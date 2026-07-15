# Krea2 Apple Silicon Optimization Findings

Last updated: 2026-07-02

This document tracks Apple Silicon optimization work for the native Krea2 Red Mix MLX workflow so we do not repeat dead-end experiments. Mark claims as confirmed or inferred.

## Current Baseline

Confirmed from the native sidecar profile at 960x1440, 10 steps, no LoRA:

- Workflow: `/Users/liam/comfy/ComfyUI/user/default/workflows/Krea2 Red Mix SeedVR2 Apple Silicon.json`
- Native sampler node: `Krea2MLXRedMixSampler`
- Native sidecar: `/Users/liam/comfy/ComfyUI/custom_nodes/krea2_mlx_redmix/sidecar.py`
- MLX pipeline: `/Users/liam/comfy/krea2_alis_mlx_redmix/krea2/pipeline.py`
- Sampler implementation: `/Users/liam/comfy/krea2_alis_mlx_redmix/krea2/sampling.py`
- Transformer precision: `mxfp8-fused`
- Active fast path: fused attention, fused MLP, compiled `forward_prepared_vectors`
- Normal activation dtype: `bf16`
- Generate time: about 50-55s cold for 960x1440 / 10 steps / no LoRA under current conditions
- Stage profile: denoise is about 48.4s of about 50.6s generate; text encode is about 0.14s; VAE decode is about 1.9s

Conclusion: the bottleneck is the 28-block transformer denoise pass over the 960x1440 token grid. Text encoding, VAE decode, image save, and workflow plumbing are not the main problem.

Lightweight benchmark target added on 2026-06-30:

- Resolution: 256x384, the same 2:3 aspect ratio as 960x1440.
- Steps: 10.
- Seed: 794015397137290.
- Sampler: `flow_euler`.
- LoRA: disabled unless explicitly testing LoRA.
- Baseline long saved JSON prompt: about 6.1-6.8s warm sidecar generate under clean-ish conditions, but can drift under system load.
- The reference PNG `/Users/liam/Downloads/e39e3b884e724eb8bb19e6176a408f42.png` embeds the same base seed `794015397137290`, a separate SeedVR2 upscaler seed `3041761909`, and final size 1920x2880.
- Same seed across different resolutions is not expected to produce the same image. Krea2 samples a different latent tensor shape, different image token count, different RoPE positions, and a different timestep schedule when resolution changes.

Confirmed contention finding from 2026-06-30:

- The same native compact-prompt 960x1440 / 10-step path can swing from about 99.8s generate under active desktop/local-service contention to about 51.1s generate after isolating the Krea sidecar from an idle-hot Anima lane. The isolated run reported about 12.1s pipeline load / 51.1s generate / 63.3s total.
- Memory pressure was not the limiter in this run; system stats still showed about 81 GB free RAM. The visible pressure was competing CPU/GPU/process activity, including WindowServer, Open Generative AI GPU helper, Splashtop, and previously the Anima Comfy lane.
- Benchmark reports must include the top process-pressure snapshot, not only the sidecar fast-path report, because the fast path can be correct while wall time is still ruined by contention.
- Implemented `KREA2_MLX_FOCUS_MODE=1` in the native Comfy node. A real Comfy API run at 960x1440 / 10 steps / seed `794015397137290` / saved workflow prompt / no LoRA completed in about 58.35s wall, with sidecar timings of about 5.40s pipeline / 51.93s generate / 57.40s total. The log confirmed Anima port `8198` was paused and resumed during generation.

Confirmed AppleSilicon-FP8 supervisor finding from 2026-06-30:

- The supervised default Comfy lane was not inheriting `ASFP8_INT8_EXT=1` or `ASFP8_FP8_EXT=1`. Manual restarts on port `8188` were immediately replaced by `zimage-stack supervise`, so benchmarks that looked like ASFP8 native-kernel runs could silently be plain supervised Comfy runs.
- Patched `/Users/liam/.local/bin/zimage-stack` so the default `8188` lane starts with:
  - `ASFP8_INT8_EXT=1`
  - `ASFP8_FP8_EXT=1`
  - `ASFP8_TRACE_OPS=0`
  - `ASFP8_PROFILE=0`
- Confirmed after launch: the actual listener process env contains those flags, and `/Users/liam/.comfy-private.noindex/comfy.log` reports `[AppleSilicon-FP8/int8_kernel] INT8 convrot Linear routed through bit-exact Metal kernel on MPS`.
- Confirmed model metadata: `/Users/liam/comfy/ComfyUI/models/diffusion_models/Krea2_Turbo_convrot_int8mixed.safetensors` has `convrot: true` quantization metadata on its INT8 layers.
- Correct warm benchmark, no `/free` between runs, short prompt, `Krea2_Turbo_convrot_int8mixed.safetensors`, `qwen3vl_4b_fp8_scaled.safetensors`, `qwen_image_vae.safetensors`, Comfy `KSampler` `er_sde` / `simple`, CFG 1.0, 8 steps:
  - 256x128 cold warm-up: 9.814s wall.
  - 256x128 warm repeat: 2.270s wall.
  - 1280x640 warm run A: 24.906s wall.
  - 1280x640 warm run B: 29.429s wall.
- Confirmed correction: ASFP8 ConvRot INT8 can reproduce the author's approximately 24s 1280x640 Krea2 Turbo class result on this machine when launched through the real supervised path and benchmarked warm. Earlier slower results were invalid for the speed claim because they included cold model load and/or were run without the supervised env flags.
- Scope: this validates the Krea2 Turbo ConvRot ASFP8 route. It does not by itself solve the separate Krea2 Red Mix MLX workflow target of 960x1440 / 10 steps / preserved reference image quality.

Confirmed Krea2 RedMix ConvRot INT8 conversion artifact from 2026-07-01:

- Source: `/Users/liam/comfy/ComfyUI/models/diffusion_models/Krea2RedMix-10Steps-bf16-dequant-ComfyUI.safetensors`.
- Conversion workflow: `/Users/liam/comfy/ComfyUI/workflows/krea2_redmix_convrot_int8_save_api.json`.
- Raw INT8-Fast output: `/Users/liam/.comfy-private.noindex/output/int8_models/Krea2RedMix-10Steps_convrot_int8mixed_raw_00001_.safetensors`.
- Final native Comfy checkpoint: `/Users/liam/comfy/ComfyUI/models/diffusion_models/Krea2RedMix-10Steps_convrot_int8mixed.safetensors`.
- Final metadata sidecar: `/Users/liam/comfy/ComfyUI/models/diffusion_models/Krea2RedMix-10Steps_convrot_int8mixed.metadata.json`.
- Header validation confirmed 224 native `int8_tensorwise` ConvRot layers, 224 INT8 weights, 224 scale tensors, and 206 BF16 tensors. `UNETLoader` object info lists the final checkpoint.
- Not yet benchmarked. Do not claim it is faster than the native RedMix MLX sidecar until a clean warm benchmark is run through the supervised ASFP8 Comfy lane.

Confirmed Krea2 Turbo ConvRot INT8 prompt-conditioning speed finding from 2026-07-01:

