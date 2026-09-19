const test = require('node:test');
const assert = require('node:assert/strict');

// node exposes WebCrypto as globalThis.crypto; btoa/atob are globals in node 18+.
async function loadVault() {
    return import(`../src/lib/e2eVault.js?case=${Math.random()}`);
}

test('vault: setup then encrypt/decrypt round-trips client-side', async () => {
    const v = await loadVault();
    const { identity, recoveryKey } = await v.createVaultIdentity('correct horse battery staple');
    assert.ok(identity.salt && identity.wrapped_mk_pass && identity.public_key && identity.wrapped_private_key);
    assert.match(recoveryKey, /^[A-Z2-7-]+$/);
    assert.equal(v.isVaultUnlocked(), true);

    const blob = await v.encryptJson({ prompt: 'a private prompt', references: ['/api/media-studio/references/a.png'] });
    assert.match(blob, /^v1\./);
    assert.ok(!blob.includes('private prompt'));
    assert.deepEqual(await v.decryptJson(blob), { prompt: 'a private prompt', references: ['/api/media-studio/references/a.png'] });
});

test('vault: the server-stored identity carries no plaintext key material', async () => {
    const v = await loadVault();
    const { identity } = await v.createVaultIdentity('passphrase-one');
    const serialized = JSON.stringify(identity);
    assert.ok(!serialized.includes('passphrase-one'));
    // Only opaque, wrapped fields are present.
    assert.deepEqual(
        Object.keys(identity).sort(),
        ['kdf', 'public_key', 'salt', 'wrapped_mk_pass', 'wrapped_mk_recovery', 'wrapped_private_key'],
    );
});

test('vault: unlock with the correct passphrase, reject the wrong one with no oracle', async () => {
    const v = await loadVault();
    const { identity } = await v.createVaultIdentity('right-passphrase');
    v.lockVault();
    assert.equal(v.isVaultUnlocked(), false);

    assert.equal(await v.unlockWithPassphrase(identity, 'wrong-passphrase'), false);
    assert.equal(v.isVaultUnlocked(), false);

    assert.equal(await v.unlockWithPassphrase(identity, 'right-passphrase'), true);
    assert.equal(v.isVaultUnlocked(), true);
    const blob = await v.encryptJson({ ok: 1 });
    assert.deepEqual(await v.decryptJson(blob), { ok: 1 });
});

test('vault: recovery key unlocks when the passphrase is lost', async () => {
    const v = await loadVault();
    const { identity, recoveryKey } = await v.createVaultIdentity('forgotten-later');
    const blob = await v.encryptJson({ secret: 42 });
    v.lockVault();

    assert.equal(await v.unlockWithRecoveryKey(identity, 'AAAA-BBBB-CCCC-DDDD'), false);
    assert.equal(await v.unlockWithRecoveryKey(identity, recoveryKey), true);
    assert.deepEqual(await v.decryptJson(blob), { secret: 42 });
});

test('vault: tampered ciphertext fails authentication', async () => {
    const v = await loadVault();
    await v.createVaultIdentity('tamper-test');
    const blob = await v.encryptJson({ a: 'b' });
    const parts = blob.split('.');
    const ct = v.__test.fromB64url(parts[2]);
    ct[0] ^= 0xff;
    const tampered = `${parts[0]}.${parts[1]}.${v.__test.toB64url(ct)}`;
    await assert.rejects(() => v.decryptJson(tampered));
});

test('vault: recovery base32 round-trips', async () => {
    const v = await loadVault();
    const { __test } = v;
    const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    assert.deepEqual(Array.from(__test.decodeRecovery(__test.encodeRecovery(bytes))), Array.from(bytes));
});
