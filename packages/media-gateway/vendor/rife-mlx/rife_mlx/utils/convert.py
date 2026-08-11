"""flownet.pkl (torch state_dict) -> MLX weights for IFNet. P4 + P3-parity.

Operates on numpy (no torch import). Two jobs:
  1. value transpose by layer type:
       Conv2d          (O,I,kH,kW) -> (O,kH,kW,I)   transpose(0,2,3,1)
       ConvTranspose2d (I,O,kH,kW) -> (O,kH,kW,I)   transpose(1,2,3,0)
       beta            (1,C,1,1)   -> (1,1,1,C)      transpose(0,2,3,1)
       bias / 1-D                                     passthrough
  2. key remap (torch -> our MLX module tree):
       block*.conv0.{j}.0.{w,b}  -> block*.conv0.{j}.conv.{w,b}
       block*.lastconv.0.{w,b}   -> block*.lastconv.{w,b}
       (encode.*, convblock.*.conv.*, convblock.*.beta already match)
  Drops train-only modules (teacher.*, caltime.*).

upstream keys may carry a `module.` prefix (DataParallel) — stripped first.
"""

from __future__ import annotations

import re

import mlx.core as mx
import numpy as np

_CONVTRANSPOSE_SUFFIXES = ("lastconv.0.weight", "encode.cnn3.weight")
_DROP_PREFIXES = ("teacher.", "caltime.")


def _strip_module(k: str) -> str:
    return k[len("module."):] if k.startswith("module.") else k


def _remap_key(k: str) -> str:
    # block{i}.conv0.{j}.0.weight -> block{i}.conv0.{j}.conv.weight
    k = re.sub(r"(conv0\.\d+)\.0\.(weight|bias)$", r"\1.conv.\2", k)
    # block{i}.lastconv.0.weight -> block{i}.lastconv.weight
    k = re.sub(r"lastconv\.0\.(weight|bias)$", r"lastconv.\1", k)
    return k


def _is_convtranspose(k: str) -> bool:
    return k.endswith(_CONVTRANSPOSE_SUFFIXES)


def convert_state_dict(sd: dict[str, np.ndarray]) -> dict[str, mx.array]:
    out: dict[str, mx.array] = {}
    for k0, v in sd.items():
        k = _strip_module(k0)
        if k.startswith(_DROP_PREFIXES):
            continue
        v = np.asarray(v)
        if k.endswith(".beta"):                       # (1,C,1,1) -> (1,1,1,C)
            v = np.transpose(v, (0, 2, 3, 1))
        elif _is_convtranspose(k) and v.ndim == 4:    # (I,O,kH,kW) -> (O,kH,kW,I)
            v = np.transpose(v, (1, 2, 3, 0))
        elif v.ndim == 4:                             # Conv2d (O,I,kH,kW) -> (O,kH,kW,I)
            v = np.transpose(v, (0, 2, 3, 1))
        out[_remap_key(k)] = mx.array(v)
    return out
