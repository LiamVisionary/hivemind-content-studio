// Moving a persona between vaults: the I/O half of lib/personaId.js.
//
// A saved persona is owner-sealed POINTERS. To leave this machine it has to be
// opened — each reference decrypted in the browser (the only place it CAN be)
// and inlined — and to arrive on another one it has to be re-uploaded, so the
// receiving vault seals its own copies and the persona points at those.
//
// Nothing here trusts the file it is given: parsePersonaExport is the gate, and
// it accepts inline media only. A shared persona is data.
import {
  buildPersonaExport,
  parsePersonaExport,
  personaExportFilename,
  personaFromReferences,
} from './personaId.js';
import { saveBytes } from './downloadMedia.js';
import { resolveMediaSrc } from './e2eMedia.js';

/** Decrypt one reference and read it back as an inline data URL. */
async function inlineReference(url) {
  const resolved = await resolveMediaSrc(url);
  // resolveMediaSrc fails open by handing back the original url when the vault
  // is locked or the media is not sealed; fetching that is still correct for
  // an unsealed reference, and simply fails for a locked one — which is what
  // the caller reports as "could not be read".
  const response = await fetch(resolved);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('could not read the decrypted bytes'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(blob);
  });
}

/**
 * Build the portable document for a saved persona. Returns { document, dropped,
 * filename } — `dropped` names any reference whose bytes could not be read, so
 * the caller can say so instead of shipping a smaller character silently.
 */
export async function buildPersonaTransfer(name, personaData) {
  const persona = personaFromReferences(personaData || {});
  const urls = [
    ...persona.images,
    ...persona.videos.map((item) => item.url),
    ...persona.audios.map((item) => item.url),
  ];
  const media = {};
  // Sequential on purpose: each decrypt holds a full-size blob, and a persona
  // is up to fifteen references — doing them at once is how a tab runs out of
  // memory on a phone.
  for (const url of urls) {
    try {
      media[url] = await inlineReference(url);
    } catch {
      // Left out of `media`, which is exactly what buildPersonaExport reports.
    }
  }
  const { document, dropped } = buildPersonaExport({
    name,
    persona,
    media,
    exportedAt: new Date().toISOString(),
  });
  return { document, dropped, filename: personaExportFilename(name) };
}

/**
 * Save the document to disk as a file the user can keep or send on.
 *
 * Through saveBytes, like every other save in the studio: an anchor click is
 * inert in the packaged desktop shell, and this export is one of the paths a
 * person would have believed had worked.
 */
export function downloadPersonaTransfer(document, filename) {
  const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' });
  return saveBytes(blob, filename);
}

/**
 * Read a persona export and re-upload its media into THIS vault, returning the
 * persona payload (pointers to the fresh copies) plus its name.
 *
 * `uploadFn` is the studio's own reference upload — the same path a dragged
 * file takes — so imported media is sealed and swept exactly like anything
 * else. onProgress reports (done, total) because fifteen uploads is not instant.
 */
export async function importPersonaTransfer(text, { uploadFn, onProgress } = {}) {
  const parsed = parsePersonaExport(text);
  if (typeof uploadFn !== 'function') throw new Error('No upload path is available for imported media.');
  const total = parsed.images.length + parsed.videos.length + parsed.audios.length;
  let done = 0;

  const upload = async (dataUrl, fallbackName) => {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const file = new File([blob], fallbackName, { type: blob.type || 'application/octet-stream' });
    const uploaded = await uploadFn(file);
    const url = typeof uploaded === 'string' ? uploaded : uploaded?.url;
    if (!url) throw new Error('the studio did not return a URL for an imported reference');
    done += 1;
    onProgress?.(done, total);
    return url;
  };

  const images = [];
  for (const [index, item] of parsed.images.entries()) {
    images.push(await upload(item.dataUrl, `persona-picture-${index + 1}`));
  }
  const videos = [];
  for (const [index, item] of parsed.videos.entries()) {
    videos.push({
      url: await upload(item.dataUrl, item.name || `persona-motion-${index + 1}`),
      name: item.name,
      useAudio: item.useAudio,
      compact: item.compact,
      ...(item.motion === false ? { motion: false } : {}),
    });
  }
  const audios = [];
  for (const [index, item] of parsed.audios.entries()) {
    audios.push({
      url: await upload(item.dataUrl, item.name || `persona-voice-${index + 1}`),
      name: item.name,
    });
  }
  return { name: parsed.name, data: personaFromReferences({ images, videos, audios, gender: parsed.gender }) };
}
