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

import { isMediaVaultLocked, mediaDownloadNameFor, resolveMediaSrc } from './e2eMedia.js';
import { requestVaultUnlock } from './vaultSession.js';

/**
 * Save `url` to disk as `filename`. When no filename is given, the registered
 * model-derived name is used, so callers that don't know the model still get the
 * right one. Falls back to opening the media in a new tab, which is better than
 * silently doing nothing.
 */
export async function downloadMedia(url, filename) {
  const name = filename || mediaDownloadNameFor(url) || '';
  try {
    const src = await resolveMediaSrc(url);
    if (isMediaVaultLocked(url)) {
      // Sealed media, no vault key in this tab: "saving" would write envelope
      // JSON to disk. Open the unlock flow instead of failing silently.
      requestVaultUnlock();
      return;
    }
    const response = await fetch(src);
    const blob = await response.blob();
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
  } catch {
    window.open(url, '_blank');
  }
}
