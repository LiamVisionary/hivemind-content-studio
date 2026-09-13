import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WORKFLOW_UNLOCK_STORAGE_KEY,
  WORKFLOW_UNLOCK_TTL_MS,
  clearLegacyUnlockNeeded,
  clearWorkflowEncryptionKey,
  decryptWorkflowFromStorage,
  encryptWorkflowForStorage,
  getVaultKeyHandles,
  getWorkflowEncryptionUnlockExpiresAt,
  isEncryptedWorkflow,
  isLegacyUnlockNeeded,
  isWorkflowEncryptionUnlocked,
  setVaultKeyHandles,
  setWorkflowEncryptionKey,
} from '../workflowEncryption';

describe('workflow unlock persistence', () => {
  afterEach(() => {
    vi.useRealTimers();
    clearWorkflowEncryptionKey();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('keeps the browser unlock in the current tab session only', () => {
    vi.setSystemTime(new Date('2026-06-23T12:00:00Z'));
    setWorkflowEncryptionKey('test-passphrase');

    const raw = sessionStorage.getItem(WORKFLOW_UNLOCK_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const stored = JSON.parse(raw as string) as { secret: string; expiresAt: number };
    expect(stored.secret).toBe('test-passphrase');
    expect(stored.expiresAt - Date.now()).toBeGreaterThanOrEqual(WORKFLOW_UNLOCK_TTL_MS);
    expect(localStorage.getItem(WORKFLOW_UNLOCK_STORAGE_KEY)).toBeNull();
    expect(isWorkflowEncryptionUnlocked()).toBe(true);
    expect(getWorkflowEncryptionUnlockExpiresAt()).toBe(stored.expiresAt);
  });

  it('forgets expired tab unlock records and scrubs legacy persistent copies', () => {
    vi.setSystemTime(new Date('2026-06-23T12:00:00Z'));
    sessionStorage.setItem(WORKFLOW_UNLOCK_STORAGE_KEY, JSON.stringify({
      secret: 'expired-passphrase',
      expiresAt: Date.now() - 1,
    }));
    localStorage.setItem(WORKFLOW_UNLOCK_STORAGE_KEY, JSON.stringify({
      secret: 'legacy-persistent-passphrase',
      expiresAt: Date.now() + WORKFLOW_UNLOCK_TTL_MS,
    }));

    expect(isWorkflowEncryptionUnlocked()).toBe(false);
    expect(sessionStorage.getItem(WORKFLOW_UNLOCK_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(WORKFLOW_UNLOCK_STORAGE_KEY)).toBeNull();
  });

  it('manual lock clears tab-scoped and legacy browser unlock state', () => {
    setWorkflowEncryptionKey('test-passphrase');
    localStorage.setItem(WORKFLOW_UNLOCK_STORAGE_KEY, 'legacy-copy');
    expect(sessionStorage.getItem(WORKFLOW_UNLOCK_STORAGE_KEY)).toBeTruthy();

    clearWorkflowEncryptionKey();

    expect(isWorkflowEncryptionUnlocked()).toBe(false);
    expect(sessionStorage.getItem(WORKFLOW_UNLOCK_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(WORKFLOW_UNLOCK_STORAGE_KEY)).toBeNull();
  });
});

// The vault handoff: what the studio shell gives this surface instead of a
// passphrase it no longer has. Proves the three things that broke before —
// that a vault alone counts as unlocked, that what it writes round-trips, and
// that v1 content stamped into images already on disk is still readable.
describe('vault key handoff', () => {
  const workflow = { nodes: [{ id: 7, type: 'KSampler' }] };

  async function makeVaultKeys() {
    const masterKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const pair = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      false,
      ['encrypt', 'decrypt'],
    );
    return { masterKey, privateKey: pair.privateKey };
  }

  afterEach(() => {
    clearWorkflowEncryptionKey();
    clearLegacyUnlockNeeded();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('counts as unlocked with no passphrase anywhere', async () => {
    expect(isWorkflowEncryptionUnlocked()).toBe(false);
    setVaultKeyHandles(await makeVaultKeys());
    expect(isWorkflowEncryptionUnlocked()).toBe(true);
    expect(sessionStorage.getItem(WORKFLOW_UNLOCK_STORAGE_KEY)).toBeNull();
  });

  it('seals new content under the vault and reads it straight back', async () => {
    setVaultKeyHandles(await makeVaultKeys());
    const envelope = await encryptWorkflowForStorage(workflow);

    expect(envelope.version).toBe(2);
    expect(envelope.kdf).toBe('vault-master-key');
    expect(isEncryptedWorkflow(envelope)).toBe(true);
    // No passphrase was used, so there is nothing for a salt to salt.
    expect('salt' in envelope).toBe(false);
    await expect(decryptWorkflowFromStorage(envelope)).resolves.toEqual(workflow);
  });

  it('still reads a v1 envelope, which is stamped into files already on disk', async () => {
    setWorkflowEncryptionKey('old-passphrase');
    const legacy = await encryptWorkflowForStorage(workflow);
    expect(legacy.version).toBe(1);

    // The browser moves on to the vault and forgets the passphrase entirely.
    clearWorkflowEncryptionKey();
    setVaultKeyHandles(await makeVaultKeys());
    await expect(decryptWorkflowFromStorage(legacy)).rejects.toThrow(/unlock required/i);
    // ...and says so, so the gate can offer to take it rather than demand it.
    expect(isLegacyUnlockNeeded()).toBe(true);

    setWorkflowEncryptionKey('old-passphrase');
    await expect(decryptWorkflowFromStorage(legacy)).resolves.toEqual(workflow);
  });

  it('refuses a vault envelope belonging to a different vault', async () => {
    setVaultKeyHandles(await makeVaultKeys());
    const envelope = await encryptWorkflowForStorage(workflow);

    setVaultKeyHandles(await makeVaultKeys());
    await expect(decryptWorkflowFromStorage(envelope)).rejects.toThrow(/different vault/i);
  });

  it('drops the vault when the shell locks', async () => {
    setVaultKeyHandles(await makeVaultKeys());
    clearWorkflowEncryptionKey();
    expect(isWorkflowEncryptionUnlocked()).toBe(false);
    expect(getVaultKeyHandles()).toBeNull();
  });
});
