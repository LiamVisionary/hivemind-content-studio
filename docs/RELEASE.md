# Release — what the download contains, and the decisions behind it

This document was written so `src-tauri/` could be built from a spec instead of
from guesswork. It now exists, at [`desktop/src-tauri`](../desktop/README.md):
a Rust core that reserves a port, supervises the sidecars by pid, shows a boot
screen with an action per failure, and loads `http://127.0.0.1:<port>` once
`/readyz` answers. The Electron shell it replaced — a webview pointed at
`HIVEMIND_STUDIO_URL || http://127.0.0.1:8765` that started nothing and showed
an empty window when the backend was absent — has been deleted, along with its
`electron-builder` packaging. What remains unbuilt is the *bundling*: the
runtimes the app ships with, and the signing chain. Everything below names it.

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
| Control API (`content-studio-api`, `control_api.py`) | bundled Python | 8765 (`CONTENT_STUDIO_CONTROL_PORT`) | `GET /readyz` |
| Media gateway (`packages/media-gateway/app.py`) | bundled Python | 8787 | `GET /health` |
| Node services (`packages/media-gateway/node-services.mjs`) | bundled Node | 8793 (`HIVEMIND_NODE_SERVICES_PORT`) | `GET /healthz` — speaks for all three surfaces below |

One Node process serves the three Node surfaces, mounted on path prefixes of
its own port, and keeps their old ports answering unprefixed so anything that
addresses them by number still works. Retiring one of those numbers is a
separate decision.

| Surface | Mounted at | Compatibility port | Its own health |
|---|---|---|---|
| Gateway frontend / Canvas (`packages/media-gateway/server.js`) | `/canvas` | 8788 (`PORT`) | `GET /healthz` |
| Local-inference bridge (`packages/open-generative-ai/hosted-server.js`) | `/bridge` | 8794 (`OGA_PORT`) | `GET /health` |
| Media Studio MCP (`packages/media-gateway/bin/media-studio-mcp.mjs --http`) | `/agent` | 8796 (`MEDIA_STUDIO_MCP_PORT`) | `POST /mcp` |

Each of those three files still listens on its own port when it is run as the
program, so `node server.js`, `node hosted-server.js` and
`media-studio-mcp.mjs --http` remain the way to bring one surface up alone.

**Attach-only — never spawned, never killed by the shell**

* **ComfyUI lanes** (8188 default, 8198 Anima, 8199 LTX). The user's own
  checkout, its own venv, its own ~25 pinned custom nodes. The shell probes
  `COMFY_LANES`, shows what answered on the Models page, and offers the Connect
  ComfyUI card described in §5 when nothing does. It must never `kill_port 8188`: a
  desktop app that kills a user's ComfyUI because it quit is a bug report, and
  the developer stack's `kill_port` behaviour is exactly what not to copy.
* **Swift MLX engines** (`engines/flux-2-swift-mlx` 8791, `engines/z-image-swift`).
  macOS 15+ Apple Silicon extras, downloaded from the release page on request,
  launched by the user or by an explicit action in the app. Same rule: attach,
  report, never reap.
* **Rented and hosted lanes.** Already remote; nothing to supervise.
* **The tailnet URL.** Nothing to supervise: `tailscale serve` holds it, not a
  process of ours. See §2.4.

Not shipped at all: the Streamlit WebUI, the MoneyPrinterTurbo HTTP API and the
Redis task backend. The stack has never started them. Their dependencies live
behind the `faceless-webui` extra (§5), and the donor shell itself — `webui/`,
its launchers, `main.py`, the donor's docs, screenshots, agent skill and landing
page, and the seven `test_webui_*.py` files — is archived under
`archive/moneyprinterturbo/` with a README saying how to run it against `app/`.
The engine in `app/` and its own tests stay where they are.

---

## 2. The load-bearing Tauri decisions

These are not preferences. Each of them breaks a shipped feature if it is
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
exactly as the browser already does. The cost is that the app cannot start until
the control API is healthy; the shell shows `splash/index.html` — one row per
service, an action on every failure — until `/readyz` answers, and never a blank
window. `/readyz` rather than `/api/runtime`: the latter probes three engines, so
a ComfyUI that is not installed would hold the window shut.

### 2.2 When the port falls back, the shell sets the origin env vars

