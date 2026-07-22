"""Train a lightweight DINOv2 matcher against whole click-order permutations.

The DINOv2 backbone is frozen and kept outside the extension. This script
stores reusable CLS features, then compares independent pair BCE and a
24-permutation objective on the same clicked correspondence labels.
"""

import argparse
import copy
import hashlib
import itertools
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

from click_captcha_dataset import (
    assignment_index,
    assignments_for,
    load_corrections,
    load_round,
)


REPORT_FORMAT = "nju-click-captcha-dinov2-permutation-report/v1"
CACHE_FORMAT = "nju-click-captcha-dinov2-cls-cache/v1"
TARGET_SLOTS = ((120, 134), (143, 157), (166, 180), (189, 203))
CANDIDATE_SLOTS = ((0, 58), (58, 128), (128, 190), (190, 250))
TARGET_TOP = 101
TARGET_BOTTOM = 119
SCENE_HEIGHT = 100


def parse_rounds(value):
    rounds = []
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start, end = (int(item) for item in part.split("-", 1))
            rounds.extend(f"round-{index:03d}" for index in range(start, end + 1))
        else:
            rounds.append(f"round-{int(part):03d}")
    if not rounds:
        raise ValueError("At least one round is required.")
    return rounds


def fingerprint(samples):
    digest = hashlib.sha256()
    for sample in samples:
        digest.update(sample["round"].encode("utf-8"))
        digest.update(sample["id"].encode("utf-8"))
        digest.update(sample["image"].tobytes())
        digest.update(bytes(sample["order"]))
    return digest.hexdigest()


def make_background(samples):
    images = np.stack([sample["image"] for sample in samples], axis=0)
    return np.median(images, axis=0).astype(np.float32)


def standard_gray_crop(image, top, bottom, left, right, invert, input_size, mean, std):
    crop = image[top:bottom, left:right]
    gray = np.mean(crop, axis=2)
    if invert:
        gray = 255 - gray
    resized = Image.fromarray(gray.astype(np.uint8)).resize(
        (input_size, input_size), Image.Resampling.BICUBIC
    ).convert("RGB")
    values = np.asarray(resized, dtype=np.float32) / 255.0
    values = (values - mean) / std
    return torch.from_numpy(values.transpose(2, 0, 1))


def background_subtracted_crop(
    image, background, top, bottom, left, right, input_size, mean, std, residual_gain
):
    crop = image[top:bottom, left:right].astype(np.float32)
    background_crop = background[top:bottom, left:right]
    residual = np.abs(crop - background_crop).max(axis=2)
    # Bright background, dark residual glyph: the same polarity as an inverted target glyph.
    gray = 255 - np.clip(residual * residual_gain, 0, 255)
    resized = Image.fromarray(gray.astype(np.uint8)).resize(
        (input_size, input_size), Image.Resampling.BICUBIC
    ).convert("RGB")
    values = np.asarray(resized, dtype=np.float32) / 255.0
    values = (values - mean) / std
    return torch.from_numpy(values.transpose(2, 0, 1))


def crop_records(samples, input_size, mean, std, preprocess, background, residual_gain):
    for sample in samples:
        image = sample["image"]
        for index, (left, right) in enumerate(TARGET_SLOTS[:sample["targetCount"]]):
            if preprocess == "full-background-residual":
                value = background_subtracted_crop(
                    image,
                    background,
                    TARGET_TOP,
                    TARGET_BOTTOM,
                    left,
                    right,
                    input_size,
                    mean,
                    std,
                    residual_gain,
                )
            else:
                value = standard_gray_crop(
                    image, TARGET_TOP, TARGET_BOTTOM, left, right, True, input_size, mean, std
                )
            yield ((sample["round"], sample["id"], "target", index), value)
        for index, (left, right) in enumerate(CANDIDATE_SLOTS):
            if preprocess in ("background-residual", "full-background-residual"):
                value = background_subtracted_crop(
                    image,
                    background,
                    0,
                    SCENE_HEIGHT,
                    left,
                    right,
                    input_size,
                    mean,
                    std,
                    residual_gain,
                )
            else:
                value = standard_gray_crop(
                    image, 0, SCENE_HEIGHT, left, right, False, input_size, mean, std
                )
            yield (
                (sample["round"], sample["id"], "candidate", index),
                value,
            )


