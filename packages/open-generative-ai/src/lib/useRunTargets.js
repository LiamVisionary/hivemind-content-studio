// The browser half of "where can this run": one hook, four inventories.
//
// Nothing here decides anything. It joins the media catalog the server already
// builds (/api/simple/catalog, shared through the studio context cache), this
// browser's own local catalog, the attached rented machines and the OAuth
// grants — and hands the joined list to runTargets.js, which owns the
// vocabulary and the ladder. Every studio asks the same question of the same
// join, which is the whole point: four pickers reading four sources is how the
// studio ended up with four vocabularies.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { loadHivemindStudioContext } from './hivemindStudio.js';
import { RENTED_CHANGED_EVENT, rentedMachinesState } from './rentedMachines.js';
import { fetchCapabilityMatrix, featureOf, rateModel } from './capabilityMatrix.js';
import { PROVIDER_OAUTH, fetchOAuthStatus } from './providerReadiness.js';
import { PLACE_ACCOUNTS, PLACE_HIVEMINDOS, buildRunTargets, pickRunTarget } from './runTargets.js';
import { placeFor } from './modelRunner.js';

const EMPTY_MACHINES = { live: [], idle: [], broken: [], provisioning: [] };

/** Which providers hold a credential right now, read off the same catalog the
 *  rows come from — `available` on a media provider IS "its credential is
 *  present and its probe passed". */
export function readinessFromCatalog(catalogProviders, oauth) {
  const keyedProviders = [];
  let hivemindosCredits = false;
  for (const provider of catalogProviders || []) {
    const id = String(provider?.id || '');
    const place = placeFor({ provider: id, source: 'cloud' });
    if (!provider?.available) continue;
    if (place === PLACE_HIVEMINDOS) hivemindosCredits = true;
    if (place === PLACE_ACCOUNTS) keyedProviders.push(id);
  }
  return { hivemindosCredits, keyedProviders, connectedProviders: connectedProviders(oauth) };
}

/** Connected AND usable: a grant whose refresh token has expired is a
 *  connection in the settings sense and a dead end in the generation sense,
 *  and the ladder must not lead with one. */
export function connectedProviders(oauth) {
  return Object.entries(PROVIDER_OAUTH)
    .filter(([, connection]) => {
      const status = oauth?.[connection];
      return Boolean(status?.connected) && status.usable !== false && !status.needs_reconnect;
    })
    .map(([provider]) => provider);
}

/**
 * The same readiness, read off rows that are already run targets.
 *
 * Story and Sprite rate the capability matrix's rows rather than the media
 * catalog directly, so they have no `catalogProviders` to read — but a row that
 * is `ready` on a bill IS that bill answering, which is the only thing the
 * ladder asks. One ladder, two inventories.
 */
export function readinessFromTargets(targets, oauth) {
  const keyedProviders = [];
  let hivemindosCredits = false;
  for (const target of targets || []) {
    if (!target?.ready) continue;
    if (target.place === PLACE_HIVEMINDOS) hivemindosCredits = true;
    if (target.place === PLACE_ACCOUNTS && !keyedProviders.includes(target.provider)) {
      keyedProviders.push(target.provider);
    }
  }
  return { hivemindosCredits, keyedProviders, connectedProviders: connectedProviders(oauth) };
}

/**
 * The attached rentals, kept current while a studio is mounted.
 *
 * Every picker needs them for the same reason — a rental is a property of This
 * Mac, so the row it serves has to be able to name it — and a studio that
 * fetched them once at mount would freeze the boot-time answer.
 */
