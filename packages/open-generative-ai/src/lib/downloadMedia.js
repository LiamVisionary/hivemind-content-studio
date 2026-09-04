// The one way this app saves a generated file to disk.
//
// Every studio had its own byte-identical copy of this, which is how the naming
// drifted: our download button used the model-derived name from downloadNames.js
// while right-click "Save image as…" and the native <video> download control fell
// back to whatever the URL or blob happened to be called.
//
// Single source of truth has two halves, and both live here:
//   1. this function, used by every explicit download control, and
//   2. the registry in e2eMedia.js, which names the decrypted File so the
//      BROWSER's own download paths offer the same filename.
// Both read the same name, produced once by downloadNames.js at generation time.

import { isSealedEnvelopeResponse, mediaDownloadNameFor, mediaSealFailure, resolveMediaSrc } from './e2eMedia.js';

// resolveMediaSrc is fail-open: on a locked vault, a foreign key, or any decrypt
// error it hands back the ORIGINAL url. Fetching that returns the sealed envelope,
// and saving it under the model-derived .mp4/.jpg name puts 2 MB of
// {"ciphertext":…,"wrapped_dek":…} in ~/Downloads, where ffprobe reports "moov
// atom not found" and the generation looks broken. Refusing is the honest answer.
export const MEDIA_DOWNLOAD_BLOCKED_EVENT = 'hivemind-media-download-blocked';

const BLOCKED_MESSAGE = {
  locked: 'This output is encrypted and your vault is locked in this tab. Unlock the studio, then download it again.',
  undecryptable: "This output is encrypted and your vault can't open it — it was sealed for a different key. There is nothing to save.",
};

function refuseCiphertext(url) {
  const reason = mediaSealFailure(url) || 'undecryptable';
  const message = BLOCKED_MESSAGE[reason] || BLOCKED_MESSAGE.undecryptable;
  try {
    window.dispatchEvent(new CustomEvent(MEDIA_DOWNLOAD_BLOCKED_EVENT, { detail: { url, reason, message } }));
  } catch { /* no window (tests) */ }
  return { ok: false, blocked: true, reason, message };
}

/**
 * The decrypted bytes behind `url`, or a refusal.
 *
 * Split out of downloadMedia so that every path which takes plaintext OUT of
 * the studio runs the same ciphertext check. Saving an envelope to disk is a
 * wasted click; handing one to a third party would publish a file nobody can
 * open under a name that claims otherwise — so both go through here.
 *
 * Returns `{ ok: true, blob }`, or the same `{ ok: false, blocked, reason,
 * message }` shape downloadMedia has always returned.
 */
export async function resolvePlaintextMedia(url) {
  let response;
  try {
    response = await fetch(await resolveMediaSrc(url));
  } catch {
    // A URL already proven to be ciphertext we can't open.
    if (mediaSealFailure(url)) return refuseCiphertext(url);
    return { ok: false, blocked: false, unreachable: true };
  }
  // The check that depends on no bookkeeping: if the bytes still announce
  // themselves as a sealed envelope, they are ciphertext.
  if (isSealedEnvelopeResponse(response)) {
    try { response.body?.cancel(); } catch { /* already consumed */ }
    return refuseCiphertext(url);
  }
  try {
    return { ok: true, blob: await response.blob() };
  } catch {
    return { ok: false, blocked: false, unreachable: true };
  }
}

/**
 * The desktop shell's save pair, or null in a browser.
 *
 * A WKWebView does not carry out `<a download>` of a `blob:` URL on its own, so
 * in the packaged Tauri app every Download button in this studio would click and
 * do nothing. Tauri exposes its plugin APIs on `window.__TAURI__` when the shell
 * sets `app.withGlobalTauri` (see docs/RELEASE.md §2.4 for the plugins and the
 * capability scope this expects); both halves are checked because the dialog
 * without the write is a save sheet that saves nothing.
 */