8765 can be taken — by a developer stack, or by anything else. When what holds
it answers `/healthz` and names this product, the shell attaches to it and the
port does not change. Otherwise it takes the first free port in `8765-8785` and,
**in the same step**, passes the chosen origin down:

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
Python loading native wheels — torch, cryptography, faster-whisper). They live in
[`desktop/src-tauri/Entitlements.plist`](../desktop/src-tauri/Entitlements.plist),
which `bundle.macOS.entitlements` points at, and that file carries the same
no-sandbox note so nobody adds `com.apple.security.app-sandbox` back to it later.
The plist is applied to what Tauri signs — the main binary and any sidecar; the
nested Mach-O inside the staged Python tree carries the wheels' own signatures
and is a separate signing question the first notarized build will answer.

### 2.4 Every port binds loopback, and remote access is a switch

The whole process tree in §1 binds `127.0.0.1`. Nothing is published on the
user's tailnet at launch.

That is a change, not a restatement. The developer stack used to bind a
hand-rolled Node HTTPS proxy to the Tailscale address at every boot, and when
`tailscale cert` was unavailable it generated a **self-signed** certificate with
openssl so the proxy had something to present. What that proxy fronted was the
Canvas port, which authenticated nothing of its own while attaching the
gateway's capability token to everything it forwarded — so every device on the
tailnet could queue arbitrary ComfyUI graphs (custom nodes run arbitrary code)
and read the generated library. And a self-signed certificate is a full-screen
browser warning with no in-app fix, which is the one thing this product does not
ship.

Two pieces replace it:

* **The Canvas port authenticates.** `packages/media-gateway/lib/canvas-gate.js`
  gates the whole 8788 dispatch and its WebSocket upgrade on either the gateway
  capability token (agents, the MCP, `media_studio.py`) or the studio account
  cookie, checked against the control API's `/api/owner/session` and cached for
  a few seconds. An unauthenticated navigation is redirected to the studio's
  sign-in gate on the same host; an XHR gets 401 JSON carrying `sign_in_url`.
  Only `GET /healthz` is exempt, so a supervisor can still see the child is
  alive. This works **because of §2.1**: the webview is on `http://127.0.0.1`,
  cookies are scoped by host and not by port, and 8765 and 8788 are the same
  site — so the Canvas iframe's own requests carry the session.
* **Remote access is opt-in.** `src/hivemind_content_studio/remote_access.py`
  and the switch on the Rented GPUs page run `tailscale serve` — a real
  certificate, no proxy process of ours, no key on disk — and publish **only**
  the control API's port. The card shows the resulting URL and names who on the
  tailnet can reach it. Off by default; turning it off unpublishes.

`packages/media-gateway/tailscale-https-proxy.js` is kept but no longer started.
Its port (8789) is still named by `trustedOwnerParent.ts`, `StudioRedirect.jsx`,
`hubData.gatewayUrl`, `McpCliStudio.jsx` and the control API's
`CONTENT_STUDIO_PROXY_SECRET` forwarded-header path; those are the last users to
retire before the file goes.
### 2.5 Saving a file needs the dialog and fs plugins

Every "keep this" control in the studio — a generated clip, a restored master, a
sprite sheet and its atlas, a persona export, the one-time vault recovery key —
ends up in `saveBytes()` in `packages/open-generative-ai/src/lib/downloadMedia.js`.
In a browser that is an `<a download>` click on a `blob:` URL. **A WKWebView does
not carry that out on its own**, so without the branch below every Download
button in the packaged app would click and do nothing, and the recovery-key
screen would tell somebody their only key was saved to a file that does not
exist.

`saveBytes` therefore branches on `window.__TAURI__`, which means the shell must:

* set `app.withGlobalTauri = true` in `tauri.conf.json` (the branch reads the
  plugin APIs off the global rather than importing `@tauri-apps/api`, because the
  frontend is built once and also served to browsers and the tailnet, where those
  imports do not resolve);
* add `tauri-plugin-dialog` and `tauri-plugin-fs`;
* grant exactly `dialog:allow-save` and `fs:allow-write-file` in the window's
  capability file, with **no** `fs:scope` beyond what the save dialog returns.
  The user picks the path in a native sheet; the app never enumerates, reads or
  writes a directory of its own, so a read permission or a broad scope would be
  strictly more authority than the feature needs.

The branch degrades in this order and never silently no-ops: native dialog →
anchor download → clipboard (for text, which is what makes the recovery key
survive a webview with no save path at all) → a tab the user can print. A
cancelled save sheet is reported as `cancelled` and nothing else fires.

