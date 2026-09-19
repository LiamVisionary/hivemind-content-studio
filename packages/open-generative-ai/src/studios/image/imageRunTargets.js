// The Image studio's models, in the shared "where does this run" vocabulary.
//
// Two inventories have to be joined, and they are two lists rather than one.
// The MUAPI catalog is dozens of models that the server's MEDIA catalog lists
// only a curated handful of, and it is what this studio has always offered on
// its cloud side — reading the media catalog alone would take models away
// rather than add places. So MUAPI's rows come from the cloud catalog, and
// every OTHER provider — HivemindOS credits, a connected ChatGPT or xAI
// account, Higgsfield — comes from the media catalog, which is what makes
// those places reachable from here at all. Until now they were readable only
// by Story and Sprite.
//
// Both lists are served now (the MUAPI half was a vendored copy until
// 2026-09-04), so these are live bindings read at call time. Every caller
// renders behind App.jsx's `withCloudCatalog` gate, so the rows have landed.
import { i2iModels, t2iModels } from '../../lib/cloudCatalog.js';
import { buildRunTargets } from '../../lib/runTargets.js';

/**
 * An image model the studio's own cloud catalog knows, deduplicated: a model
 * with both a text-to-image and an editing row is one model.
 *
 * The two buckets are also the one honest answer to what that model starts
 * from, and it is the answer this studio has always routed by (see
 * ImageStudio's apiModelSupportsImage / apiModelRequiresImage): a row in the
 * editing list takes a picture, and one that is ONLY there requires it. That
 * is 54 of the 107 rows — every upscaler, background remover and colorizer,
 * against 50 a prompt alone reaches and 3 that do both — and until this
 * carried it through, the picker offered them all as the same grey names.
 *
 * Inferring the same thing from the media catalog's `reference_roles` would be
 * wrong and was not done: `nano-banana-pro-edit` declares a reference role and
 * is edit-only, so roles would have labelled an image-to-image model as one a
 * prompt alone can reach.
 */
export function studioCloudImageModels() {
  const seen = new Map();
  for (const [capability, list] of [['text-to-image', t2iModels], ['image-to-image', i2iModels]]) {
    for (const model of list) {
      if (!model?.id) continue;
      const known = seen.get(model.id);
      if (known) { known.capabilities.push(capability); continue; }
      seen.set(model.id, {
        id: model.id,
        label: model.name || model.id,
        family: model.family || '',
        capabilities: [capability],
      });
    }
  }
  return [...seen.values()];
}

/**
 * Every place an image could be made, joined.
 *
 * @param {object} options
 * @param {Array} options.localModels this browser's discovered local workflows
 * @param {Array} options.catalogProviders the server's media catalog, image half
 * @param {object} options.machines rentedMachinesState()
 * @param {string} options.pinned this tab's run_on pin
 */
export function imageRunTargets({
  localModels = [], catalogProviders = [], machines = null, pinned = '', ratings = null,
} = {}) {
  // The server's own MUAPI row, for what it knows that this list does not:
  // whether the key is set, which key that is, and the sentence it wrote about
  // it. Only the MODELS come from the studio's catalog; hardcoding the rest was
  // how the same model came to be offered here and refused in Sprite.
  const served = (catalogProviders || []).find((provider) => String(provider?.id || '') === 'muapi') || null;
  const providers = [
    // MUAPI from the studio's own catalog — the full list, not the catalog's
    // curated four.
    { ...(served || {}), id: 'muapi', models: studioCloudImageModels() },
    ...(catalogProviders || []).filter((provider) => String(provider?.id || '') !== 'muapi'),
  ];
  return buildRunTargets({
    kind: 'image', localModels, catalogProviders: providers, machines, pinned, ratings,
  });
}
