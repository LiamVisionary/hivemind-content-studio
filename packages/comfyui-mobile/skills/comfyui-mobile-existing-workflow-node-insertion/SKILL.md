---
name: comfyui-mobile-existing-workflow-node-insertion
description: Use this skill whenever adding, wiring, surfacing, or debugging a new node in an existing ComfyUI Mobile workflow JSON, especially when the user says a node is missing from a workflow they already use. It prevents the common failure mode where the saved workflow file is changed correctly but ComfyUI Mobile still renders an older persisted/open workflow, hides the node as static, or fails to expose custom-node widgets.
compatibility: "ComfyUI Mobile frontend at /Users/liam/comfy/integrations/comfyui-mobile-frontend and ComfyUI user workflows at /Users/liam/comfy/ComfyUI/user/default/workflows."
---

# ComfyUI Mobile Existing Workflow Node Insertion

Use this when the task is to insert a new node into an existing ComfyUI workflow that is opened through ComfyUI Mobile. Do not treat this as a plain JSON edit. The mobile app has its own workflow persistence, hidden-node state, layout building, widget rendering, and built frontend bundle. Verify every layer.

## Hard Rule

If the user asks to add a node to an existing named workflow, modify that exact workflow. Do not create a copied workflow with a new name unless the user explicitly asks for a duplicate.

For example, if the user says `Anima WAI Couple Turbo - Prompt Assistant`, the target file is:

```text
/Users/liam/comfy/ComfyUI/user/default/workflows/Anima WAI Couple Turbo - Prompt Assistant.json
```

Do not add a diagnostic `- LOAD LORAS`, `- fixed`, or `- copy` workflow and tell the user to use that.

## Relevant Paths

Workflow files:

```text
/Users/liam/comfy/ComfyUI/user/default/workflows/
```

Mobile recent workflow list:

```text
/Users/liam/comfy/ComfyUI/user/default/mobile/recent_workflows.json
```

Mobile frontend repo:

```text
/Users/liam/comfy/integrations/comfyui-mobile-frontend
```

Z-Image/mobile wrapper:

```text
/Users/liam/comfy/z-image-api
```

Common frontend files involved in node visibility/widgets:

```text
src/utils/widgetDefinitions.ts
src/components/WorkflowPanel.tsx
src/components/WorkflowPanel/NodeCard.tsx
src/components/WorkflowPanel/NodeCard/Parameters.tsx
src/components/InputControls/WidgetControl.tsx
src/hooks/useWorkflow.ts
src/utils/mobileLayout.ts
src/utils/grouping.ts
src/utils/nodeOrdering.ts
```

## Workflow JSON Checklist

When inserting a node into an editor-format workflow file:

1. Read the exact workflow file and confirm it is editor-format (`nodes`, `links`) rather than API-format (`class_type` per node).
2. Add the node to `nodes` with a unique `id`, correct `type`, `title`, `pos`, `size`, `mode: 0`, `flags: {}`, `order`, `inputs`, `outputs`, and `widgets_values`.
3. Wire links in the existing editor link format:

```json
[link_id, origin_node_id, origin_slot, target_node_id, target_slot, "TYPE"]
```

4. Update `last_node_id` and `last_link_id`.
5. Confirm the new node is on the actual execution path, not floating disconnected.
6. Keep metadata aligned:

```json
{
  "extra": {
    "name": "Exact Workflow Name",
    "comfyMobile": {
      "title": "Exact Workflow Name"
    }
  }
}
```

7. Do not leave backup files in the visible `workflows/` directory. Move backups to a private folder outside the workflow picker.

## Verify The File Through The Same Route Mobile Uses

Do not stop after reading the filesystem. Verify through the mobile wrapper route:

```bash
curl -s 'http://127.0.0.1:8788/mobile/api/comfy/api/userdata/workflows%2F<encoded-workflow-name>.json' | jq '.nodes | length'
```

For a specific node:

```bash
curl -s 'http://127.0.0.1:8788/mobile/api/comfy/api/userdata/workflows%2F<encoded-workflow-name>.json' \
  | jq -r '.nodes[] | select(.id==NODE_ID or .type=="NODE_TYPE") | {id,type,title,widgets_values}'
```

If the phone uses the Tailnet HTTPS proxy, discover the listener instead of hardcoding any Tailnet IP:

```bash
lsof -nP -iTCP:8789 -sTCP:LISTEN
```

Then verify the same route through that listener.

## Mobile Visibility Checklist

A node can exist in the workflow file and still not appear in ComfyUI Mobile. Check all of these:

1. `orderNodesForMobile(workflow)` includes the node.
2. `buildDefaultLayout(...)` places the node in `mobileLayout`.
3. `buildNestedListFromLayout(...)` renders the node rather than a `hiddenBlock`.
4. `hiddenItems` does not contain the node's item key, location pointer, legacy numeric id, or legacy `root:node:<id>` key.
5. The node is not being classified as a static node because `getWidgetDefinitions(...)` and `getInputWidgetDefinitions(...)` both return empty arrays.
6. The node has a widget renderer if the user needs to interact with it.
7. Search/filter state is not hiding it.
8. The active open workflow state in IndexedDB is not an old workflow object missing the new node entirely.

