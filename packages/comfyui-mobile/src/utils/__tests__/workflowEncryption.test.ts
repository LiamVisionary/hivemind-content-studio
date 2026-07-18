import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WORKFLOW_UNLOCK_STORAGE_KEY,
  WORKFLOW_UNLOCK_TTL_MS,
  clearWorkflowEncryptionKey,
  getWorkflowEncryptionUnlockExpiresAt,
  isWorkflowEncryptionUnlocked,
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
