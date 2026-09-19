// The inspiration finder's two jobs: ask Civitai the right question, and turn
// somebody else's generation metadata into a studio setup without inventing
// anything. The second half is where the risk is — a setup that quietly
// supplies a default the source never had lands the studio on settings nobody
// chose, and it looks exactly like a successful restore.
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadInspo() {
  return import('../src/lib/civitaiInspo.js');
}

test('search params use the /images vocabulary, not the /models one', async () => {
  const { inspoSearchParams, DEFAULT_INSPO_FILTERS } = await loadInspo();
  const params = inspoSearchParams(DEFAULT_INSPO_FILTERS);
  assert.equal(params.type, 'image');
  assert.equal(params.sort, 'Most Reactions');
  assert.equal(params.period, 'Week');
  assert.equal(params.nsfw, 'false');
  // "Most Downloaded" is the MODELS sort and 400s on /images.
  assert.ok(!['Most Downloaded', 'Highest Rated'].includes(params.sort));
});

test('video is asked for as a media type', async () => {
  const { inspoSearchParams } = await loadInspo();
  assert.equal(inspoSearchParams({ kind: 'video' }).type, 'video');
});

test('an empty rating means "whatever Civitai defaults to", so it is not sent', async () => {
  const { inspoSearchParams } = await loadInspo();
  assert.ok(!('nsfw' in inspoSearchParams({ kind: 'image', nsfw: '' })));
  assert.equal(inspoSearchParams({ kind: 'image', nsfw: 'true' }).nsfw, 'true');
});

test('a cursor continues the search, and its absence starts a fresh one', async () => {
  const { inspoSearchParams } = await loadInspo();
  assert.equal(inspoSearchParams({ kind: 'image' }, 'abc123').cursor, 'abc123');
  assert.ok(!('cursor' in inspoSearchParams({ kind: 'image' }, '   ')));
});

test('paging does not repeat an id Civitai hands back on both sides of a boundary', async () => {
  const { mergeInspoResults } = await loadInspo();
  const merged = mergeInspoResults(
    [{ id: '1' }, { id: '2' }],
    [{ id: '2' }, { id: '3' }],
  );
  assert.deepEqual(merged.map((item) => item.id), ['1', '2', '3']);
});

test('a video result goes to the Video studio and an image to the Image studio', async () => {
  const { inspoSection } = await loadInspo();
  assert.equal(inspoSection({ kind: 'video' }), 'video');
  assert.equal(inspoSection({ kind: 'image' }), 'image');
  assert.equal(inspoSection({}), 'image');
});

test('the setup carries the prompt and every setting the source actually had', async () => {
  const { inspoToStudioSetup } = await loadInspo();
  const setup = inspoToStudioSetup({
    prompt: 'a heron at dawn',
    negativePrompt: 'blurry',
    steps: 28,
    cfgScale: 4.5,
    seed: 12345,
    width: 832,
    height: 1216,
  });
  assert.deepEqual(setup, {
    primaryPrompt: 'a heron at dawn',
    negativePrompt: 'blurry',
    steps: 28,
    cfg: 4.5,
    seed: 12345,
    width: 832,
    height: 1216,
  });
});

test('a setting the source did not have is OMITTED, not defaulted', async () => {
  // The studio's setup loader fills anything absent from what it already holds,
  // so a key present-but-zero would silently reset the studio's real value.
  const { inspoToStudioSetup } = await loadInspo();
  const setup = inspoToStudioSetup({ prompt: 'just a prompt' });
  assert.deepEqual(Object.keys(setup), ['primaryPrompt']);
  for (const key of ['steps', 'cfg', 'seed', 'width', 'height', 'negativePrompt']) {
    assert.ok(!(key in setup), `${key} should be absent`);
  }
});

test('seed 0 is a real seed and survives; a random seed does not', async () => {
  const { inspoToStudioSetup } = await loadInspo();
  assert.equal(inspoToStudioSetup({ prompt: 'p', seed: 0 }).seed, 0);
  assert.ok(!('seed' in inspoToStudioSetup({ prompt: 'p', seed: -1 })));
});

test('dimensions only travel as a pair', async () => {
  // Half a canvas is worse than none: it would pin one side and leave the other
  // at whatever the studio happened to hold.
  const { inspoToStudioSetup } = await loadInspo();
  assert.ok(!('width' in inspoToStudioSetup({ prompt: 'p', width: 832 })));
  assert.ok(!('height' in inspoToStudioSetup({ prompt: 'p', height: 1216 })));
});

test('the model is never carried over', async () => {
  // Civitai's model ids name checkpoints this machine almost certainly does not
  // have, and a studio handed an unresolvable id lands on the wrong lane.
  const { inspoToStudioSetup } = await loadInspo();
  const setup = inspoToStudioSetup({ prompt: 'p', modelName: 'Some Civitai Checkpoint', baseModel: 'Flux.1 D' });
  assert.ok(!('model' in setup) && !('modelId' in setup));
});

test('zero and negative settings are treated as absent', async () => {
  const { inspoToStudioSetup } = await loadInspo();
  const setup = inspoToStudioSetup({ prompt: 'p', steps: 0, cfgScale: 0, width: -5, height: -5 });
  assert.deepEqual(Object.keys(setup), ['primaryPrompt']);
});

test('credits name the base model and count the LoRAs', async () => {
  const { inspoCredits } = await loadInspo();
  assert.equal(
    inspoCredits({ baseModel: 'MiniMax H3', resources: [{ type: 'lora' }, { type: 'checkpoint' }] }),
    'MiniMax H3 · 1 LoRA',
  );
  assert.equal(inspoCredits({ modelName: 'Custom Mix' }), 'Custom Mix');
  assert.equal(inspoCredits({}), '');
});

test('settings shown on a card skip the ones that are missing', async () => {
  const { inspoSettings } = await loadInspo();
  const shown = inspoSettings({ steps: 12, cfgScale: 1, sampler: '', seed: 0, clipSkip: null });
  assert.deepEqual(shown, [['Steps', 12], ['CFG', 1], ['Seed', 0]]);
});
