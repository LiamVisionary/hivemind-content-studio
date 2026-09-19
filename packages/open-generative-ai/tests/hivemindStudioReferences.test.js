const test = require('node:test');
const assert = require('node:assert/strict');

async function loadReferences() {
    return import('../src/lib/hivemindStudio.js');
}

// Node has no FileReader; hivemindStudio reads blobs through it to build the
// inline data URLs a sealed reference is re-sent as. Same shim as
// cloudReferenceUpload.test.js.
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

// A studio fetch that behaves like the real one: reference paths answer with
// BYTES, the generate route answers with JSON. Stubs that answered JSON to
// everything could not exercise the decrypt-and-inline path at all — they threw
// inside it, and the five tests below asserted nothing for months.
function studioFetch(requests, { job = 'job-1', url = '/api/media-studio/generated/out.mp4' } = {}) {
    return async (target, options) => {
        requests.push({ url: target, options });
        if (String(target).startsWith('/api/media-studio/references/')) {
            const type = String(target).endsWith('.mp4') ? 'video/mp4' : 'image/png';
            return {
                ok: true,
                status: 200,
                headers: new Headers({ 'Content-Type': type }),
                blob: async () => new Blob([`bytes-for-${target}`], { type }),
            };
        }
        return {
            ok: true,
            status: 200,
            headers: new Headers({ 'Content-Type': 'application/json' }),
            json: async () => ({ ok: true, job_id: job, url }),
        };
    };
}

function generateCall(requests) {
    return requests.find((entry) => !String(entry.url).startsWith('/api/media-studio/references/'));
}

test('Media Studio recognizes only opaque same-origin reference paths', async () => {
    const { mediaStudioReferencePath } = await loadReferences();

    assert.equal(
        mediaStudioReferencePath('/api/media-studio/references/reference-a.png'),
        '/api/media-studio/references/reference-a.png',
    );
    assert.equal(mediaStudioReferencePath('blob:https://studio.test/dead'), null);
    assert.equal(mediaStudioReferencePath('data:image/png;base64,AAAA'), null);
    assert.equal(mediaStudioReferencePath('/api/media-studio/references/../private.png'), null);
    assert.equal(mediaStudioReferencePath('/api/media-studio/references/reference-a.png?token=nope'), null);
});

test('Media Studio uploads a reference to the encrypted same-origin cache', async () => {
    const { uploadFileToHivemindStudio } = await loadReferences();
    const originalFetch = global.fetch;
    let request;
    global.fetch = async (url, options) => {
        request = { url, options };
        return {
            ok: true,
            status: 200,
            // Real fetch always carries headers, and the reader checks
            // Content-Type / X-E2E-Media before touching the body. A stub
            // without them threw on `.get` and the test below never ran.
            headers: new Headers(),
            json: async () => ({
                ok: true,
                url: '/api/media-studio/references/reference-a.png',
                encrypted_at_rest: true,
            }),
        };
    };

    try {
        const file = new Blob(['image-bytes'], { type: 'image/png' });
        Object.defineProperty(file, 'name', { value: 'start.png' });
        const result = await uploadFileToHivemindStudio(file);

        assert.equal(request.url, '/api/media-studio/references');
        assert.equal(request.options.method, 'POST');
        assert.equal(request.options.credentials, 'same-origin');
        assert.ok(request.options.body instanceof FormData);
        assert.equal(request.options.body.get('file').name, 'start.png');
        assert.deepEqual(result, {
            url: '/api/media-studio/references/reference-a.png',
            path: '/api/media-studio/references/reference-a.png',
            // No poster in this response, so the thumbnail falls back to the
            // reference itself — the pre-poster behaviour.
            posterUrl: null,
            thumbnail: '/api/media-studio/references/reference-a.png',
            encryptedAtRest: true,
        });
    } finally {
        global.fetch = originalFetch;
    }
});

