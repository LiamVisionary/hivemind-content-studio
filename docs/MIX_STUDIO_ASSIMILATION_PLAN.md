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
> edit lanes — one real angle render verified end-to-end). Deferred with recorded reasons:
> RIFE (per-lane node pinning + no Comfy path on the native MLX lane), chained-clip MP4 join
> (clips are E2E-sealed before a join could run — needs client-side WebCodecs/ffmpeg.wasm or
> a pre-seal hook; architecture decision), SAM3 smart-select (custom node install). Still
> open: H3 reference-mode UI, outpaint position/scale controls.

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
- **Regional multi-box prompting**: `lib/regional-workflows.js` (liftable) + region-box canvas UI.
  Nodes: `Ideogram4PromptBuilderKJ` (bboxes from OUTPUT SLOT 2 — the JSON-string `elements_data` is the
  only box source that survives API-format validation) + `Krea2RegionalMultiLoRAV3` (Fedor pack;
  NB donor hand-patched KJNodes `ideogram4_nodes.py` — verify upstream before pinning). Keep their
  `positionPhrase()` centroid→language trick and NEVER send region colors as `palette` (paints swatches).
  Our couple-mode (2 regions, H/V split) stays as the simple path.
- **Depth guidance**: Depth Anything V3 Large → Krea 2 Control LoRA (opt-in Create guidance).
- **Wan Animate 2**: `lib/wan-animate2-workflow.js` (standalone; 81 frames, 6 steps, lcm, shift 5,
  `WanAnimate2Cache{cpu,int8}`; weights: wan_animate_2_int8_convrot + lightx2v rank64 + umt5_xxl fp8 +
  clip_vision_h + Wan2_1_VAE). Needs a Wan lane in the gateway first (Wan is Electron-only today).
- **SCAIL 2 motion transfer**: chunked (81f, 5/13-overlap) SAM3 track → `WanSCAILToVideo`; embedded in
  donor server.js, NOT cleanly liftable — port the *plan* (`lib/video-workflows.js` L26–34, 545–620) and
  rebuild graphs our way.
- **LTX Director** (Extend/Keyframes/Timeline): normalization half of `lib/ltx-director-workflows.js`
  (L1–330) is a pure timeline validator worth lifting even before the `LTXDirector` node lands; one data
  model for all three modes; 20s render window; local_prompts `' | '`-joined; frames forced to 8n+1.

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
