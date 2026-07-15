import type { Workflow, WorkflowInput, WorkflowLink, WorkflowNode, WorkflowOutput } from '@/api/types';

export const BIGLOVE_KLEIN3_MLX_TEST_FILENAME = 'BigLoveKlein3MLXTest.json';

const QUICK_MFLUX_NODE_TYPE = 'QuickMfluxNode';
const MFLUX_LORAS_LOADER_NODE_TYPE = 'MfluxLorasLoader';
const MFLUX_LORAS_PIPELINE_TYPE = 'MfluxLorasPipeline';
const MULTI_LORA_STACK_MODEL_ONLY_NODE_TYPE = 'MultiLoRAStackModelOnly';

const DEFAULT_MFLUX_LORA_WIDGETS = ['None', 1, 'None', 1, 'None', 1];
const MFLUX_STACK_SIZE: [number, number] = [320, 190];
const MULTI_LORA_STACK_SIZE: [number, number] = [450, 260];

export interface BigLoveKleinLoraMigrationResult {
  workflow: Workflow;
  changed: boolean;
}

function cloneWorkflow(workflow: Workflow): Workflow {
  if (typeof structuredClone === 'function') {
    return structuredClone(workflow);
  }
  return JSON.parse(JSON.stringify(workflow)) as Workflow;
}

function isTargetFilename(filename?: string | null): boolean {
  if (!filename) return false;
  const basename = filename.split('/').pop() ?? filename;
  return basename === BIGLOVE_KLEIN3_MLX_TEST_FILENAME || basename === 'BigLoveKlein3MLXTest';
}

export function isBigLoveKlein3MlxWorkflow(workflow: Workflow | null | undefined): boolean {
  return Boolean(
    workflow?.nodes?.some((node) => {
      if (node.type !== 'UNETLoader' || !Array.isArray(node.widgets_values)) return false;
      return node.widgets_values.some(
        (value) =>
          typeof value === 'string' &&
          value.toLowerCase().includes('bigloveklein3_mxfp8'),
      );
    }),
  );
}

function maxNodeId(workflow: Workflow): number {
  return Math.max(
    workflow.last_node_id ?? 0,
    0,
    ...(workflow.nodes ?? []).map((node) => node.id ?? 0),
  );
}

function maxLinkId(workflow: Workflow): number {
  return Math.max(
    workflow.last_link_id ?? 0,
    0,
    ...(workflow.links ?? []).map((link) => link[0] ?? 0),
  );
}

function getInputIndex(node: WorkflowNode, name: string, type: string): number {
  return (node.inputs ?? []).findIndex((input) => input.name === name || input.type === type);
}

function getOutputIndex(node: WorkflowNode, name: string, type: string): number {
  return (node.outputs ?? []).findIndex((output) => output.name === name || output.type === type);
}

function ensurePipelineInput(node: WorkflowNode): { index: number; changed: boolean } {
  node.inputs = node.inputs ?? [];
  const existingIndex = getInputIndex(node, 'Loras', MFLUX_LORAS_PIPELINE_TYPE);
  if (existingIndex >= 0) {
    const input = node.inputs[existingIndex];
    let changed = false;
    if (input.name !== 'Loras') {
      input.name = 'Loras';
      changed = true;
    }
    if (input.type !== MFLUX_LORAS_PIPELINE_TYPE) {
      input.type = MFLUX_LORAS_PIPELINE_TYPE;
      changed = true;
    }
    return { index: existingIndex, changed };
  }

  node.inputs.push({
    name: 'Loras',
    type: MFLUX_LORAS_PIPELINE_TYPE,
    link: null,
  });
  return { index: node.inputs.length - 1, changed: true };
}

