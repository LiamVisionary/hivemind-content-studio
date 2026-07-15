import type { Workflow, WorkflowNode, NodeTypes } from '@/api/types';
import { collectAllWorkflowNodes } from '@/utils/workflowNodes';
import { extractLoraList, findLoraListIndex, isPowerLoraLoaderNodeType } from '@/utils/loraManager';
import {
  extractTriggerWordList,
  extractTriggerWordListLoose,
  extractTriggerWordMessage,
  findTriggerWordListIndex,
  findTriggerWordMessageIndex,
  isTriggerWordToggleNodeType
} from '@/utils/triggerWordToggle';

const DATE_PARTS = {
  d: (date: Date) => date.getDate(),
  M: (date: Date) => date.getMonth() + 1,
  h: (date: Date) => date.getHours(),
  m: (date: Date) => date.getMinutes(),
  s: (date: Date) => date.getSeconds(),
};

export const PROMPT_ASSISTANT_HELPER_MODE_NONE = 'None';
export const PROMPT_ASSISTANT_HELPER_MODE_COUPLE_REGIONS = 'Couple regions';
export const PROMPT_ASSISTANT_HELPER_MODE_BOUNDING_BOXES = 'Bounding boxes';

export function normalizePromptAssistantHelperMode(value: unknown): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');

  if (
    normalized === 'couple_regions' ||
    normalized === 'couple_region' ||
    normalized === 'regional_prompt' ||
    normalized === 'regional' ||
    normalized === 'regions' ||
    normalized === 'region' ||
    normalized === 'couple'
  ) {
    return PROMPT_ASSISTANT_HELPER_MODE_COUPLE_REGIONS;
  }

  if (
    normalized === 'bounding_boxes' ||
    normalized === 'bounding_box' ||
    normalized === 'bbox' ||
    normalized === 'bbox_prompt' ||
    normalized === 'bounding_box_prompt'
  ) {
    return PROMPT_ASSISTANT_HELPER_MODE_BOUNDING_BOXES;
  }

  return PROMPT_ASSISTANT_HELPER_MODE_NONE;
}

export function normalizePromptAssistantProfileJsonOverride(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text || ['undefined', 'null', 'none'].includes(text.toLowerCase())) {
    return '';
  }
  return text.startsWith('{') ? text : '';
}

const DATE_FORMAT_PATTERN =
  Object.keys(DATE_PARTS)
    .map((key) => `${key}${key}?`)
    .join("|") + "|yyy?y?";

const ILLEGAL_FILENAME_CHARS =
  // eslint-disable-next-line no-control-regex
  /[/?<>\\:*|"\x00-\x1F\x7F]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export type ForgeCoupleRegionalDirection = 'Auto' | 'Horizontal' | 'Vertical';

export const FORGE_COUPLE_HORIZONTAL_ADVANCED_MAPPING =
  '[[0.0,1.0,0.0,1.0,0.25],[0.00,0.50,0.0,1.0,1.0],[0.50,1.0,0.0,1.0,1.0]]';
export const FORGE_COUPLE_VERTICAL_ADVANCED_MAPPING =
  '[[0.0,1.0,0.0,1.0,0.25],[0.0,1.0,0.00,0.50,1.0],[0.0,1.0,0.50,1.0,1.0]]';

const FORGE_COUPLE_WIDGET_INDEX = {
  positive_text: 0,
  backend: 3,
  mode: 4,
  direction: 5,
  background: 6,
  background_weight: 7,
  separator: 8,
  advanced_mapping: 9,
  common_parser: 10,
  include_definitions: 11,
} as const;

const PROMPT_ASSISTANT_WIDGET_INDEX = {
  prompt: 8,
  negative_prompt: 9,
  helper_mode: 10,
} as const;

const FORGE_COUPLE_VERTICAL_PATTERN =
  /\b(?:top[- ]?bottom|top[- ]?down|vertical|stacked|upper|lower|top|bottom|above|below|overhead|underneath)\b/gi;
const FORGE_COUPLE_HORIZONTAL_PATTERN =
  /\b(?:left[- ]?right|horizontal|side[- ]by[- ]side|left|right|beside|next\s+to)\b/gi;

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  const matches = text.match(pattern);
  pattern.lastIndex = 0;
  return matches?.length ?? 0;
}