- Target workflow: `/Users/liam/comfy/ComfyUI/user/default/workflows/Krea2 Turbo ConvRot INT8 ASFP8 Bench Apple Silicon.json`.
- The AppleSilicon-FP8 fast path was active during the slow runs: supervised `zimage-stack` launch, `ASFP8_INT8_EXT=1`, `ASFP8_FP8_EXT=1`, and the Comfy log reported the native M5 INT8 ConvRot Metal kernel.
- The optional Krea2 reference image node was set to `None`; `HermesOptionalLoadImage` returns `(None, None)` in that state and `TextEncodeKrea2` filters out `None` images, so reference-image conditioning was not the cause of the 40s-class text-only reruns.
- Root cause: the workflow was feeding the full pretty-printed Krea2 photo JSON helper output directly into `TextEncodeKrea2`. This bloats Krea2/Qwen3-VL conditioning, and Krea2 attends over that conditioning context inside every denoise step. It can make a small 528x368 / 8-step run behave like a 30-40s run even when model, LoRAs, sampler, and resolution are unchanged.
- Added `Krea2PromptCompact` in `/Users/liam/comfy/ComfyUI/custom_nodes/comfyui-prompt-assistant/__init__.py` and rewired the workflow as `PromptAssistantGenerate -> Krea2PromptCompact -> TextEncodeKrea2`.
- Initial speed fix used compact prose. Later adherence testing showed this was too destructive for Krea2 because Krea2 is trained to handle raw JSON-shaped prompts well. Current default is therefore `json_structured`: preserve the JSON object and newline/key structure. `json_minify` and `prose_compact` remain available as speed-test modes.
- Cleared a stale linked-prompt widget copy on `TextEncodeKrea2` in the saved workflow so API runners do not accidentally reuse old prompt text as `system_prompt`; the live encoder input still comes from the compact node.
- Added a second guard in `/Users/liam/comfy/ComfyUI/custom_nodes/ComfyUI-Krea2TextEncoder/nodes.py`: `TextEncodeKrea2` now defaults `auto_compact_json=True` and optimizes Krea2-photo-style JSON before tokenization. This protects old already-open browser canvases that still wire `PromptAssistantGenerate` directly into `TextEncodeKrea2`.
- Hardened the `TextEncodeKrea2` guard after mobile runs still hit 35s+ on a repeat: strict JSON-only parsing was not enough because JSON-like helper output can be malformed or wrapped. Valid JSON is now formatted as compact structured JSON by default; common missing-comma malformed JSON is repaired and then structured; unrepairable JSON-like prompts preserve braces/keys/line structure instead of falling back to prose. Logs only safe counts/mode/reference telemetry, never prompt text.
- Benchmark, no reference image, 528x368 latent, batch 1, `Krea2_Turbo_convrot_int8mixed.safetensors`, `qwen3vl_4b_bf16.safetensors`, `qwen_image_vae.safetensors`, `KSampler` `er_sde` / `simple`, 8 steps, CFG 1.0:
  - First post-restart compact run: about 13.12s wall / 12.75s Comfy prompt time.
  - Warm forced-new-seed runs to avoid graph cache: 9.09s, 9.09s, 9.09s wall; Comfy log prompt times 8.72s, 8.76s, 8.81s.
- Runtime-LoRA isolation after the `TextEncodeKrea2` guard:
  - Explicit compact node, zero active LoRAs: first run about 15.66s after restart, warm forced-denoise about 9.10s.
  - Explicit compact node, three active LoRAs: first patched-stack run about 19.20s, warm forced-denoise about 9.09s.
  - Explicit compact node, four active LoRAs: first patched-stack run about 17.77s, warm forced-denoise about 10.09s.
  - Old-style direct JSON into `TextEncodeKrea2`, four active LoRAs, no explicit compact node: first run about 20.84s, warm repeat about 9.15s. After all sibling services were back up, another warm direct-JSON/four-LoRA run was about 9.24s.
  - Malformed/wrapped JSON-like prompt directly into `TextEncodeKrea2`, four active LoRAs, after fallback compactor: first run about 21.76s wall / 21.60s Comfy prompt time, warm repeat about 9.09s wall / 8.79s Comfy prompt time. Log confirmed safe compaction telemetry: raw 4,931 chars -> compact 1,400 chars, zero references.
- Interpretation: a 17-21s small run immediately after restart or after changing/toggling LoRAs is cold-ish graph/model/LoRA patch/load overhead. It should not be compared to warm steady-state generation. Persistent 30-40s at 528x368 was the full-JSON conditioning path.
- Follow-up adherence fix: the first compact prompt was too speed-biased at 1,400 chars and could spend the budget before later `must_keep` constraints, making prompt adherence feel much worse. A 2,600-char adherence-first prose mode helped, but still rewrote the JSON structure Krea2 expects.
- 2026-07-01 JSON-preserving fix: `Krea2PromptCompact` now exposes `json_structured`, `json_minify`, `json_minify_or_prose`, and `prose_compact`; the saved workflow uses `json_structured`. `TextEncodeKrea2` exposes the same `json_prompt_mode` and defaults to `json_structured` for stale/direct canvases.
- 2026-07-01 rebalancer note: keep `AzKrea2GatedRebalance` active in the saved workflow with weights `1,1,1,1,1,1,1,1,2.5,5,1,4`, `multiplier=1.0`, `crossover=0.5`, `overlap=0.0`. Fixed the node so `multiplier=0` is a true bypass when intentionally testing, instead of zeroing early conditioning and causing glitchy output.
- 2026-07-01 JSON-mode benchmark, synthetic Krea2 JSON prompt, no reference image, no prompt-helper LLM, no retained history, 528x368 / 8 steps / `er_sde` / `simple`, rebalancer active: raw JSON 4,211 chars; first post-restart `json_structured` run about 25.29s; warm `json_structured` run about 19.70s; warm `json_minify` comparison about 19.67s. A shorter 1,358-char JSON prompt with rebalancer active warmed at about 13.21s; a 311-char plain prompt warmed at about 10.09s with rebalancer and about 8.08s with bypass.
- Conclusion: for Krea2 Turbo ConvRot INT8 on Apple Silicon, preserve structured JSON by default for adherence. Use `json_minify` or `prose_compact` only when explicitly speed-testing or when the user accepts the prompt-adherence tradeoff. Persistent 30-40s at 528x368 still points to too-large/non-optimized conditioning, cold-ish LoRA/model work, or a workflow path bypassing the JSON optimizer.

Confirmed BigLoveKlein3 ConvRot INT8 finding from 2026-06-30:

- Installed `/Users/liam/comfy/ComfyUI/custom_nodes/ComfyUI-INT8-Fast`.
- Converted `/Users/liam/comfy/ComfyUI/models/diffusion_models/BigLoveKlein3_bf16.safetensors` through `OTUNetLoaderW8A8` with `model_type=flux2`, `on_the_fly_quantization=true`, and `enable_convrot=true`.
- Saved raw INT8-Fast output to `/Users/liam/.comfy-private.noindex/output/int8_models/BigLoveKlein3_convrot_int8mixed_raw_00001_.safetensors`.
- Converted the raw `.comfy_quant` blobs to native Comfy format with `/Users/liam/comfy/ComfyUI/custom_nodes/ComfyUI-INT8-Fast/convert_to_comfy.py`.
- Final native checkpoint: `/Users/liam/comfy/ComfyUI/models/diffusion_models/BigLoveKlein3_convrot_int8mixed.safetensors`.
- Metadata inspection confirmed 114 native `int8_tensorwise` ConvRot layers with `convrot_groupsize=256`.
- A standard `UNETLoader` smoke run loaded the checkpoint successfully through the supervised AppleSilicon-FP8 Comfy lane. Logs reported native `int8_tensorwise` ops and the AppleSilicon-FP8 INT8 ConvRot Metal kernel patch was active.
- Initial warm benchmark, no `/free`, `BigLoveKlein3_convrot_int8mixed.safetensors`, `qwen_3_8b_fp8mixed.safetensors`, `flux2-vae.safetensors`, Comfy `KSampler` `euler` / `beta`, CFG 1.0, 448x672, 4 steps:
  - Queue-to-history wall time: about 8.04s.
  - Server-side Comfy prompt time: about 6.08s.
  - Denoise loop: about 4.3s total, roughly 1.08s/step.
- Corrected apples-to-apples forced-denoise comparison, same tiny text-to-image graph, different seeds per run to avoid Comfy graph cache:
  - BF16 load run: about 11.06s wall / 10.85s server prompt.
  - BF16 warm run: about 6.03s wall / 5.59s server prompt.
  - ConvRot INT8 load run: about 11.12s wall / 10.64s server prompt.
  - ConvRot INT8 warm run: about 7.04s wall / 6.46s server prompt.
- Corrected verdict: ConvRot INT8 did **not** improve warm BigLoveKlein3 speed at 448x672 / 4 steps in this Comfy text-to-image benchmark. BF16 was about 14-16% faster warm in total prompt time, and its denoise loop showed higher it/s. ConvRot INT8 remains useful as a smaller checkpoint / memory experiment and as a route worth testing with exact image-edit graphs, but it is not a proven speed default for BigLoveKlein3.
- User workflow copies added:
  - `/Users/liam/comfy/ComfyUI/user/default/workflows/BigLove Klein3 ConvRot INT8 Text to Image.json`
  - `/Users/liam/comfy/ComfyUI/user/default/workflows/BigLove Klein3 ConvRot INT8 SFW Image Edit.json`
