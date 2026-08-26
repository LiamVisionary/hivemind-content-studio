// The Story studio's line to its producer, on whichever engine it is running.
//
// The prompt helper's dialog already owns this dance for media prompts (pick a
// model, load it, wait for llama-server to come up, ask). This is the same
// dance for a different question, factored out of the UI so the studio can run
// it from a stage button instead of a modal. The pure half — which models can
// be selected, what their status line says, which one to start on — stays in
// lib/promptHelperRuntime.js and lib/textModels.js and is not duplicated here.
//
// Two engines, one call. A local model has to be loaded into this machine's RAM
// before it can answer, so the ask waits for that; a HivemindOS model is served
// by a machine that is already running, so the load step is skipped rather than
// faked. Which engine a model id belongs to is decided in ONE place
// (lib/textModels.js here, text_models.py on the server) — the mis-routing this
// avoids is the same one the image dispatcher was built for.
import { flattenApiDetail } from './muapiErrors.js';
import { needsLoad } from './textModels.js';

async function api(path, body, { signal = null } = {}) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // FastAPI hands 422s back as an array of { msg }; unflattened it toasts as
    // "[object Object]". A cloud producer failure arrives as
    // `{message, remedy, provider}` instead, because "no credits" is a state
    // with a button and flattening it to a sentence throws the button away.
    const detail = payload?.detail;
    const structured = detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : null;
    const error = new Error(
      (structured?.message)
      || flattenApiDetail(detail ?? payload?.error)
      || `Request failed (${response.status})`,
    );
    if (structured) {
      error.remedy = String(structured.remedy || '');
      error.provider = String(structured.provider || '');
    }
    throw error;
  }
  return payload;
}

/** Which local models exist, how much room there is, and what is loaded. */
export function producerRuntime({ signal = null } = {}) {
  return api('/api/prompt-helper/runtime', null, { signal });
}

/** Every model the producer can think with — local and HivemindOS in one
 *  answer, with each source's state and the id to start on. */
export function textModelCatalog({ signal = null } = {}) {
  return api('/api/text-models', null, { signal });
}

/**
 * Store one provider key in the machine's shared credential store.
 *
 * The same store the HivemindOS app reads (`~/.hivemindos/.env`), so a key
 * added from the producer picker is a key added for every Hive app here. The
 * value crosses to the server once and is never read back — the studio only
 * ever asks whether the NAME is set.
 */
export function saveProviderKey(name, value, { signal = null } = {}) {
  return api('/api/passbook', { values: { [name]: value } }, { signal });
}

/**
 * Point this studio at the owner's HivemindOS account.
 *
 * The key spends the balance they already have — the same one the HivemindOS app
 * and every other HivemindOS app spend. It is verified before it is stored, and
 * it is stored on the machine rather than in this browser: it is a bearer
 * credential for money, and the studio's rule for those is the same one that
 * moved the MUAPI key off localStorage.
 */
export function connectHivemindosAccount(token, { signal = null } = {}) {
  return api('/api/hivemindos/models/connect', { token }, { signal });
}

/**
 * Ask the HivemindOS app on this machine to hand its balance over.
 *
 * Returns the `hivemindos://` link to open and the nonce to poll. The scheme is
 * resolved by this computer, so this only ever reaches the app HERE — which is
 * the point: the owner approves the handover in the app, behind its own unlock,
 * instead of this studio reading its files.
 */
export function requestHivemindosLink({ signal = null } = {}) {
  return api('/api/hivemindos/models/link-request', {}, { signal });
}

/** `linked` once the app has answered, `pending` while the owner is over there,
 *  `expired` when the request timed out or was never open. */
export function hivemindosLinkState(nonce, { signal = null } = {}) {
  return api(`/api/hivemindos/models/link-state?nonce=${encodeURIComponent(nonce)}`, null, { signal });
}

/** Fold a second HivemindOS balance into the connected one, so credits bought
 *  before connecting are not stranded in an account nothing can see. */
export function mergeHivemindosCredits(tokens, { signal = null } = {}) {
  return api('/api/hivemindos/models/merge-credits', { tokens }, { signal });
}

/**
 * Start a card checkout for HivemindOS credits.
 *
 * Only for a studio with no HivemindOS app on the machine — with one running,
 * credits are added there so the two keep sharing a balance, and the server
 * refuses this. Nothing is charged by the call: it returns the checkout page for
 * the owner to complete themselves.
 */
export function startCreditTopUp({ amountUsd = 5, signal = null } = {}) {
  return api('/api/hivemindos/models/top-up', { amountUsd }, { signal });
}

/** How long to keep waiting for llama-server to finish coming up. A 26B model
 *  off a cold page cache genuinely takes minutes; anything past this is a
 *  failure worth surfacing rather than a slow start. */
const LOAD_DEADLINE_MS = 4 * 60 * 1000;
const LOAD_POLL_MS = 2500;

/**
 * Make sure `modelId` is serving, loading it if it is not.
 *
 * A load another tab (or an earlier press) already started answers `loading`
 * rather than `loaded`, so this polls instead of firing a request the server
 * would refuse. Returns the last runtime snapshot so the caller can show what
 * is in RAM without asking again.
 */
export async function ensureProducerModel(modelId, {
  unloadOthers = true, onStatus = null, signal = null, snapshot = null, source = '',
} = {}) {
  if (!modelId) throw new Error('Pick a model to think with first.');
  // A cloud model is already serving. Polling the local runtime for it would
  // report "unknown model" for a model that exists somewhere else.
  if (source && !needsLoad({ source })) return snapshot;
  let runtime = snapshot || await producerRuntime({ signal });
  const row = (runtime?.models || []).find((model) => model.id === modelId);
  if (row?.fit === 'loaded') return runtime;
  onStatus?.(`Loading ${row?.name || modelId}…`);
  let state = await api('/api/prompt-helper/load', { modelId, unloadOthers }, { signal });
  const deadline = Date.now() + LOAD_DEADLINE_MS;
  while (state?.status === 'loading' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LOAD_POLL_MS));
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
    runtime = await producerRuntime({ signal });
    const current = (runtime?.models || []).find((model) => model.id === modelId);
    state = { ...runtime, status: current?.fit === 'loading' ? 'loading' : 'loaded' };
  }
  if (state?.status === 'loading') {
    throw new Error(`${row?.name || modelId} is still loading. Give it a moment, or pick a smaller model.`);
  }
  return runtime;
}

/**
 * Ask one producer task.
 *
 * `context` is everything already locked — the contract, the characters, the
 * location, the board. It is sent every time rather than relied on as
 * conversation memory: each ask is a fresh conversation, which is what stops a
 * long session from drifting away from the sheet the sheets were drawn to.
 */
export async function askProducer({
  modelId, task, brief = '', context = null, onStatus = null, signal = null,
  unloadOthers = true, snapshot = null, source = '',
}) {
  await ensureProducerModel(modelId, { unloadOthers, onStatus, signal, snapshot, source });
  onStatus?.('Thinking…');
  const payload = await api('/api/story/producer', {
    modelId, task, brief, context: context || undefined,
  }, { signal });
  // `notes` carries the honest middle ground — an answer that came back short
  // because the model ran out of room, rather than one that failed. The caller
  // shows them; swallowing them here would present six concepts as eight.
  return { result: payload?.result ?? null, notes: Array.isArray(payload?.notes) ? payload.notes : [] };
}
