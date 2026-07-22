"""Measure whether deterministic shape scores improve the frozen OCR teacher."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from click_captcha_dataset import assignments_for


def matrix_from_row(row: dict) -> np.ndarray:
    matrix = row["matrix"]
    if matrix and isinstance(matrix[0], str):
        matrix = [[float(value) for value in line.split()] for line in matrix]
    return np.asarray(matrix, dtype=np.float64)


def permutation_scores(matrix: np.ndarray, target_count: int) -> np.ndarray:
    return np.asarray([
        sum(matrix[index, candidate] for index, candidate in enumerate(assignment))
        for assignment in assignments_for(target_count)
    ])


def standardize(values: np.ndarray) -> np.ndarray:
    spread = values.std()
    if spread < 1e-8:
        return np.zeros_like(values)
    return (values - values.mean()) / spread


def load_dino(path: Path) -> dict:
    report = json.loads(path.read_text(encoding="utf-8"))
    rows = {}
    for split in ("validation", "test"):
        for row in report["metrics"][split]["rows"]:
            rows[(row["round"], row["id"])] = {
                "split": split,
                "targetCount": int(row.get("targetCount", len(row["expected"]))),
                "expected": tuple(row["expected"]),
                "matrix": matrix_from_row(row),
            }
    return rows


def load_ppocr(directory: Path, pattern: str) -> dict:
    rows = {}
    for path in directory.glob(pattern):
        report = json.loads(path.read_text(encoding="utf-8"))
        for row in report["rows"]:
            rows[(report["round"], row["id"])] = matrix_from_row(row)
    return rows


def load_shape(path: Path) -> dict:
    report = json.loads(path.read_text(encoding="utf-8"))
    return {
        (row["round"], row["id"]): matrix_from_row(row)
        for row in report["metrics"]["rows"]
    }


def evaluate(rows: dict, ppocr: dict, shape: dict, ppocr_weight: float, shape_weight: float) -> dict:
    output = []
    for key, row in sorted(rows.items()):
        target_count = row["targetCount"]
        assignments = assignments_for(target_count)
        dino_scores = standardize(permutation_scores(row["matrix"], target_count))
        ppocr_scores = standardize(permutation_scores(ppocr[key], target_count))
        shape_scores = standardize(permutation_scores(shape[key], target_count))
        baseline_scores = dino_scores + ppocr_weight * ppocr_scores
        fused_scores = baseline_scores + shape_weight * shape_scores
        baseline = assignments[int(np.argmax(baseline_scores))]
        predicted = assignments[int(np.argmax(fused_scores))]
        output.append({
            "round": key[0],
            "id": key[1],
            "targetCount": target_count,
            "expected": list(row["expected"]),
            "baselinePredicted": list(baseline),
            "predicted": list(predicted),
            "baselineCorrect": baseline == row["expected"],
            "correct": predicted == row["expected"],
            "scoreMargin": float(np.sort(fused_scores)[-1] - np.sort(fused_scores)[-2]),
        })
    exact = sum(row["correct"] for row in output)
    return {
        "exact": exact,
        "total": len(output),
        "exactAccuracy": exact / len(output),
        "baselineExact": sum(row["baselineCorrect"] for row in output),
        "changedCorrect": sum(not row["baselineCorrect"] and row["correct"] for row in output),
        "changedWrong": sum(row["baselineCorrect"] and not row["correct"] for row in output),
        "rows": output,
    }


def summary(metrics: dict) -> dict:
    return {key: metrics[key] for key in (
        "exact", "total", "exactAccuracy", "baselineExact", "changedCorrect", "changedWrong",
    )}


def main() -> None:
    parser = argparse.ArgumentParser(description="Fuse frozen DINO, PP-OCR, and deterministic shape scores.")
    parser.add_argument("--dino-report", type=Path, required=True)
    parser.add_argument("--ppocr-dir", type=Path, required=True)
    parser.add_argument("--ppocr-pattern", default="ppocr-round-*.json")
    parser.add_argument("--shape-report", type=Path, required=True)
    parser.add_argument("--ppocr-weight", type=float, default=0.75)
    parser.add_argument("--shape-weights", default="0,0.05,0.1,0.2,0.3,0.5,0.75,1")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    dino = load_dino(args.dino_report)
    ppocr = load_ppocr(args.ppocr_dir, args.ppocr_pattern)
    shape = load_shape(args.shape_report)
    missing_ppocr = set(dino).difference(ppocr)
    missing_shape = set(dino).difference(shape)
    if missing_ppocr or missing_shape:
        raise ValueError(
            f"Missing rows: PP-OCR={len(missing_ppocr)}, shape={len(missing_shape)}"
        )
    splits = {
        split: {key: row for key, row in dino.items() if row["split"] == split}
        for split in ("validation", "test")
    }
    weights = tuple(float(value) for value in args.shape_weights.split(",") if value.strip())
    grid = {
        weight: {
            split: evaluate(rows, ppocr, shape, args.ppocr_weight, weight)
            for split, rows in splits.items()
        }
        for weight in weights
    }
    selected_weight = max(
        weights,
        key=lambda weight: (grid[weight]["validation"]["exact"], -weight),
    )
    result = {
        "format": "nju-click-captcha-shape-fusion-report/v1",
        "dinoReport": str(args.dino_report),
        "ppocrPattern": args.ppocr_pattern,
        "shapeReport": str(args.shape_report),
        "ppocrWeight": args.ppocr_weight,
        "selectionSplit": "validation",
        "selectedShapeWeight": selected_weight,
        "selected": grid[selected_weight],
        "grid": {
            str(weight): {split: summary(metrics) for split, metrics in values.items()}
            for weight, values in grid.items()
        },
    }
    print(json.dumps({
        "selectedShapeWeight": selected_weight,
        "selected": {split: summary(metrics) for split, metrics in result["selected"].items()},
        "grid": result["grid"],
    }, ensure_ascii=False, indent=2))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Report: {args.output}")


if __name__ == "__main__":
    main()
