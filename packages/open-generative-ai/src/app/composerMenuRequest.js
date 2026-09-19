// A retired page that folded into a composer control still has to land
// somewhere. Page keys are a wire contract, so ?page=cinema keeps resolving —
// it routes to the Image studio and opens the Camera menu that replaced it.
//
// Latched rather than fired-and-forgotten: the route resolves before the studio
// module has finished loading, and studio tabs mount more than one Image
// composer. The request waits until the ACTIVE one claims it.

let pending = null;
const listeners = new Set();

/** Ask `page`'s composer to open `menu` as soon as one is listening. */
export function requestComposerMenu(page, menu) {
  pending = { page: String(page || ''), menu: String(menu || '') };
  listeners.forEach((fn) => {
    try { fn(pending); } catch { /* a listener must not block the others */ }
  });
}

/** Claim the request, if it is for this composer's menu. One taker only. */
export function takeComposerMenuRequest(page, menu) {
  if (!pending || pending.page !== page || pending.menu !== menu) return false;
  pending = null;
  return true;
}

/** Called again whenever a new request lands. Returns an unsubscribe. */
export function onComposerMenuRequest(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
