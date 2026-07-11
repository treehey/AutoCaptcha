import csv
import json
import os
import random
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as functional
from PIL import Image
from torch import nn
from torch.utils.data import DataLoader, Dataset


SEED = int(os.environ.get("OCR_CNN_SEED", "20260711"))
CHARSET = "23456789abcdefghijklmnpqrstuvwxy"
CHAR_TO_INDEX = {char: index for index, char in enumerate(CHARSET)}


def seed_everything():
    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)


def load_samples(root):
    samples = []
    for number in range(24, 34):
        round_name = f"round-{number:03d}"
        round_dir = root / round_name
        with (round_dir / "answers.csv").open(encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                image = np.asarray(Image.open(round_dir / row["file"]).convert("RGB"), dtype=np.float32) / 255
                for position, label in enumerate(row["answer"].lower()):
                    samples.append({
                        "round": round_name,
                        "id": row["id"],
                        "pos": position,
                        "label": label,
                        "image": image,
                    })
    return samples


class RawCaptchaChars(Dataset):
    def __init__(self, samples, augment=False):
        self.samples = samples
        self.augment = augment

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, index):
        sample = self.samples[index]
        position = sample["pos"]
        jitter_x = random.randint(-2, 2) if self.augment else 0
        jitter_y = random.randint(-1, 1) if self.augment else 0
        x0 = max(0, position * 20 - 3 + jitter_x)
        x1 = min(80, (position + 1) * 20 + 3 + jitter_x)
        y0 = max(0, jitter_y)
        y1 = min(30, 30 + jitter_y)
        crop = torch.tensor(sample["image"][y0:y1, x0:x1], dtype=torch.float32).permute(2, 0, 1)
        crop = functional.interpolate(
            crop.unsqueeze(0), size=(32, 24), mode="bilinear", align_corners=False
        )[0]
        if self.augment:
            brightness = random.uniform(0.88, 1.12)
            contrast = random.uniform(0.85, 1.15)
            channel_scale = torch.tensor(
                [random.uniform(0.9, 1.1) for _ in range(3)], dtype=torch.float32
            ).reshape(3, 1, 1)
            mean = crop.mean(dim=(1, 2), keepdim=True)
            crop = ((crop - mean) * contrast + mean) * brightness * channel_scale
            if random.random() < 0.25:
                gray = crop.mean(dim=0, keepdim=True)
                crop = gray.repeat(3, 1, 1)
            crop = (crop + torch.randn_like(crop) * 0.012).clamp(0, 1)
        label = CHAR_TO_INDEX[sample["label"]]
        return crop, label


class RawCharCnn(nn.Module):
    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(3, 24, 3, padding=1),
            nn.BatchNorm2d(24),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(24, 48, 3, padding=1),
            nn.BatchNorm2d(48),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(48, 64, 3, padding=1),
            nn.ReLU(),
        )
        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(64 * 8 * 6, 128),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(128, len(CHARSET)),
        )

    def forward(self, images):
        return self.classifier(self.features(images))


def class_weights(samples):
    counts = torch.ones(len(CHARSET))
    for sample in samples:
        counts[CHAR_TO_INDEX[sample["label"]]] += 1
    return (counts.sum() / (counts * len(CHARSET))).clamp(max=4)


def train_model(samples, epochs):
    seed_everything()
    model = RawCharCnn()
    loader = DataLoader(
        RawCaptchaChars(samples, augment=True),
        batch_size=64,
        shuffle=True,
        generator=torch.Generator().manual_seed(SEED),
        num_workers=0,
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.0015, weight_decay=0.0008)
    criterion = nn.CrossEntropyLoss(weight=class_weights(samples))
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
    loader = DataLoader(RawCaptchaChars(samples), batch_size=64, shuffle=False)
    offset = 0
    with torch.no_grad():
        for images, _ in loader:
            probabilities = torch.softmax(model(images), dim=1)
            values, indices = torch.topk(probabilities, 3, dim=1)
            for batch_index in range(images.shape[0]):
                sample = samples[offset + batch_index]
                rows.append({
                    "round": sample["round"],
                    "id": sample["id"],
                    "pos": sample["pos"],
                    "expected": sample["label"],
                    "predicted": CHARSET[indices[batch_index, 0].item()],
                    "confidence": values[batch_index, 0].item(),
                    "top3": [
                        {
                            "label": CHARSET[indices[batch_index, rank].item()],
                            "probability": values[batch_index, rank].item(),
                        }
                        for rank in range(3)
                    ],
                })
            offset += images.shape[0]
    return rows


def summarize(rows):
    char_correct = sum(row["predicted"] == row["expected"] for row in rows)
    grouped = {}
    for row in rows:
        item = grouped.setdefault(
            f'{row["round"]}#{row["id"]}', {"expected": [""] * 4, "predicted": [""] * 4}
        )
        item["expected"][row["pos"]] = row["expected"]
        item["predicted"][row["pos"]] = row["predicted"]
    code_correct = sum(item["expected"] == item["predicted"] for item in grouped.values())
    return char_correct, len(rows), code_correct, len(grouped)


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "data/captcha-samples")
    output = Path(
        sys.argv[2] if len(sys.argv) > 2
        else "data/segmentation-experiments/raw-cnn-predictions.json"
    )
    model_output = Path(
        sys.argv[3] if len(sys.argv) > 3
        else "data/segmentation-experiments/raw-char-cnn.pt"
    )
    samples = load_samples(root)
    tune_train = [item for item in samples if item["round"] in {f"round-{n:03d}" for n in range(24, 29)}]
    tune_test = [item for item in samples if item["round"] == "round-029"]
    best = None
    for epochs in (15, 25, 35, 45):
        model = train_model(tune_train, epochs)
        summary = summarize(predict(model, tune_test))
        print(f"tune epochs={epochs}: chars={summary[0]}/{summary[1]}, codes={summary[2]}/{summary[3]}")
        score = (summary[2], summary[0], -epochs)
        if best is None or score > best[0]:
            best = (score, epochs)

    selected_epochs = best[1]
    dev_rounds = {f"round-{n:03d}" for n in range(24, 30)}
    test_rounds = {f"round-{n:03d}" for n in range(30, 34)}
    dev_samples = [item for item in samples if item["round"] in dev_rounds]
    test_samples = [item for item in samples if item["round"] in test_rounds]
    dev_predictions = []
    for held_out in sorted(dev_rounds):
        model = train_model([item for item in dev_samples if item["round"] != held_out], selected_epochs)
        rows = predict(model, [item for item in dev_samples if item["round"] == held_out])
        dev_predictions.extend(rows)
        summary = summarize(rows)
        print(f"oof {held_out}: chars={summary[0]}/{summary[1]}, codes={summary[2]}/{summary[3]}")

    model = train_model(dev_samples, selected_epochs)
    predictions = predict(model, test_samples)
    summary = summarize(predictions)
    print(f"selected epochs={selected_epochs}")
    print(f"holdout chars={summary[0]}/{summary[1]}, codes={summary[2]}/{summary[3]}")
    output.write_text(json.dumps({
        "seed": SEED,
        "epochs": selected_epochs,
        "devPredictions": dev_predictions,
        "predictions": predictions,
    }), encoding="utf-8")
    torch.save({
        "seed": SEED,
        "epochs": selected_epochs,
        "charset": CHARSET,
        "state_dict": model.state_dict(),
    }, model_output)
    print(f"predictions={output}")
    print(f"model={model_output}")


if __name__ == "__main__":
    main()