function ensurePipelineOutput(node: WorkflowNode): { index: number; changed: boolean } {
  node.outputs = node.outputs ?? [];
  const existingIndex = getOutputIndex(node, 'Loras', MFLUX_LORAS_PIPELINE_TYPE);
  if (existingIndex >= 0) {
    const output = node.outputs[existingIndex];
    let changed = false;
    if (output.name !== 'Loras') {
      output.name = 'Loras';
      changed = true;
    }
    if (output.type !== MFLUX_LORAS_PIPELINE_TYPE) {
      output.type = MFLUX_LORAS_PIPELINE_TYPE;
      changed = true;
    }
    if (!Array.isArray(output.links)) {
      output.links = [];
      changed = true;
    }
    if (output.slot_index !== existingIndex) {
      output.slot_index = existingIndex;
      changed = true;
    }
    return { index: existingIndex, changed };
  }

  node.outputs.push({
    name: 'Loras',
    type: MFLUX_LORAS_PIPELINE_TYPE,
    links: [],
    slot_index: node.outputs.length,
  });
  return { index: node.outputs.length - 1, changed: true };
}

function ensureMfluxStackShape(node: WorkflowNode, title: string): boolean {
  let changed = false;
  if (node.title !== title) {
    node.title = title;
    changed = true;
  }
  if (node.type !== MFLUX_LORAS_LOADER_NODE_TYPE) {
    node.type = MFLUX_LORAS_LOADER_NODE_TYPE;
    changed = true;
  }
  if (!Array.isArray(node.widgets_values)) {
    node.widgets_values = [...DEFAULT_MFLUX_LORA_WIDGETS];
    changed = true;
  } else {
    while (node.widgets_values.length < DEFAULT_MFLUX_LORA_WIDGETS.length) {
      node.widgets_values.push(DEFAULT_MFLUX_LORA_WIDGETS[node.widgets_values.length]);
      changed = true;
    }
  }
  if (!node.properties) {
    node.properties = {};
    changed = true;
  }
  if (!node.flags || node.flags.collapsed === true) {
    node.flags = { ...(node.flags ?? {}), collapsed: false };
    changed = true;
  }
  const inputResult = ensurePipelineInput(node);
  const outputResult = ensurePipelineOutput(node);
  return changed || inputResult.changed || outputResult.changed;
}

function createMfluxStackNode(
  id: number,
  title: string,
  pos: [number, number],
  order: number,
): WorkflowNode {
  return {
    id,
    title,
    type: MFLUX_LORAS_LOADER_NODE_TYPE,
    pos,
    size: MFLUX_STACK_SIZE,
    flags: { collapsed: false },
    order,
    mode: 0,
    inputs: [{
      name: 'Loras',
      type: MFLUX_LORAS_PIPELINE_TYPE,
      link: null,
    }],
    outputs: [{
      name: 'Loras',
      type: MFLUX_LORAS_PIPELINE_TYPE,
      links: [],
      slot_index: 0,
    }],
    properties: {},
    widgets_values: [...DEFAULT_MFLUX_LORA_WIDGETS],
  };
}

function findLink(workflow: Workflow, linkId: number | null | undefined): WorkflowLink | undefined {
  if (linkId == null) return undefined;
  return workflow.links.find((link) => link[0] === linkId);
}

function findNodeById(workflow: Workflow, id: number): WorkflowNode | undefined {
  return workflow.nodes.find((node) => node.id === id);
}

function getInputByNameOrType(
  node: WorkflowNode,
  name: string,
  type: string,
): { input: WorkflowInput; index: number } | null {
  const index = (node.inputs ?? []).findIndex((input) => input.name === name || input.type === type);
  if (index < 0) return null;
  return { input: node.inputs[index], index };
}

function getOutputByNameOrType(
  node: WorkflowNode,
  name: string,
  type: string,
): { output: WorkflowOutput; index: number } | null {
  const index = (node.outputs ?? []).findIndex((output) => output.name === name || output.type === type);
  if (index < 0) return null;
  return { output: node.outputs[index], index };
}

function unlinkOutput(node: WorkflowNode, outputIndex: number, linkId: number): void {
  const output: WorkflowOutput | undefined = node.outputs?.[outputIndex];
  if (!output || !Array.isArray(output.links)) return;
  output.links = output.links.filter((candidate) => candidate !== linkId);
}

