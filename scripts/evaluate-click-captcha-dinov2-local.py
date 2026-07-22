"""Evaluate DINOv2 global and local glyph matching on click-captcha samples.

This is an offline experiment only. It uses the click order as correspondence
supervision for scoring, never imports an OCR label, and does not modify raw
sample data. The script deliberately keeps every preprocessing detail in one
module so later model adapters can be compared on exactly the same splits.
"""

import argparse
import hashlib
import itertools
import json
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image


SCRIPT_FORMAT = "nju-click-captcha-dinov2-local-report/v1"
TARGET_SLOTS = ((120, 134), (143, 157), (166, 180), (189, 203))
CANDIDATE_SLOTS = ((0, 58), (58, 128), (128, 190), (190, 250))
SCENE_HEIGHT = 100
TARGET_TOP = 100
TARGET_BOTTOM = 120
PERMUTATIONS = tuple(itertools.permutations(range(4)))


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


def candidate_zone(x):
    if x < 58:
        return 0
    if x < 128:
        return 1
    if x < 190:
        return 2
    return 3


def load_round(round_dir):
    metadata = json.loads((round_dir / "metadata.json").read_text(encoding="utf-8"))
    samples = []
    for row in metadata["samples"]:
        image = np.asarray(Image.open(round_dir / row["image"]).convert("RGB"))
        order = tuple(candidate_zone(click["x"]) for click in row["clicks"])
        if sorted(order) != [0, 1, 2, 3]:
            raise ValueError(f"{round_dir.name}/{row['id']}: expected one click in each candidate zone")
        samples.append({
            "id": row["id"],
            "round": round_dir.name,
            "image": image,
            "order": order,
        })
    return samples


def image_fingerprint(samples):
    digest = hashlib.sha256()
    for sample in samples:
        digest.update(sample["round"].encode("utf-8"))
        digest.update(sample["id"].encode("utf-8"))
        digest.update(sample["image"].tobytes())
        digest.update(bytes(sample["order"]))
    return digest.hexdigest()


def make_background(samples):
    scenes = np.stack([sample["image"][:SCENE_HEIGHT] for sample in samples], axis=0)
    return np.median(scenes, axis=0).astype(np.float32)


def crop_to_mask(image, mask, pad):
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return image, mask
    left = max(0, int(xs.min()) - pad)
    top = max(0, int(ys.min()) - pad)
    right = min(image.shape[1], int(xs.max()) + pad + 1)
    bottom = min(image.shape[0], int(ys.max()) + pad + 1)
    return image[top:bottom, left:right], mask[top:bottom, left:right]


def render_glyph(image, mask, size, variant, margin):
    """Center a foreground glyph on white and return its image plus binary mask."""
    glyph, glyph_mask = crop_to_mask(image, mask, pad=2)
    canvas = np.full((size, size, 3), 255, dtype=np.uint8)
    mask_canvas = np.zeros((size, size), dtype=np.uint8)
    if not glyph_mask.any():
        return canvas, mask_canvas

    height, width = glyph_mask.shape
    scale = min((size - 2 * margin) / max(width, 1), (size - 2 * margin) / max(height, 1))
    output_width = max(1, round(width * scale))
    output_height = max(1, round(height * scale))

    if variant == "binary":
        binary = np.where(glyph_mask, 0, 255).astype(np.uint8)
        source = np.repeat(binary[:, :, None], 3, axis=2)
    elif variant == "foreground-rgb":
        source = np.where(glyph_mask[:, :, None], glyph, 255).astype(np.uint8)
    else:
        source = glyph.astype(np.uint8)

    rendered = np.asarray(
        Image.fromarray(source).resize((output_width, output_height), Image.Resampling.BICUBIC),
        dtype=np.uint8,
    )
    rendered_mask = np.asarray(
        Image.fromarray((glyph_mask * 255).astype(np.uint8)).resize(
            (output_width, output_height), Image.Resampling.NEAREST
        ),
        dtype=np.uint8,
    ) > 0
    top = (size - output_height) // 2
    left = (size - output_width) // 2
    canvas[top:top + output_height, left:left + output_width] = rendered
    mask_canvas[top:top + output_height, left:left + output_width] = rendered_mask.astype(np.uint8)
    return canvas, mask_canvas


def target_glyph(image, index, size, variant, margin):
    left, right = TARGET_SLOTS[index]
    crop = image[TARGET_TOP:TARGET_BOTTOM, left:right]
    mask = crop.min(axis=2) > 150
    return render_glyph(crop, mask, size, variant, margin)


def candidate_glyph(image, background, index, size, variant, difference_threshold, margin):
    left, right = CANDIDATE_SLOTS[index]
    crop = image[:SCENE_HEIGHT, left:right]
    background_crop = background[:, left:right]
    difference = np.abs(crop.astype(np.float32) - background_crop)
    mask = difference.max(axis=2) >= difference_threshold
    return render_glyph(crop, mask, size, variant, margin)


