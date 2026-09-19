// Attached rented-machine state shared by the studios' "Rented" source mode
// and the Machines hub view. A rented machine serves the models whose
// id/name matches its lane needles — the same substring rule the
// media-gateway uses to route generations to the machine's lane, so what
// this module says is "served" is exactly what actually runs remotely.
const CACHE_MS = 15000;
// Failures (vault locked, stack mid-restart) cache briefly so recovery is
// quick — a long negative cache made the Rented option miss its moment.
const ERROR_CACHE_MS = 4000;
let cache = { at: 0, machines: null, inflight: null, ttl: CACHE_MS, generation: -1 };
// Bumped by every announced attachment change. A read forced by one of those
// changes may not be answered by a request that started before it.
let generation = 0;

// Fired by the Machines view after attach/detach so mounted studios refresh
// their Rented state immediately instead of waiting for the next poll.
export const RENTED_CHANGED_EVENT = 'rented-machines-changed';

export function notifyRentedMachinesChanged() {
  generation += 1;
  try { window.dispatchEvent(new CustomEvent(RENTED_CHANGED_EVENT)); } catch { /* SSR/tests */ }
}

// "Not usable" is not one state. A box still pulling models really is arriving;
// a ready box you have not pointed at this studio is just idle, one click away;
// a ready box whose tunnel died is broken and needs saying so. Lumping all three
// under "pending" is how a dead tunnel rendered as "coming online…" with a
// spinner that would never stop.
export function classifyMachine(machine) {
  if (machine.phase !== 'ready') return 'provisioning';
  if (!machine.attached) return 'idle';
  return machine.tunnel_alive ? 'live' : 'broken';
}

async function fetchMachines() {
  const response = await fetch('/api/gpu-rentals');
  if (!response.ok) throw new Error(`gpu-rentals ${response.status}`);
  const body = await response.json();
  const managed = (body.rentals || []).filter((m) => m.managed);
  const buckets = { live: [], provisioning: [], idle: [], broken: [] };
  for (const machine of managed) buckets[classifyMachine(machine)].push(machine);
  return {
    ...buckets,
    // Back-compat for callers that only ask "is anything not usable yet".
    pending: [...buckets.provisioning, ...buckets.idle, ...buckets.broken],
  };
}

const EMPTY_STATE = { live: [], provisioning: [], idle: [], broken: [], pending: [] };

// Only the newest request may publish. One superseded by a forced refresh read
// the world before the change that forced it, and letting it land would put the
// machine you just switched away from back in front until the next poll.
function publish(promise, started, state, ttl) {
  if (cache.inflight === promise) {
    const previous = cache.machines;
    cache = { at: Date.now(), machines: state, inflight: null, ttl, generation: started };
    // A machine that CHANGED without anyone clicking anything. The event above
    // is fired by the Machines view after an attach or detach, which covers
    // every change a person makes — but a box goes ready, and then attached,
    // on the backend's own schedule long after the rent click. Whoever is
    // polling (a studio's own rented-state sync) discovers it, and before this
    // nobody else heard: the composer's status line said "1 running" off the
    // poll while the model picker's Rental tab stayed empty off a machine list
    // fetched before the box existed. Two copies of the same fact, one stale.
    // Announcing it here means the discovery reaches every reader whatever
    // caused the read. Only a real membership change announces, so a settled
    // poll is silent and this cannot feed itself.
    if (previous !== null && !sameMachines(previous, state)) {
      try { window.dispatchEvent(new CustomEvent(RENTED_CHANGED_EVENT)); } catch { /* SSR/tests */ }
    }
  }
  return state;
}

/** Membership plus the two flags every picker keys on: a box that became
 *  attached, or whose tunnel died, is a different world even at the same count. */
function sameMachines(a, b) {
  const key = (state) => ['live', 'provisioning', 'idle', 'broken']
    .map((bucket) => (state?.[bucket] || [])
      .map((m) => `${m.rental_id}:${m.attached ? 1 : 0}${m.tunnel_alive ? 1 : 0}`)
      .sort()
      .join(','))
    .join('|');
  return key(a) === key(b);
}

// Never throws — the empty state when the API is unreachable (locked vault,
// stack restarting) so the studios degrade to the rent-a-machine CTA.
export async function rentedMachinesState({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.machines !== null && now - cache.at < cache.ttl) return cache.machines;
  // Share a request that is already running for this generation — every mounted
  // studio hears the same change event, and they must not each open their own
  // round-trip — but never share one that predates the change being forced on.
  if (!cache.inflight || (force && cache.generation !== generation)) {
    const started = generation;
    const inflight = fetchMachines()
      .then((state) => publish(inflight, started, state, CACHE_MS))
      .catch(() => publish(inflight, started, EMPTY_STATE, ERROR_CACHE_MS));
    cache = { ...cache, inflight, generation: started };
  }
  return cache.inflight;
}

