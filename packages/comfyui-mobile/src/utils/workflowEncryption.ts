const ENCRYPTION_FORMAT = 'comfyui-mobile-encrypted-workflow';
const ENCRYPTION_VERSION = 1;
const PBKDF2_ITERATIONS = 250_000;
const STATUS_EVENT = 'comfyui-mobile-workflow-unlock-status';
const PERSISTED_UNLOCK_STORAGE_KEY = 'comfyui-mobile-workflow-unlock-v1';
const DEFAULT_UNLOCK_TTL_MS = 4 * 60 * 60 * 1000;

export interface EncryptedWorkflowEnvelope {
  encrypted: true;
  format: typeof ENCRYPTION_FORMAT;
  version: typeof ENCRYPTION_VERSION;
  kdf: 'PBKDF2-SHA256';
  cipher: 'AES-256-GCM';
  iterations: number;
  salt: string;
  iv: string;
  data: string;
}

interface PersistedUnlockRecord {
  secret: string;
  expiresAt: number;
}

let memorySecret: string | null = null;
let memorySecretExpiresAt: number | null = null;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function emitStatusChanged(): void {
  try {
    window.dispatchEvent(new Event(STATUS_EVENT));
  } catch {
    // Tests/non-browser runtimes may not expose window events.
  }
}

function storageAvailable(): boolean {
  try {
    return typeof window !== 'undefined' && Boolean(window.localStorage);
  } catch {
    return false;
  }
}

function readPersistedUnlockRecord(): PersistedUnlockRecord | null {
  if (!storageAvailable()) return null;
  try {
    const raw = window.localStorage.getItem(PERSISTED_UNLOCK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedUnlockRecord>;
    if (typeof parsed.secret !== 'string' || typeof parsed.expiresAt !== 'number') {
      window.localStorage.removeItem(PERSISTED_UNLOCK_STORAGE_KEY);
      return null;
    }
    if (parsed.expiresAt <= Date.now()) {
      window.localStorage.removeItem(PERSISTED_UNLOCK_STORAGE_KEY);
      return null;
    }
    return { secret: parsed.secret, expiresAt: parsed.expiresAt };
  } catch {
    try {
      window.localStorage.removeItem(PERSISTED_UNLOCK_STORAGE_KEY);
    } catch {
      // Ignore storage cleanup failures.
    }
    return null;
  }
}

function persistUnlockRecord(secret: string, ttlMs = DEFAULT_UNLOCK_TTL_MS): number | null {
  if (!storageAvailable()) return null;
  const expiresAt = Date.now() + Math.max(ttlMs, DEFAULT_UNLOCK_TTL_MS);
  try {
    window.localStorage.setItem(PERSISTED_UNLOCK_STORAGE_KEY, JSON.stringify({ secret, expiresAt }));
    return expiresAt;
  } catch {
    return null;
  }
}

function clearPersistedUnlockRecord(): void {
  if (!storageAvailable()) return;
  try {
    window.localStorage.removeItem(PERSISTED_UNLOCK_STORAGE_KEY);
  } catch {
    // Ignore storage cleanup failures.
  }
}

function loadSessionSecret(): string | null {
  if (memorySecret) {
    if (memorySecretExpiresAt && memorySecretExpiresAt <= Date.now()) {
      memorySecret = null;
      memorySecretExpiresAt = null;
      clearPersistedUnlockRecord();
      return null;
    }
    return memorySecret;
  }

  const persisted = readPersistedUnlockRecord();
  if (!persisted) return null;
  memorySecret = persisted.secret;
  memorySecretExpiresAt = persisted.expiresAt;
  return memorySecret;
}

function getSecret(): string {
  const secret = loadSessionSecret();
  if (!secret) {
    throw new Error('Private workflow unlock required. Enter your ComfyUI Mobile unlock passphrase before saving or loading encrypted workflows.');
  }
  return secret;
}

function asBufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

async function deriveKey(secret: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: asBufferSource(salt), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function isEncryptedWorkflow(value: unknown): value is EncryptedWorkflowEnvelope {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.encrypted === true && record.format === ENCRYPTION_FORMAT && record.version === ENCRYPTION_VERSION;
}

export function isWorkflowEncryptionUnlocked(): boolean {
  return Boolean(loadSessionSecret());
}

export function getWorkflowEncryptionUnlockExpiresAt(): number | null {
  loadSessionSecret();
  return memorySecretExpiresAt;
}

export function setWorkflowEncryptionKey(secret: string, ttlMs = DEFAULT_UNLOCK_TTL_MS): void {
  const trimmed = secret.trim();
  if (!trimmed) throw new Error('Unlock passphrase cannot be empty');
  memorySecret = trimmed;
  memorySecretExpiresAt = persistUnlockRecord(trimmed, ttlMs) ?? (Date.now() + Math.max(ttlMs, DEFAULT_UNLOCK_TTL_MS));
  emitStatusChanged();
}

export function subscribeWorkflowEncryptionStatus(listener: () => void): () => void {
  window.addEventListener(STATUS_EVENT, listener);
  return () => window.removeEventListener(STATUS_EVENT, listener);
}

export async function encryptWorkflowForStorage(workflow: unknown): Promise<EncryptedWorkflowEnvelope> {
  if (!crypto?.subtle) throw new Error('WebCrypto is required for workflow encryption');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(getSecret(), salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(workflow));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBufferSource(iv) }, key, plaintext));
  return {
    encrypted: true,
    format: ENCRYPTION_FORMAT,
    version: ENCRYPTION_VERSION,
    kdf: 'PBKDF2-SHA256',
    cipher: 'AES-256-GCM',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(encrypted),
  };
}

export async function encryptPrivateJsonForStorage(value: unknown): Promise<EncryptedWorkflowEnvelope> {
  return encryptWorkflowForStorage(value);
}

export async function decryptWorkflowFromStorage<T = unknown>(stored: unknown): Promise<T> {
  if (!isEncryptedWorkflow(stored)) return stored as T;
  if (!crypto?.subtle) throw new Error('WebCrypto is required for workflow decryption');
  const salt = base64ToBytes(stored.salt);
  const iv = base64ToBytes(stored.iv);
  const ciphertext = base64ToBytes(stored.data);
  const key = await deriveKey(getSecret(), salt, stored.iterations || PBKDF2_ITERATIONS);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBufferSource(iv) }, key, asBufferSource(ciphertext));
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    throw new Error('Could not decrypt workflow. Unlock ComfyUI Mobile with the same passphrase used when this workflow/image was saved.');
  }
}

export async function decryptPrivateJsonFromStorage<T = unknown>(stored: unknown): Promise<T> {
  return decryptWorkflowFromStorage<T>(stored);
}

export function clearWorkflowEncryptionKey(): void {
  memorySecret = null;
  memorySecretExpiresAt = null;
  clearPersistedUnlockRecord();
  emitStatusChanged();
}

export const WORKFLOW_UNLOCK_TTL_MS = DEFAULT_UNLOCK_TTL_MS;
export const WORKFLOW_UNLOCK_STORAGE_KEY = PERSISTED_UNLOCK_STORAGE_KEY;
