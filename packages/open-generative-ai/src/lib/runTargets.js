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
// It IS a fourth tab (RUN_TABS, below), and those are different claims. The
// place is what routes and what bills; the tab is only what a person is asked
// to choose between, and "runs on silicon you own" and "runs on a box costing
// $0.42 every hour it stays attached" are not one question with one answer.
//
// This module holds the vocabulary, the joins and the ladder. It renders
// nothing and fetches nothing, so both the picker and the tests apply exactly
// the rules the studio applies.
import { t } from './i18n.js';
import { localModelSupportsImageInput } from './localImageModelFilter.js';
import {
  PLACE_ACCOUNTS, PLACE_HIVEMINDOS, PLACE_THIS_MAC, clipRouteFor, credentialLabelFor, needsBrowserKey, placeFor,
  placeLabelFor, transportFor,
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
    label: t('place.thisMac'),
    blurb: t('place.thisMacBlurb'),
  }),
  Object.freeze({
    id: PLACE_HIVEMINDOS,
    label: t('place.hivemindos'),
    blurb: t('place.hivemindosBlurb'),
  }),
  Object.freeze({
    id: PLACE_ACCOUNTS,
    label: t('place.accounts'),
    blurb: t('place.accountsBlurb'),
  }),
]);

export const placeMeta = (placeId) => RUN_PLACES.find((place) => place.id === placeId) || null;

/**
 * The rented box, as a TAB.
 *
 * Not a fourth place: `place` is the routing identity and the bill, and a
 * rental is still This Mac's — the gateway routes it by lane, the pin is per
 * tab, and `PLACE_THIS_MAC` is what every caller dispatches on. What changes
 * here is only what a person is asked to choose between. Stacked in one list,
 * the models this Mac runs on its own silicon and the ones it can only run on a
 * box billed by the hour were the same grey rows with a different name on the
 * right, and the rent CTA was buried under whichever was longer.
 */
export const TAB_RENTAL = 'rental';

/** Which tab a target belongs on. A This Mac row that a rented machine is
 *  actually serving is the rental's; everything else is its place's. */
export const tabOfTarget = (target) => (
  target?.place === PLACE_THIS_MAC && target.machine ? TAB_RENTAL : (target?.place || '')
);

/**
 * The four tabs, in the order the strip shows them.
 *
 * Deliberately NOT the RUN_PLACES order. That list is a ladder — cheapest and
 * most private first — and it reads top to bottom as one page. A strip is four
 * doors side by side with a default already open, so it is ordered the way the
 * question is usually asked instead: the house account, the box you are paying
 * for by the hour, this machine, then the accounts that are nobody's business
 * but yours.
 */
export const RUN_TABS = Object.freeze([
  Object.freeze({
    id: PLACE_HIVEMINDOS, label: t('runOn.tabHivemind'), blurb: t('place.hivemindosBlurb'),
  }),
  Object.freeze({ id: TAB_RENTAL, label: t('runOn.tabRental'), blurb: t('runOn.rentalBlurb') }),
  Object.freeze({ id: PLACE_THIS_MAC, label: t('runOn.tabLocal'), blurb: t('place.thisMacBlurb') }),
  Object.freeze({ id: PLACE_ACCOUNTS, label: t('runOn.tabAccounts'), blurb: t('place.accountsBlurb') }),
]);

/** Every tab with the targets that fall on it — empties INCLUDED, because the
 *  rental tab earns its place with nothing rented (it is where the rent CTA
 *  lives) and only the caller knows whether it is showing that card. */
export function runTabsFor(targets) {
  return RUN_TABS.map((tab) => ({
    ...tab,
    targets: (targets || []).filter((target) => tabOfTarget(target) === tab.id),
  }));
}

/**
 * Which tab opens first.
 *
 * Local when this machine has a model it can actually run, because that is the
 * free, private, already-here answer and the one a creator wants offered before
 * anything that bills. Otherwise HivemindOS credits, which is the house default
 * and the only bill a fresh install already has. Neither: the first tab holding
 * anything, so an empty strip is never what opens.
 */
