"""Train a browser-sized, category-agnostic click-captcha matcher.

The student receives four clean target glyphs and four background-subtracted
candidate glyphs. It predicts a 4 by 4 correspondence matrix and is trained
against the complete 24-permutation click order. Optional teacher scores are
derived from the existing DINO and PP-OCR reports; manual click order remains
the primary supervision.
"""

import argparse
import copy
import json
import random
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as functional
from PIL import Image
from torch.utils.data import DataLoader, TensorDataset
from torchvision.models import (
    EfficientNet_B0_Weights,
    MobileNet_V3_Small_Weights,
    efficientnet_b0,
    mobilenet_v3_small,
)

from click_captcha_dataset import (
    ASSIGNMENTS_BY_TARGET_COUNT,
    ASSIGNMENT_INDEX_BY_TARGET_COUNT,
    TARGET_COUNTS,
    load_corrections,
    load_round,
    parse_rounds,
)


TARGET_SLOTS = ((120, 134), (143, 157), (166, 180), (189, 203))
CANDIDATE_SLOTS = ((0, 58), (58, 128), (128, 190), (190, 250))
TARGET_TOP = 101
TARGET_BOTTOM = 119
SCENE_HEIGHT = 100
def make_candidate_background(samples):
    scenes = np.stack([sample["image"][:SCENE_HEIGHT] for sample in samples], axis=0)
    return np.median(scenes, axis=0).astype(np.float32)


def foreground_bbox(gray, threshold):
    ys, xs = np.where(gray < threshold)
    if len(xs) < 3:
        return 0, 0, gray.shape[1], gray.shape[0]
    padding = 2
    return (
        max(0, int(xs.min()) - padding),
        max(0, int(ys.min()) - padding),
        min(gray.shape[1], int(xs.max()) + padding + 1),
        min(gray.shape[0], int(ys.max()) + padding + 1),
    )


def center_glyph(gray, threshold, size):
    x0, y0, x1, y1 = foreground_bbox(gray, threshold)
    crop = gray[y0:y1, x0:x1]
    height, width = crop.shape
    scale = min((size - 8) / max(height, 1), (size - 8) / max(width, 1))
    resized = Image.fromarray(crop.astype(np.uint8)).resize(
        (max(1, round(width * scale)), max(1, round(height * scale))),
        Image.Resampling.BICUBIC,
    )
    canvas = np.full((size, size), 255, dtype=np.uint8)
    top = (size - resized.height) // 2
    left = (size - resized.width) // 2
    canvas[top:top + resized.height, left:left + resized.width] = np.asarray(resized)
    return torch.from_numpy(canvas.astype(np.float32) / 255.0).unsqueeze(0)


def rotate_centered_glyph(glyph, angle):
    if not angle:
        return glyph
    image = Image.fromarray((glyph.squeeze(0).numpy() * 255).astype(np.uint8))
    rotated = image.rotate(
        angle,
        resample=Image.Resampling.BICUBIC,
        expand=False,
        fillcolor=255,
    )
    return torch.from_numpy(np.asarray(rotated, dtype=np.float32) / 255.0).unsqueeze(0)


def preprocess_sample(sample, background, size, foreground_threshold, residual_gain, candidate_rotations):
    image = sample["image"]
    target_count = len(sample["order"])
    targets = []
    candidates = []
    candidate_boxes = []
    for index, (left, right) in enumerate(TARGET_SLOTS):
        if index < target_count:
            gray = 255 - np.mean(image[TARGET_TOP:TARGET_BOTTOM, left:right], axis=2)
            targets.append(center_glyph(gray, foreground_threshold, size))
        else:
            targets.append(torch.ones((1, size, size), dtype=torch.float32))
    for left, right in CANDIDATE_SLOTS:
        region = image[:SCENE_HEIGHT, left:right].astype(np.float32)
        residual = np.abs(region - background[:, left:right]).max(axis=2)
        gray = 255 - np.clip(residual * residual_gain, 0, 255)
        x0, y0, x1, y1 = foreground_bbox(gray, foreground_threshold)
        candidate_boxes.append([left + x0, y0, left + x1, y1])
        centered = center_glyph(gray, foreground_threshold, size)
        candidates.append(torch.stack([
            rotate_centered_glyph(centered, angle)
            for angle in candidate_rotations
        ]))
    return torch.stack(targets), torch.stack(candidates), candidate_boxes, target_count


def assignment_logits(matrix, target_counts):
    batches = []
    for index, count in enumerate(target_counts.tolist()):
        assignments = ASSIGNMENTS_BY_TARGET_COUNT[int(count)]
        batches.append(torch.stack([
            matrix[index, tuple(range(count)), assignment].sum()
            for assignment in assignments
        ]))
    return torch.stack(batches)


def softmax(values):
    values = values - np.max(values)
    exponentials = np.exp(values)
    return exponentials / exponentials.sum()


