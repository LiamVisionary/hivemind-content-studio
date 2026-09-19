// The Video studio's models, in the shared "where does this run" vocabulary.
//
// Video is the one studio whose model list cannot simply come from the server
// catalog: the lane's registry is richer than the catalog's video block (tier
// pairs, LoRA variants, v2v tools), and the transitions that select a model
// need the catalog ENTRY, not a row. So the studio's own list stays the source
// of truth for what exists, and this module answers the other half — which
// place each of those models runs in, and which places cannot serve a clip at
// all yet.
//
// The result is the same target shape every other picker uses, so the readout,
// the grouping and the Automatic ladder are literally the same code.
import { PLACE_ACCOUNTS, PLACE_HIVEMINDOS, buildRunTargets } from '../../lib/runTargets.js';
import { clipRouteFor, placeFor, placeLabelFor } from '../../lib/modelRunner.js';
import { isHivemindVideoModelId } from '../../lib/hivemindModelIds.js';
import { i2vModels, t2vModels, v2vModels } from '../../lib/cloudCatalog.js';
import { getLocalModelById, isWan2gpModelId } from '../../lib/localModels.js';

/** Which account or machine a video model belongs to. The studio's lists are
 *  keyed by id alone, so this is where an id becomes a routing identity. */
export function videoProviderFor(model) {
  const id = String(model?.id || '');
  if (isHivemindVideoModelId(id)) return { provider: 'media-studio-mcp', source: 'cloud' };
  if (isWan2gpModelId(id)) return { provider: 'wan2gp', source: 'local' };
  // Everything else in the studio's generation lists is the vendored MUAPI
  // catalog, billed to the owner's MUAPI account.
  return { provider: 'muapi', source: 'cloud' };
}

/**
 * What one video model starts from, in the shared capability words.
 *
 * MODE-BLIND, and that is the whole contract. The picker's list is scoped to
 * the current mode (generationModelsFor) — with a start frame attached it is
 * the i2v list and nothing else — so reading a capability off which list a
 * model happens to be in right now answers the question "is a frame attached",
 * not "what can this model do". videoLogic.js carries the same warning over
 * resolveVideoModel, for the same bug.
 *
 * Four inventories, four answers, none of them guessed:
 *   the v2v tools        start from footage and take no prompt
 *   MUAPI                is bucketed t2v / i2v by the catalog itself
 *   Wan2GP               declares `needsImage` per local model
 *   the lane registry    lists the graph's own inputs, which is where the
 *                        studio already reads every other capability from
 */
export function videoModelCapabilities(model) {
  const id = String(model?.id || '');
  if (!id) return null;
  if (v2vModels.some((tool) => String(tool?.id) === id)) return ['video-to-video'];
  if (isHivemindVideoModelId(id)) {
    // A local lane is text-to-video first — H3 with no start frame is the
    // studio's most common run — and takes what its graph wires on top. The
    // flags are the registry mapper's; this never re-reads `accepts` itself,
    // so a capability added there arrives here already named.
    const capabilities = ['text-to-video'];
    if (model.supportsStartFrame || model.supportsReferenceImages) capabilities.push('image-to-video');
    if (model.supportsVideoInput || model.supportsHeadReplacement) capabilities.push('video-to-video');
    return capabilities;
  }
  if (isWan2gpModelId(id)) {
    return [getLocalModelById(id)?.needsImage ? 'image-to-video' : 'text-to-video'];
  }
  if (i2vModels.some((entry) => String(entry?.id) === id)) return ['image-to-video'];
  if (t2vModels.some((entry) => String(entry?.id) === id)) return ['text-to-video'];
  // A model no inventory here claims stays untyped rather than being called
  // text-to-video by default — an unbadged row is honest, a wrong badge is not.
  return null;
}

/**
 * The studio's own models as run targets, plus the places a clip cannot reach.
 *
 * The server catalog's HivemindOS-hosted and own-account video providers are
 * real for STILLS and have no clip route yet (the Media Studio lane serves its
 * own workflows and nothing else). Offering them as rows whose Generate can
 * only fail is the thing this whole item exists to stop, so they are omitted
 * and named in `unreachable` — the panel says so in one line instead.
 */
export function videoRunTargets({
  models = [], tools = [], catalogProviders = [], machines = null, pinned = '',
} = {}) {
  const byProvider = new Map();
  for (const model of [...models, ...tools]) {
    const { provider } = videoProviderFor(model);
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider).push({
      id: model.id,
      label: model.name || model.id,
      name: model.name || model.id,
      family: model.workflowFamily || '',
      // What it starts from, so the picker can badge and filter it. The video
      // studio's rows used to carry nothing but a name and a family, which is
      // why its picker was the one with no badges at all.
      capabilities: videoModelCapabilities(model),
      // What the lane must run on, so a rented box is never offered a lane it
      // physically cannot execute (the Apple-silicon H3 engine).
      accelerator: model.accelerator || '',
    });
  }
  const targets = buildRunTargets({
    kind: 'video',
    localModels: (byProvider.get('wan2gp') || []).map((model) => ({ ...model, provider: 'wan2gp' })),
    catalogProviders: [...byProvider.entries()]
      .filter(([provider]) => provider !== 'wan2gp')
      .map(([provider, list]) => ({ id: provider, available: true, models: list })),
    machines,
    pinned,
  });

  // Named by PLACE, never by provider id: "HivemindOS credits", not
  // "hivemindos-hosted-media".
  const unreachable = [];
  for (const provider of catalogProviders || []) {
    const row = { id: '', provider: String(provider?.id || ''), source: 'cloud' };
    const place = placeFor(row);
    if (place !== PLACE_HIVEMINDOS && place !== PLACE_ACCOUNTS) continue;
    if (clipRouteFor(row).transport !== 'none') continue;
    const label = placeLabelFor(row);
    if (label && !unreachable.includes(label)) unreachable.push(label);
  }
  return { targets, unreachable };
}
