// The producer's model picker: which source a model belongs to, what it costs,
// and what the studio promises about it. Every test is named after what the
// owner is told when the rule below it is missing.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const load = () => import('../src/lib/textModels.js');

const CATALOG = {
  sources: {
    local: {
      id: 'local', label: 'On this machine', available: true, availableBytes: 64e9,
      models: [{ id: 'qwen3-30b', name: 'Qwen3 30B', source: 'local', fit: 'loaded', estimatedLoadBytes: 20e9 }],
    },
    hivemindos: {
      id: 'hivemindos', label: 'HivemindOS', available: true, url: 'http://127.0.0.1:5020',
      defaultModelId: 'hivemindos/custom:openai/gpt-5.6-luna',
      credits: { configured: true, label: '1,200 credits' },
      models: [],
    },
  },
  models: [
    { id: 'qwen3-30b', name: 'Qwen3 30B', source: 'local', fit: 'loaded', estimatedLoadBytes: 20e9 },
    { id: 'hivemindos/auto', name: 'Auto', source: 'hivemindos', group: 'HivemindOS', tier: 'paid', subtitle: 'Best available' },
    { id: 'hivemindos/swarm-sovereign-scout', name: 'Swarm Sovereign Scout', source: 'hivemindos', group: 'HivemindOS', tier: 'free', subtitle: 'Free daily allowance' },
    { id: 'hivemindos/custom:openai/gpt-5.6-luna', name: 'OpenAI: GPT-5.6 Luna', source: 'hivemindos', group: 'Gateway', tier: 'paid', subtitle: '$0.52 in · $3.12 out /1M' },
    { id: 'hivemindos/custom:anthropic/claude-opus-4.8', name: 'Anthropic: Claude Opus 4.8', source: 'hivemindos', group: 'Gateway', tier: 'paid', subtitle: '$5 in · $25 out /1M' },
  ],
  defaultModelId: 'qwen3-30b',
};

test('a model lands on the tab that matches the decision it is', async () => {
  const { tabOf } = await load();

  // Three genuinely different choices: this machine, the house tiers, and the
  // named models. Folding the last two together buries the tiers in hundreds.
  assert.equal(tabOf(CATALOG.models[0]), 'local');
  assert.equal(tabOf(CATALOG.models[1]), 'hivemindos');
  assert.equal(tabOf(CATALOG.models[3]), 'cloud');
});

test('the recommended model is on the HivemindOS tab, not buried in the cloud list', async () => {
  const { modelsForTab, recommendedId } = await load();

  const rows = modelsForTab(CATALOG, 'hivemindos');

  // It is filed under Gateway by the catalog, but it is the answer to "which
  // one should I use" — an owner should not have to search for the default.
  assert.equal(rows[0].id, recommendedId(CATALOG));
  assert.equal(rows[0].id, 'hivemindos/custom:openai/gpt-5.6-luna');
  assert.ok(rows.some((row) => row.id === 'hivemindos/auto'));
});

test('the cloud tab is searched by the name a person would type', async () => {
  const { modelsForTab } = await load();

  assert.deepEqual(
    modelsForTab(CATALOG, 'cloud', 'claude').map((row) => row.id),
    ['hivemindos/custom:anthropic/claude-opus-4.8'],
  );
  // The id is searchable too — it is what a shared link or a docs page names.
  assert.equal(modelsForTab(CATALOG, 'cloud', 'gpt-5.6-luna').length, 1);
  assert.equal(modelsForTab(CATALOG, 'cloud', 'nothing like this').length, 0);
});

test('the owner’s last choice outlives a reload, and a fresh install starts where the server says', async () => {
  const { startingModelId } = await load();

  assert.equal(startingModelId(CATALOG, 'hivemindos/auto'), 'hivemindos/auto');
  // A remembered model that is gone (uninstalled, or a gateway that dropped it)
  // must not leave the picker pointed at nothing.
  assert.equal(startingModelId(CATALOG, 'deleted-model'), 'qwen3-30b');
  assert.equal(startingModelId(CATALOG, ''), 'qwen3-30b');
});

test('the privacy line follows the chosen model rather than describing half of them', async () => {
  const { privacyLine, rowFor } = await load();

  const local = privacyLine(rowFor(CATALOG, 'qwen3-30b'));
  const cloud = privacyLine(rowFor(CATALOG, 'hivemindos/custom:openai/gpt-5.6-luna'));

  assert.match(local, /stays on this machine/);
  // The old copy said "stays on this machine" under every model. Saying that
  // over a cloud model is not a wording problem, it is an untrue promise.
  assert.doesNotMatch(cloud, /stays on this machine/);
  assert.match(cloud, /sent to HivemindOS/);
  assert.match(cloud, /credits/);
});

test('a row says what it costs, in the terms that source charges in', async () => {
  const { statusLine, rowFor } = await load();

  assert.equal(statusLine(rowFor(CATALOG, 'qwen3-30b')), 'Loaded');
  assert.equal(statusLine(rowFor(CATALOG, 'hivemindos/custom:openai/gpt-5.6-luna')), '$0.52 in · $3.12 out /1M');
  assert.equal(statusLine(rowFor(CATALOG, 'hivemindos/swarm-sovereign-scout')), 'Free daily allowance');
});

test('the collapsed bar says where the producer runs without opening the picker', async () => {
  const { summaryLine, rowFor } = await load();

  assert.match(summaryLine(rowFor(CATALOG, 'qwen3-30b')), /on this machine/);
  assert.match(summaryLine(rowFor(CATALOG, 'hivemindos/auto')), /HivemindOS/);
  assert.equal(summaryLine(null), 'no model chosen');
});

