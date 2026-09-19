// Is there a ComfyUI on this machine, and what does a studio say when there
// is not?
//
// ComfyUI is an OPTIONAL engine. The studio boots without one, the cloud and
// rented lanes work without one, and a local-only surface says "Connect
// ComfyUI" with the button instead of failing at Generate. This module is the
// browser half of /api/comfy/connect: one shared answer, cached, so the three
// pickers that ask do not each cost a probe.
//
// Nothing here is polled. The answer is fetched when a surface that would offer
// a local model finds it has nothing to offer — which on a healthy machine is
// never.
//
// The cache is module-level on purpose. The Connect state is a property of the
// machine, not of a component, and every studio that offers a local model wants
// the same sentence at the same moment.

import { useEffect, useState } from 'react';

const TTL_MS = 30_000;
const REFUSED = 'Could not ask this studio about ComfyUI.';

let cache = { at: 0, state: null };
let inflight = null;
const listeners = new Set();

/** What every consumer sees before an answer arrives, and after a refusal:
 *  `connected` is null, meaning "not known", never a confident false. */
export const UNKNOWN_CONNECTION = { connected: null, lanes: [], detected: [], running: [], error: '' };

function publish(state) {
  cache = { at: Date.now(), state };
  for (const listener of [...listeners]) listener(state);
}

/** The last answer, however old. Null when nothing has been asked yet. */
export function comfyConnectionCache() {
  return cache.state;
}

/** Ask the control API. One request at a time, shared by every caller. */
export function fetchComfyConnection({ force = false } = {}) {
  if (!force && cache.state && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.state);
  if (inflight) return inflight;
  inflight = fetch('/api/comfy/connect', { credentials: 'same-origin' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      return {
        connected: Boolean(payload.connected),
        lanes: Array.isArray(payload.lanes) ? payload.lanes : [],
        detected: Array.isArray(payload.detected) ? payload.detected : [],
        running: Array.isArray(payload.running) ? payload.running : [],
        attachableLanes: Array.isArray(payload.attachableLanes) ? payload.attachableLanes : ['default'],
        installUrl: String(payload.installUrl || ''),
        sourceUrl: String(payload.sourceUrl || ''),
        error: '',
      };
    })
    // A studio that cannot ask must not claim ComfyUI is missing: `connected:
    // null` keeps the picker's existing sentence rather than sending someone to
    // set up an engine they may already have.
    .catch(() => ({ ...UNKNOWN_CONNECTION, error: REFUSED }))
    .then((state) => { publish(state); return state; })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Attach a running ComfyUI to a lane. Resolves with the new state. */
export async function connectComfy(url, lane = 'default') {
  const response = await fetch('/api/comfy/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ url, lane }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The server's refusal already names the fix ("Start ComfyUI first, then
    // attach it") — it is a sentence written for this card, not raw backend
    // text, so it is shown rather than replaced with a status code.
    throw new Error(String(payload?.detail || payload?.message || REFUSED));
  }
  return fetchComfyConnection({ force: true }).then(() => payload);
}

/** Forget an attachment. The lane falls back to its configured URL. */
export async function disconnectComfy(lane = 'default') {
  await fetch('/api/comfy/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ lane }),
  }).catch(() => {});
  return fetchComfyConnection({ force: true });
}

export function subscribeComfyConnection(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam and hub-refresh hook: drop the cached answer. */
export function resetComfyConnection() {
  cache = { at: 0, state: null };
  inflight = null;
}

/**
 * The Connect state, fetched once per surface that needs it.
 *
 * @param {boolean} enabled Ask only when the caller has something to say about
 *   it — a picker with local rows to offer never needs the answer.
 * @returns {{connected: boolean|null, lanes: Array, detected: Array, running: Array, error: string}}
 */
export function useComfyConnection(enabled = true) {
  const [state, setState] = useState(() => comfyConnectionCache() || UNKNOWN_CONNECTION);

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const unsubscribe = subscribeComfyConnection((next) => { if (live) setState(next); });
    void fetchComfyConnection().then((next) => { if (live) setState(next); });
    return () => { live = false; unsubscribe(); };
  }, [enabled]);

  // The hub broadcasts this after a stack change; a ComfyUI started since the
  // tab loaded should light the lane without a reload.
  useEffect(() => {
    if (!enabled) return undefined;
    const onRefresh = () => { void fetchComfyConnection({ force: true }); };
    window.addEventListener('hivemind-hub-refresh', onRefresh);
    return () => window.removeEventListener('hivemind-hub-refresh', onRefresh);
  }, [enabled]);

  return state;
}