def standardize(values):
    spread = values.std()
    if spread < 1e-8:
        return np.zeros_like(values)
    return (values - values.mean()) / spread


def matrix_from_row(row):
    matrix = row["matrix"]
    if matrix and isinstance(matrix[0], str):
        matrix = [[float(value) for value in line.split()] for line in matrix]
    return np.asarray(matrix, dtype=np.float64)


def permutation_scores(matrix, target_count):
    return np.asarray([
        sum(matrix[target_index, candidate_index]
            for target_index, candidate_index in enumerate(assignment))
        for assignment in ASSIGNMENTS_BY_TARGET_COUNT[target_count]
    ], dtype=np.float64)


def load_dino_matrices(path):
    report = json.loads(path.read_text(encoding="utf-8"))
    rows = {}
    for split in ("train", "validation", "test"):
        for row in report["metrics"][split]["rows"]:
            rows[(row["round"], row["id"])] = matrix_from_row(row)
    return rows


def load_ppocr_matrices(directory, pattern):
    rows = {}
    for path in directory.glob(pattern):
        report = json.loads(path.read_text(encoding="utf-8"))
        for row in report["rows"]:
            rows[(report["round"], row["id"])] = np.asarray(row["matrix"], dtype=np.float64)
    return rows


def teacher_probabilities(samples, dino_path, ppocr_dir, ppocr_pattern, weight, temperature):
    if not dino_path:
        return None
    if not ppocr_dir:
        raise ValueError("--teacher-ppocr-dir is required when --teacher-dino-report is set")
    dino = load_dino_matrices(Path(dino_path))
    ppocr = load_ppocr_matrices(Path(ppocr_dir), ppocr_pattern)
    probabilities = []
    missing = []
    for sample in samples:
        key = (sample["round"], sample["id"])
        if key not in dino or key not in ppocr:
            missing.append(key)
            continue
        target_count = len(sample["order"])
        scores = standardize(permutation_scores(dino[key], target_count))
        scores += weight * standardize(permutation_scores(ppocr[key], target_count))
        probabilities.append(softmax(scores / temperature))
    if missing:
        raise ValueError(f"Teacher reports miss {len(missing)} samples, e.g. {missing[:3]}")
    return torch.tensor(np.asarray(probabilities), dtype=torch.float32)


class ConvBlock(nn.Module):
    def __init__(self, input_channels, output_channels, stride=1):
        super().__init__()
        self.layers = nn.Sequential(
            nn.Conv2d(input_channels, output_channels, 3, stride=stride, padding=1, bias=False),
            nn.GroupNorm(4 if output_channels >= 4 else 1, output_channels),
            nn.SiLU(),
        )

    def forward(self, values):
        return self.layers(values)


class StudentPermutationMatcher(nn.Module):
    def __init__(self, embedding_dim=48, pair_hidden=64):
        super().__init__()
        self.target_stem = ConvBlock(1, 16)
        self.candidate_stem = ConvBlock(1, 16)
        self.shared = nn.Sequential(
            ConvBlock(16, 24, stride=2),
            ConvBlock(24, 32, stride=2),
            ConvBlock(32, embedding_dim, stride=2),
        )
        self.pair_head = nn.Sequential(
            nn.Linear(embedding_dim * 4, pair_hidden),
            nn.LayerNorm(pair_hidden),
            nn.SiLU(),
            nn.Linear(pair_hidden, 1),
        )

    def encode(self, glyphs, stem):
        batch_size, glyph_count = glyphs.shape[:2]
        values = glyphs.reshape(batch_size * glyph_count, *glyphs.shape[2:])
        values = self.shared(stem(values))
        values = functional.adaptive_avg_pool2d(values, 1).flatten(1)
        return functional.normalize(values.reshape(batch_size, glyph_count, -1), dim=2)

    def encode_candidates(self, glyphs):
        batch_size, glyph_count, rotation_count = glyphs.shape[:3]
        values = glyphs.reshape(batch_size * glyph_count * rotation_count, *glyphs.shape[3:])
        values = self.shared(self.candidate_stem(values))
        values = functional.adaptive_avg_pool2d(values, 1).flatten(1)
        values = values.reshape(batch_size, glyph_count, rotation_count, -1)
        return functional.normalize(values, dim=3)

    def forward(self, targets, candidates):
        target_values = self.encode(targets, self.target_stem)
        candidate_values = self.encode_candidates(candidates)
        rotation_count = candidate_values.shape[2]
        target_pairs = target_values[:, :, None, None, :].expand(-1, -1, 4, rotation_count, -1)
        candidate_pairs = candidate_values[:, None, :, :, :].expand(-1, 4, -1, -1, -1)
        values = torch.cat((
            target_pairs,
            candidate_pairs,
            torch.abs(target_pairs - candidate_pairs),
            target_pairs * candidate_pairs,
        ), dim=4)
        return self.pair_head(values).squeeze(4).max(dim=3).values


