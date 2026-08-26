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

  for (const key of ['add-local-model', 'link-hivemindos', 'open-hivemindos', 'top-up',
                     'connect-account', 'connect-provider', 'retry']) {
    assert.ok(remedyFor(key)?.label, `${key} has no button`);
    assert.ok(remedyFor(key)?.action, `${key} has no action`);
  }
  assert.equal(remedyFor('something-new'), null);
  assert.equal(Object.keys(REMEDIES).length, 7);

  // A provider account's repair has to name WHICH account — "Add key" with no
  // key name is the same dead end as an error with no button. Those arrive as
  // targets rather than as fixed ids, because the server owns the provider
  // list and a hard-coded copy here is the half that goes stale.
  assert.deepEqual(remedyFor('key:OPENROUTER_API_KEY'), { label: 'Add key', action: 'key', key: 'OPENROUTER_API_KEY' });
  assert.deepEqual(remedyFor('oauth:openai'), { label: 'Sign in', action: 'oauth', provider: 'openai' });
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

  // The link flow moved into the shared hook when the prompt helper started
  // offering the same sources; the three things that keep it from being a dead
  // button did not change.
  const studio = fs.readFileSync(new URL('../src/lib/useModelSources.js', import.meta.url), 'utf8')
    + fs.readFileSync(new URL('../src/components/ModelSourcePicker.jsx', import.meta.url), 'utf8');
  assert.match(studio, /HivemindOS did not answer/);
  assert.match(studio, /paste an account key below/);
  assert.match(studio, /Paste an account key instead/);
});

// --------------------------------------------------------------------------
// the owner's own accounts
// --------------------------------------------------------------------------

const ACCOUNT_ROWS = [
  { id: 'account:openai/gpt-4.1', name: 'gpt-4.1', source: 'accounts', provider: 'openai', group: 'OpenAI', tier: 'account', badge: 'Your key', subtitle: '' },
  { id: 'account:openrouter/anthropic/claude-4', name: 'anthropic/claude-4', source: 'accounts', provider: 'openrouter', group: 'OpenRouter', tier: 'account', badge: 'Your key', subtitle: '$3 in · $15 out /1M' },
  { id: 'account:chatgpt/gpt-5.4', name: 'gpt-5.4', source: 'accounts', provider: 'chatgpt', group: 'ChatGPT (sign-in)', tier: 'account', badge: 'Sign-in', subtitle: '' },
];

const WITH_ACCOUNTS = {
  ...CATALOG,
  sources: {
    ...CATALOG.sources,
    accounts: {
      id: 'accounts', label: 'Your accounts', available: true, detail: '', remedy: '',
      models: ACCOUNT_ROWS,
      accounts: [
        { id: 'openai', label: 'OpenAI', kind: 'key', connected: true, live: true, count: 1, credential: 'OPENAI_API_KEY', connect: 'key:OPENAI_API_KEY', detail: '', remedy: '' },
        { id: 'openrouter', label: 'OpenRouter', kind: 'key', connected: true, live: true, count: 1, credential: 'OPENROUTER_API_KEY', connect: 'key:OPENROUTER_API_KEY', detail: '', remedy: '' },
        { id: 'chatgpt', label: 'ChatGPT (sign-in)', kind: 'oauth', connected: true, live: true, count: 1, credential: 'OPENAI_OAUTH_ACCESS_TOKEN', connect: 'oauth:openai', detail: '', remedy: '' },
        { id: 'anthropic', label: 'Anthropic', kind: 'key', connected: false, live: false, count: 0, credential: '', connect: 'key:ANTHROPIC_API_KEY', detail: '', remedy: 'key:ANTHROPIC_API_KEY' },
      ],
      defaultModelId: 'account:chatgpt/gpt-5.4',
    },
  },
  models: [...CATALOG.models, ...ACCOUNT_ROWS],
};

test('a model on the owner’s own account is never mistaken for a HivemindOS one', async () => {
  const { tabOf, isAccountModel, isCloudModel, needsLoad, sourceIdForTab } = await load();

  // Three different wallets. Filing an account model on either of the other
  // tabs tells the owner the wrong thing about who is being billed.
  assert.equal(tabOf(ACCOUNT_ROWS[0]), 'accounts');
  assert.equal(isAccountModel(ACCOUNT_ROWS[0]), true);
  assert.equal(isCloudModel(ACCOUNT_ROWS[0]), false);
  // And it is not local either, so it must not go through the load-and-wait path.
  assert.equal(needsLoad(ACCOUNT_ROWS[0]), false);
  // Two of the four tabs are two halves of one source; the third source is its own.
  assert.equal(sourceIdForTab('cloud'), 'hivemindos');
  assert.equal(sourceIdForTab('accounts'), 'accounts');
});

