// Counts the sidebar's collapsed Advanced group shows on its closed header, so
// an agent waiting on a PassBook approval or a production still running is never
// hidden by the fold.
//
// Written by the hub data layer — the only thing in the app that polls — and read
// by Shell. Shell must not import hubData: that module is deliberately kept out
// of the eager bundle (it loads with the hub layer), so the numbers land here
// instead. Before the hub layer has ever booted both counts are 0.
let badges = { passbookPending: 0, runningProductions: 0 };
const listeners = new Set();

export function getNavBadges() {
  return badges;
}

export function subscribeNavBadges(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setNavBadges(patch) {
  const next = { ...badges, ...patch };
  if (next.passbookPending === badges.passbookPending && next.runningProductions === badges.runningProductions) return;
  badges = next;
  listeners.forEach((fn) => fn());
}
