// Model resolution and setup-state transitions for the Video Studio.
//
// The state-transition rules are pure functions over an immutable `setup`
// object, so React renders labels from state instead of the old vanilla
// studio's getElementById sync layer. The pure rules that need no JSX live in
// src/lib (videoPreferences, videoTasks, modelTiers, genProgress) and are
// re-exported here, so the node:test suite can exercise them and studio code
// still has one import site.
import { servedByAnyMachine } from '../../lib/rentedMachines.js';
import {
  t2vModels,
  i2vModels,
  v2vModels,
  getAspectRatiosForVideoModel,
  getDurationsForModel,
  getResolutionsForVideoModel,
  getAspectRatiosForI2VModel,
  getDurationsForI2VModel,
  getResolutionsForI2VModel,
  getModesForModel,
} from '../../lib/cloudCatalog.js';
import {
  getHivemindVideoModelById,
  getSavedHivemindVideoSelection,
  isHivemindStudioEnabled,
  isHivemindVideoModelId,
} from '../../lib/hivemindStudio.js';
import { isMinimaxFamilyModel, videoRequestPlan } from '../../lib/videoTasks.js';
import {
  getLocalModelById,
  isWan2gpModelId,
  localT2VModels,
  localI2VModels,
} from '../../lib/localModels.js';
import { isLocalAIAvailable } from '../../lib/localInferenceClient.js';
import { resolveMediaSrc } from '../../lib/e2eMedia.js';
import { personaIdentity } from '../../lib/personaId.js';
import { routingLeaderFor } from '../../lib/rentedMachines.js';
import { isSoundOnlyReference, referenceVideoCanvas } from '../../lib/h3References.js';
import { H3_RESTYLE_PRESETS, restylePhrase } from '../../lib/h3RestylePresets.js';
import { t, zh } from '../../lib/i18n.js';

// One home for the language predicate (lib/i18n.js). Re-exported here because a
// dozen video panels import `zh` from this module; the binding is the same one.
export { zh };

// Persisted settings, advanced-input reading, and the pure geometry/format
// helpers now live in lib/videoPreferences.js so the node:test suite can reach
// them; re-exported here so studio code keeps one import site.
//
// The two this module CALLS are imported as well: `export … from` forwards a
// name to importers without binding it locally, so re-exporting alone left the
// transitions below calling an undefined function — a break neither the node
// suite nor the build catches, because neither evaluates a transition.
import { getDefaultAdvancedVideoValues, getRestoredAdvancedVideoValues } from '../../lib/videoPreferences.js';

export {
  VIDEO_PREFERENCES_KEY,
  getAdvancedVideoInputs,
  getDefaultAdvancedVideoValues,
  getAdvancedVideoPayload,
  getRestoredAdvancedVideoValues,
  normalizeVideoPreferences,
  normalizeVideoIngredientSelections,
  videoIngredientDescriptions,
  withVideoIngredientDescriptions,
  normalizeSelectedVideoIngredientSheet,
  normalizeVideoGenerationProgress,
  classifyVideoGenerationStage,
  formatVideoGenerationElapsed,
  clampVideoDropdownMaxHeight,
  clampVideoDropdownViewportLeft,
  closestVideoAspectRatio,
} from '../../lib/videoPreferences.js';

/* ------------------------------------------------------------------ */
/* Catalog adapters (verbatim)                                         */
/* ------------------------------------------------------------------ */

export const adaptLocalToVideoEntry = (m) => ({
  id: m.id,
  name: m.name,
  provider: 'wan2gp',
  inputs: {
    prompt: { type: 'string', name: 'prompt', title: 'Prompt' },
    aspect_ratio: { type: 'string', name: 'aspect_ratio', enum: m.aspectRatios || ['16:9', '1:1', '9:16'], default: (m.aspectRatios || ['16:9'])[0] },
  },
});

// A registry model IS the catalog entry — everything carries through by spread,
// and only the `inputs` schema shim is synthesized (cloud catalog entries, which
// share every downstream code path, describe themselves that way).
//
// This used to enumerate the fields it copied, and that enumeration was a second
// place capabilities had to be declared: the panel resolves the CATALOG entry, so
// any field the adapter forgot read as undefined and its control silently
// disappeared for local workflows only. Spreading means adding a capability to
// the registry mapper is the whole job.
export const adaptHivemindToVideoEntry = (m) => ({
  ...m,
  provider: 'hivemind-media-studio',
  inputs: {
    prompt: { type: 'string', name: 'prompt', title: 'Prompt' },
    aspect_ratio: { type: 'string', name: 'aspect_ratio', enum: m.aspectRatios || ['1:1', '16:9', '9:16'], default: (m.aspectRatios || ['1:1'])[0] },
    duration: { type: 'number', name: 'duration', enum: m.durations || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], default: m.defaultDuration || 4 },
  },
});

/* ------------------------------------------------------------------ */
/* Pure helpers (verbatim from VideoStudio.js lines 77-267)            */
/* ------------------------------------------------------------------ */

export { activeTierFor, groupModelTiers, tierPairFor } from '../../lib/modelTiers.js';
export {
  activeVideoTask, headSwapReadiness, isLtxFamilyModel, isMinimaxFamilyModel, slotLabelsFor,
  sourceVideoSwitchCost, videoRequestPlan, videoTasksFor,
} from '../../lib/videoTasks.js';

// Smoothed, MONOTONIC progress for the generation bar — shared with the image
// studio; re-exported so existing videoLogic importers keep working.
export { computeSmoothProgress, normalizeSamplerSteps } from '../../lib/genProgress.js';

export function imageDimensions(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('Could not inspect the selected start frame.'));
    // The start frame may be an E2E-sealed generated output; decrypt in-page
    // first (legacy/upload sources pass through untouched).
    void resolveMediaSrc(source).then((resolved) => { image.src = resolved; });
  });
}

/* ------------------------------------------------------------------ */
/* Catalogs                                                            */
/* ------------------------------------------------------------------ */

export { t2vModels, i2vModels, v2vModels };

export const isLocalVideoModel = (id) => isHivemindVideoModelId(id) || isWan2gpModelId(id);

// Wan2GP entries are merged in only when the Electron bridge is present —
// same probe the old factory ran at build time (lines 290-291).
export function buildCatalogs(hivemindI2V) {
  const localT2V = isLocalAIAvailable() ? localT2VModels.map(adaptLocalToVideoEntry) : [];
  const localI2V = isLocalAIAvailable() ? localI2VModels.map(adaptLocalToVideoEntry) : [];
  return {
    hivemindI2V,
    allT2V: [...t2vModels, ...localT2V],
    // Ordering contract (old line 1243): [hivemindI2V, ...i2vModels, ...localI2V].
    allI2V: [...hivemindI2V, ...i2vModels, ...localI2V],
  };
}