class LocalStudentPermutationMatcher(nn.Module):
    """Match foreground-aware local tokens instead of only pooled glyph vectors."""

    def __init__(self, embedding_dim=48, pair_hidden=64, local_grid=4):
        super().__init__()
        self.target_stem = ConvBlock(1, 16)
        self.candidate_stem = ConvBlock(1, 16)
        self.shared = nn.Sequential(
            ConvBlock(16, 24, stride=2),
            ConvBlock(24, 32, stride=2),
            ConvBlock(32, embedding_dim, stride=2),
        )
        self.pair_head = nn.Sequential(
            nn.Linear(3, pair_hidden),
            nn.LayerNorm(pair_hidden),
            nn.SiLU(),
            nn.Linear(pair_hidden, 1),
        )
        self.local_grid = local_grid

    @staticmethod
    def foreground_masks(glyphs, height, width):
        leading_shape = glyphs.shape[:-3]
        values = glyphs.reshape(-1, *glyphs.shape[-3:])
        masks = functional.adaptive_max_pool2d(1.0 - values, (height, width)) > 0.04
        return masks.reshape(*leading_shape, height * width)

    def encode_targets(self, glyphs):
        batch_size, glyph_count = glyphs.shape[:2]
        values = glyphs.reshape(batch_size * glyph_count, *glyphs.shape[2:])
        values = self.shared(self.target_stem(values))
        values = functional.adaptive_avg_pool2d(values, (self.local_grid, self.local_grid))
        _, channels, height, width = values.shape
        tokens = functional.normalize(values, dim=1)
        tokens = tokens.reshape(batch_size, glyph_count, channels, height * width).permute(0, 1, 3, 2)
        masks = self.foreground_masks(glyphs, height, width)
        return tokens, masks

    def encode_candidates(self, glyphs):
        batch_size, glyph_count, rotation_count = glyphs.shape[:3]
        values = glyphs.reshape(batch_size * glyph_count * rotation_count, *glyphs.shape[3:])
        values = self.shared(self.candidate_stem(values))
        values = functional.adaptive_avg_pool2d(values, (self.local_grid, self.local_grid))
        _, channels, height, width = values.shape
        tokens = functional.normalize(values, dim=1)
        tokens = tokens.reshape(batch_size, glyph_count, rotation_count, channels, height * width)
        tokens = tokens.permute(0, 1, 2, 4, 3)
        masks = self.foreground_masks(glyphs, height, width)
        return tokens, masks

    @staticmethod
    def masked_average(values, mask, dimension):
        weights = mask.to(values.dtype)
        return (values * weights).sum(dim=dimension) / weights.sum(dim=dimension).clamp_min(1)

    def forward(self, targets, candidates):
        target_tokens, target_mask = self.encode_targets(targets)
        candidate_tokens, candidate_mask = self.encode_candidates(candidates)
        similarities = torch.einsum("btpc,bkrqc->btkrpq", target_tokens, candidate_tokens)

        candidate_visible = candidate_mask[:, None, :, :, None, :]
        target_best = similarities.masked_fill(~candidate_visible, -1.0).max(dim=-1).values
        target_score = self.masked_average(target_best, target_mask[:, :, None, None, :], -1)

        target_visible = target_mask[:, :, None, None, :, None]
        candidate_best = similarities.masked_fill(~target_visible, -1.0).max(dim=-2).values
        candidate_score = self.masked_average(candidate_best, candidate_mask[:, None, :, :, :], -1)

        target_global = self.masked_average(target_tokens, target_mask[:, :, :, None], 2)
        candidate_global = self.masked_average(candidate_tokens, candidate_mask[:, :, :, :, None], 3)
        global_score = torch.einsum("btc,bkrc->btkr", target_global, candidate_global)

        values = torch.stack((target_score, candidate_score, global_score), dim=-1)
        return self.pair_head(values).squeeze(-1).max(dim=3).values


class MobileGlyphEncoder(nn.Module):
    def __init__(self, pretrained=True):
        super().__init__()
        weights = MobileNet_V3_Small_Weights.DEFAULT if pretrained else None
        network = mobilenet_v3_small(weights=weights)
        self.backbone = network.features
        self.register_buffer("image_mean", torch.tensor((0.485, 0.456, 0.406))[None, :, None, None])
        self.register_buffer("image_std", torch.tensor((0.229, 0.224, 0.225))[None, :, None, None])

    def forward(self, values):
        values = values.repeat(1, 3, 1, 1)
        values = (values - self.image_mean) / self.image_std
        values = self.backbone(values)
        return functional.adaptive_avg_pool2d(values, 1).flatten(1)


