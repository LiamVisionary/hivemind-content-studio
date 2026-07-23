// Bootstraps the client-side E2E vault from the owner unlock.
//
// The studio lock screen stashes the owner password in sessionStorage for the
// browser to use (the server verifies its hash at unlock but never stores it,
// and cannot derive the vault key from the hash). This module reads that secret,
// gets-or-creates the vault identity, and unlocks it — all client-side. On first
// creation it emits the one-time recovery key for a UI banner to display.

import { isHivemindStudioEnabled } from './hivemindStudio.js';
import {
    createVaultIdentity,
    isVaultUnlocked,
    lockVault,
    unlockWithPassphrase,
} from './e2eVault.js';

const PASSPHRASE_KEY = 'hivemind.ownerPassphrase.once';
let readyPromise = null;

function readOwnerPassphrase() {
    try {
        const parsed = JSON.parse(sessionStorage.getItem(PASSPHRASE_KEY) || 'null');
        if (parsed && parsed.password && (!parsed.expiresAt || parsed.expiresAt > Date.now())) {
            return String(parsed.password);
        }
    } catch { /* absent or malformed */ }
    return null;
}

async function fetchIdentity() {
    const response = await fetch('/api/vault/identity', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(`vault identity fetch failed (${response.status})`);
    return response.json();
}

function announceRecoveryKey(recoveryKey) {
    // The recovery key is shown exactly once — the server never has it, so if the
    // owner loses both it and the passphrase the content is unrecoverable.
    try {
        window.dispatchEvent(new CustomEvent('hivemind-vault-recovery-key', { detail: { recoveryKey } }));
    } catch { /* no window (tests) */ }
}

async function bootstrap() {
    if (!isHivemindStudioEnabled()) return false;
    const passphrase = readOwnerPassphrase();
    if (!passphrase) return false; // not unlocked in this browser; caller falls back to no-persist
    let payload;
    try {
        payload = await fetchIdentity();
    } catch {
        return false;
    }
    if (payload.exists && payload.identity) {
        return unlockWithPassphrase(payload.identity, passphrase);
    }
    // First run: create the vault and register only its wrapped/public material.
    const { identity, recoveryKey } = await createVaultIdentity(passphrase);
    const put = await fetch('/api/vault/identity', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity }),
    });
    if (put.status === 409) {
        // Raced another tab that created it first — unlock against the winner.
        lockVault();
        const fresh = await fetchIdentity();
        return fresh.identity ? unlockWithPassphrase(fresh.identity, passphrase) : false;
    }
    if (!put.ok) { lockVault(); return false; }
    announceRecoveryKey(recoveryKey);
    return true;
}

export function ensureVaultReady() {
    if (isVaultUnlocked()) return Promise.resolve(true);
    if (!readyPromise) readyPromise = bootstrap().catch(() => false);
    return readyPromise;
}

export function resetVaultSession() {
    readyPromise = null;
    lockVault();
}

// ── owner-session-gated ciphertext blob transport ────────────────────────────
export async function getVaultBlob(namespace, key) {
    const response = await fetch(`/api/vault/blob/${namespace}/${key}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload.ciphertext || null;
}

export async function putVaultBlob(namespace, key, ciphertext) {
    await fetch(`/api/vault/blob/${namespace}/${key}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ciphertext }),
    });
}
