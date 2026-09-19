// Posting a creation to Civitai. Two things are load-bearing here:
//
//   * the limits, because they are checked BEFORE several hundred megabytes are
//     read and sent — getting them wrong means either a pointless upload that
//     Civitai rejects, or refusing something it would have taken; and
//   * the metadata, because it is written into the file and published as a
//     factual record of how the thing was made. A setting the studio does not
//     actually know must not appear there.
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadPost() {
  return import('../src/lib/civitaiPost.js');
}

test('Civitai accepts these types and nothing else', async () => {
  const { isPostableType } = await loadPost();
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']) {
    assert.ok(isPostableType(type), type);
  }
  for (const type of ['image/gif', 'image/heic', 'video/quicktime', 'application/json', '']) {
    assert.ok(!isPostableType(type), type);
  }
});

test('a charset suffix does not make a supported type unsupported', async () => {
  const { isPostableType } = await loadPost();
  assert.ok(isPostableType('image/png; charset=binary'));
  assert.ok(isPostableType('VIDEO/MP4'));
});

test('an oversized clip is refused with the number that fails', async () => {
  const { limitProblems, CIVITAI_LIMITS } = await loadPost();
  const problems = limitProblems({
    type: 'video/mp4', size: CIVITAI_LIMITS.videoBytes + 1, width: 1080, height: 1920, duration: 10,
  });
  assert.equal(problems.length, 1);
  // Never two identical rendered sizes compared against each other.
  assert.match(problems[0], /over Civitai's 750\.0 MB limit/);
});

test('a clip too long or too large on a side is refused', async () => {
  const { limitProblems } = await loadPost();
  assert.match(limitProblems({ type: 'video/mp4', size: 10, duration: 300 })[0], /245s/);
  assert.match(limitProblems({ type: 'video/mp4', size: 10, width: 5000, height: 100 })[0], /3840px/);
});

test('a clip inside every limit has nothing to report', async () => {
  const { limitProblems } = await loadPost();
  assert.deepEqual(
    limitProblems({ type: 'video/mp4', size: 10 * 1024 ** 2, width: 1080, height: 1920, duration: 15 }),
    [],
  );
});

test('image and video have different size ceilings', async () => {
  const { limitProblems, CIVITAI_LIMITS } = await loadPost();
  const size = CIVITAI_LIMITS.imageBytes + 1;
  assert.equal(limitProblems({ type: 'image/png', size }).length, 1);
  // The same bytes are fine as a video — 50 MB is only the IMAGE ceiling.
  assert.deepEqual(limitProblems({ type: 'video/mp4', size, width: 100, height: 100, duration: 5 }), []);
});

test('an unsupported type reports only that, not a cascade of size complaints', async () => {
  const { limitProblems } = await loadPost();
  const problems = limitProblems({ type: 'image/gif', size: 999 * 1024 ** 3 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not accept/);
});

test('an unknown duration does not refuse the clip', async () => {
  // A video element reports Infinity for some containers; measureMedia turns
  // that into 0, which must read as "unknown", not "zero seconds".
  const { limitProblems } = await loadPost();
  assert.deepEqual(limitProblems({ type: 'video/mp4', size: 1000, duration: 0, width: 100, height: 100 }), []);
});

test('tags are trimmed, deduped, and capped at Civitai’s five', async () => {
  const { normalizeTags } = await loadPost();
  assert.deepEqual(normalizeTags(' anime , landscape ,anime, '), ['anime', 'landscape']);
  assert.deepEqual(normalizeTags('a,b,c,d,e,f,g'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(normalizeTags(''), []);
  assert.deepEqual(normalizeTags('Anime,anime'), ['Anime']);
});

test('metadata carries what the entry holds', async () => {
  const { postMetaFromEntry } = await loadPost();
  const meta = postMetaFromEntry(
    { prompt: 'a heron', model: 'Krea 2', seed: 42, steps: 30, cfg: 4.5, sampler: 'euler' },
    { width: 832, height: 1216 },
  );
  assert.deepEqual(meta, {
    prompt: 'a heron', model: 'Krea 2', seed: 42, steps: 30, cfgScale: 4.5,
    sampler: 'euler', size: '832x1216',
  });
});

test('a random seed is not published as if it were reusable', async () => {
  const { postMetaFromEntry } = await loadPost();
  assert.ok(!('seed' in postMetaFromEntry({ prompt: 'p', seed: -1 })));
  assert.equal(postMetaFromEntry({ prompt: 'p', seed: 0 }).seed, 0);
});

test('settings the studio does not know are left out of the record', async () => {
  const { postMetaFromEntry } = await loadPost();
  assert.deepEqual(postMetaFromEntry({ prompt: 'only a prompt' }), { prompt: 'only a prompt' });
});

test('staging posts the file and its metadata, and returns the Civitai URL', async () => {
  const { stageCivitaiPost } = await loadPost();
  let captured = null;
  const result = await stageCivitaiPost({
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    filename: 'heron.png',
    meta: { prompt: 'a heron' },
    title: 'Heron',
    description: 'at dawn',
    tags: 'bird, dawn',
    fetchImpl: async (url, options) => {
      captured = { url, form: options.body };
      return { ok: true, status: 200, json: async () => ({ intentUrl: 'https://civitai.com/intent/post?x=1', token: 'tok' }) };
    },
  });
  // NOT /api/civitai/* — that prefix is proxied to the media gateway on the
  // tailnet URL, where this route does not exist.
  assert.equal(captured.url, '/api/civitai-post/stage');
  assert.equal(captured.form.get('title'), 'Heron');
  assert.equal(captured.form.get('description'), 'at dawn');
  assert.equal(captured.form.get('tags'), 'bird,dawn');
  assert.deepEqual(JSON.parse(captured.form.get('meta')), { prompt: 'a heron' });
  assert.equal(captured.form.get('file').name, 'heron.png');
  assert.equal(result.token, 'tok');
});

test('a staging failure surfaces the reason the server gave', async () => {
  const { stageCivitaiPost } = await loadPost();
  await assert.rejects(
    () => stageCivitaiPost({
      blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ detail: "This clip runs 300s and Civitai's limit is 245s." }) }),
    }),
    /245s/,
  );
});

