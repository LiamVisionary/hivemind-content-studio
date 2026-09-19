# Hosted GPU rentals — the marketplace keys live in a worker

Since 2026-09-07 the studio rents GPUs **without holding a marketplace key**.
`VAST_API_KEY` and the RunPod key are secrets on the Cloudflare worker
`hivemindos-gpu-rentals-gateway` (`hivemind-cloud-services/workers/gpu-rentals-gateway`),
and nowhere else. The studio talks to that worker with the owner's HivemindOS
credit token; the worker injects the platform key, scopes every instance to the
account that rented it, and bills HivemindOS credits.

Why: the studio ships to people who will never have a Vast or RunPod account.
The old path read the keys from the machine's shared store, which on a
customer's machine is empty — and on the owner's own machine produced the
misleading "marketplace keys are sealed" banner (see *The sealed-keys banner*
below).

## What moved and what did not

| Concern | Where it lives now |
|---|---|
| Marketplace credentials | worker secrets `VAST_API_KEY`, `RUNPOD_API_KEY` |
| Which box to rent (tier ladder, RAM/link floors, benchmarks, bad-machine cooldown) | unchanged, `src/hivemind_content_studio/gpu_rentals.py` |
| Provisioning (onstart script, weights, node pins, beacon), SSH tunnels, attach, pause/resume, reaper | unchanged |
| The HTTP transport under `rental_providers/vast.py::request` and `runpod.py::request`/`graphql` | routed through `rental_providers/gateway.py` when the studio has a HivemindOS account |
| Who pays the marketplace | the platform's Vast/RunPod accounts |
| Who pays the studio | the owner's HivemindOS credits, through paid-agent-gateway's platform-credit authority (service `gpu-rentals`, operation `rentals.block`) |
| The purse shown in Machines | one HivemindOS balance, not one per marketplace |

## Transport

`HIVEMIND_GPU_RENTALS_TRANSPORT`:

- `auto` (default) — hosted when `hivemindos_models.credit_token()` is present
  (a connected account key, or the HivemindOS app's own balance on this
  machine); otherwise direct, using local keys if any exist.
- `gateway` — always hosted.
- `direct` — always local keys (`VAST_API_KEY`, `RUNPOD_API_KEY` /
  `RUNPOD_MANAGEMENT_API_KEY` in the process environment). The operator's own
  marketplace accounts; nothing is billed to HivemindOS credits.

`HIVEMIND_GPU_RENTALS_GATEWAY_URL` overrides the worker URL (default is the live
one). Tests pin it to a dead port and force `direct`.

## The worker surface

All routes under `/v1/market` require `X-HivemindOS-Credit-Token`.

- `GET /v1/market` — which providers are configured on the worker, the markup,
  block length, and the caller's balance.
- `POST /v1/market/{vast|runpod}/call` `{method, path, body?, quotedUsdPerHour?}` —
  the provider call the studio already makes, forwarded with the key injected.
  Only an explicit allowlist passes (offers search, create, list, destroy,
  pause/resume, the two RunPod GraphQL queries). Lists come back filtered to
  the caller's instances; prices come back marked up (`GPU_MARKET_MARKUP_BPS`,
  25%). The platform's own balance routes (`/v0/users/current/`,
  `clientBalance`) are refused. Warm volumes are refused on the hosted rail.
- `POST /v1/market/meter` / `GET /v1/market/rentals` — keepalive and the
  caller's billing state.

## Billing

The platform-credit authority reserves only with the customer's token present
and auto-releases a reservation it has not heard about within 15 minutes. So:

- Blocks of 10 minutes. Block 1 is reserved at the quoted price *before* the
  provider is asked for the box; the true provider cost is read back from the
  instance and the rate corrected (a breach of the studio's own price
  tolerance destroys the box, releases the block and answers 409).
- The **studio keeps the meter fed**: every authenticated list call (the
  Machines poll and the reaper's snapshot, at most 3 minutes apart while a
  hosted rental is active) settles the block that ended and reserves the next.
  A settle always happens inside the authority's 15-minute window.
- The worker's cron holds no token, so it only stops and settles: lifetime
  cap, provider-gone, provisioning stall (+ bad-machine cooldown), and
  `reserved_until + 5 min` passed with no keepalive (the studio went away).
