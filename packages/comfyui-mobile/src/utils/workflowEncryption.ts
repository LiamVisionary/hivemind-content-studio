const ENCRYPTION_FORMAT = 'comfyui-mobile-encrypted-workflow';
// v1 seals under PBKDF2(passphrase). v2 seals under the owner vault's master
// key, handed to this surface by the studio shell as a non-extractable
// CryptoKey. v1 is never written any more, but it can never stop being READ
// either: v1 envelopes are stamped into saved images and history entries that
// are already on disk, so there is nothing left to re-key.
const ENCRYPTION_VERSION = 1;
const VAULT_ENCRYPTION_VERSION = 2;
const VAULT_KDF = 'vault-master-key';
const PBKDF2_ITERATIONS = 250_000;
const STATUS_EVENT = 'comfyui-mobile-workflow-unlock-status';
// Raised when something asked for a v1 envelope and this browser has no
// passphrase to open it. Deliberately a notification and not a prompt: the
// gate turns it into a dismissible offer, never a modal that interrupts.
const LEGACY_UNLOCK_EVENT = 'comfyui-mobile-workflow-legacy-unlock-required';
const PERSISTED_UNLOCK_STORAGE_KEY = 'comfyui-mobile-workflow-unlock-v1';
const DEFAULT_UNLOCK_TTL_MS = 24 * 60 * 60 * 1000;

interface BaseWorkflowEnvelope {
  encrypted: true;
  format: typeof ENCRYPTION_FORMAT;
  cipher: 'AES-256-GCM';
  iv: string;
  data: string;
}

export interface PassphraseWorkflowEnvelope extends BaseWorkflowEnvelope {
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
}

export interface VaultWorkflowEnvelope extends BaseWorkflowEnvelope {
  version: 2;
  kdf: typeof VAULT_KDF;
}

export type EncryptedWorkflowEnvelope = PassphraseWorkflowEnvelope | VaultWorkflowEnvelope;

/** The open vault, as handed over by the studio shell. Never key material. */
export interface VaultKeyHandles {
  masterKey: CryptoKey;
  privateKey: CryptoKey;
}

interface PersistedUnlockRecord {
  secret: string;
  expiresAt: number;
}

let memorySecret: string | null = null;
let memorySecretExpiresAt: number | null = null;
// The shell's vault, for as long as this frame lives. Not persisted and not
// persistable: a CryptoKey does not survive sessionStorage, and it does not
// need to — the shell re-posts the handles on every frame load and on every
// unlock, which is also what makes a lock instantaneous here.
let vaultKeys: VaultKeyHandles | null = null;
let legacyUnlockNeeded = false;

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
    return typeof window !== 'undefined' && Boolean(window.sessionStorage);
  } catch {
    return false;
  }
}

function clearLegacyPersistentUnlockRecord(): void {
  try {
    window.localStorage?.removeItem(PERSISTED_UNLOCK_STORAGE_KEY);
  } catch {
    // Old builds persisted this secret; cleanup must never block unlock.
  }
}

