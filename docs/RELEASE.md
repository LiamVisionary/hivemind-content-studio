# Release — what the download contains, and the decisions behind it

This document exists so `src-tauri/` can be written from a spec instead of from
guesswork. Today the shipped shell is a webview pointed at
`HIVEMIND_STUDIO_URL || http://127.0.0.1:8765` and the thing that serves that URL
is `scripts/hivemind-studio-stack`, a 36 KB bash supervisor bound to a git
checkout, a hand-built ComfyUI, `uv`, three `npm ci` runs and a macOS LaunchAgent.
A user who downloaded that shell today would get an empty window. Everything
below names what changes.

`scripts/hivemind-studio-stack` stays. It is the **developer** supervisor and the
reference implementation of the process tree; the Rust shell reimplements the
same tree without launchd, and the two are expected to keep the same ports so a
developer can attach the packaged app to a hand-started stack.

---

## 1. The shipped process tree

The app bundle carries its own runtimes. Nothing below is resolved from the
user's `PATH`, because a desktop app launched from Finder has no shell profile:
it inherits a bare environment, which is exactly how the current stack's
`uv run` / `npm run start` invocations would fail.

**Bundled runtimes**

| Runtime | Why it is bundled |
|---|---|
| python-build-standalone 3.12 (arm64) | `pyproject.toml` pins `>=3.11,<3.13`; 3.12 is the newest inside that window. A system Python cannot be assumed, and `uv` cannot be a user prerequisite. |
| A frozen venv from `uv export --extra desktop` | Deterministic, no git fetch at first run, no compiler. PassBook is vendored as a wheel into the build so `passbook @ git+https://…` never needs network. |
| Node (LTS, arm64) | Three shipped processes are Node. |
| Static `ffmpeg` / `ffprobe` | Resolved with `shutil.which` all over the engine (`doctor.py`), and placed first on every child's `PATH`. |

**Supervised children** — the Rust shell starts these, restarts them on crash
with backoff, and stops them on quit. Each gets an explicit environment; none
inherits one.

| Process | Runtime | Port | Health |
|---|---|---|---|
| Control API (`content-studio-api`, `control_api.py`) | bundled Python | 8765 (`CONTENT_STUDIO_CONTROL_PORT`) | `GET /api/runtime` |
| Media gateway (`packages/media-gateway/app.py`) | bundled Python | 8787 | `GET /health` |
| Gateway frontend / Canvas (`packages/media-gateway/server.js`) | bundled Node | 8788 | `GET /` |
| Local-inference bridge (`packages/open-generative-ai/hosted-server.js`) | bundled Node | 8794 (`OGA_PORT`) | `GET /health` |
| Media Studio MCP (`packages/media-gateway/bin/media-studio-mcp.mjs --http`) | bundled Node | 8796 (`MEDIA_STUDIO_MCP_PORT`) | `GET /mcp` |

**Attach-only — never spawned, never killed by the shell**

* **ComfyUI lanes** (8188 default, 8198 Anima, 8199 LTX). The user's own
  checkout, its own venv, its own ~25 pinned custom nodes. The shell probes
  `COMFY_LANES`, shows what answered on the Models page, and offers the guided
  setup described in §6 when nothing does. It must never `kill_port 8188`: a
  desktop app that kills a user's ComfyUI because it quit is a bug report, and
  the developer stack's `kill_port` behaviour is exactly what not to copy.
* **Swift MLX engines** (`engines/flux-2-swift-mlx` 8791, `engines/z-image-swift`).
  macOS 15+ Apple Silicon extras, downloaded from the release page on request,
  launched by the user or by an explicit action in the app. Same rule: attach,
  report, never reap.
* **Rented and hosted lanes.** Already remote; nothing to supervise.
* **Tailscale HTTPS proxy** (8789). Developer/fleet only; not in the bundle.