// Back-compat: the live (usable-now) machines only.
export async function attachedMachines(options = {}) {
  return (await rentedMachinesState(options)).live;
}

// Attached machines are tried in priority order and the FIRST whose needles
// match a generation gets it (the media-gateway's lane rules are first-match,
// and gpu_rentals writes the registry in this same order). Renting two boxes
// that serve the same models is legitimate, so the UI has to be able to say
// which one a generation would actually land on — this is that calculation,
// mirroring the server's ordering exactly rather than guessing.
export function attachedOrder(machines) {
  return (machines || [])
    .filter((machine) => machine.attached)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0)
      || String(a.rental_id).localeCompare(String(b.rental_id)));
}

const overlaps = (a, b) => (a.models_served || []).some((needle) => (b.models_served || []).includes(needle));

// True when nothing ahead of this machine serves the same models — i.e. it is
// the box that actually runs them. Deliberately blind to tunnel health: a
// machine with a dead tunnel still holds its place in the gateway's rules, and
// pretending otherwise would show a green light on a box nothing reaches.
export function isRoutingLeader(machine, machines) {
  const order = attachedOrder(machines);
  const index = order.findIndex((m) => m.rental_id === machine.rental_id);
  return index >= 0 && !order.slice(0, index).some((ahead) => overlaps(ahead, machine));
}

// The list as it will read once a `/select` on this machine lands: attached,
// and ahead of every other attachment — mirroring the priority the server
// writes (max + 1). The picker renders this the instant you click, because the
// round-trip that makes it true is seconds long (attach a cold box and it is
// longer still), and a picker that keeps pointing at the OLD machine for that
// long reads as a click that did nothing — so it gets clicked again.
export function withSelection(machines, rentalId) {
  const top = (machines || []).reduce((max, m) => Math.max(max, m.priority || 0), 0) + 1;
  return (machines || []).map((machine) => (machine.rental_id === rentalId
    ? { ...machine, attached: true, priority: top }
    : machine));
}

// The attached order as THIS TAB's requests see it: the pinned machine first
// (the gateway tries a `run_on` pin ahead of its priority order), then the
// server's own order. A pin naming a machine that is not attached is inert —
// the gateway has no lane for it — so the list comes back unchanged, and the
// Rented panel drops the pin as stale.
export function withPin(machines, pinned) {
  const list = machines || [];
  if (!pinned || !list.some((m) => m.rental_id === pinned && m.attached)) return list;
  return withSelection(list, pinned);
}

// The machine a generation with this model would run on, if any.
export function routingLeaderFor(machines, model) {
  return attachedOrder(machines).find((machine) => machineServesModel(machine, model)) || null;
}

// What a rented box IS. Every class in the rental ladder (gpu_rentals.GPU_CLASSES)
// is an NVIDIA card, so this is a fact about the product, not a guess about one
// machine — and it is stated here, once, rather than inferred from a GPU name.
const RENTED_ACCELERATOR = 'cuda';

export function machineServesModel(machine, model) {
  // Normalize both sides (case + separators) so UI model ids match the
  // gateway's file-name needles: "wai-anima-native-06b-turbo" ~ "waianima".
  const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // A lane that cannot run on this KIND of machine is not served by it however
  // well the names match. Every tier the studio rents is an NVIDIA card, so a
  // lane declaring anything else is out: "MiniMax H3 (Apple Silicon)" is
  // antirez/h3.c, a Metal engine that says so in its own registry row, and its
  // id still contains "minimax_h3" — which is exactly the needle a rented H3
  // box advertises. It was listed as runnable on an RTX 5090, and picked as the
  // model to hand a "Use in Video studio" to, until the preflight refused it.
  const accelerator = String(model?.accelerator || '').toLowerCase();
  if (accelerator && accelerator !== RENTED_ACCELERATOR) return false;
  const haystack = norm(`${model?.id || ''} ${model?.name || ''} ${model?.workflowId || ''}`);
  return (machine?.models_served || []).some((needle) => haystack.includes(norm(needle)));
}

export function servedByAnyMachine(machines, model) {
  return (machines || []).some((machine) => machineServesModel(machine, model));
}

// Cross-view handoff: the Machines view sets this before navigating so the
// studio opens in Rented mode once, without coupling to its prefs schema.
const HANDOFF_KEY = 'studio_open_rented_once';

export function requestRentedMode(page) {
  try { sessionStorage.setItem(HANDOFF_KEY, page); } catch { /* private mode */ }
}

export function consumeRentedModeRequest(page) {
  try {
    if (sessionStorage.getItem(HANDOFF_KEY) === page) {
      sessionStorage.removeItem(HANDOFF_KEY);
      return true;
    }
  } catch { /* private mode */ }
  return false;
}
