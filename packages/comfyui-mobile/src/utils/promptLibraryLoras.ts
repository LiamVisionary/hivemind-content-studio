import type { NodeTypes, Workflow, WorkflowLink, WorkflowNode } from '@/api/types';
import type { PromptLibraryLoraAttachment } from '@/utils/promptLibrary';
import {
  applyLoraValuesToText,
  extractLoraList,
  extractMultiLoraStackList,
  findLoraListIndex,
  isLoraList,
  isLoraManagerNodeType,
  isMfluxLorasLoaderNodeType,
  isMultiLoraStackNodeType,
  isPowerLoraLoaderNodeType,
  normalizeLoraEntry,
  normalizeLoraManagerName,
  normalizeLoraStackEntry,
  serializeMultiLoraStackList,
  type LoraManagerEntry,
} from '@/utils/loraManager';

export interface PromptLibraryLoraApplySummary {
  changed: boolean;
  nodeId?: number;
  nodeTitle?: string;
  nodeType?: string;
  applied: string[];
  skipped: string[];
  reason?: string;
}

export interface PromptLibraryLoraApplyResult {
  workflow: Workflow;
  summary: PromptLibraryLoraApplySummary;
}

export interface PromptLibraryLoraApplyOptions {
  nodeTypes?: NodeTypes | null;
  allowInsert?: boolean;
}

function cloneWorkflow(workflow: Workflow): Workflow {
  if (typeof structuredClone === 'function') {
    return structuredClone(workflow);
  }
  return JSON.parse(JSON.stringify(workflow)) as Workflow;
}

function normalizeAttachment(
  attachment: PromptLibraryLoraAttachment,
  options?: { preserveFileExtension?: boolean },
): LoraManagerEntry | null {
  const name = String(attachment.name ?? '').replace(/\\/g, '/').trim();
  if (!name) return null;
  const strength = attachment.strength ?? 1;
  const clipStrength = attachment.clipStrength ?? strength;
  return options?.preserveFileExtension
    ? normalizeLoraStackEntry({
        name,
        strength,
        clipStrength,
        active: attachment.active !== false,
      })
    : normalizeLoraEntry({
        name,
        strength,
        clipStrength,
        active: attachment.active !== false,
      });
}

function loraIdentity(name: string): string {
  const normalized = name.replace(/\\/g, '/').trim().toLowerCase();
  const base = normalized.split('/').filter(Boolean).pop() ?? normalized;
  return base.replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, '');
}

function mergeEntries(
  existing: LoraManagerEntry[],
  attachments: PromptLibraryLoraAttachment[],
  options?: { preserveFileExtension?: boolean },
): { entries: LoraManagerEntry[]; applied: string[]; skipped: string[]; changed: boolean } {
  const next = [...existing];
  const applied: string[] = [];
  const skipped: string[] = [];
  let changed = false;

  for (const attachment of attachments) {
    const entry = normalizeAttachment(attachment, options);
    if (!entry?.name) {
      skipped.push(String(attachment.name ?? 'unnamed'));
      continue;
    }

    const targetKey = loraIdentity(entry.name);
    const existingIndex = next.findIndex((candidate) => loraIdentity(String(candidate.name ?? '')) === targetKey);
    if (existingIndex >= 0) {
      const current = normalizeLoraStackEntry(next[existingIndex]);
      const merged = {
        ...current,
        ...entry,
        name: options?.preserveFileExtension ? entry.name : normalizeLoraManagerName(entry.name),
        active: true,
      };
      next[existingIndex] = options?.preserveFileExtension
        ? normalizeLoraStackEntry(merged)
        : normalizeLoraEntry(merged);
      changed = true;
    } else {
      next.push(entry);
      changed = true;
    }
    applied.push(entry.name);
  }

  return { entries: next, applied, skipped, changed };
}

function findTextWidgetIndex(node: WorkflowNode): number | null {
  if (!Array.isArray(node.widgets_values)) return null;
  const map = (node.properties?.widget_idx_map ?? {}) as Record<string, unknown>;
  const mapped = map.text;
  if (typeof mapped === 'number') return mapped;
  if (typeof mapped === 'string' && Number.isFinite(Number(mapped))) return Number(mapped);
  return node.widgets_values.findIndex((value) => typeof value === 'string' && /<lora:/i.test(value));
}