// ---- Two lists, two jobs. Do not merge them, and do not swap them. ----

// EVERY model the studio knows, mode-blind. Ids are unique across the t2v/i2v/
// v2v catalogs (asserted in tests), so a flat search is unambiguous.
export const allVideoModels = (c) => [
  ...(c?.hivemindI2V || []),
  ...(c?.allI2V || []),
  ...(c?.allT2V || []),
  ...v2vModels,
];

// Resolve a model by id to answer a CAPABILITY question. Deliberately mode-blind:
// what a model can do is a property of the model, not of whether the studio
// currently happens to have a start frame attached.
//
// Resolving capabilities through the mode-scoped picker list instead is the
// single most expensive mistake in this file's history. Hivemind local workflows
// take the start frame as an OPTIONAL input — H3 is text-to-video by default —
// so a state with imageMode false (every reference run, and every restore of a
// generation that had no start frame) found nothing in the t2v list, and every
// capability read off the result silently went false. The Frames control
// vanished while the References menu, which resolved through the lib's own flat
// registry, kept rendering: same model, two answers, depending only on which
// lookup a given line of code happened to use.
export const resolveVideoModel = (id, c) => allVideoModels(c).find((m) => m.id === id) || null;
export const currentModel = (s, c) => resolveVideoModel(s.modelId, c);

// The model picker's "Generation" section — mode-scoped on purpose, because the
// menu should offer what makes sense for the current mode. Never use it to
// answer a question about what a model can do. The picker's "Video Tools"
// section is v2vModels, listed alongside this rather than instead of it.
export const generationModelsFor = (s, c) => (s.imageMode
  ? c.allI2V
  : [...(c.hivemindI2V || []), ...c.allT2V]);

// The ONE writer of the selected-model triple. `modelFamily` is a denormalized
// copy of the model's registry family that every family-scoped gate (task strip,
// frame slots, scene chaining, the H3 quality controls) reads back out of the
// setup — so a transition that changed the model but forgot to update it left
// those gates answering for the PREVIOUS model. Six of the ten transitions below
// used to do exactly that.
export const withSelectedModel = (s, model) => ({
  ...s,
  modelId: model.id,
  modelName: model.name,
  modelFamily: String(model.workflowFamily || ''),
});
export const isMotionControlV2V = (s, c) => s.v2vMode && !!currentModel(s, c)?.imageField;
// "This run extends an uploaded clip." Derived from the plan rather than
// re-tested here, so there is exactly one definition of what an extension is.
export const isHivemindVideoInputMode = (s) => isHivemindVideoModelId(s.modelId)
    && Boolean(s.videoUrl)
    && videoRequestPlan(s).videoMode === 'extend';

export const aspectRatiosFor = (s, id) => {
  const hive = getHivemindVideoModelById(id);
  if (hive) return hive.aspectRatios || ['1:1', '16:9', '9:16'];
  const local = getLocalModelById(id);
  if (local) return local.aspectRatios || ['16:9', '1:1', '9:16'];
  return s.imageMode ? getAspectRatiosForI2VModel(id) : getAspectRatiosForVideoModel(id);
};

export const durationsFor = (s, id) => {
  const hive = getHivemindVideoModelById(id);
  if (hive) return hive.durations || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  if (getLocalModelById(id)) return [];
  return s.imageMode ? getDurationsForI2VModel(id) : getDurationsForModel(id);
};

// The node trims a MOTION reference to min(its own length, the clip's length)
// — `frames[:frame_count]` in comfy_extras/nodes_minimax_h3.py — and the card's
// budget is spent on that effective length. Two consequences the picker has to
// model, and the second is the one the old rule missed:
//
//   reference >= clip   the reference is cut down to the clip, so the CLIP is
//                       what has to fit and the duration range is capped
//   reference <  clip   the reference keeps its own (shorter) length, costs
//                       only that, and the full duration range stays open
//
// The old rule capped the clip whenever ANY motion reference was attached, so
// dropping in a two-second clip still pinned the slider at ~6s. The ceiling is
// published per canvas by the catalog (motion_reference_max_seconds).
//
// Returns null when the limit does not apply — no motion reference, a reference
// already inside the ceiling, or a workflow with no measured budget. An
// UNMEASURED card is not a card that cannot do it, so those keep the full range
// rather than being guessed at.
// ── Pricing the run the studio is ACTUALLY about to send ─────────────────────
//
// The published per-canvas ceiling above assumes the worst of everything: a
// reference as long as the clip at the node's largest reference canvas, every
// picture slot filled, the full voice allowance, soundtrack on. That is right
// for refusing an impossible run and wrong for the slider once the user has
// done the things that make a run fit — staged the clip compact, trimmed it,
// left the soundtrack out, attached three pictures instead of nine. So when
// the catalog publishes the pricing inputs (motion_reference_pricing), the
// picker prices THIS setup with the guard's own arithmetic (packedSequenceRows
// in the MCP / _h3_packed_rows in media_studio.py) and only drops the durations
// that really do not fit. The guard at submit stays the authority; an
// un-measured clip length counts as the 15s maximum, and a clip whose canvas
// the browser has not seen is priced at the node's largest ("full") canvas —
// compact staging prices at its own, smaller box.
const H3_LATTICE = { modulus: 17, offset: 5 };
const latticeAtLeast = (grid, value) => {
  const modulus = Number(grid?.modulus) || H3_LATTICE.modulus;
  const offset = ((Number(grid?.offset) || H3_LATTICE.offset) % modulus + modulus) % modulus;
  const floor = offset > 0 ? offset : modulus;
  const raw = Math.max(floor, Math.round(value));
  return raw + ((offset - (raw % modulus)) % modulus + modulus) % modulus;
};
const latticeAtMost = (grid, value) => {
  const modulus = Number(grid?.modulus) || H3_LATTICE.modulus;
  const offset = ((Number(grid?.offset) || H3_LATTICE.offset) % modulus + modulus) % modulus;
  const raw = Math.floor(value);
  const floor = offset > 0 ? offset : modulus;
  if (raw < floor) return 0;
  return raw - ((raw - offset) % modulus + modulus) % modulus;
};
const h3VideoLatentFrames = (frames) => (frames <= 5 ? 2 : Math.floor((frames - 5) / 17) * 5 + 2);

