import json
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn


SEED = 20260711
CHARSET = "23456789abcdefghijklmnpqrstuvwxy"
CHAR_TO_INDEX = {char: index for index, char in enumerate(CHARSET)}
VARIANT_WEIGHT = {
    "strict-color": 2,
    "balanced-color": 4,
    "loose-color": 3,
    "thin-line-clean": 3,
    "aggressive-line-clean": 2,
    "simple-threshold": 2,
    "legacy-fallback": 1,
    "color-cluster": 2,
}


def normalize(value):
    return (value or "").lower()


def map_regression(report):
    output = {}
    for round_result in report.get("roundResults", []):
        for sample in round_result.get("samples", []):
            output[f'{round_result["round"]}#{sample["id"]}'] = {
                **sample,
                "round": round_result["round"],
            }
    return output


def group_predictions(rows):
    output = {}
    for row in rows:
        key = f'{row["round"]}#{row["id"]}'
        output.setdefault(key, [None] * 4)[row["pos"]] = row
    return output


def support(sample, position, label):
    target = normalize(label)
    score = 0.0
    count = 0
    max_confidence = 0.0
    for candidate in sample.get("candidates", []):
        code = normalize(candidate.get("code"))
        if len(code) != 4 or code[position] != target:
            continue
        confidence = max(0.0, candidate.get("confidence", 0.0))
        score += VARIANT_WEIGHT.get(candidate.get("variant"), 1) + confidence / 25
        count += 1
        max_confidence = max(max_confidence, confidence)
    return score, count, max_confidence


def one_hot(index, size):
    output = np.zeros(size, dtype=np.float32)
    if 0 <= index < size:
        output[index] = 1
    return output


def build_rows(regression, predictions):
    rows = []
    for key, chars in predictions.items():
        sample = regression.get(key)
        current_code = normalize(sample.get("actual") if sample else "")
        expected = normalize(sample.get("expected") if sample else "")
        if not sample or len(current_code) != 4 or len(expected) != 4 or any(item is None for item in chars):
            continue
        for position, cnn in enumerate(chars):
            current = current_code[position]
            predicted = normalize(cnn["predicted"])
            if current == predicted or current not in CHAR_TO_INDEX or predicted not in CHAR_TO_INDEX:
                continue
            current_support, current_count, current_max = support(sample, position, current)
            predicted_support, predicted_count, predicted_max = support(sample, position, predicted)
            top3 = cnn["top3"]
            probabilities = [item["probability"] for item in top3]
            while len(probabilities) < 3:
                probabilities.append(0)
            numeric = np.array([
                cnn["confidence"],
                probabilities[0] - probabilities[1],
                probabilities[1],
                probabilities[2],
                min(current_support, 30) / 30,
                min(predicted_support, 30) / 30,
                np.clip((predicted_support - current_support) / 20, -1, 1),
                current_count / 7,
                predicted_count / 7,
                current_max / 100,
                predicted_max / 100,
            ], dtype=np.float32)
            features = np.concatenate([
                numeric,
                one_hot(CHAR_TO_INDEX[current], len(CHARSET)),
                one_hot(CHAR_TO_INDEX[predicted], len(CHARSET)),
                one_hot(position, 4),
            ])
            rows.append({
                "key": key,
                "round": sample["round"],
                "position": position,
                "current": current,
                "predicted": predicted,
                "expected": expected[position],
                "features": features,
                "target": float(predicted == expected[position] and current != expected[position]),
            })
    return rows


def train_logistic(rows, positive_weight):
    torch.manual_seed(SEED)
    x = torch.tensor(np.stack([row["features"] for row in rows]), dtype=torch.float32)
    y = torch.tensor([row["target"] for row in rows], dtype=torch.float32).reshape(-1, 1)
    model = nn.Linear(x.shape[1], 1)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.025, weight_decay=0.01)
    criterion = nn.BCEWithLogitsLoss(pos_weight=torch.tensor([positive_weight]))
    for _ in range(500):
        optimizer.zero_grad()
        loss = criterion(model(x), y)
        loss.backward()
        optimizer.step()
    return model


def probabilities(model, rows):
    if not rows:
        return {}
    x = torch.tensor(np.stack([row["features"] for row in rows]), dtype=torch.float32)
    with torch.no_grad():
        values = torch.sigmoid(model(x)).reshape(-1).numpy()
    return {(row["key"], row["position"]): float(value) for row, value in zip(rows, values)}


