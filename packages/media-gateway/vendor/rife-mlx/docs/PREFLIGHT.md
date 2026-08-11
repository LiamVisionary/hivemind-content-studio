# Practical-RIFE 4.x → MLX — PREFLIGHT

**Working dir:** `DEV_INT/rife-mlx` · **Remote (planned):** `xocialize/rife-mlx`
**Publish (planned):** `mlx-community/RIFE-4.25` · **Upstream:** [hzwer/Practical-RIFE](https://github.com/hzwer/Practical-RIFE)
**License:** MIT ✅ · **Tier:** 2 (single IFNet) · **Started:** 2026-06-05 · **Pinned version: 4.25**

---

## CONFIRM gates (mlx-porting)

1. **License** ✅ **MIT** — verified the actual `LICENSE` (© 2021 hzwer), code + weights, commercial-OK. No RAIL/NC.
2. **Port status** — **no MLX or MLX-Swift RIFE port** (mlx-community / GitHub). Only ncnn-Vulkan + CoreML community variants. Open lane.
3. **Config truth** — `IFNet_HDv3.py` + `flownet.pkl` **bundle per version via Google Drive** (not in the GitHub repo, not on HF). v4.25 id `1ZKjcbmt1hypiFprJPIKW0Tt0lr_2i7bg` (in `config.py`). **Must pin the exact arch from the bundled .py in P1** — the 4.25 note warns "more flow blocks, scale_list changes." `warp` semantics already read from `model/warplayer.py`: `grid_sample(bilinear, padding_mode='border', align_corners=True)`.
4. **Tier** — Tier 2. Single IFNet (Conv + PReLU + ConvTranspose + warp). No diffusion/scheduler.

## Scope (this round)

- **Pin RIFE 4.25** (recommended default; anime-improved). One arch.
- **Full video pipeline** — decode → interpolate → encode **with audio passthrough** (PyAV + ffmpeg), `--multi N` (Nx fps), `--scale` pyramid for 4K. Plus image-pair mode (arbitrary `t`).

## The crux — novel MLX ops (no native equivalent)

1. **`grid_sample_bilinear`** (NHWC, border pad, align_corners=True) — backs `warp`. `ops/grid_sample.py`, written; parity-locked in P2 (Gate A). Weights from the *unclamped* continuous coord, indices clamped (border).
2. **`interpolate_bilinear`** (NHWC, align_corners configurable) — coarse-to-fine pyramid + `--scale`. `ops/interpolate.py`, written; align_corners pinned from source in P3.

**Carried from realesrgan-mlx:** PReLU, conv `(O,I,kH,kW)→(O,kH,kW,I)`, pixel-shuffle `(C,r,r)`, parity-on-`mx.cpu` discipline, `mx.eval`-before-save. **New:** ConvTranspose2d weight layout (torch `(I,O,kH,kW)` — its own rule).

## Distribution note

Weights are **Google-Drive-only** (no HF). Converting `flownet.pkl` → safetensors and re-hosting on `mlx-community` (MIT + attribution) is itself the value-add: HF auto-download + torch-free MLX inference, neither of which exists today.

## Plan / phases

- **P0 — Scaffold** ✅ (this commit): repo, version registry (4.25 + gdrive id), **grid_sample + interpolate + warp MLX ops written**, IFNet/RIFE skeletons, ops smoke tests, scripts/PREFLIGHT/pyproject.
- **P1 — Fetch + oracle**: `gdown` the v4.25 package → pin arch into `config.py`; PyTorch goldens (warp, interpolate, per-IFBlock, full `inference` at t=0.5) → `goldens/4.25.npz`.
- **P2 — Op parity → Gate A**: grid_sample + interpolate vs torch on `mx.cpu` (<1e-4 ideal). The crux — lock before the net.
- **P3 — IFNet arch → Gate B**: translate `IFNet_HDv3` (blocks, ResConv, ConvTranspose, Head) + `RIFE_HDv3.Model`; full interpolation parity vs golden (<1e-2).
- **P4 — Convert**: `flownet.pkl` → safetensors (+ config.json); `build_model()` load path.
- **P5 — Pipeline + video**: `Model.inference` (pad to /64, scale_list/scale, fuse), `--multi` recursion, image-pair + **PyAV video w/ audio passthrough** CLI.
- **P6 — Quant**: skip (small net) unless cheap int8 sample.
- **P7 — Publish**: `mlx-community/RIFE-4.25` + GitHub `xocialize/rife-mlx` + README + M5 Max benchmarks (720p/1080p/4K, scale story).
- **P8 — DEFERRED: MLX-Swift** (post-WWDC) — RosettaCast anime VFI consumer.

## Gates

- **A** warp + interpolate vs torch `<1e-4` (cpu fp32).
- **B** full `inference(img0,img1,t=0.5,scale=1)` vs torch golden `<1e-2`; also a t-sweep (0.25/0.5/0.75 distinct, monotone motion).
- **C** `--scale 0.5` path runs 4K without OOM, output coherent.
- **D** e2e video: fps doubled, audio preserved, frame count = (N-1)*multi+1.