- Frontend routing was hardened so `BigLoveKlein3_convrot_int8mixed.safetensors` is not accidentally routed to the MLX sidecar. The ConvRot INT8 checkpoint must execute through exact Comfy so the AppleSilicon-FP8 INT8 kernel is used.

Implication:

- ConvRot INT8 is usable on this M5 setup, provided the workflow uses the native Comfy checkpoint and the supervised ASFP8 env, but it should not be treated as the BigLoveKlein3 speed default. Do not compare it against MLX runs that include different reference-conditioning, LoRA, or image-edit graph semantics without matching the workflow.

Confirmed Anima WAI ConvRot INT8 finding from 2026-07-01:

- Tested through the real Anima Comfy lane on port `8198`, which was running with the supervised Apple Silicon profile and ASFP8 env.
- Target workflow inspected: `/Users/liam/comfy/ComfyUI/user/default/workflows/Anima WAI Turbo - Prompt Assistant (No Regions).json`.
- Confirmed active model chain in that workflow: `UNETLoader -> MultiLoRAStackModelOnly -> KSampler`. The TeaCache node titled "TeaCache active - Anima turbo fast path" is present but disconnected in the saved graph, so it is not part of the current Anima WAI no-regions runtime path.
- Converted `/Users/liam/comfy/ComfyUI/models/diffusion_models/waiANIMA_v10Base10.safetensors` through `OTUNetLoaderW8A8` with `model_type=anima`, `on_the_fly_quantization=true`, and `enable_convrot=true`.
- Saved raw INT8-Fast output to `/Users/liam/.comfy-private.noindex/output/int8_models/waiANIMA_v10Base10_convrot_int8mixed_raw_00001_.safetensors` and copied the loadable test checkpoint to `/Users/liam/comfy/ComfyUI/models/diffusion_models/waiANIMA_v10Base10_convrot_int8mixed.safetensors`.
- Standard `UNETLoader` cannot load this Anima INT8-Fast file; smoke failed with `ValueError: Unknown quantization format for layer blocks.0.self_attn.q_proj`. The checkpoint must use `OTUNetLoaderW8A8` with `on_the_fly_quantization=false`.
- Runtime turbo-LoRA benchmark, 1024x1024, 8 steps, CFG 1.5, `euler` / `normal`, `qwen35_4b.safetensors`, `qwen_image_vae.safetensors`, turbo LoRA `anima-turbo-lora-v0.2.safetensors` at `0.85`, no `/free`, varied seeds to avoid KSampler cache:
  - BF16 load-ish run: 24.571s server prompt.
  - ConvRot INT8 load-ish run: 27.282s server prompt.
  - BF16 warm runs: 17.309s and 39.091s server prompt.
  - ConvRot INT8 warm runs: 23.792s and 41.236s server prompt.
- Baked-turbo variant tested using `INT8PreLoraLoader` at strength `0.85`, saved as `/Users/liam/comfy/ComfyUI/models/diffusion_models/waiANIMA_v10Base10_turbo085_convrot_int8mixed.safetensors`, and benchmarked without the runtime LoRA node:
  - BF16 base + runtime turbo LoRA: 14.231s and 15.427s server prompt, mean 14.829s.
  - Baked turbo ConvRot INT8: 15.902s and 16.897s server prompt, mean 16.399s.
- No-LoRA isolation benchmark, same 1024x1024 / 8-step graph:
  - BF16 base: 17.622s and 17.972s server prompt, mean 17.797s.
  - ConvRot INT8 base: 19.008s and 21.055s server prompt, mean 20.032s.

Anima verdict:

- ConvRot INT8 did **not** improve Anima WAI speed on this M5 setup. It is slower with runtime LoRA, slower with baked turbo LoRA, and slower even with no LoRA. Keep the BF16 Anima WAI workflow as the speed default for now.
- The useful follow-up is not more ConvRot INT8 retesting; it is a deliberate TeaCache wiring/quality benchmark or another Anima-specific kernel path. If TeaCache is tested, treat it as a quality-changing approximation until visual QA proves otherwise.

## What Sampler Are We Using?

Confirmed from `/Users/liam/comfy/krea2_alis_mlx_redmix/krea2/sampling.py`:

- The native Krea2 MLX path does not use Comfy's `KSampler`, `sampler_name`, or `scheduler` controls.
- It uses a bespoke Krea-2 flow-matching sampler ported from `krea-2-official/sampling.py`.
- The actual update is Euler-style:

```python
img = img + (tp - tc) * v
```

- Timesteps come from `timesteps(seq_len, steps, x1, x2, y1=0.5, y2=1.15, sigma=1.0, mu=None)`.
- The native sidecar now exposes `sampler` with `flow_euler` and experimental `er_sde`; the saved workflow remains on `flow_euler` because the first `er_sde` benchmark was not faster or visually preferable.
- The pre-native workflow `/Users/liam/comfy/ComfyUI/user/default/workflows/Krea2 Red Mix SeedVR2 Apple Silicon.pre-mlx-native-20260629-095508.json` did use Comfy `KSampler` with widgets:

```json
[794015397137290, "randomize", 10, 1, "er_sde", "simple", 1]
```

- Comfy registers `er_sde` in `/Users/liam/comfy/ComfyUI/comfy/samplers.py`.
- Comfy's implementation is `/Users/liam/comfy/ComfyUI/comfy/k_diffusion/sampling.py::sample_er_sde`.
- Comfy's custom sampler node wraps it in `/Users/liam/comfy/ComfyUI/comfy_extras/nodes_custom_sampler.py::SamplerER_SDE`.

Recommendation:

- For workflows that still use Comfy `KSampler`, prefer `er_sde` with a simple scheduler for speed/quality tradeoff testing.
- For the native Krea2 MLX sidecar, `er_sde` is selectable as an experiment, but it is not the recommended default based on the first benchmark.
- Do not claim the native Krea2 workflow is "using er_sde" unless the saved workflow's `Krea2MLXRedMixSampler` widget value is explicitly set to `er_sde`.
- ER-SDE is attractive because Comfy's implementation uses one model call per step. That means it is sampler-efficient compared with multi-eval samplers.
- Porting ER-SDE is not copy/paste: Comfy's version assumes sigma/logSNR data-prediction sampling, while native Krea2 uses flow-matching velocity prediction with direct `t` timesteps. We need a Krea2-correct derivation or an empirical adapter before enabling it.
- First native adapter result: runtime-stable, about 54.2s generate at 960x1440 / 10 steps / no LoRA, not a speed win.

## Working Changes To Keep

Confirmed improvements or useful instrumentation:

- Keep `mxfp8-fused` transformer weights.
- Keep fused attention and fused MLP projections.
- Keep `mx.compile(transformer.forward_prepared_vectors)`.
- Keep `MLX_METAL_FAST_SYNCH=1`.
- Keep `KREA2_MLX_CACHE_LIMIT_GB=0`; this disables MLX's free-memory cache. It does not disable compiled forward kernels.
- Keep `KREA2_MLX_EVAL_EACH_STEP=0` and `KREA2_MLX_STEP_TIMINGS=0` for normal generation. Step timings force synchronization and are for profiling only.
- Keep sidecar health reporting for:
  - `precision`
  - fused attention / fused MLP
  - compiled forward wrapper
  - activation dtype
  - MLX cache limit
  - active LoRA count
- Keep stale sidecar rejection in the Comfy node so old listeners are not silently reused.
- Keep `KREA2_MLX_RECYCLE_SIDECAR_AFTER_RUN=1` for now. Warm repeats in one loaded process drifted from about 50s to about 90-130s.
- Keep `start_new_session=True` when spawning the sidecar so it survives the launcher process correctly.
- Do not demote the sidecar with `taskpolicy -B` unless explicitly setting `KREA2_MLX_BACKGROUND_SIDECAR=1`.
- Keep `KREA2_MLX_FOCUS_MODE=1` for the native Krea2 node unless it proves disruptive. It pauses configured idle sibling Comfy lanes, currently port `8198` for Anima, only while the Krea sidecar `/generate` call is running. It skips Comfy lanes with running/pending queue work and resumes paused pids afterward. This is a contention fix, not a quality or sampling change.
- Keep the default `8188` Comfy lane's ASFP8 supervisor env in `/Users/liam/.local/bin/zimage-stack`. This is required for Krea2 Turbo ConvRot INT8 to use the AppleSilicon-FP8 native M5 kernel in real mobile/API runs, not only in ad hoc shell launches.

## Dead Ends / Do Not Retry Blindly

