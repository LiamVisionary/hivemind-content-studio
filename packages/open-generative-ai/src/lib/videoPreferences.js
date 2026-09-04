// Pure video-setup rules: what persists between sessions, how a model's
// advanced inputs are read, and the small geometry/format helpers the setup bar
// needs. No React, no DOM, no network.
//
// They live here rather than in videoLogic.js for the reason videoTasks.js
// spells out: the node:test suite cannot load JSX, so a rule kept in a .jsx file
// is a rule nothing can test. Every one of these was previously duplicated in
// the retired vanilla studio, and the tests imported THAT copy — so the shipped
// versions were unverified and had already drifted (the vanilla
// normalizeVideoPreferences still returns a `pingWhenComplete` field the studio
// stopped persisting when the completion ping became a shared setting).
//
// videoLogic.js re-exports all of this, so studio code keeps one import site.

import { normalizeCameraMotions } from './cameraMotion.js';
import { restylePresetById } from './h3RestylePresets.js';

const VIDEO_ADVANCED_EXCLUDED_INPUTS = new Set([
    'prompt',
    'aspect_ratio',
    'duration',
    'resolution',
    'quality',
    'mode',
    'name',
    'request_id',
    'images_list',
    'video_files',
    'image_url',
    'video_url',
    'last_image',
    'audio',
]);

export const VIDEO_PREFERENCES_KEY = 'video_generation_preferences';

// An advanced input whose name says it takes prose. Its value never reaches the
// plaintext settings blob (see normalizeVideoPreferences); the control itself is
// untouched. Exported so the guard test states the rule rather than re-deriving it.
export const PROMPT_LIKE_INPUT_NAME = /prompt|negative|caption|descri|text|script|dialog|subtitle|lyric|query|instruct/i;

/* ---------------- a model's advanced inputs ---------------- */

export function getAdvancedVideoInputs(model) {
    return Object.entries(model?.inputs || {})
        .filter(([name, input]) => {
            if (VIDEO_ADVANCED_EXCLUDED_INPUTS.has(name) || !input || typeof input !== 'object') return false;
            return ['boolean', 'string', 'int', 'float', 'number'].includes(input.type);
        })
        .map(([name, input]) => ({ name, ...input }));
}

export function getDefaultAdvancedVideoValues(model) {
    return Object.fromEntries(getAdvancedVideoInputs(model).map((input) => {
        if (Object.prototype.hasOwnProperty.call(input, 'default')) return [input.name, input.default];
        if (input.type === 'boolean') return [input.name, false];
        if (Array.isArray(input.enum) && input.enum.length > 0) return [input.name, input.enum[0]];
        if (['int', 'float', 'number'].includes(input.type)) return [input.name, input.minValue ?? 0];
        return [input.name, ''];
    }));
}

export function getAdvancedVideoPayload(model, values) {
    return Object.fromEntries(getAdvancedVideoInputs(model)
        .filter((input) => Object.prototype.hasOwnProperty.call(values || {}, input.name))
        .map((input) => [input.name, values[input.name]]));
}

export function getRestoredAdvancedVideoValues(model, values) {
    const defaults = getDefaultAdvancedVideoValues(model);
    if (!values || typeof values !== 'object' || Array.isArray(values)) return defaults;
    return Object.fromEntries(getAdvancedVideoInputs(model).map((input) => {
        const saved = values[input.name];
        if (saved == null) return [input.name, defaults[input.name]];
        if (input.type === 'boolean') return [input.name, Boolean(saved)];
        if (Array.isArray(input.enum) && input.enum.length > 0) {
            const match = input.enum.find((value) => String(value) === String(saved));
            return [input.name, match ?? defaults[input.name]];
        }
        if (['int', 'float', 'number'].includes(input.type)) {
            const numeric = Number(saved);
            if (!Number.isFinite(numeric)) return [input.name, defaults[input.name]];
            const bounded = Math.min(input.maxValue ?? numeric, Math.max(input.minValue ?? numeric, numeric));
            return [input.name, input.type === 'int' ? Math.round(bounded) : bounded];
        }
        return [input.name, typeof saved === 'string' ? saved : defaults[input.name]];
    }));
}

