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
  sessionIndex.set(url, { section, mediaType, context });
  try {
    if (!isHivemindStudioEnabled()) return; // no durable owner vault in this mode
    if (!(await ensureVaultReady())) return; // locked / not bootstrapped
    const blob = await encryptJson({ v: 1, section, mediaType, url, basename: basenameOf(url), context });
    const names = [...new Set([basenameOf(url), downloadName].filter(Boolean))];
    const keys = [await keyForUrl(url), ...(await Promise.all(names.map(keyForBasename)))];
    await Promise.all(keys.map((key) => putVaultBlob(NAMESPACE, key, blob)));
  } catch {
    // Durable seal is best-effort; the session tier covers this session.
  }
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
  const candidates = [];
  if (url) candidates.push(await keyForUrl(url));
  const name = basename || basenameOf(url);
  if (name) candidates.push(await keyForBasename(name));
  for (const key of candidates) {
    try {
      const ciphertext = await getVaultBlob(NAMESPACE, key);
      if (!ciphertext) continue;
      const payload = await decryptJson(ciphertext);
      if (payload && payload.context) {
        return { section: payload.section, context: payload.context, fidelity: 'full' };
      }
    } catch {
      // corrupt/foreign blob — try the next candidate
    }
  }
  return null;
}
