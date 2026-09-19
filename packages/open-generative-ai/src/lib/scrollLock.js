// One body-scroll lock, counted.
//
// Two surfaces hold the page still while they are open — ui/Modal.jsx and the
// image studio's CompareViewer, which opens OVER a Modal. Each used to do the
// obvious thing on its own: save `document.body.style.overflow`, set it to
// hidden, and put the saved value back on the way out.
//
// That is correct for one of them and wrong for two. The inner surface saves
// 'hidden' (the outer one's doing) and the outer saves ''. React runs cleanups
// in mount order, so when both unmount in the same commit — a route change, or
// a global shortcut fired while Compare is open — the OUTER cleanup runs first
// and restores '', and the inner then writes back the 'hidden' it saved. The
// page is left unable to scroll with no dialog on screen and nothing to close.
//
// A counter is the whole fix: the first lock remembers what the page had, the
// last unlock gives it back, and everything between them is arithmetic.
let depth = 0;
let saved = '';

/** Hold the page still. Returns the release — call it exactly once. */
export function lockBodyScroll() {
  if (typeof document === 'undefined') return () => {};
  if (depth === 0) {
    saved = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  depth += 1;
  let released = false;
  return () => {
    // Guarded: a double release would drop the count below the surfaces still
    // holding it and let the page scroll under an open dialog.
    if (released) return;
    released = true;
    depth = Math.max(0, depth - 1);
    if (depth === 0) document.body.style.overflow = saved;
  };
}
