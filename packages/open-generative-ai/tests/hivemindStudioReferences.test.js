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
