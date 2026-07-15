# Hivemind Content Studio

One agent-facing repository for the full social-content lifecycle:

```text
brief/source
  -> script + scene plan
  -> local/cloud media generation
  -> faceless render or animation assembly
  -> long-form clipping
  -> render QA + rights approval
  -> Postiz or Upload-Post publish
  -> performance + monetization loop
```

It consolidates three owned systems without making three parallel pipelines:

- **MoneyPrinterTurbo** is the faceless rendering engine: scripts, stock/local media, LocalTTS, subtitles, and FFmpeg/MoviePy assembly.
- **Auto Clipper** is the long-form ingestion and clipping engine: transcripts, clip candidates, rights gates, approvals, Postiz planning, and monetization matching.
- **AI Animation Factory** is the animation planning contract: briefs, scenes, image/motion prompts, voice lines, music briefs, and reproducible run artifacts.
- **Hivemind Content Studio** is the only orchestration, provider, manifest, approval, and publishing layer.

The current Upload-Post and Postiz API shapes are implemented once in `hivemind_content_studio.publishing`. MoneyPrinterTurbo never auto-publishes at the end of a render.

## Unified studio

The durable run engine is the product surface. The browser studio, CLI, and MCP are adapters over the same SQLite state machine and versioned manifest:

```text
execute run -> inspect next_actions -> route intent -> request/consume approval
            -> execute provider -> attach provenance -> evaluate -> publish -> ingest outcomes
```

Every run exposes status, current step, bounded retries, budget/spend, immutable artifact metadata, provider/job evidence, and precise next actions. Agents ask for capabilities such as `generate_keyframes` or `animate_scenes`; the router selects a ready provider under the run's privacy, allowlist, and budget policy. Paid work uses an HMAC-signed, exact-scope, one-time operator receipt. Run-associated generation attempts also emit local privacy-safe telemetry: success/failure, provider/model, media kind, duration, artifact count, and charged amount. Prompts, media, credentials, provider payloads, and raw error messages are excluded. Arbitrary shell commands and operator approval decisions are not exposed over MCP.

The browser opens as one native **Studio** with Create, Edit, Animate, and Workflow modes. Create, Edit, and Animate share one HivemindOS-style composer, up to 30 ordered reference images, the same model router, prompt history, and durable runs. Workflow reveals the detailed brief-first production form without opening another app. Image and video routes default to Automatic but can be pinned to a provider/model. Prompt Helper is on by default; Walk-through makes the brain ask questions and wait for confirmation before creating the run. The browser receives only safe model/capability metadata—HivemindOS keeps API keys and OAuth tokens server-side.

The Workflow mode exposes all seven lanes, scene direction, provider overrides, voice and captions, distribution, faceless-video controls, privacy, budget, and protected operator actions with progressive disclosure. Every mode creates the same canonical manifest and SQLite-backed durable run.

### Native all-in-one application

The browser does not expose repositories as apps, workspace cards, or iframes.
Useful behavior is assimilated into the first-party Studio surface while this
package remains the only run, asset, provenance, approval, publishing, and
metrics owner:

- `hive-image-stack` supplies the local Media Studio gateway, generation API,
  model manager, ComfyUI proxy, and Media Studio MCP behind provider-neutral
  routes.
- `comfyui-mobile-frontend` contributes workflow-editor, queue, model-manager,
  and output-browser interaction patterns to native Studio features.
- `Open-Generative-AI` contributes image, video, edit, workflow, model-catalog,
  and local-inference implementations to native Studio features.
- `flux-2-swift-mlx` and `Z-Image.swift` remain native Apple Silicon engines
  behind the local gateway; users select capabilities and models, not sidecars.
- `unified-image-studio-template` contributes portable service-catalog,
  bootstrap, and launcher patterns without contributing a second dashboard.

`GET /api/runtime` is an internal, secret-free diagnostic: one native Studio
surface, bounded engine health, and donor/upstream provenance. It is not used to
construct separate product areas. On 2026-07-15, Open Generative AI upstream
`7c8df61` was confirmed to be the fork's merge-base; the Liam fork `0ab564b` is
2 commits ahead and 0 behind, so there were no upstream commits to merge before
assimilation continued.

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

HivemindOS **Media Studio** is the image-to-video MCP already used by HivemindOS chat. The studio discovers its `mcpVideo` descriptor dynamically from `~/.hivemindos/app-preferences.json` (or portable environment overrides), stages input images through the configured upload base, calls `media_generate_video`, polls `media_get_job`, downloads the result, and runs technical QA. It never bakes a Tailnet hostname, token, or transient app ID into the repo.

