# Mix-Studio → Hivemind Content Studio assimilation plan

Source: [BlackMixture/Mix-Studio](https://github.com/BlackMixture/Mix-Studio) (GPL-3.0), inert clone audited at
`~/.codex/hive-assimilate/candidates/BlackMixture-Mix-Studio` (audit: REVIEW — findings were all vendored
minified lottie `eval` patterns; app source is clean). Donor is a zero-dependency Node server that builds
ComfyUI API graphs server-side + a vanilla-JS frontend, in daily production use by Black Mixture.

## License verdict

Every Mix-Studio feature is commercially permissible. GPL-3.0 permits commercial use; its condition is
copyleft on distribution, not a commercial ban. This repo is already **public AGPL-3.0-or-later**
(see THIRD_PARTY_NOTICES.md — forced by the Auto Clipper donor), and GPLv3 §13 explicitly allows combining
GPLv3 code with AGPLv3 works. So we may copy/adapt/translate donor **code**, not just ideas. Obligations:
preserve copyright/provenance notices (kept in THIRD_PARTY_NOTICES.md + per-file headers) and keep the
combined work AGPL-compliant on distribution — already our posture.

## Gap matrix (Mix-Studio feature → our status → action)

Verdicts from a full sweep of both codebases (2026-08-10; see ASSIMILATION_LOG.md).

### Already covered (no action, or trivial deltas)
- Krea 2 t2i + identity edit, Flux 2 Klein edit, Qwen/Anima lanes, LTX 2.3 family (9+ registry variants),
  MiniMax H3 (text/i2v/reference-9-refs/turbo/long-context via the same pinned Motion Context node),
  10Eros, upscale route (fast/max), LoRA groups + sealed prompt library, drag-to-restore settings,
  queue progress + ETA + cancellation, camera/lens body+lens prompt controls, head swap (they don't have it),
  ingredients contact sheet (they don't have it), E2E-sealed media (they have plaintext + PIN folders).

### Phase 1 — pure/low-risk lifts (THIS PASS)
| Feature | Donor source | Target | Reuse type |
| --- | --- | --- | --- |
| Camera **motion** presets (24 descriptors, idempotent phrase composer) | `public/camera-motion.js` (pure) + `test/camera-motion.test.js` | `src/lib/cameraMotion.js` + tests + Video studio composer | adapted_code |
| Upscale **compare viewer** (synced zoom/pan + reveal divider + pinch/keys) | `public/app.js` L28757–29003 + `style.css` L9212–9390 | React `CompareViewer` + `src/lib/compareMath.js`; upscale entries gain `sourceUrl` | adapted_code |
| **PWA** (manifest, nav-only service worker, offline page, install prompt) | `public/pwa.js`, `service-worker.js`, `manifest.webmanifest`, `offline.html` | `packages/open-generative-ai/public/` + registration | adapted_code |
| **Strength Hunt** core (axes plan 0→max step .2, content-hash graph merge into ONE Comfy job, labeled sheet layout) | `lib/strength-hunt.js` (fully standalone, 481 lines) + `test/strength-hunt.test.js` | `packages/media-gateway/strength_hunt.py` (PIL sheet, not their JS PNG codec) + pytest | translated_code |

> **Status 2026-08-10:** Phase 1 fully landed + verified. From Phase 2, also landed the same
> day: Strength Hunt UI (LoRA hunt-axis toggle → generate → bridge), Style Preset fix, Batch
> Count fix (sequential, seed+shot), outpaint route (`run_comfy_krea2_outpaint`) + Expand
> dialog, the **mask/inpaint feature end-to-end** (`build_krea2_turbo_inpaint_prompt` +
> `run_comfy_krea2_inpaint` + "Edit area" brush dialog), and **angle variations + edit
> sequences** ("Angles"/"Steps" viewer actions, client-orchestrated on the live Klein/Qwen
> edit lanes — one real angle render verified end-to-end). **RIFE and the chain join landed
> later the same day**: proper RIFE (Practical-RIFE 4.25, Apple-MLX port vendored at
> `packages/media-gateway/vendor/rife-mlx`) as a lane-agnostic post-process
> (`POST /api/interpolate` + "Smooth 2×"), and the chained-episode join as a client-only
> mediabunny packet-copy concat ("Join N shots" — clips never leave the device).
> **Live E2E complete (same evening):** stack restarted at idle; all four routes proven on
> real hardware (RIFE 2.24s · Strength Hunt 4/4 + sheet · outpaint 139s · inpaint 71s), plus
> outpaint placement anchors (offset_x/y, live-proven) and the six H3 restyle presets landed.
>
> **Phase 2 closed out 2026-08-11** (verified by inspection, not recall): the H3 reference-mode
> UI shipped (`ReferencesMenu.jsx` — 9 images / 3 videos / 3 audio clips, kinds mixing freely),
> and **SAM3 smart-select landed 2026-08-11**, which closes Phase 2 entirely.
> SAM3 runs LOCALLY on this Mac: `PozzettiAndrea/ComfyUI-SAM3` pinned at
> `de0ff5d`, installed WITHOUT its comfy-env/pixi installer (our own V3
> `comfy_entrypoint`) and with three MPS-unimplemented `torch._assert_async`
> calls asserted on CPU copies. No dependency changes — the pack vendors its own
> SAM3 rather than using `transformers.models.sam3`. Donor's `buildSam3MaskGraph`
> is translated in `packages/media-gateway/smart_mask.py`; the mask leaves via
> PreviewImage (SaveImage output would be sealed by the sweeper), returns inline,
> and is never written to history. Live: text 4.1s, tap 2.1s, correct silhouettes.
>
> Chaining also went well past the donor after a run of real-use bug reports: the pinned frames
> carry motion but NOT the scene (live-proven on the rental), so `armChainPrompt` keeps the
> scene description in the composer, the prompt helper is continuation-aware
> (`isContinuation` + `previousPrompt`), and the episode now has a **scene timeline** — ordered
> shot tiles, drop-a-shot, per-shot export, and the joined cut as an animated final tile that is
> saved back as a first-class sealed output (`POST /api/episode`). The donor has none of this;
> its join was a server-side ffmpeg concat with no timeline.
>
> **Phases 3 and 4 are NOT started** — confirmed by grep: no SAM3, Ideogram4PromptBuilderKJ,
> Krea2RegionalMultiLoRA, DepthAnything, WanAnimate, SCAIL, LTXDirector, prompt-preset-pack or
> queue-health anywhere in the tree.

### Phase 2 — high-value, moderate effort (NEXT)
- **Mask/inpaint UI + soft-inpaint graphs**: donor `lib/edit-mask.js` (pure, 168 lines) + `mask-boxes.js` (pure)
  + brush canvas. The load-bearing trick: flow/DiT models (Krea2/Flux/Qwen) must use
  `VAEEncode` + `SetLatentNoiseMask` + `ImageCompositeMasked` — `VAEEncodeForInpaint` reproduces grey.
  Gateway already has `noise_mask` in `krea2_identity_workflow.py`; needs route + React mask canvas.
  SAM3 text/point smart-select is a follow-on (needs `pozzettiandrea/comfyui-sam3`, pin the sha).
- **Outpaint route + UI**: we already have `build_krea2_turbo_outpaint_prompt` (internal, LTX anchor prep).
  Donor adds: `calculateNativeOutpaintPlan` geometry (pure — working canvas ≤2MP, final ≤32MP, /16 snap,
  scaled final placement), green-screen source strategy for Klein/Qwen, organic preserve mask +
  `ColorMatch{hm-mvgd-hm, .82}` exactly once, source-pixel compositing.
- **RIFE interpolation**: donor `rifeSmooth()` — one optional `RIFE VFI` stage (ComfyUI-Frame-Interpolation,
  prefer `rife49.pth`, multiplier=smooth, ensemble on) before video save + `extensionPlaybackPlan` fps math.
  Add as optional param on video workflows (MCP + registry), pin the node sha for rental lanes.
- **Chained-clip MP4 join**: donor `video-extension-join.js` (pure ffmpeg arg builders — `videoShape`
  normalize, N-chunk `trim=end_frame=keepFrames`, audio normalize/silence-pad, `-crf 18 +faststart`).
  Wire onto our H3 motion-context chains ("join all shots" action) via `assembly.py` conventions.
- **Wire the two dead Image-studio controls**: Batch Count (never sent) and Style Preset (never read) —
  batch via gateway `batch_size` + multi-output collection (use `existing_output_path()`; sweeper race),
  style presets subsumed by Mix Packs below.
- **Edit angle variation** (`lib/edit-angle.js`, pure 77 lines): 8 azimuth × 4 elevation × 3 distance
  grouped variants; Qwen gets trigger-token dialect, Klein natural-language (anti-collage clauses).
- **Edit sequence mode** (`lib/edit-sequence.js` + server chain): output N feeds step N+1 as ref, seed+1.
- **H3 UX ports our backend already supports**: reference-mode UI (ours is MCP-only today!), first/last
  frame swap, restyle presets (live action/anime/cinematic-3D/cel-3D/max-detail), Match-video-aspect.

### Phase 3 — new model families / custom-node-heavy (LATER, per-lane installs must be pinned)
- ~~**Regional multi-box prompting**~~ — **language half LANDED 2026-08-11**, graph half deferred.
  Node audit against the live ComfyUI (`/object_info`, 2494 nodes): `Ideogram4PromptBuilderKJ` **is**
  installed (and already carries `elements_data` + the slot-2 `bboxes` output the donor describes), but
  `Krea2RegionalMultiLoRAV3` (Fedor pack) is **not**, so their regional graph cannot run here at all.
  Their own comment is the way through: the regional node only masks LoRA/reference deltas, so for
  description-only regions it is the spatial LANGUAGE in the caption that pins placement. That half is
  pure text — it needs no node and therefore works on **every** image model we serve, local or cloud.
  Shipped: `src/lib/regionPrompt.js` (their `normalizeRegions`/`positionPhrase`/`elementDesc`, made
  idempotent so a restored generation does not re-append its own sentences) +
  `src/studios/image/RegionBoxEditor.jsx` (drag/click to place, drag to move, corner to resize, one row
  per region showing the exact phrase it contributes) + 9 tests. Region text is prompt content, so it is
  session-only and rides in the sealed per-generation context; only the toggle persists.
  Still to do if the Fedor pack ever lands: `addRegionalPrompting` / `buildRegionalT2IGraph` /
  `buildKrea2InpaintGraph`, i.e. per-region LoRA and reference-image masking. Their two traps stand —
  bboxes must come from the prompt builder's slot 2 (raw dict arrays fail API-format validation), and
  region colors must NEVER go out as `palette` (Krea2 paints literal swatches). Donor hand-patched
  KJNodes `ideogram4_nodes.py`; verify upstream before pinning.
  Our couple-mode (2 regions, H/V split) stays as the simple path; regions stand down while it is on.
- **Depth guidance**: Depth Anything V3 Large → Krea 2 Control LoRA (opt-in Create guidance).
- **Wan Animate 2**: `lib/wan-animate2-workflow.js` (standalone; 81 frames, 6 steps, lcm, shift 5,
  `WanAnimate2Cache{cpu,int8}`; weights: wan_animate_2_int8_convrot + lightx2v rank64 + umt5_xxl fp8 +
  clip_vision_h + Wan2_1_VAE). Needs a Wan lane in the gateway first (Wan is Electron-only today).
- **SCAIL 2 motion transfer**: chunked (81f, 5/13-overlap) SAM3 track → `WanSCAILToVideo`; embedded in
  donor server.js, NOT cleanly liftable — port the *plan* (`lib/video-workflows.js` L26–34, 545–620) and
  rebuild graphs our way.
- **LTX Director** (Extend/Keyframes/Timeline) — **node INSTALLED + timeline model LANDED 2026-08-11;
  graph builder BLOCKED ON WEIGHTS.**
  Node pack: `WhatDreamsCost/WhatDreamsCost-ComfyUI` (GPL-3.0) pinned `d6495f50926ab245a0b96f76ef6b89de40d19f6e`,
  installed at `~/comfy/ComfyUI/custom_nodes/WhatDreamsCost-ComfyUI`. All 9 nodes register
  (`object_info` 2494 → 2503). No pip installs needed — `av`/`cv2`/`PIL`/`aiohttp` were already in the
  ComfyUI venv — and no CUDA-only ops, so it is MPS-clean.
  **Installed as a pinned fork with security deltas** (`_hivemind_paths.py` documents them + rollback):
  at this revision `load_video_ui.py` registers two unauthenticated routes with NO path sanitization —
  `GET /video_ui_custom_view` is an arbitrary file read (`web.FileResponse` of the raw query param) and
  `POST /video_ui_upload_chunk` an arbitrary write. Their own newer upload route sanitizes correctly, so
  this is drift, not design. Both confined to ComfyUI's media dirs, likewise `/ltx_director_check_file`
  and `/ltx_director_get_audio`; `/ltx_director_open_folder` (opened Finder on the host) now 403s.
  Loader note: ComfyUI checks `NODE_CLASS_MAPPINGS` *before* `comfy_entrypoint` and returns early, so the
  pack's half-finished V3 entrypoint — it lists `LTXDirectorGuide`, which has no `GET_SCHEMA`, and omits
  `LTXDirectorCropGuides` — is never called and cannot break the load.
  Shipped: `packages/media-gateway/ltx_director_timeline.py` + 18 tests — one validated model for all
  three modes; 24 fps grid; 20s render window; `local_prompts` `' | '`-joined; `segment_lengths` that
  partition the window (gaps absorbed by the preceding prompt, never left as holes); output frames forced
  to 8n+1; window re-basing that advances media trims. Added `director_missing_assets()` so a missing file
  is named up front instead of failing mid-sample. Their `extensionSource {itemId, videoId}` form points
  into a plaintext media library we do not have, so only the input-file form is accepted.
  Graph builder shipped too: `packages/media-gateway/ltx_director_graph.py` + 13 tests, `/api/ltx-director`
  route, bridge passthrough, allowlist entry, client method.
  **Weights fetched 2026-08-11** (~40 GB): `ltx-2.3-22b-dev-fp8.safetensors` (27.1 GB) and
  `gemma_3_12B_it_fp8_scaled.safetensors` (12.3 GB) — the donor pins the fp4_mixed encoder, an NVIDIA
  quantisation this Mac cannot run. MLX weights are NOT substitutable: the MLX transformer is MLX
  block-quantised (U32 + `.scales`/`.biases`), diffusers-keyed and transformer-only.
  **LIVE-VERIFIED 2026-08-11 — video yes, audio NO.** A 2-segment 3s window rendered in 381s cold:
  73 frames at 704x384, i.e. exactly the 8n+1 lattice the timeline model predicts, with no extra frames —
  which is the proof `LTXDirectorCropGuides` stripped the guide frames instead of baking them in. Output
  sealed to the owner vault as expected. QA copies were taken through ComfyUI's temp dir (the sweeper
  ignores it, same trick as smart-select) because the server cannot read its own sealed output.
  **The audio track decodes to digital silence** (peak 1/32767, -91 dB, correct 48 kHz stereo 3.05 s
  shape). **NOT our port — reproduced with the stock reference graph.** Five configurations were measured
  and every one produced a BYTE-IDENTICAL 27,415-byte silent FLAC:
    1. Director graph, audio decoded after the base pass
    2. Director graph, after the refine pass
    3. the eros AV reference structure (`workflows/ltx23-eros-v14.api.json`) rebuilt on this checkpoint,
       no Director nodes at all, distilled LoRA 0.5, 8 steps
    4. same, WITHOUT the distilled LoRA
    5. same, LoRA 0.5, 20 steps
  Identical output across graph structure, LoRA presence, step count and prompt means the audio half of
  the nested latent is never modified by sampling — the decoder always sees zeros.
  Ruled out: our wiring (node-for-node faithful to the donor); `LTXVConcatAVLatent` mask semantics (an
  unmasked audio latent is filled `ones_like` = generate); `comfy.sample.prepare_noise` (it unbinds nested
  AV latents and noises each part); `LTXVSeparateAVLatent` (unbinds and takes index 1 correctly);
  the checkpoint (4,728 audio tensors in the transformer, incl. `scale_shift_table_a2v_ca_audio`, plus
  `audio_vae` + `vocoder`); the audio VAE (loads and decodes with no missing-key warnings);
  `LTXAVModel.forward` (accepts the combined AV tensor and derives `a_timestep`).
  **ROOT CAUSE FOUND 2026-08-20 — it is MPS, not the model, the config or our port.** The identical
  control graph was run on a rented RTX A6000 (Vast, ~$3 of credit) at the SAME ComfyUI commit
  (2a0e30e9) with the SAME weights (both sha256-verified byte-identical to the local copies) and the
  same prompt/seed/steps. Only the platform differed:
    Mac (MPS):   peak 1/32767, rms 0.1, 0.6% non-zero,   27,415-byte FLAC  -> silence
    A6000 (CUDA): peak 11,998,  rms 3,216, 100% non-zero, 316,330-byte FLAC -> real audio
  LTX 2.3 joint audio-video generation is therefore broken on Apple Silicon and correct on CUDA. This
  applies to EVERY LTX 2.3 AV path through ComfyUI on this Mac, not just Director. It also means LTX
  Director is fully usable today through the rental lane, which already stocks both weights in R2.
  CUDA render was also 4-5x faster: 42s vs 170-210s for the same 73-frame control.
  **Remaining:** the multi-track timeline UI. Audio on Apple Silicon is an upstream MPS defect,
  not something this port can fix — render LTX Director on a rental when the clip needs sound.

### Phase 4 — library/ops, needs privacy-aware redesign (their design assumes plaintext server storage)
- Library search / folders / user groups / trash-with-recovery / ZIP export: rebuild client-side over
  sealed metadata (decrypt in browser, zip in browser); trash must not fight the E2E sweeper.
- Mix Packs / visual prompt-preset packs: donor's single-JSON pack format (`mix-studio.prompt-preset-pack`,
  embedded base64 thumbs, two-phase inspect→confirm install, content-hash asset URLs, and the
  "preset recorded only if `prompt.includes(promptText)`" trust rule) is worth keeping verbatim;
  storage moves into our sealed named-libraries system.
- Queue-health stall detection (`lib/queue-health.js`, pure): GPU util ≥15% active; >5min job + ≤5% util
  for 90s ⇒ "possibly stalled"; wire into Telemetry/Machines with our rental-lane GPU stats.
- Mobile preview proxy pipeline (480/640/720p cached silent proxies, one-decoder-at-a-time) — relevant
  if History grids grow; adapt ideas to sealed media (proxies must be sealed too).

### Explicitly NOT assimilated (with reason)
- Their installer/updater/model-downloader/ComfyUI-discovery stack — we have zimage-stack + Models route.
- Profiles/PIN system — we have the owner vault + E2E envelope; theirs is cookie+scrypt over plaintext.
- External LLM provider (OpenAI/Gemini keys) for prompt AI — conflicts with local-first posture; ours is
  the app-spawned llama-server. Revisit only on explicit request.
- Their per-node EMA ETA (`progress-eta.js`) — we already ship a monotonic ETA with persisted timing
  stores; theirs is stateless per-run. Noted as a fallback for cold-start models.
- Gemini Spark MCP bridge (deferred upstream too); analytics.js; lottie vendor.

## Donor gotchas imported (from their AGENTS.md — hard-won, applies to our graphs too)
- V3 DynamicCombo inputs must serialize FLAT (`'sampling_mode.temperature': 0.7` dot-keys).
- Literal arrays in API graphs are treated as node LINKS — never pass arrays as widget values.
- libx264 needs even dims; MP4 `tkhd` lies about phone rotation — resize decoded frames in-graph.
- `[Errno 22]` on KSampler = ComfyUI stderr pipe death (tqdm→wandb), not a graph bug.
- PNG outputs embed the full graph in tEXt — disaster recovery source (NB: our privacy redaction differs).
- ComfyUI model dims can lie; store actual output dims, not requested.

## Verification contract per phase
Frontend: `node --test 'tests/*.test.js'` (baseline 2026-08-10: 274 tests, 5 pre-existing fails, all in
`hivemindStudioReferences.test.js`) + `vite:build` + browser verify via vite dev :5273 + stubs
(owner gate stays closed in dev). Gateway: pytest on touched modules (worktree baseline doc lists known
pre-existing fails). Live Comfy verification (strength hunt end-to-end, RIFE) needs a lane up — tracked
per-feature in ASSIMILATION_LOG.md when deferred.