function removeLinksTargetingInput(
  workflow: Workflow,
  targetNodeId: number,
  targetInputIndex: number,
): boolean {
  const removed = workflow.links.filter(
    (link) => link[3] === targetNodeId && link[4] === targetInputIndex,
  );
  if (removed.length === 0) return false;

  const removedIds = new Set(removed.map((link) => link[0]));
  workflow.links = workflow.links.filter((link) => !removedIds.has(link[0]));

  for (const link of removed) {
    const originNode = findNodeById(workflow, link[1]);
    if (originNode) unlinkOutput(originNode, link[2], link[0]);
  }
  return true;
}

function setOutputLink(node: WorkflowNode, outputIndex: number, linkId: number): void {
  const output = node.outputs[outputIndex];
  output.links = Array.isArray(output.links) ? output.links : [];
  if (!output.links.includes(linkId)) {
    output.links.push(linkId);
  }
}

function connectPipeline(
  workflow: Workflow,
  fromNode: WorkflowNode,
  toNode: WorkflowNode,
  nextLinkId: () => number,
): boolean {
  const outputResult = ensurePipelineOutput(fromNode);
  const inputResult = ensurePipelineInput(toNode);
  const input = toNode.inputs[inputResult.index];
  const existingLink = findLink(workflow, input.link);
  if (
    existingLink &&
    existingLink[1] === fromNode.id &&
    existingLink[2] === outputResult.index &&
    existingLink[3] === toNode.id &&
    existingLink[4] === inputResult.index &&
    existingLink[5] === MFLUX_LORAS_PIPELINE_TYPE
  ) {
    setOutputLink(fromNode, outputResult.index, existingLink[0]);
    return outputResult.changed || inputResult.changed;
  }

  removeLinksTargetingInput(workflow, toNode.id, inputResult.index);
  const linkId = nextLinkId();
  const link: WorkflowLink = [
    linkId,
    fromNode.id,
    outputResult.index,
    toNode.id,
    inputResult.index,
    MFLUX_LORAS_PIPELINE_TYPE,
  ];
  workflow.links.push(link);
  input.link = linkId;
  setOutputLink(fromNode, outputResult.index, linkId);
  return true;
}

function collectPipelineStackChain(workflow: Workflow, quickNode: WorkflowNode): WorkflowNode[] {
  const quickInputIndex = getInputIndex(quickNode, 'Loras', MFLUX_LORAS_PIPELINE_TYPE);
  if (quickInputIndex < 0) return [];

  const chain: WorkflowNode[] = [];
  let currentInput: WorkflowInput | undefined = quickNode.inputs[quickInputIndex];
  const visited = new Set<number>();

  while (currentInput?.link != null) {
    const link = findLink(workflow, currentInput.link);
    if (!link) break;
    const originNode = findNodeById(workflow, link[1]);
    if (!originNode || originNode.type !== MFLUX_LORAS_LOADER_NODE_TYPE || visited.has(originNode.id)) break;
    chain.push(originNode);
    visited.add(originNode.id);
    const upstreamInputIndex = getInputIndex(originNode, 'Loras', MFLUX_LORAS_PIPELINE_TYPE);
    currentInput = upstreamInputIndex >= 0 ? originNode.inputs[upstreamInputIndex] : undefined;
  }

  return chain;
}

function removePipelineLinksIntoStack(workflow: Workflow, stack: WorkflowNode): boolean {
  const inputIndex = getInputIndex(stack, 'Loras', MFLUX_LORAS_PIPELINE_TYPE);
  if (inputIndex < 0) return false;
  const changed = removeLinksTargetingInput(workflow, stack.id, inputIndex);
  stack.inputs[inputIndex].link = null;
  return changed;
}

function pickExistingSecondStack(workflow: Workflow, firstStack: WorkflowNode): WorkflowNode | undefined {
  return workflow.nodes.find(
    (node) => node.type === MFLUX_LORAS_LOADER_NODE_TYPE && node.id !== firstStack.id,
  );
}

