"""Shared, read-only data contract for click-captcha offline experiments.

The sampler records the user interaction exactly as it occurred.  A small
correction manifest selects the intended clicks for legacy three-target
captures that were made before the sampler supported variable target counts.
This module applies those corrections in memory and never changes source data.
"""

from __future__ import annotations

import itertools
import json
from pathlib import Path

import numpy as np
from PIL import Image


TARGET_COUNTS = (3, 4)
CANDIDATE_SLOTS = ((0, 58), (58, 128), (128, 190), (190, 250))
ASSIGNMENTS_BY_TARGET_COUNT = {
    count: tuple(itertools.permutations(range(4), count))
    for count in TARGET_COUNTS
}
ASSIGNMENT_INDEX_BY_TARGET_COUNT = {
    count: {assignment: index for index, assignment in enumerate(assignments)}
    for count, assignments in ASSIGNMENTS_BY_TARGET_COUNT.items()
}


def parse_rounds(value: str) -> list[str]:
    """Expand a compact CLI round expression such as ``001-006,010``."""
    rounds = []
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start, end = (int(item) for item in part.split("-", 1))
            rounds.extend(f"round-{index:03d}" for index in range(start, end + 1))
        else:
            rounds.append(f"round-{int(part):03d}")
    if not rounds:
        raise ValueError("At least one round is required.")
    return rounds


def candidate_zone(x: float) -> int:
    """Map a recorded x-coordinate to the corresponding candidate slot."""
    if x < CANDIDATE_SLOTS[1][0]:
        return 0
    if x < CANDIDATE_SLOTS[2][0]:
        return 1
    if x < CANDIDATE_SLOTS[3][0]:
        return 2
    return 3


def load_corrections(path: Path) -> dict:
    if not path.exists():
        return {}
    corrections = json.loads(path.read_text(encoding="utf-8"))
    if corrections.get("format") != "nju-click-captcha-corrections/v1":
        raise ValueError(f"Unsupported corrections format: {path}")
    return corrections.get("samples", {})


def corrected_clicks(row: dict, correction: dict | None, sample_key: str) -> tuple[list[dict], int]:
    """Return the training clicks and target count, validating every correction."""
    recorded_clicks = row["clicks"]
    if not correction:
        target_count = int(row.get("targetCount", len(recorded_clicks)))
        if target_count != len(recorded_clicks):
            raise ValueError(f"{sample_key}: targetCount does not match recorded clicks")
        return recorded_clicks, target_count

    selected_indexes = correction.get("selectedClickIndexes")
    target_count = int(correction["targetCount"])
    recorded_click_count = correction.get("recordedClickCount")
    if recorded_click_count is not None and int(recorded_click_count) != len(recorded_clicks):
        raise ValueError(f"{sample_key}: correction does not match the original recorded click count")
    if not isinstance(selected_indexes, list) or len(selected_indexes) != target_count:
        raise ValueError(f"{sample_key}: correction must select one click for each target")
    if len(set(selected_indexes)) != len(selected_indexes):
        raise ValueError(f"{sample_key}: correction selects a click more than once")
    if any(not isinstance(index, int) or index < 0 or index >= len(recorded_clicks) for index in selected_indexes):
        raise ValueError(f"{sample_key}: correction refers to an invalid recorded click")
    return [recorded_clicks[index] for index in selected_indexes], target_count


def load_round(round_dir: Path, corrections: dict | None = None, load_images: bool = True) -> list[dict]:
    """Load one round into the common immutable-in-practice experiment shape."""
    metadata = json.loads((round_dir / "metadata.json").read_text(encoding="utf-8"))
    corrections = corrections or {}
    samples = []
    for row in metadata["samples"]:
        sample_key = f"{round_dir.name}/{row['id']}"
        clicks, target_count = corrected_clicks(row, corrections.get(sample_key), sample_key)
        order = tuple(candidate_zone(click["x"]) for click in clicks)
        if target_count not in TARGET_COUNTS or len(order) != target_count or len(set(order)) != target_count:
            raise ValueError(
                f"{sample_key}: expected {target_count} non-repeating candidate clicks, got {order}"
            )
        samples.append({
            "round": round_dir.name,
            "id": row["id"],
            "image": np.asarray(Image.open(round_dir / row["image"]).convert("RGB")) if load_images else None,
            "order": order,
            "targetCount": target_count,
            "recordedClickCount": len(row["clicks"]),
            "wasCorrected": sample_key in corrections,
        })
    return samples


def load_rounds(data_dir: Path, round_names: list[str], corrections: dict | None = None) -> dict[str, list[dict]]:
    return {round_name: load_round(data_dir / round_name, corrections) for round_name in round_names}


def assignments_for(target_count: int) -> tuple[tuple[int, ...], ...]:
    try:
        return ASSIGNMENTS_BY_TARGET_COUNT[target_count]
    except KeyError as error:
        raise ValueError(f"Unsupported target count: {target_count}") from error


def assignment_index(order: tuple[int, ...]) -> int:
    return ASSIGNMENT_INDEX_BY_TARGET_COUNT[len(order)][order]
