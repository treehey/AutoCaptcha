"""Fuse several lightweight student heads and optional deterministic shape scores."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from click_captcha_dataset import assignments_for


def matrix_from_row(row: dict) -> np.ndarray:
    return np.asarray(row["matrix"], dtype=np.float64)


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


def load_student_reports(paths: list[Path]) -> dict[str, list[dict]]:
    reports = [json.loads(path.read_text(encoding="utf-8")) for path in paths]
    return {
        split: [report["metrics"][split]["rows"] for report in reports]
        for split in ("validation", "test")
    }


def load_shape(paths: list[Path] | None) -> dict:
    if not paths:
        return {}
    rows = {}
    for path in paths:
        report = json.loads(path.read_text(encoding="utf-8"))
        rows.update({
            (row["round"], row["id"]): matrix_from_row(row)
            for row in report["metrics"]["rows"]
        })
    return rows


def evaluate(head_rows: list[list[dict]], shape: dict, shape_weight: float) -> dict:
    rows = []
    for head_values in zip(*head_rows):
        reference = head_values[0]
        key = (reference["round"], reference["id"])
        if any((row["round"], row["id"]) != key for row in head_values):
            raise ValueError(f"Student report rows are not aligned at {key}")
        target_count = int(reference["targetCount"])
        assignments = assignments_for(target_count)
        head_scores = [
            standardize(permutation_scores(matrix_from_row(row), target_count))
            for row in head_values
        ]
        base_scores = np.mean(head_scores, axis=0)
        scores = base_scores.copy()
        if shape:
            scores += shape_weight * standardize(permutation_scores(shape[key], target_count))
        ranking = np.argsort(scores)[::-1]
        baseline = assignments[int(np.argmax(base_scores))]
        predicted = assignments[int(ranking[0])]
        expected = tuple(reference["expected"])
        rows.append({
            "round": key[0],
            "id": key[1],
            "targetCount": target_count,
            "expected": list(expected),
            "baselinePredicted": list(baseline),
            "predicted": list(predicted),
            "baselineCorrect": baseline == expected,
            "correct": predicted == expected,
            "scoreMargin": float(scores[ranking[0]] - scores[ranking[1]]),
        })
    exact = sum(row["correct"] for row in rows)
    character_correct = sum(
        sum(left == right for left, right in zip(row["predicted"], row["expected"]))
        for row in rows
    )
    character_total = sum(row["targetCount"] for row in rows)
    return {
        "exact": exact,
        "total": len(rows),
        "exactAccuracy": exact / len(rows),
        "characterCorrect": character_correct,
        "characterTotal": character_total,
        "characterAccuracy": character_correct / character_total,
        "baselineExact": sum(row["baselineCorrect"] for row in rows),
        "changedCorrect": sum(not row["baselineCorrect"] and row["correct"] for row in rows),
        "changedWrong": sum(row["baselineCorrect"] and not row["correct"] for row in rows),
        "byRound": {
            round_name: {
                "exact": sum(row["correct"] for row in rows if row["round"] == round_name),
                "total": sum(row["round"] == round_name for row in rows),
            }
            for round_name in sorted({row["round"] for row in rows})
        },
        "rows": rows,
    }


def summary(metrics: dict) -> dict:
    return {key: metrics[key] for key in (
        "exact", "total", "exactAccuracy", "characterCorrect", "characterTotal",
        "characterAccuracy", "baselineExact", "changedCorrect", "changedWrong", "byRound",
    )}


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate a shared-backbone student-head ensemble.")
    parser.add_argument("--reports", type=Path, nargs="+", required=True)
    parser.add_argument("--shape-report", type=Path, nargs="+")
    parser.add_argument("--shape-weights", default="0,0.02,0.05,0.1,0.15,0.2")
    parser.add_argument("--fixed-shape-weight", type=float)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    students = load_student_reports(args.reports)
    shape = load_shape(args.shape_report)
    weights = (
        (args.fixed_shape_weight,)
        if args.fixed_shape_weight is not None
        else tuple(float(value) for value in args.shape_weights.split(",") if value.strip())
    )
    grid = {
        weight: {
            split: evaluate(rows, shape, weight)
            for split, rows in students.items()
        }
        for weight in weights
    }
    selected_weight = args.fixed_shape_weight if args.fixed_shape_weight is not None else max(
        weights,
        key=lambda weight: (grid[weight]["validation"]["exact"], -weight),
    )
    result = {
        "format": "nju-click-captcha-student-ensemble-report/v1",
        "studentReports": [str(path) for path in args.reports],
        "shapeReports": [str(path) for path in args.shape_report] if args.shape_report else [],
        "selectionSplit": "fixed" if args.fixed_shape_weight is not None else "validation",
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
