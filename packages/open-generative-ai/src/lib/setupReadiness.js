// Can this machine make anything yet?
//
// A first run used to answer that question with a Generate button and a MUAPI
// key modal. Neither is an answer: the button fails, and the modal is a third
// party's paywall standing where the product's own three doors belong.
//
// So the question is asked BEFORE anything is pressed, from the four places a
// source can come from, and the answer is one boolean the shell and the studio
// frame both read:
//
//   cloud     a provider row the studio can already run — a key this machine
//             holds, or a live OAuth grant (providerReadiness decides, so the
//             rules do not fork)
//   local     the bridge answered 'ready' AND there is at least one model
//   video     the Media Studio workflow registry came back with workflows
//   rented    an attached rental whose tunnel is alive
//
// Any one of them is enough. When none of them is true the studio shows the
// Setup state, and when one becomes true it disappears by itself — there is no
// "seen" flag, because a dismissed setup screen on a machine that still cannot
// generate is the same dead end with an extra click.
import { useEffect, useSyncExternalStore } from 'react';

import {
  isHivemindStudioEnabled, loadHivemindStudioContext, mapHivemindWorkflowModels,
} from './hivemindStudio.js';
import { localAI } from './localInferenceClient.js';
import { fetchOAuthStatus, readinessFor, refreshMuapiKeyLocation } from './providerReadiness.js';
import { RENTED_CHANGED_EVENT, rentedMachinesState } from './rentedMachines.js';

/** Catalog providers that are not a source anyone can "connect": two renderers,
 *  and the two ids that mean this machine's own studio (covered by the local
 *  and video-workflow answers instead). */
export const NON_ACCOUNT_PROVIDERS = Object.freeze([
  'stickman-renderer', 'static-text-renderer', 'comfyui', 'media-studio-mcp',
]);

/**
 * The provider rows the account doors are about, from `/api/simple/catalog`.
 *
 * Shaped the way `readinessFor` wants one — `{ provider, source, available,
 * needs }` — so the Setup state, the Story picker and the studios all reach the
 * same verdict about the same account.
 */
export function cloudRowsFromCatalog(catalog) {
  const skip = new Set(NON_ACCOUNT_PROVIDERS);
  const seen = new Set();
  const rows = [];
  for (const kind of ['image', 'video']) {
    for (const provider of catalog?.media?.[kind] || []) {
      const id = String(provider?.id || '');
      if (!id || skip.has(id) || seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id: String(provider?.models?.[0]?.id || ''),
        provider: id,
        source: 'cloud',
        label: String(provider?.label || id),
        available: provider?.available !== false,
        needs: String(provider?.detail || ''),
      });
    }
  }
  return rows;
}

/**
 * Is any source ready? Pure, so the four inputs can be tested without a stack.
 *
 * `localStatus` is localInferenceClient's verdict; a bridge that says 'ready'
 * with nothing installed is not a source, which is why the count is required
 * rather than inferred from the status alone.
 */
export function isAnySourceReady({
  cloudRows = [], oauth = null,
  localStatus = '', localModelCount = 0,
  videoWorkflowCount = 0, rentedLiveCount = 0,
} = {}) {
  if (localStatus === 'ready' && Number(localModelCount) > 0) return true;
  if (Number(videoWorkflowCount) > 0) return true;
  if (Number(rentedLiveCount) > 0) return true;
  return (cloudRows || []).some((row) => readinessFor(row, { oauth }).state === 'ready');
}

/** Every account row with what it is waiting for — the door's own contents. */
export function accountRepairs({ cloudRows = [], oauth = null } = {}) {
  return (cloudRows || [])
    .map((row) => ({ row, readiness: readinessFor(row, { oauth }) }))
    .filter(({ readiness }) => readiness.action)
    .map(({ row, readiness }) => ({
      provider: row.provider,
      label: row.label,
      state: readiness.state,
      detail: readiness.detail,
      action: readiness.action,
    }));
}

/* ---------------- the shared answer ---------------- */

// `ready: null` means "nobody has looked yet". Rendering the Setup state on a
// guess would put it in front of every existing user for the length of a fetch.
let state = { ready: null, checking: false, cloudRows: [], oauth: null, repairs: [] };
const listeners = new Set();
let inflight = null;

function publish(next) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn(state));
}

export const getSetupReadiness = () => state;

export function subscribeSetupReadiness(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test seam: forget what was measured so the next refresh starts clean. */
export function resetSetupReadiness() {
  state = { ready: null, checking: false, cloudRows: [], oauth: null, repairs: [] };
  inflight = null;
}

/**
 * Ask all four questions once, and share one answer.
 *
 * Never throws and never leaves `checking` true: a source that cannot be read
 * is a source that is not ready, and a spinner that never stops is worse than
 * a door that turns out to be unnecessary.
 */
export function refreshSetupReadiness({ force = false } = {}) {
  if (!isHivemindStudioEnabled()) return Promise.resolve(state);
  if (inflight && !force) return inflight;
  publish({ checking: true });
  inflight = (async () => {
    const [context, oauth, local, rented] = await Promise.all([
      loadHivemindStudioContext({ refresh: force }).catch(() => null),
      fetchOAuthStatus().catch(() => null),
      localAI.listModels().catch(() => ({ models: [], status: 'unreachable' })),
      rentedMachinesState().catch(() => ({ live: [] })),
    ]);
    await refreshMuapiKeyLocation().catch(() => false);
    const cloudRows = cloudRowsFromCatalog(context?.catalog);
    const ready = isAnySourceReady({
      cloudRows,
      oauth,
      localStatus: String(local?.status || ''),
      localModelCount: (local?.models || []).length,
      videoWorkflowCount: mapHivemindWorkflowModels(context?.catalog).length,
      rentedLiveCount: (rented?.live || []).length,
    });
    publish({ ready, checking: false, cloudRows, oauth, repairs: accountRepairs({ cloudRows, oauth }) });
    return state;
  })().finally(() => { inflight = null; });
  return inflight;
}

/**
 * Ask again when something that could have changed the answer happened.
 *
 * Only while the answer is "no": once a source is ready nothing in the UI turns
 * on a later change, and four fetches per hub refresh for a question already
 * settled is a poll nobody asked for. Attached once, lazily, so importing this
 * module in a test does not need a DOM.
 */
let watching = false;
function watchForChanges() {
  if (watching || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  watching = true;
  const recheck = () => { if (state.ready === false) void refreshSetupReadiness({ force: true }); };
  window.addEventListener('hivemind-hub-refresh', recheck);
  window.addEventListener(RENTED_CHANGED_EVENT, recheck);
  window.addEventListener('hivemind-context-updated', recheck);
}

/** Subscribe a component to the shared answer, and ask once on first mount. */
export function useSetupReadiness() {
  const value = useSyncExternalStore(subscribeSetupReadiness, getSetupReadiness, getSetupReadiness);
  useEffect(() => {
    watchForChanges();
    // Every studio tab mounts a StudioLayout; the question is asked once, not
    // once per tab.
    if (getSetupReadiness().ready === null) void refreshSetupReadiness();
  }, []);
  return value;
}
