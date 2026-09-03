// Image studio preferences — the one definition, imported by ImageStudio.jsx
// (normalizeImagePreferences + STYLE_PRESETS). Pure module: no DOM, no React.
// Tests import normalizeImagePreferences from HERE, so what they exercise is
// what the studio runs.

import { normalizeCameraRig } from '../../lib/cameraRig.js';

export const IMAGE_PREFERENCES_KEY = 'image_generation_preferences';
export const STYLE_PRESETS = ['None', 'Photorealistic', 'Anime', 'Cinematic', 'Oil Painting', 'Watercolor', 'Digital Art', 'Concept Art', 'Cyberpunk'];

// What each preset actually appends to the prompt. The control rendered for
// months while generate() never read it — these phrases close that gap.
// Kept to compact comma phrases (not sentences) so they compose with any prompt.
export const STYLE_PRESET_PHRASES = {
    'Photorealistic': 'photorealistic, natural light, detailed skin texture, sharp focus',
    'Anime': 'anime style, clean line art, cel shading, vibrant colors',
    'Cinematic': 'cinematic composition, dramatic lighting, film grain, anamorphic look',
    'Oil Painting': 'oil painting, visible brushstrokes, canvas texture, rich impasto',
    'Watercolor': 'watercolor painting, soft washes, bleeding pigment, paper texture',
    'Digital Art': 'digital art, polished rendering, high detail illustration',
    'Concept Art': 'concept art, painterly rendering, atmospheric perspective, production design',
    'Cyberpunk': 'cyberpunk aesthetic, neon glow, rain-slick streets, high-tech low-life',
};

// Append the preset phrase unless the prompt already carries it (idempotent —
// same contract as the camera-motion composer). 'None'/unknown return as-is.
export function applyStylePreset(prompt, styleName) {
    const base = String(prompt || '').trim();
    const phrase = STYLE_PRESET_PHRASES[String(styleName || '').trim()];
    if (!phrase) return base;
    if (base.toLowerCase().includes(phrase.toLowerCase())) return base;
    if (!base) return phrase;
    return `${base}${/[,.!?;:]$/.test(base) ? ' ' : ', '}${phrase}`;
}

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
                characterSheetMode: Boolean(entry.characterSheetMode),
                characterSheetPreset: ['turnaround', 'standard', 'full'].includes(entry.characterSheetPreset) ? entry.characterSheetPreset : 'turnaround',
                // Only the toggle. The region boxes carry prompt text, which
                // belongs in the encrypted composer, never in localStorage.
                regionMode: Boolean(entry.regionMode),
            };
        });
    }

    return {
        modelId,
        imageMode: Boolean(value.imageMode),
        useLocalModel: Boolean(value.useLocalModel),
        rentedOnly: Boolean(value.rentedOnly),
        // The per-tab "Run on" pin (a rental id). Restored with the tab, and
        // dropped by the Rented panel if that machine is no longer attached.
        rentedMachineId: stringValue(value.rentedMachineId).slice(0, 128),
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
        characterSheetMode: Boolean(value.characterSheetMode),
        characterSheetPreset: ['turnaround', 'standard', 'full'].includes(value.characterSheetPreset) ? value.characterSheetPreset : 'turnaround',
        regionMode: Boolean(value.regionMode),
        // The Camera menu's rig, bounded to the option banks by its own
        // normalizer — a corrupt blob can only ever restore a valid rig.
        cameraRig: normalizeCameraRig(value.cameraRig),
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

// Seed field text -> seed. Only a whole non-negative number is an explicit
// seed; anything else (blank, junk, negatives, fractions) means "random".
// `parseInt(value) || -1` read a typed 0 as random while the field showed 0.
export function parseSeedInput(value) {
    const text = String(value ?? '').trim();
    if (!text) return -1;
    const n = Number(text);
    return Number.isInteger(n) && n >= 0 ? n : -1;
}

// How many references a restored setup may bring back: the LOCAL model's slot
// count when the run was local, the cloud model's i2i slot count otherwise.
// Sizing a local Klein restore off the cloud model's limit (nano-banana = 1)
// dropped every reference but the first. An unknown local model (discovery
// not landed yet) fails open to however many were captured — the discovery
// pass trims the picker later if it must.
export function restoredReferenceLimit({ imageMode, useLocalModel, localModel = null, cloudLimit = 1, referenceCount = 0 }) {
    if (!imageMode) return 1;
    if (useLocalModel) {
        if (localModel) return Math.max(1, Number(localModel.maxReferenceImages) || 1);
        return Math.max(1, Number(referenceCount) || 0);
    }
    return Math.max(1, Number(cloudLimit) || 1);
}

// Whether a change in the reference count has to rewrite the prompt's
// reference-ownership block: either roles were held, or the prompt still
// carries a block (a saved prompt brought one in). A prompt with neither is
// left byte-for-byte alone — applyReferenceRoles would otherwise trim it.
export function referenceRolesNeedRewrite(prompt, roles, heading) {
    if (Array.isArray(roles) && roles.length) return true;
    return Boolean(heading) && String(prompt || '').includes(heading);
}

// "Start fresh": the engine fields that go back to a blank canvas. Everything
// session-bound to the LAST image — prompt, references and their roles, the
// region boxes, couple character text, the enhancer, the failure callout, the
// viewed setup — but NOT the model, source, aspect or saved tuning.
export function startFreshPatch() {
    return {
        prompt: '',
        uploadedImageUrls: [],
        imageMode: false,
        referenceRoles: [],
        regions: [],
        coupleShared: '',
        coupleA: '',
        coupleB: '',
        enhancerOpen: false,
        enhanceBase: '',
        enhanceTags: new Set(),
        enhanceCopied: false,
        generateError: '',
        viewerUrl: null,
        lastSubmittedContext: null,
    };
}
