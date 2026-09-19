# Tests

Five suites cover this repository, in two languages, and no single command runs
them all. This file says what each one is, what it needs before it can pass, and
which of its failures are the environment rather than the code.

[`docs/RELEASE_CHECKLIST.md`](../docs/RELEASE_CHECKLIST.md) is the same list as a
gate, with the counts a release is expected to see.

- `services/`: Domain-focused unit and controller tests
  - `test_task.py`: Task pipeline tests
  - `test_task_manager.py`: In-memory and Redis queue tests
  - `test_controller_*.py`: API controller tests split by controller domain
  - `test_video.py`, `test_voice.py`: Media service tests
- The donor Streamlit shell's tests (`test_webui_*.py`) and the donor HTTP
  entry-point test moved with the shell to `archive/moneyprinterturbo/test/`;
  `pytest` does not collect them (`testpaths = ["test"]`).

## The five suites

| Suite | Where | Command |
|---|---|---|
| Studio control plane | `test/studio` | `PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q test/studio` |
| Faceless engine | `test/services`, `test/auto_clipper`, `test/test_main.py` | `PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q test --ignore=test/studio` |
| Media gateway | `packages/media-gateway` | `cd packages/media-gateway && ../../.venv/bin/python -m pytest -q .` |
| Studio frontend | `packages/open-generative-ai/tests` | `cd packages/open-generative-ai && node --test tests/*.test.js` |
| Canvas | `packages/comfyui-mobile` | `cd packages/comfyui-mobile && npx vitest run` |

`uv run pytest …` works too; the explicit `.venv/bin/python` is what a git
worktree needs, since it has no venv of its own.

Run the JS suite as `node --test tests/*.test.js`, never `node --test tests/`:
the bare directory form pulls in fixtures and helpers as if they were tests.

### 1. Studio control plane — `test/studio`

The product: the control API, the account gate, the studios' server side, the
private-state cipher, the E2E vault, the lanes and the rented-machine plumbing.
The biggest suite, and the one most worth running while you work.

`test/studio/conftest.py` is a safety boundary, not just setup. Autouse fixtures
give the private cipher a test secret so nothing shells out to the macOS
Keychain, isolate the shared hive env so a developer's real credentials cannot
leak into a test, redirect the machines access ledger away from real state, and
refuse marketplace and rental calls — an earlier version of this suite really did
rent GPUs. Do not disable them to "make a test pass"; a test that needs the real
thing does not belong here.

**Prerequisite:** the studio frontend must be built, or four tests fail.
`test_control_api.py`, `test_control_api_polish.py` and `test_private_access.py`
assert that the page served at `/` *is* the studio, and with
`packages/open-generative-ai/dist/` absent the control API correctly answers 503
with its "frontend build is missing" placeholder. Build it once:

```bash
npm --prefix packages/open-generative-ai run vite:build   # or: npm run build:embedded
```

### 2. Faceless engine — `test/services`, `test/auto_clipper`

The inherited MoneyPrinterTurbo engine and the clipping pipeline: task queue,
state, voice, video assembly, the engine's own controllers.

**Environment-dependent, and skipped rather than failed:**

* `MPT_RUN_INTEGRATION_TESTS=1` — turns on tests that call real TTS/LLM
  providers. Off by default; they need credentials and they cost money.
* `MPT_TEST_REDIS_HOST` (with `MPT_TEST_REDIS_PORT`, `MPT_TEST_REDIS_DB`) — the
  Redis-backed task-manager and state tests. CI runs a `redis:7-alpine` service
  and sets these; locally they skip. Redis is *not* in the desktop bundle — it
  lives in the `faceless-webui` extra (see `docs/RELEASE.md` §5) — so these test
  a path the shipped app never takes.

### 3. Media gateway — `packages/media-gateway`

Sealed media, the model manager, the ComfyUI graph builders, the MCP contract.

**Prerequisites:** `ffmpeg` and `ffprobe` on `PATH` (the graph builders probe
reference clips with ffprobe; without them the failures read as
`FileNotFoundError` rather than as a missing tool), and
`npm ci --prefix packages/media-gateway`, because the MCP contract tests shell
out to `bin/media-studio-mcp.mjs` and it imports
`@modelcontextprotocol/sdk`.

### 4. Studio frontend — `packages/open-generative-ai`

Node's built-in runner over the studios' logic: prompt assembly, the capability
registry, the video timeline, the composer, the client half of the vault. Pure
logic — nothing mounts a component, which is why the lint gate matters:

```bash
cd packages/open-generative-ai && npm run lint       # 0 errors, 0 warnings
```

### 5. Canvas — `packages/comfyui-mobile`

Vitest over the Canvas editor and the mobile vault. `conftest.py` there stubs the
ComfyUI runtime modules (`server`, `folder_paths`, `aiohttp`, `PIL`) so the
Python-side tests import without a ComfyUI checkout.

**Environment-dependent:** the E2E media suite seals with the repository venv's
Python. Where that is not available it skips itself and says so.

Type-check before packaging — `npm run build:mobile` runs `tsc -b` first, so a
type error is a build that cannot happen:

```bash
cd packages/comfyui-mobile && npx tsc --noEmit -p tsconfig.app.json
```

## What CI runs

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs all five on every
push and pull request, plus:

* `ruff check .` — the whole tree, as its own job. A lint job that is a step
  inside a test job stops the tests from reporting at all.
* `npm run lint` in `packages/open-generative-ai` (`--max-warnings 0`).
* the studio vite build, because four control-plane tests assert the page served
  at `/` *is* the studio.
* `pytest -q packages/comfyui-mobile/tests` — the Canvas package's Python half,
  which neither `testpaths = ["test"]` nor `npx vitest run` collects.
* `cargo test` for the desktop shell, on `ubuntu-22.04` with the Tauri system
  packages, plus `scripts/check_updater_config.py`.
* `npx tsc --noEmit -p tsconfig.app.json` in `packages/comfyui-mobile`.
* a Windows smoke job over five service tests.

What CI deliberately does **not** run, and why:

| Gate | Where a human runs it | Why not in CI |
|---|---|---|
| `npx eslint .` in `packages/comfyui-mobile` | not in the checklist | 28 pre-existing errors; it would be red on the day it was added, which is a gate nobody can read |
| `npm run build:embedded` (Canvas dist, gateway Next build) | `RELEASE_CHECKLIST.md` §3 | the release workflow builds both, and the type gate above catches the class of break that matters on a push |
| `scripts/generate_notices.py --check` | `RELEASE_CHECKLIST.md` §4 | it compares against the *installed* dependency set, so it answers "out of date" on any runner whose resolution differs from the developer's |
| `hivemind_content_studio.identity --write && git diff --exit-code` | `RELEASE_CHECKLIST.md` §4 | the version comes from `git describe`, and `actions/checkout` fetches no tags by default |

The desktop release workflows are dispatch-only and run none of this; the gate
before dispatching one is `docs/RELEASE_CHECKLIST.md`.

## Adding tests

1. Name files `test_<domain>.py` (or `<domain>.test.js`) and keep one domain per
   file.
2. Put anything about the studio, the control API or the vault in `test/studio`;
   `test/services` is the inherited engine and stays that way.
3. pytest collects both plain functions and `unittest.TestCase`.
4. Fixtures and resources go in `test/resources`; never reach for a path in
   `~/.hivemindos` or `~/.comfy-private.noindex` from a test.
5. A test that needs network, a credential, a GPU or a rented machine is not a
   unit test. Gate it behind an environment variable and make it skip with a
   reason that names the variable.
