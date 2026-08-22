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
            supportsEndFrame: false,
            supportsMotionContext: false,
            supportsReferenceImages: false,
            // Every accepts-driven capability is derived HERE and read verbatim
            // downstream; the studio must not re-test `accepts` for itself.
            supportsSpectrum: false,
            supportsFastHighRes: false,
            supportsQualitySteps: false,
            // No reference slots wired on this workflow — the References panel
            // reads this to size itself, and null means "no reference lane".
            referenceSlots: null,
            // Not a routing target — it is a tier the user picks directly.
            routingOnly: false,
            ingredientInputs: { max_images: 12, layout: 'adaptive-pack' },
            id: 'hivemind-media:ltx23-ic-ingredients-lora',
            workflowId: 'ltx23-ic-ingredients-lora',
            // Null for a model with only one build; set when a workflow declares
            // a Lite/Standard pair so the picker can collapse them into one row.
            tierGroup: null,
            tier: null,
            beta: false,
            name: 'LTX 2.3 IC-LoRA Ingredients',
            description: 'Media Studio workflow',
            type: 'video',
            family: 'hivemind-media-studio',
            workflowFamily: '',
            provider: 'hivemind-media-studio',
            needsImage: true,
            ready: true,
            detail: 'ready',
            aspectRatios: ['16:9'],
            durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
            defaultDuration: 5,
            // No registered steps default in this fixture; a full-step lane
            // (e.g. MiniMax H3's 15) enables the refinement presets.
            defaultSteps: null,
            // No measured motion-reference budget in this fixture, so the
            // duration range is not narrowed: only a workflow that HAS one
            // (MiniMax H3) drops the lengths a motion clip cannot render.
            motionReferenceMaxSeconds: null,
            // ...and without a budget there is nothing to price a run against
            // either; MiniMax H3 publishes both, so its picker prices the
            // actual attachments instead of the per-canvas worst case.
            motionReferencePricing: null,
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

// Reference mode is reached by attaching references to the normal tier, never
// by picking it. Landing ON it strands the user: its graph has no frame inputs
// (the Frames control vanishes) and it refuses to run without a reference — a
// real reload came back stuck exactly that way.
test('a routing-only workflow stays resolvable but maps back to its real tier', async () => {
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

    global.fetch = async (url) => {
        if (String(url).startsWith('/api/simple/prompts')) return response(true, { prompts: [] });
        return response(true, {
            ok: true,
            media: {
                video: [{
                    id: 'media-studio-mcp',
                    label: 'Media Studio',
                    available: true,
                    detail: 'ready',
                    models: [
                        {
                            id: 'minimax-h3',
                            label: 'MiniMax H3',
                            family: 'minimax',
                            // The real tier does NOT accept references itself —
                            // that is exactly why attaching one has to route.
                            accepts: ['prompt', 'end_image_base64'],
                            compatible_base_models: ['MiniMax H3'],
                        },
                        {
                            id: 'minimax-h3-turbo',
                            label: 'MiniMax H3 Turbo',
                            family: 'minimax',
                            beta: true,
                            accepts: ['prompt', 'end_image_base64'],
                            compatible_base_models: ['MiniMax H3'],
                        },
                        {
                            id: 'minimax-h3-reference',
                            label: 'MiniMax H3 Reference',
                            family: 'minimax',
                            beta: true,
                            routing_only: true,
                            accepts: ['prompt', 'reference_images', 'reference_videos', 'reference_audios'],
                            compatible_base_models: ['MiniMax H3'],
                            reference_slots: { images: 9, videos: 3, audios: 3 },
                        },
                    ],
                }],
            },
        });
    };

    try {
        const moduleUrl = `${pathToFileURL(path.join(__dirname, '../src/lib/hivemindStudio.js')).href}?test=${Date.now()}`;
        const studio = await import(moduleUrl);
        await studio.loadHivemindStudioContext({ refresh: true });

        const referenceId = 'hivemind-media:minimax-h3-reference';
        const baseId = 'hivemind-media:minimax-h3';
        const turboId = 'hivemind-media:minimax-h3-turbo';

        // Still discoverable — reference routing resolves against this list.
        assert.equal(studio.getHivemindVideoModelById(referenceId)?.routingOnly, true);
        assert.equal(studio.referenceWorkflowForHivemindModel(baseId)?.id, referenceId);
        assert.equal(studio.getHivemindVideoModelById(referenceId)?.referenceSlots?.videos, 3);

        // …but never a tier you sit on. It maps back to the plain H3 rather
        // than the beta turbo, and ordinary ids are returned untouched.
        assert.equal(studio.selectableHivemindModelId(referenceId), baseId);
        assert.equal(studio.selectableHivemindModelId(baseId), baseId);
        assert.equal(studio.selectableHivemindModelId(turboId), turboId);
    } finally {
        global.window = originalWindow;
        global.fetch = originalFetch;
        global.localStorage = originalLocalStorage;
        global.sessionStorage = originalSessionStorage;
    }
});