HivemindOS **hosted media** is the zero-provider-key cloud path. The studio calls the authenticated local `/api/hivemindos/media` route, obtains the live quote, verifies the official 25% markup and the run's maximum debit, then lets the HivemindOS-controlled gateway reserve shared hosted credits and own the provider job. Company freeze, budget, and approval policy remain authoritative in HivemindOS. The studio never reads or receives the hosted MUAPI key. Configure only `HIVEMINDOS_URL`, `HIVEMINDOS_DASHBOARD_DEVICE_TOKEN`, and the company agent identity `HIVEMINDOS_CONTENT_STUDIO_AGENT_ID` through the shared environment.

Palmier Pro remains a separate optional local timeline/editor MCP. It is not the Media Studio generation backend.

## Production templates

The typed template catalog in `src/hivemind_content_studio/template_catalog.py` loads frontmatter-markdown templates from `src/hivemind_content_studio/templates/catalog/<category>/`. Each template is a composer-ready production prompt with `[SLOT]` placeholders plus safe metadata (lane hint, aspect ratio, duration, tags, provenance). Three categories ship today:

- **ugc** — the hyper-real AI UGC system: a character reference photo prompt (named imperfections, lived-in environment, phone-camera language, the load-bearing negative) and the 8-beat 15-second product ad with character/outfit/environment/product/voice locks.
- **formats** — eight proven viral ad formats (shocked reaction + demo, product-as-gameplay, notification punchline, mascot engine, "what worked for me" note, spot-the-AI split screen, accidental discovery, trend-template volume), each as a runnable beat plan.
- **animation** — the brand-explainer arc built on the existing animation scaffolds.

Templates surface in three places: the Simple composer's **Templates** menu (inserts the prompt for the brain to expand), `GET /api/templates` (and the `templates` key of `/api/simple/catalog`), and `content-studio templates [template-id]`. Adding a template is dropping a new `.md` file with valid frontmatter into the catalog directory — the loader validates lane ids, unique ids, and that every declared slot appears in the prompt body.

## Quick start

The studio automatically fills missing server-side variables from `~/.hivemindos/.env`; explicit process or project values take precedence. Provider secrets never enter the browser or the provider catalog response. `hive-env-run` remains useful for consistency with other HivemindOS tools, but is no longer required just to make the studio discover shared provider credentials.

```bash
uv sync --extra dev --extra mcp
hive-env-run -- uv run content-studio doctor
hive-env-run -- uv run content-studio providers
```

Open the local studio:

```bash
hive-env-run -- uv run content-studio-api
```

Then visit `http://127.0.0.1:8765`. Studio opens in Create mode; switch among Edit, Animate, and Workflow without leaving the native application. Studio, Runs, History, Telemetry, and Providers all use the same-origin control API and canonical run engine. The original MoneyPrinter Streamlit entrypoint remains a temporary compatibility surface; new productions should begin in Hivemind Studio.

Start a durable run. It advances deterministic work and stops with structured `next_actions` when an agent, provider, evaluator, or operator is needed:

```bash
hive-env-run -- uv run content-studio run execute examples/briefs/first-frame-animation-ad.yaml --privacy local-first --max-cost-usd 10
hive-env-run -- uv run content-studio run list
hive-env-run -- uv run content-studio run get <run-id>
```

SQLite is authoritative for run/step/event/budget state. The versioned manifest is authoritative for the brief, provider selections, artifacts, provenance, approval, publish drafts, and receipts.

Scripts are agent-runtime neutral. Any command that consumes the run request JSON on stdin and writes Markdown on stdout can be used, or an already-running HivemindOS agent can attach its finished script through CLI/MCP:

```bash
uv run content-studio script run <manifest.json> --runtime <operator-registered-runtime-id> --confirm AGENT_GENERATE
uv run content-studio script attach <manifest.json> <script.md> --runtime hermes
```

Route intents before execution. The result explains the selected implementation, fallbacks, readiness evidence, and every rejected provider:

```bash
uv run content-studio intent route <run-id> generate_keyframes --estimated-cost-usd 1.25
uv run content-studio intent execute <run-id> generate_keyframes --estimated-cost-usd 1.25
uv run content-studio telemetry generations
```

Direct paid-provider execution returns `awaiting_approval`. An operator decides that exact request through the authenticated control API or `content-studio approval decide`; the agent retries with the returned one-time `--approval-token`. Spend is debited atomically only after the registered executor succeeds. MUAPI requires an explicit live-discovered endpoint and payload template under `provider_options.muapi`; model-specific schemas are never guessed.

