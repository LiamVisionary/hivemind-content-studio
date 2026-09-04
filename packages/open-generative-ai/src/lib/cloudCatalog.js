// The cloud model catalog the Image, Video and Lip sync studios render.
//
// It is SERVED, not vendored. Until 2026-09-04 this was src/lib/modelsData.js —
// a 12,779-line copy of the provider's model list, generated once from a dump
// nothing regenerated, shipped in the landing chunk, and disagreeing with the
// server's own list of the same provider's models. There is one catalog now and
// it lives on the server (src/hivemind_content_studio/catalog/muapi_models.json,
// served at /api/muapi/catalog), which is also where the producer's rows come
// from — so the two halves of the app can no longer name different models.
//
// A standalone build has no control API to ask. It falls back to the generated
// offline list, which is imported DYNAMICALLY: on a normal build the catalog
// arrives over the wire and those bytes are never fetched at all.
//
// WHY THE ARRAYS ARE `let`
// Every consumer here reads the catalog inside a function, at call time, and
// they are ESM live bindings — so reassigning them once the fetch lands updates
// every importer without a subscription. What they must never be is EMPTY when
// a studio renders (ImageStudio boots its default model off `t2iModels[0]`), so
// the studios are gated on `cloudCatalogReady()` rather than left to re-render.

/* ---------------- the rows ---------------- */

export let t2iModels = [];
export let t2vModels = [];
export let i2iModels = [];
export let i2vModels = [];
export let v2vModels = [];
export let lipsyncModels = [];
export let recastModels = [];
export let audioModels = [];

// The Lip sync studio's two lanes. Derived, so they are reassigned with the rest
// rather than captured once at module load.
export let imageLipSyncModels = [];
export let videoLipSyncModels = [];

/** Where the current rows came from: 'server', 'offline', or '' before a load. */
export let catalogSource = '';

export function applyCloudCatalog(buckets, source = '') {
  const bucket = (name) => (Array.isArray(buckets?.[name]) ? buckets[name] : []);
  t2iModels = bucket('t2i');
  t2vModels = bucket('t2v');
  i2iModels = bucket('i2i');
  i2vModels = bucket('i2v');
  v2vModels = bucket('v2v');
  lipsyncModels = bucket('lipsync');
  recastModels = bucket('recast');
  audioModels = bucket('audio');
  imageLipSyncModels = lipsyncModels.filter((m) => m.category === 'image');
  videoLipSyncModels = lipsyncModels.filter((m) => m.category === 'video');
  catalogSource = source;
  return buckets;
}

/* ---------------- loading ---------------- */

let readyPromise = null;