test('Media Studio decrypts a saved video reference in-browser and re-sends it inline', async () => {
    // The server holds no vault key, so a sealed reference path is useless to
    // it: the browser fetches the reference, decrypts it, and sends the bytes.
    // This test used to assert the opposite (a bare `video_reference` path) —
    // the contract it described was replaced by the E2E design and the stub was
    // too thin to notice.
    const { generateHivemindVideo } = await loadReferences();
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = studioFetch(requests, { job: 'job-v', url: '/api/media-studio/generated/v.mp4' });

    try {
        await withFileReader(() => generateHivemindVideo({
            model: 'hivemind-media:ltx23-regular-fast',
            video_url: '/api/media-studio/references/reference-v.mp4',
            prompt: 'continue the shot',
            duration: 3,
        }));

        // Two calls: read the reference, then start the job.
        assert.equal(requests.length, 2);
        assert.equal(requests[0].url, '/api/media-studio/references/reference-v.mp4');
        const body = JSON.parse(generateCall(requests).options.body);
        assert.ok(body.video_base64.startsWith('data:video/mp4;base64,'));
        assert.equal(body.video_reference, undefined);
        // video_mode rides only when the caller sets it — this is a plain
        // extend-capable model, not an extend request.
        assert.equal(body.video_mode, undefined);
    } finally {
        global.fetch = originalFetch;
    }
});
test('Media Studio reuses a persisted reference by decrypting it, and starts a job', async () => {
    const { generateHivemindVideo } = await loadReferences();
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = studioFetch(requests, { job: 'job-a', url: '/api/media-studio/generated/a.mp4' });

    try {
        const result = await withFileReader(() => generateHivemindVideo({
            model: 'hivemind-media:ltx23-regular-fast',
            image_url: '/api/media-studio/references/reference-a.png',
            prompt: 'gentle camera move',
            duration: 3,
        }));

        assert.equal(requests.length, 2);
        const generate = generateCall(requests);
        // Long generations go through the job-based start route so the result
        // survives dropped connections; the request body contract is identical.
        assert.equal(generate.url, '/api/media-studio/video/start');
        const body = JSON.parse(generate.options.body);
        assert.ok(body.image_base64.startsWith('data:image/png;base64,'));
        assert.equal(body.image_reference, undefined);
        assert.equal(body.workflow_id, 'ltx23-regular-fast');
        assert.equal(result.url, '/api/media-studio/generated/a.mp4');
    } finally {
        global.fetch = originalFetch;
    }
});
test('Media Studio forwards the app-tab video queue lane', async () => {
    const { generateHivemindVideo } = await loadReferences();
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options) => {
        requests.push({ url, options });
        return {
            ok: true,
            status: 200,
            // Real fetch always carries headers, and the reader checks
            // Content-Type / X-E2E-Media before touching the body. A stub
            // without them threw on `.get` and the test below never ran.
            headers: new Headers(),
            json: async () => ({ ok: true, job_id: 'job-lane', url: '/generated/lane.mp4' }),
        };
    };

    try {
        await generateHivemindVideo({
            model: 'hivemind-media:ltx23-regular-fast',
            prompt: 'gentle camera move',
            duration: 3,
            studio_lane: 'video:window-a:2',
            run_on: 'vast:48352597',
        });

        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, '/api/media-studio/video/start');
        const body = JSON.parse(requests[0].options.body);
        assert.equal(body.studio_lane, 'video:window-a:2');
        // The tab's "Run on" pin rides the same request, as the gateway reads it.
        assert.equal(body.run_on, 'vast:48352597');

        // No pin, no key: an absent pin must not reach the server as ''.
        await generateHivemindVideo({ model: 'hivemind-media:ltx23-regular-fast', prompt: 'x', duration: 3 });
        assert.equal('run_on' in JSON.parse(requests[1].options.body), false);
    } finally {
        global.fetch = originalFetch;
    }
});

test('Media Studio sends several ingredient references inline, and never as frame anchors', async () => {
    const { generateHivemindVideo } = await loadReferences();
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = studioFetch(requests, { job: 'ingredients-job', url: '/api/media-studio/generated/ingredients.mp4' });

    try {
        await withFileReader(() => generateHivemindVideo({
            model: 'hivemind-media:ltx23-ic-ingredients-lora',
            prompt: 'The same character turns toward camera.',
            ingredientImages: [
                { image: '/api/media-studio/references/front.png', description: 'front view' },
                { image: '/api/media-studio/references/profile.png', description: 'right profile' },
            ],
            duration: 3,
        }));

        const body = JSON.parse(generateCall(requests).options.body);
        assert.equal(body.ingredient_images.length, 2);
        assert.ok(body.ingredient_images[0].image_base64.startsWith('data:image/png;base64,'));
        assert.equal(body.ingredient_images[0].description, 'front view');
        assert.equal(body.ingredient_images[1].description, 'right profile');
        // The point of the test: ingredients compose into one sheet, they are
        // never promoted to a start/middle/end frame.
        assert.equal(body.image_base64, undefined);
        assert.equal(body.image_reference, undefined);
        assert.equal(body.middle_image_base64, undefined);
        assert.equal(body.end_image_base64, undefined);
        assert.equal(body.keyframes, undefined);
    } finally {
        global.fetch = originalFetch;
    }
});