export function defaultRunTab(targets, selected = null) {
  const tabs = runTabsFor(targets);
  const hasReady = (id) => tabs.some((tab) => tab.id === id && tab.targets.some((target) => target.ready));
  // Wherever the CURRENT selection lives, first. Opening anywhere else answers
  // a question nobody asked: the first thing you look for on opening a picker
  // is the row that is already chosen. With a rented box selected this opened
  // on This Mac and left the chosen row on a tab you had to go and find.
  const current = selected && (targets || []).find(
    (target) => target.id === selected.id && target.provider === selected.provider,
  );
  const currentTab = current ? tabOfTarget(current) : '';
  if (currentTab && tabs.some((tab) => tab.id === currentTab && tab.targets.length)) return currentTab;
  if (hasReady(PLACE_THIS_MAC)) return PLACE_THIS_MAC;
  if (tabs.some((tab) => tab.id === PLACE_HIVEMINDOS && tab.targets.length)) return PLACE_HIVEMINDOS;
  return tabs.find((tab) => tab.targets.length)?.id || PLACE_THIS_MAC;
}

/* ---------------- what a model STARTS FROM ---------------- */

/**
 * The other question a person asks of a model list, and the one the picker
 * could not answer.
 *
 * A bill says who pays. It says nothing about whether a prompt alone reaches
 * the model — and in a list where 54 of MUAPI's 107 image rows are editors
 * that take a required picture (19 of them no prompt at all), that is the
 * fact a reader needs first. It was printed on the few rows the hosted
 * rail happened to carry endpoint names for, and nowhere else: "AI Image
 * Upscaler" sat between two text-to-image models looking exactly like them
 * until the Generate press refused.
 *
 * Four answers, because there are four: a prompt, a picture, either, or a
 * clip (the video tools — a watermark remover starts from footage and nothing
 * else). `''` is the fifth and it is not an answer: a row whose inventory
 * declares neither capabilities nor inputs is UNTYPED, shows no badge and
 * joins no filter, because guessing here is how an editing-only model comes
 * to be labelled as one that can start from text.
 */
export const STARTS_FROM_TEXT = 'text';
export const STARTS_FROM_IMAGE = 'image';
export const STARTS_FROM_EITHER = 'hybrid';
export const STARTS_FROM_VIDEO = 'video';

// The hosted rail names one endpoint per capability and these are its keys;
// the studio catalogs speak the same words (imageRunTargets and
// videoRunTargets derive them from the bucket a model is listed in), so one
// table reads all three inventories.
const TEXT_CAPABILITIES = new Set(['text-to-image', 'text-to-video']);
const IMAGE_CAPABILITIES = new Set(['image-to-image', 'image-to-video']);

/**
 * What one row starts from, from whatever its inventory actually declared.
 *
 * Capabilities win where they exist, because they ARE the endpoint list. With
 * none, the fields the model accepts answer instead — the same image-input
 * grammar the Image studio filters its local models by — and `requiresImage`
 * is the one thing that can rule text out.
 */
function startsFrom({ capabilities = [], accepts = null, requiresImage = false }) {
  const declared = capabilities.length > 0;
  // An EMPTY `accepts` is not a claim that the model takes nothing — the media
  // catalog leaves it empty on every provider whose inputs it never listed, and
  // GPT Image, which takes sixteen reference pictures, is one of them. Only a
  // non-empty list is an inventory saying what it knows.
  const listed = Array.isArray(accepts) && accepts.length > 0;
  if (!declared && !listed && !requiresImage) return '';
  const fromText = declared ? capabilities.some((name) => TEXT_CAPABILITIES.has(name)) : !requiresImage;
  const fromImage = declared
    ? capabilities.some((name) => IMAGE_CAPABILITIES.has(name))
    : (requiresImage || localModelSupportsImageInput({ accepts }));
  if (fromText && fromImage) return STARTS_FROM_EITHER;
  if (fromImage) return STARTS_FROM_IMAGE;
  if (fromText) return STARTS_FROM_TEXT;
  // What is left takes a clip or a soundtrack and no prompt: the v2v tools,
  // and the hosted rail's video-to-video and audio-to-video rows.
  return STARTS_FROM_VIDEO;
}

/**
 * The type filters for one list, each with the rows it holds.
 *
 * Ordered the way the question is asked — start from words, start from a
 * picture, either — and EMPTY TYPES ARE DROPPED, so a chip is never a promise
 * of rows that are not there. Untyped rows belong to no chip and stay in the
 * unfiltered list, which is why pressing one narrows rather than hides.
 *
 * The words are the kind's own: an image model that takes a picture does
 * image-to-image, a video model that takes one does image-to-video, and
 * calling both "Edit" is how the picker came to describe neither.
 */
