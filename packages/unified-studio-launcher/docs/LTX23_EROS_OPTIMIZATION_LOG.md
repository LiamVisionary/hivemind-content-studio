# LTX 2.3 Eros Optimization Log

Date started: 2026-07-08

Purpose: keep a durable lab notebook for the Civitai Eros LTX 2.3 workflow so future attempts do not repeat already tested regressions. The hard goal from the user is to cut the full 9.7s generation below half of the current best time without quality loss.

## Current Control State

Status: confirmed from the live LTX lane `/system_stats` after the last restart.

- ComfyUI LTX lane: `http://127.0.0.1:8199`
- OS/device: macOS on MPS, unified memory
- ComfyUI version: `0.26.0`
- Python: `3.11.15`
- PyTorch: `2.11.0`
- Current argv:

```text
main.py --listen 127.0.0.1 --port 8199 --use-quad-cross-attention --gpu-only --output-directory /Users/liam/.comfy-private.noindex/output --input-directory /Users/liam/.comfy-private.noindex/input --temp-directory /Users/liam/.comfy-private.noindex/temp-ltx --database-url sqlite:////Users/liam/.comfy-private.noindex/comfy-ltx.db --disable-metadata
```

Current launch env:

- `COMFY_LTX_ATTENTION=--use-quad-cross-attention`
- `COMFY_LTX_EXTRA_ARGS` unset
- `PYTORCH_MPS_PREFER_METAL` unset
- `LTX2_LORA_BYPASS_MPS` unset

Rollback to this control:

```bash
launchctl unsetenv COMFY_LTX_EXTRA_ARGS || true
launchctl unsetenv PYTORCH_MPS_PREFER_METAL || true
launchctl unsetenv PYTORCH_MPS_FAST_MATH || true
launchctl unsetenv LTX2_LORA_BYPASS_MPS || true
launchctl setenv COMFY_LTX_ATTENTION --use-quad-cross-attention
/Users/liam/.local/bin/zimage-stack restart
```

## Workflow Under Test

Status: confirmed from local workflow files.

Workflow directory:

```text
/Users/liam/comfy/ComfyUI/workflows/civitai/ltx23-eros-anchor/
```

Primary workflows:

- Full run: `ltx23-eros-anchor.user-image-api.json`
- Short benchmark: `ltx23-eros-anchor.short-highvram-warm-api.json`

Important short workflow nodes:

- `646 CheckpointLoaderSimple`: `ltx/10Eros_v1-fp8mixed_learned.safetensors`
- `616 LTXAVTextEncoderLoader`: `gemma_3_12B_it_fp8_scaled.safetensors`
- `617 LTXVAudioVAELoader`: audio VAE from the same checkpoint
- `799 VAELoaderKJ`: `taeltx2_3.safetensors` for preview only
- `800 LTX2SamplingPreviewOverride`: preview override feeds both LoRA branches
- `722/723` and `719/718`: LTX 2.3 distilled LoRA branches
- `731 LTXLatentAnchorAware`: anchor guidance, strength `0.11`, cache step `6`, blocks `10-30`
- `753 LTXTextAttentionAmplifier`: text amplifier, strength `1.3`, blocks `36-48`
- `510 SamplerCustomAdvanced`: first sampler and main bottleneck
- `868 SamplerCustomAdvanced`: second sampler
- `740 VAEDecode`: final video decode from checkpoint VAE
- `593 LTXVAudioVAEDecode`: audio decode
- `597 VHS_VideoCombine`: MP4 output
- `852 AudioCrop`: short benchmark uses `end_time=1`; full run uses `end_time=10`

Quality-loss rule for this project: do not persist changes that reduce duration, resolution, steps, samplers, model/LoRA weights, final VAE quality, or numeric precision unless the user explicitly relaxes "no quality loss." Approximation caches such as TeaCache/FBCache/MagCache are also excluded unless validated as visually lossless for this exact workflow.

## Benchmark Baselines

Note: the live service log was truncated by the last stack restart. Rows marked "prior captured run output" were captured earlier in this optimization session but are no longer present in the current log file.

| Case | Video duration | Wall time | Comfy time | Main node timings | Status |
|---|---:|---:|---:|---|---|
| Original first run | 9.708s | 697.36s | not captured | not captured | prior captured run output |
| Current best full, dedicated LTX lane | 9.708s | 481.02s | 480.63s | `510=270.028s`, `868=110.937s`, `740=84.581s`, `593=6.689s`, `597=3.995s` | prior captured run output |
| Short control, quad, preview on | about 0.7-1.0s | 87.19s | 86.78s | `510=69.864s`, `868=9.769s`, `740=0.785s`, `593=4.524s`, `597=0.436s` | prior captured run output |

Target:

- Full-run target for "less than half" of the current best: under `240.51s`.
- Short-run proxy target is not a linear duration ratio. Use it only to screen regressions. Any candidate that beats short control materially must be confirmed on the full workflow.

## Attempts Already Tried

Do not retry these unless a new dependency, new Comfy/PyTorch version, or new workflow architecture changes the premise.

| Attempt | Change | Result | Decision |
|---|---|---:|---|
| Dedicated LTX lane | Separate port `8199`, `--gpu-only`, LTX priority mode, Flux2 server disabled by default while LTX lane is prioritized | Full run improved from `697.36s` to `481.02s` | Keep |
| KJNodes MPS patch setup | Install/apply LTX KJNodes MPS support during setup | Required for stable LTX path | Keep |
| Preview bypass | Removed `800 LTX2SamplingPreviewOverride`; wired LoRA nodes to base model | Short worsened from `86.78s` to `127.64s` Comfy | Reject |
| PyTorch cross attention | `COMFY_LTX_ATTENTION=--use-pytorch-cross-attention` | Short timed run `136.65s` wall, `510=115.880s` | Reject |
| Split cross attention | `COMFY_LTX_ATTENTION=--use-split-cross-attention` | Warm short `125.52s` wall | Reject |
| Flash attention flag | `COMFY_LTX_ATTENTION=--use-flash-attention` | Short warm/timed `107.82s/112.75s`; 3s sampler-one `510=139.805s` vs quad `122.947s` | Reject |
| `PYTORCH_MPS_PREFER_METAL=1` | Prefer Metal kernels for matmul | Short warm/timed `114.69s/116.21s` | Reject |
| Channels-last | `COMFY_LTX_EXTRA_ARGS=--force-channels-last` | Warm/timed `97.90s/129.01s` | Reject |
| Non-blocking | `COMFY_LTX_EXTRA_ARGS=--force-non-blocking` | Warm `130.39s` | Reject |
| AppleSilicon-FP8 op trace | `ASFP8_TRACE_OPS=1`, one short diagnostic run | Prompt `cf86442d-4ea8-49f0-869b-f8c5a5e06ce5`; wall `112.07s`, Comfy `110.94s`; traced hot path is `F.linear` with fp32 text encoder then bf16 sampler weights/activations, not `_scaled_mm`; `510=71.716s`, `868=10.267s` under trace | Diagnostic only; native FP8 kernels are not the sampler bottleneck |
| Standalone LTX-exclusive server | Stopped managed stack; launched only one Comfy LTX server with same quad/gpu-only argv and Apple Silicon env | Cold-ish short prompt `9602a1ea-67db-4b2c-9f1b-9f12afaa0578`: wall `103.27s`, Comfy `103.08s`, `510=69.720s`, `868=10.380s`; warm changed-seed prompt `22112f5a-1d1a-402f-bc22-c93eede94be6`: wall `103.44s`, Comfy `102.93s`, `510=81.664s`, `868=12.846s` | Reject; resource isolation did not beat managed-lane control (`87.19s` wall, `86.78s` Comfy) |
| Disable MPS LoRA bypass | `LTX2_LORA_BYPASS_MPS=0` | Stuck for minutes at model load | Reject |
| Rank-1 LoRA bypass rewrite | Local `lora.py` hot path rewrite; CPU/MPS exact max diff `0.0` | Warm `121.96s` | Reject and reverted |
| LoRA generic hot-path rewrite | Avoided generic conv/list/no-op dtype casts in `comfy/weight_adapter/lora.py`; exact max diff `0.0` on CPU and MPS | Warm `152.49s` | Reject and reverted |
| Decoder-only VAE compile | In-memory `TorchCompileVAE`, decoder only, `inductor`, `reduce-overhead` | Warm/timed `101.24s/115.48s`; VAE itself became fast but sampler timings regressed | Reject for short workflow; keep as possible full-only probe |
| Model compile after preview override | In-memory `TorchCompileModelAdvanced` after node `800`, transformer blocks only | Warm `129.62s`; Dynamo recompiles in attention and anchor hook | Reject |
| Full decoder-only VAE compile | In-memory `TorchCompileVAE`, decoder only, `inductor`, `reduce-overhead`, inserted before node `740` in full workflow | Prompt `ac5ce387-65e4-441c-806e-053541c305db`; wall `583.56s`, Comfy `581.46s`; `510=319.493s`, `868=125.828s`, `740=94.302s`, `593=8.617s`, `597=2.348s` | Reject; worse than `481.02s` control and worsened the target VAE node |
| Final VAE dtype change | Considered `--fp16-vae` | This is a precision/quality change and Comfy docs warn it may cause black images | Not tested/persisted |
| TeaCache/FBCache/MagCache | Researched | Training-free caching can speed up video diffusion, but sources describe adjustable speed/quality tradeoffs or "acceptable accuracy loss" | Exclude unless separately quality validated |

## Local Changes From Experiments

Confirmed local launcher hook:

- `/Users/liam/.local/bin/zimage-stack` supports `COMFY_LTX_EXTRA_ARGS` in the LTX lane.
- It is currently inert because `COMFY_LTX_EXTRA_ARGS` is unset.
- A temporary empty-array bug under `set -u` was fixed by using `${COMFY_LTX_EXTRA_ARGS:-}`.

Current repo states:

