// What an unlock screen may show, and the salt a passkey unlock derives —
// decided once, for both screens that ask.
//
// There are two of them and they had drifted. The sign-in gate
// (`src/hivemind_content_studio/account_gate.py`, standalone because /assets is
// behind the gate it guards) led with the passkey and offered the password
// underneath. The in-app modal (`bridges/VaultUnlockModal.jsx`), which a tab
// reaches when it holds a valid session cookie but no per-tab key, only ever
// asked for a password — so one workspace opened with Touch ID on one screen
// and was told to type on the other, for the same vault, in the same browser.
//
// The gate carries the block below VERBATIM: it cannot import this bundle, and
// a mirrored rule that nothing compares is how the two drifted in the first
// place. `tests/vaultUnlockPolicy.test.js` extracts both copies and fails on
// the first character that differs, so the repair is a copy-paste, not a
// judgement call.
//
// Everything OUTSIDE the delimiters is this module's own — the export line, and
// nothing else. Add a rule inside the block or it is not shared.

// >>> vault-unlock-policy
// The rules, in full:
//
//   * A passkey the browser can actually run is the PRIMARY way in. It is the
//     only credential of the three that the authenticator itself protects.
//   * A workspace holding both shows BOTH — never one instead of the other. A
//     passkey that will not prompt here (enrolled on another device, a browser
//     without WebAuthn) must never strand someone who knows their password.
//   * A workspace with no passkey yet always carries the offer to add one, and
//     that offer starts OFF. Enrolling is a biometric prompt and a new
//     credential on this device: it happens because somebody asked for it, not
//     because a control defaulted to on.
//   * A workspace with neither usable path says so. A password form on an
//     account that has no password can only refuse.
//
// `account` is the server's own shape (`Account.public()` — snake_case, as it
// arrives from /api/accounts and /api/owner/session). `webauthn` is whatever
// the calling screen has for `window.PublicKeyCredential`.
function vaultUnlockOptions(account, webauthn) {
    const hasPasskey = Boolean(account && account.has_passkey);
    const hasPassword = Boolean(account && account.has_password);
    const supported = Boolean(webauthn);
    // Registration needs an open session, so a screen can only offer to ADD a
    // passkey where a password can open one first. The gate's sign-in card and
    // the in-app modal both qualify; a pre-sign-in button never did.
    const passkey = hasPasskey && supported;
    return {
        passkey,
        password: hasPassword,
        // Only earns its place with something on either side of it.
        divider: passkey && hasPassword,
        enrol: supported && hasPassword && !hasPasskey,
        enrolDefault: false,
        stuck: !passkey && !hasPassword,
    };
}

// Fixed per account and derived from a constant label, so the same passkey
// yields the same secret on every sign-in and on every device that syncs it.
// Changing this string would strand every PRF-wrapped vault.
const VAULT_PRF_SALT_LABEL = 'hivemind-content-studio/vault-prf/v1';

async function vaultPrfSalt(accountId) {
    const material = new TextEncoder().encode(`${VAULT_PRF_SALT_LABEL}:${accountId}`);
    return new Uint8Array(await crypto.subtle.digest('SHA-256', material));
}
// <<< vault-unlock-policy

export { VAULT_PRF_SALT_LABEL, vaultPrfSalt, vaultUnlockOptions };
