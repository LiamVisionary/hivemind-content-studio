// Music recipes: a local library applied in one press, and the one opt-in call
// in the Music studio that leaves the machine.
//
// What these pin, and why each exists:
//  1. A recipe sets ONLY what the row takes. ACE-Step has a tempo and a key and
//     reads lyrics; the instrumental YuE2 lane has neither and reads a section
//     plan. One library serves both, so applying has to be row-gated or a press
//     would appear to do nothing — or worse, set something nobody can see.
//  2. A tempo the person typed outranks the recipe's typical one.
//  3. The library is the REAL one, read off disk, so a recipe that would hand the
//     instrumental LoRA a section name it was never shown fails here.
//  4. Suggest is opt-in: it is worded by the server, and without an account the
//     card still offers the list rather than a dead button.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderElement, importComponent, textOf } = require('./helpers/render.js');
const { loadHostedAudioModels } = require('../hosted-local-models.js');

const ROOT = path.resolve(__dirname, '../../..');
const LIBRARY = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/hivemind_content_studio/catalog/music_recipes.json'), 'utf8'));
const ROWS = loadHostedAudioModels(path.join(ROOT, 'packages/media-gateway/workflow-registry.json'));
const row = (id) => ROWS.find((model) => model.id === id);
const recipe = (id) => LIBRARY.recipes.find((item) => item.id === id);
const lib = () => import('../src/lib/musicRecipes.js');
const lane = () => import('../src/lib/musicLane.js');

const BOOK = {
  status: 'ready',
  recipes: LIBRARY.recipes,
  families: LIBRARY.families,
  suggest: {
    available: true,
    disclosure: { sends: 'your style line', never_sends: 'your lyrics, your settings, or anything you have made', to: "TypeSafe's Jev decision model, through your own OpenRouter account" },
  },
};

test('on the instrumental lane a recipe sets the section plan, and nothing it has no control for', async () => {
  const { applyRecipe } = await lib();
  const { defaultMusicSetup, defaultSectionPlan, sectionPlanLyrics } = await lane();
  const model = row('yue2-3b-instrumental');
  const setup = defaultMusicSetup(model);
  const next = applyRecipe(model, setup, defaultSectionPlan(), recipe('deep-house'));
  assert.deepEqual(next.plan, { mode: 'untimed', sections: recipe('deep-house').sections });
  assert.deepEqual(next.setup, setup, 'this lane has no tempo or key control, so none is set');
  assert.deepEqual(next.changes, ['8 sections']);
  // What reaches the model is still only the six trained tags.
  assert.match(sectionPlanLyrics(model, next.plan, 150), /^\[intro\]\n\[verse\]\n\[pre-chorus\]\n\[chorus\]/);

  // Somebody who asked for timings keeps them; nobody is moved INTO them.
  const timed = applyRecipe(model, setup, { mode: 'timed', sections: ['intro'] }, recipe('boom-bap'));
  assert.equal(timed.plan.mode, 'timed');

  // A style with no repeating sections hands the structure to the model.
  const ambient = applyRecipe(model, setup, defaultSectionPlan(), recipe('ambient'));
  assert.equal(ambient.plan.mode, 'bare');
  assert.equal(sectionPlanLyrics(model, ambient.plan, 150), '[instrumental]');
});

test('on ACE-Step a recipe sets tempo, metre and mode, and leaves the lyrics alone', async () => {
  const { applyRecipe } = await lib();
  const { defaultMusicSetup, defaultSectionPlan } = await lane();
  const model = row('ace-step-1.5-turbo');
  const setup = { ...defaultMusicSetup(model), keyscale: 'F# major' };
  const plan = defaultSectionPlan();

  const dnb = applyRecipe(model, setup, plan, recipe('drum-and-bass'));
  assert.equal(dnb.setup.bpm, 174, 'the gap this closes: 92 BPM whatever the style line said');
  assert.equal(dnb.setup.keyscale, 'F# minor', 'the mode moves; the root the person chose does not');
  assert.equal(dnb.plan, plan, 'a model that reads lyrics is not handed a section plan');

  const waltz = applyRecipe(model, setup, plan, recipe('jazz-waltz'));
  assert.equal(waltz.setup.timesignature, '3');
  // 12/8 is not a metre this composer can show, so it is left alone, not faked.
  assert.equal(applyRecipe(model, setup, plan, recipe('slow-blues')).setup.timesignature, setup.timesignature);

  // A tempo the person typed wins, and the receipt says where it came from.
  const typed = applyRecipe(model, setup, plan, recipe('festival-house'), { explicitBpm: 126 });
  assert.equal(typed.setup.bpm, 126);
  assert.ok(typed.changes.some((line) => /126 BPM \(from your style line\)/.test(line)));

  // A recipe with no tempo of its own sets none, rather than zero.
  assert.equal(applyRecipe(model, setup, plan, recipe('ambient')).setup.bpm, setup.bpm);
  // And a tempo outside the slider is clamped to what the control can show.
  assert.equal(applyRecipe(model, setup, plan, recipe('bebop')).setup.bpm, 200);
});

