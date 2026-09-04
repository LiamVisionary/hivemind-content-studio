// Forgetting a password used to lose the library.
//
// The recovery-key modal told people this key was the only way back, the crypto
// to use it existed, and no screen anywhere accepted one. These tests cover the
// chain that closes it end to end, in both places it runs: the app bundle
// (e2eVault.js, for Settings) and the sign-in gate, which cannot load the bundle
// — /assets is gated — and so carries its own copy of the same crypto.
//
// The load-bearing constraint throughout: possession of a vault is proved by
// DECRYPTING a nonce, never by signing one. The vault keypair is RSA-OAEP with
// encrypt/decrypt usages only, and WebCrypto refuses to sign with it.
//
// Deliberately textual: the sign-in gate is a standalone HTML page built
// outside React (the app bundle lives behind the gate it guards), so there is
// no component here to mount.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GATE = path.join(__dirname, '..', '..', '..', 'src', 'hivemind_content_studio', 'account_gate.py');

async function loadVault() {
    return import(`../src/lib/e2eVault.js?case=${Math.random()}`);
}

const fromB64url = (text) => Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const toB64url = (bytes) => Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** What the server does with the vault's public key, in the same shape. */
async function sealNonce(identity, nonce) {
    const key = await crypto.subtle.importKey(
        'spki', fromB64url(identity.public_key),
        { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'],
    );
    return toB64url(new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, nonce)));
}

/**
 * The gate's inlined recovery crypto, taken from the source it actually ships.
 *
 * This is the whole point of extracting it rather than re-implementing it: the
 * gate cannot import e2eVault.js, so the only thing standing between the two
 * copies and a silent divergence — a different iteration count, a different
 * wrap format — is a test that runs the shipped one.
 */
function gateRecovery() {
    const source = fs.readFileSync(GATE, 'utf8');
    const start = source.indexOf('// >>> vault-recovery-crypto');
    const end = source.indexOf('// <<< vault-recovery-crypto');
    assert.ok(start > 0 && end > start, 'the gate still marks its recovery-crypto block');
    const block = source.slice(start, end);
    // eslint-disable-next-line no-new-func — evaluating the shipped source is the test
    return new Function(`${block}\nreturn vaultRecovery;`)();
}

test('recovery: the whole chain — forget the passphrase, come back with the key', async () => {
    const v = await loadVault();
    const { identity, recoveryKey } = await v.createVaultIdentity('the-forgotten-one');
    const sealed = await v.encryptJson({ prompt: 'a private prompt', seed: 7 });
    v.lockVault();

    // 1. The server hands over the recovery half and a nonce sealed to the vault.
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const challenge = await sealNonce(identity, nonce);

    // 2. The recovery key opens the vault; a wrong one does not.
    assert.equal(await v.unlockWithRecoveryKey(identity, 'AAAA-BBBB-CCCC-DDDD'), false);
    assert.equal(await v.unlockWithRecoveryKey(identity, recoveryKey), true);

    // 3. Possession is proved by decryption.
    assert.equal(await v.decryptChallengeNonce(challenge), toB64url(nonce));

    // 4. The master key is re-wrapped under a new passphrase — new salt, new key.
    const wrap = await v.rewrapForPassphrase(identity, { recoveryKey }, 'a-brand-new-password');
    assert.ok(wrap.salt && wrap.wrapped_mk_pass);
    assert.notEqual(wrap.salt, identity.salt);
    assert.notEqual(wrap.wrapped_mk_pass, identity.wrapped_mk_pass);
    assert.equal(wrap.kdf, v.__test.KDF);

    // 5. The stored identity keeps everything else — the master key never changed.
    const updated = { ...identity, ...wrap };
    assert.equal(updated.public_key, identity.public_key);
    assert.equal(updated.wrapped_private_key, identity.wrapped_private_key);
    assert.equal(updated.wrapped_mk_recovery, identity.wrapped_mk_recovery);

    // 6. The new passphrase unlocks, the old one does not, and the blob sealed
    //    before any of this still opens.
    v.lockVault();
    assert.equal(await v.unlockWithPassphrase(updated, 'the-forgotten-one'), false);
    assert.equal(await v.unlockWithPassphrase(updated, 'a-brand-new-password'), true);
    assert.deepEqual(await v.decryptJson(sealed), { prompt: 'a private prompt', seed: 7 });
});

