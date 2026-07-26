// A reference held only on this Mac cannot be handed to a cloud model as-is: MUAPI
// fetches references by URL. Making one work means decrypting it in the browser and
// uploading a plaintext copy — so the studio has to know exactly WHICH references
// that applies to (referencesNeedingApproval gates the confirm prompt) and must
// never send a local path or an unapproved image.
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadCloudReferences() {
    return import('../src/lib/cloudReferenceUpload.js');
}

// Node has no FileReader; hivemindStudio reads blobs through it to build data URLs.
function withFileReader(run) {
    const original = global.FileReader;
    global.FileReader = class {
        readAsDataURL(blob) {
            blob.arrayBuffer().then((buffer) => {
                this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
                this.onload?.();
            }, (error) => { this.error = error; this.onerror?.(); });
        }
    };
    return Promise.resolve(run()).finally(() => { global.FileReader = original; });
}

function sealedReferenceFetch(requests) {
    return async (url, options) => {
        requests.push({ url, options });
        return {
            ok: true,
            status: 200,
            headers: { get: (name) => (name === 'Content-Type' ? 'image/jpeg' : null) },
            blob: async () => new Blob(['sealed-bytes'], { type: 'image/jpeg' }),
        };
    };
}

test('only references that are not already public need the owner approval', async () => {
    const { referencesNeedingApproval } = await loadCloudReferences();

    assert.deepEqual(
        referencesNeedingApproval([
            'https://cdn.muapi.ai/outputs/generated/public.png',
            '/api/media-studio/references/sealed.jpg.e2e',
            'data:image/png;base64,AAAA',
        ], new Set()),
        ['/api/media-studio/references/sealed.jpg.e2e', 'data:image/png;base64,AAAA'],
    );
    // Already approved this session — the bytes have left, so do not ask twice.
    assert.deepEqual(
        referencesNeedingApproval(
            ['/api/media-studio/references/sealed.jpg.e2e'],
            new Set(['/api/media-studio/references/sealed.jpg.e2e']),
        ),
        [],
    );
    assert.deepEqual(referencesNeedingApproval([], new Set()), []);
    // A duplicate selection is one decision, not two.
    assert.deepEqual(referencesNeedingApproval(['/api/x', '/api/x'], new Set()), ['/api/x']);
});

test('a public reference reaches the provider untouched and is never re-uploaded', async () => {
    const { resolveCloudReferences } = await loadCloudReferences();
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('must not read a public reference'); };
    try {
        const resolved = await resolveCloudReferences(['https://cdn.muapi.ai/outputs/generated/a.png'], {
            cache: new Map(),
            upload: () => { throw new Error('must not upload a public reference'); },
        });
        assert.deepEqual(resolved, ['https://cdn.muapi.ai/outputs/generated/a.png']);
    } finally {
        global.fetch = originalFetch;
    }
});

test('a sealed reference is decrypted in the browser and uploaded once per session', async () => {
    const { resolveCloudReferences } = await loadCloudReferences();
    const originalFetch = global.fetch;
    const requests = [];
    const uploads = [];
    global.fetch = sealedReferenceFetch(requests);
    const cache = new Map();
    const upload = async (file) => {
        uploads.push({ name: file.name, type: file.type, bytes: await file.text() });
        return 'https://cdn.muapi.ai/outputs/generated/uploaded.jpg';
    };
    try {
        const first = await withFileReader(() =>
            resolveCloudReferences(['/api/media-studio/references/sealed.jpg.e2e'], { cache, upload }));
        assert.deepEqual(first, ['https://cdn.muapi.ai/outputs/generated/uploaded.jpg']);
        assert.equal(uploads.length, 1);
        assert.equal(uploads[0].bytes, 'sealed-bytes');
        // Named from the decrypted media type, so the provider sees a real image.
        assert.equal(uploads[0].name, 'reference-1.jpg');
        assert.equal(uploads[0].type, 'image/jpeg');

        // Re-generating with the same reference reuses the URL — no second upload.
        const second = await withFileReader(() =>
            resolveCloudReferences(['/api/media-studio/references/sealed.jpg.e2e'], { cache, upload }));
        assert.deepEqual(second, first);
        assert.equal(uploads.length, 1);
    } finally {
        global.fetch = originalFetch;
    }
});

test('an upload that returns no usable URL fails instead of sending a local path', async () => {
    const { resolveCloudReferences } = await loadCloudReferences();
    const originalFetch = global.fetch;
    global.fetch = sealedReferenceFetch([]);
    try {
        await assert.rejects(
            () => withFileReader(() => resolveCloudReferences(['/api/media-studio/references/sealed.jpg.e2e'], {
                cache: new Map(),
                upload: async () => '',
            })),
            /did not return a usable URL/,
        );
    } finally {
        global.fetch = originalFetch;
    }
});
