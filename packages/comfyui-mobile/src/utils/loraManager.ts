import type { Workflow, WorkflowNode } from '@/api/types';

export interface LoraManagerEntry {
  name: string;
  strength: number | string;
  clipStrength?: number | string;
  active?: boolean;
  expanded?: boolean;
  locked?: boolean;
  [key: string]: unknown;
}

export interface ActiveLoraReference {
  name: string;
  strength?: number | string;
  active?: boolean;
  node_id?: number;
  node_title?: string;
  node_type?: string;
}

const LORA_LOADER_NODE_TYPES = new Set([
  'Lora Loader (LoraManager)'
]);
const LORA_TEXT_LOADER_NODE_TYPES = new Set([
  'LoRA Text Loader (LoraManager)'
]);
const LORA_CHAIN_PROVIDER_NODE_TYPES = new Set([
  'Lora Stacker (LoraManager)',
  'Lora Randomizer (LoraManager)',
  'Lora Cycler (LoraManager)'
]);
const LORA_DIRECT_PROVIDER_NODE_TYPES = new Set([
  'Lora Stacker (LoraManager)',
  'Lora Randomizer (LoraManager)',
  'Lora Cycler (LoraManager)',
  'WanVideo Lora Select (LoraManager)'
]);
const LORA_CYCLER_NODE_TYPES = new Set([
  'Lora Cycler (LoraManager)'
]);
const MULTI_LORA_STACK_NODE_TYPES = new Set([
  'MultiLoRAStack',
  'MultiLoRAStackModelOnly',
]);
const MFLUX_LORAS_LOADER_NODE_TYPE = 'MfluxLorasLoader';

const EPSILON = Number.EPSILON;
const FALSE_LIKE_VALUES = new Set(['false', '0', 'off', 'none', 'no', 'disabled']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const LORA_PATTERN = /<lora:([^:>]+):([-\d.]+)(?::([-\d.]+))?>/g;
const MODEL_EXTENSION_PATTERN = /\.(safetensors|ckpt|pt|pth|bin)$/i;

export function isLoraManagerNodeType(nodeType: string): boolean {
  return (
    isLoraLoaderNodeType(nodeType) ||
    isLoraTextLoaderNodeType(nodeType) ||
    isLoraDirectProviderNodeType(nodeType)
  );
}

/** The rgthree "Power Lora Loader" node has dynamic lora widgets needing special handling. */
export const POWER_LORA_LOADER_NODE_TYPE = 'Power Lora Loader (rgthree)';

export function isPowerLoraLoaderNodeType(nodeType: string | undefined | null): boolean {
  return nodeType === POWER_LORA_LOADER_NODE_TYPE;
}

export function isMultiLoraStackNodeType(nodeType: string | undefined | null): boolean {
  if (!nodeType) return false;
  if (MULTI_LORA_STACK_NODE_TYPES.has(nodeType)) return true;
  return nodeType.toLowerCase().includes('multilorastack');
}

export function isMfluxLorasLoaderNodeType(nodeType: string | undefined | null): boolean {
  return nodeType === MFLUX_LORAS_LOADER_NODE_TYPE;
}

export function isLoraLoaderNodeType(nodeType: string): boolean {
  if (LORA_LOADER_NODE_TYPES.has(nodeType)) return true;
  const lowered = nodeType.toLowerCase();
  return lowered.includes('(loramanager)') && lowered.includes('lora loader');
}

export function isLoraTextLoaderNodeType(nodeType: string): boolean {
  if (LORA_TEXT_LOADER_NODE_TYPES.has(nodeType)) return true;
  const lowered = nodeType.toLowerCase();
  return lowered.includes('(loramanager)') && lowered.includes('lora text loader');
}

export function isLoraChainProviderNodeType(nodeType: string): boolean {
  if (LORA_CHAIN_PROVIDER_NODE_TYPES.has(nodeType)) return true;
  const lowered = nodeType.toLowerCase();
  return lowered.includes('(loramanager)') && (
    lowered.includes('lora stacker') ||
    lowered.includes('lora randomizer') ||
    lowered.includes('lora cycler')
  );
}

export function isLoraDirectProviderNodeType(nodeType: string): boolean {
  if (LORA_DIRECT_PROVIDER_NODE_TYPES.has(nodeType)) return true;
  const lowered = nodeType.toLowerCase();
  return lowered.includes('(loramanager)') && (
    lowered.includes('lora stacker') ||
    lowered.includes('lora randomizer') ||
    lowered.includes('lora cycler') ||
    lowered.includes('wanvideo lora select')
  );
}

export function isLoraCyclerNodeType(nodeType: string): boolean {
  if (LORA_CYCLER_NODE_TYPES.has(nodeType)) return true;
  const lowered = nodeType.toLowerCase();
  return lowered.includes('(loramanager)') && lowered.includes('lora cycler');
}

export function normalizeLoraManagerName(name: string): string {
  const normalized = name.replace(/\\/g, '/').trim();
  if (!normalized) return '';
  const baseName = normalized.split('/').filter(Boolean).pop() ?? normalized;
  return baseName.replace(MODEL_EXTENSION_PATTERN, '');
}

export function isLoraList(value: unknown): value is LoraManagerEntry[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  return value.every((entry) =>
    isRecord(entry) && typeof entry.name === 'string' && 'strength' in entry
  );
}

export function extractLoraList(value: unknown): LoraManagerEntry[] | null {
  if (isLoraList(value)) return value;
  if (isRecord(value) && isLoraList(value.__value__)) {
    return value.__value__ as LoraManagerEntry[];
  }
  return null;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return fallback;
    if (FALSE_LIKE_VALUES.has(normalized)) return false;
    if (['true', '1', 'on', 'yes', 'enabled'].includes(normalized)) return true;
  }
  if (value === null || value === undefined) return fallback;
  return Boolean(value);
}