function readPersistedUnlockRecord(): PersistedUnlockRecord | null {
  clearLegacyPersistentUnlockRecord();
  if (!storageAvailable()) return null;
  try {
    const raw = window.sessionStorage.getItem(PERSISTED_UNLOCK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedUnlockRecord>;
    if (typeof parsed.secret !== 'string' || typeof parsed.expiresAt !== 'number') {
      window.sessionStorage.removeItem(PERSISTED_UNLOCK_STORAGE_KEY);
      return null;
    }
    if (parsed.expiresAt <= Date.now()) {
      window.sessionStorage.removeItem(PERSISTED_UNLOCK_STORAGE_KEY);
      return null;
    }
    return { secret: parsed.secret, expiresAt: parsed.expiresAt };
  } catch {
    try {
      window.sessionStorage.removeItem(PERSISTED_UNLOCK_STORAGE_KEY);
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
    window.sessionStorage.setItem(PERSISTED_UNLOCK_STORAGE_KEY, JSON.stringify({ secret, expiresAt }));
    clearLegacyPersistentUnlockRecord();
    return expiresAt;
  } catch {
    return null;
  }
}

function clearPersistedUnlockRecord(): void {
  clearLegacyPersistentUnlockRecord();
  if (!storageAvailable()) return;
  try {
    window.sessionStorage.removeItem(PERSISTED_UNLOCK_STORAGE_KEY);
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
    noteLegacyUnlockNeeded();
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
  if (record.encrypted !== true || record.format !== ENCRYPTION_FORMAT) return false;
  return record.version === ENCRYPTION_VERSION || record.version === VAULT_ENCRYPTION_VERSION;
}

function isVaultEnvelope(envelope: EncryptedWorkflowEnvelope): envelope is VaultWorkflowEnvelope {
  return envelope.version === VAULT_ENCRYPTION_VERSION;
}

/**
 * Whether this surface can read and write private content at all — by EITHER
 * route. The vault handed over by the shell is the normal one; the passphrase
 * is what a standalone tab (no shell to hand anything over) still has.
 */
export function isWorkflowEncryptionUnlocked(): boolean {
  return Boolean(vaultKeys || loadSessionSecret());
}

/** Adopt the open vault from the studio shell. See VaultKeyHandles. */
export function setVaultKeyHandles(handles: VaultKeyHandles | null): void {
  vaultKeys = handles;
  emitStatusChanged();
}

export function getVaultKeyHandles(): VaultKeyHandles | null {
  return vaultKeys;
}

/**
 * True once something asked for a v1 envelope that this browser cannot open.
 *
 * Reading it does not clear it: the offer to unlock should stay on screen until
 * the unlock happens or the user dismisses it, not vanish on the next render.
 */
export function isLegacyUnlockNeeded(): boolean {
  return legacyUnlockNeeded && !loadSessionSecret();
}

export function clearLegacyUnlockNeeded(): void {
  legacyUnlockNeeded = false;
  emitStatusChanged();
}

function noteLegacyUnlockNeeded(): void {
  if (legacyUnlockNeeded) return;
  legacyUnlockNeeded = true;
  try {
    window.dispatchEvent(new Event(LEGACY_UNLOCK_EVENT));
  } catch {
    // Tests/non-browser runtimes may not expose window events.
  }
  emitStatusChanged();
}

// The raw unlock passphrase for modules that derive further client-side keys
// (the E2E media vault in utils/e2eMedia.ts). Null when locked or expired.
// Like every use of this secret, it must never be sent to the backend.
export function getWorkflowEncryptionSecret(): string | null {
  return loadSessionSecret();
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
  const plaintext = new TextEncoder().encode(JSON.stringify(workflow));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // The vault is the route whenever the shell has handed it over: it is already
  // open, it costs no key derivation, and it is the same key the owner's other
  // devices unlock, so what is written here is readable on all of them.
  if (vaultKeys) {
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBufferSource(iv) }, vaultKeys.masterKey, plaintext),
    );
    return {
      encrypted: true,
      format: ENCRYPTION_FORMAT,
      version: VAULT_ENCRYPTION_VERSION,
      kdf: VAULT_KDF,
      cipher: 'AES-256-GCM',
      iv: bytesToBase64(iv),
      data: bytesToBase64(sealed),
    };
  }

  // No shell to hand a vault over (a standalone tab) — the passphrase still works.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(getSecret(), salt);
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
  const iv = base64ToBytes(stored.iv);
  const ciphertext = base64ToBytes(stored.data);

  if (isVaultEnvelope(stored)) {
    if (!vaultKeys) {
      throw new Error('Private workflow unlock required. Open this from Hivemind Content Studio, or sign in again, to reopen your vault.');
    }
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: asBufferSource(iv) }, vaultKeys.masterKey, asBufferSource(ciphertext),
      );
      return JSON.parse(new TextDecoder().decode(plaintext)) as T;
    } catch {
      throw new Error('Could not decrypt workflow. It was saved to a different vault than the one open here.');
    }
  }

  const key = await deriveKey(getSecret(), base64ToBytes(stored.salt), stored.iterations || PBKDF2_ITERATIONS);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBufferSource(iv) }, key, asBufferSource(ciphertext));
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    noteLegacyUnlockNeeded();
    throw new Error('Could not decrypt workflow. Unlock ComfyUI Mobile with the same passphrase used when this workflow/image was saved.');
  }
}

export async function decryptPrivateJsonFromStorage<T = unknown>(stored: unknown): Promise<T> {
  return decryptWorkflowFromStorage<T>(stored);
}

export function clearWorkflowEncryptionKey(): void {
  memorySecret = null;
  memorySecretExpiresAt = null;
  vaultKeys = null;
  clearPersistedUnlockRecord();
  emitStatusChanged();
}

export const WORKFLOW_LEGACY_UNLOCK_EVENT = LEGACY_UNLOCK_EVENT;
export const WORKFLOW_UNLOCK_TTL_MS = DEFAULT_UNLOCK_TTL_MS;
export const WORKFLOW_UNLOCK_STORAGE_KEY = PERSISTED_UNLOCK_STORAGE_KEY;