export function runTypesFor(targets, kind = 'image') {
  const video = kind === 'video';
  return [
    { id: STARTS_FROM_TEXT, label: video ? t('runOn.typeTextToVideo') : t('runOn.typeTextToImage') },
    { id: STARTS_FROM_IMAGE, label: video ? t('runOn.typeImageToVideo') : t('runOn.typeImageToImage') },
    { id: STARTS_FROM_EITHER, label: t('runOn.typeHybrid') },
    { id: STARTS_FROM_VIDEO, label: t('runOn.typeVideoIn') },
  ]
    .map((type) => ({ ...type, targets: (targets || []).filter((target) => target.startsFrom === type.id) }))
    .filter((type) => type.targets.length > 0);
}

/** The rental a generation with this model would actually land on, honouring
 *  THIS TAB's pin — the same ordering the gateway applies to its requests. */
export function machineForModel(machines, model, pinned = '') {
  const known = [...(machines?.live || []), ...(machines?.idle || []), ...(machines?.broken || [])];
  const ordered = attachedOrder(withPin(known, pinned));
  return ordered.find((machine) => machine.attached && machine.tunnel_alive && machineServesModel(machine, model)) || null;
}

const hourly = (machine) => `$${(Number(machine?.usd_per_hour) || 0).toFixed(2)}/hr`;

/**
 * Whether this provider's credential is present, from the ONE rule that
 * decides it — the same rule providerReadiness.readinessFor applies.
 *
 * The two inventories disagree about MUAPI and only one of them is right: the
 * media catalog and the capability matrix both report `available` from the
 * SERVER's probe, but a MUAPI key held in this browser runs a generation just
 * as well, and a key in the shared store means the browser never needed one.
 * So MUAPI's answer is "can a key be reached from here", and every other
 * provider's is the probe. Two answers is how the same model came to be offered
 * in Image and refused in Sprite at the same moment.
 */
/**
 * What a row says when it is blocked on a credential.
 *
 * NOT a credential REQUIREMENT. providers.py declares MUAPI's as the literal
 * "MUAPI_API_KEY or MUAPI_KEY", and the media catalog puts that on the wire —
 * on `detail` for MUAPI, on `needs` for others, so neither field can be trusted
 * to be prose by virtue of its name. Rendering one put an environment variable
 * on screen where a sentence belongs: a first-run user met "Nano Banana —
 * MUAPI_API_KEY or MUAPI_KEY" and learned nothing they could act on. The
 * requirement is still CARRIED on the target, because readinessFor reads it to
 * choose between "add this key" and "the provider is down" — it is just never
 * the thing a person reads.
 *
 * Some of those values ARE sentences and still name the variable ("XAI_API_KEY
 * is missing"), which is the same leak wearing a verb, so the test is for the
 * NAME rather than for the shape of the whole string. What that drops is never
 * the only route to the fix: the readiness block under the row carries the door
 * ("Add key", "Connect"), and an account reachable two ways is already two
 * rows, each naming its own door.
 */
// A credential name: SCREAMING_SNAKE with at least one underscore, which is
// what every key in the registry looks like and what no English sentence does.
// "OpenAI API key" and "MUAPI account" are prose and stay; "OPENAI_API_KEY is
// missing; use the separate GPT Image OAuth provider" is developer copy and
// goes, embedded in a sentence or not.
const CREDENTIAL_NAME = /[A-Z]{2,}_[A-Z0-9_]+/;

const asProse = (value) => {
  const text = String(value || '').trim();
  return text && !CREDENTIAL_NAME.test(text) ? text : '';
};

function credentialReason(detail, needs) {
  return asProse(detail) || asProse(needs) || t('runOn.needsCredential');
}

export function credentialReady(row, available = true) {
  if (transportFor(row).transport === 'muapi') return !needsBrowserKey(row);
  return available !== false;
}

/**
 * One selectable run target.
 *
 * `id`/`provider`/`source` are the routing identity modelRunner dispatches on,
 * unchanged — this module never invents a route. Everything else is what a
 * person reads.
 */
