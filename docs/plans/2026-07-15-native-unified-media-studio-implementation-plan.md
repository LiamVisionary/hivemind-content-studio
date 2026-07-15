# Native Unified Media Studio Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Turn Hivemind Content Studio into one seamless first-party application that assimilates the useful capabilities of every listed repository without exposing separate apps, workspace cards, or iframes.

**Architecture:** `hivemind-content-studio` owns the only browser experience, navigation, composer, run state, asset library, provider routing, approvals, publishing, and telemetry. Open Generative AI, ComfyUI Mobile, and Unified Image Studio become donor implementations and interaction patterns rather than mountable products; `hive-image-stack`, ComfyUI, Flux 2 Swift MLX, and Z-Image Swift remain invisible execution adapters behind provider-neutral contracts.

**Tech Stack:** Python 3.11, FastAPI, Pydantic, dependency-free browser JavaScript/CSS, SQLite, pytest, existing Content Studio provider and artifact contracts.

---

## Repository selection and upstream baseline

- Target: `/Users/liam/Documents/code/projects/hivemind-content-studio`
- Target branch/remote: `main` / `git@github.com:LiamVisionary/hivemind-content-studio.git`
- Target baseline commit: `65cf89a`
- Worktree caveat: the rejected composite implementation is present as uncommitted changes and must be revised in place without discarding unrelated work.
- Open Generative AI fork HEAD: `0ab564ba0e59a050a6db1adc61a3345e0dc35708`
- Open Generative AI upstream HEAD: `7c8df61ef5fe458339af03214d94e859a6a4a273`
- Confirmed divergence on 2026-07-15: fork ahead `2`, upstream ahead `0`; upstream HEAD is the merge-base and a no-commit merge reports `Already up to date`.
- Do not create a permanent clone or nested Git repository inside Content Studio. Assimilate reviewed behavior through Content Studio's native contracts.

## Product contract

The user sees one product named **Hivemind Studio**. The primary Studio surface has native modes for creating, editing, animating, and building a detailed production workflow. Every mode uses the same prompt composer, model routing, ordered reference images, durable runs, artifacts, history, and approval system. Repository names and service URLs are diagnostics/provenance, never user-facing workspace boundaries.

## Task 1: Preserve the native studio mode in canonical plans

**Objective:** Make the selected native tool mode part of the saved composer state so runs and prompt history reopen in the same experience.

**Files:**

- Modify: `src/hivemind_content_studio/control_api.py`
- Modify: `test/studio/test_control_api.py`

**Step 1: Write the failing test**

POST `/api/simple/plan` with `studioMode: "edit"` and assert both the brain request and returned `plan.composer.studioMode` preserve `edit`. Assert unsupported values fail validation.

**Step 2: Verify RED**

Run: `uv run pytest test/studio/test_control_api.py -q -k studio_mode`

Expected: failure because `SimplePlanBody` and the composer snapshot do not preserve a mode.

**Step 3: Implement the minimal contract**

Add a `Literal["create", "edit", "animate", "workflow"]` field with a `create` default and include it in `_composer_snapshot` and the returned plan composer.

**Step 4: Verify GREEN**

Run the focused test again and expect it to pass.

## Task 2: Replace composite workspaces with one native Studio surface

**Objective:** Remove every visible app boundary and expose donor capabilities as first-party modes in the existing canonical composer.

**Files:**

- Modify: `src/hivemind_content_studio/ui/index.html`
- Modify: `src/hivemind_content_studio/ui/studio.js`
- Modify: `src/hivemind_content_studio/ui/studio.css`
- Modify: `test/studio/test_studio_ui_contract.py`

**Step 1: Write the failing UI contract**

Assert that the main navigation calls the native creation surface `Studio`, includes native `create`, `edit`, `animate`, and `workflow` mode buttons, and contains no iframe, workspace board, external workspace button, or composite-app copy. Assert JavaScript preserves the selected mode in `/api/simple/plan`, restores it from a run, and does not fetch the runtime workspace catalog for presentation.

**Step 2: Verify RED**

Run: `uv run pytest test/studio/test_studio_ui_contract.py -q -k native_unified_studio`

Expected: contract failure against the current composite workspace UI.

**Step 3: Implement the native modes**

- Rename the first navigation item to `Studio` and remove the separate Studio/runtime item.
- Replace the Simple/Advanced split header with a native mode rail.
- `create`: the full agent-directed composer with image and video routes.
- `edit`: the same composer, reference intake required, image route emphasized.
- `animate`: the same composer, reference intake available, video route emphasized.
- `workflow`: reveal the existing detailed production form without leaving the Studio surface.
- Persist `studioMode` in the plan request and restore it with prompts, routes, and reference artifacts.
- Remove iframe mounting, workspace/source cards, external workspace links, and their event handlers/styles.

**Step 4: Verify GREEN**

Run the focused UI contract and `node --check src/hivemind_content_studio/ui/studio.js`.

## Task 3: Keep repository/service knowledge internal

**Objective:** Retain safe diagnostics and upstream provenance without presenting repositories as separate products.

**Files:**

- Modify: `src/hivemind_content_studio/unified_runtime.py`
- Modify: `test/studio/test_unified_runtime.py`
- Modify: `test/studio/test_control_api.py`

**Step 1: Write the failing runtime contract**

Assert the snapshot has one native `studio` surface, no mountable `workspaces`, and internal engine health plus the seven source repositories. Source integrations must be `assimilated`, `native`, or `engine`, never `embedded-workspace`.

**Step 2: Verify RED**

Run: `uv run pytest test/studio/test_unified_runtime.py -q`

Expected: failure because the current catalog exposes four separate workspaces and browser URLs.

**Step 3: Implement the internal snapshot**

Return the single native surface and bounded engine health. Remove Open Generative AI and ComfyUI frontend URLs from the browser payload; preserve their source/upstream metadata as provenance only.

**Step 4: Verify GREEN**

Run the runtime and API tests and expect them to pass.

## Task 4: Rewrite durable architecture and operations documentation

**Objective:** Remove the superseded composite/side-by-side language from all current documentation.

**Files:**

- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/MIGRATION_MAP.md`
- Modify: `docs/OPERATIONS.md`

Document one product surface, one canonical state model, donor-code assimilation, internal engine adapters, and the verified Open Generative AI fork/upstream state.

## Task 5: Verification

Run:

```bash
uv run pytest test/studio/test_unified_runtime.py test/studio/test_control_api.py test/studio/test_studio_ui_contract.py -q
node --check src/hivemind_content_studio/ui/studio.js
uv run python -m compileall -q src/hivemind_content_studio
git diff --check
uv run pytest -q
```

Start `content-studio-api`, open the real browser at `http://127.0.0.1:8765/`, switch through all four native modes, and confirm no iframe or external app chooser appears. Verify Edit blocks submission without a reference image and that Create/Animate/Workflow remain operable through the same page.

## Acceptance criteria

- The user sees one Hivemind Studio, not a collection of repositories or workspaces.
- No iframe, separate-app card, or external-workspace link remains in the product UI.
- Create, Edit, Animate, and Workflow are first-party modes over the same composer and durable run engine.
- A saved run restores its native mode, model routes, prompt options, and reference images.
- All seven repositories retain source/upstream provenance internally.
- Open Generative AI is confirmed current with upstream before assimilation work proceeds.
- Existing Content Studio behavior remains covered by the targeted and full gates.
