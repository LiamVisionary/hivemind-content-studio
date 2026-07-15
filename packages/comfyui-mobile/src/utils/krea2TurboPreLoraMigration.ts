import type { Workflow, WorkflowInput, WorkflowLink, WorkflowNode, WorkflowOutput } from '@/api/types';

const LEGACY_TURBO_CONVROT_MODEL = 'Krea2_Turbo_convrot_int8mixed.safetensors';
const PRE_LORA_TURBO_SOURCE_MODEL = 'krea2_turbo_bf16.safetensors';
const KREA2_TURBO_DEFAULT_SAMPLER = 'euler_ancestral';
const KREA2_TURBO_DEFAULT_SCHEDULER = 'beta';

export interface Krea2TurboPreLoraMigrationResult {
  workflow: Workflow;
  changed: boolean;
}

function cloneWorkflow(workflow: Workflow): Workflow {
  if (typeof structuredClone === 'function') {
    return structuredClone(workflow);
  }
  return JSON.parse(JSON.stringify(workflow)) as Workflow;
}

function basename(value: unknown): string {
  return typeof value === 'string' ? value.split('/').pop() ?? value : '';
}

function findNodeById(workflow: Workflow, id: number): WorkflowNode | undefined {
  return workflow.nodes.find((node) => node.id === id);
}

function findLink(workflow: Workflow, linkId: number | null | undefined): WorkflowLink | undefined {
  if (linkId == null) return undefined;
  return workflow.links.find((link) => link[0] === linkId);
}

function inputIndex(node: WorkflowNode, name: string, type: string): number {
  return (node.inputs ?? []).findIndex((input) => input.name === name || input.type === type);
}

function outputIndex(node: WorkflowNode, name: string, type: string): number {
  return (node.outputs ?? []).findIndex((output) => output.name === name || output.type === type);
}

function outputLinks(workflow: Workflow, nodeId: number, outputSlot: number): number[] {
  const node = findNodeById(workflow, nodeId);
  const fromOutput = node?.outputs?.[outputSlot]?.links;
  const ids = Array.isArray(fromOutput) ? [...fromOutput] : [];
  for (const link of workflow.links ?? []) {
    if (link[1] === nodeId && link[2] === outputSlot && !ids.includes(link[0])) {
      ids.push(link[0]);
    }
  }
  return ids;
}

function removeOutputLink(output: WorkflowOutput | undefined, linkId: number): void {
  if (!output || !Array.isArray(output.links)) return;
  output.links = output.links.filter((candidate) => candidate !== linkId);
}

function addOutputLinks(output: WorkflowOutput | undefined, linkIds: number[]): void {
  if (!output) return;
  output.links = Array.isArray(output.links) ? output.links : [];
  for (const linkId of linkIds) {
    if (!output.links.includes(linkId)) output.links.push(linkId);
  }
}

function setInputLink(input: WorkflowInput | undefined, linkId: number | null): void {
  if (input) input.link = linkId;
}

function isLegacyTurboUnet(node: WorkflowNode | undefined): node is WorkflowNode {
  return Boolean(
    node?.type === 'UNETLoader'
    && Array.isArray(node.widgets_values)
    && basename(node.widgets_values[0]) === LEGACY_TURBO_CONVROT_MODEL,
  );
}

function isPreLoraTurboUnet(node: WorkflowNode | undefined): node is WorkflowNode {
  return Boolean(
    node?.type === 'OTUNetLoaderW8A8'
    && Array.isArray(node.widgets_values)
    && basename(node.widgets_values[0]) === PRE_LORA_TURBO_SOURCE_MODEL
    && node.widgets_values[2] === 'krea2',
  );
}

function isKrea2TurboWorkflow(workflow: Workflow): boolean {
  return (workflow.nodes ?? []).some((node) => isLegacyTurboUnet(node) || isPreLoraTurboUnet(node));
}

