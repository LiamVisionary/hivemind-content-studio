const test = require('node:test');
const assert = require('node:assert/strict');

async function loadReferences() {
    return import('../src/lib/hivemindStudio.js');
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

test('Media Studio sends encrypted video references directly to extension workflows', async () => {
    const { generateHivemindVideo } = await loadReferences();
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options) => {
        requests.push({ url, options });
        return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, job_id: 'job-v', url: '/api/media-studio/generated/v.mp4' }),
        };
    };

    try {
        await generateHivemindVideo({
            model: 'hivemind-media:ltx23-regular-fast',
            video_url: '/api/media-studio/references/reference-v.mp4',
            prompt: 'continue the shot',
            duration: 3,
        });

        assert.equal(requests.length, 1);
        const body = JSON.parse(requests[0].options.body);
        assert.equal(body.video_reference, '/api/media-studio/references/reference-v.mp4');
        assert.equal(body.video_base64, undefined);
        assert.equal(body.video_mode, 'extend');
    } finally {
        global.fetch = originalFetch;
    }
});

test('Media Studio generation reuses a persisted reference without fetching its bytes in the browser', async () => {
    const { generateHivemindVideo } = await loadReferences();
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options) => {
        requests.push({ url, options });
        return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, job_id: 'job-a', url: '/api/media-studio/generated/a.mp4' }),
        };
    };

    try {
        const result = await generateHivemindVideo({
            model: 'hivemind-media:ltx23-regular-fast',
            image_url: '/api/media-studio/references/reference-a.png',
            prompt: 'gentle camera move',
            duration: 3,
        });

        assert.equal(requests.length, 1);
        // Long generations go through the job-based start route so the result
        // survives dropped connections; the request body contract is identical.
        assert.equal(requests[0].url, '/api/media-studio/video/start');
        const body = JSON.parse(requests[0].options.body);
        assert.equal(body.image_reference, '/api/media-studio/references/reference-a.png');
        assert.equal(body.image_base64, undefined);
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

test('Media Studio sends several encrypted ingredient references without turning them into frame anchors', async () => {
    const { generateHivemindVideo } = await loadReferences();
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options) => {
        requests.push({ url, options });
        return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, job_id: 'ingredients-job', url: '/api/media-studio/generated/ingredients.mp4' }),
        };
    };

    try {
        await generateHivemindVideo({
            model: 'hivemind-media:ltx23-ic-ingredients-lora',
            prompt: 'The same character turns toward camera.',
            ingredientImages: [
                { image: '/api/media-studio/references/front.png', description: 'front view' },
                { image: '/api/media-studio/references/profile.png', description: 'right profile' },
            ],
            duration: 3,
        });

        assert.equal(requests.length, 1);
        const body = JSON.parse(requests[0].options.body);
        assert.deepEqual(body.ingredient_images, [
            { image_reference: '/api/media-studio/references/front.png', description: 'front view' },
            { image_reference: '/api/media-studio/references/profile.png', description: 'right profile' },
        ]);
        assert.equal(body.image_reference, undefined);
        assert.equal(body.image_base64, undefined);
        assert.equal(body.middle_image_base64, undefined);
        assert.equal(body.end_image_base64, undefined);
        assert.equal(body.keyframes, undefined);
    } finally {
        global.fetch = originalFetch;
    }
});

test('Media Studio sends a persisted starting frame alongside encrypted ingredient references', async () => {
    const { generateHivemindVideo } = await loadReferences();
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options) => {
        requests.push({ url, options });
        return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, job_id: 'ingredients-start-job', url: '/api/media-studio/generated/ingredients-start.mp4' }),
        };
    };

    try {
        await generateHivemindVideo({
            model: 'hivemind-media:ltx23-ic-ingredients-lora',
            prompt: 'The same character waves to camera.',
            image: '/api/media-studio/references/start.png',
            ingredientImages: [
                { image: '/api/media-studio/references/front.png', description: 'front view' },
                { image: '/api/media-studio/references/profile.png', description: 'right profile' },
            ],
            aspect_ratio: '9:16',
            duration: 5,
        });

        assert.equal(requests.length, 1);
        const body = JSON.parse(requests[0].options.body);
        assert.equal(body.image_reference, '/api/media-studio/references/start.png');
        assert.equal(body.ingredient_images.length, 2);
        assert.equal(body.aspect_ratio, '9:16');
    } finally {
        global.fetch = originalFetch;
    }
});

test('Media Studio previews the authoritative stitched sheet without fetching encrypted references in the browser', async () => {
    const { previewHivemindIngredientSheet } = await loadReferences();
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options) => {
        requests.push({ url, options });
        return {
            ok: true,
            status: 200,
            headers: {
                get: (name) => ({
                    'X-Ingredients-Columns': '2',
                    'X-Ingredients-Rows': '1',
                    'X-Ingredients-Sources': '2',
                    'X-Ingredients-Width': '768',
                    'X-Ingredients-Height': '448',
                }[name] || null),
            },
            blob: async () => new Blob(['stitched-png'], { type: 'image/png' }),
        };
    };

    try {
        const result = await previewHivemindIngredientSheet([
            { image: '/api/media-studio/references/front.png', description: 'front view' },
            { image: '/api/media-studio/references/profile.png', description: 'right profile' },
        ]);

        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, '/api/media-studio/ingredients/preview');
        assert.equal(requests[0].options.method, 'POST');
        assert.equal(requests[0].options.credentials, 'same-origin');
        assert.deepEqual(JSON.parse(requests[0].options.body), {
            ingredient_images: [
                { image_reference: '/api/media-studio/references/front.png', description: 'front view' },
                { image_reference: '/api/media-studio/references/profile.png', description: 'right profile' },
            ],
            aspect_ratio: '16:9',
        });
        assert.equal(result.columns, 2);
        assert.equal(result.rows, 1);
        assert.equal(result.sourceCount, 2);
        assert.equal(result.width, 768);
        assert.equal(result.height, 448);
        assert.equal(await result.blob.text(), 'stitched-png');
    } finally {
        global.fetch = originalFetch;
    }
});

// A motion row switched to SOUND ONLY travels as a voice clip — in
// reference_audios after the explicit ones (the order the model numbers
// <Audio N>) — and never as a reference video. The MCP lifts the soundtrack out
// of the container; the clip's frames are not what was attached.
test('a sound-only motion reference travels as a voice clip, never as a reference video', async () => {
    const { generateHivemindVideo } = await loadReferences();
    const originalFetch = global.fetch;
    const requests = [];
    global.fetch = async (url, options) => {
        requests.push({ url, options });
        return {
            ok: true,
            status: 200,
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
