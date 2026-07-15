import { idbStorage } from '@/utils/idbStorage';
import {
  decryptPrivateJsonFromStorage,
  encryptPrivateJsonForStorage,
  isEncryptedWorkflow,
} from '@/utils/workflowEncryption';

export type PromptLibraryItemKind = 'full' | 'part';
export type PromptLibraryMode = 'none' | 'bbox' | 'forge_couple' | 'anima_region' | string;
export type PromptLibraryPartType =
  | 'positive'
  | 'negative'
  | 'style'
  | 'character'
  | 'composition'
  | 'bbox_element'
  | 'region_line'
  | string;

export interface PromptLibraryLoraAttachment {
  name: string;
  strength: number | string;
  clipStrength?: number | string;
  active?: boolean;
  triggers?: string[];
}

export interface PromptLibraryItem {
  id: string;
  kind: PromptLibraryItemKind;
  title: string;
  positive: string;
  negative?: string;
  mode?: PromptLibraryMode;
  partType?: PromptLibraryPartType;
  loras: PromptLibraryLoraAttachment[];
  createdAt: number;
  updatedAt: number;
}

interface PromptLibraryStorePayload {
  schemaVersion: 1;
  items: PromptLibraryItem[];
}

const PROMPT_LIBRARY_STORAGE_KEY = 'comfyui-mobile-prompt-library-v1';

function now(): number {
  return Date.now();
}

function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `prompt-${now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeLoraAttachment(value: unknown): PromptLibraryLoraAttachment | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const name = normalizeText(record.name).replace(/\\/g, '/').trim();
  if (!name) return null;
  const rawStrength = record.strength;
  const strength =
    typeof rawStrength === 'number' || typeof rawStrength === 'string'
      ? rawStrength
      : 1;
  const rawClip = record.clipStrength;
  const clipStrength =
    typeof rawClip === 'number' || typeof rawClip === 'string'
      ? rawClip
      : undefined;
  const triggers = Array.isArray(record.triggers)
    ? record.triggers.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    name,
    strength,
    clipStrength,
    active: record.active === undefined ? true : Boolean(record.active),
    ...(triggers && triggers.length > 0 ? { triggers } : {}),
  };
}

function normalizeItem(value: unknown): PromptLibraryItem | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind === 'part' ? 'part' : record.kind === 'full' ? 'full' : null;
  if (!kind) return null;

  const positive = normalizeText(record.positive);
  const negative = normalizeText(record.negative);
  const title = normalizeText(record.title).trim() || (kind === 'full' ? 'Untitled prompt' : 'Untitled part');
  const rawLoras = Array.isArray(record.loras) ? record.loras : [];
  const loras = rawLoras
    .map(normalizeLoraAttachment)
    .filter((item): item is PromptLibraryLoraAttachment => Boolean(item));
  const timestamp = now();

  return {
    id: normalizeText(record.id).trim() || createId(),
    kind,
    title,
    positive,
    negative,
    mode: normalizeText(record.mode) || 'none',
    partType: normalizeText(record.partType) || (kind === 'part' ? 'positive' : undefined),
    loras,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : timestamp,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : timestamp,
  };
}

function normalizePayload(value: unknown): PromptLibraryStorePayload {
  if (!value || typeof value !== 'object') return { schemaVersion: 1, items: [] };
  const record = value as Record<string, unknown>;
  const rawItems = Array.isArray(record.items) ? record.items : [];
  return {
    schemaVersion: 1,
    items: rawItems
      .map(normalizeItem)
      .filter((item): item is PromptLibraryItem => Boolean(item))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

async function readPromptLibraryPayload(): Promise<PromptLibraryStorePayload> {
  const raw = await idbStorage.getItem(PROMPT_LIBRARY_STORAGE_KEY);
  if (!raw) return { schemaVersion: 1, items: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await idbStorage.removeItem(PROMPT_LIBRARY_STORAGE_KEY);
    return { schemaVersion: 1, items: [] };
  }

  if (!isEncryptedWorkflow(parsed)) {
    await idbStorage.removeItem(PROMPT_LIBRARY_STORAGE_KEY);
    return { schemaVersion: 1, items: [] };
  }

  return normalizePayload(await decryptPrivateJsonFromStorage(parsed));
}

async function writePromptLibraryPayload(payload: PromptLibraryStorePayload): Promise<void> {
  const encrypted = await encryptPrivateJsonForStorage(normalizePayload(payload));
  await idbStorage.setItem(PROMPT_LIBRARY_STORAGE_KEY, JSON.stringify(encrypted));
}

export async function listPromptLibraryItems(): Promise<PromptLibraryItem[]> {
  return (await readPromptLibraryPayload()).items;
}

export async function savePromptLibraryItem(
  item: Omit<PromptLibraryItem, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<PromptLibraryItem, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<PromptLibraryItem> {
  const payload = await readPromptLibraryPayload();
  const timestamp = now();
  const normalized = normalizeItem({
    ...item,
    id: item.id ?? createId(),
    createdAt: item.createdAt ?? timestamp,
    updatedAt: timestamp,
  });
  if (!normalized) throw new Error('Prompt library item is missing required fields');

  const nextItems = [
    normalized,
    ...payload.items.filter((existing) => existing.id !== normalized.id),
  ];
  await writePromptLibraryPayload({ schemaVersion: 1, items: nextItems });
  return normalized;
}

export async function deletePromptLibraryItem(id: string): Promise<void> {
  const payload = await readPromptLibraryPayload();
  const nextItems = payload.items.filter((item) => item.id !== id);
  await writePromptLibraryPayload({ schemaVersion: 1, items: nextItems });
}

export async function clearPromptLibraryItems(): Promise<void> {
  await idbStorage.removeItem(PROMPT_LIBRARY_STORAGE_KEY);
}

export const PROMPT_LIBRARY_KEY = PROMPT_LIBRARY_STORAGE_KEY;