Confirmed non-working or worse:

- Reducing steps from 10 to 4 is not acceptable; quality visibly degrades.
- Native experimental `er_sde` at 960x1440 / 10 steps / no LoRA was not faster. It took about 54.2s generate versus the about 50-55s current `flow_euler` range, and the visual output changed composition enough that it should not be the default.
- Setting MLX free-memory cache to 12 GB made warm repeats worse in testing, including a run around 91s.
- Activation dtype `fp16` was slower than `bf16` in testing, around 90s generate.
- Generic FP8 activations are not a drop-in MLX dtype. MLX exposes `to_fp8` and `from_fp8` conversion helpers that store FP8 as `uint8`; using them for intermediate activations would add quantize/dequantize overhead and likely hurt quality.
- Directly calling `linear(x)` on 3D tensors instead of the existing flatten-and-reshape helper was slower, around 60.9s generate, and was reverted.
- Capturing `transformer.parameters()` explicitly in `mx.compile(..., inputs=...)` failed with `ValueError: [compile] Attempting to compile a function with uncaptured inputs is not allowed.`
- The text encoder and VAE are not the main bottleneck for this workflow at the tested settings.
- MLX `fast.rms_norm` with float32 inputs/effective weight preserved did not improve the target run. It took about 52.2s generate / 59.0s wall at 960x1440 / 10 steps / no LoRA and was reverted.
- MLX `fast.rms_norm` in native bf16 was much worse, about 99.9s generate / 105.5s wall at 960x1440 / 10 steps / no LoRA. Do not retry without a specific MLX kernel/runtime change.
- Red Mix bf16 fused-after-load was slower than the MXFP8 fused path, about 104.3s generate at 960x1440 / 10 steps / no LoRA. Higher precision is not a speed win on this machine.
- Red Mix MXFP8 unfused was slower than the fused MXFP8 path, about 113.0s generate at 960x1440 / 10 steps / no LoRA. The fused QKV/gate and MLP gate/up packing should stay.
- MLX cache limit 2 GB gave only a small/noisy improvement, about 49.4s generate. MLX cache limit 4 GB was much worse, about 95.9s generate. Keep normal default at 0 GB unless repeated evidence says 2 GB is stable.
- A fresh cache-limit 2 GB target run under active system pressure was worse: about 76.0s generate / 81.5s total. The run was contaminated by heavy Claw/Z-Image API contention, but it reinforces that 2 GB is not a safe default.
- Compiling the entire fixed denoise loop, instead of only `forward_prepared_vectors`, was worse at target shape: about 58.9s denoise on the first compiled call and about 74.5s on the second.
- Forcing `mx.eval` after every denoise step was worse, about 83.2s generate. The lazy 10-step graph should remain.
- At 256x384, compiling the whole 10-step denoise loop was also worse than the current per-step compiled-forward sidecar path. Do not wire whole-loop compile for small shapes.
- Prompt compaction is a real speed lever at 256x384 because the original saved prompt fills/truncates to 512 text tokens while compact prompts reduce the transformer context length. This is a conditioning change, not a pure runtime/kernel optimization. Use only if visually accepted.
- Accepted compact prompt candidate, 537 chars, produced about 3.6-5.0s warm sidecar generate at 256x384 depending on system load:
  `photorealistic close-up overhead selfie of an adult young East Asian woman in her early 20s with fair skin, short black bob haircut and blunt bangs, lying in bright clean sunlight, playful cheeky expression, one eye open looking at the camera and the other eye winking, soft smile with glossy coral lips, white camisole straps, wicker chair texture, arms and hands very close to the lens creating foreground occlusion, intimate POV framing, diagonal window-blind shadows across face and body, natural skin texture, sharp realistic detail`