class MobileFeaturePermutationMatcher(nn.Module):
    def __init__(self, embedding_dim=96, pair_hidden=128):
        super().__init__()
        self.projection = nn.Linear(576, embedding_dim)
        self.pair_head = nn.Sequential(
            nn.Linear(embedding_dim * 4, pair_hidden),
            nn.LayerNorm(pair_hidden),
            nn.SiLU(),
            nn.Linear(pair_hidden, 1),
        )

    def forward(self, targets, candidates):
        target_values = functional.normalize(self.projection(targets), dim=-1)
        candidate_values = functional.normalize(self.projection(candidates), dim=-1)
        rotation_count = candidate_values.shape[2]
        target_pairs = target_values[:, :, None, None, :].expand(-1, -1, 4, rotation_count, -1)
        candidate_pairs = candidate_values[:, None, :, :, :].expand(-1, 4, -1, -1, -1)
        values = torch.cat((
            target_pairs,
            candidate_pairs,
            torch.abs(target_pairs - candidate_pairs),
            target_pairs * candidate_pairs,
        ), dim=4)
        return self.pair_head(values).squeeze(4).max(dim=3).values


class MobileStudentPermutationMatcher(nn.Module):
    """Use a pretrained mobile backbone while keeping the pair head category-agnostic."""

    def __init__(self, embedding_dim=96, pair_hidden=128, pretrained=True):
        super().__init__()
        self.encoder = MobileGlyphEncoder(pretrained=pretrained)
        self.matcher = MobileFeaturePermutationMatcher(embedding_dim, pair_hidden)

    def forward(self, targets, candidates):
        batch_size, target_count = targets.shape[:2]
        rotation_count = candidates.shape[2]
        target_values = self.encoder(targets.reshape(-1, *targets.shape[2:]))
        target_values = target_values.reshape(batch_size, target_count, -1)
        candidate_values = self.encoder(candidates.reshape(-1, *candidates.shape[3:]))
        candidate_values = candidate_values.reshape(batch_size, 4, rotation_count, -1)
        return self.matcher(target_values, candidate_values)


class MobilePrefixEncoder(nn.Module):
    def __init__(self, prefix):
        super().__init__()
        self.prefix = prefix
        self.register_buffer("image_mean", torch.tensor((0.485, 0.456, 0.406))[None, :, None, None])
        self.register_buffer("image_std", torch.tensor((0.229, 0.224, 0.225))[None, :, None, None])

    def forward(self, values):
        values = values.repeat(1, 3, 1, 1)
        values = (values - self.image_mean) / self.image_std
        return self.prefix(values)


class MobileTailPermutationMatcher(nn.Module):
    def __init__(self, tail, embedding_dim=96, pair_hidden=128):
        super().__init__()
        self.tail = tail
        self.matcher = MobileFeaturePermutationMatcher(embedding_dim, pair_hidden)

    def encode(self, values):
        values = self.tail(values)
        return functional.adaptive_avg_pool2d(values, 1).flatten(1)

    def forward(self, targets, candidates):
        batch_size, target_count = targets.shape[:2]
        rotation_count = candidates.shape[2]
        target_values = self.encode(targets.reshape(-1, *targets.shape[2:]))
        target_values = target_values.reshape(batch_size, target_count, -1)
        candidate_values = self.encode(candidates.reshape(-1, *candidates.shape[3:]))
        candidate_values = candidate_values.reshape(batch_size, 4, rotation_count, -1)
        return self.matcher(target_values, candidate_values)


class MobileLocalFeaturePermutationMatcher(nn.Module):
    """Compare mid-level mobile features without discarding their stroke layout."""

    def __init__(self, input_channels, embedding_dim=64, pair_hidden=64):
        super().__init__()
        self.target_projection = nn.Conv2d(input_channels, embedding_dim, 1)
        self.candidate_projection = nn.Conv2d(input_channels, embedding_dim, 1)
        self.pair_head = nn.Sequential(
            nn.Linear(4, pair_hidden),
            nn.LayerNorm(pair_hidden),
            nn.SiLU(),
            nn.Linear(pair_hidden, 1),
        )

    def forward(self, targets, candidates):
        batch_size, target_count = targets.shape[:2]
        rotation_count = candidates.shape[2]
        target_values = self.target_projection(targets.reshape(-1, *targets.shape[2:]))
        candidate_values = self.candidate_projection(candidates.reshape(-1, *candidates.shape[3:]))
        channels, height, width = target_values.shape[1:]
        token_count = height * width
        target_values = functional.normalize(target_values, dim=1)
        candidate_values = functional.normalize(candidate_values, dim=1)
        target_tokens = target_values.reshape(batch_size, target_count, channels, token_count)
        target_tokens = target_tokens.permute(0, 1, 3, 2)
        candidate_tokens = candidate_values.reshape(batch_size, 4, rotation_count, channels, token_count)
        candidate_tokens = candidate_tokens.permute(0, 1, 2, 4, 3)
        similarities = torch.einsum("btpc,bkrqc->btkrpq", target_tokens, candidate_tokens)
        target_score = similarities.max(dim=-1).values.mean(dim=-1)
        candidate_score = similarities.max(dim=-2).values.mean(dim=-1)
        aligned_score = similarities.diagonal(dim1=-2, dim2=-1).mean(dim=-1)
        target_global = functional.normalize(target_tokens.mean(dim=2), dim=-1)
        candidate_global = functional.normalize(candidate_tokens.mean(dim=3), dim=-1)
        global_score = torch.einsum("btc,bkrc->btkr", target_global, candidate_global)
        values = torch.stack((target_score, candidate_score, aligned_score, global_score), dim=-1)
        return self.pair_head(values).squeeze(-1).max(dim=3).values


