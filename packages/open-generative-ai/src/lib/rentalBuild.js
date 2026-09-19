// The project rental build: what a rented box is provisioned WITH, per tier.
//
// Two decisions live in packages/gpu-rentals/rental-build.json and are meant to
// be committed — which of your LoRAs ride along on a tier's machines, and which
// checkpoint stands in for one of its default weights. This module is the one
// door to that file from the studio.
//
// `editable` is the gate the whole page hangs off, and it is a fact rather than
// a flag: the control API answers true only where this install is a git
// checkout it can write the config into. A packaged app has no repository to
// commit to, so the page is not a thing it can offer — which is the honest form
// of "development only" for a surface whose entire output is a file in the
// repository. It is deliberately NOT a ?dev=1 URL parameter: a packaged window
// has no address bar to type one into, which is how the last dev gate here
// ended up unreachable in the very build that ships.
//
// Shaped like rentalLoras.js next door: module state that survives an unmount,
// subscribe() for the React hook, and a fetch that fails quietly (no control
// API, a locked vault) into `editable: false` rather than into an error.

import { refreshRentalLoras } from './rentalLoras.js';

const state = { status: 'idle', editable: false, path: '', tiers: [] };
const listeners = new Set();
let inflight = null;

function emit() {
  listeners.forEach((fn) => fn(getRentalBuild()));
}

export function getRentalBuild() {
  return { ...state };
}

export function subscribeRentalBuild(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function absorb(body) {
  state.status = 'ready';
  state.editable = Boolean(body?.editable);
  state.path = String(body?.path || '');
  state.tiers = Array.isArray(body?.tiers) ? body.tiers : [];
}

export async function refreshRentalBuild() {
  if (!inflight) {
    inflight = fetch('/api/gpu-rentals/build')
      .then(async (response) => {
        if (!response.ok) throw new Error(`gpu-rentals/build ${response.status}`);
        absorb(await response.json());
      })
      .catch(() => {
        // A stack without the route, a locked vault, a hosted build: there is
        // nothing to edit and nothing to say about it. The row stays unrendered.
        state.status = 'unsupported';
        state.editable = false;
      })
      .then(() => {
        inflight = null;
        emit();
      });
  }
  await inflight;
  return getRentalBuild();
}

// One tier's row, replaced in place by a save. The whole payload is not
// re-fetched: every save answers with the tier it changed, and re-reading the
// list would re-walk the models directory for nothing.
function mergeTier(body) {
  if (!body?.tier) return getRentalBuild();
  state.status = 'ready';
  state.editable = Boolean(body.editable);
  state.tiers = state.tiers.map((row) => (row.tier === body.tier.tier ? body.tier : row));
  emit();
  return getRentalBuild();
}

async function save(path, payload) {
  const response = await fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.detail || `Saving the rental build failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return mergeTier(body);
}

export async function saveRentalBuildLoras(tier, ids) {
  const row = await save(`/api/gpu-rentals/build/${encodeURIComponent(tier)}/loras`, { ids });
  // Pinning STARTS uploads on the server, so the registry this page draws its
  // "in the bucket" state from is stale the moment the save returns. Re-read
  // it: that both picks up the entries that just went to "uploading" — which
  // is what arms the registry store's own poll — and clears a failure from an
  // earlier attempt once the retry lands. Without this the page kept showing
  // "N of these are not in the bucket" against uploads that had since
  // succeeded, with nothing to correct it short of a reload (the poll only
  // runs while something is ALREADY known to be uploading).
  await refreshRentalLoras().catch(() => {});
  return row;
}

export function saveRentalBuildCheckpoint(tier, dest, id, url = '') {
  return save(`/api/gpu-rentals/build/${encodeURIComponent(tier)}/checkpoint`, { dest, id, url });
}

export async function fetchInstalledCheckpoints() {
  const response = await fetch('/api/gpu-rentals/build/checkpoints');
  if (!response.ok) throw new Error(`gpu-rentals/build/checkpoints ${response.status}`);
  const body = await response.json();
  return Array.isArray(body?.checkpoints) ? body.checkpoints : [];
}

// A tier with no pins downloads every registered LoRA whose base-model family
// it serves — the rule every machine rented so far was provisioned under. The
// page has to say which of the two it is looking at, so this is the one place
// that decides: null is "no pins", an array (empty included) is a decision.
export function tierHasLoraPins(tier) {
  return Array.isArray(tier?.pinned_loras);
}

export function tierLoraPins(tier) {
  return tierHasLoraPins(tier) ? tier.pinned_loras : [];
}

// Tests only: the store is a module singleton and node:test files share it.
export function resetRentalBuildForTests() {
  state.status = 'idle';
  state.editable = false;
  state.path = '';
  state.tiers = [];
  inflight = null;
  listeners.clear();
}
