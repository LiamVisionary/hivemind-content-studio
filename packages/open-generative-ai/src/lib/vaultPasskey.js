// The two WebAuthn ceremonies the APP runs, from inside a session that exists.
//
// The gate keeps its own copies of these because it cannot load this bundle.
// What neither may have a second copy of is the PRF salt and the rule about
// which controls a screen shows — both live in vaultUnlockPolicy.js, and both
// screens read them from there.
//
// The two are not the same shape:
//
//   * ASSERTION (unlock). Scoped to the signed-in workspace by passing its
//     account id, so the browser can only offer a credential that opens THIS
//     one. An assertion for another workspace would be accepted by the server
//     and would re-issue the session cookie for it — moving the tab to a
//     different vault mid-unlock, which is exactly the class of bug that seals
//     one workspace's clips to another's key.
//   * REGISTRATION (the "add a passkey" offer). Only ever possible here. The
//     server refuses to register a credential without a session, which is why
//     the gate's sign-in card has no such button: before sign-in it could only
//     refuse.
//
// Neither wraps the master key — that code is in e2eVault.js and needs a secret
// this module does not hold. Both hand their PRF reading to the vault handoff
// instead (vaultSession.stashVaultHint), and the bootstrap does the wrap while
// the passphrase or the device wrap is in reach.
//
// Every failure comes back as a `reason` the caller turns into a sentence —
// never as server text: 'unsupported', 'cancelled', 'offline', 'mismatch',
// 'failed'.
// The b64url pair is imported rather than written a fourth time; recoverWithKey
// is where this package already exports them.
import { fromB64url, toB64url } from './recoverWithKey.js';
import { vaultPrfSalt } from './vaultUnlockPolicy.js';

export function passkeysAvailable() {
    return Boolean(globalThis.PublicKeyCredential);
}

/**
 * Every call POSTs a body, even an empty one. `api(path)` with no body would be
 * a GET, and a GET to a POST-only /api path is a full match for the static
 * mount at the bottom of control_api.py — it answers a bare 404 rather than a
 * 405, which is how this reads as "Not Found" instead of "wrong method".
 */
async function api(path, body) {
    let response;
    try {
        response = await fetch(path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
        });
    } catch {
        const error = new Error('offline');
        error.reason = 'offline';
        throw error;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.detail || 'That did not work.');
        error.reason = response.status === 401 ? 'refused' : 'failed';
        throw error;
    }
    return payload;
}

// A cancelled prompt is a decision, not a fault: the person pressed escape or
// dismissed Touch ID. It gets its own reason so no screen tells them something
// went wrong.
function ceremonyReason(error) {
    if (error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) return 'cancelled';
    return error?.reason || 'failed';
}

const withChallenge = (publicKey) => ({
    ...publicKey,
    challenge: fromB64url(publicKey.challenge),
    allowCredentials: (publicKey.allowCredentials || []).map((entry) => ({
        ...entry, id: fromB64url(entry.id),
    })),
});

/**
 * Prove a passkey for `accountId`, and read its PRF secret where the
 * authenticator has one.
 *
 * `prf` null is not a failure: plenty of authenticators have no PRF extension,
 * and the vault falls back to this browser's device wrap. It IS the difference
 * between a passkey that decrypts and a passkey that only opens the door, so
 * the caller is told which it got.
 */
export async function assertPasskey(accountId) {
    if (!passkeysAvailable()) return { ok: false, reason: 'unsupported' };
    try {
        const { publicKey } = await api('/api/accounts/webauthn/authenticate/options', { account_id: accountId });
        const salt = await vaultPrfSalt(accountId);
        const credential = await navigator.credentials.get({
            publicKey: { ...withChallenge(publicKey), extensions: { prf: { eval: { first: salt } } } },
        });
        if (!credential) return { ok: false, reason: 'cancelled' };
        const results = credential.getClientExtensionResults?.() || {};
        const secret = results.prf?.results?.first || null;
        const payload = await api('/api/accounts/webauthn/authenticate', {
            credential_id: credential.id,
            client_data_json: toB64url(credential.response.clientDataJSON),
            authenticator_data: toB64url(credential.response.authenticatorData),
            signature: toB64url(credential.response.signature),
        });
        // allowCredentials was scoped to this workspace, so this should be
        // unreachable — but the cookie has already moved if it is not, and a
        // tab quietly holding another workspace's session is worse than a
        // sentence saying so.
        if (payload.account?.id !== accountId) return { ok: false, reason: 'mismatch' };
        return {
            ok: true,
            accountId: payload.account.id,
            credentialId: credential.id,
            prf: secret ? toB64url(secret) : null,
        };
    } catch (error) {
        return { ok: false, reason: ceremonyReason(error) };
    }
}

/**
 * Register a passkey for the signed-in workspace, then take ONE reading of its
 * PRF secret.
 *
 * The reading is the point. The master key can only be wrapped by code holding
 * a secret that opens it, which happens in the bootstrap a moment later — so
 * the secret is read here, while the authenticator is already awake, and
 * carried forward. Without it enrolment would cost a second biometric prompt
 * on some later page load, or never happen at all.
 */
export async function registerPasskey(accountId, { label = 'This device' } = {}) {
    if (!passkeysAvailable()) return { ok: false, reason: 'unsupported' };
    try {
        const { publicKey } = await api('/api/accounts/webauthn/register/options', {});
        const salt = await vaultPrfSalt(accountId);
        const created = await navigator.credentials.create({
            publicKey: {
                ...publicKey,
                challenge: fromB64url(publicKey.challenge),
                user: { ...publicKey.user, id: fromB64url(publicKey.user.id) },
                excludeCredentials: (publicKey.excludeCredentials || []).map((entry) => ({
                    ...entry, id: fromB64url(entry.id),
                })),
                extensions: { prf: { eval: { first: salt } } },
            },
        });
        if (!created) return { ok: false, reason: 'cancelled' };
        const spki = created.response.getPublicKey && created.response.getPublicKey();
        if (!spki) return { ok: false, reason: 'keytype' };
        const extensions = created.getClientExtensionResults?.() || {};
        const prfCapable = Boolean(extensions.prf && (extensions.prf.enabled || extensions.prf.results));
        await api('/api/accounts/webauthn/register', {
            credential_id: created.id,
            public_key: toB64url(spki),
            algorithm: created.response.getPublicKeyAlgorithm(),
            client_data_json: toB64url(created.response.clientDataJSON),
            label,
            prf: prfCapable,
        });
        let secret = null;
        if (prfCapable) {
            try {
                const options = await api('/api/accounts/webauthn/authenticate/options', { account_id: accountId });
                const assertion = await navigator.credentials.get({
                    publicKey: { ...withChallenge(options.publicKey), extensions: { prf: { eval: { first: salt } } } },
                });
                secret = assertion?.getClientExtensionResults?.()?.prf?.results?.first || null;
            } catch {
                // No reading available. The credential is registered and real;
                // it just rides the device wrap instead of its own, which is
                // the documented fallback rather than a failure to report.
                secret = null;
            }
        }
        return { ok: true, credentialId: created.id, prf: secret ? toB64url(secret) : null };
    } catch (error) {
        return { ok: false, reason: ceremonyReason(error) };
    }
}