export function normalizeLoraStackEntry(entry: LoraManagerEntry): LoraManagerEntry {
  const name = String(entry.name ?? '').replace(/\\/g, '/').trim();
  const strength = coerceNumber(entry.strength, 1);
  const clipStrength = coerceNumber(entry.clipStrength ?? strength, strength);
  const active = coerceBoolean(entry.active, true);
  const expanded = entry.expanded !== undefined
    ? coerceBoolean(entry.expanded, false)
    : Math.abs(clipStrength - strength) > EPSILON;

  return {
    ...entry,
    name,
    strength,
    clipStrength,
    active,
    expanded,
  };
}

export function createDefaultLoraStackEntry(choices?: unknown[]): LoraManagerEntry {
  const firstChoice = Array.isArray(choices) && choices.length > 0
    ? String(choices[0]).replace(/\\/g, '/').trim()
    : '';
  return normalizeLoraStackEntry({
    name: firstChoice,
    strength: 1,
    clipStrength: 1,
    active: Boolean(firstChoice),
    expanded: false,
  });
}

export function extractMultiLoraStackList(value: unknown): LoraManagerEntry[] | null {
  const parsed = parseMaybeJson(
    isRecord(value) && '__value__' in value ? value.__value__ : value,
  );
  if (!Array.isArray(parsed)) return null;

  const entries: LoraManagerEntry[] = [];
  for (const rawEntry of parsed) {
    if (!isRecord(rawEntry)) continue;
    const nameValue = rawEntry.lora ?? rawEntry.name ?? '';
    const name = String(nameValue).replace(/\\/g, '/').trim();
    const rawStrength = rawEntry.strength ?? rawEntry.model_strength;
    const strength =
      typeof rawStrength === 'number' || typeof rawStrength === 'string'
        ? rawStrength
        : 1;
    entries.push(normalizeLoraStackEntry({
      name,
      strength,
      clipStrength: strength,
      active: rawEntry.on !== undefined
        ? coerceBoolean(rawEntry.on, true)
        : coerceBoolean(rawEntry.active, true),
      expanded: false,
    }));
  }
  return entries;
}

