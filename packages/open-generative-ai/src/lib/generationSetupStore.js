// Durable "record the exact generation settings at generation time, restore them
// when the output is dragged back in" store — shared by the Image and Video studios
// and the window-level drop orchestrator (OutputRestoreDropZone).
//
// Why this exists: ComfyUI runs with --disable-metadata, so output files embed no
// prompt/workflow, and cloud (MUAPI) outputs are only ever a remote CDN URL with no
// local file. The studios already CAPTURE the full generation context at submit time
// (captureImageContext / captureGenerationContext) and keep it in a session-only
// in-memory store. This module additionally seals that captured context to the owner
// vault so any output stays restorable after a reload — using the same client-only
// E2E model as the rest of the app: encryptJson under the owner masterKey, so the
// server only ever stores ciphertext it can never read.
//
// Two tiers, tried in order by resolveGenerationSetup():
//   1. session index — instant, works even when the vault is locked, this session.
//   2. owner vault KV — survives reload / a new session (sealed studio only).

import { decryptJson, encryptJson } from './e2eVault.js';
import { registerMediaDownloadName } from './e2eMedia.js';
import { ensureVaultReady, getVaultBlob, putVaultBlob } from './vaultSession.js';
import { isHivemindStudioEnabled } from './hivemindStudio.js';

const NAMESPACE = 'gen-setup';

// Session-scoped index: output URL → { section, mediaType, context }. A module
// singleton, so it survives in-app navigation (but not a reload — that's tier 2's
// job). Kept independent of each studio's own contextStore so the drop orchestrator,
// which lives outside any studio, can resolve a dropped output.
const sessionIndex = new Map();

/** Last path segment of a URL/path/filename, query- and hash-stripped. */
export function basenameOf(url) {
  if (!url) return '';
  try {
    const noHash = String(url).split('#')[0].split('?')[0];
    const seg = noHash.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(seg);
  } catch {
    return String(url);
  }
}

/** `foo (2).jpg` → `foo.jpg`; the browser's duplicate-download suffix. */
function withoutDuplicateSuffix(name) {
  return String(name || '').replace(/ \((\d+)\)(\.[^.]*)?$/, '$2');
}

/** `foo.jpg` → `foo`. Matching on the stem survives a rewritten extension. */
function stemOf(name) {
  const text = String(name || '');
  const dot = text.lastIndexOf('.');
  return dot > 0 ? text.slice(0, dot) : text;
}

/**
 * Every spelling of a filename worth looking up, most specific first. Also used at
 * seal time so both sides agree on exactly the same set.
 */
export function basenameVariants(name) {
  const base = String(name || '').trim();
  if (!base) return [];
  const deduped = withoutDuplicateSuffix(base);
  return [...new Set([base, deduped, stemOf(base), stemOf(deduped)].filter(Boolean))];
}

async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(String(str));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Vault-KV keys are a single path segment with a strict charset, so a raw URL
// (slashes/colons) can't be a key — hash the identity to fixed hex instead.
async function keyForUrl(url) {
  return `u_${await sha256Hex(String(url))}`;
}
async function keyForBasename(name) {
  return `b_${await sha256Hex(String(name).toLowerCase())}`;
}

// Local generations attach references as `data:` URLs (fileToDataUrl), so a captured
// context can carry several MB of base64 image bytes. Sealing those verbatim grew this
// namespace past 500 MB — 99 of 300 rows were over 256 KB, worst case 4.75 MB — and that
// is what forced a retention cap tight enough to evict the cheap ~2 KB settings rows,
// which is how "No saved settings found for this file" happened for older outputs.
// Small inline references still seal verbatim (a pasted crop restores exactly); anything
// past the per-reference budget becomes a marker so restore can say what to re-attach.
const INLINE_REFERENCE_MAX_CHARS = 128 * 1024;
const OMITTED_REFERENCE = '__hivemind_omitted_reference__';

export function isOmittedReference(value) {
  return typeof value === 'string' && value.startsWith(OMITTED_REFERENCE);
}

/** Settings are what matter and they are tiny; oversized inline media is not. */
export function compactContextForSeal(context) {
  if (!context || typeof context !== 'object') return context;
  let omitted = 0;
  const walk = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith('data:') && value.length > INLINE_REFERENCE_MAX_CHARS) {
        omitted += 1;
        const semi = value.indexOf(';');
        return `${OMITTED_REFERENCE}:${value.slice(5, semi > 5 ? semi : 5) || 'media'}`;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  const compacted = walk(context);
  return omitted ? { ...compacted, omittedReferences: omitted } : compacted;
}

// A marker must never reach the studios — it would render as a broken image, or be
// sent to a model as a bogus reference. Drop the carriers instead, leaving the
// omittedReferences count for the UI to report.
function isDeadReference(value) {
  if (isOmittedReference(value)) return true;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.values(value).some(isOmittedReference);
  }
  return false;
}

