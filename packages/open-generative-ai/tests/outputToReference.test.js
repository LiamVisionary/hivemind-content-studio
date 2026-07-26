const test = require('node:test');
const assert = require('node:assert/strict');

// "Use as video starting frame" must round-trip a generated output through the
// SAME reference upload the pickers use, so the image is re-sealed server-side
// and appears in the recent-references grid.
function installBrowserStubs() {
    const saved = {
        fetch: global.fetch,
        FileReader: global.FileReader,
        localStorage: global.localStorage,
        window: global.window,
        document: global.document,
    };
    const store = new Map();
    global.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
    // Studio mode: uploads go to the owner-gated reference store, not muapi.
    global.window = { location: { origin: 'https://studio.test', search: '?hivemindStudio=1' } };
    // No canvas in node: generateThumbnail resolves null and the upload's own
    // thumbnail (the reference URL) is used instead — same as a real failure.
    global.document = { createElement: () => ({ getContext: () => null }) };
    global.Image = class {
        // Synchronous so nothing fires after the stubs are torn down.
        set src(_value) { this.onerror?.(); }
    };
    global.URL.createObjectURL = () => 'blob:stub';
    global.URL.revokeObjectURL = () => {};
    global.FileReader = class {
        readAsDataURL(blob) {
            blob.arrayBuffer().then((buf) => {
                const b64 = Buffer.from(buf).toString('base64');
                this.result = `data:${blob.type || 'image/png'};base64,${b64}`;
                this.onload?.();
            });
        }
    };
    const calls = { uploads: [] };
    global.fetch = async (url, options = {}) => {
        if (String(url).startsWith('/api/media-studio/references') && options.method === 'POST') {
            calls.uploads.push(options.body.get('file'));
            return { ok: true, status: 200, json: async () => ({ ok: true, url: '/api/media-studio/references/frame.png', encrypted_at_rest: true }) };
        }
        // The source output.
        const headers = new Map([['Content-Type', 'image/png']]);
        return {
            ok: true,
            status: 200,
            headers: { get: (name) => headers.get(name) ?? null },
            blob: async () => new Blob([Buffer.from('png-bytes')], { type: 'image/png' }),
        };
    };
    return { calls, restore: () => Object.assign(global, saved) };
}

const stubs = installBrowserStubs();

test('a generated output is re-uploaded as a reference and recorded in history', async () => {
    const { calls } = stubs;
    {
        const { promoteOutputToReference } = await import('../src/lib/outputToReference.js');
        const { getUploadHistory } = await import('../src/lib/uploadHistory.js');

        const url = await promoteOutputToReference('/api/media-studio/output/krea2_identity_abc_00001_.png');

        assert.equal(url, '/api/media-studio/references/frame.png');
        assert.equal(calls.uploads.length, 1);
        assert.equal(calls.uploads[0].name, 'krea2_identity_abc_00001_.png');
        const history = getUploadHistory();
        assert.equal(history[0].uploadedUrl, '/api/media-studio/references/frame.png');
    }
});

test('a transient blob/data output never lands in the reference history', async () => {
    const { isPersistentUploadReference } = await import('../src/lib/uploadHistory.js');
    assert.equal(isPersistentUploadReference('blob:https://studio.test/abc'), false);
    assert.equal(isPersistentUploadReference('data:image/png;base64,AAAA'), false);
    assert.equal(isPersistentUploadReference('/api/media-studio/references/frame.png'), true);
});