@torch.no_grad()
def encode_mobile_values(encoder, values, batch_size):
    targets, candidates, *remaining = values

    def encode(glyphs, leading_shape):
        flat = glyphs.reshape(-1, *glyphs.shape[-3:])
        encoded = torch.cat([
            encoder(flat[start:start + batch_size])
            for start in range(0, len(flat), batch_size)
        ])
        return encoded.reshape(*leading_shape, encoded.shape[-1])

    encoder.eval()
    target_features = encode(targets, targets.shape[:2])
    candidate_features = encode(candidates, candidates.shape[:3])
    return (target_features, candidate_features, *remaining)


@torch.no_grad()
def encode_mobile_prefix_values(encoder, values, batch_size):
    targets, candidates, *remaining = values

    def encode(glyphs, leading_shape):
        flat = glyphs.reshape(-1, *glyphs.shape[-3:])
        encoded = torch.cat([
            encoder(flat[start:start + batch_size])
            for start in range(0, len(flat), batch_size)
        ])
        return encoded.reshape(*leading_shape, *encoded.shape[1:])

    encoder.eval()
    return (
        encode(targets, targets.shape[:2]),
        encode(candidates, candidates.shape[:3]),
        *remaining,
    )


def calculate_loss(matrix, orders, target_counts, labels, teacher, args):
    pair_labels = torch.zeros_like(matrix)
    valid_rows = torch.arange(4, device=matrix.device)[None, :] < target_counts[:, None]
    safe_orders = orders.clamp_min(0)
    pair_labels.scatter_(2, safe_orders[:, :, None], 1.0)
    pair_loss = functional.binary_cross_entropy_with_logits(matrix, pair_labels, reduction="none")
    pair_bce = (pair_loss * valid_rows[:, :, None]).sum() / (valid_rows.sum() * 4)
    logits = assignment_logits(matrix, target_counts)
    order_ce = functional.cross_entropy(logits, labels)
    distillation = torch.zeros((), device=matrix.device)
    if teacher is not None and args.distill_weight:
        log_probabilities = functional.log_softmax(logits / args.teacher_temperature, dim=1)
        distillation = functional.kl_div(log_probabilities, teacher, reduction="batchmean")
        distillation *= args.teacher_temperature ** 2
    total = order_ce + args.pair_bce_weight * pair_bce + args.distill_weight * distillation
    return total, order_ce, pair_bce, distillation


def build_split_tensors(samples, background, args):
    targets = []
    candidates = []
    orders = []
    target_counts = []
    labels = []
    boxes = []
    for sample in samples:
        target, candidate, candidate_boxes, target_count = preprocess_sample(
            sample,
            background,
            args.input_size,
            args.foreground_threshold,
            args.residual_gain,
            args.candidate_rotations,
        )
        targets.append(target)
        candidates.append(candidate)
        orders.append(list(sample["order"]) + [-1] * (4 - target_count))
        target_counts.append(target_count)
        labels.append(ASSIGNMENT_INDEX_BY_TARGET_COUNT[target_count][sample["order"]])
        boxes.append(candidate_boxes)
    return (
        torch.stack(targets),
        torch.stack(candidates),
        torch.tensor(orders, dtype=torch.long),
        torch.tensor(target_counts, dtype=torch.long),
        torch.tensor(labels, dtype=torch.long),
        boxes,
    )


@torch.no_grad()
def evaluate(model, values, samples, teacher, args):
    targets, candidates, orders, target_counts, labels, boxes = values
    started = time.perf_counter()
    model.eval()
    matrix = torch.cat([
        model(targets[start:start + args.eval_batch_size], candidates[start:start + args.eval_batch_size])
        for start in range(0, len(targets), args.eval_batch_size)
    ])
    elapsed_ms = (time.perf_counter() - started) * 1000
    total_loss, order_ce, pair_bce, distillation = calculate_loss(
        matrix, orders, target_counts, labels, teacher, args
    )
    scores = matrix.cpu().numpy()
    logits = assignment_logits(matrix, target_counts).cpu()
    probabilities = torch.softmax(logits, dim=1).numpy()
    rows = []
    exact = 0
    characters = 0
    for index, sample in enumerate(samples):
        ranking = np.argsort(logits[index].numpy())[::-1]
        target_count = int(target_counts[index])
        predicted = ASSIGNMENTS_BY_TARGET_COUNT[target_count][int(ranking[0])]
        expected = sample["order"]
        correct = tuple(predicted) == tuple(expected)
        exact += correct
        character_correct = sum(left == right for left, right in zip(predicted, expected))
        characters += character_correct
        rows.append({
            "round": sample["round"],
            "id": sample["id"],
            "expected": list(expected),
            "predicted": list(predicted),
            "targetCount": target_count,
            "correct": correct,
            "characterCorrect": character_correct,
            "topProbability": round(float(probabilities[index, ranking[0]]), 6),
            "probabilityMargin": round(float(probabilities[index, ranking[0]] - probabilities[index, ranking[1]]), 6),
            "candidateBoxes": boxes[index],
            "matrix": scores[index].round(6).tolist(),
        })
    return {
        "exact": exact,
        "total": len(samples),
        "exactAccuracy": round(exact / len(samples), 6),
        "characterCorrect": characters,
        "characterTotal": sum(len(sample["order"]) for sample in samples),
        "characterAccuracy": round(characters / sum(len(sample["order"]) for sample in samples), 6),
        "averageInferenceMs": round(elapsed_ms / len(samples), 3),
        "loss": round(float(total_loss), 6),
        "permutationLoss": round(float(order_ce), 6),
        "pairBce": round(float(pair_bce), 6),
        "distillationLoss": round(float(distillation), 6),
        "rows": rows,
    }


