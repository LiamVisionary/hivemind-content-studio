const test = require('node:test');
const assert = require('node:assert/strict');

// Our own download button already used the model-derived name from
// downloadNames.js, but the browser's OWN paths — right-click "Save image as…"
// and the native <video> download control — knew nothing about it, because a
// blob: URL carries no filename. Backing the object URL with a named File is what
// makes those agree. These run the REAL decrypt path, sealing an envelope here the
// same way the server does, so the assertion is about actual behaviour.

const toB64url = (bytes) => Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let vaultIdentity = null;
global.window = { __HIVEMIND_STUDIO__: 1, location: { search: '' }, dispatchEvent() {} };
global.sessionStorage = {
    getItem: () => JSON.stringify({ password: 'test-only-passphrase', expiresAt: Date.now() + 60_000 }),
    setItem() {}, removeItem() {},
};

// Captures what each object URL was built from.
let lastObjectUrlSource = null;
let counter = 0;
global.URL.createObjectURL = (payload) => { lastObjectUrlSource = payload; return `blob:test/${++counter}`; };
global.URL.revokeObjectURL = () => {};

/** Seal bytes to the vault's public key exactly as media_seal.py does. */
async function sealMedia(publicKeySpkiB64, bytes) {
    const spki = Buffer.from(publicKeySpkiB64, 'base64');
    const publicKey = await crypto.subtle.importKey(
        'spki', spki, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const dekRaw = crypto.getRandomValues(new Uint8Array(32));
    const dek = await crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, bytes);
    const wrapped = await crypto.subtle.encrypt(
        { name: 'RSA-OAEP' }, publicKey, Buffer.concat([Buffer.from(iv), Buffer.from(dekRaw)]),
    );
    return { ciphertext: toB64url(new Uint8Array(ciphertext)), wrapped_dek: toB64url(new Uint8Array(wrapped)) };
}

function serveEnvelope(envelope) {
    global.fetch = async (url) => {
        if (String(url).includes('/api/vault/identity')) {
            return { ok: true, status: 200, json: async () => (vaultIdentity ? { exists: true, identity: vaultIdentity } : { exists: false }) };
        }
        return {
            ok: true,
            status: 200,
            headers: { get: (name) => (name === 'X-E2E-Media' ? '1' : 'application/vnd.hivemind.e2e+json') },
            json: async () => envelope,
            body: null,
        };
    };
}

async function setup(mediaType, bytes) {
    const vault = await import('../src/lib/e2eVault.js');
    if (!vaultIdentity) {
        const created = await vault.createVaultIdentity('test-only-passphrase');
        vaultIdentity = created.identity;
    }
    const sealed = await sealMedia(vaultIdentity.public_key, bytes);
    serveEnvelope({ ...sealed, media_type: mediaType });
}

test('the decrypted media File carries the registered model-derived name', async () => {
    const media = await import('../src/lib/e2eMedia.js');
    await setup('image/png', new Uint8Array([137, 80, 78, 71]));
    media.clearResolvedMediaCache();
    lastObjectUrlSource = null;

    const url = '/api/media-studio/generated/opaque-xyz.png';
    media.registerMediaDownloadName(url, 'wai-anima-abc123.png');
    assert.equal(media.mediaDownloadNameFor(url), 'wai-anima-abc123.png');

    const resolved = await media.resolveMediaSrc(url);

    assert.match(resolved, /^blob:/, 'the media should have decrypted to a blob URL');
    assert.equal(
        lastObjectUrlSource.name,
        'wai-anima-abc123.png',
        'the object URL must be backed by a File so the browser offers this name',
    );
    assert.equal(lastObjectUrlSource.type, 'image/png');
});

test('video keeps its own name and type', async () => {
    const media = await import('../src/lib/e2eMedia.js');
    await setup('video/mp4', new Uint8Array([0, 0, 0, 24]));
    media.clearResolvedMediaCache();
    lastObjectUrlSource = null;

    const url = '/api/media-studio/generated/opaque-clip.mp4';
    media.registerMediaDownloadName(url, 'ltx23-eros-fast-job7.mp4');
    await media.resolveMediaSrc(url);

    assert.equal(lastObjectUrlSource.name, 'ltx23-eros-fast-job7.mp4');
    assert.equal(lastObjectUrlSource.type, 'video/mp4');
});

test('media with no registered name still resolves, just unnamed', async () => {
    const media = await import('../src/lib/e2eMedia.js');
    await setup('image/png', new Uint8Array([1, 2, 3]));
    media.clearResolvedMediaCache();
    lastObjectUrlSource = null;

    const url = '/api/media-studio/generated/unregistered.png';
    assert.equal(media.mediaDownloadNameFor(url), '');
    const resolved = await media.resolveMediaSrc(url);

    assert.match(resolved, /^blob:/);
    assert.equal(lastObjectUrlSource.name, undefined, 'a plain Blob has no name');
});

test('every studio download goes through the one helper', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

    // The three studios each carried a byte-identical copy of the download
    // routine; that duplication is how the naming drifted in the first place.
    for (const rel of ['src/studios/ImageStudio.jsx', 'src/studios/VideoStudio.jsx', 'src/studios/LipSyncStudio.jsx']) {
        const source = read(rel);
        assert.match(source, /from '\.\.\/lib\/downloadMedia\.js'/, `${rel} must use the shared downloader`);
        assert.doesNotMatch(source, /a\.download = filename;/, `${rel} still has its own copy of the downloader`);
    }
    assert.match(read('src/lib/downloadNames.js'), /export function mediaDownloadName/);
});
