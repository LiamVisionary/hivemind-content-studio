export function normalizeLoraWeight(value, fallback = 1) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(-10, Math.min(10, parsed));
}

// A selected LoRA is active unless it was explicitly muted, so selections saved
// before muting existed (and any hand-written entry) stay enabled.
export function isLoraEnabled(item) {
    return item?.enabled !== false;
}

export function toggleLoraSelection(selection, lora) {
    const current = Array.isArray(selection) ? selection : [];
    const id = String(lora?.id || '').trim();
    if (!id) return current;
    if (current.some(item => item.id === id)) {
        return current.filter(item => item.id !== id);
    }
    return [
        ...current,
        {
            id,
            name: String(lora.name || id),
            displayName: String(lora.displayName || lora.name || id),
            previewUrl: String(lora.previewUrl || ''),
            strength: normalizeLoraWeight(lora.defaultWeight, 1),
            enabled: true,
        },
    ];
}

// Mute/unmute in place — the LoRA keeps its slot and its weight, like bypassing
// a node in ComfyUI, so A/B tests don't cost you the tuned strength.
export function toggleLoraEnabled(selection, id) {
    return (Array.isArray(selection) ? selection : []).map(item => (
        item.id === id ? { ...item, enabled: !isLoraEnabled(item) } : item
    ));
}

// Strength Hunt axes (Mix-Studio port): flag up to two LoRAs whose strength the
// backend sweeps 0 → current in one job. The flag rides on the selection so it
// persists per model like mute state; a third toggle-on is refused, not queued.
export const MAX_HUNT_LORAS = 2;

export function toggleLoraHunt(selection, id) {
    const list = Array.isArray(selection) ? selection : [];
    const hunted = list.filter(item => item.hunt).length;
    return list.map(item => {
        if (item.id !== id) return item;
        if (item.hunt) return { ...item, hunt: false };
        return hunted >= MAX_HUNT_LORAS ? item : { ...item, hunt: true };
    });
}

// The 1-2 sweep axes for a generation: hunted, enabled, non-zero strength.
export function huntLoraIds(selection) {
    return (Array.isArray(selection) ? selection : [])
        .filter(item => item.hunt && isLoraEnabled(item) && Number(item.strength) !== 0)
        .map(item => item.id)
        .slice(0, MAX_HUNT_LORAS);
}

export function updateLoraStrength(selection, id, value) {
    return (Array.isArray(selection) ? selection : []).map(item => (
        item.id === id
            ? { ...item, strength: normalizeLoraWeight(value, item.strength ?? 1) }
            : item
    ));
}

// Civitai version names are free text: "v2.0", "2.0", "SDXL - Pruned". Add the "v"
// only when the name is a bare number, never invent one for a file with no Civitai
// sidecar, and leave descriptive names alone rather than mangling them.
export function loraVersionLabel(lora) {
    const name = String(lora?.versionName || '').trim();
    if (!name) return '';
    return /^\d/.test(name) ? `v${name}` : name;
}

// An update-and-replace lands a new file, so the id changes. Carry the slot,
// weight and mute state over instead of silently dropping the LoRA from the
// active set. A no-op when the replaced LoRA was not selected.
export function replaceLoraInSelection(selection, oldId, lora) {
    const current = Array.isArray(selection) ? selection : [];
    const newId = String(lora?.id || '').trim();
    if (!oldId || !newId || !current.some(item => item.id === oldId)) return current;
    if (oldId === newId) return current; // same filename: the file was updated in place
    return current.map(item => (item.id === oldId
        ? {
            ...item,
            id: newId,
            name: String(lora.name || newId),
            displayName: String(lora.displayName || lora.name || newId),
            previewUrl: String(lora.previewUrl || ''),
        }
        : item));
}

