const test = require('node:test');
const assert = require('node:assert/strict');

function stubLocalStorage() {
    const store = new Map();
    global.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
    return store;
}

// Local image work units: steps x megapixels. A 1024x1024 run is ~1.05MP.
const MP = (1024 * 1024) / 1e6;

test('a measured run scales with the step count', async () => {
    stubLocalStorage();
    const { estimateGenerationSeconds, recordGenerationSeconds } = await import('../src/lib/genProgress.js');

    // The bug: steps used to be baked into the storage key, so raising 4 -> 8
    // wiped out every sample and the bar fell back to a flat 30s guess.
    recordGenerationSeconds('img|local|krea2', 4 * MP, 20);
    assert.equal(estimateGenerationSeconds('img|local|krea2', 4 * MP, 1.2), 20);
    assert.equal(estimateGenerationSeconds('img|local|krea2', 8 * MP, 1.2), 40);
    assert.equal(estimateGenerationSeconds('img|local|krea2', 2 * MP, 1.2), 10);
});

test('a measured run scales with the pixel count', async () => {
    stubLocalStorage();
    const { estimateGenerationSeconds, recordGenerationSeconds } = await import('../src/lib/genProgress.js');

    // 8 steps at 1024^2 measured; 8 steps at 1448^2 is twice the pixels.
    recordGenerationSeconds('img|local|krea2', 8 * MP, 42);
    assert.equal(estimateGenerationSeconds('img|local|krea2', 8 * 2 * MP, 1.2), 84);
});

test('an exact match wins over the scaled fit', async () => {
    stubLocalStorage();
    const { estimateGenerationSeconds, recordGenerationSeconds } = await import('../src/lib/genProgress.js');

    recordGenerationSeconds('key', 10, 30);
    recordGenerationSeconds('key', 20, 100); // superlinear in reality
    recordGenerationSeconds('key', 20, 104);
    // The 20-unit samples are used verbatim, not the line through 10 and 20.
    assert.equal(estimateGenerationSeconds('key', 20, 1), 102);
});

test('two measured sizes separate the fixed per-run overhead', async () => {
    const { estimateSecondsForWork } = await import('../src/lib/genProgress.js');

    // 12s of model-load overhead + 3s per unit: a pure ratio off the 10-unit
    // sample would overshoot 100 units by 20%.
    assert.equal(estimateSecondsForWork([[10, 42], [40, 132]], 100), 312);
    // Noise that inverts the slope falls back to the nearest measured point.
    assert.equal(estimateSecondsForWork([[10, 120], [50, 40]], 20), 240);
    assert.equal(estimateSecondsForWork([], 20), null);
});

test('with nothing measured the fallback rate still scales', async () => {
    stubLocalStorage();
    const { estimateGenerationSeconds } = await import('../src/lib/genProgress.js');

    // 25 steps at 1024^2 lands near the old flat 30s default...
    assert.ok(Math.abs(estimateGenerationSeconds('unseen', 25 * MP, 1.2) - 31.5) < 1);
    // ...but doubling the steps now doubles the expected time from the start.
    const ratio = estimateGenerationSeconds('unseen', 50 * MP, 1.2)
        / estimateGenerationSeconds('unseen', 25 * MP, 1.2);
    assert.ok(Math.abs(ratio - 2) < 0.01, `expected ~2x, got ${ratio}`);
    // Cloud models expose no steps or dimensions: one unit, one flat estimate.
    assert.equal(estimateGenerationSeconds('unseen-api', 1, 30), 30);
});

test('the smooth bar stays monotonic and never reaches 1 on time alone', async () => {
    const { computeSmoothProgress } = await import('../src/lib/genProgress.js');

    assert.equal(computeSmoothProgress({ elapsedSec: 15, estimateSec: 30 }), 0.5);
    assert.equal(computeSmoothProgress({ elapsedSec: 300, estimateSec: 30 }), 0.985);
    assert.equal(computeSmoothProgress({ elapsedSec: 1, estimateSec: 30, prevDisplay: 0.5 }), 0.5);
});

// --- how the image studio turns its settings into a key + work units --------

const KREA2 = { defaultSteps: 10, defaultWidth: 1024, samplers: ['euler_ancestral', 'deis_3m'] };
const localSettings = (overrides) => ({
    useLocalModel: true, selectedLocalModel: 'krea2-turbo', steps: 8, sampler: '', ...overrides,
});

test('steps and dimensions scale the work units instead of splitting the key', async () => {
    const { imageTimingProfile } = await import('../src/studios/image/imagePrefs.js');

    const eight = imageTimingProfile({
        settings: localSettings({ steps: 8 }), model: KREA2, dimensions: { width: 1024, height: 1024 },
    });
    const sixteen = imageTimingProfile({
        settings: localSettings({ steps: 16 }), model: KREA2, dimensions: { width: 1024, height: 1024 },
    });
    const wide = imageTimingProfile({
        settings: localSettings({ steps: 8 }), model: KREA2, dimensions: { width: 1792, height: 1024 },
    });

    // Same cost profile -> one shared pool of samples...
    assert.equal(eight.key, sixteen.key);
    assert.equal(eight.key, wide.key);
    // ...and the run's size lives in the work units.
    assert.equal(sixteen.work / eight.work, 2);
    assert.ok(Math.abs(wide.work / eight.work - 1.75) < 0.001);
});

test('the sampler swap gets its own key, because a step costs a different amount', async () => {
    const { imageTimingProfile } = await import('../src/studios/image/imagePrefs.js');

    // On Auto, Krea 2 runs deis_3m at <=5 steps (~2.7 model evals per step) and
    // euler_ancestral above it (1), so 4 steps is not simply half of 8.
    const four = imageTimingProfile({ settings: localSettings({ steps: 4 }), model: KREA2 });
    const eight = imageTimingProfile({ settings: localSettings({ steps: 8 }), model: KREA2 });
    assert.notEqual(four.key, eight.key);

    // Pinning the sampler pools them again — there the doubling holds.
    const pinnedFour = imageTimingProfile({ settings: localSettings({ steps: 4, sampler: 'deis_3m' }), model: KREA2 });
    const pinnedEight = imageTimingProfile({ settings: localSettings({ steps: 8, sampler: 'deis_3m' }), model: KREA2 });
    assert.equal(pinnedFour.key, pinnedEight.key);
    assert.equal(pinnedEight.work / pinnedFour.work, 2);

    // A model with no sampler choice never swaps, so its steps always pool.
    const plain = { defaultSteps: 20, defaultWidth: 1024 };
    assert.equal(
        imageTimingProfile({ settings: localSettings({ steps: 4 }), model: plain }).key,
        imageTimingProfile({ settings: localSettings({ steps: 8 }), model: plain }).key,
    );
});

test('cloud runs carry one flat unit of work', async () => {
    const { imageTimingProfile } = await import('../src/studios/image/imagePrefs.js');

    const profile = imageTimingProfile({
        settings: { useLocalModel: false, selectedModel: 'seedream-v4', selectedAr: '16:9', selectedResolution: '2K' },
    });
    assert.equal(profile.work, 1);
    assert.match(profile.key, /^img\|api\|seedream-v4\|/);
});
