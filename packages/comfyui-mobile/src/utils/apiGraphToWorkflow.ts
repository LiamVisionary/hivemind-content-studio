// Rebuild a ComfyUI UI workflow ({nodes, links}) from an API-format prompt graph
// ({ "id": { class_type, inputs } }). Studio (auto-workflow) generations record
// their resolved API graph (vault-sealed); "Load in Canvas" converts it here so
// the exact node graph opens in the editor. Mirrors the store's `addNode` node
// construction (src/hooks/useWorkflow.ts) so the output matches what the renderer
// expects: widget inputs -> positional widgets_values (required then optional,
// widget inputs only, NO hidden control_after_generate widgets); connection inputs
// -> input slots + links [link_id, src_node, src_slot, dst_node, dst_slot, type].
import type {
  NodeTypeDefinition,
  NodeTypes,
  Workflow,
  WorkflowLink,
  WorkflowNode,
} from '@/api/types';

interface ApiNode {
  class_type: string;
  inputs?: Record<string, unknown>;
}
type ApiGraph = Record<string, ApiNode>;

const PRIMITIVE_WIDGET_TYPES = ['INT', 'FLOAT', 'BOOLEAN', 'STRING'];

// Matches addNode: a COMBO (array of choices) or a primitive type is a widget;
// everything else (MODEL, CLIP, VAE, LATENT, IMAGE, CONDITIONING, …) is a slot.
function isWidgetInputDef(typeOrOptions: unknown): boolean {
  if (Array.isArray(typeOrOptions)) return true;
  return PRIMITIVE_WIDGET_TYPES.includes(String(typeOrOptions).toUpperCase());
}

function widgetDefault(typeOrOptions: unknown, opts: unknown): unknown {
  if (Array.isArray(typeOrOptions)) return typeOrOptions[0] ?? '';
  const normalized = String(typeOrOptions).toUpperCase();
  const o = (opts as Record<string, unknown>) || {};
  if (normalized === 'INT') return o.default ?? 0;
  if (normalized === 'FLOAT') return o.default ?? 0.0;
  if (normalized === 'STRING') return o.default ?? '';
  if (normalized === 'BOOLEAN') return o.default ?? false;
  return o.default ?? null;
}

function orderedInputEntries(def: NodeTypeDefinition): Array<{ name: string; entry: unknown }> {
  const required = def.input?.required ?? {};
  const optional = def.input?.optional ?? {};
  const requiredOrder = def.input_order?.required ?? Object.keys(required);
  const optionalOrder = def.input_order?.optional ?? Object.keys(optional);
  const out: Array<{ name: string; entry: unknown }> = [];
  for (const name of requiredOrder) if (required[name]) out.push({ name, entry: required[name] });
  for (const name of optionalOrder) if (optional[name]) out.push({ name, entry: optional[name] });
  return out;
}

function isLinkRef(value: unknown): value is [string | number, number] {
  return (
    Array.isArray(value)
    && value.length === 2
    && (typeof value[0] === 'string' || typeof value[0] === 'number')
    && typeof value[1] === 'number'
  );
}

export function apiGraphToWorkflow(apiGraph: ApiGraph, nodeTypes: NodeTypes): Workflow {
  const nodes: WorkflowNode[] = [];
  const nodeById = new Map<number, WorkflowNode>();
  // per node: input-name -> input-slot index (connection slots only)
  const slotIndexByNode = new Map<number, Map<string, number>>();
  // per node: input-name -> widgets_values index (widget inputs only)
  const widgetIndexByNode = new Map<number, Map<string, number>>();

  const entries = Object.entries(apiGraph).filter(([, n]) => n && typeof n === 'object' && n.class_type);

  // Pass 1: build every node with default widgets + empty connection slots.
  let placed = 0;
  for (const [key, apiNode] of entries) {
    const id = Number(key);
    const type = String(apiNode.class_type);
    const def = nodeTypes[type];
    const inputs: WorkflowNode['inputs'] = [];
    const widgetsValues: unknown[] = [];
    const slotIndex = new Map<string, number>();
    const widgetIndex = new Map<string, number>();

    if (def) {
      for (const { name, entry } of orderedInputEntries(def)) {
        const [typeOrOptions, opts] = entry as [unknown, unknown];
        if (isWidgetInputDef(typeOrOptions)) {
          widgetIndex.set(name, widgetsValues.length);
          widgetsValues.push(widgetDefault(typeOrOptions, opts));
        } else {
          slotIndex.set(name, inputs.length);
          inputs.push({ name, type: String(typeOrOptions), link: null });
        }
      }
    }

    const outputs: WorkflowNode['outputs'] = (def?.output ?? []).map((t, i) => ({
      name: def?.output_name?.[i] ?? String(t),
      type: String(t),
      links: null,
      slot_index: i,
    }));

    // Grid auto-layout; the editor re-flows on load, this just avoids overlap.
    const node: WorkflowNode = {
      id,
      type,
      pos: [Math.floor(placed / 8) * 420, (placed % 8) * 200],
      size: [210, 130],
      flags: {},
      order: placed,
      mode: 0,
      inputs,
      outputs,
      properties: {},
      widgets_values: widgetsValues,
    };
    placed += 1;

    // Override widget defaults with the literal values from the API graph.
    for (const [inName, inVal] of Object.entries(apiNode.inputs ?? {})) {
      if (isLinkRef(inVal)) continue;
      const wi = widgetIndex.get(inName);
      if (wi !== undefined) (node.widgets_values as unknown[])[wi] = inVal;
    }

    nodes.push(node);
    nodeById.set(id, node);
    slotIndexByNode.set(id, slotIndex);
    widgetIndexByNode.set(id, widgetIndex);
  }

  // Pass 2: reconstruct links from connection-ref inputs.
  const links: WorkflowLink[] = [];
  let linkId = 0;
  for (const [key, apiNode] of entries) {
    const targetId = Number(key);
    const target = nodeById.get(targetId);
    const slotIndex = slotIndexByNode.get(targetId);
    if (!target || !slotIndex) continue;
    for (const [inName, inVal] of Object.entries(apiNode.inputs ?? {})) {
      if (!isLinkRef(inVal)) continue;
      const [srcKey, srcSlot] = inVal;
      const srcId = Number(srcKey);
      const source = nodeById.get(srcId);
      const targetSlot = slotIndex.get(inName);
      if (!source || targetSlot === undefined) continue;
      const linkType = target.inputs[targetSlot]?.type ?? '*';
      linkId += 1;
      links.push([linkId, srcId, Number(srcSlot), targetId, targetSlot, String(linkType)]);
      target.inputs[targetSlot].link = linkId;
      const outSlot = source.outputs[Number(srcSlot)];
      if (outSlot) outSlot.links = [...(outSlot.links ?? []), linkId];
    }
  }

  const lastNodeId = nodes.reduce((max, n) => Math.max(max, n.id), 0);
  return {
    last_node_id: lastNodeId,
    last_link_id: linkId,
    nodes,
    links,
    groups: [],
    config: {},
    extra: {},
    version: 0.4,
  } as Workflow;
}
