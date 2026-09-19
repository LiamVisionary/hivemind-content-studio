// Whether a provider can run, and the action that fixes it when it cannot.
//
// The rule: never present a problem where the solution could be offered
// instead. Reported 2026-08-24 — picking GPT Image 2 (OAuth) and pressing Draw
// answered "OpenAI GPT Image (ChatGPT sign-in): Invalid refresh token." That
// arrives after the press, is not an instruction, and the remedy was elsewhere.
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.window = { __HIVEMIND_STUDIO__: 1, location: { search: '' } };

const load = () => import('../src/lib/providerReadiness.js');
const OAUTH_ROW = { id: 'gpt-image-2', provider: 'openai-gpt-image-oauth', source: 'cloud' };

test('a live grant is ready and offers nothing', async () => {
  const { readinessFor } = await load();

  const r = readinessFor(OAUTH_ROW, { oauth: { openai: { connected: true, usable: true } } });

  assert.equal(r.state, 'ready');
  assert.equal(r.action, null);
  assert.equal(r.blocks, false);
});

test('a stale grant says so BEFORE the press, and carries Reconnect', async () => {
  const { readinessFor } = await load();

  const r = readinessFor(OAUTH_ROW, {
    oauth: { openai: { connected: true, usable: false, needs_reconnect: true, detail: 'Invalid refresh token.' } },
  });

  assert.equal(r.state, 'reconnect');
  assert.equal(r.action.kind, 'oauth');
  assert.equal(r.action.provider, 'openai');
  assert.equal(r.action.label, 'Reconnect');
  // The provider's words survive as detail — they help when something else is
  // wrong — but they are not the whole answer any more.
  assert.equal(r.detail, 'Invalid refresh token.');
  assert.equal(r.blocks, true);
});

test('connected-but-unusable is a stale grant even when nobody said so', async () => {
  const { readinessFor } = await load();

  // The dashboard reported `connected` and the studio believed it; the grant
  // was dead. `usable` is the field that matters.
  const r = readinessFor(OAUTH_ROW, { oauth: { openai: { connected: true, usable: false } } });

  assert.equal(r.state, 'reconnect');
});

test('never connected offers Connect, not Reconnect', async () => {
  const { readinessFor } = await load();

  const r = readinessFor(OAUTH_ROW, { oauth: { openai: { connected: false, usable: false } } });

  assert.equal(r.state, 'connect');
  assert.equal(r.action.label, 'Connect');
});

test('a status we could not read is not treated as a pass', async () => {
  const { readinessFor } = await load();

  // Assuming ready and failing at generation time is the exact experience this
  // module replaces.
  const r = readinessFor(OAUTH_ROW, { oauth: null });

  assert.equal(r.state, 'offline');
  assert.match(r.detail, /could not reach/i);
  assert.equal(r.action.label, 'Check again');
});

test('a missing MUAPI key offers the dialog rather than a failed request', async () => {
  const { readinessFor } = await load();

  const r = readinessFor({ id: 'flux-2-pro', provider: 'muapi', source: 'cloud' }, { oauth: {} });

  assert.equal(r.state, 'browser-key');
  assert.equal(r.action.kind, 'muapi-key');
  assert.equal(r.blocks, true);
});

test('a present MUAPI key is simply ready', async () => {
  const { readinessFor } = await load();
  globalThis.localStorage = { getItem: () => 'a-key', setItem: () => {} };

  assert.equal(readinessFor({ id: 'flux-2-pro', provider: 'muapi', source: 'cloud' }, { oauth: {} }).state, 'ready');

  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
});

test('a server-side key that is not set names the variable', async () => {
  const { readinessFor } = await load();

  const r = readinessFor({ id: 'gpt-image-2', provider: 'openai-gpt-image', source: 'cloud', available: false }, { oauth: {} });

  assert.equal(r.state, 'key');
  // "Not configured" alone sends someone hunting. The name is the instruction.
  assert.match(r.detail, /OPENAI_API_KEY/);
});

test('a row with no route says that, rather than blaming a credential', async () => {
  const { readinessFor } = await load();

  const r = readinessFor({ id: 'x', provider: 'brand-new-provider', source: 'cloud' }, { oauth: {} });

  assert.equal(r.state, 'unroutable');
  assert.match(r.detail, /no route/);
});

/* ---------------- a failure becomes a button ---------------- */

test('a generation failure that names its remedy is turned into the remedy', async () => {
  const { readinessFromError } = await load();

  const r = readinessFromError({
    message: 'OpenAI GPT Image (ChatGPT sign-in): Invalid refresh token.',
    remedy: 'reconnect',
    provider: 'openai',
  });

  assert.equal(r.state, 'reconnect');
  assert.equal(r.action.provider, 'openai');
  assert.match(r.detail, /Invalid refresh token/);
});

test('a failure reconnecting cannot fix offers no reconnect', async () => {
  const { readinessFromError } = await load();

  // Offering the wrong remedy is its own kind of lie.
  const r = readinessFromError({ message: 'MUAPI: 429 Too Many Requests', remedy: '', provider: '' });

  assert.equal(r.state, 'error');
  assert.equal(r.action, null);
});

test('a plain string error still renders as a message', async () => {
  const { readinessFromError } = await load();

  assert.equal(readinessFromError('something broke').detail, 'something broke');
});

