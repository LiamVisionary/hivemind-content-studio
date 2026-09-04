// One answer to "where does this run, and who pays for it".
//
// The studio used to ask that question four different ways. Image and Video
// showed a Local / API / Rented segmented control; the text producer showed
// sections named This machine / HivemindOS / Your accounts; Story and Sprite
// showed a provider caption with no notion of place at all; Restore had its own
// lane list. Five vocabularies — "API", "cloud", "Hivemind local", "This
// machine", "Rented" — for three real choices, and a user moving between
// studios had to learn each one.
//
// There are three places, and they are three BILLS:
//
//   This Mac            free, private, as fast as the hardware
//   HivemindOS credits  one balance, the same one the HivemindOS app spends
//   Your accounts       billed by a provider to an account you already pay for
//
// A rented GPU is deliberately NOT a fourth place. Mechanically it never was
// one: the studio's own comments say "Rented is local mechanically — the lane
// rules route by model server-side", and the media gateway already sends a
// generation to an attached box when its needles match the model, whether or
// not any mode was chosen. So a rental is a PROPERTY of This Mac — the machine
// this Mac's work is currently landing on — shown as "Runs on: RTX 5090 ·
// $0.42/hr" with the per-tab pin behind it as the override.
//
// This module holds the vocabulary, the joins and the ladder. It renders
// nothing and fetches nothing, so both the picker and the tests apply exactly
// the rules the studio applies.
import {
  PLACE_ACCOUNTS, PLACE_HIVEMINDOS, PLACE_THIS_MAC, clipRouteFor, placeFor, placeLabelFor, transportFor,
} from './modelRunner.js';
import { attachedOrder, machineServesModel, withPin } from './rentedMachines.js';

export { PLACE_ACCOUNTS, PLACE_HIVEMINDOS, PLACE_THIS_MAC };

/**
 * The three groups, in the order the list shows them — cheapest and most
 * private first. Deliberately the same shape and the same order as
 * textModels.SECTIONS, because they describe the same three bills; the labels
 * differ only where "This machine" reads better as "This Mac" beside a rented
 * GPU's name.
 */
export const RUN_PLACES = Object.freeze([
  Object.freeze({
    id: PLACE_THIS_MAC,
    label: 'This Mac',
    blurb: 'Free, private, and as fast as the hardware — nothing leaves the machine.',
  }),
  Object.freeze({
    id: PLACE_HIVEMINDOS,
    label: 'HivemindOS credits',
    blurb: 'One balance of HivemindOS credits — the same one the HivemindOS app spends.',
  }),
  Object.freeze({
    id: PLACE_ACCOUNTS,
    label: 'Your accounts',
    blurb: 'Billed by the provider to an account you already pay for. No HivemindOS credits spent.',
  }),
]);

export const placeMeta = (placeId) => RUN_PLACES.find((place) => place.id === placeId) || null;

/** The rental a generation with this model would actually land on, honouring
 *  THIS TAB's pin — the same ordering the gateway applies to its requests. */
export function machineForModel(machines, model, pinned = '') {
  const known = [...(machines?.live || []), ...(machines?.idle || []), ...(machines?.broken || [])];
  const ordered = attachedOrder(withPin(known, pinned));
  return ordered.find((machine) => machine.attached && machine.tunnel_alive && machineServesModel(machine, model)) || null;
}

const hourly = (machine) => `$${(Number(machine?.usd_per_hour) || 0).toFixed(2)}/hr`;

/**
 * One selectable run target.
 *
 * `id`/`provider`/`source` are the routing identity modelRunner dispatches on,
 * unchanged — this module never invents a route. Everything else is what a
 * person reads.
 */
function makeTarget({
  id, provider, source, label, rating = '', ratingReason = '', accepts = null, family = '', available = true,
  machines = null, pinned = '', kind = 'image',
}) {
  const row = { id, provider, source, accepts, family };
  const place = placeFor(row);
  const route = kind === 'video' ? clipRouteFor(row) : transportFor(row);
  const machine = place === PLACE_THIS_MAC ? machineForModel(machines, { id, name: label }, pinned) : null;
  return {
    key: `${place || 'unknown'}:${provider}:${id}`,
    id,
    provider,
    source,
    label,
    family,
    accepts,
    place,
    // The ONE display label for where this runs. When a rental serves the
    // model, the machine IS the place: "This Mac" would be a true sentence
    // about the lane and a false one about the hardware doing the work.
    placeLabel: machine ? (machine.gpu || 'Rented GPU') : placeLabelFor(row),
    machine,
    rating,
    ratingReason,
    // A row is offered only when this studio can actually reach it. The video
    // side is the strict one: the Media Studio lane serves its own workflows
    // and nothing else, so a Higgsfield clip has no route yet and says so
    // rather than being offered as a row whose Generate can only fail.
    ready: available !== false && route.runnable,
    reason: route.runnable ? '' : route.reason,
    transport: route.transport,
  };
}

