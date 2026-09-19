// Deliberately textual: which reference views the studio exposes for a
// conditioning-only lane is wiring into a lane this machine may not have.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// These used to import the retired vanilla studio (src/components/VideoStudio.js),
// which the app stopped loading when the React port landed and which had since
// drifted from it — its normalizeVideoPreferences still returned a
// `pingWhenComplete` field the studio no longer persists. They now exercise the
// SHIPPED rules in src/lib/videoPreferences.js.
async function loadVideoStudioHelpers() {
    return import('../src/lib/videoPreferences.js');
}

const readSource = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('video progress normalizes ratio and percentage telemetry', async () => {
    const { normalizeVideoGenerationProgress } = await loadVideoStudioHelpers();

    assert.equal(normalizeVideoGenerationProgress(0.42), 0.42);
    assert.equal(normalizeVideoGenerationProgress(42), 0.42);
    assert.equal(normalizeVideoGenerationProgress(120), 1);
    assert.equal(normalizeVideoGenerationProgress(-1), 0);
    assert.equal(normalizeVideoGenerationProgress(undefined), null);
});

test('video progress classifies provider stages without displaying raw messages', async () => {
    const { classifyVideoGenerationStage } = await loadVideoStudioHelpers();

    assert.equal(classifyVideoGenerationStage('loading model weights'), 'loading');
    assert.equal(classifyVideoGenerationStage('pending'), 'queued');
    assert.equal(classifyVideoGenerationStage('encoding output'), 'finishing');
    assert.equal(classifyVideoGenerationStage('sampling'), 'rendering');
});

test('video progress formats elapsed generation time', async () => {
    const { formatVideoGenerationElapsed } = await loadVideoStudioHelpers();

    assert.equal(formatVideoGenerationElapsed(0), '0:00');
    assert.equal(formatVideoGenerationElapsed(65_900), '1:05');
});

test('video popup positioning stays inside desktop and mobile viewports', async () => {
    const { clampVideoDropdownViewportLeft } = await loadVideoStudioHelpers();

    assert.equal(clampVideoDropdownViewportLeft(900, 384, 1024), 628);
    assert.equal(clampVideoDropdownViewportLeft(-40, 384, 1024), 12);
    assert.equal(clampVideoDropdownViewportLeft(24, 272, 320), 24);
    assert.equal(clampVideoDropdownViewportLeft(0, 400, 320), 12);
});

