import json
import random
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset


SEED = 20260711
CHARSET = "23456789abcdefghijklmnpqrstuvwxy"
CHAR_TO_INDEX = {char: index for index, char in enumerate(CHARSET)}


def seed_everything():
    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)


def normalize_label(label):
    return label.lower() if label.isalpha() else label


class CaptchaChars(Dataset):
    def __init__(self, samples, augment=False):
        self.samples = samples
        self.augment = augment

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, index):
        sample = self.samples[index]
        image = torch.tensor(sample["channels"], dtype=torch.float32).reshape(len(sample["channels"]), 32, 24)
        if self.augment:
            dx = random.randint(-2, 2)
            dy = random.randint(-1, 1)
            shifted = torch.zeros_like(image)
            src_x0, src_x1 = max(0, -dx), min(24, 24 - dx)
            src_y0, src_y1 = max(0, -dy), min(32, 32 - dy)
            dst_x0, dst_x1 = max(0, dx), min(24, 24 + dx)
            dst_y0, dst_y1 = max(0, dy), min(32, 32 + dy)
            shifted[:, dst_y0:dst_y1, dst_x0:dst_x1] = image[:, src_y0:src_y1, src_x0:src_x1]
            image = shifted
            if random.random() < 0.35:
                noise = torch.rand_like(image)
                image = image * (noise > 0.015)
        label = CHAR_TO_INDEX[normalize_label(sample["label"])]
        return image, label


class CharCnn(nn.Module):
    def __init__(self, input_channels):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(input_channels, 16, 3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(16, 32, 3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
        )
        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(32 * 8 * 6, 96),
            nn.ReLU(),
            nn.Dropout(0.15),
            nn.Linear(96, len(CHARSET)),
        )

    def forward(self, images):
        return self.classifier(self.features(images))


def class_weights(samples):
    counts = torch.ones(len(CHARSET), dtype=torch.float32)
    for sample in samples:
        counts[CHAR_TO_INDEX[normalize_label(sample["label"])]] += 1
    weights = counts.sum() / (counts * len(CHARSET))
    return weights.clamp(max=4.0)


def train_model(train_samples, epochs):
    seed_everything()
    model = CharCnn(len(train_samples[0]["channels"]))
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.0015, weight_decay=0.0005)
    criterion = nn.CrossEntropyLoss(weight=class_weights(train_samples))
    loader = DataLoader(
        CaptchaChars(train_samples, augment=True),
        batch_size=64,
        shuffle=True,
        num_workers=0,
        generator=torch.Generator().manual_seed(SEED),
    )
    for _ in range(epochs):
        model.train()
        for images, labels in loader:
            optimizer.zero_grad()
            loss = criterion(model(images), labels)
            loss.backward()
            optimizer.step()
    return model


def predict(model, samples):
    model.eval()
    rows = []
    with torch.no_grad():
        for sample in samples:
            image = torch.tensor(sample["channels"], dtype=torch.float32).reshape(
                1, len(sample["channels"]), 32, 24
            )
            probabilities = torch.softmax(model(image), dim=1)[0]
            values, indices = torch.topk(probabilities, 3)
            rows.append({
                "round": sample["round"],
                "id": sample["id"],
                "pos": sample["pos"],
                "expected": normalize_label(sample["label"]),
                "predicted": CHARSET[indices[0].item()],
                "confidence": values[0].item(),
                "top3": [
                    {"label": CHARSET[item.item()], "probability": value.item()}
                    for item, value in zip(indices, values)
                ],
            })
    return rows


def summarize(rows):
    char_correct = sum(row["predicted"] == row["expected"] for row in rows)
    images = {}
    for row in rows:
        key = f'{row["round"]}#{row["id"]}'
        item = images.setdefault(key, {"expected": [""] * 4, "predicted": [""] * 4})
        item["expected"][row["pos"]] = row["expected"]
        item["predicted"][row["pos"]] = row["predicted"]
    code_correct = sum(item["expected"] == item["predicted"] for item in images.values())
    return {
        "charCorrect": char_correct,
        "charTotal": len(rows),
        "charAccuracy": char_correct / len(rows) if rows else 0,
        "codeCorrect": code_correct,
        "codeTotal": len(images),
        "codeAccuracy": code_correct / len(images) if images else 0,
    }