All four are now in place, plus one the section had not accounted for: the
capability declares `remote: { urls: ["http://127.0.0.1:*"] }`. The window loads
the control API's loopback origin (§2.1), which the capability system treats as a
*remote* origin — so without that block the IPC is denied on the studio page and
the save pair is unreachable even with both plugins registered.
`the_capability_pattern_matches_every_origin_the_shell_can_load` in `ports.rs`
parses that literal with Tauri's own `RemoteUrlPattern` and tests it against
every port `reserve_port` can return.

`tests/saveBytes.test.js` pins both sides of the branch and
`test/studio/test_desktop_bundle.py` pins the shell side. Neither can pin the real
webview; step 6 of the release checklist is where a Download button is pressed in
the built app.

### 2.6 The bundle carries the app, and `bundle.resources` is where that is said

Tauri bundles only what `bundle.resources` names. It named nothing, so
`cargo tauri build` produced an .app holding the Rust shell, `splash/index.html`
and none of §1's table — and `Layout::resolve` then looked for its interpreter at
`<cwd>/.venv/bin/python`, which for a Finder launch is `/.venv/bin/python`. Every
sidecar failed to spawn and the boot screen was all anyone ever saw.

Five entries now, filled by
[`scripts/stage_desktop_resources.py`](../scripts/stage_desktop_resources.py):

| Resource | What it is | Produced by |
|---|---|---|
| `desktop-python/` | The frozen venv and the static ffmpeg/ffprobe pair | `scripts/build_desktop_python.py --build` |
| `node/` | The Node binary the three Node surfaces run on | staged from the build runner's Node |
| `studio/` | The application: `src/`, the two Node services, and the three built frontends | `npm run build:embedded`, then staged |
| `legal/` | LICENSE, THIRD_PARTY_NOTICES.md, CHANGELOG.md, notices.json | staged |
| `runtime.json` | Where the shell finds all of the above | written by the staging script |

`runtime.json`'s paths are **relative to the app's resource directory**, because
a bundle does not know where it will be installed; `ShellConfig::anchor_to`
resolves them against that directory, and the environment still wins over the
file so `cargo tauri dev` against a checkout is unchanged. `pathPrepend` puts the
staged ffmpeg in front of every child's `PATH`, which is what makes `shutil.which`
in `doctor.py` find the bundled pair rather than the user's.

Three gates, because this failed silently once:

* `tauri-build` refuses to compile when a path named in `bundle.resources` does
  not exist. That is why a placeholder for each part is committed — a checkout
  that has built nothing still has to compile.
* `python3 scripts/stage_desktop_resources.py --verify` fails while any part is
  still a placeholder or missing a build output. The release workflow runs it
  between staging and the bundle step.
* `test/studio/test_desktop_bundle.py` holds `ShellConfig` and `runtime.json` to
  each other: a new field on the shell's config fails the suite until it is
  either pointed at something inside the bundle or written down as deliberately
  left alone.

---

## 3. Platforms

**v1 is macOS 14+ on Apple Silicon only.** That is what the engines assume: MLX
is Apple Silicon, the ComfyUI lanes are tuned for MPS, and every performance
number in this repository was measured on an M-series machine. An Intel Mac gets
a clear refusal at install time, not a slow app.

Windows and Linux are **not built**. Their electron-builder targets (NSIS,
deb/AppImage) went with the Electron shell; Tauri can produce both, and the
control API, the gateway and the supervisor are already platform-neutral — the
supervisor's one Unix-specific piece is the process-group signal, which has a
Windows branch. The missing pieces are the bundled runtimes and a signing chain
per platform, not the app.

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
source URL. It is generated into `packages/open-generative-ai/identity.json`
(`python -m hivemind_content_studio.identity --write`), which `hosted-server.js`
reads, and it is repeated in `desktop/src-tauri/tauri.conf.json` because Tauri
reads its identifier from there. `test/studio/test_identity.py` fails if those
two disagree, and if the bundle id is typed anywhere else.

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
models the user picks on the Models page — and nothing else. A first launch with
no ComfyUI is a working app with the hosted and rented lanes available and the
local lanes showing a setup card; it is not an error state.