function getNonEmptyPromptLines(prompt: string): string[] {
  return String(prompt || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function inferPromptAssistantForgeCoupleDirection(prompt: string): ForgeCoupleRegionalDirection {
  const lines = getNonEmptyPromptLines(prompt);
  if (lines.length === 0) return 'Auto';

  const firstSubject = lines.length >= 3 ? lines[1] : lines[0] ?? '';
  const secondSubject = lines.length >= 3 ? lines[2] : lines[1] ?? '';
  const globalLine = lines.length >= 3 ? lines[0] : '';
  const fullText = lines.join('\n');
  let horizontalScore = 0;
  let verticalScore = 0;

  if (/\b(?:top|upper|above)\b/i.test(firstSubject) && /\b(?:bottom|lower|below)\b/i.test(secondSubject)) {
    verticalScore += 5;
  }
  if (/\b(?:left)\b/i.test(firstSubject) && /\b(?:right)\b/i.test(secondSubject)) {
    horizontalScore += 5;
  }

  verticalScore += countMatches(globalLine, FORGE_COUPLE_VERTICAL_PATTERN) * 2;
  horizontalScore += countMatches(globalLine, FORGE_COUPLE_HORIZONTAL_PATTERN) * 2;
  verticalScore += countMatches(fullText, FORGE_COUPLE_VERTICAL_PATTERN);
  horizontalScore += countMatches(fullText, FORGE_COUPLE_HORIZONTAL_PATTERN);

  if (verticalScore > horizontalScore) return 'Vertical';
  if (horizontalScore > 0) return 'Horizontal';
  return 'Auto';
}

function buildForgeCoupleAdvancedMapping(
  direction: ForgeCoupleRegionalDirection,
  lineCount: number,
  background: 'None' | 'First Line',
): string {
  if (lineCount === 3 && background === 'First Line') {
    return direction === 'Vertical'
      ? FORGE_COUPLE_VERTICAL_ADVANCED_MAPPING
      : FORGE_COUPLE_HORIZONTAL_ADVANCED_MAPPING;
  }

  const horizontal = direction !== 'Vertical';
  const hasBackground = background === 'First Line';
  const tileCount = Math.max(1, lineCount - (hasBackground ? 1 : 0));
  const rows: number[][] = [];
  if (hasBackground) rows.push([0.0, 1.0, 0.0, 1.0, 0.25]);
  for (let tile = 0; tile < tileCount; tile += 1) {
    const start = tile / tileCount;
    const end = (tile + 1) / tileCount;
    rows.push(horizontal
      ? [start, end, 0.0, 1.0, 1.0]
      : [0.0, 1.0, start, end, 1.0]);
  }
  return JSON.stringify(rows);
}

function isForgeCoupleRegionalPromptNode(node: WorkflowNode): boolean {
  return node.type === 'ForgeCoupleRegionalPrompt';
}

function getLinkedForgeCoupleNode(
  workflow: Workflow,
  assistantNode: WorkflowNode,
): WorkflowNode | null {
  const nodesById = new Map(workflow.nodes.map((workflowNode) => [workflowNode.id, workflowNode]));

  for (const link of workflow.links) {
    const [, sourceNodeId, sourceSlot, targetNodeId, targetSlot] = link;
    if (sourceNodeId !== assistantNode.id) continue;

    const sourceOutput = assistantNode.outputs?.[sourceSlot];
    if (sourceSlot !== 0 && sourceOutput?.name !== 'prompt') continue;

    const targetNode = nodesById.get(targetNodeId);
    if (!targetNode || !isForgeCoupleRegionalPromptNode(targetNode)) continue;

    const targetInputName = targetNode.inputs?.[targetSlot]?.name;
    if (targetInputName === 'positive_text') return targetNode;
  }

  const candidates = workflow.nodes.filter(isForgeCoupleRegionalPromptNode);
  return candidates.length === 1 ? candidates[0] : null;
}

function setForgeCoupleWidgetValue(
  values: unknown[],
  widgetMap: Record<string, number> | null,
  name: keyof typeof FORGE_COUPLE_WIDGET_INDEX,
  value: unknown,
): void {
  const index = widgetMap?.[name] ?? FORGE_COUPLE_WIDGET_INDEX[name];
  values[index] = value;
}

function updateForgeCoupleNodeForAssistantPrompt(
  workflow: Workflow,
  forgeNode: WorkflowNode,
  prompt: string,
): WorkflowNode {
  const direction = inferPromptAssistantForgeCoupleDirection(prompt);
  const lineCount = getNonEmptyPromptLines(prompt).length;
  const background = lineCount >= 3 ? 'First Line' : 'None';
  const advancedMapping = buildForgeCoupleAdvancedMapping(direction, lineCount, background);
  const widgetMap = getNodeWidgetIndexMap(workflow, forgeNode);

  if (!Array.isArray(forgeNode.widgets_values)) {
    const nextValues = {
      ...(isRecord(forgeNode.widgets_values) ? forgeNode.widgets_values : {}),
      positive_text: prompt,
      backend: 'anima_mask',
      mode: 'Basic',
      direction,
      background,
      background_weight: 0.25,
      separator: '\\n',
      advanced_mapping: advancedMapping,
      common_parser: 'Off',
      include_definitions: true,
    };
    return { ...forgeNode, widgets_values: nextValues };
  }

  const nextValues = [...forgeNode.widgets_values];
  setForgeCoupleWidgetValue(nextValues, widgetMap, 'positive_text', prompt);
  setForgeCoupleWidgetValue(nextValues, widgetMap, 'backend', 'anima_mask');
  setForgeCoupleWidgetValue(nextValues, widgetMap, 'mode', 'Basic');
  setForgeCoupleWidgetValue(nextValues, widgetMap, 'direction', direction);
  setForgeCoupleWidgetValue(nextValues, widgetMap, 'background', background);
  setForgeCoupleWidgetValue(nextValues, widgetMap, 'background_weight', 0.25);
  setForgeCoupleWidgetValue(nextValues, widgetMap, 'separator', '\\n');
  setForgeCoupleWidgetValue(nextValues, widgetMap, 'advanced_mapping', advancedMapping);
  setForgeCoupleWidgetValue(nextValues, widgetMap, 'common_parser', 'Off');
  setForgeCoupleWidgetValue(nextValues, widgetMap, 'include_definitions', true);

  return { ...forgeNode, widgets_values: nextValues };
}

export interface PromptAssistantForgeCoupleAutomationResult {
  workflow: Workflow;
  forgeNodeId: number;
  direction: ForgeCoupleRegionalDirection;
}

export function applyPromptAssistantForgeCoupleAutomation(
  workflow: Workflow | null,
  assistantNode: WorkflowNode,
  prompt: string,
  helperMode: unknown,
): PromptAssistantForgeCoupleAutomationResult | null {
  if (!workflow) return null;
  if (normalizePromptAssistantHelperMode(helperMode) !== PROMPT_ASSISTANT_HELPER_MODE_COUPLE_REGIONS) {
    return null;
  }

  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) return null;
  if (getNonEmptyPromptLines(cleanPrompt).length < 2) return null;

  const forgeNode = getLinkedForgeCoupleNode(workflow, assistantNode);
  if (!forgeNode) return null;

  const updatedForgeNode = updateForgeCoupleNodeForAssistantPrompt(workflow, forgeNode, cleanPrompt);
  const nextNodes = workflow.nodes.map((workflowNode) =>
    workflowNode.id === forgeNode.id ? updatedForgeNode : workflowNode,
  );

  return {
    workflow: { ...workflow, nodes: nextNodes },
    forgeNodeId: forgeNode.id,
    direction: inferPromptAssistantForgeCoupleDirection(cleanPrompt),
  };
}

function getWidgetValueByName(
  workflow: Workflow,
  node: WorkflowNode,
  name: string,
  fallbackIndex?: number,
): unknown {
  const values = node.widgets_values;
  if (Array.isArray(values)) {
    const widgetMap = getNodeWidgetIndexMap(workflow, node);
    const index = widgetMap?.[name] ?? fallbackIndex;
    return index === undefined ? undefined : values[index];
  }
  if (isRecord(values)) {
    return values[name] ?? (fallbackIndex === undefined ? undefined : values[String(fallbackIndex)]);
  }
  return undefined;
}

function readPromptAssistantQueuePrompt(
  workflow: Workflow,
  assistantNode: WorkflowNode,
): { prompt: string; helperMode: string } {
  let prompt = normalizePromptAssistantTextInput(
    getWidgetValueByName(workflow, assistantNode, 'prompt', PROMPT_ASSISTANT_WIDGET_INDEX.prompt),
  );
  let negativePrompt = normalizePromptAssistantTextInput(
    getWidgetValueByName(workflow, assistantNode, 'negative_prompt', PROMPT_ASSISTANT_WIDGET_INDEX.negative_prompt),
  );
  if (shouldPromotePromptAssistantNegativeToPrompt(prompt, negativePrompt)) {
    prompt = negativePrompt;
    negativePrompt = '';
  }

  const helperMode = normalizePromptAssistantHelperMode(
    getWidgetValueByName(workflow, assistantNode, 'helper_mode', PROMPT_ASSISTANT_WIDGET_INDEX.helper_mode),
  );
  return { prompt, helperMode };
}

export function applyPromptAssistantForgeCoupleQueueAutomation(
  workflow: Workflow,
): PromptAssistantForgeCoupleAutomationResult & { changed: boolean } {
  let nextWorkflow = workflow;
  let lastForgeNodeId = -1;
  let lastDirection: ForgeCoupleRegionalDirection = 'Auto';
  let changed = false;

  for (const originalNode of workflow.nodes) {
    if (!isPromptAssistantGenerateNodeType(originalNode.type, originalNode.type)) continue;
    const assistantNode = nextWorkflow.nodes.find((node) => node.id === originalNode.id) ?? originalNode;
    const { prompt, helperMode } = readPromptAssistantQueuePrompt(nextWorkflow, assistantNode);
    const automation = applyPromptAssistantForgeCoupleAutomation(
      nextWorkflow,
      assistantNode,
      prompt,
      helperMode,
    );
    if (!automation) continue;

    nextWorkflow = automation.workflow;
    lastForgeNodeId = automation.forgeNodeId;
    lastDirection = automation.direction;
    changed = true;
  }

  return {
    workflow: nextWorkflow,
    forgeNodeId: lastForgeNodeId,
    direction: lastDirection,
    changed,
  };
}

export const DYNAMIC_COMBO_TYPE = 'COMFY_DYNAMICCOMBO_V3';
export const DYNAMIC_COMBO_WIDGET_NAME_OPTION = '__dynamicComboWidgetName';

function dynamicComboOptionKey(option: unknown): string | null {
  if (isRecord(option)) {
    const key = option.key;
    if (typeof key === 'string' || typeof key === 'number') return String(key);
    return null;
  }
  if (typeof option === 'string' || typeof option === 'number') {
    return String(option);
  }
  return null;
}

export function getDynamicComboOptionKeys(
  inputOptions?: Record<string, unknown> | null,
): string[] {
  const rawOptions = inputOptions?.options;
  if (!Array.isArray(rawOptions)) return [];
  return rawOptions
    .map(dynamicComboOptionKey)
    .filter((key): key is string => Boolean(key));
}

export function isDynamicComboInput(
  typeOrOptions: string | unknown[],
  inputOptions?: Record<string, unknown> | null,
): boolean {
  if (Array.isArray(typeOrOptions)) return false;
  return String(typeOrOptions).toUpperCase() === DYNAMIC_COMBO_TYPE &&
    getDynamicComboOptionKeys(inputOptions).length > 0;
}

export function getComboComparableValue(
  value: unknown,
  widgetName?: string,
): unknown {
  if (!isRecord(value)) return value;

  if (widgetName) {
    const named = value[widgetName];
    if (typeof named === 'string' || typeof named === 'number') return named;
  }

  const stringValues = Object.values(value).filter(
    (entry): entry is string => typeof entry === 'string',
  );
  return stringValues.length === 1 ? stringValues[0] : value;
}

export function serializeDynamicComboWidgetValue(
  widgetName: string,
  selectedValue: unknown,
  currentValue?: unknown,
): unknown {
  const comparable = getComboComparableValue(selectedValue, widgetName);
  if (comparable === undefined || comparable === null) return selectedValue;
  return {
    ...(isRecord(currentValue) ? currentValue : {}),
    [widgetName]: String(comparable),
  };
}

export function normalizeDynamicComboInputValue(
  value: unknown,
  widgetName: string,
): unknown {
  return serializeDynamicComboWidgetValue(widgetName, value, value);
}

function formatDateToken(text: string, date: Date): string {
  return text.replace(new RegExp(DATE_FORMAT_PATTERN, "g"), (token: string): string => {
    if (token === "yy") return `${date.getFullYear()}`.substring(2);
    if (token === "yyyy") return date.getFullYear().toString();
    if (token[0] in DATE_PARTS) {
      const part = DATE_PARTS[token[0] as keyof typeof DATE_PARTS](date);
      return `${part}`.padStart(token.length, "0");
    }
    return token;
  });
}

function resolveReplacementWidgetValue(
  workflow: Workflow,
  node: WorkflowNode,
  widgetName: string,
): unknown {
  const widgetIndexMap = getWorkflowWidgetIndexMap(workflow, node.id);
  const mappedIndex = widgetIndexMap?.[widgetName];
  if (mappedIndex !== undefined) {
    return getWidgetValue(node, widgetName, mappedIndex);
  }

  return getWidgetValue(node, widgetName, undefined);
}

function applyTextReplacements(workflow: Workflow, value: string): string {
  const allNodes = collectAllWorkflowNodes(workflow);

  return value.replace(/%([^%]+)%/g, (match, text: string) => {
    const split = text.split(".");
    if (split.length !== 2) {
      if (split[0]?.startsWith("date:")) {
        return formatDateToken(split[0].substring(5), new Date());
      }

      if (text !== "width" && text !== "height") {
        console.warn("[workflowInputs] Invalid replacement pattern", text);
      }
      return match;
    }

    let nodes = allNodes.filter(
      (nodeItem) => nodeItem.properties?.["Node name for S&R"] === split[0]
    );
    if (!nodes.length) {
      nodes = allNodes.filter(
        (nodeItem) => (nodeItem as { title?: unknown }).title === split[0]
      );
    }
    if (!nodes.length) {
      console.warn("[workflowInputs] Unable to find node", split[0]);
      return match;
    }
    if (nodes.length > 1) {
      console.warn("[workflowInputs] Multiple nodes matched", split[0], "using first match");
    }

    const node = nodes[0];
    const widgetValue = resolveReplacementWidgetValue(workflow, node, split[1]);
    if (widgetValue === undefined) {
      console.warn(
        "[workflowInputs] Unable to find widget",
        split[1],
        "on node",
        split[0],
        node
      );
      return match;
    }

    return `${widgetValue ?? ""}`.replace(ILLEGAL_FILENAME_CHARS, "_");
  });
}

function finalizeInputValue(
  workflow: Workflow,
  inputName: string,
  value: unknown,
): unknown {
  if (inputName === "filename_prefix" && typeof value === "string") {
    return applyTextReplacements(workflow, value);
  }
  return value;
}

function getPrimitiveInlineValue(node: WorkflowNode): unknown {
  const type = String(node.type || '');
  if (!type.startsWith('Primitive') && node.type !== 'PrimitiveNode') {
    return undefined;
  }

  if (Array.isArray(node.widgets_values)) {
    return node.widgets_values[0];
  }

  if (isRecord(node.widgets_values)) {
    const value = node.widgets_values.value;
    return value !== undefined ? value : node.widgets_values[0];
  }

  return undefined;
}

export function getWidgetValue(
  node: WorkflowNode,
  name: string,
  index: number | undefined
): unknown {
  const values = node.widgets_values;
  if (Array.isArray(values)) {
    if (index === undefined || index < 0 || index >= values.length) return undefined;
    return values[index];
  }
  if (isRecord(values)) {
    if (values[name] !== undefined) return values[name];
    if (node.type === 'VHS_VideoCombine' && name === 'save_image' && values.save_output !== undefined) {
      return values.save_output;
    }
  }
  return undefined;
}

export function getWorkflowWidgetIndexMap(
  workflow: Workflow,
  nodeId: number
): Record<string, number> | null {
  const entry = workflow.widget_idx_map?.[String(nodeId)];
  if (entry) {
    return entry;
  }
  const extraMap = workflow.extra?.widget_idx_map as Record<string, Record<string, number>> | undefined;
  return extraMap?.[String(nodeId)] ?? null;
}

/**
 * Decide whether to skip past ComfyUI's auto-added control_after_generate slot
 * that conventionally follows an INT seed widget.
 *
 * Most ComfyUI nodes have this widget; some custom nodes (Efficient KSampler
 * family) strip it in their own JS. The resulting saved workflows can be in
 * any of three shapes at the control slot:
 *   - present, string value (stock ComfyUI: 'fixed' / 'randomize' / etc.)
 *   - present, null value (Efficient Nodes leaves the slot but blanks it)
 *   - absent entirely (slot index >= widgets_values.length)
 *
 * Returns true (bump past the slot) when the value at controlSlotIndex is a
 * string, null, or out of bounds. Returns false when the slot holds a real
 * widget value (number / boolean / non-null object) — that means
 * control_after_generate wasn't there to begin with and the slot belongs to
 * the next declared widget.
 */
export function skipImplicitSeedControlSlot(
  node: WorkflowNode,
  controlSlotIndex: number,
): boolean {
  if (!Array.isArray(node.widgets_values)) return false;
  if (controlSlotIndex >= node.widgets_values.length) return false;
  const value = node.widgets_values[controlSlotIndex];
  if (value === null) return true;
  if (typeof value === 'string') return true;
  return false;
}

export function getNodePropertyWidgetIndexMap(
  node: WorkflowNode
): Record<string, number> | null {
  const widgetIds = node.properties?.__lm_widget_ids;
  if (!Array.isArray(widgetIds)) return null;

  const result: Record<string, number> = {};
  widgetIds.forEach((value, index) => {
    if (typeof value !== 'string' || !value) return;
    if (value.startsWith('__lm_')) return;
    result[value] = index;
  });

  return Object.keys(result).length > 0 ? result : null;
}

export function getNodeWidgetIndexMap(
  workflow: Workflow,
  node: WorkflowNode
): Record<string, number> | null {
  return getWorkflowWidgetIndexMap(workflow, node.id) ?? getNodePropertyWidgetIndexMap(node);
}

export function isWidgetInputType(typeOrOptions: string | unknown[]): boolean {
  if (Array.isArray(typeOrOptions)) {
    const signature = typeOrOptions.map((entry) => String(entry)).join(',').toUpperCase();
    if (signature.includes('AUTOCOMPLETE_TEXT_PROMPT') || signature.includes('AUTOCOMPLETE_TEXT_LORAS')) {
      return true;
    }
    return true;
  }
  const normalized = String(typeOrOptions).toUpperCase();
  return normalized === 'INT' ||
    normalized === 'FLOAT' ||
    normalized === 'BOOLEAN' ||
    normalized === 'STRING' ||
    normalized === DYNAMIC_COMBO_TYPE ||
    normalized.includes('AUTOCOMPLETE_TEXT_LORAS') ||
    normalized.includes('AUTOCOMPLETE_TEXT_PROMPT');
}

export function normalizeWidgetValue(
  value: unknown,
  typeOrOptions: string | unknown[],
  options?: { comboIndexToValue?: boolean }
): unknown {
  if (Array.isArray(typeOrOptions)) {
    if (options?.comboIndexToValue && typeof value === 'number' && Number.isFinite(value)) {
      const idx = Math.trunc(value);
      return typeOrOptions[idx] ?? value;
    }
    return value;
  }

  if (typeOrOptions === 'INT') {
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
      return Math.trunc(Number(value));
    }
  }

  if (typeOrOptions === 'FLOAT') {
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
      return Number(value);
    }
  }

  if (typeOrOptions === 'BOOLEAN' && typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }

  return value;
}