// Packed rows of ONE run: the clip, each motion clip at its staged canvas for
// min(its length, the clip's) plus its soundtrack, the pictures, the voice
// clips. null when the model publishes no pricing or the canvas is unknown.
export const motionReferencePackedRows = (s, id, clipSeconds) => {
  const pricing = getHivemindVideoModelById(id)?.motionReferencePricing;
  if (!pricing || typeof pricing !== 'object') return null;
  const rate = Number(pricing.frame_rate) || 24;
  const tier = String(s.resolution || 'standard').trim().toLowerCase() || 'standard';
  const outRows = Number(pricing.output_rows_per_latent_frame?.[`${tier}|${String(s.ar || '').trim()}`]);
  if (!(outRows > 0)) return null;
  const audioRows = (seconds) => Math.round(Math.max(0, seconds) * (Number(pricing.audio_rows_per_second) || 80) / 2) * 2;
  const refRows = pricing.reference_rows_per_latent_frame || {};
  const refMax = Number(pricing.reference_video_max_seconds) || 15;
  const voiceMax = Number(pricing.reference_audio_max_seconds) || 15;
  const images = Array.isArray(s.referenceImageUrls) ? s.referenceImageUrls.filter(Boolean) : [];
  const rows = Array.isArray(s.referenceVideos) ? s.referenceVideos.filter((item) => item?.url) : [];
  // A sound-only row is a voice clip as far as the card is concerned: its
  // soundtrack's rows, no frames.
  const videos = rows.filter((item) => !isSoundOnlyReference(item));
  const soundOnly = rows.filter((item) => isSoundOnlyReference(item));
  const audios = Array.isArray(s.referenceAudios) ? s.referenceAudios.filter((item) => item?.url) : [];

  const frames = latticeAtLeast(pricing.frame_grid, Number(clipSeconds) * rate);
  let total = h3VideoLatentFrames(frames) * outRows + audioRows(frames / rate);
  for (const item of videos) {
    const own = Number(item?.durationSeconds) > 0 ? Number(item.durationSeconds) : refMax;
    const seconds = Math.min(own, refMax);
    const effective = latticeAtMost(pricing.frame_grid, Math.min(Math.round(seconds * rate), frames));
    const canvas = referenceVideoCanvas(item, { images });
    const perLatent = Number(refRows[canvas]) || Number(refRows.full) || 0;
    total += h3VideoLatentFrames(effective) * perLatent;
    if (item?.useAudio) total += audioRows(seconds);
  }
  total += images.length * outRows;
  const voiceSeconds = [...audios, ...soundOnly]
    .reduce((sum, item) => sum + (Number(item?.durationSeconds) > 0 ? Number(item.durationSeconds) : voiceMax), 0);
  total += audioRows(Math.min(voiceSeconds, voiceMax));
  return total;
};

// ── The card a run will land on ──────────────────────────────────────────────
// The packed-row budget is a property of the CARD, not the workflow: the base
// number was measured on a 32 GB 5090, and the catalog publishes the same
// budget per card size (`max_packed_rows_by_vram_gb`). Which card that is, the
// studio already knows: this tab's "Run on" pin when Rented is on (the gateway
// tries `run_on` first), otherwise the routing leader among the attached
// rentals — the same first-match rule the gateway applies. No machine known,
// or a card the table does not list, keeps the measured base.
const MOTION_REFERENCE_VRAM_KEY_TOLERANCE_GB = 1.5; // a "32 GB" card reports ~31.4 GiB

export const servingMachineFor = (s, id, machines) => {
  const list = Array.isArray(machines) ? machines.filter(Boolean) : [];
  if (!list.length) return null;
  if (s?.rentedOnly && s?.rentedMachineId) {
    const pinned = list.find((machine) => String(machine?.rental_id) === String(s.rentedMachineId) && machine?.attached);
    if (pinned) return pinned;
  }
  const model = getHivemindVideoModelById(id);
  return routingLeaderFor(list, model ? { id: model.id, name: model.name, workflowId: model.workflowId } : { id }) || null;
};

export const motionReferenceBudgetRows = (pricing, vramGb) => {
  const base = Number(pricing?.max_packed_rows);
  if (!(base > 0)) return null;
  const table = pricing?.max_packed_rows_by_vram_gb;
  const size = Number(vramGb);
  if (!table || typeof table !== 'object' || !(size > 0)) return { rows: base, vramGb: null };
  const fits = Object.entries(table)
    .map(([key, rows]) => ({ vramGb: Number(key), rows: Number(rows) }))
    .filter((entry) => entry.vramGb > 0 && entry.rows > 0 && entry.vramGb <= size + MOTION_REFERENCE_VRAM_KEY_TOLERANCE_GB)
    .sort((a, b) => a.vramGb - b.vramGb);
  const best = fits.length ? fits[fits.length - 1] : null;
  return best ? { rows: best.rows, vramGb: best.vramGb } : { rows: base, vramGb: null };
};

export const motionReferenceLimitFor = (s, id, machines) => {
  // ANY attached reference caps the clip, not just a motion one. Pictures and
  // sound references ride in the same packed sequence, and at 15s the output
  // alone is already 90,658 rows of an 85,000 budget — so the picker offered a
  // length the card could not hold whenever the motion clip's picture was
  // switched off (measured 2026-08-22: 15s + 7 pictures + that clip's
  // soundtrack = ~97,600 rows, OOM at the MLP of block 0 on a 5090).
  // `videos` stays MOTION-only below: a sound-only row is a voice clip and
  // never trims to the clip's length.
  const rows = Array.isArray(s.referenceVideos) ? s.referenceVideos.filter((item) => item?.url) : [];
  const videos = rows.filter((item) => !isSoundOnlyReference(item));
  const pictureCount = Array.isArray(s.referenceImageUrls) ? s.referenceImageUrls.filter(Boolean).length : 0;
  const voiceCount = (Array.isArray(s.referenceAudios) ? s.referenceAudios.filter((item) => item?.url).length : 0)
    + rows.filter((item) => isSoundOnlyReference(item)).length;
  if (!rows.length && !pictureCount && !voiceCount) return null;
  const model = getHivemindVideoModelById(id);
  const pricing = model?.motionReferencePricing;
  if (pricing && typeof pricing === 'object' && Number(pricing.max_packed_rows) > 0) {
    const machine = servingMachineFor(s, id, machines);
    const budget = motionReferenceBudgetRows(pricing, machine?.vram_gb);
    const durations = durationsFor(s, id).map(Number).filter((value) => value > 0);
    const priced = durations.map((seconds) => ({ seconds, rows: motionReferencePackedRows(s, id, seconds) }));
    // An unknown canvas prices as null — fall through to the published ceiling.
    if (priced.length && priced.every((entry) => Number.isFinite(entry.rows))) {
      const fits = priced.filter((entry) => entry.rows <= budget.rows).map((entry) => entry.seconds);
      if (fits.length === durations.length) return null;
      const measured = videos.map((item) => Number(item?.durationSeconds)).filter((value) => value > 0);
      const longest = measured.length === videos.length ? Math.max(...measured) : Infinity;
      return {
        maxSeconds: fits.length ? Math.max(...fits) : 0,
        referenceVideoCount: videos.length,
        referencePictureCount: pictureCount,
        referenceSoundCount: voiceCount,
        longestReferenceSeconds: Number.isFinite(longest) ? longest : null,
        priced: true,
        budgetRows: budget.rows,
        cardVramGb: budget.vramGb,
        machine: machine ? { rentalId: machine.rental_id, gpu: machine.gpu || null, vramGb: Number(machine.vram_gb) || null } : null,
      };
    }
  }
  const limits = model?.motionReferenceMaxSeconds;
  if (!limits || typeof limits !== 'object') return null;
  // The server falls back to the standard tier for an unset resolution, so the
  // lookup has to agree or the picker would quote a ceiling from a canvas the
  // run will not use.
  const tier = String(s.resolution || 'standard').trim().toLowerCase() || 'standard';
  const maxSeconds = Number(limits[`${tier}|${String(s.ar || '').trim()}`]);
  if (!Number.isFinite(maxSeconds)) return null;
  // The LONGEST attached reference decides. A duration we have not measured yet
  // counts as long, matching the server: guessing it short would offer a length
  // the run then refuses.
  const measured = videos.map((item) => Number(item?.durationSeconds)).filter((value) => value > 0);
  const longest = measured.length === videos.length ? Math.max(...measured) : Infinity;
  if (longest <= maxSeconds) return null;
  return {
    maxSeconds,
    referenceVideoCount: videos.length,
    longestReferenceSeconds: Number.isFinite(longest) ? longest : null,
  };
};

