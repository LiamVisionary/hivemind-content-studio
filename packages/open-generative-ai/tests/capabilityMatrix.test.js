// The browser applies the server's verdicts; it must not grow its own.
import assert from 'node:assert/strict';
import test from 'node:test';

const load = () => import('../src/lib/capabilityMatrix.js');

// Shaped exactly like /api/capabilities/matrix.
const MATRIX = {
  ratings: ['good', 'workable', 'unmeasured', 'poor', 'unsupported'],
  unmatched: { rating: 'unmeasured', reason: 'No sprite run has been recorded for this model.', evidence: 'none' },
  features: [
    {
      id: 'sprite_source',
      label: 'Draw a game sprite',
      kind: 'image',
      requires_any: [],
      forbids: [],
      rules: [
        { match: 'model:anything-v5', rating: 'good', reason: 'Flat cel shading by default.', evidence: 'reasoned' },
        { match: 'model:realistic-vision-v51', rating: 'poor', reason: 'Soft photographic edges.', evidence: 'reasoned' },
        { match: 'family:krea-2', rating: 'poor', reason: 'An identity-edit graph.', evidence: 'contract' },
        { match: 'provider:sdcpp', rating: 'workable', reason: 'A local checkpoint.', evidence: 'reasoned' },
      ],
      rows: [{ model: 'flux-2-pro', rating: 'workable', provider: 'muapi' }],
    },
    {
      id: 'sprite_animation',
      label: 'Animate a sprite',
      kind: 'video',
      requires_any: [['image_base64', 'image_path', 'image_url']],
      forbids: [],
      rules: [{ match: 'model:minimax-h3', rating: 'good', reason: 'Holds one character.', evidence: 'reported' }],
      rows: [],
    },
  ],
};

const LOCAL_MODELS = [
  { id: 'anything-v5', name: 'Anything v5', provider: 'sdcpp' },
  { id: 'realistic-vision-v51', name: 'Realistic Vision v5.1', provider: 'sdcpp' },
  { id: 'z-image-turbo', name: 'Z-Image Turbo', provider: 'sdcpp' },
  { id: 'wan2gp:flux-dev', name: 'Flux.1 Dev', provider: 'wan2gp' },
];

test('the local catalog is rated by the SERVER rules, not a second table in JS', async () => {
  const { rankModels } = await load();

  const ranked = rankModels(MATRIX, 'sprite_source', LOCAL_MODELS);

  const byId = Object.fromEntries(ranked.map((row) => [row.id, row]));
  assert.equal(byId['anything-v5'].rating, 'good');
  assert.equal(byId['realistic-vision-v51'].rating, 'poor');
  // No model rule, but its provider has one.
  assert.equal(byId['z-image-turbo'].rating, 'workable');
  // Neither: honest silence, not a guess.
  assert.equal(byId['wan2gp:flux-dev'].rating, 'unmeasured');
  assert.equal(byId['wan2gp:flux-dev'].evidence, 'none');
});

test('a model rule beats a family rule beats a provider rule', async () => {
  const { rateModel, featureOf } = await load();
  const feature = featureOf(MATRIX, 'sprite_source');

  // provider:sdcpp says workable; the krea-2 family rule says poor.
  assert.equal(rateModel(feature, { id: 'x', family: 'krea-2', provider: 'sdcpp' }).rating, 'poor');
  // model:anything-v5 says good, over both.
  assert.equal(rateModel(feature, { id: 'anything-v5', family: 'krea-2', provider: 'sdcpp' }).rating, 'good');
});

test('ranking puts the best first and sinks anything not ready to run', async () => {
  const { rankModels } = await load();

  const ranked = rankModels(MATRIX, 'sprite_source', [
    { id: 'anything-v5', provider: 'sdcpp', available: false },
    { id: 'other-good', provider: 'sdcpp', available: true },
  ]);

  // Same provider rating for 'other-good' (workable) vs 'anything-v5' (good):
  // the good one still leads, offline or not — but its status travels with it.
  assert.equal(ranked[0].id, 'anything-v5');
  assert.equal(ranked[0].available, false);
});

