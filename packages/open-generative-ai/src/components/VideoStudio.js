import { muapi } from '../lib/muapi.js';
import { t2vModels, getAspectRatiosForVideoModel, getDurationsForModel, getResolutionsForVideoModel, i2vModels, getAspectRatiosForI2VModel, getDurationsForI2VModel, getResolutionsForI2VModel, v2vModels, getModesForModel } from '../lib/models.js';
import { AuthModal } from './AuthModal.js';
import { t } from '../lib/i18n.js';
import { createUploadPicker } from './UploadPicker.js';
import { savePendingJob, removePendingJob, getPendingJobs } from '../lib/pendingJobs.js';
import { localAI, isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { isWan2gpModelId, getLocalModelById, localT2VModels, localI2VModels } from '../lib/localModels.js';
import { loraGenerationPayload, toggleLoraSelection, updateLoraStrength } from '../lib/loraSelection.js';
import { createCivitaiDownloadDialog } from './CivitaiDownloadDialog.js';
import { createGenerationContextStore } from '../lib/generationContext.js';
import { resolveMediaSrc } from '../lib/e2eMedia.js';
import {
    generateHivemindVideo,
    deleteHivemindStudioUpload,
    getHivemindVideoModelById,
    getSavedHivemindVideoSelection,
    isHivemindStudioEnabled,
    isHivemindVideoModelId,
    loadStudioGenerationHistory,
    loadHivemindStudioContext,
    previewHivemindIngredientSheet,
    saveStudioGenerationHistory,
    uploadFileToHivemindStudio,
    workflowIdFromHivemindModelId,
} from '../lib/hivemindStudio.js';

// Promotes a wan2gp catalog entry (lib/localModels.js shape) into the
// `inputs`-shaped descriptor the Video Studio dropdowns/controls expect.
const adaptLocalToVideoEntry = (m) => ({
    id: m.id,
    name: m.name,
    provider: 'wan2gp',
    inputs: {
        prompt: { type: 'string', name: 'prompt', title: 'Prompt' },
        aspect_ratio: { type: 'string', name: 'aspect_ratio', enum: m.aspectRatios || ['16:9', '1:1', '9:16'], default: (m.aspectRatios || ['16:9'])[0] },
    },
});

const adaptHivemindToVideoEntry = (m) => ({
    id: m.id,
    name: m.name,
    provider: 'hivemind-media-studio',
    workflowId: m.workflowId,
    supportsVideoInput: Boolean(m.supportsVideoInput),
    supportsLoras: Boolean(m.supportsLoras),
    compatibleBaseModels: Array.isArray(m.compatibleBaseModels) ? m.compatibleBaseModels : [],
    supportsIngredientImages: Boolean(m.supportsIngredientImages),
    ingredientInputs: m.ingredientInputs && typeof m.ingredientInputs === 'object' ? m.ingredientInputs : null,
    videoModes: m.videoModes || [],
    inputs: {
        prompt: { type: 'string', name: 'prompt', title: 'Prompt' },
        aspect_ratio: { type: 'string', name: 'aspect_ratio', enum: m.aspectRatios || ['1:1', '16:9', '9:16'], default: (m.aspectRatios || ['1:1'])[0] },
        duration: { type: 'number', name: 'duration', enum: m.durations || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], default: m.defaultDuration || 4 },
    },
});

const VIDEO_COMPLETION_PING_KEY = 'video_ping_when_complete';
const VIDEO_PREFERENCES_KEY = 'video_generation_preferences';
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

export function normalizeVideoPreferences(value) {
    if (!value || typeof value !== 'object') return null;
    const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
    if (!modelId || modelId.length > 256) return null;
    const duration = Number(value.duration);
    const stringValue = (candidate) => typeof candidate === 'string' ? candidate.trim() : '';
    const advancedValues = value.advancedValues && typeof value.advancedValues === 'object' && !Array.isArray(value.advancedValues)
        ? Object.fromEntries(Object.entries(value.advancedValues).filter(([, candidate]) => (
            ['string', 'number', 'boolean'].includes(typeof candidate) && (typeof candidate !== 'number' || Number.isFinite(candidate))
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
                }];
            });
        });
    }
    const ingredientSelections = normalizeVideoIngredientSelections(value.ingredientSelections);
    const ingredientSheets = normalizeVideoIngredientSelections(value.ingredientSheets);
    const ingredientSelectedSheet = normalizeSelectedVideoIngredientSheet(
        value.ingredientSelectedSheet,
        ingredientSelections,
        ingredientSheets,
    );
    return {
        modelId,
        localMode: typeof value.localMode === 'boolean' ? value.localMode : null,
        aspectRatio: stringValue(value.aspectRatio),
        duration: Number.isFinite(duration) && duration > 0 ? duration : null,
        resolution: stringValue(value.resolution),
        quality: stringValue(value.quality),
        mode: stringValue(value.mode),
        effectName: stringValue(value.effectName),
        advancedValues,
        loraSelections,
        ingredientSelections,
        ingredientSheets,
        ingredientSelectedSheet,
        pingWhenComplete: Boolean(value.pingWhenComplete),
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

export function normalizeSelectedVideoIngredientSheet(value, ingredientSelections, ingredientSheets) {
    const views = Array.isArray(ingredientSelections) ? ingredientSelections : [];
    const sheets = Array.isArray(ingredientSheets) ? ingredientSheets : [];
    // Legacy state carries no explicit selection: saved reference views were implicitly active.
    if (typeof value !== 'string') return views.length ? 'stitched' : '';
    const candidate = value.trim();
    if (candidate === 'stitched') return views.length ? 'stitched' : '';
    return sheets.some((sheet) => sheet?.url === candidate) ? candidate : '';
}

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
    // Dropdowns open upward from their anchor, so the usable height is the
    // space between the viewport top and the anchor button. The minimum keeps
    // the panel usable even when the anchor sits unusually high.
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

function imageDimensions(source) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error('Could not inspect the selected start frame.'));
        // The start frame may be an E2E-sealed generated output; decrypt in-page
        // first (legacy/upload sources pass through untouched).
        void resolveMediaSrc(source).then((resolved) => { image.src = resolved; });
    });
}