// A reference clip's own length, read from its metadata. Needed because the
// ceiling above depends on it, and a reference can arrive from a file drop, a
// cast or a saved persona — so it is measured where they all land rather than
// at each attach point.
export const probeVideoDurationSeconds = (url) => new Promise((resolve) => {
  if (!url || typeof document === 'undefined') return resolve(0);
  const video = document.createElement('video');
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    video.removeAttribute('src');
    resolve(Number.isFinite(value) && value > 0 ? value : 0);
  };
  // A codec the browser half-supports would otherwise never fire either event,
  // leaving the duration unknown forever — which reads as "long" and silently
  // pins the slider.
  const timer = setTimeout(() => finish(0), 8000);
  video.preload = 'metadata';
  video.muted = true;
  video.addEventListener('loadedmetadata', () => { clearTimeout(timer); finish(Number(video.duration)); });
  video.addEventListener('error', () => { clearTimeout(timer); finish(0); });
  video.src = url;
});

// The durations that will actually render, given everything else selected.
// Never empty when the model offers any: if not even the shortest fits, the
// canvas itself is the problem, and blanking the control would hide that.
export const availableDurationsFor = (s, id, machines) => {
  const durations = durationsFor(s, id);
  const limit = motionReferenceLimitFor(s, id, machines);
  if (!limit) return durations;
  const fits = durations.filter((value) => Number(value) <= limit.maxSeconds);
  return fits.length ? fits : durations.slice(0, 1);
};

// Pull a selected duration back onto the list above. Returns the same value
// when it already fits, so callers can assign unconditionally.
export const clampDurationToMotionReference = (s, id, machines) => {
  const available = availableDurationsFor(s, id, machines);
  if (!available.length) return s.duration;
  if (available.some((value) => Number(value) === Number(s.duration))) return s.duration;
  return available.reduce((best, value) => (Number(value) > Number(best) ? value : best), available[0]);
};

export const resolutionsFor = (s, id) => {
  // Local Media Studio workflows render at aspect buckets; High requests the
  // larger bucket (~2.5x pixels) — synthetic list, old line 394.
  // High leads because the first entry becomes the default: Standard is 0.34 MP
  // at 16:9, roughly a third of what LTX 2.3 workflows in the wild generate at,
  // and LTX anatomy degrades sharply below its trained resolution. High (0.86 MP)
  // lands near that mark. Standard stays available for quick drafts.
  const hive = getHivemindVideoModelById(id);
  if (hive) {
    // MiniMax H3 additionally gets Max (~1.0MP): the model's trained canvas
    // (768px short edge at 16:9) and its measured quality knee. Nothing above
    // 1MP is offered — H3 grows less coherent past it.
    return isMinimaxFamilyModel(hive) ? ['High', 'Standard', 'Max'] : ['High', 'Standard'];
  }
  if (getLocalModelById(id)) return [];
  return s.imageMode ? getResolutionsForI2VModel(id) : getResolutionsForVideoModel(id);
};

export const modesFor = (id) => getModesForModel(id);

export const qualitiesFor = (s, c, id) => resolveVideoModel(id, c)?.inputs?.quality?.enum || [];

export const effectNamesFor = (s, c, id) => resolveVideoModel(id, c)?.inputs?.name?.enum || [];

/* ------------------------------------------------------------------ */
/* Setup-state transitions (port of the imperative cascades)           */
/* ------------------------------------------------------------------ */

export function buildInitialSetup(c) {
  const defaultModel = c.allT2V[0];
  return withSelectedModel({
    localMode: isHivemindStudioEnabled() && isLocalAIAvailable()
      ? true
      : isLocalVideoModel(defaultModel.id),
    // Rented is opt-in: a boot with no saved preference runs on this machine.
    rentedOnly: false,
    // Per-tab "Run on" pin (a rental id); '' follows the Machines default.
    rentedMachineId: '',
    imageMode: false,
    v2vMode: false,
    ar: defaultModel.inputs?.aspect_ratio?.default || '16:9',
    duration: defaultModel.inputs?.duration?.default || 5,
    resolution: defaultModel.inputs?.resolution?.default || '',
    quality: defaultModel.inputs?.quality?.default || '',
    mode: '',
    effectName: '',
    advancedValues: getDefaultAdvancedVideoValues(defaultModel),
    // -1 = random (a fresh seed is rolled per generation); >= 0 = a locked seed.
    seed: -1,
    imageUrl: null,
    endImageUrl: null,
    // MiniMax H3 Reference mode: character/subject pictures (up to 9, ordered),
    // voice clips (<Audio N>) and motion clips (<Video N>, each with its own
    // useAudio flag). All three are optional and mix freely.
    referenceImageUrls: [],
    referenceAudios: [],
    referenceVideos: [],
    // Head replacement, armed from a motion clip's own thumbnail: which attached
    // clip is being rewritten, the painted mask, and the dials the dialog
    // changed. Null means an ordinary generation — this is the ONE flag that
    // routes the run to the inpaint graph, so clearing it is how you go back.
    inpaint: null,
    // The Hive Persona ID those references were loaded from (or last saved as):
    // { id, name }, or null when they are not a named character. It is a LABEL
    // for the three lists above, never a source of media in its own right.
    persona: null,
    ltxMiddleUrl: null,
    ltxEndUrl: null,
    matchStartFrameAr: true,
    // Post-generation grain cleanup: '' (off), 'light', 'strong'.
    denoise: '',
    // Sampling-steps override for workflows with a steps slot (H3 refinement).
    // null = the workflow's registered default.
    steps: null,
    videoUrl: null,
    videoName: null,
    prompt: '',
  }, defaultModel);
}

