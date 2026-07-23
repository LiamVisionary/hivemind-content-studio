const test = require('node:test');
const assert = require('node:assert/strict');

// A minimal server-side vault: an in-memory blob map behind the same endpoints
// the browser uses. It only ever sees the ciphertext strings the client sends.
function stubStudioBrowser({ password = 'owner-pass', stored = {} } = {}) {
    const local = new Map(Object.entries(stored));
    const session = new Map([['hivemind.ownerPassphrase.once', JSON.stringify({ password, expiresAt: Date.now() + 1e6 })]]);
    global.window = { location: { search: '?hivemindStudio=1' }, dispatchEvent: () => {} };
    global.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
    global.localStorage = {
        getItem: (k) => (local.has(k) ? local.get(k) : null),
        setItem: (k, v) => local.set(k, String(v)),
        removeItem: (k) => local.delete(k),
    };
    global.sessionStorage = { getItem: (k) => (session.has(k) ? session.get(k) : null) };

    const vault = { identity: null, blobs: new Map() };
    const seen = [];
    global.fetch = async (url, options = {}) => {
        const method = options.method || 'GET';
        seen.push({ url, method, body: options.body });
        if (url === '/api/vault/identity' && method === 'GET') {
            return { ok: true, json: async () => ({ ok: true, exists: !!vault.identity, identity: vault.identity }) };
        }
        if (url === '/api/vault/identity' && method === 'PUT') {
            vault.identity = JSON.parse(options.body).identity;
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        const blobMatch = url.match(/^\/api\/vault\/blob\/([^/]+)\/([^/]+)$/);
        if (blobMatch && method === 'GET') {
            const ct = vault.blobs.get(url) || null;
            return { ok: true, json: async () => ({ ok: true, ciphertext: ct }) };
        }
        if (blobMatch && method === 'PUT') {
            vault.blobs.set(url, JSON.parse(options.body).ciphertext);
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
    return { vault, seen, local };
}

test('composer state is encrypted in the browser; the server only ever sees ciphertext', async () => {
    const { vault, seen } = stubStudioBrowser();
    const mod = await import(`../src/lib/composerState.js?case=${Date.now()}-e2e`);

    await mod.hydrateComposerState(); // creates + unlocks the vault (no identity yet)
    assert.ok(vault.identity, 'a vault identity was registered');
    assert.deepEqual(
        Object.keys(vault.identity).sort(),
        ['kdf', 'public_key', 'salt', 'wrapped_mk_pass', 'wrapped_mk_recovery', 'wrapped_private_key'],
    );

    mod.updateComposerSection('image', { prompt: 'a secret prompt', references: ['/api/media-studio/references/x.png'] });
    await new Promise((resolve) => setTimeout(resolve, 750));

    const put = seen.find((c) => c.method === 'PUT' && c.url.startsWith('/api/vault/blob/'));
    assert.ok(put, 'ciphertext was PUT to the vault blob endpoint');
    const stored = JSON.parse(put.body).ciphertext;
    assert.match(stored, /^v1\./, 'stored value is a versioned AES-GCM blob');
    assert.ok(!stored.includes('secret prompt'), 'prompt text never leaves the browser in cleartext');
    assert.ok(!JSON.stringify([...vault.blobs.values()]).includes('secret prompt'));
});

test('a fresh page load re-hydrates by decrypting the stored ciphertext in the browser', async () => {
    const shared = stubStudioBrowser();
    let mod = await import(`../src/lib/composerState.js?case=${Date.now()}-persist`);
    await mod.hydrateComposerState();
    mod.updateComposerSection('image', { prompt: 'remembered draft' });
    await new Promise((resolve) => setTimeout(resolve, 750));

    // Simulate a reload: same server vault + same passphrase, fresh module instance.
    const identity = shared.vault.identity;
    const blobs = shared.vault.blobs;
    const reload = stubStudioBrowser();
    reload.vault.identity = identity;
    reload.vault.blobs = blobs;
    mod = await import(`../src/lib/composerState.js?case=${Date.now()}-reload`);
    const state = await mod.hydrateComposerState();
    assert.equal(state.image.prompt, 'remembered draft');
});

test('outside studio mode the composer state stays in localStorage and never calls the API', async () => {
    global.window = { location: { search: '' } };
    const store = new Map();
    global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
    let fetched = 0;
    global.fetch = async () => { fetched += 1; return { ok: true, json: async () => ({}) }; };
    const mod = await import(`../src/lib/composerState.js?case=${Date.now()}-standalone`);

    await mod.hydrateComposerState();
    mod.updateComposerSection('image', { prompt: 'local draft' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(fetched, 0);
    assert.equal(JSON.parse(store.get('opengen_composer_state')).image.prompt, 'local draft');
});

test('image studio wires the encrypted composer draft into prompt, references, and preferences', async () => {
    const fs = require('node:fs');
    const source = fs.readFileSync(require.resolve('../src/components/ImageStudio.js'), 'utf8');
    assert.match(source, /hydrateComposerState\(\)\.then/);
    assert.match(source, /updateComposerSection\('image', \{ prompt: textarea\.value \}\)/);
    assert.match(source, /updateComposerSection\('image', \{ references: uploadedImageUrls\.slice\(\) \}\)/);
    assert.match(source, /updateComposerSection\('image', \{ references: \[\] \}\)/);
    assert.match(source, /updateComposerSection\('image', \{ preferences \}\)/);
    const uploads = fs.readFileSync(require.resolve('../src/lib/uploadHistory.js'), 'utf8');
    assert.match(uploads, /isHivemindStudioEnabled\(\)/);
    assert.match(uploads, /setComposerUploads/);
});