/* ---------------- what survives a reload ---------------- */

export function normalizeVideoPreferences(value) {
    if (!value || typeof value !== 'object') return null;
    const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
    if (!modelId || modelId.length > 256) return null;
    const duration = Number(value.duration);
    const stringValue = (candidate) => typeof candidate === 'string' ? candidate.trim() : '';
    const advancedValues = value.advancedValues && typeof value.advancedValues === 'object' && !Array.isArray(value.advancedValues)
        ? Object.fromEntries(Object.entries(value.advancedValues).filter(([name, candidate]) => (
            ['string', 'number', 'boolean'].includes(typeof candidate)
            && (typeof candidate !== 'number' || Number.isFinite(candidate))
            // A model's advanced inputs are its own knobs, and a workflow is
            // free to declare one that takes a sentence — `negative_prompt`,
            // `caption`, a per-shot `description`. The control still renders and
            // still ships with the run; the words are simply not written down
            // here, because this blob is plaintext. All we have to go on is the
            // input's NAME, which is why this is a name rule.
            && !PROMPT_LIKE_INPUT_NAME.test(name)
        )))
        : {};
    const loraSelections = {};
    if (value.loraSelections && typeof value.loraSelections === 'object' && !Array.isArray(value.loraSelections)) {
        Object.entries(value.loraSelections).forEach(([model, selections]) => {
            if (!model || !Array.isArray(selections)) return;
            loraSelections[model] = selections.flatMap((selection) => {
                const id = stringValue(selection?.id);
                if (!id) return [];
                const rawStrength = Number(selection.strength);
                const strength = Number.isFinite(rawStrength) ? Math.max(-10, Math.min(10, rawStrength)) : 1;
                return [{
                    id,
                    name: stringValue(selection.name) || id,
                    displayName: stringValue(selection.displayName) || stringValue(selection.name) || id,
                    previewUrl: stringValue(selection.previewUrl),
                    strength,
                    // Muted LoRAs stay in the list (with their weight) across reloads.
                    enabled: selection.enabled !== false,
                }];
            });
        });
    }
    // SELECTION ONLY. A reference's description is a sentence somebody wrote
    // about a picture of their own life ("my daughter at the beach"), so it is
    // prompt text by every definition that matters and follows the negative
    // prompt into the encrypted composer section. What stays here is which
    // reference, in which order — opaque same-origin pointers, no words.
    const ingredientSelections = withoutVideoIngredientDescriptions(value.ingredientSelections);
    const ingredientSheets = withoutVideoIngredientDescriptions(value.ingredientSheets);
    const ingredientSelectedSheet = normalizeSelectedVideoIngredientSheet(
        value.ingredientSelectedSheet,
        ingredientSelections,
        ingredientSheets,
    );
    return {
        modelId,
        localMode: typeof value.localMode === 'boolean' ? value.localMode : null,
        rentedOnly: typeof value.rentedOnly === 'boolean' ? value.rentedOnly : null,
        // The per-tab "Run on" pin (a rental id); '' = follow the Machines default.
        rentedMachineId: stringValue(value.rentedMachineId).slice(0, 128),
        aspectRatio: stringValue(value.aspectRatio),
        duration: Number.isFinite(duration) && duration > 0 ? duration : null,
        resolution: stringValue(value.resolution),
        quality: stringValue(value.quality),
        mode: stringValue(value.mode),
        effectName: stringValue(value.effectName),
        matchStartFrameAr: typeof value.matchStartFrameAr === 'boolean' ? value.matchStartFrameAr : null,
        denoise: ['light', 'strong'].includes(value.denoise) ? value.denoise : '',
        // NAG strength is a setting, not prompt text, so it persists here. The
        // negative prompt itself deliberately does not — it lives in the encrypted
        // composer with the positive prompt.
        nagScale: (typeof value.nagScale === 'number' && Number.isFinite(value.nagScale)) ? value.nagScale : null,
        videoTask: ['generate', 'extend', 'head-swap'].includes(value.videoTask) ? value.videoTask : 'generate',
        // Which head-swap engine, and its knobs. Settings, so they persist.
        headSwapBackend: value.headSwapBackend === 'facefusion' ? 'facefusion' : 'bfs',
        headSwapFaceEnhancer: typeof value.headSwapFaceEnhancer === 'boolean' ? value.headSwapFaceEnhancer : false,
        // null = use whatever the selected workflow ships with; true/false is an
        // explicit user override of the forecaster.
        spectrum: typeof value.spectrum === 'boolean' ? value.spectrum : null,
        // Fast high-res is OFF unless the user turns it on, so it persists as a
        // plain boolean rather than the spectrum tri-state: the registered graph's
        // own default is false and there is nothing to defer to.
        fastHighRes: value.fastHighRes === true,
        // Sampling-steps override (H3 refinement). null = workflow default. Only
        // sent for models whose registry maps a steps slot, so a stale value from
        // another model cannot leak into a graph without one.
        steps: (typeof value.steps === 'number' && Number.isFinite(value.steps) && value.steps >= 1 && value.steps <= 100)
            ? Math.round(value.steps)
            : null,
        // Head-swap identity strength. A setting, so it persists like the rest.
        headSwapLoraStrength: (typeof value.headSwapLoraStrength === 'number' && Number.isFinite(value.headSwapLoraStrength))
            ? Math.min(1.5, Math.max(0.5, value.headSwapLoraStrength))
            : 1,
        // IC-LoRA Detailer strength. 0 means the gateway skips the pass entirely,
        // so defaulting to 0 is what keeps an ordinary generation unchanged.
        detailerStrength: (typeof value.detailerStrength === 'number' && Number.isFinite(value.detailerStrength) && value.detailerStrength > 0)
            ? Math.min(1.5, value.detailerStrength)
            : 0,
        seed: (typeof value.seed === 'number' && Number.isFinite(value.seed) && value.seed >= 0) ? Math.floor(value.seed) : -1,
        // Scene chaining: an OPAQUE same-origin pointer to the sealed clip being
        // continued — no plaintext content — so an in-progress chain survives a
        // reload. Foreign/absolute URLs are dropped on principle.
        motionContextUrl: (() => {
            const url = stringValue(value.motionContextUrl);
            // `//host/path` also starts with a slash and resolves to a FOREIGN
            // origin, so a bare startsWith('/') is not the same-origin check it
            // reads as. Both leading forms have to be excluded.
            const sameOrigin = url.startsWith('/') && !url.startsWith('//');
            return sameOrigin && url.length <= 512 ? url : '';
        })(),
        motionContextIndex: (typeof value.motionContextIndex === 'number'
            && Number.isFinite(value.motionContextIndex) && value.motionContextIndex >= 1)
            ? Math.floor(value.motionContextIndex)
            : null,
        // Camera-motion and restyle SELECTIONS (ids, never the phrase they
        // generate): the phrase rides in the encrypted composer with the
        // prompt, and the ids are what lets re-applying strip it instead of
        // stacking a second sentence after a reload.
        cameraMotionIds: normalizeCameraMotions(value.cameraMotionIds),
        restylePresetId: restylePresetById(stringValue(value.restylePresetId)) ? stringValue(value.restylePresetId) : null,
        advancedValues,
        loraSelections,
        ingredientSelections,
        ingredientSheets,
        ingredientSelectedSheet,
        // The completion ping is a shared all-studio setting (lib/completionPing.js),
        // not a video preference — legacy values here are migrated once on load.
    };
}

