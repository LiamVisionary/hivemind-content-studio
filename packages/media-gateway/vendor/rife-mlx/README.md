# rife-mlx

Apple **MLX** port of [Practical-RIFE](https://github.com/hzwer/Practical-RIFE) 4.25 —
real-time video **frame interpolation** on Apple Silicon. **MIT.**

The first MLX / Apple-Silicon-native RIFE: torch-free inference, HF auto-download
(upstream ships weights via Google Drive only), arbitrary-timestep interpolation,
`--multi` Nx frame-rate, `--scale` pyramid for 4K, and **audio-preserving** video output.

> **Status: network parity-locked + full pipeline working** (pinned **RIFE 4.25**;
> only version currently in the registry). Publishing to `mlx-community/RIFE-4.25` is the
> remaining step. See [`docs/PREFLIGHT.md`](docs/PREFLIGHT.md).

## Usage

```bash
pip install -e .            # runtime: mlx, numpy, pillow, huggingface_hub, av (no torch)

# 2× frame rate, keep audio
rife-mlx -i input.mp4 -o output.mp4 --multi 2

# interpolate a single middle frame
rife-mlx --img0 a.png --img1 b.png -t 0.5 -o mid.png

# 4K: halve the pyramid scale for memory
rife-mlx -i 4k.mp4 -o out.mp4 --multi 2 --scale 0.5
```

Flags: `-m`/`--multi N` (insert N-1 frames/pair, output fps ×N) · `-t`/`--timestep`
(image-pair timestep) · `-s`/`--scale {0.25,0.5,1.0,2.0,4.0}` · `-n`/`--version`
(default `4.25`) · `--weights_dir` local override. `-o`/`--output` is required.

## Python

```python
from rife_mlx.utils.weights import build_model
from rife_mlx.pipeline_mlx import interpolate_pair, interpolate_sequence

model = build_model("4.25")                                  # auto-downloads from mlx-community
mid = interpolate_pair(model, frame_a, frame_b, timestep=0.5)   # HWC uint8
# whole list of HWC uint8 frames -> multi-1 inserted per pair:
frames_out = interpolate_sequence(model, frames, multi=2, scale=1.0)
```

## Parity

The full IFNet is parity-locked vs PyTorch on CPU fp32 (the two hand-rolled crux ops —
backward-`warp` `grid_sample` and bilinear `interpolate` — and the whole network):

| Component | max_abs vs PyTorch |
|---|---|
| `warp` (grid_sample, border, align_corners) | 2.2e-6 |
| bilinear `interpolate` | 1.2e-7 |
| **full IFNet interpolation** | **1.43e-3** |

Shipped **fp32** (22.7 MB): RIFE's coarse-to-fine flow accumulation is fp16-sensitive
(fp16 diverged to 3.1e-2), and the net is tiny, so there's no reason to quantize.

## Benchmarks (M5 Max, fp32, GPU)

Single mid-frame `inference`, mean of 3:

| Resolution | scale 1.0 | scale 0.5 |
|---|---|---|
| 480p | 168 ms | 135 ms |
| 720p | 260 ms | 258 ms |
| 1080p | 554 ms | 581 ms |
| 4K | 2112 ms | 2019 ms |

See [`docs/REPORT.md`](docs/REPORT.md).

## How it works

- **IFNet** (5 coarse-to-fine IFBlocks, channels [192,128,96,64,32], LeakyReLU(0.2),
  ResConv+beta, Head encoder, ConvTranspose+PixelShuffle) translated 1:1 from the bundled
  v4.25 source (NHWC). `F.interpolate` uses `align_corners=False`; `warp` grid_sample uses
  `align_corners=True`, border padding.
- **`warp`** (backward `grid_sample`) and bilinear **`interpolate`** are hand-rolled in MLX
  — no native ops — and parity-locked.
- Weights converted from `flownet.pkl` (Google-Drive-only) to safetensors, re-hosted
  on `mlx-community/RIFE-4.25` with HF auto-download + torch-free load.

## License

MIT, inherited from upstream Practical-RIFE (© hzwer). Weights are the official
RIFE 4.25 release, converted to MLX.
