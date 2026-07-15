import { idbStorage } from '@/utils/idbStorage';
import {
  decryptPrivateJsonFromStorage,
  encryptPrivateJsonForStorage,
  isEncryptedWorkflow,
} from '@/utils/workflowEncryption';

export interface PersistedPromptAssistantReferenceImage {
  dataUrl: string;
  name: string;
}

interface StoredPromptAssistantReferenceImage extends PersistedPromptAssistantReferenceImage {
  savedAt: number;
}

const STORAGE_KEY_PREFIX = 'comfyui-mobile-prompt-assistant-reference-image-v1';
const WORKFLOW_UNLOCK_REQUIRED_TEXT = 'Private workflow unlock required';
const WORKFLOW_DECRYPT_FAILED_TEXT = 'Could not decrypt workflow';

function safeKeyPart(value: string): string {
  return encodeURIComponent(value.trim() || 'unknown');
}

export function buildPromptAssistantReferenceImageStorageKey(options: {
  workflowFilename?: string | null;
  workflowKey?: string | null;
  activeSessionId?: string | null;
  nodeKey?: string | number | null;
}): string {
  const workflowIdentity =
    options.workflowFilename?.trim()
    || options.activeSessionId?.trim()
    || options.workflowKey?.trim()
    || 'unsaved-workflow';
  const nodeIdentity = String(options.nodeKey ?? 'prompt-assistant');
  return `${STORAGE_KEY_PREFIX}:${safeKeyPart(workflowIdentity)}:${safeKeyPart(nodeIdentity)}`;
}

function isStoredReferenceImage(value: unknown): value is StoredPromptAssistantReferenceImage {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.dataUrl === 'string'
    && record.dataUrl.startsWith('data:image/')
    && typeof record.name === 'string';
}

export async function loadPromptAssistantReferenceImage(
  storageKey: string,
): Promise<PersistedPromptAssistantReferenceImage | null> {
  const raw = await idbStorage.getItem(storageKey);
  if (!raw) return null;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    await idbStorage.removeItem(storageKey);
    return null;
  }
  if (!isEncryptedWorkflow(stored)) {
    await idbStorage.removeItem(storageKey);
    return null;
  }
  const decrypted = await decryptPrivateJsonFromStorage<unknown>(stored);
  if (!isStoredReferenceImage(decrypted)) {
    await idbStorage.removeItem(storageKey);
    return null;
  }
  return {
    dataUrl: decrypted.dataUrl,
    name: decrypted.name,
  };
}

export function getPromptAssistantReferenceImageRestoreErrorMessage(
  error: unknown,
  workflowUnlocked: boolean,
): string | null {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';

  if (!workflowUnlocked && (
    message.includes(WORKFLOW_UNLOCK_REQUIRED_TEXT)
    || message.includes(WORKFLOW_DECRYPT_FAILED_TEXT)
  )) {
    return null;
  }

  if (message.includes(WORKFLOW_UNLOCK_REQUIRED_TEXT)) {
    return 'Unlock ComfyUI Mobile to restore the saved reference image.';
  }

  if (message.includes(WORKFLOW_DECRYPT_FAILED_TEXT)) {
    return 'Reference image could not be restored with the current unlock. Reattach the image to save a fresh encrypted copy.';
  }

  return message
    ? `Reference image could not be restored: ${message}`
    : 'Reference image could not be restored';
}

export async function savePromptAssistantReferenceImage(
  storageKey: string,
  image: PersistedPromptAssistantReferenceImage,
): Promise<void> {
  const encrypted = await encryptPrivateJsonForStorage({
    dataUrl: image.dataUrl,
    name: image.name || 'reference image',
    savedAt: Date.now(),
  } satisfies StoredPromptAssistantReferenceImage);
  await idbStorage.setItem(storageKey, JSON.stringify(encrypted));
}

export async function deletePromptAssistantReferenceImage(storageKey: string): Promise<void> {
  await idbStorage.removeItem(storageKey);
}