- Stop settles the current block at elapsed minutes and releases anything not
  started. A box that never served (provisioning failed, create failed, price
  moved) releases everything.

Secrets on the worker: `VAST_API_KEY`, `RUNPOD_API_KEY`,
`HIVEMINDOS_INTERNAL_SERVICE_TOKEN` (the value PassBook holds as
`HIVEMINDOS_GPU_RENTALS_INTERNAL_TOKEN`, which paid-agent-gateway pins to the
`gpu-rentals` service and the `gpu_reserve_` reservation namespace). The
authority is reached over the `REVENUE_LEDGER` service binding — a public
worker-to-worker fetch on the same account is answered 404.

## The sealed-keys banner

The banner *"the marketplace keys (VAST_API_KEY, RUNPOD_MANAGEMENT_API_KEY) are
in this machine's shared store, but sealed — the vault is locked"* was seen on
2026-09-07 with the vault **open**. The stack launcher hands each service only
the keys in its `STUDIO_KEYS` allowlist (`scripts/hivemind-studio-stack`), and
the marketplace keys were never on it, so the studio process saw the names in
the store and no values and diagnosed a locked vault. That diagnosis is now
shown only on the `direct` transport; on `auto` a studio with no account says
to connect one (Models → HivemindOS → Connect). The marketplace keys stay off
`STUDIO_KEYS` on purpose.

## Credential audit (2026-09-07)

Every third-party credential production code reads locally, and where it
should live. **(a)** must move behind a worker before end users depend on it;
**(b)** is the owner's own account by design; **(c)** is local identity, not a
provider key.

| Credential | Read at | Class | Status |
|---|---|---|---|
| `VAST_API_KEY`, `RUNPOD_*` | `rental_providers/vast.py`, `runpod.py` | (a) | **moved** — this document |
| `MUAPI_API_KEY` (`MUAPI_KEY`) | `muapi_proxy.py`, `providers.py`, browser fallback `packages/open-generative-ai/src/lib/muapi.js` | (a) | open. The hosted rail exists (`hivemindos_hosted_media.py` via the HivemindOS app; paid-agent-gateway `muapi-managed-media.ts`) but the direct MUAPI route is still selectable in `image_router.py`, and the browser falls back to a key in `localStorage` |
| `HIGGSFIELD_API_KEY_ID` / `_SECRET` | `generation.py`, `providers.py`, `image_router.py` | (a) | open — no hosted rail |
| `ELEVENLABS_API_KEY` | `voice.py`, `app/services/voice.py`, `app/services/elevenlabs_music.py`, `app/config/config.py` (four readers) | (a) | open — no hosted rail |
| `PEXELS_*`, `PIXABAY_*`, `COVERR_*`, `TWELVELABS_*` | `providers.py`, `app/config/config.py`, `app/services/material.py` | (a) | open (faceless lane stock media) |
| `CIVITAI_*` (downloads) | `packages/media-gateway/gateway/models.py` | (a)/(b) | downloads are platform-ish; posting uses no key (browser, owner's account) |
| `MINIMAX_*`, `SONILO_*`, `AZURE_SPEECH_*`, `SILICONFLOW_*`, … | `app/config/config.py` (MoneyPrinterTurbo lane) | (a) | open |
| `OPENAI_*`, `ANTHROPIC_*`, `OPENROUTER_*`, `GEMINI_*`, `XAI_*`, `GROQ_*`, `VENICE_*`, OAuth grants | `provider_models.py` | (b) | stays — the producer runs on the owner's accounts |
| `POSTIZ_*`, `UPLOAD_POST_*` | `config.py`, `providers.py` | (b) | stays — publishing to the owner's socials |
| `CONTENT_STUDIO_*`, `ZIMG_*`, `MEDIA_STUDIO_*`, `COMFY_*`, lane tokens, `HIVEMINDOS_DASHBOARD_DEVICE_TOKEN` | various | (c) | stays |
| `RESTORE_ENDPOINT_TOKEN` | `packages/gpu-rentals/serverless/modal_app.py` | platform, server-side | already only in Modal |

Recommended order for the open rows: MUAPI (a hosted rail exists — make it the
production default and drop the browser-held key), Higgsfield and ElevenLabs
(paid, per-call — same reserve/settle shape as restore-gateway), then the
faceless lane's stock-media keys (cheap, rate-limited, one worker with a
per-account quota).
