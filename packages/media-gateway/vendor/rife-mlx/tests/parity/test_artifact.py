"""P4: validate the published fp32 safetensors artifact via build_model().

Confirms materialization + that the loaded model reproduces the golden middle
frame within the full-pass gate. Skips if dist/ or goldens/ absent.
"""

from __future__ import annotations

import os

import numpy as np
import pytest

import mlx.core as mx

from rife_mlx.utils.weights import build_model

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DIST = os.path.join(ROOT, "dist", "RIFE-4.25")
GOLDEN = os.path.join(ROOT, "goldens", "4.25.npz")


def test_fp32_artifact_parity():
    if not (os.path.isdir(DIST) and os.path.exists(GOLDEN)):
        pytest.skip("missing dist/golden")
    g = np.load(GOLDEN)
    img0 = mx.array(np.transpose(g["ifnet_img0_nchw"], (0, 2, 3, 1)))
    img1 = mx.array(np.transpose(g["ifnet_img1_nchw"], (0, 2, 3, 1)))
    ref = g["ifnet_merged_nchw"]

    m = build_model("4.25", weights_dir=DIST)
    with mx.stream(mx.cpu):
        out = m.inference(img0, img1, 0.5, 1.0)
        mx.eval(out)
    out_nchw = np.transpose(np.array(out).astype(np.float32), (0, 3, 1, 2))
    err = float(np.max(np.abs(out_nchw - ref)))
    assert not np.allclose(out_nchw, 0.0)
    print(f"\nfp32 artifact max_abs={err:.3e}")
    assert err < 1e-2
