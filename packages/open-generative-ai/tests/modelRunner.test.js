// The one path a studio uses to run a selected model.
//
// The bug this module exists for: two studios dispatched on `source === 'local'
// ? localAI : muapi`, so every one of the catalog's ten cloud providers was
// sent to MUAPI. Choosing GPT Image 2 under the OpenAI OAuth provider opened
// the MUAPI API-key dialog — and with a key present would have billed MUAPI's
// endpoint of the same name, on a different account.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';

const load = () => import('../src/lib/modelRunner.js');

// The lib reads localStorage and window at call time; node has neither.
// `__HIVEMIND_STUDIO__` is the marker the studio server injects — the server
// transport is only reachable when the app is served by it.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.window = { __HIVEMIND_STUDIO__: 1, location: { search: '' } };

test('three providers offer a model called gpt-image-2, and they are three routes', async () => {
  const { transportFor } = await load();

  const api = transportFor({ id: 'gpt-image-2', provider: 'openai-gpt-image', source: 'cloud' });
  const oauth = transportFor({ id: 'gpt-image-2', provider: 'openai-gpt-image-oauth', source: 'cloud' });
  const mu = transportFor({ id: 'gpt-image-1.5', provider: 'muapi', source: 'cloud' });

  // Same model id, three accounts. Dispatching on the id alone bills whichever
  // one the caller happened to hard-code.
  assert.notEqual(api.label, oauth.label);
  assert.equal(mu.transport, 'muapi');
  assert.equal(api.transport, 'studio');
  assert.equal(oauth.transport, 'studio');
});

test('only MUAPI needs a key this browser holds', async () => {
  const { browserCredentialFor } = await load();

  assert.equal(browserCredentialFor({ provider: 'muapi', source: 'cloud' }), 'muapi');
  // Every other credential is checked where it lives. Asking for a MUAPI key
  // because a model is "not local" is the exact bug.
  assert.equal(browserCredentialFor({ provider: 'openai-gpt-image-oauth', source: 'cloud' }), '');
  assert.equal(browserCredentialFor({ provider: 'higgsfield-cloud', source: 'cloud' }), '');
  assert.equal(browserCredentialFor({ provider: 'sdcpp', source: 'local' }), '');
});

test('a provider nobody has routed is refused loudly, not defaulted', async () => {
  const { transportFor } = await load();

  const route = transportFor({ id: 'something', provider: 'brand-new-provider', source: 'cloud' });

  // Defaulting here makes a routing decision by accident, and the first sign of
  // it is a charge on the wrong account.
  assert.equal(route.runnable, false);
  assert.match(route.reason, /no route for/);
});

test('a renderer is not offered as an image model', async () => {
  const { transportFor } = await load();

  for (const provider of ['static-text-renderer', 'stickman-renderer']) {
    assert.equal(transportFor({ provider, source: 'cloud' }).runnable, false);
  }
});

test('a local row is local whatever its provider is called', async () => {
  const { transportFor } = await load();

  // The browser's own catalog IS the local inventory; its provider names are
  // checkpoint backends, not accounts.
  assert.equal(transportFor({ provider: 'anything-at-all', source: 'local' }).transport, 'local');
});

test('running an unroutable model refuses with the reason rather than falling back', async () => {
  const { runImage } = await load();

  await assert.rejects(
    () => runImage({ row: { id: 'x', provider: 'brand-new-provider', source: 'cloud' }, shared: { prompt: 'a pier' } }),
    /no route for/,
  );
});

test('running with no model and no prompt says which is missing', async () => {
  const { runImage } = await load();

  await assert.rejects(() => runImage({ row: null, shared: { prompt: 'a pier' } }), /Pick a model/);
  await assert.rejects(
    () => runImage({ row: { id: 'x', provider: 'muapi', source: 'cloud' }, shared: { prompt: '  ' } }),
    /nothing to draw/,
  );
});

test('a server-routed provider posts the PROVIDER, not just the model', async () => {
  const { runImage } = await load();
  let sent = null;
  globalThis.fetch = async (path, init) => {
    sent = { path, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ ok: true, url: '/api/media-studio/generated/a.png', provider: 'openai-gpt-image-oauth', model: 'gpt-image-2' }) };
  };

  const result = await runImage({
    row: { id: 'gpt-image-2', provider: 'openai-gpt-image-oauth', source: 'cloud' },
    shared: { prompt: 'an empty terminus', aspect_ratio: '9:16' },
  });

  assert.equal(sent.path, '/api/media-studio/image');
  assert.equal(sent.body.provider, 'openai-gpt-image-oauth');
  assert.equal(sent.body.model, 'gpt-image-2');
  assert.equal(sent.body.aspect_ratio, '9:16');
  assert.equal(result.url, '/api/media-studio/generated/a.png');
});

test('a server error comes back as its message, not as a status code', async () => {
  const { runImage } = await load();
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ detail: 'OpenAI GPT Image (ChatGPT sign-in): not connected' }),
  });

  await assert.rejects(
    () => runImage({ row: { id: 'gpt-image-2', provider: 'openai-gpt-image-oauth', source: 'cloud' }, shared: { prompt: 'x' } }),
    /ChatGPT sign-in/,
  );
});

/* ---------------- the rule, enforced ---------------- */

