// Dev-mode gate for developer-only affordances (currently: "Use in rentals"
// on LoRA cards). The studio at 8765 serves a prebuilt dist, so no build-time
// flag can reach it — this is a runtime switch:
//   - the vite dev server (import.meta.env.DEV) is always dev mode
//   - ?dev=1 turns it on and persists it to localStorage
//   - ?dev=0 turns it off again
const KEY = 'opengen.devMode';

export function isDevMode() {
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) return true;
  } catch { /* non-vite runtime */ }
  try {
    const param = new URLSearchParams(window.location.search).get('dev');
    if (param === '1') {
      window.localStorage?.setItem(KEY, '1');
      return true;
    }
    if (param === '0') window.localStorage?.removeItem(KEY);
    return window.localStorage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}
