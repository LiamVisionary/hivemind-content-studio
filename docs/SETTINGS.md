# Settings

Generated from `src/hivemind_content_studio/settings.py` — run
`python -m hivemind_content_studio.settings --docs > docs/SETTINGS.md` after changing the schema.

Every row here is changeable in the app: **Settings** in the Advanced group, or ⌘,.
The document is written to `<media state>/content-studio/settings.json`
(`CONTENT_STUDIO_SETTINGS_FILE` moves it) and the bash supervisor exports the same
document for the servers that only read environment variables.

Precedence is **environment > document > default**, and the Settings page reports which
one each value came from, so a variable pinned in `stack-local.env` is visible rather
than mysterious.

Secrets are not here and cannot be: keys, tokens and passwords live in PassBook, and
`settings.py` refuses any credential-shaped key at import.

## Models & storage (`paths`)

| Key | Default | Restart | Environment override | What it does |
| --- | --- | --- | --- | --- |
| `paths.data_dir` | `<repo>/data in a checkout, ~/.hivemindos/media-studio/content-studio in the app` | yes | `CONTENT_STUDIO_DATA_DIR` | Where the studio keeps its own state — runs, jobs, the account vaults. |
| `paths.runs_dir` | `<data dir>/runs` | yes | `CONTENT_STUDIO_RUNS_DIR` | Where production runs are written. |
| `paths.models_root` | `~/comfy/ComfyUI` | yes | `COMFY_DIR` | The ComfyUI folder whose models/ subtree holds the local weights. |
| `paths.output_root` | `~/.comfy-private.noindex/z_image_outputs` | yes | `ZIMG_OUTPUT_DIR` | Where finished images and video land on disk. |
| `paths.model_cache_dir` | `~/.cache/huggingface` | yes | `HF_HOME` | The download cache for models fetched from Hugging Face. |

## Engines (`lanes`)

| Key | Default | Restart | Environment override | What it does |
| --- | --- | --- | --- | --- |
| `lanes.ltx` | `off` | yes | `COMFY_ENABLE_LTX_LANE` | Run the dedicated LTX video lane on this machine. |
| `lanes.flux2_server` | `off` | yes | `ZIMG_ENABLE_FLUX2_SERVER` | Keep the Swift/MLX Flux 2 image server warm. |
| `lanes.apple_silicon_optimizations` | `on` | yes | `ZIMG_ENABLE_APPLE_SILICON_OPTIMIZATIONS` | Use the Apple Silicon tuning for the local lanes. |

## Network (`network`)

| Key | Default | Restart | Environment override | What it does |
| --- | --- | --- | --- | --- |
| `network.control_host` | `127.0.0.1` | yes | `CONTENT_STUDIO_CONTROL_HOST` | The address the studio itself listens on. |
| `network.control_port` | `8765` | yes | `CONTENT_STUDIO_CONTROL_PORT` | The port the studio itself listens on. Change it when something else already has 8765. |
| `network.gateway_url` | `http://127.0.0.1:8787` | no | `CONTENT_STUDIO_GATEWAY_URL`, `ZIMG_GATEWAY_URL`, `MEDIA_STUDIO_BACKEND_URL` | Where the media gateway answers. |
| `network.upload_base` | `http://127.0.0.1:8788` | no | `MEDIA_STUDIO_UPLOAD_BASE`, `MEDIA_STUDIO_STUDIO_URL`, `ZIMG_STUDIO_URL` | Where references are uploaded for the Canvas and the agent tools. |
| `network.bridge_url` | `http://127.0.0.1:8794` | no | `OPEN_GENERATIVE_AI_URL`, `OGA_URL` | Where the local-inference bridge answers. |
| `network.mcp_url` | `http://127.0.0.1:8796/mcp` | no | `MEDIA_STUDIO_MCP_URL` | Where agents reach this machine's media tools. |
| `network.comfy_url` | `http://127.0.0.1:8188` | no | `COMFY_HTTP_DEFAULT`, `COMFY_HTTP`, `COMFYUI_URL` | Your own ComfyUI. The studio attaches to it and never starts or stops it. |

## Privacy & vault (`privacy`)

| Key | Default | Restart | Environment override | What it does |
| --- | --- | --- | --- | --- |
| `privacy.output_encryption` | `on` | yes | `ZIMG_OUTPUT_ENCRYPTION` | Encrypt finished media at rest. Off writes plain files anyone on this Mac can open. |
| `privacy.agent_dual_seal` | `off` | yes | `ZIMG_AGENT_DUAL_SEAL` | Also seal agent-requested outputs to the agent that asked for them. |

## Rented GPUs (`reaper`)

| Key | Default | Restart | Environment override | What it does |
| --- | --- | --- | --- | --- |
| `reaper.autoreap` | `on` | no | `HIVEMIND_RENTAL_AUTOREAP` | Destroy a rented box that failed to provision. Off keeps it billing so you can SSH in. |
| `reaper.grace_seconds` | `60` | no | `HIVEMIND_RENTAL_REAP_GRACE` | How long a failed box is left alone before it is destroyed. |
| `reaper.bad_machine_hours` | `24` | no | `HIVEMIND_RENTAL_BAD_MACHINE_HOURS` | How long a host that just failed stays out of the running. |

## Still environment-only

These are not user settings and have no row above. They are named here so nobody has to
guess which of the ~87 environment variables in this package a person is expected to set.

| Variable | Who sets it | Why it is not a setting |
| --- | --- | --- |
| `CONTENT_STUDIO_ROOT`, `CONTENT_STUDIO_FRONTEND_DIST` | installer | Decided by the build; a wrong value is a broken install, not a preference. |
| `CONTENT_STUDIO_WEBAUTHN_RP_ID`, `CONTENT_STUDIO_WEBAUTHN_ORIGINS` | installer | Set with the port the shell actually bound; changing one alone orphans every enrolled passkey. |
| `HIVEMIND_MEDIA_STATE_DIR`, `COMFY_PRIVATE_ROOT` | installer | The document itself lives under these, so they cannot be set from inside it. |
| `HIVE_HOME` | installer | PassBook's store. Owned by PassBook, shared with every app on the machine. |
| `CONTENT_STUDIO_ENABLE_LIVE_PUBLISH`, `CONTENT_STUDIO_ALLOW_PRIVATE_GENERATION_DOWNLOADS` | developer | Safety switches that exist to be off in the shipped app. |
| `CONTENT_STUDIO_MAX_GENERATION_BYTES`, `ZIMG_OUTPUT_ENCRYPTION_ITER` | developer | Tuning with no honest unit to show a person. |
| `COMFY_LANES`, `ZIMG_ACCELERATOR_PROFILE`, `ZIMG_KLEIN_*_MEMORY_GB` | developer | Bench and lane experiments; the Models page reports what actually answered. |
| `*_API_KEY`, `*_TOKEN`, `POSTIZ_API_KEY`, `UPLOAD_POST_*` | PassBook | Credentials. Never in this document — see PassBook in the Advanced group. |
