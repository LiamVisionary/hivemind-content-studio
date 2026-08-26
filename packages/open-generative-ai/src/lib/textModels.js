// Which models the producer can think with, and how the picker groups them.
//
// The producer used to be local-only, which meant a machine with no GGUF on it
// had no producer at all — every stage button in the Story studio was dead. It
// can now also run on HivemindOS's models, which are the SAME models, credits
// and billing as the HivemindOS app itself.
//
// The app is NOT required, and it is NOT a second balance. It is a proxy in
// front of a public gateway: with it running the studio uses it (it already
// holds the machine's account key), and without it the studio holds the owner's
// own HivemindOS account key and spends THE SAME credits. `sources.hivemindos`
// carries `route` and `credits.configured` so the picker can say which of the
// three states it is in — using the app, connected directly, or not connected
// yet — and offer the one action that moves it forward.
//
// The server answers `/api/text-models` with both sources at once; this module
// is the browser half of that one answer — grouping, search, the starting
// choice, and the sentence each source is honest about. Nothing here fetches a
// catalog of its own, so the picker cannot drift from what will actually run.
import { formatBytes, modelStatus } from './promptHelperRuntime.js';

export const LOCAL = 'local';
export const HIVEMINDOS = 'hivemindos';
/** The owner's OWN provider accounts — their OpenAI key, their ChatGPT
 *  sign-in, their OpenRouter balance. Billed by that provider to that account,
 *  never to HivemindOS credits, and read from the same shared credential store
 *  the HivemindOS app uses, so connecting one anywhere connects it everywhere. */
export const ACCOUNTS = 'accounts';

/**
 * The four things an owner is actually choosing between.
 *
 * Local, HivemindOS and their own accounts are the three SOURCES; "Cloud
 * models" is the second half of the HivemindOS source, split out because a list
 * of hundreds of named frontier models is a different kind of decision from
 * picking one of the house tiers, and burying the first inside the second makes
 * both worse.
 *
 * The last tab is the one this picker was missing: an owner with a ChatGPT plan,
 * an OpenAI key or an OpenRouter balance was being asked to buy HivemindOS
 * credits to write a scene, with the credential for the model they wanted
 * already sitting in the machine's shared store.
 */
export const TABS = Object.freeze([
  {
    id: LOCAL,
    label: 'On this machine',
    blurb: 'Runs on this computer. Free, private, and as fast as the hardware.',
    privacy: 'Everything it is told stays on this machine — it is a llama-server here, not a cloud model.',
  },
  {
    id: HIVEMINDOS,
    label: 'HivemindOS',
    blurb: 'HivemindOS models, on HivemindOS credits. No install needed.',
    privacy: 'The story is sent to HivemindOS to answer, and the answer is charged to your HivemindOS credits.',
  },
  {
    id: 'cloud',
    label: 'Cloud models',
    blurb: 'Every named model HivemindOS can reach, on the same credits.',
    privacy: 'The story is sent to HivemindOS to answer, and the answer is charged to your HivemindOS credits.',
  },
  {
    id: ACCOUNTS,
    label: 'Your accounts',
    blurb: 'Models on accounts you already pay for — no HivemindOS credits spent.',
    privacy: 'The story is sent straight to the provider you picked and billed to your own account there. It does not pass through HivemindOS.',
  },
]);

/** How the studio is reaching HivemindOS: `app` through the one on this machine,
 *  `direct` straight to the hosted service. */
export const APP_ROUTE = 'app';
export const DIRECT_ROUTE = 'direct';

export function routeOf(payload) {
  return sourceState(payload, HIVEMINDOS).route || DIRECT_ROUTE;
}

/**
 * Whose credits these are, said plainly.
 *
 * There is one HivemindOS balance and this is how the studio reaches it: through
 * the app when it is running, or with the owner's own account key when it is
 * not. The wrong version of this line — "this studio's own balance" — described
 * a second balance, which is not what anyone wants and not what the gateway
 * requires.
 */
