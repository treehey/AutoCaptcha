import argparse
import itertools
import json
import random
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as functional
from PIL import Image
from torch import nn
from torch.utils.data import DataLoader, Dataset


SEED = 20260719
TARGET_SLOTS = ((120, 134), (143, 157), (166, 180), (189, 203))
CANDIDATE_SLOTS = ((0, 58), (58, 128), (128, 190), (190, 250))
SCENE_HEIGHT = 100
TARGET_TOP = 101
TARGET_BOTTOM = 119
IMAGE_SIZE = 48


def seed_everything():
    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)


def candidate_zone(x):
    if x < 58:
        return 0
    if x < 128:
        return 1
    if x < 190:
        return 2
    return 3


def target_tensor(image, position):
    left, right = TARGET_SLOTS[position]
    crop = image[TARGET_TOP:TARGET_BOTTOM, left:right]
    mask = (crop.min(axis=2) > 150).astype(np.float32)
    tensor = torch.from_numpy(mask).unsqueeze(0).unsqueeze(0)
    return functional.interpolate(tensor, size=(IMAGE_SIZE, IMAGE_SIZE), mode="bilinear", align_corners=False)[0]


def tensor_from_candidate_crop(crop):
    crop = crop.astype(np.float32) / 255.0
    hsv = np.asarray(Image.fromarray((crop * 255).astype(np.uint8)).convert("HSV"), dtype=np.float32)
    saturation = (hsv[:, :, 1:2] / 255.0)
    features = np.concatenate((crop, saturation), axis=2)
    tensor = torch.from_numpy(features).permute(2, 0, 1).unsqueeze(0)
    return functional.interpolate(tensor, size=(IMAGE_SIZE, IMAGE_SIZE), mode="bilinear", align_corners=False)[0]


def candidate_tensor_from_zone(image, position):
    left, right = CANDIDATE_SLOTS[position]
    return tensor_from_candidate_crop(image[:SCENE_HEIGHT, left:right])


def candidate_tensor_from_click(image, click):
    half_width = 32
    half_height = 42
    padded = np.pad(image[:SCENE_HEIGHT], ((half_height, half_height), (half_width, half_width), (0, 0)), mode="edge")
    x = int(click["x"]) + half_width
    y = int(click["y"]) + half_height
    crop = padded[y - half_height:y + half_height, x - half_width:x + half_width]
    return tensor_from_candidate_crop(crop)


def load_samples(round_dir, candidate_input):
    metadata = json.loads((round_dir / "metadata.json").read_text(encoding="utf-8"))
    samples = []
    for row in metadata["samples"]:
        image = np.asarray(Image.open(round_dir / row["image"]).convert("RGB"))
        clicks_by_zone = {candidate_zone(click["x"]): click for click in row["clicks"]}
        order = tuple(candidate_zone(click["x"]) for click in row["clicks"])
        if sorted(order) != [0, 1, 2, 3]:
            raise ValueError(f"{row['id']} does not map to a one-to-one candidate order: {order}")
        samples.append({
            "id": row["id"],
            "image": image,
            "order": order,
            "targets": [target_tensor(image, index) for index in range(4)],
            "candidates": [
                candidate_tensor_from_click(image, clicks_by_zone[index])
                if candidate_input == "clicks"
                else candidate_tensor_from_zone(image, index)
                for index in range(4)
            ],
        })
    return samples


class PairDataset(Dataset):
    def __init__(self, samples, augment=False):
        self.augment = augment
        self.rows = []
        for sample in samples:
            for target_index, expected_candidate in enumerate(sample["order"]):
                for candidate_index in range(4):
                    self.rows.append((
                        sample["targets"][target_index],
                        sample["candidates"][candidate_index],
                        1.0 if candidate_index == expected_candidate else 0.0,
                    ))

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        target, candidate, label = self.rows[index]
        target = target.clone()
        candidate = candidate.clone()
        if self.augment:
            target = target + torch.randn_like(target) * 0.015
            candidate = candidate + torch.randn_like(candidate) * 0.012
            candidate[:3] = candidate[:3] * random.uniform(0.88, 1.10)
            candidate[3:] = candidate[3:] * random.uniform(0.90, 1.08)
        return target.clamp(0, 1), candidate.clamp(0, 1), torch.tensor(label, dtype=torch.float32)


