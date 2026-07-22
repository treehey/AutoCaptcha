"""Evaluate a local PP-OCR Chinese recognizer on click-captcha samples.

This is a development-only spike.  It deliberately lives outside the extension
runtime so a large third-party model cannot accidentally affect the published
package.  The output can be evaluated using the existing click-order labels:
the recognizer reads the four target glyphs and the four candidate glyphs, then
matches equal recognized text with a one-to-one assignment.
"""

import argparse
import itertools
import json
import sys
import time
from pathlib import Path

import numpy as np
import yaml
from PIL import Image

from click_captcha_dataset import assignments_for, load_corrections, load_round


TARGET_SLOTS = ((120, 134), (143, 157), (166, 180), (189, 203))
CANDIDATE_SLOTS = ((0, 58), (58, 128), (128, 190), (190, 250))
TARGET_TOP = 100
TARGET_BOTTOM = 120
SCENE_HEIGHT = 100
MODEL_HEIGHT = 48
MODEL_WIDTH = 320


def read_dictionary(model_dir):
    config = yaml.safe_load((model_dir / "inference.yml").read_text(encoding="utf-8"))
    characters = config["PostProcess"]["character_dict"]
    # Paddle CTC reserves index zero for its blank token.
    return [""] + characters


def foreground_bbox(image, threshold):
    mask = image.min(axis=2) < threshold
    ys, xs = np.where(mask)
    if len(xs) < 3:
        return 0, 0, image.shape[1], image.shape[0]

    padding = 2
    return (
        max(0, int(xs.min()) - padding),
        max(0, int(ys.min()) - padding),
        min(image.shape[1], int(xs.max()) + padding + 1),
        min(image.shape[0], int(ys.max()) + padding + 1),
    )


def target_glyph(image, index):
    left, right = TARGET_SLOTS[index]
    # Bottom glyphs are white on black.  PP-OCR expects dark text on light
    # background, so invert before normalization.
    return 255 - image[TARGET_TOP:TARGET_BOTTOM, left:right]


def candidate_glyph(image, index, threshold, mode, background=None, residual_gain=2.0):
    left, right = CANDIDATE_SLOTS[index]
    region = image[:SCENE_HEIGHT, left:right]
    if mode == "residual":
        if background is None:
            raise ValueError("Candidate residual mode requires a static background image.")
        background_region = background[:SCENE_HEIGHT, left:right]
        residual = np.abs(region.astype(np.float32) - background_region).max(axis=2)
        gray = 255 - np.clip(residual * residual_gain, 0, 255)
        normalized = np.repeat(gray[:, :, None], 3, axis=2).astype(np.uint8)
        x0, y0, x1, y1 = foreground_bbox(normalized, threshold)
        return normalized[y0:y1, x0:x1]

    x0, y0, x1, y1 = foreground_bbox(region, threshold)
    crop = region[y0:y1, x0:x1]

    if mode == "binary":
        mask = crop.min(axis=2) < threshold
        binary = np.where(mask, 0, 255).astype(np.uint8)
        return np.repeat(binary[:, :, None], 3, axis=2)
    if mode == "gray":
        gray = np.mean(crop, axis=2, keepdims=True)
        return np.repeat(gray, 3, axis=2).astype(np.uint8)
    return crop


def rotate_glyph(image, angle):
    if not angle:
        return image
    return np.asarray(
        Image.fromarray(image).rotate(
            angle,
            resample=Image.Resampling.BICUBIC,
            expand=True,
            fillcolor=(255, 255, 255),
        )
    )


def prepare_image(image):
    height, width = image.shape[:2]
    resized_width = min(MODEL_WIDTH, max(1, int(np.ceil(MODEL_HEIGHT * width / height))))
    resized = np.asarray(
        Image.fromarray(image).resize((resized_width, MODEL_HEIGHT), Image.Resampling.BILINEAR),
        dtype=np.float32,
    )
    # The official model configuration uses BGR source input.
    resized = resized[:, :, ::-1].transpose(2, 0, 1) / 255.0
    resized = (resized - 0.5) / 0.5
    output = np.zeros((3, MODEL_HEIGHT, MODEL_WIDTH), dtype=np.float32)
    output[:, :, :resized_width] = resized
    return output


def recognize(session, dictionary, image):
    input_name = session.get_inputs()[0].name
    logits = session.run(None, {input_name: prepare_image(image)[None, :, :, :]})[0][0]
    indices = np.argmax(logits, axis=1)

    characters = []
    confidences = []
    previous = -1
    for timestep, index in enumerate(indices):
        index = int(index)
        if index != 0 and index != previous and index < len(dictionary):
            characters.append(dictionary[index])
            # This ONNX export already emits class probabilities, not logits.
            confidences.append(float(logits[timestep, index]))
        previous = index

    return "".join(characters), (sum(confidences) / len(confidences) if confidences else 0.0)


def text_similarity(target, candidate):
    if not target or not candidate:
        return -1.0
    if target == candidate:
        return 3.0
    if target in candidate or candidate in target:
        return 1.0
    return 0.0