Not shipped at all: the Streamlit WebUI, the MoneyPrinterTurbo HTTP API and the
Redis task backend. The stack has never started them. Their dependencies live
behind the `faceless-webui` extra (§5), and the donor shell itself — `webui/`,
its launchers, `main.py`, the donor's docs, screenshots, agent skill and landing
page, and the seven `test_webui_*.py` files — is archived under
`archive/moneyprinterturbo/` with a README saying how to run it against `app/`.
The engine in `app/` and its own tests stay where they are.

---

## 2. The three load-bearing Tauri decisions

These three are not preferences. Each of them breaks a shipped feature if it is
decided the other way, so they are written down before the scaffold exists.

### 2.1 The webview loads `http://127.0.0.1:<port>`, never `tauri://localhost`

The obvious Tauri design — bundle the Vite `dist/` as app assets and serve it
from the custom protocol — breaks three things at once:

* **The account cookie.** The owner session is a cookie on the control API's
  origin. Under `tauri://localhost` the page's origin is not the API's, so every
  request is cross-origin and the session cookie is not sent.
* **The Canvas iframe.** `ToolSurface` frames the gateway frontend on 8788.
  A custom-protocol parent framing an `http://` child is a mixed, cross-origin
  embed that the webview blocks.
* **The WebAuthn RP id.** Passkeys are bound to an RP id derived from the
  document's host (`accounts.py`, `CONTENT_STUDIO_WEBAUTHN_RP_ID`). A passkey
  enrolled at `127.0.0.1` cannot be used from `tauri://localhost`, and there is
  no migration for an already-enrolled key.

So the window loads the control API over loopback, same-origin with its own API,
exactly as the browser and the current Electron shell already do. The cost is
that the app cannot start until the control API is healthy; the shell shows its
own startup state until `/api/runtime` answers, and never a blank window.

### 2.2 When the port falls back, the shell sets the origin env vars

8765 can be taken — by a developer stack, or by anything else. The shell picks
the first free port in `8765-8785` and, **in the same step**, passes the chosen
origin down:

* `CONTENT_STUDIO_WEBAUTHN_ORIGINS` — the accounts layer accepts an assertion
  only from an origin in this list. Unset, `RelyingParty.for_request` falls back
  to whatever origin the request arrived on, which works but pins nothing; the
  packaged app pins the list to the one origin it actually serves, so a fallback
  port **must** rewrite it in the same step or every enrolled passkey fails to
  verify. Setting it and forgetting to update it is worse than never setting it.
* `CONTENT_STUDIO_WEBAUTHN_RP_ID` — set to `127.0.0.1`. The default already
  strips the port off the Host header, so a passkey survives a port change on
  its own; pinning it means an accidental `localhost` vs `127.0.0.1` difference
  cannot silently orphan an enrolled key.
* `HIVEMIND_STUDIO_TARGET` — what the proxy and MCP layers use to reach the
  control API, and what the developer stack already sets (`stack:598`).

A port fallback that does not carry these three is the failure mode this
decision exists to prevent: the app opens, the studio loads, and sign-in fails
with no explanation.

### 2.3 The app ships **without** the App Sandbox

PassBook is the credential store, and it refuses a sandboxed `HOME`: under the
sandbox macOS rewrites `HOME` to a per-app container, so `~/.hivemindos/.env`
resolves to a private empty directory, PassBook reports every key absent, and
the app looks broken while the store sits untouched two directories away. The
same reasoning applies to the user's ComfyUI checkout, model directories and
`~/.comfy-private.noindex`, all of which live wherever the user put them.

Consequences accepted with this: no Mac App Store distribution (direct DMG
only), and hardened-runtime + notarization carry the security story instead.
The entitlements needed are `com.apple.security.cs.allow-jit` (the webview),
`allow-unsigned-executable-memory` and `disable-library-validation` (the bundled
Python loading native wheels — torch, cryptography, faster-whisper).

---

## 3. Platforms

**v1 is macOS 14+ on Apple Silicon only.** That is what the engines assume: MLX
is Apple Silicon, the ComfyUI lanes are tuned for MPS, and every performance
number in this repository was measured on an M-series machine. An Intel Mac gets
a clear refusal at install time, not a slow app.