def evaluate(regression, rows, scores, threshold, max_changes, rounds):
    by_key = {}
    for row in rows:
        if row["round"] in rounds:
            by_key.setdefault(row["key"], []).append(row)
    correct = 0
    baseline = 0
    fixes = 0
    breaks = 0
    round_gain = {round_name: 0 for round_name in rounds}
    changes = []
    for key, sample in regression.items():
        if sample["round"] not in rounds or len(normalize(sample.get("actual"))) != 4:
            continue
        expected = normalize(sample["expected"])
        before_code = normalize(sample["actual"])
        output = list(before_code)
        selected = sorted(
            [
                (scores.get((key, row["position"]), 0), row)
                for row in by_key.get(key, [])
                if scores.get((key, row["position"]), 0) >= threshold
            ],
            key=lambda item: item[0],
            reverse=True,
        )[:max_changes]
        for score, row in selected:
            output[row["position"]] = row["predicted"]
        after_code = "".join(output)
        before = before_code == expected
        after = after_code == expected
        baseline += int(before)
        correct += int(after)
        fixes += int(not before and after)
        breaks += int(before and not after)
        round_gain[sample["round"]] += int(after) - int(before)
        if selected:
            changes.append(f"{key}:{before_code}->{after_code}({int(after) - int(before)})")
    return {
        "correct": correct,
        "baseline": baseline,
        "gain": correct - baseline,
        "fixes": fixes,
        "breaks": breaks,
        "worstRound": min(round_gain.values()),
        "changes": changes,
    }


def main():
    regression_path = Path(sys.argv[1])
    predictions_path = Path(sys.argv[2])
    regression = map_regression(json.loads(regression_path.read_text(encoding="utf-8")))
    prediction_data = json.loads(predictions_path.read_text(encoding="utf-8"))
    dev_rows = build_rows(regression, group_predictions(prediction_data["devPredictions"]))
    test_rows = build_rows(regression, group_predictions(prediction_data["predictions"]))
    dev_rounds = sorted({row["round"] for row in dev_rows})
    test_rounds = sorted({row["round"] for row in test_rows})

    configurations = []
    for positive_weight in (1.0, 1.5, 2.0, 3.0, 4.0):
        oof_scores = {}
        for held_out in dev_rounds:
            train_rows = [row for row in dev_rows if row["round"] != held_out]
            held_out_rows = [row for row in dev_rows if row["round"] == held_out]
            model = train_logistic(train_rows, positive_weight)
            oof_scores.update(probabilities(model, held_out_rows))
        for threshold in np.arange(0.25, 0.91, 0.05):
            for max_changes in (1, 2):
                result = evaluate(regression, dev_rows, oof_scores, float(threshold), max_changes, dev_rounds)
                configurations.append({
                    "positiveWeight": positive_weight,
                    "threshold": float(threshold),
                    "maxChanges": max_changes,
                    **result,
                })

    configurations.sort(
        key=lambda item: (
            item["worstRound"],
            item["gain"],
            -item["breaks"],
            item["threshold"],
            -item["maxChanges"],
        ),
        reverse=True,
    )
    for index, item in enumerate(configurations[:15], 1):
        print(
            f'#{index} dev={item["correct"]}/{item["baseline"]} gain={item["gain"]} '
            f'fixes={item["fixes"]} breaks={item["breaks"]} worstRound={item["worstRound"]} '
            f'weight={item["positiveWeight"]} threshold={item["threshold"]:.2f} maxChanges={item["maxChanges"]}'
        )

    selected = configurations[0]
    final_model = train_logistic(dev_rows, selected["positiveWeight"])
    test_scores = probabilities(final_model, test_rows)
    result = evaluate(
        regression,
        test_rows,
        test_scores,
        selected["threshold"],
        selected["maxChanges"],
        test_rounds,
    )
    print("")
    print(
        f'Frozen holdout={result["correct"]}/{result["baseline"]} gain={result["gain"]} '
        f'fixes={result["fixes"]} breaks={result["breaks"]}'
    )
    print(", ".join(result["changes"]))


if __name__ == "__main__":
    main()
