// Which models the producer can think with, how the picker groups them, and
// what one press costs on each.
//
// The producer used to be local-only, which meant a machine with no GGUF on it
// had no producer at all — every stage button in the Story studio was dead. It
// can now also run on HivemindOS's models, which are the SAME models, credits
// and billing as the HivemindOS app itself, and on the owner's own provider
// accounts.
//
// The app is NOT required, and it is NOT a second balance. It is a proxy in
// front of a public gateway: with it running the studio uses it (it already
// holds the machine's account key), and without it the studio holds the owner's
// own HivemindOS account key and spends THE SAME credits. `sources.hivemindos`
// carries `route` and `credits.configured` so the picker can say which of the
// three states it is in — using the app, connected directly, or not connected
// yet — and offer the one action that moves it forward.
//
// The server answers `/api/text-models` with every source at once; this module
// is the browser half of that one answer — sections, search, the starting
// choice, the cost of a press, and the sentence each source is honest about.
// Nothing here fetches a catalog of its own, so the picker cannot drift from
// what will actually run.
import { t } from './i18n.js';
import { pref, setPrefs } from './prefs.js';
import { formatBytes, modelStatus } from './promptHelperRuntime.js';

export const LOCAL = 'local';
export const HIVEMINDOS = 'hivemindos';
/** The owner's OWN provider accounts — their OpenAI key, their ChatGPT
 *  sign-in, their OpenRouter balance. Billed by that provider to that account,
 *  never to HivemindOS credits, and read from the same shared credential store
 *  the HivemindOS app uses, so connecting one anywhere connects it everywhere. */
export const ACCOUNTS = 'accounts';
/** No filter: every section in one list. */
export const ALL = '';

/**
 * The three things an owner is actually choosing between — three different
 * bills, three different privacy answers.
 *
 * There used to be a fourth, "Cloud models", holding the hundreds of named
 * models HivemindOS routes, apart from its own house tiers. It was the same
 * balance and the same privacy sentence as the HivemindOS tab, and splitting
 * one bill across two tabs was the thing that made the picker feel messy: an
 * owner had to know which of two places HivemindOS had filed GPT under. Now a
 * section is a bill, and a search box is how a named model is found.
 */
export const SECTIONS = Object.freeze([
  {
    id: LOCAL,
    label: t('place.thisMac'),
    blurb: 'Runs here. Free, private, and as fast as the hardware.',
    privacy: 'Everything it is told stays on this machine — it is a llama-server here, not a cloud model.',
  },
  {
    id: HIVEMINDOS,
    label: 'HivemindOS',
    blurb: 'One balance of HivemindOS credits: the house tiers, the free model, and every model HivemindOS can reach.',
    privacy: 'The story is sent to HivemindOS to answer, and the answer is charged to your HivemindOS credits.',
  },
  {
    id: ACCOUNTS,
    label: t('place.accounts'),
    blurb: t('place.accountsBlurb'),
    privacy: 'The story is sent straight to the provider you picked and billed to your own account there. It does not pass through HivemindOS.',
  },
]);

/** The older name for the same list. */
export const TABS = SECTIONS;

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

/** Groups the server labels HivemindOS's own tiers with. */
const HOUSE_GROUPS = new Set(['HivemindOS', 'Hive Compute']);

export const isCloudModel = (row) => row?.source === HIVEMINDOS;

/** A model on one of the owner's own provider accounts. */
export const isAccountModel = (row) => row?.source === ACCOUNTS;

/** The free HivemindOS model, on the daily allowance rather than credits. */
export const isFreeCloudModel = (row) => isCloudModel(row) && row?.tier === 'free';

/** A HivemindOS row that will be charged to credits. */
export const isPaidCloudModel = (row) => isCloudModel(row) && row?.tier !== 'free';

/** A local model has to be loaded into RAM before it can answer; a cloud one is
 *  answered by a machine that is already running. */
export const needsLoad = (row) => row?.source === LOCAL;

/** The section a row lives in. */
export function tabOf(row) {
  if (isAccountModel(row)) return ACCOUNTS;
  return isCloudModel(row) ? HIVEMINDOS : LOCAL;
}

/** Which source's state backs a section. Identity now that a section IS a
 *  source; kept so callers written against the older four-tab picker still
 *  resolve. */
