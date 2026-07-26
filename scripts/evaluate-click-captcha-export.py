"""Evaluate an exported click-CAPTCHA ensemble with its shipped background asset."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torchvision.models import efficientnet_b0

from click_captcha_dataset import load_corrections, load_round, parse_rounds


def load_export_module():
    path = Path(__file__).with_name("export-click-captcha-ensemble.py")
    spec = importlib.util.spec_from_file_location("click_captcha_export", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate the exact background pixels shipped with an ONNX model.")
    parser.add_argument("--checkpoints", type=Path, nargs="+", required=True)
    parser.add_argument("--background", type=Path, required=True)
    parser.add_argument("--rounds", default="001-020")
    parser.add_argument("--data-dir", type=Path, default=Path("data/click-captcha-samples"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    exporter = load_export_module()
    training = exporter.load_training_module()
    checkpoints = [torch.load(path, map_location="cpu", weights_only=False) for path in args.checkpoints]
    reference = checkpoints[0]
    network = efficientnet_b0(weights=None)
    encoder = training.MobilePrefixEncoder(network.features[:int(reference["mobileCacheCut"])])
    encoder.load_state_dict(reference["backboneStateDict"])
    input_channels = int(reference["stateDict"]["target_projection.weight"].shape[1])
    heads = []
    for checkpoint in checkpoints:
        head = training.MobileLocalFeaturePermutationMatcher(
            input_channels,
            int(checkpoint["embeddingDim"]),
            int(checkpoint["pairHidden"]),
        )
        head.load_state_dict(checkpoint["stateDict"])
        heads.append(head)
    model = exporter.EfficientLocalEnsemble(encoder, heads).eval()

    background = np.asarray(Image.open(args.background).convert("RGB"), dtype=np.float32)
    config = argparse.Namespace(
        input_size=int(reference["inputSize"]),
        foreground_threshold=int(reference["foregroundThreshold"]),
        residual_gain=float(reference["residualGain"]),
        candidate_rotations=tuple(float(value) for value in reference["candidateRotations"]),
    )
    corrections = load_corrections(args.data_dir / "corrections.json")
    samples = [
        sample
        for round_name in parse_rounds(args.rounds)
        for sample in load_round(args.data_dir / round_name, corrections)
    ]
    rows = []
    for sample in samples:
        targets, candidates, _, target_count = training.preprocess_sample(
            sample,
            background,
            config.input_size,
            config.foreground_threshold,
            config.residual_gain,
            config.candidate_rotations,
        )
        with torch.no_grad():
            matrices = model(targets[None], candidates[None]).numpy()[0]
        predicted = exporter.prediction(matrices, target_count)
        correct = tuple(predicted) == tuple(sample["order"])
        rows.append({
            "round": sample["round"],
            "id": sample["id"],
            "expected": list(sample["order"]),
            "predicted": list(predicted),
            "correct": correct,
        })
    result = {
        "format": "nju-click-captcha-export-evaluation/v1",
        "background": str(args.background),
        "rounds": parse_rounds(args.rounds),
        "exact": sum(row["correct"] for row in rows),
        "total": len(rows),
        "byRound": {
            round_name: {
                "exact": sum(row["correct"] for row in rows if row["round"] == round_name),
                "total": sum(row["round"] == round_name for row in rows),
            }
            for round_name in sorted({row["round"] for row in rows})
        },
        "rows": rows,
    }
    result["exactAccuracy"] = result["exact"] / result["total"]
    print(json.dumps({key: value for key, value in result.items() if key != "rows"}, ensure_ascii=False, indent=2))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
