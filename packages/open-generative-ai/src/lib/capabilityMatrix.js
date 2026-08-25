// Which models are FIT for a studio feature — the browser half.
//
// The verdicts themselves live in ONE place, src/hivemind_content_studio/
// capability_matrix.py, and travel here over /api/capabilities/matrix. This
// module does not hold opinions; it applies the ones it was sent.
//
// Two inventories have to be rated and only one of them is the server's. The
// media catalog (cloud providers, Media Studio workflows) is joined server-side
// and arrives as `rows`. The LOCAL image models — sd.cpp checkpoints on this
// disk, a Wan2GP server the owner runs — are a browser-side catalog the server
// has never heard of (src/lib/localModels.js), so the raw `rules` come along
// and get applied here against exactly the same declarations. Writing a second
// table of "which model draws a good sprite" in JS is the failure mode this
// shape exists to prevent.

// Best first. Mirrors RATING_ORDER in the Python module; the server ships its
// own copy in `ratings` and that one wins whenever it is present.
const FALLBACK_RATING_ORDER = ['good', 'workable', 'unmeasured', 'poor', 'unsupported'];

const UNRATED = {
  rating: 'unmeasured',
  reason: 'Nobody has run this model through this feature here.',
  evidence: 'none',
};

export const RATING_LABELS = {
  good: 'Good fit',
  workable: 'Workable',
  unmeasured: 'Untried here',
  poor: 'Poor fit',
  unsupported: 'Cannot run this',
};

/** How a verdict was arrived at, spelled out. The matrix would otherwise
 *  present an inference and a measured run in the same typeface. */
export const EVIDENCE_LABELS = {
  measured: 'Measured on this machine',
  reported: 'Reported by you after a run',
  contract: 'From the model’s own schema',
  reasoned: 'Inferred from what the model is — not from a run',
  none: 'Nobody has tried it here',
};

export async function fetchCapabilityMatrix({ signal = null } = {}) {
  const response = await fetch('/api/capabilities/matrix', { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error('Could not read the capability matrix.');
  return response.json();
}

export function featureOf(matrix, featureId) {
  return (matrix?.features || []).find((feature) => feature.id === featureId) || null;
}

/** The declared verdict for one model, most-specific match first:
 *  model id, then registry family, then provider. Same order as the server. */
export function ruleFor(feature, model) {
  const rules = feature?.rules || [];
  const keys = [
    `model:${model?.id ?? ''}`,
    model?.family ? `family:${model.family}` : '',
    `provider:${model?.provider ?? ''}`,
  ];
  for (const key of keys) {
    if (!key.endsWith(':')) {
      const hit = rules.find((rule) => rule.match === key);
      if (hit) return hit;
    }
  }
  return null;
}

/** Why the live inventory says this model cannot run the feature at all.
 *  Derived from what the model declares it accepts, never declared here — a
 *  model that gains an input stops being refused with no edit to this file.
 *  An EMPTY accepts list means "not read", not "no inputs": refusing on that
 *  would tell the owner their models cannot do this whenever a registry read
 *  blinks. */
export function structuralReason(feature, model) {
  const accepts = new Set(Array.isArray(model?.accepts) ? model.accepts.map(String) : []);
  if (!accepts.size) return '';
  for (const group of feature?.requires_any || []) {
    if (!group.some((field) => accepts.has(String(field)))) {
      return `The workflow declares no ${group.join(' / ')} input, so it cannot start from your sprite.`;
    }
  }
  return '';
}

/** Rate one model against one feature. `model` is {id, provider, family, accepts}
 *  — the shape both catalogs can produce. */
export function rateModel(feature, model, { unmatched = UNRATED } = {}) {
  const blocked = structuralReason(feature, model);
  if (blocked) return { rating: 'unsupported', reason: blocked, evidence: 'contract' };
  const rule = ruleFor(feature, model);
  if (rule) return { rating: rule.rating, reason: rule.reason, evidence: rule.evidence };
  return { ...unmatched };
}

/**
 * The identity of a catalogued model. The id alone is NOT unique: the catalog
 * lists gpt-image-2 under both the OpenAI API-key and OAuth providers,
 * grok-imagine-image under two xAI providers, and "automatic" under the hosted
 * provider for both media kinds. Keying a list on the id collides — React drops
 * or duplicates rows — and selecting one entry highlights its twin.
 */
export function modelKey(model) {
  return `${model?.source || 'catalog'}:${model?.provider ?? ''}:${model?.id ?? ''}`;
}

export function ratingOrder(matrix) {
  const ratings = Array.isArray(matrix?.ratings) && matrix.ratings.length ? matrix.ratings : FALLBACK_RATING_ORDER;
  return new Map(ratings.map((rating, index) => [rating, index]));
}

/**
 * Rate a list of models and sort them best-first. Within one rating, anything
 * that is not ready to run right now sinks: a `good` rating on an offline
 * provider is still a good rating, but it must not sit at the top of a picker
 * as if pressing it would generate something.
 * @param {object} matrix the payload from fetchCapabilityMatrix
 * @param {string} featureId
 * @param {Array<{id:string, label?:string, provider?:string, family?:string, accepts?:string[], available?:boolean}>} models
 */
export function rankModels(matrix, featureId, models) {
  const feature = featureOf(matrix, featureId);
  if (!feature) return [];
  const order = ratingOrder(matrix);
  const unmatched = matrix?.unmatched || UNRATED;
  return (models || [])
    .map((model) => {
      const verdict = rateModel(feature, model, { unmatched });
      return {
        ...model,
        ...verdict,
        key: modelKey(model),
        available: model.available !== false,
        label: model.label || model.name || model.id,
      };
    })
    .sort((left, right) => (
      (order.get(left.rating) ?? 9) - (order.get(right.rating) ?? 9)
      || Number(right.available) - Number(left.available)
      || String(left.label).toLowerCase().localeCompare(String(right.label).toLowerCase())
    ));
}

/** The server-joined rows for a feature (cloud providers, Media Studio
 *  workflows), already rated and ranked upstream. */
export function serverRows(matrix, featureId) {
  return featureOf(matrix, featureId)?.rows || [];
}

/** The single model to pre-select: best rating that is actually ready. Falls
 *  back to the first entry rather than leaving a picker empty — an offline
 *  best pick is still the right thing to show, with its status next to it. */
export function defaultPick(ranked) {
  return ranked.find((row) => row.available && (row.rating === 'good' || row.rating === 'workable'))
    || ranked.find((row) => row.rating !== 'unsupported')
    || ranked[0]
    || null;
}