// Port of updateControlsForModel (1001-1100): re-derives the per-model default
// selections. Visibility is derived at render time via deriveControlVisibility.
export function applyModelDefaults(prev, c) {
  const s = { ...prev };
  const model = resolveVideoModel(s.modelId, c);
  s.advancedValues = getDefaultAdvancedVideoValues(model);
  if (s.v2vMode) return s; // v2v hides all parameter controls; values untouched
  const localVideoInput = isHivemindVideoInputMode(s);
  const availableArs = aspectRatiosFor(s, s.modelId);
  if (!localVideoInput && availableArs.length > 0) s.ar = availableArs[0];
  const durations = durationsFor(s, s.modelId);
  if (durations.length > 0) {
    s.duration = durations.find((d) => Number(d) === Number(model?.inputs?.duration?.default)) ?? durations[0];
  }
  const resolutions = resolutionsFor(s, s.modelId);
  if (resolutions.length > 0) s.resolution = resolutions[0];
  const qualities = qualitiesFor(s, c, s.modelId);
  s.quality = qualities.length > 0 ? (model?.inputs?.quality?.default || qualities[0]) : '';
  const modes = modesFor(s.modelId);
  s.mode = modes.length > 0 ? (model?.inputs?.mode?.default || modes[0]) : '';
  const effectNames = effectNamesFor(s, c, s.modelId);
  s.effectName = effectNames.length > 0 ? (model?.inputs?.name?.default || effectNames[0]) : '';
  return s;
}

export function deriveControlVisibility(s, c) {
  if (s.v2vMode) {
    return { ar: false, duration: false, resolution: false, quality: false, mode: false, effect: false };
  }
  const localVideoInput = isHivemindVideoInputMode(s);
  return {
    ar: !localVideoInput && aspectRatiosFor(s, s.modelId).length > 0,
    duration: durationsFor(s, s.modelId).length > 0,
    resolution: resolutionsFor(s, s.modelId).length > 0,
    quality: qualitiesFor(s, c, s.modelId).length > 0,
    mode: modesFor(s.modelId).length > 0,
    effect: effectNamesFor(s, c, s.modelId).length > 0,
  };
}

// Extend banner (old 1087-1099): '' means hidden.
export function deriveExtendBanner(s, c) {
  if (s.v2vMode) return '';
  const model = currentModel(s, c);
  if (videoRequestPlan(s).sendMotionContext) {
    // The airlock guidance is part of the interface: cutting straight to a new
    // setup makes the model render the old and new staging as a UNION, and a
    // held frame with no business renders as a literal freeze.
    const shot = Number(s.motionContextIndex) > 0 ? Number(s.motionContextIndex) : 1;
    return zh()
      ? `正在接续第 ${shot} 段的结尾（拼接处约 1 秒会重渲染并自动裁掉）。开场先保持上一镜头的构图约 2 秒，给角色一点小动作（呼吸、转视线），再切到新画面。`
      : `Continuing shot ${shot} — the new clip picks up exactly where it ended (≈1s is re-rendered for the join, then trimmed off). Open by holding the previous framing for ~2s with small business (a breath, an eyeline), then cut to the new setup.`;
  }
  if (isHivemindVideoInputMode(s)) {
    return zh()
      ? '正在延长已上传的 LTX 镜头；时长控制追加多少新画面'
      : 'Extending the uploaded LTX shot; duration controls how much new footage is appended';
  }
  if (model?.requiresRequestId) {
    return zh()
      ? '正在延长上一次 Seedance 2.0 生成；可添加可选提示词引导延续'
      : 'Extending previous Seedance 2.0 generation; add an optional prompt to guide the continuation';
  }
  return '';
}

// Derived textarea placeholder/disabled — replaces the ~14 imperative
// textarea.placeholder writes in the old file with one state-derived rule.
export function derivePromptUi(s, c) {
  const model = currentModel(s, c);
  if (s.v2vMode) {
    if (model?.imageField) {
      if (s.videoUrl && s.imageUrl) {
        return {
          placeholder: model.promptRequired
            ? (zh() ? '描述动作' : 'Describe the motion')
            : (zh() ? '描述动作（可选）' : 'Describe the motion (optional)'),
          disabled: false,
        };
      }
      if (s.imageUrl) return { placeholder: zh() ? '现在请添加参考视频' : 'Now attach a reference video', disabled: false };
      if (s.videoUrl) return { placeholder: zh() ? '现在请添加参考图片' : 'Now attach a reference image', disabled: false };
      return {
        placeholder: model.promptRequired
          ? (zh() ? '上传参考视频和图片，然后描述动作' : 'Upload a reference video and image, then describe the motion')
          : (zh() ? '上传参考视频和图片，然后描述动作（可选）' : 'Upload a reference video and image, then describe the motion (optional)'),
        disabled: false,
      };
    }
    const disabled = !(model?.hasPrompt || model?.promptRequired);
    if (s.videoUrl) return { placeholder: zh() ? '视频已就绪 — 点击生成' : 'Video ready — click Generate', disabled };
    return { placeholder: zh() ? '先添加一个视频，然后点击生成' : 'Attach a video, then click Generate', disabled };
  }
  if (isHivemindVideoInputMode(s)) {
    return { placeholder: zh() ? '描述镜头应如何延续' : 'Describe how the shot should continue', disabled: false };
  }
  if (videoRequestPlan(s).sendMotionContext) {
    return { placeholder: zh() ? '描述下一个镜头' : 'Describe the next shot', disabled: false };
  }
  if (model?.requiresRequestId) {
    return { placeholder: zh() ? '可选：描述视频如何继续…' : 'Optional: describe how to continue the video...', disabled: false };
  }
  if (model?.supportsIngredientImages) {
    return { placeholder: zh() ? '使用所选角色参考来描述镜头' : 'Describe the shot using the selected character references', disabled: false };
  }
  // Local workflows (H3, LTX) take the start frame as an OPTIONAL input — H3 is
  // text-to-video by default — so the box asks for the shot, not for a frame
  // the user does not need. (The old "Upload a start frame image, then…" read
  // as a requirement, on a model that generates from text.)
  if (isHivemindVideoModelId(s.modelId)) {
    return { placeholder: zh() ? '描述这个镜头' : 'Describe the shot', disabled: false };
  }
  if (s.imageMode) {
    return { placeholder: zh() ? '描述动作或效果（可选）' : 'Describe the motion or effect (optional)', disabled: false };
  }
  return { placeholder: t('video.placeholder'), disabled: false };
}

