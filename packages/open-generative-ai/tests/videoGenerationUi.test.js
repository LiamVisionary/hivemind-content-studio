const test = require('node:test');
const assert = require('node:assert/strict');

async function loadVideoStudioHelpers() {
    return import('../src/components/VideoStudio.js');
}

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

    const fs = require('node:fs');
    const path = require('node:path');
    for (const file of ['VideoStudio.js', 'ImageStudio.js']) {
        const source = fs.readFileSync(path.join(__dirname, '../src/components', file), 'utf8');
        assert.match(source, /dropdown\.style\.maxHeight/, `${file} caps dropdown height`);
        assert.match(source, /flex flex-col min-h-0 max-h-\[70vh\]/, `${file} lets the model list shrink and scroll`);
        assert.doesNotMatch(source, /flex flex-col h-full max-h-\[70vh\]/, `${file} dropped the unconstrained wrapper`);
    }
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

    assert.deepEqual(
        normalizeVideoPreferences({
            modelId: ' hivemind-video:ltx23-eros-fast ',
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
            pingWhenComplete: true,
        }),
        {
            modelId: 'hivemind-video:ltx23-eros-fast',
            localMode: true,
            aspectRatio: '16:9',
            duration: 6,
            resolution: '1080p',
            quality: 'high',
            mode: 'pro',
            effectName: 'dolly',
            advancedValues: { generate_audio: false, guidance: 3.5 },
            loraSelections: {
                'ltx23-regular-fp8': [{
                    id: 'ltx/style.safetensors',
                    name: 'ltx/style.safetensors',
                    displayName: 'Style',
                    previewUrl: '',
                    strength: 0.75,
                }],
            },
            ingredientSelections: [{
                url: '/api/media-studio/references/front.png',
                description: 'front view',
            }],
            ingredientSheets: [],
            ingredientSelectedSheet: 'stitched',
            pingWhenComplete: true,
        },
    );
    assert.deepEqual(
        normalizeVideoPreferences({ modelId: 'seedance-v2.0-t2v', duration: 0 }),
        {
            modelId: 'seedance-v2.0-t2v',
            localMode: null,
            aspectRatio: '',
            duration: null,
            resolution: '',
            quality: '',
            mode: '',
            effectName: '',
            advancedValues: {},
            loraSelections: {},
            ingredientSelections: [],
            ingredientSheets: [],
            ingredientSelectedSheet: '',
            pingWhenComplete: false,
        },
    );
    assert.equal(normalizeVideoPreferences({ duration: 5 }), null);
    assert.equal(normalizeVideoPreferences(null), null);
});

