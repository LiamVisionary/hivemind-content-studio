"""P2 Gate A — warp + bilinear interpolate vs PyTorch, on mx.cpu fp32.

The crux ops. Threshold <1e-4 (ideal single-op). Needs goldens/<v>.npz
(scripts/gen_goldens.py). Skips if absent.
"""

from __future__ import annotations

import os

import numpy as np
import pytest

import mlx.core as mx

from rife_mlx.ops.grid_sample import grid_sample_bilinear  # noqa: F401
from rife_mlx.ops.interpolate import interpolate_bilinear
from rife_mlx.model.warplayer import warp

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GOLDEN = os.path.join(ROOT, "goldens", "4.25.npz")
TOL = 1e-4


def _g():
    if not os.path.exists(GOLDEN):
        pytest.skip("missing goldens/4.25.npz")
    return np.load(GOLDEN)


def _nchw_to_nhwc(a):
    return np.transpose(a, (0, 2, 3, 1))


def test_warp_parity():
    g = _g()
    img = mx.array(_nchw_to_nhwc(g["warp_img_nchw"]))
    flow = mx.array(_nchw_to_nhwc(g["warp_flow_nchw"]))  # [N,H,W,2] (x,y)
    ref = g["warp_out_nchw"]
    with mx.stream(mx.cpu):
        out = warp(img, flow)
        mx.eval(out)
    out_nchw = np.transpose(np.array(out), (0, 3, 1, 2))
    err = float(np.max(np.abs(out_nchw - ref)))
    print(f"\nwarp max_abs={err:.3e} (tol {TOL:.0e})")
    assert err < TOL


@pytest.mark.parametrize("key,scale", [("interp_up2_nchw", 2.0), ("interp_dn2_nchw", 0.5)])
def test_interpolate_parity(key, scale):
    g = _g()
    x = mx.array(_nchw_to_nhwc(g["interp_in_nchw"]))
    ref = g[key]
    with mx.stream(mx.cpu):
        out = interpolate_bilinear(x, scale_factor=scale, align_corners=False)
        mx.eval(out)
    out_nchw = np.transpose(np.array(out), (0, 3, 1, 2))
    assert out_nchw.shape == ref.shape, (out_nchw.shape, ref.shape)
    err = float(np.max(np.abs(out_nchw - ref)))
    print(f"\ninterp {key} max_abs={err:.3e} (tol {TOL:.0e})")
    assert err < TOL
