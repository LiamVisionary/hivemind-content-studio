// What the studios say about a local ComfyUI lane still sitting on its models.
//
// The panel this drives is deliberately hard to trigger. A lane being UP is not
// news — an idle lane holds under a gigabyte — and a lane that is BUSY is doing
// exactly what it should, so neither earns a line of the user's attention. The
// one state worth interrupting for is: this lane finished, still holds real
// memory, and the next local generation has to fit around it.
//
// Mirrors src/hivemind_content_studio/comfy_lanes.py; the server decides
// `reclaimable` (it also refuses to free a busy lane), this only decides what to
// say about it.

export const GB = 1024 ** 3;

export function formatGB(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 GB';
  return `${(value / GB).toFixed(value < 10 * GB ? 1 : 0)} GB`;
}

// Lanes worth showing, biggest first — if two lanes are both holding, the one
// with more to give back is the one to offer.
export function reclaimableLanes(snapshot) {
  const lanes = Array.isArray(snapshot?.lanes) ? snapshot.lanes : [];
  return lanes
    .filter((lane) => lane?.reclaimable)
    .sort((a, b) => (Number(b?.rssBytes) || 0) - (Number(a?.rssBytes) || 0));
}

// Whether the machine is tight enough that this actually matters. The gateway
// will not start a native Klein edit until its headroom + per-job reservation
// fit, so "you have less than that" is the honest reason to act now, and
// anything else is a nicety the user can ignore.
export function isMemoryTight(snapshot) {
  const available = Number(snapshot?.availableBytes);
  const needed = Number(snapshot?.kleinAdmissionBytes);
  if (!Number.isFinite(available) || !Number.isFinite(needed) || needed <= 0) return false;
  return available < needed;
}

// One line of copy. Never promises a speed-up it cannot demonstrate: it states
// what is held and what freeing does, and only escalates to "generations are
// waiting on this" when the machine is genuinely below the admission bar.
export function laneNotice(snapshot) {
  const [lane] = reclaimableLanes(snapshot);
  if (!lane) return null;
  const held = formatGB(lane.rssBytes);
  const tight = isMemoryTight(snapshot);
  return {
    lane: lane.id,
    label: lane.label,
    held,
    tone: tight ? 'warn' : 'info',
    // The lane stays up either way — saying so is what makes this safe to click
    // without wondering whether video still works afterwards.
    message: tight
      ? `${lane.label} is holding ${held} and this machine is below the headroom a local generation reserves — freeing it lets the next one start.`
      : `${lane.label} is still holding ${held} from its last job. Freeing it returns that memory; the lane stays up and reloads when you next use it.`,
    action: `Free ${held}`,
  };
}