**There is no ComfyUI installer in v1.** The Connect ComfyUI card
(`/api/comfy/connect`, `src/hivemind_content_studio/comfy_connect.py`, reachable
from the Rented GPUs page and from every studio's empty local section) detects
what is on the machine — `$COMFY_DIR`, `~/comfy/ComfyUI`, `~/ComfyUI`, the
ComfyUI Desktop install — attaches an address the user is already serving, or
links to ComfyUI's own instructions. Two rules hold it to that:

* It never modifies a ComfyUI the app did not create. Detection is `stat()` and
  one `GET /system_stats`; the attachment is written into this app's own state
  root (`comfy-attachments.json`, read live by the gateway so attaching lights
  the lane without a restart). Custom nodes a workflow needs are *named* to the
  user, never symlinked into their install. The developer stack keeps its own
  `custom_nodes` symlinks, and only into the checkout it starts itself.
* The pinned node list in `packages/gpu-rentals/provisioning/comfyui-hivemind.sh`
  is **not** a manifest for this. It provisions a CUDA box at `/opt/ComfyUI`
  with a torch build and an accelerator set chosen for a rented NVIDIA card;
  running it against a Mac checkout would be wrong in every one of those
  choices.

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

The full list, with the exact command and expected count for each of the five
suites, the lint gate, the manual owner-gate and vault smoke, and the packaging
and promotion steps, is [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md). It is one
list, so it does not drift from a second copy here. The shape of it:

1. `uv run pytest test` and `uv run pytest test/studio` green; `npm run test:embedded` green; `cd packages/comfyui-mobile && npx vitest run` green.
2. `python3 scripts/generate_notices.py --check` clean, and `THIRD_PARTY_NOTICES.md` carries no open distribution gate. (It carries none as of 2026-09-03; the donor-checkout retirement gates in [`OPERATIONS.md`](OPERATIONS.md) are the older list.)
3. `python -m hivemind_content_studio.identity --write` produces no diff — identity has not drifted from the generated JSON, and `python3 scripts/generate_gate_css.py --check` is clean — the sign-in gate's stylesheet still matches the design tokens.
4. A cold start of the packaged app on a machine with no repository checkout, no `uv`, no Node and no ComfyUI reaches the studio, signs in with a passkey, and shows the local lanes as "not set up" rather than as errors.
5. Tag `studio-v0.x`, build, sign, notarize, staple.
6. Smoke-test the built DMG on a second machine: install, launch, sign in, one hosted generation, one restore, **press Download on the result and confirm a native save sheet appears and writes the file** (§2.5 — blocking, not advisory: the anchor fallback reports success while writing nothing), quit — and confirm no ComfyUI process was killed on quit.
7. Promote `latest.json`. This is the step that ships it; until it runs, the tag is only an artifact.

## 8. Still open

Named here rather than left implicit:

* **Nothing here has been launched as a `.app`.** `cargo check` and `cargo test` pass and the supervisor's logic is unit-tested, but the shell has never been built into a bundle and double-clicked. Step 4 of the checklist is the first time that happens.
* **The bundled interpreter is not yet relocatable.** `bundle.resources` now names every part of §1's table and `scripts/stage_desktop_resources.py` assembles them (§2.6), but the release workflow calls `scripts/build_desktop_python.py` with no `--python`, so `uv venv` picks the runner's own interpreter and `venv/bin/python` symlinks a path that does not exist on a user's machine. A python-build-standalone 3.12 arm64 interpreter has to be downloaded on the runner and passed to `--python`, and the interpreter itself copied into the staged tree. `--verify` catches the dangling symlink (a broken link does not `exist()`), so this fails the build rather than shipping.
* A release also needs a static arm64 ffmpeg/ffprobe pair on the runner — repository variable `DESKTOP_FFMPEG_ARCHIVE_URL`, or `vendor/ffmpeg/darwin-arm64` locally. Neither is a secret; both are public download URLs.
* **No updater key pair has been generated** (`cargo tauri signer generate` — the owner's step, and the private half never enters this repository), so `src-tauri/updater.json` carries an empty `pubkey` and the build lane produces UNSIGNED artifacts. The plugin itself is now in the build: `tauri-plugin-updater` is a dependency, registered in `lib.rs`, and granted `updater:default` in the capability, and `check_updater_config.py` asserts all three — it used to compare two JSON files and call a configuration with no plugin behind it healthy. `scripts/check_updater_config.py --require-key` is the gate that keeps such a build from being promoted, and it holds `tauri.conf.json` to that same one source for the updater endpoint and public key.
* The frontend still hard-codes `:8788` for the Canvas iframe and `:8796` for the MCP page. The shell prefers those ports and attaches to whatever already answers on them, so a collision degrades one panel rather than boot — but the discovery half of finding `startup-08` is unwritten.
* The packaged app's configuration surface (the ~dozen env names and five hard-coded loopback ports the control API resolves by convention) still has no single settings object; see finding `cp-config-surface-for-packaging`.* Windows and Linux need bundled runtimes and a signing chain before their lanes can be re-enabled.
