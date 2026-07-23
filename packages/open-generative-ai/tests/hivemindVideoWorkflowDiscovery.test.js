const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function response(ok, payload) {
    return { ok, json: async () => payload };
}

test('video workflow discovery recovers after an owner-session startup race', async () => {
    const originalWindow = global.window;
    const originalFetch = global.fetch;
    const originalLocalStorage = global.localStorage;
    const originalSessionStorage = global.sessionStorage;
    const eventTarget = new EventTarget();
    eventTarget.location = { search: '?hivemindStudio=1', origin: 'https://studio.test' };
    eventTarget.parent = { postMessage() {} };
    global.window = eventTarget;
    global.localStorage = { getItem: () => null, removeItem() {}, setItem() {} };
    global.sessionStorage = { getItem: () => null, removeItem() {}, setItem() {} };

    let catalogRequests = 0;
    global.fetch = async (url) => {
        if (String(url).startsWith('/api/simple/prompts')) return response(true, { prompts: [] });
        catalogRequests += 1;
        if (catalogRequests === 1 || catalogRequests === 3) return response(false, {});
        return response(true, {
            ok: true,
            media: {
                video: [{
                    id: 'media-studio-mcp',
                    label: 'Media Studio',
                    available: true,
                    detail: 'ready',
                    models: [{
                        id: 'ltx23-ic-ingredients-lora',
                        label: 'LTX 2.3 IC-LoRA Ingredients',
                        accepts: ['prompt', 'image_base64', 'ingredient_images', 'loras'],
                        supports_loras: true,
                        compatible_base_models: ['LTXV'],
                        aspect_ratios: ['16:9'],
                        default_duration_seconds: 5,
                        ingredient_inputs: { max_images: 12, layout: 'adaptive-pack' },
                    }],
                }],
            },
        });
    };

    try {
        const moduleUrl = `${pathToFileURL(path.join(__dirname, '../src/lib/hivemindStudio.js')).href}?test=${Date.now()}`;
        const studio = await import(moduleUrl);
        const updates = [];
        window.addEventListener('hivemind-context-updated', (event) => updates.push(event.detail.context));

        const initial = await studio.loadHivemindStudioContext();
        assert.deepEqual(initial.videoModels, []);

        const recovered = await studio.loadHivemindStudioContext({ refresh: true });
        assert.equal(catalogRequests, 2);
        assert.equal(recovered.videoModels.length, 1);
        assert.deepEqual(recovered.videoModels[0], {
            accepts: ['prompt', 'image_base64', 'ingredient_images', 'loras'],
            supportsVideoInput: false,
            videoModes: [],
            supportsLoras: true,
            compatibleBaseModels: ['LTXV'],
            supportsIngredientImages: true,
            ingredientInputs: { max_images: 12, layout: 'adaptive-pack' },
            id: 'hivemind-media:ltx23-ic-ingredients-lora',
            workflowId: 'ltx23-ic-ingredients-lora',
            name: 'LTX 2.3 IC-LoRA Ingredients',
            description: 'Media Studio workflow',
            type: 'video',
            family: 'hivemind-media-studio',
            provider: 'hivemind-media-studio',
            needsImage: true,
            ready: true,
            detail: 'ready',
            aspectRatios: ['16:9'],
            durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
            defaultDuration: 5,
            tags: ['video', 'workflow', 'local'],
        });
        assert.equal(updates.length, 2);
        assert.equal(studio.getHivemindVideoModelById(recovered.videoModels[0].id)?.workflowId, 'ltx23-ic-ingredients-lora');

        const retained = await studio.loadHivemindStudioContext({ refresh: true });
        assert.equal(catalogRequests, 3);
        assert.equal(retained.videoModels[0].workflowId, 'ltx23-ic-ingredients-lora');
        assert.equal(studio.getHivemindVideoModelById(retained.videoModels[0].id)?.workflowId, 'ltx23-ic-ingredients-lora');
    } finally {
        global.window = originalWindow;
        global.fetch = originalFetch;
        global.localStorage = originalLocalStorage;
        global.sessionStorage = originalSessionStorage;
    }
});