test('Media Studio sends a persisted starting frame alongside its ingredient references', async () => {
    const { generateHivemindVideo } = await loadReferences();
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = studioFetch(requests, { job: 'ingredients-start-job', url: '/api/media-studio/generated/ingredients-start.mp4' });

    try {
        await withFileReader(() => generateHivemindVideo({
            model: 'hivemind-media:ltx23-ic-ingredients-lora',
            prompt: 'The same character waves to camera.',
            image: '/api/media-studio/references/start.png',
            ingredientImages: [
                { image: '/api/media-studio/references/front.png', description: 'front view' },
                { image: '/api/media-studio/references/profile.png', description: 'right profile' },
            ],
            aspect_ratio: '9:16',
            duration: 5,
        }));

        const body = JSON.parse(generateCall(requests).options.body);
        // The start frame stays a start frame — it is not folded into the sheet.
        assert.ok(body.image_base64.startsWith('data:image/png;base64,'));
        assert.equal(body.image_reference, undefined);
        assert.equal(body.ingredient_images.length, 2);
        assert.equal(body.aspect_ratio, '9:16');
    } finally {
        global.fetch = originalFetch;
    }
});

test('Media Studio previews the authoritative stitched sheet the server composed', async () => {
    // The sheet the model will actually see is stitched server-side, so the
    // preview must come back from /ingredients/preview rather than being
    // reassembled in the browser. The references themselves are decrypted here
    // and sent inline, exactly as a generation would send them.
    const { previewHivemindIngredientSheet } = await loadReferences();
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (target, options) => {
        requests.push({ url: target, options });
        if (String(target).startsWith('/api/media-studio/references/')) {
            return {
                ok: true,
                status: 200,
                headers: new Headers({ 'Content-Type': 'image/png' }),
                blob: async () => new Blob([`bytes-for-${target}`], { type: 'image/png' }),
            };
        }
        return {
            ok: true,
            status: 200,
            headers: new Headers({
                'X-Ingredients-Columns': '2',
                'X-Ingredients-Rows': '1',
                'X-Ingredients-Sources': '2',
                'X-Ingredients-Width': '768',
                'X-Ingredients-Height': '448',
            }),
            blob: async () => new Blob(['stitched-png'], { type: 'image/png' }),
        };
    };

    try {
        const sheet = await withFileReader(() => previewHivemindIngredientSheet([
            { image: '/api/media-studio/references/front.png' },
            { image: '/api/media-studio/references/profile.png' },
        ], { aspectRatio: '16:9' }));

        const preview = requests.find((entry) => entry.url === '/api/media-studio/ingredients/preview');
        assert.ok(preview, 'the preview must be the server-composed sheet');
        const body = JSON.parse(preview.options.body);
        assert.equal(body.ingredient_images.length, 2);
        assert.ok(body.ingredient_images[0].image_base64.startsWith('data:image/png;base64,'));
        assert.equal(body.aspect_ratio, '16:9');
        assert.equal(sheet.columns, 2);
        assert.equal(sheet.rows, 1);
        assert.equal(sheet.sourceCount, 2);
        assert.equal(sheet.width, 768);
        assert.equal(sheet.height, 448);
    } finally {
        global.fetch = originalFetch;
    }
});
test('a sound-only motion reference travels as a voice clip, never as a reference video', async () => {
    const { generateHivemindVideo } = await loadReferences();
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options) => {
        requests.push({ url, options });
        return {
            ok: true,
            status: 200,
            // Real fetch always carries headers, and the reader checks
            // Content-Type / X-E2E-Media before touching the body. A stub
            // without them threw on `.get` and the test below never ran.
            headers: new Headers(),
            json: async () => ({ ok: true, job_id: 'job-s', url: '/api/media-studio/generated/s.mp4' }),
        };
    };
    try {
        await generateHivemindVideo({
            model: 'hivemind-media:minimax-h3',
            prompt: 'x',
            duration: 5,
            referenceImages: ['data:image/png;base64,iVBORw0KGgo='],
            referenceAudios: [{ url: 'data:audio/wav;base64,UklGRg==' }],
            referenceVideos: [
                { url: 'data:video/mp4;base64,AAAAIGZ0eXA=', useAudio: false },
                { url: 'data:video/quicktime;base64,AAAAIGZ0eXBxdCAg', motion: false, useAudio: true, durationSeconds: 9 },
            ],
        });
        const body = JSON.parse(requests[0].options.body);
        assert.equal(body.reference_videos.length, 1, 'only the motion row is a reference video');
        assert.equal(body.reference_videos[0].use_audio, false);
        assert.equal(body.reference_audios.length, 2, 'the explicit clip, then the sound-only row');
        assert.match(body.reference_audios[0].audio_base64, /^data:audio\/wav/);
        assert.match(body.reference_audios[1].audio_base64, /^data:video\/quicktime/);
        assert.equal(body.reference_audios[1].duration_seconds, 9);
    } finally {
        global.fetch = originalFetch;
    }
});
