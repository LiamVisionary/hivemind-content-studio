// The two ways a finished generation leaves this studio carrying more than
// pixels: saved WITH its settings written in, or handed to the system share
// sheet.
//
// Why either needs saying out loud. Everything the studio keeps is sealed, and
// the local lane runs ComfyUI with --disable-metadata, so a downloaded picture
// is exactly its pixels: the prompt, the seed, the model and the LoRAs live
// encrypted in the owner's vault (generationSetupStore.js), beside the output
// rather than inside it. Sending someone that file sends them a picture. That
// is the default and it stays the default.
//
// Both doors here break it, in different directions:
//
//   * downloadMediaWithSettings() writes the A1111 `parameters` block INTO the
//     file — the same stamp the Civitai handoff makes, because that is the
//     format the ecosystem reads. From then on the prompt travels with the
//     file, to everyone it is ever sent to, and there is no taking it back out
//     of a copy somebody already has. Which is why the studio makes you turn it
//     on (prefs.js: unencryptedDownload) before the menu item does anything.
//
//   * shareMedia() hands the plaintext bytes to the OS share sheet. It shares
//     exactly what the plain Download writes — no stamped settings, whatever
//     the toggle says — because "share" is one tap and the surprise would be
//     expensive.
//
// Neither invents a save path: both end in saveBytes()/navigator.share with
// bytes that came through resolvePlaintextMedia(), the one guard that refuses
// to hand out an envelope under a name claiming it is a picture.

import { measureMedia } from './civitaiPost.js';
import { resolvePlaintextMedia, saveBytes } from './downloadMedia.js';

/** The stamping route (api/bridge.py). Same origin, owner-gated. */
const STAMP_ENDPOINT = '/api/media/stamp-settings';

/** How long a dimension probe may hold up a save it is only decorating. */
const MEASURE_TIMEOUT_MS = 4000;

/**
 * A File the OS and the stamper can both name, from resolved plaintext.
 *
 * `filename` matters more than it looks: the share sheet shows it, AirDrop
 * keeps it, and the stamper picks its container from the extension. It is
 * always the model-derived name (downloadNames.js), never the opaque URL.
 */
function namedFile(blob, filename) {
  const name = String(filename || '').trim();
  return name ? new File([blob], name, { type: blob.type }) : blob;
}

/**
 * Save `url` with its generation settings written into the file.
 *
 * `meta` is postMetaFromEntry() from the context captured for THIS output —
 * never the composer's current state, which is a different generation by the
 * time anybody presses this.
 *
 * Returns the same shape downloadMedia() does, plus `embedded`: false means the
 * file was saved but the settings did not travel (no Pillow, no ffmpeg, a
 * container that will not carry tags). Callers say so rather than implying a
 * stamp that is not there.
 */
export async function downloadMediaWithSettings(url, filename, meta, fetchImpl = fetch) {
  const resolved = await resolvePlaintextMedia(url);
  // A refusal here is a sealed output this tab cannot open. It carries the
  // vault's own sentence ("unlock the studio, then download it again"), which
  // is more useful than anything this layer could add — pass it straight up.
  if (!resolved.ok) return resolved;

  // `Size` is the one setting the studio cannot know from its own records: the
  // recorded aspect is a ratio, an upscale changes the pixels without changing
  // it, and a lane can snap to its own buckets. The decrypted bytes are already
  // here, so measure them rather than write a number that might be a lie.
  //
  // Guarded AND capped, because it is a NICETY and not the job. measureMedia
  // probes through a detached <img>/<video> and resolves on `load` or `error`;
  // a container that fires neither would leave this awaiting forever, which is
  // a Download button that spins and never finishes. Losing a Size line is the
  // right price.
  const settings = { ...(meta || {}) };
  if (!settings.size) {
    try {
      let timer = null;
      const measured = await Promise.race([
        measureMedia(resolved.blob),
        // Cleared on the way out: a race leaves the loser running, and an
        // uncancelled timer per download is a handle nothing ever collects.
        new Promise((resolve) => { timer = setTimeout(() => resolve({}), MEASURE_TIMEOUT_MS); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (measured.width && measured.height) settings.size = `${measured.width}x${measured.height}`;
    } catch { /* no dimensions is a missing line, not a failed download */ }
  }

  const form = new FormData();
  form.append('file', namedFile(resolved.blob, filename || 'creation'));
  form.append('meta', JSON.stringify(settings));

  let response;
  try {
    response = await fetchImpl(STAMP_ENDPOINT, { method: 'POST', body: form });
  } catch {
    return { ok: false, blocked: false, unreachable: true };
  }
  if (!response.ok) return { ok: false, blocked: false, unreachable: true };

  const embedded = response.headers?.get?.('X-Settings-Embedded') === '1';
  let stamped;
  try {
    stamped = await response.blob();
  } catch {
    return { ok: false, blocked: false, unreachable: true };
  }

  const saved = await saveBytes(namedFile(stamped, filename), filename || '');
  // A cancelled save sheet is the person's answer, not a failure to route around.
  if (saved.cancelled) return { ok: false, blocked: false, cancelled: true, embedded };
  return { ok: Boolean(saved.ok), blocked: false, embedded };
}

/**
 * Can this browser hand a FILE to the system share sheet?
 *
 * Two different capabilities wear one name. `navigator.share` alone shares text
 * and links — every mobile browser has it, and some desktop ones — while
 * sharing FILES is Web Share level 2 and is what this studio needs; a browser
 * with the first and not the second throws on the call. `canShare({files})` is
 * the only honest test, and it needs a real File, so this builds a token one.
 *
 * Called during render to decide whether to draw the item enabled, so it is
 * cheap and never throws.
 */
export function canShareMedia() {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files: [new File([new Uint8Array(1)], 'probe.png', { type: 'image/png' })] });
  } catch {
    return false;
  }
}

/**
 * Hand `url` to the system share sheet.
 *
 * Shares the plaintext media only — the same bytes the plain Download writes,
 * with no settings stamped in. The share sheet is one tap and its targets are
 * other people's apps; a prompt riding along inside the file would be a
 * surprise nobody consented to. Someone who wants the settings to travel picks
 * the download that says so.
 *
 * Returns `{ ok }`, `{ ok: false, cancelled: true }` when the sheet is
 * dismissed (an answer, not a failure), `{ ok: false, unsupported: true }`
 * where the browser has no file sharing, or the resolver's own refusal for a
 * sealed output.
 */
export async function shareMedia(url, filename, { title = '', text = '' } = {}) {
  if (!canShareMedia()) return { ok: false, blocked: false, unsupported: true };
  const resolved = await resolvePlaintextMedia(url);
  if (!resolved.ok) return resolved;

  const file = namedFile(resolved.blob, filename || 'creation');
  const payload = { files: [file] };
  if (title) payload.title = title;
  if (text) payload.text = text;
  // The probe above proved the browser can share SOME file; this one asks about
  // the actual file, whose type a target may still refuse.
  try {
    if (!navigator.canShare(payload)) return { ok: false, blocked: false, unsupported: true };
  } catch {
    return { ok: false, blocked: false, unsupported: true };
  }
  try {
    await navigator.share(payload);
    return { ok: true, blocked: false };
  } catch (error) {
    // AbortError is the person closing the sheet. Every browser reports it the
    // same way, and treating it as an error would put a red toast over a
    // deliberate "no".
    if (String(error?.name || '') === 'AbortError') return { ok: false, blocked: false, cancelled: true };
    return { ok: false, blocked: false, failed: true };
  }
}