function isProbablyLoraName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.replace(/\\/g, '/').trim();
  if (!text || /^none$/i.test(text)) return false;
  if (text.startsWith('[') || text.startsWith('{')) return false;
  return MODEL_EXTENSION_PATTERN.test(text) || text.includes('/');
}

function activeReferenceFromEntry(
  entry: LoraManagerEntry,
  node: WorkflowNode,
): ActiveLoraReference | null {
  const normalized = normalizeLoraStackEntry(entry);
  if (!normalized.name || normalized.active === false) return null;
  if (Number(normalized.strength) === 0) return null;
  return {
    name: normalized.name,
    strength: normalized.strength,
    active: true,
    node_id: node.id,
    node_title: node.title,
    node_type: node.type,
  };
}

function pushActiveReference(
  references: ActiveLoraReference[],
  seen: Set<string>,
  reference: ActiveLoraReference | null,
): void {
  if (!reference?.name) return;
  const key = reference.name.replace(/\\/g, '/').trim().toLowerCase();
  if (!key || seen.has(key)) return;
  seen.add(key);
  references.push(reference);
}

function extractActiveLorasFromNode(
  node: WorkflowNode,
  references: ActiveLoraReference[],
  seen: Set<string>,
): void {
  const values = node.widgets_values;
  const lowered = `${node.type || ''} ${node.title || ''}`.toLowerCase();

  if (isMultiLoraStackNodeType(node.type) && Array.isArray(values)) {
    const stack = extractMultiLoraStackList(values[0]);
    if (stack) {
      stack.forEach((entry) => pushActiveReference(references, seen, activeReferenceFromEntry(entry, node)));
    }
  }

  if (Array.isArray(values)) {
    if (isMfluxLorasLoaderNodeType(node.type)) {
      for (let index = 0; index < values.length; index += 2) {
        const name = values[index];
        const strength = values[index + 1] ?? 1;
        if (isProbablyLoraName(name) && Number(strength) !== 0) {
          pushActiveReference(references, seen, {
            name,
            strength: strength as number | string,
            active: true,
            node_id: node.id,
            node_title: node.title,
            node_type: node.type,
          });
        }
      }
    }

    for (const value of values) {
      const list = extractLoraList(value);
      if (list) {
        list.forEach((entry) => pushActiveReference(references, seen, activeReferenceFromEntry(entry, node)));
      }

      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        ('lora' in value || 'lora_name' in value || 'name' in value)
      ) {
        const record = value as Record<string, unknown>;
        const name = String(record.lora ?? record.lora_name ?? record.name ?? '').replace(/\\/g, '/').trim();
        const active = record.on !== undefined
          ? coerceBoolean(record.on, true)
          : coerceBoolean(record.active, true);
        const strength = record.strength ?? record.model_strength ?? record.strength_model ?? 1;
        if (name && active && Number(strength) !== 0) {
          pushActiveReference(references, seen, {
            name,
            strength: strength as number | string,
            active,
            node_id: node.id,
            node_title: node.title,
            node_type: node.type,
          });
        }
      }

      if (lowered.includes('lora') && isProbablyLoraName(value)) {
        pushActiveReference(references, seen, {
          name: value,
          active: true,
          node_id: node.id,
          node_title: node.title,
          node_type: node.type,
        });
      }
    }
  } else if (values && typeof values === 'object') {
    for (const value of Object.values(values)) {
      const list = extractLoraList(value);
      if (list) {
        list.forEach((entry) => pushActiveReference(references, seen, activeReferenceFromEntry(entry, node)));
      }
    }
  }
}