async function fetchServedCatalog() {
  const response = await fetch('/api/muapi/catalog', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error(`catalog ${response.status}`);
  const payload = await response.json();
  if (!payload?.buckets || typeof payload.buckets !== 'object') throw new Error('catalog has no buckets');
  // A 200 carrying no text-to-image rows is a failed catalog wearing a success
  // code. Every studio boots its default model off a bucket, so an empty t2i is
  // the one shape that must fall through to the offline list rather than be
  // applied — the invariant three lines above this file's title, now enforced.
  if (!Array.isArray(payload.buckets.t2i) || payload.buckets.t2i.length === 0) {
    throw new Error('catalog has no t2i models');
  }
  return payload.buckets;
}

async function loadOfflineCatalog() {
  const module = await import('./generated/cloudCatalogFallback.js');
  return module.buckets;
}

/**
 * Load the catalog once, and resolve when the studios may render.
 *
 * Never rejects. A studio with no models is a broken studio, so a server that
 * cannot answer falls through to the offline list rather than leaving the
 * arrays empty — the same list a standalone build uses.
 */
export function cloudCatalogReady() {
  if (!readyPromise) {
    readyPromise = fetchServedCatalog()
      .then((buckets) => applyCloudCatalog(buckets, 'server'))
      .catch(() => loadOfflineCatalog().then((buckets) => applyCloudCatalog(buckets, 'offline')))
      .catch(() => applyCloudCatalog({}, ''));
  }
  return readyPromise;
}

/** Test seam: forget the loaded catalog so the next `cloudCatalogReady()` reloads. */
export function resetCloudCatalog() {
  readyPromise = null;
  applyCloudCatalog({}, '');
}

/* ---------------- accessors ----------------
 * Every one of these reads a value off a catalog row. They are the studios'
 * only route into the rows, which is what let the vendored module go.
 */

const byId = (rows, id) => rows.find((m) => m.id === id);

export const getModelById = (id) => byId(t2iModels, id);
export const getVideoModelById = (id) => byId(t2vModels, id);
export const getI2IModelById = (id) => byId(i2iModels, id);
export const getI2VModelById = (id) => byId(i2vModels, id);
export const getV2VModelById = (id) => byId(v2vModels, id);
export const getLipSyncModelById = (id) => byId(lipsyncModels, id);
export const getRecastModelById = (id) => byId(recastModels, id);
export const getAudioModelById = (id) => byId(audioModels, id);

const enumOf = (model, input) => model?.inputs?.[input]?.enum;

export const getAspectRatiosForModel = (modelId) => {
  const model = getModelById(modelId);
  if (!model) return ['1:1'];
  return enumOf(model, 'aspect_ratio') || ['1:1', '16:9', '9:16', '4:3', '3:2', '21:9'];
};

export const getAspectRatiosForVideoModel = (modelId) => {
  const model = getVideoModelById(modelId);
  if (!model) return ['16:9'];
  return enumOf(model, 'aspect_ratio') || ['16:9', '9:16', '1:1'];
};

export const getAspectRatiosForI2IModel = (modelId) => {
  const model = getI2IModelById(modelId);
  if (!model) return ['1:1'];
  return enumOf(model, 'aspect_ratio') || ['1:1', '16:9', '9:16'];
};

export const getAspectRatiosForI2VModel = (modelId) => {
  const model = getI2VModelById(modelId);
  if (!model) return ['16:9'];
  return enumOf(model, 'aspect_ratio') || ['16:9', '9:16', '1:1'];
};

export const getAspectRatiosForRecastModel = (id) => getRecastModelById(id)?.inputs?.aspect_ratio?.enum || [];

export const getDurationsForModel = (modelId) => {
  const model = getVideoModelById(modelId);
  if (!model) return [5];
  const duration = model.inputs?.duration;
  if (duration?.enum) return duration.enum;
  if (duration) return [duration.default || 5];
  return [];
};

// The i2v ladder differs from the t2v one on purpose: an i2v model that declares
// a RANGE gets that range expanded into steps, because the picker is a list of
// choices and a bare default would offer exactly one length.
export const getDurationsForI2VModel = (modelId) => {
  const duration = getI2VModelById(modelId)?.inputs?.duration;
  if (!duration) return [];
  if (duration.enum) return duration.enum;
  if (duration.minValue !== undefined && duration.maxValue !== undefined && duration.step) {
    const values = [];
    for (let v = duration.minValue; v <= duration.maxValue; v += duration.step) values.push(v);
    return values;
  }
  if (duration.default) return [duration.default];
  return [];
};

export const getResolutionsForVideoModel = (modelId) => enumOf(getVideoModelById(modelId), 'resolution') || [];
export const getResolutionsForI2VModel = (modelId) => enumOf(getI2VModelById(modelId), 'resolution') || [];
export const getResolutionsForLipSyncModel = (id) => enumOf(getLipSyncModelById(id), 'resolution') || [];

// Quality and resolution are the same control under two provider spellings, so
// the studio asks which field a model wants before reading its options.
const qualityField = (model) => {
  if (!model) return null;
  if (model.inputs?.resolution) return 'resolution';
  if (model.inputs?.quality) return 'quality';
  return null;
};
const qualityOptions = (model) => {
  if (!model) return [];
  return model.inputs?.resolution?.enum || model.inputs?.quality?.enum || [];
};

export const getQualityFieldForModel = (modelId) => qualityField(getModelById(modelId));
export const getQualityFieldForI2IModel = (modelId) => qualityField(getI2IModelById(modelId));
export const getResolutionsForModel = (modelId) => qualityOptions(getModelById(modelId));
export const getResolutionsForI2IModel = (modelId) => qualityOptions(getI2IModelById(modelId));

// Effect-style models declare `inputs.name` as an enum of effect types.
export const getEffectsForI2VModel = (modelId) => enumOf(getI2VModelById(modelId), 'name') || [];
export const getDefaultEffectForI2VModel = (modelId) => getI2VModelById(modelId)?.inputs?.name?.default || null;
export const getEffectsForI2IModel = (modelId) => enumOf(getI2IModelById(modelId), 'name') || [];
export const getDefaultEffectForI2IModel = (modelId) => getI2IModelById(modelId)?.inputs?.name?.default || null;

export const getModesForModel = (modelId) => {
  const model = byId(t2vModels, modelId) || byId(i2vModels, modelId);
  return enumOf(model, 'mode') || [];
};

export const getMaxImagesForI2IModel = (modelId) => getI2IModelById(modelId)?.maxImages || 1;

// A model with a `last_image` field takes two pictures — a start and an end —
// even when it declares no explicit count.
export const getMaxImagesForI2VModel = (modelId) => {
  const model = getI2VModelById(modelId);
  if (!model) return 1;
  if (model.maxImages) return model.maxImages;
  if (model.lastImageField) return 2;
  return 1;
};
