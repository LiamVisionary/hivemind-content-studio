"""P7: publish dist/RIFE-4.25 to mlx-community.

Writes a model card and uploads model.safetensors + config.json. Requires HF
auth (xocialize @ mlx-community). Run after convert_to_mlx.py.

  python scripts/publish_hf.py 4.25
"""

from __future__ import annotations

import os
import sys

from huggingface_hub import HfApi, create_repo, upload_folder

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rife_mlx.config import VERSIONS  # noqa: E402

ORG = "mlx-community"
DIST = "dist"


def model_card(cfg) -> str:
    return f"""---
license: mit
library_name: mlx
pipeline_tag: video-to-video
tags:
- mlx
- frame-interpolation
- video-frame-interpolation
- rife
- apple-silicon
---

# RIFE {cfg.name} (MLX)

Apple **MLX** port of [Practical-RIFE](https://github.com/hzwer/Practical-RIFE)
**{cfg.name}** — real-time video **frame interpolation** on Apple Silicon. **MIT.**

First MLX/Apple-Silicon-native RIFE: torch-free inference, arbitrary-timestep
interpolation, `--multi` Nx frame rate, `--scale` pyramid for 4K, audio-preserving
video. Converted from the official RIFE {cfg.name} `flownet.pkl` (Google-Drive-only
upstream) to fp32 safetensors.

## Usage

```bash
pip install rife-mlx   # https://github.com/xocialize/rife-mlx
rife-mlx -i input.mp4 -o out.mp4 --multi 2          # 2x fps, keep audio
rife-mlx --img0 a.png --img1 b.png -t 0.5 -o mid.png
```

```python
from rife_mlx.utils.weights import build_model
from rife_mlx.pipeline_mlx import interpolate_pair
model = build_model("{cfg.name}")                    # auto-downloads this repo
mid = interpolate_pair(model, frame_a, frame_b, 0.5) # HWC uint8
```

## Details

- **Architecture**: IFNet (5 coarse-to-fine IFBlocks c=[192,128,96,64,32],
  LeakyReLU, ResConv+beta, Head encoder, ConvTranspose+PixelShuffle).
- **Precision**: fp32 (~23 MB) — RIFE's coarse-to-fine flow is fp16-sensitive.
- **Parity vs PyTorch (CPU fp32)**: warp 2.2e-6 · interp 1.2e-7 · full IFNet 1.43e-3.

## License

MIT (upstream Practical-RIFE, © hzwer). Weights are the official RIFE {cfg.name}
release, converted to MLX.
"""


def main() -> None:
    v = sys.argv[1] if len(sys.argv) > 1 else "4.25"
    cfg = VERSIONS[v]
    folder = os.path.join(DIST, cfg.hf_name)
    if not os.path.isdir(folder):
        raise SystemExit(f"missing {folder}; run convert_to_mlx.py")
    HfApi().whoami()
    with open(os.path.join(folder, "README.md"), "w") as f:
        f.write(model_card(cfg))
    repo_id = f"{ORG}/{cfg.hf_name}"
    create_repo(repo_id, repo_type="model", private=False, exist_ok=True)
    upload_folder(repo_id=repo_id, folder_path=folder, repo_type="model",
                  commit_message=f"Add {cfg.hf_name} (MLX fp32 RIFE port)")
    print(f"OK  https://huggingface.co/{repo_id}")


if __name__ == "__main__":
    main()
