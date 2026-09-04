# desktop — the shipped shell

`src-tauri/` is the Tauri v2 app. This directory exists so a release action's
`projectPath` can point at the folder *containing* `src-tauri`, which is what
`tauri-action` expects.

[`docs/RELEASE.md`](../docs/RELEASE.md) is the specification; this is what it
turned into. Read §2 there before changing any of the three decisions below.

## What it does

1. **Reserves a port.** 8765 preferred. If something already answers `/healthz`
   there and names this product, the shell *attaches* to it — that is how the
   packaged app coexists with a hand-started `scripts/hivemind-studio-stack`
   instead of starting a second copy. If a stranger holds the port, the shell
   steps around it to the next free port in 8766–8785, and never signals it.
2. **Starts three sidecars** with an explicit environment each: the control API
   and the media gateway (Python), and one Node process (`node-services.mjs`)
   that serves all three Node surfaces — the Canvas frontend, the
   local-inference bridge and the agent MCP — under `/canvas`, `/bridge` and
   `/agent`, while still answering on their old ports 8788, 8794 and 8796.
   `service_plans` in `src/services.rs` is that list, and
   `the_three_node_surfaces_are_one_child_that_keeps_the_old_ports` is what
   holds it to three. The names in those env blocks are the ones
   `scripts/hivemind-studio-stack` already passes, so the packaged app and the
   developer stack describe the same process tree.
3. **Shows a boot screen** (`splash/index.html`) listing every service with its
   state, and an action for every failure state: Retry, Show logs, and Continue
   without it where that is honest. It polls `/healthz` then `/readyz` for up to
   90 seconds before giving up, so a slow first launch is never a blank window.
4. **Loads `http://127.0.0.1:<port>`** — never `tauri://localhost`. The account
   cookie, the Canvas iframe and the WebAuthn relying-party id are all bound to
   the control API's loopback origin.

## What it never does

* **Spawn or kill ComfyUI.** The lanes on 8188/8198/8199 are the user's own
  checkout. The shell describes them to the control API through `COMFY_LANES`
  and never signals them. The developer stack's `kill_port` is exactly what not
  to copy here.
* **Signal a process it did not start.** Every kill goes through a `Child`
  handle this process owns; there is no `lsof` and no port scan. Quitting sends
  SIGTERM to each child's *process group*, so nothing they started is orphaned.
* **Tear down the tree when one child dies.** A crash restarts that child alone,
  with an exponential backoff and a crash counter; after five it is parked as
  failed with its actions rather than looping in silence.

## Configuration

Sidecar commands come from `runtime.json` in the app's resource directory, and
any of these environment variables override it:

| Variable | Default |
|---|---|
| `HIVEMIND_STUDIO_ROOT` | `.` — set it to the checkout for development |
| `HIVEMIND_STUDIO_PYTHON` | `<root>/.venv/bin/python` |
| `HIVEMIND_STUDIO_NODE` | `node` |
| `CONTENT_STUDIO_FRONTEND_DIST` | `<root>/packages/open-generative-ai/dist` |
| `HIVEMIND_MEDIA_STATE_DIR` | `~/.hivemindos/media-studio`, adopted in place |
| `COMFY_LANES` | the two documented local lanes |

`runtime.json` is written by `scripts/stage_desktop_resources.py`, which also
stages the runtimes it names into `src-tauri/resources/`. Its paths are relative
to the app's resource directory — a bundle does not know where it will be
installed — and `ShellConfig::anchor_to` resolves them against that directory.
The environment still wins over the file, which is what keeps `cargo tauri dev`
against a checkout working with nothing staged.

`bundle.resources` in `tauri.conf.json` names those parts, and `tauri-build`
refuses to compile when one of the named paths is missing. That is why a
`PLACEHOLDER.md` for each part is committed: a checkout that has never built a
frontend still has to compile. `python3 scripts/stage_desktop_resources.py
--verify` fails while any of them is still a placeholder, and the release
workflow runs it between staging and the bundle step.

## Running and testing it

```sh
npm run desktop          # cargo tauri dev, with HIVEMIND_STUDIO_ROOT set
npm run desktop:check    # cargo check && cargo test
```

The private-state key is generated once and kept in the OS keychain, then handed
to the control API through `CONTENT_STUDIO_PRIVATE_SECRET` — so no key file sits
in the same folder as the data it protects.
