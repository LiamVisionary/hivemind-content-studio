"""P3 Gate B — full IFNet interpolation vs PyTorch golden, on mx.cpu fp32.

Loads converted flownet.pkl weights into the MLX IFNet, runs inference at
t=0.5 scale=1 on the golden frame pair, compares merged frame. Threshold <1e-2
(full-pass). Needs goldens/4.25.npz + refs/4.25/train_log/flownet.pkl + torch.
"""

from __future__ import annotations

import os

import numpy as np
import pytest

import mlx.core as mx

from rife_mlx.model.IFNet_HDv3 import IFNet
from rife_mlx.utils.convert import convert_state_dict

torch = pytest.importorskip("torch")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GOLDEN = os.path.join(ROOT, "goldens", "4.25.npz")
PKL = os.path.join(ROOT, "refs", "4.25", "train_log", "flownet.pkl")


def _nhwc(a):
    return np.transpose(a, (0, 2, 3, 1))


def _load_mlx_ifnet():
    sd = torch.load(PKL, map_location="cpu", weights_only=True)
    sd = {k: v.detach().cpu().numpy() for k, v in sd.items()}
    weights = convert_state_dict(sd)
    m = IFNet()
    m.load_weights(list(weights.items()), strict=True)
    mx.eval(m.parameters())
    return m


def test_ifnet_key_coverage():
    if not os.path.exists(PKL):
        pytest.skip("missing flownet.pkl")
    from mlx.utils import tree_flatten
    sd = torch.load(PKL, map_location="cpu", weights_only=True)
    sd = {k: v.detach().cpu().numpy() for k, v in sd.items()}
    conv = convert_state_dict(sd)
    model_keys = {k for k, _ in tree_flatten(IFNet().parameters())}
    conv_keys = set(conv)
    assert model_keys == conv_keys, (
        f"only in model: {sorted(model_keys - conv_keys)[:5]} | "
        f"only in converted: {sorted(conv_keys - model_keys)[:5]}")


def test_ifnet_full_parity():
    if not (os.path.exists(GOLDEN) and os.path.exists(PKL)):
        pytest.skip("missing golden/pkl")
    g = np.load(GOLDEN)
    img0 = mx.array(_nhwc(g["ifnet_img0_nchw"]))
    img1 = mx.array(_nhwc(g["ifnet_img1_nchw"]))
    ref = g["ifnet_merged_nchw"]

    m = _load_mlx_ifnet()
    with mx.stream(mx.cpu):
        x = mx.concatenate([img0, img1], axis=-1)
        _flow, _mask, merged = m(x, 0.5, (16, 8, 4, 2, 1))
        mx.eval(merged)
    out = np.transpose(np.array(merged), (0, 3, 1, 2))
    err = float(np.max(np.abs(out - ref)))
    print(f"\nIFNet full interpolation max_abs={err:.3e} (tol 1e-2)")
    assert out.shape == ref.shape
    assert err < 1e-2