export function normalizeVideoIngredientSelections(value) {
    const lists = Array.isArray(value)
        ? [value]
        : (value && typeof value === 'object'
            ? Object.values(value).filter(Array.isArray)
            : []);
    const normalized = [];
    const indexesByUrl = new Map();
    for (const selections of lists) {
        for (const selection of selections) {
            const url = typeof selection?.url === 'string' ? selection.url.trim() : '';
            if (!url.startsWith('/api/media-studio/references/')) continue;
            const description = typeof selection?.description === 'string'
                ? selection.description.trim().slice(0, 1000)
                : '';
            const existingIndex = indexesByUrl.get(url);
            if (existingIndex !== undefined) {
                if (!normalized[existingIndex].description && description) {
                    normalized[existingIndex] = { ...normalized[existingIndex], description };
                }
                continue;
            }
            if (normalized.length >= 12) continue;
            indexesByUrl.set(url, normalized.length);
            normalized.push({ url, description });
        }
    }
    return normalized;
}

/** The same list with every description removed — what localStorage is allowed
 *  to hold. Separate from the normalizer above because the IN-MEMORY list, the
 *  sealed generation context and the sheet preview all still carry the words;
 *  it is only the plaintext settings blob that may not. */
export function withoutVideoIngredientDescriptions(value) {
    return normalizeVideoIngredientSelections(value).map(({ url }) => ({ url }));
}