- Very short/tuned prompts did not reliably improve beyond the accepted compact prompt and often changed output or slowed down; do not assume fewer characters is faster.
- Dynamic text length is default-off. It can change Qwen text-encoder positions for compact prompts, so it is an experiment, not a preservation-safe default.
- `MLX_ENABLE_TF32=1` is slower on the 256x384 fixed-seed long-prompt benchmark. Warm generate was about 7.24-8.50s versus the 6.35-6.38s baseline.
- `MLX_METAL_JIT=0` is much slower on the 256x384 fixed-seed long-prompt benchmark. Warm generate drifted from about 10.99s to 19.33s.
- `MLX_METAL_JIT=1` is much slower on the 256x384 fixed-seed long-prompt benchmark. Warm generate was about 16.18-17.71s after a 31.12s first generate.
- `MLX_ENABLE_TF32=1` plus `MLX_METAL_JIT=1` is slower on the 256x384 fixed-seed long-prompt benchmark. Warm generate was about 14.14-14.44s.
- Do not retry TF32 or explicit `MLX_METAL_JIT` as a generic speed fix unless MLX changes or the workload changes. The sidecar fast-path report now records both flags so stale-runtime comparisons are visible.
- Progressive latent sampling is a real speed lever but failed the preserved-quality constraint in the first full-size tests. A 960x1440 final image with 6 early steps at 608x896 and 4 final steps at 960x1440 reached about 30.05s denoise / 32.84s after load, but produced visible color artifacts and wardrobe/content drift. Safer 608x896/4 and 720x1088/6 variants were slower, about 51-55s denoise in the tested run, and still changed the image. Do not wire progressive latent into the main workflow unless a later variant removes those artifacts.
- Progressive latent with high-frequency residual noise handoff improved artifacts in a small 256x384 probe but did not preserve the full workflow target. The full 960x1440 test at 608x896 / 6 low steps / residual alpha 0.5 took about 56.3s denoise / 60.2s after load and still drifted wardrobe/content. Do not retry this exact residual handoff as a speed fix.
- `KREA2_MLX_ROPE_PRECISION=native` / input-dtype RoPE is slower at target size. A standalone sidecar run at 960x1440 / 10 steps / no LoRA took about 58.62s generate / 63.70s total versus the current fp32-RoPE default at about 51.93s generate. Keep default `fp32`.
- Do not default-pause the raw Z-Image API listener on port `8787`. A real Comfy API test with raw port `8787` in focus mode made the stack supervisor health check fail and restart the whole stack mid-generation. Raw-port pausing must stay opt-in diagnostic only unless the supervisor health behavior is changed.
- Comfy-native FP8 Krea2 on MPS is not a speed path. The local `Krea2RedMix-10Steps-fp8-scaled-ComfyUI.safetensors` standard `UNETLoader` + `KSampler` path failed at 256x384 / 10 steps with `TypeError: Trying to convert Float8_e4m3fn to the MPS backend but it does not have support for that dtype.`
- Comfy-native BF16 Krea2 through standard `UNETLoader` + `KSampler` is far slower than the MLX sidecar. A 256x384 / 10-step `er_sde` run with `Krea2RedMix-10Steps-bf16-dequant-ComfyUI.safetensors` took about 40.3s wall. A nearby native MLX recompute with sidecar/process warmup contamination took about 15.1s wall; previous clean warm 256x384 native sidecar runs are about 6-8s.
- Comfy-native INT8 Krea2 Turbo on MPS is not a speed path. `Krea2_Turbo_int8mixed.safetensors` from `Winnougan/Krea-2-Base-Turbo-NVFP4-FP8-INT8` loaded, but the 256x384 / 8-step `er_sde` run failed in `KSampler` with `NotImplementedError: aten::_int_mm is not currently implemented for the MPS device.` PyTorch suggests `PYTORCH_ENABLE_MPS_FALLBACK=1`, but that moves the missing op to CPU and is not an Apple GPU fast path.
- Superseded ConvRot INT8 caution: before `ComfyUI-AppleSilicon-FP8` and the supervised `ASFP8_INT8_EXT=1` fix, ConvRot INT8 was effectively NVIDIA-oriented here. That is no longer true for eligible M5 runs using the AppleSilicon-FP8 Metal INT8 kernel. Keep the caution only for non-M5/non-ASFP8 paths, plain PyTorch MPS without the patch, or workflows that accidentally route away from exact Comfy execution.
- Comfy-native MXFP8 and NVFP4 are not Apple GPU speed paths in this local stack. A direct comfy-kitchen backend probe on MPS failed for both `quantize_mxfp8` and `quantize_nvfp4` with the same `Float8_e4m3fn` unsupported-on-MPS error; the same probes worked on CPU. Do not download the Turbo MXFP8/NVFP4 checkpoints for speed unless the MPS float8 limitation or backend kernels change.
- The Winnougan quant repo sizes checked on 2026-06-30: Turbo INT8 about 12.9 GB, Turbo ConvRot INT8 about 12.9 GB, Turbo FP8 about 12.9 GB, Turbo MXFP8 about 13.5 GB, Turbo NVFP4 about 7.7 GB, INT8 text encoder about 4.8 GB. Downloading more of these does not change the confirmed MPS backend limitations above.
- `ComfyUI-AppleSilicon-FP8` is useful for compatibility and is a real speed path for Krea2 Turbo ConvRot INT8 when launched with the supervised env fix. Installed `/Users/liam/comfy/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8`, `ninja`, and `mtlflashattn`; installed Xcode 26.6, accepted license, and downloaded the Metal Toolchain with `xcodebuild -downloadComponent MetalToolchain`.
- AppleSilicon-FP8 compatibility mode changed Krea2 Turbo INT8 from hard failure to success: 256x384 / 8-step / `Krea2_Turbo_int8mixed.safetensors` completed in about 24.1s wall. That is still slower than native MLX and not a useful speed target.
- Xcode 26.6 / macOS 26.5 SDK exposes `MTLLanguageVersion4_0`, not the repo's hardcoded `MTLLanguageVersion4_1`. A local patch changed `MTLLanguageVersion4_1` to `MTLLanguageVersion4_0` in the AppleSilicon-FP8 int8/fp8 extension sources; with that patch, the startup log confirmed `[AppleSilicon-FP8/int8_kernel] INT8 convrot Linear routed through bit-exact Metal kernel on MPS`.
- With the local Metal 4.0 patch and `ASFP8_INT8_EXT=1 ASFP8_FP8_EXT=1`, the same plain `Krea2_Turbo_int8mixed.safetensors` 256x384 / 8-step test got worse, about 48.2s wall. Inferred cause: the native kernel is designed for ConvRot W8A8, while the tested file is regular INT8. Do not use plain INT8 Turbo as the benchmark for the native kernel.
- Superseded bad AppleSilicon-FP8 ConvRot test: `Krea2_Turbo_convrot_int8mixed.safetensors`, 256x384 / 8-step / `er_sde` / CFG 1.0, reported about 34.2s wall before the supervisor env fix and while earlier scripts were calling `/free` before each quant run. Do not use that number for the author's warm 1280x640 speed comparison.
- Do not call `/free` before timing warm generation unless the run is explicitly labeled cold. `/free` forces model unload/reload and can make fast-path timing look broken.
- Do not switch Anima WAI to ConvRot INT8 by default. Both runtime-LoRA and baked-turbo-LoRA ConvRot tests were slower than the current BF16 path at 1024x1024 / 8 steps, and the standard `UNETLoader` cannot load the INT8-Fast Anima file anyway.
- Superseded Krea2 RedMix ConvRot INT8 runtime LoRA failure from 2026-07-01: applying Krea2 LoRAs through the normal `MultiLoRAStack` on the already-quantized ConvRot INT8 model collapsed output into colored noise, even with a single LoRA. That remains a real failure mode for runtime LoRA-on-quantized-weight routing, but it is no longer the recommended route.
- Confirmed Krea2 RedMix ConvRot INT8 LoRA fix on 2026-07-01: bake LoRAs into BF16 first, then quantize ConvRot INT8 on the fly through INT8-Fast. Added `/Users/liam/comfy/ComfyUI/custom_nodes/multi-lora-stack::MultiLoRAStackToPreLora`, which parses the same multi-stack JSON UI and emits `PRE_LORA` for `OTUNetLoaderW8A8`.
- Rewired `/Users/liam/comfy/ComfyUI/user/default/workflows/Krea2 RedMix ConvRot INT8 ASFP8 Bench Apple Silicon.json` to use `MultiLoRAStackToPreLora -> OTUNetLoaderW8A8` with `Krea2RedMix-10Steps-bf16-dequant-ComfyUI.safetensors`, `model_type=krea2`, `on_the_fly_quantization=true`, `enable_convrot=true`, and `lora_mode=None`. This preserves the AppleSilicon-FP8 ConvRot INT8 fast path after the quantized model is built while avoiding runtime LoRA patching against prequantized weights.
- Smoke-confirmed at 320x224 / 8 steps / `er_sde` / `simple` / CFG 1.0 / seed `123456789`: standard LoRA `SummerVibesHM_krea2_epoch8.safetensors` at `0.6`, LoKR `realism_engine_krea2_v2.safetensors` at `0.5`, and a three-LoRA low stack (`SummerVibesHM 0.35`, `realism_engine 0.25`, `krea2_mary 0.35`) all produced coherent images through the Pre-LoRA ConvRot route. The same path is slower when it has to quantize after a restart, so do not benchmark first-run on-the-fly quantization as warm inference speed. After the three-LoRA stack was baked/cached, warm repeats with different seeds and no `/free` completed in about 7.57s wall at 320x224.
- Keep the separate BF16 workflow for quality comparison and for arbitrary runtime LoRA experimentation. For ConvRot INT8 RedMix, use Pre-LoRA before quantization; do not reintroduce normal `MultiLoRAStack` after `UNETLoader` on the prequantized ConvRot file unless a future native quantized-LoRA patch is proven.

## Installed Krea2 Quality-Lane Dependencies

Installed or downloaded on 2026-06-30 for separate quality workflow experiments:

- Custom nodes:
  - `/Users/liam/comfy/ComfyUI/custom_nodes/ComfyUI-VAE-Utils`
  - `/Users/liam/comfy/ComfyUI/custom_nodes/ComfyUI-Krea2TextEncoder`
  - `/Users/liam/comfy/ComfyUI/custom_nodes/ComfyUI-RBG-SmartSeedVariance`
- Loaded node class names after restart:
  - `VAEUtils_CustomVAELoader`
  - `VAEUtils_VAEDecodeTiled`
  - `TextEncodeKrea2`
  - `Krea2SystemPrompt`
  - `RBG_Smart_Seed_Variance`
- Downloaded models/LoRAs:
  - `/Users/liam/comfy/ComfyUI/models/diffusion_models/Krea2_Turbo_int8mixed.safetensors`
  - `/Users/liam/comfy/ComfyUI/models/loras/krea2_turbo_lora_rank_64_bf16.safetensors`
  - `/Users/liam/comfy/ComfyUI/models/vae/Wan2.1_VAE_upscale2x_imageonly_real_v1.safetensors`
  - `/Users/liam/comfy/ComfyUI/models/vae/qwen_image_HDR_vae_fp32_comfy.safetensors`
- Comfy-Org Krea2 raw/turbo size check: Raw BF16 and Turbo BF16 are each about 26.3 GB; Raw FP8 and Turbo FP8 are each about 13.1 GB. Raw + Turbo LoRA should be treated as a separate quality recipe, not evidence for the native MLX Red Mix speed goal.

## Release Routing Hardening

Confirmed on 2026-06-30:

- Apple Silicon-specific acceleration is now centralized in `/Users/liam/comfy/z-image-api/hardware_profile.py`.
- The profile can be forced with `ZIMG_ACCELERATOR_PROFILE=apple-silicon|cuda|rocm|apple-intel|cpu`; otherwise it auto-detects Darwin arm64 as `apple-silicon`, NVIDIA as `cuda`, ROCm as `rocm`, and falls back to `cpu`.
- `/Users/liam/.local/bin/zimage-stack` now consumes that profile before launching the managed stack. `ASFP8_INT8_EXT`, `ASFP8_FP8_EXT`, the Swift/MLX Flux2 sidecar, native BigLove MLX intercept, and the Comfy quad-attention flag are enabled by default only for the `apple-silicon` profile.
- Both managed Comfy lanes receive the same ASFP8 defaults on Apple Silicon, so Anima, BigLove Flux/Klein, Krea2 Turbo ConvRot, and Red Mix experiments share the same device gate instead of each workflow carrying separate Apple-only assumptions.
- The API guards the native MLX BigLove path and the MPS-only BigLove MXFP8-to-BF16 rewrite behind the same profile. Unit tests force `ZIMG_ACCELERATOR_PROFILE=cuda` and confirm those Apple-only routes are disabled on CUDA.
- The Krea2 Red Mix MLX custom node and sidecar now import the same profile helper and reject the MLX route unless `native_mlx` is supported. Import-level probes confirmed forced `cuda` rejects the route and forced `apple-silicon` allows it.
- Live post-restart verification on this M5 machine: default Comfy and Anima Comfy children had `ZIMG_ACCELERATOR_PROFILE=apple-silicon`, `ZIMG_ENABLE_APPLE_SILICON_OPTIMIZATIONS=1`, `ASFP8_INT8_EXT=1`, and `ASFP8_FP8_EXT=1`; the API child had `ZIMG_ACCELERATOR_PROFILE=apple-silicon`, `ZIMG_USE_FLUX2_SERVER=1`, and `ZIMG_NATIVE_MXFP8_PROMPT_INTERCEPT=1`.