function updateMultiLoraStackNode(
  node: WorkflowNode,
  attachments: PromptLibraryLoraAttachment[],
): PromptLibraryLoraApplySummary | null {
  if (!isMultiLoraStackNodeType(node.type) || !Array.isArray(node.widgets_values)) return null;
  const current = extractMultiLoraStackList(node.widgets_values[0]) ?? [];
  const merged = mergeEntries(current, attachments, { preserveFileExtension: true });
  node.widgets_values[0] = serializeMultiLoraStackList(merged.entries);
  node.mode = 0;
  return {
    changed: merged.changed,
    nodeId: node.id,
    nodeTitle: node.title,
    nodeType: node.type,
    applied: merged.applied,
    skipped: merged.skipped,
  };
}

function updateLoraManagerNode(
  node: WorkflowNode,
  attachments: PromptLibraryLoraAttachment[],
): PromptLibraryLoraApplySummary | null {
  if (!isLoraManagerNodeType(node.type) || !Array.isArray(node.widgets_values)) return null;
  const listIndex = findLoraListIndex(node);
  if (listIndex === null) return null;
  const current = extractLoraList(node.widgets_values[listIndex]) ?? [];
  const merged = mergeEntries(current, attachments);
  node.widgets_values[listIndex] = merged.entries;
  const textIndex = findTextWidgetIndex(node);
  if (textIndex !== null && textIndex >= 0) {
    const currentText = typeof node.widgets_values[textIndex] === 'string'
      ? node.widgets_values[textIndex]
      : '';
    node.widgets_values[textIndex] = applyLoraValuesToText(currentText, merged.entries);
  }
  node.mode = 0;
  return {
    changed: merged.changed,
    nodeId: node.id,
    nodeTitle: node.title,
    nodeType: node.type,
    applied: merged.applied,
    skipped: merged.skipped,
  };
}

function updatePowerLoraNode(
  node: WorkflowNode,
  attachments: PromptLibraryLoraAttachment[],
): PromptLibraryLoraApplySummary | null {
  if (!isPowerLoraLoaderNodeType(node.type) || !Array.isArray(node.widgets_values)) return null;
  const isPowerLoraWidgetValue = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && 'lora' in value;
  const current = node.widgets_values
    .filter(isPowerLoraWidgetValue)
    .map((value) => normalizeLoraStackEntry({
      name: String(value.lora ?? ''),
      strength: (value.strength as number | string | undefined) ?? 1,
      clipStrength:
        (value.strengthTwo as number | string | undefined) ??
        (value.strength as number | string | undefined) ??
        1,
      active: value.on !== false,
    }));
  const merged = mergeEntries(current, attachments, { preserveFileExtension: true });
  const nonLoraValues = node.widgets_values.filter((value) => !isPowerLoraWidgetValue(value));
  node.widgets_values = [
    ...nonLoraValues,
    ...merged.entries.map((entry) => ({
      on: entry.active !== false,
      lora: entry.name,
      strength: Number(entry.strength ?? 1),
      strengthTwo: Number(entry.clipStrength ?? entry.strength ?? 1),
    })),
  ];
  node.mode = 0;
  return {
    changed: merged.changed,
    nodeId: node.id,
    nodeTitle: node.title,
    nodeType: node.type,
    applied: merged.applied,
    skipped: merged.skipped,
  };
}

function updateMfluxNode(
  node: WorkflowNode,
  attachments: PromptLibraryLoraAttachment[],
): PromptLibraryLoraApplySummary | null {
  if (!isMfluxLorasLoaderNodeType(node.type) || !Array.isArray(node.widgets_values)) return null;
  const values = [...node.widgets_values];
  const applied: string[] = [];
  const skipped: string[] = [];
  let changed = false;

  for (const attachment of attachments) {
    const entry = normalizeAttachment(attachment, { preserveFileExtension: true });
    if (!entry?.name) continue;
    let targetIndex = -1;
    for (let index = 0; index < values.length; index += 2) {
      const value = String(values[index] ?? '');
      if (loraIdentity(value) === loraIdentity(entry.name)) {
        targetIndex = index;
        break;
      }
      if (targetIndex < 0 && (!value || /^none$/i.test(value))) {
        targetIndex = index;
      }
    }
    if (targetIndex < 0) {
      skipped.push(entry.name);
      continue;
    }
    values[targetIndex] = entry.name;
    values[targetIndex + 1] = Number(entry.strength ?? 1);
    applied.push(entry.name);
    changed = true;
  }

  node.widgets_values = values;
  node.mode = 0;
  return {
    changed,
    nodeId: node.id,
    nodeTitle: node.title,
    nodeType: node.type,
    applied,
    skipped,
  };
}

