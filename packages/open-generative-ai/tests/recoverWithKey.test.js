// The browser-side recovery contract: a pasted private key opens exactly the
// envelopes sealed to it, probing stops at the DEK, and a re-seal produces an
// envelope in the gateway's wire format that the new recipient opens.
const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
globalThis.crypto = globalThis.crypto || webcrypto;

const subtle = globalThis.crypto.subtle;

async function keypair() {
    return subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
}
function pemOf(der, label) {
    const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
    return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}
// Seal exactly as media_seal.py / the gateway do: AES-GCM payload, iv||dek wrapped RSA-OAEP-SHA256.
async function sealTo(publicKey, plain, lib) {
    const dek = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await subtle.importKey('raw', dek, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, k, plain);
    const joined = new Uint8Array(44); joined.set(iv, 0); joined.set(dek, 12);
    const wrapped = await subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, joined);
    return { v: 1, media_type: 'video/mp4', wrapped_dek: lib.toB64url(wrapped), ciphertext: lib.toB64url(ct) };
}

test('a PKCS#8 key opens only what was sealed to it, and probing stops at the DEK', async () => {
    const lib = await import('../src/lib/recoverWithKey.js');
    const a = await keypair(), b = await keypair();
    const plain = Buffer.from([...Array(2048).keys()].map((i) => (i * 31) % 256));
    const sealedToA = await sealTo(a.publicKey, plain, lib);
    const sealedToB = await sealTo(b.publicKey, plain, lib);

    const pemA = pemOf(await subtle.exportKey('pkcs8', a.privateKey), 'PRIVATE KEY');
    const keyA = await lib.importPrivateKeyPem(pemA);
    assert.equal(await lib.keyOpens(sealedToA, keyA), true);
    assert.equal(await lib.keyOpens(sealedToB, keyA), false, 'a foreign envelope must refuse');

    // The fingerprint is the gateway's: sha256 over the base64url SPKI, first 32 hex.
    const spki = lib.toB64url(await subtle.exportKey('spki', a.publicKey));
    const expected = Buffer.from(await subtle.digest('SHA-256', Buffer.from(spki))).toString('hex').slice(0, 32);
    assert.equal(await lib.keyFingerprint(keyA, pemA), expected);
});

test('a PKCS#1 key is refused with the conversion, not guessed at', async () => {
    const lib = await import('../src/lib/recoverWithKey.js');
    await assert.rejects(() => lib.importPrivateKeyPem('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----'), /PKCS#1.*openssl pkcs8/);
    await assert.rejects(() => lib.importPrivateKeyPem('not a key'), /Not a PEM/);
});

test('re-sealing moves a clip to a new recipient without changing its bytes', async () => {
    const lib = await import('../src/lib/recoverWithKey.js');
    const lost = await keypair(), vault = await keypair();
    const plain = Buffer.from('ftypmp42 the actual clip bytes, verbatim');
    const sealedToLost = await sealTo(lost.publicKey, plain, lib);
    const lostKey = await lib.importPrivateKeyPem(pemOf(await subtle.exportKey('pkcs8', lost.privateKey), 'PRIVATE KEY'));
    const vaultSpki = lib.toB64url(await subtle.exportKey('spki', vault.publicKey));

    const fresh = await lib.reseal(sealedToLost, lostKey, vaultSpki);
    assert.equal(fresh.v, 1); assert.equal(fresh.media_type, 'video/mp4');
    assert.equal(lib.fromB64url(fresh.wrapped_dek).byteLength, 256, 'RSA-2048 wrap');
    // The vault opens it (this is what e2eVault.decryptMedia does)...
    const raw = await subtle.decrypt({ name: 'RSA-OAEP' }, vault.privateKey, lib.fromB64url(fresh.wrapped_dek));
    const dek = await subtle.importKey('raw', raw.slice(12), { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const out = Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(raw.slice(0, 12)) }, dek, lib.fromB64url(fresh.ciphertext)));
    assert.deepEqual(out, plain);
    // ...and the lost key no longer does.
    assert.equal(await lib.keyOpens(fresh, lostKey), false);
});

test('scanForKey sorts a library into opens / refuses / not-sealed and reports progress', async () => {
    const lib = await import('../src/lib/recoverWithKey.js');
    const a = await keypair(), b = await keypair();
    const keyA = await lib.importPrivateKeyPem(pemOf(await subtle.exportKey('pkcs8', a.privateKey), 'PRIVATE KEY'));
    const env = { 'u/a': await sealTo(a.publicKey, Buffer.from('x'), lib), 'u/b': await sealTo(b.publicKey, Buffer.from('y'), lib), 'u/plain': null };
    const ticks = [];
    const r = await lib.scanForKey([{ id: 1, url: 'u/a' }, { id: 2, url: 'u/b' }, { id: 3, url: 'u/plain' }], keyA, async (u) => env[u], (p) => ticks.push(p));
    assert.deepEqual([r.opens.map((x) => x.id), r.refuses.map((x) => x.id), r.skipped.map((x) => x.id)], [[1], [2], [3]]);
    assert.equal(ticks.length, 3); assert.equal(ticks[2].opens, 1);
});