The last point is the easy one to miss. ComfyUI Mobile persists the active workflow in `workflow-storage`; the open screen may not be the latest file from disk.

## If The Node Type Has Custom Widgets

Adding the JSON node is not enough. Teach the mobile frontend how to render/edit its widget shape.

Use `src/utils/widgetDefinitions.ts` to synthesize mobile widget definitions for the custom node. For a custom stack/list node, return normal editable controls instead of exposing a raw JSON string.

For list-style controls, the usual files are:

```text
src/utils/<feature>.ts
src/utils/widgetDefinitions.ts
src/components/WorkflowPanel/NodeCard/Parameters.tsx
src/components/InputControls/WidgetControl.tsx
src/utils/__tests__/<feature>.test.ts
src/utils/__tests__/widgetDefinitions.test.ts
```

For LoRA stack nodes specifically:

- Detect the node type in `src/utils/loraManager.ts`.
- Parse the stack JSON into editable row entries.
- Serialize back into the exact format the custom ComfyUI node expects.
- Preserve `.safetensors` filenames when the backend expects full filenames.
- Add `getWidgetDefinitions(...)` tests proving the node produces visible widgets.

## Existing Workflow Persisted-State Repair

When adding a node to a workflow the user already has open, handle two stale-state cases:

Case 1: The new node exists in active workflow state but is hidden.

- Clear hidden state for the new node type in `loadWorkflow(...)`.
- Add a render-time self-heal in `WorkflowPanel.tsx` if necessary:
  - compute the node's possible keys (`itemKey`, location pointer, numeric id, legacy root key)
  - call `setItemHidden(key, false)` for any hidden matches

Case 2: The active workflow state does not contain the new node at all.

- Add a targeted self-repair that detects the exact workflow filename and the missing required node type.
- Load the saved workflow file from ComfyUI with `loadUserWorkflow(...)`.
- Replace the active tab in-place:

```ts
loadWorkflow(serverWorkflow, filename, {
  fresh: true,
  replaceActive: true,
  navigate: false,
  source: { type: "user", filename },
});
```

Use this sparingly and make the filename/type predicate exact so it does not surprise other workflows.

## Build And Serving Verification

After frontend changes:

```bash
npm test -- --run src/utils/__tests__/widgetDefinitions.test.ts src/utils/__tests__/<feature>.test.ts
npm run build
```

Verify the served mobile bundle hash changed:

```bash
curl -s 'http://127.0.0.1:8788/mobile/' | rg -o 'index-[A-Za-z0-9_\\-]+\\.js'
```

If the Tailnet HTTPS proxy is in use, verify that route too:

```bash
curl -ks 'https://<discovered-tailnet-host>:8789/mobile/' | rg -o 'index-[A-Za-z0-9_\\-]+\\.js'
```

The frontend can serve immutable hashed JS assets. That is fine when the hash changed. The HTML route should point at the new hash.

## User-Facing Verification

Before claiming the fix:

1. Confirm the exact original workflow is still first in `mobile/recent_workflows.json` if recents matter.
2. Confirm there is no copied diagnostic workflow cluttering the picker.
3. Confirm the exact original workflow route returns the new node.
4. Confirm frontend tests pass.
5. Confirm `npm run build` passes.
6. Confirm the running mobile route serves the new built bundle.
7. Explain whether the phone must refresh the already-open app process to run the new JS. Do not call this a "cache issue" if the root problem was stale persisted workflow state.

## Useful Debug Commands

List matching workflows:

```bash
curl -s 'http://127.0.0.1:8788/mobile/api/comfy/api/v2/userdata?path=workflows' \
  | jq -r '.[] | select(.name|test("Anima|Workflow|Prompt")) | [.name,.path,.modified] | @tsv'
```

Print a node from a workflow file:

```bash
python3 - <<'PY'
import json
from pathlib import Path
p = Path('/Users/liam/comfy/ComfyUI/user/default/workflows/WORKFLOW.json')
w = json.loads(p.read_text())
for n in w.get('nodes', []):
    if n.get('id') == 11 or 'lora' in (n.get('type', '') + n.get('title', '')).lower():
        print(json.dumps(n, indent=2))
PY
```

Check mobile listeners:

```bash
lsof -nP -iTCP:8788 -sTCP:LISTEN
lsof -nP -iTCP:8789 -sTCP:LISTEN
```

Check current frontend changes:

```bash
git -C /Users/liam/comfy/integrations/comfyui-mobile-frontend status --short
```

## Lessons From The LoRA Stack Incident

The `Anima WAI Couple Turbo - Prompt Assistant` LoRA-stack issue had three separate layers:

1. The original workflow file needed `MultiLoRAStackModelOnly` inserted and wired into the model path.
2. The mobile frontend needed first-class widget support for that custom node; otherwise it could look missing or useless.
3. The phone could already have the original workflow open from persisted `workflow-storage`, so the active in-memory workflow had no new node even though the saved file was correct.

Future fixes must cover all three layers before telling the user it is done.
