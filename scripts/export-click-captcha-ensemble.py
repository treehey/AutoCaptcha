"""Export the shared EfficientNet prefix and three local matcher heads to ONNX."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from PIL import Image
from torchvision.models import efficientnet_b0

from click_captcha_dataset import assignments_for, load_corrections, load_round, parse_rounds


ROOT = Path(__file__).resolve().parents[1]
LOCAL_DEPS = ROOT / "data" / "click-captcha-experiments" / "python-deps"
if LOCAL_DEPS.exists():
    sys.path.insert(0, str(LOCAL_DEPS))


def load_training_module():
    path = Path(__file__).with_name("train-click-captcha-student.py")
    spec = importlib.util.spec_from_file_location("click_captcha_student_training", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class EfficientLocalEnsemble(nn.Module):
    def __init__(self, encoder, heads):
        super().__init__()
        self.encoder = encoder
        self.heads = nn.ModuleList(heads)

    def forward(self, targets, candidates):
        batch_size = targets.shape[0]
        rotation_count = candidates.shape[2]
        target_values = self.encoder(targets.reshape(-1, *targets.shape[2:]))
        target_values = target_values.reshape(batch_size, 4, *target_values.shape[1:])
        candidate_values = self.encoder(candidates.reshape(-1, *candidates.shape[3:]))
        candidate_values = candidate_values.reshape(batch_size, 4, rotation_count, *candidate_values.shape[1:])
        return torch.stack([head(target_values, candidate_values) for head in self.heads], dim=1)


def standardize(values):
    spread = values.std()
    return np.zeros_like(values) if spread < 1e-8 else (values - values.mean()) / spread


def prediction(matrices, target_count):
    assignments = assignments_for(target_count)
    head_scores = []
    for matrix in matrices:
        values = np.asarray([
            sum(matrix[index, candidate] for index, candidate in enumerate(assignment))
            for assignment in assignments
        ])
        head_scores.append(standardize(values))
    return assignments[int(np.argmax(np.mean(head_scores, axis=0)))]


def main() -> None:
    parser = argparse.ArgumentParser(description="Export and verify the click-captcha student ensemble.")
    parser.add_argument("--checkpoints", type=Path, nargs="+", required=True)
    parser.add_argument("--data-dir", type=Path, default=Path("data/click-captcha-samples"))
    parser.add_argument("--background-rounds", default="001-013")
    parser.add_argument("--verify-rounds", default="001-020")
    parser.add_argument("--output", type=Path, default=Path("data/click-captcha-experiments/click-captcha-ensemble.onnx"))
    parser.add_argument(
        "--background-output",
        type=Path,
        default=Path("data/click-captcha-experiments/click-captcha-background.png"),
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("data/click-captcha-experiments/click-captcha-onnx-parity.json"),
    )
    args = parser.parse_args()

    training = load_training_module()
    checkpoints = [torch.load(path, map_location="cpu", weights_only=False) for path in args.checkpoints]
    reference = checkpoints[0]
    keys = (
        "inputSize", "foregroundThreshold", "residualGain", "candidateRotations",
        "embeddingDim", "pairHidden", "matcher", "mobileCacheCut",
    )
    if any(any(checkpoint.get(key) != reference.get(key) for key in keys) for checkpoint in checkpoints[1:]):
        raise ValueError("All ensemble checkpoints must use the same architecture and preprocessing")
    if reference["matcher"] != "efficientnet-local":
        raise ValueError("Only the frozen efficientnet-local deployment candidate is supported")

    network = efficientnet_b0(weights=None)
    cut = int(reference["mobileCacheCut"])
    encoder = training.MobilePrefixEncoder(network.features[:cut])
    encoder.load_state_dict(reference["backboneStateDict"])
    input_channels = int(reference["stateDict"]["target_projection.weight"].shape[1])
    heads = []
    for checkpoint in checkpoints:
        head = training.MobileLocalFeaturePermutationMatcher(
            input_channels,
            int(checkpoint["embeddingDim"]),
            int(checkpoint["pairHidden"]),
        )
        head.load_state_dict(checkpoint["stateDict"])
        heads.append(head)
    model = EfficientLocalEnsemble(encoder, heads).eval()

    rotations = tuple(float(value) for value in reference["candidateRotations"])
    dummy_targets = torch.ones((1, 4, 1, reference["inputSize"], reference["inputSize"]), dtype=torch.float32)
    dummy_candidates = torch.ones(
        (1, 4, len(rotations), 1, reference["inputSize"], reference["inputSize"]),
        dtype=torch.float32,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        (dummy_targets, dummy_candidates),
        args.output,
        input_names=("targets", "candidates"),
        output_names=("matrices",),
        opset_version=18,
        dynamo=False,
    )

    corrections = load_corrections(args.data_dir / "corrections.json")
    background_samples = [
        sample
        for round_name in parse_rounds(args.background_rounds)
        for sample in load_round(args.data_dir / round_name, corrections)
    ]
    background = training.make_candidate_background(background_samples)
    args.background_output.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(background.astype(np.uint8)).save(args.background_output)

    import onnxruntime as ort

    session_options = ort.SessionOptions()
    session_options.log_severity_level = 3
    session_options.intra_op_num_threads = 1
    session = ort.InferenceSession(
        str(args.output),
        sess_options=session_options,
        providers=["CPUExecutionProvider"],
    )
    config = argparse.Namespace(
        input_size=int(reference["inputSize"]),
        foreground_threshold=int(reference["foregroundThreshold"]),
        residual_gain=float(reference["residualGain"]),
        candidate_rotations=rotations,
    )
    samples = [
        sample
        for round_name in parse_rounds(args.verify_rounds)
        for sample in load_round(args.data_dir / round_name, corrections)
    ]
    mismatches = []
    max_absolute_error = 0.0
    onnx_elapsed = 0.0
    for sample in samples:
        targets, candidates, _, target_count = training.preprocess_sample(
            sample,
            background,
            config.input_size,
            config.foreground_threshold,
            config.residual_gain,
            config.candidate_rotations,
        )
        target_batch = targets[None]
        candidate_batch = candidates[None]
        with torch.no_grad():
            expected_matrices = model(target_batch, candidate_batch).numpy()[0]
        started = time.perf_counter()
        actual_matrices = session.run(None, {
            "targets": target_batch.numpy(),
            "candidates": candidate_batch.numpy(),
        })[0][0]
        onnx_elapsed += time.perf_counter() - started
        max_absolute_error = max(
            max_absolute_error,
            float(np.max(np.abs(expected_matrices - actual_matrices))),
        )
        expected_prediction = prediction(expected_matrices, target_count)
        actual_prediction = prediction(actual_matrices, target_count)
        if expected_prediction != actual_prediction:
            mismatches.append({
                "round": sample["round"],
                "id": sample["id"],
                "pytorch": list(expected_prediction),
                "onnx": list(actual_prediction),
            })
    report = {
        "format": "nju-click-captcha-onnx-parity/v1",
        "checkpoints": [str(path) for path in args.checkpoints],
        "model": str(args.output),
        "modelBytes": args.output.stat().st_size,
        "background": str(args.background_output),
        "verifyRounds": parse_rounds(args.verify_rounds),
        "samples": len(samples),
        "predictionMismatches": mismatches,
        "maxAbsoluteError": max_absolute_error,
        "averageOnnxInferenceMs": onnx_elapsed * 1000 / len(samples),
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"ONNX parity: {len(samples) - len(mismatches)}/{len(samples)} predictions; "
        f"max abs error {max_absolute_error:.8f}; "
        f"{report['averageOnnxInferenceMs']:.2f} ms/image; {report['modelBytes'] / 1024:.1f} KiB"
    )
    print(f"Report: {args.report}")


if __name__ == "__main__":
    main()