export function extractActiveLoraReferencesFromWorkflow(
  workflow: Workflow | null | undefined,
): ActiveLoraReference[] {
  if (!workflow) return [];
  const references: ActiveLoraReference[] = [];
  const seen = new Set<string>();
  workflow.nodes?.forEach((node) => extractActiveLorasFromNode(node, references, seen));
  workflow.definitions?.subgraphs?.forEach((subgraph) => {
    subgraph.nodes?.forEach((node) => extractActiveLorasFromNode(node, references, seen));
  });
  return references;
}

export function serializeMultiLoraStackList(list: LoraManagerEntry[]): string {
  const serialized = list
    .map((entry) => normalizeLoraStackEntry(entry))
    .filter((entry) => entry.name.trim().length > 0)
    .map((entry) => ({
      on: entry.active !== false,
      lora: entry.name,
      strength: coerceNumber(entry.strength, 1),
    }));
  return JSON.stringify(serialized);
}

export function findLoraListIndex(
  node: WorkflowNode,
  textIndex?: number | null
): number | null {
  if (!Array.isArray(node.widgets_values)) return null;
  const values = node.widgets_values;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (isLoraList(value) && value.length > 0) {
      return i;
    }
  }

  if (textIndex !== null && textIndex !== undefined) {
    const candidateIndex = textIndex + 1;
    if (candidateIndex >= 0 && candidateIndex < values.length) {
      const candidate = values[candidateIndex];
      if (Array.isArray(candidate)) {
        return candidateIndex;
      }
    } else if (candidateIndex === values.length) {
      return candidateIndex;
    }
  }

  const emptyIndex = values.findIndex((value) => Array.isArray(value) && value.length === 0);
  return emptyIndex >= 0 ? emptyIndex : null;
}

function coerceNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return fallback;
}

export function normalizeLoraEntry(entry: LoraManagerEntry): LoraManagerEntry {
  const name = normalizeLoraManagerName(entry.name);
  const strength = coerceNumber(entry.strength, 1);
  const clipStrength = coerceNumber(entry.clipStrength ?? strength, strength);
  const active = coerceBoolean(entry.active, true);
  const expanded = entry.expanded !== undefined
    ? coerceBoolean(entry.expanded, false)
    : Math.abs(clipStrength - strength) > EPSILON;

  return {
    ...entry,
    name,
    strength,
    clipStrength,
    active,
    expanded
  };
}

export function createDefaultLoraEntry(choices?: unknown[]): LoraManagerEntry {
  const firstChoice = Array.isArray(choices) && choices.length > 0
    ? normalizeLoraManagerName(String(choices[0]))
    : '';
  const active = Boolean(firstChoice);
  return normalizeLoraEntry({
    name: firstChoice,
    strength: 1,
    clipStrength: 1,
    active,
    expanded: false
  });
}

export function mergeLoras(
  lorasText: string,
  lorasArr: LoraManagerEntry[]
): LoraManagerEntry[] {
  const parsedLoras: Record<string, { strength: number; clipStrength: number }> = {};
  let match: RegExpExecArray | null;
  LORA_PATTERN.lastIndex = 0;
  while ((match = LORA_PATTERN.exec(lorasText)) !== null) {
    const name = normalizeLoraManagerName(match[1]);
    if (!name) continue;
    const modelStrength = Number(match[2]);
    const clipStrength = match[3] ? Number(match[3]) : modelStrength;
    parsedLoras[name] = { strength: modelStrength, clipStrength };
  }

  const result: LoraManagerEntry[] = [];
  const usedNames = new Set<string>();

  for (const lora of lorasArr) {
    const name = lora ? normalizeLoraManagerName(lora.name) : '';
    if (!lora || !name || !parsedLoras[name]) continue;
    const parsed = parsedLoras[name];
    result.push({
      ...lora,
      name,
      strength: lora.strength !== undefined ? lora.strength : parsed.strength,
      clipStrength: lora.clipStrength !== undefined ? lora.clipStrength : parsed.clipStrength,
      active: lora.active !== undefined ? lora.active : true,
      expanded: lora.expanded !== undefined ? lora.expanded : false
    });
    usedNames.add(name);
  }

  for (const name of Object.keys(parsedLoras)) {
    if (usedNames.has(name)) continue;
    const parsed = parsedLoras[name];
    result.push({
      name,
      strength: parsed.strength,
      clipStrength: parsed.clipStrength,
      active: true
    });
  }

  return result;
}

