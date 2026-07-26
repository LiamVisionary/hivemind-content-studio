// Image studio preferences — moved VERBATIM from src/components/ImageStudio.js
// (normalizeImagePreferences + STYLE_PRESETS). Pure module: no DOM, no React.
// Tests and other callers import normalizeImagePreferences via src/studios/ImageStudio.jsx.

export const IMAGE_PREFERENCES_KEY = 'image_generation_preferences';
export const STYLE_PRESETS = ['None', 'Photorealistic', 'Anime', 'Cinematic', 'Oil Painting', 'Watercolor', 'Digital Art', 'Concept Art', 'Cyberpunk'];

export function normalizeImagePreferences(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const stringValue = (candidate) => typeof candidate === 'string' ? candidate.trim() : '';
    const modelId = stringValue(value.modelId);
    if (!modelId || modelId.length > 256) return null;
    const numberValue = (candidate, fallback, min, max, integer = false) => {
        const parsed = Number(candidate);
        if (!Number.isFinite(parsed)) return fallback;
        const bounded = Math.min(max, Math.max(min, parsed));
        return integer ? Math.round(bounded) : bounded;
    };
    const loraSelections = {};
    if (value.loraSelections && typeof value.loraSelections === 'object' && !Array.isArray(value.loraSelections)) {
        Object.entries(value.loraSelections).forEach(([model, selections]) => {
            if (!model || !Array.isArray(selections)) return;
            loraSelections[model] = selections.flatMap((selection) => {
                const id = stringValue(selection?.id);
                if (!id) return [];
                return [{
                    id,
                    name: stringValue(selection.name) || id,
                    displayName: stringValue(selection.displayName) || stringValue(selection.name) || id,
                    previewUrl: stringValue(selection.previewUrl),
                    strength: numberValue(selection.strength, 1, -10, 10),
                    // Muted LoRAs stay in the list (with their weight) across reloads.
                    enabled: selection.enabled !== false,
                }];
            });
        });
    }
    // Per-model advanced settings (keyed "local:<id>" / "api:<id>") — tuned
    // values follow the model instead of resetting on every switch.
    const modelSettings = {};
    if (value.modelSettings && typeof value.modelSettings === 'object' && !Array.isArray(value.modelSettings)) {
        Object.entries(value.modelSettings).forEach(([key, entry]) => {
            if (!key || !entry || typeof entry !== 'object' || Array.isArray(entry)) return;
            modelSettings[key] = {
                steps: numberValue(entry.steps, 25, 1, 50, true),
                guidanceScale: numberValue(entry.guidanceScale, 7.5, 1, 20),
                negativePrompt: typeof entry.negativePrompt === 'string' ? entry.negativePrompt : '',
                aspectRatio: stringValue(entry.aspectRatio),
                resolution: stringValue(entry.resolution),
                customWidth: numberValue(entry.customWidth, 0, 0, 16384, true),
                customHeight: numberValue(entry.customHeight, 0, 0, 16384, true),
                localRuntimeMode: ['one-off', 'persistent'].includes(entry.localRuntimeMode) ? entry.localRuntimeMode : 'one-off',
                // '' means "whatever the workflow picks for this step count".
                sampler: stringValue(entry.sampler),
                scheduler: stringValue(entry.scheduler),
                baseSize: numberValue(entry.baseSize, 0, 0, 2048, true),
                coupleMode: Boolean(entry.coupleMode),
                coupleDirection: entry.coupleDirection === 'vertical' ? 'vertical' : 'horizontal',
                coupleSplit: numberValue(entry.coupleSplit, 50, 10, 90, true),
                couplePair: ['girls', 'mixed', 'boys'].includes(entry.couplePair) ? entry.couplePair : 'girls',
            };
        });
    }

    return {
        modelId,
        imageMode: Boolean(value.imageMode),
        useLocalModel: Boolean(value.useLocalModel),
        localModelId: stringValue(value.localModelId),
        aspectRatio: stringValue(value.aspectRatio),
        resolution: stringValue(value.resolution),
        localRuntimeMode: ['one-off', 'persistent'].includes(value.localRuntimeMode) ? value.localRuntimeMode : 'one-off',
        // Sampler/scheduler/base size only apply to local workflows that expose
        // them; '' / 0 means "let the workflow decide" (see krea2_sampler_defaults).
        sampler: stringValue(value.sampler),
        scheduler: stringValue(value.scheduler),
        baseSize: numberValue(value.baseSize, 0, 0, 2048, true),
        negativePrompt: typeof value.negativePrompt === 'string' ? value.negativePrompt : '',
        guidanceScale: numberValue(value.guidanceScale, 7.5, 1, 20),
        steps: numberValue(value.steps, 25, 1, 50, true),
        seed: numberValue(value.seed, -1, -1, 2_147_483_647, true),
        style: STYLE_PRESETS.includes(value.style) ? value.style : 'None',
        batchCount: numberValue(value.batchCount, 1, 1, 4, true),
        customWidth: numberValue(value.customWidth, 0, 0, 16384, true),
        customHeight: numberValue(value.customHeight, 0, 0, 16384, true),
        referenceStrength: numberValue(value.referenceStrength, 50, 0, 100, true),
        coupleMode: Boolean(value.coupleMode),
        coupleDirection: value.coupleDirection === 'vertical' ? 'vertical' : 'horizontal',
        coupleSplit: numberValue(value.coupleSplit, 50, 10, 90, true),
        couplePair: ['girls', 'mixed', 'boys'].includes(value.couplePair) ? value.couplePair : 'girls',
        modelSettings,
        loraSelections,
    };
}

