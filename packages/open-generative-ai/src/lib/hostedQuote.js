// What the next press on the hosted rail will cost, for the button about to
// make it.
//
// There is no catalogue figure the studio could honestly print. The
// HivemindOS media gateway lists 538 endpoints and prices exactly ten of them
// statically; the other 528 are `dynamicPricing`, and even the ten move with
// the request — flux-3-text-to-video quotes $0.94 at 3 seconds, $1.56 at 5
// and $3.13 at 10, and $1.56 at 720p against $2.63 at 1080p. So the number
// comes from a quote of the request the composer is actually holding, re-asked
// when that request changes.
//
// Quoting is free and reserves nothing: the gateway's quote route takes no
// credential at all. What it is NOT is a promise — the run quotes itself
// again before it spends, and refuses to exceed the ceiling this number set.
import { useEffect, useRef, useState } from 'react';

// The ONE conversion both apps use (media-model-catalog.v1): credits are
// retail USD x 500, rounded up, so the cheapest model on the rail still costs
// something rather than rounding to free.
export function creditsForUsd(usd) {
  const value = Number(usd) || 0;
  return value > 0 ? Math.ceil(value * 500) : 0;
}

/**
 * "44 credits" / "2 credits", and "~44 credits" when the figure is for a
 * press other than the one the composer is set up to make.
 *
 * The unit is spelled out: a bare number beside a duration reads as seconds.
 * The PLACE is not — "HivemindOS credits · 44 credits" says credits twice,
 * and on the Hivemind tab the place was never in question.
 */
export function formatCredits(credits, { exact = true } = {}) {
  const value = Number(credits) || 0;
  if (value <= 0) return '';
  return `${exact ? '' : '~'}${value.toLocaleString()} credit${value === 1 ? '' : 's'}`;
}

/**
 * Ask the studio what one press would cost.
 *
 * Resolves to `{usd, credits, capability, model, category}`; throws with the
 * server's own sentence, which is already prose (a model that cannot start
 * from what is attached says so by name).
 */
export async function quoteHostedRun(request, { signal = null } = {}) {
  const response = await fetch('/api/media-studio/hosted-quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    signal,
    body: JSON.stringify(request),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(body?.detail?.message || body?.detail || `Could not price this run (${response.status})`));
  }
  return {
    usd: Number(body?.usd) || 0,
    credits: Number(body?.credits) || 0,
    capability: String(body?.capability || ''),
    model: String(body?.model || ''),
    category: String(body?.category || ''),
  };
}

/* ---------------- which endpoint a row is priced as ---------------- */

// What each capability starts FROM, which is the other half of pricing it:
// the gateway prices an endpoint, and an endpoint that edits a picture is
// only priced with one in the request.
const CAPABILITY_ATTACHED = {
  'text-to-image': 'none',
  'text-to-video': 'none',
  'image-to-image': 'image',
  'image-to-video': 'image',
  'video-to-video': 'video',
  'audio-to-video': 'audio',
};

/**
 * Which of a row's endpoints to price, and whether that is the press the
 * composer is currently set up to make.
 *
 * First choice is what the composer holds — a reference attached means the
 * editing endpoint, and that is not the same money. But a row that ONLY
 * edits is still worth a price with nothing attached: "38 credits once you
 * attach a picture" is a useful thing to know while choosing, and a row that
 * fell back to its place label would be the redundant "HivemindOS credits"
 * all over again. That case is the one the tilde is for.
 *
 * Returns `{capability, model, usd, attached, exact}`.
 */
export function routeForAttached(hostedRoutes, kind, attached = 'none') {
  const routes = hostedRoutes && typeof hostedRoutes === 'object' ? hostedRoutes : null;
  if (!routes) return null;
  const wanted = kind === 'video'
    ? ({ none: ['text-to-video'], image: ['image-to-video', 'text-to-video'], video: ['video-to-video', 'image-to-video', 'text-to-video'], audio: ['audio-to-video', 'text-to-video'] }[attached] || ['text-to-video'])
    : ({ none: ['text-to-image'], image: ['image-to-image', 'text-to-image'] }[attached] || ['text-to-image']);
  for (const capability of wanted) {
    if (routes[capability]) return { capability, ...routes[capability], attached, exact: true };
  }
  // Nothing this row does matches what is attached: price what it DOES.
  const [capability] = Object.keys(routes);
  if (!capability) return null;
  return { capability, ...routes[capability], attached: CAPABILITY_ATTACHED[capability] || 'none', exact: false };
}

const DEBOUNCE_MS = 400;

/**
 * The live price of the current composer state, debounced.
 *
 * `enabled` is the caller's "this run is on the hosted rail" — every other
 * place bills differently and must not spend a round trip here. The request
 * is keyed by its own JSON, so a re-render that changes nothing re-asks
 * nothing, and a request in flight is abandoned when the state moves on.
 */
export function useHostedQuote({ enabled = false, ...request } = {}) {
  const [state, setState] = useState({ credits: 0, usd: 0, loading: false, error: '' });
  // The whole request, as its own identity: typing in the prompt does not
  // change the price, and re-asking on every keystroke would be 40 round
  // trips a sentence.
  const key = enabled ? JSON.stringify(request) : '';
  const latest = useRef(0);
  useEffect(() => {
    if (!key) { setState({ credits: 0, usd: 0, loading: false, error: '' }); return undefined; }
    const ticket = ++latest.current;
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true, error: '' }));
    const timer = setTimeout(() => {
      void quoteHostedRun(JSON.parse(key), { signal: controller.signal })
        .then((quote) => {
          if (ticket === latest.current) setState({ credits: quote.credits, usd: quote.usd, loading: false, error: '' });
        })
        .catch((error) => {
          if (controller.signal.aborted || ticket !== latest.current) return;
          // A price that cannot be read is not a press that cannot be made:
          // the run quotes itself before it spends either way.
          setState({ credits: 0, usd: 0, loading: false, error: error?.message || 'No price yet' });
        });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key]);
  return state;
}