function makeTarget({
  id, provider, source, label, rating = '', ratingReason = '', accepts = null, family = '', available = true,
  needs = '', keys = null, detail = '', machines = null, pinned = '', kind = 'image', capabilities = null,
  hostedRoutes = null, requiresImage = false, accelerator = '',
}) {
  const row = { id, provider, source, accepts, family };
  const declared = Array.isArray(capabilities) ? capabilities.filter(Boolean).map(String) : [];
  const place = placeFor(row);
  const route = kind === 'video' ? clipRouteFor(row) : transportFor(row);
  // `accelerator` rides along because a name is not a capability: the matcher
  // would otherwise offer the Apple-silicon H3 lane on a rented NVIDIA box,
  // whose needles legitimately say "minimax_h3".
  const machine = place === PLACE_THIS_MAC
    ? machineForModel(machines, { id, name: label, accelerator }, pinned)
    : null;
  const credentialled = credentialReady(row, available);
  return {
    key: `${place || 'unknown'}:${provider}:${id}`,
    id,
    provider,
    source,
    label,
    family,
    accepts,
    place,
    // What one ROW can do, when the row stands for several endpoints.
    //
    // The hosted rail lists an endpoint per capability: `flux-3` is four rows
    // upstream — text-to-image, image-to-image, text-to-video, image-to-video
    // — which are four prices and one model. The catalog collapses them, and
    // these are the badges that say so, in the kind's own terms. Empty for
    // every row that is only ever one thing.
    capabilities: declared,
    // capability -> {model, usd}. The endpoint each badge stands for, and its
    // catalogue price where it has one — ten of the rail's 538 do; the rest
    // are quoted per request, which is what the row asks for when it is on
    // screen. Null for every row that is not the hosted rail.
    hostedRoutes: hostedRoutes && typeof hostedRoutes === 'object' ? hostedRoutes : null,
    // This row cannot start from text: every capability it has takes a picture
    // in. The hosted rail is full of these — AI Ghibli Style's whole upstream
    // schema is one required `image_url` — and the studio used to find out at
    // the Generate press, after a prompt had been written for a model with no
    // prompt field. The catalog knows; now the picker and the composer do too.
    requiresImage: Boolean(requiresImage),
    // Which of this studio's two kinds the row makes, carried so the picker can
    // say "image to image" or "image to video" without being told twice — the
    // list and the words on it then cannot disagree.
    kind,
    // A prompt, a picture, either, or a clip — '' where the inventory declared
    // nothing to read it off. See startsFrom.
    startsFrom: startsFrom({ capabilities: declared, accepts, requiresImage }),
    // The ONE display label for where this runs. When a rental serves the
    // model, the machine IS the place: "This Mac" would be a true sentence
    // about the lane and a false one about the hardware doing the work.
    placeLabel: machine ? (machine.gpu || t('place.rentedGpu')) : placeLabelFor(row),
    // Which of that account's two doors this row goes through — "API key" or
    // "ChatGPT sign-in" — so two rows on one bill are not one row printed
    // twice. '' for every provider with no sibling.
    credentialLabel: machine ? '' : credentialLabelFor(row),
    machine,
    rating,
    ratingReason,
    // A row is offered only when this studio can actually reach it. The video
    // side is the strict one: the Media Studio lane serves its own workflows
    // and nothing else, so a Higgsfield clip has no route yet and says so
    // rather than being offered as a row whose Generate can only fail.
    ready: credentialled && route.runnable,
    // Never a greyed row with nothing on it. A row refused by the transport
    // says what the transport said; a row refused for a missing credential
    // carries the server's own sentence, so the picker has something to print
    // even where no readiness adapter is passed.
    reason: route.runnable ? (credentialled ? '' : credentialReason(detail, needs)) : route.reason,
    transport: route.transport,
    // The credential half of the row, carried rather than dropped: readinessFor
    // reads exactly these to decide between "not configured — add this key" and
    // "the provider is down", and without them every cloud row it saw looked
    // ready.
    available: available !== false,
    needs: String(needs || ''),
    detail: String(detail || ''),
    keys: Array.isArray(keys) ? keys.filter(Boolean).map(String) : [],
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
  // A lane the studio drives from its own button is not a place a generation
  // can be sent, so it is not a run target. The Klein direction tools (Point
  // eyes, Move sun) steer a picture that already exists, from a dialog opened
  // ON that picture; listed here as well, they read as two more models to
  // choose between — which is the choosing their dialog exists to remove.
  // Filtered HERE rather than in a studio so every picker agrees at once.
  const local = (localModels || []).filter((model) => !model?.actionOnly).map((model) => rated(makeTarget({
    id: model.id,
    provider: model.provider || 'sdcpp',
    source: 'local',
    label: model.name || model.label || model.id,
    family: model.family || '',
    accepts: model.accepts || null,
    // A local inventory that names its capabilities outright is taken at its
    // word (the Video studio's Wan2GP rows, which declare t2v or i2v per
    // model); one that only lists inputs is read off those, below.
    capabilities: Array.isArray(model.capabilities) ? model.capabilities : null,
    // The browser's own catalog says it in its own words: `requires.image` is
    // the local mapper's flag for a graph that cannot start from a prompt (the
    // Krea 2 identity edit, the Klein edit lanes). Without it every local row
    // read as text-to-image, badge and filter alike.
    requiresImage: Boolean(model.requires?.image),
    accelerator: model.accelerator || '',
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
        // `hosted_routes` is capability -> {model, usd}; the keys are what
        // this row can do in this kind. A catalog with no routes may still name
        // its capabilities outright — the two studio inventories derive theirs
        // from the bucket a model is listed in, which is the same claim made by
        // a list rather than by a price map.
        capabilities: model.hosted_routes && typeof model.hosted_routes === 'object'
          ? Object.keys(model.hosted_routes)
          : (Array.isArray(model.capabilities) ? model.capabilities : null),
        hostedRoutes: model.hosted_routes || null,
        requiresImage: model.requires_image === true,
        accelerator: model.accelerator || '',
        available: provider.available !== false,
        // The provider row's own account of what it is waiting for — the
        // sentence the server wrote ("Needs a MUAPI key") and the credential
        // names behind it, so a blocked row explains itself.
        needs: provider.needs || '',
        detail: provider.detail || '',
        keys: Array.isArray(provider.keys) ? provider.keys : null,
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
      // Carried, never inferred: an inventory that knows what its rows start
      // from says so here and gets the badge and the filter; one that does not
      // leaves them untyped rather than being read as text-to-image. Restore's
      // lanes and Sprite's rows are the second case.
      capabilities: Array.isArray(row.capabilities) ? row.capabilities : null,
      requiresImage: row.requiresImage === true || row.requires_image === true,
      rating: row.rating || '',
      ratingReason: row.reason || '',
      available: row.available !== false,
      needs: row.needs || row.unavailableReason || '',
      detail: row.detail || '',
      keys: Array.isArray(row.keys) ? row.keys : null,
      machines,
      pinned,
      kind,
    });
    // A row that names its own place is not a catalogued model: Restore's lanes
    // are places the GATEWAY named, and asking the transport table about them
    // would refuse every one of them for having no provider.
    const declared = Boolean(row.place);
    // A row that names its OWN reason keeps its own answer — a sealed sprite
    // that can only be animated here, a lane with no SeedVR2 nodes. A row that
    // is merely "the server's probe failed" defers to the one credential rule,
    // because for MUAPI that probe is not the whole truth: a key on this
    // machine or in this browser runs the generation the probe said it could
    // not. That disagreement is what offered a model in Image and refused the
    // same model in Sprite at the same moment.
    const blocked = row.available === false
      && (Boolean(row.unavailableReason) || !credentialReady(row, false));
    return {
      ...target,
      // How the verdict was arrived at travels with the row: a picker that
      // shows a rating has to be able to say where the rating came from.
      evidence: row.evidence || '',
      ...(declared ? { place: row.place, placeLabel: row.placeLabel || target.placeLabel } : {}),
      ...(row.badge ? { badge: row.badge } : {}),
      // An inventory that knows its own bill says so here, and runOnReadout
      // prints it instead of guessing from the place. Restore's rented lane is
      // the case: it lands on This Mac with no `machine` object to price, and
      // the place's own default note is "free, stays here".
      ...(row.note ? { note: row.note } : {}),
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
  if (localPick) return { target: localPick, reason: t('runOn.freeStaysHere') };

  if (readiness?.hivemindosCredits) {
    const hosted = ready.find((target) => target.place === PLACE_HIVEMINDOS);
    if (hosted) return { target: hosted, reason: t('runOn.onYourCredits') };
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
  return fallback
    ? { target: fallback, reason: fallback.place === PLACE_THIS_MAC ? t('runOn.freeStaysHere') : '' }
    : none;
}

/**
 * The compact readout: "Runs on: This Mac · Z-Image Turbo — free, stays here".
 *
 * Returned in parts so the component can weight them; joined by `readoutText`
 * for the places that want one string (a title attribute, a test).
 */
export function runOnReadout(target, { reason = '', automatic = false } = {}) {
  if (!target) {
    return { place: t('runOn.nowhere'), model: '', note: t('runOn.nothingRuns'), automatic: false };
  }
  // `target.note` is for an inventory that knows its own bill and is not a
  // rented MACHINE this app booked. Restore's lanes are the case: a paid lane
  // is somebody else's card reached through this Mac, so it lands on This Mac
  // with no `machine` object — and without this it fell through to "free,
  // stays here", which put the word FREE on the row that bills by the hour.
  const note = target.machine
    ? hourly(target.machine)
    : (reason || target.note || (target.place === PLACE_THIS_MAC ? t('runOn.freeStaysHere') : ''));
  return { place: target.placeLabel || t('place.thisMac'), model: target.label, note, automatic: Boolean(automatic) };
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
 * One group's rows, split by the ACCOUNT they run on, in the order they came.
 *
 * A place can hold several accounts — "Your accounts" is MUAPI and OpenAI and
 * xAI and Higgsfield at once — and an account reachable two ways (a key and a
 * sign-in) is two of them, because they are repaired differently. The two
 * halves of the key are exactly what `makeTarget` already writes: the place
 * label and, where there is a sibling, which door this row goes through.
 *
 * Rows are grouped so that whatever is true of an ACCOUNT can be said once
 * for the account instead of once per model. On this machine MUAPI serves 125
 * of them, and "This machine has no MUAPI key yet…" was printed under every
 * single row, with its own Add key button, 125 times.
 */
export function accountRunsOf(targets) {
  const runs = [];
  const byKey = new Map();
  for (const target of targets || []) {
    const key = `${target.provider}:${target.credentialLabel || ''}`;
    let run = byKey.get(key);
    if (!run) {
      run = { key, label: target.placeLabel || '', credentialLabel: target.credentialLabel || '', targets: [] };
      byKey.set(key, run);
      runs.push(run);
    }
    run.targets.push(target);
  }
  return runs;
}

/**
 * The one thing true of every row in an account, when there IS one.
 *
 * Returns the shared readiness only when the account holds more than one row
 * and every row is blocked on exactly the same thing with exactly the same
 * repair — which is the case this exists for, and is not the case for an
 * account whose models fail for different reasons. Null otherwise, and each
 * row keeps its own block.
 */
export function sharedAccountReadiness(targets, readinessFor) {
  const rows = targets || [];
  if (rows.length < 2 || typeof readinessFor !== 'function') return null;
  const first = readinessFor(rows[0]);
  // Not only the states that BLOCK. "Sign-in status unknown — Check again"
  // does not stop a press, and it was still printed three times under three
  // xAI rows with three identical buttons. Whether it blocks decides whether
  // the models fold away (below), not whether it is said once.
  if (!first || first.state === 'ready') return null;
  const identity = (readiness) => (readiness ? [
    readiness.state, readiness.label, readiness.detail,
    readiness.action?.kind || '', readiness.action?.key || '', readiness.action?.provider || '',
  ].join('\u0000') : '');
  const wanted = identity(first);
  return rows.every((target) => identity(readinessFor(target)) === wanted) ? first : null;
}

/**
 * One group's accounts, the usable ones first, each carrying whatever is true
 * of the whole account.
 *
 * Order matters more than it looks. On this machine MUAPI serves 125 of the
 * 137 models in "Your accounts" and holds no key, so listing accounts in the
 * order they arrive buried every OTHER account's Add key button 125 rows
 * down the list — the Higgsfield one was off the bottom of the panel. An
 * account you can use comes first because it is the answer; an account that
 * needs setting up comes next, with its own door, and they end up together.
 */
export function accountSectionsOf(targets, readinessFor) {
  const runs = accountRunsOf(targets).map((run) => {
    const shared = sharedAccountReadiness(run.targets, readinessFor);
    return {
      ...run,
      // What the account says once, above its models.
      shared,
      // …and whether that stops every press. Only then are the models folded:
      // an account whose sign-in status is merely unknown might still run,
      // so its rows stay where a person can reach them.
      blocked: shared?.blocks ? shared : null,
    };
  });
  // Ordered by whether the account can RUN something, not by whether its
  // state happened to be hoisted. A one-model account is never hoisted (one
  // row is not a repetition) and was sorting above the grouped ones purely
  // for that reason, which put an unusable account at the top.
  const canRun = (run) => run.targets.some((target) => target.ready && !readinessFor?.(target)?.blocks);
  const usable = runs.filter(canRun);
  return [...usable, ...runs.filter((run) => !canRun(run))];
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
