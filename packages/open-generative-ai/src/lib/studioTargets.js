// Where another studio can send work: which TAB, on which SOURCE, running what.
//
// The Story studio's "Open in the Video studio" used to be a single button that
// posted into whichever video tab happened to be in front, on whatever source
// that tab happened to be on. Both of those are decisions — a story written for
// a rented MiniMax H3 is a different prompt, with different attachments, from
// the same story sent to a cloud Seedance (see lib/videoDelivery.js) — so they
// have to be visible and chosen before anything is sent.
//
// Only a mounted studio can answer what it is running: the model lives inside
// the component, and switching source re-points it through transitions the
// sender has no business re-implementing. So each tab PUBLISHES what it is, and
// the sender reads. Same shape as the tab strip's `apiRef` handle, for the same
// reason.
//
// Module state, deliberately: it describes what is mounted right now. Nothing
// here is persisted — a target that is not on screen is not a target.

const targets = new Map(); // key -> descriptor
const listeners = new Set();

const notify = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* a bad listener is not the publisher's problem */ } } };

/**
 * Publish (or update) one tab's descriptor. Returns the unpublish function, so
 * an unmount cannot leave a target behind that nothing can send to.
 *
 * @param {string} key stable per mount — `${section}:${tabId}`
 * @param {object} descriptor {section, tabId, index, label, current, sources}
 */
export function publishSendTarget(key, descriptor) {
  targets.set(key, { ...descriptor, key });
  notify();
  return () => {
    if (targets.delete(key)) notify();
  };
}

/** Every live target for a section, in tab order. */
export function listSendTargets(section = 'video') {
  return [...targets.values()]
    .filter((entry) => entry.section === section)
    .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
}

/** Called whenever the set of targets, or any one of them, changes. */
export function subscribeSendTargets(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget everything. Never called by the app. */
export function resetSendTargets() {
  targets.clear();
  notify();
}

/** The three sources, in the order the studio's own toggle shows them. */
export const SEND_SOURCES = Object.freeze(['local', 'api', 'rented']);

export const SOURCE_LABELS = Object.freeze({
  local: { en: 'Local', zh: '本地' },
  api: { en: 'API', zh: '云端' },
  rented: { en: 'Rented', zh: '租用' },
});

/**
 * Ask a tab to come to the front before work is sent to it.
 *
 * An event rather than a direct call: the strip owns tab state, the sender is
 * in another studio entirely, and the one-shot setup bridge only drains into
 * the tab that is actually mounted and active (app/promptTarget.js).
 */
export function selectSendTarget(section, tabId) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('studio-select-tab', {
    detail: { studioType: section, tabId: Number(tabId) },
  }));
}
