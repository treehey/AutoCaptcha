"""Replay the browser target-count detector against the frozen sample set."""

from __future__ import annotations

import math
from collections import Counter
from pathlib import Path

import numpy as np

from click_captcha_dataset import load_corrections, load_round


REFERENCE_WIDTH = 250
REFERENCE_HEIGHT = 120
FOUR_TARGET_RIGHT_BRACKET = (211, 222)
TARGET_TEXT_BOUNDS = (101, 119)
BRIGHT_PIXEL_THRESHOLD = 32


def infer_target_count(image: np.ndarray) -> tuple[int, int]:
    height, width = image.shape[:2]
    left = math.floor(FOUR_TARGET_RIGHT_BRACKET[0] * width / REFERENCE_WIDTH)
    right = math.ceil(FOUR_TARGET_RIGHT_BRACKET[1] * width / REFERENCE_WIDTH)
    top = math.floor(TARGET_TEXT_BOUNDS[0] * height / REFERENCE_HEIGHT)
    bottom = math.ceil(TARGET_TEXT_BOUNDS[1] * height / REFERENCE_HEIGHT)
    pixels = image[top:bottom, left:right].astype(np.uint16)
    bright_pixels = int(np.count_nonzero(pixels.sum(axis=2) >= 480))
    return (4 if bright_pixels >= BRIGHT_PIXEL_THRESHOLD else 3), bright_pixels


def main() -> None:
    data_dir = Path(__file__).resolve().parents[1] / "data" / "click-captcha-samples"
    corrections = load_corrections(data_dir / "corrections.json")
    rows = []

    for round_dir in sorted(data_dir.glob("round-*")):
        for sample in load_round(round_dir, corrections):
            predicted, bright_pixels = infer_target_count(sample["image"])
            rows.append({
                "key": f"{sample['round']}/{sample['id']}",
                "actual": sample["targetCount"],
                "predicted": predicted,
                "brightPixels": bright_pixels,
            })

    errors = [row for row in rows if row["actual"] != row["predicted"]]
    distribution = Counter(row["actual"] for row in rows)
    print(
        f"Click-captcha target count: {len(rows) - len(errors)}/{len(rows)} correct; "
        f"three-target={distribution[3]}, four-target={distribution[4]}"
    )
    if errors:
        for row in errors:
            print(
                f"  {row['key']}: expected {row['actual']}, predicted {row['predicted']}, "
                f"brightPixels={row['brightPixels']}"
            )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
