// Posting a finished generation to Civitai.
//
// Civitai has no upload API — the public REST API is read-only — so the
// supported route is their Post Intent System: open
// civitai.com/intent/post?mediaUrl=…, and the composer (in a tab already signed
// in to Civitai) fetches that URL itself and attaches what it finds.
//
// Which makes the browser the courier. The studio's outputs are sealed and only
// this side holds the vault key, so:
//
//   1. the bytes are decrypted HERE, through the same guard the downloader uses
//      — an envelope must never be handed to a third party under a name that
//      claims it is a picture;
//   2. the plaintext is posted to this machine's own staging route, which
//      writes the generation metadata into the file and parks it behind a
//      short-lived random token;
//   3. Civitai's composer opens and reads it back from that token URL.
//
// Nothing is uploaded to a bucket or a CDN, and the file is dropped as soon as
// the post is made. What DOES leave, unencrypted and irreversibly, is the
// creation itself — which is the point, and is why the dialog asks first.
import { resolvePlaintextMedia } from './downloadMedia.js';

// Civitai's own ceilings (src/server/common/constants.ts, read 2026-08-28).
// Mirrored on this side so an oversized clip is refused before it is read into
// memory and posted, rather than after.
export const CIVITAI_LIMITS = {
  imageBytes: 50 * 1024 ** 2,
  videoBytes: 750 * 1024 ** 2,
  videoSeconds: 245,
  videoDimension: 3840,
  tags: 5,
};

const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'video/mp4', 'video/webm']);

export function isPostableType(type) {
  return ACCEPTED.has(String(type || '').split(';', 1)[0].trim().toLowerCase());
}

export function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Measure a blob the way Civitai will: duration and pixel dimensions.
 *
 * Worth doing before the upload rather than after. A 4k clip and a 300-second
 * one are both refused by Civitai's composer, and finding that out here costs
 * a few milliseconds instead of several hundred megabytes.
 */
export function measureMedia(blob) {
  const kind = String(blob?.type || '').startsWith('video/') ? 'video' : 'image';
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(blob);
    const done = (value) => {
      URL.revokeObjectURL(objectUrl);
      resolve({ kind, width: 0, height: 0, duration: 0, ...value });
    };
    if (kind === 'video') {
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => done({
        width: probe.videoWidth,
        height: probe.videoHeight,
        // A live stream reports Infinity; treated as unknown rather than as a
        // number, so the duration check does not refuse on a bogus value.
        duration: Number.isFinite(probe.duration) ? probe.duration : 0,
      });
      probe.onerror = () => done({});
      probe.src = objectUrl;
      return;
    }
    const probe = new Image();
    probe.onload = () => done({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => done({});
    probe.src = objectUrl;
  });
}

/**
 * What Civitai would refuse, named with the number that fails. Empty means OK.
 *
 * The size messages lead with the LIMIT rather than comparing two rendered
 * sizes: a file one byte over rounds to the same string as the limit itself,
 * and "this clip is 750.0 MB, the limit is 750.0 MB" reads as a bug.
 */
export function limitProblems({ type, size, width, height, duration }) {
  const problems = [];
  if (!isPostableType(type)) {
    problems.push(`Civitai does not accept ${type || 'this file type'}. It takes PNG, JPEG, WebP, MP4 and WebM.`);
    return problems;
  }
  if (String(type).startsWith('video/')) {
    if (size > CIVITAI_LIMITS.videoBytes) {
      problems.push(`This clip is over Civitai's ${formatBytes(CIVITAI_LIMITS.videoBytes)} limit for video (it is ${formatBytes(size)}).`);
    }
    if (duration > CIVITAI_LIMITS.videoSeconds) {
      problems.push(`This clip runs ${Math.round(duration)}s; Civitai's limit is ${CIVITAI_LIMITS.videoSeconds}s.`);
    }
    if (Math.max(width || 0, height || 0) > CIVITAI_LIMITS.videoDimension) {
      problems.push(`This clip is ${width}×${height}; Civitai's limit is ${CIVITAI_LIMITS.videoDimension}px on a side.`);
    }
    return problems;
  }
  if (size > CIVITAI_LIMITS.imageBytes) {
    problems.push(`This image is over Civitai's ${formatBytes(CIVITAI_LIMITS.imageBytes)} limit (it is ${formatBytes(size)}).`);
  }
  return problems;
}

/** Civitai allows five tags; the sixth onwards is dropped here rather than
 *  failing their whole page with "Maximum of 5 tags allowed". */
export function normalizeTags(value) {
  const seen = new Set();
  return String(value || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => {
      if (!tag || seen.has(tag.toLowerCase())) return false;
      seen.add(tag.toLowerCase());
      return true;
    })
    .slice(0, CIVITAI_LIMITS.tags);
}

/**
 * The LoRAs a generation used, as Civitai resource links.
 *
 * This is the part the community extension has to work for: ComfyUI metadata
 * carries only file hashes, so it resolves them through Civitai's API and waits
 * for a person to disambiguate. Every LoRA installed through this studio keeps
 * its Civitai sidecar, so the catalog already knows the version id — the join
 * below is the whole lookup.
 *
 * `selection` must be the LoRAs recorded for THAT output (the per-output
 * generation context), never the composer's current selection: crediting a LoRA
 * that was not used is a false claim on a public post.
 */