class Encoder(nn.Module):
    def __init__(self, channels):
        super().__init__()
        self.layers = nn.Sequential(
            nn.Conv2d(channels, 20, 3, padding=1),
            nn.BatchNorm2d(20),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(20, 40, 3, padding=1),
            nn.BatchNorm2d(40),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(40, 48, 3, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d((4, 4)),
            nn.Flatten(),
            nn.Linear(48 * 4 * 4, 64),
            nn.ReLU(),
        )

    def forward(self, values):
        return self.layers(values)


class ClickCaptchaMatcher(nn.Module):
    def __init__(self):
        super().__init__()
        self.target_encoder = Encoder(1)
        self.candidate_encoder = Encoder(4)
        self.head = nn.Sequential(
            nn.Linear(64 * 4, 96),
            nn.ReLU(),
            nn.Dropout(0.15),
            nn.Linear(96, 1),
        )

    def forward(self, target, candidate):
        target_features = self.target_encoder(target)
        candidate_features = self.candidate_encoder(candidate)
        features = torch.cat((
            target_features,
            candidate_features,
            torch.abs(target_features - candidate_features),
            target_features * candidate_features,
        ), dim=1)
        return self.head(features).squeeze(1)


def train(model, samples, epochs):
    dataset = PairDataset(samples, augment=True)
    loader = DataLoader(
        dataset,
        batch_size=min(512, len(dataset)),
        shuffle=True,
        generator=torch.Generator().manual_seed(SEED),
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.0012, weight_decay=0.001)
    criterion = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(3.0))
    model.train()
    for _ in range(epochs):
        for target, candidate, label in loader:
            optimizer.zero_grad()
            loss = criterion(model(target, candidate), label)
            loss.backward()
            optimizer.step()


def score_sample(model, sample):
    model.eval()
    with torch.no_grad():
        matrix = np.zeros((4, 4), dtype=np.float32)
        for target_index in range(4):
            targets = sample["targets"][target_index].unsqueeze(0).repeat(4, 1, 1, 1)
            candidates = torch.stack(sample["candidates"])
            matrix[target_index] = torch.sigmoid(model(targets, candidates)).numpy()

    assignment = max(
        itertools.permutations(range(4)),
        key=lambda permutation: sum(matrix[index, permutation[index]] for index in range(4)),
    )
    sorted_rows = np.sort(matrix, axis=1)
    confidence = float(np.mean(sorted_rows[:, -1]))
    margin = float(np.mean(sorted_rows[:, -1] - sorted_rows[:, -2]))
    return assignment, matrix, confidence, margin


def evaluate(model, samples):
    rows = []
    exact = 0
    chars = 0
    for sample in samples:
        predicted, matrix, confidence, margin = score_sample(model, sample)
        correct = tuple(predicted) == tuple(sample["order"])
        exact += correct
        chars += sum(left == right for left, right in zip(predicted, sample["order"]))
        rows.append({
            "id": sample["id"],
            "expected": list(sample["order"]),
            "predicted": list(predicted),
            "correct": correct,
            "confidence": confidence,
            "margin": margin,
            "scores": matrix.round(6).tolist(),
        })
    return {
        "exact": exact,
        "total": len(samples),
        "charCorrect": chars,
        "charTotal": len(samples) * 4,
        "rows": rows,
    }


def main():
    parser = argparse.ArgumentParser(description="Train a development-only Chinese click-captcha pair matcher.")
    parser.add_argument("round", nargs="?", default="data/click-captcha-samples/round-001")
    parser.add_argument("--epochs", type=int, default=90)
    parser.add_argument("--candidate-input", choices=("zones", "clicks"), default="zones")
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--output", default="data/click-captcha-experiments/round-001-matcher.json")
    args = parser.parse_args()

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(args.threads)
    seed_everything()
    samples = load_samples(Path(args.round), args.candidate_input)
    if len(samples) < 10:
        raise ValueError("At least 10 samples are required for a development split.")

    shuffled = samples[:]
    random.Random(SEED).shuffle(shuffled)
    split = max(1, round(len(shuffled) * 0.2))
    validation = shuffled[:split]
    training = shuffled[split:]

    model = ClickCaptchaMatcher()
    train(model, training, args.epochs)
    train_metrics = evaluate(model, training)
    validation_metrics = evaluate(model, validation)

    output = {
        "format": "nju-click-captcha-matcher-report/v1",
        "round": Path(args.round).name,
        "seed": SEED,
        "epochs": args.epochs,
        "candidateInput": args.candidate_input,
        "layout": {
            "targetSlots": TARGET_SLOTS,
            "candidateSlots": CANDIDATE_SLOTS,
            "sceneHeight": SCENE_HEIGHT,
            "targetTop": TARGET_TOP,
            "targetBottom": TARGET_BOTTOM,
        },
        "warning": "Single-round development split only. This result is not a generalization metric.",
        "training": train_metrics,
        "validation": validation_metrics,
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"training: {train_metrics['exact']}/{train_metrics['total']} exact; {train_metrics['charCorrect']}/{train_metrics['charTotal']} chars")
    print(f"validation: {validation_metrics['exact']}/{validation_metrics['total']} exact; {validation_metrics['charCorrect']}/{validation_metrics['charTotal']} chars")
    print(f"report: {output_path}")


if __name__ == "__main__":
    main()
