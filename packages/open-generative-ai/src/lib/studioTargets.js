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

import { loadTabState, saveTabState } from './studioTabs.js';

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

/**
 * Live targets over resolved ones, by tab.
 *
 * A mounted tab knows its CURRENT setup, which storage cannot: it may have been
 * switched since the last save, and a background tab never saves at all. A tab
 * that is not mounted is still a real destination, so the resolved answer fills
 * in for it rather than the tab vanishing from the list.
 */
export function mergeSendTargets(live = [], resolved = []) {
  const byTab = new Map((resolved || []).map((entry) => [entry.tabId, entry]));
  for (const entry of live || []) byTab.set(entry.tabId, entry);
  return [...byTab.values()].sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
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
  const wanted = Number(tabId);
  // Written to the strip's own storage FIRST, because the common case is that
  // the target studio is not mounted yet — there is nothing listening, and the
  // strip reads this when it comes up. The event is for the case where it IS
  // mounted and has to move now.
  try {
    const state = loadTabState(section);
    if (state.tabs.some((tab) => tab.id === wanted)) saveTabState(section, { ...state, activeId: wanted });
  } catch { /* storage disabled — the event below still handles a mounted strip */ }
  window.dispatchEvent(new CustomEvent('studio-select-tab', {
    detail: { studioType: section, tabId: wanted },
  }));
}