export function sourceIdForTab(tabId) {
  return tabId === ACCOUNTS ? ACCOUNTS : tabId === LOCAL ? LOCAL : HIVEMINDOS;
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
 *  Not-connected accounts are listed on purpose: the section is also how an
 *  owner discovers that the ChatGPT plan they already pay for can write scenes. */
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

/** "3 of 9 connected" — what the accounts section says about itself. */
export function accountsLine(payload) {
  const accounts = accountsOf(payload);
  if (!accounts.length) return '';
  const connected = accounts.filter((account) => account.connected).length;
  return connected ? `${connected} of ${accounts.length} connected` : 'none connected yet';
}

/**
 * The rows in one section, filtered by the search box.
 *
 * The recommended model is pinned to the top of the HivemindOS section: it is
 * the answer to "which one should I use", and an owner should not have to
 * search for the default. The free model comes next, because "what does this
 * cost" is the second question and its answer is nothing.
 */
export function modelsForTab(payload, tabId, query = '') {
  const rows = (payload?.models || []).filter((row) => tabOf(row) === tabId);
  if (tabId === HIVEMINDOS) {
    const first = [recommendedId(payload), ...rows.filter(isFreeCloudModel).map((row) => row.id)];
    rows.sort((a, b) => rank(first, a.id) - rank(first, b.id));
  }
  return rankByUse(search(visible(rows, query), query));
}

function rank(order, id) {
  const index = order.indexOf(id);
  return index === -1 ? order.length : index;
}

/**
 * What the unfiltered list shows for a section: a short, deliberate head of
 * the list rather than all of it.
 *
 * HivemindOS routes hundreds of named models. Listing them all under the three
 * local ones is a page nobody scrolls; listing none is a picker that hides what
 * it can do. So each section leads with what it is most likely wanted for —
 * the default, the free model, what the owner has used before, the house tiers
 * — and says how many more a search or the section's own filter can reach.
 */
export function featuredRows(payload, tabId, limit = 6) {
  const rows = modelsForTab(payload, tabId);
  if (tabId !== HIVEMINDOS) {
    return { rows: rows.slice(0, limit), hidden: Math.max(0, rows.length - limit) };
  }
  const counts = modelUseCounts();
  const lead = rows.filter((row) => row.id === recommendedId(payload) || isFreeCloudModel(row)
    || (Number(counts[row.id]) || 0) > 0 || HOUSE_GROUPS.has(row.group));
  const rest = rows.filter((row) => !lead.includes(row));
  const shown = [...lead, ...rest].slice(0, limit);
  return { rows: shown, hidden: Math.max(0, rows.length - shown.length) };
}

/** Everything worth listing for this query: the pins join in only once someone
 *  types, because that is the only time they are what was wanted. */
function visible(rows, query) {
  return String(query || '').trim() ? rows : rows.filter((row) => !isPinnedVariant(row));
}

/** How many rows a section is holding back, so the cap is never silent. */
export function hiddenVariants(payload, tabId, providerId = '') {
  return (payload?.models || []).filter((row) => tabOf(row) === tabId
    && isPinnedVariant(row) && (!providerId || row.provider === providerId)).length;
}

/** Substring match over the things a person would actually type — the name they
 *  know it by, and the id they may have been given. */
export function search(rows, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => `${row.name} ${row.id} ${row.subtitle || ''} ${row.group || ''}`.toLowerCase().includes(needle));
}

/**
 * How often the owner has actually chosen each model. The truest "popular"
 * this studio can measure, and the only one that is about THEM.
 *
 * Per browser, in localStorage, because it is a convenience rather than a
 * record — losing it costs one session of slightly worse ordering.
 */
export function modelUseCounts() {
  return pref('modelUse');
}