// Start-frame selected (old picker onSelect, 449-483).
export function startFrameSelectedTransition(prev, url, c) {
  let s = prev;
  if (isHivemindVideoInputMode(s)) s = clearVideoUploadTransition(s, c);
  s = { ...s, imageUrl: url };
  // Motion-control v2v: image is a second input alongside the video, not a mode switch
  if (isMotionControlV2V(s, c)) return { setup: s, matchAspect: false, modelChanged: false };
  if (s.v2vMode) s = { ...s, v2vMode: false, videoUrl: null, videoName: null };
  let modelChanged = false;
  if (!s.imageMode) {
    const currentT2V = c.allT2V.find((m) => m.id === s.modelId);
    const sibling = currentT2V?.family ? c.allI2V.find((m) => m.family === currentT2V.family) : null;
    const target = sibling || c.allI2V[0];
    s = applyModelDefaults(withSelectedModel({ ...s, imageMode: true }, target), c);
    modelChanged = true;
  }
  return { setup: s, matchAspect: true, modelChanged };
}

// The text-to-video model a cleared composer lands on, from the SAME source the
// tab is set to. `allT2V` is ordered cloud-first, so its head is the cloud
// default even while Local is selected — "+ New" after an H3 run left the Model
// chip naming Seedance Lite with a cloud icon, the picker (filtered to local
// models) not listing it, and Generate opening the API-key modal. Local lands on
// the session's last hand-picked local workflow, else the LTX default, else the
// first local workflow; cloud lands on the first cloud model.
export function defaultTextToVideoModelFor(s, c) {
  if (s?.localMode) {
    const local = c.hivemindI2V || [];
    let saved = null;
    try { saved = getSavedHivemindVideoSelection(); } catch { /* no session store */ }
    const preferred = (saved?.modelId && local.find((m) => m.id === saved.modelId))
      || local.find((m) => m.workflowId === 'ltx23-eros-fast')
      || local[0]
      || c.allT2V.find((m) => isLocalVideoModel(m.id));
    if (preferred) return preferred;
  }
  // Cloud: the text-to-video sibling of the model's own family first (the
  // reverse of the hop a start-frame pick makes), then the first cloud model.
  const current = resolveVideoModel(s?.modelId, c);
  const sibling = current?.family
    ? c.allT2V.find((m) => m.family === current.family && !isLocalVideoModel(m.id))
    : null;
  return sibling || c.allT2V.find((m) => !isLocalVideoModel(m.id)) || c.allT2V[0];
}

// Whether a freshly cleared composer can stay on its model: Hivemind local
// workflows take the start frame as an OPTIONAL input (H3 is text-to-video by
// default), and a plain text-to-video model (imageMode off) has nothing to
// lose — so clearing inputs never needs to leave either. Only a model that
// cannot run without its input (a cloud image-to-video sibling, a video tool)
// has to move.
const keepsModelWhenCleared = (s) => !s?.v2vMode && (isHivemindVideoModelId(s?.modelId) || !s?.imageMode);

// Start-frame cleared (old picker onClear, 484-499).
export function startFrameClearedTransition(prev, c) {
  let s = { ...prev, imageUrl: null };
  // Motion-control v2v: keep the model selection; just lose the image
  if (isMotionControlV2V(s, c)) return s;
  // Hivemind local workflows take the start frame as an OPTIONAL input, so
  // clearing it must not drop the model: falling back to the first cloud t2v
  // model unmounted the keyframe picker mid-edit and discarded middle/end.
  if (isHivemindVideoModelId(s.modelId)) return s;
  // Clearing the start frame invalidates any selected end frame.
  s = withSelectedModel({ ...s, imageMode: false, endImageUrl: null }, defaultTextToVideoModelFor(s, c));
  return applyModelDefaults(s, c);
}

// Clearing the reference video (old clearVideoUpload, 605-634).
export function clearVideoUploadTransition(prev, c) {
  const wasHivemindVideo = isHivemindVideoInputMode(prev);
  let s = { ...prev, videoUrl: null, videoName: null };
  // Motion-control v2v: keep the model and image; user can re-upload a video
  if (isMotionControlV2V(s, c)) return s;
  if (wasHivemindVideo) {
    // The LTX extension graph is a local workflow that generates from text
    // just as well, so clearing the clip only clears the clip: the model, the
    // source and the format settings all stay where they were.
    return { ...s, imageMode: true };
  }
  const target = keepsModelWhenCleared(s) ? null : defaultTextToVideoModelFor(s, c);
  if (!target) return { ...s, v2vMode: false };
  return applyModelDefaults(withSelectedModel({ ...s, v2vMode: false }, target), c);
}

// After a reference video finished uploading (old videoFileInput.onchange, 663-706).
export function videoUploadedTransition(prev, { url, name, useHivemind, preferredHive }, c) {
  let s = { ...prev, videoUrl: url, videoName: name };
  if (useHivemind) {
    const keepFace = videoRequestPlan(s).keepImageOnVideoUpload;
    s = withSelectedModel({
      ...s,
      ...(keepFace ? {} : { imageUrl: null }),
      endImageUrl: null,
      // A source video means extend/head-swap — reference mode never combines.
      referenceImageUrls: [],
      referenceAudios: [],
      referenceVideos: [],
      persona: null,
      v2vMode: false,
      imageMode: true,
    }, preferredHive);
    return applyModelDefaults(s, c);
  }
  // If a motion-control v2v model is already selected, keep it and the image upload
  if (isMotionControlV2V(s, c)) return s;
  // Default v2v flow — auto-pick the first v2v model
  if (s.imageMode) s = { ...s, imageUrl: null, imageMode: false };
  s = withSelectedModel({ ...s, v2vMode: true }, v2vModels[0]);
  return applyModelDefaults(s, c);
}

// Model dropdown selections (old makeModelItem onclick, 2026-2072).
export function selectV2VModelTransition(prev, m, c) {
  let s = { ...prev, v2vMode: true, imageMode: false };
  // Single-input v2v (watermark remover etc.) — drop any image
  if (!m.imageField) s = { ...s, imageUrl: null };
  return applyModelDefaults(withSelectedModel(s, m), c);
}

