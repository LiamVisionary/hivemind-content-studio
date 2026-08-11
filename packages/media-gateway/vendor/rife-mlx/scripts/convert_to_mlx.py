"""P4: flownet.pkl -> dist/<hf_name>/{model.safetensors, config.json}.

Converts via utils.convert (strip module., transpose conv/convtranspose/beta,
key remap, drop teacher/caltime), mx.eval all (lazy-zero guard), saves.
config.json carries the pinned arch params for the loader.

Published as **fp32**: the net is tiny (~22 MB) and RIFE's coarse-to-fine flow
accumulation is fp16-sensitive (fp16 full-interp diverged to 3.1e-2 vs the 1e-2
gate; fp32 holds the 1.4e-3 parity). No accuracy reason to quantize.

  python scripts/convert_to_mlx.py 4.25
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict

import mlx.core as mx
import torch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rife_mlx.config import VERSIONS  # noqa: E402
from rife_mlx.utils.convert import convert_state_dict  # noqa: E402

V = sys.argv[1] if len(sys.argv) > 1 else "4.25"
DIST = "dist"


def main() -> None:
    cfg = VERSIONS[V]
    pkl = os.path.join("refs", V, "train_log", "flownet.pkl")
    sd = torch.load(pkl, map_location="cpu", weights_only=True)
    sd = {k: v.detach().cpu().numpy() for k, v in sd.items()}

    weights = convert_state_dict(sd)  # fp32 (RIFE flow accumulation is fp16-sensitive)
    mx.eval(weights)

    outdir = os.path.join(DIST, cfg.hf_name)
    os.makedirs(outdir, exist_ok=True)
    st = os.path.join(outdir, "model.safetensors")
    mx.save_safetensors(st, weights, metadata={"format": "mlx"})
    with open(os.path.join(outdir, "config.json"), "w") as f:
        json.dump(asdict(cfg), f, indent=2)

    print(f"OK {cfg.hf_name}: {len(weights)} tensors  {os.path.getsize(st)/1e6:.1f} MB")


if __name__ == "__main__":
    main()
