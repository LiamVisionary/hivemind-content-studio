import { muapi } from '../lib/muapi.js';
import {
    t2iModels, getAspectRatiosForModel, getResolutionsForModel, getQualityFieldForModel,
    i2iModels, getAspectRatiosForI2IModel, getResolutionsForI2IModel, getQualityFieldForI2IModel,
    getMaxImagesForI2IModel
} from '../lib/models.js';
import { localAI, isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { LOCAL_MODEL_CATALOG, getLocalModelById } from '../lib/localModels.js';
import { ENHANCE_TAGS, QUICK_PROMPTS } from '../lib/promptUtils.js';
import { AuthModal } from './AuthModal.js';
import { t } from '../lib/i18n.js';
import { createUploadPicker } from './UploadPicker.js';
import { savePendingJob, removePendingJob, getPendingJobs } from '../lib/pendingJobs.js';
import { isHivemindStudioEnabled, loadStudioGenerationHistory, saveStudioGenerationHistory } from '../lib/hivemindStudio.js';
import { getComposerSection, hydrateComposerState, updateComposerSection } from '../lib/composerState.js';
import { resolveMediaSrc } from '../lib/e2eMedia.js';
import { loraGenerationPayload, toggleLoraSelection, updateLoraStrength } from '../lib/loraSelection.js';
import { localModelSupportsImageInput } from '../lib/localImageModelFilter.js';
import { createCivitaiDownloadDialog } from './CivitaiDownloadDialog.js';
import { createGenerationContextStore } from '../lib/generationContext.js';

const IMAGE_PREFERENCES_KEY = 'image_generation_preferences';
const STYLE_PRESETS = ['None', 'Photorealistic', 'Anime', 'Cinematic', 'Oil Painting', 'Watercolor', 'Digital Art', 'Concept Art', 'Cyberpunk'];

// Cloud catalog capability flags: an API model "supports" references when it
// has an image-to-image configuration; models only in the editing catalog
// require one. Models are never hidden based on attached references.
const apiModelSupportsImage = (id) => i2iModels.some((m) => m.id === id);
const apiModelRequiresImage = (id) => apiModelSupportsImage(id) && !t2iModels.some((m) => m.id === id);

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

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Unable to read reference image'));
        reader.readAsDataURL(file);
    });
}

function createInlineInstructions(type) {
    const el = document.createElement('div');
    el.className = 'w-full text-center text-secondary/80 text-sm flex flex-col items-center gap-2 py-2';
    el.innerHTML = `
        <p>Enter a prompt above and click <span class="text-primary font-semibold">Generate</span> to create your ${type}.</p>
        <p class="text-xs text-muted">Tip: Be descriptive — include style, lighting, mood, and subject for best results.</p>
    `;
    return el;
}