function stackPositionBelow(node: WorkflowNode): [number, number] {
  return [node.pos?.[0] ?? 0, (node.pos?.[1] ?? 0) + Math.max(node.size?.[1] ?? MFLUX_STACK_SIZE[1], 190) + 70];
}

function stackPositionLeftOf(node: WorkflowNode, verticalOffset = 0): [number, number] {
  return [(node.pos?.[0] ?? 0) - 380, (node.pos?.[1] ?? 0) + verticalOffset];
}

function nextWorkflowLinkId(workflow: Workflow): number {
  return maxLinkId(workflow) + 1;
}

function updateTargetInputLink(
  workflow: Workflow,
  targetNodeId: number,
  targetInputIndex: number,
  linkId: number,
): void {
  const targetNode = findNodeById(workflow, targetNodeId);
  const targetInput = targetNode?.inputs?.[targetInputIndex];
  if (targetInput) targetInput.link = linkId;
}

function replaceOutputLinks(node: WorkflowNode, outputIndex: number, links: number[]): void {
  if (!node.outputs?.[outputIndex]) return;
  node.outputs[outputIndex].links = links;
}

function removeOutputLinks(node: WorkflowNode, outputIndex: number, linkIds: Set<number>): void {
  const output = node.outputs?.[outputIndex];
  if (!output || !Array.isArray(output.links)) return;
  output.links = output.links.filter((linkId) => !linkIds.has(linkId));
}

function activeLoraStackFromStandardLoader(node: WorkflowNode): Array<{ on: true; lora: string; strength: number }> {
  if (!Array.isArray(node.widgets_values)) return [];
  const loraName = typeof node.widgets_values[0] === 'string' ? node.widgets_values[0].trim() : '';
  if (!loraName || /^none$/i.test(loraName)) return [];
  const rawStrength = Number(node.widgets_values[1]);
  return [{
    on: true,
    lora: loraName,
    strength: Number.isFinite(rawStrength) ? rawStrength : 1,
  }];
}

/**
 * BigLoveKlein3MLXTest previously persisted a standard LoraLoader in browser
 * IndexedDB. The saved workflow file now uses the native fast-path
 * MultiLoRAStackModelOnly node, so repair stale open tabs in-place during
 * hydration instead of relying on the user to clear workflow-storage.
 */