function normalizeBase(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Mirrors the gateway's base matching: equal, or one a prefix of the other
// ("Flux.1 D" / "Flux.1 Dev"). "ZImageBase" and "ZImageTurbo" stay distinct.
function sameBaseFamily(a, b) {
    const left = normalizeBase(a);
    const right = normalizeBase(b);
    if (!left || !right) return false;
    return left === right || left.startsWith(right) || right.startsWith(left);
}

const VERSION_TOKEN = /^v?\d+(?:[._-]\d+)*[a-z]?$/;

// Descriptive words of a version name, version numbers removed: "Soft Enhance" →
// {soft, enhance}, "Krea 2 v1.0" → {krea}, "v1.1" → {}.
function versionLabelTokens(name) {
    const words = String(name || '').toLowerCase().split(/[^a-z0-9]+/);
    const labels = new Set();
    for (const word of words) {
        if (!word || VERSION_TOKEN.test(word)) continue;
        const stripped = word.replace(/\d+/g, '');
        if (stripped.length > 1) labels.add(stripped);
    }
    return labels;
}

// Civitai models publish OPTIONS as versions, not only revisions: "LTX 2.3 -
// Enhancers" ships "Soft Enhance" and "Crisp Enhance" side by side, and the higher
// id is simply the other option. Same rule as the gateway's same_version_lineage.
function sameVersionLineage(installedName, latestName) {
    const installed = versionLabelTokens(installedName);
    const latest = versionLabelTokens(latestName);
    if (!installed.size || !latest.size) return true; // a bare "v1.1" contradicts nothing
    const subset = (a, b) => [...a].every(word => b.has(word));
    return subset(installed, latest) || subset(latest, installed);
}

// A Civitai model publishes a version per base model, so its newest version is
// often a different adapter (the Krea 2 build of a Z-Image LoRA) — and even within
// one base it may be a sibling option rather than a newer build. Neither is an
// update, and "update and replace" would delete the installed file for it, so both
// are rejected here as well as server-side.
export function isLoraUpdateCandidate(lora, update) {
    if (!update?.latestVersionId) return false;
    if (update.latestBaseModel && lora?.baseModel && !sameBaseFamily(update.latestBaseModel, lora.baseModel)) {
        return false;
    }
    if (update.currentVersionName && update.latestVersionName
        && !sameVersionLineage(update.currentVersionName, update.latestVersionName)) {
        return false;
    }
    return true;
}

// Update availability is fetched after the catalog (it hits Civitai), so it is
// merged in rather than blocking the list. Keyed by installed-LoRA id.
export function mergeLoraUpdates(loras, updates) {
    const map = updates && typeof updates === 'object' ? updates : {};
    return (Array.isArray(loras) ? loras : []).map(lora => (
        isLoraUpdateCandidate(lora, map[lora.id]) ? { ...lora, update: map[lora.id] } : lora
    ));
}

// ── LoRA groups ──────────────────────────────────────────────────────────────
// A saved group records IDENTITY + tuning only. Catalog metadata (preview URLs,
// display names) goes stale — an update-and-replace rewrites the file — so a
// group is re-resolved against the live catalog when it is loaded, and the saved
// snapshot is used only to NAME adapters that are no longer installed.

export function loraGroupFromSelection(selection, { baseModelId = '', baseLabel = '', baseModels = [] } = {}) {
    return {
        baseModelId: String(baseModelId || ''),
        baseLabel: String(baseLabel || ''),
        baseModels: (Array.isArray(baseModels) ? baseModels : []).map(name => String(name || '')).filter(Boolean),
        loras: (Array.isArray(selection) ? selection : []).map(item => ({
            id: item.id,
            name: String(item.name || item.id),
            displayName: String(item.displayName || item.name || item.id),
            strength: normalizeLoraWeight(item.strength, 1),
            enabled: isLoraEnabled(item),
        })),
    };
}

// Whether a saved group belongs to the model currently selected. Adapters are
// per base family, so a group saved on LTX 2.3 is noise under a Klein model.
// Prefer the recorded family lists (loose spelling match, same as updates);
// groups saved before `baseModels` existed carry only the model id, which still
// pins them to the exact model they were saved on. A group with no recorded
// base matches nothing — the menu files it under "Other models" over guessing.
export function loraGroupMatchesBase(group, { baseModelId = '', baseModels = [] } = {}) {
    const savedFamilies = (Array.isArray(group?.baseModels) ? group.baseModels : []).filter(Boolean);
    const currentFamilies = (Array.isArray(baseModels) ? baseModels : []).filter(Boolean);
    if (savedFamilies.length && currentFamilies.length) {
        return savedFamilies.some(saved => currentFamilies.some(current => sameBaseFamily(saved, current)));
    }
    const savedId = normalizeBase(group?.baseModelId);
    const currentId = normalizeBase(baseModelId);
    return Boolean(savedId && currentId && savedId === currentId);
}

// Returns { selection, missing }. `missing` names the adapters the group refers
// to that are not installed under this base model now, so the UI can say so
// instead of silently applying a smaller stack than the user saved.
export function loraSelectionFromGroup(group, availableLoras) {
    const catalog = new Map((Array.isArray(availableLoras) ? availableLoras : []).map(lora => [lora.id, lora]));
    const selection = [];
    const missing = [];
    for (const saved of group?.loras || []) {
        const live = catalog.get(saved.id);
        if (!live) {
            missing.push(String(saved.displayName || saved.name || saved.id));
            continue;
        }
        selection.push({
            id: live.id,
            name: String(live.name || live.id),
            displayName: String(live.displayName || live.name || live.id),
            previewUrl: String(live.previewUrl || ''),
            strength: normalizeLoraWeight(saved.strength, 1),
            enabled: saved.enabled !== false,
        });
    }
    return { selection, missing };
}

// Muted LoRAs are dropped here rather than in the studios, so every generation
// path (image, video, prompt helper) honours the mute automatically.
export function loraGenerationPayload(selection) {
    return (Array.isArray(selection) ? selection : []).filter(isLoraEnabled).map(item => ({
        id: item.id,
        strength: normalizeLoraWeight(item.strength, 1),
    }));
}