- Product repo: `/Users/liam/comfy/unified-image-studio-template` on `main`, clean before this document.
- ComfyUI repo: `/Users/liam/comfy/ComfyUI` is ahead of origin by two prior commits and has untracked `workflows/civitai/`.
- No active local diff remains in `comfy/weight_adapter/lora.py` or KJNodes LTX files after reverted experiments.

## Research Findings

Sources are primary when possible: official docs, official repositories, and upstream issue trackers.

### ComfyUI Flags

Source: official ComfyUI startup flags, https://docs.comfy.org/development/comfyui-server/startup-flags

Confirmed:

- Attention flags are mutually exclusive: split, quad, PyTorch, Sage, Flash, etc.
- `--gpu-only` stores and runs models on GPU; this is already active for the LTX lane.
- `--highvram`, `--lowvram`, `--novram`, `--cpu`, and `--gpu-only` are mutually exclusive.
- `--force-channels-last`, precision flags, preview flags, and cache flags are available.

Implication:

- The obvious attention alternatives have now been measured and lost to quad on this exact workflow.
- `--highvram` is not additive with the current `--gpu-only` lane.
- `--fp16-vae`, `--fp16-intermediates`, and `PYTORCH_MPS_FAST_MATH` are quality/numeric changes, not clean quality-neutral optimizations.

### PyTorch MPS

Sources:

- PyTorch MPS environment variables, https://docs.pytorch.org/docs/2.12/mps_environment_variables.html
- PyTorch `torch.compile`, https://docs.pytorch.org/docs/2.12/generated/torch.compile.html
- PyTorch MPS SDPA improvement issue, https://github.com/pytorch/pytorch/issues/179294

Confirmed:

- `PYTORCH_MPS_PREFER_METAL=1` uses Metal kernels instead of MPS Graph APIs for matmul; it measured worse here.
- `PYTORCH_MPS_FAST_MATH=1` enables fast math. This is a numeric behavior change and should not be persisted under "no quality loss" without output equivalence testing.
- `torch.compile(mode="reduce-overhead")` mostly targets CUDA graph overhead reduction; docs do not promise the same benefit on MPS.
- `torch.compile(mode="max-autotune")` leans on Triton/template matmul machinery on supported devices; this is unlikely to be a clean Apple MPS win for this workflow.
- Upstream PyTorch is still actively improving MPS SDPA behavior and call routing.

Implication:

- Our failed compile experiments are consistent with PyTorch docs: MPS does not get the strongest CUDA compile paths, and dynamic hooks in this graph trigger recompilation.
- A future PyTorch with improved MPS SDPA could change this, but current PyTorch `2.11.0` does not make PyTorch/Flash attention faster for this workflow.

### Lightricks LTX / ComfyUI-LTXVideo

Sources:

- Official LTX-Video repository, https://github.com/Lightricks/ltx-video
- Official ComfyUI-LTXVideo repository, https://github.com/Lightricks/ComfyUI-LTXVideo

Confirmed:

- The official ComfyUI-LTXVideo repo lists CUDA-compatible GPU with 32GB+ VRAM as a prerequisite for its main path.
- It ships LTX 2.3 example workflows, including single-stage and two-stage distilled/full pipelines.
- It states Union IC-LoRA uses downsampled latent processing to reduce memory and speed inference while maintaining quality.
- The main LTX-Video repo calls out LTX-VideoQ8 as an 8-bit optimized version designed for NVIDIA ADA GPUs, not Apple Silicon.
- The main repo describes TeaCache as up to 2x but with configurable speed/visual-quality tradeoffs.

Implication:

- The current Comfy path is not the vendor-optimized Apple path. Apple Silicon support here depends on local MPS/FP8 patches and Comfy graph behavior.
- The strongest no-quality-loss lead from Lightricks sources is not a Comfy flag; it is a model/runtime path purpose-built for the target hardware or a downsampled-control workflow that preserves the intended output.

### AppleSilicon-FP8 Local Patch Layer

Source: local node README and code at `/Users/liam/comfy/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8/`.

Confirmed:

- The active patch layer already routes MPS FP8 `_scaled_mm` through LUT decode plus bf16 matrix-unit matmul.
- It patches `F.linear` FP8 operands on MPS.
- It installs a guarded mtlflashattn SDPA path for large MPS attention.
- Its README says default FP8 on MPS is compatibility more than speed: FP8 storage savings remain, but matmul runs after bf16 decode unless opt-in native kernels engage.
- Opt-in native fp8/int8 kernels have OS/GPU/toolchain constraints and may not engage on this machine.

Implication:

- We are already tapping the main existing Apple Silicon compatibility layer.
- A trace run on 2026-07-08 showed the sampler hot path is `F.linear` with `torch.bfloat16` tensors, not `_scaled_mm` FP8. Native FP8 matmul is therefore not the current sampler bottleneck for this workflow.
- The remaining 2x class improvements probably need either faster bf16 linear/attention execution for this exact LTX path, native MLX/Metal kernels, or a different runtime architecture, not another Comfy flag.

### Metal / MPS Attention Projects

Sources:

- `mps-flash-attention`, https://github.com/mpsops/mps-flash-attention
- `metal-flash-attention`, https://github.com/philipturner/metal-flash-attention
- Apple MPSGraph SDPA docs, https://developer.apple.com/documentation/metalperformanceshadersgraph/mpsgraph/scaleddotproductattention%28query%3Akey%3Avalue%3Amask%3Ascale%3Aname%3A%29
- PyTorch forum post on custom MPS SDPA operator, https://discuss.pytorch.org/t/faster-attenion-with-mps-backend/224884

Confirmed:

- External Apple Silicon attention projects exist and expose drop-in SDPA or custom-op approaches.
- `mps-flash-attention` supports PyTorch `2.5` through `<2.12`, Apple Silicon, and a drop-in SDPA replacement.
- Our current lane already has an mtlflashattn-based patch active, and the Comfy `--use-flash-attention` path measured worse than quad.

Implication:

- Do not assume "Flash" is faster. It must be measured through the actual LTX graph.
- A custom direct attention kernel can still be a real research path, but it is not a quick flag-level optimization.

### Wan2GP

Sources:

- Wan2GP repository, https://github.com/deepbeepmeep/Wan2GP
- Local clone `/tmp/Wan2GP-ltx-opt` at commit `c3232fc`

Confirmed:

- Wan2GP supports LTX-2/LTXV and has many LTX 2.3 features.
- Its documented speed stack heavily leans on CUDA/Triton/Sage/Flash and memory/offload profiles.
- Its changelog claims additional LTX 2.3 VRAM optimizations and an 8% speedup around the 10.9875 update.
- It has early MPS/Apple support, but its own changelog says Apple support is not yet fast or very optimized.

Implication:

- Direct Wan2GP CUDA/Sage/Triton kernels are not portable to MPS.
- Transferable ideas: isolate browser/other GPU users, offload/residency profiling, block streaming concepts, profile-driven feature gates, and possibly a separate MLX-native route.

### MLX LTX Ports

Sources:

- `dgrauet/ltx-2-mlx`, https://github.com/dgrauet/ltx-2-mlx
- `dgrauet/ComfyUI-LTXVideo-mlx`, https://github.com/dgrauet/ComfyUI-LTXVideo-mlx
- Apple MLX research article, https://machinelearning.apple.com/research/exploring-llms-mlx-m5
- `mlx-video`, https://github.com/Blaizzy/mlx-video

Confirmed:

- There are native MLX LTX 2.3 ports for Apple Silicon.
- `dgrauet/ltx-2-mlx` advertises text-to-video, image-to-video, audio-to-video, retake/extend, keyframe interpolation, IC-LoRA, block streaming, q4/q8/bf16 model variants, and low-RAM modes.
- `ComfyUI-LTXVideo-mlx` is a ComfyUI LTXVideo fork with MLX-oriented models/workflows.
- Apple describes MLX as Apple Silicon focused and able to run operations on CPU/GPU without explicit memory movement.

Unconfirmed:

- Whether the exact Eros workflow checkpoint, distilled LoRA wiring, anchor-aware hook, text attention amplifier, and current output quality can be reproduced in MLX today.
- Whether MLX supports the same fp8mixed checkpoint directly or requires converted q8/q4/bf16 weights that would alter quality/performance tradeoffs.

Implication:

- MLX is the most credible novel path for a real 2x Apple Silicon speedup.
- It is not a drop-in Comfy flag. It needs a compatibility spike: can it load equivalent models, apply equivalent LoRAs/conditioning, and preserve the same output target?
- Windows users must continue using the existing Comfy/Windows path. Any MLX route must be Apple-only behind hardware detection.

## Novel Attempts Queue

Only run these if they preserve quality or are explicitly marked "research only."

1. Profile actual MPS ops in sampler:
   - Reason: node-level timings show sampler bottleneck but not operator bottleneck.
   - Test: use AppleSilicon-FP8 `mps_profile` or PyTorch MPS profiler/signposts on one short run.
   - Success bar: identify a specific operation seam that can be patched without changing math.
   - Risk: profiler overhead; use one short run only.

2. MLX compatibility spike:
   - Reason: most credible path for large Apple-specific improvement.
   - Test: install/use an isolated MLX LTX 2.3 pipeline, confirm image-to-video/audio path, model variants, LoRA support, and output dimensions.
   - Success bar: one short generation from the same image and semantically equivalent prompt at same quality target, then compare timing.
   - Risk: may not support anchor-aware/text-amplifier custom Comfy nodes; may require converted weights and therefore not be strictly identical.

3. Exact prompt/text-encoder cache:
   - Reason: quality-neutral for repeated identical prompt/image runs.
   - Test: ensure Comfy cache already skips text/image preprocessing; if not, add safe caching.
   - Success bar: faster repeated prompt startup only.
   - Risk: not enough to affect sampler-dominated full runs.

## Excluded For Now