def evaluate(round_dir, session, dictionary, threshold, mode, rotations, residual_gain, corrections):
    samples = load_round(round_dir, corrections)
    images = [sample["image"] for sample in samples]
    background = np.median(np.stack(images, axis=0), axis=0).astype(np.float32)
    rows = []
    exact = 0
    characters = 0
    started = time.perf_counter()

    for sample, image in zip(samples, images):
        target_count = sample["targetCount"]
        targets = [recognize(session, dictionary, target_glyph(image, index)) for index in range(target_count)]
        candidate_variants = []
        for index in range(4):
            glyph = candidate_glyph(image, index, threshold, mode, background, residual_gain)
            candidate_variants.append([
                (angle, *recognize(session, dictionary, rotate_glyph(glyph, angle)))
                for angle in rotations
            ])
        matrix = np.array([
            [
                max(
                    text_similarity(target[0], candidate_text)
                    for _, candidate_text, _ in variants
                )
                for variants in candidate_variants
            ]
            for target in targets
        ])
        predicted = max(
            assignments_for(target_count),
            key=lambda assignment: sum(matrix[index, candidate_index] for index, candidate_index in enumerate(assignment)),
        )
        expected = sample["order"]
        derived_candidate_labels = [None] * 4
        for target_index, candidate_index in enumerate(expected):
            derived_candidate_labels[candidate_index] = targets[target_index][0]
        correct = predicted == expected
        exact += correct
        characters += sum(left == right for left, right in zip(predicted, expected))
        rows.append({
            "id": sample["id"],
            "targetCount": target_count,
            "expected": list(expected),
            "predicted": list(predicted),
            "correct": correct,
            "targets": [{"text": text, "score": score} for text, score in targets],
            "candidates": [
                [
                    {"angle": angle, "text": text, "score": score}
                    for angle, text, score in variants
                ]
                for variants in candidate_variants
            ],
            "derivedCandidateLabels": derived_candidate_labels,
            "matrix": matrix.tolist(),
        })

    elapsed_ms = (time.perf_counter() - started) * 1000
    return {
        "exact": exact,
        "total": len(rows),
        "characterCorrect": characters,
        "characterTotal": sum(row["targetCount"] for row in rows),
        "elapsedMs": round(elapsed_ms, 1),
        "averageMs": round(elapsed_ms / len(rows), 1),
        "rows": rows,
    }


def main():
    parser = argparse.ArgumentParser(description="Evaluate a local PP-OCR model on click-captcha samples.")
    parser.add_argument("round", nargs="?", default="data/click-captcha-samples/round-001")
    parser.add_argument("--model-dir", default="data/click-captcha-experiments/ppocr-v5")
    parser.add_argument("--deps", default="data/click-captcha-experiments/python-deps")
    parser.add_argument(
        "--corrections",
        default="",
        help="Optional correction manifest for legacy samples with extra captured clicks.",
    )
    parser.add_argument("--threshold", type=int, default=160)
    parser.add_argument("--candidate-mode", choices=("raw", "binary", "gray", "residual"), default="binary")
    parser.add_argument(
        "--rotations",
        default="0",
        help="Comma-separated rotation angles applied to each isolated candidate glyph.",
    )
    parser.add_argument("--residual-gain", type=float, default=2.0)
    parser.add_argument("--output", default="data/click-captcha-experiments/round-001-ppocr.json")
    args = parser.parse_args()

    sys.path.insert(0, str(Path(args.deps).resolve()))
    import onnxruntime as ort

    model_dir = Path(args.model_dir)
    session_options = ort.SessionOptions()
    session_options.log_severity_level = 3
    session = ort.InferenceSession(
        str(model_dir / "inference.onnx"),
        sess_options=session_options,
        providers=["CPUExecutionProvider"],
    )
    rotations = tuple(float(value) for value in args.rotations.split(",") if value.strip())
    if not rotations:
        raise ValueError("At least one rotation angle is required.")
    round_dir = Path(args.round)
    corrections_path = Path(args.corrections) if args.corrections else round_dir.parent / "corrections.json"
    corrections = load_corrections(corrections_path)
    metrics = evaluate(
        round_dir,
        session,
        read_dictionary(model_dir),
        args.threshold,
        args.candidate_mode,
        rotations,
        args.residual_gain,
        corrections,
    )
    metrics.update({
        "format": "nju-click-captcha-ppocr-report/v1",
        "round": round_dir.name,
        "corrections": str(corrections_path) if corrections else None,
        "model": "PP-OCRv5_mobile_rec_onnx",
        "candidateMode": args.candidate_mode,
        "threshold": args.threshold,
        "rotations": rotations,
        "residualGain": args.residual_gain if args.candidate_mode == "residual" else None,
        "warning": "Development-only local-model spike. This report is not a generalization claim.",
    })
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"exact: {metrics['exact']}/{metrics['total']}")
    print(f"characters: {metrics['characterCorrect']}/{metrics['characterTotal']}")
    print(f"average: {metrics['averageMs']} ms/image")
    print(f"report: {output}")


if __name__ == "__main__":
    main()