function updateSingleLoraLoaderNode(
  node: WorkflowNode,
  attachments: PromptLibraryLoraAttachment[],
): PromptLibraryLoraApplySummary | null {
  const lowered = `${node.type} ${node.title ?? ''}`.toLowerCase();
  if (!lowered.includes('lora') || !Array.isArray(node.widgets_values)) return null;
  if (isLoraList(node.widgets_values)) return null;
  const attachment = attachments[0];
  const entry = attachment ? normalizeAttachment(attachment, { preserveFileExtension: true }) : null;
  if (!entry?.name) return null;

  node.widgets_values[0] = entry.name;
  if (node.widgets_values.length > 1) node.widgets_values[1] = Number(entry.strength ?? 1);
  if (node.widgets_values.length > 2) node.widgets_values[2] = Number(entry.clipStrength ?? entry.strength ?? 1);
  node.mode = 0;

  return {
    changed: true,
    nodeId: node.id,
    nodeTitle: node.title,
    nodeType: node.type,
    applied: [entry.name],
    skipped: attachments.slice(1).map((item) => item.name),
    reason: attachments.length > 1
      ? 'This workflow only has a single LoRA loader, so only the first saved LoRA was applied.'
      : undefined,
  };
}

function allNodes(workflow: Workflow): WorkflowNode[] {
  return [
    ...(workflow.nodes ?? []),
    ...(workflow.definitions?.subgraphs ?? []).flatMap((subgraph) => subgraph.nodes ?? []),
  ];
}

function maxNodeId(workflow: Workflow): number {
  return Math.max(
    workflow.last_node_id ?? 0,
    0,
    ...(workflow.nodes ?? []).map((node) => node.id ?? 0),
    ...(workflow.definitions?.subgraphs ?? []).flatMap((subgraph) => subgraph.nodes ?? []).map((node) => node.id ?? 0),
  );
}

function maxLinkId(workflow: Workflow): number {
  return Math.max(workflow.last_link_id ?? 0, 0, ...(workflow.links ?? []).map((link) => link[0] ?? 0));
}

function chooseInsertableStackType(nodeTypes?: NodeTypes | null): 'MultiLoRAStackModelOnly' | 'MultiLoRAStack' | null {
  if (!nodeTypes) return null;
  if (nodeTypes.MultiLoRAStackModelOnly) return 'MultiLoRAStackModelOnly';
  if (nodeTypes.MultiLoRAStack) return 'MultiLoRAStack';
  return null;
}

function findInsertableModelLink(workflow: Workflow): WorkflowLink | null {
  for (const link of workflow.links ?? []) {
    if (String(link[5] ?? '').toUpperCase() !== 'MODEL') continue;
    const targetNode = workflow.nodes.find((node) => node.id === link[3]);
    const targetInput = targetNode?.inputs?.[link[4]];
    if (!targetNode || !targetInput) continue;
    if (String(targetInput.type ?? '').toUpperCase() === 'MODEL') return link;
  }
  return null;
}