- `PYTORCH_MPS_FAST_MATH=1`: numeric behavior change.
- `--fp16-vae` / `--fp16-intermediates` / dtype downgrades: precision and quality risk.
- Reducing frames, duration, resolution, sampler steps, or replacing final VAE with TAE: violates current quality constraint.
- TeaCache/FBCache/MagCache: approximation cache; sources advertise speed/quality tradeoff or acceptable accuracy loss, not exact equivalence.
- Retrying split/pytorch/flash/channels-last/non-blocking/PREFER_METAL without a new runtime version: already measured worse.

## Next Measurement Protocol

For every candidate:

1. Restore control state.
2. Run one warm short workflow.
3. Run one timed short workflow.
4. Extract wall time and per-node `NodeTiming`.
5. Revert immediately if worse or if it changes quality semantics.
6. Only if short results improve materially, run the full 10s workflow and compare against `481.02s`.
7. Append results here before moving to the next idea.

Useful commands:

```bash
curl -fsS http://127.0.0.1:8199/system_stats | /usr/bin/python3 -m json.tool | sed -n '1,90p'
tail -260 /Users/liam/.comfy-private.noindex/comfy-ltx.log | rg "prompt_id|NodeTiming|Prompt executed|recompile|ERROR"
curl -fsS http://127.0.0.1:8199/object_info/TorchCompileModelAdvanced | /usr/bin/python3 -m json.tool
curl -fsS http://127.0.0.1:8199/object_info/TorchCompileVAE | /usr/bin/python3 -m json.tool
```

## 2026-07-08 Continued Research Pass

### Live State Re-check

Confirmed:

- LTX lane `/system_stats` still reports `--use-quad-cross-attention` and `--gpu-only` on port `8199`.
- ComfyUI reports MPS device, PyTorch `2.11.0`, ComfyUI `0.26.0`, and ~128 GiB unified memory.
- Product repo status before this doc update: only this optimization log was untracked/modified.
- Free disk on `/Users/liam`/`/tmp`: ~228 GiB.
- Existing LTX assets:
  - Checkpoints: `/Users/liam/comfy/ComfyUI/models/checkpoints/ltx`, ~27 GiB.
  - LoRAs: `/Users/liam/comfy/ComfyUI/models/loras/ltx`, ~1.2 GiB.
  - Text encoders: `/Users/liam/comfy/ComfyUI/models/text_encoders`, ~71 GiB.

### MLX Native Runtime Setup

Confirmed:

- Cloned `dgrauet/ltx-2-mlx` into `/tmp/ltx-2-mlx-opt`.
- Ran `uv sync --no-dev` successfully in that clone.
- The isolated venv installed `ltx-core-mlx==0.14.15`, `ltx-pipelines-mlx==0.14.15`, `mlx==0.31.1`, `mlx-lm==0.31.1`, and related dependencies.
- This did not touch the ComfyUI runtime or the product repo.
- `uv run ltx-2-mlx --help` exposes generation, audio-to-video, retake/extend, keyframe, IC-LoRA, prompt enhancement, and model info commands.
- `uv run ltx-2-mlx generate --help` confirms:
  - Image-to-video supports `--image PATH [FRAME_IDX STRENGTH [CRF]]`.
  - The mode must be explicit: `--one-stage`, `--two-stage`, `--two-stages-hq`, or `--distilled`.
  - `--distilled` is the fastest built-in generation mode.
  - `--enable-teacache` is an explicit approximation cache and remains excluded unless separately validated.
  - Frame rate is mandatory; LTX-2.3 was trained at `24`.
  - The help text exposes no hidden exact-quality Comfy graph import path.

Important local finding:

- `ltx-2-mlx info --model <hf-repo>` calls `snapshot_download(args.model)` if the model path is not already local. Do not use `info` as a cheap metadata probe for huge HF repos; it will attempt a full model snapshot.

### MLX Sources Reviewed

Sources:

- `dgrauet/ltx-2-mlx`, https://github.com/dgrauet/ltx-2-mlx
- `dgrauet/mlx-forge`, https://github.com/dgrauet/mlx-forge
- `MLXBits/ltx-2.3-10eros-v1.2-mlx-q8`, https://huggingface.co/MLXBits/ltx-2.3-10eros-v1.2-mlx-q8
- MLX documentation, https://ml-explore.github.io/mlx/build/html/index.html

Confirmed:

- `ltx-2-mlx` describes itself as a pure MLX LTX-2.3 port for Apple Silicon, with T2V, I2V, A2V, two-stage, distilled, keyframe, IC-LoRA, q4/q8/bf16 model variants, block streaming, modality tiling, and upsamplers.
- Its pipeline maturity doc marks `generate --one-stage`, `--two-stage`, `--two-stages-hq`, and `--distilled` as stable and upstream-isomorphic for the MLX port.
- It documents frame counts as `8k + 1`; `9` frames is the minimal quick test, `25` frames is roughly one second at 24 fps, and `97` frames is roughly four seconds.
- It documents `LTX2_DIT_EVAL_EVERY=N`, default `8`, as a command-buffer flush cadence. Setting it to `0` disables periodic DiT eval flushing to maximize lazy-graph throughput on machines that do not hit the macOS GPU watchdog. This should not alter sampling math, but it can crash/hang on some Macs.
- It documents `LTX2_GEMMA_EVAL_EVERY=N`, default `1`, similarly for Gemma text encoding. This is less important for the current Comfy benchmark because sampler/decoder dominate, but could matter in MLX end-to-end timing.
- `mlx-forge` supports LTX-2.3 conversion, int8 quantization, per-component splitting, validation, and local-checkpoint conversion via `mlx-forge convert ltx-2.3 --checkpoint /path/to/checkpoint.safetensors`.
- `mlx-forge` says only Linear weights are quantized; Conv/norm/embedding and other layers stay in original precision.

### 10Eros MLX Model Candidate

Source:

- `MLXBits/ltx-2.3-10eros-v1.2-mlx-q8`, https://huggingface.co/MLXBits/ltx-2.3-10eros-v1.2-mlx-q8

Confirmed from the model card:

- It is an int8 MLX quantization of `TenStrip/LTX2.3-10Eros v1.2`, packaged for `ltx-2-mlx`.
- It includes both transformer variants plus shared components, so `--two-stage`, `--distilled`, I2V, and audio pipelines should work out of the box.
- Approximate listed sizes:
  - `transformer-dev.safetensors`: ~19 GiB.
  - `transformer-distilled-1.1.safetensors`: ~19 GiB.
  - `connector.safetensors`: ~5.9 GiB.
  - VAE/audio/vocoder/upscalers add several more GiB.
  - Official rank-384 distilled LoRAs are ~7.1 GiB each if included.
- Text encoder is not bundled; `ltx-2-mlx` loads Gemma separately via `mlx-lm`.
- Conversion provenance shows the distilled LoRA was merged into a 10Eros v1.2 bf16 checkpoint before q8 conversion.

Implication:

- This is the fastest credible Apple-native path to test, but it is not yet an accepted replacement for the current Comfy workflow because:
  - Current Comfy checkpoint is `10Eros_v1-fp8mixed_learned.safetensors`, not confirmed identical to `10Eros v1.2`.
  - q8 quantization is close, but not mathematically identical to the fp8mixed/PyTorch path.
  - Current Comfy graph uses custom `LTXLatentAnchorAware` and `LTXTextAttentionAmplifier` nodes that are not obviously represented in `ltx-2-mlx`.
  - The current Comfy workflow uses two sampler nodes and custom LoRA branch wiring; MLX has a different pipeline abstraction.

Decision:

- Treat MLX q8 as a compatibility/speed spike first.
- It can become the Apple Silicon lane only if quality and workflow semantics are validated against the current graph.
- Windows must continue to use the existing Comfy/Windows path.

### Additional Comfy / LTX Research

Sources:

- Official Comfy LTX-2.3 workflow docs, https://docs.comfy.org/tutorials/video/ltx/ltx-2-3
- Official `Lightricks/ComfyUI-LTXVideo`, https://github.com/Lightricks/ComfyUI-LTXVideo
- LTX-2 optimization request thread, https://github.com/Lightricks/ComfyUI-LTXVideo/issues/421
- ComfyUI LTX-2.3 slowdown issue, https://github.com/Comfy-Org/ComfyUI/issues/14345

Confirmed:

- Comfy docs say LTX-2.3 is natively supported and improves fine detail, portrait video, audio, I2V, prompt understanding, and text rendering.
- Official Comfy docs list BF16 full model, FP8 quantized model, distilled LoRA, upscaler, and Gemma text encoder assets.
- The Lightricks repo lists LTX-2.3 example workflows including single-stage and two-stage distilled/full model paths.
- A GitHub issue requesting SageAttention + `torch.compile` + FP16 for LTX-2 remains a feature request, not a confirmed available Apple path.
- A 2026 Comfy issue reports LTX-2.3 slowdown after a Comfy update, with suspected offloading/VAE/CUDA behavior. This supports tracking runtime versions and offloading, but does not provide an Apple/MPS fix.

Implication:

- The current Comfy lane already uses the most favorable measured native Comfy attention flag (`--use-quad-cross-attention`) and Apple Silicon patches.
- Unproven CUDA-focused advice should not be transplanted into MPS.

### Wan2GP Research Update

Source:

- `deepbeepmeep/Wan2GP`, https://github.com/deepbeepmeep/Wan2GP

Confirmed:

- Wan2GP's documented high-performance stack is CUDA-centric: CUDA 12.4, PyTorch CUDA, cuDNN, SageAttention compiled for the specific GPU architecture, TF32/threading env tuning, and cache mounting.
- The repo supports LTX-2 in its broader model matrix, but the performance recipe is not Apple/MPS-native.

Implication:

- Transferable ideas remain: headless batch processing, cache locality, model pinning/offload discipline, and compile/cache per hardware lane.
- Direct SageAttention/Triton/CUDA kernels are not viable for this Apple Silicon target.

