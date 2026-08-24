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
    rememberOnThisDevice,
    unlockWithDevice,
    unlockWithPassphrase,
    unlockWithPrf,
    wrapMasterKeyForPrf,
} from './e2eVault.js';

const PASSPHRASE_KEY = 'hivemind.ownerPassphrase.once';
// What the sign-in gate recorded about HOW this session was opened. A passkey
// sign-in leaves no passphrase behind, so without this the app would have a
// valid session and a permanently locked vault.
const VAULT_HINT_KEY = 'hivemind.vaultUnlock.once';
let readyPromise = null;

function readHandoff(key) {
    try {
        const parsed = JSON.parse(sessionStorage.getItem(key) || 'null');
        if (parsed && (!parsed.expiresAt || parsed.expiresAt > Date.now())) return parsed;
    } catch { /* absent or malformed */ }
    return null;
}

function readOwnerPassphrase() {
    const parsed = readHandoff(PASSPHRASE_KEY);
    return parsed?.password ? String(parsed.password) : null;
}

function fromB64url(text) {
    const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '==='.slice((padded.length + 3) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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

/**
 * Unlock a vault the way this session was signed in.
 *
 * Order matters and is not arbitrary: the PRF secret is the only one of the
 * three that the authenticator itself protects, so it is tried first; the
 * device wrap is the fallback for authenticators without PRF; the passphrase is
 * last because it is the only one present on a device that has never been used
 * before, and re-deriving it costs 600k PBKDF2 iterations.
 */
async function unlockExisting(identity, hint, passphrase) {
    if (hint?.prf && hint.credentialId) {
        if (await unlockWithPrf(identity, hint.credentialId, fromB64url(hint.prf))) return true;
    }
    if (hint?.accountId && await unlockWithDevice(identity, hint.accountId)) return true;
    if (passphrase && await unlockWithPassphrase(identity, passphrase)) {
        // Having proved the passphrase, leave a device-wrapped copy behind so
        // the NEXT sign-in on this browser can be a passkey with no password —
        // which is the whole point of the passkey-first gate.
        if (hint?.accountId) {
            await rememberOnThisDevice(identity, passphrase, hint.accountId).catch(() => false);
        }
        // The gate can register a passkey and read its PRF secret, but it
        // cannot wrap the master key — that code is here. Finish the enrolment
        // now, while both the passphrase and the secret are in hand, so the
        // user is never prompted for a second biometric later.
        await enrolPrfWrap(identity, hint, passphrase).catch(() => false);
        return true;
    }
    return false;
}

async function enrolPrfWrap(identity, hint, passphrase) {
    if (!hint?.prf || !hint.credentialId) return false;
    let existing = {};
    try {
        existing = JSON.parse(identity.wrapped_mk_prf || '{}');
    } catch { /* treat unreadable as absent and re-enrol */ }
    if (existing[hint.credentialId]) return false;
    const wrapped = await wrapMasterKeyForPrf(identity, passphrase, fromB64url(hint.prf));
    if (!wrapped) return false;
    const response = await fetch(`/api/vault/prf/${encodeURIComponent(hint.credentialId)}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wrapped_mk: wrapped }),
    });
    return response.ok;
}

async function bootstrap() {
    if (!isHivemindStudioEnabled()) return false;
    const passphrase = readOwnerPassphrase();
    const hint = readHandoff(VAULT_HINT_KEY);
    // A passkey sign-in has no passphrase but does have a hint; either alone is
    // enough to try, neither means this browser was never unlocked.
    if (!passphrase && !hint) return false;
    let payload;
    try {
        payload = await fetchIdentity();
    } catch {
        return false;
    }
    if (payload.exists && payload.identity) {
        return unlockExisting(payload.identity, hint, passphrase);
    }
    // A vault can only be CREATED from a passphrase: there is nothing yet for a
    // passkey to have been enrolled against.
    if (!passphrase) return false;
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

// Lock must not leave the per-tab passphrase handoff behind: the sign-in gate
// stashes it for 24 h and only the hub data layer used to remove it (and only
// in tabs that had visited a hub page). Called from the topbar Lock button.
export function clearOwnerHandoff() {
    try {
        sessionStorage.removeItem(PASSPHRASE_KEY);
        sessionStorage.removeItem(VAULT_HINT_KEY);
    } catch { /* storage unavailable */ }
}

// ── in-app unlock (tab has a valid owner cookie but no per-tab passphrase) ───
//
// The owner gate's lock screen never runs in that tab, so nothing stashed the
// passphrase and the vault cannot bootstrap. Any UI that hits this state can
// dispatch this event; VaultUnlockModal listens and runs the same flow as the
// gate: verify the password server-side, stash it per-tab, reload.
export const VAULT_UNLOCK_REQUEST_EVENT = 'hivemind-vault-unlock-request';

export function requestVaultUnlock() {
    try {
        window.dispatchEvent(new Event(VAULT_UNLOCK_REQUEST_EVENT));
    } catch { /* no window (tests) */ }
}

/**
 * Verify `password` against the owner gate and, on success, stash it exactly
 * like the lock screen does (same key, same 24h expiry) so a reload bootstraps
 * the vault. Returns { ok, status } — status 429 means rate-limited, anything
 * else falsy-ok means a wrong password or an unreachable gate.
 */
export async function unlockOwnerSession(password) {
    let response;
    try {
        response = await fetch('/api/owner/unlock', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        });
    } catch {
        return { ok: false, status: 0 };
    }
    if (!response.ok) return { ok: false, status: response.status };
    try {
        sessionStorage.setItem(
            PASSPHRASE_KEY,
            JSON.stringify({ password, expiresAt: Date.now() + 24 * 60 * 60 * 1000 }),
        );
    } catch { /* storage unavailable — the reload will fall back to the gate */ }
    return { ok: true, status: response.status };
}

// ── owner-session-gated ciphertext blob transport ────────────────────────────
//
// Both calls THROW on a non-OK response. A missing blob is not an error: the
// server answers 200 with `ciphertext: null` for one that was never written, so
// anything non-OK (a lapsed session, a 400, a 5xx) is a real failure. Returning
// null for a failed READ used to make a lapsed session look like an empty
// library, and the next save then replaced the whole sealed library with one
// entry; an unchecked WRITE reported "Saved" for an entry the server never kept.
async function vaultBlobError(response, fallback) {
    let detail = '';
    try {
        const payload = await response.json();
        const raw = payload?.detail ?? payload?.error ?? '';
        // FastAPI validation errors arrive as an array of { msg } objects.
        detail = Array.isArray(raw) ? raw.map((item) => item?.msg || String(item)).join(' · ') : String(raw || '');
    } catch { /* no JSON body */ }
    const error = new Error(detail || `${fallback} (${response.status})`);
    error.status = response.status;
    return error;
}

export async function getVaultBlob(namespace, key) {
    const response = await fetch(`/api/vault/blob/${namespace}/${key}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw await vaultBlobError(response, 'Could not read from your vault');
    const payload = await response.json();
    return payload.ciphertext || null;
}

export async function putVaultBlob(namespace, key, ciphertext) {
    const response = await fetch(`/api/vault/blob/${namespace}/${key}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ciphertext }),
    });
    if (!response.ok) throw await vaultBlobError(response, 'Could not write to your vault');
}
