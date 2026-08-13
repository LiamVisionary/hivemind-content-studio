const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function response(payload) {
    return { ok: true, json: async () => payload };
}

// The MiniMax H3 family as the catalog reports it when the workflow registry
// could NOT be read: the same model, described from the server's built-in
// fallback list. Note what is missing — reference_images, the end-frame and
// motion-context fields, and the routing-only reference workflow entirely.
const DEGRADED_MODELS = [{
    id: 'minimax-h3',
    label: 'MiniMax H3',
    accepts: ['image_base64'],
    family: 'minimax',
    default_duration_seconds: 5,
}];

const LIVE_MODELS = [
    {
        id: 'minimax-h3',
        label: 'MiniMax H3',
        accepts: ['image_base64', 'end_image_base64', 'motion_context_base64'],
        family: 'minimax',
        default_duration_seconds: 5,
    },
    {
        id: 'minimax-h3-reference',
        label: 'MiniMax H3 Reference',
        accepts: ['reference_images'],
        family: 'minimax',
        reference_slots: { images: 9, videos: 3, audios: 3 },
        routing_only: true,
    },
];

function catalog(models, { registryLive } = {}) {
    const provider = {
        id: 'media-studio-mcp',
        label: 'Media Studio',
        available: true,
        detail: 'ready',
        models,
    };
    if (registryLive !== undefined) provider.registry_live = registryLive;
    return { ok: true, media: { video: [provider] } };
}

test('a catalog built without the live workflow registry is flagged, not silently believed', async () => {
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

    const payloads = [
        catalog(DEGRADED_MODELS, { registryLive: false }),
        catalog(LIVE_MODELS, { registryLive: true }),
        catalog(LIVE_MODELS),
    ];
    let request = 0;
    global.fetch = async (url) => {
        if (String(url).startsWith('/api/simple/prompts')) return response({ prompts: [] });
        return response(payloads[Math.min(request++, payloads.length - 1)]);
    };

    try {
        const moduleUrl = `${pathToFileURL(path.join(__dirname, '../src/lib/hivemindStudio.js')).href}?test=${Date.now()}`;
        const studio = await import(moduleUrl);

        const degraded = await studio.loadHivemindStudioContext();
        // The damage: a full model list, so no caller can tell by counting —
        // this is precisely why the studio's empty-catalog retry never fired and
        // the video route kept rendering MiniMax H3's pre-reference toolbar.
        assert.equal(degraded.videoModels.length, 1);
        assert.equal(degraded.videoRegistryLive, false);
        assert.equal(studio.referenceWorkflowForHivemindModel('hivemind-media:minimax-h3'), null);

        const live = await studio.loadHivemindStudioContext({ refresh: true });
        assert.equal(live.videoRegistryLive, true);
        const reference = studio.referenceWorkflowForHivemindModel('hivemind-media:minimax-h3');
        assert.equal(reference?.workflowId, 'minimax-h3-reference');
        assert.deepEqual(reference.referenceSlots, { images: 9, videos: 3, audios: 3 });
        assert.equal(reference.routingOnly, true);

        // A payload from a server that predates the flag was always a live read.
        const legacy = await studio.loadHivemindStudioContext({ refresh: true });
        assert.equal(legacy.videoRegistryLive, true);
    } finally {
        global.window = originalWindow;
        global.fetch = originalFetch;
        global.localStorage = originalLocalStorage;
        global.sessionStorage = originalSessionStorage;
    }
});
