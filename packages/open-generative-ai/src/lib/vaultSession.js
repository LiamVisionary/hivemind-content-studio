// Bootstraps the client-side E2E vault from the owner unlock.
//
// The studio lock screen stashes the owner password in sessionStorage for the
// browser to use (the server verifies its hash at unlock but never stores it,
// and cannot derive the vault key from the hash). This module reads that secret,
// gets-or-creates the vault identity, and unlocks it — all client-side. On first
// creation it emits the one-time recovery key for a UI banner to display.
// Once this browser holds a device wrap the passphrase is removed again, so
// the handoff lives for one bootstrap rather than 24 h.

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
    wrapMasterKeyForPrfWithDevice,
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

/**
 * The sign-in hint, with its two halves treated as the different things they
 * are.
 *
 * The gate stamps ONE 24 h expiry across the whole blob, but `prf` is a secret
 * that must lapse while `accountId` and `credentialId` are identifiers — and
 * `accountId` is the only thing the device wrap needs. Expiring it bought
 * nothing: the wrap it points at lives in IndexedDB with no expiry, and the
 * owner cookie SLIDES (control_api re-issues it past half its life), so a tab
 * in daily use keeps a valid session indefinitely. All the expiry did was
 * guarantee that every browser lost its vault exactly 24 h after sign-in, with
 * a working session, a healthy vault and a usable device wrap — and no way back
 * but retyping the password, every day.
 *
 * So the secret lapses and the identifiers do not.
 */
function readVaultHint() {
    let parsed = null;
    try {
        parsed = JSON.parse(sessionStorage.getItem(VAULT_HINT_KEY) || 'null');
    } catch { return null; }
    if (!parsed) return null;
    if (!parsed.expiresAt || parsed.expiresAt > Date.now()) return parsed;
    return { ...parsed, prf: null, expired: true };
}