function normalizeStrengthValue(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return (1).toFixed(2);
  }
  return numeric.toFixed(2);
}

function shouldIncludeClipStrength(
  lora: LoraManagerEntry | undefined,
  hadClipFromText: unknown
): boolean {
  const clip = lora?.clipStrength;
  const strength = lora?.strength;

  if (clip === undefined || clip === null) {
    return Boolean(hadClipFromText);
  }

  const clipValue = Number(clip);
  const strengthValue = Number(strength);

  if (!Number.isFinite(clipValue) || !Number.isFinite(strengthValue)) {
    return Boolean(hadClipFromText);
  }

  if (Math.abs(clipValue - strengthValue) > EPSILON) {
    return true;
  }

  return Boolean(lora?.expanded || hadClipFromText);
}

function cleanupLoraSyntax(text: string): string {
  if (!text) {
    return '';
  }

  let cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/,\s*,+/g, ',')
    .replace(/\s*,\s*/g, ',')
    .trim();

  if (cleaned === ',') {
    return '';
  }

  cleaned = cleaned.replace(/(^,)|(,$)/g, '');
  cleaned = cleaned.replace(/,\s*/g, ', ');

  return cleaned.trim();
}

export function applyLoraValuesToText(
  originalText: string,
  loras: LoraManagerEntry[]
): string {
  const baseText = typeof originalText === 'string' ? originalText : '';
  const loraArray = Array.isArray(loras) ? loras : [];
  const loraMap = new Map<string, LoraManagerEntry>();

  loraArray.forEach((lora) => {
    if (!lora || !lora.name) return;
    const name = normalizeLoraManagerName(lora.name);
    if (!name) return;
    loraMap.set(name, normalizeLoraEntry({ ...lora, name }));
  });

  LORA_PATTERN.lastIndex = 0;
  const retainedNames = new Set<string>();

  const updated = baseText.replace(
    LORA_PATTERN,
    (_match, rawName, strength, clipStrength) => {
      const name = normalizeLoraManagerName(rawName);
      const lora = loraMap.get(name);
      if (!lora) {
        return '';
      }

      retainedNames.add(name);

      const formattedStrength = normalizeStrengthValue(
        lora.strength ?? strength
      );
      const formattedClip = normalizeStrengthValue(
        lora.clipStrength ?? lora.strength ?? clipStrength
      );

      const includeClip = shouldIncludeClipStrength(lora, clipStrength);

      if (includeClip) {
        return `<lora:${name}:${formattedStrength}:${formattedClip}>`;
      }

      return `<lora:${name}:${formattedStrength}>`;
    }
  );

  const cleaned = cleanupLoraSyntax(updated);

  if (loraMap.size === retainedNames.size) {
    return cleaned;
  }

  const missingEntries: string[] = [];
  loraMap.forEach((lora, name) => {
    if (retainedNames.has(name)) return;
    const formattedStrength = normalizeStrengthValue(lora.strength);
    const formattedClip = normalizeStrengthValue(
      lora.clipStrength ?? lora.strength
    );
    const includeClip = shouldIncludeClipStrength(lora, null);

    const syntax = includeClip
      ? `<lora:${name}:${formattedStrength}:${formattedClip}>`
      : `<lora:${name}:${formattedStrength}>`;

    missingEntries.push(syntax);
  });

  if (missingEntries.length === 0) {
    return cleaned;
  }

  const separator = cleaned ? ' ' : '';
  return `${cleaned}${separator}${missingEntries.join(' ')}`.trim();
}
