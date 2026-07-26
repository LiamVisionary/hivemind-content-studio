// referenceToLocalImageInput decides how a picked reference reaches a LOCAL image
// workflow. Selecting one from the saved list used to send its same-origin path as
// image_url, which the hosted bridge handed to new URL() — the owner saw a bare
// "Invalid URL" a few seconds into a Krea 2 identity generation.
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadStudio() {
    return import('../src/lib/hivemindStudio.js');
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

test('a freshly uploaded reference is already inline and is passed through', async () => {
    const { referenceToLocalImageInput } = await loadStudio();
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('must not fetch an inline reference'); };
    try {
        assert.deepEqual(
            await referenceToLocalImageInput('data:image/png;base64,AAAA'),
            { image_base64: 'data:image/png;base64,AAAA' },
        );
    } finally {
        global.fetch = originalFetch;
    }
});

test('a past cloud upload stays a URL for the bridge to fetch', async () => {
    const { referenceToLocalImageInput } = await loadStudio();
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('must not read a cross-origin reference in the browser'); };
    try {
        assert.deepEqual(
            await referenceToLocalImageInput('https://cdn.muapi.ai/outputs/generated/abc.png'),
            { image_url: 'https://cdn.muapi.ai/outputs/generated/abc.png' },
        );
    } finally {
        global.fetch = originalFetch;
    }
});

test('a saved reference path is read in the browser and sent inline, never as a URL', async () => {
    const { referenceToLocalImageInput } = await loadStudio();
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options) => {
        requests.push({ url, options });
        return {
            ok: true,
            status: 200,
            headers: { get: (name) => (name === 'Content-Type' ? 'image/png' : null) },
            blob: async () => new Blob(['reference-bytes'], { type: 'image/png' }),
        };
    };
    try {
        const input = await withFileReader(() =>
            referenceToLocalImageInput('/api/media-studio/references/reference-a.png'));

        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, '/api/media-studio/references/reference-a.png');
        assert.equal(requests[0].options.credentials, 'same-origin');
        assert.equal(input.image_url, undefined);
        assert.equal(
            input.image_base64,
            `data:image/png;base64,${Buffer.from('reference-bytes').toString('base64')}`,
        );
    } finally {
        global.fetch = originalFetch;
    }
});

test('no reference sends no image fields at all', async () => {
    const { referenceToLocalImageInput } = await loadStudio();
    assert.deepEqual(await referenceToLocalImageInput(''), {});
    assert.deepEqual(await referenceToLocalImageInput(null), {});
});