test('video preferences migrate regular and Eros Ingredients into one shared selection', async () => {
    const { normalizeVideoPreferences } = await loadVideoStudioHelpers();

    const preferences = normalizeVideoPreferences({
        modelId: 'hivemind-video:ltx23-eros-ic-ingredients-lora',
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

    assert.deepEqual(preferences.ingredientSelections, [
        { url: '/api/media-studio/references/front.png', description: 'front view' },
        { url: '/api/media-studio/references/profile.png', description: 'profile view' },
    ]);
});

test('video preferences persist uploaded ingredient sheets and the selected sheet', async () => {
    const { normalizeVideoPreferences } = await loadVideoStudioHelpers();

    const preferences = normalizeVideoPreferences({
        modelId: 'hivemind-video:ltx23-ic-ingredients-lora',
        ingredientSelections: [{ url: '/api/media-studio/references/front.png', description: 'front' }],
        ingredientSheets: [
            { url: '/api/media-studio/references/sheet.png', description: ' full cast sheet ' },
            { url: 'https://outside.test/sheet.png', description: 'ignored' },
        ],
        ingredientSelectedSheet: '/api/media-studio/references/sheet.png',
    });

    assert.deepEqual(preferences.ingredientSheets, [
        { url: '/api/media-studio/references/sheet.png', description: 'full cast sheet' },
    ]);
    assert.equal(preferences.ingredientSelectedSheet, '/api/media-studio/references/sheet.png');

    const missingSelection = normalizeVideoPreferences({
        modelId: 'hivemind-video:ltx23-ic-ingredients-lora',
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

test('video Studio renders and forwards workflow-compatible LoRAs', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '../src/components/VideoStudio.js'), 'utf8');
    const hive = fs.readFileSync(path.join(__dirname, '../src/lib/hivemindStudio.js'), 'utf8');

    assert.match(source, /createCivitaiDownloadDialog/);
    assert.match(source, /localAI\.listLoras\(model\.workflowId\)/);
    assert.match(source, /loras: loraGenerationPayload\(currentVideoLoraSelection\(\)\)/);
    assert.match(source, /Download LoRA/);
    assert.match(source, /hivemind-context-updated/);
    assert.match(source, /isHivemindStudioEnabled\(\) && isLocalAIAvailable\(\)/);
    assert.match(hive, /supportsLoras: Boolean\(workflow\.supports_loras\)/);
    assert.match(hive, /loras: params\.loras/);
});

test('Explore supports direct video routing and narrow-width media navigation', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
    const shell = fs.readFileSync(path.join(__dirname, '../src/components/AppShell.js'), 'utf8');

    assert.match(main, /get\('page'\)/);
    assert.match(main, /navigate\(builders\[requestedPage\] \|\| HUB_PAGES\[requestedPage\] \? requestedPage : 'image'\)/);
    // A failed lazy import must leave the router retryable (currentPage only
    // commits after a successful mount) and trigger stale-chunk recovery.
    assert.doesNotMatch(main, /if \(page === currentPage\) return;.{0,120}currentPage = page;/s);
    assert.match(main, /await loadPageModule\(builders\[page\]\);[\s\S]*?currentPage = page;/);
    // One immediate retry absorbs transient import failures (dist rebuilt
    // mid-session / stack restarting) before the router snaps back.
    assert.match(main, /async function loadPageModule\(loader\) \{\s*try \{ return await loader\(\); \}\s*catch \{ return loader\(\); \}/);
    assert.match(main, /recoverFromStaleChunks\(error\)/);
    assert.match(main, /dynamically imported module/);
    assert.match(shell, /Studio media navigation/);
    assert.match(shell, /lg:hidden/);
});

test('video Studio exposes conditioning-only Ingredients reference views', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '../src/components/VideoStudio.js'), 'utf8');
    const hive = fs.readFileSync(path.join(__dirname, '../src/lib/hivemindStudio.js'), 'utf8');

    assert.match(source, /Ingredient references/);
    assert.match(source, /LTX Ingredients/);
    assert.match(source, /v-ingredients-btn/);
    assert.match(source, /workflowId === 'ltx23-ic-ingredients-lora'/);
    assert.match(source, /selectedModel === workflow\.id && dropdownOpen === 'advanced'/);
    assert.match(source, /Stitched sheet/);
    assert.match(source, /data-ingredient-count/);
    assert.match(source, /Active in next generation/);
    assert.match(source, /ingredient reference views are active for the next generation/);
    assert.match(source, /ingredientFileInput\.multiple = true/);
    assert.match(source, /ingredientImages: currentIngredientSelection/);
    assert.match(source, /ingredientImages: activeIngredientSheetItems/);
    assert.match(source, /sharedIngredientSelections/);
    assert.match(source, /sharedIngredientSheets/);
    assert.match(source, /ingredientSheetFileInput/);
    assert.match(source, /normalizeSelectedVideoIngredientSheet/);
    assert.match(source, /Tap again to turn ingredients off/);
    assert.match(source, /Used as-is, no stitching/);
    assert.match(source, /selectedIngredientSheet = 'stitched'/);
    assert.match(source, /selectedIngredientSheet = result\.url/);
    // Selecting or uploading a finished sheet snaps the output aspect to the
    // sheet's geometry so it is not letterboxed into a tiny conditioning image,
    // and generation re-asserts the match even after a session restore.
    assert.match(source, /matchAspectToIngredientSheet/);
    assert.equal(source.match(/void matchAspectToIngredientSheet\(selectedIngredientSheet\)/g).length, 2);
    assert.match(source, /await matchAspectToIngredientSheet\(selectedIngredientSheet\)/);
    // Local workflows expose a Standard/High resolution tier that reaches the
    // backend as a lowercase resolution field.
    assert.match(source, /return \['Standard', 'High'\]/);
    assert.match(source, /resolution: String\(selectedResolution \|\| ''\)\.toLowerCase\(\) === 'high' \? 'high' : 'standard'/);
    assert.doesNotMatch(source, /ingredientSelectionsByModel/);

    const mcp = fs.readFileSync(path.join(__dirname, '../../media-gateway/bin/media-studio-mcp.mjs'), 'utf8');
    // A single ingredient source is described as a whole reference sheet, not
    // as a lone positioned panel.
    assert.match(mcp, /entries\.length === 1/);
    assert.match(mcp, /The reference sheet shows the same character from multiple angles/);
    assert.match(source, /else if \(uploadedImageUrl\) \{\s*localParams\.image = uploadedImageUrl;/);
    assert.match(source, /Number\(duration\) === Number\(model\?\.inputs\?\.duration\?\.default\)/);
    assert.match(source, /previewHivemindIngredientSheet/);
    assert.match(hive, /supportsIngredientImages: accepts\.includes\('ingredient_images'\)/);
    assert.match(hive, /ingredient_images: ingredientImages/);
    assert.match(hive, /resolution: String\(params\.resolution\)\.trim\(\)\.toLowerCase\(\)/);
    assert.match(hive, /workflow\.aspect_ratios/);
    assert.match(hive, /workflow\.default_duration_seconds/);
    assert.doesNotMatch(hive, /!ingredientImages\.length && imageReference/);
    assert.doesNotMatch(hive, /!ingredientImages\.length && imageBase64/);
    assert.match(hive, /\/api\/media-studio\/ingredients\/preview/);
});

test('expanded media view closes via X or backdrop without touching the setup', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    for (const file of ['ImageStudio.js', 'VideoStudio.js']) {
        const source = fs.readFileSync(path.join(__dirname, '../src/components', file), 'utf8');
        assert.match(source, /closeCanvasBtn/, `${file} has an X close button`);
        assert.match(source, /event\.target === canvas/, `${file} closes on backdrop click`);
        // The plain close resets the view only — it must not restore an old
        // context or clear the user's in-progress prompt and settings.
        const closeHandler = source.match(/closeCanvasBtn\.onclick[\s\S]{0,220}?\};/)[0];
        assert.match(closeHandler, /resetToPromptBar\(\)/, `${file} close returns to the prompt bar`);
        assert.doesNotMatch(closeHandler, /restore|clearViewed|textarea\.value|picker\.reset/, `${file} close leaves setup untouched`);
    }
});

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
