// Open/close state for the Hivemind prompt library, shared between the `more`
// menu row that opens it (studios/frame/PromptLibraryItem.jsx) and the popover
// that draws it (studios/frame/PromptLibraryMenu.jsx). It lives outside both
// because the row is inside a menu that closes on the same press that opens the
// library, so the two never exist at the same time to pass a prop between them.
//
// There is no toggle: the row OPENS the library, and the library closes itself
// the way every other popover in the app does (its own X, Escape, a click
// outside). A menu row that flips a panel on and off somewhere else reads as a
// setting, which is what it was mistaken for.
let open = false;
const listeners = new Set();

export function setPromptLibraryOpen(value) {
  open = Boolean(value);
  listeners.forEach((fn) => fn(open));
}

export function getPromptLibraryOpen() {
  return open;
}

export function subscribePromptLibrary(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