export function rehydrateSealedContext(context) {
  if (!context || typeof context !== 'object') return context;
  const walk = (value) => {
    if (Array.isArray(value)) return value.filter((item) => !isDeadReference(item)).map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key, isOmittedReference(item) ? '' : walk(item),
      ]));
    }
    return value;
  };
  return walk(context);
}

/**
 * Record the captured context for a completed generation. Always updates the
 * in-memory index (instant same-session restore, even when the vault is locked),
 * then best-effort seals to the durable vault KV under the URL key plus every
 * basename the user might later re-drop (the served/CDN basename and the app's own
 * download filename). Never throws — generation must not be blocked by a persistence
 * hiccup; the session tier still restores this output within the session.
 */
export async function rememberGenerationSetup({ url, section, mediaType, context, downloadName } = {}) {
  if (!url || !context) return;
  // Publish the model-derived filename synchronously, before anything can decrypt
  // this output: it names the decrypted File so right-click "Save image as…" and
  // the native <video> download control offer the same name as our own button.
  registerMediaDownloadName(url, downloadName);
  // The SESSION tier keeps the context verbatim — it costs nothing in memory and
  // gives a same-session restore full fidelity, references included.
  sessionIndex.set(url, { section, mediaType, context });
  try {
    if (!isHivemindStudioEnabled()) return; // no durable owner vault in this mode
    if (!(await ensureVaultReady())) return; // locked / not bootstrapped
    const blob = await encryptJson({ v: 1, section, mediaType, url, basename: basenameOf(url), context: compactContextForSeal(context) });
    // Seal under every name the user could later re-drop: the served basename, the
    // app's own download filename, and the variants a Downloads folder produces.
    const names = [...new Set(
      [basenameOf(url), downloadName].filter(Boolean).flatMap(basenameVariants),
    )];
    const keys = [await keyForUrl(url), ...(await Promise.all(names.map(keyForBasename)))];
    await Promise.all(keys.map((key) => putVaultBlob(NAMESPACE, key, blob)));
  } catch {
    // Durable seal is best-effort; the session tier covers this session.
  }
}

/**
 * Open the vault ahead of a lookup, while the user is still dragging. Unlocking
 * derives the master key with 600k PBKDF2 iterations — deliberately expensive, and
 * on a cold session it dominates the time between letting go and seeing settings.
 * Idempotent and safe to call on every dragenter; ensureVaultReady caches.
 */
export function warmGenerationSetupLookup() {
  if (!isHivemindStudioEnabled()) return;
  void ensureVaultReady().catch(() => { /* locked; the drop reports it */ });
}

/**
 * Resolve a dropped identity to a restorable payload.
 * Returns one of:
 *   { section, context, fidelity: 'full' }  on a hit
 *   { needsUnlock: true }                   when the durable tier could match but the vault is locked
 *   null                                    when nothing matched
 */
export async function resolveGenerationSetup({ url, basename } = {}) {
  // Tier 1 — session index (works even if the vault is locked).
  if (url && sessionIndex.has(url)) {
    const hit = sessionIndex.get(url);
    return { section: hit.section, context: hit.context, fidelity: 'full' };
  }
  // Tier 2 — durable owner vault KV (only exists in the sealed studio).
  if (!isHivemindStudioEnabled()) return null;
  if (!(await ensureVaultReady())) {
    return (url || basename) ? { needsUnlock: true } : null;
  }
  // A file that has been through a Downloads folder is rarely byte-identical in
  // name to what we served: browsers de-duplicate as "name (1).jpg", and the
  // container extension can be rewritten to match the real bytes. So there are
  // several keys to try — most of which will miss.
  const name = basename || basenameOf(url);
  const candidates = await Promise.all([
    ...(url ? [keyForUrl(url)] : []),
    ...basenameVariants(name).map(keyForBasename),
  ]);

  // Fetch every candidate CONCURRENTLY. Awaiting them one at a time cost a 404
  // round trip per miss, which is what made a drop feel slow — the misses are the
  // common case, and only the winner is worth decrypting. Promise.all preserves
  // order, so the most specific key still wins.
  const fetched = await Promise.all(
    candidates.map((key) => getVaultBlob(NAMESPACE, key).catch(() => null)),
  );
  for (const ciphertext of fetched) {
    if (!ciphertext) continue;
    try {
      const payload = await decryptJson(ciphertext);
      if (payload && payload.context) {
        const context = rehydrateSealedContext(payload.context);
        return {
          section: payload.section,
          context,
          omittedReferences: Number(context?.omittedReferences || 0),
          fidelity: context?.omittedReferences ? 'settings' : 'full',
        };
      }
    } catch {
      // corrupt/foreign blob — try the next candidate
    }
  }
  return null;
}
