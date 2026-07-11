import json
import sys
from pathlib import Path

import numpy as np
import torch


def fold_batch_norm(conv_weight, conv_bias, state, prefix):
    gamma = state[f"{prefix}.weight"].numpy()
    beta = state[f"{prefix}.bias"].numpy()
    mean = state[f"{prefix}.running_mean"].numpy()
    variance = state[f"{prefix}.running_var"].numpy()
    scale = gamma / np.sqrt(variance + 1e-5)
    weight = conv_weight.numpy() * scale[:, None, None, None]
    bias = beta + (conv_bias.numpy() - mean) * scale
    return weight, bias


def main():
    source = Path(sys.argv[1])
    manifest_path = Path(sys.argv[2])
    weights_path = Path(sys.argv[3])
    checkpoint = torch.load(source, map_location="cpu", weights_only=True)
    state = checkpoint["state_dict"]

    conv1 = fold_batch_norm(
        state["features.0.weight"],
        state["features.0.bias"],
        state,
        "features.1",
    )
    conv2 = fold_batch_norm(
        state["features.4.weight"],
        state["features.4.bias"],
        state,
        "features.5",
    )
    tensors = [
        ("conv1.weight", conv1[0]),
        ("conv1.bias", conv1[1]),
        ("conv2.weight", conv2[0]),
        ("conv2.bias", conv2[1]),
        ("conv3.weight", state["features.8.weight"].numpy()),
        ("conv3.bias", state["features.8.bias"].numpy()),
        ("fc1.weight", state["classifier.1.weight"].numpy()),
        ("fc1.bias", state["classifier.1.bias"].numpy()),
        ("fc2.weight", state["classifier.4.weight"].numpy()),
        ("fc2.bias", state["classifier.4.bias"].numpy()),
    ]

    offset = 0
    manifest_tensors = {}
    chunks = []
    for name, values in tensors:
        array = np.asarray(values, dtype="<f4").reshape(-1)
        manifest_tensors[name] = {
            "offset": offset,
            "length": int(array.size),
            "shape": list(values.shape),
        }
        chunks.append(array)
        offset += array.size

    weights_path.parent.mkdir(parents=True, exist_ok=True)
    np.concatenate(chunks).tofile(weights_path)
    manifest = {
        "version": 1,
        "seed": checkpoint["seed"],
        "epochs": checkpoint["epochs"],
        "charset": checkpoint["charset"],
        "input": {
            "width": 24,
            "height": 32,
            "channels": 3,
            "sourceWidth": 80,
            "sourceHeight": 30,
            "slotWidth": 20,
            "overlap": 3,
        },
        "weights": weights_path.name,
        "floatCount": offset,
        "tensors": manifest_tensors,
    }
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    print(f"manifest={manifest_path}")
    print(f"weights={weights_path} bytes={weights_path.stat().st_size}")


if __name__ == "__main__":
    main()