test('the credit line is shown before a press, not after a refusal', async () => {
  const { creditsLine } = await load();

  assert.equal(creditsLine(CATALOG), '1,200 credits left');
  // Without the app, an unconfigured balance is an account nobody has connected
  // yet — not an empty wallet. The two need different buttons.
  assert.equal(creditsLine({ sources: { hivemindos: { route: 'direct', credits: { configured: false } } } }), 'Account not connected');
  assert.equal(creditsLine({ sources: { hivemindos: { route: 'app', credits: { configured: false } } } }), 'No credits added yet');
});

test('every state a source can be broken in offers the action that repairs it', async () => {
  const { remedyFor, REMEDIES } = await load();

  for (const key of ['add-local-model', 'link-hivemindos', 'open-hivemindos', 'top-up', 'connect-account', 'retry']) {
    assert.ok(remedyFor(key)?.label, `${key} has no button`);
    assert.ok(remedyFor(key)?.action, `${key} has no action`);
  }
  assert.equal(remedyFor('something-new'), null);
  assert.equal(Object.keys(REMEDIES).length, 6);
});

test('a cloud model is never sent through the local load-and-wait path', async () => {
  const { needsLoad } = await load();

  assert.equal(needsLoad({ source: 'local' }), true);
  assert.equal(needsLoad({ source: 'hivemindos' }), false);

  // The studio has to pass the source through, or the client falls back to
  // polling this machine's runtime for a model that lives somewhere else.
  const studio = fs.readFileSync(new URL('../src/studios/StoryStudio.jsx', import.meta.url), 'utf8');
  assert.match(studio, /source: producer\.source/);
});

test('there is one HivemindOS balance, and the studio never claims a second one', async () => {
  const { routeOf, creditsHome, accountConnected, APP_ROUTE, DIRECT_ROUTE } = await load();

  // Through the app: it already holds the key, so nothing to connect.
  const withApp = { sources: { hivemindos: { route: APP_ROUTE } } };
  assert.equal(routeOf(withApp), APP_ROUTE);
  assert.equal(accountConnected(withApp), true);
  assert.match(creditsHome(withApp), /Your HivemindOS credits/);

  // Connected directly: the SAME balance, and the copy has to say so. It once
  // said "this studio's own balance … installing HivemindOS later keeps its
  // balance separate", which described a second wallet nobody asked for.
  const connected = { sources: { hivemindos: { route: DIRECT_ROUTE, credits: { configured: true } } } };
  assert.equal(accountConnected(connected), true);
  assert.match(creditsHome(connected), /same balance as the app/);
  assert.doesNotMatch(creditsHome(connected), /own balance|separate/);

  // Not connected yet: one instruction, not a description of the problem.
  const fresh = { sources: { hivemindos: { route: DIRECT_ROUTE, credits: { configured: false } } } };
  assert.equal(accountConnected(fresh), false);
  assert.match(creditsHome(fresh), /Connect your HivemindOS account/);

  // A catalog that predates the field must not read as "the app is running".
  assert.equal(routeOf({ sources: {} }), DIRECT_ROUTE);
});

test('the HivemindOS tab never tells someone to install an app to use it', async () => {
  const { TABS } = await load();

  const tab = TABS.find((entry) => entry.id === 'hivemindos');
  assert.match(tab.blurb, /No install needed/i);
});

test('the tab badge counts what the tab lists', async () => {
  const { tabCounts, modelsForTab } = await load();

  const counts = tabCounts(CATALOG);
  for (const id of ['local', 'hivemindos', 'cloud']) {
    assert.equal(counts[id], modelsForTab(CATALOG, id).length, `${id} badge disagrees with its list`);
  }
  // The HivemindOS tab shows its own rows plus the pinned recommendation, so a
  // badge counting only membership reads one under what is on screen.
  assert.equal(counts.hivemindos, 3);
});

test('a key found on this machine is shown as that, not adopted silently', async () => {
  const { creditsHome, creditSource, accountConnected } = await load();

  // The app is installed but closed: the studio read its key from ~/.hivemindos
  // and spends the same balance. The owner is told where that came from.
  const linked = { sources: { hivemindos: { route: 'direct', credits: { configured: true, source: 'app' } } } };
  assert.equal(creditSource(linked), 'app');
  assert.equal(accountConnected(linked), true);
  assert.match(creditsHome(linked), /Linked from the HivemindOS app on this machine/);
  assert.match(creditsHome(linked), /even while it is closed/);

  // A key the owner pasted reads differently, because it is a different fact.
  const pasted = { sources: { hivemindos: { route: 'direct', credits: { configured: true, source: 'connected' } } } };
  assert.match(creditsHome(pasted), /same balance as the app/);
  assert.equal(creditSource({ sources: {} }), '');
});

test('the link button has somewhere to land when the app never answers', async () => {
  const { LINK_WAIT_MS, LINK_POLL_MS } = await load();
  const fs = await import('node:fs');

  // A custom-scheme link nothing handles fails silently — no error, no window.
  // So the studio needs a budget after which it says so, and a fallback.
  assert.ok(LINK_WAIT_MS >= 20000, 'too short to let someone approve in another app');
  assert.ok(LINK_WAIT_MS <= 120000, 'a button that waits this long reads as hung');
  assert.ok(LINK_POLL_MS >= 1000 && LINK_POLL_MS < LINK_WAIT_MS);

  const studio = fs.readFileSync(new URL('../src/studios/StoryStudio.jsx', import.meta.url), 'utf8');
  // The three things that keep it from being a dead button.
  assert.match(studio, /HivemindOS did not answer/);
  assert.match(studio, /paste an account key below/);
  assert.match(studio, /Paste an account key instead/);
});