### New Candidate Queue After Research

1. MLX q8 benchmark, research-only:
   - Download `MLXBits/ltx-2.3-10eros-v1.2-mlx-q8` to a durable local model directory.
   - Run the shortest valid I2V benchmark (`9` frames) and a one-second benchmark (`25` frames) with `--distilled`.
   - Record wall time and output path.
   - Not accepted as a quality-preserving replacement until visual/semantic comparison passes.

2. MLX q8 eval-cadence benchmark, quality-neutral candidate:
   - Repeat the same MLX short benchmark with `LTX2_DIT_EVAL_EVERY=0` if the baseline completes.
   - If it crashes/hangs, revert to default `8`.
   - If faster and stable, this is a real Apple-only speed knob for an MLX lane.

3. Exact-weight MLX conversion spike:
   - Investigate whether `mlx-forge convert ltx-2.3 --checkpoint /Users/liam/comfy/ComfyUI/models/checkpoints/ltx/10Eros_v1-fp8mixed_learned.safetensors` can convert the current checkpoint or whether it requires a bf16 10Eros checkpoint.
   - If it requires bf16, find/download the exact bf16 upstream variant via the existing civit/HF model flow instead of converting the fp8mixed checkpoint.
   - This is the only MLX route likely to satisfy "same model, same quality target."

4. TeaCache only if quality is explicitly validated:
   - The source advertises LTX-Video speedups but also documents quality-loss knobs.
   - Keep excluded for now under the user's "no quality degradation" constraint.

### MLX Distilled Subset Download

Confirmed:

- Downloaded the required `--distilled` subset of `MLXBits/ltx-2.3-10eros-v1.2-mlx-q8` to:

```text
/Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1.2-mlx-q8-distilled-subset
```

- Download used `huggingface_hub.snapshot_download(..., allow_patterns=[...])` and avoided the dev transformer and 7 GiB LoRA files.
- Download duration: ~19m43s wall, unauthenticated HF.
- Final files:
  - `transformer-distilled-1.1.safetensors`: 20,587,728,079 bytes.
  - `connector.safetensors`: 6,344,495,512 bytes.
  - `vae_encoder.safetensors`: 637,885,319 bytes.
  - `vae_decoder.safetensors`: 814,349,531 bytes.
  - `audio_vae.safetensors`: 106,509,048 bytes.
  - `vocoder.safetensors`: 258,313,851 bytes.
  - `spatial_upscaler_x2_v1_1.safetensors`: 995,745,061 bytes.
  - Required config/metadata JSON files.

Status:

- Ready for local `ltx-2-mlx` preflight and short benchmark.
- This is still a research-only Apple-native lane until visual/semantic quality is compared with the current Comfy graph.

### Exact Current Checkpoint Conversion Notes

Confirmed:

- Current Comfy checkpoint:

```text
/Users/liam/comfy/ComfyUI/models/checkpoints/ltx/10Eros_v1-fp8mixed_learned.safetensors
```

- File size: ~27 GiB.
- Safetensors key count: `8411`.
- Metadata keys include `_quantization_metadata`, `config`, `description`, `license`, and `model_version`.
- `model_version`: `2.3.0`.
- Top-level key prefixes:
  - `model`: `6908`.
  - `vocoder`: `1227`.
  - `vae`: `170`.
  - `audio_vae`: `102`.
  - `text_embedding_projection`: `4`.
- `_quantization_metadata` has `format_version=1.0` and `1232` layer entries, all `float8_e4m3fn`.

Implication:

- `mlx-forge` exact conversion is structurally plausible because the checkpoint uses standard LTX-2.3 component prefixes.
- It is not yet confirmed safe because `mlx-forge`'s documented main path expects bf16/fp16 PyTorch checkpoint tensors, while this local checkpoint is fp8mixed with explicit FP8 quantization metadata.
- Before attempting a full exact conversion, inspect whether `mlx-forge` preserves/dequantizes these FP8-marked tensors correctly. A naive conversion could write invalid or all-zero transformer weights.

### MLX Q8 Distilled Benchmarks

Status:

- Research-only Apple-native lane.
- Clears the full-run speed target, but is not yet accepted as a no-quality-loss replacement for the current Comfy graph.

Preflight:

- `ltx-2-mlx info` on the local distilled subset:
  - Total safetensors: `27.7 GiB`.
  - Estimated runtime RAM: `~36 GiB`.
  - Required files present: distilled transformer, connector, VAE encoder/decoder, audio VAE, vocoder, x2 spatial upscaler, configs.
- Gemma text encoder `mlx-community/gemma-3-12b-it-4bit` was not cached before the first MLX run.
  - Downloaded separately to avoid counting model download as generation time.
  - Size: ~`7.51 GiB`.
  - Download duration: ~`5m35s` unauthenticated HF.

Important correction:

- Initial MLX tests accidentally requested `-H 480 -W 832`, producing landscape `832x448`.
- Actual Comfy outputs are portrait `448x832`.
- Correct MLX request is `-H 832 -W 480`; MLX two-stage floors dimensions to multiples of `64`, so `480` becomes `448` and `832` remains `832`.

Invalid-shape smoke results:

| Case | Shape | Frames | Wall | Notes |
|---|---:|---:|---:|---|
| MLX q8 distilled, default cadence | `832x448` | `9` | `18.25s` | wrong orientation, smoke only |
| MLX q8 distilled, default cadence | `832x448` | `25` | `19.74s` | wrong orientation, not comparable |
| MLX q8 distilled, `LTX2_DIT_EVAL_EVERY=0` | `832x448` | `25` | `33.31s` | same output hash as default, slower; reject |

Correct portrait results:

| Case | Shape | Frames / duration | Wall | Reported generation time | Output | Status |
|---|---:|---:|---:|---:|---|---|
| MLX q8 distilled, default cadence | `448x832` | `17 / 0.708333s` | `22.59s` | `22.4s` | `/Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_q8_distilled_17f_portrait_default.mp4` | fastest short correct-shape MLX run |
| MLX q8 distilled, default cadence | `448x832` | `25 / 1.041667s` | `26.49s` | `26.3s` | `/Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_q8_distilled_25f_portrait_default.mp4` | one-second correct-shape run |
| MLX q8 distilled, default cadence | `448x832` | `233 / 9.708333s` | `193.11s` | `192.9s` | `/Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_q8_distilled_233f_portrait_default.mp4` | clears full target, research-only until quality accepted |

Full 233-frame stage timing:

- Text encoder load/cache check: `2.0s`.
- Prompt encode: `1.4s`.
- Distilled transformer load: `0.9s`.
- Stage 1 denoise: ~`46.9s` (`8` steps, ~`5.86s/it`).
- Stage 2 denoise: ~`108.7s` (`3` steps, ~`36.23s/it`).
- Decode + audio mux: `30.4s`.
- End-to-end wall: `193.11s`.

Comparison against current Comfy:

| Run | Duration | Wall |
|---|---:|---:|
| Original Comfy full | `9.708333s` | `697.36s` |
| Current best Comfy full | `9.708333s` | `481.02s` |
| Half-target threshold | `9.708333s` | `<240.51s` |
| MLX q8 distilled full | `9.708333s` | `193.11s` |

Verified output metadata:

- Full MLX output: `448x832`, `24 fps`, `233` video frames, audio stream present, duration `9.708333s`, file size `3,426,026` bytes.
- Full output SHA-256: `8b41cbaf4e9d1df785eebab7e9bbaedb813116547ad647366d94e58070b44346`.
- 17-frame default SHA-256: `24363a1785c93b819f7f31ef1fa5a486064d832090bf5313f77a22f3dbb0b65b`.
- Thumbnail sanity frame:
  - `/Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_q8_distilled_17f_portrait_frame.png`
  - The frame is nonblank, portrait, photorealistic, and preserves the user reference composition well enough for a speed spike.
  - This is not a full visual/temporal quality acceptance test.

MLX cadence and residency probes:

| Probe | Shape | Frames | Wall | Hash vs default | Status |
|---|---:|---:|---:|---|---|
| `LTX2_DIT_EVAL_EVERY=16` | `448x832` | `17` | `27.12s` | identical | Reject, slower |
| `LTX2_DIT_EVAL_EVERY=4` | `448x832` | `17` | `24.94s` | identical | Reject, slower |
| `LTX2_DIT_EVAL_EVERY=0` | `832x448` | `25` | `33.31s` | identical to wrong-shape default | Reject, slower |
| `LTX2_GEMMA_EVAL_EVERY=0` | `448x832` | `17` | `23.62s` | identical | Reject, slower |
| Resident Python process, `low_memory=False` | `448x832` | `25` | warm `42.304s`, timed `33.523s` | different seed | Reject; keeping Gemma/DiT/decoders resident caused slower denoise, likely Metal heap pressure |

Decision:

- Keep MLX default eval cadence (`LTX2_DIT_EVAL_EVERY=8`, `LTX2_GEMMA_EVAL_EVERY=1`).
- Keep `low_memory=True` for this q8 distilled CLI/runtime path even on the M5 Max; it is faster than retaining all components resident.
- The MLX q8 distilled path is the first measured route below half of the current best full Comfy time.
- It should be implemented as an Apple Silicon-only lane if quality acceptance passes.
- Windows and non-MLX systems must continue through the existing Comfy/Windows path.

Remaining blockers before replacing the current Comfy LTX lane:

- Quality/semantic equivalence is unconfirmed:
  - Model differs from current checkpoint: MLXBits q8 is `TenStrip/LTX2.3-10Eros v1.2`; current Comfy checkpoint is `10Eros_v1-fp8mixed_learned.safetensors`.
  - Runtime differs: MLX distilled pipeline vs current Comfy graph with `LTXLatentAnchorAware`, `LTXTextAttentionAmplifier`, and custom two-sampler wiring.
  - q8 quantization is not identical to the fp8mixed/PyTorch path.