/* ---------------- the rule, enforced ---------------- */

test('every OAuth provider the runner routes has a connection the studio can repair', async () => {
  const { PROVIDER_OAUTH } = await load();
  const { PROVIDER_TRANSPORTS } = await import('../src/lib/modelRunner.js');

  // A provider whose credential is a grant, with no connection named here,
  // would fail with a sentence and no button — the original bug.
  for (const provider of Object.keys(PROVIDER_TRANSPORTS)) {
    if (!/oauth/.test(provider)) continue;
    assert.ok(PROVIDER_OAUTH[provider], `${provider} has no repairable connection`);
  }
});

/* ---------------- the key moved off the browser ---------------- */

test('a machine that holds the MUAPI key stops asking the browser for one', async () => {
  const { readinessFor } = await load();
  const { setMuapiKeyOnServer } = await import('../src/lib/modelRunner.js');
  const row = { id: 'flux-2-pro', provider: 'muapi', source: 'cloud' };

  setMuapiKeyOnServer(true);
  // Prompting for a key HivemindOS has had all along is the same avoidable
  // demand as any other.
  assert.equal(readinessFor(row, { oauth: {} }).state, 'ready');

  setMuapiKeyOnServer(false);
  assert.equal(readinessFor(row, { oauth: {} }).state, 'browser-key');
  setMuapiKeyOnServer(null);
});

test('with the key on the server no row needs a browser credential', async () => {
  const { setMuapiKeyOnServer, browserCredentialFor, needsBrowserKey } = await import('../src/lib/modelRunner.js');
  const row = { id: 'flux-2-pro', provider: 'muapi', source: 'cloud' };

  setMuapiKeyOnServer(true);
  assert.equal(browserCredentialFor(row), '');
  assert.equal(needsBrowserKey(row), false);

  setMuapiKeyOnServer(false);
  assert.equal(browserCredentialFor(row), 'muapi');
  setMuapiKeyOnServer(null);
});

test('the missing-key message names the shared environment, not just this browser', async () => {
  const { readinessFor } = await load();
  const { setMuapiKeyOnServer } = await import('../src/lib/modelRunner.js');
  setMuapiKeyOnServer(false);

  const r = readinessFor({ id: 'flux-2-pro', provider: 'muapi', source: 'cloud' }, { oauth: {} });

  assert.match(r.detail, /MUAPI_API_KEY/);
  setMuapiKeyOnServer(null);
});

/* ---------------- the answer is seeded once, for every studio ---------------- */

// Until this ran at boot, only the studio that happened to ask knew where the
// key lived: Story asked, so Story was right, and Image / Video / Lip sync /
// Cinema / Sprite all demanded a browser key on a machine that had one.

test('asking this machine once makes every row truthful, without a browser key', async () => {
  const { refreshMuapiKeyLocation, readinessFor } = await load();
  const { needsBrowserKey, muapiRow, setMuapiKeyOnServer } = await import('../src/lib/modelRunner.js');
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, server_key: true }) });

  assert.equal(await refreshMuapiKeyLocation(), true);

  // Any row, in any studio — the gate never reads localStorage again.
  assert.equal(needsBrowserKey(muapiRow('flux-2-pro')), false);
  assert.equal(needsBrowserKey(muapiRow('kling-video-v2.5')), false);
  assert.equal(readinessFor(muapiRow('flux-2-pro'), { oauth: {} }).state, 'ready');
  setMuapiKeyOnServer(null);
});

test('a machine with no key still asks, and a status we cannot read is not a pass', async () => {
  const { refreshMuapiKeyLocation, readinessFor } = await load();
  const { needsBrowserKey, muapiRow, setMuapiKeyOnServer } = await import('../src/lib/modelRunner.js');
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, server_key: false }) });
  assert.equal(await refreshMuapiKeyLocation(), false);
  assert.equal(needsBrowserKey(muapiRow('flux-2-pro')), true);
  assert.equal(readinessFor(muapiRow('flux-2-pro'), { oauth: {} }).action.kind, 'muapi-key');

  // An unreachable studio server is "no server key", not "assume one" — the
  // dialog is offered rather than a request spent on a call that cannot work.
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal(await refreshMuapiKeyLocation(), false);
  assert.equal(needsBrowserKey(muapiRow('flux-2-pro')), true);
  setMuapiKeyOnServer(null);
});

test('the keyless gate for uploads and resumes answers the same as a row', async () => {
  // Uploads and resumed polls have no model row, so they ask muapiKeyMissing().
  // If the two ever disagreed, one surface would gate and the other would not.
  const { muapiKeyMissing, needsBrowserKey, muapiRow, setMuapiKeyOnServer } = await import('../src/lib/modelRunner.js');
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };

  setMuapiKeyOnServer(true);
  assert.equal(muapiKeyMissing(), false);
  assert.equal(muapiKeyMissing(), needsBrowserKey(muapiRow('flux-2-pro')));

  setMuapiKeyOnServer(false);
  assert.equal(muapiKeyMissing(), true);
  assert.equal(muapiKeyMissing(), needsBrowserKey(muapiRow('flux-2-pro')));

  globalThis.localStorage = { getItem: () => 'a-key', setItem: () => {} };
  assert.equal(muapiKeyMissing(), false);

  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  setMuapiKeyOnServer(null);
});
