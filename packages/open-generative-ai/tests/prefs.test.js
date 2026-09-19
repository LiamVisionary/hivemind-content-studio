// The one preferences document, and the migration that empties the old keys.
//
// Seven storage keys became one. The parts worth asserting are the parts a
// person would notice if they broke: the migration runs once and DELETES what
// it moved (two copies of a setting is how they drift), the Discover query is
// dropped rather than carried across (it is text somebody typed), a corrupted
// document degrades to defaults instead of throwing at boot, and an export
// carries no prompt, key or search text.
const test = require('node:test');
const assert = require('node:assert/strict');

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    key: (index) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  };
}

async function withStorage(seed, run) {
  // Import BEFORE the storage is installed: the module runs its migration once,
  // at load, and a seeded store would be consumed by that instead of by the
  // explicit call each test makes.
  const prefs = await import('../src/lib/prefs.js');
  const original = globalThis.localStorage;
  const store = memoryStorage(seed);
  globalThis.localStorage = store;
  prefs.forgetPrefsCache();
  try {
    return await run(store, prefs);
  } finally {
    prefs.forgetPrefsCache();
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
}

test('the migration moves the old keys in and deletes them', async () => {
  await withStorage({
    og_lang: 'zh-CN',
    completion_ping_enabled: '1',
    prompt_helper_last_model: 'qwen3-4b.gguf',
    'hivemind.producer.modelUse': '{"flux-2-pro":3}',
    inspo_filters_v1: '{"sort":"Most Reactions"}',
    models_discover_search_v1: '{"query":"a private search","filters":{"type":"LORA"}}',
    'hive.section.nav.advanced': '1',
    'hive.section.image.tuning': '0',
  }, async (store, { migrateLegacyPrefs, prefs, PREFS_KEY, sectionOpen }) => {
    const moved = migrateLegacyPrefs();
    assert.ok(moved.length >= 7, `expected every legacy key, moved ${moved.join(', ')}`);

    const doc = prefs();
    assert.equal(doc.lang, 'zh-CN');
    assert.equal(doc.completionPing, true);
    assert.equal(doc.promptHelperModel, 'qwen3-4b.gguf');
    assert.deepEqual(doc.modelUse, { 'flux-2-pro': 3 });
    assert.deepEqual(doc.inspoFilters, { sort: 'Most Reactions' });
    assert.equal(sectionOpen('nav.advanced', false), true);
    assert.equal(sectionOpen('image.tuning', true), false);

    // The typed query does NOT come across — filters are a shape you like, a
    // query is something you typed.
    assert.deepEqual(doc.discoverFilters, { type: 'LORA' });
    assert.equal(JSON.stringify(doc).includes('a private search'), false);

    // One document, and nothing left behind to drift from it.
    assert.deepEqual([...store.map.keys()], [PREFS_KEY]);

    // Idempotent: a second run has nothing to move.
    assert.deepEqual(migrateLegacyPrefs(), []);
  });
});

test('a document that cannot be read degrades to the defaults and says so', async () => {
  await withStorage({ 'hive.prefs.v1': '{not json' }, async (store, { prefs, prefsWereUnreadable, DEFAULT_PREFS }) => {
    assert.equal(prefsWereUnreadable(), true);
    assert.equal(prefs().lang, DEFAULT_PREFS.lang);
    assert.deepEqual(prefs().modelUse, {});
  });
});

test('unknown fields and impossible values are dropped on read', async () => {
  await withStorage({}, async (store, { normalizePrefs }) => {
    const cleaned = normalizePrefs({
      lang: 42,
      completionPing: 'yes',
      modelUse: { good: 2, bad: 'lots', zero: 0 },
      sections: { open: 1 },
      somethingNobodyDeclared: 'x',
    });
    assert.equal(cleaned.lang, '');
    assert.equal(cleaned.completionPing, true);
    assert.deepEqual(cleaned.modelUse, { good: 2 });
    assert.deepEqual(cleaned.sections, { open: true });
    assert.equal('somethingNobodyDeclared' in cleaned, false);
    assert.equal(cleaned.v, 1);
  });
});

test('subscribers hear every change, and reset puts it all back', async () => {
  await withStorage({}, async (store, { setPrefs, subscribePrefs, resetPrefs, pref }) => {
    const seen = [];
    const stop = subscribePrefs((doc) => seen.push(doc.completionPing));
    setPrefs({ completionPing: true });
    assert.equal(pref('completionPing'), true);
    resetPrefs();
    assert.equal(pref('completionPing'), false);
    stop();
    setPrefs({ completionPing: true });
    assert.deepEqual(seen, [true, false], 'one call per change, and none after unsubscribing');
  });
});

test('an export carries no prompt, no key and no search text', async () => {
  await withStorage({
    image_generation_preferences: JSON.stringify({
      modelId: 'flux-2-pro', aspectRatio: '16:9', prompt: 'a secret idea', negativePrompt: 'no', apiKey: 'sk-live',
    }),
  }, async (store, { exportPrefs, setPrefs, importPrefs, STUDIO_PREFERENCE_KEYS }) => {
    setPrefs({ promptHelperModel: 'qwen3-4b.gguf', completionPing: true });
    const exported = exportPrefs();
    const body = JSON.stringify(exported);
    assert.equal(body.includes('a secret idea'), false);
    assert.equal(body.includes('sk-live'), false);
    assert.equal(exported.studios.image.modelId, 'flux-2-pro');
    assert.equal(exported.prefs.completionPing, true);

    // And it comes back.
    store.map.clear();
    const restored = importPrefs(exported);
    assert.deepEqual(restored.studios, ['image']);
    const blob = JSON.parse(store.getItem(STUDIO_PREFERENCE_KEYS.image));
    assert.equal(blob.aspectRatio, '16:9');
    assert.equal('prompt' in blob, false);
  });
});

test('importing something that is not a settings export is refused with a sentence', async () => {
  await withStorage({}, async (store, { importPrefs }) => {
    assert.throws(() => importPrefs({ hello: 'world' }), /not a studio settings export/);
    assert.throws(() => importPrefs({ kind: 'settings', v: 99 }), /newer version/);
  });
});

test('resetting one studio leaves the others alone', async () => {
  await withStorage({
    image_generation_preferences: '{"modelId":"a"}',
    video_generation_preferences: '{"modelId":"b"}',
  }, async (store, { resetStudioPreferences }) => {
    assert.equal(resetStudioPreferences('image'), true);
    assert.equal(store.getItem('image_generation_preferences'), null);
    assert.equal(store.getItem('video_generation_preferences'), '{"modelId":"b"}');
    // A studio with nothing saved is not an error.
    assert.equal(resetStudioPreferences('image'), false);
  });
});

test('a browser with storage switched off still boots', async () => {
  const original = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    const { prefs, setPrefs, migrateLegacyPrefs, forgetPrefsCache } = await import('../src/lib/prefs.js');
    forgetPrefsCache();
    assert.deepEqual(migrateLegacyPrefs(), []);
    assert.equal(prefs().completionPing, false);
    setPrefs({ completionPing: true });
    assert.equal(prefs().completionPing, true, 'the session still remembers, it just does not persist');
    forgetPrefsCache();
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
});