test('recovery: a wrong recovery key re-wraps nothing, with no server round trip', async () => {
    const v = await loadVault();
    const { identity } = await v.createVaultIdentity('still-known');
    v.lockVault();
    assert.equal(await v.rewrapForPassphrase(identity, { recoveryKey: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' }, 'nope'), null);
    assert.equal(await v.rewrapForPassphrase(identity, { passphrase: 'not-the-password' }, 'nope'), null);
});

test('change password: the old passphrase re-wraps, and every other way in survives', async () => {
    const v = await loadVault();
    const { identity, recoveryKey } = await v.createVaultIdentity('old-password');
    const sealed = await v.encryptJson({ keep: 'me' });
    // A passkey's PRF wrap, written before the change.
    const prfWrap = await v.wrapMasterKeyForPrf(identity, 'old-password', new Uint8Array(32).fill(9));
    const withPrf = { ...identity, wrapped_mk_prf: JSON.stringify({ 'cred-1': prfWrap }) };

    const wrap = await v.rewrapForPassphrase(withPrf, { passphrase: 'old-password' }, 'new-password');
    const updated = { ...withPrf, ...wrap };
    v.lockVault();

    assert.equal(await v.unlockWithPassphrase(updated, 'new-password'), true);
    assert.deepEqual(await v.decryptJson(sealed), { keep: 'me' });
    // The passkey wrap and the recovery key wrap the SAME master key, which did
    // not change — so a password change must not have cost either of them.
    v.lockVault();
    assert.equal(await v.unlockWithPrf(updated, 'cred-1', new Uint8Array(32).fill(9)), true);
    v.lockVault();
    assert.equal(await v.unlockWithRecoveryKey(updated, recoveryKey), true);
});

test('a new recovery key retires the old one and leaves sealed content alone', async () => {
    const v = await loadVault();
    const { identity, recoveryKey } = await v.createVaultIdentity('kept-password');
    const sealed = await v.encryptJson({ still: 'here' });

    const minted = await v.rewrapForRecovery(identity, { passphrase: 'kept-password' });
    assert.match(minted.recoveryKey, /^[A-Z2-7-]+$/);
    assert.notEqual(minted.recoveryKey, recoveryKey);
    const updated = { ...identity, wrapped_mk_recovery: minted.wrapped_mk_recovery };

    v.lockVault();
    assert.equal(await v.unlockWithRecoveryKey(updated, recoveryKey), false, 'the old key is dead');
    assert.equal(await v.unlockWithRecoveryKey(updated, minted.recoveryKey), true);
    assert.deepEqual(await v.decryptJson(sealed), { still: 'here' });
    // The passphrase is untouched by minting a recovery key.
    v.lockVault();
    assert.equal(await v.unlockWithPassphrase(updated, 'kept-password'), true);
});

test('the gate’s own copy of the crypto matches e2eVault, byte for byte in effect', async () => {
    const v = await loadVault();
    const gate = gateRecovery();
    assert.equal(gate.KDF, v.__test.KDF, 'same KDF label, so the same iteration count');
    assert.deepEqual(
        Array.from(gate.decodeRecovery('ABCD-EFGH')),
        Array.from(v.__test.fromB64url(v.__test.toB64url(gate.decodeRecovery('abcd efgh')))),
        'the same base32, case- and separator-insensitive',
    );

    const { identity, recoveryKey } = await v.createVaultIdentity('gate-forgotten');
    const sealed = await v.encryptJson({ from: 'before the reset' });
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const payload = {
        salt: identity.salt,
        wrapped_mk_recovery: identity.wrapped_mk_recovery,
        wrapped_private_key: identity.wrapped_private_key,
        nonce: await sealNonce(identity, nonce),
    };
    v.lockVault();

    assert.equal(await gate.open(payload, 'AAAA-BBBB-CCCC-DDDD'), null, 'a wrong key opens nothing');
    const opened = await gate.open(payload, recoveryKey);
    assert.equal(opened.nonce, toB64url(nonce), 'the gate proves possession by decrypting');

    const wrap = await gate.rewrap(opened.masterKey, 'set-from-the-gate');
    // The decisive assertion: a wrap produced by the GATE is one the app bundle
    // can unlock. If either copy drifted, this is where it shows.
    const updated = { ...identity, ...wrap };
    assert.equal(await v.unlockWithPassphrase(updated, 'set-from-the-gate'), true);
    assert.deepEqual(await v.decryptJson(sealed), { from: 'before the reset' });
});

test('the gate offers a way in for someone who forgot, and asks for the key', () => {
    const source = fs.readFileSync(GATE, 'utf8');
    assert.match(source, /id="forgot"[^>]*>Forgot your password\?/);
    assert.match(source, /id="recover-key"/, 'a field for the recovery key');
    assert.match(source, /\/api\/accounts\/recovery\/challenge/);
    assert.match(source, /\/api\/accounts\/recovery\/reset/);
    // The passphrase-wrapped key is the one thing the pre-auth exchange must
    // never involve; the gate never so much as names it.
    assert.doesNotMatch(source, /wrapped_mk_pass'/, 'the gate reads no passphrase wrap');
});