export function ImageStudio() {
    const container = document.createElement('div');
    // `justify-content: safe center` centers the content while it fits, but falls back to
    // start-alignment once it overflows — otherwise centering pushes the top above the scroll
    // origin (unreachable) and each lazily-loading LoRA card re-centers and yanks the scroll.
    container.className = 'w-full h-full flex flex-col items-center [justify-content:safe_center] bg-transparent relative p-4 md:p-6 overflow-y-auto custom-scrollbar overflow-x-hidden';

    // --- State ---
    // Studio mode reads configs from the warm encrypted composer cache first
    // (tab switches remount this component; the cache survives in-module), and
    // never writes them to browser storage.
    let persistedImagePreferences = null;
    try {
        persistedImagePreferences = normalizeImagePreferences(
            getComposerSection('image').preferences
                || JSON.parse(localStorage.getItem(IMAGE_PREFERENCES_KEY) || 'null'),
        );
    } catch {}
    // imageMode is DERIVED from actually-attached references (picker onSelect,
    // draft hydration, context restore) — never adopted as a bare persisted
    // flag, which used to leave the studio in a ghost "image attached" state
    // with a visibly empty picker after reloads.
    const defaultModel = t2iModels.find((model) => model.id === persistedImagePreferences?.modelId)
        || i2iModels.find((model) => model.id === persistedImagePreferences?.modelId)
        || t2iModels[0];
    let selectedModel = defaultModel.id;
    let selectedModelName = defaultModel.name;
    let imageMode = false;
    const initialI2iConfig = apiModelRequiresImage(selectedModel);
    const initialAspectRatios = initialI2iConfig ? getAspectRatiosForI2IModel(selectedModel) : getAspectRatiosForModel(selectedModel);
    let selectedAr = initialAspectRatios.includes(persistedImagePreferences?.aspectRatio)
        ? persistedImagePreferences.aspectRatio
        : (defaultModel.inputs?.aspect_ratio?.default || initialAspectRatios[0] || '1:1');
    const initialResolutions = initialI2iConfig ? getResolutionsForI2IModel(selectedModel) : getResolutionsForModel(selectedModel);
    let selectedResolution = initialResolutions.includes(persistedImagePreferences?.resolution)
        ? persistedImagePreferences.resolution
        : (initialResolutions[0] || '');
    let dropdownOpen = null;
    let uploadedImageUrls = []; // array of uploaded image URLs (multi-image support)

    // Local inference state — only image-capable models surface here.
    // sd.cpp uses type='sd1'|'sdxl'|'z-image'; Wan2GP image models use type='image'.
    // Wan2GP video models (type='video') are hidden from ImageStudio.
    let localImageModels = LOCAL_MODEL_CATALOG.filter(m => m.type !== 'video');
    let useLocalModel = Boolean(persistedImagePreferences?.useLocalModel && isLocalAIAvailable());
    let selectedLocalModel = persistedImagePreferences?.localModelId || localImageModels[0]?.id || null;
    const localModelById = (id) => localImageModels.find(m => m.id === id) || getLocalModelById(id);
    // Every local model is always listed; attaching an image never hides
    // text-to-image models. Models that can't take references simply ignore
    // them (the reference chip says so and the upload trigger is disabled).
    const compatibleLocalModels = () => localImageModels;
    const ensureCompatibleLocalModel = () => {
        const compatible = compatibleLocalModels();
        const selected = compatible.find(model => model.id === selectedLocalModel) || compatible[0] || null;
        selectedLocalModel = selected?.id || null;
        return selected;
    };
    const currentModelSupportsImage = () => {
        if (!useLocalModel) return apiModelSupportsImage(selectedModel);
        const model = localModelById(selectedLocalModel);
        // Fail OPEN while the runtime catalog is still loading — an unknown
        // model must not lock the upload button (worst case the chip marks
        // the references as ignored once the catalog lands).
        return model ? localModelSupportsImageInput(model) : true;
    };
    let localRuntimeMode = persistedImagePreferences?.localRuntimeMode || localModelById(selectedLocalModel)?.defaultRuntimeMode || 'one-off';
    let localGenProgress = 0; // 0–1

    // Advanced parameters state
    let negativePrompt = persistedImagePreferences?.negativePrompt || '';
    let guidanceScale = persistedImagePreferences?.guidanceScale ?? 7.5;
    let steps = persistedImagePreferences?.steps ?? 25;
    let seed = persistedImagePreferences?.seed ?? -1;
    let showAdvanced = false;
    let selectedStyle = persistedImagePreferences?.style || 'None';
    let batchCount = persistedImagePreferences?.batchCount ?? 1;

    // New advanced controls
    let customWidth = persistedImagePreferences?.customWidth ?? 0;  // 0 means use default (aspect ratio based)
    let customHeight = persistedImagePreferences?.customHeight ?? 0;
    let referenceStrength = persistedImagePreferences?.referenceStrength ?? 50;  // 0-100, for style reference models

    // Couple mode (regional two-character workflows) — OFF by default; only
    // offered when the selected local model is couple-capable. Character text
    // lives in the panel inputs for the session, never in persisted prefs.
    let coupleMode = Boolean(persistedImagePreferences?.coupleMode);
    let coupleDirection = persistedImagePreferences?.coupleDirection === 'vertical' ? 'vertical' : 'horizontal';
    let coupleSplit = persistedImagePreferences?.coupleSplit ?? 50; // Character A's share, percent
    let couplePair = ['girls', 'mixed', 'boys'].includes(persistedImagePreferences?.couplePair)
        ? persistedImagePreferences.couplePair : 'girls';
    let availableLoras = [];
    let loraCatalogStatus = 'idle';
    let loraCatalogMessage = '';
    let loraCatalogRequest = 0;
    let promptHelperRequest = 0;
    const loraSelectionsByModel = new Map();
    Object.entries(persistedImagePreferences?.loraSelections || {}).forEach(([model, selections]) => {
        loraSelectionsByModel.set(model, selections);
    });

    // Quick tools panel state
    let showToolsPanel = false;

    // "Return to a past generation's exact setup" — shares the store the Video studio uses.
    // See src/lib/generationContext.js.
    const contextStore = createGenerationContextStore();
    let lastSubmittedContext = null;

    // A cloud model runs with its image-to-image configuration when references
    // are attached and usable, or when the model only exists as an editing tool.
    const useI2iConfig = (id) => !useLocalModel && apiModelSupportsImage(id)
        && (uploadedImageUrls.length > 0 || apiModelRequiresImage(id));
    const getCurrentAspectRatios = (id) => useI2iConfig(id) ? getAspectRatiosForI2IModel(id) : getAspectRatiosForModel(id);
    const getCurrentResolutions = (id) => useI2iConfig(id) ? getResolutionsForI2IModel(id) : getResolutionsForModel(id);
    const getCurrentQualityField = (id) => useI2iConfig(id) ? getQualityFieldForI2IModel(id) : getQualityFieldForModel(id);

    // Per-model advanced settings: the active model's tuned values are
    // snapshotted on every persist and restored when the model is reselected.
    const modelSettingsById = new Map(Object.entries(persistedImagePreferences?.modelSettings || {}));
    const currentSettingsKey = () => {
        const id = useLocalModel ? selectedLocalModel : selectedModel;
        return id ? `${useLocalModel ? 'local' : 'api'}:${id}` : '';
    };
    const snapshotCurrentModelSettings = () => {
        const key = currentSettingsKey();
        if (!key) return;
        modelSettingsById.set(key, {
            steps,
            guidanceScale,
            negativePrompt,
            aspectRatio: selectedAr,
            resolution: selectedResolution,
            customWidth,
            customHeight,
            localRuntimeMode,
            coupleMode,
            coupleDirection,
            coupleSplit,
            couplePair,
        });
    };

    const persistImagePreferences = () => {
        snapshotCurrentModelSettings();
        const preferences = normalizeImagePreferences({
            modelId: selectedModel,
            imageMode,
            useLocalModel,
            localModelId: selectedLocalModel,
            aspectRatio: selectedAr,
            resolution: selectedResolution,
            localRuntimeMode,
            negativePrompt,
            guidanceScale,
            steps,
            seed,
            style: selectedStyle,
            batchCount,
            customWidth,
            customHeight,
            referenceStrength,
            coupleMode,
            coupleDirection,
            coupleSplit,
            couplePair,
            modelSettings: Object.fromEntries(modelSettingsById),
            loraSelections: Object.fromEntries(loraSelectionsByModel),
        });
        if (!preferences) return;
        persistedImagePreferences = preferences;
        updateComposerSection('image', { preferences });
        if (!isHivemindStudioEnabled()) {
            try { localStorage.setItem(IMAGE_PREFERENCES_KEY, JSON.stringify(preferences)); } catch {}
        }
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
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                </svg>
             </div>
        </div>
        <h1 class="font-display text-3xl md:text-4xl font-bold tracking-tight text-white mb-2 text-center px-4">${t('image.title')}</h1>
        <p class="text-secondary text-sm md:text-[15px] text-center px-4">${t('image.subtitle')}</p>
    `;
    container.appendChild(hero);

    // ==========================================
    // 2. PROMPT BAR (Tailwind Refactor)
    // ==========================================
    const promptWrapper = document.createElement('div');
    promptWrapper.className = 'w-full max-w-4xl relative z-40 animate-fade-in-up';
    promptWrapper.style.animationDelay = '0.2s';

    const bar = document.createElement('div');
    bar.className = 'w-full bg-card-bg/90 backdrop-blur-xl border border-white/10 rounded-2xl md:rounded-3xl p-3 md:p-5 flex flex-col gap-3 md:gap-5 shadow-panel transition-colors focus-within:border-primary/40';

    // Top Row: Input
    const topRow = document.createElement('div');
    topRow.className = 'flex items-start gap-5 px-2';

    // --- Image Upload Picker (Image-to-Image) ---
    const picker = createUploadPicker({
        anchorContainer: container,
        uploadFn: (file) => useLocalModel ? fileToDataUrl(file) : muapi.uploadFile(file),
        requireApiKey: () => !useLocalModel,
        persistUpload: ({ uploadedUrl }) => !String(uploadedUrl || '').startsWith('data:'),
        onSelect: ({ url, urls }) => {
            uploadedImageUrls = urls || [url];
            imageMode = true;
            if (!useLocalModel) {
                // The model NEVER changes because a reference was attached —
                // its i2i configuration simply becomes active if it has one.
                refreshModelConfigControls();
            }
            updateReferenceChip();
            if (useLocalModel) {
                const localModel = ensureCompatibleLocalModel();
                if (localModel) {
                    document.getElementById('model-btn-label').textContent = localModel.name;
                    selectedAr = localModel.aspectRatios?.[0] || selectedAr;
                    document.getElementById('ar-btn-label').textContent = selectedAr;
                    picker.setMaxImages(localModel.maxReferenceImages || 1);
                }
                updatePromptHelperUI();
                void loadLorasForCurrentModel();
            }
            textarea.placeholder = uploadedImageUrls.length > 1
                ? `${uploadedImageUrls.length} ${t('image.multiImageNote') || 'images selected — describe the transformation (optional)'}`
                : t('image.placeholderTransform');
            persistImagePreferences();
            updateComposerSection('image', { references: uploadedImageUrls.slice() });
        },
        onClear: () => clearReferences(),
    });

    // Reflect the selected cloud model's active configuration (t2i vs i2i,
    // depending on attached references) in the aspect/quality controls.
    const refreshModelConfigControls = () => {
        const ars = getCurrentAspectRatios(selectedModel);
        if (!ars.includes(selectedAr)) {
            selectedAr = ars[0] || '1:1';
            document.getElementById('ar-btn-label').textContent = selectedAr;
        }
        const resolutions = getCurrentResolutions(selectedModel);
        if (!resolutions.includes(selectedResolution)) selectedResolution = resolutions[0] || '';
        qualityBtn.style.display = resolutions.length > 0 ? 'flex' : 'none';
        if (resolutions.length > 0) document.getElementById('quality-btn-label').textContent = selectedResolution;
        picker.setMaxImages(apiModelSupportsImage(selectedModel)
            ? getMaxImagesForI2IModel(selectedModel)
            : Math.max(uploadedImageUrls.length, 1));
    };

    // Shared by the picker's own clear action and the reference chip's Clear.
    const clearReferences = () => {
        {
            uploadedImageUrls = [];
            imageMode = false;
            if (!useLocalModel) {
                // The selected model stays put; only its active config flips
                // back to text-to-image where applicable.
                refreshModelConfigControls();
            }
            updateReferenceChip();
            if (useLocalModel) {
                const localModel = ensureCompatibleLocalModel();
                if (localModel) {
                    document.getElementById('model-btn-label').textContent = localModel.name;
                    selectedAr = localModel.aspectRatios?.[0] || selectedAr;
                    document.getElementById('ar-btn-label').textContent = selectedAr;
                }
                updatePromptHelperUI();
                void loadLorasForCurrentModel();
            }
            textarea.placeholder = t('image.placeholder');
            persistImagePreferences();
            updateComposerSection('image', { references: [] });
        }
    };
    topRow.appendChild(picker.trigger);
    container.appendChild(picker.panel);

    // --- Reference state chip: "Using N reference images · Clear" ---------
    // Always-visible truth about attached references, including when the
    // selected model can't use them (they are ignored, never silently applied).
    const refChip = document.createElement('div');
    refChip.id = 'image-ref-chip';
    refChip.className = 'hidden items-center gap-2 px-3 py-2 rounded-xl border border-primary/25 bg-primary/10 text-xs font-semibold text-primary whitespace-nowrap';
    const refChipLabel = document.createElement('span');
    refChip.appendChild(refChipLabel);
    const refChipClear = document.createElement('button');
    refChipClear.type = 'button';
    refChipClear.className = 'rounded-md px-1.5 py-0.5 text-[11px] font-bold text-primary/80 underline decoration-primary/40 underline-offset-2 transition-colors hover:text-white';
    refChipClear.textContent = t('common.clearReferences');
    refChip.appendChild(refChipClear);

    const updateReferenceChip = () => {
        const count = uploadedImageUrls.length;
        refChip.classList.toggle('hidden', count === 0);
        refChip.classList.toggle('flex', count > 0);
        if (!count) return;
        const ignored = !currentModelSupportsImage();
        const noun = count === 1 ? 'reference image' : 'reference images';
        refChipLabel.textContent = ignored
            ? `${count} ${noun} — ignored by this model`
            : `Using ${count} ${noun}`;
        refChip.classList.toggle('opacity-60', ignored);
        refChip.title = ignored
            ? 'The selected model does not accept image references; they stay attached but are not sent.'
            : 'These references are sent with your next generation.';
    };

    // The upload trigger disables when the selected model can't take images —
    // references never silently vanish, and models are never hidden for it.
    const updateUploadTriggerState = () => {
        const supported = currentModelSupportsImage();
        picker.trigger.disabled = !supported;
        picker.trigger.title = supported
            ? 'Reference image'
            : 'This model does not accept reference images';
        updateReferenceChip();
    };

    refChipClear.onclick = (e) => {
        e.stopPropagation();
        picker.reset();
        clearReferences();
    };

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Describe the image you want to create';
    textarea.className = 'flex-1 bg-transparent border-none text-white text-base md:text-xl placeholder:text-muted focus:outline-none resize-none pt-2.5 leading-relaxed min-h-[40px] max-h-[150px] md:max-h-[250px] overflow-y-auto custom-scrollbar';
    textarea.rows = 1;
    textarea.oninput = () => {
        textarea.style.height = 'auto';
        const maxHeight = window.innerWidth < 768 ? 150 : 250;
        textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
        updateComposerSection('image', { prompt: textarea.value });
    };

    topRow.appendChild(textarea);
    bar.appendChild(topRow);

    // ── Couple mode panel ────────────────────────────────────────────────
    // Shown instead of the single prompt box when a couple-capable local
    // workflow has Couple mode toggled on. One line per character, plus an
    // optional shared scene line and a visual canvas split control.
    const couplePanel = document.createElement('div');
    couplePanel.id = 'couple-panel';
    couplePanel.className = 'hidden mx-2 border-t border-white/5 pt-3 flex-col gap-3';
    couplePanel.innerHTML = `
        <input id="couple-shared-input" type="text" placeholder="Shared scene (optional) — e.g. sitting by a bonfire at night"
            class="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm text-white placeholder:text-muted outline-none focus:border-primary/50" />
        <div class="flex flex-col md:flex-row gap-3">
            <div class="flex-1 flex flex-col gap-1.5">
                <label for="couple-a-input" class="text-[11px] font-bold uppercase tracking-wider text-primary">Character A</label>
                <textarea id="couple-a-input" rows="2" placeholder="e.g. haruno sakura, pink hair, smiling"
                    class="w-full resize-y rounded-xl border border-primary/30 bg-black/20 px-4 py-2.5 text-sm text-white placeholder:text-muted outline-none focus:border-primary/60"></textarea>
            </div>
            <div class="flex-1 flex flex-col gap-1.5">
                <label for="couple-b-input" class="text-[11px] font-bold uppercase tracking-wider text-accent">Character B</label>
                <textarea id="couple-b-input" rows="2" placeholder="e.g. black hair, green eyes, crossed arms"
                    class="w-full resize-y rounded-xl border border-accent/30 bg-black/20 px-4 py-2.5 text-sm text-white placeholder:text-muted outline-none focus:border-accent/60"></textarea>
            </div>
        </div>
        <div class="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
            <div class="flex items-center gap-1.5">
                <span class="text-[11px] font-bold uppercase tracking-wider text-secondary mr-1">Pair</span>
                <button data-couple-pair="girls" class="px-3 py-1.5 rounded-lg text-xs font-bold transition-all">Two girls</button>
                <button data-couple-pair="mixed" class="px-3 py-1.5 rounded-lg text-xs font-bold transition-all">Girl &amp; boy</button>
                <button data-couple-pair="boys" class="px-3 py-1.5 rounded-lg text-xs font-bold transition-all">Two boys</button>
            </div>
            <div class="flex items-center gap-1.5">
                <span class="text-[11px] font-bold uppercase tracking-wider text-secondary mr-1">Layout</span>
                <button id="couple-layout-h" class="px-3 py-1.5 rounded-lg text-xs font-bold transition-all">Side by side</button>
                <button id="couple-layout-v" class="px-3 py-1.5 rounded-lg text-xs font-bold transition-all">Stacked</button>
            </div>
            <div class="flex flex-1 items-center gap-3 min-w-[220px]">
                <span id="couple-split-label" class="text-xs font-bold text-secondary whitespace-nowrap">A 50% / B 50%</span>
                <div class="flex-1 flex flex-col gap-1">
                    <div id="couple-split-bar" class="flex h-2 w-full overflow-hidden rounded-full">
                        <div id="couple-split-bar-a" class="bg-primary" style="width:50%"></div>
                        <div id="couple-split-bar-b" class="bg-accent" style="width:50%"></div>
                    </div>
                    <input id="couple-split-slider" type="range" min="10" max="90" step="5" value="50" class="w-full accent-primary" />
                </div>
            </div>
        </div>
    `;
    bar.appendChild(couplePanel);

    const coupleSharedInput = couplePanel.querySelector('#couple-shared-input');
    const coupleAInput = couplePanel.querySelector('#couple-a-input');
    const coupleBInput = couplePanel.querySelector('#couple-b-input');
    const coupleSplitSlider = couplePanel.querySelector('#couple-split-slider');

    const coupleCapableModel = () => useLocalModel && Boolean(localModelById(selectedLocalModel)?.coupleCapable);
    const coupleActive = () => coupleMode && coupleCapableModel();

    const updateCoupleSplitUI = () => {
        const a = Math.round(coupleSplit);
        const vertical = coupleDirection === 'vertical';
        coupleSplitSlider.value = String(a);
        couplePanel.querySelector('#couple-split-bar-a').style.width = `${a}%`;
        couplePanel.querySelector('#couple-split-bar-b').style.width = `${100 - a}%`;
        couplePanel.querySelector('#couple-split-bar').className =
            `flex h-2 w-full overflow-hidden rounded-full ${vertical ? 'flex-col !h-6 w-3 self-center' : ''}`;
        couplePanel.querySelector('#couple-split-bar-a').style.height = vertical ? `${a}%` : '';
        couplePanel.querySelector('#couple-split-bar-b').style.height = vertical ? `${100 - a}%` : '';
        couplePanel.querySelector('#couple-split-label').textContent =
            vertical ? `A ${a}% top / B ${100 - a}%` : `A ${a}% / B ${100 - a}%`;
        const active = 'px-3 py-1.5 rounded-lg text-xs font-bold transition-all bg-primary text-black';
        const idle = 'px-3 py-1.5 rounded-lg text-xs font-bold transition-all bg-white/5 text-secondary hover:bg-white/10';
        couplePanel.querySelector('#couple-layout-h').className = vertical ? idle : active;
        couplePanel.querySelector('#couple-layout-v').className = vertical ? active : idle;
        couplePanel.querySelectorAll('[data-couple-pair]').forEach((btn) => {
            btn.className = btn.dataset.couplePair === couplePair ? active : idle;
        });
        const [labelA, labelB] = couplePair === 'mixed'
            ? ['Character A (girl)', 'Character B (boy)']
            : ['Character A', 'Character B'];
        couplePanel.querySelector('label[for="couple-a-input"]').textContent = labelA;
        couplePanel.querySelector('label[for="couple-b-input"]').textContent = labelB;
    };
    couplePanel.querySelector('#couple-layout-h').onclick = () => { coupleDirection = 'horizontal'; updateCoupleSplitUI(); persistImagePreferences(); };
    couplePanel.querySelector('#couple-layout-v').onclick = () => { coupleDirection = 'vertical'; updateCoupleSplitUI(); persistImagePreferences(); };
    couplePanel.querySelectorAll('[data-couple-pair]').forEach((btn) => {
        btn.onclick = () => { couplePair = btn.dataset.couplePair; updateCoupleSplitUI(); persistImagePreferences(); };
    });
    coupleSplitSlider.oninput = (e) => { coupleSplit = Number(e.target.value); updateCoupleSplitUI(); };
    coupleSplitSlider.onchange = () => persistImagePreferences();

    // Hoisted below with the toggle button; declared here so early callers exist.
    let updateCoupleUI = () => {};

    const promptHelperPanel = document.createElement('div');
    promptHelperPanel.id = 'workflow-prompt-helper-panel';
    promptHelperPanel.className = 'hidden mx-2 border-t border-white/5 pt-3';
    promptHelperPanel.innerHTML = `
        <div class="flex items-center justify-between gap-3 mb-2">
            <span data-prompt-helper-title class="text-[10px] font-bold uppercase tracking-widest text-primary">Prompt helper</span>
            <button type="button" data-prompt-helper-dismiss title="Dismiss" aria-label="Dismiss prompt helper" class="grid h-8 w-8 place-items-center rounded-lg bg-white/5 text-lg text-white/50 transition-colors hover:bg-white/10 hover:text-white">×</button>
        </div>
        <textarea data-prompt-helper-result rows="4" class="w-full resize-y rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm leading-relaxed text-white outline-none focus:border-primary/50"></textarea>
        <div class="mt-2 flex items-center justify-between gap-3">
            <span data-prompt-helper-status class="min-w-0 text-xs text-muted" role="status" aria-live="polite"></span>
            <button type="button" data-prompt-helper-use class="shrink-0 rounded-lg bg-primary px-4 py-2 text-xs font-black text-black transition-opacity hover:opacity-90">Use prompt</button>
        </div>
    `;
    bar.appendChild(promptHelperPanel);

    // Bottom Row: Controls
    const bottomRow = document.createElement('div');
    bottomRow.className = 'flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 px-2 pt-4 border-t border-white/5';

    const controlsLeft = document.createElement('div');
    controlsLeft.className = 'flex flex-1 min-w-0 items-center gap-1.5 md:gap-2 relative overflow-x-auto no-scrollbar pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0';

    const createControlBtn = (icon, label, id, tooltip) => {
        const btn = document.createElement('button');
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
            <span class="text-[10px] font-black text-black">G</span>
        </div>
    `, selectedModelName, 'model-btn', t('image.modelTooltip'));

    const arBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>
    `, selectedAr, 'ar-btn', t('image.arTooltip'));

    const qualityBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><path d="M6 2L3 6v15a2 2 0 002 2h14a2 2 0 002-2V6l-3-4H6z"/></svg>
    `, '720p', 'quality-btn', t('image.qualityTooltip'));

    // Local / API source toggle (only shown in Electron)
    let localToggleBtn = null;
    // Hoisted so restoreImageContext() can reflect the restored API/Local source; a no-op
    // when the toggle isn't rendered (non-Electron).
    let updateLocalToggleStyle = () => {};
    if (isLocalAIAvailable()) {
        localToggleBtn = document.createElement('button');
        localToggleBtn.id = 'local-toggle-btn';
        localToggleBtn.className = 'flex items-center gap-1.5 px-3 py-2 rounded-xl transition-all border text-xs font-bold whitespace-nowrap';
        updateLocalToggleStyle = () => {
            if (useLocalModel) {
                localToggleBtn.className = 'flex items-center gap-1.5 px-3 py-2 rounded-xl transition-all border text-xs font-bold whitespace-nowrap bg-primary/20 border-primary/40 text-primary';
                localToggleBtn.textContent = t('image.local');
            } else {
                localToggleBtn.className = 'flex items-center gap-1.5 px-3 py-2 rounded-xl transition-all border text-xs font-bold whitespace-nowrap bg-white/5 border-white/5 text-white/60 hover:bg-white/10';
                localToggleBtn.textContent = t('image.api');
            }
        };
        updateLocalToggleStyle();
        localToggleBtn.onclick = (e) => {
            e.stopPropagation();
            snapshotCurrentModelSettings();
            useLocalModel = !useLocalModel;
            updateLocalToggleStyle();
            // Reflect active model in the button label
            if (useLocalModel) {
                const lm = ensureCompatibleLocalModel();
                if (lm) document.getElementById('model-btn-label').textContent = lm.name;
                localRuntimeMode = lm?.defaultRuntimeMode || localRuntimeMode || 'one-off';
                if (lm) applyStoredModelSettings(`local:${lm.id}`, lm);
                updateLocalRuntimeModeUI();
            } else {
                document.getElementById('model-btn-label').textContent = selectedModelName;
                applyStoredModelSettings(`api:${selectedModel}`);
                updateLocalRuntimeModeUI();
            }
            updatePromptHelperUI();
            void loadLorasForCurrentModel();
            persistImagePreferences();
            updateUploadTriggerState();
            updateCoupleUI();
        };
        controlsLeft.appendChild(localToggleBtn);
    }

    controlsLeft.appendChild(modelBtn);
    controlsLeft.appendChild(arBtn);
    controlsLeft.appendChild(qualityBtn);
    controlsLeft.appendChild(refChip);

    // Couple mode toggle — only rendered for couple-capable local workflows.
    const coupleToggleBtn = document.createElement('button');
    coupleToggleBtn.id = 'couple-toggle-btn';
    coupleToggleBtn.setAttribute('data-tooltip', 'Two-character mode: one prompt per character with a canvas split');
    updateCoupleUI = () => {
        const capable = coupleCapableModel();
        coupleToggleBtn.style.display = capable ? 'flex' : 'none';
        const active = coupleActive();
        coupleToggleBtn.className = active
            ? 'flex items-center gap-1.5 px-3 py-2 rounded-xl transition-all border text-xs font-bold whitespace-nowrap bg-accent/20 border-accent/40 text-accent'
            : 'flex items-center gap-1.5 px-3 py-2 rounded-xl transition-all border text-xs font-bold whitespace-nowrap bg-white/5 border-white/5 text-white/60 hover:bg-white/10';
        coupleToggleBtn.textContent = active ? 'Couple on' : 'Couple';
        couplePanel.classList.toggle('hidden', !active);
        couplePanel.classList.toggle('flex', active);
        // The single prompt box hands over to the per-character inputs.
        topRow.classList.toggle('hidden', active);
        if (active) updateCoupleSplitUI();
    };
    coupleToggleBtn.onclick = (e) => {
        e.stopPropagation();
        coupleMode = !coupleMode;
        updateCoupleUI();
        persistImagePreferences();
        if (coupleActive()) coupleAInput.focus();
    };
    updateCoupleUI();
    controlsLeft.appendChild(coupleToggleBtn);

    // Advanced options toggle button
    const advancedBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 001.82-.33 1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-1.82.33A1.65 1.65 0 0019.4 9a1.65 1.65 0 00-1.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
    `, t('common.advanced'), 'advanced-btn', t('image.advancedTooltip'));
    controlsLeft.appendChild(advancedBtn);

    // Quick Tools toggle button
    const toolsBtn = createControlBtn(`
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-60 text-secondary"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>
    `, t('common.tools'), 'tools-btn', t('image.toolsTooltip'));
    controlsLeft.appendChild(toolsBtn);

    const promptHelperBtn = document.createElement('button');
    promptHelperBtn.type = 'button';
    promptHelperBtn.id = 'image-prompt-helper-btn';
    promptHelperBtn.title = 'Refine with this workflow prompt helper';
    promptHelperBtn.className = 'hidden items-center gap-2 px-3 md:px-4 py-2 md:py-2.5 bg-primary/10 hover:bg-primary/20 rounded-xl md:rounded-2xl transition-all border border-primary/20 whitespace-nowrap text-primary';
    promptHelperBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m12 3-1.6 4.4L6 9l4.4 1.6L12 15l1.6-4.4L18 9l-4.4-1.6L12 3Z"/><path d="m5 15-.8 2.2L2 18l2.2.8L5 21l.8-2.2L8 18l-2.2-.8L5 15Z"/><path d="m19 13-1.1 2.9L15 17l2.9 1.1L19 21l1.1-2.9L23 17l-2.9-1.1L19 13Z"/></svg>
        <span data-prompt-helper-button-label class="text-xs font-bold">Prompt helper</span>
    `;
    controlsLeft.appendChild(promptHelperBtn);
    // Show quality button if the default model has quality/resolution options
    const _initResolutions = getCurrentResolutions(selectedModel);
    qualityBtn.style.display = _initResolutions.length > 0 ? 'flex' : 'none';
    if (_initResolutions.length > 0) {
        const qlabel = qualityBtn.querySelector('#quality-btn-label');
        if (qlabel) qlabel.textContent = selectedResolution || _initResolutions[0];
    }
    if (useLocalModel) {
        const localModel = localModelById(selectedLocalModel);
        if (localModel) modelBtn.querySelector('#model-btn-label').textContent = localModel.name;
        qualityBtn.style.display = 'none';
    }

    const generateBtn = document.createElement('button');
    generateBtn.className = 'bg-primary text-black px-6 md:px-8 py-3 md:py-3.5 rounded-xl md:rounded-2xl font-bold text-sm md:text-base hover:shadow-glow hover:scale-105 active:scale-95 transition-all flex items-center justify-center gap-2.5 w-full sm:w-auto shadow-lg';
    generateBtn.setAttribute('data-tooltip', t('image.generateTooltip'));
    generateBtn.innerHTML = t('common.generate');

    bottomRow.appendChild(controlsLeft);
    bottomRow.appendChild(generateBtn);
    bar.appendChild(bottomRow);
    promptWrapper.appendChild(bar);
    container.appendChild(promptWrapper);

    const inlineInstructions = createInlineInstructions('image');
    inlineInstructions.classList.add('max-w-4xl', 'mt-8');
    container.appendChild(inlineInstructions);

    // Local generation progress bar (hidden until active)
    const localProgressWrap = document.createElement('div');
    localProgressWrap.className = 'w-full max-w-4xl mt-4 hidden flex-col gap-2';
    localProgressWrap.id = 'local-progress-wrap';
    localProgressWrap.innerHTML = `
        <div class="flex items-center justify-between">
            <span class="text-xs font-bold text-white/60">${t('image.generatingLocally')}</span>
            <span id="local-progress-pct" class="text-xs font-bold text-primary">0%</span>
        </div>
        <div class="h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div id="local-progress-fill" class="h-full bg-primary transition-all duration-200" style="width:0%"></div>
        </div>
        <div class="flex justify-end">
            <button id="local-cancel-btn" class="text-xs text-red-400 hover:text-red-300 transition-colors">${t('common.cancel')}</button>
        </div>
    `;
    container.appendChild(localProgressWrap);

    localProgressWrap.querySelector('#local-cancel-btn')?.addEventListener('click', () => {
        localAI.cancelGeneration();
        localProgressWrap.classList.remove('flex');
        localProgressWrap.classList.add('hidden');
        generateBtn.disabled = false;
        generateBtn.innerHTML = t('common.generate');
    });

    // ==========================================
    // 3. QUICK TOOLS PANEL (Prompt Enhancer + Quick Starters)
    // ==========================================
    const toolsPanel = document.createElement('div');
    toolsPanel.className = 'w-full max-w-4xl mt-6 animate-fade-in-up hidden';
    toolsPanel.id = 'tools-panel';
    
    // Build tools panel HTML
    toolsPanel.innerHTML = `
        <div class="bg-card-bg/90 backdrop-blur-xl border border-white/10 rounded-2xl p-5 flex flex-col gap-4">
            <div class="sticky top-0 z-20 -mx-5 -mt-5 mb-1 flex items-center justify-between gap-3 px-5 pt-5 pb-3 border-b border-white/10 bg-[#141414] rounded-t-2xl">
                <h3 class="text-sm font-bold text-white">${t('image.quickTools')}</h3>
                <button id="close-tools-btn" title="${t('common.less')}" aria-label="${t('common.less')}" class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/5 text-white/50 transition-colors hover:bg-white/10 hover:text-white">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
            </div>

            <div class="flex flex-col lg:flex-row gap-6">
                <!-- Quick Starters Section -->
                <div class="flex-1">
                    <h4 class="text-xs font-bold text-secondary uppercase tracking-wider mb-3">${t('image.quickStarters')}</h4>
                    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        ${QUICK_PROMPTS.map(q => `
                            <button class="quick-starter-btn px-3 py-2 rounded-lg text-xs font-bold bg-white/5 text-secondary hover:bg-white/10 hover:text-primary transition-all text-left border border-white/5 hover:border-primary/30" data-prompt="${q.prompt}">
                                ${q.label}
                            </button>
                        `).join('')}
                    </div>
                </div>
                
                <!-- Prompt Enhancer Section -->
                <div class="flex-1">
                    <h4 class="text-xs font-bold text-secondary uppercase tracking-wider mb-3">${t('image.promptEnhancer')}</h4>
                    <div class="flex flex-col gap-3">
                        <input type="text" id="base-prompt-input"
                            placeholder="${t('image.basePromptPlaceholder')}"
                            class="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm placeholder:text-muted focus:outline-none focus:border-primary/50 transition-colors">

                        <div>
                            <label class="text-[10px] font-bold text-muted uppercase tracking-wider mb-2 block">${t('image.enhancementTags')}</label>
                            <div id="enhance-tags-area" class="flex flex-wrap gap-1.5">
                                ${Object.entries(ENHANCE_TAGS).map(([category, tags]) => 
                                    tags.map(tag => `<button class="enhance-tag-btn px-2 py-1 rounded-full text-[10px] font-bold bg-white/5 text-secondary hover:bg-white/10 transition-all" data-tag="${tag}">${tag}</button>`).join('')
                                ).join('')}
                            </div>
                        </div>
                        
                        <div class="flex flex-col gap-2">
                            <label class="text-[10px] font-bold text-muted uppercase tracking-wider">${t('image.enhancedPrompt')}</label>
                            <div id="enhanced-prompt-display" class="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-xs min-h-[40px]"></div>
                            <div class="flex gap-2">
                                <button id="copy-enhanced-btn" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-white/5 text-secondary hover:bg-white/10 transition-all">
                                    ${t('common.copy')}
                                </button>
                                <button id="use-enhanced-btn" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-primary text-black hover:shadow-glow transition-all">
                                    ${t('common.useInGenerator')}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    container.appendChild(toolsPanel);

    // ==========================================
    // 4. ADVANCED OPTIONS PANEL
    // ==========================================
    const advancedPanel = document.createElement('div');
    advancedPanel.className = 'w-full max-w-4xl mt-6 animate-fade-in-up hidden';
    advancedPanel.id = 'advanced-panel';
    advancedPanel.innerHTML = `
        <div class="bg-card-bg/90 backdrop-blur-xl border border-white/10 rounded-2xl p-5 flex flex-col gap-4">
            <!-- Sticky header: pins to the top of the scroll container so the close button stays
                 reachable even when the LoRA grid makes the panel taller than the viewport. -->
            <div class="sticky top-0 z-20 -mx-5 -mt-5 mb-1 flex items-center justify-between gap-3 px-5 pt-5 pb-3 border-b border-white/10 bg-[#141414] rounded-t-2xl">
                <h3 class="text-sm font-bold text-white">${t('image.advancedOptions')}</h3>
                <button id="close-adv-btn" title="${t('common.less')}" aria-label="${t('common.less')}" class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/5 text-white/50 transition-colors hover:bg-white/10 hover:text-white">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
            </div>

            <!-- Style Presets -->
            <div class="flex flex-col gap-2">
                <label class="text-xs font-bold text-secondary uppercase tracking-wider">${t('image.stylePreset')}</label>
                <div class="flex gap-2 flex-wrap">
                    ${STYLE_PRESETS.map(s => `<button class="style-preset-btn px-3 py-1.5 rounded-lg text-xs font-bold bg-white/5 text-secondary hover:bg-white/10 transition-all" data-style="${s}">${s}</button>`).join('')}
                </div>
            </div>

            <!-- Local Runtime Mode -->
            <div id="local-runtime-mode-panel" class="flex flex-col gap-2">
                <label class="text-xs font-bold text-secondary uppercase tracking-wider">Local runtime mode</label>
                <div class="flex gap-2 flex-wrap">
                    <button class="local-runtime-btn px-3 py-1.5 rounded-lg text-xs font-bold bg-primary text-black transition-all" data-runtime-mode="one-off">One-off generation</button>
                    <button class="local-runtime-btn px-3 py-1.5 rounded-lg text-xs font-bold bg-white/5 text-secondary hover:bg-white/10 transition-all" data-runtime-mode="persistent">Keep model loaded</button>
                    <button id="warm-ideogram4-btn" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-white/5 text-secondary hover:bg-white/10 transition-all">Warm model</button>
                    <button id="unload-ideogram4-btn" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-all">Unload</button>
                </div>
                <p id="local-runtime-mode-note" class="text-xs text-muted">One-off frees RAM after each image. Keep loaded uses the loopback-only Apple Silicon MLX sidecar for faster follow-up images.</p>
            </div>

            <!-- Negative Prompt -->
            <div class="flex flex-col gap-2">
                <label class="text-xs font-bold text-secondary uppercase tracking-wider">${t('image.negPromptLabel')}</label>
                <input type="text" id="negative-prompt-input"
                    placeholder="${t('image.negPromptPlaceholder')}"
                    class="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm placeholder:text-muted focus:outline-none focus:border-primary/50 transition-colors">
            </div>
            
            <!-- Guidance Scale & Steps Row -->
            <div class="flex gap-4 flex-wrap">
                <div class="flex-1 min-w-[200px] flex flex-col gap-2">
                    <div class="flex items-center justify-between">
                        <label class="text-xs font-bold text-secondary uppercase tracking-wider">${t('image.guidanceScale')}</label>
                        <span id="guidance-value" class="text-xs font-bold text-primary">7.5</span>
                    </div>
                    <input type="range" id="guidance-slider" min="1" max="20" step="0.5" value="7.5" 
                        class="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-primary">
                </div>
                
                <div class="flex-1 min-w-[200px] flex flex-col gap-2">
                    <div class="flex items-center justify-between">
                        <label class="text-xs font-bold text-secondary uppercase tracking-wider">${t('image.steps')}</label>
                        <span id="steps-value" class="text-xs font-bold text-primary">25</span>
                    </div>
                    <input type="range" id="steps-slider" min="1" max="50" step="1" value="25" 
                        class="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-primary">
                </div>
            </div>
            
            <!-- Seed -->
            <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between">
                    <label class="text-xs font-bold text-secondary uppercase tracking-wider">${t('image.seed')}</label>
                    <button id="randomize-seed-btn" class="text-xs font-bold text-primary hover:text-primary/80 transition-colors">${t('common.randomize')}</button>
                </div>
                <input type="number" id="seed-input"
                    placeholder="${t('image.seedPlaceholder')}"
                    value="-1"
                    class="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm placeholder:text-muted focus:outline-none focus:border-primary/50 transition-colors">
            </div>
            
            <!-- Batch Count -->
            <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between">
                    <label class="text-xs font-bold text-secondary uppercase tracking-wider">${t('image.batchCount')}</label>
                    <span id="batch-value" class="text-xs font-bold text-primary">1</span>
                </div>
                <input type="range" id="batch-slider" min="1" max="4" step="1" value="1" 
                    class="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-primary">
            </div>
            
            <!-- Width & Height -->
            <div class="flex gap-4 flex-wrap">
                <div class="flex-1 min-w-[120px] flex flex-col gap-2">
                    <label class="text-xs font-bold text-secondary uppercase tracking-wider">${t('image.width')}</label>
                    <input type="number" id="width-input"
                        placeholder="${t('image.widthPlaceholder')}"
                        value=""
                        class="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm placeholder:text-muted focus:outline-none focus:border-primary/50 transition-colors">
                </div>
                <div class="flex-1 min-w-[120px] flex flex-col gap-2">
                    <label class="text-xs font-bold text-secondary uppercase tracking-wider">${t('image.height')}</label>
                    <input type="number" id="height-input"
                        placeholder="${t('image.heightPlaceholder')}"
                        value=""
                        class="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm placeholder:text-muted focus:outline-none focus:border-primary/50 transition-colors">
                </div>
            </div>
            
            <!-- Reference Strength (for I2I models) -->
            <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between">
                    <label class="text-xs font-bold text-secondary uppercase tracking-wider">${t('image.refStrength')}</label>
                    <span id="reference-strength-value" class="text-xs font-bold text-primary">50%</span>
                </div>
                <input type="range" id="reference-strength-slider" min="0" max="100" step="5" value="50" 
                    class="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-primary">
                <p class="text-xs text-muted">${t('image.refStrengthNote')}</p>
            </div>
            
            <!-- Model-aware LoRA Selection -->
            <div id="lora-selection-panel" class="flex flex-col gap-3 border-t border-white/5 pt-4">
                <div class="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <label class="text-xs font-bold text-secondary uppercase tracking-wider">LoRAs</label>
                        <p id="lora-base-models" class="text-xs text-muted mt-1">Choose a local workflow to see compatible LoRAs.</p>
                    </div>
                    <div class="ml-auto flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
                        <button id="download-lora-btn" type="button" title="Download LoRA from Civitai" class="inline-flex items-center gap-2 rounded-lg bg-white/5 px-3 py-1.5 text-xs font-bold text-secondary transition-colors hover:bg-white/10 hover:text-white">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
                            <span>Download LoRA</span>
                        </button>
                        <button id="clear-loras-btn" type="button" title="Unload all LoRAs" aria-label="Unload all LoRAs" class="hidden shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-all">Unload all</button>
                    </div>
                </div>
                <div id="selected-lora-list" class="hidden flex-col gap-2" aria-label="Selected LoRAs"></div>
                <div id="lora-catalog-status" class="rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 text-xs text-muted">LoRAs load automatically for the selected local workflow.</div>
                <div id="lora-card-grid" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3"></div>
            </div>
        </div>
    `;
    container.appendChild(advancedPanel);

    // Advanced panel toggle logic
    const toggleAdvanced = () => {
        showAdvanced = !showAdvanced;
        advancedPanel.classList.toggle('hidden', !showAdvanced);
        document.getElementById('advanced-btn-label').textContent = showAdvanced ? t('common.less') : t('common.advanced');
        if (showAdvanced) void loadLorasForCurrentModel();
    };
    
    // Add tools panel and advanced panel to container first before accessing their elements
    container.appendChild(toolsPanel);
    container.appendChild(advancedPanel);
    
    // Now set up event handlers after elements are in DOM
    advancedBtn.onclick = toggleAdvanced;
    const closeAdvBtn = advancedPanel.querySelector('#close-adv-btn');
    if (closeAdvBtn) closeAdvBtn.onclick = toggleAdvanced;

    const applyLocalModelDefaults = (model) => {
        if (!model) return;
        steps = Number(model.defaultSteps || steps);
        guidanceScale = Number(model.defaultGuidance ?? guidanceScale);
        const stepsSlider = advancedPanel.querySelector('#steps-slider');
        const stepsValue = advancedPanel.querySelector('#steps-value');
        const guidanceSlider = advancedPanel.querySelector('#guidance-slider');
        const guidanceValue = advancedPanel.querySelector('#guidance-value');
        if (stepsSlider) stepsSlider.value = String(steps);
        if (stepsValue) stepsValue.textContent = String(steps);
        if (guidanceSlider) guidanceSlider.value = String(guidanceScale);
        if (guidanceValue) guidanceValue.textContent = String(guidanceScale);
    };

    const updateLocalRuntimeModeUI = () => {
        const selected = localModelById(selectedLocalModel);
        const modes = selected?.runtimeModes || [];
        const panel = advancedPanel.querySelector('#local-runtime-mode-panel');
        if (panel) panel.classList.toggle('hidden', !useLocalModel || modes.length === 0);
        advancedPanel.querySelectorAll('.local-runtime-btn').forEach(btn => {
            const active = btn.dataset.runtimeMode === localRuntimeMode;
            btn.classList.toggle('bg-primary', active);
            btn.classList.toggle('text-black', active);
            btn.classList.toggle('bg-white/5', !active);
            btn.classList.toggle('text-secondary', !active);
        });
    };
    advancedPanel.querySelectorAll('.local-runtime-btn').forEach(btn => {
        btn.onclick = () => {
            localRuntimeMode = btn.dataset.runtimeMode || 'one-off';
            updateLocalRuntimeModeUI();
        };
    });
    const warmIdeogram4Btn = advancedPanel.querySelector('#warm-ideogram4-btn');
    if (warmIdeogram4Btn) {
        warmIdeogram4Btn.onclick = async () => {
            warmIdeogram4Btn.textContent = 'Warming…';
            warmIdeogram4Btn.disabled = true;
            try {
                await localAI.warmIdeogram4();
                warmIdeogram4Btn.textContent = 'Warm';
            } catch (e) {
                warmIdeogram4Btn.textContent = `Warm failed`;
                console.error('[Local] Ideogram warm failed:', e);
            } finally {
                setTimeout(() => { warmIdeogram4Btn.textContent = 'Warm model'; warmIdeogram4Btn.disabled = false; }, 2500);
            }
        };
    }
    const unloadIdeogram4Btn = advancedPanel.querySelector('#unload-ideogram4-btn');
    if (unloadIdeogram4Btn) {
        unloadIdeogram4Btn.onclick = async () => {
            unloadIdeogram4Btn.textContent = 'Unloading…';
            unloadIdeogram4Btn.disabled = true;
            try {
                await localAI.unloadIdeogram4();
                unloadIdeogram4Btn.textContent = 'Unloaded';
            } catch (e) {
                unloadIdeogram4Btn.textContent = 'Unload failed';
                console.error('[Local] Ideogram unload failed:', e);
            } finally {
                setTimeout(() => { unloadIdeogram4Btn.textContent = 'Unload'; unloadIdeogram4Btn.disabled = false; }, 2500);
            }
        };
    }
    updateLocalRuntimeModeUI();
    
    // Quick Tools Panel toggle
    const toggleTools = () => {
        showToolsPanel = !showToolsPanel;
        toolsPanel.classList.toggle('hidden', !showToolsPanel);
        if (showToolsPanel) {
            // Close advanced panel when opening tools
            if (!showAdvanced) {
                showAdvanced = true;
                advancedPanel.classList.remove('hidden');
            }
        }
        document.getElementById('tools-btn-label').textContent = showToolsPanel ? 'Tools' : 'Tools';
    };
    
    toolsBtn.onclick = toggleTools;
    const closeToolsBtn = toolsPanel.querySelector('#close-tools-btn');
    if (closeToolsBtn) closeToolsBtn.onclick = toggleTools;
    
    // Quick Starter buttons
    const quickStarterBtns = toolsPanel.querySelectorAll('.quick-starter-btn');
    quickStarterBtns.forEach(btn => {
        btn.onclick = () => {
            const prompt = btn.dataset.prompt;
            textarea.value = prompt;
            textarea.style.height = 'auto';
            const maxHeight = window.innerWidth < 768 ? 150 : 250;
            textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
            // Close tools panel after selection
            showToolsPanel = false;
            toolsPanel.classList.add('hidden');
        };
    });
    
    // Prompt Enhancer - selected tags state
    const enhanceSelectedTags = new Set();
    const basePromptInput = toolsPanel.querySelector('#base-prompt-input');
    const enhancedPromptDisplay = toolsPanel.querySelector('#enhanced-prompt-display');
    
    // Update enhanced prompt display
    const updateEnhancedPrompt = () => {
        const base = basePromptInput?.value?.trim() || '';
        const tags = Array.from(enhanceSelectedTags).join(', ');
        const enhanced = [base, tags].filter(p => p).join(', ');
        if (enhancedPromptDisplay) {
            enhancedPromptDisplay.textContent = enhanced || t('image.enhancedPlaceholder');
            enhancedPromptDisplay.classList.toggle('text-muted', !enhanced);
        }
    };
    
    // Base prompt input handler
    if (basePromptInput) {
        basePromptInput.oninput = updateEnhancedPrompt;
    }
    
    // Enhance tag buttons
    const enhanceTagBtns = toolsPanel.querySelectorAll('.enhance-tag-btn');
    enhanceTagBtns.forEach(btn => {
        btn.onclick = () => {
            const tag = btn.dataset.tag;
            if (enhanceSelectedTags.has(tag)) {
                enhanceSelectedTags.delete(tag);
                btn.classList.remove('bg-primary', 'text-black');
                btn.classList.add('bg-white/5', 'text-secondary');
            } else {
                enhanceSelectedTags.add(tag);
                btn.classList.remove('bg-white/5', 'text-secondary');
                btn.classList.add('bg-primary', 'text-black');
            }
            updateEnhancedPrompt();
        };
    });
    
    // Copy enhanced button
    const copyEnhancedBtn = toolsPanel.querySelector('#copy-enhanced-btn');
    if (copyEnhancedBtn) {
        copyEnhancedBtn.onclick = () => {
            const text = enhancedPromptDisplay?.textContent || '';
            if (text && text !== t('image.enhancedPlaceholder')) {
                navigator.clipboard.writeText(text);
                copyEnhancedBtn.textContent = t('common.copied');
                setTimeout(() => { copyEnhancedBtn.textContent = t('common.copy'); }, 1500);
            }
        };
    }
    
    // Use enhanced button
    const useEnhancedBtn = toolsPanel.querySelector('#use-enhanced-btn');
    if (useEnhancedBtn) {
        useEnhancedBtn.onclick = () => {
            const text = enhancedPromptDisplay?.textContent || '';
            if (text && text !== t('image.enhancedPlaceholder')) {
                textarea.value = text;
                textarea.style.height = 'auto';
                const maxHeight = window.innerWidth < 768 ? 150 : 250;
                textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
                // Close tools panel after use
                showToolsPanel = false;
                toolsPanel.classList.add('hidden');
            }
        };
    }
    
    // Negative prompt
    const negPromptInput = advancedPanel.querySelector('#negative-prompt-input');
    if (negPromptInput) negPromptInput.oninput = (e) => { negativePrompt = e.target.value; };

    const currentPromptHelper = () => useLocalModel ? localModelById(selectedLocalModel)?.promptHelper : null;
    const closePromptHelper = () => {
        promptHelperRequest += 1;
        promptHelperPanel.classList.add('hidden');
    };
    const updatePromptHelperUI = () => {
        const helper = currentPromptHelper();
        promptHelperBtn.classList.toggle('hidden', !helper);
        promptHelperBtn.classList.toggle('flex', Boolean(helper));
        const label = promptHelperBtn.querySelector('[data-prompt-helper-button-label]');
        if (label) label.textContent = helper?.label || 'Prompt helper';
        if (!helper) closePromptHelper();
    };

    promptHelperPanel.querySelector('[data-prompt-helper-dismiss]').onclick = closePromptHelper;
    promptHelperPanel.querySelector('[data-prompt-helper-use]').onclick = () => {
        const result = promptHelperPanel.querySelector('[data-prompt-helper-result]').value.trim();
        if (!result) return;
        textarea.value = result;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        const suggestedNegative = promptHelperPanel.dataset.negativePrompt || '';
        if (suggestedNegative) {
            negativePrompt = suggestedNegative;
            if (negPromptInput) negPromptInput.value = negativePrompt;
        }
        persistImagePreferences();
        closePromptHelper();
        textarea.focus();
    };
    promptHelperBtn.onclick = async (event) => {
        event.stopPropagation();
        const idea = textarea.value.trim();
        const helper = currentPromptHelper();
        const modelId = selectedLocalModel;
        if (!helper) return;
        if (!idea) {
            textarea.focus();
            return;
        }
        const request = ++promptHelperRequest;
        const resultInput = promptHelperPanel.querySelector('[data-prompt-helper-result]');
        const status = promptHelperPanel.querySelector('[data-prompt-helper-status]');
        const useButton = promptHelperPanel.querySelector('[data-prompt-helper-use]');
        const title = promptHelperPanel.querySelector('[data-prompt-helper-title]');
        promptHelperPanel.classList.remove('hidden');
        title.textContent = helper.label || 'Prompt helper';
        resultInput.value = '';
        resultInput.disabled = true;
        useButton.disabled = true;
        useButton.classList.add('opacity-50');
        status.textContent = 'Refining prompt…';
        promptHelperBtn.disabled = true;
        try {
            const sourceImage = uploadedImageUrls[0] || '';
            const result = await localAI.generatePrompt({
                model: modelId,
                idea,
                negative_prompt: negativePrompt || undefined,
                seed,
                active_loras: loraGenerationPayload(currentLoraSelection()),
                ...(sourceImage.startsWith('data:image/') ? { reference_image: sourceImage } : {}),
            });
            if (request !== promptHelperRequest || modelId !== selectedLocalModel) return;
            const refined = String(result?.prompt || '').trim();
            if (!refined) throw new Error('Prompt helper returned no prompt');
            resultInput.value = refined;
            promptHelperPanel.dataset.negativePrompt = String(result?.negative_prompt || '');
            status.textContent = String(result?.title || 'Ready');
            resultInput.disabled = false;
            useButton.disabled = false;
            useButton.classList.remove('opacity-50');
        } catch (error) {
            if (request !== promptHelperRequest) return;
            status.textContent = error.message;
            resultInput.disabled = false;
        } finally {
            if (request === promptHelperRequest) promptHelperBtn.disabled = false;
        }
    };
    updatePromptHelperUI();
    
    // Guidance scale slider
    const guidanceSlider = advancedPanel.querySelector('#guidance-slider');
    const guidanceValue = advancedPanel.querySelector('#guidance-value');
    if (guidanceSlider && guidanceValue) {
        guidanceSlider.oninput = (e) => {
            guidanceScale = parseFloat(e.target.value);
            guidanceValue.textContent = guidanceScale;
        };
    }
    
    // Steps slider
    const stepsSlider = advancedPanel.querySelector('#steps-slider');
    const stepsValue = advancedPanel.querySelector('#steps-value');
    if (stepsSlider && stepsValue) {
        stepsSlider.oninput = (e) => {
            steps = parseInt(e.target.value);
            stepsValue.textContent = steps;
        };
    }
    
    // Seed input
    const seedInput = advancedPanel.querySelector('#seed-input');
    if (seedInput) seedInput.oninput = (e) => { seed = parseInt(e.target.value) || -1; };
    
    // Randomize seed button
    const randSeedBtn = advancedPanel.querySelector('#randomize-seed-btn');
    if (randSeedBtn) {
        randSeedBtn.onclick = () => {
            seed = Math.floor(Math.random() * 999999999);
            if (seedInput) seedInput.value = seed;
        };
    }
    
    // Batch count slider
    const batchSlider = advancedPanel.querySelector('#batch-slider');
    const batchValueEl = advancedPanel.querySelector('#batch-value');
    if (batchSlider && batchValueEl) {
        batchSlider.oninput = (e) => {
            batchCount = parseInt(e.target.value);
            batchValueEl.textContent = batchCount;
        };
    }
    
    // Width input
    const widthInput = advancedPanel.querySelector('#width-input');
    if (widthInput) {
        widthInput.oninput = (e) => {
            customWidth = parseInt(e.target.value) || 0;
        };
    }
    
    // Height input
    const heightInput = advancedPanel.querySelector('#height-input');
    if (heightInput) {
        heightInput.oninput = (e) => {
            customHeight = parseInt(e.target.value) || 0;
        };
    }
    
    // Reference strength slider
    const refStrengthSlider = advancedPanel.querySelector('#reference-strength-slider');
    const refStrengthValue = advancedPanel.querySelector('#reference-strength-value');
    if (refStrengthSlider && refStrengthValue) {
        refStrengthSlider.oninput = (e) => {
            referenceStrength = parseInt(e.target.value);
            refStrengthValue.textContent = referenceStrength + '%';
        };
    }
    
    const currentLoraModel = () => useLocalModel ? localModelById(selectedLocalModel) : null;
    const currentLoraSelection = () => loraSelectionsByModel.get(currentLoraModel()?.id) || [];
    const setCurrentLoraSelection = (selection) => {
        const model = currentLoraModel();
        if (!model) return;
        loraSelectionsByModel.set(model.id, selection);
    };

    const createLoraPreview = (lora, className) => {
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
            image.onload = () => { fallback.classList.add('hidden'); };
            image.onerror = () => { image.remove(); };
            media.appendChild(image);
        }
        return media;
    };

    const renderSelectedLoras = () => {
        const list = advancedPanel.querySelector('#selected-lora-list');
        const clearButton = advancedPanel.querySelector('#clear-loras-btn');
        const selection = currentLoraSelection();
        list.replaceChildren();
        list.classList.toggle('hidden', selection.length === 0);
        list.classList.toggle('flex', selection.length > 0);
        clearButton.classList.toggle('hidden', selection.length === 0);
        selection.forEach((lora) => {
            const row = document.createElement('div');
            row.className = 'grid grid-cols-[42px_minmax(0,1fr)_76px_34px] items-center gap-3 rounded-xl border border-primary/20 bg-primary/[0.06] p-2';
            row.appendChild(createLoraPreview(lora, 'w-[42px] h-[42px] rounded-lg'));

            const copy = document.createElement('div');
            copy.className = 'min-w-0';
            const name = document.createElement('div');
            name.className = 'truncate text-xs font-bold text-white';
            name.textContent = lora.displayName || lora.name;
            const file = document.createElement('div');
            file.className = 'truncate text-[10px] text-muted';
            file.textContent = lora.name;
            copy.append(name, file);
            row.appendChild(copy);

            const weight = document.createElement('input');
            weight.type = 'number';
            weight.min = '-10';
            weight.max = '10';
            weight.step = '0.05';
            weight.value = String(lora.strength ?? 1);
            weight.title = `Weight for ${lora.displayName || lora.name}`;
            weight.setAttribute('aria-label', `Weight for ${lora.displayName || lora.name}`);
            weight.className = 'w-full rounded-lg border border-white/10 bg-black/20 px-2 py-2 text-center text-xs font-bold text-white focus:outline-none focus:border-primary/50';
            weight.oninput = () => setCurrentLoraSelection(updateLoraStrength(currentLoraSelection(), lora.id, weight.value));
            weight.onchange = () => {
                setCurrentLoraSelection(updateLoraStrength(currentLoraSelection(), lora.id, weight.value));
                renderSelectedLoras();
            };
            row.appendChild(weight);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.title = `Unload ${lora.displayName || lora.name}`;
            remove.setAttribute('aria-label', remove.title);
            remove.className = 'w-[34px] h-[34px] rounded-lg bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors text-lg leading-none';
            remove.textContent = '×';
            remove.onclick = () => {
                setCurrentLoraSelection(currentLoraSelection().filter(item => item.id !== lora.id));
                renderSelectedLoras();
                renderLoraCatalog();
            };
            row.appendChild(remove);
            list.appendChild(row);
        });
    };

    const renderLoraCatalog = () => {
        const grid = advancedPanel.querySelector('#lora-card-grid');
        const status = advancedPanel.querySelector('#lora-catalog-status');
        grid.replaceChildren();
        status.dataset.state = loraCatalogStatus;
        status.textContent = loraCatalogMessage;
        status.classList.toggle('hidden', !loraCatalogMessage);
        const selectedIds = new Set(currentLoraSelection().map(item => item.id));
        availableLoras.forEach((lora) => {
            const selected = selectedIds.has(lora.id);
            const card = document.createElement('button');
            card.type = 'button';
            card.dataset.loraId = lora.id;
            card.setAttribute('aria-pressed', String(selected));
            card.title = selected ? `Unload ${lora.displayName}` : `Use ${lora.displayName}`;
            card.className = `relative min-w-0 overflow-hidden rounded-xl border text-left transition-all ${selected ? 'border-primary bg-primary/10 shadow-[0_0_0_1px_rgba(34,211,238,.18)]' : 'border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.06]'}`;
            card.appendChild(createLoraPreview(lora, 'w-full aspect-[4/3]'));

            const body = document.createElement('div');
            body.className = 'p-2.5';
            const name = document.createElement('div');
            name.className = 'truncate text-xs font-bold text-white';
            name.textContent = lora.displayName || lora.name;
            const base = document.createElement('div');
            base.className = 'mt-1 truncate text-[10px] text-muted';
            base.textContent = lora.triggerWords?.[0] || lora.baseModel;
            body.append(name, base);
            card.appendChild(body);

            const marker = document.createElement('span');
            marker.className = `absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full border text-sm font-black backdrop-blur ${selected ? 'border-primary bg-primary text-black' : 'border-white/15 bg-black/55 text-white'}`;
            marker.textContent = selected ? '✓' : '+';
            card.appendChild(marker);
            card.onclick = () => {
                setCurrentLoraSelection(toggleLoraSelection(currentLoraSelection(), lora));
                renderSelectedLoras();
                renderLoraCatalog();
            };
            grid.appendChild(card);
        });
        renderSelectedLoras();
    };

    const loadLorasForCurrentModel = async () => {
        const baseLabel = advancedPanel.querySelector('#lora-base-models');
        const model = currentLoraModel();
        const request = ++loraCatalogRequest;
        availableLoras = [];
        if (!model) {
            loraCatalogStatus = 'unavailable';
            loraCatalogMessage = 'Installed LoRAs are available when Local is selected.';
            baseLabel.textContent = 'Choose a local workflow to see compatible LoRAs.';
            renderLoraCatalog();
            return;
        }
        loraCatalogStatus = 'loading';
        loraCatalogMessage = `Loading LoRAs for ${model.name}…`;
        baseLabel.textContent = model.name;
        renderLoraCatalog();
        try {
            const data = await localAI.listLoras(model.id);
            if (request !== loraCatalogRequest) return;
            availableLoras = Array.isArray(data?.loras) ? data.loras : [];
            const bases = Array.isArray(data?.baseModels) ? data.baseModels : [];
            baseLabel.textContent = data?.supported === false
                ? `${model.name} does not expose an add-on LoRA path.`
                : `${model.name} · ${bases.join(', ') || 'compatible local adapters'}`;
            loraCatalogStatus = data?.supported === false ? 'unsupported' : 'ready';
            loraCatalogMessage = data?.supported === false
                ? 'This workflow does not support add-on LoRAs.'
                : availableLoras.length
                    ? `${availableLoras.length} compatible LoRA${availableLoras.length === 1 ? '' : 's'} installed. Tap a card to load it.`
                    : 'No compatible LoRAs are installed for this workflow.';
        } catch (error) {
            if (request !== loraCatalogRequest) return;
            loraCatalogStatus = 'error';
            loraCatalogMessage = `Unable to load LoRAs: ${error.message}`;
        }
        renderLoraCatalog();
    };

    advancedPanel.querySelector('#clear-loras-btn').onclick = () => {
        setCurrentLoraSelection([]);
        renderSelectedLoras();
        renderLoraCatalog();
    };
    const civitaiDownloadDialog = createCivitaiDownloadDialog({
        api: localAI,
        onComplete: () => loadLorasForCurrentModel(),
    });
    advancedPanel.querySelector('#download-lora-btn').onclick = () => civitaiDownloadDialog.open();
    renderLoraCatalog();
    
    // Style preset handlers
    advancedPanel.querySelectorAll('.style-preset-btn').forEach(btn => {
        btn.onclick = () => {
            selectedStyle = btn.dataset.style;
            advancedPanel.querySelectorAll('.style-preset-btn').forEach(b => {
                b.classList.remove('bg-primary/20', 'text-primary', 'border-primary/30');
                b.classList.add('bg-white/5', 'text-secondary');
            });
            btn.classList.add('bg-primary/20', 'text-primary', 'border-primary/30');
            btn.classList.remove('bg-white/5', 'text-secondary');
        };
    });

    const restoreImagePreferenceControls = () => {
        if (negPromptInput) negPromptInput.value = negativePrompt;
        if (guidanceSlider) guidanceSlider.value = String(guidanceScale);
        if (guidanceValue) guidanceValue.textContent = String(guidanceScale);
        if (stepsSlider) stepsSlider.value = String(steps);
        if (stepsValue) stepsValue.textContent = String(steps);
        if (seedInput) seedInput.value = String(seed);
        if (batchSlider) batchSlider.value = String(batchCount);
        if (batchValueEl) batchValueEl.textContent = String(batchCount);
        if (widthInput) widthInput.value = customWidth ? String(customWidth) : '';
        if (heightInput) heightInput.value = customHeight ? String(customHeight) : '';
        if (refStrengthSlider) refStrengthSlider.value = String(referenceStrength);
        if (refStrengthValue) refStrengthValue.textContent = `${referenceStrength}%`;
        advancedPanel.querySelectorAll('.style-preset-btn').forEach((btn) => {
            const active = btn.dataset.style === selectedStyle;
            btn.classList.toggle('bg-primary/20', active);
            btn.classList.toggle('text-primary', active);
            btn.classList.toggle('border-primary/30', active);
            btn.classList.toggle('bg-white/5', !active);
            btn.classList.toggle('text-secondary', !active);
        });
        updateLocalRuntimeModeUI();
    };
    restoreImagePreferenceControls();

    // Restore a model's saved advanced settings when it's reselected; fall
    // back to the model's own defaults the first time it's used.
    const applyStoredModelSettings = (key, fallbackLocalModel) => {
        const stored = modelSettingsById.get(key);
        if (!stored) {
            if (fallbackLocalModel) applyLocalModelDefaults(fallbackLocalModel);
            return false;
        }
        steps = stored.steps;
        guidanceScale = stored.guidanceScale;
        negativePrompt = stored.negativePrompt;
        customWidth = stored.customWidth;
        customHeight = stored.customHeight;
        coupleMode = Boolean(stored.coupleMode);
        coupleDirection = stored.coupleDirection === 'vertical' ? 'vertical' : 'horizontal';
        coupleSplit = stored.coupleSplit ?? coupleSplit;
        couplePair = stored.couplePair || couplePair;
        if (useLocalModel) {
            const modes = fallbackLocalModel?.runtimeModes || localModelById(selectedLocalModel)?.runtimeModes || [];
            if (stored.localRuntimeMode && (modes.length === 0 || modes.includes(stored.localRuntimeMode))) {
                localRuntimeMode = stored.localRuntimeMode;
            }
        }
        const validArs = useLocalModel
            ? (fallbackLocalModel?.aspectRatios || localModelById(selectedLocalModel)?.aspectRatios || [])
            : getCurrentAspectRatios(selectedModel);
        if (stored.aspectRatio && validArs.includes(stored.aspectRatio)) selectedAr = stored.aspectRatio;
        if (!useLocalModel && stored.resolution && getCurrentResolutions(selectedModel).includes(stored.resolution)) {
            selectedResolution = stored.resolution;
        }
        restoreImagePreferenceControls();
        updateCoupleUI();
        const arLabel = document.getElementById('ar-btn-label');
        if (arLabel) arLabel.textContent = selectedAr;
        return true;
    };

    // ── Capture / restore a generation's full setup (prompt + every control) ──────
    // Parity with the Video studio via the shared contextStore, so a past image can be
    // reopened with its exact prompt, model, aspect ratio, advanced params, LoRAs and
    // reference images. Contexts are session-scoped (see lib/generationContext.js).
    const captureImageContext = (prompt) => ({
        prompt,
        imageMode,
        useLocalModel,
        selectedModel,
        selectedModelName,
        selectedLocalModel,
        localRuntimeMode,
        aspectRatio: selectedAr,
        resolution: selectedResolution,
        negativePrompt,
        guidanceScale,
        steps,
        seed,
        style: selectedStyle,
        batchCount,
        customWidth,
        customHeight,
        referenceStrength,
        loras: currentLoraSelection().map((lora) => ({ ...lora })),
        referenceImages: [...uploadedImageUrls],
    });

    const restoreImageContext = (context) => {
        if (!context) return false;

        imageMode = Boolean(context.imageMode);
        useLocalModel = Boolean(context.useLocalModel) && isLocalAIAvailable();

        // Any cloud model is valid regardless of restored reference state.
        const models = [...t2iModels, ...i2iModels];
        const model = models.find((m) => m.id === context.selectedModel) || t2iModels[0];
        if (!model) return false;
        selectedModel = model.id;
        selectedModelName = context.selectedModelName || model.name;
        if (useLocalModel) {
            selectedLocalModel = context.selectedLocalModel || selectedLocalModel;
            localRuntimeMode = context.localRuntimeMode || localRuntimeMode || 'one-off';
        }

        // Scalar params.
        selectedAr = context.aspectRatio || selectedAr;
        selectedResolution = context.resolution ?? selectedResolution;
        negativePrompt = context.negativePrompt || '';
        guidanceScale = context.guidanceScale ?? guidanceScale;
        steps = context.steps ?? steps;
        seed = context.seed ?? seed;
        selectedStyle = STYLE_PRESETS.includes(context.style) ? context.style : selectedStyle;
        batchCount = context.batchCount ?? batchCount;
        customWidth = context.customWidth ?? customWidth;
        customHeight = context.customHeight ?? customHeight;
        referenceStrength = context.referenceStrength ?? referenceStrength;

        // Reference images — restore silently so the picker doesn't re-run upload side effects.
        const maxRefs = imageMode ? getMaxImagesForI2IModel(selectedModel) : 1;
        picker.setMaxImages(maxRefs);
        const refs = Array.isArray(context.referenceImages) ? context.referenceImages.filter(Boolean) : [];
        if (refs.length) {
            picker.setImages(refs);
            uploadedImageUrls = picker.getSelectedUrls();
        } else {
            picker.reset();
            uploadedImageUrls = [];
        }
        // Image mode is only real when references actually restored — a bare
        // flag with an empty picker is the ghost state this guards against.
        if (imageMode && uploadedImageUrls.length === 0) {
            imageMode = false;
            const fallback = t2iModels.find((m) => m.id === context.selectedModel) || t2iModels[0];
            selectedModel = fallback.id;
            selectedModelName = fallback.name;
        }
        updateUploadTriggerState();
        updateCoupleUI();

        // LoRA selection (only meaningful for local workflows).
        const loraModel = useLocalModel ? localModelById(selectedLocalModel) : null;
        if (loraModel && Array.isArray(context.loras)) {
            loraSelectionsByModel.set(loraModel.id, context.loras.map((lora) => ({ ...lora })));
        }

        // Reflect everything in the UI.
        updateLocalToggleStyle();
        const modelLabel = document.getElementById('model-btn-label');
        if (modelLabel) modelLabel.textContent = useLocalModel ? (loraModel?.name || selectedModelName) : selectedModelName;
        const arLabel = document.getElementById('ar-btn-label');
        if (arLabel) arLabel.textContent = selectedAr;
        if (useLocalModel) {
            qualityBtn.style.display = 'none';
        } else {
            const resolutions = getCurrentResolutions(selectedModel);
            qualityBtn.style.display = resolutions.length > 0 ? 'flex' : 'none';
            if (resolutions.length > 0) {
                if (!resolutions.includes(selectedResolution)) selectedResolution = resolutions[0];
                const qLabel = document.getElementById('quality-btn-label');
                if (qLabel) qLabel.textContent = selectedResolution;
            }
        }

        restoreImagePreferenceControls();
        updateLocalRuntimeModeUI();
        updatePromptHelperUI();
        void loadLorasForCurrentModel();

        textarea.value = context.prompt || '';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.placeholder = imageMode ? t('image.placeholderTransform') : t('image.placeholder');

        persistImagePreferences();
        return true;
    };

    // ==========================================
    // 3. DROPDOWNS (Professional implementation)
    // ==========================================
    const dropdown = document.createElement('div');
    dropdown.className = 'absolute bottom-[102%] left-2 z-50 transition-all opacity-0 pointer-events-none scale-95 origin-bottom-left glass rounded-3xl p-3 translate-y-2 w-[calc(100vw-3rem)] max-w-xs shadow-4xl border border-white/10 flex flex-col';

    const showDropdown = (type, anchorBtn) => {
        dropdown.innerHTML = '';
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
                            <input type="text" id="model-search" placeholder="${t('common.searchModels')}" class="bg-transparent border-none text-xs text-white focus:ring-0 w-full p-0">
                        </div>
                    </div>
                    <div class="text-[10px] font-bold text-secondary uppercase tracking-widest px-3 py-2 shrink-0">Available models</div>
                    <div id="model-list-container" class="flex flex-col gap-1.5 overflow-y-auto custom-scrollbar pr-1 pb-2"></div>
                </div>
            `;
            const list = dropdown.querySelector('#model-list-container');

            const renderModels = (filter = '') => {
                list.innerHTML = '';

                if (useLocalModel) {
                    // ── Runtime-discovered, launchable local image workflows ──
                    const filtered = compatibleLocalModels().filter(m =>
                        m.name.toLowerCase().includes(filter.toLowerCase()) ||
                        m.id.toLowerCase().includes(filter.toLowerCase())
                    );
                    if (filtered.length === 0) {
                        list.innerHTML = `<div class="text-xs text-muted text-center py-4">${t('common.noResults')}</div>`;
                        return;
                    }
                    filtered.forEach(m => {
                        const item = document.createElement('div');
                        item.className = `flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all border border-transparent hover:border-white/5 ${selectedLocalModel === m.id ? 'bg-white/5 border-white/5' : ''}`;
                        item.innerHTML = `
                            <div class="flex items-center gap-3.5">
                                <div class="w-10 h-10 ${m.featured ? 'bg-primary/10 text-primary' : 'bg-green-500/10 text-green-400'} border border-white/5 rounded-xl flex items-center justify-center font-black text-sm shadow-inner uppercase">${m.featured ? '⚡' : m.name.charAt(0)}</div>
                                <div class="flex flex-col gap-0.5">
                                    <div class="flex items-center gap-1.5">
                                        <span class="text-xs font-bold text-white tracking-tight">${m.name}</span>
                                        ${m.featured ? '<span class="text-[9px] font-black px-1 py-0.5 rounded bg-primary/20 text-primary">FEATURED</span>' : ''}
                                        ${m.requires?.image ? '<span class="text-[9px] font-black px-1 py-0.5 rounded bg-amber-400/10 text-amber-300">IMAGE REQUIRED</span>' : ''}
                                    </div>
                                    <span class="text-[10px] text-muted">${String(m.type || 'image').toUpperCase()} · ${m.family || 'local'}</span>
                                </div>
                            </div>
                            ${selectedLocalModel === m.id ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                        `;
                        item.onclick = (e) => {
                            e.stopPropagation();
                            snapshotCurrentModelSettings();
                            selectedLocalModel = m.id;
                            localRuntimeMode = m.defaultRuntimeMode || 'one-off';
                            selectedAr = m.aspectRatios?.[0] || '1:1';
                            selectedResolution = '';
                            applyStoredModelSettings(`local:${m.id}`, m);
                            updateLocalRuntimeModeUI();
                            document.getElementById('model-btn-label').textContent = m.name;
                            document.getElementById('ar-btn-label').textContent = selectedAr;
                            qualityBtn.style.display = 'none';
                            updatePromptHelperUI();
                            void loadLorasForCurrentModel();
                            updateUploadTriggerState();
                            updateCoupleUI();
                            closeDropdown();
                        };
                        list.appendChild(item);
                    });
                    return;
                }

                // ── Remote (API) model list — one dropdown, two labeled ──────
                // sections; models are never hidden because of references.
                const query = filter.toLowerCase();
                const matches = (m) => m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query);
                const hasRefs = uploadedImageUrls.length > 0;
                const sections = [
                    {
                        label: hasRefs ? 'Text to image — ignores your reference' : 'Text to image',
                        models: t2iModels.filter(matches),
                        editing: false,
                    },
                    {
                        label: hasRefs ? 'Image editing — uses your reference' : 'Image editing — works with a reference image',
                        models: i2iModels.filter(matches),
                        editing: true,
                    },
                ];
                if (hasRefs) sections.reverse();
                if (!sections.some((section) => section.models.length)) {
                    list.innerHTML = `<div class="text-xs text-muted text-center py-4">${t('common.noResults')}</div>`;
                    return;
                }
                sections.forEach((section) => {
                    if (!section.models.length) return;
                    const heading = document.createElement('div');
                    heading.className = 'px-3 pt-3 pb-1.5 text-[10px] font-bold uppercase tracking-widest text-muted';
                    heading.textContent = section.label;
                    list.appendChild(heading);
                    section.models.forEach(m => {
                        const requiresImage = section.editing && apiModelRequiresImage(m.id);
                        const item = document.createElement('div');
                        item.className = `flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all border border-transparent hover:border-white/5 ${selectedModel === m.id ? 'bg-white/5 border-white/5' : ''}`;
                        item.innerHTML = `
                            <div class="flex items-center gap-3.5">
                                 <div class="w-10 h-10 ${m.family === 'kontext' ? 'bg-blue-500/10 text-blue-400' : m.family === 'effects' ? 'bg-purple-500/10 text-purple-400' : 'bg-primary/10 text-primary'} border border-white/5 rounded-xl flex items-center justify-center font-black text-sm shadow-inner uppercase">${m.name.charAt(0)}</div>
                                 <div class="flex flex-col gap-0.5">
                                    <div class="flex items-center gap-1.5">
                                        <span class="text-xs font-bold text-white tracking-tight">${m.name}</span>
                                        ${requiresImage ? '<span class="text-[9px] font-black px-1 py-0.5 rounded bg-amber-400/10 text-amber-300">IMAGE REQUIRED</span>' : section.editing ? '<span class="text-[9px] font-black px-1 py-0.5 rounded bg-primary/15 text-primary">IMAGE</span>' : ''}
                                    </div>
                                 </div>
                            </div>
                            ${selectedModel === m.id ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                        `;
                        item.onclick = (e) => {
                            e.stopPropagation();
                            snapshotCurrentModelSettings();
                            selectedModel = m.id;
                            selectedModelName = m.name;
                            document.getElementById('model-btn-label').textContent = selectedModelName;
                            const availableArs = getCurrentAspectRatios(selectedModel);
                            selectedAr = availableArs.includes(selectedAr) ? selectedAr : (availableArs[0] || '1:1');
                            document.getElementById('ar-btn-label').textContent = selectedAr;
                            applyStoredModelSettings(`api:${m.id}`);
                            refreshModelConfigControls();
                            updateUploadTriggerState();
                            updatePromptHelperUI();
                            void loadLorasForCurrentModel();
                            closeDropdown();
                        };
                        list.appendChild(item);
                    });
                });
            };

            renderModels();

            const searchInput = dropdown.querySelector('#model-search');
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
                    document.getElementById('ar-btn-label').textContent = r;
                    persistImagePreferences();
                    closeDropdown();
                };
                list.appendChild(item);
            });
            dropdown.appendChild(list);
        } else if (type === 'quality') {
            dropdown.classList.add('max-w-[200px]');
            dropdown.innerHTML = `<div class="text-[10px] font-bold text-secondary uppercase tracking-widest px-3 py-2 border-b border-white/5 mb-2">Resolution</div>`;
            const list = document.createElement('div');
            list.className = 'flex flex-col gap-1';

            const options = getCurrentResolutions(selectedModel);

            options.forEach(opt => {
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all group';
                item.innerHTML = `
                    <span class="text-xs font-bold text-white opacity-80 group-hover:opacity-100">${opt}</span>
                     ${selectedResolution === opt ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
                `;
                item.onclick = (e) => {
                    e.stopPropagation();
                    selectedResolution = opt;
                    document.getElementById('quality-btn-label').textContent = opt;
                    persistImagePreferences();
                    closeDropdown();
                };
                list.appendChild(item);
            });
            dropdown.appendChild(list);
        }

        // Position dropdown
        const btnRect = anchorBtn.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        // Horizontal position
        if (window.innerWidth < 768) {
            // Center on mobile
            dropdown.style.left = '50%';
            dropdown.style.transform = 'translateX(-50%) translate(0, 8px)';
        } else {
            // Align with button on desktop
            dropdown.style.left = `${btnRect.left - containerRect.left}px`;
            dropdown.style.transform = 'translate(0, 8px)';
        }

        // Vertical position (always above button)
        dropdown.style.bottom = `${containerRect.bottom - btnRect.top + 8}px`;
        // The panel grows upward, so cap it to the space between the studio
        // area's top edge (below the app header) and the anchor, and scroll
        // instead of letting long model lists overflow the viewport top.
        dropdown.style.maxHeight = `${Math.max(180, Math.round(btnRect.top - Math.max(0, containerRect.top)) - 24)}px`;
        dropdown.classList.remove('overflow-y-auto', 'custom-scrollbar');
        if (type !== 'model') dropdown.classList.add('overflow-y-auto', 'custom-scrollbar');
    };

    const closeDropdown = () => {
        dropdown.classList.add('opacity-0', 'pointer-events-none');
        dropdown.classList.remove('opacity-100', 'pointer-events-auto');
        dropdownOpen = null;
    };

    modelBtn.onclick = (e) => {
        e.stopPropagation();
        if (dropdownOpen === 'model') closeDropdown();
        else {
            dropdownOpen = 'model';
            showDropdown('model', modelBtn);
        }
    };

    arBtn.onclick = (e) => {
        e.stopPropagation();
        if (dropdownOpen === 'ar') closeDropdown();
        else {
            dropdownOpen = 'ar';
            showDropdown('ar', arBtn);
        }
    };

    qualityBtn.onclick = (e) => {
        e.stopPropagation();
        if (dropdownOpen === 'quality') closeDropdown();
        else {
            dropdownOpen = 'quality';
            showDropdown('quality', qualityBtn);
        }
    };

    window.onclick = () => closeDropdown();
    container.appendChild(dropdown);

    // ==========================================
    // 4. CANVAS AREA + HISTORY
    // ==========================================
    const generationHistory = [];

    // History sidebar
    const historySidebar = document.createElement('div');
    historySidebar.className = 'fixed right-0 top-[100px] h-[calc(100%-100px)] lg:top-14 lg:h-[calc(100%-3.5rem)] w-20 md:w-24 bg-panel-bg/75 backdrop-blur-xl border-l border-white/[0.06] z-40 flex flex-col items-center py-4 gap-3 overflow-y-auto transition-all duration-500 translate-x-full opacity-0';
    historySidebar.id = 'history-sidebar';

    const historyLabel = document.createElement('div');
    historyLabel.className = 'text-[9px] font-bold text-muted uppercase tracking-widest mb-2 rotate-0';
    historyLabel.textContent = t('common.history');
    historySidebar.appendChild(historyLabel);

    const historyList = document.createElement('div');
    historyList.className = 'flex flex-col gap-2 w-full px-2';
    historySidebar.appendChild(historyList);

    container.appendChild(historySidebar);

    // Main canvas
    const canvas = document.createElement('div');
    canvas.className = 'absolute inset-0 flex flex-col items-center justify-center p-4 min-[800px]:p-16 z-10 opacity-0 pointer-events-none transition-all duration-1000 translate-y-10 scale-95';

    const imageContainer = document.createElement('div');
    imageContainer.className = 'relative group';

    const resultImg = document.createElement('img');
    resultImg.className = 'max-h-[60vh] max-w-[80vw] rounded-3xl shadow-3xl border border-white/10 interactive-glow object-contain';
    imageContainer.appendChild(resultImg);

    // Plain close: back to the prompt bar exactly as the user left it — no
    // context restore, no clearing. "Back to setup"/"+ New" stay the explicit
    // state-changing exits.
    const closeCanvasBtn = document.createElement('button');
    closeCanvasBtn.type = 'button';
    closeCanvasBtn.title = 'Close';
    closeCanvasBtn.setAttribute('aria-label', 'Close expanded image');
    closeCanvasBtn.className = 'absolute -right-3 -top-3 z-20 grid h-9 w-9 place-items-center rounded-full border border-white/15 bg-black/70 text-lg text-white/80 shadow-xl backdrop-blur transition-colors hover:bg-black/90 hover:text-white';
    closeCanvasBtn.textContent = '×';
    imageContainer.appendChild(closeCanvasBtn);

    // Canvas Controls
    const canvasControls = document.createElement('div');
    canvasControls.className = 'mt-6 flex gap-3 opacity-0 transition-opacity delay-500 duration-500 justify-center';

    const backToSetupBtn = document.createElement('button');
    backToSetupBtn.className = 'bg-white/10 hover:bg-white/20 px-4 py-2.5 rounded-2xl text-xs font-bold transition-all border border-white/5 backdrop-blur-lg text-white';
    backToSetupBtn.textContent = t('common.backToSetup');
    backToSetupBtn.title = t('common.backToSetup');

    const regenerateBtn = document.createElement('button');
    regenerateBtn.className = 'bg-white/10 hover:bg-white/20 px-6 py-2.5 rounded-2xl text-xs font-bold transition-all border border-white/5 backdrop-blur-lg text-white';
    regenerateBtn.textContent = t('common.regenerate');

    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'bg-primary text-black px-6 py-2.5 rounded-2xl text-xs font-bold transition-all shadow-glow active:scale-95';
    downloadBtn.textContent = t('common.download');

    const newPromptBtn = document.createElement('button');
    newPromptBtn.className = 'bg-white/10 hover:bg-white/20 px-6 py-2.5 rounded-2xl text-xs font-bold transition-all border border-white/5 backdrop-blur-lg text-white';
    newPromptBtn.textContent = t('common.newItem');

    canvasControls.appendChild(backToSetupBtn);
    canvasControls.appendChild(regenerateBtn);
    canvasControls.appendChild(downloadBtn);
    canvasControls.appendChild(newPromptBtn);

    canvas.appendChild(imageContainer);
    canvas.appendChild(canvasControls);
    container.appendChild(canvas);

    closeCanvasBtn.onclick = (event) => {
        event.stopPropagation();
        resetToPromptBar();
        textarea.focus();
    };
    // Clicking the backdrop (not the image or its controls) also closes.
    canvas.addEventListener('click', (event) => {
        if (event.target === canvas) {
            resetToPromptBar();
            textarea.focus();
        }
    });

    // --- Helper: Show image in canvas ---
    const showImageInCanvas = (imageUrl) => {
        // Fully hide hero and prompt
        hero.classList.add('hidden');
        promptWrapper.classList.add('hidden');

        // Track the setup behind the on-screen image so "Back to setup"/"Regenerate" can
        // restore it (resolved from the shared store by output URL).
        contextStore.view(imageUrl);

        // E2E media resolves to a decrypted blob URL in-page; legacy plaintext
        // passes through untouched (resolveMediaSrc is fail-open). Resolve BEFORE
        // assigning src so we never flash the sealed envelope into the <img>.
        resultImg.onload = () => {
            canvas.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-10', 'scale-95');
            canvas.classList.add('opacity-100', 'translate-y-0', 'scale-100');
            canvasControls.classList.remove('opacity-0');
            canvasControls.classList.add('opacity-100');
        };
        void resolveMediaSrc(imageUrl).then((resolved) => { resultImg.src = resolved; });
    };

    // --- Helper: Reset the view back to the prompt bar (no state wiped) ---
    const resetToPromptBar = () => {
        canvas.classList.add('opacity-0', 'pointer-events-none', 'translate-y-10', 'scale-95');
        canvas.classList.remove('opacity-100', 'translate-y-0', 'scale-100');
        canvasControls.classList.add('opacity-0');
        canvasControls.classList.remove('opacity-100');
        hero.classList.remove('hidden', 'opacity-0', 'scale-95', '-translate-y-10', 'pointer-events-none');
        promptWrapper.classList.remove('hidden', 'opacity-0', 'opacity-40', 'pointer-events-none');
    };

    // --- Helper: Add to history ---
    const addToHistory = (entry, generationContext = null) => {
        if (generationContext && entry?.url) contextStore.remember(entry.url, generationContext);
        generationHistory.unshift(entry);

        saveStudioGenerationHistory('muapi_history', generationHistory, 50);

        // Show sidebar
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
                <img alt="${entry.prompt?.substring(0, 30) || 'Generated'}" class="w-full aspect-square object-cover">
                <div class="absolute inset-0 bg-black/60 opacity-0 group-hover/thumb:opacity-100 transition-opacity flex items-center justify-center gap-1">
                    <button class="hist-download p-1.5 bg-primary rounded-lg text-black hover:scale-110 transition-transform" title="Download">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                    </button>
                </div>
            `;
            // Decrypt E2E media in-page before painting the thumbnail (fail-open).
            void resolveMediaSrc(entry.url).then((resolved) => { const im = thumb.querySelector('img'); if (im) im.src = resolved; });

            thumb.onclick = (e) => {
                if (e.target.closest('.hist-download')) {
                    downloadImage(entry.url, `muapi-${entry.id || idx}.jpg`);
                    return;
                }
                showImageInCanvas(entry.url);
                // Update active border
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

    // --- Helper: Download image ---
    const downloadImage = async (url, filename) => {
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
            // Fallback: open in new tab
            window.open(url, '_blank');
        }
    };

    const savedHistory = loadStudioGenerationHistory('muapi_history');
    if (savedHistory.length > 0) {
        savedHistory.forEach(e => generationHistory.push(e));
        historySidebar.classList.remove('translate-x-full', 'opacity-0');
        historySidebar.classList.add('translate-x-0', 'opacity-100');
        renderHistory();
    }

    // --- Resume any pending image generations from a previous session ---
    (async () => {
        const pending = getPendingJobs('image');
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
                console.warn('[ImageStudio] Pending job failed on resume:', job.requestId, e.message);
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
        const current = resultImg.src;
        if (current) {
            const entry = generationHistory.find(e => e.url === current);
            downloadImage(current, `muapi-${entry?.id || 'image'}.jpg`);
        }
    };

    // Bring the setup that produced the on-screen image back to the prompt bar.
    backToSetupBtn.onclick = () => {
        const viewed = contextStore.getViewed();
        if (viewed) restoreImageContext(viewed);
        resetToPromptBar();
        textarea.focus();
    };

    // Reproduce the on-screen image's setup, then fire it again.
    regenerateBtn.onclick = () => {
        const viewed = contextStore.getViewed();
        if (viewed) restoreImageContext(viewed);
        generateBtn.click();
    };

    newPromptBtn.onclick = () => {
        // Reset to prompt view (start fresh — clears prompt, refs and the viewed setup).
        resetToPromptBar();
        contextStore.clearViewed();
        lastSubmittedContext = null;
        textarea.value = '';
        picker.reset();
        uploadedImageUrls = [];
        picker.setMaxImages(1);
        // Reset to t2i mode
        imageMode = false;
        selectedModel = t2iModels[0].id;
        selectedModelName = t2iModels[0].name;
        selectedAr = getAspectRatiosForModel(selectedModel)[0];
        document.getElementById('model-btn-label').textContent = selectedModelName;
        document.getElementById('ar-btn-label').textContent = selectedAr;
        const resetResolutions = getResolutionsForModel(selectedModel);
        selectedResolution = resetResolutions[0] || '';
        qualityBtn.style.display = resetResolutions.length > 0 ? 'flex' : 'none';
        if (resetResolutions.length > 0) document.getElementById('quality-btn-label').textContent = resetResolutions[0];
        if (!useLocalModel) applyStoredModelSettings(`api:${selectedModel}`);
        if (useLocalModel) {
            const localModel = ensureCompatibleLocalModel();
            if (localModel) {
                document.getElementById('model-btn-label').textContent = localModel.name;
                selectedAr = localModel.aspectRatios?.[0] || selectedAr;
                // "Start fresh" clears the canvas, not the model's saved tuning.
                applyStoredModelSettings(`local:${localModel.id}`, localModel);
                document.getElementById('ar-btn-label').textContent = selectedAr;
            }
        }
        textarea.placeholder = t('image.placeholder');
        textarea.focus();
    };

    // ==========================================
    // 5. GENERATION LOGIC
    // ==========================================
    generateBtn.onclick = async () => {
        let prompt = textarea.value.trim();
        // Couple mode composes one line per character (optional shared scene
        // first); the backend maps lines to canvas regions.
        let coupleOptions = null;
        if (coupleActive()) {
            const sharedScene = coupleSharedInput.value.trim();
            const characterA = coupleAInput.value.trim();
            const characterB = coupleBInput.value.trim();
            if (!characterA && !characterB) {
                alert('Couple mode needs at least one character prompt.');
                return;
            }
            const lines = [characterA || characterB, characterB || characterA];
            if (sharedScene) lines.unshift(sharedScene);
            prompt = lines.join('\n');
            coupleOptions = {
                couple_mode: true,
                couple_shared: Boolean(sharedScene),
                couple_direction: coupleDirection,
                couple_split: Math.round(coupleSplit) / 100,
                couple_pair: couplePair,
            };
        }
        // References are sent only when the selected model can take them.
        const sendingRefs = uploadedImageUrls.length > 0 && currentModelSupportsImage();
        if (!useLocalModel && apiModelRequiresImage(selectedModel) && uploadedImageUrls.length === 0) {
            alert(`${selectedModelName} needs a reference image — attach one first.`);
            return;
        }
        if (!sendingRefs && !prompt) {
            alert('Please enter a prompt to generate an image.');
            return;
        }

        // Snapshot the full setup so this generation can be reopened from history later.
        lastSubmittedContext = captureImageContext(prompt);

        // ── Local inference path ──────────────────────────────────────────────
        if (useLocalModel) {
            const lm = localModelById(selectedLocalModel);
            if (!lm) { alert('No local model selected.'); return; }
            if (lm.requires?.prompt && !prompt) { alert('Please enter an edit prompt.'); return; }
            if (lm.requires?.image && uploadedImageUrls.length === 0) { alert(`${lm.name} requires a reference image.`); return; }

            hero.classList.add('opacity-0', 'scale-95', '-translate-y-10', 'pointer-events-none');
            generateBtn.disabled = true;
            generateBtn.innerHTML = `<span class="animate-spin inline-block mr-2 text-black">◌</span> ${t('common.generating')}`;

            const progressWrap = document.getElementById('local-progress-wrap');
            const progressFill = document.getElementById('local-progress-fill');
            const progressPct = document.getElementById('local-progress-pct');
            progressWrap.classList.remove('hidden');
            progressWrap.classList.add('flex');

            const unsub = localAI.onProgress(({ progress, status, message }) => {
                const pct = Math.round((progress ?? 0) * 100);
                const label = message || (status === 'starting' ? 'Starting...' : `${pct}%`);
                if (progressFill) progressFill.style.width = `${pct}%`;
                if (progressPct) progressPct.textContent = label;
                generateBtn.innerHTML = `<span class="animate-spin inline-block mr-2 text-black">◌</span> ${label}`;
            });

            let hadError = false;
            try {
                // References are ignored (not sent) when the model can't take them.
                const sourceImage = localModelSupportsImageInput(lm) ? (uploadedImageUrls[0] || '') : '';
                const res = await localAI.generate({
                    model: selectedLocalModel,
                    prompt,
                    negative_prompt: negativePrompt || undefined,
                    aspect_ratio: selectedAr,
                    steps: steps,
                    guidance_scale: guidanceScale,
                    seed,
                    runtime_mode: localRuntimeMode,
                    width: customWidth || undefined,
                    height: customHeight || undefined,
                    loras: loraGenerationPayload(currentLoraSelection()),
                    ...(coupleOptions || {}),
                    ...(sourceImage.startsWith('data:') ? { image_base64: sourceImage } : {}),
                    ...(sourceImage && !sourceImage.startsWith('data:') ? { image_url: sourceImage } : {}),
                });
                unsub();
                progressWrap.classList.replace('flex', 'hidden');
                progressWrap.classList.add('hidden');

                if (!res?.url) throw new Error('No output returned from local generation');
                if (res.mediaType === 'video') {
                    throw new Error('This model produces video — use the Video studio instead.');
                }
                addToHistory({
                    id: Date.now().toString(),
                    url: res.url,
                    prompt,
                    model: `local:${selectedLocalModel}`,
                    aspect_ratio: selectedAr,
                    seed: res.seed,
                    timestamp: new Date().toISOString()
                }, lastSubmittedContext);
                showImageInCanvas(res.url);
            } catch (e) {
                hadError = true;
                unsub();
                progressWrap.classList.add('hidden');
                console.error('[Local] generation error:', e);
                hero.classList.remove('opacity-0', 'scale-95', '-translate-y-10', 'pointer-events-none');
                console.error('[Local] full error:', e.message);
                generateBtn.innerHTML = `Error: ${e.message.slice(0, 120)}`;
                setTimeout(() => { generateBtn.innerHTML = t('common.generate'); }, 6000);
            } finally {
                generateBtn.disabled = false;
                if (!hadError) generateBtn.innerHTML = t('common.generate');
            }
            return;
        }

        // ── Remote API path ───────────────────────────────────────────────────
        const apiKey = localStorage.getItem('muapi_key');
        if (!apiKey) {
            AuthModal(() => generateBtn.click());
            return;
        }

        hero.classList.add('opacity-0', 'scale-95', '-translate-y-10', 'pointer-events-none');
        generateBtn.disabled = true;
        generateBtn.innerHTML = `<span class="animate-spin inline-block mr-2 text-black">◌</span> Generating...`;

        let hadError = false;
        let capturedRequestId = null;
        const historyMeta = { prompt, model: selectedModel, aspect_ratio: selectedAr };

        try {
            let res;
            const qualityLabel = selectedResolution;
            if (sendingRefs) {
                const genParams = {
                    model: selectedModel,
                    images_list: uploadedImageUrls,
                    image_url: uploadedImageUrls[0], // backward compat for single-image models
                    aspect_ratio: selectedAr,
                    onRequestId: (rid) => {
                        capturedRequestId = rid;
                        savePendingJob({ requestId: rid, studioType: 'image', historyMeta, maxAttempts: 60, interval: 2000, submittedAt: Date.now() });
                    }
                };
                if (prompt) genParams.prompt = prompt;
                const qualityField = getCurrentQualityField(selectedModel);
                if (qualityField && qualityLabel) genParams[qualityField] = qualityLabel;
                res = await muapi.generateI2I(genParams);
            } else {
                const genParams = {
                    model: selectedModel,
                    prompt,
                    aspect_ratio: selectedAr,
                    onRequestId: (rid) => {
                        capturedRequestId = rid;
                        savePendingJob({ requestId: rid, studioType: 'image', historyMeta, maxAttempts: 60, interval: 2000, submittedAt: Date.now() });
                    }
                };
                const qualityField = getCurrentQualityField(selectedModel);
                if (qualityField && qualityLabel) genParams[qualityField] = qualityLabel;
                res = await muapi.generateImage(genParams);
            }

            if (res && res.url) {
                if (capturedRequestId) removePendingJob(capturedRequestId);
                addToHistory({
                    id: res.id || capturedRequestId || Date.now().toString(),
                    url: res.url,
                    prompt: prompt,
                    model: selectedModel,
                    aspect_ratio: selectedAr,
                    timestamp: new Date().toISOString()
                }, lastSubmittedContext);
                showImageInCanvas(res.url);
            } else {
                throw new Error('No image URL returned by API');
            }
        } catch (e) {
            hadError = true;
            if (capturedRequestId) removePendingJob(capturedRequestId);
            console.error(e);
            // Restore hero so the page doesn't look broken after a failed generation
            hero.classList.remove('opacity-0', 'scale-95', '-translate-y-10', 'pointer-events-none');
            generateBtn.innerHTML = `Error: ${e.message.slice(0, 60)}`;
            setTimeout(() => {
                generateBtn.innerHTML = t('common.generate');
            }, 4000);
        } finally {
            generateBtn.disabled = false;
            // Only reset the label on success; the catch timeout handles the error case
            if (!hadError) generateBtn.innerHTML = t('common.generate');
        }
    };

    localAI.listModels().then((models) => {
        const discovered = (Array.isArray(models) ? models : []).filter((model) => (
            model?.type !== 'video' && model?.state !== 'not-downloaded' && model?.ready !== false
        ));
        if (discovered.length === 0) return;
        localImageModels = discovered;
        const localModel = ensureCompatibleLocalModel();
        if (!localModel) return;
        const savedRuntimeMode = persistedImagePreferences?.localRuntimeMode;
        localRuntimeMode = localModel.runtimeModes?.includes(savedRuntimeMode)
            ? savedRuntimeMode
            : (localModel.defaultRuntimeMode || 'one-off');
        if (useLocalModel) {
            if (!persistedImagePreferences) applyLocalModelDefaults(localModel);
            document.getElementById('model-btn-label').textContent = localModel.name;
            selectedAr = localModel.aspectRatios?.[0] || selectedAr;
            // The catalog just landed — the model's saved tuning (cfg, steps,
            // AR, couple setup) wins over these boot defaults.
            applyStoredModelSettings(`local:${localModel.id}`, null);
            document.getElementById('ar-btn-label').textContent = selectedAr;
            picker.setMaxImages(imageMode ? (localModel.maxReferenceImages || 1) : 1);
            updateLocalRuntimeModeUI();
            updatePromptHelperUI();
            if (showAdvanced) void loadLorasForCurrentModel();
        }
        // The runtime catalog just landed — re-evaluate image support and
        // couple capability for the selected model (the boot-time pass may
        // have run before discovery).
        updateUploadTriggerState();
        updateCoupleUI();
        restoreImagePreferenceControls();
    }).catch((error) => {
        console.warn('[Local] Unable to discover runtime image workflows:', error);
    });

    let persistTimer = null;
    const scheduleImagePreferencePersistence = () => {
        if (persistTimer != null) clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
            persistTimer = null;
            persistImagePreferences();
        }, 0);
    };
    ['click', 'input', 'change'].forEach((eventName) => {
        container.addEventListener(eventName, scheduleImagePreferencePersistence, true);
    });

    // Initial trigger/chip state for the selected model (no references yet).
    updateUploadTriggerState();
    updateCoupleUI();

    // Restore the encrypted composer draft (prompt + reference selection) so the
    // rebuilt-per-navigation image section survives tab switches and reloads.
    void hydrateComposerState().then(() => {
        const saved = getComposerSection('image');
        if (typeof saved.prompt === 'string' && saved.prompt && !textarea.value) {
            textarea.value = saved.prompt;
            textarea.oninput();
        }
        const references = Array.isArray(saved.references) ? saved.references.filter(Boolean) : [];
        if (references.length && uploadedImageUrls.length === 0) {
            picker.setMaxImages(Math.max(references.length, 1));
            picker.setImages(references, { silent: false });
        }
    });

    return container;
}