- Need side-by-side visual/temporal review against the existing Comfy full output with the same reference image and prompt.
- Need decide whether to:
  - accept MLX q8 distilled as "quality-equivalent enough" for Apple Silicon speed mode, or
  - pursue exact MLX conversion of the current fp8mixed checkpoint / exact bf16 10Eros source first.

### Exact / Closer MLX Conversion Spike

HF source inventory:

- `TenStrip/LTX2.3-10Eros` contains:
  - `10Eros_v1_bf16.safetensors`: `42.97 GiB`.
  - `10Eros_v1-fp8mixed_learned.safetensors`: `27.16 GiB` (current Comfy file).
  - `10Eros_v1.2_bf16.safetensors`: `42.97 GiB`.
  - `10Eros_v1.2_fp8mixed_learned.safetensors`: `31.97 GiB`.
  - `10Eros_v1.3_bf16.safetensors`: `42.97 GiB`.
  - `10Eros_v1.3_fp8mixed_learned.safetensors`: `27.16 GiB`.
  - `10Eros_v1.4_bf16.safetensors`: `42.97 GiB`.
  - `10Eros_v1.4_fp8mixed_learned.safetensors`: `27.16 GiB`.
- `TenStrip/LTX2.3_Distilled_Lora_1.1_Experiments` contains the current Comfy LoRA:
  - `ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors`: `0.62 GiB`.
- `Lightricks/LTX-2.3` contains official bf16 dev/distilled checkpoints and official rank-384 distilled LoRAs.
- `Kijai/LTX2.3_comfy` contains transformer-only fp8/int8/bf16 variants, audio/video VAE files, and Comfy assets.

Local exact-current fp8mixed finding:

- The current local checkpoint's FP8 layers are real `F8_E4M3` safetensors tensors, not bf16 tensors with only metadata.
- Sample:
  - `model.diffusion_model.transformer_blocks.10.attn1.to_q.weight`: shape `(4096, 4096)`, dtype `F8_E4M3`.
  - `model.diffusion_model.transformer_blocks.0.attn1.to_q.weight`: shape `(4096, 4096)`, dtype `BF16`.
- Direct `mlx-forge` conversion from the fp8mixed file remains unsafe/unconfirmed because `ltx-2-mlx` expects MLX q4/q8 quantization metadata or normal floating tensors, not Comfy's fp8mixed learned tensor/scale scheme.

Exact v1 bf16 route:

- Started download:

```text
repo: TenStrip/LTX2.3-10Eros
file: 10Eros_v1_bf16.safetensors
target: /Users/liam/comfy/mlx-models/source/10Eros_v1_bf16.safetensors
```

- No HF token was available:
  - `HF_TOKEN=absent`
  - `HUGGING_FACE_HUB_TOKEN=absent`
  - `HUGGINGFACE_HUB_TOKEN=absent`
- Download is therefore unauthenticated and may be slow/rate-limited.

Local assets for conversion:

- Existing source upscaler:

```text
/Users/liam/comfy/ComfyUI/models/latent_upscale_models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors
```

- Existing current Comfy LoRA:

```text
/Users/liam/comfy/ComfyUI/models/loras/ltx/2.3/ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors
```

`mlx-forge` setup:

- Cloned `dgrauet/mlx-forge` to `/tmp/mlx-forge-opt`.
- Ran `uv sync --no-dev` successfully; isolated converter env is ready.
- Dry-run command:

```bash
cd /tmp/mlx-forge-opt
uv run mlx-forge convert ltx-2.3 \
  --checkpoint /Users/liam/comfy/mlx-models/source/10Eros_v1_bf16.safetensors \
  --variant dev \
  --output /Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1-mlx-q8-dev \
  --quantize --bits 8 \
  --spatial-upscaler x2 \
  --spatial-upscaler-checkpoint /Users/liam/comfy/ComfyUI/models/latent_upscale_models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors \
  --temporal-upscaler \
  --lora \
  --dry-run
```

- Dry-run result:
  - Variant: `dev`.
  - Output directory: `/Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1-mlx-q8-dev`.
  - Output shared components: connector, VAE decoder/encoder, audio VAE, vocoder.
  - Output transformer: `transformer-dev.safetensors`, q8, ~`22.0 GiB`.
  - Output x2 spatial upscaler: ~`1.0 GiB`.
  - Quantization: int8, group size `64`, transformer-block Linear weights only.
  - Estimated output size: ~`23.9 GiB`.

Planned exact-ish benchmark after download/conversion:

1. Convert `10Eros_v1_bf16.safetensors` to MLX q8 dev.
2. Copy or point `ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors` into the converted model dir if `ltx-2-mlx --two-stage` requires model-relative LoRA resolution.
3. Run a short `--two-stage` I2V benchmark at `448x832`, `17` frames, same prompt/reference.
4. If short is promising and quality looks close, run full `233` frames.
5. Compare against:
   - Comfy full current best: `481.02s`.
   - MLX q8 distilled full: `193.11s`.

Risks:

- q8 conversion is still quantization and may not be visually identical to bf16/fp8mixed Comfy.
- `--two-stage` dev+CFG is much slower than distilled; it may not clear `<240.51s`.
- Current Comfy custom nodes (`LTXLatentAnchorAware`, `LTXTextAttentionAmplifier`) still do not map one-to-one into `ltx-2-mlx`.

## 2026-07-08 Continuation: Exact-v1 MLX Route Completed

### Source Download

Status: completed.

- First HF/Xet path stalled around `2.4 GiB`, so the retry used:

```bash
HF_HUB_DISABLE_XET=1
```

- Source file:

```text
/Users/liam/comfy/mlx-models/source/10Eros_v1_bf16.safetensors
```

- Download wall time after retry: `2026.45s` (`33m 46s`).
- Size: `42.97 GiB`.
- SHA-256:

```text
b4b3498eeafa4d52fab5222776e4fe8821787d11fff39de867b919c83e916d35
```

Finding:

- This is the closest available non-fp8 source for the current Comfy `10Eros_v1` checkpoint family.
- The local current Comfy fp8mixed checkpoint remains unsafe for direct MLX conversion because it stores real `F8_E4M3` tensors in some transformer layers, not normal bf16 tensors.

### Conversion

Status: completed.

Command:

```bash
cd /tmp/mlx-forge-opt
uv run mlx-forge convert ltx-2.3 \
  --checkpoint /Users/liam/comfy/mlx-models/source/10Eros_v1_bf16.safetensors \
  --variant dev \
  --output /Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1-mlx-q8-dev \
  --quantize --bits 8 \
  --spatial-upscaler x2 \
  --spatial-upscaler-checkpoint /Users/liam/comfy/ComfyUI/models/latent_upscale_models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors \
  --temporal-upscaler \
  --lora
```

Result:

- Conversion wall time: `26.71s`.
- Output directory:

```text
/Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1-mlx-q8-dev
```

- Output size: `28 GiB`.
- Transformer: `transformer-dev.safetensors`, q8, `19.6 GiB`.
- Shared components present: connector, VAE encoder/decoder, audio VAE, vocoder, spatial upscaler.

Follow-up setup:

- Copied current Comfy condsafe distilled LoRA into the converted model dir:

```text
/Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1-mlx-q8-dev/ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors
```

### Benchmark: Exact-v1 q8 Dev + Condsafe LoRA, MLX Two-stage

Status: rejected for speed.

Command shape:

```bash
cd /tmp/ltx-2-mlx-opt
uv run ltx-2-mlx generate \
  --two-stage \
  --model /Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1-mlx-q8-dev \
  --image /Users/liam/Downloads/e39e3b884e724eb8bb19e6176a408f42.png \
  -H 832 -W 480 \
  -f 17 \
  --frame-rate 24 \
  --distilled-lora ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors \
  --distilled-lora-strength 1.0
```

Result:

- Output:

```text
/Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_v1_q8_dev_twostage_condsafe_17f_portrait_default.mp4
```

- Wall time: `163.25s`.
- Reported generation time: `163.1s`.
- Metadata: `448x832`, `24 fps`, `17` frames, `0.708333s`, audio present.
- File size: `196,129 bytes`.
- SHA-256:

```text
ec6de86b4947bbb5b4a01c38e4f134cf78ccd8d70308cbac8d91faf29eaacb28
```

Stage timing:

- Stage 1 guided dev denoise: ~`137s` for `30` steps; iterations progressively slowed.
- Stage 2 LoRA-refine denoise: ~`15s`.
- Decode/audio/mux: ~`2.7s`.

Verdict:

- Reject as an optimization path.
- It is semantically closer to current Comfy than MLXBits q8 distilled, but it is already slower than the current Comfy short benchmark (`86.78s`) for the same `17` frames.
- A full `233`-frame run would not plausibly clear the `<240.51s` no-quality-loss target.
- This confirmed that the Apple Silicon win comes from the distilled fast lane, not merely from MLX replacing PyTorch MPS.

### Deep Research Notes

Confirmed from primary project docs/issues:

- `dgrauet/ltx-2-mlx` explicitly targets Apple Silicon/Metal, supports image-to-video, distilled generation, two-stage generation, q8/q4 weights, and block streaming. It documents `--distilled` as the fastest route and gives `LTX2_DIT_EVAL_EVERY` / `LTX2_GEMMA_EVAL_EVERY` as the major Metal command-buffer throughput knobs.
- `dgrauet/ltx-2-mlx` also documents the frame-count constraint as `8k + 1`; our benchmark choices of `17`, `25`, and `233` obey that constraint.
- ComfyUI discussion `#14093` says LTX 2.3 is a 22B DiT and that PyTorch MPS on Mac can take several to tens of minutes for short clips; it specifically recommends distilled/quantized variants and low-base-resolution-plus-upscale for performance.
- PyTorch issue `#141471` recorded an LTXVideo MPS regression after PyTorch `2.4.1`, including both incorrect output and ~`40%` slower iteration time in the reporter's environment. Our environment is PyTorch `2.11.0`, so this exact version rollback is not directly applicable without a high-risk dependency lane, but it reinforces that MPS/PyTorch runtime behavior is a real bottleneck.
- Wan2GP advertises LTX-2 support, but its companion `mmgp` optimizer is framed around CUDA/VRAM profiles, async CPU<->GPU transfers, slicing, and Linux/Windows PyTorch/Triton compilation. Those ideas are useful conceptually, but not directly portable to Apple MLX/MPS with no quality loss.

