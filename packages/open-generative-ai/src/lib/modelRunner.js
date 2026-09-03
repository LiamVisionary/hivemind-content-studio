// The ONE way a studio runs a selected model.
//
// The media catalog lists eleven image providers across five different
// credentials: an OpenAI API key, an OpenAI OAuth grant, an xAI key, an xAI
// OAuth grant, Higgsfield, MUAPI, the HivemindOS dashboard token, and the local
// Media Studio. Three of them offer a model called `gpt-image-2`. Any caller
// that dispatches on less than the PROVIDER gets one of them right and sends
// the rest somewhere else.
//
// That is not hypothetical. Until 2026-08-24 the Sprite and Story studios both
// ran `model.source === 'local' ? localAI : muapi`, so choosing GPT Image 2
// under the OAuth provider opened the MUAPI API-key dialog — and with a key
// present would have billed MUAPI's endpoint of the same name, on a different
// account, without erroring.
//
// ── Why this is a dispatcher and not an abstraction ────────────────────────
//
// The five transports do not take the same arguments and should not be forced
// to. Local generation carries outpaint and inpaint masks, a studio lane and a
// runtime mode; MUAPI carries a request id callback and a per-model quality
// field; the Media Studio lane carries reference rows, LoRAs and a job id.
// Flattening those into one signature would lose the half that does not fit,
// and losing a mask silently is a worse bug than the one this replaced.
//
// So: this module owns exactly one decision — WHICH transport runs — and the
// caller's payload passes through untouched. `extra` is keyed by transport,
// which doubles as the caller's declaration of what it can serve: a row that
// resolves to a transport the caller built nothing for is refused, loudly,
// instead of being sent a payload shaped for somewhere else.
import { isLocalAIAvailable, localAI } from './localInferenceClient.js';
import { canvasPixels } from '../studios/story/sheetLayout.js';
import { generateHivemindVideo, isHivemindStudioEnabled } from './hivemindStudio.js';
import { flattenApiDetail } from './muapiErrors.js';
import { muapi } from './muapi.js';

/**
 * How each catalog provider is reached, and what it needs before it can run.
 *
 * `local`  the sd.cpp / Wan2GP bridge in this app
 * `muapi`  the MUAPI client in this browser, with the owner's key
 * `studio` this machine's studio server, which holds every other credential —
 *          `/api/media-studio/image` for stills, the Media Studio lane for clips
 *
 * `muapi` is still the browser's own client — it owns endpoint resolution, the
 * poll cadence and the request-id contract a reload resumes from — but since
 * 2026-08-24 its KEY lives on this machine like every other provider's, and the
 * client proxies through /api/muapi. Transport and credential are separate
 * questions; only the second one moved.
 */
export const PROVIDER_TRANSPORTS = Object.freeze({
  'openai-gpt-image': { transport: 'studio', label: 'OpenAI GPT Image (API key)' },
  'openai-gpt-image-oauth': { transport: 'studio', label: 'OpenAI GPT Image (ChatGPT sign-in)' },
  'xai-imagine-api': { transport: 'studio', label: 'xAI Imagine (API key)' },
  'xai-imagine-oauth': { transport: 'studio', label: 'xAI Imagine (sign-in)' },
  'higgsfield-consumer': { transport: 'studio', label: 'Higgsfield' },
  'higgsfield-cloud': { transport: 'studio', label: 'Higgsfield Cloud' },
  'hivemindos-hosted-media': { transport: 'studio', label: 'HivemindOS hosted' },
  'media-studio-mcp': { transport: 'studio', label: 'this machine’s Media Studio' },
  comfyui: { transport: 'studio', label: 'this machine’s Media Studio' },
  muapi: { transport: 'muapi', label: 'MUAPI' },
  // Browser-side catalogs the server has never heard of.
  sdcpp: { transport: 'local', label: 'this machine' },
  wan2gp: { transport: 'local', label: 'a Wan2GP server you run' },
});

/** Providers that render something other than a generated image — a text card,
 *  a stick figure. Real routes, but never what a studio picker means by a model. */
const NON_MODEL_PROVIDERS = new Set(['static-text-renderer', 'stickman-renderer']);

/* ---------------- rows ----------------
 * A row is the routing identity of a selection: `{ id, provider, source }`.
 * Built here so "which provider is this model from" is answered in one place
 * rather than assembled ad hoc at each call site.
 */

/** A model from the browser's own local inventory (sd.cpp checkpoints, Wan2GP). */
export const localRow = (id, provider = 'sdcpp') => ({ id, provider, source: 'local' });

/** A model from src/lib/modelsData.js — which IS the MUAPI catalog. */
export const muapiRow = (id) => ({ id, provider: 'muapi', source: 'cloud' });

/** A workflow served by this machine's Media Studio (local Comfy, a fleet
 *  machine, or an attached rental — the lane decides, not the caller). */