export function useRentedMachines() {
  const [machines, setMachines] = useState(EMPTY_MACHINES);
  const refresh = useCallback(async () => {
    setMachines((await rentedMachinesState({ force: true }).catch(() => EMPTY_MACHINES)) || EMPTY_MACHINES);
  }, []);
  useEffect(() => {
    let live = true;
    rentedMachinesState().catch(() => EMPTY_MACHINES).then((state) => {
      if (live) setMachines(state || EMPTY_MACHINES);
    });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = () => { void refresh(); };
    window.addEventListener(RENTED_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(RENTED_CHANGED_EVENT, onChange);
  }, [refresh]);
  return { machines, refreshMachines: refresh };
}

/** The capability verdicts for one feature, keyed the way buildRunTargets asks
 *  for them. Null when no feature was named — a picker with no feature has
 *  nothing to rate against and must not invent a rating. */
export function ratingsForFeature(matrix, featureId) {
  const feature = featureId ? featureOf(matrix, featureId) : null;
  if (!feature) return null;
  const ratings = new Map();
  for (const row of feature.rows || []) {
    ratings.set(`${row.provider}:${row.model}`, { rating: row.rating, reason: row.reason });
  }
  return {
    map: ratings,
    // Local models are a browser-side catalog the server has never heard of, so
    // they are rated here against the SAME shipped rules rather than left
    // unrated beside rated cloud rows.
    rateLocal: (model) => rateModel(feature, model, { unmatched: matrix?.unmatched || undefined }),
  };
}

/**
 * Every run target for one studio, plus the Automatic pick and its reason.
 *
 * @param {object} options
 * @param {'image'|'video'} options.kind
 * @param {Array} options.localModels this browser's own catalog for that kind
 * @param {string} options.pinned this tab's run_on pin
 * @param {string} options.featureId optional — turns on the capability pill
 */
export function useRunTargets({ kind = 'image', localModels = [], pinned = '', featureId = '' } = {}) {
  const [catalogProviders, setCatalogProviders] = useState([]);
  const [machines, setMachines] = useState(EMPTY_MACHINES);
  const [oauth, setOauth] = useState(null);
  const [matrix, setMatrix] = useState(null);
  const [loading, setLoading] = useState(true);

  const refreshMachines = useCallback(async () => {
    setMachines((await rentedMachinesState({ force: true }).catch(() => EMPTY_MACHINES)) || EMPTY_MACHINES);
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      const [context, rentals, grants, capabilities] = await Promise.all([
        loadHivemindStudioContext().catch(() => null),
        rentedMachinesState().catch(() => EMPTY_MACHINES),
        fetchOAuthStatus().catch(() => null),
        // A picker with no feature id shows no rating, so the matrix is not
        // worth a round-trip for it.
        featureId ? fetchCapabilityMatrix().catch(() => null) : Promise.resolve(null),
      ]);
      if (!live) return;
      setCatalogProviders(((context?.catalog?.media || {})[kind]) || []);
      setMachines(rentals || EMPTY_MACHINES);
      setOauth(grants);
      setMatrix(capabilities);
      setLoading(false);
    })();
    return () => { live = false; };
  }, [kind, featureId]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChange = () => { void refreshMachines(); };
    window.addEventListener(RENTED_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(RENTED_CHANGED_EVENT, onChange);
  }, [refreshMachines]);

  const rated = useMemo(() => ratingsForFeature(matrix, featureId), [matrix, featureId]);

  const targets = useMemo(() => {
    const built = buildRunTargets({
      kind, localModels, catalogProviders, machines, pinned, ratings: rated?.map || null,
    });
    if (!rated) return built;
    // Cloud rows arrive rated from the server; local ones are rated here.
    return built.map((target) => (target.source === 'local'
      ? { ...target, ...(({ rating, reason }) => ({ rating, ratingReason: reason }))(rated.rateLocal(target)) }
      : target));
  }, [kind, localModels, catalogProviders, machines, pinned, rated]);

  const readiness = useMemo(() => readinessFromCatalog(catalogProviders, oauth), [catalogProviders, oauth]);
  const automatic = useMemo(
    () => pickRunTarget(kind, { catalog: targets, machines, readiness }),
    [kind, targets, machines, readiness],
  );

  // `catalogProviders` is handed back for the one studio whose model list the
  // server catalog cannot supply — Video, whose lane registry is richer than
  // the catalog's video block. It joins the same pieces through
  // studios/video/videoRunTargets.js rather than a second fetch.
  return { targets, machines, readiness, automatic, loading, refreshMachines, catalogProviders };
}