test('every recipe in the shipped library is one the instrumental lane can be handed', async () => {
  const { sectionTags } = await lane();
  const allowed = new Set(sectionTags(row('yue2-3b-instrumental')));
  assert.ok(LIBRARY.recipes.length >= 30);
  for (const item of LIBRARY.recipes) {
    for (const tag of item.sections) assert.ok(allowed.has(tag), `${item.id} names "${tag}"`);
    assert.ok(LIBRARY.families.some((family) => family.id === item.family), `${item.id} has no family`);
  }
});

test('the door is named for what a recipe will change on this model, and absent where it changes nothing', async () => {
  const { recipeDoorLabel, recipesApplyTo } = await lib();
  assert.equal(recipeDoorLabel(row('yue2-3b-instrumental')), 'Suggest structure');
  assert.equal(recipeDoorLabel(row('ace-step-1.5-turbo')), 'Suggest tempo and key');
  // Base YuE2 sings from lyrics and has no tempo control: a recipe has nothing to set.
  assert.equal(recipesApplyTo(row('yue2-3b')), false);

  const MusicComposer = await importComponent('src/studios/music/MusicComposer.jsx', 'MusicComposer');
  const { defaultMusicSetup, defaultSectionPlan } = await lane();
  const props = (model) => ({
    model: { ...model, ready: true }, setup: defaultMusicSetup(model), onSetup() {}, prompt: 'deep house', onPrompt() {},
    lyrics: '', onLyrics() {}, plan: defaultSectionPlan(), onPlan() {}, lyricsOpen: false, onToggleLyrics() {}, onGenerate() {},
  });
  assert.match(renderElement(MusicComposer, props(row('yue2-3b-instrumental'))).markup, /aria-label="Suggest structure"/);
  assert.doesNotMatch(renderElement(MusicComposer, props(row('yue2-3b'))).markup, /Suggest/);
});

test('the card says what Suggest sends before anything is sent, and the list needs no account', async () => {
  const Card = await importComponent('src/studios/music/MusicRecipeCard.jsx', 'MusicRecipeCard');
  const { defaultMusicSetup, defaultSectionPlan } = await lane();
  const { suggestDisclosure } = await lib();
  const model = row('yue2-3b-instrumental');
  const base = { model, setup: defaultMusicSetup(model), plan: defaultSectionPlan(), prompt: 'deep house', onApply() {}, onClose() {} };

  const ready = renderElement(Card, { ...base, book: BOOK });
  assert.deepEqual(ready.logged, []);
  const text = textOf(ready.markup);
  assert.match(text, /Suggest from my style line/);
  assert.match(text, /Sends your style line — nothing else — to a hosted decision model/);
  assert.match(text, /Deep house/);
  assert.match(text, /Electronic and dance/i);
  assert.match(suggestDisclosure(BOOK.suggest), /never sends your lyrics/);

  const noAccount = renderElement(Card, { ...base, book: { ...BOOK, suggest: { available: false } } });
  const quiet = textOf(noAccount.markup);
  assert.match(quiet, /needs an OpenRouter account connected on this machine/);
  assert.match(quiet, /Picking from the list below works without one/);
  assert.match(quiet, /Deep house/, 'the list is still there');
  assert.match(noAccount.markup, /<button[^>]*disabled=""[^>]*>(?:<svg.*?<\/svg>)?Suggest from my style line/s);

  const down = textOf(renderElement(Card, { ...base, book: { status: 'unreachable', recipes: [], families: [], suggest: {} } }).markup);
  assert.match(down, /did not load/);
  assert.match(down, /set the structure and tempo by hand/);
});

test('Suggest sends the style line and nothing else', async () => {
  const { suggestMusicRecipe } = await lib();
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, recipe: 'deep-house', confident: true }) };
  };
  try {
    await suggestMusicRecipe('deep house, warm chords');
  } finally {
    global.fetch = realFetch;
  }
  assert.deepEqual(calls, [{ url: '/api/music/suggest', body: { style: 'deep house, warm chords' } }]);
});
