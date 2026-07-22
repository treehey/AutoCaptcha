"""Evaluate deterministic shape registration on click-captcha rounds."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from click_captcha_dataset import assignments_for, load_corrections, load_round, parse_rounds
from click_captcha_shape import ShapeConfig, make_candidate_background, score_matrix


def permutation_scores(matrix: np.ndarray, target_count: int) -> np.ndarray:
    return np.asarray([
        sum(matrix[index, candidate] for index, candidate in enumerate(assignment))
        for assignment in assignments_for(target_count)
    ])


def softmax(values: np.ndarray) -> np.ndarray:
    shifted = values - values.max()
    exponentials = np.exp(shifted)
    return exponentials / exponentials.sum()


def evaluate(samples: list[dict], background: np.ndarray, config: ShapeConfig) -> dict:
    rows = []
    exact = 0
    character_correct = 0
    started = time.perf_counter()
    for sample in samples:
        target_count = sample["targetCount"]
        matrix, debug = score_matrix(sample["image"], target_count, background, config)
        scores = permutation_scores(matrix, target_count)
        ranking = np.argsort(scores)[::-1]
        assignments = assignments_for(target_count)
        predicted = assignments[int(ranking[0])]
        expected = sample["order"]
        correct = predicted == expected
        exact += correct
        character_correct += sum(left == right for left, right in zip(predicted, expected))
        probabilities = softmax(scores)
        rows.append({
            "round": sample["round"],
            "id": sample["id"],
            "targetCount": target_count,
            "expected": list(expected),
            "predicted": list(predicted),
            "correct": correct,
            "topProbability": round(float(probabilities[ranking[0]]), 6),
            "probabilityMargin": round(float(probabilities[ranking[0]] - probabilities[ranking[1]]), 6),
            "scoreMargin": round(float(scores[ranking[0]] - scores[ranking[1]]), 6),
            "matrix": matrix.round(8).tolist(),
            "debug": debug,
        })
    elapsed_ms = (time.perf_counter() - started) * 1000
    character_total = sum(sample["targetCount"] for sample in samples)
    return {
        "exact": exact,
        "total": len(samples),
        "exactAccuracy": round(exact / len(samples), 6),
        "characterCorrect": character_correct,
        "characterTotal": character_total,
        "characterAccuracy": round(character_correct / character_total, 6),
        "averageInferenceMs": round(elapsed_ms / len(samples), 3),
        "rows": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate category-agnostic click-captcha shape matching.")
    parser.add_argument("--data-dir", default="data/click-captcha-samples")
    parser.add_argument("--corrections", default="")
    parser.add_argument("--background-rounds", default="001-010")
    parser.add_argument("--eval-rounds", default="011-016")
    parser.add_argument("--size", type=int, default=64)
    parser.add_argument("--margin", type=int, default=6)
    parser.add_argument("--foreground-threshold", type=int, default=160)
    parser.add_argument("--residual-gain", type=float, default=2.0)
    parser.add_argument("--rotation-min", type=int, default=-60)
    parser.add_argument("--rotation-max", type=int, default=60)
    parser.add_argument("--rotation-step", type=int, default=5)
    parser.add_argument("--foreground-weight", type=float, default=0.20)
    parser.add_argument("--contour-weight", type=float, default=0.30)
    parser.add_argument("--skeleton-weight", type=float, default=0.50)
    parser.add_argument("--topology-weight", type=float, default=0.30)
    parser.add_argument("--output", default="data/click-captcha-experiments/shape-report.json")
    args = parser.parse_args()

    data_dir = Path(args.data_dir)
    corrections_path = Path(args.corrections) if args.corrections else data_dir / "corrections.json"
    corrections = load_corrections(corrections_path)
    background_rounds = parse_rounds(args.background_rounds)
    eval_rounds = parse_rounds(args.eval_rounds)
    background_samples = [
        sample
        for round_name in background_rounds
        for sample in load_round(data_dir / round_name, corrections)
    ]
    eval_samples = [
        sample
        for round_name in eval_rounds
        for sample in load_round(data_dir / round_name, corrections)
    ]
    rotations = tuple(range(args.rotation_min, args.rotation_max + 1, args.rotation_step))
    config = ShapeConfig(
        size=args.size,
        margin=args.margin,
        foreground_threshold=args.foreground_threshold,
        residual_gain=args.residual_gain,
        rotations=rotations,
        foreground_weight=args.foreground_weight,
        contour_weight=args.contour_weight,
        skeleton_weight=args.skeleton_weight,
        topology_weight=args.topology_weight,
    )
    metrics = evaluate(eval_samples, make_candidate_background(background_samples), config)
    report = {
        "format": "nju-click-captcha-shape-report/v1",
        "backgroundRounds": background_rounds,
        "evalRounds": eval_rounds,
        "corrections": str(corrections_path) if corrections else None,
        "config": {
            "size": config.size,
            "margin": config.margin,
            "foregroundThreshold": config.foreground_threshold,
            "residualGain": config.residual_gain,
            "rotations": config.rotations,
            "weights": {
                "foreground": config.foreground_weight,
                "contour": config.contour_weight,
                "skeleton": config.skeleton_weight,
                "topology": config.topology_weight,
            },
        },
        "metrics": metrics,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"Shape: {metrics['exact']}/{metrics['total']} = {metrics['exactAccuracy']:.1%}; "
        f"characters {metrics['characterCorrect']}/{metrics['characterTotal']} = "
        f"{metrics['characterAccuracy']:.1%}; {metrics['averageInferenceMs']:.1f} ms/image"
    )
    print(f"Report: {output}")


if __name__ == "__main__":
    main()
