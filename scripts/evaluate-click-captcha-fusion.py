"""Evaluate DINO and PP-OCR click-captcha fusion without retraining either model.

The validation rounds select an auxiliary PP-OCR weight.  The test split is
reported after selection only; it must not be used to choose the weight.
"""

import argparse
import json
from pathlib import Path

import numpy as np

from click_captcha_dataset import assignments_for


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dino-report", type=Path, required=True)
    parser.add_argument("--ppocr-dir", type=Path, required=True)
    parser.add_argument("--ppocr-pattern", default="round-*-ppocr-residual-rot45.json")
    parser.add_argument("--weights", default="0,0.1,0.2,0.3,0.5,0.75,1,1.5,2")
    parser.add_argument(
        "--fixed-weight",
        type=float,
        help="Use a preselected auxiliary weight without performing validation selection.",
    )
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def permutation_scores(matrix, target_count):
    return np.asarray([
        sum(matrix[target_index, candidate_index]
            for target_index, candidate_index in enumerate(assignment))
        for assignment in assignments_for(target_count)
    ], dtype=np.float64)


def standardize(scores):
    spread = scores.std()
    if spread < 1e-8:
        return np.zeros_like(scores)
    return (scores - scores.mean()) / spread


def softmax(scores):
    shifted = scores - np.max(scores)
    values = np.exp(shifted)
    return values / values.sum()


def subset_metrics(rows):
    total = len(rows)
    exact = sum(row["correct"] for row in rows)
    return {
        "exact": exact,
        "total": total,
        "exactAccuracy": exact / total if total else None,
    }


def dino_rows(path):
    report = json.loads(path.read_text(encoding="utf-8"))
    rows = {}
    for split in ("validation", "test"):
        if split not in report["metrics"]:
            continue
        for row in report["metrics"][split]["rows"]:
            matrix = row["matrix"]
            if matrix and isinstance(matrix[0], str):
                matrix = [[float(value) for value in line.split()] for line in matrix]
            rows[(row["round"], row["id"])] = {
                "split": split,
                "expected": tuple(row["expected"]),
                "targetCount": int(row.get("targetCount", len(row["expected"]))),
                "matrix": np.asarray(matrix, dtype=np.float64),
            }
    return rows


def ppocr_rows(directory, pattern):
    rows = {}
    for path in directory.glob(pattern):
        report = json.loads(path.read_text(encoding="utf-8"))
        for row in report["rows"]:
            rows[(report["round"], row["id"])] = {
                "targetCount": int(row.get("targetCount", len(row["expected"]))),
                "matrix": np.asarray(row["matrix"], dtype=np.float64),
            }
    return rows


def evaluate(rows, ppo_rows, weight):
    output = []
    for key, row in sorted(rows.items()):
        target_count = row["targetCount"]
        ppo_row = ppo_rows[key]
        if ppo_row["targetCount"] != target_count:
            raise ValueError(f"Target count mismatch for {key}: {target_count} vs {ppo_row['targetCount']}")
        dino = permutation_scores(row["matrix"], target_count)
        ppo = permutation_scores(ppo_row["matrix"], target_count)
        assignments = assignments_for(target_count)
        dino_prediction = assignments[int(np.argmax(dino))]
        scores = standardize(dino) + weight * standardize(ppo)
        ranking = np.argsort(scores)[::-1]
        probabilities = softmax(scores)
        prediction = assignments[int(ranking[0])]
        output.append({
            "round": key[0],
            "id": key[1],
            "targetCount": target_count,
            "expected": list(row["expected"]),
            "dinoPredicted": list(dino_prediction),
            "predicted": list(prediction),
            "dinoCorrect": dino_prediction == row["expected"],
            "correct": prediction == row["expected"],
            "fusionTopProbability": float(probabilities[ranking[0]]),
            "fusionProbabilityMargin": float(probabilities[ranking[0]] - probabilities[ranking[1]]),
            "fusionScoreMargin": float(scores[ranking[0]] - scores[ranking[1]]),
        })
    exact = sum(row["correct"] for row in output)
    return {
        "exact": exact,
        "total": len(output),
        "exactAccuracy": exact / len(output),
        "changedCorrect": sum(not row["dinoCorrect"] and row["correct"] for row in output),
        "changedWrong": sum(row["dinoCorrect"] and not row["correct"] for row in output),
        "byTargetCount": {
            str(target_count): subset_metrics([
                row for row in output if row["targetCount"] == target_count
            ])
            for target_count in sorted({row["targetCount"] for row in output})
        },
        "rows": output,
    }


def metrics_only(result):
    return {key: result[key] for key in (
        "exact", "total", "exactAccuracy", "changedCorrect", "changedWrong",
    )}


def main():
    args = parse_args()
    weights = tuple(float(value) for value in args.weights.split(",") if value.strip())
    dino = dino_rows(args.dino_report)
    ppo = ppocr_rows(args.ppocr_dir, args.ppocr_pattern)
    missing = set(dino).difference(ppo)
    if missing:
        raise ValueError(f"Missing PP-OCR rows for {len(missing)} DINO rows, e.g. {sorted(missing)[:3]}")
    split_names = tuple(split for split in ("validation", "test") if any(
        row["split"] == split for row in dino.values()
    ))
    if not split_names:
        raise ValueError("The DINO report has no validation or test rows.")
    if args.fixed_weight is None and "validation" not in split_names:
        raise ValueError("A validation split is required unless --fixed-weight is set.")
    splits = {
        split: {key: row for key, row in dino.items() if row["split"] == split}
        for split in split_names
    }
    weights = (args.fixed_weight,) if args.fixed_weight is not None else weights
    grid = {
        str(weight): {
            split: evaluate(rows, ppo, weight)
            for split, rows in splits.items()
        }
        for weight in weights
    }
    best_weight = args.fixed_weight if args.fixed_weight is not None else max(
        weights,
        key=lambda weight: (
            grid[str(weight)]["validation"]["exactAccuracy"],
            -weight,
        ),
    )
    result = {
        "format": "nju-click-captcha-fusion-report/v1",
        "dinoReport": str(args.dino_report),
        "ppocrPattern": args.ppocr_pattern,
        "selectionSplit": "fixed" if args.fixed_weight is not None else "validation",
        "selectedWeight": best_weight,
        "selected": {
            split: grid[str(best_weight)][split]
            for split in split_names
        },
        "grid": {
            weight: {
                split: metrics_only(metrics)
                for split, metrics in values.items()
            }
            for weight, values in grid.items()
        },
    }
    print(json.dumps({
        "selectedWeight": best_weight,
        "selected": {
            split: metrics_only(metrics)
            for split, metrics in result["selected"].items()
        },
        "grid": result["grid"],
    }, ensure_ascii=False, indent=2))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Saved fusion report to {args.output}")


if __name__ == "__main__":
    main()