export function repairBigLoveKlein3MlxComfyLoraStack(
  workflow: Workflow,
  filename?: string | null,
): BigLoveKleinLoraMigrationResult {
  if (!isTargetFilename(filename) && !isBigLoveKlein3MlxWorkflow(workflow)) {
    return { workflow, changed: false };
  }
  if (workflow.nodes?.some((node) => node.type === MULTI_LORA_STACK_MODEL_ONLY_NODE_TYPE)) {
    return { workflow, changed: false };
  }

  const staleLoader = workflow.nodes?.find((node) => node.type === 'LoraLoader');
  if (!staleLoader) {
    return { workflow, changed: false };
  }

  const modelInput = getInputByNameOrType(staleLoader, 'model', 'MODEL');
  const clipInput = getInputByNameOrType(staleLoader, 'clip', 'CLIP');
  const modelOutput = getOutputByNameOrType(staleLoader, 'MODEL', 'MODEL');
  const clipOutput = getOutputByNameOrType(staleLoader, 'CLIP', 'CLIP');
  if (!modelInput || !modelOutput) {
    return { workflow, changed: false };
  }

  const migrated = cloneWorkflow(workflow);
  migrated.nodes = migrated.nodes ?? [];
  migrated.links = migrated.links ?? [];
  migrated.groups = migrated.groups ?? [];
  migrated.config = migrated.config ?? {};

  const migratedLoader = migrated.nodes.find((node) => node.id === staleLoader.id);
  if (!migratedLoader) {
    return { workflow, changed: false };
  }

  const modelLinks = Array.isArray(modelOutput.output.links)
    ? [...modelOutput.output.links]
    : migrated.links
        .filter((link) => link[1] === staleLoader.id && link[2] === modelOutput.index)
        .map((link) => link[0]);
  const stack = activeLoraStackFromStandardLoader(staleLoader);

  if (clipInput?.input.link != null && clipOutput) {
    const originalClipInputLink = migrated.links.find((link) => link[0] === clipInput.input.link);
    const staleClipOutputLinks = migrated.links.filter(
      (link) => link[1] === staleLoader.id && link[2] === clipOutput.index,
    );

    if (originalClipInputLink && staleClipOutputLinks.length > 0) {
      const sourceNode = migrated.nodes.find((node) => node.id === originalClipInputLink[1]);
      const sourceOutput = sourceNode?.outputs?.[originalClipInputLink[2]];
      const removedClipLinkIds = new Set(staleClipOutputLinks.map((link) => link[0]));
      const replacementClipLinkIds: number[] = [];

      staleClipOutputLinks.forEach((staleLink, index) => {
        const linkId = index === 0 ? originalClipInputLink[0] : nextWorkflowLinkId(migrated) + index - 1;
        const replacement: WorkflowLink = [
          linkId,
          originalClipInputLink[1],
          originalClipInputLink[2],
          staleLink[3],
          staleLink[4],
          staleLink[5] || 'CLIP',
        ];
        if (index === 0) {
          const existingIndex = migrated.links.findIndex((link) => link[0] === originalClipInputLink[0]);
          if (existingIndex >= 0) migrated.links[existingIndex] = replacement;
        } else {
          migrated.links.push(replacement);
        }
        updateTargetInputLink(migrated, staleLink[3], staleLink[4], linkId);
        replacementClipLinkIds.push(linkId);
      });

      migrated.links = migrated.links.filter((link) => !removedClipLinkIds.has(link[0]));
      if (sourceOutput) {
        sourceOutput.links = Array.isArray(sourceOutput.links) ? sourceOutput.links : [];
        sourceOutput.links = [
          ...sourceOutput.links.filter((linkId) => !removedClipLinkIds.has(linkId)),
          ...replacementClipLinkIds.filter((linkId) => !sourceOutput.links?.includes(linkId)),
        ];
      }
      migrated.last_link_id = Math.max(migrated.last_link_id ?? 0, maxLinkId(migrated));
    }
  }

  migratedLoader.type = MULTI_LORA_STACK_MODEL_ONLY_NODE_TYPE;
  migratedLoader.title = 'LOAD LORAS HERE - Multi LoRA Stack';
  migratedLoader.size = MULTI_LORA_STACK_SIZE;
  migratedLoader.mode = 0;
  migratedLoader.flags = { ...(migratedLoader.flags ?? {}), collapsed: false };
  migratedLoader.inputs = [{ name: 'model', type: 'MODEL', link: modelInput.input.link ?? null }];
  migratedLoader.outputs = [{
    name: 'MODEL',
    type: 'MODEL',
    links: modelLinks,
    slot_index: 0,
  }];
  migratedLoader.properties = {
    ...(migratedLoader.properties ?? {}),
    'Node name for S&R': MULTI_LORA_STACK_MODEL_ONLY_NODE_TYPE,
  };
  migratedLoader.widgets_values = [JSON.stringify(stack)];

  replaceOutputLinks(migratedLoader, 0, modelLinks);
  if (clipOutput) {
    removeOutputLinks(migratedLoader, clipOutput.index, new Set(clipOutput.output.links ?? []));
  }

  migrated.last_node_id = Math.max(migrated.last_node_id ?? 0, maxNodeId(migrated));
  migrated.last_link_id = Math.max(migrated.last_link_id ?? 0, maxLinkId(migrated));

  return { workflow: migrated, changed: true };
}

/**
 * BigLoveKlein3MLXTest is encrypted at rest, so server-side JSON patches only
 * hit the envelope. Run this after the frontend decrypts the workflow.
 */