test('a success with no intent URL is still a failure', async () => {
  const { stageCivitaiPost } = await loadPost();
  await assert.rejects(
    () => stageCivitaiPost({
      blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    }),
    /Could not stage/,
  );
});

test('cleanup is best effort and never throws at the caller', async () => {
  const { dropCivitaiPost } = await loadPost();
  assert.equal(await dropCivitaiPost(''), false);
  assert.equal(await dropCivitaiPost('tok', async () => { throw new Error('offline'); }), false);
  assert.equal(await dropCivitaiPost('tok', async () => ({ ok: true })), true);
});

test('LoRAs become Civitai resource links via the catalog’s version ids', async () => {
  const { civitaiResourcesFromLoras } = await loadPost();
  const catalog = [
    { id: 'a.safetensors', versionId: '12345' },
    { id: 'b.safetensors', versionId: '67890' },
    { id: 'local.safetensors', versionId: '' },
  ];
  const used = [
    { id: 'a.safetensors', strength: 0.8, enabled: true },
    { id: 'b.safetensors', strength: 1 },
  ];
  assert.deepEqual(civitaiResourcesFromLoras(used, catalog), [
    { type: 'lora', modelVersionId: 12345, weight: 0.8 },
    { type: 'lora', modelVersionId: 67890, weight: 1 },
  ]);
});

test('a hand-placed LoRA with no Civitai sidecar is not linked', async () => {
  // Guessing from the filename would link somebody else's model on a public post.
  const { civitaiResourcesFromLoras } = await loadPost();
  const resources = civitaiResourcesFromLoras(
    [{ id: 'local.safetensors', strength: 1 }],
    [{ id: 'local.safetensors', versionId: '' }],
  );
  assert.deepEqual(resources, []);
});

test('a muted LoRA is not credited', async () => {
  const { civitaiResourcesFromLoras } = await loadPost();
  const resources = civitaiResourcesFromLoras(
    [{ id: 'a.safetensors', strength: 1, enabled: false }],
    [{ id: 'a.safetensors', versionId: '5' }],
  );
  assert.deepEqual(resources, []);
});

test('resources ride along in the metadata when the studio knows them', async () => {
  const { postMetaFromEntry } = await loadPost();
  const resources = [{ type: 'lora', modelVersionId: 7, weight: 1 }];
  assert.deepEqual(postMetaFromEntry({ prompt: 'p', civitaiResources: resources }).civitaiResources, resources);
  assert.ok(!('civitaiResources' in postMetaFromEntry({ prompt: 'p' })));
  assert.ok(!('civitaiResources' in postMetaFromEntry({ prompt: 'p', civitaiResources: [] })));
});
