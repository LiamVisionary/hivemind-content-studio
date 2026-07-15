# Unified Media Studio Implementation Plan

> **Superseded on 2026-07-15:** The composite workspace/iframe approach was
> rejected in favor of the native all-in-one plan in
> `docs/plans/2026-07-15-native-unified-media-studio-implementation-plan.md`.

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make Hivemind Content Studio the single product shell for the listed creative frontends and local generation engines without copying their code or creating a second durable run system.

**Architecture:** Keep `hivemind-content-studio` as the canonical FastAPI/browser/MCP application and durable run owner. Treat `hive-image-stack` as the local media gateway, ComfyUI Mobile and Open Generative AI as mounted specialist workspaces, and the Swift repositories as engine sidecars behind the gateway. Assimilate the reusable service-catalog ideas from `unified-image-studio-template`, but keep every external fork in its own repository so it can continue tracking upstream.

**Tech Stack:** Python 3.11, FastAPI, dependency-free browser JavaScript/CSS, pytest, HTTP health probes, existing Hivemind Content Studio provider and Media Studio MCP adapters.

---

## Repository selection and baseline

- Target: `/Users/liam/Documents/code/projects/hivemind-content-studio`
- Remote: `git@github.com:LiamVisionary/hivemind-content-studio.git`
- Branch at planning time: `main`
- Baseline commit: `65cf89a`
- Baseline worktree: clean
- Baseline gate: `uv run pytest test/studio/test_control_api.py test/studio/test_studio_ui_contract.py -q` -> `35 passed`
- Nearby target duplicates: none under `/Users/liam/Documents/code/projects`; inspection copies of the other repositories are temporary shallow clones only.
- Do not use `unified-image-studio-template` as a second product shell. Its config-driven lifecycle and repository metadata patterns are inputs to the Content Studio runtime registry.

## Confirmed component boundaries

| Repository | Combined-app role | Integration decision |
|---|---|---|
| `hivemind-content-studio` | Product shell, durable runs, provenance, approvals, publishing | Canonical application |
| `unified-image-studio-template` | Portable service/repository manifest and launcher patterns | Assimilate patterns; do not run as a second dashboard |
| `Open-Generative-AI` | Broad image/video/model exploration UI | Mount as a specialist workspace; add provider adapters only for unique backends |
| `comfyui-mobile-frontend` | Advanced ComfyUI workflow editor, queue, and output browser | Mount through `hive-image-stack` at its same-origin mobile route |
| `hive-image-stack` | Local gateway, model manager, ComfyUI proxy, generation/history API, Media Studio MCP | Primary local media service behind Content Studio |
| `flux-2-swift-mlx` | Warm Apple Silicon Flux 2 edit engine | Keep as a managed sidecar behind `hive-image-stack` |
| `Z-Image.swift` | Apple Silicon Z-Image library/CLI/staging daemon | Keep as a managed engine behind `hive-image-stack` |

## Phase 1: Combined shell and runtime registry

### Task 1: Specify the safe runtime catalog

**Objective:** Define the public repository, workspace, and engine metadata returned by the Content Studio API.

**Files:**

- Create: `src/hivemind_content_studio/unified_runtime.py`
- Test: `test/studio/test_unified_runtime.py`

**Step 1: Write failing tests**

Test that the catalog contains all seven Liam repositories, preserves four upstream links, classifies each component by layer, accepts only HTTP(S) workspace URLs, and never returns token values or host filesystem paths.

**Step 2: Verify RED**

Run: `uv run pytest test/studio/test_unified_runtime.py -q`

Expected: collection failure because `hivemind_content_studio.unified_runtime` does not exist.

**Step 3: Implement the minimal catalog and bounded probes**

Use immutable dataclasses for source repositories, workspaces, and engines. Read only explicit URL overrides, normalize them as HTTP(S), probe health endpoints concurrently with short timeouts, and return status/error classes without raw exception strings.

**Step 4: Verify GREEN**

Run: `uv run pytest test/studio/test_unified_runtime.py -q`

Expected: all runtime-catalog tests pass.

### Task 2: Expose the registry from the canonical control API

**Objective:** Add a read-only same-origin runtime endpoint without introducing another state store.

**Files:**

- Modify: `src/hivemind_content_studio/control_api.py`
- Modify: `test/studio/test_control_api.py`

**Step 1: Write failing API test**

Patch the runtime snapshot builder and assert `GET /api/runtime` returns its safe payload without requiring the operator token.

