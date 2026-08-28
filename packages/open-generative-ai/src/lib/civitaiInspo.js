// The inspiration finder's vocabulary, and the one translation that matters:
// somebody else's Civitai generation metadata turned into a studio setup.
//
// The finder browses what people MADE (civitai /images), not what they publish
// to install (civitai /models — that is modelLibrary.js and the Discover tab).
// Everything here is shaped by one fact about that endpoint: a prompt is not
// guaranteed. The gateway drops the ones with nothing reusable, so anything
// arriving here has a prompt; what is still optional is every OTHER field, and
// the setup mapping below has to carry that through without inventing values.

export const INSPO_KINDS = [
  { value: 'image', label: 'Images', zh: '图片' },
  { value: 'video', label: 'Videos', zh: '视频' },
];

// Civitai's own sort vocabulary for /images — NOT the /models one (which has
// "Most Downloaded" and would 400 here).
export const INSPO_SORTS = ['Most Reactions', 'Most Comments', 'Newest', 'Random'];
export const INSPO_PERIODS = ['Day', 'Week', 'Month', 'Year', 'AllTime'];

// Safe by default, matching the model browser: explicit imagery in a work tool
// is something to opt into, not out of.
export const DEFAULT_INSPO_FILTERS = {
  kind: 'image',
  baseModels: '',
  sort: 'Most Reactions',
  period: 'Week',
  nsfw: 'false',
  limit: '24',
};

export function inspoSearchParams(filters, cursor = '') {
  const params = { type: filters?.kind === 'video' ? 'video' : 'image' };
  for (const key of ['baseModels', 'sort', 'period', 'limit']) {
    if (filters?.[key]) params[key] = filters[key];
  }
  const username = String(filters?.username || '').trim();
  if (username) params.username = username;
  // Empty means "whatever Civitai defaults to" — only an explicit choice is sent.
  if (filters?.nsfw === 'true' || filters?.nsfw === 'false') params.nsfw = filters.nsfw;
  const next = String(cursor || '').trim();
  if (next) params.cursor = next;
  return params;
}

// A later page appended to what is already shown, without repeating an id
// Civitai handed back on both sides of a page boundary.
export function mergeInspoResults(existing, incoming) {
  const seen = new Set((existing || []).map((item) => String(item?.id)));
  const added = (incoming || []).filter((item) => {
    const key = String(item?.id);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...(existing || []), ...added];
}

/** Which studio a result belongs in. Video results carry motion prompts that a
 *  still-image model has no lane for, so they go to the Video studio. */
export function inspoSection(item) {
  return item?.kind === 'video' ? 'video' : 'image';
}

const POSITIVE_INTEGER = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
};

/**
 * A Civitai result as a studio setup payload.
 *
 * Deliberately partial. registerStudioSetupLoader in each studio fills every
 * field it is not given from what the studio already holds, so a missing
 * `steps` here means "keep yours", not "reset to zero" — which is why every
 * optional number is dropped rather than defaulted. The one thing always
 * present is the prompt, because that is what the gateway filtered for.
 *
 * The MODEL is never carried over: the id is Civitai's, it names a checkpoint
 * this machine very likely does not have, and handing a studio a model id it
 * cannot resolve is how a restored setup silently lands on the wrong lane.
 * The model name travels as a note on the card instead.
 */
export function inspoToStudioSetup(item) {
  const setup = { primaryPrompt: String(item?.prompt || '') };
  const negative = String(item?.negativePrompt || '').trim();
  if (negative) setup.negativePrompt = negative;

  const steps = POSITIVE_INTEGER(item?.steps);
  if (steps) setup.steps = steps;

  const cfg = Number(item?.cfgScale);
  if (Number.isFinite(cfg) && cfg > 0) setup.cfg = cfg;

  // Seed 0 is a legitimate seed, so this checks for a number rather than for
  // truthiness. A negative seed means "random" and is left to the studio.
  const seed = Number(item?.seed);
  if (Number.isFinite(seed) && seed >= 0) setup.seed = seed;

  const width = POSITIVE_INTEGER(item?.width);
  const height = POSITIVE_INTEGER(item?.height);
  if (width && height) {
    setup.width = width;
    setup.height = height;
  }
  return setup;
}

/** The "made with" line under a card: base model, or the checkpoint the
 *  uploader recorded, plus any LoRAs Civitai resolved. */
export function inspoCredits(item) {
  const parts = [];
  if (item?.baseModel) parts.push(item.baseModel);
  else if (item?.modelName) parts.push(item.modelName);
  const loras = (item?.resources || []).filter((entry) => String(entry?.type || '').toLowerCase() === 'lora');
  if (loras.length) parts.push(`${loras.length} LoRA${loras.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** Settings worth showing on a card, in the order a generator reads them. */
export function inspoSettings(item) {
  return [
    ['Steps', item?.steps],
    ['CFG', item?.cfgScale],
    ['Sampler', item?.sampler],
    ['Seed', item?.seed],
    ['Clip skip', item?.clipSkip],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');
}