function normalizeKrea2TurboSamplerWidgets(workflow: Workflow): boolean {
  if (!isKrea2TurboWorkflow(workflow)) return false;
  let changed = false;
  for (const node of workflow.nodes ?? []) {
    if (node.type !== 'KSampler' || !Array.isArray(node.widgets_values)) continue;
    const widgets = node.widgets_values;
    if (widgets[4] !== 'er_sde' || widgets[5] !== 'simple') continue;
    widgets[4] = KREA2_TURBO_DEFAULT_SAMPLER;
    widgets[5] = KREA2_TURBO_DEFAULT_SCHEDULER;
    if (node.title === 'KSampler - Turbo INT8 er_sde') {
      node.title = 'KSampler - Turbo INT8 euler ancestral beta';
    }
    changed = true;
  }
  return changed;
}

function normalizeKrea2TextEncodeWidgets(node: WorkflowNode): boolean {
  if (node.type !== 'TextEncodeKrea2') return false;
  const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  const currentShape =
    widgets.length === 7
    && typeof widgets[1] === 'number'
    && typeof widgets[2] === 'number'
    && typeof widgets[3] === 'string'
    && typeof widgets[4] === 'boolean'
    && typeof widgets[5] === 'boolean'
    && typeof widgets[6] === 'string';
  if (currentShape) return false;
  const prompt = typeof widgets[0] === 'string' ? widgets[0] : '';
  node.widgets_values = [prompt, 1.0, 0.0, 'before prompt', false, true, 'json_structured'];
  return true;
}

function normalizeKrea2PromptCompactWidgets(node: WorkflowNode): boolean {
  if (node.type !== 'Krea2PromptCompact') return false;
  const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  const maxChars = Number(widgets[0]);
  const nextMaxChars = Number.isFinite(maxChars) ? maxChars : 2600;
  const nextMode = typeof widgets[widgets.length - 1] === 'string'
    ? widgets[widgets.length - 1]
    : 'json_structured';
  if (widgets.length === 2 && widgets[0] === nextMaxChars && widgets[1] === nextMode) return false;
  node.widgets_values = [nextMaxChars, nextMode];
  return true;
}

function normalizeStaleKrea2WidgetShapes(workflow: Workflow): boolean {
  let changed = false;
  for (const node of workflow.nodes ?? []) {
    changed = normalizeKrea2TextEncodeWidgets(node) || changed;
    changed = normalizeKrea2PromptCompactWidgets(node) || changed;
  }
  return changed;
}

export function isLegacyKrea2TurboRuntimeLoraWorkflow(workflow: Workflow | null | undefined): boolean {
  if (!workflow?.nodes?.length) return false;
  return workflow.nodes.some((node) => {
    if (node.type !== 'MultiLoRAStack') return false;
    const modelInput = node.inputs?.[inputIndex(node, 'model', 'MODEL')];
    const modelLink = findLink(workflow, modelInput?.link);
    return isLegacyTurboUnet(modelLink ? findNodeById(workflow, modelLink[1]) : undefined);
  });
}