def train(model, train_values, validation_values, train_teacher, validation_teacher, validation_samples, args):
    train_targets, train_candidates, train_orders, train_target_counts, train_labels, _ = train_values
    if train_teacher is None:
        dataset = TensorDataset(train_targets, train_candidates, train_orders, train_target_counts, train_labels)
    else:
        dataset = TensorDataset(
            train_targets, train_candidates, train_orders, train_target_counts, train_labels, train_teacher
        )
    loader = DataLoader(
        dataset,
        batch_size=min(args.batch_size, len(dataset)),
        shuffle=True,
        generator=torch.Generator().manual_seed(args.seed),
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay)
    best_state = None
    best_key = None
    best_epoch = 0
    wait = 0
    for epoch in range(1, args.epochs + 1):
        model.train()
        for batch in loader:
            targets, candidates, orders, target_counts, labels = batch[:5]
            teacher = batch[5] if len(batch) == 6 else None
            if args.input_noise:
                targets = (targets + torch.randn_like(targets) * args.input_noise).clamp(0, 1)
                candidates = (candidates + torch.randn_like(candidates) * args.input_noise).clamp(0, 1)
            optimizer.zero_grad()
            loss, _, _, _ = calculate_loss(
                model(targets, candidates), orders, target_counts, labels, teacher, args
            )
            loss.backward()
            optimizer.step()
        validation = evaluate(model, validation_values, validation_samples, validation_teacher, args)
        key = (validation["exact"], -validation["loss"])
        if best_key is None or key > best_key:
            best_key = key
            best_state = copy.deepcopy(model.state_dict())
            best_epoch = epoch
            wait = 0
        else:
            wait += 1
        if epoch == 1 or epoch % 10 == 0 or epoch == args.epochs:
            print(f"  epoch {epoch:03d}: val={validation['exact']}/{validation['total']} loss={validation['loss']:.4f}")
        if epoch >= args.min_epochs and wait >= args.patience:
            print(f"  early stop at epoch {epoch}; best validation epoch was {best_epoch}")
            break
    model.load_state_dict(best_state)
    return best_epoch