Inferred release implication:

- Future CUDA/ROCm optimization routes should be added to `hardware_profile.py` as new capabilities and consumed by the supervisor/API through the same profile object, rather than checking machine-specific env vars inside individual workflow patches.

## Krea2 Runtime LoRA Quality Notes

Confirmed on 2026-07-01 against the then-current `Krea2 Turbo ConvRot INT8 ASFP8 Bench Apple Silicon`:

- Historical route: `UNETLoader(Krea2_Turbo_convrot_int8mixed.safetensors)` -> `MultiLoRAStack` -> `KSampler`.
- Normal strengths are not globally broken. At 320x224, each default workflow LoRA at strength `1.0`, all five default LoRAs at strength `1.0`, and a saved-path 528x368 run with the Krea2 gated rebalance all produced clean outputs.
- Deliberately high strength is a reproducible artifact path. `realism_engine_krea2_v2.safetensors` at strength `10.0` produced a melted/glitchy output both before and after the ASFP8 guard change.
- The LoRA strength UI now allows very large values for experimentation, but practical Krea2 strengths still need to be treated as model/LoRA-specific. For this Turbo ConvRot workflow, start near `0.3-1.0` and raise slowly; `10.0` is already destructive for at least one tested realism LoRA.

Correction from 2026-07-02:

- User testing showed blotchy output can persist with `AzKrea2GatedRebalance` disabled, so the rebalancer is not the root cause.
- The stronger root-cause hypothesis is the same class as the confirmed RedMix failure: runtime LoRA patching against an already-quantized ConvRot INT8 checkpoint can produce sampling/texture artifacts. Lower LoRA strength may reduce symptoms, but it does not fix the underlying route.
- `/Users/liam/comfy/ComfyUI/user/default/workflows/Krea2 Turbo ConvRot INT8 ASFP8 Bench Apple Silicon.json` has been rewired to use `MultiLoRAStackToPreLora -> OTUNetLoaderW8A8(krea2_turbo_bf16.safetensors, on_the_fly_quantization=true, enable_convrot=true)` so enabled LoRAs are baked into BF16 first and only then quantized to ConvRot INT8.
- The old route is preserved as `/Users/liam/comfy/ComfyUI/user/default/workflows/Krea2 Turbo ConvRot INT8 ASFP8 Bench Apple Silicon - legacy runtime LoRA.json` for controlled comparison.
- Downloaded the required BF16 source from Comfy-Org Krea-2 into `/Users/liam/comfy/ComfyUI/models/diffusion_models/krea2_turbo_bf16.safetensors`.
- Verification smoke, 528x368 / 8 steps / `er_sde` / `simple` / CFG 1.0 / same benign wall-heavy prompt / same two-LoRA stack (`realism_engine_krea2_v2.safetensors` 1.0 and `krea2_mary.safetensors` 1.5):
  - Legacy runtime route: `UNETLoader(Krea2_Turbo_convrot_int8mixed.safetensors) -> MultiLoRAStack`, prompt executed in 13.80s; KSampler 12.495s.
  - New cold pre-LoRA route: `MultiLoRAStackToPreLora -> OTUNetLoaderW8A8(krea2_turbo_bf16.safetensors)`, prompt executed in 38.19s; loader bake/quant step 23.239s; KSampler 11.655s. Logs confirmed `MultiLoRAStackToPreLora: prepared 2 enabled LoRA(s)` and `INT8 Fast: Prepared 256 layer patches for baking`.
  - New warm pre-LoRA repeat with only seed changed: prompt executed in 10.49s; KSampler 10.209s; Comfy cache skipped loader/conditioning. The bake/quant cost is therefore cold or LoRA-stack-change overhead, not per-generation overhead.

Fix applied:

- `/Users/liam/comfy/ComfyUI/custom_nodes/ComfyUI-AppleSilicon-FP8/_patches/int8_linear_kernel_mps.py` now makes the M5 INT8 kernel fall back when Comfy attaches `weight_lowvram_function` or `bias_lowvram_function` runtime patches. The previous guard covered normal `weight_function`/`bias_function` LoRA patches but not the low-vram patch path.

## Krea2 Turbo ConvRot 528x368 Timing

Confirmed on 2026-07-01 against `Krea2 Turbo ConvRot INT8 ASFP8 Bench Apple Silicon` after restarting through `/Users/liam/.local/bin/zimage-stack`:

- ASFP8 M5 INT8 kernel was active at startup.
- Workflow settings: 528x368 latent, 8 steps, CFG 1.0, `er_sde` / `simple`, Krea2 gated rebalance active with weights `1,1,1,1,1,1,1,1,2.5,5,1,4`.
- Reference image path was structurally disengaged: `HermesOptionalLoadImage` used the `None` sentinel and returned no image/mask.
- Prompt generation was not the slowdown. `PromptAssistantGenerate` completed in 0.001s because `auto_generate_on_queue` was false and the saved manual prompt was reused.
- First direct REST benchmark with the saved workflow and seed `794015397137290`: 25.98s server execution / 26.23s wall. Major node timings: KSampler 21.141s, CLIPLoader 2.538s, TextEncodeKrea2 1.046s, VAEDecode 0.628s, CLIPTextEncode 0.281s, AzKrea2GatedRebalance 0.014s.
- Second direct REST benchmark with only the seed changed to `794015397137291`: 18.04s server execution / 18.24s wall. Comfy graph cache skipped upstream conditioning; only KSampler 17.659s, VAEDecode 0.341s, and SaveImage 0.037s executed.
- Third warm sanity benchmark with seed `794015397137292`: 17.28s wall. Major node timings: KSampler 16.465s, VAEDecode 0.317s, SaveImage 0.039s.
- Temporary benchmark histories and `.codex_krea2_speedtest_*` outputs were deleted after measuring.

Fix applied:

- `/Users/liam/comfy/ComfyUI/custom_nodes/ComfyUI-Krea2TextEncoder/nodes.py` now keeps a small text-only conditioning cache keyed by the assembled Krea2 text/template and loaded CLIP object. It is disabled for reference-image conditioning so stale vision embeddings cannot be reused.

Confirmed prompt-length scaling benchmark from 2026-07-01 (same warm server, ASFP8 kernel confirmed active, same graph as the saved bench workflow, LoRAs off, rebalancer active, only the prompt varied, run under live desktop contention with WindowServer/Splashtop/Claude renderer busy):

- 500-char plain prompt: 7.07s and 7.08s wall; KSampler 6.40s and 6.52s.
- 4,914-char stored Krea2 JSON prompt (`json_structured`): 18.28s wall; KSampler 16.90s.
- Real mobile runs the same evening, 8,800-char PromptAssistant JSON (optimized to 7,895 chars by `TextEncodeKrea2` `json_structured`) plus 5 active runtime LoRAs (strengths 0.6/1.0/0.1/1.5/1.0): 36.47s and 38.42s wall; KSampler 33.29s and 37.84s, with per-step time degrading between runs (2.9 -> 4.7 s/it), consistent with contention.
- Important gap: `Krea2PromptCompact` `max_chars=2600` is not enforced in `json_structured` mode. An 8,800-char helper JSON reached `TextEncodeKrea2` at 7,895 chars. Conditioning length is the dominant 528x368 cost lever; there is currently no hard cap on the mobile path.
- Interpretation: the machine baseline at 528x368 / 8 steps is about 7s wall warm with a short prompt. 25-38s mobile runs are explained by helper JSON size (5-6x compact length) plus the 5-LoRA stack and desktop/screen-streaming contention, not by a broken ASFP8 path.

Confirmed Krea2 prompt-bloat fix from 2026-07-01 (injector consolidation + negation-list strip):

