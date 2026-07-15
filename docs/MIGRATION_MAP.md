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
| Unified Media Studio Template | service catalog, workflow installers, tests, cross-platform launchers | `packages/unified-studio-launcher` and `hivemind_content_studio.unified_runtime` | Tracked source embedded; parallel dashboard retired |
| Hive Image Stack | local Media Studio gateway, model manager, ComfyUI proxy, MCP, native engine routing | `packages/media-gateway` | Tracked source and the previously external supervisor embedded; does not own content runs |
| Open Generative AI fork | image/video/edit/workflow UI, model catalog, Liam local inference additions | `packages/open-generative-ai` and Explore | Complete tracked fork embedded with browser and Electron local-inference bridges. Fork `0ab564b` was 2 ahead / 0 behind upstream `7c8df61` on import |
| ComfyUI Mobile Frontend fork | workflow editing, queue, output browser, native workflow refinements | `packages/comfyui-mobile` and Canvas | Complete tracked fork embedded; the ComfyUI custom-node link points here |
| Flux 2 Swift MLX fork | Apple Silicon native generation and local conversion tools | `engines/flux-2-swift-mlx` | Tracked source plus three ignored owner-authored conversion scripts embedded |
| Z-Image Swift fork | Apple Silicon Z-Image generation | `engines/z-image-swift` | Complete tracked source embedded as a managed engine |

## Removed overlap

- MoneyPrinterTurbo no longer imports an Upload-Post singleton or auto-publishes after rendering.
- Auto Clipper no longer carries a second Postiz HTTP client.
- Animation artifacts use generic role names (`image-prompts`, `motion-prompts`, `voice-lines`, `music-brief`) rather than provider-branded duplicates.
- Credential values are never written into app config; providers read environment at call time.
- A single publish receipt format is used for Postiz and Upload-Post.
- Script generation uses a general agent-runtime contract rather than a vendor-specific integration.
- MUAPI, Higgsfield Cloud, Higgsfield consumer, and ElevenLabs use one paid-generation gate and one manifest artifact shape.
- Repository launchers do not define product navigation. Explore, Canvas, and Models are embedded tool surfaces inside the canonical shell.

## Migrated local state

- Gateway history, jobs, equipped models, selected LoRAs, and the last mobile prompt LoRAs were copied to `~/.hivemindos/media-studio/state/media-gateway/`.
- A new gateway bearer token was generated at `~/.hivemindos/media-studio/secure/zimg-token`; old plaintext token files were not copied.
- OpenGen backups, ignored local-inference source, and loose generated bundles were archived under `~/.hivemindos/media-studio/archives/open-generative-ai/`.
- ComfyUI models, workflows, custom nodes, inputs, outputs, and caches remain in their existing external runtime directories and are not deleted with donor checkouts.
- The migration receipt is stored under `~/.hivemindos/media-studio/migration-manifests/`.

## Compatibility surfaces retained

- MoneyPrinterTurbo's existing web/API entrypoints remain usable during migration, but the unified studio is the canonical creation surface.
- `auto-clipper` and `auto-clipper-mcp` remain available for focused clipping workflows.
- New work should enter through `content-studio` or `content-studio-mcp` so it receives a canonical manifest.
- Old image-studio checkouts are removable only after the cold-start and feature gates in `docs/OPERATIONS.md` pass and license review permits committing the embedded source.
