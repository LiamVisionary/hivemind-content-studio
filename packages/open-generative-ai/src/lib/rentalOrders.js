// A rent is an ORDER before it is a machine.
//
// Pressing Rent used to hold one request open for the whole placement — the
// offer search, the credit check, the Civitai links, the manifest upload, the
// marketplace's own order — behind a spinner on the button: ten to twenty
// seconds on a good day, minutes on a slow Civitai one. When it came back, the
// list the view re-read was a snapshot from before the order, so the spinner
// stopped over a page with no trace of a machine that was already billing
// (2026-09-15). The server now answers `background: true` with an order at
// once and lists it (`orders`) until it resolves. These are the readings of
// that payload the Machines view draws, kept pure so the handoff from the
// order's row to the machine's row is testable without a browser.

// The machine's own ladder with the order as its first rung: one bar from the
// click to Ready. The order fills the first segment, the box's beacon the rest.
export const PROVISION_STEPS = [
  { key: 'placing', label: 'Reserving your machine' },
  { key: 'booting', label: 'Starting the machine' },
  { key: 'installing', label: 'Installing the software' },
  { key: 'downloading', label: 'Copying the models over' },
  { key: 'starting-comfy', label: 'Almost ready' },
  { key: 'ready', label: 'Ready' },
];

const stepAt = (key) => PROVISION_STEPS.findIndex((step) => step.key === key);
const SEGMENTS = PROVISION_STEPS.length - 1;

// How far through the first rung each order stage is, and what it is doing.
// `sending` belongs to this tab alone: the moment between the click and the
// POST answering, which the row covers so nothing waits on the network to
// appear. `placed` ends the rung exactly where a booting machine begins it.
const ORDER_STAGES = {
  sending: { within: 0.1, label: 'Sending your order' },
  searching: { within: 0.3, label: 'Finding a machine at your price' },
  preparing: { within: 0.6, label: 'Getting the model downloads ready' },
  renting: { within: 0.85, label: 'Reserving the machine' },
  placed: { within: 1, label: PROVISION_STEPS[stepAt('booting')].label },
};

// A placed order keeps its row until the machine list shows the machine: the
// list is a snapshot and can trail the order by a poll. Bounded, because a box
// that died before the list ever saw it must not sit at "Starting the machine"
// for the whole replay window — past this the list is the only authority.
export const ORDER_HANDOFF_SECONDS = 90;

export const orderOpen = (order) => Boolean(order) && order.stage !== 'placed' && order.stage !== 'failed';

export function orderProgress(order) {
  const stage = ORDER_STAGES[order?.stage] || ORDER_STAGES.searching;
  return { value: stage.within / SEGMENTS, label: stage.label };
}

export function provisionStepIndex(machine) {
  const booting = stepAt('booting');
  if (machine?.phase === 'booting') return booting;
  const step = machine?.provision?.step || 'booting';
  // 'error' is not a step in the ladder: a box that had already died used to
  // draw a spinner on "Booting host", so it looked like it was still starting.
  if (step === 'error') return machine.provision?.done ? stepAt('downloading') : booting;
  const index = stepAt(step === 'syncing' ? 'installing' : step);
  return index === -1 ? booting : index;
}

export function machineProgress(machine) {
  const current = provisionStepIndex(machine);
  const p = machine?.provision;
  const step = PROVISION_STEPS[current];
  const fraction = p?.total ? Math.min(1, (p.done || 0) / p.total) : null;
  const value = step.key === 'downloading' && fraction != null
    ? (current + fraction) / SEGMENTS
    : current / SEGMENTS;
  return { value, step };
}

// Drafts are this tab's orders before the POST has answered. The server's copy
// wins the moment it exists, so a stage never runs backwards.
export function mergeOrders(serverOrders, drafts) {
  const known = new Set((serverOrders || []).map((order) => order.order_id));
  return [...(serverOrders || []), ...(drafts || []).filter((draft) => !known.has(draft.order_id))];
}

// The orders that still get a row: open ones, and placed ones whose machines
// the list has not caught up with. A failed order never draws a row — how it
// ended is said once, in words, by the tab that placed it.
export function ordersToDraw(orders, rentals, now = Date.now() / 1000) {
  const listed = new Set((rentals || []).map((machine) => String(machine.rental_id)));
  return (orders || []).filter((order) => {
    if (orderOpen(order)) return true;
    if (order.stage !== 'placed') return false;
    if (order.finished_at && now - order.finished_at > ORDER_HANDOFF_SECONDS) return false;
    return (order.rental_ids || []).some((id) => !listed.has(String(id)));
  });
}

// The server places one order per tier at a time (a second one is a 409), so
// the Rent button for a tier with an order on its way is not a button.
export function placingTiers(orders) {
  return new Set((orders || []).filter(orderOpen).map((order) => order.tier));
}

// What a finished order says to whoever placed it; null while it is going.
export function orderOutcome(order) {
  if (!order || orderOpen(order)) return null;
  if (order.stage === 'failed') {
    const error = order.error || {};
    const moved = error.priceChanged;
    // A price that moved UP is a question, not a failure. One that moved DOWN
    // never arrives here: it is inside the cap and was taken without asking.
    if (moved && moved.now > moved.quoted) return { kind: 'price', priceChanged: moved };
    return {
      kind: 'error',
      message: error.message || '',
      // Nothing about money can be promised after an error nobody foresaw.
      unexpected: Boolean(error.unexpected),
      incident: error.incident || '',
      remedy: error.remedy || '',
    };
  }
  const notices = [];
  if (order.partial) notices.push(order.partial);
  const quoted = Number(order.quoted_usd_per_hour);
  const landed = Number(order.usd_per_hour);
  if (quoted && landed && Math.abs(landed - quoted) >= 0.0005) {
    // Three decimals, not two: the server lets a fallback land within
    // max($0.02, 3%) of the quote, so the entire legal gap on a ~$0.34/hr tier
    // rounds away at two — the sentence then contrasts a number with itself
    // ("it cost $0.34/hr instead of the $0.34/hr quoted").
    notices.push(`it cost $${landed.toFixed(3)}/hr instead of the $${quoted.toFixed(3)}/hr quoted — that machine was taken, and the next one was within a few cents`);
  }
  return { kind: 'placed', notice: notices.join('; ') };
}