/**
 * Every place a generation of this kind could run, joined from the four
 * inventories that answer the question between them.
 *
 * @param {object} options
 * @param {'image'|'video'} options.kind
 * @param {Array} options.localModels this browser's own catalog (sd.cpp, Wan2GP)
 * @param {Array} options.catalogProviders `/api/simple/catalog`'s media[kind]
 * @param {object} options.machines rentedMachinesState()
 * @param {string} options.pinned this tab's run_on pin
 * @param {Map|null} options.ratings key -> {rating, reason} from the capability matrix
 */
export function buildRunTargets({
  kind = 'image', localModels = [], catalogProviders = [], machines = null, pinned = '', ratings = null,
} = {}) {
  const rated = (target) => {
    const verdict = ratings?.get(`${target.provider}:${target.id}`) || null;
    return verdict ? { ...target, rating: verdict.rating || '', ratingReason: verdict.reason || '' } : target;
  };
  const local = (localModels || []).map((model) => rated(makeTarget({
    id: model.id,
    provider: model.provider || 'sdcpp',
    source: 'local',
    label: model.name || model.label || model.id,
    family: model.family || '',
    accepts: model.accepts || null,
    machines,
    pinned,
    kind,
  })));
  const cloud = [];
  for (const provider of catalogProviders || []) {
    const providerId = String(provider?.id || '');
    if (!placeFor({ provider: providerId, source: 'cloud' })) continue;
    for (const model of provider?.models || []) {
      const modelId = String(model?.id || '');
      if (!modelId) continue;
      cloud.push(rated(makeTarget({
        id: modelId,
        provider: providerId,
        source: 'cloud',
        label: String(model.label || model.name || modelId),
        family: String(model.family || ''),
        accepts: Array.isArray(model.accepts) ? model.accepts : null,
        available: provider.available !== false,
        machines,
        pinned,
        kind,
      })));
    }
  }
  return [...local, ...cloud];
}

/**
 * Run targets from rows an inventory has ALREADY rated and filtered.
 *
 * The media catalog is not the only inventory. Story and Sprite rank the
 * capability matrix's own rows per feature (which drops sentinels and carries
 * the evidence behind each verdict), and Restore is handed lanes by the
 * gateway. Those studios used to answer "where does this run" with a control of
 * their own because their rows did not come from `buildRunTargets`; this is the
 * adapter, so the ROWS stay theirs and the vocabulary stops being.
 *
 * A row that already knows it cannot run wins over the transport table: a
 * studio knows constraints the table does not — a sealed sprite that can only
 * be animated on this machine, a lane with no SeedVR2 nodes — and re-deriving
 * `ready` here would offer a press that can only fail.
 */
export function runTargetsFromRows(rows, { kind = 'image', machines = null, pinned = '' } = {}) {
  return (rows || []).map((row) => {
    const target = makeTarget({
      id: String(row.id ?? row.model ?? ''),
      provider: String(row.provider || ''),
      source: row.source || 'cloud',
      label: String(row.label || row.model_label || row.name || row.id || ''),
      family: String(row.family || ''),
      accepts: Array.isArray(row.accepts) ? row.accepts : null,
      rating: row.rating || '',
      ratingReason: row.reason || '',
      available: row.available !== false,
      machines,
      pinned,
      kind,
    });
    // A row that names its own place is not a catalogued model: Restore's lanes
    // are places the GATEWAY named, and asking the transport table about them
    // would refuse every one of them for having no provider.
    const declared = Boolean(row.place);
    const blocked = row.available === false;
    return {
      ...target,
      // How the verdict was arrived at travels with the row: a picker that
      // shows a rating has to be able to say where the rating came from.
      evidence: row.evidence || '',
      ...(declared ? { place: row.place, placeLabel: row.placeLabel || target.placeLabel } : {}),
      ...(row.badge ? { badge: row.badge } : {}),
      ready: declared ? !blocked : (blocked ? false : target.ready),
      reason: blocked && row.unavailableReason ? row.unavailableReason : (declared ? '' : target.reason),
    };
  });
}

/** The list as the picker shows it: three groups, empty ones dropped. There is
 *  no fourth group — a rental rides on its This Mac row. */
export function groupRunTargets(targets) {
  return RUN_PLACES
    .map((place) => ({ ...place, targets: (targets || []).filter((target) => target.place === place.id) }))
    .filter((group) => group.targets.length > 0);
}