export function normalizeComboValue(
  value: unknown,
  options: unknown[]
): unknown {
  if (options.length === 0) return value;
  const resolved = resolveComboOption(value, options);
  if (resolved !== undefined) {
    return resolved;
  }
  // No exact/basename/extensionless match. How we recover depends on whether the
  // combo is a file picker or a closed enum:
  //
  // - File pickers (loras, checkpoints, images, …) have an inherently incomplete
  //   option list — uploads and newly-added files never appear in object_info —
  //   so an unmatched value may still be valid. Keep it as-is and let the server
  //   decide, rather than swapping in a different (wrong) file.
  //
  // - Closed enums (action widgets like "Select to add Wildcard", sampler /
  //   scheduler names, …) enumerate EVERY valid value, so an unmatched value is
  //   stale — e.g. a dynamic combo whose placeholder option was captured into
  //   widgets_values at save time. ComfyUI does not error on an out-of-range
  //   combo value; it silently EXCLUDES that node (and its whole downstream
  //   branch) from the run, completing with "success" and no output. To keep the
  //   prompt executable we fall back to the first option (ComfyUI's default).
  //
  // Only substitute when NEITHER the option list nor the stale value looks
  // file-like. A picker whose options happen to lack a recognizable extension
  // (e.g. a custom node listing bare names) would otherwise be misread as an
  // enum and a genuine file selection clobbered; keeping a file-like value as-is
  // lets the server resolve or clearly reject it instead.
  if (!optionsAreFileLike(options) && !isFileLikeToken(value)) {
    return options[0];
  }
  return value;
}

