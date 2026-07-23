const test = require('node:test');
const assert = require('node:assert/strict');

async function loadImageStudioHelpers() {
    return import('../src/components/ImageStudio.js');
}

test('image preferences retain provider, dropdown, advanced, and per-model LoRA settings', async () => {
    const { normalizeImagePreferences } = await loadImageStudioHelpers();

    assert.deepEqual(normalizeImagePreferences({
        modelId: ' local-krea2 ',
        imageMode: true,
        useLocalModel: true,
        localModelId: ' krea2-turbo ',
        aspectRatio: ' 9:16 ',
        resolution: '2K',
        localRuntimeMode: 'persistent',
        negativePrompt: 'washed out',
        guidanceScale: 99,
        steps: 0,
        seed: 42.4,
        style: 'Cinematic',
        batchCount: 9,
        customWidth: 1080,
        customHeight: 1920,
        referenceStrength: -5,
        coupleMode: 1,
        coupleDirection: 'vertical',
        coupleSplit: 95,
        couplePair: 'boys',
        loraSelections: {
            'krea2-turbo': [{
                id: ' pink-hair ',
                name: 'pink.safetensors',
                displayName: 'Pink Hair',
                previewUrl: '/preview/pink.jpg',
                strength: 20,
            }],
        },
    }), {
        modelId: 'local-krea2',
        imageMode: true,
        useLocalModel: true,
        localModelId: 'krea2-turbo',
        aspectRatio: '9:16',
        resolution: '2K',
        localRuntimeMode: 'persistent',
        negativePrompt: 'washed out',
        guidanceScale: 20,
        steps: 1,
        seed: 42,
        style: 'Cinematic',
        batchCount: 4,
        customWidth: 1080,
        customHeight: 1920,
        referenceStrength: 0,
        coupleMode: true,
        coupleDirection: 'vertical',
        coupleSplit: 90,
        couplePair: 'boys',
        modelSettings: {},
        loraSelections: {
            'krea2-turbo': [{
                id: 'pink-hair',
                name: 'pink.safetensors',
                displayName: 'Pink Hair',
                previewUrl: '/preview/pink.jpg',
                strength: 10,
            }],
        },
    });
});

test('image preferences reject missing models and recover safe defaults', async () => {
    const { normalizeImagePreferences } = await loadImageStudioHelpers();

    assert.equal(normalizeImagePreferences({ modelId: '' }), null);
    assert.deepEqual(normalizeImagePreferences({ modelId: 'z-image', style: 'removed', localRuntimeMode: 'invalid' }), {
        modelId: 'z-image',
        imageMode: false,
        useLocalModel: false,
        localModelId: '',
        aspectRatio: '',
        resolution: '',
        localRuntimeMode: 'one-off',
        negativePrompt: '',
        guidanceScale: 7.5,
        steps: 25,
        seed: -1,
        style: 'None',
        batchCount: 1,
        customWidth: 0,
        customHeight: 0,
        referenceStrength: 50,
        coupleMode: false,
        coupleDirection: 'horizontal',
        coupleSplit: 50,
        couplePair: 'girls',
        modelSettings: {},
        loraSelections: {},
    });
});

test('per-model settings are sanitized and junk entries dropped', async () => {
    const { normalizeImagePreferences } = await loadImageStudioHelpers();

    const prefs = normalizeImagePreferences({
        modelId: 'z-image',
        modelSettings: {
            'local:comfy-auto-wai-anima-couple-turbo': {
                steps: 400,
                guidanceScale: 3,
                negativePrompt: 'blurry',
                aspectRatio: ' 3:4 ',
                resolution: '',
                customWidth: -5,
                customHeight: 1344,
                localRuntimeMode: 'persistent',
                coupleMode: 1,
                coupleDirection: 'vertical',
                coupleSplit: 65,
                couplePair: 'mixed',
            },
            '': { steps: 5 },
            'api:junk': 'not-an-object',
        },
    });

    assert.deepEqual(prefs.modelSettings, {
        'local:comfy-auto-wai-anima-couple-turbo': {
            steps: 50,
            guidanceScale: 3,
            negativePrompt: 'blurry',
            aspectRatio: '3:4',
            resolution: '',
            customWidth: 0,
            customHeight: 1344,
            localRuntimeMode: 'persistent',
            coupleMode: true,
            coupleDirection: 'vertical',
            coupleSplit: 65,
            couplePair: 'mixed',
        },
    });
});