test('studio dropdowns cap their height to the space above the anchor and scroll', async () => {
    const { clampVideoDropdownMaxHeight } = await loadVideoStudioHelpers();

    assert.equal(clampVideoDropdownMaxHeight(600), 576);
    assert.equal(clampVideoDropdownMaxHeight(120), 180);
    assert.equal(clampVideoDropdownMaxHeight(undefined), 180);

    // The vanilla studios each wrote style.maxHeight themselves, in two copies;
    // the React port routes every dropdown through one Menu component, so the
    // rule is asserted once, where it now lives.
    const menu = readSource('src/ui/Menu.jsx');
    assert.match(menu, /max-h-\[min\(/, 'the shared menu caps its height against the viewport');
    assert.match(menu, /overflow-y-auto/, 'and scrolls rather than overflowing the page');
});

test('Ingredients start frames choose the nearest supported output geometry', async () => {
    const { closestVideoAspectRatio } = await loadVideoStudioHelpers();
    const ratios = ['16:9', '9:16', '4:3', '3:4', '1:1'];

    assert.equal(closestVideoAspectRatio(720, 1024, ratios), '3:4');
    assert.equal(closestVideoAspectRatio(1920, 1080, ratios), '16:9');
    assert.equal(closestVideoAspectRatio(1000, 1000, ratios), '1:1');
    assert.equal(closestVideoAspectRatio(0, 1000, ratios), null);
});

test('video preferences retain the complete generation configuration', async () => {
    const { normalizeVideoPreferences } = await loadVideoStudioHelpers();

    const restored = normalizeVideoPreferences({
        modelId: ' hivemind-media:ltx23-eros-fast ',
        localMode: true,
        aspectRatio: ' 16:9 ',
        duration: '6',
        resolution: '1080p',
        quality: 'high',
        mode: 'pro',
        effectName: 'dolly',
        advancedValues: { generate_audio: false, guidance: 3.5, ignored: null },
        loraSelections: {
            'ltx23-regular-fp8': [{ id: 'ltx/style.safetensors', displayName: 'Style', strength: 0.75 }],
        },
        ingredientSelections: {
            'ltx23-ic-ingredients-lora': [
                { url: '/api/media-studio/references/front.png', description: ' front view ' },
                { url: 'https://outside.test/profile.png', description: 'ignored' },
            ],
        },
    });

    assert.equal(restored.modelId, 'hivemind-media:ltx23-eros-fast', 'trimmed');
    assert.equal(restored.localMode, true);
    assert.equal(restored.aspectRatio, '16:9');
    assert.equal(restored.duration, 6, 'a numeric string is a duration');
    assert.equal(restored.resolution, '1080p');
    assert.equal(restored.quality, 'high');
    assert.equal(restored.mode, 'pro');
    assert.equal(restored.effectName, 'dolly');
    assert.deepEqual(restored.advancedValues, { generate_audio: false, guidance: 3.5 },
        'a null advanced value is dropped, a false one is kept');
    assert.deepEqual(restored.loraSelections, {
        'ltx23-regular-fp8': [{
            id: 'ltx/style.safetensors',
            name: 'ltx/style.safetensors',
            displayName: 'Style',
            previewUrl: '',
            strength: 0.75,
            enabled: true,
        }],
    });
    assert.deepEqual(restored.ingredientSelections, [
        { url: '/api/media-studio/references/front.png' },
    ], 'an off-origin reference url never persists, and the description is not persisted at all');
    assert.equal(restored.ingredientSelectedSheet, 'stitched');
    // The completion ping is a shared all-studio setting now, not a video
    // preference — the key must not come back here.
    assert.equal('pingWhenComplete' in restored, false);

    const minimal = normalizeVideoPreferences({ modelId: 'seedance-v2.0-t2v', duration: 0 });
    assert.equal(minimal.duration, null, 'zero is not a duration');
    assert.equal(minimal.localMode, null, 'unset stays unset rather than defaulting to false');
    assert.deepEqual(minimal.advancedValues, {});
    assert.deepEqual(minimal.ingredientSelections, []);
    assert.equal(minimal.ingredientSelectedSheet, '');
    assert.equal(minimal.seed, -1, 'no saved seed means a fresh one per generation');

    assert.equal(normalizeVideoPreferences({ duration: 5 }), null, 'no model id, nothing to restore');
    assert.equal(normalizeVideoPreferences(null), null);
    assert.equal(normalizeVideoPreferences({ modelId: 'x'.repeat(300) }), null, 'bounded id');
});

test('video preferences migrate regular and Eros Ingredients into one shared selection', async () => {
    const { normalizeVideoPreferences } = await loadVideoStudioHelpers();

    const preferences = normalizeVideoPreferences({
        modelId: 'hivemind-media:ltx23-eros-ic-ingredients-lora',
        ingredientSelections: {
            'ltx23-ic-ingredients-lora': [
                { url: '/api/media-studio/references/front.png', description: 'front view' },
                { url: '/api/media-studio/references/profile.png', description: '' },
            ],
            'ltx23-eros-ic-ingredients-lora': [
                { url: '/api/media-studio/references/profile.png', description: 'profile view' },
            ],
        },
    });

    // The two per-model lists merge into one selection, deduped by url. The
    // descriptions are NOT here: they ride in the encrypted composer section
    // (tests/persistedBlobPrivacy.test.js), because a sentence about a picture
    // of somebody's own life is prompt text.
    assert.deepEqual(preferences.ingredientSelections, [
        { url: '/api/media-studio/references/front.png' },
        { url: '/api/media-studio/references/profile.png' },
    ]);
});

test('video preferences persist uploaded ingredient sheets and the selected sheet', async () => {
    const { normalizeVideoPreferences } = await loadVideoStudioHelpers();

    const preferences = normalizeVideoPreferences({
        modelId: 'hivemind-media:ltx23-ic-ingredients-lora',
        ingredientSelections: [{ url: '/api/media-studio/references/front.png', description: 'front' }],
        ingredientSheets: [
            { url: '/api/media-studio/references/sheet.png', description: ' full cast sheet ' },
            { url: 'https://outside.test/sheet.png', description: 'ignored' },
        ],
        ingredientSelectedSheet: '/api/media-studio/references/sheet.png',
    });

    assert.deepEqual(preferences.ingredientSheets, [
        { url: '/api/media-studio/references/sheet.png' },
    ]);
    assert.equal(preferences.ingredientSelectedSheet, '/api/media-studio/references/sheet.png');

    const missingSelection = normalizeVideoPreferences({
        modelId: 'hivemind-media:ltx23-ic-ingredients-lora',
        ingredientSelections: [{ url: '/api/media-studio/references/front.png', description: '' }],
        ingredientSelectedSheet: '/api/media-studio/references/gone.png',
    });
    assert.equal(missingSelection.ingredientSelectedSheet, '');
});

test('ingredient sheet selection normalizes stitched, uploaded, and off states', async () => {
    const { normalizeSelectedVideoIngredientSheet } = await loadVideoStudioHelpers();
    const views = [{ url: '/api/media-studio/references/a.png', description: '' }];
    const sheets = [{ url: '/api/media-studio/references/sheet.png', description: '' }];

    // Legacy state without an explicit selection keeps saved views active.
    assert.equal(normalizeSelectedVideoIngredientSheet(undefined, views, sheets), 'stitched');
    assert.equal(normalizeSelectedVideoIngredientSheet(undefined, [], sheets), '');
    assert.equal(normalizeSelectedVideoIngredientSheet('stitched', views, sheets), 'stitched');
    assert.equal(normalizeSelectedVideoIngredientSheet('stitched', [], sheets), '');
    assert.equal(
        normalizeSelectedVideoIngredientSheet('/api/media-studio/references/sheet.png', views, sheets),
        '/api/media-studio/references/sheet.png',
    );
    assert.equal(normalizeSelectedVideoIngredientSheet('/api/media-studio/references/gone.png', views, sheets), '');
    // Tapping the selected sheet again turns ingredients off and stays off.
    assert.equal(normalizeSelectedVideoIngredientSheet('', views, sheets), '');
});

test('video Studio renders and forwards workflow-compatible LoRAs', () => {
    const source = readSource('src/studios/VideoStudio.jsx');
    const hive = readSource('src/lib/hivemindStudio.js');

    assert.match(source, /localAI\.listLoras\(/);
    assert.match(source, /loras: loraGenerationPayload\(/);
    assert.match(source, /hivemind-context-updated/);
    assert.match(readSource('src/studios/video/videoLogic.js'), /isHivemindStudioEnabled\(\) && isLocalAIAvailable\(\)/);
    assert.match(hive, /supportsLoras: Boolean\(workflow\.supports_loras\)/);
    assert.match(hive, /loras: params\.loras/);
});

test('Explore supports direct video routing and narrow-width media navigation', () => {
    const app = readSource('src/app/App.jsx');
    const shell = readSource('src/app/Shell.jsx');

    // ?page= still selects a studio directly, and the choice is written back to
    // the URL so a deep link survives a reload.
    assert.match(app, /get\('page'\)/);
    assert.match(app, /searchParams\.set\('page'/);
    assert.match(shell, /lg:hidden/, 'the media nav collapses on narrow widths');
});

test('video Studio exposes conditioning-only Ingredients reference views', () => {
    const studio = readSource('src/studios/VideoStudio.jsx');
    const panel = readSource('src/studios/video/IngredientsPanel.jsx');
    const hive = readSource('src/lib/hivemindStudio.js');

    assert.match(panel, /Ingredient references/);
    assert.match(panel, /Stitched sheet/);
    assert.match(panel, /Active in next generation/);
    assert.match(panel, /Tap again to turn ingredients off/);
    assert.match(panel, /Used as-is, no stitching/);
    // Selecting or uploading a finished sheet snaps the output aspect to the
    // sheet's geometry so it is not letterboxed into a tiny conditioning image,
    // and generation re-asserts the match even after a session restore.
    assert.match(studio, /matchAspectToIngredientSheet/);
    assert.match(studio, /previewHivemindIngredientSheet/);
    assert.match(studio, /ingredientImages: /);

    const mcp = fs.readFileSync(path.join(__dirname, '../../media-gateway/bin/media-studio-mcp.mjs'), 'utf8');
    // A single ingredient source is described as a whole reference sheet, not
    // as a lone positioned panel.
    assert.match(mcp, /entries\.length === 1/);
    assert.match(mcp, /The reference sheet shows the same character from multiple angles/);
    assert.match(hive, /supportsIngredientImages: accepts\.includes\('ingredient_images'\)/);
    assert.match(hive, /ingredient_images: ingredientImages/);
    assert.match(hive, /resolution: String\(params\.resolution\)\.trim\(\)\.toLowerCase\(\)/);
    assert.match(hive, /workflow\.aspect_ratios/);
    assert.match(hive, /workflow\.default_duration_seconds/);
    assert.doesNotMatch(hive, /!ingredientImages\.length && imageReference/);
    assert.doesNotMatch(hive, /!ingredientImages\.length && imageBase64/);
    assert.match(hive, /\/api\/media-studio\/ingredients\/preview/);
});

// DROPPED with the vanilla studio: 'expanded media view closes via X or backdrop
// without touching the setup'. It asserted that each studio's closeCanvasBtn
// handler called resetToPromptBar() and nothing else — a rule about a
// full-screen canvas overlay that the React port does not have. Results now
// render inline in StudioLayout, so there is no close handler that could clear
// the prompt. The test is not portable; the construct it guarded is gone.

test('video preference restoration validates advanced values against the current model schema', async () => {
    const { getRestoredAdvancedVideoValues } = await loadVideoStudioHelpers();
    const model = {
        inputs: {
            generate_audio: { type: 'boolean', default: true },
            movement: { type: 'string', enum: ['small', 'large'], default: 'small' },
            guidance: { type: 'float', minValue: 1, maxValue: 5, default: 2 },
            steps: { type: 'int', minValue: 1, maxValue: 20, default: 8 },
        },
    };

    assert.deepEqual(getRestoredAdvancedVideoValues(model, {
        generate_audio: false,
        movement: 'removed-option',
        guidance: 99,
        steps: 6.7,
        stale_field: 'ignored',
    }), {
        generate_audio: false,
        movement: 'small',
        guidance: 5,
        steps: 7,
    });
});

test('video advanced inputs include supported model options and preserve falsey defaults', async () => {
    const { getAdvancedVideoInputs, getDefaultAdvancedVideoValues, getAdvancedVideoPayload } = await loadVideoStudioHelpers();
    const model = {
        inputs: {
            prompt: { type: 'string', default: '' },
            duration: { type: 'int', default: 5 },
            generate_audio: { type: 'boolean', title: 'Generate Audio', default: false },
            movement_amplitude: { type: 'string', enum: ['small', 'large'], default: 'small' },
            variety: { type: 'int', minValue: 0, maxValue: 100, default: 0 },
            images_list: { type: 'array' },
        },
    };

    assert.deepEqual(
        getAdvancedVideoInputs(model).map((input) => input.name),
        ['generate_audio', 'movement_amplitude', 'variety'],
    );
    assert.deepEqual(getDefaultAdvancedVideoValues(model), {
        generate_audio: false,
        movement_amplitude: 'small',
        variety: 0,
    });
    assert.deepEqual(getAdvancedVideoPayload(model, {
        generate_audio: true,
        movement_amplitude: 'large',
        variety: 25,
        ignored: 'nope',
    }), {
        generate_audio: true,
        movement_amplitude: 'large',
        variety: 25,
    });
});

test('Muapi copies only model-declared video inputs, including false values', async () => {
    const { applyDeclaredModelInputs } = await import('../src/lib/muapi.js');
    const payload = applyDeclaredModelInputs(
        { prompt: 'shot' },
        { prompt: 'shot', generate_audio: false, camera_fixed: true, ignored: 'nope' },
        { inputs: { prompt: {}, generate_audio: {}, camera_fixed: {} } },
    );

    assert.deepEqual(payload, { prompt: 'shot', generate_audio: false, camera_fixed: true });
});