def normalize_for_model(image, mean, std):
    values = np.asarray(image, dtype=np.float32) / 255.0
    values = (values - mean) / std
    return torch.from_numpy(values.transpose(2, 0, 1))


def foreground_tokens(tokens, mask, patch_size, max_tokens, minimum_coverage):
    side = mask.shape[0] // patch_size
    coverage = mask.reshape(side, patch_size, side, patch_size).mean(axis=(1, 3)).reshape(-1)
    indices = np.flatnonzero(coverage >= minimum_coverage)
    if len(indices) < 8:
        indices = np.argsort(coverage)[-min(8, len(coverage)):]
    if len(indices) > max_tokens:
        indices = indices[np.argsort(coverage[indices])[-max_tokens:]]
    return tokens[indices]


def cosine_score(left, right):
    return float(torch.nn.functional.cosine_similarity(left[None], right[None]).item())


def patch_chamfer_score(left, right):
    similarities = left @ right.T
    return float((similarities.max(dim=1).values.mean() + similarities.max(dim=0).values.mean()).div(2).item())


def best_assignment(matrix):
    totals = [(sum(matrix[index, candidate] for index, candidate in enumerate(permutation)), permutation)
              for permutation in PERMUTATIONS]
    totals.sort(key=lambda entry: entry[0], reverse=True)
    return totals[0][1], float(totals[0][0] - totals[1][0]), float(totals[0][0])


def summarize(rows, elapsed_ms):
    exact = sum(row["correct"] for row in rows)
    chars = sum(row["characterCorrect"] for row in rows)
    return {
        "exact": exact,
        "total": len(rows),
        "exactAccuracy": round(exact / len(rows), 6) if rows else 0.0,
        "characterCorrect": chars,
        "characterTotal": len(rows) * 4,
        "characterAccuracy": round(chars / (len(rows) * 4), 6) if rows else 0.0,
        "elapsedMs": round(elapsed_ms, 1),
        "averageMs": round(elapsed_ms / len(rows), 2) if rows else 0.0,
        "rows": rows,
    }


@torch.no_grad()
def evaluate_samples(model, samples, background, variant, modes, config, args):
    mean = np.asarray(config["mean"], dtype=np.float32).reshape(1, 1, 3)
    std = np.asarray(config["std"], dtype=np.float32).reshape(1, 1, 3)
    size = config["input_size"][1]
    patch_size = model.patch_embed.patch_size[0]
    started = time.perf_counter()
    rows_by_mode = {mode: [] for mode in modes}

    for sample_index, sample in enumerate(samples, start=1):
        targets = [target_glyph(sample["image"], index, size, variant, args.margin) for index in range(4)]
        candidates = [
            candidate_glyph(
                sample["image"], background, index, size, variant,
                args.difference_threshold, args.margin,
            )
            for index in range(4)
        ]
        glyphs = targets + candidates
        tensors = torch.stack([normalize_for_model(glyph[0], mean, std) for glyph in glyphs])
        features = model.forward_features(tensors)
        cls_features = torch.nn.functional.normalize(features[:, 0, :], dim=1)
        patch_features = torch.nn.functional.normalize(features[:, 1:, :], dim=2)
        local_features = [
            foreground_tokens(
                patch_features[index], glyphs[index][1], patch_size,
                args.max_tokens, args.minimum_coverage,
            )
            for index in range(8)
        ]

        matrices = {mode: np.zeros((4, 4), dtype=np.float32) for mode in modes}
        for target_index in range(4):
            for candidate_index in range(4):
                if "cls" in matrices:
                    matrices["cls"][target_index, candidate_index] = cosine_score(
                        cls_features[target_index], cls_features[4 + candidate_index]
                    )
                if "patch-chamfer" in matrices:
                    matrices["patch-chamfer"][target_index, candidate_index] = patch_chamfer_score(
                        local_features[target_index], local_features[4 + candidate_index]
                    )

        expected = sample["order"]
        for mode, matrix in matrices.items():
            predicted, margin, total_score = best_assignment(matrix)
            correct = tuple(predicted) == tuple(expected)
            rows_by_mode[mode].append({
                "round": sample["round"],
                "id": sample["id"],
                "expected": list(expected),
                "predicted": list(predicted),
                "correct": correct,
                "characterCorrect": sum(left == right for left, right in zip(predicted, expected)),
                "assignmentMargin": round(margin, 6),
                "assignmentScore": round(total_score, 6),
                "matrix": matrix.round(6).tolist(),
            })
        if args.progress and sample_index % args.progress == 0:
            print(f"  {variant}: {sample_index}/{len(samples)}", flush=True)

    elapsed_ms = (time.perf_counter() - started) * 1000
    return {mode: summarize(rows, elapsed_ms) for mode, rows in rows_by_mode.items()}


