// Code-split chunks in a session that outlived the build it booted from.
//
// The studio is served as a prebuilt dist whose chunk filenames carry a content
// hash, so every rebuild renames them. A tab opened before the rebuild still
// holds the OLD map, and the first thing it lazy-loads asks for a file the
// server no longer has:
//
//   Failed to fetch dynamically imported module:
//   http://localhost:8765/assets/PromptHelperDialog-GkW3aS7R.js
//
// Nothing is broken but the tab's idea of where the code lives — one reload
// fetches fresh index.html and the current map. App.jsx already did that for
// the ROUTE loaders, but everything reached through React.lazy bypassed it and
// the rejection landed in the studio's ErrorBoundary as a dead end ("The image
// studio hit an error") for a page that only needed the reload. So the recovery
// lives here, shared by the routes, by `lazyChunk` for lazy components, and by
// a window-level listener that covers every remaining dynamic import (the clip
// joiner, hub data, mediabunny) without each call site opting in.
import { lazy } from 'react';

const CHUNK_RELOAD_KEY = 'studio.chunkReloadedAt';
const RELOAD_GUARD_MS = 60_000;

// Chrome, Safari and Firefox each word this differently; all three mean the
// module URL did not load.
const STALE_CHUNK = /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

export function isStaleChunkError(error) {
  return STALE_CHUNK.test(String(error?.message || error || ''));
}

/**
 * Reload once when a lazy import 404s because the dist was rebuilt underneath
 * this session. Returns true when a reload is on its way, so callers can tell a
 * recoverable stale chunk from a real failure worth reporting.
 */
export function recoverFromStaleChunks(error) {
  if (!isStaleChunkError(error)) return false;
  // Offline looks identical from here, and reloading offline replaces the app
  // with the browser's error page — strictly worse than the message we'd show.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  let lastReload = 0;
  try { lastReload = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY)) || 0; } catch { /* non-critical */ }
  // The timestamp guard stops a reload loop when the server is really broken.
  if (Date.now() - lastReload < RELOAD_GUARD_MS) return false;
  try { sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now())); } catch { /* non-critical */ }
  window.location.reload();
  return true;
}

// One immediate retry absorbs transient failures during dist rebuilds — the
// window where index.html is already new and the chunk is still being written.
export async function loadWithRetry(loader) {
  try { return await loader(); }
  catch { return loader(); }
}

/**
 * React.lazy for a dialog or menu that is shut on arrival. Same signature, but a
 * chunk that has been renamed by a rebuild reloads the page instead of crashing
 * the boundary above it.
 */
export function lazyChunk(loader) {
  return lazy(() => loadWithRetry(loader).catch((error) => {
    console.error('[studio] failed to load a lazy component:', error);
    // A reload is on the way; the throw only keeps the boundary honest if it
    // turns out this was a real failure rather than a stale chunk.
    recoverFromStaleChunks(error);
    throw error;
  }));
}

/**
 * Install the app-wide net. Vite's preload helper dispatches `vite:preloadError`
 * for every failed chunk fetch, which is how the dynamic imports that are NOT
 * components get covered: those are awaited inside try/catch blocks that report
 * "couldn't do that" rather than the truth, and there is no reason to teach each
 * one about chunk hashes.
 */
export function installChunkRecovery() {
  if (typeof window === 'undefined') return;
  window.addEventListener('vite:preloadError', (event) => {
    recoverFromStaleChunks(event?.payload || event);
  });
}