function desktopSavePair() {
  const tauri = typeof window === 'undefined' ? null : window.__TAURI__;
  const save = tauri?.dialog?.save;
  const write = tauri?.fs?.writeFile;
  return typeof save === 'function' && typeof write === 'function' ? { save, write } : null;
}

function extensionFilters(name) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return match ? [{ name: match[1].toUpperCase(), extensions: [match[1].toLowerCase()] }] : [];
}

/**
 * Last resort when neither a native dialog nor an anchor can write the file:
 * put the bytes somewhere the user can still keep them. Text goes to the
 * clipboard (a recovery key pasted into a password manager is a saved recovery
 * key); anything else opens in a tab the user can print or save by hand. Doing
 * nothing is the one outcome this function exists to prevent.
 */
async function keepSomehow(blob) {
  const text = /^text\/|json|xml/i.test(blob?.type || '');
  if (text && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(await blob.text());
      return { ok: true, method: 'clipboard' };
    } catch { /* fall through to a tab */ }
  }
  try {
    const url = URL.createObjectURL(blob);
    if (window.open(url, '_blank')) return { ok: true, method: 'window' };
  } catch { /* nothing left to try */ }
  return { ok: false, method: 'none' };
}

/**
 * THE way this app puts bytes on the user's disk.
 *
 * Branches on the desktop shell because the two environments save differently
 * and only one of them is a browser:
 *   * Tauri → native save dialog, then a write. A cancelled dialog is a
 *     deliberate "no", reported as `cancelled` so callers do not treat it as a
 *     failure and open a tab over the user's decision.
 *   * anywhere else → the `<a download>` an ordinary browser understands.
 *   * neither worked → clipboard or a tab (`keepSomehow`).
 *
 * Returns `{ ok, method, cancelled? }`. Every explicit save in the studio —
 * media downloads, the sprite sheet and atlas, a persona export, the vault
 * recovery key — goes through here, so the desktop branch is written once.
 */
export async function saveBytes(blob, filename) {
  const name = filename || '';
  const native = desktopSavePair();
  if (native) {
    try {
      const path = await native.save({ defaultPath: name || 'download', filters: extensionFilters(name) });
      if (!path) return { ok: false, cancelled: true, method: 'tauri' };
      await native.write(path, new Uint8Array(await blob.arrayBuffer()));
      return { ok: true, method: 'tauri', path };
    } catch {
      // A shell that refused the write still has a webview; try the browser
      // path rather than losing the file to a plugin misconfiguration.
    }
  }
  let blobUrl = null;
  try {
    blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    if (name) anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(blobUrl);
    return { ok: true, method: 'anchor' };
  } catch {
    if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch { /* already gone */ } }
    return keepSomehow(blob);
  }
}

/**
 * Save `url` to disk as `filename`. When no filename is given, the registered
 * model-derived name is used, so callers that don't know the model still get the
 * right one. Falls back to opening the media in a new tab, which is better than
 * silently doing nothing — unless the media is sealed ciphertext, which is
 * refused outright.
 */
export async function downloadMedia(url, filename) {
  const name = filename || mediaDownloadNameFor(url) || '';
  const resolved = await resolvePlaintextMedia(url);
  if (!resolved.ok) {
    // Unreadable but not ciphertext: a new tab is still better than nothing.
    if (resolved.unreachable) {
      window.open(url, '_blank');
      return { ok: false, blocked: false };
    }
    return resolved;
  }
  const blob = resolved.blob;
  // Name the blob too: if anything downstream re-derives a name from this
  // object rather than the anchor, it still agrees.
  const payload = name ? new File([blob], name, { type: blob.type }) : blob;
  const saved = await saveBytes(payload, name);
  if (saved.ok) return { ok: true, blocked: false };
  // A cancelled save sheet is the user's answer, not a failure to route around.
  if (saved.cancelled) return { ok: false, blocked: false, cancelled: true };
  window.open(url, '_blank');
  return { ok: false, blocked: false };
}