export function creditsHome(payload) {
  if (routeOf(payload) === APP_ROUTE) return 'Your HivemindOS credits, through the app on this machine.';
  if (creditSource(payload) === 'app') {
    // Linked by reading the HivemindOS app's own key on this machine. Said out
    // loud: a credential picked up from another app should never be a thing the
    // owner discovers by accident.
    return 'Linked from the HivemindOS app on this machine — the same balance, even while it is closed.';
  }
  return accountConnected(payload)
    ? 'Your HivemindOS credits — the same balance as the app and every other HivemindOS app.'
    : 'Connect your HivemindOS account to spend the credits you already have.';
}

/** Where the key being spent came from: `app` (found on this machine),
 *  `connected` (the owner pasted one), or '' (nothing yet). */
export function creditSource(payload) {
  return sourceState(payload, HIVEMINDOS).credits?.source || '';
}

/** Has the owner pointed this studio at their HivemindOS account? Always true on
 *  the app route, which holds the key itself. */
export function accountConnected(payload) {
  if (routeOf(payload) === APP_ROUTE) return true;
  return Boolean(sourceState(payload, HIVEMINDOS).credits?.configured);
}

/** Groups the server labels HivemindOS's own tiers with. Everything else it
 *  routes is a named third-party model and belongs on the Cloud tab. */
const HOUSE_GROUPS = new Set(['HivemindOS', 'Hive Compute']);

export const isCloudModel = (row) => row?.source === HIVEMINDOS;

/** A model on one of the owner's own provider accounts. */
export const isAccountModel = (row) => row?.source === ACCOUNTS;

/** A local model has to be loaded into RAM before it can answer; a cloud one is
 *  answered by a machine that is already running. */
export const needsLoad = (row) => row?.source === LOCAL;

/** The tab a row lives on. */
export function tabOf(row) {
  if (isAccountModel(row)) return ACCOUNTS;
  if (!isCloudModel(row)) return LOCAL;
  return HOUSE_GROUPS.has(row.group) ? HIVEMINDOS : 'cloud';
}

/** Which source's state backs a tab. Two of the four tabs are two halves of the
 *  HivemindOS source, which is why this is a lookup and not `tab === source`. */
export function sourceIdForTab(tabId) {
  if (tabId === LOCAL) return LOCAL;
  if (tabId === ACCOUNTS) return ACCOUNTS;
  return HIVEMINDOS;
}

/** The model HivemindOS says to start on — its own answer, not a second copy of
 *  the same decision here. */
export function recommendedId(payload) {
  return String(payload?.sources?.[HIVEMINDOS]?.defaultModelId || '');
}

export function rowFor(payload, id) {
  if (!id) return null;
  return (payload?.models || []).find((row) => row.id === id) || null;
}

export function sourceState(payload, sourceId) {
  return payload?.sources?.[sourceId] || { available: false, models: [], detail: '', remedy: '' };
}

/** Every provider account this studio knows how to use, connected or not.
 *
 *  Not-connected accounts are listed on purpose: the tab is also how an owner
 *  discovers that the ChatGPT plan they already pay for can write scenes. */
export function accountsOf(payload) {
  return sourceState(payload, ACCOUNTS).accounts || [];
}

export function accountFor(payload, providerId) {
  return accountsOf(payload).find((account) => account.id === providerId) || null;
}

/** The rows belonging to one provider account. */
export function modelsForAccount(payload, providerId, query = '') {
  const rows = (payload?.models || []).filter(
    (row) => isAccountModel(row) && row.provider === providerId,
  );
  return rankByUse(search(visible(rows, query), query));
}

/** "3 of 9 connected" — what the accounts tab says about itself before any
 *  provider is chosen. */
export function accountsLine(payload) {
  const accounts = accountsOf(payload);
  if (!accounts.length) return '';
  const connected = accounts.filter((account) => account.connected).length;
  return connected ? `${connected} of ${accounts.length} connected` : 'none connected yet';
}

/**
 * The rows on one tab, filtered by the search box.
 *
 * The recommended model is pinned to the top of the HivemindOS tab even though
 * the catalog files it under the cloud list: it is the answer to "which one
 * should I use", and an owner should not have to search for the default.
 */
