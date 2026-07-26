// Promote a generated output into a persistent reference image.
//
// "Use as video starting frame" and anything else that wants to feed an existing
// generation back in as an input goes through here, so the image lands in the
// SAME place a manual upload does: sealed to the owner vault server-side, and
// listed in the reference pickers' recent grid. Nothing here writes plaintext
// media anywhere — the bytes are decrypted in-browser only long enough to be
// re-uploaded, and the upload endpoint re-seals them.
import { isHivemindStudioEnabled, mediaSourceToDataUrl, uploadFileToHivemindStudio } from './hivemindStudio.js';
import { muapi } from './muapi.js';
import { generateThumbnail, isPersistentUploadReference, saveUpload } from './uploadHistory.js';

function dataUrlToBlob(dataUrl) {
  const [header, encoded] = String(dataUrl || '').split(',');
  if (!encoded) throw new Error('Could not read the generated image.');
  const type = (header.match(/data:([^;]+)/) || [])[1] || 'image/png';
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

function referenceFileName(source, type) {
  const ext = (String(type || '').split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const raw = String(source || '');
  // Local generations hand back a data: URL, which has no meaningful basename —
  // naming it after the payload would produce a multi-kilobyte filename.
  const base = /^(data|blob):/i.test(raw) ? '' : (raw.split('/').pop()?.split('?')[0] || '');
  const stem = base
    .replace(/\.(e2e|zenc)$/i, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9._-]/gi, '_')
    .slice(0, 80);
  return `${stem || `generated-${Date.now()}`}.${ext}`;
}

/**
 * Uploads an in-app image URL (gallery output, viewer image, …) as a reference
 * and records it in the upload history.
 * @returns {Promise<string>} the persistent reference URL to hand to a picker.
 */
export async function promoteOutputToReference(source, { name } = {}) {
  const dataUrl = await mediaSourceToDataUrl(source, 'image');
  if (!dataUrl) throw new Error('Could not read the generated image.');
  const blob = dataUrlToBlob(dataUrl);
  const file = new File([blob], name || referenceFileName(source, blob.type), { type: blob.type || 'image/png' });

  const doUpload = isHivemindStudioEnabled() ? uploadFileToHivemindStudio : (f) => muapi.uploadFile(f);
  const [uploadResult, thumbnail] = await Promise.all([doUpload(file), generateThumbnail(file)]);
  const uploadedUrl = typeof uploadResult === 'string' ? uploadResult : uploadResult?.url;
  if (!uploadedUrl) throw new Error('The reference upload did not return a URL.');

  const entry = {
    id: `${Date.now()}`,
    name: file.name,
    uploadedUrl,
    thumbnail: typeof uploadResult === 'string' ? thumbnail : (uploadResult?.thumbnail || thumbnail),
    timestamp: new Date().toISOString(),
  };
  // Same gate the picker uses: blob:/data: URLs are per-session, never history.
  if (isPersistentUploadReference(uploadedUrl)) saveUpload(entry);
  return uploadedUrl;
}