- Root cause of both the size and the adherence regression: the `_strengthen_krea2_photo_json_composition` injectors in `comfyui-prompt-assistant/__init__.py` stamped each framing/anchor concept into up to 6 sections at once (mirror_rules, body.legs, pose, clothing.bottom, composition, crop_control, background.elements, must_keep, avoid, negative_prompt). A ~700-char idea ballooned to ~9,000 chars, must_keep grew to 24 items, avoid to 38, and the actual scene became a small fraction of the conditioning tokens.
- Second defect: `constraints.avoid` and `negative_prompt` lists are embedded in the text that `TextEncodeKrea2` encodes as POSITIVE conditioning. The turbo workflows run CFG 1.0, where Comfy skips the negative pass entirely, so those lists did nothing as negatives but injected the named failure concepts ("female feet on floor", "cropped head") into the prompt. Reported symptom matched: leg placement got worse when the leg-avoid list was added.
- Fix applied in `comfyui-prompt-assistant/__init__.py`: each anchor concept now injects exactly once into its single most relevant field; must_keep injections collapsed to at most one phrase per concept (~9 anchors max); no avoid/negative injection at all. `json_structured` and `json_minify` modes plus the prose compactor now strip `negative_prompt` and `constraints.avoid` before encoding.
- Fix applied in `ComfyUI-Krea2TextEncoder/nodes.py`: the encoder guard's structured/minify modes strip the same negation lists (protects old canvases that wire the helper directly into the encoder), and the malformed-JSON fallback no longer extracts the negative_prompt section.
- Measured on the user's real 9,976-char helper JSON: encoder payload with strip only = 7,434 chars (old boilerplate still baked into prose); simulated fresh regeneration with the new injector = 5,538 chars, encoder payload 4,976 chars, user must_keep items first.
- Benchmark note: post-restart timings were contaminated by `hivemindos/scripts/agent-telemetry-collector.mjs` at 250-470% CPU (control 500-char run 12.1s vs 7.07s clean, about 1.7x). Under identical contention, old pasted JSON = 44.4s wall vs new regenerated JSON = 29.8-30.9s wall at 528x368 / 8 steps with rebalancer, LoRAs off, i.e. about 33 percent faster; normalized to clean conditions the regen payload lands in the ~17-18s class consistent with the 4.9k-char scaling point. The telemetry collector is now a named contention source for benchmark hygiene, alongside WindowServer/Splashtop.
- Tests: comfyui-prompt-assistant 43 OK (2 new: single-occurrence injection, minify strip); ComfyUI-Krea2TextEncoder 6 OK (1 new: structured strip).

Confirmed Krea2 framing strategy from 2026-07-02 (object-placement anchors, never visibility rules):

- Krea2 training captions describe objects with positions; "both subjects fully visible" / "legs in shot" / "no cropped heads" are not caption language and do nothing (negations backfire in positive conditioning). Confirmed on Liam's sofa scene and by community results.
- Frame bounds are controlled by described objects: ceiling light fixture above the subjects = top edge (confirmed working), floor + planted feet = bottom edge (confirmed working), "empty wall and floor space beyond the left/right sofa arm" = side edges (added after the sofa arms kept cropping - furniture gets cropped at its edges unless something beyond those edges is described).
- json_structured/json_minify now encode scene-first (background + photography before subject) in both custom nodes, strip negation lists, and scrub known legacy meta phrases from lists AND prose so old saved prompts are healed at encode time.
- Prior-fighting constraints (female-on-sofa pose vs kneeling-on-floor prior) keep a deliberate 2x concrete-imagery dose in pose.position + body.legs; everything else is 1x.
- Latent aspect ratio matters: 528x368 is 1.43:1, squarer than the prompted 16:9 wide-sofa composition, which pressures the model to crop width. Prefer a true wide latent (e.g. 624x352 or 848x480) for full-sofa scenes.

Confirmed Krea2 negative-conditioning rollback from 2026-07-02:

- The Krea2 positive compaction path correctly strips `negative_prompt` and `constraints.avoid` from the positive text so negated concepts are not summoned by the positive encoder.
- Regression found after quality reports: wiring `PromptAssistantGenerate.negative_prompt` into the Turbo ConvRot workflow's negative `CLIPTextEncode` branch correlated with blotchy/under-conditioned-looking samples. Krea2 Turbo is touchy around negative conditioning/CFG, and the previously good path effectively used positive Krea2 conditioning with an empty negative text branch.
- Fix applied: keep `PromptAssistantGenerate.negative_prompt` available as an output, but do not wire it into `Krea2 Turbo ConvRot INT8 ASFP8 Bench Apple Silicon` by default. The negative `CLIPTextEncode` node remains empty unless explicitly reconnected for a controlled experiment.
- Verification: saved workflow JSON validates with no dangling links; direct 528x368 / 8-step `er_sde/simple` control through ConvRot INT8 + TextEncodeKrea2 + AzKrea2GatedRebalance + empty negative branch produced a coherent image in 9.90s wall / 7.97s KSampler after cache clear.
- Tests: comfyui-prompt-assistant 44 OK; ComfyUI-Krea2TextEncoder 6 OK; mobile LoRA utility 9 OK; multi-lora-stack backend regression 1 OK.

Superseded Krea2 blotchy-wall LoRA isolation from 2026-07-02:

- A manually exported failing run was not on the saved 528x368 baseline: it used 736x1024, randomized seed, `realism_engine_krea2_v2.safetensors` at 1.0, `krea2_mary.safetensors` at 1.5, empty negative conditioning, and Krea2 gated rebalance enabled. The live Comfy log confirmed `TextEncodeKrea2` had zero reference images and only a short 214-character positive conditioning payload for that run.
- Safe controlled wall-scene tests at 736x1024 / 8 steps / `er_sde` / `simple` showed the blotchy/cloudy wall artifact is not a general VAE/model/sampler failure. No-LoRA and Mary-only controls were comparatively clean.
- `realism_engine_krea2_v2.safetensors` at strength 1.0 was the strongest artifact amplifier, especially with `AzKrea2GatedRebalance`. The single-LoRA realism run with rebalance showed visible colored wall mottling; `krea2_mary.safetensors` alone did not.
- Superseded interpretation: lowering `realism_engine_krea2_v2.safetensors` from 1.0 to 0.5 is a symptom reducer, not a root fix. After user testing showed blotchiness still present with rebalancer disabled, the active root-cause target moved to runtime LoRA-on-prequantized-ConvRot routing.
- Workflow update: `/Users/liam/comfy/ComfyUI/user/default/workflows/Krea2 Turbo ConvRot INT8 ASFP8 Bench Apple Silicon.json` now keeps LoRAs off by default, lists `krea2_mary.safetensors` as an available stack entry, and sets the default `realism_engine_krea2_v2.safetensors` strength to 0.5.

Confirmed Krea2 stale-session ConvRot routing issue from 2026-07-02:

- A later manually exported blotchy run still did not exercise the repaired saved workflow. Its embedded workflow and Comfy log showed the old editor/session graph: `UNETLoader(Krea2_Turbo_convrot_int8mixed.safetensors)` feeding runtime `MultiLoRAStack`, with the stale Krea2 widget shape still present.
- Root cause: repairing the saved workflow file is not enough when an already-open browser tab/session keeps its own serialized workflow. The tab can submit the legacy graph until it reloads or the queue path rewrites it.
- Fix applied in the mobile frontend: loading, session normalization, and queue submission now migrate legacy Krea2 Turbo ConvRot runtime-LoRA graphs to `MultiLoRAStackToPreLora -> OTUNetLoaderW8A8(krea2_turbo_bf16.safetensors, model_type=krea2, on_the_fly_quantization=true, enable_convrot=true)` before expansion/submission. The migration also normalizes stale `TextEncodeKrea2` and `Krea2PromptCompact` widget arrays while preserving direct prompt widget text.
- Fix applied in `z-image-api`: `/api/prompt` proxy now has a server-side guard for stale API prompts on Apple Silicon, rewriting the legacy runtime-LoRA prompt body to the same pre-LoRA BF16-to-ConvRot route before Comfy executes it.
- Live verification after stack restart: a synthetic stale API graph submitted through the authenticated local proxy was rewritten server-side, then Comfy executed `MultiLoRAStackToPreLora` and `OTUNetLoaderW8A8`; the temporary smoke output and history entry were deleted afterward.
- Tests: z-image-api regression 1 OK; z-image-api unit suite 24 OK; mobile Krea2 migration test 3 OK; mobile production build OK.

