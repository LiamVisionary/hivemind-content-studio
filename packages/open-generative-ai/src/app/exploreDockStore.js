// Open/close state for the Hivemind explore dock, shared between the topbar
// trigger (Shell) and the dock panel (ExploreDock bridge). The dock is rendered
// once by App for its postMessage/event contracts; the trigger lives in the
// topbar so it never overlaps a studio's docked composer.
let open = false;
const listeners = new Set();

export function toggleExploreDock() {
  open = !open;
  listeners.forEach((fn) => fn(open));
}

export function setExploreDock(value) {
  open = Boolean(value);
  listeners.forEach((fn) => fn(open));
}

export function getExploreDock() {
  return open;
}

export function subscribeExploreDock(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