test('within one rating, an offline model sinks below a ready one', async () => {
  const { rankModels } = await load();

  const ranked = rankModels(MATRIX, 'sprite_source', [
    { id: 'aaa-offline', provider: 'sdcpp', available: false },
    { id: 'zzz-ready', provider: 'sdcpp', available: true },
  ]);

  assert.deepEqual(ranked.map((row) => row.id), ['zzz-ready', 'aaa-offline']);
});

test('a model with no way to take the sprite in is refused structurally', async () => {
  const { rankModels } = await load();

  const ranked = rankModels(MATRIX, 'sprite_animation', [
    { id: 'text-only', provider: 'x', accepts: ['prompt', 'steps'] },
    { id: 'minimax-h3', provider: 'media-studio-mcp', accepts: ['prompt', 'image_base64'] },
  ]);

  assert.equal(ranked[0].id, 'minimax-h3');
  assert.equal(ranked[1].rating, 'unsupported');
  assert.match(ranked[1].reason, /image_base64/);
});

test('an unread registry does not refuse every model', async () => {
  // A degraded catalog hands back an empty accepts list. Reading that as "no
  // inputs" would tell the owner their models cannot animate a sprite.
  const { rankModels } = await load();

  const ranked = rankModels(MATRIX, 'sprite_animation', [{ id: 'minimax-h3', provider: 'media-studio-mcp', accepts: [] }]);

  assert.equal(ranked[0].rating, 'good');
});

test('the default pick is the best model that can actually run right now', async () => {
  const { rankModels, defaultPick } = await load();

  const ranked = rankModels(MATRIX, 'sprite_source', [
    { id: 'anything-v5', provider: 'sdcpp', available: false },
    { id: 'z-image-turbo', provider: 'sdcpp', available: true },
  ]);

  assert.equal(defaultPick(ranked).id, 'z-image-turbo');
});

test('with nothing runnable the picker still shows something rather than going blank', async () => {
  const { rankModels, defaultPick } = await load();

  const ranked = rankModels(MATRIX, 'sprite_source', [{ id: 'anything-v5', provider: 'sdcpp', available: false }]);

  assert.equal(defaultPick(ranked).id, 'anything-v5');
  assert.equal(defaultPick([]), null);
});

test('an unknown feature ranks nothing instead of ranking everything wrongly', async () => {
  const { rankModels, featureOf } = await load();

  assert.deepEqual(rankModels(MATRIX, 'sprite_teleport', LOCAL_MODELS), []);
  assert.equal(featureOf(MATRIX, 'sprite_teleport'), null);
});

test('a model id repeated across providers still gets a unique key', async () => {
  // The catalog really does this: gpt-image-2 under both the OpenAI API-key
  // and OAuth providers. Keying on the id alone made React drop one row and
  // made selecting either highlight both.
  const { rankModels } = await load();

  const ranked = rankModels(MATRIX, 'sprite_source', [
    { id: 'gpt-image-2', provider: 'openai-gpt-image', source: 'cloud' },
    { id: 'gpt-image-2', provider: 'openai-gpt-image-oauth', source: 'cloud' },
    { id: 'z-image-turbo', provider: 'sdcpp', source: 'local' },
  ]);

  assert.equal(new Set(ranked.map((row) => row.key)).size, 3);
});

test('the same model id from the local catalog and the cloud catalog do not collide', async () => {
  const { modelKey } = await load();

  assert.notEqual(
    modelKey({ id: 'automatic', provider: 'hivemindos-hosted-media', source: 'local' }),
    modelKey({ id: 'automatic', provider: 'hivemindos-hosted-media', source: 'cloud' }),
  );
});

test('every rating and evidence class the server can send has a label', async () => {
  const { RATING_LABELS, EVIDENCE_LABELS } = await load();

  for (const rating of MATRIX.ratings) assert.ok(RATING_LABELS[rating], rating);
  for (const evidence of ['measured', 'reported', 'contract', 'reasoned', 'none']) {
    assert.ok(EVIDENCE_LABELS[evidence], evidence);
  }
});