export const studioRow = (id) => ({ id, provider: 'media-studio-mcp', source: 'cloud' });

/**
 * How this row would run, without running it.
 *
 * Returns `{ transport, label, runnable, reason }`; `reason` is what the owner
 * is shown, so it names the account rather than the failure.
 */
export function transportFor(row) {
  const provider = String(row?.provider || '').trim();
  // A row from the browser's own catalog is local whatever it calls its
  // provider — that catalog is the local inventory by definition.
  if (row?.source === 'local') {
    return {
      transport: 'local',
      label: PROVIDER_TRANSPORTS[provider]?.label || 'this machine',
      runnable: isLocalAIAvailable(),
      reason: isLocalAIAvailable() ? '' : 'This model runs on this machine, and the local bridge is not available in this window.',
    };
  }
  if (NON_MODEL_PROVIDERS.has(provider)) {
    return { transport: 'none', label: provider, runnable: false, reason: 'This is a renderer, not an image model.' };
  }
  const known = PROVIDER_TRANSPORTS[provider];
  if (!known) {
    // Loud rather than silent: a provider added to the catalog and not here is
    // a routing decision nobody has made yet, and defaulting it would make that
    // decision by accident.
    return {
      transport: 'none',
      label: provider || 'unknown provider',
      runnable: false,
      reason: `The studio has no route for “${provider || 'this provider'}” yet.`,
    };
  }
  if (known.transport === 'studio') {
    const ready = isHivemindStudioEnabled();
    return {
      ...known,
      runnable: ready,
      reason: ready ? '' : `${known.label} runs through this machine’s studio, which this window cannot reach.`,
    };
  }
  return { ...known, runnable: true, reason: '' };
}

/** The providers whose clips the Media Studio LANE serves: a `workflow_id`
 *  there is a workflow the lane's registry knows. Every other `studio`
 *  provider (Higgsfield, xAI, OpenAI, HivemindOS hosted) reaches the studio
 *  server through the still endpoint only, and posting its model id to the
 *  lane as a workflow is the mis-route this set exists to refuse. */
const STUDIO_LANE_PROVIDERS = new Set(['media-studio-mcp', 'comfyui']);

/**
 * How this row would run as a CLIP, without running it.
 *
 * Same shape as `transportFor`. The difference is the `studio` transport:
 * for a still it is `/api/media-studio/image`, which dispatches on provider;
 * for a clip it is the Media Studio lane, which only knows its own workflows.
 * A row whose provider the lane does not serve is unroutable here, and says
 * which rows are — the picker shows that rather than a failed local job.
 */
export function clipRouteFor(row) {
  const route = transportFor(row);
  if (route.transport !== 'studio') return route;
  const provider = String(row?.provider || '').trim();
  if (STUDIO_LANE_PROVIDERS.has(provider)) return route;
  return {
    transport: 'none',
    label: route.label,
    runnable: false,
    reason: `${route.label} clips are not wired into this studio yet — pick a model on this machine’s Media Studio.`,
  };
}

// Where MUAPI's key lives on THIS machine. `null` until asked.
//
// It used to live only in the browser, which is why a user whose HivemindOS
// already held MUAPI_API_KEY was still prompted for one. The key now lives in
// the shared Hive environment where every other provider's does, and the
// browser client proxies through this machine — so "does the browser need a
// key?" has an answer that is no longer always yes.
let muapiKeyOnServer = null;

/** Told by the readiness fetch, which asks /api/muapi/status once. */
export function setMuapiKeyOnServer(present) {
  muapiKeyOnServer = present === null ? null : Boolean(present);
}

export function muapiKeyIsOnServer() {
  return muapiKeyOnServer === true;
}

/** Which credential a row needs before it can run, or '' when it needs none
 *  that this browser holds. Everything else is checked where it actually is. */
export function browserCredentialFor(row) {
  if (transportFor(row).transport !== 'muapi') return '';
  return muapiKeyIsOnServer() ? '' : 'muapi';
}

/** True when the row cannot run for lack of a credential THIS browser holds. */
export function needsBrowserKey(row) {
  if (browserCredentialFor(row) !== 'muapi') return false;
  try { return !localStorage.getItem('muapi_key'); } catch { return false; }
}

/**
 * Resolve the transport and the payload it will actually receive.
 *
 * Exported for the tests and for callers that want to check before spending:
 * every refusal here is one the owner can act on, and none of them costs a
 * request.
 */
