const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PY = '/Users/liam/comfy/hivemind-content-studio/.venv/bin/python';
const SEAL = '/Users/liam/comfy/hivemind-content-studio/packages/media-gateway/media_seal.py';

function stubStudioBrowser() {
    const session = new Map([['hivemind.ownerPassphrase.once', JSON.stringify({ password: 'media-pass', expiresAt: Date.now() + 1e6 })]]);
    global.window = { location: { search: '?hivemindStudio=1' }, dispatchEvent: () => {} };
    global.CustomEvent = class { constructor(t, i) { this.type = t; Object.assign(this, i); } };
    global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    global.sessionStorage = { getItem: (k) => (session.has(k) ? session.get(k) : null) };
    const blobs = [];
    global.URL = { createObjectURL: (blob) => { blobs.push(blob); return `blob:mock/${blobs.length - 1}`; }, revokeObjectURL: () => {} };
    return blobs;
}

async function sealWithPython(publicKeyB64, plaintext) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2emedia-'));
    fs.writeFileSync(path.join(dir, 'pub.txt'), publicKeyB64);
    fs.writeFileSync(path.join(dir, 'in.bin'), plaintext);
    execFileSync(PY, [SEAL, '--pub', `@${path.join(dir, 'pub.txt')}`, '--in', path.join(dir, 'in.bin'), '--out', path.join(dir, 'out.json')]);
    const sealed = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
    fs.rmSync(dir, { recursive: true, force: true });
    return { ...sealed, v: 1, media_type: 'video/mp4' };
}

test('E2E media: the browser fetches the envelope and renders decrypted bytes', async () => {
    const blobs = stubStudioBrowser();
    // Bootstrap the vault (the media helper shares e2eVault's session via vaultSession).
    const vault = { identity: null, blobs: new Map() };
    global.fetch = async (url, options = {}) => {
        const method = options.method || 'GET';
        if (url === '/api/vault/identity' && method === 'GET') return { ok: true, json: async () => ({ ok: true, exists: !!vault.identity, identity: vault.identity }) };
        if (url === '/api/vault/identity' && method === 'PUT') { vault.identity = JSON.parse(options.body).identity; return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
        throw new Error(`unexpected ${url}`);
    };
    const session = await import(`../src/lib/vaultSession.js?case=${Date.now()}-a`);
    assert.equal(await session.ensureVaultReady(), true);
    const pub = (await (await fetch('/api/vault/identity')).json()).identity.public_key;

    const plaintext = Buffer.from('the actual generated video bytes '.repeat(64));
    const envelope = await sealWithPython(pub, plaintext);

    let bodyCancelled = false;
    global.fetch = async (url) => {
        // Cross-origin gateway media: the custom X-E2E-Media header is NOT readable,
        // only Content-Type is — the detection must work off Content-Type alone.
        if (url === 'http://127.0.0.1:8787/image/clip.mp4?token=x') {
            return { ok: true, headers: { get: (h) => (h === 'Content-Type' ? 'application/vnd.hivemind.e2e+json' : null) }, json: async () => envelope, body: { cancel() { bodyCancelled = true; } } };
        }
        if (url === '/image/legacy.png') {
            return { ok: true, headers: { get: (h) => (h === 'Content-Type' ? 'image/png' : null) }, body: { cancel() { bodyCancelled = true; } } };
        }
        throw new Error(`unexpected ${url}`);
    };
    const media = await import(`../src/lib/e2eMedia.js?case=${Date.now()}-a`);

    const src = await media.resolveMediaSrc('http://127.0.0.1:8787/image/clip.mp4?token=x');
    assert.match(src, /^blob:mock\//, 'cross-origin E2E media resolves to a decrypted blob URL via Content-Type');
    const recovered = Buffer.from(await blobs[0].arrayBuffer());
    assert.deepEqual(recovered, plaintext, 'the blob holds the decrypted plaintext');

    // Legacy/plaintext media is passed through untouched (and not buffered here).
    const legacy = await media.resolveMediaSrc('/image/legacy.png');
    assert.equal(legacy, '/image/legacy.png');
    assert.equal(bodyCancelled, true, 'legacy response body is not downloaded twice');
});

test('E2E media: fails open to the original URL on any error', async () => {
    stubStudioBrowser();
    global.fetch = async () => { throw new Error('network down'); };
    const media = await import(`../src/lib/e2eMedia.js?case=${Date.now()}-b`);
    assert.equal(await media.resolveMediaSrc('/image/x.png'), '/image/x.png');
    assert.equal(await media.resolveMediaSrc(''), '');
});
