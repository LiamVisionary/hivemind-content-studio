// Where you drop something decides what it MEANS.
//
// Anywhere in the studio, dragging in a generated clip or picture restores the
// settings that made it (see app/OutputRestoreDropZone.jsx). Over the composer
// — the box you write the shot in — the same file is an INPUT instead, filed by
// what it is: a picture, a motion clip or a voice clip.
//
// This module is the routing half, kept out of the panels so the composer and
// the References panel file a dropped file identically: same slot, same order,
// same refusals. The WORDING of a refusal belongs to the panel (it is
// translated, and it names the row) — this returns codes.
import { referenceDropBlock, referenceKindForFile } from './h3References.js';
import { isPersistentUploadReference, saveUpload } from './uploadHistory.js';

// An in-app drag of one of our own outputs. Written by the gallery/history
// strips, read by both the restore zone and the composer — one constant so the
// two can never drift apart.
export const HIVEMIND_OUTPUT_DRAG_TYPE = 'application/x-hivemind-output';

// True for anything either drop target can act on. Uses `types` alone: during
// dragenter/dragover the browser is in protected mode and getData() returns ''
// — the payload itself is only readable once the user lets go.
export function dragCarriesDroppable(dataTransfer) {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types || []);
  return types.includes(HIVEMIND_OUTPUT_DRAG_TYPE) || types.includes('Files');
}

// The in-app output being dragged, once the drop has happened.
export function droppedOutputPayload(dataTransfer) {
  try {
    const raw = dataTransfer?.getData?.(HIVEMIND_OUTPUT_DRAG_TYPE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.url) return null;
    return { url: parsed.url, section: parsed.section || '', mediaType: parsed.mediaType || '' };
  } catch {
    return null;
  }
}

// Which reference row a dragged output belongs in. The strips say what they are
// carrying; `section` is the fallback for an older payload that did not.
export function referenceKindForOutput(payload) {
  const mime = String(payload?.mediaType || '').toLowerCase();
  if (mime.startsWith('video/')) return 'videos';
  if (mime.startsWith('audio/')) return 'audios';
  if (mime.startsWith('image/')) return 'images';
  return payload?.section === 'video' ? 'videos' : 'images';
}

// Uploads one file and hands back the row entry. Pictures also join the shared
// upload history — it backs the picture grids elsewhere in the studio, which
// cannot render a clip — but only when the upload produced something that
// outlives the session: a local model hands back a data: URL, and a megabyte of
// base64 does not belong in the history store.
export function referenceUploader(doUpload) {
  return async (kind, file) => {
    const uploaded = await doUpload(file);
    const url = typeof uploaded === 'string' ? uploaded : uploaded?.url;
    if (!url) throw new Error('Upload returned no URL');
    if (kind === 'images' && isPersistentUploadReference(url)) {
      saveUpload({ id: `${Date.now()}${Math.random()}`, uploadedUrl: url, name: file.name });
    }
    return { url, name: file.name };
  };
}

/**
 * Files each dropped file into its row, in drop order, stopping at each row's
 * limit. The counts are tracked locally because several files can land in one
 * drop, long before React has re-rendered with the first one attached.
 *
 * Each rejection carries WHY as a code. An unsupported file, a full row and a
 * server refusal (too large, too short, bad codec) need opposite fixes, and
 * collapsing them into one sentence tells the user nothing.
 *
 * @returns {Promise<{added: {images: [], videos: [], audios: []}, rejected: []}>}
 */
export async function attachDroppedReferences({ files, taken = {}, limits = {}, upload }) {
  const counts = { images: 0, videos: 0, audios: 0, ...taken };
  const added = { images: [], videos: [], audios: [] };
  const rejected = [];
  for (const file of Array.from(files || [])) {
    const kind = referenceKindForFile(file);
    const limit = kind ? (limits[kind] || 0) : 0;
    const block = referenceDropBlock({ kind, taken: counts[kind], limit });
    if (block) {
      rejected.push({ name: file.name, code: block, kind, limit });
      continue;
    }
    counts[kind] += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      added[kind].push(await upload(kind, file));
    } catch (error) {
      // The server states its cap but cannot state YOUR file's size, and
      // "max 100 MB" is only actionable next to the number it is compared to.
      rejected.push({ name: file.name, code: 'upload-failed', kind, limit, error, size: file.size });
      counts[kind] -= 1;
    }
  }
  return { added, rejected };
}
