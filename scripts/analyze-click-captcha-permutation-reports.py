"""Compare and ensemble click-captcha permutation matcher reports.

The matcher emits a 4 by 4 target-to-candidate score matrix for every sample.
This utility reuses those matrices to evaluate independent training seeds without
re-running DINOv2 feature extraction or changing the source samples.
"""

import argparse
import itertools
import json
from pathlib import Path

import numpy as np


PERMUTATIONS = tuple(itertools.permutations(range(4)))


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("reports", nargs="+", type=Path)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def softmax(values):
    values = values - np.max(values)
    exponential = np.exp(values)
    return exponential / exponential.sum()


def permutation_scores(matrix):
    return np.asarray([
        sum(matrix[target_index, candidate_index]
            for target_index, candidate_index in enumerate(permutation))
        for permutation in PERMUTATIONS
    ])


def parse_rows(path):
    report = json.loads(path.read_text(encoding="utf-8"))
    splits = {}
    for split_name in ("validation", "test"):
        rows = {}
        for row in report["metrics"][split_name]["rows"]:
            key = (row["round"], row["id"])
            matrix = row["matrix"]
            if matrix and isinstance(matrix[0], str):
                matrix = [[float(value) for value in line.split()] for line in matrix]
            rows[key] = {
                "expected": tuple(row["expected"]),
                "matrix": np.asarray(matrix, dtype=np.float64),
            }
        splits[split_name] = rows
    return splits


def summarize(rows_by_report, split_name, method):
    shared = set.intersection(*(set(rows[split_name]) for rows in rows_by_report))
    outcomes = []
    for key in sorted(shared):
        matrices = [rows[split_name][key]["matrix"] for rows in rows_by_report]
        expected = rows_by_report[0][split_name][key]["expected"]
        per_model_scores = np.stack([permutation_scores(matrix) for matrix in matrices])
        if method == "mean-matrix":
            scores = permutation_scores(np.mean(matrices, axis=0))
            probabilities = softmax(scores)
        elif method == "mean-probability":
            probabilities = np.mean([softmax(scores) for scores in per_model_scores], axis=0)
            scores = probabilities
        else:
            raise ValueError(f"Unsupported method: {method}")
        ranking = np.argsort(scores)[::-1]
        permutation = PERMUTATIONS[int(ranking[0])]
        character_correct = sum(a == b for a, b in zip(permutation, expected))
        outcomes.append({
            "round": key[0],
            "id": key[1],
            "expected": list(expected),
            "predicted": list(permutation),
            "correct": permutation == expected,
            "characterCorrect": character_correct,
            "topProbability": float(probabilities[ranking[0]]),
            "probabilityMargin": float(probabilities[ranking[0]] - probabilities[ranking[1]]),
        })
    total = len(outcomes)
    return {
        "exact": sum(row["correct"] for row in outcomes),
        "total": total,
        "exactAccuracy": sum(row["correct"] for row in outcomes) / total,
        "characterCorrect": sum(row["characterCorrect"] for row in outcomes),
        "characterTotal": total * 4,
        "characterAccuracy": sum(row["characterCorrect"] for row in outcomes) / (total * 4),
        "rows": outcomes,
    }


def confidence_breakdown(rows):
    thresholds = (0.0, 0.10, 0.20, 0.30, 0.40, 0.50)
    summary = []
    for threshold in thresholds:
        accepted = [row for row in rows if row["probabilityMargin"] >= threshold]
        correct = sum(row["correct"] for row in accepted)
        summary.append({
            "minimumProbabilityMargin": threshold,
            "accepted": len(accepted),
            "coverage": len(accepted) / len(rows),
            "exact": correct,
            "exactAccuracy": correct / len(accepted) if accepted else None,
        })
    return summary


def compact_metrics(metrics):
    return {
        key: metrics[key]
        for key in (
            "exact", "total", "exactAccuracy",
            "characterCorrect", "characterTotal", "characterAccuracy",
        )
    }


def main():
    args = parse_args()
    reports = [parse_rows(path) for path in args.reports]
    methods = {
        method: {
            split: summarize(reports, split, method)
            for split in ("validation", "test")
        }
        for method in ("mean-matrix", "mean-probability")
    }
    result = {
        "format": "nju-click-captcha-permutation-ensemble-report/v1",
        "reports": [str(path) for path in args.reports],
        "methods": {
            method: {
                split: {
                    **compact_metrics(metrics),
                    "confidence": confidence_breakdown(metrics["rows"]),
                }
                for split, metrics in splits.items()
            }
            for method, splits in methods.items()
        },
    }
    print(json.dumps(result["methods"], ensure_ascii=False, indent=2))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Saved ensemble report to {args.output}")


if __name__ == "__main__":
    main()