export function selectRegularModelTransition(prev, m, c) {
  let s = prev;
  if (s.v2vMode) s = { ...s, v2vMode: false, videoUrl: null, videoName: null };
  return applyModelDefaults(withSelectedModel(s, m), c);
}

// selectHivemindWorkflowModel (old 1208-1232) — caller checks target exists.
// Landing in Rented mode still pointed at a model the machine cannot run leaves
// a selection the generate guard will simply refuse. One rule, so every way into
// Rented mode obeys it: the source picker, and the "Use in Video Studio" handoff
// from the Machines view — which bypassed this and was how that handoff arrived
// in Rented mode still on a cloud model (2026-08-24).
export function withServedModel(setup, machines, c) {
  if (!machines?.length) return setup;
  if (servedByAnyMachine(machines, { id: setup.modelId, name: setup.modelName })) return setup;
  const served = [...(c.hivemindI2V || []), ...(c.allT2V || [])]
    .find((m) => servedByAnyMachine(machines, m));
  return served ? selectHivemindWorkflowTransition(setup, served, c) : setup;
}


export function selectHivemindWorkflowTransition(prev, target, c) {
  let s = prev;
  if (s.v2vMode) s = { ...s, v2vMode: false, videoUrl: null, videoName: null };
  s = withSelectedModel({ ...s, imageMode: true, localMode: true }, target);
  return applyModelDefaults(s, c);
}

// "+ New" (old newPromptBtn, 2940-2962): a fresh prompt with every input
// cleared. The MODEL stays when it can start a text prompt where it is — every
// Hivemind local workflow can — so "+ New" after an H3 run is still H3 with
// the same format settings; only a model that cannot run without its input (a
// cloud image-to-video sibling, a video tool) falls back to the default
// text-to-video model of the same source.
export function newPromptTransition(prev, c) {
  const cleared = {
    ...prev,
    prompt: '',
    imageUrl: null,
    endImageUrl: null,
    referenceImageUrls: [],
    referenceAudios: [],
    referenceVideos: [],
    persona: null,
    ltxMiddleUrl: null,
    ltxEndUrl: null,
    matchStartFrameAr: true,
    // Post-generation grain cleanup: '' (off), 'light', 'strong'.
    denoise: '',
    videoUrl: null,
    videoName: null,
    v2vMode: false,
  };
  if (keepsModelWhenCleared(prev)) {
    // Local workflows are selected with imageMode true (the start frame is an
    // optional input, not a mode) — keep that shape so a later start-frame pick
    // stays on this model instead of hopping to the first in the list.
    return { ...cleared, imageMode: isHivemindVideoModelId(prev.modelId) };
  }
  const s = withSelectedModel({ ...cleared, imageMode: false }, defaultTextToVideoModelFor(prev, c));
  return applyModelDefaults(s, c);
}

// Extend flow (old extendBtn, 2964-2978).
export function extendTransition(prev, c) {
  const s = withSelectedModel({ ...prev, prompt: '', imageUrl: null, imageMode: false },
    { id: 'seedance-v2.0-extend', name: 'Seedance 2.0 Extend' });
  return applyModelDefaults(s, c);
}

// Restore persisted preferences (old restorePersistedVideoPreferences, 1126-1206).
// Returns null when the saved model no longer resolves. Resolution priority is
// v2v -> i2v -> t2v, exactly as the old code.
export function applyRestoredPreferences(prev, preferences, c) {
  if (!preferences) return null;
  const v2vModel = v2vModels.find((model) => model.id === preferences.modelId);
  const i2vModel = c.allI2V.find((model) => model.id === preferences.modelId);
  const t2vModel = c.allT2V.find((model) => model.id === preferences.modelId);
  const target = v2vModel || i2vModel || t2vModel;
  if (!target) return null;
  let s = withSelectedModel({
    ...prev,
    v2vMode: Boolean(v2vModel),
    imageMode: !v2vModel && Boolean(i2vModel),
    localMode: preferences.localMode ?? isLocalVideoModel(target.id),
    rentedOnly: Boolean(preferences.rentedOnly && (preferences.localMode ?? isLocalVideoModel(target.id))),
    rentedMachineId: typeof preferences.rentedMachineId === 'string' ? preferences.rentedMachineId : '',
  }, target);
  s = applyModelDefaults(s, c);
  const matchingDuration = durationsFor(s, s.modelId)
    .find((duration) => Number(duration) === preferences.duration);
  if (matchingDuration != null) s.duration = matchingDuration;
  const restoreChoice = (values, saved, apply) => {
    const match = values.find((value) => String(value) === String(saved));
    if (match != null) apply(match);
  };
  restoreChoice(aspectRatiosFor(s, s.modelId), preferences.aspectRatio, (value) => { s.ar = value; });
  restoreChoice(resolutionsFor(s, s.modelId), preferences.resolution, (value) => { s.resolution = value; });
  restoreChoice(qualitiesFor(s, c, s.modelId), preferences.quality, (value) => { s.quality = value; });
  restoreChoice(modesFor(s.modelId), preferences.mode, (value) => { s.mode = value; });
  restoreChoice(effectNamesFor(s, c, s.modelId), preferences.effectName, (value) => { s.effectName = value; });
  if (typeof preferences.matchStartFrameAr === 'boolean') s.matchStartFrameAr = preferences.matchStartFrameAr;
  if (['light', 'strong', ''].includes(preferences.denoise)) s.denoise = preferences.denoise;
  if (typeof preferences.seed === 'number') s.seed = preferences.seed;
  if (typeof preferences.steps === 'number') s.steps = preferences.steps;
  // A speed/quality preference, so it survives a reload. The send path re-gates
  // it on the selected model's capability, so a value left on from MiniMax H3
  // is inert on a workflow that cannot compile the two-pass graph.
  s.fastHighRes = preferences.fastHighRes === true;
  // The rest of what the Advanced / Task panels hold. Every one of these was
  // normalized by normalizeVideoPreferences and WRITTEN by the studio, but
  // never read back — so Spectrum off, the Detailer, negative guidance, Task =
  // Head swap and the swap engine all reset on every reload. Each is re-gated
  // at send time on the selected model (Spectrum/Detailer/NAG are capability-
  // checked, the task strip is LTX-only), so a value saved on one model is
  // inert on another rather than harmful.
  if (typeof preferences.spectrum === 'boolean') s.spectrum = preferences.spectrum;
  if (typeof preferences.nagScale === 'number') s.nagScale = preferences.nagScale;
  if (typeof preferences.detailerStrength === 'number' && preferences.detailerStrength > 0) s.detailerStrength = preferences.detailerStrength;
  if (typeof preferences.videoTask === 'string' && preferences.videoTask !== 'generate') s.videoTask = preferences.videoTask;
  if (preferences.headSwapBackend === 'facefusion') s.headSwapBackend = 'facefusion';
  if (preferences.headSwapFaceEnhancer === true) s.headSwapFaceEnhancer = true;
  if (typeof preferences.headSwapLoraStrength === 'number' && preferences.headSwapLoraStrength !== 1) s.headSwapLoraStrength = preferences.headSwapLoraStrength;
  // The camera / restyle chips: ids only. The phrase they stand for comes back
  // with the prompt from the encrypted composer, and the studio reconciles the
  // two once that hydrates (a chip must never claim a phrase the prompt lacks).
  if (Array.isArray(preferences.cameraMotionIds) && preferences.cameraMotionIds.length) s.cameraMotionIds = [...preferences.cameraMotionIds];
  if (typeof preferences.restylePresetId === 'string' && preferences.restylePresetId) s.restylePresetId = preferences.restylePresetId;
  // An in-progress scene chain survives reload: the pointer is opaque and the
  // clip stays sealed. videoRequestPlan re-gates it, so a stale value on a
  // non-chaining model is inert.
  if (typeof preferences.motionContextUrl === 'string' && preferences.motionContextUrl) {
    s.motionContextUrl = preferences.motionContextUrl;
    s.motionContextIndex = preferences.motionContextIndex || 1;
  }
  s.advancedValues = getRestoredAdvancedVideoValues(target, preferences.advancedValues);
  return s;
}