For `hivemindos-hosted-media`, first discover the hosted catalog/schema and put the explicit model/payload template under `provider_options.hivemindos-hosted-media.<keyframe|motion>`. Pass the quoted retail amount as `--estimated-cost-usd`. This provider delegates authorization to the HivemindOS company policy instead of creating a second studio approval: an autonomous company inside its budget proceeds, while a frozen company, exhausted budget, low hosted balance, or HivemindOS approval threshold stops before provider spend.

Higgsfield Cloud and the consumer CLI are separate providers. The studio never silently switches between their independent credentials or sessions.

OpenAI GPT Image has two explicit providers. `openai-gpt-image` uses `OPENAI_API_KEY` with the official Image API. `openai-gpt-image-oauth` reuses the HivemindOS ChatGPT/Codex sign-in through the beta Codex Responses `image_generation` surface; it never presents that OAuth token to the public Image API. xAI Imagine similarly supports separate `XAI_API_KEY` and HivemindOS-brokered OAuth routes for image and video generation. The studio's OAuth controls start and inspect the existing HivemindOS sessions; access and refresh tokens never enter this process or the browser.

Stickman ads can remain entirely local until product cut-ins or premium generation are requested:

```bash
uv run content-studio render-stickman <manifest.json>
uv run content-studio intent execute <run-id> generate_voice --provider elevenlabs --estimated-cost-usd <estimate> --approval-token <one-time-token>
uv run content-studio assemble <manifest.json>
uv run content-studio capcut-handoff <manifest.json>
```

FFmpeg assembly is the zero-human default. The CapCut command emits a portable asset/timing CSV and instructions rather than writing CapCut's unstable private project database.

Palmier discovery is read-only:

```bash
uv run content-studio mcp-tools
```

Media Studio discovery is also read-only:

```bash
hive-env-run -- uv run content-studio media-studio status
hive-env-run -- uv run content-studio media-studio tools
```

Media Studio is also available through the `animate_scenes` intent. Its local/fleet generation never implies approval to publish the result.

An actual Palmier project/tool mutation requires explicit confirmation:

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

Live publishing additionally requires both `CONTENT_STUDIO_ENABLE_LIVE_PUBLISH=true` and `--confirm LIVE_PUBLISH`. Use `hive-env-run --` so credentials remain in the shared HivemindOS environment.

After distribution, attach platform outcomes to the same run:

```bash
uv run content-studio metrics record <manifest.json> --platform youtube --views 1000 --completed-views 620 --clicks 35 --conversions 4 --revenue 80
uv run content-studio metrics summary <manifest.json>
```

## Agent access

Two MCP servers are included. `content-studio-mcp` is the primary agent contract and exposes high-level run, intent, asset, evaluation, experiment, metric, and publishing tools plus these discoverable resources:

- `studio://capabilities`
- `studio://providers`
- `studio://telemetry/generations`
- `studio://runs/{run_id}`
- `studio://runs/{run_id}/artifacts`
- `studio://runs/{run_id}/next-actions`

- `content-studio-mcp`: unified durable workflows; it can request approval but cannot approve or deny its own request.
- `auto-clipper-mcp`: focused compatibility surface for existing clipping agents.

The optional operator console is secondary and starts locally with `hive-env-run -- uv run content-studio-api`. It reads the same state store; authenticated mutations require `CONTENT_STUDIO_CONTROL_TOKEN`.

The repository also snapshots the relevant Shared Brain skills under `skills/shared/` and vendors the audited Clueso workflow shelf under `skills/vendor/clueso-ai/`. `skills/hivemind-content-studio/SKILL.md` is linked into `.agents/skills/` as the canonical entry skill; provider adapters are operational references, not duplicate implementations.

## Safety and licensing

- No credential values belong in this repository. `.env.example` contains key names only.
- Remote media is untrusted input and is validated before rendering/publishing.
- Remote URL ingestion and generated-media downloads enforce public HTTPS/SSRF, byte-size, MIME, and decode checks. Private generation URLs are disabled by default.
- Agent runtimes are registered by operator-owned environment keys; agents submit a runtime id, not an argv array.
- Paid generation and run approval use one-time exact-scope receipts. Editor mutation and public publishing retain separate gates.
- Auto Clipper is declared AGPL-3.0-or-later. The combined work is therefore configured as AGPL-3.0-or-later; see `THIRD_PARTY_NOTICES.md` before distribution.

See [Architecture](docs/ARCHITECTURE.md), [Operations](docs/OPERATIONS.md), [Migration Map](docs/MIGRATION_MAP.md), and [Monetization](docs/MONETIZATION.md).
