# Unified Media Studio Template

A small, configurable starter repo for shipping one local media-generation app
that supervises multiple internal services: ComfyUI, a gateway/API, a mobile
workflow UI, model managers, and native sidecars.

The template is intentionally generic. It does not include private workflows,
model weights, tokens, Tailnet IPs, or hard-coded local paths from any one
machine. Fork it, copy `studio.config.example.json` to `studio.config.json`, and
replace the service commands with your own stack.

This repo is a product shell, not a vendor dump. By default it does not contain
ComfyUI, mobile frontends, native engines, or gateway repos. You can either point
the config at existing local checkouts, or define `repositories` and run
`npm run bootstrap` to clone them into `vendor/`.

## What You Get

- A local dashboard with service health, start/restart/stop controls, and raw
  service metadata.
- A config-driven service manifest.
- Optional whole-stack actions for existing supervisors such as `zimage-stack`.
- A fallback per-service process launcher for simpler stacks.
- macOS, Linux, and Windows launchers for double-click starting.
- Optional repository bootstrapping for ComfyUI, gateways, frontends, and engine
  sidecars.
- A tiny adapter surface that people can extend without adopting one specific
  backend.

## Quickstart

```bash
cp studio.config.example.json studio.config.json
npm test
npm run doctor
npm run start
```

On Windows Command Prompt, use:

```cmd
copy studio.config.example.json studio.config.json
npm test
npm run doctor
npm run start
```

Open the dashboard at:

```text
http://127.0.0.1:4888
```

Install a local launcher for your current OS:

```bash
npm run install:launcher
```

On macOS this creates `~/Applications/Unified Media Studio.app`. On Linux it
creates a `.desktop` launcher plus a shell command under `~/.local`. On Windows
it creates a Start Menu `.cmd` launcher.

## Configure Your Own Stack

Edit `studio.config.json`.

Use `actions` when you already have a whole-stack supervisor:

```json
{
  "actions": {
    "start": ["zimage-stack", "start"],
    "stop": ["zimage-stack", "stop"],
    "restart": ["zimage-stack", "restart"]
  }
}
```

Use per-service `start` commands when the template should start each process:

```json
{
  "services": [
    {
      "id": "comfyui",
      "name": "ComfyUI",
      "healthUrl": "http://127.0.0.1:8188/system_stats",
      "start": ["python3", "main.py", "--listen", "127.0.0.1", "--port", "8188"],
      "cwd": "/path/to/ComfyUI"
    }
  ]
}
```

Commands can be platform-specific:

```json
{
  "start": {
    "darwin": ["python3", "main.py"],
    "linux": ["python3", "main.py"],
    "win32": ["python", "main.py"]
  }
}
```

Services can also define environment variables. Use a flat map for all
platforms, a platform map for the whole service, or platform maps on individual
values:

```json
{
  "env": {
    "darwin": {
      "ZIMG_ACCELERATOR_PROFILE": "apple-silicon",
      "ZIMG_ENABLE_APPLE_SILICON_OPTIMIZATIONS": "1"
    },
    "win32": {
      "ZIMG_ACCELERATOR_PROFILE": "cuda"
    }
  }
}
```

Use `repositories` when you want this repo to clone external pieces:

```json
{
  "repositories": [
    {
      "id": "comfyui",
      "url": "https://github.com/comfyanonymous/ComfyUI.git",
      "ref": "master",
      "path": "vendor/ComfyUI"
    }
  ]
}
```

Then run:

```bash
npm run repos
npm run bootstrap
npm run bootstrap -- --update
npm run bootstrap -- --install
```

`bootstrap` clones missing repos. `--update` fetches existing repos. `--install`
runs the install commands you configured for each repo.

See `examples/comfyui-local.config.json` for a minimal dynamic ComfyUI install.
See `examples/ltx23-eros-anchor.config.json` for an LTX 2.3 workflow profile
that keeps Apple Silicon `--use-quad-cross-attention` and Windows CUDA launch
paths separate.

## Civitai Workflow Manifests

This repo includes a manifest installer for the Civitai.red workflow archive:

```text
ComfyUI LTX2.3 Eros Anchor Video Generation
model 2667355, version 2995139, file 2874732
```

Install or refresh the workflow archive through the local Civitai downloader
endpoint:

```bash
npm run setup:ltx23-eros
```

If the archive is already present in your ComfyUI `models/Workflows` folder,
reuse it and install the declared custom nodes:

```bash
npm run setup:ltx23-eros -- --skip-download --install-nodes
```

The installer extracts the editor-format workflow to:

```text
~/comfy/ComfyUI/workflows/civitai/ltx23-eros-anchor/ltx23-eros-anchor.editor.json
```

It also checks the running ComfyUI `/object_info` endpoint, reports missing
runtime node classes, applies declared local compatibility patches, and reports
required model files. On Apple Silicon, the LTX profile applies the tracked
KJNodes LTX2 LoRA bypass patch so repeated LoRA weight repatching stays on the
ComfyUI MPS fast path. Large Hugging Face model weights are declared in
`manifests/civitai/ltx23-eros-anchor.json`, but are only downloaded when
explicitly requested. This command downloads required weights:

```bash
npm run setup:ltx23-eros -- --skip-download --download-models
```

Add `--download-optional-models` to include optional model files.

That model step is large: the primary `10Eros_v1-fp8mixed_learned.safetensors`
checkpoint is about 29 GB before the text encoder, upscaler, VAE, and LoRA
files. The Civitai workflow archive itself is small and is downloaded via the
existing downloader endpoint.

## Scripts

```bash
npm run start          # start stack, serve dashboard, open browser
npm run serve          # serve dashboard only
npm run status         # print service status JSON
npm run repos          # print configured repository status
npm run bootstrap      # clone configured repositories
npm run doctor         # check config and paths
npm run install:launcher # create a launcher for the current OS
npm run setup:ltx23-eros # install/check the LTX 2.3 Eros Anchor workflow
npm test              # run template tests
```

## Repository Goals

This repo is for people who want to build their own unified media studio without
starting from a private one-off script.

Good modifications:

- Add your own engine adapter.
- Replace the dashboard with React, Next.js, Tauri, or Electron.
- Add model-download manifests.
- Add workflow/project libraries.
- Package platform-specific runtimes.

Avoid putting these in git:

- Model weights.
- API tokens.
- Private workflow JSON.
- User output folders.
- Machine-specific Tailnet IPs.

## License

MIT. See `LICENSE`.