// Restore a captured generation context (old restoreGenerationContext, 2831-2909).
// Returns { setup, model } or null; the caller handles loras/ingredients/persist.
export function applyGenerationContext(prev, context, c) {
  if (!context?.model) return null;
  const s0 = { ...prev, imageMode: Boolean(context.imageMode), v2vMode: Boolean(context.v2vMode) };
  // Mode-blind on purpose: a captured run records the mode it ran in, and a
  // reference run records imageMode false. Looking the model up in the list for
  // THAT mode failed to find it and abandoned the whole restore.
  const model = resolveVideoModel(context.model, c);
  if (!model) return null;
  let s = {
    ...withSelectedModel(s0, model),
    // The captured label wins over the catalog's — a workflow renamed since the
    // run should still restore under the name the user saw.
    modelName: context.modelName || model.name,
    imageUrl: context.imageUrl || null,
    endImageUrl: context.endImageUrl || null,
    referenceImageUrls: Array.isArray(context.referenceImageUrls)
      ? context.referenceImageUrls.filter(Boolean)
      : [],
    referenceAudios: Array.isArray(context.referenceAudios)
      ? context.referenceAudios.filter((item) => item?.url)
      : [],
    referenceVideos: Array.isArray(context.referenceVideos)
      ? context.referenceVideos.filter((item) => item?.url)
      : [],
    // Restoring a run restores which character it was: a captured persona is
    // only its id, name and gender, so a deleted one comes back as a plain label.
    persona: personaIdentity(context.persona),
    videoUrl: context.videoUrl || null,
    videoName: context.videoName || null,
    motionContextUrl: context.motionContextUrl || null,
    motionContextIndex: Number(context.motionContextIndex) > 0 ? Number(context.motionContextIndex) : null,
    prompt: context.prompt || '',
  };
  s = applyModelDefaults(s, c);
  s.ar = context.aspectRatio || s.ar;
  s.duration = context.duration ?? s.duration;
  s.resolution = context.resolution ?? s.resolution;
  s.quality = context.quality ?? s.quality;
  s.mode = context.mode ?? s.mode;
  s.effectName = context.effectName ?? s.effectName;
  s.advancedValues = {
    ...getDefaultAdvancedVideoValues(model),
    ...(context.advancedValues || {}),
  };
  return { setup: s, model };
}

/* ------------------------------------------------------------------ */
/* Ingredients helpers                                                 */
/* ------------------------------------------------------------------ */

// Fallback chain (old getIngredientsWorkflow, 955-961).
export function getIngredientsWorkflow(s, hivemindI2V) {
  const selected = hivemindI2V.find((model) => model.id === s.modelId && model.supportsIngredientImages);
  return selected
    || hivemindI2V.find((model) => model.workflowId === 'ltx23-ic-ingredients-lora')
    || hivemindI2V.find((model) => model.supportsIngredientImages)
    || null;
}

export function currentIngredientModel(s, c) {
  const model = currentModel(s, c);
  return model?.provider === 'hivemind-media-studio' && model.supportsIngredientImages ? model : null;
}

// Start / middle / end keyframe slots (one FrameSlotsPicker instead of the plain
// start-frame picker): a Hivemind local workflow, image-driven rather than a video
// extension, and not an ingredient-sheet model.
export function frameSlotsVisible(s, c) {
  if (currentIngredientModel(s, c)) return false;
  return videoRequestPlan(s).showFrameSlots;
}

// The references the next generation actually conditions on (old 1336-1341).
export function activeIngredientSheetItems(ingredientModel, ing) {
  if (!ingredientModel) return [];
  if (ing.selectedSheet === 'stitched') return ing.selections;
  const sheet = ing.sheets.find((entry) => entry.url === ing.selectedSheet) || null;
  return sheet ? [sheet] : [];
}

export function ingredientSelectionSignature(model, selection, ar) {
  return JSON.stringify([
    Boolean(model),
    ar,
    ...selection.map((item) => item.url),
  ]);
}

// History privacy: Hivemind prompts never persist (old 2677-2681).
export const redactPrivateHistoryEntry = (entry) => (
  isHivemindVideoModelId(entry?.model)
    ? { ...entry, prompt: '', prompt_private: true }
    : entry
);


// The restyle preset whose phrase is written in the prompt, or null — the
// reverse of applyRestylePrompt, so the Style chip can be reconciled with a
// prompt restored from the encrypted composer (see cameraMotionIdsInPrompt).
export function restylePresetIdInPrompt(prompt) {
  const source = String(prompt || '');
  if (!source) return null;
  const hit = H3_RESTYLE_PRESETS.find((preset) => source.includes(restylePhrase(preset.id)));
  return hit ? hit.id : null;
}

// Capability readers. The `accepts` → capability derivation itself lives in ONE
// place — mapHivemindWorkflowModels in lib/hivemindStudio.js — so these are
// deliberately thin: re-testing `accepts` here is how a rule ends up with two
// definitions that disagree. A cloud model has no such field and reads false,
// which is correct: these are local-graph capabilities.
export const supportsSpectrum = (model) => Boolean(model?.supportsSpectrum);
export const supportsFastHighRes = (model) => Boolean(model?.supportsFastHighRes);
export const supportsQualitySteps = (model) => Boolean(model?.supportsQualitySteps);