// A token is "file-like" when it carries a path separator or a known
// model/media/config file extension. Combo lists with such options are
// inherently incomplete (uploads aren't enumerated), so unmatched values are
// kept as-is. Everything else is a closed enum that lists all valid values.
const FILE_LIKE_OPTION =
  /[\\/]|\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx|vae|yaml|yml|json|txt|csv|png|jpe?g|webp|gif|bmp|tiff?|mp4|webm|mov|mkv|wav|mp3|flac|ogg|npy|npz|pkl|engine|trt)$/i;

function isFileLikeToken(token: unknown): boolean {
  return FILE_LIKE_OPTION.test(String(token));
}

export function optionsAreFileLike(options: unknown[]): boolean {
  return options.some(isFileLikeToken);
}

const SAFETENSORS_SUFFIX = '.safetensors';

function stripSafetensorsSuffix(value: string): string {
  const lower = value.toLowerCase();
  if (lower.endsWith(SAFETENSORS_SUFFIX)) {
    return value.slice(0, value.length - SAFETENSORS_SUFFIX.length);
  }
  return value;
}

function getComboBase(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

export function resolveComboOption(
  value: unknown,
  options: unknown[],
  widgetName?: string,
): unknown | undefined {
  if (!Array.isArray(options) || options.length === 0) return undefined;
  const comparable = getComboComparableValue(value, widgetName);
  const normalized = normalizeWidgetValue(comparable, options, { comboIndexToValue: true });
  const normalizedString = String(normalized);
  const normalizedBase = getComboBase(normalizedString);

  const directMatch = options.find((opt) => String(opt) === normalizedString);
  if (directMatch !== undefined) {
    return directMatch;
  }

  const baseMatch = options.find((opt) => String(opt) === normalizedBase);
  if (baseMatch !== undefined) {
    return baseMatch;
  }

  const normalizedNoExt = stripSafetensorsSuffix(normalizedBase);
  const normalizedNoExtLower = normalizedNoExt.toLowerCase();
  const extensionlessMatch = options.find((opt) => {
    const optString = String(opt);
    const optBase = getComboBase(optString);
    const optNoExt = stripSafetensorsSuffix(optBase);
    return optNoExt.toLowerCase() === normalizedNoExtLower;
  });

  return extensionlessMatch;
}

export function isValueCompatible(value: unknown, typeOrOptions: string | unknown[]): boolean {
  if (Array.isArray(typeOrOptions)) {
    const asString = String(getComboComparableValue(value));
    return typeOrOptions.some((opt) => String(opt) === asString);
  }

  if (typeOrOptions === 'INT' || typeOrOptions === 'FLOAT') {
    if (typeof value === 'number' && Number.isFinite(value)) return true;
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return true;
    return false;
  }

  if (typeOrOptions === 'BOOLEAN') {
    return typeof value === 'boolean' ||
      (typeof value === 'string' && ['true', 'false'].includes(value.toLowerCase()));
  }

  if (typeOrOptions === 'STRING') {
    return typeof value === 'string';
  }

  return true;
}

export function resolveSource(
  workflow: Workflow,
  linkId: number,
  visitedLinkIds: Set<number> = new Set(),
  promptKeyMap?: Map<number, string>
): { nodeId: number; slotIndex: number } | null {
  if (visitedLinkIds.has(linkId)) return null;
  visitedLinkIds.add(linkId);

  const link = workflow.links.find((l) => l[0] === linkId);
  if (!link) return null;

  const sourceNodeId = link[1];
  const sourceSlotIndex = link[2];
  const sourceNode = workflow.nodes.find((n) => n.id === sourceNodeId);

  if (!sourceNode) return null;

  if (sourceNode.type === 'GetNode') {
    const getterName = getKJSetGetNodeName(sourceNode);
    if (!getterName) return null;

    const setterNode = findKJSetterNode(workflow, sourceNode, getterName, promptKeyMap);
    const setterInputLink = setterNode?.inputs?.[0]?.link;
    if (setterInputLink == null) return null;

    return resolveSource(workflow, setterInputLink, visitedLinkIds, promptKeyMap);
  }

  if (sourceNode.type === 'SetNode') {
    const setterInputLink = sourceNode.inputs?.[0]?.link;
    if (setterInputLink == null) return null;

    return resolveSource(workflow, setterInputLink, visitedLinkIds, promptKeyMap);
  }

  if (sourceNode.mode === 4 || sourceNode.type === 'Reroute') {
    const outputDef = sourceNode.outputs[sourceSlotIndex];
    if (!outputDef) return null;

    const matchingInput = sourceNode.inputs.find((input) => {
      if (input.link === null) return false;
      const inType = String(input.type).toUpperCase();
      const outType = String(outputDef.type).toUpperCase();
      return inType === outType || inType === '*' || outType === '*';
    });

    if (matchingInput?.link != null) {
      return resolveSource(workflow, matchingInput.link, visitedLinkIds, promptKeyMap);
    }
    return null;
  }

  return { nodeId: sourceNodeId, slotIndex: sourceSlotIndex };
}

function getKJSetGetNodeName(node: WorkflowNode): string | null {
  const values = node.widgets_values;
  if (Array.isArray(values)) {
    const value = values[0];
    return typeof value === 'string' && value ? value : null;
  }
  if (isRecord(values)) {
    const value = values[0] ?? values.value ?? values.name;
    return typeof value === 'string' && value ? value : null;
  }
  return null;
}

function getPromptScope(promptKey: string | undefined): string | null {
  if (!promptKey) return null;
  const scopeEnd = promptKey.lastIndexOf(':');
  return scopeEnd === -1 ? '' : promptKey.slice(0, scopeEnd);
}

function findKJSetterNode(
  workflow: Workflow,
  getterNode: WorkflowNode,
  getterName: string,
  promptKeyMap?: Map<number, string>
): WorkflowNode | undefined {
  const candidates = workflow.nodes.filter(
    (node) => node.type === 'SetNode' && getKJSetGetNodeName(node) === getterName
  );

  const getterScope = getPromptScope(promptKeyMap?.get(getterNode.id));
  if (getterScope === null) return candidates[0];

  return candidates.find(
    (node) => getPromptScope(promptKeyMap?.get(node.id)) === getterScope
  );
}

function isPromptAssistantGenerateNodeType(classType: string, nodeType: string): boolean {
  return classType === 'PromptAssistantGenerate' || nodeType === 'PromptAssistantGenerate';
}

function normalizePromptAssistantTextInput(value: unknown): string {
  return value == null ? '' : String(value);
}

function looksLikeStructuredPositivePrompt(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  return (
    (text.startsWith('{') &&
      (text.includes('"high_level_description"') ||
        text.includes('"compositional_deconstruction"'))) ||
    (/"bbox"\s*:/.test(text) && /"desc"\s*:/.test(text))
  );
}

function promptAssistantPositivePromptScore(value: unknown): number {
  const text = normalizePromptAssistantTextInput(value).trim();
  if (!text) return 0;
  if (looksLikeStructuredPositivePrompt(text)) return 10;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return 0;

  let score = 1;
  const subjectLineCount = lines.filter((line) =>
    /\b(?:[1-9]\d*\s*(?:girls?|boys?)|[1-9]\d*girls?|[1-9]\d*boys?|1girl|1boy|women|woman|men|man|female focus|male focus)\b/i.test(line)
  ).length;
  if (subjectLineCount >= 2) score += 2;
  if (/\b(?:left[- ]right|top[- ]bottom|composition|shared scene|background|foreground|region|regional)\b/i.test(text)) {
    score += 3;
  }
  if (/\b(?:bbox|high_level_description|compositional_deconstruction)\b/i.test(text)) {
    score += 4;
  }
  return score;
}

function shouldPromotePromptAssistantNegativeToPrompt(
  prompt: unknown,
  negativePrompt: unknown,
): boolean {
  const negativeScore = promptAssistantPositivePromptScore(negativePrompt);
  if (negativeScore <= 0) return false;
  const promptScore = promptAssistantPositivePromptScore(prompt);
  if (normalizePromptAssistantTextInput(prompt).trim() === '') return true;
  return negativeScore >= 4 && negativeScore > promptScore;
}

function parseLeadingJsonObject(value: string): Record<string, unknown> | null {
  const text = value.trim();
  if (!text.startsWith('{')) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(0, index + 1));
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function structuredPositivePromptToText(value: unknown): string | null {
  const text = typeof value === 'string' ? value : '';
  const parsed = parseLeadingJsonObject(text);
  if (!parsed) return null;
  const composition = parsed.compositional_deconstruction;
  if (!composition || typeof composition !== 'object' || Array.isArray(composition)) return null;
  const compositionRecord = composition as Record<string, unknown>;
  const elements = Array.isArray(compositionRecord.elements) ? compositionRecord.elements : [];
  const parts: string[] = [];
  if (typeof parsed.high_level_description === 'string' && parsed.high_level_description.trim()) {
    parts.push(parsed.high_level_description.trim());
  }
  if (typeof compositionRecord.background === 'string' && compositionRecord.background.trim()) {
    parts.push(compositionRecord.background.trim());
  }
  for (const element of elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) continue;
    const desc = (element as Record<string, unknown>).desc;
    if (typeof desc === 'string' && desc.trim()) parts.push(desc.trim());
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

function applyPromptAssistantQueueDefaults(
  _workflow: Workflow,
  classType: string,
  node: WorkflowNode,
  inputs: Record<string, unknown>,
): void {
  if (!isPromptAssistantGenerateNodeType(classType, node.type)) return;

  inputs.idea = normalizePromptAssistantTextInput(inputs.idea);
  inputs.context = '';
  inputs.image_caption = '';
  inputs.extra_instructions = '';
  inputs.prompt = normalizePromptAssistantTextInput(inputs.prompt);
  inputs.negative_prompt = normalizePromptAssistantTextInput(inputs.negative_prompt);
  inputs.profile_json_override = normalizePromptAssistantProfileJsonOverride(inputs.profile_json_override);
  if (shouldPromotePromptAssistantNegativeToPrompt(inputs.prompt, inputs.negative_prompt)) {
    inputs.prompt = inputs.negative_prompt;
    inputs.negative_prompt = '';
  }
  if (inputs.helper_mode == null || String(inputs.helper_mode).trim() === '') {
    inputs.helper_mode = PROMPT_ASSISTANT_HELPER_MODE_NONE;
  }
  inputs.helper_mode = normalizePromptAssistantHelperMode(inputs.helper_mode);
  inputs.emit_ui_text = true;
  inputs.auto_generate_on_queue = false;
}

export function buildWorkflowPromptInputs(
  workflow: Workflow,
  nodeTypes: NodeTypes,
  node: WorkflowNode,
  classType: string,
  allowedNodeIds: Set<number>,
  widgetIndexMap: Record<string, number> | null,
  seedOverrides?: Record<number, number>,
  promptKeyMap?: Map<number, string>
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};

  for (const input of node.inputs) {
    if (input.link != null) {
      const resolved = resolveSource(workflow, input.link, new Set(), promptKeyMap);
      if (resolved) {
        if (allowedNodeIds.has(resolved.nodeId)) {
          const nodeKey = promptKeyMap?.get(resolved.nodeId) ?? String(resolved.nodeId);
          inputs[input.name] = [nodeKey, resolved.slotIndex];
        } else {
          const sourceNode = workflow.nodes.find((n) => n.id === resolved.nodeId);
          if (sourceNode) {
            const value = getPrimitiveInlineValue(sourceNode);
            if (value !== undefined) {
              inputs[input.name] = value;
            } else {
              console.warn(
                `[workflowInputs] Missing source node for input '${input.name}' on node ${node.id} (${node.type}).`,
                {
                  sourceNodeId: resolved.nodeId,
                  sourceNodeType: sourceNode.type,
                  sourceAllowed: false
                }
              );
            }
          }
        }
      }
    }
  }

  const typeDef = nodeTypes[classType];
  if (!typeDef?.input) {
    return inputs;
  }

  const requiredOrder = typeDef.input_order?.required || Object.keys(typeDef.input.required || {});
  const optionalOrder = typeDef.input_order?.optional || Object.keys(typeDef.input.optional || {});
  const orderedInputs = [...requiredOrder, ...optionalOrder];
  let widgetCursor = 0;
  const widgetValuesArray = Array.isArray(node.widgets_values) ? node.widgets_values : null;

  for (const name of orderedInputs) {
    try {
      const inputDef = typeDef.input.required?.[name] || typeDef.input.optional?.[name];
      if (!inputDef) continue;

      const [typeOrOptions, inputOptions] = inputDef;
      const inputEntry = node.inputs.find((i) => i.name === name);
      const isConnected = inputEntry?.link != null;
      const isWidgetToggle = Boolean(inputEntry?.widget) && !isConnected;
      const isForceInputSocketOnly = inputOptions?.forceInput === true && !inputEntry?.widget;
      const hasSocket = Boolean(inputEntry);
      const defaultValue = inputDef[1]?.default;
      const hasDefault = Object.prototype.hasOwnProperty.call(inputDef[1] ?? {}, 'default');
      const isWidgetType = !isForceInputSocketOnly && (
        isWidgetInputType(typeOrOptions) || isWidgetToggle || !hasSocket
      );
      const isWidget = isWidgetType;

      if (isWidget) {
        let indexToUse = widgetIndexMap?.[name];

        if (indexToUse === undefined) {
          indexToUse = widgetCursor;
        }

        // Apply the seed override for either of the two conventional seed input
        // names — stock KSampler uses 'seed', but several custom nodes (e.g.
        // KSampler Adv (Efficient), KSampler SDXL (Eff.)) use 'noise_seed' and
        // declare it as INT with min=0, so sending -1 (the special-mode value
        // stored in the widget) would be rejected by the server.
        if ((name === 'seed' || name === 'noise_seed')
            && seedOverrides?.[node.id] !== undefined
            && !(name in inputs)) {
          inputs[name] = seedOverrides[node.id];
        } else if (indexToUse !== undefined && !isConnected && !(name in inputs)) {
          const rawValue = getWidgetValue(node, name, indexToUse);
          if (rawValue !== undefined) {
            if (isPromptAssistantGenerateNodeType(classType, node.type) && name === 'helper_mode') {
              inputs[name] = normalizePromptAssistantHelperMode(rawValue);
            } else if (isDynamicComboInput(typeOrOptions, inputOptions)) {
              inputs[name] = finalizeInputValue(
                workflow,
                name,
                normalizeDynamicComboInputValue(rawValue, name)
              );
            } else if (Array.isArray(typeOrOptions)) {
              inputs[name] = finalizeInputValue(
                workflow,
                name,
                normalizeComboValue(rawValue, typeOrOptions)
              );
            } else {
              inputs[name] = finalizeInputValue(
                workflow,
                name,
                normalizeWidgetValue(rawValue, typeOrOptions)
              );
            }
          }
        } else if (!isConnected && hasDefault && !(name in inputs)) {
          inputs[name] = defaultValue;
        }

        if (indexToUse !== undefined) {
          widgetCursor = Math.max(widgetCursor, indexToUse + 1);
        }

        if (
          String(typeOrOptions) === 'INT' &&
          (name === 'seed' || name === 'noise_seed') &&
          !isPromptAssistantGenerateNodeType(classType, node.type)
        ) {
          const seedSlot = indexToUse ?? (widgetCursor - 1);
          if (skipImplicitSeedControlSlot(node, seedSlot + 1)) {
            if (indexToUse !== undefined) {
              widgetCursor = Math.max(widgetCursor, indexToUse + 2);
            } else {
              widgetCursor = Math.max(widgetCursor, widgetCursor + 1);
            }
          }
        }
      }
    } catch (e) {
      console.error(`Error processing input '${name}' for node ${node.id} (${node.type}):`, e);
    }
  }

  // Include any widgets defined in widgetIndexMap that weren't captured by the type definition
  // This is important for nodes with dynamic widgets (like rgthree's) or when the object_info
  // is slightly out of sync with the workflow.
  if (widgetIndexMap) {
    for (const [name, index] of Object.entries(widgetIndexMap)) {
      if (!(name in inputs) && widgetValuesArray && index < widgetValuesArray.length) {
        const value = widgetValuesArray[index];
        if (value !== undefined && value !== null) {
          inputs[name] = finalizeInputValue(workflow, name, value);
        }
      }
      if (!(name in inputs) && !widgetValuesArray) {
        const value = getWidgetValue(node, name, index);
        if (value !== undefined && value !== null) {
          inputs[name] = finalizeInputValue(workflow, name, value);
        }
      }
    }
  }

  // Special handling for Power Lora Loader (rgthree) which has dynamic widgets not in object_info.
  // We ensure all widgets that look like Lora objects are included in the prompt inputs.
  if (isPowerLoraLoaderNodeType(classType) || isPowerLoraLoaderNodeType(node.type)) {
    if (widgetValuesArray) {
      widgetValuesArray.forEach((val, idx) => {
        if (typeof val === 'object' && val !== null && 'lora' in val) {
          // Check if this index was already added under any name
          const alreadyAdded = Object.values(widgetIndexMap || {}).some(index => index === idx) || 
                               (widgetIndexMap === null && idx < widgetCursor);
          
          if (!alreadyAdded) {
            const name = `lora_${idx}`;
            if (!(name in inputs)) {
              // For rgthree nodes, if strengthTwo is missing but expected, we might want to provide it,
              // but the node's serializeValue handles it by deleting it if not in separate mode.
              // Our widget value already contains what it needs.
              inputs[name] = val;
            }
          }
        }
      });
    }
  }

  if (seedOverrides?.[node.id] !== undefined && !('seed' in inputs) && !('noise_seed' in inputs)) {
    inputs.seed = seedOverrides[node.id];
  }

  appendLoraManagerInputs(node, inputs, widgetValuesArray, widgetIndexMap);
  appendTriggerWordToggleInputs(node, inputs, widgetValuesArray, widgetIndexMap);
  applyPromptAssistantQueueDefaults(workflow, classType, node, inputs);

  return inputs;
}

function resolveClassType(nodeTypes: NodeTypes, node: WorkflowNode): string | null {
  if (nodeTypes[node.type]) return node.type;
  const match = Object.entries(nodeTypes).find(
    ([, def]) => def.display_name === node.type || def.name === node.type,
  );
  return match?.[0] ?? null;
}

function promptKeyForNode(node: WorkflowNode, promptKeyMap?: Map<number, string>): string {
  return promptKeyMap?.get(node.id) ?? String(node.id);
}

function fallbackPromptKeyForSource(node: WorkflowNode, promptKeyMap?: Map<number, string>): string {
  return `__mobile_fallback_positive_${promptKeyForNode(node, promptKeyMap).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function isLinkedInput(value: unknown): value is [string, number] {
  return Array.isArray(value) && value.length >= 2 && typeof value[1] === 'number';
}

/**
 * Repair the common Anima "Couple Regions bypassed" shape.
 *
 * A bypassed node normally behaves like a reroute, but
 * ForgeCoupleRegionalPrompt creates CONDITIONING from prompt text + CLIP. It
 * has no upstream CONDITIONING input to pass through, so bypassing it leaves
 * KSampler.positive unset and Comfy queues only unrelated output nodes. When
 * that happens, synthesize a normal CLIPTextEncode node from the same prompt
 * text and CLIP input, then wire KSampler.positive to it.
 *
 * Some editor graphs also drop a neighboring linked CLIPTextEncode while
 * resolving the bypass. If KSampler.positive/negative is missing but the graph
 * still has a direct CONDITIONING link, serialize that linked source node and
 * wire it back in.
 */
export function applyBypassedRegionalPromptFallbacks(
  workflow: Workflow,
  nodeTypes: NodeTypes,
  prompt: Record<string, unknown>,
  allowedNodeIds: Set<number>,
  promptKeyMap?: Map<number, string>,
  seedOverrides?: Record<number, number>,
): void {
  if (!nodeTypes.CLIPTextEncode) return;

  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const linksById = new Map(workflow.links.map((link) => [link[0], link]));

  for (const node of workflow.nodes) {
    if (node.mode === 4) continue;
    const classType = resolveClassType(nodeTypes, node);
    if (classType !== 'KSampler' && classType !== 'KSamplerAdvanced') continue;

    const samplerPromptKey = promptKeyForNode(node, promptKeyMap);
    const samplerPrompt = prompt[samplerPromptKey] as { inputs?: Record<string, unknown> } | undefined;
    if (!samplerPrompt?.inputs) continue;

    for (const inputName of ['positive', 'negative'] as const) {
      if (samplerPrompt.inputs[inputName] !== undefined) continue;

      const conditioningInput = node.inputs.find((input) => input.name === inputName);
      if (conditioningInput?.link == null) continue;
      const conditioningLink = linksById.get(conditioningInput.link);
      if (!conditioningLink) continue;

      const sourceNode = nodesById.get(conditioningLink[1]);
      if (!sourceNode) continue;
      const sourceOutput = sourceNode.outputs[conditioningLink[2]];
      if (String(sourceOutput?.type || '').toUpperCase() !== 'CONDITIONING') continue;

      const sourceClassType = resolveClassType(nodeTypes, sourceNode);
      if (!sourceClassType) continue;
      const sourceInputs = buildWorkflowPromptInputs(
        workflow,
        nodeTypes,
        sourceNode,
        sourceClassType,
        allowedNodeIds,
        getNodeWidgetIndexMap(workflow, sourceNode),
        seedOverrides,
        promptKeyMap,
      );

      if (sourceNode.mode !== 4) {
        const sourcePromptKey = promptKeyForNode(sourceNode, promptKeyMap);
        if (!prompt[sourcePromptKey]) {
          prompt[sourcePromptKey] = {
            class_type: sourceClassType,
            inputs: sourceInputs,
          };
        }
        samplerPrompt.inputs[inputName] = [sourcePromptKey, conditioningLink[2]];
        continue;
      }

      if (inputName !== 'positive' || sourceNode.type !== 'ForgeCoupleRegionalPrompt') continue;

      const text = structuredPositivePromptToText(sourceInputs.positive_text) ?? sourceInputs.positive_text;
      const clip = sourceInputs.clip;
      if (!text || !isLinkedInput(clip)) continue;

      const fallbackKey = fallbackPromptKeyForSource(sourceNode, promptKeyMap);
      if (!prompt[fallbackKey]) {
        prompt[fallbackKey] = {
          class_type: 'CLIPTextEncode',
          inputs: {
            clip,
            text,
          },
        };
      }
      samplerPrompt.inputs.positive = [fallbackKey, 0];
    }
  }
}

function appendLoraManagerInputs(
  node: WorkflowNode,
  inputs: Record<string, unknown>,
  widgetValuesArray: unknown[] | null,
  widgetIndexMap: Record<string, number> | null
) {
  if ('loras' in inputs) return;

  const mappedIndex = widgetIndexMap?.loras;
  const listIndex = mappedIndex !== undefined ? mappedIndex : findLoraListIndex(node);
  if (listIndex === null) return;

  const rawValue = widgetValuesArray?.[listIndex];
  const loraList = extractLoraList(rawValue);
  if (loraList) {
    inputs.loras = loraList;
  }
}

function appendTriggerWordToggleInputs(
  node: WorkflowNode,
  inputs: Record<string, unknown>,
  widgetValuesArray: unknown[] | null,
  widgetIndexMap: Record<string, number> | null
) {
  if (!isTriggerWordToggleNodeType(node.type)) return;

  const mappedListIndex = widgetIndexMap?.toggle_trigger_words;
  const listIndex = mappedListIndex !== undefined
    ? mappedListIndex
    : findTriggerWordListIndex(node);
  if (listIndex === null) return;

  if (!('toggle_trigger_words' in inputs)) {
    const rawValue = widgetValuesArray?.[listIndex];
    const triggerList = extractTriggerWordList(rawValue) ?? extractTriggerWordListLoose(rawValue);
    if (triggerList) {
      inputs.toggle_trigger_words = triggerList;
    }
  }

  const mappedMessageIndex = widgetIndexMap?.originalMessage ?? widgetIndexMap?.orinalMessage;
  const messageIndex = mappedMessageIndex !== undefined
    ? mappedMessageIndex
    : findTriggerWordMessageIndex(node, listIndex);
  if (messageIndex === null) return;

  const messageValue = widgetValuesArray?.[messageIndex];
  const message = extractTriggerWordMessage(messageValue);
  if (message === null) return;

  const messageKey = widgetIndexMap && 'originalMessage' in widgetIndexMap
    ? 'originalMessage'
    : (widgetIndexMap && 'orinalMessage' in widgetIndexMap
      ? 'orinalMessage'
      : 'orinalMessage');

  if (!(messageKey in inputs)) {
    inputs[messageKey] = message;
  }
}
