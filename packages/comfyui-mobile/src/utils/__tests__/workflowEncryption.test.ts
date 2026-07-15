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
  });

  it('persists the browser unlock for at least four hours', () => {
    vi.setSystemTime(new Date('2026-06-23T12:00:00Z'));
    setWorkflowEncryptionKey('test-passphrase');

    const raw = localStorage.getItem(WORKFLOW_UNLOCK_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const stored = JSON.parse(raw as string) as { secret: string; expiresAt: number };
    expect(stored.secret).toBe('test-passphrase');
    expect(stored.expiresAt - Date.now()).toBeGreaterThanOrEqual(WORKFLOW_UNLOCK_TTL_MS);
    expect(isWorkflowEncryptionUnlocked()).toBe(true);
    expect(getWorkflowEncryptionUnlockExpiresAt()).toBe(stored.expiresAt);
  });

  it('forgets expired browser unlock records', () => {
    vi.setSystemTime(new Date('2026-06-23T12:00:00Z'));
    localStorage.setItem(WORKFLOW_UNLOCK_STORAGE_KEY, JSON.stringify({
      secret: 'expired-passphrase',
      expiresAt: Date.now() - 1,
    }));

    expect(isWorkflowEncryptionUnlocked()).toBe(false);
    expect(localStorage.getItem(WORKFLOW_UNLOCK_STORAGE_KEY)).toBeNull();
  });

  it('manual lock clears persisted browser unlock state', () => {
    setWorkflowEncryptionKey('test-passphrase');
    expect(localStorage.getItem(WORKFLOW_UNLOCK_STORAGE_KEY)).toBeTruthy();

    clearWorkflowEncryptionKey();

    expect(isWorkflowEncryptionUnlocked()).toBe(false);
    expect(localStorage.getItem(WORKFLOW_UNLOCK_STORAGE_KEY)).toBeNull();
  });
});
