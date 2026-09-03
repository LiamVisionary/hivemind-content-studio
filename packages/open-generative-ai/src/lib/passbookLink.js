// One door to PassBook, and it opens on the key you were missing.
//
// PassBook holds twelve credentials. "Set OPENAI_API_KEY" sent people to a page
// of twelve rows and left them to find it — a remedy that names the fix and
// then hides it. So the link carries the key: `?page=passbook&key=OPENAI_API_KEY`
// is read by PassBookView, which scrolls that row into view and focuses its
// field. The query parameter is the shareable half (a link in a note still
// works); the event is for a press made while PassBook is already the open
// page, which the router treats as a no-op.

export const PASSBOOK_KEY_PARAM = 'key';
export const PASSBOOK_FOCUS_EVENT = 'passbook-focus-key';

/** The key this page was opened for, if any. */
export function requestedPassBookKey() {
  try {
    return String(new URLSearchParams(window.location.search).get(PASSBOOK_KEY_PARAM) || '');
  } catch {
    return '';
  }
}

/** Forget it once it has been honoured, so a later reload does not re-focus. */
export function clearRequestedPassBookKey() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(PASSBOOK_KEY_PARAM)) return;
    url.searchParams.delete(PASSBOOK_KEY_PARAM);
    window.history.replaceState(window.history.state, '', url);
  } catch { /* non-critical */ }
}

/** Open PassBook with one credential row focused. */
export function openPassBookForKey(name) {
  const key = String(name || '').trim();
  try {
    const url = new URL(window.location.href);
    if (key) url.searchParams.set(PASSBOOK_KEY_PARAM, key);
    else url.searchParams.delete(PASSBOOK_KEY_PARAM);
    window.history.replaceState(window.history.state, '', url);
  } catch { /* non-critical */ }
  window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'passbook' } }));
  // Already on the page: the router ignores a re-press, so say it directly.
  if (key) window.dispatchEvent(new CustomEvent(PASSBOOK_FOCUS_EVENT, { detail: { key } }));
}
