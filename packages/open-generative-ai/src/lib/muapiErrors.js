// One reading of a MUAPI (cloud) failure for every studio that calls it.
//
// muapi.js throws plain Errors whose message carries the HTTP status and up to
// 100 chars of the raw body ("API Request Failed: 401 Unauthorized - {…}"),
// which the studios used to paste straight into a toast. This turns that into
// something a person can act on: a rejected key points at Settings, a 4xx says
// what the server said, anything else names the status. Pure (no React, no
// toast) like the rest of src/lib, so the mapping is testable in node; the
// toast that carries the "Open Settings" action lives in
// studios/lipsync/muapiErrorToast.jsx.

const KEY_MISSING = /api key missing/i;
// The status sits right after the "… Failed:" / "… failed:" prefix muapi.js uses,
// never inside the body it appends, so the first 3-digit run after it is safe.
const STATUS_IN_MESSAGE = /\b(?:failed|error)\b[^0-9]{0,4}(\d{3})\b/i;

/** FastAPI-style `detail` → one line. Arrays of { msg } become "a · b". */
export function flattenApiDetail(detail) {
  if (detail == null || detail === '') return '';
  if (Array.isArray(detail)) {
    return detail
      .map((item) => (item && typeof item === 'object' ? (item.msg || item.message || '') : String(item)))
      .filter(Boolean)
      .join(' · ');
  }
  if (typeof detail === 'object') return String(detail.message || detail.msg || detail.error || '');
  return String(detail);
}

/** The HTTP status behind a MUAPI error, or 0 when there was none (network). */
export function muapiErrorStatus(error) {
  const direct = Number(error?.status);
  if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct;
  const match = STATUS_IN_MESSAGE.exec(String(error?.message || ''));
  return match ? Number(match[1]) : 0;
}

// What the server said, when muapi.js appended its body: the JSON detail/error
// field if the slice still parses, else the raw text after " - ".
function serverSaid(message) {
  const tail = String(message || '').split(' - ').slice(1).join(' - ').trim();
  if (!tail) return '';
  try {
    const parsed = JSON.parse(tail);
    const said = flattenApiDetail(parsed?.detail ?? parsed?.error ?? parsed?.message);
    if (said) return said;
  } catch { /* the body was cut at 100 chars or was never JSON */ }
  // A truncated JSON body reads as noise; a plain sentence is worth keeping.
  return tail.startsWith('{') || tail.startsWith('[') ? '' : tail;
}

/**
 * → { status, message, keyRejected }. `keyRejected` means the fix is a key
 * (none, or a 401/403 from MUAPI), and the toast carries the button that adds
 * one — so the message names the fix without naming a page.
 */
export function describeMuapiError(error) {
  const raw = String(error?.message || error || '').trim();
  const status = muapiErrorStatus(error);
  if (KEY_MISSING.test(raw)) {
    return { status, message: 'MUAPI key missing — add one to continue', keyRejected: true };
  }
  if (status === 401 || status === 403) {
    return { status, message: 'MUAPI key rejected — check it and try again', keyRejected: true };
  }
  if (status >= 400 && status < 500) {
    const said = serverSaid(raw);
    return { status, message: said ? `MUAPI refused the request: ${said}` : `MUAPI refused the request (${status})`, keyRejected: false };
  }
  if (status >= 500) {
    return { status, message: `MUAPI request failed (${status}) — try again in a moment`, keyRejected: false };
  }
  if (/failed to fetch|networkerror|load failed/i.test(raw)) {
    return { status: 0, message: 'MUAPI could not be reached — check the connection and try again', keyRejected: false };
  }
  // "Generation failed: …", "Generation timed out after polling." and friends
  // already say what happened.
  return { status, message: raw || 'MUAPI request failed', keyRejected: false };
}

// The app router treats page:'settings' as "open the settings modal".
export function openStudioSettings() {
  try {
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'settings' } }));
  } catch { /* no window (tests) */ }
}
