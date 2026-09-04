# Operations

Running the studio from a checkout, on ports, as processes. The person *using*
the app wants [`GUIDE.md`](GUIDE.md) instead; a failure with a sentence on it is
in [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## Developer quick start

Credentials come from [PassBook](https://github.com/LiamVisionary/passbook), the
machine's shared credential store — `$HIVE_HOME`, else `~/.hivemindos/.env`. The
studio joins that store at startup and fills only the server-side variables that
are missing; an explicit process or project value always wins. Provider secrets
never enter the browser or the provider catalog response.

`passbook run --` puts the store in front of a command and records which key was
read and who asked. The studio does not need it — it asks PassBook directly —
but it is what you want for anything that does not. `hive-env-run --` is the
older shim over the same store and still works.

```bash
uv sync --extra dev --extra mcp
npm --prefix packages/open-generative-ai ci
npm --prefix packages/comfyui-mobile ci
npm --prefix packages/media-gateway ci
npm run build:embedded
passbook run -- uv run content-studio doctor
passbook run -- uv run content-studio providers
uv run content-studio stack start   # then http://127.0.0.1:8765
```

Add `--extra faceless-webui` to the sync only if you want the Streamlit WebUI,
the MoneyPrinterTurbo HTTP API, the Redis task backend, or the Azure and
DashScope providers. The stack starts none of them and the desktop build ships
without them ([`RELEASE.md`](RELEASE.md)). The donor's Streamlit shell is
archived under `archive/moneyprinterturbo/`; its README says how to run it
against the engine in `app/`.

Private runtime state is outside Git under `~/.hivemindos/media-studio`.
Existing gateway history and settings are migrated there by
`scripts/migrate_media_state.py`. ComfyUI models, workflows, custom nodes,
generated outputs, and caches remain under the configured ComfyUI/private model
directories; deleting donor source checkouts does not remove them.

A headless or fleet box that nobody sits in front of can skip the interactive
setup card by seeding the owner with `CONTENT_STUDIO_OWNER_PASSWORD_HASH` (the
SHA-256 hex digest of the passphrase) and `CONTENT_STUDIO_OWNER_NAME`. See
[First sign-in and vault recovery](#first-sign-in-and-vault-recovery).

## Configuration

This machine's settings — where models and output live, which optional engines run,
the loopback addresses, output encryption, the rental reaper — are one typed document
that a person edits in the app (**Settings**, in the Advanced group, or ⌘,) and that the
supervisor exports for the servers that only read environment variables.
[`SETTINGS.md`](SETTINGS.md) is generated from that schema and lists every key, its
default, whether it needs a restart, and the variable that overrides it. Environment
variables still win over the document, and the Settings page names the one that is
winning rather than letting a saved value quietly do nothing.

Project/process environment wins over the shared hive environment, so a project-specific provider can override a fleet default without changing files.

The studio server reads `~/.hivemindos/.env` as its only default shared fallback and fills only variables missing from the process. The browser receives provider readiness, capability, cost class, and safe status text—not credential values. Do not add secret inputs or return environment values from frontend routes. Protected operator actions remain separate: the browser may hold an operator token in memory for the current page, but the server never autofills that token from the shared environment into browser state.

## Local services

The browser is one Hivemind Content Studio shell. Explore, Canvas, and Models
mount embedded package UIs while durable runs continue to use the canonical
Content Studio API and state store.
`GET /api/runtime` is a read-only operator diagnostic for its internal engines
and source provenance; it does not start processes or accept command arrays.
Default loopback endpoints are `COMFYUI_URL=http://127.0.0.1:8188`,
`SWIFT_FLUX2_SERVER_URL=http://127.0.0.1:8791`, and
`MEDIA_STUDIO_BACKEND_URL=http://127.0.0.1:8787`. These names configure
execution adapters, not user-visible workspaces.

- Media Studio MCP: dynamically discovered from HivemindOS app preferences; never copy its Tailnet URL or token into project files.
- Palmier Pro MCP: optional local timeline editor at `http://127.0.0.1:19789/mcp`, available only when installed and open.
- Universal TTS: default `http://127.0.0.1:8799`; discovery uses `/health`, `/v1/models`, and `/v1/voices`.
- ComfyUI and ACE-Step: discovered/configured through their HivemindOS or local service routes.
- General agent runtime: register bounded commands as `CONTENT_STUDIO_RUNTIME_<ID>_COMMAND`; any HivemindOS agent may instead attach a finished script through MCP.
- MUAPI: the bundled helper uses `MUAPI_API_KEY` or `MUAPI_KEY` and explicit endpoint payloads.
- OpenAI GPT Image API: uses `OPENAI_API_KEY` with the official Image API.
- OpenAI GPT Image OAuth: reuses the connected HivemindOS ChatGPT/Codex OAuth session through the beta Codex Responses `image_generation` surface. The token remains inside HivemindOS and is never treated as an Image API key.
- xAI Imagine API: uses `XAI_API_KEY` for `grok-imagine-image-quality` images and `grok-imagine-video` video generation.
- xAI Imagine OAuth: reuses the HivemindOS-owned OAuth session through the authenticated local bridge; rotating tokens remain in HivemindOS. If status reports a revoked refresh token, use Connect xAI in the Providers view and complete the browser flow.
- HivemindOS hosted media: use `HIVEMINDOS_URL`, `HIVEMINDOS_DASHBOARD_DEVICE_TOKEN`, and `HIVEMINDOS_CONTENT_STUDIO_AGENT_ID`; no upstream provider key enters the studio.
- Higgsfield Cloud: uses `HIGGSFIELD_API_KEY_ID` plus `HIGGSFIELD_API_KEY_SECRET`.
- Higgsfield consumer: requires its own authenticated CLI session; CLI presence is not authentication readiness.
- ElevenLabs: uses `ELEVENLABS_API_KEY` and a per-run `voice.voice_id`; voice IDs do not belong in shared skills.
- Clueso MCP: optional, agent-scoped OAuth provider. Verify it in the active runtime's MCP inventory; do not add runtime-specific configuration automatically. Any uploaded source or generated project data crosses the Clueso remote-service boundary.
- Durable approvals: set `CONTENT_STUDIO_APPROVAL_SIGNING_SECRET` (32+ chars) and `CONTENT_STUDIO_OPERATOR_TOKEN` (12+ chars) in the shared environment.
- Browser studio: set a distinct `CONTENT_STUDIO_CONTROL_TOKEN` for protected run actions and keep the default bind on `127.0.0.1` unless a trusted private proxy supplies transport/auth.
- Agent runtimes: register each allowed command as `CONTENT_STUDIO_RUNTIME_<ID>_COMMAND`. MCP/CLI agents select `<id>`; they never send a command array.

Do not replace a remote/Tailnet service URL with client-local `127.0.0.1`. The loopback defaults above apply only when the service is on this machine.

## Production lanes

| Lane | Input | Primary local path | Cloud/BYOK alternatives |
|---|---|---|---|
| Animation | YAML scene brief | ComfyUI + Media Studio MCP + Universal TTS + ACE-Step | HivemindOS hosted credits, MUAPI, and other configured providers |
| First-frame animation ad | Script/scene brief | General agent runtime + ComfyUI + Media Studio MCP + FFmpeg | GPT Image, xAI Imagine image/video, HivemindOS hosted credits, MUAPI, Higgsfield Cloud, Higgsfield consumer/Kling |
| Stickman performance ad | Script/scene brief | Deterministic black-line renderer + Universal TTS + FFmpeg | ElevenLabs, Higgsfield product/UGC cut-ins, MUAPI |
| Static text ad | One headline/subtext per scene | Deterministic 4:5/9:16/1:1 renderer | Generated product or UGC cut-ins when explicitly requested |
| Faceless short | Topic/script/search terms | Embedded MoneyPrinterTurbo + stock/local media + Universal TTS | Pexels, Pixabay, configured LLMs |
| Clipping | Long video URL/file | Embedded Auto Clipper + Podcli/FFmpeg | MUAPI AI clipping |
| Social post | Approved final media | Self-hosted Postiz | Upload-Post |

The optional `clueso-mcp` provider adds 90 agent-discoverable workflows for
motion graphics, demos, training, editing, localization, repurposing, and
video-derived documentation. The workflows are namespaced behind the canonical
studio router: Clueso is never silently preferred over local or hosted paths,
and connecting its MCP or uploading media remains an explicit remote action.

HivemindOS **Media Studio** is the image-to-video MCP already used by HivemindOS
chat. The studio discovers its `mcpVideo` descriptor dynamically from
`~/.hivemindos/app-preferences.json` (or portable environment overrides), stages
input images through the configured upload base, calls `media_generate_video`,
polls `media_get_job`, downloads the result, and runs technical QA. It never
bakes a Tailnet hostname, token, or transient app ID into the repo.

HivemindOS **hosted media** is the zero-provider-key cloud path. The studio calls
the authenticated local `/api/hivemindos/media` route, obtains the live quote,
verifies the official 25% markup and the run's maximum debit, then lets the
HivemindOS-controlled gateway reserve shared hosted credits and own the provider
job. Company freeze, budget, and approval policy remain authoritative in
HivemindOS, and the studio never reads or receives the hosted MUAPI key.

Palmier Pro remains a separate optional local timeline/editor MCP. It is not the
Media Studio generation backend.

## Production templates

The typed template catalog in
`src/hivemind_content_studio/template_catalog.py` loads frontmatter-markdown
templates from `src/hivemind_content_studio/templates/catalog/<category>/`. Each
template is a composer-ready production prompt with `[SLOT]` placeholders plus
safe metadata (lane hint, aspect ratio, duration, tags, provenance). Three
categories ship today:

- **ugc** — the hyper-real AI UGC system: a character reference photo prompt
  (named imperfections, lived-in environment, phone-camera language, the
  load-bearing negative) and the 8-beat 15-second product ad with
  character/outfit/environment/product/voice locks.
- **formats** — eight proven viral ad formats (shocked reaction + demo,
  product-as-gameplay, notification punchline, mascot engine, "what worked for
  me" note, spot-the-AI split screen, accidental discovery, trend-template
  volume), each as a runnable beat plan.
- **animation** — the brand-explainer arc built on the existing animation
  scaffolds.

Templates surface in three places: the Planner's **Templates** chip (inserts the
prompt for the brain to expand), `GET /api/templates` (and the
`templates` key of `/api/simple/catalog`), and `content-studio templates
[template-id]`. Adding a template is dropping a new `.md` file with valid
frontmatter into the catalog directory — the loader validates lane ids, unique
ids, and that every declared slot appears in the prompt body.

## Run lifecycle

1. Create a YAML brief from `examples/briefs/` or specify a rights-known clip source.
2. Run `content-studio run execute <brief> --privacy <policy> --max-cost-usd <cap>`.
3. Read `next_actions`; attach agent output or execute the named provider-neutral intent.
4. For direct paid-provider work, submit a bounded estimate, have the operator decide the generated approval request, then retry with its one-time receipt. For `hivemindos-hosted-media`, use the live retail quote as the bounded estimate and let HivemindOS company governance authorize or stop the spend.
5. Resume the run after external artifacts arrive. Provider job IDs, source URLs, hashes, and dependencies are attached automatically.
6. Complete technical QA and structured semantic evaluation. Regenerate only failed scenes when possible.
7. Request and consume a separate run-approval receipt for rights and claims.
8. Prepare and dry-run publishing. Execute live only under the separate live-publish gate.
9. Ingest platform metrics with external IDs, spend, retention, conversions, and revenue; use the controlled-variant recommendation for the next iteration.
10. Inspect generation reliability and routing with `content-studio telemetry generations` or the MCP `get_generation_telemetry` tool. This telemetry remains local and excludes creative inputs and credentials.

## Ad-lane lifecycle

1. Plan `first-frame-animation-ad`, `stickman-performance-ad`, or `static-text-ad`.
2. Let any configured agent runtime consume `script-request.json`, or attach its script.
3. For first-frame ads, generate one manifest-recorded keyframe per scene, then one scene video per keyframe through Media Studio, xAI Imagine, MUAPI, or the explicitly selected Higgsfield surface. GPT Image is a keyframe provider, not a video provider.
4. For stickman ads, run the deterministic renderer; add generated product or UGC cut-ins only where the brief calls for them.
5. Generate exact line-level voice through Universal TTS or the approval-gated ElevenLabs executor.
6. Assemble with FFmpeg, run technical QA, and optionally export the portable CapCut handoff.
7. Apply rights/claims approval, dry-run distribution, and publish only under the existing live-publish gate.

## Command reference

SQLite is authoritative for run/step/event/budget state. The versioned manifest
is authoritative for the brief, provider selections, artifacts, provenance,
approval, publish drafts, and receipts.

**Durable runs.** Each `execute` advances deterministic work and stops with
structured `next_actions` when an agent, provider, evaluator, or operator is
needed.

```bash
passbook run -- uv run content-studio run execute examples/briefs/first-frame-animation-ad.yaml --privacy local-first --max-cost-usd 10
passbook run -- uv run content-studio run list
passbook run -- uv run content-studio run get <run-id>
```

**Scripts** are agent-runtime neutral. Any command that consumes the run request
JSON on stdin and writes Markdown on stdout can be used, or an already-running
HivemindOS agent can attach its finished script through CLI/MCP:

```bash
uv run content-studio script run <manifest.json> --runtime <operator-registered-runtime-id> --confirm AGENT_GENERATE
uv run content-studio script attach <manifest.json> <script.md> --runtime hermes
```

**Intents** route before execution. The result explains the selected
implementation, fallbacks, readiness evidence, and every rejected provider:

```bash
uv run content-studio intent route <run-id> generate_keyframes --estimated-cost-usd 1.25
uv run content-studio intent execute <run-id> generate_keyframes --estimated-cost-usd 1.25
uv run content-studio telemetry generations
```

Direct paid-provider execution returns `awaiting_approval`. An operator decides
that exact request through the authenticated control API or `content-studio
approval decide`; the agent retries with the returned one-time
`--approval-token`. Spend is debited atomically only after the registered
executor succeeds. MUAPI requires an explicit live-discovered endpoint and
payload template under `provider_options.muapi`; model-specific schemas are
never guessed.

For `hivemindos-hosted-media`, first discover the hosted catalog/schema and put
the explicit model/payload template under
`provider_options.hivemindos-hosted-media.<keyframe|motion>`. Pass the quoted
retail amount as `--estimated-cost-usd`. This provider delegates authorization
to the HivemindOS company policy instead of creating a second studio approval:
an autonomous company inside its budget proceeds, while a frozen company,
exhausted budget, low hosted balance, or HivemindOS approval threshold stops
before provider spend.

Higgsfield Cloud and the consumer CLI are separate providers; the studio never
silently switches between their independent credentials or sessions. OpenAI GPT
Image has two explicit providers — `openai-gpt-image` (key, official Image API)
and `openai-gpt-image-oauth` (the HivemindOS ChatGPT/Codex sign-in through the
beta Codex Responses `image_generation` surface, which never presents that OAuth
token to the public Image API). xAI Imagine likewise supports separate key and
HivemindOS-brokered OAuth routes. The studio's OAuth controls start and inspect
the existing HivemindOS sessions; access and refresh tokens never enter this
process or the browser.

**Ad lanes.** Stickman ads can remain entirely local until product cut-ins or
premium generation are requested:

```bash
uv run content-studio render-stickman <manifest.json>
uv run content-studio intent execute <run-id> generate_voice --provider elevenlabs --estimated-cost-usd <estimate> --approval-token <one-time-token>
uv run content-studio assemble <manifest.json>
uv run content-studio capcut-handoff <manifest.json>
```

FFmpeg assembly is the zero-human default. The CapCut command emits a portable
asset/timing CSV and instructions rather than writing CapCut's unstable private
project database.

**Read-only discovery.**

```bash
uv run content-studio mcp-tools
passbook run -- uv run content-studio media-studio status
passbook run -- uv run content-studio media-studio tools
```

Media Studio is also available through the `animate_scenes` intent. Its
local/fleet generation never implies approval to publish the result. An actual
Palmier project/tool mutation requires explicit confirmation:

```bash
uv run content-studio mcp-call <tool> --arguments '{"project_id":"..."}' --confirm MCP_WRITE
```

## Publishing gate

Rendering and publishing are separate. Setup never enables auto-upload.

```bash
uv run content-studio publish prepare <manifest.json> \
  --video <final.mp4> \
  --title "..." \
  --caption "..." \
  --platforms youtube,tiktok,instagram \
  --provider upload-post

uv run content-studio publish dry-run <manifest.json>
uv run content-studio approval request-run <manifest.json>
uv run content-studio approval decide <approval-id> --decision approve --decided-by <name>
uv run content-studio approve <manifest.json> --reviewer <name> --rights-note "Owned/approved media and claims reviewed." --approval-token <one-time-token>
```

Live publishing additionally requires both
`CONTENT_STUDIO_ENABLE_LIVE_PUBLISH=true` and `--confirm LIVE_PUBLISH`. Use
`passbook run --` so credentials stay in the shared store and every read is
recorded.

After distribution, attach platform outcomes to the same run:

```bash
uv run content-studio metrics record <manifest.json> --platform youtube --views 1000 --completed-views 620 --clicks 35 --conversions 4 --revenue 80
uv run content-studio metrics summary <manifest.json>
```

## Agent access

Two MCP servers are included. `content-studio-mcp` is the primary agent contract
and exposes high-level run, intent, asset, evaluation, experiment, metric, and
publishing tools plus these discoverable resources:

- `studio://capabilities`
- `studio://providers`
- `studio://telemetry/generations`
- `studio://runs/{run_id}`
- `studio://runs/{run_id}/artifacts`
- `studio://runs/{run_id}/next-actions`

`content-studio-mcp` can request approval but cannot approve or deny its own
request. `auto-clipper-mcp` is a focused compatibility surface for existing
clipping agents; its `render` tool takes an optional `category` (`business`,
`knowledge`, `opinion`, `speech`, `entertainment`, `experience`,
`content_review`) that selects a scoring-prompt overlay from `presets/prompts/`,
and returns `semantics_status` alongside the run id.

After Podcli renders, an LLM pass scores each candidate and writes its hook and
caption (`clips.llm_score`, `llm_reason`, `hook_title`, `caption`); the Obsidian
run note lists clips best-first so the reviewer reads them in ranked order. The
pass **ranks but never deletes** — the approval gate remains the only filter —
and it fails open, so a missing model costs a render nothing. Set
`AUTO_CLIPPER_LLM` to `auto` (default: an already-loaded local model, else the
cloud provider), `local`, `cloud`, or `off`.

Podcli's own AI clip selection is **off** by default. Stock Podcli hands the
whole transcript to any `claude` or `codex` binary on PATH;
`patches/podcli-ai-select-default-off.patch` makes that an explicit
`--ai-select` opt-in, and `auto-clipper doctor` fails an install that is missing
the gate.

The optional operator console is secondary and starts locally with `passbook run
-- uv run content-studio-api`. It reads the same state store; authenticated
mutations require `CONTENT_STUDIO_CONTROL_TOKEN`.

The repository also snapshots the relevant Shared Brain skills under
`skills/shared/` and vendors the audited Clueso workflow shelf under
`skills/vendor/clueso-ai/`. `skills/hivemind-content-studio/SKILL.md` is linked
into `.agents/skills/` as the canonical entry skill; provider adapters are
operational references, not duplicate implementations.

## Failure handling

- Provider errors are sanitized; credential values must never appear in logs.
- Re-run generation as a new versioned artifact instead of overwriting the only good output.
- Upload retries use idempotency keys where supported.
- Do not retry publish in an unbounded loop. Inspect the receipt/provider state first.
- Palmier is currently optional; when closed, use MoneyPrinterTurbo/FFmpeg/ComfyUI assembly paths.
- Cancellation always records local orchestration intent. It must not claim a remote job was cancelled unless the provider confirms it.
- Higgsfield Cloud motion requires a public source URL or an explicit upload integration; a local path is not silently treated as remotely reachable.
- MUAPI generation fails closed until the chosen endpoint's live schema has been discovered and encoded under `provider_options.muapi`.

## MCP and browser studio

Run the stdio MCP server with `passbook run -- uv run content-studio-mcp`. Agents should begin with `studio://capabilities` and `studio://providers`, create a run with `execute_content_run`, and inspect `studio://runs/<id>/next-actions` after every external step.

Re-run `npm run build:embedded` after any dependency or frontend change (the
per-package `npm ci` lines are in [Developer quick start](#developer-quick-start)).

Use `content-studio stack status`, `restart`, `stop`, or `url` for lifecycle control. The supervisor owns ports 8765, 8787, 8793, 8788, 8794, 8796, the configured ComfyUI lanes, and optional native MLX/Tailscale listeners. The Canvas host and ComfyUI proxy, the local-inference bridge and the agent MCP are one Node child (`packages/media-gateway/node-services.mjs`): it serves all three on 8793 under `/canvas`, `/bridge` and `/agent`, answers for all three on `http://127.0.0.1:8793/healthz`, and keeps 8788, 8794 and 8796 answering unprefixed so anything that addresses them by number still works. `/canvas` is an API and proxy mount rather than a page to open: the surfaces behind it emit absolute asset URLs, so a browser navigation there is redirected to 8788. The Canvas surface and the bridge both authenticate their callers with the gateway token or the owner's studio session (`packages/media-gateway/lib/canvas-gate.js`); only their bare liveness paths answer without one. Creating a run is a safe local draft operation; resume, retry, cancellation, and approval decisions require `Authorization: Bearer <CONTENT_STUDIO_CONTROL_TOKEN>`. The approval signing secret and operator token remain server-side.

`.github/SECURITY.md` has the full "what listens where" table — every port, its
bind address, and what authenticates it — plus how to report a vulnerability
privately.

The stable LaunchAgent still invokes `~/.local/bin/zimage-stack`. Install the reversible link only after verification:

```bash
python3 scripts/bootstrap_unified_studio.py --install-links
```

The installer archives the prior launcher under `~/.hivemindos/media-studio/archive/launchers/` and reports the exact restore path. It refuses to overwrite a real ComfyUI custom-node directory.
Starting the unified LaunchAgent also boots out and disables the obsolete `com.liam.open-generative-ai-hosted` label so it cannot compete for port 8794. Its plist is left intact for rollback.

## Workflow registry entries

The media gateway reads `packages/media-gateway/workflow-registry.json`. A ComfyUI
API-format entry is shaped like this — `api_workflow`/`mobile_workflow` are absolute
paths, `accepts` declares the capability the studio exposes, and `slots` maps each
accepted field onto a node input:

```json
{
  "workflows": [
    {
      "id": "wan-example-i2v",
      "media_type": "video",
      "title": "Wan Example Image-to-Video",
      "family": "wan",
      "builder": "comfy-api",
      "api_workflow": "/absolute/path/to/wan-image-to-video-api.json",
      "mobile_workflow": "/absolute/path/to/wan-image-to-video-editor.json",
      "default": false,
      "requires": { "prompt": true, "image": true },
      "accepts": ["prompt", "image_path", "width", "height", "frames", "seed", "steps", "cfg"],
      "defaults": { "width": 720, "height": 1280, "frames": 81, "steps": 30, "cfg": 5, "seed": 42 },
      "slots": {
        "prompt": { "node": "6", "input": "text" },
        "image_path": { "node": "4", "input": "image" },
        "width": { "node": "10", "input": "width" },
        "height": { "node": "10", "input": "height" },
        "frames": { "node": "10", "input": "length" },
        "seed": { "node": "12", "input": "seed" },
        "steps": { "node": "12", "input": "steps" },
        "cfg": { "node": "12", "input": "cfg" }
      }
    }
  ]
}
```

## Donor checkout retirement gate

This is a migration gate, not a ship gate. What has to be green before a desktop
build is dispatched is [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md).

Do not delete an old checkout until all of these are true:

1. `uv run pytest test/studio` and `npm run test:embedded` pass.
2. `npm run build:embedded` passes from the unified repo.
3. A cold start from `scripts/hivemind-studio-stack supervise` reaches every required health endpoint.
4. Browser checks pass for Studio, Explore, Canvas, Models, Runs, History, Telemetry, and Providers on desktop and mobile widths.
5. `scripts/migrate_media_state.py` has written a migration receipt and the canonical state files are present.
6. ~~The two owner forks without detected license files have an explicit redistribution decision before the embedded source is pushed publicly.~~ Closed 2026-09-03: recorded as "distribute" in `THIRD_PARTY_NOTICES.md`, which now carries no open distribution gate.

Deleting donor checkouts must never include the external ComfyUI checkout, model directories, `~/.comfy-private.noindex`, or `~/.hivemindos/media-studio`. Keep a final archive until at least one real generation has completed through the unified stack.

## First sign-in and vault recovery

- **First launch** is two steps at the machine: name the studio and choose a passphrase on the setup card, then keep the vault recovery key the app shows as step two. There is no compiled-in password. A headless or fleet box seeds the owner instead with `CONTENT_STUDIO_OWNER_PASSWORD_HASH` (SHA-256 hex of the passphrase) and `CONTENT_STUDIO_OWNER_NAME`.
- **The passphrase** signs in *and* derives the vault key. Nobody can reset it: there is no server-side copy, by design (`docs/E2E_ENCRYPTION_DESIGN.md`).
- **The recovery key** is emitted once, at vault creation, and never stored. Lost passphrase + lost recovery key = the sealed library stays sealed; run files and anything written before the vault existed are unaffected because they use this machine's key, not the account's.
- **Changing the passphrase** re-wraps the master key for the account; it does not re-encrypt media, and it does not invalidate the recovery key.
- **Passkeys** are per device and additive. Removing the last one leaves password sign-in; removing the password is not offered, because it is the only thing that can unwrap the vault on a new device.
- **`CONTENT_STUDIO_DESKTOP=1`** tells the sign-in gate it is running inside the packaged desktop shell: a solo workspace with a passkey goes straight to the prompt, and "New workspace" moves to Settings > Privacy > Workspaces. Unset in the developer stack.
- **The gate's stylesheet is generated**: `python3 scripts/generate_gate_css.py` after any change to `packages/open-generative-ai/src/styles/variables.css`; `--check` fails when it is stale.

## Recovery and rollback

- Cancel: `content-studio run cancel <run-id> --reason <reason>` preserves all evidence.
- Resume: `content-studio run resume <run-id>` continues from the first incomplete step.
- Retry: `content-studio run retry <run-id> <step-id>` increments the bounded attempt count.
- Filesystem rollback: archive or remove only the target run directory after cancelling; do not delete shared SQLite state by hand.
- Approval receipts are one-use and expire. Request a new exact scope instead of editing ledger rows.

## Safety and licensing

- No credential values belong in this repository. `.env.example` contains key names only.
- Remote media is untrusted input and is validated before rendering/publishing.
- Remote URL ingestion and generated-media downloads enforce public HTTPS/SSRF, byte-size, MIME, and decode checks. Private generation URLs are disabled by default.
- Agent runtimes are registered by operator-owned environment keys; agents submit a runtime id, not an argv array.
- Paid generation and run approval use one-time exact-scope receipts. Editor mutation and public publishing retain separate gates.
- Auto Clipper is declared AGPL-3.0-or-later. The combined work is therefore configured as AGPL-3.0-or-later; see `THIRD_PARTY_NOTICES.md` before distribution.
