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

## Removed overlap

- MoneyPrinterTurbo no longer imports an Upload-Post singleton or auto-publishes after rendering.
- Auto Clipper no longer carries a second Postiz HTTP client.
- Animation artifacts use generic role names (`image-prompts`, `motion-prompts`, `voice-lines`, `music-brief`) rather than provider-branded duplicates.
- Credential values are never written into app config; providers read environment at call time.
- A single publish receipt format is used for Postiz and Upload-Post.
- Script generation uses a general agent-runtime contract rather than a vendor-specific integration.
- MUAPI, Higgsfield Cloud, Higgsfield consumer, and ElevenLabs use one paid-generation gate and one manifest artifact shape.

## Compatibility surfaces retained

- MoneyPrinterTurbo's existing web/API entrypoints remain usable during migration, but the unified studio is the canonical creation surface.
- `auto-clipper` and `auto-clipper-mcp` remain available for focused clipping workflows.
- New work should enter through `content-studio` or `content-studio-mcp` so it receives a canonical manifest.