export function repairBigLoveKlein3MlxLoraStack(
  workflow: Workflow,
  filename?: string | null,
): BigLoveKleinLoraMigrationResult {
  if (!isTargetFilename(filename)) {
    return { workflow, changed: false };
  }

  const quickNode = workflow.nodes?.find((node) => node.type === QUICK_MFLUX_NODE_TYPE);
  if (!quickNode) {
    return { workflow, changed: false };
  }

  const migrated = cloneWorkflow(workflow);
  migrated.nodes = migrated.nodes ?? [];
  migrated.links = migrated.links ?? [];
  migrated.groups = migrated.groups ?? [];
  migrated.config = migrated.config ?? {};

  const migratedQuickNode = migrated.nodes.find((node) => node.id === quickNode.id);
  if (!migratedQuickNode) {
    return { workflow, changed: false };
  }

  let changed = false;
  let nextNodeIdValue = maxNodeId(migrated);
  let nextLinkIdValue = maxLinkId(migrated);
  const nextNodeId = () => {
    nextNodeIdValue += 1;
    return nextNodeIdValue;
  };
  const nextLinkId = () => {
    nextLinkIdValue += 1;
    return nextLinkIdValue;
  };

  const quickInputResult = ensurePipelineInput(migratedQuickNode);
  changed = changed || quickInputResult.changed;

  const chain = collectPipelineStackChain(migrated, migratedQuickNode);
  if (chain.length >= 2) {
    changed = ensureMfluxStackShape(chain[chain.length - 1], 'MFlux LoRA Stack 1-3') || changed;
    changed = ensureMfluxStackShape(chain[0], 'MFlux LoRA Stack 4-6') || changed;
    if (changed) {
      migrated.last_node_id = Math.max(migrated.last_node_id ?? 0, maxNodeId(migrated));
      migrated.last_link_id = Math.max(migrated.last_link_id ?? 0, maxLinkId(migrated));
    }
    return { workflow: changed ? migrated : workflow, changed };
  }

  let firstStack: WorkflowNode | undefined = chain[0];
  if (!firstStack) {
    firstStack = migrated.nodes.find((node) => node.type === MFLUX_LORAS_LOADER_NODE_TYPE);
    if (!firstStack) {
      firstStack = createMfluxStackNode(
        nextNodeId(),
        'MFlux LoRA Stack 1-3',
        stackPositionLeftOf(migratedQuickNode, -260),
        Math.max(0, ...migrated.nodes.map((node) => node.order ?? 0)) + 1,
      );
      migrated.nodes.push(firstStack);
      changed = true;
    }
  }

  if (!firstStack) {
    return { workflow, changed: false };
  }

  changed = ensureMfluxStackShape(firstStack, 'MFlux LoRA Stack 1-3') || changed;

  let secondStack = pickExistingSecondStack(migrated, firstStack);
  if (!secondStack) {
    secondStack = createMfluxStackNode(
      nextNodeId(),
      'MFlux LoRA Stack 4-6',
      stackPositionBelow(firstStack),
      Math.max(0, ...migrated.nodes.map((node) => node.order ?? 0)) + 1,
    );
    migrated.nodes.push(secondStack);
    changed = true;
  }

  changed = ensureMfluxStackShape(secondStack, 'MFlux LoRA Stack 4-6') || changed;
  changed = removePipelineLinksIntoStack(migrated, secondStack) || changed;
  changed = connectPipeline(migrated, firstStack, secondStack, nextLinkId) || changed;
  changed = connectPipeline(migrated, secondStack, migratedQuickNode, nextLinkId) || changed;

  migrated.last_node_id = Math.max(migrated.last_node_id ?? 0, nextNodeIdValue, maxNodeId(migrated));
  migrated.last_link_id = Math.max(migrated.last_link_id ?? 0, nextLinkIdValue, maxLinkId(migrated));

  return { workflow: changed ? migrated : workflow, changed };
}
