// Prompt-helper model picker: which local LLMs are safe to load right now.
//
// The server reports a `fit` per model, computed from real available memory and
// what the studio could reclaim by unloading its own servers. This turns that
// into what the picker renders, and — more importantly — what it refuses to let
// the user do, because the failure mode being designed out here is an OOM that
// takes a running generation down with it.
//
// Pure helpers live in src/lib so the node:test suite can import them; it cannot
// load JSX.

/** Bytes as a short human string. */
export function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '0 GB';
    if (value < 1024 ** 3) return `${Math.round(value / 1024 ** 2)} MB`;
    return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

/** Can the user pick this model, given the unload-others setting? */
export function canSelect(model, { unloadOthers = true } = {}) {
    if (!model) return false;
    switch (model.fit) {
        case 'loaded':
        case 'fits':
            return true;
        case 'needs_unload':
            // Only reachable *because* loading will free the other models first.
            return Boolean(unloadOthers);
        default:
            return false;
    }
}

/** Why a model is unavailable, or '' when it is selectable. */
export function blockedReason(model, { unloadOthers = true } = {}) {
    if (!model) return '';
    if (canSelect(model, { unloadOthers })) return '';
    if (model.fit === 'needs_unload') {
        return `Needs ${formatBytes(model.estimatedLoadBytes)} — turn on "Unload others first" to make room.`;
    }
    return `Needs ${formatBytes(model.estimatedLoadBytes)}, which is more than this machine can free right now.`;
}

/** Short status line for a model row. */
export function modelStatus(model) {
    if (!model) return '';
    if (model.fit === 'loaded') return 'Loaded';
    const size = formatBytes(model.estimatedLoadBytes);
    // "measured" means the number came from a real load, not the size heuristic.
    return model.measured ? `${size} in RAM` : `~${size} in RAM`;
}

/** Memory the studio cannot reclaim itself, with who is holding it. */
export function externalHold(snapshot) {
    const external = Array.isArray(snapshot?.external) ? snapshot.external : [];
    if (!external.length) return null;
    return {
        count: external.length,
        names: external.map((entry) => entry.id).filter(Boolean),
    };
}

/** Loaded-first, then largest-first, so the useful rows are at the top. */
export function sortModels(models) {
    return [...(Array.isArray(models) ? models : [])].sort((a, b) => {
        const loaded = (m) => (m.fit === 'loaded' ? 0 : 1);
        if (loaded(a) !== loaded(b)) return loaded(a) - loaded(b);
        return (b.sizeBytes || 0) - (a.sizeBytes || 0);
    });
}

// The owner's last choice, so a fresh page load does not re-offer a model they
// already passed over. An id is a filename, not prompt text, so localStorage is
// the right home for it.
const LAST_MODEL_KEY = 'prompt_helper_last_model';

/** The model this browser last used, or '' if it has never been told. */
export function lastUsedModelId() {
    try { return localStorage.getItem(LAST_MODEL_KEY) || ''; } catch { return ''; }
}

/** Remember a choice so the next open starts from it. */
export function rememberModelId(modelId) {
    try { if (modelId) localStorage.setItem(LAST_MODEL_KEY, modelId); } catch { /* quota */ }
}

/**
 * Which model the picker should start on when nothing is chosen yet.
 *
 * The last used one wins outright — including over a model that happens to be
 * in RAM, since the picker is sorted loaded-first/largest-first and falling
 * through to the top row is exactly the behaviour being replaced. It only loses
 * when it is gone from disk or cannot fit at all.
 */
export function preferredModelId(models, { lastUsedId = '', loadedId = '' } = {}) {
    const rows = sortModels(models);
    const selectable = (id) => {
        const model = id ? rows.find((row) => row.id === id) : null;
        return canSelect(model, { unloadOthers: true }) ? model.id : '';
    };
    return selectable(lastUsedId)
        || selectable(loadedId)
        || rows.find((row) => canSelect(row, { unloadOthers: true }))?.id
        || '';
}
