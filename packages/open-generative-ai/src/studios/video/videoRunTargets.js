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
import { isWan2gpModelId } from '../../lib/localModels.js';

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
