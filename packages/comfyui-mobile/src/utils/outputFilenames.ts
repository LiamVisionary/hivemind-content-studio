type PromptNode = {
  class_type?: unknown;
  inputs?: Record<string, unknown>;
};

const MODEL_INPUT_KEYS = [
  'ckpt_name',
  'unet_name',
  'model_name',
  'diffusion_model_name',
  'diffusion_model',
  'checkpoint',
  'model',
];

const MODEL_EXTENSION =
  /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx|mlpackage)$/i;

let lastFilenameTimestamp = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLinkValue(value: unknown): boolean {
  return Array.isArray(value)
    && value.length >= 2
    && (typeof value[0] === 'string' || typeof value[0] === 'number')
    && typeof value[1] === 'number';
}

function promptNode(value: unknown): PromptNode | null {
  if (!isRecord(value)) return null;
  const inputs = isRecord(value.inputs) ? value.inputs : undefined;
  return {
    class_type: value.class_type,
    inputs,
  };
}

function basename(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.pop() ?? value;
}

function cleanFilenamePart(value: string, fallback: string): string {
  const withoutExtension = basename(value.trim()).replace(MODEL_EXTENSION, '');
  const clean = withoutExtension
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_ .-]+|[_ .-]+$/g, '')
    .slice(0, 64);
  return clean || fallback;
}

function nodePriority(node: PromptNode): number {
  const classType = String(node.class_type || '').toLowerCase();
  if (classType.includes('checkpointloader')) return 100;
  if (classType.includes('unetloader')) return 95;
  if (classType.includes('diffusion') && classType.includes('loader')) return 90;
  if (classType.includes('model') && classType.includes('loader')) return 80;
  if (classType.includes('loader')) return 40;
  return 0;
}

export function modelNameFromPrompt(prompt: Record<string, unknown>): string | null {
  const candidates: Array<{ value: string; priority: number; order: number }> = [];

  Object.values(prompt).forEach((rawNode, order) => {
    const node = promptNode(rawNode);
    if (!node?.inputs) return;
    const priority = nodePriority(node);
    if (priority <= 0) return;

    for (const key of MODEL_INPUT_KEYS) {
      const value = node.inputs[key];
      if (value == null || isLinkValue(value)) continue;
      const text = String(value).trim();
      if (!text) continue;
      candidates.push({ value: text, priority, order });
      break;
    }
  });

  candidates.sort((a, b) => b.priority - a.priority || a.order - b.order);
  const best = candidates[0]?.value;
  return best ? cleanFilenamePart(best, 'generation') : null;
}

export function formatFilenameTimestamp(timestamp: number | Date = Date.now()): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    '_',
    pad(date.getMilliseconds(), 3),
  ].join('');
}

export function nextFilenameTimestamp(seed: number = Date.now()): number {
  const next = Math.max(seed, lastFilenameTimestamp + 1);
  lastFilenameTimestamp = next;
  return next;
}

function outputDirectoryFromPrefix(prefix: unknown): string {
  if (typeof prefix !== 'string' || !prefix.includes('/')) return '';
  const rawParts = prefix.split('/').filter(Boolean);
  rawParts.pop();
  const cleanParts = rawParts
    .map((part) => cleanFilenamePart(part, ''))
    .filter(Boolean);
  return cleanParts.length > 0 ? `${cleanParts.join('/')}/` : '';
}

export function buildGenerationFilenamePrefix(
  prompt: Record<string, unknown>,
  timestamp: number | Date = Date.now(),
  existingPrefix?: unknown,
): string {
  const model = modelNameFromPrompt(prompt) ?? 'generation';
  return `${outputDirectoryFromPrefix(existingPrefix)}${model}_${formatFilenameTimestamp(timestamp)}`;
}

export function applyGenerationFilenamePrefixes(
  prompt: Record<string, unknown>,
  timestamp: number | Date = Date.now(),
): Record<string, unknown> {
  let changed = false;
  const nextPrompt: Record<string, unknown> = {};

  for (const [nodeId, rawNode] of Object.entries(prompt)) {
    const node = promptNode(rawNode);
    if (!node?.inputs || !Object.prototype.hasOwnProperty.call(node.inputs, 'filename_prefix')) {
      nextPrompt[nodeId] = rawNode;
      continue;
    }

    const filenamePrefix = buildGenerationFilenamePrefix(
      prompt,
      timestamp,
      node.inputs.filename_prefix,
    );
    nextPrompt[nodeId] = {
      ...(rawNode as Record<string, unknown>),
      inputs: {
        ...node.inputs,
        filename_prefix: filenamePrefix,
      },
    };
    changed = true;
  }

  return changed ? nextPrompt : prompt;
}