const GOOD_ENOUGH = new Set(['good', 'workable']);

/** A rating good enough to lead with. No rating at all counts: a picker with no
 *  feature id has nothing to rate against, and refusing every row on that basis
 *  would leave a fresh install with no default. */
const wellRated = (target) => !target.rating || GOOD_ENOUGH.has(target.rating);

/**
 * The Automatic default, and the one line that explains it.
 *
 * The ladder is the text producer's, applied to media: a model already runnable
 * here wins because it is free, private and answers now; then HivemindOS
 * credits WHEN they are configured, because that is the house default; then an
 * account the owner has actually connected; then one whose key is present; and
 * a rented box last, because it is the only rung that costs by the hour whether
 * or not anything is generating.
 *
 * Returns `{ target, reason }` — never a bare model id, because a default
 * nobody can see the reasoning for is the thing this replaces.
 */
export function pickRunTarget(kind = 'image', { catalog = [], machines = null, readiness = {} } = {}) {
  const ready = (catalog || []).filter((target) => target.ready);
  const none = { target: null, reason: '' };
  if (!ready.length) return none;

  const onThisMac = ready.filter((target) => target.place === PLACE_THIS_MAC);
  const unrented = onThisMac.filter((target) => !target.machine);
  const localPick = unrented.find(wellRated);
  if (localPick) return { target: localPick, reason: 'free, stays on this Mac' };

  if (readiness?.hivemindosCredits) {
    const hosted = ready.find((target) => target.place === PLACE_HIVEMINDOS);
    if (hosted) return { target: hosted, reason: 'on your HivemindOS credits' };
  }

  const connected = new Set(readiness?.connectedProviders || []);
  const account = ready.find((target) => target.place === PLACE_ACCOUNTS && connected.has(target.provider));
  if (account) return { target: account, reason: `on ${account.placeLabel.toLowerCase()}` };

  const keyed = new Set(readiness?.keyedProviders || []);
  const keyedPick = ready.find((target) => target.place === PLACE_ACCOUNTS && keyed.has(target.provider));
  if (keyedPick) return { target: keyedPick, reason: `on ${keyedPick.placeLabel.toLowerCase()}` };

  const rented = onThisMac.find((target) => target.machine);
  if (rented) {
    return { target: rented, reason: `on the ${rented.machine.gpu || 'GPU'} you are renting, ${hourly(rented.machine)}` };
  }

  // Nothing on any rung — a local model that exists but is unrated, or a
  // provider that is up with no credential. Still a real answer: better a row
  // with its state on it than an empty picker.
  const fallback = unrented[0] || ready[0];
  return fallback ? { target: fallback, reason: fallback.place === PLACE_THIS_MAC ? 'free, stays on this Mac' : '' } : none;
}

/**
 * The compact readout: "Runs on: This Mac · Z-Image Turbo — free, stays here".
 *
 * Returned in parts so the component can weight them; joined by `readoutText`
 * for the places that want one string (a title attribute, a test).
 */
export function runOnReadout(target, { reason = '', automatic = false } = {}) {
  if (!target) {
    return { place: 'Nowhere yet', model: '', note: 'No model here can run this yet', automatic: false };
  }
  const note = target.machine
    ? hourly(target.machine)
    : (reason || (target.place === PLACE_THIS_MAC ? 'free, stays here' : ''));
  return { place: target.placeLabel || 'This Mac', model: target.label, note, automatic: Boolean(automatic) };
}

export function readoutText(readout) {
  // Said once. Some rows ARE their place — Restore's local lane is "This
  // computer" running on this computer — and "This computer · This computer"
  // reads as a bug rather than as an answer.
  const parts = readout.model && readout.model !== readout.place
    ? [readout.place, readout.model]
    : [readout.place];
  const head = parts.filter(Boolean).join(' · ');
  return readout.note ? `${head} — ${readout.note}` : head;
}

/**
 * Which targets the machine pinned to this tab can actually serve.
 *
 * The one copy of this filter. It used to exist three times — the image model
 * menu, the video model menu and the send-to resolver each narrowed their own
 * list — and a rule with three implementations is a rule with three answers.
 */
export function servedByPinnedMachine(targets, machines, pinned) {
  if (!pinned) return targets || [];
  const known = [...(machines?.live || []), ...(machines?.idle || []), ...(machines?.broken || [])];
  const machine = known.find((entry) => entry.rental_id === pinned && entry.attached);
  if (!machine) return targets || [];
  return (targets || []).filter((target) => target.place !== PLACE_THIS_MAC
    || machineServesModel(machine, { id: target.id, name: target.label }));
}
