# gpu-rentals — provisioned ComfyUI rentals (RunComfy-style)

Hourly, per-customer GPU instances preloaded with the studio's models
(Krea2, WAI Anima, LTX 2.3 eros 1.4 DMD), provisioned on **Vast.ai**
datacenter/verified offers. Provider decision and margin analysis: see the
2026-07-29 research summary (conversation) — short version: Vast is the price
leader AND the only major dedicated-pod provider whose ToS doesn't list adult
content as unauthorized (RunPod's does, which disqualifies it for the eros
tiers).

## Economics (July 2026)

| Tier | GPU | Vast cost/hr | Retail benchmark (RunComfy) | Gross margin |
|---|---|---|---|---|
| image | RTX 4090 24GB | ~$0.25–0.35 | $1.75 (24GB tier) | ~80% |
| image-fast / video | RTX 5090 32GB | ~$0.30–0.45 | — | price at ~$1.90 |
| video-comfort | A6000 48GB | ~$0.40 | $2.50 (48GB tier) | ~84% |

Margin killers to watch: warm-pool idle burn, per-host bandwidth charges
(video egress), storage for the model volume. Weights ship from a private
Cloudflare R2 bucket (zero egress) — never from Civitai/HF at boot.

## Files

- `models.manifest.json` — the serving set: what's already on the Mac, what
  must be re-downloaded (LTX fp8 + eros v1.4 are incomplete/missing locally —
  production video runs MLX builds that do not port), what needs CUDA
  verification (convrot int8mixed quants).
- `provisioning/comfyui-hivemind.sh` — boots inside the Vast ComfyUI template
  (`PROVISIONING_SCRIPT` contract); idempotent model pull from R2.
- `provisioning/hivemind_privacy.py` — the privacy custom node every rented box
  runs: prompt-graph redaction on `/history` and **every** queue accessor, the
  `POST /hivemind/scrub-files` route the gateway calls after requester-sealed
  harvest, and optional `HIVEMIND_LANE_TOKEN` auth. Canonical copy; the
  template script above embeds it verbatim (a test asserts the two match) and
  `gpu_rentals._onstart_script` embeds it for Machines-UI boots, where
  provisioning refuses to report `ready` until the scrub route answers.
- `scripts/vast-search.sh` — find datacenter/verified offers per tier.
- `scripts/vast-rent.sh` — create an instance from an offer id.
- `scripts/upload-models-r2.sh` — one-time weight sync Mac → R2.
- `EMAIL-vast-resale-terms.md` — draft inquiry; get written resale + adult
  content confirmation from Vast BEFORE launch (their "service bureau" clause
  is gray for platforms).

## Bring-up order (blockers first)

1. **Vast account + API key** (human step — needs payment method):
   create at cloud.vast.ai, then `pip install vastai` and
   `hive-env-add VAST_API_KEY=...` so every machine can provision.
2. **Send the resale-terms email** (EMAIL-vast-resale-terms.md).
3. **R2 bucket: DONE + FULLY STOCKED 2026-07-30** — `hivemind-rental-models`
   holds all 17 serving artifacts (~112G: both Krea2 quants, WAI Anima set,
   both LTX checkpoints, DMD + Crisp LoRAs, encoders, VAEs, upscalers);
   `upload-models-r2.sh` ran clean, zero errors. S3 creds derive from the
   hive env's Cloudflare API token (access key = token id, secret = sha256
   of the token value — no separate R2 keys needed for rclone).
