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
  try {
    const blob = resolved.blob;
    // Name the blob too: if anything downstream re-derives a name from this
    // object rather than the anchor, it still agrees.
    const payload = name ? new File([blob], name, { type: blob.type }) : blob;
    const blobUrl = URL.createObjectURL(payload);
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    if (name) anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(blobUrl);
    return { ok: true, blocked: false };
  } catch {
    window.open(url, '_blank');
    return { ok: false, blocked: false };
  }
}
