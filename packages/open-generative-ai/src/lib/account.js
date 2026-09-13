// The account: who this person is, what they hold, and the four ways to add to it.
//
// The browser half of `hivemind_content_studio/hivemindos_account.py`. Every
// call is a thin pass to a studio route — nothing here talks to the gateway
// directly, because the account key must never reach the page. What IS decided
// here is presentation: how a balance and a meter read as sentences, and where
// the meter turns from a fact into a warning.

async function api(path, body, { signal = null, method = '' } = {}) {
  const response = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Same shape `lib/localProducer.js` unwraps: a studio failure carries
    // `{message, remedy}` so the caller can put the repair beside the sentence
    // instead of printing a dead end.
    const detail = payload?.detail;
    const structured = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : null;
    const error = new Error(structured?.message || payload?.error || `Request failed (${response.status})`);
    error.remedy = String(structured?.remedy || '');
    error.status = response.status;
    throw error;
  }
  return payload;
}

/* ---------------- reads ---------------- */

/** Name, balance and free meter in one request — what the sidebar row shows. */
export function accountOverview({ signal = null } = {}) {
  return api('/api/hivemindos/account', null, { signal });
}

export function renameAccount(handle, { signal = null } = {}) {
  return api('/api/hivemindos/account/handle', { handle }, { signal });
}

export function subscriptionState({ signal = null } = {}) {
  return api('/api/hivemindos/account/subscription', null, { signal });
}

export function depositConfig({ signal = null } = {}) {
  return api('/api/hivemindos/account/deposit', null, { signal });
}

/* ---------------- backing it up ---------------- */

export function linkEmailStart(email, { signal = null } = {}) {
  return api('/api/hivemindos/account/email/link/start', { email }, { signal });
}

export function linkEmailVerify(challengeId, code, { signal = null } = {}) {
  return api('/api/hivemindos/account/email/link/verify', { challengeId, code }, { signal });
}

export function signInStart(email, { signal = null } = {}) {
  return api('/api/hivemindos/account/email/signin/start', { email }, { signal });
}

export function signInVerify(challengeId, code, { signal = null } = {}) {
  return api('/api/hivemindos/account/email/signin/verify', { challengeId, code }, { signal });
}

/** The account key, revealed once. A POST because it is an act, not a page. */
export function revealRecoveryKey({ signal = null } = {}) {
  return api('/api/hivemindos/account/recovery-key', {}, { signal });
}

/* ---------------- the four rails ---------------- */

export function startCardCheckout(amountUsd, { signal = null } = {}) {
  return api('/api/hivemindos/models/top-up', { amountUsd }, { signal });
}

export function startSubscription(tier, { signal = null } = {}) {
  return api('/api/hivemindos/account/subscription', { tier }, { signal });
}

export const CANCEL_SUBSCRIPTION_CONFIRMATION = 'CANCEL_HIVEMINDOS_CREDIT_SUBSCRIPTION';

export function cancelSubscription({ signal = null } = {}) {
  return api(
    '/api/hivemindos/account/subscription/cancel',
    { confirmation: CANCEL_SUBSCRIPTION_CONFIRMATION },
    { signal },
  );
}

export function quoteDeposit(payer, amountUsd, { signal = null } = {}) {
  return api('/api/hivemindos/account/deposit/quote', { payer, amountUsd }, { signal });
}

export function settleDeposit(paymentId, transactionHash, { signal = null } = {}) {
  return api('/api/hivemindos/account/deposit/settle', { paymentId, transactionHash }, { signal });
}

export function startWalletPayment(amountUsd, { signal = null } = {}) {
  return api('/api/hivemindos/account/wallet-pay', { amountUsd }, { signal });
}

export function walletPaymentState(nonce, { signal = null } = {}) {
  return api(`/api/hivemindos/account/wallet-pay/state?nonce=${encodeURIComponent(nonce)}`, null, { signal });
}

/** How long to keep asking whether the owner answered the app's prompt, and how
 *  often. The deep link cannot report that nothing opened it, so silence has to
 *  become an answer rather than a spinner nobody ever escapes. */
export const WALLET_POLL_MS = 1200;
export const WALLET_WAIT_MS = 5 * 60 * 1000;

/* ---------------- reading the numbers ---------------- */

/** The amounts offered, mirroring the HivemindOS app's own ladder. */
export const TOP_UP_AMOUNTS_USD = [5, 10, 25, 50, 100];

/** What one dollar buys, mirrored from the studio's `CREDITS_PER_USD`. */
export const CREDITS_PER_USD = 500;

export function creditsForUsd(usd) {
  return Math.round(Number(usd || 0) * CREDITS_PER_USD);
}

/** "1,240" — a balance is read at a glance, and the gateway keeps fractions. */
export function formatCredits(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return Math.round(number).toLocaleString('en-US');
}

export function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(number) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(number);
}

/**
 * The free meter as a fraction, or null when it cannot be known.
 *
 * Requests and tokens are metered separately and either can run out first, so
 * the bar shows whichever is emptier — a meter that reads half full while the
 * next press is refused is worse than no meter.
 */
export function allowanceFraction(allowance) {
  if (!allowance?.known) return null;
  const parts = [
    ratio(allowance.remainingRequests, allowance.requestLimit),
    ratio(allowance.remainingTokens, allowance.tokenLimit),
  ].filter((part) => part !== null);
  return parts.length ? Math.min(...parts) : null;
}

function ratio(remaining, limit) {
  // `Number(null)` is 0, not NaN — so a missing remaining count read as an
  // EMPTY allowance and painted the bar danger-red under the words "400 free a
  // day". A count we do not have is not a count of zero.
  if (remaining === null || remaining === undefined) return null;
  const left = Number(remaining);
  const total = Number(limit);
  if (!Number.isFinite(left) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(1, left / total));
}

/** Under this the meter turns from a fact into a warning colour. */
const LOW_ALLOWANCE = 0.15;

export function allowanceTone(allowance) {
  const fraction = allowanceFraction(allowance);
  if (fraction === null) return 'neutral';
  if (fraction <= 0) return 'danger';
  return fraction < LOW_ALLOWANCE ? 'warn' : 'ok';
}

/** When today's allowance comes back, as a local time rather than a UTC stamp. */
export function resetsAtLabel(allowance) {
  const at = Date.parse(allowance?.resetAt || '');
  if (!Number.isFinite(at)) return '';
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * The gradient a derived avatar paints.
 *
 * Kept as inline style rather than a Tailwind class because the hues are data —
 * one account is one pair of angles, and there is no finite palette to name.
 */
export function avatarStyle(avatar) {
  const hue = Number(avatar?.hue ?? 40);
  const hue2 = Number(avatar?.hue2 ?? 80);
  return {
    backgroundImage: `linear-gradient(135deg, hsl(${hue} 62% 52%), hsl(${hue2} 68% 44%))`,
  };
}
