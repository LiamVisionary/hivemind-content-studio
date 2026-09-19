"""Smoke tests for the hand-rolled ops — self-consistency, no weights/torch.

These verify the ops compile and obey invariants. Numerical parity vs torch is
the P2 gate (tests/parity), which needs goldens.
"""

import mlx.core as mx
import numpy as np

from rife_mlx.ops.grid_sample import grid_sample_bilinear
from rife_mlx.ops.interpolate import interpolate_bilinear
from rife_mlx.model.warplayer import warp


def _identity_grid(N, H, W):
    xs = mx.broadcast_to(mx.linspace(-1, 1, W).reshape(1, 1, W, 1), (N, H, W, 1))
    ys = mx.broadcast_to(mx.linspace(-1, 1, H).reshape(1, H, 1, 1), (N, H, W, 1))
    return mx.concatenate([xs, ys], axis=-1)


def test_grid_sample_identity_grid_is_identity():
    rng = np.random.default_rng(0)
    x = mx.array(rng.random((1, 8, 10, 3)).astype(np.float32))
    g = _identity_grid(1, 8, 10)
    y = grid_sample_bilinear(x, g, align_corners=True)
    assert float(mx.max(mx.abs(y - x))) < 1e-5


def test_warp_zero_flow_is_identity():
    rng = np.random.default_rng(1)
    x = mx.array(rng.random((1, 8, 10, 3)).astype(np.float32))
    flow = mx.zeros((1, 8, 10, 2))
    y = warp(x, flow)
    assert float(mx.max(mx.abs(y - x))) < 1e-5


def test_warp_integer_shift_matches_roll():
    # shift right by 1px in x: flow_x = +1 everywhere (interior matches np.roll)
    rng = np.random.default_rng(2)
    x = mx.array(rng.random((1, 6, 6, 1)).astype(np.float32))
    flow = mx.concatenate([mx.ones((1, 6, 6, 1)), mx.zeros((1, 6, 6, 1))], axis=-1)
    y = np.array(warp(x, flow))
    xref = np.array(x)
    # sampling at x+1: y[:, :, j] ≈ x[:, :, j+1] in the interior
    assert np.allclose(y[0, 2:4, 2:4, 0], xref[0, 2:4, 3:5, 0], atol=1e-5)


def test_interpolate_scale1_is_identity():
    rng = np.random.default_rng(3)
    x = mx.array(rng.random((1, 7, 9, 2)).astype(np.float32))
    y = interpolate_bilinear(x, scale_factor=1.0)
    assert y.shape == x.shape
    assert float(mx.max(mx.abs(y - x))) < 1e-6


def test_interpolate_up_down_shapes():
    x = mx.zeros((1, 16, 24, 3))
    up = interpolate_bilinear(x, scale_factor=2.0)
    dn = interpolate_bilinear(x, scale_factor=0.5)
    assert up.shape == (1, 32, 48, 3)
    assert dn.shape == (1, 8, 12, 3)