/** The descriptions on their own, keyed by the reference they belong to. This is
 *  what rides in the encrypted composer section; an empty one is not stored, so
 *  a person who never wrote a caption has nothing written down about them. */
export function videoIngredientDescriptions(...lists) {
    const descriptions = {};
    for (const list of lists) {
        for (const item of normalizeVideoIngredientSelections(list)) {
            if (item.description) descriptions[item.url] = item.description;
        }
    }
    return descriptions;
}

/** Put the descriptions back on a selection list after the composer hydrates. */
export function withVideoIngredientDescriptions(list, descriptions) {
    const source = descriptions && typeof descriptions === 'object' && !Array.isArray(descriptions) ? descriptions : {};
    return (Array.isArray(list) ? list : []).map((item) => {
        const saved = source[item?.url];
        if (!item?.url || item.description || typeof saved !== 'string' || !saved) return item;
        return { ...item, description: saved.slice(0, 1000) };
    });
}

export function normalizeSelectedVideoIngredientSheet(value, ingredientSelections, ingredientSheets) {
    const views = Array.isArray(ingredientSelections) ? ingredientSelections : [];
    const sheets = Array.isArray(ingredientSheets) ? ingredientSheets : [];
    // Legacy state carries no explicit selection: saved reference views were implicitly active.
    if (typeof value !== 'string') return views.length ? 'stitched' : '';
    const candidate = value.trim();
    if (candidate === 'stitched') return views.length ? 'stitched' : '';
    return sheets.some((sheet) => sheet?.url === candidate) ? candidate : '';
}

/* ---------------- progress + layout formatting ---------------- */

export function normalizeVideoGenerationProgress(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const normalized = value > 1 ? value / 100 : value;
    return Math.min(1, Math.max(0, normalized));
}

export function classifyVideoGenerationStage(status) {
    const value = String(status || '').toLowerCase();
    if (/load|model|startup|prepar/.test(value)) return 'loading';
    if (/encod|decod|export|sav|final/.test(value)) return 'finishing';
    if (/queue|pending|submit/.test(value)) return 'queued';
    return 'rendering';
}

export function formatVideoGenerationElapsed(elapsedMs) {
    const totalSeconds = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
}

export function clampVideoDropdownMaxHeight(anchorTop, minimum = 180, margin = 24) {
    return Math.max(minimum, Math.round(Number(anchorTop) || 0) - margin);
}

export function clampVideoDropdownViewportLeft(preferredLeft, dropdownWidth, viewportWidth, padding = 12) {
    const safePadding = Math.max(0, Number(padding) || 0);
    const width = Math.max(0, Number(dropdownWidth) || 0);
    const viewport = Math.max(0, Number(viewportWidth) || 0);
    const maximum = Math.max(safePadding, viewport - width - safePadding);
    return Math.min(maximum, Math.max(safePadding, Number(preferredLeft) || 0));
}

export function closestVideoAspectRatio(width, height, availableRatios = []) {
    const sourceWidth = Number(width);
    const sourceHeight = Number(height);
    if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;
    const sourceRatio = sourceWidth / sourceHeight;
    return availableRatios.reduce((best, value) => {
        const match = String(value).match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/);
        if (!match) return best;
        const ratio = Number(match[1]) / Number(match[2]);
        if (!(ratio > 0)) return best;
        const distance = Math.abs(Math.log(ratio / sourceRatio));
        return !best || distance < best.distance ? { value, distance } : best;
    }, null)?.value || null;
}