export function resolveRun({ row, kind = 'image', shared = {}, extra = null }) {
  if (!row) throw new Error('Pick a model first.');
  // A clip and a still reach the studio server by different doors, and only
  // one of them dispatches on provider — see clipRouteFor.
  const route = kind === 'clip' ? clipRouteFor(row) : transportFor(row);
  if (!route.runnable) throw new Error(route.reason || `${route.label} cannot run here.`);
  if (extra && !Object.prototype.hasOwnProperty.call(extra, route.transport)) {
    // The caller built a payload for somewhere else. Sending the shared half
    // anyway would drop whatever made this generation what it is — a mask, a
    // reference row, a lane — and look like a plain result rather than a
    // mis-route.
    throw new Error(
      `${route.label} cannot run this ${kind} here: the studio built no ${route.transport} request for it.`,
    );
  }
  const payload = { ...shared, ...(extra?.[route.transport] || {}) };
  return { route, payload };
}

async function studioImage(payload, { row, signal }) {
  const response = await fetch('/api/media-studio/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    signal,
    body: JSON.stringify({
      provider: row.provider,
      model: payload.model ?? row.id,
      prompt: payload.prompt,
      aspect_ratio: payload.aspect_ratio || '1:1',
      quality: payload.quality || '',
      seed: Number.isFinite(payload.seed) && payload.seed >= 0 ? payload.seed : null,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The server sends `{message, remedy, provider}` so a failure can become a
    // BUTTON. Flattening it to a sentence here would throw the fix away.
    const detail = body?.detail;
    const error = new Error(
      (detail && typeof detail === 'object' && detail.message)
        ? detail.message
        : (flattenApiDetail(detail ?? body?.error) || `Request failed (${response.status})`),
    );
    if (detail && typeof detail === 'object') {
      error.remedy = String(detail.remedy || '');
      error.oauthProvider = String(detail.provider || '');
    }
    throw error;
  }
  if (!body?.url) throw new Error('The provider returned no image.');
  return { url: body.url, provider: body.provider, model: body.model };
}

/**
 * Render one still with the model the picker actually selected.
 *
 * `shared` is what every transport understands (model, prompt, aspect_ratio,
 * seed). `extra` is keyed by transport for anything only one of them takes —
 * and doubles as the declaration of which transports this call supports.
 */
export async function runImage({ row, shared = {}, extra = null, signal = null }) {
  const { route, payload } = resolveRun({ row, kind: 'image', shared, extra });
  if (!String(payload.prompt || '').trim() && !payload.image_base64 && !payload.image_url) {
    throw new Error('There is nothing to draw yet.');
  }
  if (route.transport === 'local') {
    // The ratio AND the pixels, for this transport only. The local bridge hands
    // the job to a workflow whose latent node takes width/height, so a bridge
    // build that does not translate `aspect_ratio` silently falls back to
    // whatever shape the workflow was saved with — landscape, usually. On a
    // grid sheet that squashes every panel by the same factor, and from the
    // browser it looks identical to a provider that obeyed. MUAPI and the
    // studio route are left alone: they read the ratio, and unknown fields in
    // a MUAPI payload are a 400.
    const pixels = canvasPixels(payload.aspect_ratio);
    // `model` LAST: the row is the routing identity, and a payload that
    // carries its own model must not be able to redirect the run.
    const result = await localAI.generate({ ...pixels, ...payload, model: row.id });
    if (!result?.url) throw new Error('Nothing came back.');
    return { ...result, provider: row.provider || 'local', model: row.id };
  }
  if (route.transport === 'muapi') {
    const method = payload.method || 'generateImage';
    const { method: _drop, ...params } = payload;
    const result = await muapi[method]({ signal, ...params, model: row.id });
    if (!result?.url) throw new Error('Nothing came back.');
    return { ...result, provider: 'muapi', model: row.id };
  }
  return studioImage(payload, { row, signal });
}

/**
 * Render one clip with the model the picker actually selected.
 *
 * The `studio` transport here is the Media Studio LANE rather than the image
 * route: a clip is a job with progress, a cancellable id and a lane to run on,
 * and generateHivemindVideo already owns all of that.
 */
export async function runVideo({ row, shared = {}, extra = null, signal = null }) {
  const { route, payload } = resolveRun({ row, kind: 'clip', shared, extra });
  if (route.transport === 'local') {
    const result = await localAI.generate({ ...payload, model: row.id });
    if (!result?.url) throw new Error('No video URL returned.');
    return { ...result, provider: row.provider || 'local', model: row.id };
  }
  if (route.transport === 'muapi') {
    const result = await muapi.generateVideo({ signal, ...payload, model: row.id });
    if (!result?.url) throw new Error('No video URL returned.');
    return { ...result, provider: 'muapi', model: row.id };
  }
  // The lane names its workflow `workflow_id`; `model` there is the studio's
  // `hivemind-media:<id>` form and a raw id in it decodes to nothing, which
  // lands the job on the DEFAULT lane while the picker shows the one you chose.
  // Only a lane provider reaches here: resolveRun refused the rest above, so a
  // Higgsfield model id can no longer arrive as an unknown workflow.
  const result = await generateHivemindVideo({ signal, ...payload, workflow_id: row.id });
  return { ...result, provider: row.provider || 'media-studio-mcp', model: row.id };
}