test('no studio dispatches a model itself — every one of them goes through here', async () => {
  // The regression this module exists to prevent, checked mechanically. Two
  // studios grew the same copied dispatch (`not local, therefore MUAPI`); a
  // third would have. There is no exemption list any more: every studio that
  // generates does it through runImage/runVideo.
  const dir = new URL('../src/studios/', import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith('.jsx'));
  const offenders = [];
  for (const name of files) {
    const source = await readFile(new URL(name, dir), 'utf8');
    // Every generating call, not the three the first version happened to list:
    // processV2V, generateI2V and processLipSync all slipped past that one.
    if (/muapi\.(generate\w*|process\w*)\(/.test(source)) offenders.push(`${name}: calls muapi.generate*/process* directly`);
    if (/\blocalAI\.generate\(/.test(source)) offenders.push(`${name}: calls localAI.generate directly`);
    if (/\bgenerateHivemindVideo\(/.test(source)) offenders.push(`${name}: calls the Media Studio lane directly`);
  }

  assert.deepEqual(offenders, [], `these must route through lib/modelRunner.js:\n${offenders.join('\n')}`);
});

test('the row is the routing identity, and a payload cannot redirect the run', async () => {
  const { runImage } = await load();
  let sent = null;
  globalThis.window.localAI = { isElectron: true, generate: async (p) => { sent = p; return { url: 'blob:x' }; } };

  // A stale `model` left in a payload used to be the last word. It is not: a
  // caller that says one model and pays for another is the whole failure class.
  await runImage({
    row: { id: 'z-image-turbo', provider: 'sdcpp', source: 'local' },
    shared: { prompt: 'a pier' },
    extra: { local: { model: 'some-other-checkpoint' } },
  });

  assert.equal(sent.model, 'z-image-turbo');
  delete globalThis.window.localAI;
});

test('a payload built for one transport is never delivered to another', async () => {
  const { runImage } = await load();

  // The Image studio builds an outpaint mask for the LOCAL bridge. If that row
  // resolved to a paid cloud provider, sending the shared half would produce a
  // plain generation that looks like a result and is not the one asked for.
  await assert.rejects(
    () => runImage({
      row: { id: 'gpt-image-2', provider: 'openai-gpt-image-oauth', source: 'cloud' },
      shared: { prompt: 'a pier' },
      extra: { local: { outpaint: { width: 1024, height: 1024 } } },
    }),
    /built no studio request/,
  );
});

test('no extra at all means the shared payload serves any transport', async () => {
  const { resolveRun } = await load();

  const { route, payload } = resolveRun({
    row: { id: 'flux-2-pro', provider: 'muapi', source: 'cloud' },
    shared: { prompt: 'a pier', aspect_ratio: '9:16' },
  });

  assert.equal(route.transport, 'muapi');
  assert.deepEqual(payload, { prompt: 'a pier', aspect_ratio: '9:16' });
});

test('a clip routes to the Media Studio lane, not to the image endpoint', async () => {
  const { transportFor, studioRow } = await load();

  // The lane is a job with progress, a cancellable id and a machine to run on.
  // It is the same `studio` transport, and runVideo picks the lane for it.
  assert.equal(transportFor(studioRow('minimax-h3')).transport, 'studio');
});

test('a clip NAMES its MUAPI call instead of making it, so V2V, I2V and lip sync are covered too', async () => {
  const { runVideo, muapiRow } = await load();
  const { muapi } = await import('../src/lib/muapi.js');
  const seen = [];
  for (const name of ['generateVideo', 'generateI2V', 'processV2V', 'processLipSync']) {
    muapi[name] = async (params) => { seen.push([name, params]); return { url: `blob:${name}` }; };
  }

  await runVideo({ row: muapiRow('seedance-v2.0-t2v'), extra: { muapi: { prompt: 'a pier' } } });
  await runVideo({ row: muapiRow('kling-i2v'), extra: { muapi: { image_url: 'u', method: 'generateI2V' } } });
  await runVideo({ row: muapiRow('kling-v2v'), extra: { muapi: { video_url: 'u', method: 'processV2V' } } });
  await runVideo({ row: muapiRow('kling-lipsync'), extra: { muapi: { audio_url: 'u', method: 'processLipSync' } } });

  assert.deepEqual(seen.map(([name]) => name), ['generateVideo', 'generateI2V', 'processV2V', 'processLipSync']);
  // `method` is routing, not payload — MUAPI would 400 on an unknown field.
  for (const [, params] of seen) assert.equal(params.method, undefined);
  // And the row is still the last word on which model is billed.
  assert.equal(seen[1][1].model, 'kling-i2v');

  for (const name of ['generateVideo', 'generateI2V', 'processV2V', 'processLipSync']) delete muapi[name];
});

test('a method the client does not have is refused in words, not a TypeError', async () => {
  const { runVideo, muapiRow } = await load();

  await assert.rejects(
    () => runVideo({ row: muapiRow('x'), extra: { muapi: { method: 'generateHologram' } } }),
    /no .generateHologram. call/,
  );
});

test('every studio that generates imports what it calls', async () => {
  // The mistake made while migrating these: removing the `muapi` import from a
  // studio that still used it for a poll and an upload. A bundler does not
  // catch an undeclared identifier — it is a ReferenceError at the moment the
  // user presses the button.
  const dir = new URL('../src/studios/', import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith('.jsx'));
  const WATCHED = ['muapi', 'localAI', 'runImage', 'runVideo', 'localRow', 'muapiRow', 'studioRow', 'generateHivemindVideo'];
  const missing = [];
  for (const name of files) {
    const source = await readFile(new URL(name, dir), 'utf8');
    const body = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const imported = new Set();
    for (const match of body.matchAll(/^import\s*\{([^}]*)\}/gm)) {
      for (const part of match[1].split(',')) imported.add(part.trim().split(/\s+as\s+/).pop().trim());
    }
    for (const symbol of WATCHED) {
      const used = new RegExp(`(?<![.\\w])${symbol}\\s*[.(]`).test(body.replace(/^import[^;]*;/gm, ''));
      if (used && !imported.has(symbol)) missing.push(`${name}: uses ${symbol} but does not import it`);
    }
  }

  assert.deepEqual(missing, []);
});