// Mirrors KREA2_LOW_STEP_THRESHOLD in packages/media-gateway/
// krea2_identity_workflow.py: at or below this step count the workflow swaps
// its own sampler pair, which changes what a step costs.
export const AUTO_SAMPLER_LOW_STEP_THRESHOLD = 5;

// Generation-timing profile for one image run, split into:
//   key  — the params that change the COST PROFILE (model, sampler, adapters,
//          graph shape). Samplers differ in MODEL EVALUATIONS per step (deis_3m
//          runs ~2.7, most run 1), so time is only linear in steps WITHIN one
//          sampler and their runs must never pool; on Auto the pair is swapped
//          at the threshold above, so the effective pair goes in the key.
//          Steps and dimensions deliberately stay out of it. Never prompt text.
//   work — what the run actually costs: steps x megapixels. Sampling is close to
//          linear in both, so doubling either roughly doubles the time, and a
//          measured run can estimate an unmeasured one instead of falling back
//          to a flat constant.
// Cloud models expose neither steps nor dimensions, so they carry a single flat
// unit of work and lean entirely on their recorded durations.
export function imageTimingProfile({ settings = {}, model = null, loraCount = 0, dimensions = null } = {}) {
    if (!settings.useLocalModel) {
        const refs = settings.uploadedImageUrls?.length ? 1 : 0;
        return {
            key: `img|api|${settings.selectedModel}|ar=${settings.selectedAr}`
                + `|q=${settings.selectedResolution || ''}|refs=${refs}`,
            work: 1,
        };
    }
    const steps = Number(settings.steps) > 0 ? Number(settings.steps) : (Number(model?.defaultSteps) || 25);
    // A model that offers no sampler choice never swaps, so it keeps a single
    // bucket across every step count.
    const sampler = (model?.samplers || []).length
        ? (settings.sampler || (steps <= AUTO_SAMPLER_LOW_STEP_THRESHOLD ? 'auto-low' : 'auto-std'))
        : '';
    const width = Number(dimensions?.width) || Number(model?.defaultWidth) || 1024;
    const height = Number(dimensions?.height) || width;
    return {
        key: `img|local|${settings.selectedLocalModel}|sampler=${sampler}`
            + `|loras=${loraCount}|couple=${settings.coupleMode ? 1 : 0}`,
        work: steps * Math.max(0.01, (width * height) / 1_000_000),
    };
}
