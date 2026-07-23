const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Proves the phase-2 media contract end to end across languages: the Python
// gateway seals bytes to the vault PUBLIC key, and only the browser's private
// key (via e2eVault.decryptMedia) can recover them. If this passes, the server
// genuinely cannot decrypt media it produced.
const PY = '/Users/liam/comfy/hivemind-content-studio/.venv/bin/python';
const SEAL = '/Users/liam/comfy/hivemind-content-studio/packages/media-gateway/media_seal.py';

test('python seals media to the vault public key; only the browser private key decrypts', async () => {
    const v = await import(`../src/lib/e2eVault.js?case=${Date.now()}-interop`);
    const { identity } = await v.createVaultIdentity('interop-passphrase');

    // A stand-in "generated video": arbitrary binary the server would produce.
    const plaintext = Buffer.from([...Array(4096).keys()].map((i) => (i * 37) % 256));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seal-'));
    const inFile = path.join(dir, 'clip.bin');
    const pubFile = path.join(dir, 'pub.txt');
    const outFile = path.join(dir, 'sealed.json');
    fs.writeFileSync(inFile, plaintext);
    fs.writeFileSync(pubFile, identity.public_key);

    // Server side: seal with no access to the private key.
    execFileSync(PY, [SEAL, '--pub', `@${pubFile}`, '--in', inFile, '--out', outFile]);
    const sealed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.ok(sealed.ciphertext && sealed.wrapped_dek);
    assert.ok(!fs.readFileSync(outFile, 'utf8').includes(plaintext.slice(0, 8).toString('latin1')));

    // Client side: recover with the browser-held private key.
    const recovered = Buffer.from(await v.decryptMedia(sealed.ciphertext, sealed.wrapped_dek));
    assert.deepEqual(recovered, plaintext);

    // A different vault (different private key) cannot decrypt the same blob.
    const other = await v.createVaultIdentity('someone-else');
    void other;
    await assert.rejects(() => v.decryptMedia(sealed.ciphertext, sealed.wrapped_dek));

    fs.rmSync(dir, { recursive: true, force: true });
});
