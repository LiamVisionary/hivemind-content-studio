// Rental-LoRA registry shared by both studios' LoRA panels.
//
// Dev mode marks a locally installed LoRA as "available for rentals": the
// control API uploads the file once to the private R2 bucket, and every NEW
// rented machine whose tier serves the LoRA's base-model family downloads it
// during provisioning (gpu_rentals.py appends it to the onstart model list).
// Machines already attached keep the serving set they provisioned with.
//
// Shaped like civitaiDownloadStore: module-level state that survives panel
// unmounts, one poll loop while an upload is in flight, and subscribe() for
// the React hook. Fetches go to the control API same-origin, exactly like
// rentedMachines.js — and fail just as quietly (locked vault, hosted build
// without a control API), leaving the affordance unrendered.

const POLL_MS = 1500;

// entries: null until a fetch succeeds — callers treat null as "unknown" and
// fail open, never as "nothing is registered".
const state = { status: 'idle', entries: null };
const listeners = new Set();
let inflight = null;
let pollTimer = null;

function emit() {
  listeners.forEach((fn) => fn(getRentalLoras()));
}

export function getRentalLoras() {
  return { status: state.status, entries: state.entries };
}

export function subscribeRentalLoras(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function anyUploading() {
  return Object.values(state.entries || {}).some((entry) => entry.status === 'uploading');
}

function schedulePollIfUploading() {
  if (pollTimer || !anyUploading()) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void refreshRentalLoras();
  }, POLL_MS);
}

async function fetchRegistry() {
  const response = await fetch('/api/gpu-rentals/loras');
  if (!response.ok) throw new Error(`gpu-rentals/loras ${response.status}`);
  const body = await response.json();
  const entries = {};
  for (const entry of body.loras || []) {
    if (entry && entry.id) entries[entry.id] = entry;
  }
  return entries;
}

export async function refreshRentalLoras() {
  if (!inflight) {
    inflight = fetchRegistry()
      .then((entries) => {
        state.status = 'ready';
        state.entries = entries;
      })
      .catch(() => {
        // Keep whatever we knew; with no data at all the panel simply doesn't
        // render the rental affordance ("unsupported"), it never errors.
        state.status = state.entries ? 'ready' : 'unsupported';
      })
      .then(() => {
        inflight = null;
        emit();
        schedulePollIfUploading();
      });
  }
  await inflight;
  return getRentalLoras();
}

function encodeRentalLoraId(id) {
  // Ids keep their models/loras subdirectories; encode each segment but let
  // the slashes through so the :path route parameter receives them.
  return String(id).split('/').map(encodeURIComponent).join('/');
}

export async function addRentalLora(lora, rating, contextBaseModels) {
  const response = await fetch('/api/gpu-rentals/loras', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: lora.id,
      rating,
      baseModel: lora.baseModel || '',
      displayName: lora.displayName || lora.name || '',
      contextBaseModels: Array.isArray(contextBaseModels) ? contextBaseModels : [],
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.detail || `Adding to rentals failed (${response.status})`);
  // Merge immediately so the card flips to "uploading" without waiting a poll.
  state.status = 'ready';
  state.entries = { ...(state.entries || {}), [body.id]: body };
  emit();
  schedulePollIfUploading();
  return body;
}

export async function removeRentalLora(id) {
  const response = await fetch(`/api/gpu-rentals/loras/${encodeRentalLoraId(id)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.detail || `Removing from rentals failed (${response.status})`);
  }
  if (state.entries && state.entries[id]) {
    const next = { ...state.entries };
    delete next[id];
    state.entries = next;
    emit();
  }
  return true;
}

// Rented mode shows only what a machine provisioned today would actually
// download. `entries === null` means the registry is unknown (fetch failed,
// no control API): fail open rather than blank the whole catalog.
// `includeNsfw` is the seam for the future NSFW mode — ratings are already
// stored, so hiding becomes a flag flip here, not a migration.
export function filterRentalLoras(loras, entries, { includeNsfw = true } = {}) {
  if (!entries) return loras || [];
  return (loras || []).filter((lora) => {
    const entry = entries[lora.id];
    if (!entry || entry.status !== 'ready') return false;
    return includeNsfw || entry.rating !== 'nsfw';
  });
}

export function rentalLoraUploadPercent(entry) {
  if (!entry || entry.status !== 'uploading') return 0;
  const total = Number(entry.size_bytes) || 0;
  const done = Number(entry.uploaded_bytes) || 0;
  if (total <= 0) return 0;
  // Cap at 99: "100%" belongs to the server saying ready, not to the last poll.
  return Math.min(99, Math.round((done / total) * 100));
}

// Tests only: the store is a module singleton and node:test files share it.
export function resetRentalLorasForTests() {
  state.status = 'idle';
  state.entries = null;
  inflight = null;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  listeners.clear();
}