def load_or_extract_features(
    model, samples, config, cache_path, batch_size, refresh_cache, preprocess, background, residual_gain
):
    cache_key = {
        "format": CACHE_FORMAT,
        "model": "vit_small_patch14_dinov2",
        "inputSize": tuple(config["input_size"]),
        "mean": tuple(config["mean"]),
        "std": tuple(config["std"]),
        "preprocess": preprocess,
        "residualGain": residual_gain if preprocess != "zone-gray" else None,
        "fingerprint": fingerprint(samples),
    }
    if cache_path.exists() and not refresh_cache:
        cached = torch.load(cache_path, map_location="cpu", weights_only=False)
        if cached.get("cacheKey") == cache_key:
            print(f"Loaded {len(cached['features'])} frozen features from {cache_path}", flush=True)
            return cached["features"], cache_key
        print("Existing feature cache does not match the selected data or preprocessing; rebuilding.", flush=True)

    print("Extracting frozen DINOv2 CLS features...", flush=True)
    features = {}
    pending_keys = []
    pending_values = []
    total = sum(4 + sample["targetCount"] for sample in samples)
    completed = 0
    input_size = config["input_size"][1]
    mean = np.asarray(config["mean"], dtype=np.float32).reshape(1, 1, 3)
    std = np.asarray(config["std"], dtype=np.float32).reshape(1, 1, 3)

    def flush():
        nonlocal completed
        if not pending_values:
            return
        batch = torch.stack(pending_values)
        tokens = model.forward_features(batch)
        cls = tokens[:, 0, :].cpu()
        for key, value in zip(pending_keys, cls):
            features[key] = value.clone()
        completed += len(pending_keys)
        if completed % max(batch_size * 20, 160) == 0 or completed == total:
            print(f"  {completed}/{total} crops", flush=True)
        pending_keys.clear()
        pending_values.clear()

    with torch.no_grad():
        for key, value in crop_records(
            samples, input_size, mean, std, preprocess, background, residual_gain
        ):
            pending_keys.append(key)
            pending_values.append(value)
            if len(pending_values) == batch_size:
                flush()
        flush()

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"cacheKey": cache_key, "features": features}, cache_path)
    print(f"Saved {len(features)} frozen features to {cache_path}", flush=True)
    return features, cache_key


def split_tensors(features, samples):
    targets = []
    candidates = []
    orders = []
    permutation_labels = []
    target_counts = []
    for sample in samples:
        prefix = (sample["round"], sample["id"])
        target_count = sample["targetCount"]
        glyphs = [features[prefix + ("target", index)] for index in range(target_count)]
        glyphs.extend(torch.zeros_like(glyphs[0]) for _ in range(4 - target_count))
        targets.append(torch.stack(glyphs))
        candidates.append(torch.stack([features[prefix + ("candidate", index)] for index in range(4)]))
        orders.append(sample["order"] + (0,) * (4 - target_count))
        permutation_labels.append(assignment_index(sample["order"]))
        target_counts.append(target_count)
    return (
        torch.stack(targets),
        torch.stack(candidates),
        torch.tensor(orders, dtype=torch.long),
        torch.tensor(permutation_labels, dtype=torch.long),
        torch.tensor(target_counts, dtype=torch.long),
    )


class PermutationMatcher(nn.Module):
    def __init__(self, feature_dim, hidden, dropout):
        super().__init__()
        self.head = nn.Sequential(
            nn.Linear(feature_dim * 4, hidden),
            nn.LayerNorm(hidden),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden, hidden // 2),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden // 2, 1),
        )

    def forward(self, targets, candidates):
        batch_size, target_count, feature_dim = targets.shape
        candidate_count = candidates.shape[1]
        targets = targets[:, :, None, :].expand(batch_size, target_count, candidate_count, feature_dim)
        candidates = candidates[:, None, :, :].expand(batch_size, target_count, candidate_count, feature_dim)
        paired = torch.cat((targets, candidates, torch.abs(targets - candidates), targets * candidates), dim=3)
        return self.head(paired).squeeze(3)


