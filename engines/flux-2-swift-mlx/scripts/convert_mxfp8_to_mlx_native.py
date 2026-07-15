#!/usr/bin/env python3
"""Convert Comfy/TensorCore MXFP8 safetensors to MLX-native packed MXFP8.

Output format:
- For each float8_e4m3fn matrix with `<key>_scale`, writes:
  - `<key>` as MLX uint32 packed mxfp8 weights
  - `<key>_mlx_scale` as MLX uint8 E8M0 scales in MLX layout
- Other tensors are copied as float16/uint arrays for the existing Swift loader.

This lets Swift MLX use quantizedMM(mode: .mxfp8) instead of BF16 matmul.
"""
from __future__ import annotations

import argparse
import gc
import time
from pathlib import Path

import comfy_kitchen as ck
import mlx.core as mx
import torch
from safetensors import safe_open


def torch_to_mx_float16(t: torch.Tensor) -> mx.array:
    if t.dtype == torch.bfloat16:
        return mx.array(t.float().numpy(), dtype=mx.float16)
    if t.dtype in (torch.float16, torch.float32, torch.float64):
        return mx.array(t.float().numpy(), dtype=mx.float16)
    if t.dtype == torch.uint8:
        return mx.array(t.numpy(), dtype=mx.uint8)
    if t.dtype == torch.int64:
        return mx.array(t.numpy(), dtype=mx.int64)
    if t.dtype == torch.int32:
        return mx.array(t.numpy(), dtype=mx.int32)
    raise TypeError(f"Unsupported tensor dtype for copy: {t.dtype}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--group-size", type=int, default=32)
    ap.add_argument("--bits", type=int, default=8)
    args = ap.parse_args()

    src = Path(args.input).expanduser().resolve()
    dst = Path(args.output).expanduser().resolve()
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(dst.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()

    out = {}
    converted = copied = skipped = 0
    t0 = time.time()

    with safe_open(str(src), framework="pt", device="cpu") as f:
        keys = list(f.keys())
        key_set = set(keys)
        for idx, key in enumerate(keys, 1):
            if key.endswith("_scale") or key.endswith("_comfy_quant"):
                skipped += 1
                continue
            t = f.get_tensor(key)
            scale_key = key + "_scale"
            if scale_key in key_set and str(t.dtype) == "torch.float8_e4m3fn":
                scale = f.get_tensor(scale_key).view(torch.float8_e8m0fnu)
                # Correctly unswizzle/dequantize Comfy layout, then requantize into MLX's
                # own packed uint32 mxfp8 layout. This is offline; inference stays quantized.
                deq = ck.dequantize_mxfp8(t, scale, torch.bfloat16)
                w = mx.array(deq.float().numpy(), dtype=mx.float16)
                q, sc, *biases = mx.quantize(w, group_size=args.group_size, bits=args.bits, mode="mxfp8")
                if biases:
                    raise RuntimeError(f"Unexpected biases for mxfp8 quantize: {key}")
                mx.eval(q, sc)
                out[key] = q
                out[key + "_mlx_scale"] = sc
                converted += 1
                del scale, deq, w, q, sc
            else:
                out[key] = torch_to_mx_float16(t)
                copied += 1
            if idx % 25 == 0:
                print(f"processed {idx}/{len(keys)} converted={converted} copied={copied} skipped={skipped}", flush=True)
                gc.collect()

    metadata = {
        "format": "mlx-native-mxfp8",
        "source": str(src),
        "group_size": str(args.group_size),
        "bits": str(args.bits),
        "scale_suffix": "_mlx_scale",
        "converted_float8_tensors": str(converted),
        "copied_tensors": str(copied),
        "skipped_sidecars": str(skipped),
    }
    print(f"saving {len(out)} tensors to {tmp}", flush=True)
    mx.save_safetensors(str(tmp), out, metadata=metadata)
    written = tmp if tmp.exists() else Path(str(tmp) + ".safetensors")
    written.replace(dst)
    print(f"done: {dst}")
    print(f"converted={converted} copied={copied} skipped={skipped} elapsed={time.time()-t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
