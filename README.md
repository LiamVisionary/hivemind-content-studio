# Hivemind Content Studio

A desktop studio for making pictures, video and finished social clips — on your
own Mac by default, on a rented or hosted GPU when you ask for one. It is one
app rather than a launcher: the same prompt box, the same encrypted library, and
the same "where does this run and what does it cost" answer in every studio.

**Using the app?** → **[The guide](docs/GUIDE.md)** · **[Troubleshooting](docs/TROUBLESHOOTING.md)**
**Running it from this checkout?** → **[Operations](docs/OPERATIONS.md)**
**Everything else** → **[docs/](docs/README.md)**

---

## What it looks like

A left sidebar in three tiers, and one workspace beside it.

**Create** — **Image**, **Video**, **Story**, **Restore**, with a folded **Labs**
group holding **Sprite** and **Lip sync**. Each is a canvas with a prompt bar
along the bottom and a settings panel down the side. The prompt bar is five
things: attach references, load a starter, improve the prompt, choose where it
runs, and **Generate**. The **Runs on** chip reads out the answer before you
press — *"This Mac · Z-Image Turbo — free, stays here"*, or a rented card's name
and its hourly price — and defaults to **Automatic**, which prefers free and
local and says why it chose what it chose.

**Produce** — **Planner** (say what you want in words; a brain plans it and you
confirm before anything is spent), **Library** (everything you have made, sealed
with your key), **Productions** (the durable runs, with their steps, artifacts
and one bounded next action), **Inspo** (Civitai's gallery, with a button that
loads a prompt straight into the studio it belongs in) and **Models** (install,
inspect and remove local weights — the only door to doing so).

**Advanced**, collapsed — **Rented GPUs**, **Providers**, **PassBook**,
**Canvas** (the node workflow editor), **Agents & API**, **Settings**, **About**.

First launch is two steps at the machine: name the studio and choose a
passphrase, then keep the vault recovery key it shows once. There is no
compiled-in password, and no server-side copy of yours.

## Install and run

**From this checkout** — the path that works today. Four install commands, the
embedded build, two checks and a stack start, listed in full under
[Developer quick start](docs/OPERATIONS.md#developer-quick-start). Then open the
studio at the loopback address the supervisor prints, and follow
[the guide](docs/GUIDE.md) from the setup card onward.

**The packaged app** is a signed macOS DMG carrying its own Python, Node and
ffmpeg, supervised by the Rust shell in `desktop/src-tauri`: it reserves a port,
starts the sidecars, shows a boot screen with an action per failure, and opens
the studio once it is ready. ComfyUI, the Swift MLX engines and rented boxes stay
attach-only — the app finds them and never starts or kills them.
[`docs/RELEASE.md`](docs/RELEASE.md) is the specification for what that download
contains and names exactly what is still unbuilt, so read it before assuming a
build exists.

## What is inside

The canonical Python package owns every run, asset, provenance, approval,
publishing and metrics decision. Everything else is an adapter over it.

| Package | What it is |
|---|---|
| `src/hivemind_content_studio` | The control plane: durable runs, the manifest, routing, approvals, publishing, telemetry, the browser API |
| `packages/open-generative-ai` | The React studio — Image, Video, Story, Restore, Sprite, Lip sync, the hub pages |
| `packages/media-gateway` | The local generation gateway, model manager, ComfyUI proxy and Media Studio MCP |
| `packages/comfyui-mobile` | The embedded node workflow editor behind Canvas |
| `engines/flux-2-swift-mlx`, `engines/z-image-swift` | Native Apple Silicon engines behind the gateway |
| `desktop/src-tauri` | The Rust shell that supervises the sidecars and shows a boot screen with an action per failure |
| `src/auto_clipper`, `app/` | The clipping engine and the faceless-render engine, embedded rather than orchestrated |

Runs are durable: SQLite is authoritative for run, step, event and budget state;
a versioned manifest is authoritative for the brief, provider selections,
artifacts, provenance, approvals and receipts. Agents ask for capabilities
(`generate_keyframes`, `animate_scenes`); the router picks a ready provider under
the run's privacy, allowlist and budget policy. Paid work uses an HMAC-signed,
exact-scope, one-time operator receipt, and rendering never implies publishing.

Prompts, media, workflows and generation parameters stay on the client. Provider
secrets live in [PassBook](https://github.com/LiamVisionary/passbook), the
machine's shared credential store, and never enter the browser or a catalog
response.

## Documentation

| | |
|---|---|
| [Guide](docs/GUIDE.md) | For the person using the app: first run, first image, first video, every studio |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Every failure the app can show, keyed to its own words |
| [Operations](docs/OPERATIONS.md) | Ports, processes, the stack script, health endpoints, the CLI, the publishing gate, agent access |
| [Architecture](docs/ARCHITECTURE.md) | How the run engine, router and manifest fit together |
| [Settings](docs/SETTINGS.md) | Every key, its default, and the variable that overrides it |
| [End-to-end encryption](docs/E2E_ENCRYPTION_DESIGN.md) | What is sealed with which key, and why nothing can reset a passphrase |
| [Restore Studio](docs/RESTORE_STUDIO.md) | The SeedVR2 restoration rail in depth |
| [Monetization](docs/MONETIZATION.md) | The revenue loop the runs feed |
| [Release](docs/RELEASE.md) · [Release checklist](docs/RELEASE_CHECKLIST.md) | What the download contains; what must be green before a build is dispatched |
| [Tests](test/README.md) | The five suites and their prerequisites |
| [Security](.github/SECURITY.md) | What listens where, and how to report a vulnerability privately |
| [History](docs/history/README.md) | Assimilation and migration records, kept for provenance |

## Licensing

Auto Clipper is AGPL-3.0-or-later, so the combined work is AGPL-3.0-or-later.
Read [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) before distributing.
The app's own **About** page carries the version, the licence, the no-warranty
line, the third-party notices and the offer of Corresponding Source.

No credential values belong in this repository; `.env.example` contains key names
only.