def permutation_logits(matrix, target_counts):
    return torch.stack([
        torch.stack([
            matrix[index, tuple(range(int(count))), assignment].sum()
            for assignment in assignments_for(int(count))
        ])
        for index, count in enumerate(target_counts.tolist())
    ])


def matcher_loss(matrix, orders, permutation_labels, target_counts, mode, hybrid_weight):
    pair_labels = torch.zeros_like(matrix)
    pair_mask = torch.zeros_like(matrix)
    for index, count in enumerate(target_counts.tolist()):
        pair_labels[index, tuple(range(int(count))), orders[index, :int(count)]] = 1.0
        pair_mask[index, :int(count), :] = 1.0
    bce = functional.binary_cross_entropy_with_logits(
        matrix, pair_labels, reduction="none"
    )
    bce = (bce * pair_mask).sum() / pair_mask.sum()
    permutation = functional.cross_entropy(permutation_logits(matrix, target_counts), permutation_labels)
    if mode == "bce":
        return bce, bce, permutation
    if mode == "permutation":
        return permutation, bce, permutation
    return permutation + hybrid_weight * bce, bce, permutation


@torch.no_grad()
def evaluate(model, values, samples, loss_mode, hybrid_weight):
    targets, candidates, orders, permutation_labels, target_counts = values
    model.eval()
    matrix = model(targets, candidates)
    total_loss, bce_loss, order_loss = matcher_loss(
        matrix, orders, permutation_labels, target_counts, loss_mode, hybrid_weight
    )
    scores = matrix.cpu().numpy()
    order_values = permutation_logits(matrix, target_counts).cpu()
    probabilities = torch.softmax(order_values, dim=1).numpy()
    exact = 0
    characters = 0
    rows = []
    for index, sample in enumerate(samples):
        ranking = np.argsort(order_values[index].numpy())[::-1]
        predicted = assignments_for(sample["targetCount"])[int(ranking[0])]
        expected = sample["order"]
        correct = tuple(predicted) == tuple(expected)
        exact += correct
        character_correct = sum(left == right for left, right in zip(predicted, expected))
        characters += character_correct
        rows.append({
            "round": sample["round"],
            "id": sample["id"],
            "targetCount": sample["targetCount"],
            "expected": list(expected),
            "predicted": list(predicted),
            "correct": correct,
            "characterCorrect": character_correct,
            "topProbability": round(float(probabilities[index, ranking[0]]), 6),
            "probabilityMargin": round(float(probabilities[index, ranking[0]] - probabilities[index, ranking[1]]), 6),
            "scoreMargin": round(float(order_values[index, ranking[0]] - order_values[index, ranking[1]]), 6),
            "matrix": scores[index].round(6).tolist(),
        })
    return {
        "exact": exact,
        "total": len(samples),
        "exactAccuracy": round(exact / len(samples), 6),
        "characterCorrect": characters,
        "characterTotal": sum(sample["targetCount"] for sample in samples),
        "characterAccuracy": round(characters / sum(sample["targetCount"] for sample in samples), 6),
        "loss": round(float(total_loss), 6),
        "pairBce": round(float(bce_loss), 6),
        "permutationLoss": round(float(order_loss), 6),
        "rows": rows,
    }


