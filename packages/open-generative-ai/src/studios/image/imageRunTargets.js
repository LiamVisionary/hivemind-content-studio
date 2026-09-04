// The Image studio's models, in the shared "where does this run" vocabulary.
//
// Two inventories have to be joined and only one of them is the server's. The
// vendored MUAPI catalog (src/lib/models.js) is dozens of models the server's
// media catalog lists only a curated handful of, and it is what this studio has
// always offered on its cloud side — dropping it to read the catalog alone
// would take models away rather than add places. So MUAPI's rows come from the
// studio's own catalog, and every OTHER provider — HivemindOS credits, a
// connected ChatGPT or xAI account, Higgsfield — comes from the server's,
// which is what makes those places reachable from here at all. Until now they
// were readable only by Story and Sprite.
import { i2iModels, t2iModels } from '../../lib/models.js';
import { buildRunTargets } from '../../lib/runTargets.js';

/** An image model the studio's own cloud catalog knows, deduplicated: a model
 *  with both a text-to-image and an editing row is one model. */
export function studioCloudImageModels() {
  const seen = new Map();
  for (const model of [...t2iModels, ...i2iModels]) {
    if (!model?.id || seen.has(model.id)) continue;
    seen.set(model.id, { id: model.id, label: model.name || model.id, family: model.family || '' });
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
  const providers = [
    // MUAPI from the studio's own catalog — the full list, not the catalog's
    // curated four.
    { id: 'muapi', available: true, models: studioCloudImageModels() },
    ...(catalogProviders || []).filter((provider) => String(provider?.id || '') !== 'muapi'),
  ];
  return buildRunTargets({
    kind: 'image', localModels, catalogProviders: providers, machines, pinned, ratings,
  });
}
