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

test('video preferences retain only a valid model id and duration', async () => {
    const { normalizeVideoPreferences } = await loadVideoStudioHelpers();

    assert.deepEqual(
        normalizeVideoPreferences({ modelId: ' hivemind-video:ltx23-eros-fast ', duration: '6' }),
        { modelId: 'hivemind-video:ltx23-eros-fast', duration: 6 },
    );
    assert.deepEqual(
        normalizeVideoPreferences({ modelId: 'seedance-v2.0-t2v', duration: 0 }),
        { modelId: 'seedance-v2.0-t2v', duration: null },
    );
    assert.equal(normalizeVideoPreferences({ duration: 5 }), null);
    assert.equal(normalizeVideoPreferences(null), null);
});
