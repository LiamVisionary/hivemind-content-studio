"""P7: M5 Max benchmarks -> docs/REPORT.md.

Per-resolution single-frame interpolation latency (one Model.inference) at
scale 1.0 and 0.5, GPU fp32. Mean of 3 timed runs after a warmup.

  python scripts/benchmark.py
"""

from __future__ import annotations

import os
import sys
import time

import mlx.core as mx
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rife_mlx.pipeline_mlx import interpolate_pair  # noqa: E402
from rife_mlx.utils.weights import build_model  # noqa: E402

DIST = "dist/RIFE-4.25"
RES = [("480p", 480, 854), ("720p", 720, 1280), ("1080p", 1080, 1920), ("4K", 2160, 3840)]


def _peak_mb():
    if hasattr(mx, "get_peak_memory"):
        return mx.get_peak_memory() / 1e6
    return float("nan")


def main():
    model = build_model("4.25", weights_dir=DIST)
    rng = np.random.default_rng(0)
    lines = ["# RIFE-4.25-MLX — Benchmarks (M5 Max, fp32, GPU)\n",
             "Single mid-frame interpolation (`Model.inference`), mean of 3 runs.\n",
             "\n| Resolution | scale | Latency | Peak mem |",
             "|---|---|---|---|"]
    for name, H, W in RES:
        a = (rng.random((H, W, 3)) * 255).astype(np.uint8)
        b = np.roll(a, 4, axis=1)
        for scale in (1.0, 0.5):
            try:
                interpolate_pair(model, a, b, 0.5, scale)  # warmup
                if hasattr(mx, "reset_peak_memory"):
                    mx.reset_peak_memory()
                t0 = time.perf_counter()
                for _ in range(3):
                    interpolate_pair(model, a, b, 0.5, scale)
                dt = (time.perf_counter() - t0) / 3
                row = f"| {name} ({H}×{W}) | {scale} | {dt*1000:.0f} ms | {_peak_mb():.0f} MB |"
            except Exception as e:  # noqa: BLE001
                row = f"| {name} ({H}×{W}) | {scale} | OOM/err | {type(e).__name__} |"
            lines.append(row); print(row)

    os.makedirs("docs", exist_ok=True)
    with open("docs/REPORT.md", "w") as f:
        f.write("\n".join(lines) + "\n")
    print("wrote docs/REPORT.md")


if __name__ == "__main__":
    main()