**Step 2: Verify RED**

Run: `uv run pytest test/studio/test_control_api.py -q -k unified_runtime`

Expected: HTTP 404.

**Step 3: Add the endpoint**

Import the snapshot function and return it from `GET /api/runtime`. Keep start/stop/restart out of this phase; those mutations need registered commands and the existing control-token gate.

**Step 4: Verify GREEN**

Run: `uv run pytest test/studio/test_control_api.py -q -k unified_runtime`

Expected: pass.

### Task 3: Add the unified Studio browser view

**Objective:** Let one browser app inspect the full runtime and open specialist workspaces without exposing secrets.

**Files:**

- Modify: `src/hivemind_content_studio/ui/index.html`
- Modify: `src/hivemind_content_studio/ui/studio.js`
- Modify: `src/hivemind_content_studio/ui/studio.css`
- Modify: `test/studio/test_studio_ui_contract.py`

**Step 1: Write failing UI contract tests**

Assert that navigation has a `studio` view, the page contains workspace/runtime/source containers and a sandboxed workspace frame, JavaScript loads `/api/runtime`, and the UI offers no raw command input.

**Step 2: Verify RED**

Run: `uv run pytest test/studio/test_studio_ui_contract.py -q -k unified_studio`

Expected: contract failure because the view does not exist.

**Step 3: Build the view**

Render workspace cards, engine health, and repository/upstream ownership from the API payload. Load selected specialist UIs into an iframe only after an explicit click; include a new-tab fallback. Keep Content Studio creation native by routing its workspace action back to `#create`.

**Step 4: Verify GREEN**

Run: `uv run pytest test/studio/test_studio_ui_contract.py -q -k unified_studio`

Expected: pass.

### Task 4: Document configuration and ownership

**Objective:** Make the composite-app boundary durable and understandable.

**Files:**

- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/MIGRATION_MAP.md`
- Modify: `docs/OPERATIONS.md`

Document the workspace URL overrides, the source/upstream map, and that engine lifecycle remains owned by `hive-image-stack`/its supervisor while Content Studio owns runs and approvals.

### Task 5: Run the phase-1 gates

**Objective:** Prove the new path and protect existing behavior.

Run:

```bash
uv run pytest test/studio/test_unified_runtime.py test/studio/test_control_api.py test/studio/test_studio_ui_contract.py -q
uv run pytest -q
```

Then start `content-studio-api`, open `http://127.0.0.1:8765/#studio`, verify the runtime cards render, and verify an online workspace can be selected in the embedded frame. If external services are offline, verify the UI reports that state without failing the Content Studio shell.

## Phase 2: Provider convergence

1. Make `hive-image-stack` publish a versioned, secret-free capability/schema document over its Media Studio MCP.
2. Replace the static local `workflow-default` entries in Content Studio with that live schema while retaining safe cached labels only when the service is unreachable.
3. Register Z-Image, Flux 2 MLX, Ideogram 4 MLX, and ComfyUI workflows as implementations beneath the existing provider-neutral image/keyframe intent; do not make their UI repository names durable run providers unless they are the actual executor.
4. Preserve model, workflow, job, source URL, hash, and dependency evidence on every canonical artifact.
5. Add real image-generation integration tests against a disposable fake Media Studio MCP before using the live local stack.

## Phase 3: Controlled lifecycle and packaging

1. Define operator-registered lifecycle IDs for the media gateway, Open Generative AI workspace, ComfyUI, and native sidecars.
2. Add authenticated start/stop/restart routes that accept only those IDs, never argv or arbitrary working directories.
3. Port cross-platform launcher generation and repository bootstrap concepts from `unified-image-studio-template` into a separate operator CLI namespace.
4. Keep repository installation opt-in, pinned by ref, and outside the Python package tree.
5. Build signed desktop packaging only after the runtime registry and lifecycle gates are proven on macOS, Windows, and Linux.

## Acceptance criteria

- One Hivemind Content Studio URL shows creation, durable runs, providers, telemetry, workspaces, engines, and source ownership.
- All seven Liam repositories are represented without vendoring or losing upstream provenance.
- ComfyUI Mobile and Open Generative AI can be opened from the combined shell.
- `hive-image-stack` remains the local media gateway; Swift engines remain sidecars.
- No second run database, approval system, publisher, credential store, or arbitrary command API is introduced.
- Existing Content Studio tests remain green.
