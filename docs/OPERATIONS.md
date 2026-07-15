# Operations

## Configuration

Run with shared credentials without copying secrets:

```bash
hive-env-run -- uv run content-studio doctor
```

Project/process environment wins over the shared hive environment, so a project-specific provider can override a fleet default without changing files.

The studio server reads `~/.hivemindos/.env` as its only default shared fallback and fills only variables missing from the process. The browser receives provider readiness, capability, cost class, and safe status text—not credential values. Do not add secret inputs or return environment values from frontend routes. Protected operator actions remain separate: the browser may hold an operator token in memory for the current page, but the server never autofills that token from the shared environment into browser state.

## Local services

The browser is one native Studio and does not mount local-service UIs.
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

Run the stdio MCP server with `hive-env-run -- uv run content-studio-mcp`. Agents should begin with `studio://capabilities` and `studio://providers`, create a run with `execute_content_run`, and inspect `studio://runs/<id>/next-actions` after every external step.

Start the local creation and operations studio with:

```bash
hive-env-run -- uv run content-studio-api
```

Open `http://127.0.0.1:8765`. The default flow creates a production from a title, creative direction, lane, and optional scenes. Advanced panels expose provider routing, voice/captions, distribution, MoneyPrinter faceless controls, privacy, budget, and operator credentials only when needed. Creating a run is a safe local draft operation; resume, retry, cancellation, and approval decisions require `Authorization: Bearer <CONTENT_STUDIO_CONTROL_TOKEN>`. The approval signing secret and operator token remain server-side.

## Recovery and rollback

- Cancel: `content-studio run cancel <run-id> --reason <reason>` preserves all evidence.
- Resume: `content-studio run resume <run-id>` continues from the first incomplete step.
- Retry: `content-studio run retry <run-id> <step-id>` increments the bounded attempt count.
- Filesystem rollback: archive or remove only the target run directory after cancelling; do not delete shared SQLite state by hand.
- Approval receipts are one-use and expire. Request a new exact scope instead of editing ledger rows.
