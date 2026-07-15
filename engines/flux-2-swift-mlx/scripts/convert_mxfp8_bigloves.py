#!/usr/bin/env python3
"""Convert Comfy MXFP8 Flux/BigLove safetensors into scale-correct BF16 safetensors.

This is a compatibility bridge for runtimes that cannot apply MXFP8 block scales
inside matmul. It preserves original BFL/Comfy key names, drops *_weight_scale and
*_comfy_quant sidecar tensors, and dequantizes float8_e4m3fn matrices as:

    dequant = fp8_value * 2 ** (uint8_scale - 127)

with scale repeated over the 32-column MXFP8 group.
"""
from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import save_file

try:
    import comfy_kitchen as ck
except Exception as exc:  # pragma: no cover - runtime dependency check
    ck = None
    _CK_IMPORT_ERROR = exc
else:
    _CK_IMPORT_ERROR = None


def dequant_mxfp8(weight: torch.Tensor, scale: torch.Tensor, *, group_size: int = 32) -> torch.Tensor:
    if ck is None:
        raise RuntimeError(f"comfy_kitchen is required for correct MXFP8 dequantization: {_CK_IMPORT_ERROR}")
    if not hasattr(torch, "float8_e8m0fnu"):
        raise RuntimeError("This torch build lacks torch.float8_e8m0fnu, required for MXFP8 scales")
    if weight.ndim != 2:
        raise ValueError(f"MXFP8 dequant expected 2D tensor, got {tuple(weight.shape)}")
    if scale.ndim != 2:
        raise ValueError(f"MXFP8 scale expected 2D tensor, got {tuple(scale.shape)}")

    # MXFP8 scales are not row-major power exponents. They are stored as E8M0 bytes
    # in TensorCore/Comfy's blocked layout. Reinterpret the uint8 scale bytes as
    # float8_e8m0fnu and let comfy_kitchen unswizzle + dequantize exactly.
    scale_e8m0 = scale.view(torch.float8_e8m0fnu)
    return ck.dequantize_mxfp8(weight, scale_e8m0, torch.bfloat16).contiguous()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--group-size", type=int, default=32)
    args = parser.parse_args()

    src = Path(args.input).expanduser().resolve()
    dst = Path(args.output).expanduser().resolve()
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(dst.suffix + ".tmp")

    t0 = time.time()
    out: dict[str, torch.Tensor] = {}
    converted = 0
    copied = 0
    skipped = 0

    with safe_open(str(src), framework="pt", device="cpu") as f:
        keys = list(f.keys())
        key_set = set(keys)
        for idx, key in enumerate(keys, 1):
            if key.endswith("_scale") or key.endswith("_comfy_quant"):
                skipped += 1
                continue
            tensor = f.get_tensor(key)
            scale_key = key + "_scale"
            if scale_key in key_set and str(tensor.dtype) == "torch.float8_e4m3fn":
                scale = f.get_tensor(scale_key)
                out[key] = dequant_mxfp8(tensor, scale, group_size=args.group_size)
                converted += 1
            else:
                # Preserve bf16/native tensors. If any unsupported float8 tensor lacks scale,
                # fail loudly instead of writing a poisoned checkpoint.
                if "float8" in str(tensor.dtype):
                    raise RuntimeError(f"Float8 tensor has no scale sidecar: {key}")
                out[key] = tensor.contiguous()
                copied += 1
            if idx % 25 == 0:
                print(f"processed {idx}/{len(keys)} tensors; converted={converted} copied={copied} skipped={skipped}", flush=True)

    metadata = {
        "source": str(src),
        "format": "mxfp8-dequant-bf16",
        "group_size": str(args.group_size),
        "scale_formula": "float8_e4m3fn * 2**(uint8_scale-127)",
        "converted_float8_tensors": str(converted),
        "copied_tensors": str(copied),
        "skipped_sidecars": str(skipped),
    }
    print(f"saving {len(out)} tensors to {tmp}", flush=True)
    save_file(out, str(tmp), metadata=metadata)
    os.replace(tmp, dst)
    print(f"done: {dst}")
    print(f"converted={converted} copied={copied} skipped={skipped} elapsed={time.time()-t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
