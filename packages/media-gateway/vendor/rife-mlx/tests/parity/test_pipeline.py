"""P5 pipeline gates — needs dist/ weights. Skips if absent.

  - interpolate_sequence frame-count math: (N-1)*multi + 1
  - t-sweep: t=0.25/0.5/0.75 produce distinct frames, motion monotone in t
    (a vertical bar shifted between img0 and img1 moves with t).
"""

from __future__ import annotations

import os

import numpy as np
import pytest

from rife_mlx.pipeline_mlx import interpolate_pair, interpolate_sequence
from rife_mlx.utils.weights import build_model

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DIST = os.path.join(ROOT, "dist", "RIFE-4.25")


@pytest.fixture(scope="module")
def model():
    if not os.path.isdir(DIST):
        pytest.skip("missing dist/RIFE-4.25")
    return build_model("4.25", weights_dir=DIST)


def _bar_frame(x):
    img = np.zeros((64, 96, 3), np.uint8)
    img[:, max(0, x - 4):x + 4, :] = 255
    return img


def test_sequence_frame_count(model):
    frames = [_bar_frame(8), _bar_frame(40), _bar_frame(72)]  # 3 frames
    for multi in (2, 3, 4):
        out = interpolate_sequence(model, frames, multi=multi)
        assert len(out) == (len(frames) - 1) * multi + 1


@pytest.mark.parametrize("H,W,scale", [
    (1080, 1920, 0.5),   # regression: 1080 pads to 1088 at /64 but needs 1152 at scale 0.5
    (1080, 1920, 0.25),
    (721, 1281, 0.5),    # odd dims
    (240, 320, 1.0),
])
def test_scale_padding_roundtrip(model, H, W, scale):
    rng = np.random.default_rng(0)
    a = (rng.random((H, W, 3)) * 255).astype(np.uint8)
    b = np.roll(a, 4, axis=1)
    out = interpolate_pair(model, a, b, 0.5, scale)
    assert out.shape == (H, W, 3)


def test_t_sweep_monotone_motion(model):
    img0, img1 = _bar_frame(16), _bar_frame(72)  # bar moves left->right
    def bar_x(frame):  # centroid column of the bright bar
        col = frame.mean(axis=(0, 2))
        return float((np.arange(len(col)) * col).sum() / (col.sum() + 1e-6))
    xs = [bar_x(interpolate_pair(model, img0, img1, t)) for t in (0.25, 0.5, 0.75)]
    print(f"\nbar centroid by t: {[round(x,1) for x in xs]}")
    assert xs[0] < xs[1] < xs[2], f"motion not monotone in t: {xs}"