def seed_everything(seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def main():
    parser = argparse.ArgumentParser(description="Train a small click-captcha permutation student.")
    parser.add_argument("--data-dir", default="data/click-captcha-samples")
    parser.add_argument(
        "--corrections",
        default="",
        help="Optional correction manifest for legacy samples with extra captured clicks.",
    )
    parser.add_argument("--train-rounds", default="001-006")
    parser.add_argument("--validation-rounds", default="007-008")
    parser.add_argument("--test-rounds", default="009-010")
    parser.add_argument("--input-size", type=int, default=64)
    parser.add_argument("--foreground-threshold", type=int, default=160)
    parser.add_argument("--residual-gain", type=float, default=2.0)
    parser.add_argument(
        "--candidate-rotations",
        default="0",
        help="Comma-separated candidate rotation variants in degrees.",
    )
    parser.add_argument("--embedding-dim", type=int, default=48)
    parser.add_argument("--pair-hidden", type=int, default=64)
    parser.add_argument("--local-grid", type=int, default=4)
    parser.add_argument(
        "--matcher",
        choices=(
            "global", "local-chamfer", "mobilenet-v3-small", "mobilenet-local", "efficientnet-local",
        ),
        default="global",
        help="Small CNN baselines or an ImageNet-pretrained mobile matcher.",
    )
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--eval-batch-size", type=int, default=32)
    parser.add_argument(
        "--freeze-mobile-backbone",
        action="store_true",
        help="Cache pretrained MobileNet features and train only the projection and pair head.",
    )
    parser.add_argument(
        "--mobile-cache-cut",
        type=int,
        default=0,
        help="Cache MobileNet blocks before this index and fine-tune the remaining blocks.",
    )
    parser.add_argument(
        "--mobile-feature-cache",
        default="",
        help="Optional reusable cache for frozen MobileNet prefix activations.",
    )
    parser.add_argument("--learning-rate", type=float, default=0.001)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--input-noise", type=float, default=0.02)
    parser.add_argument("--pair-bce-weight", type=float, default=0.1)
    parser.add_argument("--distill-weight", type=float, default=0.0)
    parser.add_argument("--teacher-temperature", type=float, default=1.0)
    parser.add_argument("--teacher-weight", type=float, default=0.75)
    parser.add_argument("--teacher-dino-report")
    parser.add_argument("--teacher-ppocr-dir")
    parser.add_argument("--teacher-ppocr-pattern", default="gain2-th160-rot60fine-round-*.json")
    parser.add_argument("--epochs", type=int, default=160)
    parser.add_argument("--min-epochs", type=int, default=30)
    parser.add_argument("--patience", type=int, default=30)
    parser.add_argument("--seed", type=int, default=20260722)
    parser.add_argument("--max-samples-per-split", type=int, default=0)
    parser.add_argument("--checkpoint", default="data/click-captcha-experiments/click-captcha-student.pt")
    parser.add_argument("--output", default="data/click-captcha-experiments/click-captcha-student-report.json")
    args = parser.parse_args()
    args.candidate_rotations = tuple(
        float(value) for value in args.candidate_rotations.split(",") if value.strip()
    )
    if not args.candidate_rotations:
        raise ValueError("At least one candidate rotation is required")

    seed_everything(args.seed)
    train_rounds = parse_rounds(args.train_rounds)
    validation_rounds = parse_rounds(args.validation_rounds)
    test_rounds = parse_rounds(args.test_rounds)
    all_rounds = train_rounds + validation_rounds + test_rounds
    if len(set(all_rounds)) != len(all_rounds):
        raise ValueError("train, validation, and test rounds must not overlap")
    data_dir = Path(args.data_dir)
    corrections_path = Path(args.corrections) if args.corrections else data_dir / "corrections.json"
    corrections = load_corrections(corrections_path)
    loaded = {round_name: load_round(data_dir / round_name, corrections) for round_name in all_rounds}
    splits = {
        "train": [sample for round_name in train_rounds for sample in loaded[round_name]],
        "validation": [sample for round_name in validation_rounds for sample in loaded[round_name]],
        "test": [sample for round_name in test_rounds for sample in loaded[round_name]],
    }
    if args.max_samples_per_split:
        splits = {name: samples[:args.max_samples_per_split] for name, samples in splits.items()}
    background = make_candidate_background(splits["train"])
    values = {name: build_split_tensors(samples, background, args) for name, samples in splits.items()}
    teachers = {
        name: (
            teacher_probabilities(
                samples,
                args.teacher_dino_report,
                args.teacher_ppocr_dir,
                args.teacher_ppocr_pattern,
                args.teacher_weight,
                args.teacher_temperature,
            )
            if name != "test" else None
        )
        for name, samples in splits.items()
    }
    mobile_encoder = None
    deployed_parameter_count = None
    if args.matcher == "local-chamfer":
        model = LocalStudentPermutationMatcher(args.embedding_dim, args.pair_hidden, args.local_grid)
    elif args.matcher in ("mobilenet-v3-small", "mobilenet-local", "efficientnet-local"):
        if args.matcher in ("mobilenet-local", "efficientnet-local") and not args.mobile_cache_cut:
            raise ValueError(f"{args.matcher} requires --mobile-cache-cut")
        if args.freeze_mobile_backbone and args.mobile_cache_cut:
            raise ValueError("Choose either --freeze-mobile-backbone or --mobile-cache-cut")
        if args.mobile_cache_cut:
            network = (
                efficientnet_b0(weights=EfficientNet_B0_Weights.DEFAULT)
                if args.matcher == "efficientnet-local"
                else mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT)
            )
            if args.mobile_cache_cut < 1 or args.mobile_cache_cut >= len(network.features):
                raise ValueError("--mobile-cache-cut must leave at least one trainable MobileNet block")
            mobile_encoder = MobilePrefixEncoder(network.features[:args.mobile_cache_cut])
            cache_key = {
                "format": "nju-click-captcha-mobile-prefix/v1",
                "backbone": args.matcher,
                "trainRounds": train_rounds,
                "validationRounds": validation_rounds,
                "testRounds": test_rounds,
                "inputSize": args.input_size,
                "foregroundThreshold": args.foreground_threshold,
                "residualGain": args.residual_gain,
                "candidateRotations": args.candidate_rotations,
                "mobileCacheCut": args.mobile_cache_cut,
            }
            cache_path = Path(args.mobile_feature_cache) if args.mobile_feature_cache else None
            cached = torch.load(cache_path, map_location="cpu", weights_only=False) if cache_path and cache_path.exists() else None
            if cached and cached.get("key") == cache_key:
                values = cached["values"]
                print(f"Loaded mobile prefix features from {cache_path}")
            else:
                values = {
                    name: encode_mobile_prefix_values(mobile_encoder, split_values, args.eval_batch_size)
                    for name, split_values in values.items()
                }
                if cache_path:
                    cache_path.parent.mkdir(parents=True, exist_ok=True)
                    torch.save({"key": cache_key, "values": values}, cache_path)
                    print(f"Cached mobile prefix features at {cache_path}")
            if args.matcher in ("mobilenet-local", "efficientnet-local"):
                input_channels = values["train"][0].shape[-3]
                model = MobileLocalFeaturePermutationMatcher(
                    input_channels, args.embedding_dim, args.pair_hidden
                )
            else:
                model = MobileTailPermutationMatcher(
                    network.features[args.mobile_cache_cut:], args.embedding_dim, args.pair_hidden
                )
            deployed_parameter_count = (
                sum(parameter.numel() for parameter in mobile_encoder.parameters())
                + sum(parameter.numel() for parameter in model.parameters())
            )
        elif args.freeze_mobile_backbone:
            mobile_encoder = MobileGlyphEncoder(pretrained=True)
            values = {
                name: encode_mobile_values(mobile_encoder, split_values, args.eval_batch_size)
                for name, split_values in values.items()
            }
            model = MobileFeaturePermutationMatcher(args.embedding_dim, args.pair_hidden)
            deployed_parameter_count = (
                sum(parameter.numel() for parameter in mobile_encoder.parameters())
                + sum(parameter.numel() for parameter in model.parameters())
            )
        else:
            model = MobileStudentPermutationMatcher(args.embedding_dim, args.pair_hidden, pretrained=True)
    else:
        model = StudentPermutationMatcher(args.embedding_dim, args.pair_hidden)
    parameter_count = sum(parameter.numel() for parameter in model.parameters())
    print(f"Training {parameter_count} student parameters...")
    best_epoch = train(
        model,
        values["train"],
        values["validation"],
        teachers["train"],
        teachers["validation"],
        splits["validation"],
        args,
    )
    metrics = {
        name: evaluate(model, values[name], samples, teachers[name], args)
        for name, samples in splits.items()
    }
    print(
        f"Final: train={metrics['train']['exact']}/{metrics['train']['total']} "
        f"val={metrics['validation']['exact']}/{metrics['validation']['total']} "
        f"test={metrics['test']['exact']}/{metrics['test']['total']}"
    )
    checkpoint = Path(args.checkpoint)
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "format": "nju-click-captcha-student-checkpoint/v1",
        "stateDict": model.state_dict(),
        "backboneStateDict": mobile_encoder.state_dict() if mobile_encoder is not None else None,
        "inputSize": args.input_size,
        "foregroundThreshold": args.foreground_threshold,
        "residualGain": args.residual_gain,
        "candidateRotations": args.candidate_rotations,
        "embeddingDim": args.embedding_dim,
        "pairHidden": args.pair_hidden,
        "matcher": args.matcher,
        "localGrid": args.local_grid if args.matcher == "local-chamfer" else None,
        "mobileCacheCut": args.mobile_cache_cut,
        "bestEpoch": best_epoch,
    }, checkpoint)
    report = {
        "format": "nju-click-captcha-student-report/v1",
        "warning": "round-009/010 were previously used during development and are not a final holdout.",
        "checkpoint": str(checkpoint),
        "parameterCount": parameter_count,
        "deployedParameterCount": deployed_parameter_count or parameter_count,
        "bestEpoch": best_epoch,
        "splits": {"trainRounds": train_rounds, "validationRounds": validation_rounds, "testRounds": test_rounds},
        "corrections": str(corrections_path) if corrections else None,
        "preprocess": {
            "candidateBackground": "train-median-top-region",
            "target": "inverted-grayscale",
            "inputSize": args.input_size,
            "foregroundThreshold": args.foreground_threshold,
            "residualGain": args.residual_gain,
            "candidateRotations": args.candidate_rotations,
        },
        "training": {
            "seed": args.seed,
            "embeddingDim": args.embedding_dim,
            "pairHidden": args.pair_hidden,
            "matcher": args.matcher,
            "frozenMobileBackbone": args.freeze_mobile_backbone,
            "mobileCacheCut": args.mobile_cache_cut,
            "localGrid": args.local_grid if args.matcher == "local-chamfer" else None,
            "pairBceWeight": args.pair_bce_weight,
            "distillWeight": args.distill_weight,
            "teacherWeight": args.teacher_weight if args.teacher_dino_report else None,
            "teacherDinoReport": args.teacher_dino_report,
            "teacherPpocrPattern": args.teacher_ppocr_pattern if args.teacher_dino_report else None,
        },
        "metrics": metrics,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Checkpoint: {checkpoint}")
    print(f"Report: {output}")


if __name__ == "__main__":
    main()