Source URLs checked:

- https://github.com/dgrauet/ltx-2-mlx
- https://github.com/dgrauet/mlx-forge
- https://github.com/deepbeepmeep/Wan2GP
- https://github.com/deepbeepmeep/mmgp
- https://github.com/Comfy-Org/ComfyUI/discussions/14093
- https://github.com/pytorch/pytorch/issues/141471

### Next Novel Attempt: Pre-fused Exact-v1 LoRA Distilled Lane

Hypothesis:

- The fast MLXBits q8 distilled path works because it uses a pre-distilled transformer and the `--distilled` pipeline, avoiding the slow dev+CFG stage.
- The exact-v1 q8 dev+runtime-LoRA path is too slow because `--two-stage` still performs the slow guided dev sampler.
- If we safely pre-fuse the current condsafe distilled LoRA into the exact-v1 q8 dev transformer and save a transformer that the MLX `--distilled` pipeline can load, we may get closer current-model semantics while using the fast distilled sampler.

Constraints:

- Do not overwrite the working q8 dev conversion.
- Fusion must preserve MLX q8 quantization metadata where possible.
- If fusion creates a dequantized/bf16 transformer, reject it before benchmarking because it would increase memory pressure and likely slow down.
- This still may not be "no quality loss"; it is an experiment to reduce the semantic gap before any replacement decision.

Investigation target:

- Inspect `ltx_core_mlx.loader.fuse_loras.apply_loras`.
- Confirm whether it dequantizes, adds LoRA delta, and re-quantizes q8 weights.
- Confirm key remapping for Comfy LoRA via `ltx_core_mlx.loader.sd_ops`.
- If safe, create a separate model dir, generate `transformer-distilled-1.1.safetensors` from the fused q8 state, then benchmark `--distilled` at `17` frames before any full run.

### Attempt: Pre-fuse Exact-v1 q8 Dev + Condsafe LoRA, Then Use MLX `--distilled`

Status: rejected for full-length speed.

Confirmed from code inspection:

- `ltx_core_mlx.loader.fuse_loras.apply_loras` supports q4/q8 MLX weights.
- For quantized weights it:
  - dequantizes the q8 weight,
  - adds `B @ A * strength`,
  - re-quantizes with the original group size / bit width.
- `ltx_core_mlx.loader.sd_ops.LTXV_LORA_COMFY_RENAMING_MAP` handles the current Comfy LoRA key format.
- `DistilledPipeline` loads any `transformer-distilled*.safetensors` file through the same q8 quantized loader as the known-fast MLXBits path.

Created separate model dir:

```text
/Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1-condsafe-distilled-q8-prefused
```

Notes:

- Shared components are symlinked to:

```text
/Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1-mlx-q8-dev
```

- New fused transformer:

```text
/Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1-condsafe-distilled-q8-prefused/transformer-distilled-condsafe.safetensors
```

- Fused transformer SHA-256:

```text
770bef0a0ac3fc5ae9304db5ed87520b419fd029f5fa771d501db4a793141d33
```

Fusion result:

- Source transformer keys: `7450`.
- LoRA keys after remapping: `3320`.
- Matched LoRA weight keys: `1660`.
- Quantized matched keys: `1632`.
- Fused q8 metadata preserved:
  - `.scales`: `1632`.
  - `.biases`: `1632`.
- Output file size: `21,747,120,813 bytes`.
- Quirk: `mx.save_safetensors()` appended `.safetensors` to the temp filename because the temp path did not end with `.safetensors`; final rename fixed this.

Short benchmark:

```bash
cd /tmp/ltx-2-mlx-opt
/usr/bin/time -p uv run ltx-2-mlx generate \
  --distilled \
  --model /Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1-condsafe-distilled-q8-prefused \
  --prompt 'photorealistic close-up selfie video of an adult woman, black bob haircut, warm smile, looking into the camera, soft sunlight stripes across face and shoulders, natural blinking, subtle head movement, lips softly singing along to the audio, realistic skin texture, handheld phone camera, smooth natural motion, high quality, realistic lighting' \
  --image /Users/liam/Downloads/e39e3b884e724eb8bb19e6176a408f42.png \
  -H 832 -W 480 \
  -f 17 \
  --frame-rate 24 \
  --seed 42 \
  -o /Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_v1_prefused_condsafe_q8_distilled_17f_portrait_default.mp4
```

Result:

- Wall time: `18.08s`.
- Reported generation time: `17.9s`.
- Metadata: `448x832`, `24 fps`, `17` frames, `0.708333s`, audio present.
- Output:

```text
/Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_v1_prefused_condsafe_q8_distilled_17f_portrait_default.mp4
```

- Output SHA-256:

```text
3d1c8910b0c84753b431555d33ad8e5e614714504ccfd7de898fd24fcec4c7ba
```

- Frame sanity thumbnail:

```text
/tmp/mlx_10eros_v1_prefused_condsafe_q8_distilled_17f_frame.png
```

- Visual sanity result: nonblank, portrait, photorealistic, reference composition preserved.

Full benchmark:

```bash
cd /tmp/ltx-2-mlx-opt
/usr/bin/time -p uv run ltx-2-mlx generate \
  --distilled \
  --model /Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1-condsafe-distilled-q8-prefused \
  --prompt 'photorealistic close-up selfie video of an adult woman, black bob haircut, warm smile, looking into the camera, soft sunlight stripes across face and shoulders, natural blinking, subtle head movement, lips softly singing along to the audio, realistic skin texture, handheld phone camera, smooth natural motion, high quality, realistic lighting' \
  --image /Users/liam/Downloads/e39e3b884e724eb8bb19e6176a408f42.png \
  -H 832 -W 480 \
  -f 233 \
  --frame-rate 24 \
  --seed 42 \
  -o /Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_v1_prefused_condsafe_q8_distilled_233f_portrait_default.mp4
```

Result:

- Wall time: `327.19s`.
- Reported generation time: `326.9s`.
- Metadata: `448x832`, `24 fps`, `233` frames, `9.708333s`, audio present.
- Output:

```text
/Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_v1_prefused_condsafe_q8_distilled_233f_portrait_default.mp4
```

- Output SHA-256:

```text
6c2a3a8a69874096272c5b170b8b8656493652c02315094f3e610b0bd8373d67
```

Stage timing:

- Text encoder load: `2.2s`.
- Prompt encode: `2.1s`.
- Fused transformer load: `1.0s`.
- Stage 1 denoise: ~`118.6s` (`8` steps, ~`14.83s/it`).
- Stage 2 denoise: ~`163.4s` (`3` steps, ~`54.45s/it`).
- Decode/audio/mux: `35.8s`.

Verdict:

- Reject as full-length optimization.
- The 17-frame benchmark was misleadingly fast (`18.08s`) and beat the prior MLXBits q8 distilled short run (`22.59s`).
- The 233-frame benchmark failed the half-target:
  - current best Comfy full: `481.02s`;
  - half target: `<240.51s`;
  - pre-fused exact-v1 q8 full: `327.19s`.
- This is still faster than current Comfy (`481.02s -> 327.19s`, `1.47x`), but not enough and not better than the MLXBits q8 distilled full (`193.11s`).

Finding:

- Pre-fusing LoRA preserves q8 metadata and makes the fast `--distilled` pipeline load, but it does not reproduce the speed characteristics of a true distilled checkpoint at full length.
- Likely reason: this is still dev-family exact-v1 weights with a fused LoRA approximation, not a true distilled transformer trained/converted as `transformer-distilled` / `transformer-distilled-1.1`.
- Do not repeat this path unless a new true distilled exact-v1 source checkpoint is found.

### Converter Finding: Do Not Relabel Exact Dev as Distilled

Status: rejected without running.

`mlx-forge` supports `--variant distilled`, `--variant distilled-1.1`, and `--variant dev`, but when a local `--checkpoint` is supplied, the converter uses that same checkpoint for whichever variant name is requested. It does not locally train, distill, or apply a distillation transform.

Confirmed behavior:

- `_convert_variant()` uses `args.checkpoint` directly when provided.
- Without `args.checkpoint`, it downloads `ltx-2.3-22b-{variant}.safetensors` from `Lightricks/LTX-2.3`.
- Variant choice controls output filename, not checkpoint semantics.
- `extract_config()` detects cross-attention AdaLN from the actual weights; the exact `10Eros_v1_bf16.safetensors` source is dev-style.

Verdict:

- Converting `10Eros_v1_bf16.safetensors` as `--variant distilled` would only mislabel dev-family weights as `transformer-distilled.safetensors`.
- This would likely recreate the rejected pre-fused behavior or produce a semantically invalid model.
- Do not run this as an optimization attempt.

### Attempt: MLXBits q8 Distilled `--low-ram` Screening

Status: rejected after same-cache A/B.

Reason for trying:

- `ltx-2-mlx` documents `--low-ram` block streaming as a memory-pressure tool.
- The full pre-fused run showed long-run stage 2 heap pressure can dominate, so this was worth screening even though docs imply it is usually slower.
- This keeps model, resolution, frame count, sampler, and steps unchanged; expected quality should be the same aside from runtime implementation details.

Short `--low-ram` run:

```bash
cd /tmp/ltx-2-mlx-opt
/usr/bin/time -p uv run ltx-2-mlx generate \
  --distilled \
  --low-ram \
  --model /Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1.2-mlx-q8-distilled-subset \
  --prompt 'photorealistic close-up selfie video of an adult woman, black bob haircut, warm smile, looking into the camera, soft sunlight stripes across face and shoulders, natural blinking, subtle head movement, lips softly singing along to the audio, realistic skin texture, handheld phone camera, smooth natural motion, high quality, realistic lighting' \
  --image /Users/liam/Downloads/e39e3b884e724eb8bb19e6176a408f42.png \
  -H 832 -W 480 \
  -f 17 \
  --frame-rate 24 \
  --seed 42 \
  -o /Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_q8_distilled_lowram_17f_portrait_default.mp4
```

Result:

- Wall time: `19.52s`.
- Reported generation time: `19.3s`.
- Stage 1 denoise: ~`7.3s`.
- Stage 2 denoise: ~`5.1s`.
- Decode/audio/mux: `1.7s`.

Same-cache non-`--low-ram` control:

```bash
cd /tmp/ltx-2-mlx-opt
/usr/bin/time -p uv run ltx-2-mlx generate \
  --distilled \
  --model /Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1.2-mlx-q8-distilled-subset \
  --prompt 'photorealistic close-up selfie video of an adult woman, black bob haircut, warm smile, looking into the camera, soft sunlight stripes across face and shoulders, natural blinking, subtle head movement, lips softly singing along to the audio, realistic skin texture, handheld phone camera, smooth natural motion, high quality, realistic lighting' \
  --image /Users/liam/Downloads/e39e3b884e724eb8bb19e6176a408f42.png \
  -H 832 -W 480 \
  -f 17 \
  --frame-rate 24 \
  --seed 42 \
  -o /Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_q8_distilled_current_control_17f_portrait_default.mp4
```

Result:

- Wall time: `16.77s`.
- Reported generation time: `16.6s`.
- Stage 1 denoise: ~`4.5s`.
- Stage 2 denoise: ~`4.95s`.
- Decode/audio/mux: `1.7s`.

Verdict:

- Reject `--low-ram` for this M5 Max / 128GB profile.
- The apparent improvement versus the older `22.59s` short run was cache/warmth, not streaming.
- Keep non-streaming q8 distilled as the fastest screened MLX path on this machine.

### Attempt: Pre-MLX Comfy `/free` Cleanup

Status: keep as operational hygiene for MLX lane; not a new all-time best.

Reason for trying:

- A same-cache full rerun of the MLXBits q8 distilled path unexpectedly slowed to `273.23s`, despite a very fast current short control.
- Three Comfy servers were resident (`8188`, `8198`, `8199`) and may have retained MPS/Metal heap allocations even while idle.
- Cleanup is quality-neutral if done before a separate MLX generation: it unloads idle Comfy models and frees memory, but does not change model weights, prompt, steps, sampler, resolution, or output settings.

Cleanup commands:

```bash
curl -s -X POST http://127.0.0.1:8188/free \
  -H 'Content-Type: application/json' \
  -d '{"unload_models":true,"free_memory":true}'

curl -s -X POST http://127.0.0.1:8198/free \
  -H 'Content-Type: application/json' \
  -d '{"unload_models":true,"free_memory":true}'

curl -s -X POST http://127.0.0.1:8199/free \
  -H 'Content-Type: application/json' \
  -d '{"unload_models":true,"free_memory":true}'
```

System memory after cleanup:

- `memory_pressure`: system-wide free percentage `94%`.
- LTX Comfy lane stayed healthy:
  - `http://127.0.0.1:8199/system_stats` returned ComfyUI `0.26.0`.
  - argv still included `--use-quad-cross-attention`, `--gpu-only`, and the private output/input/temp directories.
  - MPS reported `110.97 GiB` free.

Same-command full run after cleanup:

```bash
cd /tmp/ltx-2-mlx-opt
/usr/bin/time -p uv run ltx-2-mlx generate \
  --distilled \
  --model /Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1.2-mlx-q8-distilled-subset \
  --prompt 'photorealistic close-up selfie video of an adult woman, black bob haircut, warm smile, looking into the camera, soft sunlight stripes across face and shoulders, natural blinking, subtle head movement, lips softly singing along to the audio, realistic skin texture, handheld phone camera, smooth natural motion, high quality, realistic lighting' \
  --image /Users/liam/Downloads/e39e3b884e724eb8bb19e6176a408f42.png \
  -H 832 -W 480 \
  -f 233 \
  --frame-rate 24 \
  --seed 42 \
  -o /Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_q8_distilled_post_comfy_free_233f_portrait_default.mp4
```

Result:

- Wall time: `226.38s`.
- Reported generation time: `226.2s`.
- Metadata: `448x832`, `24 fps`, `233` frames, `9.708333s`, audio present.
- Output:

```text
/Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_q8_distilled_post_comfy_free_233f_portrait_default.mp4
```

- Output SHA-256:

```text
7f1fd82a182fab265d5a203dd870c5c67a2f8f285e814b5fac6cb68197852c7f
```

Important deterministic-output finding:

- The post-cleanup run hash matches the slower `273.23s` same-command rerun exactly:

```text
7f1fd82a182fab265d5a203dd870c5c67a2f8f285e814b5fac6cb68197852c7f
```

- Therefore Comfy `/free` changed performance without changing output bytes for this MLXBits q8 distilled run.

Comparison:

| Run | Wall | Output hash |
|---|---:|---|
| MLXBits q8 distilled historical best | `193.11s` | `8b41cbaf4e9d1df785eebab7e9bbaedb813116547ad647366d94e58070b44346` |
| Same-cache rerun before cleanup | `273.23s` | `7f1fd82a182fab265d5a203dd870c5c67a2f8f285e814b5fac6cb68197852c7f` |
| Same-command rerun after Comfy `/free` | `226.38s` | `7f1fd82a182fab265d5a203dd870c5c67a2f8f285e814b5fac6cb68197852c7f` |

Verdict:

- Keep as an MLX-lane preflight: call `/free` on resident Comfy endpoints before launching a heavy Apple MLX LTX job.
- This recovered `46.85s` versus the immediately preceding full rerun with byte-identical output.
- It did not beat the historical MLXBits best (`193.11s`), so the best measured full time remains `193.11s`.
- It does not solve the remaining quality-equivalence blocker for replacing current Comfy exact-v1 output.

### Attempt: Stop Managed Z-Image / Comfy Stack During MLX Full Run

Status: useful resource-isolation finding; do not make default unless the app can schedule exclusive mode safely.

Reason for trying:

- Comfy `/free` recovered a byte-identical full run from `273.23s` to `226.38s`.
- This tested whether idle Comfy processes themselves, not only loaded models, were still costing Metal/CPU/memory throughput.
- Rollback path was explicit: `zimage-stack start`, then verify `8199/system_stats` and app `/health`.

Stop command:

```bash
/Users/liam/.local/bin/zimage-stack stop
```

Stopped listeners:

- `8188`
- `8199`
- `8198`
- `8787`
- `8788`
- `8789`

Isolated benchmark:

```bash
cd /tmp/ltx-2-mlx-opt
/usr/bin/time -p uv run ltx-2-mlx generate \
  --distilled \
  --model /Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1.2-mlx-q8-distilled-subset \
  --prompt 'photorealistic close-up selfie video of an adult woman, black bob haircut, warm smile, looking into the camera, soft sunlight stripes across face and shoulders, natural blinking, subtle head movement, lips softly singing along to the audio, realistic skin texture, handheld phone camera, smooth natural motion, high quality, realistic lighting' \
  --image /Users/liam/Downloads/e39e3b884e724eb8bb19e6176a408f42.png \
  -H 832 -W 480 \
  -f 233 \
  --frame-rate 24 \
  --seed 42 \
  -o /Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_q8_distilled_stack_stopped_233f_portrait_default.mp4
```

Result:

- Wall time: `209.44s`.
- Reported generation time: `209.2s`.
- Metadata: `448x832`, `24 fps`, `233` frames, `9.708333s`, audio present.
- Output:

```text
/Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_q8_distilled_stack_stopped_233f_portrait_default.mp4
```

- Output SHA-256:

```text
7f1fd82a182fab265d5a203dd870c5c67a2f8f285e814b5fac6cb68197852c7f
```

Stage timing:

- Text encoder load: `2.0s`.
- Prompt encode: `1.1s`.
- Transformer load: `0.8s`.
- Stage 1 denoise: ~`36.6s` (`8` steps, ~`4.57s/it`).
- Stage 2 denoise: ~`133.1s` (`3` steps, ~`44.35s/it`).
- Decode/audio/mux: `33.2s`.

Comparison:

| Run | Wall | Output hash |
|---|---:|---|
| Same-cache rerun before cleanup | `273.23s` | `7f1fd82a182fab265d5a203dd870c5c67a2f8f285e814b5fac6cb68197852c7f` |
| After Comfy `/free` | `226.38s` | `7f1fd82a182fab265d5a203dd870c5c67a2f8f285e814b5fac6cb68197852c7f` |
| Stack stopped | `209.44s` | `7f1fd82a182fab265d5a203dd870c5c67a2f8f285e814b5fac6cb68197852c7f` |
| Historical MLXBits best | `193.11s` | `8b41cbaf4e9d1df785eebab7e9bbaedb813116547ad647366d94e58070b44346` |

Finding:

- Stopping the managed stack improved the same output hash by another `16.94s` versus `/free` alone, and by `63.79s` versus the dirty same-cache rerun.
- This confirms that resident Comfy/app workers materially affect heavy MLX video throughput on Apple Silicon even after model unload.
- The output bytes were unchanged relative to the `273.23s` and `226.38s` reruns, so the isolation improved runtime without changing generated media for this seed/model/prompt.
- It still did not beat the historical `193.11s` best, so the best measured full time remains `193.11s`.

Rollback verification:

```bash
/Users/liam/.local/bin/zimage-stack start
curl -s http://127.0.0.1:8199/system_stats
curl -s http://127.0.0.1:8788/health
```

Verified after restart:

- LaunchAgent state: `running`.
- LTX lane `8199` healthy.
- LTX argv includes `--use-quad-cross-attention`, `--gpu-only`, private output/input/temp dirs, and `--disable-metadata`.
- App health returned:

