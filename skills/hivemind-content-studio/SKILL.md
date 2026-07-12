---
name: hivemind-content-studio
description: Operate the agent-first Hivemind Content Studio for durable first-frame animation ads, stickman ads, static text ads, faceless shorts, clipping, local or cloud media generation, exact voice, assembly, semantic evaluation, approval-gated social posting, experiments, and monetization metrics. Use when an agent must create, resume, inspect, evaluate, publish, or optimize social content through the unified repo rather than invoking Auto Clipper, AI Animation Factory, MoneyPrinterTurbo, MUAPI, Higgsfield, Media Studio, Postiz, or Upload-Post as overlapping standalone pipelines.
---

# Operate Hivemind Content Studio

Use the MCP run engine as the primary contract. Use the CLI for operator work or when MCP is unavailable. Do not invoke donor pipelines independently.

## Workflow

1. Read `studio://capabilities` and `studio://providers`.
2. Create a durable run with `execute_content_run`. Set explicit privacy and maximum cost policy.
3. Read `studio://runs/{run_id}/next-actions`; perform only the requested bounded action.
4. Use `route_content_intent` before `execute_content_intent`. Preserve its provider-selection and rejection evidence.
5. Attach remote assets through the base64 or public-HTTPS ingestion tools. Do not pass arbitrary host paths from a remote agent.
6. For direct paid-provider work, submit a bounded estimate. Stop when the tool returns `awaiting_approval`; an operator must decide it outside MCP. Retry with the exact one-time receipt. For `hivemindos-hosted-media`, use the live HivemindOS retail quote as the maximum debit and obey the HivemindOS company-governance result; do not create or bypass a duplicate studio approval.
7. Resume the run after adding script, keyframes, scene videos, voice, or evaluation evidence.
8. Run deterministic semantic preflight, then record structured semantic evaluation with per-scene failures and regeneration instructions.
9. Request separate rights/claims run approval before publishing. An agent may request approval but cannot approve or deny it.
10. Dry-run publishing. Live publishing still requires the approved manifest, enabled live-publish policy, and explicit outward-action gate.
11. Ingest idempotent outcome entries with external IDs, spend, retention, conversions, and revenue. Change one measured creative dimension per recommended child variant.
12. Read `studio://telemetry/generations` or call `get_generation_telemetry` when choosing between providers, estimating completion time, or investigating failures. Use aggregate timing and success evidence; never infer quality from speed alone.

## Lanes

- `first-frame-animation-ad`: agent-authored script, consistent scene keyframes, image-to-video, exact voice, deterministic assembly.
- `stickman-performance-ad`: deterministic black-line frames with optional product/UGC cut-ins.
- `static-text-ad`: deterministic plain-background headline/subtext creative for cheap control variants.
- `animation`: general scene-driven media production.
- `faceless`: embedded MoneyPrinterTurbo renderer.
- `clip`: embedded Auto Clipper with rights and monetization evidence.
- `social-post`: evaluation and distribution of an existing asset.

## Provider rules

- Treat Higgsfield Cloud and Higgsfield consumer as separate auth/billing surfaces. Never silently switch.
- For Higgsfield consumer, use explicit model IDs. The documented defaults are GPT Image 2 for general keyframes and Seedance 2.0 for serious image-to-video.
- For Higgsfield Cloud motion, require a public source URL or a real upload integration; a local path is not remotely reachable.
- For MUAPI, discover the selected endpoint's live schema and put its explicit endpoint/payload template under `provider_options.muapi`. Never guess model payloads.
- Prefer `hivemindos-hosted-media` when the user wants zero provider setup and hosted credits. Discover the model/schema through `/api/hivemindos/media`, store an explicit model/payload template under `provider_options.hivemindos-hosted-media`, and bind execution to the returned retail quote. The HivemindOS route owns the provider key, 25% markup, credit reservation/refunds, company budgets, approvals, idempotency, and receipts.
- Prefer ready local providers under `local-only` or `local-first`: deterministic static/stickman renderers, Universal TTS, Media Studio MCP, FFmpeg/MoneyPrinterTurbo, and Auto Clipper.
- Treat `skills/vendor/clueso-ai/` as a provider-specific workflow shelf, not a second orchestrator. Select `clueso-mcp` only when the user explicitly requests Clueso or the provider matrix allows it, verify its authenticated tools in the active general agent runtime, and read the central Clueso policy before its namespaced workflow adapter.
- Keep provider job IDs, source URLs, model IDs, hashes, and dependencies on canonical artifacts.

## Safety

- Agent script execution uses operator-registered runtime IDs only. Never accept an agent-supplied argv array.
- Never print or persist credential values. Use shared env keys by name only.
- Do not bypass the approval ledger with legacy confirmation strings. Internal adapter confirmations are implementation details, not authority.
- Do not claim remote cancellation, publication, or payment success without a provider receipt.
- Do not publish scraped or third-party media without documented rights.

Use the focused skills under `skills/shared/` and the audited `clueso-*` adapters only for provider-specific operational knowledge, payload discovery, subtitle timing, assembly, and QA. Executable configuration, routing, provenance, approval, publishing, and metrics remain single-sourced in this package.