export function repairKrea2TurboPreLoraWorkflow(
  workflow: Workflow,
): Krea2TurboPreLoraMigrationResult {
  if (!workflow.nodes?.length) return { workflow, changed: false };
  if (!isLegacyKrea2TurboRuntimeLoraWorkflow(workflow)) {
    const normalized = cloneWorkflow(workflow);
    const normalizedChanged = normalizeStaleKrea2WidgetShapes(normalized);
    const samplerChanged = normalizeKrea2TurboSamplerWidgets(normalized);
    return normalizedChanged || samplerChanged
      ? { workflow: normalized, changed: true }
      : { workflow, changed: false };
  }

  const migrated = cloneWorkflow(workflow);
  migrated.links = migrated.links ?? [];
  migrated.nodes = migrated.nodes ?? [];
  let changed = normalizeStaleKrea2WidgetShapes(migrated);
  changed = normalizeKrea2TurboSamplerWidgets(migrated) || changed;

  for (const loraNode of migrated.nodes) {
    if (loraNode.type !== 'MultiLoRAStack') continue;
    const modelInputIdx = inputIndex(loraNode, 'model', 'MODEL');
    const clipInputIdx = inputIndex(loraNode, 'clip', 'CLIP');
    const modelOutputIdx = outputIndex(loraNode, 'MODEL', 'MODEL');
    const clipOutputIdx = outputIndex(loraNode, 'CLIP', 'CLIP');
    if (modelInputIdx < 0 || modelOutputIdx < 0) continue;

    const oldModelInput = loraNode.inputs[modelInputIdx];
    const oldModelInputLink = findLink(migrated, oldModelInput?.link);
    if (!oldModelInputLink) continue;

    const unetNode = findNodeById(migrated, oldModelInputLink[1]);
    if (!isLegacyTurboUnet(unetNode)) continue;

    const oldClipInput = clipInputIdx >= 0 ? loraNode.inputs[clipInputIdx] : undefined;
    const oldClipInputLink = findLink(migrated, oldClipInput?.link);
    const clipSourceNode = oldClipInputLink ? findNodeById(migrated, oldClipInputLink[1]) : undefined;
    const clipSourceOutput = oldClipInputLink && clipSourceNode
      ? clipSourceNode.outputs?.[oldClipInputLink[2]]
      : undefined;

    const modelDownstreamLinkIds = outputLinks(migrated, loraNode.id, modelOutputIdx);
    const clipDownstreamLinkIds = clipOutputIdx >= 0
      ? outputLinks(migrated, loraNode.id, clipOutputIdx)
      : [];
    const preLoraLinkId = oldModelInputLink[0];

    loraNode.type = 'MultiLoRAStackToPreLora';
    loraNode.title = 'Multi-LoRA Stack - Pre-Quantization';
    loraNode.inputs = [];
    loraNode.outputs = [{
      name: 'PRE_LORA',
      type: 'PRE_LORA',
      links: [preLoraLinkId],
      slot_index: 0,
    }];
    loraNode.properties = { ...(loraNode.properties ?? {}), 'Node name for S&R': 'MultiLoRAStackToPreLora' };

    unetNode.type = 'OTUNetLoaderW8A8';
    unetNode.title = 'UNet Loader - BF16 + Multi-LoRA -> ConvRot INT8';
    unetNode.size = [330.0044769287109, 178];
    unetNode.inputs = [
      { name: 'pre_lora', type: 'PRE_LORA', link: preLoraLinkId },
      { name: 'unet_name', type: 'COMBO', widget: { name: 'unet_name' }, link: null },
      { name: 'weight_dtype', type: 'COMBO', widget: { name: 'weight_dtype' }, link: null },
      { name: 'model_type', type: 'COMBO', widget: { name: 'model_type' }, link: null },
      { name: 'on_the_fly_quantization', type: 'BOOLEAN', widget: { name: 'on_the_fly_quantization' }, link: null },
      { name: 'enable_convrot', type: 'BOOLEAN', widget: { name: 'enable_convrot' }, link: null },
      { name: 'lora_mode', type: 'COMBO', widget: { name: 'lora_mode' }, link: null },
    ];
    unetNode.outputs = [{
      name: 'MODEL',
      type: 'MODEL',
      links: modelDownstreamLinkIds,
      slot_index: 0,
    }];
    unetNode.properties = { ...(unetNode.properties ?? {}), 'Node name for S&R': 'OTUNetLoaderW8A8' };
    unetNode.widgets_values = [PRE_LORA_TURBO_SOURCE_MODEL, 'default', 'krea2', true, true, 'None'];

    oldModelInputLink[1] = loraNode.id;
    oldModelInputLink[2] = 0;
    oldModelInputLink[3] = unetNode.id;
    oldModelInputLink[4] = 0;
    oldModelInputLink[5] = 'PRE_LORA';

    for (const linkId of modelDownstreamLinkIds) {
      const link = findLink(migrated, linkId);
      if (!link) continue;
      link[1] = unetNode.id;
      link[2] = 0;
      link[5] = 'MODEL';
    }

    if (oldClipInputLink && clipSourceNode) {
      removeOutputLink(clipSourceOutput, oldClipInputLink[0]);
      migrated.links = migrated.links.filter((link) => link[0] !== oldClipInputLink[0]);
      for (const linkId of clipDownstreamLinkIds) {
        const link = findLink(migrated, linkId);
        if (!link) continue;
        link[1] = oldClipInputLink[1];
        link[2] = oldClipInputLink[2];
        link[5] = 'CLIP';
      }
      addOutputLinks(clipSourceOutput, clipDownstreamLinkIds);
    }

    setInputLink(oldModelInput, null);
    setInputLink(oldClipInput, null);
    changed = true;
    break;
  }

  return changed ? { workflow: migrated, changed: true } : { workflow, changed: false };
}