def main():
    parser = argparse.ArgumentParser(
        description="Evaluate global and local DINOv2 glyph matching without OCR character labels."
    )
    parser.add_argument("--data-dir", default="data/click-captcha-samples")
    parser.add_argument("--train-rounds", default="001-006")
    parser.add_argument("--validation-rounds", default="007-008")
    parser.add_argument("--test-rounds", default="009-010")
    parser.add_argument("--variants", default="binary")
    parser.add_argument("--modes", default="cls,patch-chamfer")
    parser.add_argument("--difference-threshold", type=float, default=18.0)
    parser.add_argument("--minimum-coverage", type=float, default=0.08)
    parser.add_argument("--max-tokens", type=int, default=96)
    parser.add_argument("--margin", type=int, default=28)
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--progress", type=int, default=20)
    parser.add_argument("--max-samples", type=int, default=0)
    parser.add_argument("--evaluate-splits", default="train,validation,test")
    parser.add_argument("--output", default="data/click-captcha-experiments/dinov2-local-report.json")
    args = parser.parse_args()

    variants = [value.strip() for value in args.variants.split(",") if value.strip()]
    modes = [value.strip() for value in args.modes.split(",") if value.strip()]
    if any(value not in {"binary", "foreground-rgb", "raw"} for value in variants):
        raise ValueError("variants must contain binary, foreground-rgb, or raw")
    if any(value not in {"cls", "patch-chamfer"} for value in modes):
        raise ValueError("modes must contain cls or patch-chamfer")
    evaluate_splits = [value.strip() for value in args.evaluate_splits.split(",") if value.strip()]
    if not evaluate_splits or any(value not in {"train", "validation", "test"} for value in evaluate_splits):
        raise ValueError("evaluate-splits must contain train, validation, and/or test")

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(args.threads)
    train_rounds = parse_rounds(args.train_rounds)
    validation_rounds = parse_rounds(args.validation_rounds)
    test_rounds = parse_rounds(args.test_rounds)
    all_rounds = train_rounds + validation_rounds + test_rounds
    if len(set(all_rounds)) != len(all_rounds):
        raise ValueError("train, validation, and test rounds must not overlap")

    data_dir = Path(args.data_dir)
    loaded = {round_name: load_round(data_dir / round_name) for round_name in all_rounds}
    splits = {
        "train": [sample for round_name in train_rounds for sample in loaded[round_name]],
        "validation": [sample for round_name in validation_rounds for sample in loaded[round_name]],
        "test": [sample for round_name in test_rounds for sample in loaded[round_name]],
    }
    if args.max_samples:
        splits = {name: samples[:args.max_samples] for name, samples in splits.items()}
    evaluated_splits = {name: samples for name, samples in splits.items() if name in evaluate_splits}
    background = make_background([sample for round_name in train_rounds for sample in loaded[round_name]])

    import timm
    from timm.data import resolve_model_data_config

    model_name = "vit_small_patch14_dinov2"
    print(f"Loading {model_name}...", flush=True)
    model = timm.create_model(model_name, pretrained=True, num_classes=0).eval()
    config = resolve_model_data_config(model)
    print(f"Input size: {config['input_size']}; patch size: {model.patch_embed.patch_size}", flush=True)

    report = {
        "format": SCRIPT_FORMAT,
        "model": model_name,
        "modelParameters": sum(parameter.numel() for parameter in model.parameters()),
        "data": {
            "trainRounds": train_rounds,
            "validationRounds": validation_rounds,
            "testRounds": test_rounds,
            "fingerprint": image_fingerprint([sample for samples in splits.values() for sample in samples]),
        },
        "preprocess": {
            "inputSize": config["input_size"],
            "interpolation": config["interpolation"],
            "mean": config["mean"],
            "std": config["std"],
            "backgroundFrom": train_rounds,
            "differenceThreshold": args.difference_threshold,
            "minimumCoverage": args.minimum_coverage,
            "maxTokens": args.max_tokens,
            "glyphMargin": args.margin,
        },
        "results": {},
    }

    for variant in variants:
        print(f"Evaluating {variant}...", flush=True)
        by_split = {
            split_name: evaluate_samples(model, samples, background, variant, modes, config, args)
            for split_name, samples in evaluated_splits.items()
        }
        report["results"][variant] = {
            mode: {split_name: result[mode] for split_name, result in by_split.items()}
            for mode in modes
        }
        for mode in modes:
            if "test" not in report["results"][variant][mode]:
                continue
            test = report["results"][variant][mode]["test"]
            print(
                f"  {mode} test: {test['exact']}/{test['total']} exact "
                f"({test['exactAccuracy'] * 100:.1f}%), {test['averageMs']:.1f} ms/image",
                flush=True,
            )

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Report: {output}")


if __name__ == "__main__":
    main()