export function modelsForTab(payload, tabId, query = '') {
  const rows = (payload?.models || []).filter((row) => tabOf(row) === tabId);
  if (tabId === HIVEMINDOS) {
    const recommended = rowFor(payload, recommendedId(payload));
    if (recommended && tabOf(recommended) !== HIVEMINDOS) rows.unshift(recommended);
  }
  return rankByUse(search(visible(rows, query), query));
}

/** Everything worth listing for this query: the pins join in only once someone
 *  types, because that is the only time they are what was wanted. */
function visible(rows, query) {
  return String(query || '').trim() ? rows : rows.filter((row) => !isPinnedVariant(row));
}

/** How many rows a tab is holding back, so the cap is never silent. */
export function hiddenVariants(payload, tabId, providerId = '') {
  return (payload?.models || []).filter((row) => tabOf(row) === tabId
    && isPinnedVariant(row) && (!providerId || row.provider === providerId)).length;
}

/** Substring match over the things a person would actually type — the name they
 *  know it by, and the id they may have been given. */
export function search(rows, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => `${row.name} ${row.id} ${row.subtitle || ''}`.toLowerCase().includes(needle));
}

/**
 * How often the owner has actually chosen each model. The truest "popular"
 * this studio can measure, and the only one that is about THEM.
 *
 * Per browser, in localStorage, because it is a convenience rather than a
 * record — losing it costs one session of slightly worse ordering.
 */
const USE_KEY = 'hivemind.producer.modelUse';