def seed_everything(seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def train(model, train_values, validation_values, validation_samples, args):
    train_targets, train_candidates, train_orders, train_permutations, train_target_counts = train_values
    dataset = TensorDataset(train_targets, train_candidates, train_orders, train_permutations, train_target_counts)
    loader = DataLoader(
        dataset,
        batch_size=min(args.head_batch_size, len(dataset)),
        shuffle=True,
        generator=torch.Generator().manual_seed(args.seed),
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay)
    fixed_epochs = args.fixed_epochs
    if not fixed_epochs and validation_values is None:
        raise ValueError("Validation data is required unless --fixed-epochs is set.")
    best_state = None
    best_key = None
    best_epoch = fixed_epochs
    wait = 0

    for epoch in range(1, fixed_epochs or args.epochs + 1):
        model.train()
        for targets, candidates, orders, labels, target_counts in loader:
            if args.feature_noise:
                targets = targets + torch.randn_like(targets) * args.feature_noise
                candidates = candidates + torch.randn_like(candidates) * args.feature_noise
            optimizer.zero_grad()
            matrix = model(targets, candidates)
            loss, _, _ = matcher_loss(
                matrix, orders, labels, target_counts, args.loss, args.hybrid_weight
            )
            loss.backward()
            optimizer.step()

        if fixed_epochs:
            if epoch == 1 or epoch % 10 == 0 or epoch == fixed_epochs:
                print(f"  epoch {epoch:03d}: fixed-epoch training", flush=True)
            continue

        validation = evaluate(model, validation_values, validation_samples, args.loss, args.hybrid_weight)
        key = (validation["exact"], -validation["loss"])
        if best_key is None or key > best_key:
            best_key = key
            best_state = copy.deepcopy(model.state_dict())
            best_epoch = epoch
            wait = 0
        else:
            wait += 1
        if epoch == 1 or epoch % 10 == 0 or epoch == args.epochs:
            print(
                f"  epoch {epoch:03d}: val={validation['exact']}/{validation['total']} "
                f"loss={validation['loss']:.4f}",
                flush=True,
            )
        if epoch >= args.min_epochs and wait >= args.patience:
            print(f"  early stop at epoch {epoch}; best validation epoch was {best_epoch}", flush=True)
            break

    if best_state is not None:
        model.load_state_dict(best_state)
    return best_epoch


def main():
    parser = argparse.ArgumentParser(description="Train a frozen-DINO click-captcha permutation matcher.")
    parser.add_argument("--data-dir", default="data/click-captcha-samples")
    parser.add_argument(
        "--corrections",
        default="",
        help="Optional correction manifest for legacy samples with extra captured clicks.",
    )
    parser.add_argument("--train-rounds", default="001-006")
    parser.add_argument(
        "--validation-rounds",
        default="007-008",
        help="Validation rounds, or an empty string with --fixed-epochs for final refitting.",
    )
    parser.add_argument("--test-rounds", default="009-010")
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--feature-batch-size", type=int, default=8)
    parser.add_argument(
        "--preprocess",
        choices=("zone-gray", "background-residual", "full-background-residual"),
        default="background-residual",
    )
    parser.add_argument("--residual-gain", type=float, default=2.0)
    parser.add_argument("--head-batch-size", type=int, default=32)
    parser.add_argument("--hidden", type=int, default=128)
    parser.add_argument("--dropout", type=float, default=0.5)
    parser.add_argument("--feature-noise", type=float, default=0.05)
    parser.add_argument("--learning-rate", type=float, default=0.001)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument(
        "--fixed-epochs",
        type=int,
        default=0,
        help="Train exactly this many epochs without validation-based checkpoint selection.",
    )
    parser.add_argument("--min-epochs", type=int, default=20)
    parser.add_argument("--patience", type=int, default=15)
    parser.add_argument("--loss", choices=("bce", "permutation", "hybrid"), default="permutation")
    parser.add_argument("--hybrid-weight", type=float, default=0.25)
    parser.add_argument("--seed", type=int, default=20260722)
    parser.add_argument("--refresh-cache", action="store_true")
    parser.add_argument("--max-samples-per-split", type=int, default=0)
    parser.add_argument(
        "--cache",
        default="data/click-captcha-experiments/dinov2-features/zone-gray-standard-cls.pt",
    )
    parser.add_argument(
        "--checkpoint",
        default="data/click-captcha-experiments/dinov2-permutation-matcher.pt",
    )
    parser.add_argument(
        "--output",
        default="data/click-captcha-experiments/dinov2-permutation-report.json",
    )
    args = parser.parse_args()

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(args.threads)
    seed_everything(args.seed)
    train_rounds = parse_rounds(args.train_rounds)
    validation_rounds = parse_rounds(args.validation_rounds) if args.validation_rounds.strip() else []
    test_rounds = parse_rounds(args.test_rounds)
    if not validation_rounds and not args.fixed_epochs:
        raise ValueError("--validation-rounds is required unless --fixed-epochs is set.")
    all_rounds = train_rounds + validation_rounds + test_rounds
    if len(set(all_rounds)) != len(all_rounds):
        raise ValueError("train, validation, and test rounds must not overlap")

    data_dir = Path(args.data_dir)
    corrections_path = Path(args.corrections) if args.corrections else data_dir / "corrections.json"
    corrections = load_corrections(corrections_path)
    loaded = {round_name: load_round(data_dir / round_name, corrections) for round_name in all_rounds}
    splits = {
        "train": [sample for round_name in train_rounds for sample in loaded[round_name]],
        "test": [sample for round_name in test_rounds for sample in loaded[round_name]],
    }
    if validation_rounds:
        splits["validation"] = [
            sample for round_name in validation_rounds for sample in loaded[round_name]
        ]
    if args.max_samples_per_split:
        splits = {name: samples[:args.max_samples_per_split] for name, samples in splits.items()}
    background = make_background(splits["train"])

    import timm
    from timm.data import resolve_model_data_config

    backbone_name = "vit_small_patch14_dinov2"
    print(f"Loading frozen {backbone_name}...", flush=True)
    backbone = timm.create_model(backbone_name, pretrained=True, num_classes=0).eval()
    config = resolve_model_data_config(backbone)
    all_samples = [sample for split in splits.values() for sample in split]
    started = time.perf_counter()
    features, cache_key = load_or_extract_features(
        backbone,
        all_samples,
        config,
        Path(args.cache),
        args.feature_batch_size,
        args.refresh_cache,
        args.preprocess,
        background,
        args.residual_gain,
    )
    extraction_ms = (time.perf_counter() - started) * 1000
    feature_dim = next(iter(features.values())).numel()
    values = {name: split_tensors(features, samples) for name, samples in splits.items()}

    model = PermutationMatcher(feature_dim, args.hidden, args.dropout)
    print(f"Training {sum(parameter.numel() for parameter in model.parameters())} head parameters ({args.loss} loss)...", flush=True)
    best_epoch = train(
        model,
        values["train"],
        values.get("validation"),
        splits.get("validation"),
        args,
    )
    metrics = {
        name: evaluate(model, values[name], samples, args.loss, args.hybrid_weight)
        for name, samples in splits.items()
    }
    print(
        "Final: " + " ".join(
            f"{name}={metrics[name]['exact']}/{metrics[name]['total']}"
            for name in ("train", "validation", "test") if name in metrics
        ),
        flush=True,
    )

    checkpoint = Path(args.checkpoint)
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "format": "nju-click-captcha-dinov2-permutation-checkpoint/v1",
        "stateDict": model.state_dict(),
        "featureDim": feature_dim,
        "hidden": args.hidden,
        "dropout": args.dropout,
        "loss": args.loss,
        "cacheKey": cache_key,
        "bestEpoch": best_epoch,
    }, checkpoint)

    report = {
        "format": REPORT_FORMAT,
        "warning": "round-009/010 were previously used during development and are not a final holdout.",
        "backbone": backbone_name,
        "backboneParameters": sum(parameter.numel() for parameter in backbone.parameters()),
        "featureCache": str(Path(args.cache)),
        "featureExtractionMs": round(extraction_ms, 1),
        "bestEpoch": best_epoch,
        "checkpoint": str(checkpoint),
        "splits": {
            "trainRounds": train_rounds,
            "validationRounds": validation_rounds,
            "testRounds": test_rounds,
        },
        "corrections": str(corrections_path) if corrections else None,
        "preprocess": cache_key,
        "training": {
            "seed": args.seed,
            "hidden": args.hidden,
            "dropout": args.dropout,
            "featureNoise": args.feature_noise,
            "learningRate": args.learning_rate,
            "weightDecay": args.weight_decay,
            "loss": args.loss,
            "hybridWeight": args.hybrid_weight,
            "fixedEpochs": args.fixed_epochs or None,
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
