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

test('gateway-served /image/ media is still decrypted, not rendered as raw envelope', async () => {
    const media = await import('../src/lib/e2eMedia.js');
    await setup('image/png', new Uint8Array([137, 80, 78, 71]));
    media.clearResolvedMediaCache();

    // The gateway serves generated outputs from `/image/<name>?token=…` — a
    // same-origin path that is NOT under /api/. A predicate that enumerated the
    // sealed paths missed this one and pointed <img> at the envelope JSON, so
    // every generated result rendered broken.
    const resolved = await media.resolveMediaSrc('/image/krea2-out.png?token=abc');
    assert.match(resolved, /^blob:/, '/image/ media must be decrypted to a blob URL');
});

test('the seal probe is skipped only for URLs that provably cannot be sealed', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const hooks = fs.readFileSync(path.join(__dirname, '..', 'src/hooks/hooks.js'), 'utf8');

    // Must be an explicit skip-list, never an allow-list: anything unlisted has to
    // fall through to the probe, because a missed probe means broken media while a
    // needless one only costs a request.
    assert.match(hooks, /function cannotBeSealed/);
    assert.doesNotMatch(hooks, /function couldBeSealed/, 'an allow-list predicate is what broke /image/ media');
    assert.match(hooks, /local-ai/, 'the bridge art is the one thing worth skipping');
});

test('a data: URL carrying an E2E envelope is decrypted, not shoved into <img>', async () => {
    const media = await import('../src/lib/e2eMedia.js');
    const vault = await import('../src/lib/e2eVault.js');
    if (!vaultIdentity) vaultIdentity = (await vault.createVaultIdentity('test-only-passphrase')).identity;

    const pixels = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const sealed = await sealMedia(vaultIdentity.public_key, pixels);
    const envelope = JSON.stringify({ ...sealed, media_type: 'image/png' });
    // Exactly what hosted-server.js:611 produces when the gateway served a sealed
    // output: the envelope inlined as a data: URL.
    const dataUrl = `data:application/vnd.hivemind.e2e+json;base64,${Buffer.from(envelope).toString('base64')}`;

    // Serve it the way a real fetch() of that data: URL would.
    global.fetch = async (url) => {
        if (String(url).includes('/api/vault/identity')) {
            return { ok: true, status: 200, json: async () => ({ exists: true, identity: vaultIdentity }) };
        }
        assert.ok(String(url).startsWith('data:'), 'the data: URL itself must be fetched');
        return {
            ok: true,
            status: 200,
            headers: { get: (n) => (n === 'Content-Type' ? 'application/vnd.hivemind.e2e+json' : null) },
            json: async () => JSON.parse(envelope),
            body: null,
        };
    };

    media.clearResolvedMediaCache();
    const resolved = await media.resolveMediaSrc(dataUrl);
    assert.match(resolved, /^blob:/, 'an inlined envelope must decrypt to a renderable blob URL');
});

test('the skip-list classifies data: URLs by their announced type', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const hooks = fs.readFileSync(path.join(__dirname, '..', 'src/hooks/hooks.js'), 'utf8');
    const match = hooks.match(/function cannotBeSealed[\s\S]*?\n}/);
    assert.ok(match, 'cannotBeSealed not found');
    // Rebuild the predicate in isolation so the classification itself is asserted.
    const cannotBeSealed = new Function(`${match[0]}; return cannotBeSealed;`)();

    assert.equal(cannotBeSealed('data:application/vnd.hivemind.e2e+json;base64,eyJ='), false, 'sealed payloads must be probed');
    assert.equal(cannotBeSealed('data:image/png;base64,iVBOR'), true, 'a plain inline image needs no probe');
    assert.equal(cannotBeSealed('/image/krea2-out.png?token=abc'), false, 'gateway output must be probed');
    assert.equal(cannotBeSealed('/api/media-studio/generated/x.png'), false);
    assert.equal(cannotBeSealed('/local-ai/lora-preview/abc'), true);
    assert.equal(cannotBeSealed('blob:http://x/1'), true);
});

test('no video player offers the browser its own download path', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..', 'src');

    // Chrome names a blob: download from the URL's UUID and ignores the File's
    // name, so a native <video> download can never agree with ours. The only way
    // to guarantee one name is to leave exactly one download path: ours. Every
    // player that shows controls must therefore suppress the download item.
    const offenders = [];
    const walk = (dir) => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, item.name);
            if (item.isDirectory()) { walk(full); continue; }
            if (!/\.(jsx?|tsx?)$/.test(item.name)) continue;
            // src/components and src/views hold the retired vanilla-JS UI.
            if (/\/(components|views)\//.test(full)) continue;
            const source = fs.readFileSync(full, 'utf8');
            for (const tag of source.match(/<video\b[^>]*>/gs) || []) {
                if (/\bcontrols\b/.test(tag) && !/controlsList=["'][^"']*nodownload/.test(tag)) {
                    offenders.push(`${path.relative(root, full)}: ${tag.replace(/\s+/g, ' ').slice(0, 70)}`);
                }
            }
        }
    };
    walk(root);
    assert.deepEqual(offenders, [], 'these players still expose the native download');
});

test('History can still download, now that the native control is gone', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const view = fs.readFileSync(path.join(__dirname, '..', 'src/hub/views/HistoryView.jsx'), 'utf8');

    // Suppressing the native item would otherwise leave History with NO way to
    // save a clip at all.
    assert.match(view, /label: 'Download'/, 'History cards need their own download action');
    assert.match(view, /downloadMedia\(entry\.media_url, downloadName\)/);
    assert.match(view, /from '\.\.\/\.\.\/lib\/downloadMedia\.js'/);
});