function fromB64url(text) {
    const padded = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '==='.slice((padded.length + 3) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

// A failure to REACH the studio is not an answer about the vault. Marking it
// keeps ensureVaultReady from caching a restart, a sleeping laptop or one
// dropped packet as "locked" for the rest of the page load.
function transportError(message) {
    const error = new Error(message);
    error.transient = true;
    return error;
}

async function fetchIdentity() {
    let response;
    try {
        response = await fetch('/api/vault/identity', { credentials: 'same-origin', cache: 'no-store' });
    } catch {
        throw transportError('vault identity unreachable');
    }
    if (!response.ok) {
        const error = new Error(`vault identity fetch failed (${response.status})`);
        // 5xx is the server having a bad moment and worth retrying. A 4xx is a
        // real answer about this session, and retrying it on every sealed image
        // on the page would be a stampede for the same "no".
        error.transient = response.status >= 500;
        throw error;
    }
    return response.json();
}

/**
 * Retire the sign-in secrets once this browser can unlock without them.
 *
 * The gate hands the passphrase (and a passkey's PRF secret) to the app through
 * sessionStorage, where any script in the origin can read them for 24 h. The
 * device wrap makes that unnecessary the moment it exists: unlockWithDevice
 * needs only the account id. So the passphrase goes, and the hint is rewritten
 * to its identifiers — accountId for the device wrap, credentialId so a later
 * PRF enrolment still knows which passkey it was — with no secret and no
 * expiry (identifiers do not lapse; see readVaultHint). A second tab on the
 * same browser still unlocks: it reads the same hint and the same IndexedDB.
 *
 * Only ever called AFTER the wrap is confirmed written. Removing the passphrase
 * before that would leave the next reload with nothing to unlock from.
 */
function retireSignInSecrets(hint) {
    try {
        sessionStorage.removeItem(PASSPHRASE_KEY);
        if (hint?.accountId) {
            sessionStorage.setItem(VAULT_HINT_KEY, JSON.stringify({
                accountId: hint.accountId,
                credentialId: hint.credentialId || null,
                prf: null,
            }));
        }
    } catch { /* storage unavailable */ }
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
        if (await unlockWithPrf(identity, hint.credentialId, fromB64url(hint.prf))) {
            // The PRF wrap did not need the passphrase — but on a password
            // sign-in the gate stashed one anyway, and it would sit there for
            // 24 h. Spend it on a device wrap instead, then retire it: after
            // this the account id alone unlocks, so nothing is lost and an
            // injected script has nothing to take.
            if (passphrase) await finishPassphraseUnlock(identity, hint, passphrase);
            return true;
        }
    }
    if (hint?.accountId && await unlockWithDevice(identity, hint.accountId)) {
        // A device unlock has no passphrase, but it does put the master key
        // within reach — so finish the enrolment the passphrase path would have
        // done. Without this a passkey sign-in rides the device wrap forever:
        // every unlock takes the weaker path, PRF is never written, and the day
        // the wrap breaks there is nothing left but the password.
        await enrolPrfWrapFromDevice(identity, hint).catch(() => false);
        // The wrap just proved itself; nothing in sessionStorage is needed now.
        retireSignInSecrets(hint);
        return true;
    }
    if (passphrase && await unlockWithPassphrase(identity, passphrase)) {
        await finishPassphraseUnlock(identity, hint, passphrase);
        return true;
    }
    return false;
}

/**
 * What a proven passphrase leaves behind, on the unlock and first-run paths
 * alike: a device wrap, a PRF wrap where the gate handed over a secret, and —
 * once the wrap is confirmed — no passphrase in sessionStorage.
 */
async function finishPassphraseUnlock(identity, hint, passphrase) {
    // Having proved the passphrase, leave a device-wrapped copy behind so the
    // NEXT sign-in on this browser can be a passkey with no password — which
    // is the whole point of the passkey-first gate.
    let remembered = false;
    if (hint?.accountId) {
        remembered = await rememberOnThisDevice(identity, passphrase, hint.accountId).catch(() => false);
    }
    // The gate can register a passkey and read its PRF secret, but it cannot
    // wrap the master key — that code is here. Finish the enrolment now, while
    // both the passphrase and the secret are in hand, so the user is never
    // prompted for a second biometric later.
    await enrolPrfWrap(identity, hint, passphrase).catch(() => false);
    // Without a wrap (no IndexedDB, or no account id in the hint) the
    // passphrase is still the only way this tab can unlock after a reload, so
    // it stays until there is one.
    if (remembered === true) retireSignInSecrets(hint);
}

function prfWrapMissing(identity, credentialId) {
    let existing = {};
    try {
        existing = JSON.parse(identity.wrapped_mk_prf || '{}');
    } catch { /* treat unreadable as absent and re-enrol */ }
    return !existing[credentialId];
}

async function putPrfWrap(credentialId, wrapped) {
    const response = await fetch(`/api/vault/prf/${encodeURIComponent(credentialId)}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wrapped_mk: wrapped }),
    });
    return response.ok;
}

async function enrolPrfWrap(identity, hint, passphrase) {
    if (!hint?.prf || !hint.credentialId) return false;
    if (!prfWrapMissing(identity, hint.credentialId)) return false;
    const wrapped = await wrapMasterKeyForPrf(identity, passphrase, fromB64url(hint.prf));
    if (!wrapped) return false;
    return putPrfWrap(hint.credentialId, wrapped);
}

async function enrolPrfWrapFromDevice(identity, hint) {
    if (!hint?.prf || !hint.credentialId || !hint.accountId) return false;
    if (!prfWrapMissing(identity, hint.credentialId)) return false;
    const wrapped = await wrapMasterKeyForPrfWithDevice(hint.accountId, fromB64url(hint.prf));
    if (!wrapped) return false;
    return putPrfWrap(hint.credentialId, wrapped);
}

async function bootstrap() {
    if (!isHivemindStudioEnabled()) return false;
    const passphrase = readOwnerPassphrase();
    const hint = readVaultHint();
    // A passkey sign-in has no passphrase but does have a hint; either alone is
    // enough to try, neither means this browser was never unlocked. An EXPIRED
    // hint still counts: its secret is gone, but it names the account whose
    // device wrap is sitting in IndexedDB, unexpired.
    if (!passphrase && !hint) return false;
    let payload;
    try {
        payload = await fetchIdentity();
    } catch (error) {
        // Rethrown so ensureVaultReady can decline to cache it; a 4xx still
        // reads as a settled "no".
        if (error?.transient) throw error;
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
    await finishPassphraseUnlock(identity, hint, passphrase);
    announceRecoveryKey(recoveryKey);
    return true;
}

export function ensureVaultReady() {
    if (isVaultUnlocked()) return Promise.resolve(true);
    if (!readyPromise) {
        readyPromise = bootstrap().catch((error) => {
            // "This vault cannot be unlocked here" is a stable answer and is
            // worth caching for the page load. "I could not reach the studio"
            // is not: caching it pinned the vault locked until a manual reload,
            // with a valid session, healthy keys and a working API one second
            // later. Clear the slot so the next caller retries.
            if (error?.transient) readyPromise = null;
            return false;
        });
    }
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
 * Verify `password` against the signed-in workspace and, on success, stash it
 * exactly like the gate does (same key, same 24h expiry) so a reload bootstraps
 * the vault. Returns { ok, status } — status 429 means rate-limited, anything
 * else falsy-ok means a wrong password, a lapsed session, or an unreachable
 * gate. The workspace is whichever one the session cookie names: the gate's
 * unlock route needs an account id, and /api/owner/session is what knows it.
 */
export async function unlockOwnerSession(password) {
    let response;
    try {
        const session = await fetch('/api/owner/session', { credentials: 'same-origin', cache: 'no-store' });
        const current = session.ok ? await session.json().catch(() => null) : null;
        const accountId = current?.unlocked ? current?.account?.id : null;
        if (accountId == null) return { ok: false, status: session.ok ? 401 : session.status };
        response = await fetch('/api/accounts/unlock', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account_id: accountId, password }),
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
