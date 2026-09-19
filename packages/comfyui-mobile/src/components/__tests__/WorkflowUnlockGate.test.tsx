// What the unlock gate actually PUTS ON SCREEN in each state.
//
// This used to have one state — a full-screen wall — which is the bug: the
// studio shell signs you in, cannot hand over a passphrase it deliberately
// retired, and the canvas demanded one anyway. These three cases are the
// contract now: the vault unlocks it silently, a locked canvas stays out of
// the way, and only content that genuinely needs the old passphrase asks —
// as a dismissible offer, never a wall.
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkflowUnlockGate } from '../WorkflowUnlockGate';
import {
  clearLegacyUnlockNeeded,
  clearWorkflowEncryptionKey,
  decryptWorkflowFromStorage,
  encryptWorkflowForStorage,
  setVaultKeyHandles,
  setWorkflowEncryptionKey,
} from '@/utils/workflowEncryption';

async function makeVaultKeys() {
  const masterKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    false,
    ['encrypt', 'decrypt'],
  );
  return { masterKey, privateKey: pair.privateKey };
}

describe('WorkflowUnlockGate rendering', () => {
  afterEach(() => {
    clearWorkflowEncryptionKey();
    clearLegacyUnlockNeeded();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('renders nothing at all while locked and unneeded', () => {
    expect(renderToStaticMarkup(<WorkflowUnlockGate />)).toBe('');
  });

  it('shows only the unlocked badge once the shell hands over the vault', async () => {
    setVaultKeyHandles(await makeVaultKeys());
    const html = renderToStaticMarkup(<WorkflowUnlockGate />);

    expect(html).toContain('Private workflows unlocked');
    // The wall is the thing that must not come back.
    expect(html).not.toContain('Unlock passphrase');
    expect(html).not.toContain('<form');
    // The shell owns this unlock, so this frame must not offer to drop it.
    expect(html).toContain('disabled');
  });

  it('offers — does not demand — a passphrase once legacy content needs one', async () => {
    setWorkflowEncryptionKey('old-passphrase');
    const legacy = await encryptWorkflowForStorage({ nodes: [] });
    clearWorkflowEncryptionKey();
    setVaultKeyHandles(await makeVaultKeys());
    await expect(decryptWorkflowFromStorage(legacy)).rejects.toThrow();

    // The vault is open, so this is still the badge — the vault covers
    // everything except the old envelope, and that is not worth a wall.
    const html = renderToStaticMarkup(<WorkflowUnlockGate />);
    expect(html).toContain('Private workflows unlocked');
    expect(html).not.toContain('<form');

    // With no vault either, it becomes a dismissible pill and still not a wall.
    setVaultKeyHandles(null);
    const lockedHtml = renderToStaticMarkup(<WorkflowUnlockGate />);
    expect(lockedHtml).toContain('Unlock older private items');
    expect(lockedHtml).not.toContain('<form');
  });
});