export function modelUseCounts() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(USE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function rememberModelUse(id) {
  if (!id) return;
  try {
    const counts = modelUseCounts();
    counts[id] = (Number(counts[id]) || 0) + 1;
    window.localStorage.setItem(USE_KEY, JSON.stringify(counts));
  } catch {
    /* a browser that refuses storage still picks models fine */
  }
}

/**
 * The owner's own picks first, then the server's order.
 *
 * The server ranks by how many providers carry a model — a real demand signal,
 * but a global one. What someone reaches for twice a week beats it, and after a
 * few sessions this is the only ordering that matters to them.
 */
export function rankByUse(rows) {
  const counts = modelUseCounts();
  return rows
    .map((row, index) => ({ row, index, used: Number(counts[row.id]) || 0 }))
    .sort((a, b) => (b.used - a.used) || (a.index - b.index))
    .map((entry) => entry.row);
}

/** A dated or routed pin of another row — `gpt-5-2025-08-07` under `gpt-5`,
 *  `glm-5.2:free` under `glm-5.2`. Reachable by search, out of the way until
 *  then: on this machine they were 139 of 637 rows. */
export const isPinnedVariant = (row) => Boolean(row?.pinned);

/** How many models each tab can offer, for the tab's own count badge.
 *
 *  Counted through `modelsForTab` rather than by membership, so the badge is
 *  what the tab actually lists — the HivemindOS tab also shows the recommended
 *  model, and a badge reading one over a list of two is a small lie. */
export function tabCounts(payload) {
  return Object.fromEntries(TABS.map((tab) => [tab.id, modelsForTab(payload, tab.id).length]));
}

/**
 * Which model to start on.
 *
 * The owner's last choice wins whenever it still exists — including over the
 * server's suggestion, because overriding a deliberate choice on every reload is
 * the behaviour this replaces. Otherwise the server decides: a local model
 * already in RAM, else HivemindOS's default, else a local model that fits.
 */
export function startingModelId(payload, lastUsedId = '') {
  if (lastUsedId && rowFor(payload, lastUsedId)) return lastUsedId;
  return String(payload?.defaultModelId || '');
}

/** The status line beside a row: what a local model would cost in RAM, or what a
 *  cloud model costs to run. */
export function statusLine(row) {
  if (!row) return '';
  // The provider's own price when it quoted one, else the account that pays —
  // which is the fact that matters on this tab, because it is not the same
  // wallet as either of the other two.
  // Price and context when the provider quotes them, otherwise nothing. This
  // used to read "Billed to your own account" on every row — a sentence the tab
  // states once above them, and pure noise forty times underneath.
  if (isAccountModel(row)) return row.subtitle || '';
  if (!isCloudModel(row)) return modelStatus(row);
  if (row.tier === 'free') return row.subtitle || 'Free daily allowance';
  return row.subtitle || 'HivemindOS credits';
}

/** One line for the collapsed producer bar, so the source is legible without
 *  opening the picker. */
export function summaryLine(row) {
  if (!row) return 'no model chosen';
  const where = isAccountModel(row) ? row.group : isCloudModel(row) ? 'HivemindOS' : 'on this machine';
  // On the collapsed bar the wallet IS the useful half, so an account row that
  // has no price to show says so here rather than nowhere.
  const status = statusLine(row) || (isAccountModel(row) ? 'billed to your own account' : '');
  return status ? `${row.name || row.id} · ${where} · ${status}` : `${row.name || row.id} · ${where}`;
}

/** The privacy sentence that is true for the CHOSEN model, rather than one
 *  sentence that is true for only half of them. */
export function privacyLine(row) {
  const tab = TABS.find((entry) => entry.id === (row ? tabOf(row) : LOCAL));
  return tab?.privacy || '';
}

/**
 * What a source cannot do right now, and the button that repairs it.
 *
 * Modelled on the image picker's readiness: a source that is missing, unlinked
 * or out of credits is a state with an action, never a sentence that arrives
 * after a press has already been spent.
 */
export const REMEDIES = Object.freeze({
  'add-local-model': { label: 'Open Models', action: 'models' },
  'link-hivemindos': { label: 'Open HivemindOS', action: 'open' },
  'open-hivemindos': { label: 'Open HivemindOS', action: 'open' },
  // Adding credits is two different acts: with the app running it belongs there,
  // so the machine keeps one balance; without it the studio opens the checkout
  // itself, because "go and install HivemindOS first" is not an answer for
  // someone who does not have it.
  'top-up': { label: 'Add credits', action: 'top-up' },
  // The answer for a studio with no app: the owner's HivemindOS account key,
  // which spends the balance they already have. Buying a second one is the
  // fallback for someone who has never had HivemindOS credits at all.
  'connect-account': { label: 'Connect account', action: 'connect' },
  // No provider account connected at all. Points at the tab rather than at one
  // provider, because which one to connect is the owner's choice.
  'connect-provider': { label: 'Connect an account', action: 'accounts' },
  retry: { label: 'Try again', action: 'refresh' },
});

/**
 * The action that repairs a state, including the ones that name a target.
 *
 * A provider account's remedy has to say WHICH account — "Add key" with no key
 * name is the same dead end as an error with no button — so those arrive as
 * `key:OPENROUTER_API_KEY` or `oauth:openai` and are parsed here rather than
 * enumerated: the server owns the provider list, and a hard-coded copy in the
 * browser is the half that goes stale when a provider is added.
 */
export function remedyFor(remedy) {
  const value = String(remedy || '');
  if (value.startsWith('key:')) {
    return { label: 'Add key', action: 'key', key: value.slice(4) };
  }
  if (value.startsWith('oauth:')) {
    return { label: 'Sign in', action: 'oauth', provider: value.slice(6) };
  }
  return REMEDIES[value] || null;
}

/**
 * How long to wait for the app to answer a link before saying it did not.
 *
 * A custom-scheme link that nothing handles fails SILENTLY — no error, no
 * window, nothing to catch. So the studio treats silence as an answer after
 * this long and offers the paste path instead, which is the difference between
 * a button that appears broken and one that tells you what happened.
 */
export const LINK_WAIT_MS = 45000;
export const LINK_POLL_MS = 1500;

/** The credit line for the HivemindOS tab: what is left, or what is missing —
 *  said before a press, not after a refusal. */
export function creditsLine(payload) {
  const credits = sourceState(payload, HIVEMINDOS).credits || {};
  if (!credits.configured) {
    return routeOf(payload) === APP_ROUTE ? 'No credits added yet' : 'Account not connected';
  }
  return credits.label ? `${credits.label} left` : '';
}

/** Total RAM headroom, for the local tab's own line. */
export function localHeadroom(payload) {
  const local = sourceState(payload, LOCAL);
  return local.availableBytes ? `${formatBytes(local.availableBytes)} free` : '';
}