test('the accounts tab says who pays before anything is pressed', async () => {
  const { privacyLine, statusLine, summaryLine, accountsLine } = await load();

  // The one sentence that is different about this tab, and the reason it needs
  // its own: the story does not pass through HivemindOS at all.
  assert.match(privacyLine(ACCOUNT_ROWS[0]), /billed to your own account there/i);
  assert.match(privacyLine(ACCOUNT_ROWS[0]), /does not pass through HivemindOS/i);

  // The provider's own price when it quoted one, and NOTHING when it did not:
  // "Billed to your own account" under all forty rows is a sentence the tab
  // states once above them.
  assert.equal(statusLine(ACCOUNT_ROWS[1]), '$3 in · $15 out /1M');
  assert.equal(statusLine(ACCOUNT_ROWS[0]), '');
  // On the collapsed bar the wallet IS the useful half, so it says it there.
  assert.equal(summaryLine(ACCOUNT_ROWS[2]), 'gpt-5.4 · ChatGPT (sign-in) · billed to your own account');
  assert.equal(accountsLine(WITH_ACCOUNTS), '3 of 4 connected');
});

test('an account that was never connected is still listed, with the way to connect it', async () => {
  const { accountsOf, accountFor, remedyFor } = await load();

  // The tab is how someone finds out the ChatGPT plan they already pay for can
  // write scenes. Filtering to what is connected can never tell them that.
  assert.equal(accountsOf(WITH_ACCOUNTS).length, 4);
  const anthropic = accountFor(WITH_ACCOUNTS, 'anthropic');
  assert.equal(anthropic.connected, false);
  // A sign-in and a key are different repairs and must not share a button.
  assert.equal(remedyFor(anthropic.remedy).action, 'key');
  assert.equal(remedyFor(accountFor(WITH_ACCOUNTS, 'chatgpt').connect).action, 'oauth');
});

test('choosing an account narrows the list to the models it can actually run', async () => {
  const { modelsForAccount, modelsForTab, tabCounts } = await load();

  // Six connected accounts is several hundred models, and "search 657 models"
  // is not a decision anyone can make.
  assert.deepEqual(modelsForAccount(WITH_ACCOUNTS, 'openrouter').map((row) => row.id),
    ['account:openrouter/anthropic/claude-4']);
  assert.equal(modelsForTab(WITH_ACCOUNTS, 'accounts').length, 3);
  // The badge counts what the tab lists, so it cannot read one over a list of two.
  assert.equal(tabCounts(WITH_ACCOUNTS).accounts, 3);
  // Search still reaches the id, because an OpenRouter model is known by it.
  assert.equal(modelsForAccount(WITH_ACCOUNTS, 'openrouter', 'claude').length, 1);
  assert.equal(modelsForAccount(WITH_ACCOUNTS, 'openrouter', 'gemini').length, 0);
});

test('the picker does not list ten near-identical tiles for one model', async () => {
  const { modelsForAccount, hiddenVariants, isPinnedVariant } = await load();

  // A catalog lists every dated snapshot and routing variant beside the model
  // itself — 139 of 637 rows on a real machine. Ten `gpt-5-*` tiles is not a
  // choice anyone can make, so the pins wait until they are searched for.
  const rows = [
    { id: 'account:openai/gpt-5', name: 'gpt-5', source: 'accounts', provider: 'openai', group: 'OpenAI', pinned: '', snapshots: 2 },
    { id: 'account:openai/gpt-5-2025-08-07', name: 'gpt-5-2025-08-07', source: 'accounts', provider: 'openai', group: 'OpenAI', pinned: 'gpt-5' },
    { id: 'account:openai/gpt-5-mini', name: 'gpt-5-mini', source: 'accounts', provider: 'openai', group: 'OpenAI', pinned: '' },
  ];
  const payload = { models: rows, sources: { accounts: { available: true, models: rows, accounts: [] } } };

  assert.deepEqual(modelsForAccount(payload, 'openai').map((r) => r.name), ['gpt-5', 'gpt-5-mini']);
  // Never unreachable, only out of the way: searching for the pin finds it.
  assert.deepEqual(modelsForAccount(payload, 'openai', '2025-08-07').map((r) => r.name), ['gpt-5-2025-08-07']);
  // And never a silent cap — the tab can say how many it is holding back.
  assert.equal(hiddenVariants(payload, 'accounts', 'openai'), 1);
  assert.equal(isPinnedVariant(rows[1]), true);
});

test('what the owner keeps choosing outranks what the world hosts most', async () => {
  const { modelsForAccount, rememberModelUse } = await load();

  const rows = [
    { id: 'account:openai/a', name: 'a', source: 'accounts', provider: 'openai', group: 'OpenAI', pinned: '' },
    { id: 'account:openai/b', name: 'b', source: 'accounts', provider: 'openai', group: 'OpenAI', pinned: '' },
  ];
  const payload = { models: rows, sources: { accounts: { available: true, models: rows, accounts: [] } } };

  const store = new Map();
  globalThis.window = { localStorage: {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  } };
  try {
    // The server ranks globally — by how many providers carry a model. That is
    // a real signal but it is not about this person; two picks beat it.
    assert.deepEqual(modelsForAccount(payload, 'openai').map((r) => r.name), ['a', 'b']);
    rememberModelUse('account:openai/b');
    rememberModelUse('account:openai/b');
    assert.deepEqual(modelsForAccount(payload, 'openai').map((r) => r.name), ['b', 'a']);
  } finally {
    delete globalThis.window;
  }
});