export function rememberModelUse(id) {
  if (!id) return;
  const counts = { ...modelUseCounts() };
  counts[id] = (Number(counts[id]) || 0) + 1;
  setPrefs({ modelUse: counts });
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

/** How many models each section can offer, for its count badge.
 *
 *  Counted through `modelsForTab` rather than by membership, so the badge is
 *  what the section actually lists. */
export function tabCounts(payload) {
  return Object.fromEntries(SECTIONS.map((tab) => [tab.id, modelsForTab(payload, tab.id).length]));
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

/* ------------------------------------------------------------------ cost */

/**
 * The size of one press, for the estimate beside each paid row.
 *
 * A Story draft: measured 2026-09-02, the "concepts" ask is ~360 prompt tokens
 * before any locked context, and later stages carry the contract, cast and
 * board as JSON on top — a thousand is a round, honest middle. Eight concepts
 * of six prose fields come back at roughly two and a half thousand tokens. The
 * prompt helper writes one media prompt from a long system profile: more in,
 * less out. Both are typical sizes, not ceilings — the task budgets (4,000 to
 * 6,000) are what a reasoning model MAY spend, not what a draft costs.
 */
export const DRAFT_USAGE = Object.freeze({ label: 'per draft', promptTokens: 1000, completionTokens: 2500 });
export const PROMPT_USAGE = Object.freeze({ label: 'per prompt', promptTokens: 1200, completionTokens: 700 });

function perMillion(rate, tokens) {
  // A missing rate is not a free model; only a number counts.
  if (rate === null || rate === undefined || rate === '') return null;
  const value = Number(rate);
  return Number.isFinite(value) && value >= 0 ? (value * tokens) / 1_000_000 : null;
}

/** HivemindOS credits one press on this row costs, or null when the catalog
 *  quoted no rate. Never for the free model — the allowance is not credits. */
export function creditsPerCall(row, usage = DRAFT_USAGE) {
  if (!isPaidCloudModel(row)) return null;
  const prompt = perMillion(row.promptCreditsPerMTok, usage.promptTokens);
  const completion = perMillion(row.completionCreditsPerMTok, usage.completionTokens);
  return prompt === null || completion === null ? null : prompt + completion;
}

/** Dollars one press costs on a provider account, or null when unquoted. */
export function usdPerCall(row, usage = DRAFT_USAGE) {
  if (!isAccountModel(row)) return null;
  const prompt = perMillion(row.promptUsdPerMTok, usage.promptTokens);
  const completion = perMillion(row.completionUsdPerMTok, usage.completionTokens);
  return prompt === null || completion === null ? null : prompt + completion;
}

export function formatCredits(value) {
  if (value < 1) return '< 1 credit';
  const rounded = Math.round(value);
  return `${rounded.toLocaleString('en-US')} ${rounded === 1 ? 'credit' : 'credits'}`;
}

export function formatUsd(value) {
  if (value < 0.01) return '< $0.01';
  return `$${value.toFixed(2)}`;
}

/**
 * What one press costs on this row, in the terms that source charges in.
 *
 * The one line every row carries, right-aligned, so the choice reads as a
 * price list: "Free · private", "≈ 5 credits per draft", "≈ $0.03 per draft".
 * A paid row with no quoted rate says whose money it is rather than pretending
 * to a number.
 */
export function costLine(row, usage = DRAFT_USAGE) {
  if (!row) return '';
  if (!isCloudModel(row) && !isAccountModel(row)) return 'Free · private';
  if (isFreeCloudModel(row)) {
    const cap = Number(row.maxOutputTokens);
    return cap > 0 ? `Free · answers up to ${cap.toLocaleString('en-US')} tokens` : 'Free';
  }
  if (isCloudModel(row)) {
    const credits = creditsPerCall(row, usage);
    return credits === null ? 'HivemindOS credits' : `${about(credits < 1)}${formatCredits(credits)} ${usage.label}`;
  }
  const usd = usdPerCall(row, usage);
  return usd === null ? 'billed to your own account' : `${about(usd < 0.01)}${formatUsd(usd)} ${usage.label}`;
}

/** "≈ 4 credits", but "< 1 credit" — a bound is already approximate. */
const about = (bounded) => (bounded ? '' : '≈ ');

/** The rate behind the estimate, for a tooltip: the owner can check the
 *  arithmetic without the picker printing it on every row. */
export function rateLine(row) {
  if (isPaidCloudModel(row)) {
    const prompt = Number(row.promptCreditsPerMTok);
    const completion = Number(row.completionCreditsPerMTok);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return '';
    return `${Math.round(prompt).toLocaleString('en-US')} in · ${Math.round(completion).toLocaleString('en-US')} out credits per 1M tokens`;
  }
  if (isAccountModel(row)) {
    const prompt = Number(row.promptUsdPerMTok);
    const completion = Number(row.completionUsdPerMTok);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return '';
    return `$${trim(prompt)} in · $${trim(completion)} out per 1M tokens`;
  }
  return '';
}

function trim(value) {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** The small line under a row's name: what differs from the row above it and
 *  is not already the cost. A local model's RAM state, a house tier's blurb, a
 *  provider model's context size. */
export function detailLine(row) {
  if (!row) return '';
  if (!isCloudModel(row) && !isAccountModel(row)) return modelStatus(row);
  // "$0.52 in · $3.12 out /1M" is the rate, and the rate is the tooltip now.
  const parts = String(row.subtitle || '').replace(PRICE_SEGMENT, '')
    .split(' · ').map((part) => part.trim()).filter(Boolean);
  if (isFreeCloudModel(row)) return parts.filter((part) => !/^free/i.test(part)).join(' · ');
  return parts.join(' · ');
}

const PRICE_SEGMENT = /\$[\d.,]+ in · \$[\d.,]+ out \/1M/g;

/** The status line beside a row — the older name for the cost. */
export function statusLine(row) {
  if (!row) return '';
  if (isAccountModel(row)) return row.subtitle || '';
  if (!isCloudModel(row)) return modelStatus(row);
  if (row.tier === 'free') return row.subtitle || 'Free daily allowance';
  return row.subtitle || 'HivemindOS credits';
}

/** One line for the collapsed producer bar, so the source and the price are
 *  legible without opening the picker. */
export function summaryLine(row, usage = DRAFT_USAGE) {
  if (!row) return 'no model chosen';
  const where = isAccountModel(row) ? row.group : isCloudModel(row) ? 'HivemindOS' : 'this machine';
  return `${row.name || row.id} · ${where} · ${costLine(row, usage)}`;
}

/** The privacy sentence that is true for the CHOSEN model, rather than one
 *  sentence that is true for only half of them. */
export function privacyLine(row) {
  const tab = SECTIONS.find((entry) => entry.id === (row ? tabOf(row) : LOCAL));
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
  'add-local-model': { label: t('common.openModels'), action: 'models' },
  'link-hivemindos': { label: t('failure.openHivemindos'), action: 'open' },
  'open-hivemindos': { label: t('failure.openHivemindos'), action: 'open' },
  // Adding credits is two different acts: with the app running it belongs there,
  // so the machine keeps one balance; without it the studio opens the checkout
  // itself, because "go and install HivemindOS first" is not an answer for
  // someone who does not have it.
  'top-up': { label: t('failure.addCredits'), action: 'top-up' },
  // The answer for a studio with no app: the owner's HivemindOS account key,
  // which spends the balance they already have. Buying a second one is the
  // fallback for someone who has never had HivemindOS credits at all.
  'connect-account': { label: t('failure.connectAccount'), action: 'connect' },
  // The restore and SAM3 capability payloads say `connect` for the same act.
  // One vocabulary reaching two spellings is cheaper than a server migration
  // that would silently drop the button on any client that has not shipped yet.
  connect: { label: t('failure.connectAccount'), action: 'connect' },
  // No provider account connected at all. Points at the section rather than at
  // one provider, because which one to connect is the owner's choice.
  'connect-provider': { label: t('failure.connectAccount'), action: 'accounts' },
  retry: { label: t('common.tryAgain'), action: 'refresh' },
  // A machine that cannot do the job is repaired on the Machines page — attach
  // one that can, or rent one. The restore lanes are the first rows to say it,
  // and they say it in the one vocabulary rather than a second one.
  'attach-machine': { label: t('failure.openMachines'), action: 'machines' },
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
    return { label: t('failure.addKey'), action: 'key', key: value.slice(4) };
  }
  if (value.startsWith('oauth:')) {
    return { label: t('failure.signIn'), action: 'oauth', provider: value.slice(6) };
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

/** The credit line for the HivemindOS section: what is left, or what is
 *  missing — said before a press, not after a refusal. */
export function creditsLine(payload) {
  const credits = sourceState(payload, HIVEMINDOS).credits || {};
  if (!credits.configured) {
    return routeOf(payload) === APP_ROUTE ? 'No credits added yet' : 'Account not connected';
  }
  return credits.label ? `${credits.label} left` : '';
}

/** Total RAM headroom, for the local section's own line. */
export function localHeadroom(payload) {
  const local = sourceState(payload, LOCAL);
  return local.availableBytes ? `${formatBytes(local.availableBytes)} free` : '';
}

/** The one fact each section header carries on its right: RAM left, credits
 *  left, accounts connected. */
export function sectionLine(payload, tabId) {
  if (tabId === LOCAL) return localHeadroom(payload);
  if (tabId === ACCOUNTS) return accountsLine(payload);
  return creditsLine(payload);
}