```json
{
  "ok": true,
  "comfy": "/Users/liam/comfy/ComfyUI",
  "runner": true,
  "ui": "v2"
}
```

Operational recommendation:

- For an Apple MLX LTX job that is explicitly prioritized for speed, implement an exclusive-mode preflight:
  - pause or stop managed Comfy/app workers,
  - run MLX generation,
  - restart and health-check the stack.
- Only do this when the UI can show the temporary outage or schedule it; otherwise use the lighter `/free` preflight.

### Attempt: Correct-shape MLX `LTX2_DIT_EVAL_EVERY=0`

Status: rejected.

Reason for trying:

- Earlier `LTX2_DIT_EVAL_EVERY=0` was only measured on an invalid landscape smoke run.
- `ltx-2-mlx` documents this as a throughput knob for Macs that can tolerate larger Metal command buffers.
- This should be output-equivalent if it completes, so it is a quality-neutral candidate.

Command:

```bash
cd /tmp/ltx-2-mlx-opt
/usr/bin/time -p env LTX2_DIT_EVAL_EVERY=0 uv run ltx-2-mlx generate \
  --distilled \
  --model /Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1.2-mlx-q8-distilled-subset \
  --prompt 'photorealistic close-up selfie video of an adult woman, black bob haircut, warm smile, looking into the camera, soft sunlight stripes across face and shoulders, natural blinking, subtle head movement, lips softly singing along to the audio, realistic skin texture, handheld phone camera, smooth natural motion, high quality, realistic lighting' \
  --image /Users/liam/Downloads/e39e3b884e724eb8bb19e6176a408f42.png \
  -H 832 -W 480 \
  -f 17 \
  --frame-rate 24 \
  --seed 42 \
  -o /Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_q8_distilled_dit0_17f_portrait_default.mp4
```

Result:

- Wall time: `16.93s`.
- Reported generation time: `16.7s`.
- Same-cache default control: `16.77s`.
- Output hash matched the default control exactly:

```text
9403a6ca8a4462c0877cd7a3b4e6c75739dbcdb8b243407ad366f0a9a46ceed6
```

Verdict:

- Reject. It is byte-identical but slightly slower than default eval cadence on the correct portrait short benchmark.
- Keep default `LTX2_DIT_EVAL_EVERY=8`.

### Attempt: Exact-v1 Merge-before-Quantize Distilled Model

Status: rejected for the strict speed target, but important quality-gap research result.

Reason for trying:

- Deep search found the key MLXBits provenance clue: their fast q8 model was produced by merging the condsafe LoRA into a bf16 10Eros base first, then converting/quantizing.
- Our previous exact-v1 pre-fused attempt merged into an already-q8 dev transformer, which preserved q8 metadata but did not reproduce the true merge-before-quantize route.
- This attempt applies the LoRA delta to `10Eros_v1_bf16.safetensors` before conversion, then writes a real `transformer-distilled.safetensors` q8 file.

Source inputs:

```text
/Users/liam/comfy/mlx-models/source/10Eros_v1_bf16.safetensors
/Users/liam/comfy/ComfyUI/models/loras/ltx/2.3/ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors
```

Output model dir:

```text
/Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1-bf16-lora-merged-q8-distilled
```

Build details:

- Used `mlx_forge` conversion primitives instead of hand-rolled tensor layout.
- Merged LoRA in original bf16 checkpoint key space:
  - base keys: `5947`;
  - LoRA keys: `3320`;
  - matched LoRA weight keys: `1660`;
  - shape mismatches: `0`.
- Converted only the merged transformer into MLX split format.
- Symlinked shared components from the existing exact-v1 q8 dev conversion.
- Wrote `config.json` with `variants.distilled.cross_attention_adaln = true`.
- Quantized the merged transformer to q8:
  - quantized keys: `1632/1632`;
  - final transformer keys: `7450`;
  - final transformer size: `20,587,728,079 bytes`.
- Build wall time: `42.77s`.
- Transformer SHA-256:

```text
eceea102644a5849d5a52725699c673ed54134cee5dd77b2a5e491cc36bf2f81
```

Validation:

```bash
cd /tmp/mlx-forge-opt
uv run mlx-forge validate ltx-2.3 \
  /Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1-bf16-lora-merged-q8-distilled
```

Result:

- All checks passed.
- Quantized int8.
- `48` transformer blocks.
- `1632` `.scales` keys and `1632` `.biases` keys.
- Quantization only in transformer blocks.
- Connector, VAE decoder/encoder, audio VAE, vocoder, and x2 spatial upscaler validated.

Short benchmark:

```bash
cd /tmp/ltx-2-mlx-opt
/usr/bin/time -p uv run ltx-2-mlx generate \
  --distilled \
  --model /Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1-bf16-lora-merged-q8-distilled \
  --prompt 'photorealistic close-up selfie video of an adult woman, black bob haircut, warm smile, looking into the camera, soft sunlight stripes across face and shoulders, natural blinking, subtle head movement, lips softly singing along to the audio, realistic skin texture, handheld phone camera, smooth natural motion, high quality, realistic lighting' \
  --image /Users/liam/Downloads/e39e3b884e724eb8bb19e6176a408f42.png \
  -H 832 -W 480 \
  -f 17 \
  --frame-rate 24 \
  --seed 42 \
  -o /Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_v1_bf16_lora_merged_q8_distilled_17f_portrait_default.mp4
```

Result:

- Wall time: `17.32s`.
- Reported generation time: `17.1s`.
- Metadata: `448x832`, `24 fps`, `17` frames, `0.708333s`, audio present.
- Output SHA-256:

```text
e63b1edf59e6324a6c351df6842d31b50274ac0c9346c66fd4091b62f9d088a9
```

- Frame sanity thumbnail:

```text
/tmp/mlx_10eros_v1_bf16_lora_merged_q8_distilled_17f_frame.png
```

- Visual sanity result: nonblank, portrait, photorealistic, reference composition preserved.

Full benchmark under exclusive stack-stopped mode:

```bash
/Users/liam/.local/bin/zimage-stack stop

cd /tmp/ltx-2-mlx-opt
/usr/bin/time -p uv run ltx-2-mlx generate \
  --distilled \
  --model /Users/liam/comfy/mlx-models/ltx-2.3-10eros-v1-bf16-lora-merged-q8-distilled \
  --prompt 'photorealistic close-up selfie video of an adult woman, black bob haircut, warm smile, looking into the camera, soft sunlight stripes across face and shoulders, natural blinking, subtle head movement, lips softly singing along to the audio, realistic skin texture, handheld phone camera, smooth natural motion, high quality, realistic lighting' \
  --image /Users/liam/Downloads/e39e3b884e724eb8bb19e6176a408f42.png \
  -H 832 -W 480 \
  -f 233 \
  --frame-rate 24 \
  --seed 42 \
  -o /Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_v1_bf16_lora_merged_q8_distilled_stack_stopped_233f_portrait_default.mp4

/Users/liam/.local/bin/zimage-stack start
```

Result:

- Wall time: `247.44s`.
- Reported generation time: `247.2s`.
- Metadata: `448x832`, `24 fps`, `233` frames, `9.708333s`, audio present.
- Output:

```text
/Users/liam/.comfy-private.noindex/output/Eros/mlx_10eros_v1_bf16_lora_merged_q8_distilled_stack_stopped_233f_portrait_default.mp4
```

- Output SHA-256:

```text
7f324008be7028a6bd75dc0ef360d719057e2bc17edaa003eb36e8b9029e6bba
```

Stage timing:

- Text encoder load: `2.0s`.
- Prompt encode: `2.1s`.
- Transformer load: `1.0s`.
- Stage 1 denoise: ~`67.3s` (`8` steps, ~`8.41s/it`).
- Stage 2 denoise: ~`139.6s` (`3` steps, ~`46.53s/it`).
- Decode/audio/mux: `32.3s`.

Comparison:

| Run | Wall | Verdict |
|---|---:|---|
| Current best Comfy full | `481.02s` | baseline |
| Half-target threshold | `<240.51s` | target |
| Exact-v1 q8 dev + LoRA two-stage short | `163.25s` for 17f | reject early |
| Exact-v1 q8 pre-fused after quantization full | `327.19s` | reject |
| Exact-v1 bf16 LoRA merged before q8 full | `247.44s` | reject, close but over target |
| MLXBits q8 v1.2 distilled historical best | `193.11s` | fastest full, quality-gap blocker |

Finding:

- The merge-before-quantize route is technically valid and closer to the MLXBits provenance than q8 post-fusion.
- It improves exact-v1 distilled full speed versus q8 post-fusion (`327.19s -> 247.44s`, `1.32x`) and current Comfy (`481.02s -> 247.44s`, `1.94x`).
- It still misses the strict target by `6.93s`.
- The true fast route remains MLXBits v1.2 q8 distilled, but that model/version/runtime still has a quality-equivalence blocker versus the current Comfy exact-v1 workflow.

Rollback verification:

- Restarted `zimage-stack`.
- Verified app health:

```json
{
  "ok": true,
  "comfy": "/Users/liam/comfy/ComfyUI",
  "runner": true,
  "ui": "v2"
}
```

- Verified LTX lane `8199/system_stats`:
  - ComfyUI `0.26.0`;
  - PyTorch `2.11.0`;
  - argv includes `--use-quad-cross-attention`, `--gpu-only`, private output/input/temp dirs, and `--disable-metadata`.
- Disk after this attempt: `82 GiB` free on `/System/Volumes/Data`.

Do not repeat:

- Do not repeat q8 post-fusion.
- Do not repeat exact-v1 bf16 merge-before-q8 unless there is a new way to reduce full stage 2 by at least `7s` without touching quality.
- If pursuing exact-v1 further, focus specifically on full-resolution stage 2 DiT throughput and decoder scheduling, not conversion correctness.