Confirmed Krea2 Turbo sampler correction from 2026-07-02:

- User-reported blotchy/mottled output persisted after stale workflow migration, correct widget defaults, no reference image, empty negative conditioning, and pre-LoRA ConvRot routing were verified. Treating LoRAs as the root cause was not sufficient.
- The saved workflow was still using the earlier speed-test pair: `KSampler` `er_sde` / `simple`, 8 steps, CFG 1.0.
- The current quantized Krea2 Turbo workflow published with `Winnougan/Krea-2-Base-Turbo-NVFP4-FP8-INT8` uses `euler_ancestral` / `beta` at 8 steps, CFG 1.0. This is closer to the Krea2/flow matching schedule than the experimental `er_sde/simple` setting we had promoted.
- Controlled local A/B at 528x368, same safe wall/sofa prompt, same seed, same two enabled LoRAs (`realism_engine_krea2_v2.safetensors` 1.0 and `krea2_mary.safetensors` 1.5), same BF16-to-ConvRot pre-LoRA route, same `qwen_image_vae.safetensors`:
  - `er_sde` / `simple`, CFG 1.0: about 27.14s wall.
  - `euler_ancestral` / `beta`, CFG 1.0: about 11.05s wall.
  - `euler` / `beta`, CFG 1.0: about 11.06s wall.
  - `euler_ancestral` / `beta`, CFG 0.0: about 23.12s wall and visibly off-target in the control output.
- Fix applied: `/Users/liam/comfy/ComfyUI/user/default/workflows/Krea2 Turbo ConvRot INT8 ASFP8 Bench Apple Silicon.json` now defaults to `euler_ancestral` / `beta`, 8 steps, CFG 1.0. Keep `er_sde/simple` only as an explicit experiment, not the default.

Confirmed z-image-api WebSocket relay fix from 2026-07-02 (10s image-delivery delay on remote tailnet clients):

- Symptom: generation completes on the M5 but the remote browser (M2 over tailscale HTTPS proxy) showed the image 10s+ later. Server-side serving was fast (45-76ms for /comfy/view including .zenc openssl decrypt at 50k PBKDF2 iters; history 121ms).
- Root cause: `proxy_websocket_to_comfy` in `/Users/liam/comfy/z-image-api/app.py` set both sockets non-blocking and then called `sendall()` in a select loop. When the remote client couldn't drain Comfy's binary latent-preview frames fast enough, sendall raised BlockingIOError mid-frame (or wrote a partial frame, desyncing the WebSocket stream) and killed the tunnel mid-generation - visible as `proxy error: read ECONNRESET` in z-image-tailscale-https-proxy.log. The browser missed the `executed` event and fell back to the 2s queue poll + history fetch + reconnect churn.
- Also: the upstream socket kept create_connection's 10s timeout, so idle tunnels could die.
- Fix: relay the handshake until the full header terminator, then two blocking pump threads with timeouts cleared; blocking sendall applies backpressure instead of dying. Verified through the real relay: cold run `executed` arrived at completion (9.37s = model load + gen), warm run 3.26s from queue POST to `executed` (pure generation time, zero relay overhead).
- z-image-api is NOT under git version control; this fix exists only in the working tree.

Implication:

- A 35-46s 528x368 run is not expected on the current direct Comfy path unless something outside the saved graph is changing the prompt, invalidating graph cache, adding a reference image, running another heavy job concurrently, or using a different server/process than the supervised ASFP8 lane.
- At this resolution/settings, the remaining quality-preserving speed target is KSampler/denoise. Rebalancer and prompt helper are confirmed tiny in this benchmark.

## Open Hypotheses Worth Testing

Potential next experiments that preserve 960x1440, 10 steps, and model quality:

- Tune the native `er_sde` experiment only if there is a specific quality target. A first deterministic ER-SDE-style adapter exists, but it is not faster at equal steps.
- Try fewer-step `er_sde` only as a separate quality experiment. It may be useful if it preserves quality at fewer steps, but equal-step speed is not better.
- Add richer sampler controls only after a sampler beats or clearly complements `flow_euler`; avoid cluttering the workflow with unproven knobs.
- Investigate whether MLX has a lower-overhead compiled loop for the full denoise sequence, not only `forward_prepared_vectors` per step.
- Compile or specialize the whole denoise function for fixed shape `(960, 1440, 10)` if MLX can capture the transformer module safely without uncaptured-input errors.
- Profile individual transformer block costs with coarse synchronization every N blocks to see whether attention, MLP, RMSNorm, or modulation dominates.
- Profile one target-resolution denoise step with intra-block synchronization to separate fused qkvgate, q/k norm, RoPE, scaled dot-product attention, output projection, and MLP cost. This is diagnostic only; do not compare its absolute time to normal unsynchronized runs.
- Confirmed diagnostic profile at 960x1440 target shape, one warmed forward, uncompiled and synchronized inside blocks: MLP total was about 5.4s, attention total about 4.7s, qkvgate about 1.5s, SDPA about 1.1s, RoPE about 0.8s. Broadly, the cost is the main transformer matmuls/attention over 5912 tokens, not text encode, VAE, or workflow plumbing.
- Test whether shape-specific resolution buckets with fewer image tokens but equivalent final upscaling can preserve quality better than lowering steps. This is not a first choice because the user does not want quality degradation.
- Explore MLX Metal captures for the denoise pass to identify kernel stalls or unexpected CPU sync points.
- Investigate LoRA adapter overhead separately. Existing logs show one LoRA can push generate time into about 80-116s and two LoRAs to about 130s.
- For standard LoRAs, investigate adapter fusion or pre-packed multi-adapter projections without dequantizing/replacing the MXFP8 base weights.
- If revisiting progressive latent, test it as an explicit opt-in turbo mode only. The first viable speed setting hit near-target runtime but failed visual QA; the next attempt should focus on artifact-free latent resize/timestep handoff, not just lower token counts.
- Extend the Krea focus guard only if measured contention remains. The current implementation handles idle sibling Comfy lanes; additional candidates like Flux2Server, Open Generative AI, or desktop screen-sharing processes need explicit evidence and safer active-job detection before pausing.

## Benchmark Rules

Use the same comparison setup unless explicitly testing another axis:

- Resolution: 960x1440
- Steps: 10
- LoRA: disabled for baseline unless testing LoRA overhead
- Seed: `794015397137290`
- Prompt: saved prompt in `Krea2 Red Mix SeedVR2 Apple Silicon.json`
- Report:
  - wall time
  - sidecar `timings.generate`
  - profile stages if `KREA2_MLX_PROFILE_STAGES=1`
  - sidecar fast-path report
  - whether run was cold or warm

## Useful Environment Flags

- `KREA2_MLX_PROFILE_STAGES=1`: opt-in stage profiling; slower because it synchronizes stage boundaries.
- `KREA2_MLX_STEP_TIMINGS=1`: opt-in per-step timings; slower because it synchronizes every step.
- `KREA2_MLX_EVAL_EACH_STEP=1`: old forced sync behavior; use only for debugging.
- `KREA2_MLX_ACTIVATION_DTYPE=bf16`: default and fastest confirmed safe activation dtype.
- `KREA2_MLX_ACTIVATION_DTYPE=fp16`: available for testing; slower in current benchmark.
- `KREA2_MLX_RECYCLE_SIDECAR_AFTER_RUN=1`: default to avoid warm-run drift.
- `KREA2_MLX_BACKGROUND_SIDECAR=1`: opt into background scheduling; default is foreground because background scheduling was a suspected slowdown.
- `KREA2_MLX_FOCUS_MODE=1`: default focus guard around native Krea2 generation.
- `KREA2_MLX_FOCUS_PAUSE_PORTS=8198`: space- or comma-separated local Comfy ports to pause only when their `/queue` endpoint is idle.
- `KREA2_MLX_FOCUS_PAUSE_RAW_PORTS=`: opt-in diagnostic only. Space- or comma-separated raw listener ports to pause without Comfy queue checks. Default is empty because pausing port `8787` trips the stack supervisor health check.
- `KREA2_MLX_ROPE_PRECISION=fp32`: default and fastest confirmed RoPE path. `native` is available as a diagnostic flag only and was slower in target testing.