Windows and Linux lanes stay present but **disabled**: `electron-builder.config.cjs`
still describes the NSIS and deb/AppImage targets, and
`scripts/package-linux-deb.js` still works, but neither is built, signed or
published for v1. They are kept so the code paths do not rot, and because the
control API and gateway are already platform-neutral — the missing pieces are
the bundled runtimes and the signing chain, not the app.

---

## 4. Tags, signing and updates

**Tag scheme: `studio-v0.x`.** `studio-` because this repository also carries the
upstream MoneyPrinterTurbo engine version (`app.__version__`, currently v1.3.4)
and a bare `v1.3.4` tag would be ambiguous about which product it names. `0.x`
because the Python package is `0.1.0` and the desktop app is pre-1.0; `1.0.0` is
claimed when the first-run experience in §6 needs no terminal. The tag is the
source archive the AGPL offer points at, so it is never moved or deleted.

**Identity** comes from `src/hivemind_content_studio/identity.py` — product name,
bundle id `ai.hivemindos.content-studio`, copyright holder, support-folder name,
source URL. It is generated into
`packages/open-generative-ai/electron/identity.json`
(`python -m hivemind_content_studio.identity --write`), which the Electron main
process, `hosted-server.js`, `electron-builder.config.cjs` and the Tauri config
all read. Nothing else may type the bundle id.

**Signing**: Developer ID Application, hardened runtime, `--timestamp`, then
`notarytool submit --wait` and `stapler staple` on the `.dmg`. The bundled Python
and Node binaries and every native wheel are signed as part of the deep sign;
this is the step most likely to fail late, so it runs in CI on every tag, not
only on release tags.

**Updates**: `tauri-plugin-updater` against a signed `latest.json` on the release
host. Promotion is a **separate, manual step** from tagging: a tag builds and
signs artifacts, and a human then promotes `latest.json` to point at them. A
release that fails smoke-testing is therefore never delivered to anyone, and
rollback is editing one JSON file rather than un-shipping a build. The updater's
public key lives in `tauri.conf.json`; its private key never enters the repo and
is read from the signing environment.

**Notices**: `python3 scripts/generate_notices.py` regenerates `docs/notices.json`
(runtime Python distributions plus the three npm lockfiles) and
`--check` fails the build when it is stale. `docs/notices.json`,
`THIRD_PARTY_NOTICES.md`, `CHANGELOG.md` and `LICENSE` ship inside the bundle
(`CONTENT_STUDIO_DOCS_DIR` points the app at wherever they land). The About page
— nav key `about`, and the version chip in the topbar — renders them from
`GET /api/about`: the `/api/version` payload (product, version, commit, licence,
source URL, build date) plus the generated notices and the recent changelog
headlines. That page is what satisfies the AGPL's interactive notice and its
offer of source, and `test/studio/test_repo_contract.py` fails the build if the
notices file still carries an open distribution gate.

The version itself has exactly one home: `[project] version` in `pyproject.toml`.
Python reads it through package metadata; the JavaScript side reads the same line
through `packages/open-generative-ai/scripts/projectVersion.cjs`, which vite
(`__APP_VERSION__`), electron-builder and the .deb packager all use. The four
package.json files no longer carry versions of their own. `app.__version__` is
the exception and stays: it is the embedded MoneyPrinterTurbo engine's version
and the marker the upstream sync compares against.

---

## 5. Bundled vs detected vs installed

**Bundled** (in the DMG): the bundled Python and its frozen `--extra desktop`
venv, bundled Node, static ffmpeg/ffprobe, the React `dist/`, the comfyui-mobile
`dist/`, the gateway's Next build, `LICENSE`, `THIRD_PARTY_NOTICES.md`,
`docs/notices.json`.

