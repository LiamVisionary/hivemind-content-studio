# Migration map

## Assimilated responsibilities

| Source | Source responsibility | Unified destination | Decision |
|---|---|---|---|
| MoneyPrinterTurbo-private | FastAPI/Streamlit faceless generation and local TTS | `app/` plus unified studio faceless controls | Backbone retained; reusable controls adapted; render-time auto-upload removed |
| Auto Clipper | ingestion, transcripts, Podcli, clip rights/approval, monetization | `src/auto_clipper/` | Embedded as the focused clipping engine |
| Auto Clipper | Postiz client/payload | `hivemind_content_studio.publishing` | Replaced by one current official API implementation |
| AI Animation Factory | brief and scene artifact planning | `hivemind_content_studio.planner` | Adapted into provider-neutral canonical runs |
| AI Animation Factory | Upload-Post helper | `hivemind_content_studio.publishing` | Replaced by current Upload-Post endpoint/auth contract |
| HivemindOS | Media Studio `mcpVideo` preference and video-generation bridge | `hivemind_content_studio.media_studio` | Dynamic Streamable HTTP image-to-video MCP adapter |
| HivemindOS | Palmier Pro catalog and endpoint | `hivemind_content_studio.mcp_http` | Optional editor/timeline MCP adapter |
| Shared Brain | generation, clipping, TTS, assembly, QA, publishing playbooks | `skills/shared/` | Versioned snapshots with a sync tool |
| Shared Brain | MUAPI, Higgsfield, API quirks, AI UGC, and exact-line ElevenLabs workflows | `skills/shared/` plus canonical adapters | Skills choose payloads/models; executable gates and manifest receipts stay single-sourced in the studio package |
| Unified Media Studio Template | service catalog, repository bootstrap, cross-platform launchers | `hivemind_content_studio.unified_runtime` plus future operator lifecycle CLI | Catalog pattern assimilated; parallel dashboard rejected |
| Hive Image Stack | local Media Studio gateway, model manager, ComfyUI proxy, MCP, native engine routing | internal provider adapters plus `hivemind_content_studio.media_studio` | Kept as an invisible managed engine; does not own content runs |
| Open Generative AI fork | image/video/edit/workflow UI, model catalog, Liam local inference additions | native Studio modes and provider executors | Donor behavior assimilated; separate UI/runtime rejected. Fork `0ab564b` confirmed 2 ahead / 0 behind upstream `7c8df61` on 2026-07-15 |
| ComfyUI Mobile Frontend fork | workflow editing, queue, output browser, native workflow refinements | native Workflow, Runs, Models, and artifact-library components | Donor behavior assimilated; separate frontend rejected |
| Flux 2 Swift MLX and Z-Image Swift forks | Apple Silicon native generation | managed sidecars behind Hive Image Stack | Engines retained out of process; artifacts enter canonical manifests through the gateway |

## Removed overlap

- MoneyPrinterTurbo no longer imports an Upload-Post singleton or auto-publishes after rendering.
- Auto Clipper no longer carries a second Postiz HTTP client.
- Animation artifacts use generic role names (`image-prompts`, `motion-prompts`, `voice-lines`, `music-brief`) rather than provider-branded duplicates.
- Credential values are never written into app config; providers read environment at call time.
- A single publish receipt format is used for Postiz and Upload-Post.
- Script generation uses a general agent-runtime contract rather than a vendor-specific integration.
- MUAPI, Higgsfield Cloud, Higgsfield consumer, and ElevenLabs use one paid-generation gate and one manifest artifact shape.
- Repository names, workspace URLs, and iframes do not define product navigation; users operate native capabilities and canonical assets.

## Compatibility surfaces retained

- MoneyPrinterTurbo's existing web/API entrypoints remain usable during migration, but the unified studio is the canonical creation surface.
- `auto-clipper` and `auto-clipper-mcp` remain available for focused clipping workflows.
- New work should enter through `content-studio` or `content-studio-mcp` so it receives a canonical manifest.
