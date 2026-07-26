"""Print compact, deterministic input summaries for browser parity debugging."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np

from click_captcha_dataset import load_corrections, load_round, parse_rounds


def load_training_module():
    path = Path(__file__).with_name("train-click-captcha-student.py")
    spec = importlib.util.spec_from_file_location("click_captcha_student_training", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser(description="Inspect one canonical click-captcha preprocessing result.")
    parser.add_argument("--round", default="001")
    parser.add_argument("--id", default="0001")
    parser.add_argument("--background-rounds", default="001-013")
    parser.add_argument("--data-dir", type=Path, default=Path("data/click-captcha-samples"))
    args = parser.parse_args()

    training = load_training_module()
    corrections = load_corrections(args.data_dir / "corrections.json")
    samples = load_round(args.data_dir / f"round-{args.round}", corrections)
    sample = next(item for item in samples if item["id"] == args.id)
    background_samples = [
        item
        for round_name in parse_rounds(args.background_rounds)
        for item in load_round(args.data_dir / round_name, corrections)
    ]
    background = training.make_candidate_background(background_samples)
    targets, candidates, boxes, target_count = training.preprocess_sample(
        sample,
        background,
        64,
        160,
        2,
        (-60, -40, -20, 0, 20, 40, 60),
    )
    print(json.dumps({
        "targetCount": target_count,
        "boxes": boxes,
        "targets": [float(item.sum()) for item in targets],
        "candidates": [[float(item.sum()) for item in group] for group in candidates],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