export function civitaiResourcesFromLoras(selection, catalog) {
  const versions = new Map();
  for (const item of Array.isArray(catalog) ? catalog : []) {
    const id = String(item?.id || '');
    const versionId = Number(item?.versionId);
    if (id && Number.isFinite(versionId) && versionId > 0) versions.set(id, versionId);
  }
  const resources = [];
  for (const lora of Array.isArray(selection) ? selection : []) {
    // A muted LoRA did not shape the output, so it is not a resource of it.
    if (lora?.enabled === false) continue;
    const versionId = versions.get(String(lora?.id || ''));
    // No sidecar means no Civitai identity — a hand-placed file cannot be
    // linked, and guessing from its name would link the wrong thing.
    if (!versionId) continue;
    const weight = Number(lora?.strength);
    resources.push({
      type: 'lora',
      modelVersionId: versionId,
      ...(Number.isFinite(weight) ? { weight } : {}),
    });
  }
  return resources;
}

/**
 * The generation settings that should travel INSIDE the file, from a studio
 * gallery entry. Only what the entry actually holds — a missing seed stays
 * missing rather than becoming a plausible-looking zero, because this ends up
 * in the metadata Civitai shows other people as fact.
 */
export function postMetaFromEntry(entry, measured = {}) {
  const meta = {};
  const prompt = String(entry?.prompt || '').trim();
  if (prompt) meta.prompt = prompt;
  const negative = String(entry?.negativePrompt || '').trim();
  if (negative) meta.negativePrompt = negative;
  if (entry?.model) meta.model = String(entry.model);
  const seed = Number(entry?.seed);
  // -1 is the studio's "random", not a seed anybody could reuse.
  if (Number.isFinite(seed) && seed >= 0) meta.seed = seed;
  const steps = Number(entry?.steps);
  if (Number.isFinite(steps) && steps > 0) meta.steps = steps;
  const cfg = Number(entry?.cfg ?? entry?.guidanceScale);
  if (Number.isFinite(cfg) && cfg > 0) meta.cfgScale = cfg;
  if (entry?.sampler) meta.sampler = String(entry.sampler);
  if (measured.width && measured.height) meta.size = `${measured.width}x${measured.height}`;
  // Resource links, when the studio could tie LoRAs to this exact output.
  if (Array.isArray(entry?.civitaiResources) && entry.civitaiResources.length) {
    meta.civitaiResources = entry.civitaiResources;
  }
  return meta;
}

/**
 * Can Civitai's composer actually reach this studio's staged URL?
 *
 * Only from a SECURE origin. Civitai's page is https, and a browser refuses to
 * let an https page fetch an http subresource — measured 2026-08-28 in a
 * Chromium browser: the request to http://127.0.0.1 was never even sent, so no
 * amount of CORS on our side can rescue it.
 *
 * So a studio opened at http://localhost:8765 cannot do the one-click handoff,
 * while the same studio opened at its https tailnet URL can. Rather than open a
 * Civitai tab that fails with "Could not fetch media from that url", the studio
 * checks first and offers the manual route instead.
 */
export function canHandOffDirectly(loc = (typeof location === 'undefined' ? null : location)) {
  return String(loc?.protocol || '') === 'https:';
}

/** Civitai's own uploader, for the manual route. */
export const CIVITAI_UPLOAD_URL = 'https://civitai.com/posts/create';

/**
 * Decrypt one output and read what Civitai will care about, without sending
 * anything yet. Split from the send so the dialog can show the real size,
 * duration and refusals before the owner commits.
 */
export async function prepareCivitaiPost(url) {
  const resolved = await resolvePlaintextMedia(url);
  if (!resolved.ok) {
    return {
      ok: false,
      // A sealed output carries the vault's own message ("unlock the studio…"),
      // which is more useful than anything this layer could say.
      message: resolved.message || 'Could not read this output.',
      blocked: Boolean(resolved.blocked),
    };
  }
  const blob = resolved.blob;
  const measured = await measureMedia(blob);
  return {
    ok: true,
    blob,
    ...measured,
    size: blob.size,
    type: blob.type,
    problems: limitProblems({ type: blob.type, size: blob.size, ...measured }),
  };
}

/**
 * Stage the plaintext on this machine and return the Civitai URL to open.
 *
 * `fetchImpl` and the returned `token` exist for the caller's cleanup: once the
 * composer has the file, dropCivitaiPost(token) removes the plaintext instead
 * of leaving it to expire.
 */
export async function stageCivitaiPost({
  blob, filename, meta, title, description, tags, fetchImpl = fetch,
}) {
  const form = new FormData();
  form.append('file', new File([blob], filename || 'creation', { type: blob.type }));
  if (title) form.append('title', title);
  if (description) form.append('description', description);
  const tagList = Array.isArray(tags) ? tags : normalizeTags(tags);
  if (tagList.length) form.append('tags', tagList.join(','));
  form.append('meta', JSON.stringify(meta || {}));

  const response = await fetchImpl('/api/civitai-post/stage', { method: 'POST', body: form });
  let payload = {};
  try {
    payload = await response.json();
  } catch { /* a non-JSON body is handled by the status check below */ }
  if (!response.ok || !payload?.intentUrl) {
    throw new Error(payload?.detail || payload?.error || `Could not stage this for Civitai (HTTP ${response.status}).`);
  }
  return payload;
}

export async function dropCivitaiPost(token, fetchImpl = fetch) {
  if (!token) return false;
  try {
    const response = await fetchImpl(`/api/civitai-post/stage/${encodeURIComponent(token)}`, { method: 'DELETE' });
    return response.ok;
  } catch {
    // Cleanup is best-effort: the staging expires on its own, so a failure here
    // costs a few minutes of disk, not correctness.
    return false;
  }
}
