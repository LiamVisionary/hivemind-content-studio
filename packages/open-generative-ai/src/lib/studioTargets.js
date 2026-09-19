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

import { t, tf } from './i18n.js';
import { PLACE_ACCOUNTS, PLACE_THIS_MAC } from './modelRunner.js';
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

/**
 * The places work can be sent to, in the order every picker shows them.
 *
 * There used to be three, and the third was not a place: "Rented" was Local
 * plus a menu filter — the fifth copy of a triad that Image, Video, the text
 * producer and Restore each spelled differently. A rental is a property of This
 * Mac (the box its work is currently landing on), so it is named in the row's
 * own note rather than offered as a mode with nothing behind it.
 *
 * The wire values are unchanged: `source` travels between studios, and
 * renaming what a person reads must not rename what a handoff sends.
 */
export const SEND_SOURCES = Object.freeze(['local', 'api']);

export const SOURCE_LABELS = Object.freeze({
  local: t('place.thisMac'),
  api: t('place.accounts'),
});

/** Which of the three places each wire source IS. The menu shows the same
 *  groups as every studio picker rather than a second control beside them. */
export const SOURCE_PLACES = Object.freeze({
  local: PLACE_THIS_MAC,
  api: PLACE_ACCOUNTS,
});

/**
 * One tab's sources, as the rows the RunOnPicker draws.
 *
 * The Send-to menu used to be a two-row control of its own that merely borrowed
 * the new words. It is the picker now: same groups, same rows, same reasons —
 * `id` stays the wire `source`, because a handoff sends that and renaming what
 * a person reads must not rename what travels.
 *
 * @param {object} target one entry from useSendTargets
 * @param {function|null} describeFor the sender's own "what would travel there"
 */
export function sendRunTargets(target, describeFor = null) {
  return SEND_SOURCES.map((source) => {
    const descriptor = target?.sources?.[source] || null;
    const available = Boolean(descriptor?.available);
    // The consequence, on the row: a place with no model named under it is a
    // choice made blind, and `switches` matters as much as the name — this
    // place does not offer the model loaded now, so picking it moves the tab.
    const consequence = available
      ? [descriptor.note, describeFor?.(descriptor.plan) || ''].filter(Boolean).join(' · ')
      : '';
    const model = available ? (descriptor.modelName || descriptor.modelId) : '';
    return {
      id: source,
      provider: 'send',
      source,
      label: available && descriptor.switches
        ? tf('sendTo.switchesTo', model)
        : (model || SOURCE_LABELS[source]),
      place: SOURCE_PLACES[source],
      placeLabel: SOURCE_LABELS[source],
      available,
      unavailableReason: descriptor?.reason || '',
      reason: consequence,
    };
  });
}

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