The `desktop` extra is the base dependency list in `pyproject.toml`;
`faceless-webui` holds `streamlit`, `streamlit-tour`,
`azure-cognitiveservices-speech`, `dashscope` and `redis` — the five packages
only the Streamlit WebUI, the MPT HTTP API and two optional cloud providers ever
import, and roughly a third of the venv on disk. All five were already imported
lazily except one: `app/router.py` reached `redis` eagerly through
`app/controllers/v1/video.py`, which made the whole engine unimportable without
it. That import now happens inside the `enable_redis` branch, and
`test/studio/test_packaging_extras.py` proves the engine imports with all five
blocked.

**Detected** (never installed silently, always surfaced in-app with the action
next to the problem, never in a Settings hunt): ComfyUI and its lanes, the Swift
MLX engines, Tailscale, an existing PassBook store, an existing
`~/.hivemindos/media-studio`.

**Installed on first run, with consent and progress**: nothing by default. The
models the user picks on the Models page, and — if they choose it — the guided
ComfyUI setup, whose node manifest is the pinned list already maintained in
`packages/gpu-rentals/provisioning/comfyui-hivemind.sh`. A first launch with no
ComfyUI is a working app with the hosted and rented lanes available and the
local lanes showing a setup card; it is not an error state.

---

## 6. State, and what migrates

The app is not the owner of the user's data directories, and it does not move
them.

| Path | What happens |
|---|---|
| `~/.hivemindos/media-studio` | Adopted in place. This is the canonical private state root (`HIVEMIND_MEDIA_STATE_DIR`); the packaged app reads and writes the same tree the stack does, so a developer machine and the app share one history. |
| `~/.comfy-private.noindex` | Adopted in place (`COMFY_PRIVATE_ROOT`): logs, debug outputs and the private view token. Never relocated into the app container — that is the sandbox decision in §2.3 again. |
| `~/.hivemindos/.env` (PassBook) | Read through PassBook, never copied, never mirrored into the bundle. |
| `~/Library/Application Support/open-generative-ai/local-ai` | The donor-named support folder. The new name is `Hivemind Content Studio` (`identity.py`); `hosted-server.js` prefers the new directory and falls back to the old one while it exists, so a user who already downloaded a local model keeps it instead of re-downloading it to rename a folder. |
| ComfyUI checkout, models, custom nodes, outputs | Untouched. Uninstalling the app removes the bundle and nothing else. |
| LaunchAgent `com.liam.zimage-stack` | Developer-only. The packaged app does not install a LaunchAgent; it supervises its own children for as long as it is running. If the agent is loaded, the app detects the running stack on 8765 and attaches instead of starting a second copy. |

---

## 7. Release checklist

Run in order. Steps 1-4 are the gate; a failure at any of them stops the tag.

1. `uv run pytest test` and `uv run pytest test/studio` green; `npm run test:embedded` green; `cd packages/comfyui-mobile && npx vitest run` green.
2. `python3 scripts/generate_notices.py --check` clean, and `THIRD_PARTY_NOTICES.md` carries no open distribution gate. (It carries none as of 2026-09-03; the donor-checkout retirement gates in [`OPERATIONS.md`](OPERATIONS.md) are the older list.)
3. `python -m hivemind_content_studio.identity --write` produces no diff — identity has not drifted from the generated JSON.
4. A cold start of the packaged app on a machine with no repository checkout, no `uv`, no Node and no ComfyUI reaches the studio, signs in with a passkey, and shows the local lanes as "not set up" rather than as errors.
5. Tag `studio-v0.x`, build, sign, notarize, staple.
6. Smoke-test the built DMG on a second machine: install, launch, sign in, one hosted generation, one restore, quit — and confirm no ComfyUI process was killed on quit.
7. Promote `latest.json`. This is the step that ships it; until it runs, the tag is only an artifact.

## 8. Still open

Named here rather than left implicit:

* `src-tauri/` does not exist yet. This document is its specification, not a description of it.
* The packaged app's configuration surface (the ~dozen env names and five hard-coded loopback ports the control API resolves by convention) still has no single settings object; see finding `cp-config-surface-for-packaging`.
* Windows and Linux need bundled runtimes and a signing chain before their lanes can be re-enabled.
