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
