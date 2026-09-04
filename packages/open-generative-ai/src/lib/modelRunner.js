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
import { t } from './i18n.js';
import { isLocalAIAvailable, localAI, localCatalogStatusNow } from './localInferenceClient.js';
import { adoptCloudOutput } from './cloudAdopt.js';
import { canvasPixels } from '../studios/story/sheetLayout.js';
import { generateHivemindVideo, isHivemindStudioEnabled, markMuapiKeyOnServer } from './hivemindStudio.js';
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
 *
 * ── placeLabel ────────────────────────────────────────────────────────────
 *
 * `label` names the TRANSPORT, which is the right answer to "how does this
 * run" and the wrong answer to "where does this run and who pays". Every
 * picker was asking the second question and printing the first, so a consumer
 * met "API", "Hivemind local", "OpenAI · GPT Image OAuth" and "cloud" for
 * things that are, to them, three places: this Mac, HivemindOS credits, and an
 * account they already pay for.
 *
 * So each provider also declares a PLACE (one of three, mirroring the text
 * producer's sections, which have been grouped by bill since they shipped) and
 * the sentence a person reads for it. Nothing else may compose a place label:
 * a registry id, a transport name or a family slug reaching a label is the bug
 * this field exists to close.
 */
export const PLACE_THIS_MAC = 'this-mac';
export const PLACE_HIVEMINDOS = 'hivemindos';
export const PLACE_ACCOUNTS = 'accounts';

export const PROVIDER_TRANSPORTS = Object.freeze({
  'openai-gpt-image': {
    transport: 'studio', label: 'OpenAI GPT Image (API key)', place: PLACE_ACCOUNTS, placeLabel: 'Your OpenAI account',
    credential: 'API key',
  },
  'openai-gpt-image-oauth': {
    transport: 'studio', label: 'OpenAI GPT Image (ChatGPT sign-in)', place: PLACE_ACCOUNTS, placeLabel: 'Your OpenAI account',
    credential: 'ChatGPT sign-in',
  },
  'xai-imagine-api': {
    transport: 'studio', label: 'xAI Imagine (API key)', place: PLACE_ACCOUNTS, placeLabel: 'Your xAI account',
    credential: 'API key',
  },
  'xai-imagine-oauth': {
    transport: 'studio', label: 'xAI Imagine (sign-in)', place: PLACE_ACCOUNTS, placeLabel: 'Your xAI account',
    credential: 'sign-in',
  },
  'higgsfield-consumer': {
    transport: 'studio', label: 'Higgsfield', place: PLACE_ACCOUNTS, placeLabel: 'Your Higgsfield account',
    credential: 'sign-in',
  },
  'higgsfield-cloud': {
    transport: 'studio', label: 'Higgsfield Cloud', place: PLACE_ACCOUNTS, placeLabel: 'Your Higgsfield account',
    credential: 'API key',
  },
  'hivemindos-hosted-media': {
    transport: 'studio', label: 'HivemindOS hosted', place: PLACE_HIVEMINDOS, placeLabel: 'HivemindOS credits',
  },
  'media-studio-mcp': {
    transport: 'studio', label: 'this machine’s studio', place: PLACE_THIS_MAC, placeLabel: 'This Mac',
  },
  comfyui: {
    transport: 'studio', label: 'this machine’s studio', place: PLACE_THIS_MAC, placeLabel: 'This Mac',
  },
  muapi: { transport: 'muapi', label: 'MUAPI', place: PLACE_ACCOUNTS, placeLabel: 'MUAPI account' },
  // Browser-side catalogs the server has never heard of.
  sdcpp: { transport: 'local', label: 'this machine', place: PLACE_THIS_MAC, placeLabel: 'This Mac' },
  wan2gp: {
    transport: 'local', label: 'a Wan2GP server you run', place: PLACE_THIS_MAC, placeLabel: 'This Mac',
  },
});

/**
 * Which of the three places a row runs in, and the sentence for it.
 *
 * A `source: 'local'` row is on this Mac whatever its provider calls itself —
 * that catalog IS the local inventory, the same rule transportFor applies.
 * An unknown provider is NOT guessed into a place: it gets the empty place, so
 * a picker leaves it out of the grouped list rather than filing it under a bill
 * nobody has decided it belongs to.
 */
export function placeFor(row) {
  if (row?.source === 'local') return PLACE_THIS_MAC;
  return PROVIDER_TRANSPORTS[String(row?.provider || '')]?.place || '';
}

/** The label a person reads for that place. '' when the place is unknown — a
 *  caller that prints this must print nothing rather than the provider id. */
export function placeLabelFor(row) {
  if (row?.source === 'local') return t('place.thisMac');
  return PROVIDER_TRANSPORTS[String(row?.provider || '')]?.placeLabel || '';
}

/**
 * Which credential this provider runs on, when the same account can be reached
 * two ways.
 *
 * OpenAI, xAI and Higgsfield each appear twice in the catalog — once on an API
 * key and once on a sign-in — and both rows carry the same model under the same
 * place label. Two identical lines that bill differently is a choice nobody can
 * make, so the row names the credential. '' where a provider has no sibling:
 * "MUAPI account (API key)" would be noise.
 */
export function credentialLabelFor(row) {
  if (row?.source === 'local') return '';
  return PROVIDER_TRANSPORTS[String(row?.provider || '')]?.credential || '';
}

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

/** A model from the served cloud catalog (src/lib/cloudCatalog.js). */
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
    const label = PROVIDER_TRANSPORTS[provider]?.label || 'this machine';
    if (!isLocalAIAvailable()) {
      return {
        transport: 'local',
        label,
        runnable: false,
        reason: 'This model runs on this machine, and the local bridge is not available in this window.',
      };
    }
    // A bridge in the window is not the same as an engine that can run
    // something. The catalog fetch already asked; this reads its verdict so
    // Image, Story and Sprite refuse an unrunnable local row identically
    // rather than each discovering it at Generate time.
    const status = localCatalogStatusNow();
    if (status === 'unreachable') {
      return {
        transport: 'local',
        label,
        runnable: false,
        reason: 'The local engine is starting — this model runs on this machine, which is not answering yet.',
      };
    }
    if (status === 'empty') {
      return {
        transport: 'local',
        label,
        runnable: false,
        reason: 'No local model is installed yet — open Models to install one.',
      };
    }
    // 'discovering' stays runnable: the answer is milliseconds away and a
    // picker that greys itself out on every mount is its own bug.
    return { transport: 'local', label, runnable: true, reason: '' };
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
    reason: `${route.label} clips are not wired into this studio yet — pick a model that runs on this machine.`,
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

/** Told by the readiness fetch, which asks /api/muapi/status once — seeded at
 *  app boot (lib/muapiKey.js) so every studio has the answer, not just the one
 *  that happened to ask. */
export function setMuapiKeyOnServer(present) {
  muapiKeyOnServer = present === null ? null : Boolean(present);
  // The legacy scrub lives with the other localStorage scrubs; it only has to
  // know that the server holds the key before it may drop the browser copy.
  markMuapiKeyOnServer(muapiKeyOnServer === true);
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

/** True when the row cannot run for lack of a credential THIS browser holds.
 *  The one place the browser copy is read for a gate: with the key on this
 *  machine it is never consulted, which is what stops a configured machine
 *  from asking for a key it already has. */
export function needsBrowserKey(row) {
  if (browserCredentialFor(row) !== 'muapi') return false;
  try { return !localStorage.getItem('muapi_key'); } catch { return false; }
}

/** The same gate for a MUAPI call that has no model row — an upload, a resumed
 *  poll. True when neither this machine nor this browser holds the key. */
export function muapiKeyMissing() {
  return needsBrowserKey(muapiRow(''));
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
    // A MUAPI result is a link on someone else's CDN that expires. Keep a
    // sealed copy here, so it is in the Library after a relaunch like every
    // local render — `savedUrl` is that copy, and `url` stays the provider's
    // because that is what a later call hands BACK to the provider.
    const savedUrl = await adoptCloudOutput(result.url, { kind: 'image', model: row.id, provider: 'muapi' });
    return { ...result, provider: 'muapi', model: row.id, savedUrl, saved: Boolean(savedUrl) };
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
    // Same shape as runImage: a clip that starts from a frame, a source video
    // or a voice track is a different MUAPI method, and the caller names it
    // rather than calling it — so the readiness refusal above covers all of them.
    const method = payload.method || 'generateVideo';
    // A name the client does not have would otherwise surface as
    // "muapi[method] is not a function" in a toast.
    if (typeof muapi[method] !== 'function') {
      throw new Error(`The studio has no “${method}” call for this clip.`);
    }
    const { method: _drop, ...params } = payload;
    const result = await muapi[method]({ signal, ...params, model: row.id });
    if (!result?.url) throw new Error('No video URL returned.');
    // Same as a still: a clip that only exists on the provider's CDN is one
    // relaunch from gone. Lip sync is the expensive case — three minutes of
    // waiting that used to survive exactly as long as the tab did.
    const savedUrl = await adoptCloudOutput(result.url, { kind: 'video', model: row.id, provider: 'muapi' });
    return { ...result, provider: 'muapi', model: row.id, savedUrl, saved: Boolean(savedUrl) };
  }
  // The lane names its workflow `workflow_id`; `model` there is the studio's
  // `hivemind-media:<id>` form and a raw id in it decodes to nothing, which
  // lands the job on the DEFAULT lane while the picker shows the one you chose.
  // Only a lane provider reaches here: resolveRun refused the rest above, so a
  // Higgsfield model id can no longer arrive as an unknown workflow.
  const result = await generateHivemindVideo({ signal, ...payload, workflow_id: row.id });
  return { ...result, provider: row.provider || 'media-studio-mcp', model: row.id };
}