export function VideoStudio() {
    const container = document.createElement('div');
    // `justify-content: safe center` centers content while it fits but falls back to
    // start-alignment once it overflows, so a tall advanced panel stays scrollable to the top.
    container.className = 'w-full h-full flex flex-col items-center [justify-content:safe_center] bg-transparent relative p-4 md:p-6 overflow-y-auto custom-scrollbar overflow-x-hidden';

    // Merge Wan2GP video models in only when running inside Electron AND the
    // user has a Wan2GP server configured. We can't probe synchronously, so
    // we always include them when isLocalAIAvailable() — getCurrentModel()
    // reads from these arrays, so they need to be present from init.
    const localT2V = isLocalAIAvailable() ? localT2VModels.map(adaptLocalToVideoEntry) : [];
    const localI2V = isLocalAIAvailable() ? localI2VModels.map(adaptLocalToVideoEntry) : [];
    let hivemindI2V = [];
    let hivemindWorkflowSignature = '';
    let allT2V = [...t2vModels, ...localT2V];
    let allI2V = [...i2vModels, ...localI2V];

    // --- State ---
    const defaultModel = allT2V[0];
    let selectedModel = defaultModel.id;
    let selectedModelName = defaultModel.name;
    // Local/API source filter for the model dropdown (Electron only). Local = LTX Media Studio
    // workflows + Wan2GP; API = remote providers. Mirrors the Image studio's Local/API toggle.
    const isLocalVideoModel = (id) => isHivemindVideoModelId(id) || isWan2gpModelId(id);
    let videoLocalMode = isHivemindStudioEnabled() && isLocalAIAvailable()
        ? true
        : isLocalVideoModel(defaultModel.id);
    let selectedAr = defaultModel.inputs?.aspect_ratio?.default || '16:9';
    let selectedDuration = defaultModel.inputs?.duration?.default || 5;
    let selectedResolution = defaultModel.inputs?.resolution?.default || '';
    let selectedQuality = defaultModel.inputs?.quality?.default || '';
    let selectedMode = '';
    let selectedEffectName = '';
    let advancedValues = getDefaultAdvancedVideoValues(defaultModel);
    let lastGenerationId = null;
    let lastGenerationModel = null;
    let dropdownOpen = null;
    let uploadedImageUrl = null;
    let preserveNextStartFrameAspect = false;
    let uploadedEndImageUrl = null; // optional end-frame for FLF i2v models
    let imageMode = false; // false = t2v models, true = i2v models
    let v2vMode = false;   // true = video-to-video tools mode
    let uploadedVideoUrl = null;
    let uploadedVideoName = null;
    let lastSubmittedContext = null;
    // Shared "return to a past generation" store — see src/lib/generationContext.js.
    const contextStore = createGenerationContextStore();
    let pingWhenComplete = false;
    let completionAudioContext = null;
    let persistedVideoPreferences = null;
    let availableVideoLoras = [];
    let videoLoraCatalogStatus = 'idle';
    let videoLoraCatalogMessage = '';
    let videoLoraCatalogRequest = 0;
    let videoLoraCatalogModelId = '';
    const videoLoraSelectionsByModel = new Map();
    let sharedIngredientSelections = [];
    let sharedIngredientSheets = [];
    let selectedIngredientSheet = '';
    let ingredientSheetPreviewRequest = 0;
    let ingredientSheetPreview = {
        workflowId: '',
        signature: '',
        status: 'idle',
        url: '',
        columns: null,
        rows: null,
        width: null,
        height: null,
        sourceCount: 0,
        error: '',
    };
    try {
        pingWhenComplete = sessionStorage.getItem(VIDEO_COMPLETION_PING_KEY) === '1';
    } catch {}
    try {
        persistedVideoPreferences = normalizeVideoPreferences(
            JSON.parse(localStorage.getItem(VIDEO_PREFERENCES_KEY) || 'null'),
        );
        if (persistedVideoPreferences) pingWhenComplete = persistedVideoPreferences.pingWhenComplete;
    } catch {}
    Object.entries(persistedVideoPreferences?.loraSelections || {}).forEach(([model, selections]) => {
        videoLoraSelectionsByModel.set(model, selections);
    });
    sharedIngredientSelections = (persistedVideoPreferences?.ingredientSelections || [])
        .map((selection) => ({ ...selection }));
    sharedIngredientSheets = (persistedVideoPreferences?.ingredientSheets || [])
        .map((sheet) => ({ ...sheet }));
    selectedIngredientSheet = normalizeSelectedVideoIngredientSheet(
        persistedVideoPreferences?.ingredientSelectedSheet,
        sharedIngredientSelections,
        sharedIngredientSheets,
    );

    const getCurrentModels = () => v2vMode ? v2vModels : (imageMode ? allI2V : allT2V);
    // Local Wan2GP entries don't live in the Muapi-derived helpers, so we
    // resolve aspect ratios off the catalog when the selected id is local.
    const getCurrentAspectRatios = (id) => {
        const hive = getHivemindVideoModelById(id);
        if (hive) return hive.aspectRatios || ['1:1', '16:9', '9:16'];
        const local = getLocalModelById(id);
        if (local) return local.aspectRatios || ['16:9', '1:1', '9:16'];
        return imageMode ? getAspectRatiosForI2VModel(id) : getAspectRatiosForVideoModel(id);
    };
    const getCurrentDurations = (id) => {
        const hive = getHivemindVideoModelById(id);
        if (hive) return hive.durations || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        if (getLocalModelById(id)) return [];
        return imageMode ? getDurationsForI2VModel(id) : getDurationsForModel(id);
    };
    const getCurrentResolutions = (id) => {
        // Local Media Studio workflows render at aspect buckets; High requests
        // the larger bucket (~2.5x pixels), which also sharpens IC-LoRA
        // reference conditioning because references encode at output size.
        if (getHivemindVideoModelById(id)) return ['Standard', 'High'];
        if (getLocalModelById(id)) return [];
        return imageMode ? getResolutionsForI2VModel(id) : getResolutionsForVideoModel(id);
    };
    const getCurrentModes = (id) => getModesForModel(id);
    const getCurrentModel = () => getCurrentModels().find(m => m.id === selectedModel);
    const isMotionControlV2V = () => v2vMode && !!getCurrentModel()?.imageField;
    const isHivemindVideoInputMode = () => isHivemindVideoModelId(selectedModel) && Boolean(uploadedVideoUrl);
    const getQualitiesForModel = (id) => {
        const model = getCurrentModels().find(m => m.id === id);
        return model?.inputs?.quality?.enum || [];
    };
    const getEffectNamesForModel = (id) => {
        const model = getCurrentModels().find(m => m.id === id);
        return model?.inputs?.name?.enum || [];
    };

    // ==========================================
    // 1. HERO SECTION
    // ==========================================
    const hero = document.createElement('div');
    hero.className = 'flex flex-col items-center mb-8 md:mb-10 animate-fade-in-up transition-all duration-700';
    hero.innerHTML = `
        <div class="mb-5 relative">
             <div class="absolute inset-0 bg-primary/25 blur-3xl rounded-full opacity-50"></div>
             <div class="relative grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-gradient-to-br from-primary/15 to-accent/10 shadow-glow">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" class="text-primary">
                    <polygon points="23 7 16 12 23 17 23 7"/>
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                </svg>
             </div>
        </div>
        <h1 class="font-display text-3xl md:text-4xl font-bold tracking-tight text-white mb-2 text-center px-4">${t('video.title')}</h1>
        <p class="text-secondary text-sm md:text-[15px] text-center px-4">${t('video.subtitle')}</p>
    `;
    container.appendChild(hero);

    // ==========================================
    // 2. PROMPT BAR
    // ==========================================
    const promptWrapper = document.createElement('div');
    promptWrapper.className = 'w-full max-w-4xl relative z-40 animate-fade-in-up';
    promptWrapper.style.animationDelay = '0.2s';

    const bar = document.createElement('div');
    bar.className = 'w-full bg-card-bg/90 backdrop-blur-xl border border-white/10 rounded-2xl md:rounded-3xl p-3 md:p-5 flex flex-col gap-3 md:gap-5 shadow-panel transition-colors focus-within:border-primary/40';

    const topRow = document.createElement('div');
    topRow.className = 'flex items-start gap-5 px-2';

    // --- Image Upload Picker (Image-to-Video) ---
    const picker = createUploadPicker({
        anchorContainer: container,
        onRemoveUpload: ({ uploadedUrl }) => deleteHivemindStudioUpload(uploadedUrl),
        onSelect: ({ url }) => {
            if (isHivemindVideoInputMode()) clearVideoUpload();
            uploadedImageUrl = url;
            // Motion-control v2v: image is a second input alongside the video, not a mode switch
            if (isMotionControlV2V()) {
                textarea.disabled = false;
                textarea.placeholder = uploadedVideoUrl
                    ? (getCurrentModel()?.promptRequired ? 'Describe the motion' : 'Describe the motion (optional)')
                    : 'Now upload a reference video using the 🎥 button';
                return;
            }
            // Clear video mode if active
            if (v2vMode) {
                uploadedVideoUrl = null;
                v2vMode = false;
                showVideoIcon();
            }
            if (!imageMode) {
                imageMode = true;
                const currentT2V = allT2V.find(m => m.id === selectedModel);
                const sibling = currentT2V?.family
                    ? allI2V.find(m => m.family === currentT2V.family)
                    : null;
                const target = sibling || allI2V[0];
                selectedModel = target.id;
                selectedModelName = target.name;
                document.getElementById('v-model-btn-label').textContent = selectedModelName;
                updateControlsForModel(selectedModel);
                persistVideoPreferences();
            }
            const preserveAspect = preserveNextStartFrameAspect;
            preserveNextStartFrameAspect = false;
            if (!preserveAspect) void matchIngredientsAspectToStartFrame(url);
            textarea.placeholder = 'Describe the motion or effect (optional)';
            textarea.disabled = false;
        },
        onClear: () => {
            uploadedImageUrl = null;
            // Motion-control v2v: keep the model selection; just lose the image
            if (isMotionControlV2V()) return;
            imageMode = false;
            // Clearing the start frame invalidates any selected end frame.
            uploadedEndImageUrl = null;
            endPicker?.reset();
            selectedModel = allT2V[0].id;
            selectedModelName = allT2V[0].name;
            document.getElementById('v-model-btn-label').textContent = selectedModelName;
            updateControlsForModel(selectedModel);
            persistVideoPreferences();
            textarea.placeholder = t('video.placeholder');
            textarea.disabled = false;
        },
        // Route the upload through the configured Wan2GP server when the active
        // model is local; otherwise fall back to the Muapi-hosted upload.
        uploadFn: (file) => isHivemindVideoModelId(selectedModel)
            ? uploadFileToHivemindStudio(file)
            : (isWan2gpModelId(selectedModel) ? localAI.uploadFileToWan2gp(file) : muapi.uploadFile(file)),
        requireApiKey: () => !isWan2gpModelId(selectedModel) && !isHivemindVideoModelId(selectedModel),
    });
    topRow.appendChild(picker.trigger);
    container.appendChild(picker.panel);

    // --- End-Frame Upload Picker (FLF i2v models — kling/veo/seedance/etc.) ---
    // Shown only when imageMode is on AND the selected i2v model declares a
    // `lastImageField` in its catalog entry. Reuses the same UploadPicker UI;
    // a corner badge differentiates it from the start-frame picker.
    const endPicker = createUploadPicker({
        anchorContainer: container,
        onRemoveUpload: ({ uploadedUrl }) => deleteHivemindStudioUpload(uploadedUrl),
        onSelect: ({ url }) => { uploadedEndImageUrl = url; },
        onClear: () => { uploadedEndImageUrl = null; },
        uploadFn: (file) => isHivemindVideoModelId(selectedModel)
            ? uploadFileToHivemindStudio(file)
            : (isWan2gpModelId(selectedModel) ? localAI.uploadFileToWan2gp(file) : muapi.uploadFile(file)),
        requireApiKey: () => !isWan2gpModelId(selectedModel) && !isHivemindVideoModelId(selectedModel),
    });
    endPicker.trigger.title = 'End frame (optional)';
    // Visual marker: small "L" badge in the corner so users can tell the two
    // pickers apart at a glance. The wrapper keeps it from interfering with
    // UploadPicker's own thumbnail/spinner state swapping.
    const endBadge = document.createElement('div');
    endBadge.className = 'absolute top-0.5 left-0.5 px-1 h-4 bg-white/20 rounded-md flex items-center justify-center pointer-events-none';
    endBadge.innerHTML = '<span class="text-[8px] font-black text-white leading-none">END</span>';
    endPicker.trigger.appendChild(endBadge);
    endPicker.trigger.classList.add('hidden'); // start hidden until updateEndFrameVisibility flips it on
    topRow.appendChild(endPicker.trigger);
    container.appendChild(endPicker.panel);

    const updateEndFrameVisibility = () => {
        const model = getCurrentModel();
        const supports = imageMode && !!model?.lastImageField;
        if (supports) {
            endPicker.trigger.classList.remove('hidden');
            endPicker.trigger.classList.add('flex');
        } else {
            endPicker.trigger.classList.add('hidden');
            endPicker.trigger.classList.remove('flex');
            // Drop any stale end-frame selection when leaving FLF-capable state
            if (uploadedEndImageUrl) {
                uploadedEndImageUrl = null;
                endPicker.reset();
            }
        }
    };

    // --- Video Upload Picker (Video-to-Video) ---
    const videoFileInput = document.createElement('input');
    videoFileInput.type = 'file';
    videoFileInput.accept = 'video/*';
    videoFileInput.className = 'hidden';

    const videoPickerBtn = document.createElement('button');
    videoPickerBtn.type = 'button';
    videoPickerBtn.title = 'Upload a source video';
    videoPickerBtn.className = 'w-10 h-10 shrink-0 rounded-xl border transition-all flex items-center justify-center relative overflow-hidden mt-1.5 bg-white/5 border-white/10 hover:bg-white/10 hover:border-primary/40 group';

    const videoIconEl = document.createElement('div');
    videoIconEl.className = 'flex items-center justify-center w-full h-full';
    videoIconEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-muted group-hover:text-primary transition-colors"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;

    const videoSpinnerEl = document.createElement('div');
    videoSpinnerEl.className = 'hidden items-center justify-center w-full h-full';
    videoSpinnerEl.innerHTML = `<span class="animate-spin text-primary text-sm">◌</span>`;

    const videoReadyEl = document.createElement('div');
    videoReadyEl.className = 'hidden items-center justify-center w-full h-full';
    videoReadyEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-primary"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/><polyline points="7 10 10 13 15 8" stroke="#22d3ee" stroke-width="2.5"/></svg>`;

    videoPickerBtn.appendChild(videoFileInput);
    videoPickerBtn.appendChild(videoIconEl);
    videoPickerBtn.appendChild(videoSpinnerEl);
    videoPickerBtn.appendChild(videoReadyEl);

    const showVideoIcon = () => {
        videoIconEl.classList.replace('hidden', 'flex');
        videoSpinnerEl.classList.add('hidden'); videoSpinnerEl.classList.remove('flex');
        videoReadyEl.classList.add('hidden'); videoReadyEl.classList.remove('flex');
        videoPickerBtn.classList.remove('border-primary/60');
        videoPickerBtn.classList.add('border-white/10');
        videoPickerBtn.title = 'Upload a source video';
    };

    const showVideoSpinner = () => {
        videoIconEl.classList.add('hidden'); videoIconEl.classList.remove('flex');
        videoSpinnerEl.classList.replace('hidden', 'flex');
        videoReadyEl.classList.add('hidden'); videoReadyEl.classList.remove('flex');
    };

    const showVideoReady = (filename) => {
        videoIconEl.classList.add('hidden'); videoIconEl.classList.remove('flex');
        videoSpinnerEl.classList.add('hidden'); videoSpinnerEl.classList.remove('flex');
        videoReadyEl.classList.replace('hidden', 'flex');
        videoPickerBtn.classList.remove('border-white/10');
        videoPickerBtn.classList.add('border-primary/60');
        videoPickerBtn.title = `${filename} — click to clear`;
    };

    const clearVideoUpload = () => {
        const wasHivemindVideo = isHivemindVideoInputMode();
        uploadedVideoUrl = null;
        uploadedVideoName = null;
        showVideoIcon();
        // Motion-control v2v: keep the model and image; user can re-upload a video
        if (isMotionControlV2V()) {
            textarea.placeholder = 'Upload a reference video using the 🎥 button';
            return;
        }
        if (wasHivemindVideo) {
            imageMode = false;
            selectedModel = allT2V[0].id;
            selectedModelName = allT2V[0].name;
            document.getElementById('v-model-btn-label').textContent = selectedModelName;
            updateControlsForModel(selectedModel);
            persistVideoPreferences();
            textarea.placeholder = 'Describe the video you want to create';
            textarea.disabled = false;
            return;
        }
        v2vMode = false;
        selectedModel = allT2V[0].id;
        selectedModelName = allT2V[0].name;
        document.getElementById('v-model-btn-label').textContent = selectedModelName;
        updateControlsForModel(selectedModel);
        persistVideoPreferences();
        textarea.placeholder = 'Describe the video you want to create';
        textarea.disabled = false;
    };

    videoPickerBtn.onclick = (e) => {
        e.stopPropagation();
        if (uploadedVideoUrl) {
            clearVideoUpload();
        } else {
            videoFileInput.click();
        }
    };

    videoFileInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const currentHive = getHivemindVideoModelById(selectedModel);
        const preferredHive = currentHive?.supportsVideoInput
            ? currentHive
            : (hivemindI2V.find((model) => model.workflowId === 'ltx23-eros-fast' && model.supportsVideoInput)
                || hivemindI2V.find((model) => model.supportsVideoInput));
        const useHivemind = Boolean(preferredHive && isHivemindStudioEnabled());
        const apiKey = localStorage.getItem('muapi_key');
        if (!useHivemind && !apiKey) {
            AuthModal(() => videoFileInput.click());
            return;
        }

        showVideoSpinner();
        try {
            const upload = useHivemind
                ? await uploadFileToHivemindStudio(file)
                : { url: await muapi.uploadFile(file) };
            const url = upload.url;
            uploadedVideoUrl = url;
            uploadedVideoName = file.name;
            showVideoReady(file.name);

            if (useHivemind) {
                picker.reset();
                endPicker.reset();
                uploadedImageUrl = null;
                uploadedEndImageUrl = null;
                v2vMode = false;
                imageMode = true;
                selectedModel = preferredHive.id;
                selectedModelName = preferredHive.name;
                document.getElementById('v-model-btn-label').textContent = selectedModelName;
                updateControlsForModel(selectedModel);
                persistVideoPreferences();
                textarea.placeholder = 'Describe how the shot should continue';
                textarea.disabled = false;
            // If a motion-control v2v model is already selected, keep it and the image upload
            } else if (isMotionControlV2V()) {
                textarea.disabled = false;
                textarea.placeholder = uploadedImageUrl
                    ? (getCurrentModel()?.promptRequired ? 'Describe the motion' : 'Describe the motion (optional)')
                    : 'Now upload a reference image using the 🖼 button';
            } else {
                // Default v2v flow (e.g. watermark remover) — auto-pick the first v2v model
                if (imageMode) {
                    picker.reset();
                    uploadedImageUrl = null;
                    imageMode = false;
                }
                v2vMode = true;
                selectedModel = v2vModels[0].id;
                selectedModelName = v2vModels[0].name;
                document.getElementById('v-model-btn-label').textContent = selectedModelName;
                updateControlsForModel(selectedModel);
                persistVideoPreferences();
                textarea.placeholder = 'Video ready — click Generate to remove watermark';
                textarea.disabled = true;
            }
        } catch (err) {
            console.error('[VideoStudio] Video upload failed:', err);
            showVideoIcon();
            alert(`Video upload failed: ${err.message}`);
        }
        videoFileInput.value = '';
    };

    topRow.appendChild(videoPickerBtn);

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Describe the video you want to create';
    textarea.className = 'flex-1 bg-transparent border-none text-white text-base md:text-xl placeholder:text-muted focus:outline-none resize-none pt-2.5 leading-relaxed min-h-[40px] max-h-[150px] md:max-h-[250px] overflow-y-auto custom-scrollbar';
    textarea.rows = 1;
    textarea.oninput = () => {
        textarea.style.height = 'auto';
        const maxHeight = window.innerWidth < 768 ? 150 : 250;
        textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
    };

    topRow.appendChild(textarea);
    bar.appendChild(topRow);

    // Extend mode banner (shown when extend model is active, not editable by user)
    const extendBanner = document.createElement('div');
    extendBanner.className = 'hidden items-center gap-2 px-4 py-2 mx-2 mt-2 bg-primary/10 border border-primary/20 rounded-xl text-xs text-primary';
    extendBanner.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        <span>Extending previous Seedance 2.0 generation — add an optional prompt to guide the continuation</span>
    `;
    bar.appendChild(extendBanner);

    // Bottom Row: Controls
    const bottomRow = document.createElement('div');
    bottomRow.className = 'flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 px-2 pt-4 border-t border-white/5';

    const controlsLeft = document.createElement('div');
    controlsLeft.className = 'flex flex-1 min-w-0 items-center gap-1.5 md:gap-2 relative overflow-x-auto no-scrollbar pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0';

    const createControlBtn = (icon, label, id, tooltip) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = id;
        btn.className = 'flex items-center gap-1.5 md:gap-2.5 px-3 md:px-4 py-2 md:py-2.5 bg-white/5 hover:bg-white/10 rounded-xl md:rounded-2xl transition-all border border-white/5 group whitespace-nowrap';
        if (tooltip) btn.setAttribute('data-tooltip', tooltip);
        btn.innerHTML = `
            ${icon}
            <span id="${id}-label" class="text-xs font-bold text-white group-hover:text-primary transition-colors">${label}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" class="opacity-20 group-hover:opacity-100 transition-opacity"><path d="M6 9l6 6 6-6"/></svg>
        `;
        return btn;
    };

    const modelBtn = createControlBtn(`
        <div class="w-5 h-5 bg-primary rounded-md flex items-center justify-center shadow-lg shadow-primary/20">
            <span class="text-[10px] font-black text-black">V</span>
        </div>
    `, selectedModelName, 'v-model-btn', 'Select AI video model');

    const arBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>
    `, selectedAr, 'v-ar-btn', 'Change aspect ratio');

    const durationBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    `, `${selectedDuration}s`, 'v-duration-btn', 'Set video duration');

    const resolutionBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><path d="M6 2L3 6v15a2 2 0 002 2h14a2 2 0 002-2V6l-3-4H6z"/></svg>
    `, selectedResolution || '720p', 'v-resolution-btn', 'Set output resolution');

    const qualityBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
    `, selectedQuality || 'basic', 'v-quality-btn', 'Set output quality');

    const modeBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    `, selectedMode || 'normal', 'v-mode-btn');

    const effectNameBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6L12 2z"/></svg>
    `, 'Effect', 'v-effect-btn', 'Select effect type');

    const ingredientsBtn = document.createElement('button');
    ingredientsBtn.type = 'button';
    ingredientsBtn.id = 'v-ingredients-btn';
    ingredientsBtn.title = 'Open LTX Ingredients references';
    ingredientsBtn.style.display = 'none';
    ingredientsBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
        </svg>
        <span class="text-xs font-bold">LTX Ingredients</span>
        <span data-ingredient-count class="hidden min-w-5 rounded-full bg-black/25 px-1.5 py-0.5 text-[9px] font-black tabular-nums"></span>
    `;

    // Local/API source toggle — filters the model dropdown between local (LTX/Wan2GP) and
    // remote providers. Electron-only, since local models require the desktop bridge.
    let videoSourceToggleBtn = null;
    let updateVideoSourceToggleStyle = () => {};
    if (isLocalAIAvailable()) {
        videoSourceToggleBtn = document.createElement('button');
        videoSourceToggleBtn.id = 'v-source-toggle-btn';
        videoSourceToggleBtn.type = 'button';
        videoSourceToggleBtn.title = 'Switch between local and API video models';
        updateVideoSourceToggleStyle = () => {
            const base = 'flex items-center gap-1.5 px-3 py-2 rounded-xl transition-all border text-xs font-bold whitespace-nowrap';
            if (videoLocalMode) {
                videoSourceToggleBtn.className = `${base} bg-primary/20 border-primary/40 text-primary`;
                videoSourceToggleBtn.textContent = t('image.local');
            } else {
                videoSourceToggleBtn.className = `${base} bg-white/5 border-white/5 text-white/60 hover:bg-white/10`;
                videoSourceToggleBtn.textContent = t('image.api');
            }
        };
        updateVideoSourceToggleStyle();
        videoSourceToggleBtn.onclick = (e) => {
            e.stopPropagation();
            videoLocalMode = !videoLocalMode;
            updateVideoSourceToggleStyle();
            persistVideoPreferences();
            // Open the model dropdown filtered to the chosen source so the user can pick a model.
            showDropdown('model', modelBtn);
        };
        controlsLeft.appendChild(videoSourceToggleBtn);
    }
    controlsLeft.appendChild(modelBtn);
    controlsLeft.appendChild(ingredientsBtn);
    controlsLeft.appendChild(arBtn);
    controlsLeft.appendChild(durationBtn);
    controlsLeft.appendChild(resolutionBtn);
    controlsLeft.appendChild(qualityBtn);
    controlsLeft.appendChild(modeBtn);
    controlsLeft.appendChild(effectNameBtn);

    // Advanced options toggle button
    const advancedBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 001.82-.33 1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-1.82.33A1.65 1.65 0 0019.4 9a1.65 1.65 0 00-1.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
    `, 'Advanced', 'v-advanced-btn', 'Show advanced options');
    controlsLeft.appendChild(advancedBtn);

    // Initial visibility (t2v mode)
    const initDurations = getDurationsForModel(defaultModel.id);
    durationBtn.style.display = initDurations.length > 0 ? 'flex' : 'none';
    const initResolutions = getResolutionsForVideoModel(defaultModel.id);
    resolutionBtn.style.display = initResolutions.length > 0 ? 'flex' : 'none';
    qualityBtn.style.display = 'none';
    modeBtn.style.display = getModesForModel(defaultModel.id).length > 0 ? 'flex' : 'none';
    effectNameBtn.style.display = 'none';

    const generateBtn = document.createElement('button');
    generateBtn.className = 'bg-primary text-black px-6 md:px-8 py-3 md:py-3.5 rounded-xl md:rounded-2xl font-bold text-sm md:text-base hover:shadow-glow hover:scale-105 active:scale-95 transition-all flex items-center justify-center gap-2.5 w-full sm:w-auto shadow-lg';
    generateBtn.setAttribute('data-tooltip', 'Generate AI video from prompt');
    generateBtn.innerHTML = t('common.generate');

    const controlsRight = document.createElement('div');
    controlsRight.className = 'flex items-center justify-end gap-3 w-full sm:w-auto shrink-0';

    const pingToggleLabel = document.createElement('label');
    pingToggleLabel.className = 'flex items-center gap-2.5 px-2 py-2 cursor-pointer select-none shrink-0';
    pingToggleLabel.title = t('video.pingWhenComplete');
    pingToggleLabel.innerHTML = `
        <span class="relative w-9 h-5 shrink-0">
            <input data-video-completion-ping type="checkbox" class="peer absolute inset-0 w-full h-full opacity-0 cursor-pointer" aria-label="${t('video.pingWhenComplete')}">
            <span class="absolute inset-0 rounded-full bg-white/10 border border-white/10 transition-colors peer-checked:bg-primary/30 peer-checked:border-primary/60"></span>
            <span class="absolute left-[3px] top-[3px] w-3.5 h-3.5 rounded-full bg-white/60 transition-all peer-checked:translate-x-4 peer-checked:bg-primary"></span>
        </span>
        <span class="text-[11px] font-bold text-secondary whitespace-nowrap">${t('video.pingWhenComplete')}</span>
    `;
    const pingToggleInput = pingToggleLabel.querySelector('[data-video-completion-ping]');
    pingToggleInput.checked = pingWhenComplete;

    bottomRow.appendChild(controlsLeft);
    controlsRight.appendChild(generateBtn);
    bottomRow.appendChild(controlsRight);
    bar.appendChild(bottomRow);
    promptWrapper.appendChild(bar);
    container.appendChild(promptWrapper);

    const generationProgressView = document.createElement('div');
    generationProgressView.id = 'video-generation-progress';
    generationProgressView.className = 'video-generation-stage absolute inset-0 z-50 flex items-start justify-center p-4 md:p-8 opacity-0 pointer-events-none translate-y-4 transition-all duration-500';
    generationProgressView.setAttribute('role', 'status');
    generationProgressView.setAttribute('aria-live', 'polite');
    generationProgressView.setAttribute('aria-hidden', 'true');
    generationProgressView.innerHTML = `
        <div class="video-generation-card w-full max-w-[440px] bg-[#101313] border border-white/10 rounded-2xl p-4 md:p-5 shadow-3xl">
            <div class="flex items-center justify-between gap-4 mb-4">
                <div class="flex items-center gap-3 min-w-0">
                    <div class="video-generation-icon w-10 h-10 shrink-0 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                    </div>
                    <div class="min-w-0">
                        <p class="text-sm font-black text-white">${t('video.progressTitle')}</p>
                        <p data-video-progress-model class="text-[11px] text-secondary truncate mt-0.5"></p>
                    </div>
                </div>
                <span data-video-progress-value class="shrink-0 text-xs font-black text-primary tabular-nums">${t('video.progress.inProgress')}</span>
            </div>

            <div class="video-generation-preview relative aspect-video overflow-hidden rounded-xl border border-white/10 bg-black/40">
                <img data-video-progress-preview alt="" class="hidden absolute inset-0 w-full h-full object-cover opacity-70">
                <div data-video-progress-placeholder class="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                    <div class="video-generation-frames flex items-center gap-2 text-white/20">
                        <span></span><span></span><span></span>
                    </div>
                </div>
                <div class="video-generation-scan" aria-hidden="true"></div>
                <div class="absolute inset-x-0 bottom-0 flex items-center gap-2 px-3 py-2 bg-black/70">
                    <span class="video-generation-live-dot w-1.5 h-1.5 rounded-full bg-primary" aria-hidden="true"></span>
                    <span data-video-progress-status class="text-[11px] font-bold text-white">${t('video.progress.preparing')}</span>
                </div>
            </div>

            <div class="mt-4">
                <div data-video-progress-track data-progress-mode="indeterminate" class="video-generation-progress-track h-1.5 rounded-full bg-white/10 overflow-hidden" role="progressbar" aria-label="Video generation progress">
                    <div data-video-progress-fill class="video-generation-progress-fill h-full rounded-full bg-primary"></div>
                </div>
                <div class="mt-2 flex items-center justify-between text-[10px] text-muted">
                    <span data-video-progress-detail>${t('video.progress.rendering')}</span>
                    <span class="tabular-nums"><span>${t('video.progress.elapsed')}</span> <span data-video-progress-elapsed>0:00</span></span>
                </div>
            </div>
        </div>
    `;
    container.appendChild(generationProgressView);

    const generationProgressModel = generationProgressView.querySelector('[data-video-progress-model]');
    const generationProgressValue = generationProgressView.querySelector('[data-video-progress-value]');
    const generationProgressPreview = generationProgressView.querySelector('[data-video-progress-preview]');
    const generationProgressPlaceholder = generationProgressView.querySelector('[data-video-progress-placeholder]');
    const generationProgressStatus = generationProgressView.querySelector('[data-video-progress-status]');
    const generationProgressTrack = generationProgressView.querySelector('[data-video-progress-track]');
    const generationProgressFill = generationProgressView.querySelector('[data-video-progress-fill]');
    const generationProgressDetail = generationProgressView.querySelector('[data-video-progress-detail]');
    const generationProgressElapsed = generationProgressView.querySelector('[data-video-progress-elapsed]');

    // ==========================================
    // 3. DROPDOWNS
    // ==========================================
    const dropdown = document.createElement('div');
    dropdown.className = 'absolute bottom-[102%] left-2 z-50 transition-all opacity-0 pointer-events-none scale-95 origin-bottom-left glass rounded-3xl p-3 translate-y-2 w-[calc(100vw-3rem)] max-w-xs shadow-4xl border border-white/10 flex flex-col';
    dropdown.id = 'v-control-dropdown';
    dropdown.onclick = (event) => event.stopPropagation();
    advancedBtn.setAttribute('aria-controls', dropdown.id);
    advancedBtn.setAttribute('aria-expanded', 'false');

    const getIngredientsWorkflow = () => {
        const selected = hivemindI2V.find((model) => model.id === selectedModel && model.supportsIngredientImages);
        return selected
            || hivemindI2V.find((model) => model.workflowId === 'ltx23-ic-ingredients-lora')
            || hivemindI2V.find((model) => model.supportsIngredientImages)
            || null;
    };
    const updateIngredientsShortcut = () => {
        const workflow = getIngredientsWorkflow();
        ingredientsBtn.style.display = workflow ? 'flex' : 'none';
        const active = Boolean(workflow && selectedModel === workflow.id);
        const selectedCount = selectedIngredientSheet === 'stitched'
            ? sharedIngredientSelections.length
            : (sharedIngredientSheets.some((sheet) => sheet.url === selectedIngredientSheet) ? 1 : 0);
        const savedCount = sharedIngredientSelections.length + sharedIngredientSheets.length;
        const referenceCount = selectedCount || savedCount;
        const usingUploadedSheet = selectedCount > 0 && selectedIngredientSheet !== 'stitched';
        ingredientsBtn.setAttribute('aria-pressed', String(active));
        ingredientsBtn.setAttribute('aria-label', active && selectedCount
            ? (usingUploadedSheet
                ? 'LTX Ingredients active with an uploaded ingredients sheet'
                : `LTX Ingredients active with ${selectedCount} reference views`)
            : referenceCount
                ? `Open ${referenceCount} saved LTX Ingredients references`
                : 'Open LTX Ingredients references');
        ingredientsBtn.title = active && selectedCount
            ? (usingUploadedSheet
                ? 'The uploaded ingredients sheet is active for the next generation'
                : `${selectedCount} ingredient reference views are active for the next generation`)
            : referenceCount
                ? `${referenceCount} saved ingredient references; select an Ingredients workflow and tap a sheet to use them`
                : 'Open LTX Ingredients references';
        const count = ingredientsBtn.querySelector('[data-ingredient-count]');
        if (count) {
            const emerald = active && selectedCount > 0;
            count.textContent = String(referenceCount);
            count.classList.toggle('hidden', referenceCount === 0);
            count.classList.toggle('bg-emerald-300', emerald);
            count.classList.toggle('bg-black/25', !emerald && referenceCount > 0);
            count.classList.toggle('text-black', emerald);
        }
        ingredientsBtn.className = active
            ? 'flex items-center gap-1.5 md:gap-2.5 px-3 md:px-4 py-2 md:py-2.5 rounded-xl md:rounded-2xl transition-all border whitespace-nowrap bg-primary/10 border-primary/30 text-primary'
            : 'flex items-center gap-1.5 md:gap-2.5 px-3 md:px-4 py-2 md:py-2.5 rounded-xl md:rounded-2xl transition-all border whitespace-nowrap bg-white/5 hover:bg-white/10 border-white/5 text-white';
    };

    const updateControlsForModel = (modelId) => {
        const model = getCurrentModels().find(m => m.id === modelId);
        const localVideoInput = isHivemindVideoInputMode();
        advancedValues = getDefaultAdvancedVideoValues(model);
        updateIngredientsShortcut();

        // End-frame picker visibility depends on imageMode + model.lastImageField.
        updateEndFrameVisibility();

        // In v2v mode, hide all parameter controls — no prompt/AR/duration/etc needed
        if (v2vMode) {
            arBtn.style.display = 'none';
            durationBtn.style.display = 'none';
            resolutionBtn.style.display = 'none';
            qualityBtn.style.display = 'none';
            modeBtn.style.display = 'none';
            effectNameBtn.style.display = 'none';
            extendBanner.classList.add('hidden');
            extendBanner.classList.remove('flex');
            return;
        }

        // Aspect ratio
        const availableArs = getCurrentAspectRatios(modelId);
        if (!localVideoInput && availableArs.length > 0) {
            selectedAr = availableArs[0];
            document.getElementById('v-ar-btn-label').textContent = selectedAr;
            arBtn.style.display = 'flex';
        } else {
            arBtn.style.display = 'none';
        }

        // Duration
        const durations = getCurrentDurations(modelId);
        if (durations.length > 0) {
            selectedDuration = durations.find((duration) => Number(duration) === Number(model?.inputs?.duration?.default))
                ?? durations[0];
            document.getElementById('v-duration-btn-label').textContent = `${selectedDuration}s`;
            durationBtn.style.display = 'flex';
        } else {
            durationBtn.style.display = 'none';
        }

        // Resolution
        const resolutions = getCurrentResolutions(modelId);
        if (resolutions.length > 0) {
            selectedResolution = resolutions[0];
            document.getElementById('v-resolution-btn-label').textContent = selectedResolution;
            resolutionBtn.style.display = 'flex';
        } else {
            resolutionBtn.style.display = 'none';
        }

        // Quality
        const qualities = getQualitiesForModel(modelId);
        if (qualities.length > 0) {
            selectedQuality = model?.inputs?.quality?.default || qualities[0];
            document.getElementById('v-quality-btn-label').textContent = selectedQuality;
            qualityBtn.style.display = 'flex';
        } else {
            selectedQuality = '';
            qualityBtn.style.display = 'none';
        }

        // Mode
        const modes = getCurrentModes(modelId);
        if (modes.length > 0) {
            selectedMode = model?.inputs?.mode?.default || modes[0];
            document.getElementById('v-mode-btn-label').textContent = selectedMode;
            modeBtn.style.display = 'flex';
        } else {
            selectedMode = '';
            modeBtn.style.display = 'none';
        }

        // Effect name (ai-video-effects / motion-controls)
        const effectNames = getEffectNamesForModel(modelId);
        if (effectNames.length > 0) {
            selectedEffectName = model?.inputs?.name?.default || effectNames[0];
            document.getElementById('v-effect-btn-label').textContent = selectedEffectName;
            effectNameBtn.style.display = 'flex';
        } else {
            selectedEffectName = '';
            effectNameBtn.style.display = 'none';
        }

        // Extend banner (extend model only)
        if (localVideoInput) {
            extendBanner.querySelector('span').textContent = 'Extending the uploaded LTX shot; duration controls how much new footage is appended';
            extendBanner.classList.remove('hidden');
            extendBanner.classList.add('flex');
        } else if (model?.requiresRequestId) {
            extendBanner.querySelector('span').textContent = 'Extending previous Seedance 2.0 generation; add an optional prompt to guide the continuation';
            extendBanner.classList.remove('hidden');
            extendBanner.classList.add('flex');
        } else {
            extendBanner.classList.add('hidden');
            extendBanner.classList.remove('flex');
        }
    };

    const persistVideoPreferences = () => {
        const preferences = normalizeVideoPreferences({
            modelId: selectedModel,
            localMode: videoLocalMode,
            duration: selectedDuration,
            aspectRatio: selectedAr,
            resolution: selectedResolution,
            quality: selectedQuality,
            mode: selectedMode,
            effectName: selectedEffectName,
            advancedValues,
            loraSelections: Object.fromEntries(videoLoraSelectionsByModel),
            ingredientSelections: sharedIngredientSelections,
            ingredientSheets: sharedIngredientSheets,
            ingredientSelectedSheet: selectedIngredientSheet,
            pingWhenComplete,
        });
        if (!preferences) return;
        persistedVideoPreferences = preferences;
        try {
            localStorage.setItem(VIDEO_PREFERENCES_KEY, JSON.stringify(preferences));
        } catch {}
    };

    const restorePersistedVideoPreferences = () => {
        const preferences = persistedVideoPreferences;
        if (!preferences) return false;

        const v2vModel = v2vModels.find((model) => model.id === preferences.modelId);
        const i2vModel = allI2V.find((model) => model.id === preferences.modelId);
        const t2vModel = allT2V.find((model) => model.id === preferences.modelId);
        const target = v2vModel || i2vModel || t2vModel;
        if (!target) return false;

        v2vMode = Boolean(v2vModel);
        imageMode = !v2vMode && Boolean(i2vModel);
        selectedModel = target.id;
        selectedModelName = target.name;
        videoLocalMode = preferences.localMode ?? isLocalVideoModel(target.id);
        updateVideoSourceToggleStyle();
        const label = document.getElementById('v-model-btn-label');
        if (label) label.textContent = selectedModelName;
        updateControlsForModel(selectedModel);

        const matchingDuration = getCurrentDurations(selectedModel)
            .find((duration) => Number(duration) === preferences.duration);
        if (matchingDuration != null) {
            selectedDuration = matchingDuration;
            const durationLabel = document.getElementById('v-duration-btn-label');
            if (durationLabel) durationLabel.textContent = `${selectedDuration}s`;
        }

        const restoreChoice = (values, saved, apply) => {
            const match = values.find((value) => String(value) === String(saved));
            if (match != null) apply(match);
        };
        restoreChoice(getCurrentAspectRatios(selectedModel), preferences.aspectRatio, (value) => {
            selectedAr = value;
            const label = document.getElementById('v-ar-btn-label');
            if (label) label.textContent = value;
        });
        restoreChoice(getCurrentResolutions(selectedModel), preferences.resolution, (value) => {
            selectedResolution = value;
            const label = document.getElementById('v-resolution-btn-label');
            if (label) label.textContent = value;
        });
        restoreChoice(getQualitiesForModel(selectedModel), preferences.quality, (value) => {
            selectedQuality = value;
            const label = document.getElementById('v-quality-btn-label');
            if (label) label.textContent = value;
        });
        restoreChoice(getCurrentModes(selectedModel), preferences.mode, (value) => {
            selectedMode = value;
            const label = document.getElementById('v-mode-btn-label');
            if (label) label.textContent = value;
        });
        restoreChoice(getEffectNamesForModel(selectedModel), preferences.effectName, (value) => {
            selectedEffectName = value;
            const label = document.getElementById('v-effect-btn-label');
            if (label) label.textContent = value;
        });
        advancedValues = getRestoredAdvancedVideoValues(target, preferences.advancedValues);
        pingWhenComplete = preferences.pingWhenComplete;
        pingToggleInput.checked = pingWhenComplete;

        if (v2vMode) {
            textarea.disabled = !target.imageField;
            textarea.placeholder = target.imageField
                ? (target.promptRequired
                    ? 'Upload a reference video and image, then describe the motion'
                    : 'Upload a reference video and image, then describe the motion (optional)')
                : 'Upload a video using the 🎥 button, then click Generate';
        } else if (imageMode) {
            textarea.disabled = false;
            textarea.placeholder = target.supportsIngredientImages
                ? 'Describe the shot using the selected character references'
                : isHivemindVideoModelId(selectedModel)
                ? 'Upload a start frame image, then describe the motion'
                : 'Describe the motion or effect (optional)';
        } else {
            textarea.disabled = false;
            textarea.placeholder = 'Describe the video you want to create';
        }
        return true;
    };

    const selectHivemindWorkflowModel = (modelId) => {
        const target = allI2V.find(m => m.id === modelId);
        if (!target) return false;
        if (v2vMode) {
            v2vMode = false;
            uploadedVideoUrl = null;
            showVideoIcon();
        }
        imageMode = true;
        videoLocalMode = true;
        updateVideoSourceToggleStyle();
        selectedModel = target.id;
        selectedModelName = target.name;
        const label = document.getElementById('v-model-btn-label');
        if (label) label.textContent = selectedModelName;
        updateControlsForModel(selectedModel);
        persistVideoPreferences();
        textarea.placeholder = target.supportsIngredientImages
            ? 'Describe the shot using the selected character references'
            : uploadedImageUrl
                ? 'Describe the motion or effect (optional)'
                : 'Upload a start frame image, then describe the motion';
        textarea.disabled = false;
        return true;
    };

    const applyHivemindWorkflows = (context) => {
        const videoModels = Array.isArray(context?.videoModels) ? context.videoModels : [];
        if (!videoModels.length && hivemindI2V.length) return;
        const signature = JSON.stringify(videoModels);
        if (signature === hivemindWorkflowSignature) return;
        hivemindWorkflowSignature = signature;
        // A catalog fetched before the owner-unlock comes back empty and is then memoized
        // module-wide. Apply every later catalog update so the local lane recovers in-place.
        hivemindI2V = videoModels.map(adaptHivemindToVideoEntry);
        allI2V = [...hivemindI2V, ...i2vModels, ...localI2V];
        updateIngredientsShortcut();
        const restoredPreference = restorePersistedVideoPreferences();
        if (!restoredPreference) {
            const saved = getSavedHivemindVideoSelection();
            const preferredModelId = saved?.modelId
                || hivemindI2V.find((model) => model.workflowId === 'ltx23-eros-fast')?.id
                || hivemindI2V[0]?.id;
            if (preferredModelId && isHivemindStudioEnabled()) selectHivemindWorkflowModel(preferredModelId);
        }
        if (dropdownOpen === 'model') showDropdown('model', modelBtn);
    };
    const refreshHivemindWorkflows = async () => {
        let context = await loadHivemindStudioContext();
        // Owner unlock and backend startup can race the iframe's first request.
        if (!context.videoModels?.length) context = await loadHivemindStudioContext({ refresh: true });
        applyHivemindWorkflows(context);
    };
    queueMicrotask(() => {
        restorePersistedVideoPreferences();
        void refreshHivemindWorkflows();
    });
    window.addEventListener('hivemind-workflow-selected', (event) => {
        const modelId = event.detail?.modelId;
        if (!modelId) return;
        if (selectHivemindWorkflowModel(modelId)) return;
        refreshHivemindWorkflows().then(() => selectHivemindWorkflowModel(modelId));
    });
    const handleHivemindContextUpdate = (event) => {
        if (!container.isConnected) {
            window.requestAnimationFrame(() => {
                if (container.isConnected && event.detail?.context) applyHivemindWorkflows(event.detail.context);
                else if (!container.isConnected) window.removeEventListener('hivemind-context-updated', handleHivemindContextUpdate);
            });
            return;
        }
        if (event.detail?.context) applyHivemindWorkflows(event.detail.context);
    };
    window.addEventListener('hivemind-context-updated', handleHivemindContextUpdate);

    const currentIngredientModel = () => {
        const model = getCurrentModel();
        return model?.provider === 'hivemind-media-studio' && model.supportsIngredientImages ? model : null;
    };
    async function matchIngredientsAspectToStartFrame(url) {
        try {
            const dimensions = await imageDimensions(url);
            if (uploadedImageUrl !== url) return;
            const model = currentIngredientModel();
            if (!model) return;
            const matched = closestVideoAspectRatio(
                dimensions.width,
                dimensions.height,
                getCurrentAspectRatios(model.id),
            );
            if (!matched || matched === selectedAr) return;
            selectedAr = matched;
            const label = document.getElementById('v-ar-btn-label');
            if (label) label.textContent = matched;
            persistVideoPreferences();
            void refreshIngredientSheetPreview({ force: true });
        } catch {
            // Keep the user's current aspect ratio when the browser cannot inspect the image.
        }
    }
    // A finished sheet conditions best when the output canvas matches its
    // geometry: a portrait sheet letterboxed onto a landscape canvas shrinks
    // every reference panel into uselessness. Snap the aspect on selection.
    async function matchAspectToIngredientSheet(url) {
        try {
            const dimensions = await imageDimensions(url);
            const model = currentIngredientModel();
            if (!model || selectedIngredientSheet !== url) return;
            const matched = closestVideoAspectRatio(
                dimensions.width,
                dimensions.height,
                getCurrentAspectRatios(model.id),
            );
            if (!matched || matched === selectedAr) return;
            selectedAr = matched;
            const label = document.getElementById('v-ar-btn-label');
            if (label) label.textContent = matched;
            persistVideoPreferences();
        } catch {
            // Keep the user's aspect ratio when the browser cannot inspect the sheet.
        }
    }
    const currentIngredientSelection = () => currentIngredientModel() ? sharedIngredientSelections : [];
    const selectedUploadedIngredientSheet = () => (
        sharedIngredientSheets.find((sheet) => sheet.url === selectedIngredientSheet) || null
    );
    // The references the next generation actually conditions on: the stitched
    // sheet's source views, the one selected uploaded sheet, or nothing at all.
    const activeIngredientSheetItems = () => {
        if (!currentIngredientModel()) return [];
        if (selectedIngredientSheet === 'stitched') return sharedIngredientSelections;
        const sheet = selectedUploadedIngredientSheet();
        return sheet ? [sheet] : [];
    };
    const syncSelectedIngredientSheet = () => {
        selectedIngredientSheet = normalizeSelectedVideoIngredientSheet(
            selectedIngredientSheet,
            sharedIngredientSelections,
            sharedIngredientSheets,
        );
    };
    const ingredientSelectionSignature = (model, selection) => JSON.stringify([
        Boolean(model),
        selectedAr,
        ...selection.map((item) => item.url),
    ]);
    const releaseIngredientSheetPreview = () => {
        if (ingredientSheetPreview.url) URL.revokeObjectURL(ingredientSheetPreview.url);
    };
    const refreshIngredientSheetPreview = async ({ force = false } = {}) => {
        const model = currentIngredientModel();
        const selection = currentIngredientSelection();
        if (!model || !selection.length) {
            ingredientSheetPreviewRequest += 1;
            releaseIngredientSheetPreview();
            ingredientSheetPreview = {
                workflowId: model?.workflowId || '',
                signature: '',
                status: 'idle',
                url: '',
                columns: null,
                rows: null,
                width: null,
                height: null,
                sourceCount: 0,
                error: '',
            };
            return;
        }
        const signature = ingredientSelectionSignature(model, selection);
        if (!force && ingredientSheetPreview.signature === signature
            && ['loading', 'ready'].includes(ingredientSheetPreview.status)) return;
        const request = ++ingredientSheetPreviewRequest;
        releaseIngredientSheetPreview();
        ingredientSheetPreview = {
            workflowId: model.workflowId,
            signature,
            status: 'loading',
            url: '',
            columns: null,
            rows: null,
            width: null,
            height: null,
            sourceCount: selection.length,
            error: '',
        };
        if (dropdownOpen === 'advanced') showDropdown('advanced', advancedBtn);
        try {
            const result = await previewHivemindIngredientSheet(selection.map((item) => ({
                image: item.url,
                description: item.description,
            })), { aspectRatio: selectedAr });
            const url = URL.createObjectURL(result.blob);
            if (request !== ingredientSheetPreviewRequest
                || signature !== ingredientSelectionSignature(currentIngredientModel(), currentIngredientSelection())) {
                URL.revokeObjectURL(url);
                return;
            }
            ingredientSheetPreview = {
                workflowId: model.workflowId,
                signature,
                status: 'ready',
                url,
                columns: result.columns,
                rows: result.rows,
                width: result.width,
                height: result.height,
                sourceCount: result.sourceCount,
                error: '',
            };
        } catch (error) {
            if (request !== ingredientSheetPreviewRequest) return;
            ingredientSheetPreview = {
                workflowId: model.workflowId,
                signature,
                status: 'error',
                url: '',
                columns: null,
                rows: null,
                width: null,
                height: null,
                sourceCount: selection.length,
                error: error.message,
            };
        }
        if (dropdownOpen === 'advanced') showDropdown('advanced', advancedBtn);
    };
    const setCurrentIngredientSelection = (selection) => {
        const model = currentIngredientModel();
        if (!model) return;
        sharedIngredientSelections = selection
            .slice(0, model.ingredientInputs?.max_images || 12)
            .map((item) => ({ ...item }));
        syncSelectedIngredientSheet();
        updateIngredientsShortcut();
        persistVideoPreferences();
        void refreshIngredientSheetPreview();
    };
    const toggleIngredientSheetSelection = (sheetId) => {
        selectedIngredientSheet = selectedIngredientSheet === sheetId ? '' : sheetId;
        syncSelectedIngredientSheet();
        if (selectedIngredientSheet && selectedIngredientSheet !== 'stitched') {
            void matchAspectToIngredientSheet(selectedIngredientSheet);
        }
        updateIngredientsShortcut();
        persistVideoPreferences();
        if (dropdownOpen === 'advanced') showDropdown('advanced', advancedBtn);
    };
    const removeIngredientSheet = (url) => {
        sharedIngredientSheets = sharedIngredientSheets.filter((sheet) => sheet.url !== url);
        syncSelectedIngredientSheet();
        updateIngredientsShortcut();
        persistVideoPreferences();
        void deleteHivemindStudioUpload(url).catch(() => {});
        if (dropdownOpen === 'advanced') showDropdown('advanced', advancedBtn);
    };
    let ingredientUploadMessage = '';
    const ingredientFileInput = document.createElement('input');
    ingredientFileInput.type = 'file';
    ingredientFileInput.accept = 'image/*';
    ingredientFileInput.multiple = true;
    ingredientFileInput.className = 'hidden';
    ingredientFileInput.setAttribute('aria-label', 'Add ingredient reference images');
    container.appendChild(ingredientFileInput);
    ingredientFileInput.onchange = async () => {
        const model = currentIngredientModel();
        if (!model) return;
        const existing = currentIngredientSelection();
        const maximum = Number(model.ingredientInputs?.max_images || 12);
        const files = [...(ingredientFileInput.files || [])].slice(0, Math.max(0, maximum - existing.length));
        ingredientFileInput.value = '';
        if (!files.length) return;
        ingredientUploadMessage = `Adding ${files.length} view${files.length === 1 ? '' : 's'}…`;
        if (dropdownOpen === 'advanced') showDropdown('advanced', advancedBtn);
        try {
            const uploaded = [];
            for (const file of files) {
                const result = await uploadFileToHivemindStudio(file);
                uploaded.push({ url: result.url, description: '' });
            }
            // Fresh reference views make the stitched sheet the active selection.
            selectedIngredientSheet = 'stitched';
            setCurrentIngredientSelection([...existing, ...uploaded]);
            ingredientUploadMessage = '';
        } catch (error) {
            ingredientUploadMessage = `Upload failed: ${error.message}`;
        }
        if (dropdownOpen === 'advanced') showDropdown('advanced', advancedBtn);
    };
    const ingredientSheetFileInput = document.createElement('input');
    ingredientSheetFileInput.type = 'file';
    ingredientSheetFileInput.accept = 'image/*';
    ingredientSheetFileInput.multiple = true;
    ingredientSheetFileInput.className = 'hidden';
    ingredientSheetFileInput.setAttribute('aria-label', 'Upload finished ingredients sheets');
    container.appendChild(ingredientSheetFileInput);
    ingredientSheetFileInput.onchange = async () => {
        const model = currentIngredientModel();
        if (!model) return;
        const files = [...(ingredientSheetFileInput.files || [])].slice(0, Math.max(0, 12 - sharedIngredientSheets.length));
        ingredientSheetFileInput.value = '';
        if (!files.length) return;
        ingredientUploadMessage = `Adding ${files.length} sheet${files.length === 1 ? '' : 's'}…`;
        if (dropdownOpen === 'advanced') showDropdown('advanced', advancedBtn);
        try {
            for (const file of files) {
                const result = await uploadFileToHivemindStudio(file);
                sharedIngredientSheets = [...sharedIngredientSheets, { url: result.url, description: '' }];
                // A freshly uploaded finished sheet becomes the active selection.
                selectedIngredientSheet = result.url;
            }
            ingredientUploadMessage = '';
        } catch (error) {
            ingredientUploadMessage = `Upload failed: ${error.message}`;
        }
        syncSelectedIngredientSheet();
        if (selectedIngredientSheet && selectedIngredientSheet !== 'stitched') {
            void matchAspectToIngredientSheet(selectedIngredientSheet);
        }
        updateIngredientsShortcut();
        persistVideoPreferences();
        if (dropdownOpen === 'advanced') showDropdown('advanced', advancedBtn);
    };

    const renderIngredientReferenceSection = () => {
        const model = currentIngredientModel();
        if (!model) return;
        const selection = currentIngredientSelection();
        const maximum = Number(model.ingredientInputs?.max_images || 12);
        const activeCount = activeIngredientSheetItems().length;
        const section = document.createElement('section');
        section.dataset.ingredientReferenceSection = '';
        section.className = 'mt-2 border-t border-white/5 px-2 pt-3';

        const header = document.createElement('div');
        header.className = 'flex flex-wrap items-center justify-between gap-2';
        const title = document.createElement('div');
        title.className = 'min-w-0';
        const countsLine = [
            `${selection.length} / ${maximum} views`,
            ...(sharedIngredientSheets.length
                ? [`${sharedIngredientSheets.length} uploaded sheet${sharedIngredientSheets.length === 1 ? '' : 's'}`]
                : []),
        ].join(' · ');
        title.innerHTML = `<div class="text-[10px] font-bold uppercase tracking-widest text-secondary">Ingredient references</div><div class="mt-1 text-[10px] text-muted">${countsLine}</div>`;
        header.appendChild(title);
        if (activeCount) {
            const activeStatus = document.createElement('div');
            activeStatus.className = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-emerald-400/10 px-2 py-1 text-[9px] font-bold text-emerald-200';
            activeStatus.innerHTML = '<span class="h-1.5 w-1.5 rounded-full bg-emerald-300" aria-hidden="true"></span><span>Active in next generation</span>';
            activeStatus.setAttribute('role', 'status');
            header.appendChild(activeStatus);
        } else if (selection.length || sharedIngredientSheets.length) {
            const idleStatus = document.createElement('div');
            idleStatus.className = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white/5 px-2 py-1 text-[9px] font-bold text-muted';
            idleStatus.innerHTML = '<span class="h-1.5 w-1.5 rounded-full bg-white/25" aria-hidden="true"></span><span>Off — tap a sheet to use it</span>';
            idleStatus.setAttribute('role', 'status');
            header.appendChild(idleStatus);
        }
        const actions = document.createElement('div');
        actions.className = 'flex items-center gap-2';
        const add = document.createElement('button');
        add.type = 'button';
        add.title = 'Add reference views that get stitched into one sheet';
        add.disabled = selection.length >= maximum;
        add.className = 'inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1.5 text-[10px] font-bold text-secondary transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30';
        add.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>Add views</span>';
        add.onclick = () => ingredientFileInput.click();
        actions.appendChild(add);
        const addSheet = document.createElement('button');
        addSheet.type = 'button';
        addSheet.title = 'Upload a finished ingredients sheet, used as-is without stitching';
        addSheet.disabled = sharedIngredientSheets.length >= 12;
        addSheet.className = 'inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1.5 text-[10px] font-bold text-secondary transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30';
        addSheet.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18M12 3v18"/></svg><span>Add sheet</span>';
        addSheet.onclick = () => ingredientSheetFileInput.click();
        actions.appendChild(addSheet);
        if (selection.length || sharedIngredientSheets.length) {
            const clear = document.createElement('button');
            clear.type = 'button';
            clear.title = 'Remove all ingredient references and sheets';
            clear.className = 'rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[10px] font-bold text-red-300 hover:bg-red-500/20';
            clear.textContent = 'Clear';
            clear.onclick = () => {
                const removed = [...selection, ...sharedIngredientSheets];
                sharedIngredientSheets = [];
                setCurrentIngredientSelection([]);
                removed.forEach((item) => { void deleteHivemindStudioUpload(item.url).catch(() => {}); });
                showDropdown('advanced', advancedBtn);
            };
            actions.appendChild(clear);
        }
        header.appendChild(actions);
        section.appendChild(header);

        if (ingredientUploadMessage) {
            const status = document.createElement('div');
            status.className = 'mt-3 rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2 text-[10px] text-muted';
            status.setAttribute('role', 'status');
            status.textContent = ingredientUploadMessage;
            section.appendChild(status);
        }

        // Sheet picker: the auto-stitched sheet plus any uploaded finished
        // sheets, exactly one of which conditions the next generation.
        const createSheetCard = ({ sheetId, label, detail, media, corner }) => {
            const selected = selectedIngredientSheet === sheetId;
            const wrapper = document.createElement('div');
            wrapper.className = 'relative';
            const card = document.createElement('button');
            card.type = 'button';
            card.dataset.ingredientSheetOption = sheetId;
            card.setAttribute('aria-pressed', String(selected));
            card.title = selected
                ? 'Tap again to turn ingredients off'
                : 'Use this ingredients sheet for the next generation';
            card.className = selected
                ? 'block w-full overflow-hidden rounded-xl border-2 border-primary/70 bg-black text-left focus:outline-none focus:ring-2 focus:ring-primary/50'
                : 'block w-full overflow-hidden rounded-xl border border-white/10 bg-black text-left transition-colors hover:border-white/30 focus:outline-none focus:ring-2 focus:ring-primary/50';
            card.onclick = () => toggleIngredientSheetSelection(sheetId);
            const frame = document.createElement('div');
            frame.className = 'grid h-24 place-items-center overflow-hidden bg-black';
            frame.appendChild(media);
            card.appendChild(frame);
            const caption = document.createElement('div');
            caption.className = 'flex items-center justify-between gap-1 border-t border-white/10 bg-white/[0.04] px-2 py-1.5';
            caption.innerHTML = `<span class="min-w-0"><span class="block truncate text-[10px] font-bold ${selected ? 'text-primary' : 'text-white/80'}">${label}</span>${detail ? `<span class="block truncate text-[9px] text-muted">${detail}</span>` : ''}</span>${selected ? '<span class="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide text-primary">On</span>' : ''}`;
            card.appendChild(caption);
            wrapper.appendChild(card);
            if (corner) {
                corner.classList.add('absolute', 'right-1', 'top-1', 'z-10');
                wrapper.appendChild(corner);
            }
            return wrapper;
        };

        if (selection.length || sharedIngredientSheets.length) {
            const signature = ingredientSelectionSignature(model, selection);
            const previewMatches = ingredientSheetPreview.signature === signature;
            const previewStatus = previewMatches ? ingredientSheetPreview.status : 'loading';
            if (selection.length && (!previewMatches || ingredientSheetPreview.status === 'idle')) {
                queueMicrotask(() => { void refreshIngredientSheetPreview(); });
            }
            const sheets = document.createElement('div');
            sheets.className = 'mt-3';
            const sheetsHeader = document.createElement('div');
            sheetsHeader.className = 'mb-2 flex items-center justify-between gap-2';
            sheetsHeader.innerHTML = '<span class="text-[10px] font-bold text-white/70">Ingredients sheet</span><span class="text-[9px] text-muted">Tap to select · tap again to turn off</span>';
            sheets.appendChild(sheetsHeader);
            const grid = document.createElement('div');
            grid.className = 'grid grid-cols-2 gap-2';

            if (selection.length) {
                let media;
                let corner = null;
                let detail = `${selection.length} view${selection.length === 1 ? '' : 's'}`;
                if (previewStatus === 'ready' && ingredientSheetPreview.url) {
                    media = document.createElement('img');
                    media.src = ingredientSheetPreview.url;
                    media.alt = `Stitched ingredient sheet containing ${ingredientSheetPreview.sourceCount} reference views`;
                    media.className = 'h-24 w-full bg-black object-contain';
                    const pixelSize = ingredientSheetPreview.width && ingredientSheetPreview.height
                        ? `${ingredientSheetPreview.width} × ${ingredientSheetPreview.height}`
                        : '';
                    const gridSize = ingredientSheetPreview.columns && ingredientSheetPreview.rows
                        ? `${ingredientSheetPreview.columns} × ${ingredientSheetPreview.rows} grid`
                        : `${ingredientSheetPreview.sourceCount} views`;
                    detail = [pixelSize, gridSize].filter(Boolean).join(' · ');
                    corner = document.createElement('a');
                    corner.href = ingredientSheetPreview.url;
                    corner.target = '_blank';
                    corner.rel = 'noopener';
                    corner.title = 'Open stitched sheet full size';
                    corner.setAttribute('aria-label', corner.title);
                    corner.className = 'grid h-6 w-6 place-items-center rounded-lg bg-black/60 text-[11px] text-white/80 backdrop-blur hover:bg-black/80 hover:text-white';
                    corner.textContent = '⤢';
                } else if (previewStatus === 'error') {
                    media = document.createElement('div');
                    media.className = 'px-2 text-center text-[9px] text-red-200';
                    media.textContent = ingredientSheetPreview.error || 'Preview unavailable';
                    corner = document.createElement('button');
                    corner.type = 'button';
                    corner.title = 'Retry stitched sheet preview';
                    corner.setAttribute('aria-label', corner.title);
                    corner.className = 'grid h-6 w-6 place-items-center rounded-lg bg-black/60 text-[11px] text-white/80 backdrop-blur hover:bg-black/80 hover:text-white';
                    corner.textContent = '↻';
                    corner.onclick = () => { void refreshIngredientSheetPreview({ force: true }); };
                } else {
                    media = document.createElement('div');
                    media.className = 'h-full w-full animate-pulse bg-white/[0.04]';
                    media.setAttribute('role', 'status');
                    media.setAttribute('aria-label', 'Composing stitched ingredient sheet');
                }
                grid.appendChild(createSheetCard({
                    sheetId: 'stitched',
                    label: 'Stitched sheet',
                    detail,
                    media,
                    corner,
                }));
            }

            sharedIngredientSheets.forEach((sheet, index) => {
                const media = document.createElement('img');
                media.src = sheet.url;
                media.alt = `Uploaded ingredients sheet ${index + 1}`;
                media.className = 'h-24 w-full bg-black object-contain';
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.title = `Remove uploaded ingredients sheet ${index + 1}`;
                remove.setAttribute('aria-label', remove.title);
                remove.className = 'grid h-6 w-6 place-items-center rounded-lg bg-black/60 text-sm text-red-300 backdrop-blur hover:bg-black/80 hover:text-red-200';
                remove.textContent = '×';
                remove.onclick = () => removeIngredientSheet(sheet.url);
                grid.appendChild(createSheetCard({
                    sheetId: sheet.url,
                    label: `Uploaded sheet ${index + 1}`,
                    detail: 'Used as-is, no stitching',
                    media,
                    corner: remove,
                }));
            });
            sheets.appendChild(grid);

            const selectedSheet = selectedUploadedIngredientSheet();
            if (selectedSheet) {
                const description = document.createElement('input');
                description.type = 'text';
                description.maxLength = 1000;
                description.value = selectedSheet.description || '';
                description.placeholder = 'Describe every panel in this sheet (optional)';
                description.setAttribute('aria-label', 'Description for the selected ingredients sheet');
                description.className = 'mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[10px] text-white outline-none placeholder:text-white/25 focus:border-primary/50';
                description.oninput = () => {
                    sharedIngredientSheets = sharedIngredientSheets.map((sheet) => (
                        sheet.url === selectedSheet.url ? { ...sheet, description: description.value } : sheet
                    ));
                    persistVideoPreferences();
                };
                sheets.appendChild(description);
            }
            section.appendChild(sheets);
        }

        if (selection.length) {
            const listHeader = document.createElement('div');
            listHeader.className = 'mt-3 flex items-center justify-between gap-2';
            listHeader.innerHTML = '<span class="text-[10px] font-bold text-white/70">Reference views</span><span class="text-[9px] text-muted">Stitched into the sheet above</span>';
            section.appendChild(listHeader);
            const list = document.createElement('div');
            list.className = 'mt-2 flex flex-col gap-2';
            selection.forEach((item, index) => {
                const row = document.createElement('div');
                row.className = 'grid grid-cols-[56px_minmax(0,1fr)_30px] items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-2';
                const preview = document.createElement('img');
                preview.src = item.url;
                preview.alt = `Ingredient reference ${index + 1}`;
                preview.className = 'h-14 w-14 rounded-lg bg-black object-contain';
                row.appendChild(preview);
                const description = document.createElement('input');
                description.type = 'text';
                description.maxLength = 1000;
                description.value = item.description || '';
                description.placeholder = `View ${index + 1}: front, profile, full body…`;
                description.setAttribute('aria-label', `Description for ingredient reference ${index + 1}`);
                description.className = 'min-w-0 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[10px] text-white outline-none placeholder:text-white/25 focus:border-primary/50';
                description.oninput = () => {
                    const updated = currentIngredientSelection().map((entry, entryIndex) => (
                        entryIndex === index ? { ...entry, description: description.value } : entry
                    ));
                    setCurrentIngredientSelection(updated);
                };
                row.appendChild(description);
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.title = `Remove ingredient reference ${index + 1}`;
                remove.setAttribute('aria-label', remove.title);
                remove.className = 'grid h-[30px] w-[30px] place-items-center rounded-lg bg-red-500/10 text-lg text-red-300 hover:bg-red-500/20';
                remove.textContent = '×';
                remove.onclick = () => {
                    setCurrentIngredientSelection(currentIngredientSelection().filter((_, entryIndex) => entryIndex !== index));
                    void deleteHivemindStudioUpload(item.url).catch(() => {});
                    showDropdown('advanced', advancedBtn);
                };
                row.appendChild(remove);
                list.appendChild(row);
            });
            section.appendChild(list);
        }
        dropdown.appendChild(section);
    };

    const currentVideoLoraModel = () => {
        const model = getCurrentModel();
        return model?.provider === 'hivemind-media-studio' && model.supportsLoras ? model : null;
    };
    const currentVideoLoraSelection = () => videoLoraSelectionsByModel.get(currentVideoLoraModel()?.workflowId) || [];
    const setCurrentVideoLoraSelection = (selection) => {
        const model = currentVideoLoraModel();
        if (!model) return;
        videoLoraSelectionsByModel.set(model.workflowId, selection);
        persistVideoPreferences();
    };
    const createVideoLoraPreview = (lora, className) => {
        const media = document.createElement('div');
        media.className = `${className} bg-white/5 overflow-hidden flex items-center justify-center text-[10px] font-black text-white/30`;
        const fallback = document.createElement('span');
        fallback.textContent = 'LoRA';
        media.appendChild(fallback);
        if (lora.previewUrl) {
            const image = document.createElement('img');
            image.src = lora.previewUrl;
            image.alt = `${lora.displayName || lora.name} preview`;
            image.loading = 'lazy';
            image.className = 'w-full h-full object-cover';
            image.onload = () => fallback.classList.add('hidden');
            image.onerror = () => image.remove();
            media.appendChild(image);
        }
        return media;
    };

    const renderVideoLoraSection = () => {
        const model = currentVideoLoraModel();
        if (!model) return;
        const section = document.createElement('section');
        section.dataset.videoLoraSection = '';
        section.className = 'mt-2 border-t border-white/5 px-2 pt-3';

        const header = document.createElement('div');
        header.className = 'flex flex-wrap items-center justify-between gap-2';
        const heading = document.createElement('div');
        heading.className = 'min-w-0';
        const title = document.createElement('div');
        title.className = 'text-[10px] font-bold uppercase tracking-widest text-secondary';
        title.textContent = 'LoRAs';
        const bases = document.createElement('div');
        bases.className = 'mt-1 truncate text-[10px] text-muted';
        bases.textContent = model.compatibleBaseModels?.join(', ') || model.name;
        heading.append(title, bases);
        header.appendChild(heading);

        const actions = document.createElement('div');
        actions.className = 'flex items-center gap-2';
        const download = document.createElement('button');
        download.type = 'button';
        download.title = 'Download LoRA from Civitai';
        download.className = 'inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1.5 text-[10px] font-bold text-secondary transition-colors hover:bg-white/10 hover:text-white';
        download.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg><span>Download LoRA</span>';
        download.onclick = () => videoCivitaiDownloadDialog.open();
        actions.appendChild(download);
        const selection = currentVideoLoraSelection();
        if (selection.length) {
            const clear = document.createElement('button');
            clear.type = 'button';
            clear.title = 'Unload all LoRAs';
            clear.className = 'rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[10px] font-bold text-red-300 hover:bg-red-500/20';
            clear.textContent = 'Unload all';
            clear.onclick = () => {
                setCurrentVideoLoraSelection([]);
                showDropdown('advanced', advancedBtn);
            };
            actions.appendChild(clear);
        }
        header.appendChild(actions);
        section.appendChild(header);

        if (selection.length) {
            const selectedList = document.createElement('div');
            selectedList.className = 'mt-3 flex flex-col gap-2';
            selection.forEach((lora) => {
                const row = document.createElement('div');
                row.className = 'grid grid-cols-[36px_minmax(0,1fr)_68px_30px] items-center gap-2 rounded-xl border border-primary/20 bg-primary/[0.06] p-2';
                row.appendChild(createVideoLoraPreview(lora, 'h-9 w-9 rounded-lg'));
                const name = document.createElement('div');
                name.className = 'min-w-0 truncate text-[11px] font-bold text-white';
                name.textContent = lora.displayName || lora.name;
                row.appendChild(name);
                const weight = document.createElement('input');
                weight.type = 'number';
                weight.min = '-10';
                weight.max = '10';
                weight.step = '0.05';
                weight.value = String(lora.strength ?? 1);
                weight.setAttribute('aria-label', `Weight for ${lora.displayName || lora.name}`);
                weight.className = 'w-full rounded-lg border border-white/10 bg-black/20 px-1.5 py-1.5 text-center text-[10px] font-bold text-white outline-none focus:border-primary/50';
                weight.oninput = () => setCurrentVideoLoraSelection(updateLoraStrength(currentVideoLoraSelection(), lora.id, weight.value));
                row.appendChild(weight);
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.title = `Unload ${lora.displayName || lora.name}`;
                remove.setAttribute('aria-label', remove.title);
                remove.className = 'grid h-[30px] w-[30px] place-items-center rounded-lg bg-red-500/10 text-lg text-red-300 hover:bg-red-500/20';
                remove.textContent = '×';
                remove.onclick = () => {
                    setCurrentVideoLoraSelection(currentVideoLoraSelection().filter((item) => item.id !== lora.id));
                    showDropdown('advanced', advancedBtn);
                };
                row.appendChild(remove);
                selectedList.appendChild(row);
            });
            section.appendChild(selectedList);
        }

        const status = document.createElement('div');
        status.className = 'mt-3 rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2.5 text-[10px] text-muted';
        status.textContent = videoLoraCatalogMessage || 'Loading compatible LoRAs…';
        section.appendChild(status);

        if (availableVideoLoras.length) {
            const selectedIds = new Set(selection.map((item) => item.id));
            const grid = document.createElement('div');
            grid.className = 'mt-3 grid grid-cols-2 gap-2';
            availableVideoLoras.forEach((lora) => {
                const selected = selectedIds.has(lora.id);
                const card = document.createElement('button');
                card.type = 'button';
                card.setAttribute('aria-pressed', String(selected));
                card.title = selected ? `Unload ${lora.displayName}` : `Use ${lora.displayName}`;
                card.className = `relative min-w-0 overflow-hidden rounded-xl border text-left transition-colors ${selected ? 'border-primary bg-primary/10' : 'border-white/10 bg-white/[0.03] hover:border-white/25'}`;
                card.appendChild(createVideoLoraPreview(lora, 'w-full aspect-[4/3]'));
                const label = document.createElement('div');
                label.className = 'truncate px-2 py-2 text-[10px] font-bold text-white';
                label.textContent = lora.displayName || lora.name;
                card.appendChild(label);
                const marker = document.createElement('span');
                marker.className = `absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full border text-xs font-black backdrop-blur ${selected ? 'border-primary bg-primary text-black' : 'border-white/15 bg-black/60 text-white'}`;
                marker.textContent = selected ? '✓' : '+';
                card.appendChild(marker);
                card.onclick = () => {
                    setCurrentVideoLoraSelection(toggleLoraSelection(currentVideoLoraSelection(), lora));
                    showDropdown('advanced', advancedBtn);
                };
                grid.appendChild(card);
            });
            section.appendChild(grid);
        }
        dropdown.appendChild(section);
    };

    const loadLorasForCurrentVideoModel = async () => {
        const model = currentVideoLoraModel();
        const request = ++videoLoraCatalogRequest;
        availableVideoLoras = [];
        if (!model) {
            videoLoraCatalogModelId = '';
            videoLoraCatalogStatus = 'unavailable';
            videoLoraCatalogMessage = '';
            return;
        }
        videoLoraCatalogModelId = model.workflowId;
        videoLoraCatalogStatus = 'loading';
        videoLoraCatalogMessage = `Loading LoRAs for ${model.name}…`;
        if (dropdownOpen === 'advanced') showDropdown('advanced', advancedBtn);
        try {
            const data = await localAI.listLoras(model.workflowId);
            if (request !== videoLoraCatalogRequest || model.workflowId !== currentVideoLoraModel()?.workflowId) return;
            availableVideoLoras = Array.isArray(data?.loras) ? data.loras : [];
            videoLoraCatalogStatus = data?.supported === false ? 'unsupported' : 'ready';
            videoLoraCatalogMessage = data?.supported === false
                ? 'This workflow does not expose an add-on LoRA path.'
                : availableVideoLoras.length
                    ? `${availableVideoLoras.length} compatible LoRA${availableVideoLoras.length === 1 ? '' : 's'} installed.`
                    : 'No compatible LoRAs are installed for this workflow.';
        } catch (error) {
            if (request !== videoLoraCatalogRequest) return;
            videoLoraCatalogStatus = 'error';
            videoLoraCatalogMessage = `Unable to load LoRAs: ${error.message}`;
        }
        if (dropdownOpen === 'advanced') showDropdown('advanced', advancedBtn);
    };
    const videoCivitaiDownloadDialog = createCivitaiDownloadDialog({
        api: localAI,
        onComplete: () => loadLorasForCurrentVideoModel(),
    });

    const showDropdown = (type, anchorBtn) => {
        dropdown.innerHTML = '';
        dropdown.classList.remove('max-w-xs', 'max-w-sm', 'max-w-[240px]', 'max-w-[200px]');
        dropdown.classList.remove('max-h-[70vh]', 'overflow-y-auto', 'custom-scrollbar');
        dropdown.classList.remove('opacity-0', 'pointer-events-none');
        dropdown.classList.add('opacity-100', 'pointer-events-auto');

        if (type === 'model') {
            dropdown.classList.add('w-[calc(100vw-3rem)]', 'max-w-xs');
            dropdown.classList.remove('max-w-[240px]', 'max-w-[200px]');
            dropdown.innerHTML = `
                <div class="flex flex-col min-h-0 max-h-[70vh]">
                    <div class="px-2 pb-3 mb-2 border-b border-white/5 shrink-0">
                        <div class="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-2.5 border border-white/5 focus-within:border-primary/50 transition-colors">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="text-muted"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                            <input type="text" id="v-model-search" placeholder="${t('common.searchModels')}" class="bg-transparent border-none text-xs text-white focus:ring-0 w-full p-0">
                        </div>
                    </div>
                    <div class="text-[10px] font-bold text-secondary uppercase tracking-widest px-3 py-2 shrink-0">Video models</div>
                    <div id="v-model-list-container" class="flex flex-col gap-1.5 overflow-y-auto custom-scrollbar pr-1 pb-2"></div>
                </div>
            `;
            const list = dropdown.querySelector('#v-model-list-container');

            const makeModelItem = (m, isV2V = false) => {
                const item = document.createElement('div');
                item.className = `flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all border border-transparent hover:border-white/5 ${selectedModel === m.id ? 'bg-white/5 border-white/5' : ''}`;
                const isHive = isHivemindVideoModelId(m.id);
                const isWan = isWan2gpModelId(m.id);
                const iconColor = isV2V ? 'bg-orange-500/10 text-orange-400' : isHive ? 'bg-emerald-500/10 text-emerald-300' : m.id.includes('kling') ? 'bg-blue-500/10 text-blue-400' : m.id.includes('veo') ? 'bg-purple-500/10 text-purple-400' : m.id.includes('sora') ? 'bg-rose-500/10 text-rose-400' : 'bg-primary/10 text-primary';
                item.innerHTML = `
                    <div class="flex items-center gap-3.5">
                         <div class="w-10 h-10 ${iconColor} border border-white/5 rounded-xl flex items-center justify-center font-black text-sm shadow-inner uppercase">${m.name.charAt(0)}</div>
                         <div class="flex flex-col gap-0.5">
                            <span class="text-xs font-bold text-white tracking-tight">${m.name}</span>
                            ${isV2V ? `<span class="text-[9px] text-orange-400/70">${m.imageField ? 'Upload a video and image' : 'Upload a video to use'}</span>` : ''}
                            ${isHive ? '<span class="text-[9px] text-emerald-300/75">Hivemind local workflow</span>' : ''}
                            ${isWan ? '<span class="text-[9px] text-primary/75">Wan2GP local server</span>' : ''}
                         </div>
                    </div>
                    ${selectedModel === m.id ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                `;
                item.onclick = (e) => {
                    e.stopPropagation();
                    if (isV2V) {
                        // Switch to v2v mode
                        v2vMode = true;
                        imageMode = false;
                        const isMC = !!m.imageField;
                        if (!isMC) {
                            // Single-input v2v (watermark remover etc.) — drop any image
                            picker.reset();
                            uploadedImageUrl = null;
                        }
                        selectedModel = m.id;
                        selectedModelName = m.name;
                        document.getElementById('v-model-btn-label').textContent = selectedModelName;
                        updateControlsForModel(selectedModel);
                        persistVideoPreferences();
                        if (isMC) {
                            textarea.placeholder = m.promptRequired
                                ? 'Upload a reference video and image, then describe the motion'
                                : 'Upload a reference video and image, then describe the motion (optional)';
                            textarea.disabled = false;
                        } else {
                            textarea.placeholder = 'Upload a video using the 🎥 button, then click Generate';
                            textarea.disabled = true;
                        }
                    } else {
                        if (isHive && selectHivemindWorkflowModel(m.id)) {
                            closeDropdown();
                            return;
                        }
                        // Leaving v2v mode if was in it
                        if (v2vMode) {
                            v2vMode = false;
                            uploadedVideoUrl = null;
                            showVideoIcon();
                            textarea.disabled = false;
                        }
                        selectedModel = m.id;
                        selectedModelName = m.name;
                        document.getElementById('v-model-btn-label').textContent = selectedModelName;
                        updateControlsForModel(selectedModel);
                        persistVideoPreferences();
                        textarea.placeholder = imageMode ? 'Describe the motion or effect (optional)' : 'Describe the video you want to create';
                    }
                    closeDropdown();
                };
                return item;
            };

            const renderModels = (filter = '') => {
                list.innerHTML = '';
                const lf = filter.toLowerCase();

                // Regular generation models (always t2v or i2v, never v2v). When the Local/API
                // toggle is present, filter to just the chosen source.
                const generationModels = (imageMode ? allI2V : [...hivemindI2V, ...allT2V])
                    .filter(m => !videoSourceToggleBtn || isLocalVideoModel(m.id) === videoLocalMode);
                const filteredMain = generationModels
                    .filter(m => m.name.toLowerCase().includes(lf) || m.id.toLowerCase().includes(lf));
                filteredMain.forEach(m => list.appendChild(makeModelItem(m, false)));

                // Video Tools section (remote-only) — hidden while filtering to Local sources.
                const filteredV2V = (videoSourceToggleBtn && videoLocalMode)
                    ? []
                    : v2vModels.filter(m => m.name.toLowerCase().includes(lf) || m.id.toLowerCase().includes(lf));
                if (filteredV2V.length > 0) {
                    const sectionLabel = document.createElement('div');
                    sectionLabel.className = 'text-[10px] font-bold text-orange-400/70 uppercase tracking-widest px-3 py-2 mt-1 border-t border-white/5';
                    sectionLabel.textContent = t('video.videoTools');
                    list.appendChild(sectionLabel);
                    filteredV2V.forEach(m => list.appendChild(makeModelItem(m, true)));
                }
                if (!list.childElementCount) {
                    const empty = document.createElement('div');
                    empty.className = 'rounded-xl border border-white/5 bg-white/[0.03] px-3 py-4 text-center text-[10px] text-muted';
                    empty.textContent = videoLocalMode
                        ? 'No local video workflows are available yet. Studio will refresh them automatically.'
                        : 'No API video models match this search.';
                    list.appendChild(empty);
                }
            };

            renderModels();
            const searchInput = dropdown.querySelector('#v-model-search');
            searchInput.onclick = (e) => e.stopPropagation();
            searchInput.oninput = (e) => renderModels(e.target.value);

        } else if (type === 'ar') {
            dropdown.classList.add('max-w-[240px]');
            dropdown.innerHTML = `<div class="text-[10px] font-bold text-muted uppercase tracking-widest px-3 py-2 border-b border-white/5 mb-2">Aspect Ratio</div>`;
            const list = document.createElement('div');
            list.className = 'flex flex-col gap-1';
            const availableArs = getCurrentAspectRatios(selectedModel);
            availableArs.forEach(r => {
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all group';
                item.innerHTML = `
                    <div class="flex items-center gap-4">
                        <div class="w-6 h-6 border-2 border-white/20 rounded-md shadow-inner flex items-center justify-center group-hover:border-primary/50 transition-colors">
                             <div class="w-3 h-3 bg-white/10 rounded-sm"></div>
                        </div>
                        <span class="text-xs font-bold text-white opacity-80 group-hover:opacity-100 transition-opacity">${r}</span>
                    </div>
                     ${selectedAr === r ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                `;
                item.onclick = (e) => {
                    e.stopPropagation();
                    selectedAr = r;
                    document.getElementById('v-ar-btn-label').textContent = r;
                    persistVideoPreferences();
                    void refreshIngredientSheetPreview({ force: true });
                    closeDropdown();
                };
                list.appendChild(item);
            });
            dropdown.appendChild(list);

        } else if (type === 'duration') {
            dropdown.classList.add('max-w-[200px]');
            dropdown.innerHTML = `<div class="text-[10px] font-bold text-secondary uppercase tracking-widest px-3 py-2 border-b border-white/5 mb-2">Duration</div>`;
            const list = document.createElement('div');
            list.className = 'flex flex-col gap-1';
            const durations = getCurrentDurations(selectedModel);
            durations.forEach(d => {
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all group';
                item.innerHTML = `
                    <span class="text-xs font-bold text-white opacity-80 group-hover:opacity-100">${d}s</span>
                     ${selectedDuration === d ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                `;
                item.onclick = (e) => {
                    e.stopPropagation();
                    selectedDuration = d;
                    document.getElementById('v-duration-btn-label').textContent = `${d}s`;
                    persistVideoPreferences();
                    closeDropdown();
                };
                list.appendChild(item);
            });
            dropdown.appendChild(list);

        } else if (type === 'quality') {
            dropdown.classList.add('max-w-[200px]');
            dropdown.innerHTML = `<div class="text-[10px] font-bold text-secondary uppercase tracking-widest px-3 py-2 border-b border-white/5 mb-2">Quality</div>`;
            const list = document.createElement('div');
            list.className = 'flex flex-col gap-1';
            getQualitiesForModel(selectedModel).forEach(q => {
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all group';
                item.innerHTML = `
                    <span class="text-xs font-bold text-white opacity-80 group-hover:opacity-100 capitalize">${q}</span>
                    ${selectedQuality === q ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                `;
                item.onclick = (e) => {
                    e.stopPropagation();
                    selectedQuality = q;
                    document.getElementById('v-quality-btn-label').textContent = q;
                    persistVideoPreferences();
                    closeDropdown();
                };
                list.appendChild(item);
            });
            dropdown.appendChild(list);

        } else if (type === 'resolution') {
            dropdown.classList.add('max-w-[200px]');
            dropdown.innerHTML = `<div class="text-[10px] font-bold text-secondary uppercase tracking-widest px-3 py-2 border-b border-white/5 mb-2">Resolution</div>`;
            const list = document.createElement('div');
            list.className = 'flex flex-col gap-1';
            const resolutions = getCurrentResolutions(selectedModel);
            resolutions.forEach(r => {
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all group';
                item.innerHTML = `
                    <span class="text-xs font-bold text-white opacity-80 group-hover:opacity-100">${r}</span>
                     ${selectedResolution === r ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                `;
                item.onclick = (e) => {
                    e.stopPropagation();
                    selectedResolution = r;
                    document.getElementById('v-resolution-btn-label').textContent = r;
                    persistVideoPreferences();
                    closeDropdown();
                };
                list.appendChild(item);
            });
            dropdown.appendChild(list);

        } else if (type === 'mode') {
            dropdown.classList.add('max-w-[200px]');
            dropdown.innerHTML = `<div class="text-[10px] font-bold text-secondary uppercase tracking-widest px-3 py-2 border-b border-white/5 mb-2">Mode</div>`;
            const list = document.createElement('div');
            list.className = 'flex flex-col gap-1';
            getCurrentModes(selectedModel).forEach(m => {
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all group';
                item.innerHTML = `
                    <span class="text-xs font-bold text-white opacity-80 group-hover:opacity-100 capitalize">${m}</span>
                    ${selectedMode === m ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                `;
                item.onclick = (e) => {
                    e.stopPropagation();
                    selectedMode = m;
                    document.getElementById('v-mode-btn-label').textContent = m;
                    persistVideoPreferences();
                    closeDropdown();
                };
                list.appendChild(item);
            });
            dropdown.appendChild(list);

        } else if (type === 'effect') {
            dropdown.classList.add('max-w-[240px]');
            dropdown.classList.remove('max-w-[200px]');
            dropdown.innerHTML = `<div class="text-[10px] font-bold text-secondary uppercase tracking-widest px-3 py-2 border-b border-white/5 mb-2">Effect Type</div>`;
            const list = document.createElement('div');
            list.className = 'flex flex-col gap-1 max-h-[50vh] overflow-y-auto custom-scrollbar';
            getEffectNamesForModel(selectedModel).forEach(e => {
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between p-3 hover:bg-white/5 rounded-2xl cursor-pointer transition-all group';
                item.innerHTML = `
                    <span class="text-xs font-bold text-white opacity-80 group-hover:opacity-100">${e}</span>
                    ${selectedEffectName === e ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                `;
                item.onclick = (ev) => {
                    ev.stopPropagation();
                    selectedEffectName = e;
                    document.getElementById('v-effect-btn-label').textContent = e;
                    persistVideoPreferences();
                    closeDropdown();
                };
                list.appendChild(item);
            });
            dropdown.appendChild(list);
        } else if (type === 'advanced') {
            dropdown.classList.add('max-w-sm');
            dropdown.classList.remove('max-w-[240px]', 'max-w-[200px]');
            dropdown.classList.add('max-h-[70vh]', 'overflow-y-auto', 'custom-scrollbar');

            const header = document.createElement('div');
            header.className = 'flex items-center justify-between px-2 py-2 border-b border-white/5 mb-2';
            const title = document.createElement('span');
            title.className = 'text-[10px] font-bold text-secondary uppercase tracking-widest';
            title.textContent = 'Advanced video settings';
            header.appendChild(title);
            dropdown.appendChild(header);

            pingToggleLabel.className = 'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 cursor-pointer select-none hover:bg-white/5';
            dropdown.appendChild(pingToggleLabel);

            const inputs = getAdvancedVideoInputs(getCurrentModel());
            if (inputs.length > 0) {
                const divider = document.createElement('div');
                divider.className = 'mx-2 my-1 border-t border-white/5';
                dropdown.appendChild(divider);
            }

            inputs.forEach((input) => {
                const row = document.createElement('label');
                row.className = 'flex w-full items-center justify-between gap-4 rounded-xl px-3 py-2.5 hover:bg-white/5';
                if (input.description) row.title = input.description;

                const label = document.createElement('span');
                label.className = 'min-w-0 text-xs font-bold text-white/80';
                label.textContent = input.title || input.name;
                row.appendChild(label);

                let control;
                if (input.type === 'boolean') {
                    control = document.createElement('input');
                    control.type = 'checkbox';
                    control.checked = Boolean(advancedValues[input.name]);
                    control.className = 'h-4 w-4 shrink-0 accent-primary';
                    control.onchange = () => {
                        advancedValues[input.name] = control.checked;
                        persistVideoPreferences();
                    };
                } else if (Array.isArray(input.enum) && input.enum.length > 0) {
                    control = document.createElement('select');
                    control.className = 'max-w-[150px] rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs font-bold text-white outline-none focus:border-primary/50';
                    input.enum.forEach((value) => {
                        const option = document.createElement('option');
                        option.value = String(value);
                        option.textContent = String(value).replaceAll('_', ' ');
                        option.selected = value === advancedValues[input.name];
                        control.appendChild(option);
                    });
                    control.onchange = () => {
                        const match = input.enum.find((value) => String(value) === control.value);
                        advancedValues[input.name] = match ?? control.value;
                        persistVideoPreferences();
                    };
                } else {
                    control = document.createElement('input');
                    const numeric = ['int', 'float', 'number'].includes(input.type);
                    control.type = numeric ? 'number' : 'text';
                    control.value = String(advancedValues[input.name] ?? '');
                    if (numeric) {
                        if (input.minValue != null) control.min = String(input.minValue);
                        if (input.maxValue != null) control.max = String(input.maxValue);
                        control.step = String(input.step ?? (input.type === 'int' ? 1 : 'any'));
                    }
                    control.className = 'w-28 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs font-bold text-white outline-none focus:border-primary/50';
                    control.oninput = () => {
                        advancedValues[input.name] = numeric && control.value !== '' ? Number(control.value) : control.value;
                        persistVideoPreferences();
                    };
                }
                control.dataset.videoAdvancedInput = input.name;
                row.appendChild(control);
                dropdown.appendChild(row);
            });
            renderIngredientReferenceSection();
            renderVideoLoraSection();
            const loraModel = currentVideoLoraModel();
            if (loraModel && (videoLoraCatalogModelId !== loraModel.workflowId || videoLoraCatalogStatus === 'idle')) {
                void loadLorasForCurrentVideoModel();
            }
        }

        // Position dropdown
        const btnRect = anchorBtn.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const dropdownWidth = dropdown.offsetWidth || Math.min(384, Math.max(0, window.innerWidth - 48));
        const preferredViewportLeft = window.innerWidth < 768
            ? (window.innerWidth - dropdownWidth) / 2
            : btnRect.left;
        const viewportLeft = clampVideoDropdownViewportLeft(
            preferredViewportLeft,
            dropdownWidth,
            window.innerWidth,
        );
        dropdown.style.left = `${viewportLeft - containerRect.left}px`;
        dropdown.style.transform = 'translate(0, 8px)';
        dropdown.style.bottom = `${containerRect.bottom - btnRect.top + 8}px`;
        // The panel grows upward, so cap it to the space between the studio
        // area's top edge (below the app header) and the anchor, and scroll
        // the body instead of letting long lists overflow the viewport.
        dropdown.style.maxHeight = `${clampVideoDropdownMaxHeight(btnRect.top - Math.max(0, containerRect.top))}px`;
        if (type !== 'model') dropdown.classList.add('overflow-y-auto', 'custom-scrollbar');
        advancedBtn.setAttribute('aria-expanded', String(type === 'advanced'));
    };

    const closeDropdown = () => {
        dropdown.classList.add('opacity-0', 'pointer-events-none');
        dropdown.classList.remove('opacity-100', 'pointer-events-auto');
        dropdownOpen = null;
        advancedBtn.setAttribute('aria-expanded', 'false');
    };

    const toggleDropdown = (type, btn) => (e) => {
        e.stopPropagation();
        if (dropdownOpen === type) closeDropdown();
        else { dropdownOpen = type; showDropdown(type, btn); }
    };

    modelBtn.onclick = toggleDropdown('model', modelBtn);
    arBtn.onclick = toggleDropdown('ar', arBtn);
    durationBtn.onclick = toggleDropdown('duration', durationBtn);
    resolutionBtn.onclick = toggleDropdown('resolution', resolutionBtn);
    qualityBtn.onclick = toggleDropdown('quality', qualityBtn);
    modeBtn.onclick = toggleDropdown('mode', modeBtn);
    effectNameBtn.onclick = toggleDropdown('effect', effectNameBtn);
    advancedBtn.onclick = toggleDropdown('advanced', advancedBtn);
    ingredientsBtn.onclick = (event) => {
        event.stopPropagation();
        const workflow = getIngredientsWorkflow();
        if (!workflow) return;
        if (selectedModel === workflow.id && dropdownOpen === 'advanced') {
            closeDropdown();
            return;
        }
        if (!selectHivemindWorkflowModel(workflow.id)) return;
        updateIngredientsShortcut();
        dropdownOpen = 'advanced';
        showDropdown('advanced', advancedBtn);
    };

    window.addEventListener('click', closeDropdown);
    container.appendChild(dropdown);

    // ==========================================
    // 4. CANVAS AREA + HISTORY
    // ==========================================
    const generationHistory = [];

    const historySidebar = document.createElement('div');
    historySidebar.className = 'fixed right-0 top-[100px] h-[calc(100%-100px)] lg:top-14 lg:h-[calc(100%-3.5rem)] w-20 md:w-24 bg-panel-bg/75 backdrop-blur-xl border-l border-white/[0.06] z-40 flex flex-col items-center py-4 gap-3 overflow-y-auto transition-all duration-500 translate-x-full opacity-0';
    historySidebar.id = 'video-history-sidebar';

    const historyLabel = document.createElement('div');
    historyLabel.className = 'text-[9px] font-bold text-muted uppercase tracking-widest mb-2';
    historyLabel.textContent = t('video.history');
    historySidebar.appendChild(historyLabel);

    const historyList = document.createElement('div');
    historyList.className = 'flex flex-col gap-2 w-full px-2';
    historySidebar.appendChild(historyList);
    container.appendChild(historySidebar);

    // Main canvas
    const canvas = document.createElement('div');
    canvas.className = 'absolute inset-0 flex flex-col items-center justify-center p-4 min-[800px]:p-16 z-10 opacity-0 pointer-events-none transition-all duration-1000 translate-y-10 scale-95';

    const videoContainer = document.createElement('div');
    videoContainer.className = 'relative group';

    const resultVideo = document.createElement('video');
    resultVideo.className = 'max-h-[60vh] max-w-[80vw] rounded-3xl shadow-3xl border border-white/10 interactive-glow object-contain';
    resultVideo.controls = true;
    resultVideo.loop = true;
    resultVideo.autoplay = true;
    resultVideo.muted = true;
    resultVideo.playsInline = true;
    videoContainer.appendChild(resultVideo);

    // Plain close: back to the prompt bar exactly as the user left it — no
    // context restore, no clearing. "Back to setup"/"+ New" stay the explicit
    // state-changing exits.
    const closeCanvasBtn = document.createElement('button');
    closeCanvasBtn.type = 'button';
    closeCanvasBtn.title = 'Close';
    closeCanvasBtn.setAttribute('aria-label', 'Close expanded video');
    closeCanvasBtn.className = 'absolute -right-3 -top-3 z-20 grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-black/70 text-lg text-white/80 shadow-xl backdrop-blur transition-colors hover:bg-black/90 hover:text-white';
    closeCanvasBtn.textContent = '×';
    videoContainer.appendChild(closeCanvasBtn);

    // Canvas Controls
    const canvasControls = document.createElement('div');
    canvasControls.className = 'mt-6 flex flex-wrap gap-2.5 opacity-0 transition-opacity delay-500 duration-500 justify-center';

    const backToSetupBtn = document.createElement('button');
    backToSetupBtn.className = 'bg-white/10 hover:bg-white/20 px-4 py-2.5 rounded-xl text-xs font-bold transition-all border border-white/5 backdrop-blur-lg text-white flex items-center gap-2';
    backToSetupBtn.title = t('video.backToSetup');
    backToSetupBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg><span>${t('video.backToSetup')}</span>`;

    const regenerateBtn = document.createElement('button');
    regenerateBtn.className = 'bg-white/10 hover:bg-white/20 px-4 py-2.5 rounded-xl text-xs font-bold transition-all border border-white/5 backdrop-blur-lg text-white';
    regenerateBtn.textContent = t('video.regenerate');

    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'bg-primary text-black px-6 py-2.5 rounded-2xl text-xs font-bold transition-all shadow-glow active:scale-95';
    downloadBtn.textContent = t('video.download');

    const extendBtn = document.createElement('button');
    extendBtn.className = 'hidden bg-white/10 hover:bg-white/20 px-6 py-2.5 rounded-2xl text-xs font-bold transition-all border border-primary/30 text-primary backdrop-blur-lg';
    extendBtn.textContent = t('video.extend');
    extendBtn.title = 'Extend this video using Seedance 2.0 Extend';

    const newPromptBtn = document.createElement('button');
    newPromptBtn.className = 'bg-white/10 hover:bg-white/20 px-6 py-2.5 rounded-2xl text-xs font-bold transition-all border border-white/5 backdrop-blur-lg text-white';
    newPromptBtn.textContent = t('video.new');

    canvasControls.appendChild(backToSetupBtn);
    canvasControls.appendChild(regenerateBtn);
    canvasControls.appendChild(extendBtn);
    canvasControls.appendChild(downloadBtn);
    canvasControls.appendChild(newPromptBtn);

    canvas.appendChild(videoContainer);
    canvas.appendChild(canvasControls);
    container.appendChild(canvas);

    closeCanvasBtn.onclick = (event) => {
        event.stopPropagation();
        resetToPromptBar();
        textarea.focus();
    };
    // Clicking the backdrop (not the video or its controls) also closes.
    canvas.addEventListener('click', (event) => {
        if (event.target === canvas) {
            resetToPromptBar();
            textarea.focus();
        }
    });

    let generationProgressTimer = null;
    let generationStartedAt = 0;

    const getCompletionAudioContext = () => {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return null;
        if (!completionAudioContext || completionAudioContext.state === 'closed') {
            completionAudioContext = new AudioContextClass();
        }
        return completionAudioContext;
    };

    const primeCompletionPing = async () => {
        if (!pingWhenComplete) return;
        const audioContext = getCompletionAudioContext();
        if (!audioContext) return;
        try {
            if (audioContext.state !== 'running') await audioContext.resume();
            if (audioContext.state !== 'running') return;
            const oscillator = audioContext.createOscillator();
            const gain = audioContext.createGain();
            gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
            oscillator.connect(gain);
            gain.connect(audioContext.destination);
            oscillator.start();
            oscillator.stop(audioContext.currentTime + 0.01);
        } catch (error) {
            console.warn('[VideoStudio] Completion ping could not be enabled:', error?.message || 'audio unavailable');
        }
    };

    const playCompletionPing = async () => {
        if (!pingWhenComplete) return;
        const audioContext = getCompletionAudioContext();
        if (!audioContext) return;

        try {
            if (audioContext.state !== 'running') await audioContext.resume();
            if (audioContext.state !== 'running') return;
            const start = audioContext.currentTime + 0.02;
            [[659.25, start, 0.2], [880, start + 0.16, 0.34]].forEach(([frequency, noteStart, duration]) => {
                const oscillator = audioContext.createOscillator();
                const gain = audioContext.createGain();
                oscillator.type = 'triangle';
                oscillator.frequency.setValueAtTime(frequency, noteStart);
                gain.gain.setValueAtTime(0.0001, noteStart);
                gain.gain.linearRampToValueAtTime(0.2, noteStart + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + duration);
                oscillator.connect(gain);
                gain.connect(audioContext.destination);
                oscillator.start(noteStart);
                oscillator.stop(noteStart + duration + 0.02);
            });
        } catch (error) {
            console.warn('[VideoStudio] Completion ping could not play:', error?.message || 'audio unavailable');
        }
    };

    pingToggleInput.onchange = () => {
        pingWhenComplete = Boolean(pingToggleInput.checked);
        try {
            sessionStorage.setItem(VIDEO_COMPLETION_PING_KEY, pingWhenComplete ? '1' : '0');
        } catch {}
        persistVideoPreferences();
        if (pingWhenComplete) void playCompletionPing();
    };

    const updateGenerationProgress = ({ status = '', progress = null, stage = '' } = {}) => {
        const normalized = normalizeVideoGenerationProgress(progress);
        const stageName = stage || classifyVideoGenerationStage(status);
        const stageLabel = t(`video.progress.${stageName}`);
        generationProgressStatus.textContent = stageLabel;

        if (normalized == null) {
            generationProgressTrack.dataset.progressMode = 'indeterminate';
            generationProgressTrack.removeAttribute('aria-valuenow');
            generationProgressFill.style.removeProperty('width');
            generationProgressValue.textContent = t('video.progress.inProgress');
            return;
        }

        const percent = Math.round(normalized * 100);
        generationProgressTrack.dataset.progressMode = 'determinate';
        generationProgressTrack.setAttribute('aria-valuemin', '0');
        generationProgressTrack.setAttribute('aria-valuemax', '100');
        generationProgressTrack.setAttribute('aria-valuenow', String(percent));
        generationProgressFill.style.width = `${percent}%`;
        generationProgressValue.textContent = `${percent}%`;
    };

    const showGenerationProgress = (context) => {
        generationProgressView.dataset.active = 'true';
        generationProgressView.setAttribute('aria-hidden', 'false');
        generationProgressView.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-4');
        generationProgressView.classList.add('opacity-100', 'translate-y-0');

        generationProgressModel.textContent = context.modelName || context.model;
        const details = [context.aspectRatio];
        if (context.duration) details.push(`${context.duration}s`);
        generationProgressDetail.textContent = details.filter(Boolean).join(' · ');

        if (context.imageUrl) {
            void resolveMediaSrc(context.imageUrl).then((resolved) => { generationProgressPreview.src = resolved; });
            generationProgressPreview.classList.remove('hidden');
            generationProgressPlaceholder.classList.add('hidden');
        } else {
            generationProgressPreview.removeAttribute('src');
            generationProgressPreview.classList.add('hidden');
            generationProgressPlaceholder.classList.remove('hidden');
        }

        canvas.classList.add('opacity-0', 'pointer-events-none', 'translate-y-10', 'scale-95');
        canvas.classList.remove('opacity-100', 'translate-y-0', 'scale-100');
        hero.classList.add('hidden', 'opacity-0', 'scale-95', '-translate-y-10', 'pointer-events-none');
        promptWrapper.classList.add('hidden', 'opacity-0', 'pointer-events-none');
        updateGenerationProgress({ stage: 'preparing' });

        if (generationProgressTimer) clearInterval(generationProgressTimer);
        generationStartedAt = Date.now();
        generationProgressElapsed.textContent = '0:00';
        generationProgressTimer = window.setInterval(() => {
            generationProgressElapsed.textContent = formatVideoGenerationElapsed(Date.now() - generationStartedAt);
        }, 1000);
    };

    const hideGenerationProgress = ({ restoreSetup = false } = {}) => {
        generationProgressView.dataset.active = 'false';
        generationProgressView.setAttribute('aria-hidden', 'true');
        generationProgressView.classList.add('opacity-0', 'pointer-events-none', 'translate-y-4');
        generationProgressView.classList.remove('opacity-100', 'translate-y-0');
        if (generationProgressTimer) clearInterval(generationProgressTimer);
        generationProgressTimer = null;
        generationProgressPreview.removeAttribute('src');

        if (restoreSetup) {
            hero.classList.remove('hidden', 'opacity-0', 'scale-95', '-translate-y-10', 'pointer-events-none');
            promptWrapper.classList.remove('hidden', 'opacity-0', 'opacity-40', 'pointer-events-none');
        }
    };

    // --- Helper: Show video in canvas ---
    const showVideoInCanvas = (videoUrl, genModel, generationContext = null) => {
        contextStore.view(generationContext || videoUrl);
        hero.classList.add('hidden');
        promptWrapper.classList.add('hidden');

        // Show extend button only for seedance-v2.0-t2v and i2v (not extend itself)
        const isSeedance2 = genModel && (genModel === 'seedance-v2.0-t2v' || genModel === 'seedance-v2.0-i2v');
        extendBtn.classList.toggle('hidden', !isSeedance2);

        let videoRevealed = false;
        const revealVideo = () => {
            if (videoRevealed) return;
            videoRevealed = true;
            const completedGeneration = generationProgressView.dataset.active === 'true';
            if (completedGeneration) hideGenerationProgress();
            canvas.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-10', 'scale-95');
            canvas.classList.add('opacity-100', 'translate-y-0', 'scale-100');
            canvasControls.classList.remove('opacity-0');
            canvasControls.classList.add('opacity-100');
            if (completedGeneration) void playCompletionPing();
        };
        resultVideo.onloadeddata = revealVideo;
        if (generationProgressView.dataset.active === 'true') {
            updateGenerationProgress({ stage: 'finishing', progress: 1 });
        }
        // E2E-sealed outputs decrypt in-page to a blob URL; everything else
        // passes through untouched (resolveMediaSrc is fail-open).
        void resolveMediaSrc(videoUrl).then((resolved) => {
            resultVideo.src = resolved;
            if (resultVideo.readyState >= 2) queueMicrotask(revealVideo);
        });
    };

    const redactPrivateHistoryEntry = (entry) => (
        isHivemindVideoModelId(entry?.model)
            ? { ...entry, prompt: '', prompt_private: true }
            : entry
    );

    // --- Helper: Add to history ---
    const addToHistory = (entry, generationContext = null) => {
        const safeEntry = redactPrivateHistoryEntry(entry);
        if (generationContext && entry?.url) contextStore.remember(entry.url, generationContext);
        generationHistory.unshift(safeEntry);
        saveStudioGenerationHistory('video_history', generationHistory, 30);
        historySidebar.classList.remove('translate-x-full', 'opacity-0');
        historySidebar.classList.add('translate-x-0', 'opacity-100');
        renderHistory();
    };

    const renderHistory = () => {
        historyList.innerHTML = '';
        generationHistory.forEach((entry, idx) => {
            const thumb = document.createElement('div');
            thumb.className = `relative group/thumb cursor-pointer rounded-xl overflow-hidden border-2 transition-all duration-300 ${idx === 0 ? 'border-primary shadow-glow' : 'border-white/10 hover:border-white/30'}`;

            thumb.innerHTML = `
                <video preload="metadata" muted class="w-full aspect-square object-cover"></video>
                <div class="absolute inset-0 bg-black/60 opacity-0 group-hover/thumb:opacity-100 transition-opacity flex items-center justify-center gap-1">
                    <button class="hist-download p-1.5 bg-primary rounded-lg text-black hover:scale-110 transition-transform" title="Download">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                    </button>
                </div>
            `;
            void resolveMediaSrc(entry.url).then((resolved) => { const v = thumb.querySelector('video'); if (v) v.src = resolved; });

            thumb.onclick = (e) => {
                if (e.target.closest('.hist-download')) {
                    downloadFile(entry.url, `video-${entry.id || idx}.mp4`);
                    return;
                }
                // Restore extend context when viewing a seedance-v2.0 generation
                if (entry.model === 'seedance-v2.0-t2v' || entry.model === 'seedance-v2.0-i2v') {
                    lastGenerationId = entry.id;
                    lastGenerationModel = entry.model;
                } else {
                    lastGenerationId = null;
                    lastGenerationModel = null;
                }
                showVideoInCanvas(entry.url, entry.model);
                historyList.querySelectorAll('div').forEach(t => {
                    t.classList.remove('border-primary', 'shadow-glow');
                    t.classList.add('border-white/10');
                });
                thumb.classList.remove('border-white/10');
                thumb.classList.add('border-primary', 'shadow-glow');
            };

            historyList.appendChild(thumb);
        });
    };

    // --- Helper: Download file ---
    const downloadFile = async (url, filename) => {
        try {
            const response = await fetch(await resolveMediaSrc(url));
            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        } catch (err) {
            window.open(url, '_blank');
        }
    };

    const savedHistory = loadStudioGenerationHistory('video_history');
    if (savedHistory.length > 0) {
        const sanitized = savedHistory.map(redactPrivateHistoryEntry);
        sanitized.forEach(e => generationHistory.push(e));
        saveStudioGenerationHistory('video_history', sanitized, 30);
        historySidebar.classList.remove('translate-x-full', 'opacity-0');
        historySidebar.classList.add('translate-x-0', 'opacity-100');
        renderHistory();
    }

    // --- Resume any pending video generations from a previous session ---
    (async () => {
        const pending = getPendingJobs('video');
        if (!pending.length) return;

        const apiKey = localStorage.getItem('muapi_key');
        if (!apiKey) return; // can't poll without key; jobs remain for next time

        const banner = document.createElement('div');
        banner.className = 'fixed top-4 left-1/2 -translate-x-1/2 z-[200] bg-[#111] border border-white/10 text-white text-sm px-5 py-3 rounded-2xl shadow-xl flex items-center gap-3';
        banner.innerHTML = `<span class="animate-spin text-primary">◌</span> <span class="banner-text">Resuming ${pending.length} pending generation${pending.length > 1 ? 's' : ''}…</span>`;
        document.body.appendChild(banner);

        let remaining = pending.length;
        pending.forEach(async (job) => {
            const elapsedAttempts = Math.floor((Date.now() - job.submittedAt) / job.interval);
            const attemptsLeft = Math.max(1, job.maxAttempts - elapsedAttempts);
            try {
                const result = await muapi.pollForResult(job.requestId, apiKey, attemptsLeft, job.interval);
                const url = result.outputs?.[0] || result.url || result.output?.url;
                if (url) {
                    addToHistory({ id: job.requestId, url, ...job.historyMeta, timestamp: new Date().toISOString() });
                }
            } catch (e) {
                console.warn('[VideoStudio] Pending job failed on resume:', job.requestId, e.message);
            } finally {
                removePendingJob(job.requestId);
                remaining--;
                if (remaining === 0) banner.remove();
                else banner.querySelector('.banner-text').textContent = `Resuming ${remaining} pending generation${remaining > 1 ? 's' : ''}…`;
            }
        });
    })();

    // --- Button Handlers ---
    downloadBtn.onclick = () => {
        const current = resultVideo.src;
        if (current) {
            const entry = generationHistory.find(e => e.url === current);
            downloadFile(current, `video-${entry?.id || 'clip'}.mp4`);
        }
    };

    const captureGenerationContext = (prompt) => ({
        prompt,
        model: selectedModel,
        modelName: selectedModelName,
        aspectRatio: selectedAr,
        duration: selectedDuration,
        resolution: selectedResolution,
        quality: selectedQuality,
        mode: selectedMode,
        effectName: selectedEffectName,
        advancedValues: { ...advancedValues },
        loras: currentVideoLoraSelection().map((lora) => ({ ...lora })),
        ingredientImages: currentIngredientSelection().map((item) => ({ ...item })),
        ingredientSheets: (currentIngredientModel() ? sharedIngredientSheets : []).map((item) => ({ ...item })),
        ingredientSelectedSheet: currentIngredientModel() ? selectedIngredientSheet : '',
        imageMode,
        v2vMode,
        imageUrl: uploadedImageUrl,
        endImageUrl: uploadedEndImageUrl,
        videoUrl: uploadedVideoUrl,
        videoName: uploadedVideoName,
        sourceGenerationId: getCurrentModel()?.requiresRequestId ? lastGenerationId : null,
    });

    const restoreGenerationContext = (context) => {
        if (!context?.model) return false;

        imageMode = Boolean(context.imageMode);
        v2vMode = Boolean(context.v2vMode);
        const model = getCurrentModels().find((entry) => entry.id === context.model);
        if (!model) return false;

        selectedModel = context.model;
        selectedModelName = context.modelName || model.name;
        uploadedImageUrl = context.imageUrl || null;
        uploadedEndImageUrl = context.endImageUrl || null;
        uploadedVideoUrl = context.videoUrl || null;
        uploadedVideoName = context.videoName || null;
        document.getElementById('v-model-btn-label').textContent = selectedModelName;
        updateControlsForModel(selectedModel);
        if (model.workflowId && Array.isArray(context.loras)) {
            videoLoraSelectionsByModel.set(model.workflowId, context.loras.map((lora) => ({ ...lora })));
        }
        if (model.supportsIngredientImages && Array.isArray(context.ingredientImages)) {
            sharedIngredientSelections = normalizeVideoIngredientSelections(context.ingredientImages);
        }
        if (model.supportsIngredientImages) {
            if (Array.isArray(context.ingredientSheets)) {
                sharedIngredientSheets = normalizeVideoIngredientSelections(context.ingredientSheets);
            }
            selectedIngredientSheet = normalizeSelectedVideoIngredientSheet(
                context.ingredientSelectedSheet,
                sharedIngredientSelections,
                sharedIngredientSheets,
            );
            updateIngredientsShortcut();
        }

        selectedAr = context.aspectRatio || selectedAr;
        selectedDuration = context.duration ?? selectedDuration;
        selectedResolution = context.resolution ?? selectedResolution;
        selectedQuality = context.quality ?? selectedQuality;
        selectedMode = context.mode ?? selectedMode;
        selectedEffectName = context.effectName ?? selectedEffectName;
        advancedValues = {
            ...getDefaultAdvancedVideoValues(model),
            ...(context.advancedValues || {}),
        };
        const setLabel = (id, value) => {
            const label = document.getElementById(id);
            if (label && value !== '' && value != null) label.textContent = value;
        };
        setLabel('v-ar-btn-label', selectedAr);
        setLabel('v-duration-btn-label', `${selectedDuration}s`);
        setLabel('v-resolution-btn-label', selectedResolution);
        setLabel('v-quality-btn-label', selectedQuality);
        setLabel('v-mode-btn-label', selectedMode);
        setLabel('v-effect-btn-label', selectedEffectName);

        if (uploadedImageUrl) {
            preserveNextStartFrameAspect = true;
            picker.setImage(uploadedImageUrl);
        }
        else picker.reset();
        if (uploadedEndImageUrl) endPicker.setImage(uploadedEndImageUrl);
        else endPicker.reset();
        if (uploadedVideoUrl) showVideoReady(uploadedVideoName || 'Reference video');
        else showVideoIcon();

        textarea.value = context.prompt || '';
        textarea.disabled = v2vMode && !model.hasPrompt && !model.promptRequired;
        if (v2vMode) {
            textarea.placeholder = model.promptRequired ? 'Describe the motion' : 'Describe the motion (optional)';
        } else if (imageMode) {
            textarea.placeholder = 'Describe the motion or effect (optional)';
        } else {
            textarea.placeholder = 'Describe the video you want to create';
        }
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        if (context.sourceGenerationId) lastGenerationId = context.sourceGenerationId;
        persistVideoPreferences();
        return true;
    };

    const resetToPromptBar = () => {
        hideGenerationProgress();
        resultVideo.pause();
        canvas.classList.add('opacity-0', 'pointer-events-none', 'translate-y-10', 'scale-95');
        canvas.classList.remove('opacity-100', 'translate-y-0', 'scale-100');
        canvasControls.classList.add('opacity-0');
        canvasControls.classList.remove('opacity-100');
        hero.classList.remove('hidden', 'opacity-0', 'scale-95', '-translate-y-10', 'pointer-events-none');
        promptWrapper.classList.remove('hidden', 'opacity-0', 'opacity-40', 'pointer-events-none');
    };

    backToSetupBtn.onclick = () => {
        const viewed = contextStore.getViewed();
        if (viewed) restoreGenerationContext(viewed);
        resetToPromptBar();
        textarea.focus();
    };

    regenerateBtn.onclick = () => {
        const viewed = contextStore.getViewed();
        if (!viewed || !restoreGenerationContext(viewed)) {
            resetToPromptBar();
            textarea.focus();
            return;
        }
        resultVideo.pause();
        generateBtn.click();
    };

    newPromptBtn.onclick = () => {
        resetToPromptBar();
        textarea.value = '';
        picker.reset();
        endPicker.reset();
        uploadedImageUrl = null;
        uploadedEndImageUrl = null;
        imageMode = false;
        uploadedVideoUrl = null;
        uploadedVideoName = null;
        v2vMode = false;
        lastSubmittedContext = null;
        contextStore.clearViewed();
        showVideoIcon();
        selectedModel = allT2V[0].id;
        selectedModelName = allT2V[0].name;
        document.getElementById('v-model-btn-label').textContent = selectedModelName;
        updateControlsForModel(selectedModel);
        persistVideoPreferences();
        textarea.placeholder = 'Describe the video you want to create';
        textarea.disabled = false;
        textarea.focus();
    };

    extendBtn.onclick = () => {
        if (!lastGenerationId) return;
        resetToPromptBar();
        textarea.value = '';
        picker.reset();
        uploadedImageUrl = null;
        imageMode = false;
        selectedModel = 'seedance-v2.0-extend';
        selectedModelName = 'Seedance 2.0 Extend';
        document.getElementById('v-model-btn-label').textContent = selectedModelName;
        updateControlsForModel(selectedModel);
        persistVideoPreferences();
        textarea.placeholder = 'Optional: describe how to continue the video...';
        textarea.focus();
    };

    // ==========================================
    // 5. GENERATION LOGIC
    // ==========================================
    generateBtn.onclick = async () => {
        const prompt = textarea.value.trim();
        const model = getCurrentModel();
        const isExtendMode = model?.requiresRequestId;
        const isWan2gpLocal = isWan2gpModelId(selectedModel);
        const isHivemindLocal = isHivemindVideoModelId(selectedModel);
        const isHivemindVideoInput = isHivemindLocal && Boolean(uploadedVideoUrl);
        const hasIngredientReferences = isHivemindLocal
            && Boolean(model?.supportsIngredientImages)
            && activeIngredientSheetItems().length > 0;

        if (isHivemindVideoInput) {
            if (!model?.supportsVideoInput) {
                alert('This local workflow does not support source-video extension.');
                return;
            }
        } else if (v2vMode) {
            if (!uploadedVideoUrl) {
                alert('Please upload a video first.');
                return;
            }
            if (model?.imageField && !uploadedImageUrl) {
                alert('Please upload a reference image for motion control.');
                return;
            }
            if (model?.promptRequired && !prompt) {
                alert('Please describe the motion you want.');
                return;
            }
        } else if (isExtendMode) {
            if (!lastGenerationId) {
                alert('No Seedance 2.0 generation found to extend. Generate a video first.');
                return;
            }
        } else if (imageMode) {
            if (!uploadedImageUrl && !hasIngredientReferences) {
                alert(model?.supportsIngredientImages
                    ? 'Please add reference views or select an ingredients sheet in Advanced.'
                    : 'Please upload a start frame image first.');
                return;
            }
            if (model?.supportsIngredientImages && !prompt) {
                alert('Please describe the shot to generate from these references.');
                return;
            }
        } else {
            if (!prompt) {
                alert('Please enter a prompt to generate a video.');
                return;
            }
        }

        // The sheet's geometry governs conditioning quality — re-assert the
        // matched aspect at generation time even if a restored session or a
        // later model switch reverted the aspect choice.
        if (hasIngredientReferences && selectedUploadedIngredientSheet()) {
            await matchAspectToIngredientSheet(selectedIngredientSheet);
        }

        const isLocal = isWan2gpLocal || isHivemindLocal;

        // Local Wan2GP generations don't go through Muapi — skip the auth gate.
        if (!isLocal) {
            const apiKey = localStorage.getItem('muapi_key');
            if (!apiKey) {
                AuthModal(() => generateBtn.click());
                return;
            }
        }

        lastSubmittedContext = captureGenerationContext(prompt);
        void primeCompletionPing();
        showGenerationProgress(lastSubmittedContext);
        generateBtn.disabled = true;
        generateBtn.innerHTML = `<span class="animate-spin inline-block mr-2 text-black">◌</span> ${t('common.generating')}`;

        // Wan2GP reports real progress. Other providers stay visibly
        // indeterminate until they return because they expose no progress API.
        let unsubscribeProgress = null;
        if (isWan2gpLocal) {
            unsubscribeProgress = localAI.onProgress(({ status, progress }) => {
                updateGenerationProgress({ status, progress });
            });
        } else {
            updateGenerationProgress({ stage: isHivemindLocal ? 'rendering' : 'queued' });
        }

        let hadError = false;
        let capturedRequestId = null;
        const historyMeta = { prompt, model: selectedModel, aspect_ratio: selectedAr, duration: selectedDuration };

        const onRequestId = (rid) => {
            capturedRequestId = rid;
            updateGenerationProgress({ stage: 'rendering' });
            savePendingJob({ requestId: rid, studioType: 'video', historyMeta, maxAttempts: 900, interval: 2000, submittedAt: Date.now() });
        };

        try {
            // ─── Local Media Studio path ─────────────────────────────────────
            // Hivemind workflows are served through the same-origin Content
            // Studio API, which wraps the configured Media Studio MCP.
            if (isHivemindLocal) {
                const localParams = {
                    model: selectedModel,
                    workflow_id: workflowIdFromHivemindModelId(selectedModel),
                    prompt: prompt || '',
                    aspect_ratio: selectedAr,
                    resolution: String(selectedResolution || '').toLowerCase() === 'high' ? 'high' : 'standard',
                    duration: selectedDuration || 4,
                    loras: loraGenerationPayload(currentVideoLoraSelection()),
                    ...(hasIngredientReferences ? {
                        ingredientImages: activeIngredientSheetItems().map((item) => ({
                            image: item.url,
                            description: item.description,
                        })),
                        // A finished sheet's description stands alone as the full
                        // reference-sheet description instead of a panel caption.
                        ...(selectedUploadedIngredientSheet()?.description?.trim()
                            ? { referenceDescription: selectedUploadedIngredientSheet().description.trim() }
                            : {}),
                    } : {}),
                };
                if (isHivemindVideoInput) {
                    localParams.video = uploadedVideoUrl;
                    localParams.video_mode = 'extend';
                } else if (uploadedImageUrl) {
                    localParams.image = uploadedImageUrl;
                }
                // Job-based generation reports real render progress while the
                // browser polls (long high-res runs survive connection drops).
                localParams.onProgress = (progress) => updateGenerationProgress({ stage: 'rendering', progress });
                const res = await generateHivemindVideo(localParams);
                if (res && res.url) {
                    const genId = res.id || Date.now().toString();
                    lastGenerationId = null;
                    lastGenerationModel = null;
                    addToHistory({ id: genId, url: res.url, prompt, model: selectedModel, aspect_ratio: selectedAr, duration: selectedDuration, timestamp: new Date().toISOString() }, lastSubmittedContext);
                    showVideoInCanvas(res.url, selectedModel);
                } else {
                    throw new Error('No video URL returned by Hivemind Media Studio');
                }
                generateBtn.disabled = false;
                generateBtn.innerHTML = t('common.generate');
                return;
            }

            // ─── Local Wan2GP path ───────────────────────────────────────────
            // Uploaded image URLs were minted by uploadFileToWan2gp(), so
            // wan2gpProvider can rehydrate the Gradio file descriptor.
            if (isWan2gpLocal) {
                const localParams = {
                    model: selectedModel,
                    prompt: prompt || '',
                    aspect_ratio: selectedAr,
                };
                if (imageMode && uploadedImageUrl) localParams.image = uploadedImageUrl;
                const res = await localAI.generate(localParams);
                if (res && res.url) {
                    const genId = Date.now().toString();
                    lastGenerationId = null;
                    lastGenerationModel = null;
                    addToHistory({ id: genId, url: res.url, prompt, model: selectedModel, aspect_ratio: selectedAr, timestamp: new Date().toISOString() }, lastSubmittedContext);
                    showVideoInCanvas(res.url, selectedModel);
                } else {
                    throw new Error('No video URL returned by Wan2GP');
                }
                generateBtn.disabled = false;
                generateBtn.innerHTML = t('common.generate');
                return;
            }

            if (v2vMode) {
                const v2vParams = { model: selectedModel, video_url: uploadedVideoUrl, onRequestId };
                if (model?.imageField && uploadedImageUrl) v2vParams.image_url = uploadedImageUrl;
                if (model?.hasPrompt && prompt) v2vParams.prompt = prompt;
                const res = await muapi.processV2V(v2vParams);
                if (res && res.url) {
                    if (capturedRequestId) removePendingJob(capturedRequestId);
                    const genId = res.id || capturedRequestId || Date.now().toString();
                    lastGenerationId = null;
                    lastGenerationModel = null;
                    addToHistory({ id: genId, url: res.url, prompt: model?.hasPrompt ? prompt : '', model: selectedModel, timestamp: new Date().toISOString() }, lastSubmittedContext);
                    showVideoInCanvas(res.url, selectedModel);
                } else {
                    throw new Error('No video URL returned by API');
                }
                generateBtn.disabled = false;
                generateBtn.innerHTML = t('common.generate');
                return;
            }

            if (imageMode) {
                const modelAdvancedParams = getAdvancedVideoPayload(model, advancedValues);
                const i2vParams = {
                    model: selectedModel,
                    image_url: uploadedImageUrl,
                    onRequestId,
                    ...modelAdvancedParams,
                };
                i2vParams.prompt = prompt || '';
                i2vParams.aspect_ratio = selectedAr;
                if (uploadedEndImageUrl && getCurrentModel()?.lastImageField) {
                    i2vParams.last_image = uploadedEndImageUrl;
                }
                const durations = getCurrentDurations(selectedModel);
                if (durations.length > 0) i2vParams.duration = selectedDuration;
                const resolutions = getCurrentResolutions(selectedModel);
                if (resolutions.length > 0) i2vParams.resolution = selectedResolution;
                if (selectedQuality) i2vParams.quality = selectedQuality;
                if (selectedMode) i2vParams.mode = selectedMode;
                if (selectedEffectName) i2vParams.name = selectedEffectName;

                const res = await muapi.generateI2V(i2vParams);
                if (res && res.url) {
                    if (capturedRequestId) removePendingJob(capturedRequestId);
                    const genId = res.id || capturedRequestId || Date.now().toString();
                    if (selectedModel === 'seedance-v2.0-i2v') {
                        lastGenerationId = genId;
                        lastGenerationModel = selectedModel;
                    } else {
                        lastGenerationId = null;
                        lastGenerationModel = null;
                    }
                    addToHistory({ id: genId, url: res.url, prompt, model: selectedModel, aspect_ratio: selectedAr, duration: selectedDuration, timestamp: new Date().toISOString() }, lastSubmittedContext);
                    showVideoInCanvas(res.url, selectedModel);
                } else {
                    throw new Error('No video URL returned by API');
                }
                generateBtn.disabled = false;
                generateBtn.innerHTML = t('common.generate');
                return;
            }

            const params = {
                model: selectedModel,
                onRequestId,
                ...getAdvancedVideoPayload(model, advancedValues),
            };

            if (prompt) params.prompt = prompt;

            // Extend mode: pass stored request_id, skip aspect_ratio
            if (isExtendMode) {
                params.request_id = lastGenerationId;
            } else {
                params.aspect_ratio = selectedAr;
            }

            const durations = getCurrentDurations(selectedModel);
            if (durations.length > 0) params.duration = selectedDuration;

            const resolutions = getCurrentResolutions(selectedModel);
            if (resolutions.length > 0) params.resolution = selectedResolution;

            if (selectedQuality) params.quality = selectedQuality;
            if (selectedMode) params.mode = selectedMode;

            const res = await muapi.generateVideo(params);

            if (res && res.url) {
                if (capturedRequestId) removePendingJob(capturedRequestId);
                const genId = res.id || capturedRequestId || Date.now().toString();
                // Store request_id for seedance-v2.0 models (enables Extend button)
                if (selectedModel === 'seedance-v2.0-t2v' || selectedModel === 'seedance-v2.0-i2v') {
                    lastGenerationId = genId;
                    lastGenerationModel = selectedModel;
                } else {
                    lastGenerationId = null;
                    lastGenerationModel = null;
                }

                addToHistory({
                    id: genId,
                    url: res.url,
                    prompt,
                    model: selectedModel,
                    aspect_ratio: selectedAr,
                    duration: selectedDuration,
                    timestamp: new Date().toISOString()
                }, lastSubmittedContext);
                showVideoInCanvas(res.url, selectedModel);
            } else {
                throw new Error('No video URL returned by API');
            }
        } catch (e) {
            hadError = true;
            if (capturedRequestId) removePendingJob(capturedRequestId);
            console.error(e);
            hideGenerationProgress({ restoreSetup: true });
            generateBtn.innerHTML = `Error: ${e.message.slice(0, 60)}`;
            setTimeout(() => {
                generateBtn.innerHTML = t('common.generate');
            }, 4000);
        } finally {
            generateBtn.disabled = false;
            if (typeof unsubscribeProgress === 'function') unsubscribeProgress();
            // Only reset the label on success; the catch timeout handles the error case
            if (!hadError) generateBtn.innerHTML = t('common.generate');
        }
    };

    return container;
}
