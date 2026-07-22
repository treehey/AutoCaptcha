"""Deterministic, category-agnostic shape matching for click captchas."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np


LOCAL_DEPS = Path(__file__).resolve().parents[1] / "data" / "click-captcha-experiments" / "python-deps"
if LOCAL_DEPS.exists():
    sys.path.insert(0, str(LOCAL_DEPS))

import cv2
from skimage.morphology import skeletonize


TARGET_SLOTS = ((120, 134), (143, 157), (166, 180), (189, 203))
CANDIDATE_SLOTS = ((0, 58), (58, 128), (128, 190), (190, 250))
TARGET_TOP = 101
TARGET_BOTTOM = 119
SCENE_HEIGHT = 100


@dataclass(frozen=True)
class ShapeConfig:
    size: int = 64
    margin: int = 6
    foreground_threshold: int = 160
    residual_gain: float = 2.0
    rotations: tuple[float, ...] = tuple(range(-60, 61, 5))
    foreground_weight: float = 0.20
    contour_weight: float = 0.30
    skeleton_weight: float = 0.50
    topology_weight: float = 0.30


@dataclass(frozen=True)
class GlyphShape:
    foreground: np.ndarray
    contour: np.ndarray
    skeleton: np.ndarray
    components: int
    holes: int


def make_candidate_background(samples: list[dict]) -> np.ndarray:
    scenes = np.stack([sample["image"][:SCENE_HEIGHT] for sample in samples], axis=0)
    return np.median(scenes, axis=0).astype(np.float32)


def _remove_specks(mask: np.ndarray, minimum_area: int = 2) -> np.ndarray:
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    cleaned = np.zeros_like(mask, dtype=bool)
    for label in range(1, count):
        if stats[label, cv2.CC_STAT_AREA] >= minimum_area:
            cleaned |= labels == label
    return cleaned


def normalize_mask(mask: np.ndarray, config: ShapeConfig) -> np.ndarray:
    mask = _remove_specks(mask)
    ys, xs = np.where(mask)
    if len(xs) < 3:
        return np.zeros((config.size, config.size), dtype=bool)

    crop = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.uint8) * 255
    available = config.size - 2 * config.margin
    scale = min(available / crop.shape[0], available / crop.shape[1])
    height = max(1, round(crop.shape[0] * scale))
    width = max(1, round(crop.shape[1] * scale))
    resized = cv2.resize(crop, (width, height), interpolation=cv2.INTER_AREA) >= 96
    canvas = np.zeros((config.size, config.size), dtype=bool)
    top = (config.size - height) // 2
    left = (config.size - width) // 2
    canvas[top:top + height, left:left + width] = resized
    return canvas


def target_masks(image: np.ndarray, target_count: int, config: ShapeConfig) -> list[np.ndarray]:
    masks = []
    for left, right in TARGET_SLOTS[:target_count]:
        region = image[TARGET_TOP:TARGET_BOTTOM, left:right]
        inverted = 255.0 - region.mean(axis=2)
        masks.append(normalize_mask(inverted < config.foreground_threshold, config))
    return masks


def candidate_masks(image: np.ndarray, background: np.ndarray, config: ShapeConfig) -> list[np.ndarray]:
    masks = []
    for left, right in CANDIDATE_SLOTS:
        region = image[:SCENE_HEIGHT, left:right].astype(np.float32)
        residual = np.abs(region - background[:, left:right]).max(axis=2)
        masks.append(normalize_mask(residual * config.residual_gain > 255 - config.foreground_threshold, config))
    return masks


def rotate_mask(mask: np.ndarray, angle: float, config: ShapeConfig) -> np.ndarray:
    if angle == 0:
        return mask
    center = ((config.size - 1) / 2, (config.size - 1) / 2)
    transform = cv2.getRotationMatrix2D(center, angle, 1.0)
    rotated = cv2.warpAffine(
        mask.astype(np.uint8) * 255,
        transform,
        (config.size, config.size),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    return normalize_mask(rotated > 0, config)


def _contour(mask: np.ndarray) -> np.ndarray:
    eroded = cv2.erode(mask.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=1).astype(bool)
    return mask & ~eroded


def _topology(mask: np.ndarray) -> tuple[int, int]:
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    components = sum(stats[label, cv2.CC_STAT_AREA] >= 3 for label in range(1, count))
    contours, hierarchy = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    holes = 0
    if hierarchy is not None:
        holes = sum(1 for item in hierarchy[0] if item[3] >= 0)
    return components, holes


def describe(mask: np.ndarray) -> GlyphShape:
    components, holes = _topology(mask)
    return GlyphShape(
        foreground=mask,
        contour=_contour(mask),
        skeleton=skeletonize(mask),
        components=components,
        holes=holes,
    )


def _symmetric_chamfer(left: np.ndarray, right: np.ndarray) -> float:
    if left.sum() == 0 or right.sum() == 0:
        return 2.0
    left_distance = cv2.distanceTransform((~left).astype(np.uint8), cv2.DIST_L2, 5)
    right_distance = cv2.distanceTransform((~right).astype(np.uint8), cv2.DIST_L2, 5)
    distance = right_distance[left].mean() + left_distance[right].mean()
    return float(distance / (2 * max(left.shape)))


def shape_distance(left: GlyphShape, right: GlyphShape, config: ShapeConfig) -> float:
    distance = (
        config.foreground_weight * _symmetric_chamfer(left.foreground, right.foreground)
        + config.contour_weight * _symmetric_chamfer(left.contour, right.contour)
        + config.skeleton_weight * _symmetric_chamfer(left.skeleton, right.skeleton)
    )
    topology = abs(left.components - right.components) + abs(left.holes - right.holes)
    return distance + config.topology_weight * topology


def score_matrix(
    image: np.ndarray,
    target_count: int,
    background: np.ndarray,
    config: ShapeConfig,
) -> tuple[np.ndarray, dict]:
    target_values = target_masks(image, target_count, config)
    candidate_values = candidate_masks(image, background, config)
    target_shapes = [describe(mask) for mask in target_values]
    rotated_candidates = [
        [describe(rotate_mask(mask, angle, config)) for angle in config.rotations]
        for mask in candidate_values
    ]
    matrix = np.zeros((target_count, 4), dtype=np.float64)
    best_rotations = np.zeros((target_count, 4), dtype=np.float64)
    for target_index, target in enumerate(target_shapes):
        for candidate_index, variants in enumerate(rotated_candidates):
            distances = [shape_distance(target, variant, config) for variant in variants]
            best_index = int(np.argmin(distances))
            matrix[target_index, candidate_index] = -distances[best_index]
            best_rotations[target_index, candidate_index] = config.rotations[best_index]
    debug = {
        "targetForegroundPixels": [int(mask.sum()) for mask in target_values],
        "candidateForegroundPixels": [int(mask.sum()) for mask in candidate_values],
        "bestRotations": best_rotations.tolist(),
    }
    return matrix, debug