function insertMultiLoraStackIntoModelLink(
  workflow: Workflow,
  attachments: PromptLibraryLoraAttachment[],
  stackType: 'MultiLoRAStackModelOnly' | 'MultiLoRAStack',
): PromptLibraryLoraApplySummary | null {
  const modelLink = findInsertableModelLink(workflow);
  if (!modelLink) return null;

  const sourceNode = workflow.nodes.find((node) => node.id === modelLink[1]);
  const targetNode = workflow.nodes.find((node) => node.id === modelLink[3]);
  if (!sourceNode || !targetNode) return null;

  const stackId = maxNodeId(workflow) + 1;
  const newLinkId = maxLinkId(workflow) + 1;
  const entries = attachments
    .map((attachment) => normalizeAttachment(attachment, { preserveFileExtension: true }))
    .filter((entry): entry is LoraManagerEntry => Boolean(entry?.name));
  if (entries.length === 0) return null;

  const stackNode: WorkflowNode = {
    id: stackId,
    title: 'LOAD LORAS HERE - Multi LoRA Stack',
    type: stackType,
    pos: [
      Math.round(((sourceNode.pos?.[0] ?? 0) + (targetNode.pos?.[0] ?? 0)) / 2),
      Math.round(((sourceNode.pos?.[1] ?? 0) + (targetNode.pos?.[1] ?? 0)) / 2) - 80,
    ],
    size: [450, 260],
    flags: { collapsed: false },
    order: Math.max(0, targetNode.order ?? 0),
    mode: 0,
    inputs: [
      {
        name: 'model',
        type: 'MODEL',
        link: modelLink[0],
      },
    ],
    outputs: [
      {
        name: 'MODEL',
        type: 'MODEL',
        links: [newLinkId],
        slot_index: 0,
      },
    ],
    properties: {
      'Node name for S&R': stackType,
    },
    widgets_values: [serializeMultiLoraStackList(entries)],
  };

  const oldTargetNodeId = modelLink[3];
  const oldTargetSlot = modelLink[4];
  modelLink[3] = stackId;
  modelLink[4] = 0;

  const targetInput = targetNode.inputs?.[oldTargetSlot];
  if (targetInput) targetInput.link = newLinkId;

  workflow.nodes.push(stackNode);
  workflow.links.push([newLinkId, stackId, 0, oldTargetNodeId, oldTargetSlot, 'MODEL']);
  workflow.last_node_id = Math.max(workflow.last_node_id ?? 0, stackId);
  workflow.last_link_id = Math.max(workflow.last_link_id ?? 0, newLinkId);

  return {
    changed: true,
    nodeId: stackId,
    nodeTitle: stackNode.title,
    nodeType: stackNode.type,
    applied: entries.map((entry) => entry.name),
    skipped: [],
    reason: `Inserted ${stackType} into the model path.`,
  };
}

export function applyPromptLibraryLorasToWorkflow(
  workflow: Workflow,
  attachments: PromptLibraryLoraAttachment[],
  options: PromptLibraryLoraApplyOptions = {},
): PromptLibraryLoraApplyResult {
  const normalizedAttachments = attachments
    .map((attachment) => normalizeAttachment(attachment, { preserveFileExtension: true }))
    .filter((entry): entry is LoraManagerEntry => Boolean(entry?.name))
    .map((entry) => ({
      name: entry.name,
      strength: entry.strength,
      clipStrength: entry.clipStrength,
      active: true,
    }));

  if (normalizedAttachments.length === 0) {
    return {
      workflow,
      summary: {
        changed: false,
        applied: [],
        skipped: [],
        reason: 'No LoRAs attached.',
      },
    };
  }

  const nextWorkflow = cloneWorkflow(workflow);
  const nodes = allNodes(nextWorkflow);
  const updaters = [
    updateMultiLoraStackNode,
    updatePowerLoraNode,
    updateLoraManagerNode,
    updateMfluxNode,
    updateSingleLoraLoaderNode,
  ];

  for (const updater of updaters) {
    for (const node of nodes) {
      const summary = updater(node, normalizedAttachments);
      if (summary) {
        return { workflow: nextWorkflow, summary };
      }
    }
  }

  if (options.allowInsert !== false) {
    const stackType = chooseInsertableStackType(options.nodeTypes);
    if (stackType) {
      const summary = insertMultiLoraStackIntoModelLink(nextWorkflow, normalizedAttachments, stackType);
      if (summary) {
        return { workflow: nextWorkflow, summary };
      }
    }
  }

  return {
    workflow,
    summary: {
      changed: false,
      applied: [],
      skipped: normalizedAttachments.map((attachment) => attachment.name),
      reason: 'No compatible LoRA node was found in this workflow.',
    },
  };
}