def main():
    source = Path(sys.argv[1] if len(sys.argv) > 1 else "data/segmentation-experiments/cnn-features.json")
    output = Path(sys.argv[2] if len(sys.argv) > 2 else "data/segmentation-experiments/cnn-predictions.json")
    model_data = json.loads(source.read_text(encoding="utf-8"))
    modes = [mode for mode in ("thin", "aggressive", "color") if any(
        sample["mode"] == mode for sample in model_data["samples"]
    )]
    grouped = {}
    for sample in model_data["samples"]:
        if sample["mode"] not in modes:
            continue
        key = (sample["round"], sample["id"], sample["pos"])
        item = grouped.setdefault(key, {
            "round": sample["round"],
            "id": sample["id"],
            "pos": sample["pos"],
            "label": sample["label"],
            "vectors": {},
        })
        item["vectors"][sample["mode"]] = sample["vector"]
    samples = [
        {
            **item,
            "channels": [item["vectors"][mode] for mode in modes],
        }
        for item in grouped.values()
        if all(mode in item["vectors"] for mode in modes)
    ]
    print(f'modes={",".join(modes)} samples={len(samples)}')

    tune_train = [sample for sample in samples if sample["round"] in {f"round-{n:03d}" for n in range(24, 29)}]
    tune_test = [sample for sample in samples if sample["round"] == "round-029"]
    best = None
    for epochs in (10, 20, 30, 40, 55):
        model = train_model(tune_train, epochs)
        summary = summarize(predict(model, tune_test))
        print(
            f'tune epochs={epochs}: chars={summary["charCorrect"]}/{summary["charTotal"]} '
            f'({summary["charAccuracy"]:.1%}), codes={summary["codeCorrect"]}/{summary["codeTotal"]} '
            f'({summary["codeAccuracy"]:.1%})'
        )
        score = (summary["codeCorrect"], summary["charCorrect"], -epochs)
        if best is None or score > best[0]:
            best = (score, epochs)

    best_epochs = best[1]
    train_rounds = {f"round-{n:03d}" for n in range(24, 30)}
    test_rounds = {f"round-{n:03d}" for n in range(30, 34)}
    train_samples = [sample for sample in samples if sample["round"] in train_rounds]
    test_samples = [sample for sample in samples if sample["round"] in test_rounds]
    dev_predictions = []
    for held_out_round in sorted(train_rounds):
        fold_train = [sample for sample in train_samples if sample["round"] != held_out_round]
        fold_test = [sample for sample in train_samples if sample["round"] == held_out_round]
        fold_model = train_model(fold_train, best_epochs)
        fold_predictions = predict(fold_model, fold_test)
        dev_predictions.extend(fold_predictions)
        fold_summary = summarize(fold_predictions)
        print(
            f'oof {held_out_round}: chars={fold_summary["charCorrect"]}/{fold_summary["charTotal"]} '
            f'({fold_summary["charAccuracy"]:.1%}), codes={fold_summary["codeCorrect"]}/{fold_summary["codeTotal"]} '
            f'({fold_summary["codeAccuracy"]:.1%})'
        )
    model = train_model(train_samples, best_epochs)
    predictions = predict(model, test_samples)
    summary = summarize(predictions)
    print(f"selected epochs={best_epochs}")
    print(
        f'holdout chars={summary["charCorrect"]}/{summary["charTotal"]} ({summary["charAccuracy"]:.1%}), '
        f'codes={summary["codeCorrect"]}/{summary["codeTotal"]} ({summary["codeAccuracy"]:.1%})'
    )
    output.write_text(json.dumps({
        "seed": SEED,
        "epochs": best_epochs,
        "trainRounds": sorted(train_rounds),
        "testRounds": sorted(test_rounds),
        "summary": summary,
        "devPredictions": dev_predictions,
        "predictions": predictions,
    }), encoding="utf-8")
    print(f"predictions={output}")


if __name__ == "__main__":
    main()
