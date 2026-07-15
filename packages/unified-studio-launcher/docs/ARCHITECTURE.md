# Architecture

The template separates the reusable "studio wrapper" from any particular media
stack.

## Layers

- **Dashboard server:** `src/server.mjs` serves the browser UI and JSON API.
- **Config loader:** `src/config.mjs` reads `studio.config.json` or the example
  config.
- **Service manager:** `src/service-manager.mjs` runs whole-stack actions or
  per-service process commands, probes health endpoints, and stores local PIDs
  under `.studio/state.json`.
- **Repository manager:** `src/repository-manager.mjs` optionally clones,
  updates, and inspects external repos declared in `repositories`.
- **Browser UI:** `public/*` renders status cards and action buttons.
- **Launchers:** `src/launchers.mjs` creates a macOS `.app`, Linux `.desktop`
  launcher, or Windows Start Menu `.cmd` launcher.

## Runtime Model

```text
User
  -> Unified Media Studio dashboard
    -> /api/status
    -> /api/repositories
    -> /api/bootstrap
    -> /api/action
      -> whole-stack supervisor command
      -> or per-service start/stop commands
        -> ComfyUI
        -> gateway/API
        -> mobile workflow UI
        -> native sidecars
```

## Configuration Contract

Each service can define:

- `id`
- `name`
- `role`
- `url`
- `healthUrl`
- `cwd`
- `env`
- `start`
- `stop`

Whole-stack `actions` take precedence over per-service commands. This lets an
existing supervisor such as `zimage-stack`, `docker compose`, `launchctl`, or a
custom shell script own process lifecycle while this repo owns the product UI.

Commands can be plain arrays:

```json
["python3", "main.py"]
```

or platform maps:

```json
{
  "darwin": ["python3", "main.py"],
  "linux": ["python3", "main.py"],
  "win32": ["python", "main.py"],
  "default": ["python", "main.py"]
}
```

Service `env` can be a flat object, a platform object, or a flat object with
platform-specific values. The selected values are merged into the spawned
process environment:

```json
{
  "env": {
    "darwin": {
      "ZIMG_ACCELERATOR_PROFILE": "apple-silicon"
    },
    "win32": {
      "ZIMG_ACCELERATOR_PROFILE": "cuda"
    }
  }
}
```

For Apple Silicon ComfyUI profiles, keep MLX/native sidecar concerns in the
gateway or sidecar services and use ComfyUI-specific launch flags such as
`--use-quad-cross-attention` on the Darwin command. Windows launch commands
remain independent through the `win32` branch.

## Repository Contract

The template does not vendor other repos by default. It can point at existing
local checkouts through service `cwd` paths, or it can clone external repos
declared in `repositories`.

Each repository can define:

- `id`
- `url`
- `ref`
- `path`
- `install`

`npm run bootstrap` clones missing repositories. `npm run bootstrap -- --update`
fetches existing repositories and checks out configured refs.
`npm run bootstrap -- --install` also runs configured install commands.

This gives forks three packaging options:

- Use existing local checkouts during development.
- Dynamically clone sources into `vendor/` from the manifest.
- Replace the manifest with git submodules or release artifacts for stricter
  product builds.

## Workflow Manifests

Workflow installers live under `scripts/`, with declarative manifests under
`manifests/`. The Civitai installer downloads workflow archives through the
configured local downloader endpoint, extracts editor-format workflow JSON into
the target ComfyUI checkout, applies declared local compatibility patches, checks
`/object_info` for missing runtime node classes, and reports model files under
`ComfyUI/models`.

Model weights stay out of git. Manifests may declare direct model URLs and sizes,
but downloads are explicit so public forks can decide whether to pull large
checkpoints locally, package them separately, or leave them to a fleet-specific
model manager.

## What To Customize

- Replace `public/*` with a richer React/Next/Tauri/Electron frontend.
- Add typed engine adapters in `src/adapters/`.
- Add a model registry and downloader.
- Add auth, profiles, update channels, logs, and crash reports.
- Add signed installers and update channels for macOS, Windows, and Linux.