4. **Downloads: DONE.** eros v1.4 full checkpoint (27.2G) local +
   SHA256-verified; the v1.4 **DMD LoRA** is local at
   `mlx-models/source/eros-dmd-lora/` (production fuses it into the MLX q8
   transformer, which is why it's absent from ComfyUI/models/loras); on CUDA
   it applies as a normal LoRA — v1.4 has near-zero anatomy without it.
   LTX 2.3 22B dev fp8 base (27.1G) is **in R2 only** — relayed straight
   HF→R2 (`scripts/relay-url-to-r2.py`: 256M ranged GETs → multipart,
   inline SHA256) because the Mac's disk is 98% full. Mind that constraint
   before pulling anything else big locally.
5. **Lock workflow exports**: the CUDA image needs API-format workflow JSONs +
   their custom-node list. Image workflows: `ComfyUI/workflows/auto/`. Video
   workflows live in the media-gateway MCP's built-in registry — export, then
   fill the `NODES` array in the provisioning script and the Krea2 text-encoder
   entry in the manifest.
6. **First boot: VIDEO VALIDATED 2026-07-31** — RTX 5090 ($0.402/hr, total
   test cost $0.28): R2 presigned pulls at ~45MB/s, ComfyUI 0.29 **native**
   LTX-2.3 nodes, 768×512/97f/20-step t2v in ~60s warm. Validated graph:
   `workflows/ltx23_t2v_validated.py` (LTX-2.3 needs the AV-latent path —
   empty audio latent from the ckpt-bundled audio VAE, concat before / separate
   after sampling; the Gemma loader wants both the encoder AND the ckpt).
   Gotcha: the vastai/comfy image's supervisor doesn't auto-start under bare
   `--image` — seed lives at /opt/workspace-internal/ComfyUI, venv at
   /venv/main; launch manually or use their full template env.
7. **ALL THREE TIERS VALIDATED 2026-07-31** (second 5090, ~$0.35): Krea2
   convrot int8 / WAI Anima 8s / eros v1.4+DMD video 48s — all visually
   verified. Full graphs: `workflows/tier_validation_suite.py`.
   **Krea2 tuning sweep (fourth 5090, 8-step deis, 5 configs, 2026-07-31):**
   steady state at 1024² is **2.8s for ANY prompt** on STOCK settings — the
   13.7s "new-prompt penalty" was a first-2-3-jobs transient (Comfy's smart
   memory settles with quant+encoder resident at ~21GB), not a per-prompt tax.
   Rental image recipe: stock memory flags + a boot WARMUP (2-3 dummy gens,
   2 different prompts, per res tier) so customers never see the transient.
   **Do NOT use --highvram**: OOMs the convrot loader on 32GB. `--fast`: no
   measurable gain. torch.compile (TorchCompileModel/inductor on the INT8
   model): steady 2.4s (~15% faster) but 90-140s recompile per NEW resolution
   and ~140-220s first warmup — only worth it for fixed-resolution lanes.
   2048² native: ~22-32s. Cold first-gen after boot: 25-41s (page-cache
   dependent). Floor is ~8 INT8 DiT evals + VAE decode; further gains are
   step-count (quality tradeoff) or batching (throughput), not config.
   Facts: stock ComfyUI 0.29 has CLIPLoader type **krea2** (no fork needed);
   convrot needs only the public ComfyUI-INT8-Fast node (CUDA-native);
   Krea2 = Qwen-Image family (qwen3VL4BAbliterated encoder + qwen_image_vae);
   eros v1.4 bundles its own audio VAE; DMD sampling = 8 steps cfg 1.
   REMAINING for product: resale-terms email, template-ize the provisioning
   (their full env contract, not bare --image), metering layer. Per-instance
   token auth is DONE: the hivemind_privacy custom node (installed by
   provisioning) guards every :8188 request — websocket included — with
   `Authorization: Bearer $HIVEMIND_LANE_TOKEN` when that env var is set on
   the instance (in-process aiohttp middleware, no extra proxy service).
7. **Then** the product layer: start/stop API, per-second metering, customer
   storage.
8. **Studio UI shipped 2026-08-05**: owner-gated "Machines" hub view in the
   OpenGen app (System section) → `/api/gpu-rentals*` on control_api →
   `src/hivemind_content_studio/gpu_rentals.py` (direct Vast API on the
   owner's account, tier presets from this package, R2-presigned onstart
   provisioning, destroy refuses non-`hivemind-studio-gpur-*` labels so the
   billing gateway's instances stay safe). Tests:
   `test/studio/test_gpu_rentals_api.py`. The customer-facing UI in the
   hivemindos app (billing-gateway routes) is still to build.
9. **Remote-lane attach LIVE + E2E-verified 2026-08-06**: the branch lane
   contract is merged into media-gateway (131 tests); "Attach to studios" on
   a ready machine spawns a detached SSH tunnel (proxy ssh fallback for
   API-created instances), writes `~/.hivemindos/media-studio/rental-lanes.env`
   (folded into COMFY_LANES/RULES/REMOTE_LANES by the stack launcher; rental
   rules win), restarts the stack, and the machine's models route to the box
   with requester-sealed fetch-back. Live proof: rent→ready 9.5 min,
   attach 53s, krea2 gen 46s round-trip landing as `hivemind_remote` sealed
   outputs; detach/destroy tear everything down. Ops rule: pre-validate every
   tier's R2 keys with RANGED GETs (HEAD 403s on GET-signed URLs) — use
   the check in the E2E driver.
10. **Studio "Rented" source (2026-08-06)**: both studios always show
    **Local | ☁ API | Rented** — never conditionally hidden. Rented carries
    three states (`src/studios/RentedSourceStatus.jsx`): a live machine
    ("N online, ~$X/hr"), one coming online (phase + model count + View
    Machines), or none (a "Rent a machine" CTA into the Machines view).
    With no machine, the settings panel COLLAPSES to the Source block + CTA
    (model/format/advanced/LoRA and the composer's model pill are hidden, and
    Generate is disabled) — no controls for compute that cannot run.
    `generate()` in both studios also REFUSES when Rented is selected and no
    live machine serves the model, so the source toggle can never silently
    fall back to the local GPU. Video routes through the first-class
    `ltx23-eros-v14-comfy` registry workflow (referencing exactly the files
    the video tier provisions), not a special case.

## Privacy posture (disclose in the product)

A rented GPU box is NOT the home E2E stack: **while a job runs, the customer's
prompt and pixels exist in plaintext on the instance** (the GPU has to read
them — this is inherent, not a bug to fix). The security contract covers
everything before submit and after harvest; do not market rentals under the
local stack's E2E guarantees.

Mitigations shipped here, on the box (provisioning):
- `--disable-metadata`: no workflow/prompt embedded in output files.
- `COMFY_PRIVATE_HISTORY_PROMPTS` (default ON for rentals, via the
  hivemind_privacy custom node): prompt graphs are redacted from `/history`
  and `/queue` responses even mid-run; encrypted workflow envelopes survive.
- `POST /hivemind/scrub-files`: gateway-driven deletion of a prompt's output
  and staged input files immediately after harvest.
- `HIVEMIND_LANE_TOKEN`: per-instance bearer-token auth on all of :8188.
- Datacenter/verified hosts only; ephemeral disks torn down with the instance.

And on the gateway side (media-gateway remote Comfy lanes, `COMFY_LANES` +
`COMFY_REMOTE_LANES` + `COMFY_LANE_TOKENS`):
- Remote lanes are reachable only over an authenticated channel: a per-lane
  bearer token, or an SSH tunnel (loopback lane declared in
  `COMFY_REMOTE_LANES`). Unauthenticated off-host lanes are refused at submit.
- Results are fetched back over the lane's `/view` and sealed to the
  REQUESTING client's public key (`X-E2E-Requester-Pub`, owner vault key as
  fallback) before anything persists — no plaintext remote result ever lands
  in a shared output dir, and nothing colocated with the gateway can decrypt
  another requester's outputs. Possession of the decrypt key, not machine
  locality, grants access.
- History/status reads for a keyed job are scoped to the presenting requester,
  and after harvest the prompt is scrubbed from the box (files + history).
