// Image Studio — React port of src/components/ImageStudio.js (2513 lines, vanilla).
// Unified image generation: cloud (muapi) + local inference, couple mode, LoRA,
// references, pending-job resume, E2E-encrypted history/composer state.
//
// Port rules honored here:
// - All src/lib modules are consumed unchanged (they stay the source of truth).
// - Studio state lives in one mutable "engine" object (useRef) mirroring the old
//   closure variables, so the imperative sequencing (snapshot → switch model →
//   apply stored settings → refresh → reload LoRAs) is preserved verbatim.
// - Preferences persist after EVERY interaction via the same capture-phase
//   click/input/change listener trick the old code used (scoped to this studio's
//   root, not window), plus explicit persist calls on portal-hosted actions.
// - alert() → toast.error() with identical abort semantics.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'react-hot-toast';

import { muapi } from '../lib/muapi.js';
import {
  t2iModels, getAspectRatiosForModel, getResolutionsForModel, getQualityFieldForModel,
  i2iModels, getAspectRatiosForI2IModel, getResolutionsForI2IModel, getQualityFieldForI2IModel,
  getMaxImagesForI2IModel,
} from '../lib/models.js';
import { localAI, isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { LOCAL_MODEL_CATALOG, getLocalModelById } from '../lib/localModels.js';
import { ENHANCE_TAGS, QUICK_PROMPTS } from '../lib/promptUtils.js';
import { t } from '../lib/i18n.js';
import { savePendingJob, removePendingJob, getPendingJobs } from '../lib/pendingJobs.js';
import { isHivemindStudioEnabled, loadStudioGenerationHistory, saveStudioGenerationHistory } from '../lib/hivemindStudio.js';
import { getComposerSection, hydrateComposerState, updateComposerSection } from '../lib/composerState.js';
import { resolveMediaSrc } from '../lib/e2eMedia.js';
import { loraGenerationPayload, toggleLoraSelection, updateLoraStrength } from '../lib/loraSelection.js';
import { localModelSupportsImageInput } from '../lib/localImageModelFilter.js';
import { createGenerationContextStore } from '../lib/generationContext.js';

import { registerPromptInserter, registerStudioSetupLoader } from '../app/promptTarget.js';
import { rememberGenerationSetup } from '../lib/generationSetupStore.js';
import { Icon } from '../ui/icons.jsx';
import {
  Button, Card, EmptyState, Field, IconButton, NativeSelect, Pill, ProgressBar,
  SectionLabel, Segmented, Slider, Spinner, TextArea, TextInput, Toggle, cx,
} from '../ui/kit.jsx';
import { ChipButton, Menu, MenuHeading, MenuItem } from '../ui/Menu.jsx';
import { StudioLayout } from '../ui/kit.jsx';

import { UploadPicker } from './UploadPicker.jsx';
import { AuthModal } from '../dialogs/AuthModal.jsx';
import { CivitaiDownloadDialog } from '../dialogs/CivitaiDownloadDialog.jsx';

import { computeSmoothProgress, formatElapsed, estimateGenerationSeconds, recordGenerationSeconds } from '../lib/genProgress.js';
import { IMAGE_PREFERENCES_KEY, STYLE_PRESETS, normalizeImagePreferences } from './image/imagePrefs.js';
import { LoraSection } from './image/LoraSection.jsx';
import { GalleryCard, ViewerModal } from './image/GalleryAndViewer.jsx';

// Re-export the pure normalizer — tests and other callers import it from here.
export { normalizeImagePreferences };

// Cloud catalog capability flags: an API model "supports" references when it
// has an image-to-image configuration; models only in the editing catalog
// require one. Models are never hidden based on attached references.
const apiModelSupportsImage = (id) => i2iModels.some((m) => m.id === id);
const apiModelRequiresImage = (id) => apiModelSupportsImage(id) && !t2iModels.some((m) => m.id === id);

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Unable to read reference image'));
    reader.readAsDataURL(file);
  });
}

// One mutable state bag per mount — the studio remounts on every navigation
// (App keys the studio), so this re-runs exactly like the old factory did.
function createEngine() {
  // Reads persisted settings from the warm encrypted composer cache first (tab
  // switches remount this component; the cache survives in-module), then falls back
  // to the localStorage copy of the NON-SENSITIVE settings — which is what makes the
  // model + params restore synchronously on a fresh reload, before the vault cache
  // has hydrated. Prompt text and the negative prompt stay in the encrypted cache.
  let persistedImagePreferences = null;
  try {
    persistedImagePreferences = normalizeImagePreferences(
      getComposerSection('image').preferences
        || JSON.parse(localStorage.getItem(IMAGE_PREFERENCES_KEY) || 'null'),
    );
  } catch { /* corrupted prefs — boot with defaults */ }

  // imageMode is DERIVED from actually-attached references (picker onChange,
  // draft hydration, context restore) — never adopted as a bare persisted flag.
  const defaultModel = t2iModels.find((model) => model.id === persistedImagePreferences?.modelId)
    || i2iModels.find((model) => model.id === persistedImagePreferences?.modelId)
    || t2iModels[0];
  const selectedModel = defaultModel.id;
  const initialI2iConfig = apiModelRequiresImage(selectedModel);
  const initialAspectRatios = initialI2iConfig ? getAspectRatiosForI2IModel(selectedModel) : getAspectRatiosForModel(selectedModel);
  const selectedAr = initialAspectRatios.includes(persistedImagePreferences?.aspectRatio)
    ? persistedImagePreferences.aspectRatio
    : (defaultModel.inputs?.aspect_ratio?.default || initialAspectRatios[0] || '1:1');
  const initialResolutions = initialI2iConfig ? getResolutionsForI2IModel(selectedModel) : getResolutionsForModel(selectedModel);
  const selectedResolution = initialResolutions.includes(persistedImagePreferences?.resolution)
    ? persistedImagePreferences.resolution
    : (initialResolutions[0] || '');

  // Local inference state — only image-capable models surface here.
  const localImageModels = LOCAL_MODEL_CATALOG.filter((m) => m.type !== 'video');
  const useLocalModel = Boolean(persistedImagePreferences?.useLocalModel && isLocalAIAvailable());
  const selectedLocalModel = persistedImagePreferences?.localModelId || localImageModels[0]?.id || null;
  const bootLocalModel = localImageModels.find((m) => m.id === selectedLocalModel) || getLocalModelById(selectedLocalModel);
  const localRuntimeMode = persistedImagePreferences?.localRuntimeMode || bootLocalModel?.defaultRuntimeMode || 'one-off';

  const seed = persistedImagePreferences?.seed ?? -1;

  const loraSelectionsByModel = new Map();
  Object.entries(persistedImagePreferences?.loraSelections || {}).forEach(([model, selections]) => {
    loraSelectionsByModel.set(model, selections);
  });

  return {
    persistedImagePreferences,
    selectedModel,
    selectedModelName: defaultModel.name,
    imageMode: false,
    selectedAr,
    selectedResolution,
    uploadedImageUrls: [],
    localImageModels,
    useLocalModel,
    selectedLocalModel,
    localRuntimeMode,
    negativePrompt: persistedImagePreferences?.negativePrompt || '',
    guidanceScale: persistedImagePreferences?.guidanceScale ?? 7.5,
    steps: persistedImagePreferences?.steps ?? 25,
    seed,
    seedText: String(seed),
    selectedStyle: persistedImagePreferences?.style || 'None',
    batchCount: persistedImagePreferences?.batchCount ?? 1,
    customWidth: persistedImagePreferences?.customWidth ?? 0,
    customHeight: persistedImagePreferences?.customHeight ?? 0,
    referenceStrength: persistedImagePreferences?.referenceStrength ?? 50,
    // Couple mode — OFF by default; character text is session-only, never persisted.
    coupleMode: Boolean(persistedImagePreferences?.coupleMode),
    coupleDirection: persistedImagePreferences?.coupleDirection === 'vertical' ? 'vertical' : 'horizontal',
    coupleSplit: persistedImagePreferences?.coupleSplit ?? 50,
    couplePair: ['girls', 'mixed', 'boys'].includes(persistedImagePreferences?.couplePair)
      ? persistedImagePreferences.couplePair : 'girls',
    coupleShared: '',
    coupleA: '',
    coupleB: '',
    availableLoras: [],
    loraCatalogStatus: 'idle',
    loraCatalogMessage: 'LoRAs load automatically for the selected local workflow.',
    loraBaseLabel: 'Choose a local workflow to see compatible LoRAs.',
    loraCatalogRequest: 0,
    promptHelperRequest: 0,
    loraSelectionsByModel,
    modelSettingsById: new Map(Object.entries(persistedImagePreferences?.modelSettings || {})),
    loraOpen: false,
    // "Return to a past generation's exact setup" — same store contract as the Video studio.
    contextStore: createGenerationContextStore(),
    lastSubmittedContext: null,
    // History is loaded synchronously at build, exactly like the old factory
    // (lib maps 'muapi_history' to localStorage, or memory-only in studio mode).
    history: loadStudioGenerationHistory('muapi_history'),
    prompt: '',
    maxImages: useLocalModel
      ? (bootLocalModel?.maxReferenceImages || 1)
      : (apiModelSupportsImage(selectedModel) ? getMaxImagesForI2IModel(selectedModel) : 1),
    generating: false,
    localProgress: { active: false, pct: 0, label: '' },
    // Smooth, time-based ETA bar. Image generation exposes no real per-step
    // progress on any path, so the bar is driven by elapsed / expected (from the
    // client-side per-signature duration store), nudged up by the coarse status.
    progressDisplay: 0,
    progressReal: 0,
    progressEstimateSec: null,
    progressSignature: '',
    generationStartedAt: 0,
    generationTimer: null,
    viewerUrl: null,
    authOpen: false,
    civitaiOpen: false,
    resumeRemaining: 0,
    promptHelper: { open: false, busy: false, title: '', result: '', status: '', negative: '', ready: false },
    enhancerOpen: false,
    enhanceBase: '',
    enhanceTags: new Set(),
    enhanceCopied: false,
    warmLabel: 'Warm model',
    warmBusy: false,
    unloadLabel: 'Unload',
    unloadBusy: false,
    persistTimer: null,
  };
}

export function ImageStudio({ active = true } = {}) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = createEngine();
  const s = engineRef.current;
  const [, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);

  const rootRef = useRef(null);
  const promptRef = useRef(null);
  const authRetryRef = useRef(null);
  const mountedOnceRef = useRef(false);
  const mountedRef = useRef(true);

  /* ---------------- derived helpers (verbatim logic) ---------------- */

  const localModelById = (id) => s.localImageModels.find((m) => m.id === id) || getLocalModelById(id);
  // Every local model is always listed; attaching an image never hides
  // text-to-image models — unsupported models simply ignore references.
  const compatibleLocalModels = () => s.localImageModels;
  const ensureCompatibleLocalModel = () => {
    const compatible = compatibleLocalModels();
    const selected = compatible.find((model) => model.id === s.selectedLocalModel) || compatible[0] || null;
    s.selectedLocalModel = selected?.id || null;
    return selected;
  };
  const currentModelSupportsImage = () => {
    if (!s.useLocalModel) return apiModelSupportsImage(s.selectedModel);
    const model = localModelById(s.selectedLocalModel);
    // Fail OPEN while the runtime catalog is still loading — an unknown
    // model must not lock the upload button.
    return model ? localModelSupportsImageInput(model) : true;
  };

  // A cloud model runs with its image-to-image configuration when references
  // are attached and usable, or when the model only exists as an editing tool.
  const useI2iConfig = (id) => !s.useLocalModel && apiModelSupportsImage(id)
    && (s.uploadedImageUrls.length > 0 || apiModelRequiresImage(id));
  const getCurrentAspectRatios = (id) => useI2iConfig(id) ? getAspectRatiosForI2IModel(id) : getAspectRatiosForModel(id);
  const getCurrentResolutions = (id) => useI2iConfig(id) ? getResolutionsForI2IModel(id) : getResolutionsForModel(id);
  const getCurrentQualityField = (id) => useI2iConfig(id) ? getQualityFieldForI2IModel(id) : getQualityFieldForModel(id);

  const coupleCapableModel = () => s.useLocalModel && Boolean(localModelById(s.selectedLocalModel)?.coupleCapable);
  const coupleActive = () => s.coupleMode && coupleCapableModel();

  const currentPromptHelper = () => s.useLocalModel ? localModelById(s.selectedLocalModel)?.promptHelper : null;

  const currentLoraModel = () => s.useLocalModel ? localModelById(s.selectedLocalModel) : null;
  const currentLoraSelection = () => s.loraSelectionsByModel.get(currentLoraModel()?.id) || [];

  /* ---------------- generation progress (smooth time-based ETA) ---------------- */

  const DEFAULT_IMAGE_ESTIMATE_SEC = 30;
  // Opaque key over the params that meaningfully affect time (model, steps,
  // quality, dims, batch, loras) — never prompt text — so similar runs share an
  // elapsed/expected estimate. Local vs remote are tracked separately.
  const imageTimingSignature = () => {
    if (s.useLocalModel) {
      const dims = (s.customWidth && s.customHeight) ? `${s.customWidth}x${s.customHeight}` : (s.selectedAr || '');
      const loraCount = (currentLoraSelection() || []).length;
      return `img|local|${s.selectedLocalModel}|steps=${s.steps}|dims=${dims}|batch=${s.batchCount}|loras=${loraCount}|couple=${s.coupleMode ? 1 : 0}`;
    }
    return `img|api|${s.selectedModel}|ar=${s.selectedAr}|q=${s.selectedResolution || ''}|refs=${s.uploadedImageUrls.length ? 1 : 0}`;
  };
  const startImageProgress = () => {
    if (s.generationTimer) clearInterval(s.generationTimer);
    s.progressSignature = imageTimingSignature();
    s.generationStartedAt = Date.now();
    s.progressDisplay = 0;
    s.progressReal = 0;
    s.progressEstimateSec = estimateGenerationSeconds(s.progressSignature, DEFAULT_IMAGE_ESTIMATE_SEC);
    s.generationTimer = setInterval(() => {
      if (!mountedRef.current) { clearInterval(s.generationTimer); s.generationTimer = null; return; }
      s.progressDisplay = computeSmoothProgress({
        elapsedSec: (Date.now() - s.generationStartedAt) / 1000,
        estimateSec: Number(s.progressEstimateSec) || 0,
        realFraction: Number(s.progressReal) || 0,
        prevDisplay: s.progressDisplay,
      });
      bump();
    }, 300);
  };
  const finishImageProgress = (success) => {
    if (s.generationTimer) { clearInterval(s.generationTimer); s.generationTimer = null; }
    if (success && s.progressSignature && s.generationStartedAt) {
      recordGenerationSeconds(s.progressSignature, (Date.now() - s.generationStartedAt) / 1000);
    }
    s.progressDisplay = success ? 1 : 0;
  };
  const setCurrentLoraSelection = (selection) => {
    const model = currentLoraModel();
    if (!model) return;
    s.loraSelectionsByModel.set(model.id, selection);
  };

  /* ---------------- persistence ---------------- */

  const currentSettingsKey = () => {
    const id = s.useLocalModel ? s.selectedLocalModel : s.selectedModel;
    return id ? `${s.useLocalModel ? 'local' : 'api'}:${id}` : '';
  };
  const snapshotCurrentModelSettings = () => {
    const key = currentSettingsKey();
    if (!key) return;
    s.modelSettingsById.set(key, {
      steps: s.steps,
      guidanceScale: s.guidanceScale,
      negativePrompt: s.negativePrompt,
      aspectRatio: s.selectedAr,
      resolution: s.selectedResolution,
      customWidth: s.customWidth,
      customHeight: s.customHeight,
      localRuntimeMode: s.localRuntimeMode,
      coupleMode: s.coupleMode,
      coupleDirection: s.coupleDirection,
      coupleSplit: s.coupleSplit,
      couplePair: s.couplePair,
    });
  };

  const persistImagePreferences = () => {
    snapshotCurrentModelSettings();
    const preferences = normalizeImagePreferences({
      modelId: s.selectedModel,
      imageMode: s.imageMode,
      useLocalModel: s.useLocalModel,
      localModelId: s.selectedLocalModel,
      aspectRatio: s.selectedAr,
      resolution: s.selectedResolution,
      localRuntimeMode: s.localRuntimeMode,
      negativePrompt: s.negativePrompt,
      guidanceScale: s.guidanceScale,
      steps: s.steps,
      seed: s.seed,
      style: s.selectedStyle,
      batchCount: s.batchCount,
      customWidth: s.customWidth,
      customHeight: s.customHeight,
      referenceStrength: s.referenceStrength,
      coupleMode: s.coupleMode,
      coupleDirection: s.coupleDirection,
      coupleSplit: s.coupleSplit,
      couplePair: s.couplePair,
      modelSettings: Object.fromEntries(s.modelSettingsById),
      loraSelections: Object.fromEntries(s.loraSelectionsByModel),
    });
    if (!preferences) return;
    s.persistedImagePreferences = preferences;
    updateComposerSection('image', { preferences });
    // Non-sensitive settings (everything except the negative-prompt text) ALSO go
    // to localStorage, unconditionally — so the model + params restore
    // SYNCHRONOUSLY at mount, before the encrypted composer cache hydrates. Without
    // this, studio mode had no sync source and the model reverted to the default
    // (Krea) on every reload. The negative prompt is prompt text, so it stays in
    // the encrypted composer section only (restored on hydrate).
    try {
      const stripNegative = ({ negativePrompt: _neg, ...rest }) => rest;
      const settings = stripNegative(preferences);
      if (settings.modelSettings && typeof settings.modelSettings === 'object') {
        // The per-model tuning cache also holds each model's negative prompt — strip
        // those too, so no prompt text lands in plaintext localStorage.
        settings.modelSettings = Object.fromEntries(
          Object.entries(settings.modelSettings).map(([key, entry]) => [
            key, entry && typeof entry === 'object' ? stripNegative(entry) : entry,
          ]),
        );
      }
      localStorage.setItem(IMAGE_PREFERENCES_KEY, JSON.stringify(settings));
    } catch { /* quota */ }
  };
  const persistRef = useRef(persistImagePreferences);
  persistRef.current = persistImagePreferences;

  const schedulePersist = () => {
    if (s.persistTimer != null) clearTimeout(s.persistTimer);
    s.persistTimer = setTimeout(() => {
      s.persistTimer = null;
      persistRef.current();
    }, 0);
  };

  /* ---------------- model / settings transitions (verbatim order) ---------------- */

  const applyLocalModelDefaults = (model) => {
    if (!model) return;
    s.steps = Number(model.defaultSteps || s.steps);
    s.guidanceScale = Number(model.defaultGuidance ?? s.guidanceScale);
  };

  // Restore a model's saved advanced settings when it's reselected; fall back
  // to the model's own defaults the first time it's used.
  const applyStoredModelSettings = (key, fallbackLocalModel) => {
    const stored = s.modelSettingsById.get(key);
    if (!stored) {
      if (fallbackLocalModel) applyLocalModelDefaults(fallbackLocalModel);
      return false;
    }
    s.steps = stored.steps;
    s.guidanceScale = stored.guidanceScale;
    s.negativePrompt = stored.negativePrompt;
    s.customWidth = stored.customWidth;
    s.customHeight = stored.customHeight;
    s.coupleMode = Boolean(stored.coupleMode);
    s.coupleDirection = stored.coupleDirection === 'vertical' ? 'vertical' : 'horizontal';
    s.coupleSplit = stored.coupleSplit ?? s.coupleSplit;
    s.couplePair = stored.couplePair || s.couplePair;
    if (s.useLocalModel) {
      const modes = fallbackLocalModel?.runtimeModes || localModelById(s.selectedLocalModel)?.runtimeModes || [];
      if (stored.localRuntimeMode && (modes.length === 0 || modes.includes(stored.localRuntimeMode))) {
        s.localRuntimeMode = stored.localRuntimeMode;
      }
    }
    const validArs = s.useLocalModel
      ? (fallbackLocalModel?.aspectRatios || localModelById(s.selectedLocalModel)?.aspectRatios || [])
      : getCurrentAspectRatios(s.selectedModel);
    if (stored.aspectRatio && validArs.includes(stored.aspectRatio)) s.selectedAr = stored.aspectRatio;
    if (!s.useLocalModel && stored.resolution && getCurrentResolutions(s.selectedModel).includes(stored.resolution)) {
      s.selectedResolution = stored.resolution;
    }
    return true;
  };

  // Reflect the selected cloud model's active configuration (t2i vs i2i,
  // depending on attached references) in aspect/quality state.
  const refreshModelConfigControls = () => {
    const ars = getCurrentAspectRatios(s.selectedModel);
    if (!ars.includes(s.selectedAr)) s.selectedAr = ars[0] || '1:1';
    const resolutions = getCurrentResolutions(s.selectedModel);
    if (!resolutions.includes(s.selectedResolution)) s.selectedResolution = resolutions[0] || '';
    s.maxImages = apiModelSupportsImage(s.selectedModel)
      ? getMaxImagesForI2IModel(s.selectedModel)
      : Math.max(s.uploadedImageUrls.length, 1);
  };

  const closePromptHelper = () => {
    s.promptHelperRequest += 1;
    s.promptHelper = { ...s.promptHelper, open: false, busy: false };
  };
  const updatePromptHelperVisibility = () => {
    if (!currentPromptHelper()) closePromptHelper();
  };

  /* ---------------- LoRA catalog (race-token guarded, verbatim) ---------------- */

  const loadLorasForCurrentModel = async () => {
    const model = currentLoraModel();
    const request = ++s.loraCatalogRequest;
    s.availableLoras = [];
    if (!model) {
      s.loraCatalogStatus = 'unavailable';
      s.loraCatalogMessage = 'Installed LoRAs are available when Local is selected.';
      s.loraBaseLabel = 'Choose a local workflow to see compatible LoRAs.';
      bump();
      return;
    }
    s.loraCatalogStatus = 'loading';
    s.loraCatalogMessage = `Loading LoRAs for ${model.name}…`;
    s.loraBaseLabel = model.name;
    bump();
    try {
      const data = await localAI.listLoras(model.id);
      if (request !== s.loraCatalogRequest) return;
      s.availableLoras = Array.isArray(data?.loras) ? data.loras : [];
      const bases = Array.isArray(data?.baseModels) ? data.baseModels : [];
      s.loraBaseLabel = data?.supported === false
        ? `${model.name} does not expose an add-on LoRA path.`
        : `${model.name} · ${bases.join(', ') || 'compatible local adapters'}`;
      s.loraCatalogStatus = data?.supported === false ? 'unsupported' : 'ready';
      s.loraCatalogMessage = data?.supported === false
        ? 'This workflow does not support add-on LoRAs.'
        : s.availableLoras.length
          ? `${s.availableLoras.length} compatible LoRA${s.availableLoras.length === 1 ? '' : 's'} installed. Tap a card to load it.`
          : 'No compatible LoRAs are installed for this workflow.';
    } catch (error) {
      if (request !== s.loraCatalogRequest) return;
      s.loraCatalogStatus = 'error';
      s.loraCatalogMessage = `Unable to load LoRAs: ${error.message}`;
    }
    bump();
  };

  /* ---------------- references ---------------- */

  // onChange add/update path — mirrors the old picker onSelect side effects.
  const handleReferencesSelected = (urls) => {
    s.uploadedImageUrls = urls.slice();
    s.imageMode = true;
    if (!s.useLocalModel) {
      // The model NEVER changes because a reference was attached — its i2i
      // configuration simply becomes active if it has one.
      refreshModelConfigControls();
    }
    if (s.useLocalModel) {
      const localModel = ensureCompatibleLocalModel();
      if (localModel) {
        s.selectedAr = localModel.aspectRatios?.[0] || s.selectedAr;
        s.maxImages = localModel.maxReferenceImages || 1;
      }
      updatePromptHelperVisibility();
      void loadLorasForCurrentModel();
    }
    persistImagePreferences();
    updateComposerSection('image', { references: s.uploadedImageUrls.slice() });
    bump();
  };

  const clearReferences = () => {
    s.uploadedImageUrls = [];
    s.imageMode = false;
    if (!s.useLocalModel) {
      // The selected model stays put; only its active config flips back.
      refreshModelConfigControls();
    }
    if (s.useLocalModel) {
      const localModel = ensureCompatibleLocalModel();
      if (localModel) s.selectedAr = localModel.aspectRatios?.[0] || s.selectedAr;
      updatePromptHelperVisibility();
      void loadLorasForCurrentModel();
    }
    persistImagePreferences();
    updateComposerSection('image', { references: [] });
    bump();
  };

  const handlePickerChange = (urls) => {
    const next = Array.isArray(urls) ? urls.filter(Boolean) : [];
    if (next.length === 0) clearReferences();
    else handleReferencesSelected(next);
  };

  /* ---------------- prompt ---------------- */

  const setPromptValue = (value) => {
    s.prompt = value;
    updateComposerSection('image', { prompt: value });
    bump();
  };

  /* ---------------- model selection ---------------- */

  const selectLocalModel = (m) => {
    snapshotCurrentModelSettings();
    s.selectedLocalModel = m.id;
    s.localRuntimeMode = m.defaultRuntimeMode || 'one-off';
    s.selectedAr = m.aspectRatios?.[0] || '1:1';
    s.selectedResolution = '';
    applyStoredModelSettings(`local:${m.id}`, m);
    updatePromptHelperVisibility();
    void loadLorasForCurrentModel();
    bump();
  };

  const selectApiModel = (m) => {
    snapshotCurrentModelSettings();
    s.selectedModel = m.id;
    s.selectedModelName = m.name;
    const availableArs = getCurrentAspectRatios(s.selectedModel);
    s.selectedAr = availableArs.includes(s.selectedAr) ? s.selectedAr : (availableArs[0] || '1:1');
    applyStoredModelSettings(`api:${m.id}`);
    refreshModelConfigControls();
    updatePromptHelperVisibility();
    void loadLorasForCurrentModel();
    bump();
  };

  const setSource = (nextLocal) => {
    if (nextLocal === s.useLocalModel) return;
    snapshotCurrentModelSettings();
    s.useLocalModel = nextLocal;
    if (s.useLocalModel) {
      const lm = ensureCompatibleLocalModel();
      s.localRuntimeMode = lm?.defaultRuntimeMode || s.localRuntimeMode || 'one-off';
      if (lm) applyStoredModelSettings(`local:${lm.id}`, lm);
    } else {
      applyStoredModelSettings(`api:${s.selectedModel}`);
    }
    updatePromptHelperVisibility();
    void loadLorasForCurrentModel();
    persistImagePreferences();
    bump();
  };

  /* ---------------- generation context capture/restore (shared contract) ---------------- */

  const captureImageContext = (prompt) => ({
    prompt,
    imageMode: s.imageMode,
    useLocalModel: s.useLocalModel,
    selectedModel: s.selectedModel,
    selectedModelName: s.selectedModelName,
    selectedLocalModel: s.selectedLocalModel,
    localRuntimeMode: s.localRuntimeMode,
    aspectRatio: s.selectedAr,
    resolution: s.selectedResolution,
    negativePrompt: s.negativePrompt,
    guidanceScale: s.guidanceScale,
    steps: s.steps,
    seed: s.seed,
    style: s.selectedStyle,
    batchCount: s.batchCount,
    customWidth: s.customWidth,
    customHeight: s.customHeight,
    referenceStrength: s.referenceStrength,
    loras: currentLoraSelection().map((lora) => ({ ...lora })),
    referenceImages: [...s.uploadedImageUrls],
  });

  const restoreImageContext = (context) => {
    if (!context) return false;

    s.imageMode = Boolean(context.imageMode);
    s.useLocalModel = Boolean(context.useLocalModel) && isLocalAIAvailable();

    // Any cloud model is valid regardless of restored reference state.
    const models = [...t2iModels, ...i2iModels];
    const model = models.find((m) => m.id === context.selectedModel) || t2iModels[0];
    if (!model) return false;
    s.selectedModel = model.id;
    s.selectedModelName = context.selectedModelName || model.name;
    if (s.useLocalModel) {
      s.selectedLocalModel = context.selectedLocalModel || s.selectedLocalModel;
      s.localRuntimeMode = context.localRuntimeMode || s.localRuntimeMode || 'one-off';
    }

    // Scalar params.
    s.selectedAr = context.aspectRatio || s.selectedAr;
    s.selectedResolution = context.resolution ?? s.selectedResolution;
    s.negativePrompt = context.negativePrompt || '';
    s.guidanceScale = context.guidanceScale ?? s.guidanceScale;
    s.steps = context.steps ?? s.steps;
    s.seed = context.seed ?? s.seed;
    s.seedText = String(s.seed);
    s.selectedStyle = STYLE_PRESETS.includes(context.style) ? context.style : s.selectedStyle;
    s.batchCount = context.batchCount ?? s.batchCount;
    s.customWidth = context.customWidth ?? s.customWidth;
    s.customHeight = context.customHeight ?? s.customHeight;
    s.referenceStrength = context.referenceStrength ?? s.referenceStrength;

    // Reference images — restored silently (no upload side effects re-run).
    const maxRefs = s.imageMode ? getMaxImagesForI2IModel(s.selectedModel) : 1;
    s.maxImages = maxRefs;
    const refs = Array.isArray(context.referenceImages) ? context.referenceImages.filter(Boolean) : [];
    s.uploadedImageUrls = refs.slice(0, Math.max(maxRefs, 1));
    // Image mode is only real when references actually restored — a bare flag
    // with an empty picker is the ghost state this guards against.
    if (s.imageMode && s.uploadedImageUrls.length === 0) {
      s.imageMode = false;
      const fallback = t2iModels.find((m) => m.id === context.selectedModel) || t2iModels[0];
      s.selectedModel = fallback.id;
      s.selectedModelName = fallback.name;
    }

    // LoRA selection (only meaningful for local workflows).
    const loraModel = s.useLocalModel ? localModelById(s.selectedLocalModel) : null;
    if (loraModel && Array.isArray(context.loras)) {
      s.loraSelectionsByModel.set(loraModel.id, context.loras.map((lora) => ({ ...lora })));
    }

    if (!s.useLocalModel) {
      const resolutions = getCurrentResolutions(s.selectedModel);
      if (resolutions.length > 0 && !resolutions.includes(s.selectedResolution)) {
        s.selectedResolution = resolutions[0];
      }
    }

    updatePromptHelperVisibility();
    void loadLorasForCurrentModel();

    s.prompt = context.prompt || '';
    updateComposerSection('image', { prompt: s.prompt });

    persistImagePreferences();
    bump();
    return true;
  };

  /* ---------------- history / canvas ---------------- */

  const addToHistory = (entry, generationContext = null) => {
    if (generationContext && entry?.url) {
      s.contextStore.remember(entry.url, generationContext);
      // Seal the exact settings so this output can be dragged back in later.
      void rememberGenerationSetup({
        url: entry.url,
        section: 'image',
        mediaType: 'image/*',
        context: generationContext,
        downloadName: `muapi-${entry.id}.jpg`,
      });
    }
    s.history.unshift(entry);
    saveStudioGenerationHistory('muapi_history', s.history, 50);
    bump();
  };

  // Post-generation upscale. The image is decrypted client-side (resolveMediaSrc)
  // and sent to the local /api/upscale route as base64 — nothing leaves the Mac.
  // mode 'fast' = R-ESRGAN only (~seconds); 'max' = ESRGAN + diffusion refine.
  const upscaleEntry = async (entry, mode = 'fast') => {
    if (!entry?.url) return;
    const loadingId = toast.loading(mode === 'max'
      ? 'Upscaling (max quality — this can take a couple minutes)…'
      : 'Upscaling…');
    try {
      const src = await resolveMediaSrc(entry.url);
      const blob = await (await fetch(src)).blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read the image'));
        reader.readAsDataURL(blob);
      });
      const result = await localAI.upscale({ image_base64: dataUrl, mode, scale: 1.5, prompt: entry.prompt || '' });
      if (!result?.url) throw new Error('Upscale finished without an image');
      addToHistory({
        id: `upscale-${entry.id || 'img'}-${mode}-${Date.now()}`,
        url: result.url,
        prompt: entry.prompt || '',
        model: `${entry.model || 'Anima'} · upscaled${mode === 'max' ? ' (max)' : ''}`,
        aspect_ratio: entry.aspect_ratio,
        timestamp: new Date().toISOString(),
      });
      toast.success('Upscaled image added to the gallery.', { id: loadingId });
    } catch (error) {
      toast.error(error?.message || 'Upscale failed', { id: loadingId });
    }
  };

  const viewImage = (imageUrl) => {
    // Track the setup behind the on-screen image so "Back to setup"/"Regenerate"
    // can restore it (resolved from the shared store by output URL).
    s.contextStore.view(imageUrl);
    s.viewerUrl = imageUrl;
    bump();
  };

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
    } catch {
      // Fallback: open in new tab
      window.open(url, '_blank');
    }
  };

  const newPrompt = () => {
    // Start fresh — clears prompt, refs and the viewed setup, keeps saved tuning.
    s.viewerUrl = null;
    s.contextStore.clearViewed();
    s.lastSubmittedContext = null;
    s.prompt = '';
    s.uploadedImageUrls = [];
    s.maxImages = 1;
    s.imageMode = false;
    s.selectedModel = t2iModels[0].id;
    s.selectedModelName = t2iModels[0].name;
    s.selectedAr = getAspectRatiosForModel(s.selectedModel)[0];
    const resetResolutions = getResolutionsForModel(s.selectedModel);
    s.selectedResolution = resetResolutions[0] || '';
    if (!s.useLocalModel) applyStoredModelSettings(`api:${s.selectedModel}`);
    if (s.useLocalModel) {
      const localModel = ensureCompatibleLocalModel();
      if (localModel) {
        s.selectedAr = localModel.aspectRatios?.[0] || s.selectedAr;
        // "Start fresh" clears the canvas, not the model's saved tuning.
        applyStoredModelSettings(`local:${localModel.id}`, localModel);
      }
    }
    schedulePersist();
    bump();
    promptRef.current?.focus();
  };

  /* ---------------- prompt helper (race-guarded, verbatim payload) ---------------- */

  const runPromptHelper = async () => {
    const idea = s.prompt.trim();
    const helper = currentPromptHelper();
    const modelId = s.selectedLocalModel;
    if (!helper) return;
    if (!idea) {
      promptRef.current?.focus();
      return;
    }
    const request = ++s.promptHelperRequest;
    s.promptHelper = {
      open: true,
      busy: true,
      title: helper.label || 'Prompt helper',
      result: '',
      status: 'Refining prompt…',
      negative: '',
      ready: false,
    };
    bump();
    try {
      const sourceImage = s.uploadedImageUrls[0] || '';
      const result = await localAI.generatePrompt({
        model: modelId,
        idea,
        negative_prompt: s.negativePrompt || undefined,
        seed: s.seed,
        active_loras: loraGenerationPayload(currentLoraSelection()),
        ...(sourceImage.startsWith('data:image/') ? { reference_image: sourceImage } : {}),
      });
      if (request !== s.promptHelperRequest || modelId !== s.selectedLocalModel) return;
      const refined = String(result?.prompt || '').trim();
      if (!refined) throw new Error('Prompt helper returned no prompt');
      s.promptHelper = {
        ...s.promptHelper,
        busy: false,
        result: refined,
        negative: String(result?.negative_prompt || ''),
        status: String(result?.title || 'Ready'),
        ready: true,
      };
      bump();
    } catch (error) {
      if (request !== s.promptHelperRequest) return;
      s.promptHelper = { ...s.promptHelper, busy: false, status: error.message, ready: false };
      bump();
    }
  };

  const usePromptHelperResult = () => {
    const result = s.promptHelper.result.trim();
    if (!result) return;
    setPromptValue(result);
    const suggestedNegative = s.promptHelper.negative || '';
    if (suggestedNegative) s.negativePrompt = suggestedNegative;
    persistImagePreferences();
    closePromptHelper();
    bump();
    promptRef.current?.focus();
  };

  /* ---------------- generation ---------------- */

  const cancelLocalGeneration = () => {
    localAI.cancelGeneration();
    s.localProgress = { active: false, pct: 0, label: '' };
    s.generating = false;
    bump();
  };

  const generate = async () => {
    let prompt = s.prompt.trim();
    // Couple mode composes one line per character (optional shared scene
    // first); the backend maps lines to canvas regions.
    let coupleOptions = null;
    if (coupleActive()) {
      const sharedScene = s.coupleShared.trim();
      const characterA = s.coupleA.trim();
      const characterB = s.coupleB.trim();
      if (!characterA && !characterB) {
        toast.error('Couple mode needs at least one character prompt.');
        return;
      }
      const lines = [characterA || characterB, characterB || characterA];
      if (sharedScene) lines.unshift(sharedScene);
      prompt = lines.join('\n');
      coupleOptions = {
        couple_mode: true,
        couple_shared: Boolean(sharedScene),
        couple_direction: s.coupleDirection,
        couple_split: Math.round(s.coupleSplit) / 100,
        couple_pair: s.couplePair,
      };
    }
    // References are sent only when the selected model can take them.
    const sendingRefs = s.uploadedImageUrls.length > 0 && currentModelSupportsImage();
    if (!s.useLocalModel && apiModelRequiresImage(s.selectedModel) && s.uploadedImageUrls.length === 0) {
      toast.error(`${s.selectedModelName} needs a reference image — attach one first.`);
      return;
    }
    if (!sendingRefs && !prompt) {
      toast.error('Please enter a prompt to generate an image.');
      return;
    }

    // Snapshot the full setup so this generation can be reopened from history later.
    s.lastSubmittedContext = captureImageContext(prompt);

    // ── Local inference path ──────────────────────────────────────────────
    if (s.useLocalModel) {
      const lm = localModelById(s.selectedLocalModel);
      if (!lm) { toast.error('No local model selected.'); return; }
      if (lm.requires?.prompt && !prompt) { toast.error('Please enter an edit prompt.'); return; }
      if (lm.requires?.image && s.uploadedImageUrls.length === 0) {
        toast.error(`${lm.name} requires a reference image.`);
        return;
      }

      s.generating = true;
      s.localProgress = { active: true, pct: 0, label: t('common.generating') };
      startImageProgress();
      bump();

      const unsub = localAI.onProgress(({ progress, status, message }) => {
        const pct = Math.round((progress ?? 0) * 100);
        const label = message || (status === 'starting' ? 'Starting...' : `${pct}%`);
        s.localProgress = { active: true, pct, label };
        // Coarse status nudges the bar up (never down); elapsed/estimate drives it.
        s.progressReal = Math.min(1, Math.max(0, progress ?? 0));
        bump();
      });

      try {
        // References are ignored (not sent) when the model can't take them.
        const sourceImage = localModelSupportsImageInput(lm) ? (s.uploadedImageUrls[0] || '') : '';
        const res = await localAI.generate({
          model: s.selectedLocalModel,
          prompt,
          negative_prompt: s.negativePrompt || undefined,
          aspect_ratio: s.selectedAr,
          steps: s.steps,
          guidance_scale: s.guidanceScale,
          seed: s.seed,
          runtime_mode: s.localRuntimeMode,
          width: s.customWidth || undefined,
          height: s.customHeight || undefined,
          loras: loraGenerationPayload(currentLoraSelection()),
          ...(coupleOptions || {}),
          ...(sourceImage.startsWith('data:') ? { image_base64: sourceImage } : {}),
          ...(sourceImage && !sourceImage.startsWith('data:') ? { image_url: sourceImage } : {}),
        });
        unsub();
        s.localProgress = { active: false, pct: 0, label: '' };

        if (!res?.url) throw new Error('No output returned from local generation');
        if (res.mediaType === 'video') {
          throw new Error('This model produces video — use the Video studio instead.');
        }
        addToHistory({
          id: Date.now().toString(),
          url: res.url,
          prompt,
          model: `local:${s.selectedLocalModel}`,
          aspect_ratio: s.selectedAr,
          seed: res.seed,
          timestamp: new Date().toISOString(),
        }, s.lastSubmittedContext);
        finishImageProgress(true);
        viewImage(res.url);
      } catch (e) {
        unsub();
        s.localProgress = { active: false, pct: 0, label: '' };
        finishImageProgress(false);
        console.error('[Local] generation error:', e);
        console.error('[Local] full error:', e.message);
        toast.error(e.message);
      } finally {
        s.generating = false;
        bump();
      }
      return;
    }

    // ── Remote API path ───────────────────────────────────────────────────
    const apiKey = localStorage.getItem('muapi_key');
    if (!apiKey) {
      authRetryRef.current = () => generate();
      s.authOpen = true;
      bump();
      return;
    }

    s.generating = true;
    startImageProgress();
    bump();

    let capturedRequestId = null;
    const historyMeta = { prompt, model: s.selectedModel, aspect_ratio: s.selectedAr };

    try {
      let res;
      const qualityLabel = s.selectedResolution;
      if (sendingRefs) {
        const genParams = {
          model: s.selectedModel,
          images_list: s.uploadedImageUrls,
          image_url: s.uploadedImageUrls[0], // backward compat for single-image models
          aspect_ratio: s.selectedAr,
          onRequestId: (rid) => {
            capturedRequestId = rid;
            savePendingJob({ requestId: rid, studioType: 'image', historyMeta, maxAttempts: 60, interval: 2000, submittedAt: Date.now() });
          },
        };
        if (prompt) genParams.prompt = prompt;
        const qualityField = getCurrentQualityField(s.selectedModel);
        if (qualityField && qualityLabel) genParams[qualityField] = qualityLabel;
        res = await muapi.generateI2I(genParams);
      } else {
        const genParams = {
          model: s.selectedModel,
          prompt,
          aspect_ratio: s.selectedAr,
          onRequestId: (rid) => {
            capturedRequestId = rid;
            savePendingJob({ requestId: rid, studioType: 'image', historyMeta, maxAttempts: 60, interval: 2000, submittedAt: Date.now() });
          },
        };
        const qualityField = getCurrentQualityField(s.selectedModel);
        if (qualityField && qualityLabel) genParams[qualityField] = qualityLabel;
        res = await muapi.generateImage(genParams);
      }

      if (res && res.url) {
        if (capturedRequestId) removePendingJob(capturedRequestId);
        addToHistory({
          id: res.id || capturedRequestId || Date.now().toString(),
          url: res.url,
          prompt,
          model: s.selectedModel,
          aspect_ratio: s.selectedAr,
          timestamp: new Date().toISOString(),
        }, s.lastSubmittedContext);
        finishImageProgress(true);
        viewImage(res.url);
      } else {
        throw new Error('No image URL returned by API');
      }
    } catch (e) {
      if (capturedRequestId) removePendingJob(capturedRequestId);
      finishImageProgress(false);
      console.error(e);
      toast.error(e.message);
    } finally {
      s.generating = false;
      bump();
    }
  };

  /* ---------------- warm / unload (Ideogram sidecar) ---------------- */

  const warmModel = async () => {
    s.warmLabel = 'Warming…';
    s.warmBusy = true;
    bump();
    try {
      await localAI.warmIdeogram4();
      s.warmLabel = 'Warm';
    } catch (e) {
      s.warmLabel = 'Warm failed';
      console.error('[Local] Ideogram warm failed:', e);
    } finally {
      bump();
      setTimeout(() => { s.warmLabel = 'Warm model'; s.warmBusy = false; bump(); }, 2500);
    }
  };

  const unloadModel = async () => {
    s.unloadLabel = 'Unloading…';
    s.unloadBusy = true;
    bump();
    try {
      await localAI.unloadIdeogram4();
      s.unloadLabel = 'Unloaded';
    } catch (e) {
      s.unloadLabel = 'Unload failed';
      console.error('[Local] Ideogram unload failed:', e);
    } finally {
      bump();
      setTimeout(() => { s.unloadLabel = 'Unload'; s.unloadBusy = false; bump(); }, 2500);
    }
  };

  /* ---------------- mount effects (replicate factory boot order) ---------------- */

  useEffect(() => {
    if (mountedOnceRef.current) return undefined;
    mountedOnceRef.current = true;

    // --- Resume any pending image generations from a previous session ---
    (async () => {
      const pending = getPendingJobs('image');
      if (!pending.length) return;
      const apiKey = localStorage.getItem('muapi_key');
      if (!apiKey) return; // can't poll without key; jobs remain for next time

      s.resumeRemaining = pending.length;
      bump();
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
          s.resumeRemaining -= 1;
          bump();
        }
      });
    })();

    // --- Runtime discovery: replace the boot catalog, re-apply saved tuning ---
    localAI.listModels().then((models) => {
      const discovered = (Array.isArray(models) ? models : []).filter((model) => (
        model?.type !== 'video' && model?.state !== 'not-downloaded' && model?.ready !== false
      ));
      if (discovered.length === 0) return;
      s.localImageModels = discovered;
      const localModel = ensureCompatibleLocalModel();
      if (!localModel) return;
      const savedRuntimeMode = s.persistedImagePreferences?.localRuntimeMode;
      s.localRuntimeMode = localModel.runtimeModes?.includes(savedRuntimeMode)
        ? savedRuntimeMode
        : (localModel.defaultRuntimeMode || 'one-off');
      if (s.useLocalModel) {
        if (!s.persistedImagePreferences) applyLocalModelDefaults(localModel);
        s.selectedAr = localModel.aspectRatios?.[0] || s.selectedAr;
        // The catalog just landed — the model's saved tuning (cfg, steps,
        // AR, couple setup) wins over these boot defaults.
        applyStoredModelSettings(`local:${localModel.id}`, null);
        s.maxImages = s.imageMode ? (localModel.maxReferenceImages || 1) : 1;
        updatePromptHelperVisibility();
        if (s.loraOpen) void loadLorasForCurrentModel();
      }
      // Re-evaluate image support and couple capability for the selected model
      // (the boot-time pass may have run before discovery) — derived in render.
      bump();
    }).catch((error) => {
      console.warn('[Local] Unable to discover runtime image workflows:', error);
    });

    // --- Restore the encrypted composer draft (prompt + reference selection) ---
    void hydrateComposerState().then(() => {
      const saved = getComposerSection('image');
      if (typeof saved.prompt === 'string' && saved.prompt && !s.prompt) {
        setPromptValue(saved.prompt);
      }
      // The negative prompt is prompt text, kept in the encrypted composer only, so
      // it arrives with hydration — restore it unless the user already typed one.
      const savedNegative = saved.preferences?.negativePrompt;
      if (typeof savedNegative === 'string' && savedNegative && !s.negativePrompt) {
        s.negativePrompt = savedNegative;
        bump();
      }
      // Per-model negative prompts were stripped from localStorage; the composer
      // holds the full cache — fill in only the ones still missing (never clobber).
      const savedModelSettings = saved.preferences?.modelSettings;
      if (savedModelSettings && typeof savedModelSettings === 'object') {
        for (const [key, entry] of Object.entries(savedModelSettings)) {
          const current = s.modelSettingsById.get(key);
          if (current && entry && typeof entry.negativePrompt === 'string' && !current.negativePrompt) {
            s.modelSettingsById.set(key, { ...current, negativePrompt: entry.negativePrompt });
          }
        }
      }
      const references = Array.isArray(saved.references) ? saved.references.filter(Boolean) : [];
      if (references.length && s.uploadedImageUrls.length === 0) {
        s.maxImages = Math.max(references.length, 1);
        // Intentionally NON-silent: re-runs the selection side effects, like
        // the old picker.setImages(references, { silent: false }).
        handleReferencesSelected(references);
      }
    });

    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Capture-phase persistence — any click/input/change inside the studio root
  // schedules a debounced persist, exactly like the old container listeners.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const schedule = () => schedulePersist();
    ['click', 'input', 'change'].forEach((eventName) => el.addEventListener(eventName, schedule, true));
    return () => {
      ['click', 'input', 'change'].forEach((eventName) => el.removeEventListener(eventName, schedule, true));
      if (s.persistTimer != null) {
        clearTimeout(s.persistTimer);
        s.persistTimer = null;
        persistRef.current();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Unmount: mark unmounted (guards the progress timer's bump) and stop the timer.
  useEffect(() => () => {
    mountedRef.current = false;
    if (s.generationTimer) { clearInterval(s.generationTimer); s.generationTimer = null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Explore dock / hub bridges insert into THIS studio's prompt — but only while
  // it is the visible studio (studios stay mounted-hidden after first visit).
  useEffect(() => {
    if (!active) return undefined;
    const offInsert = registerPromptInserter((text) => {
      const current = s.prompt;
      const needsNewline = current && !current.endsWith('\n');
      setPromptValue(`${current}${needsNewline ? '\n' : ''}${text}`);
      promptRef.current?.focus();
    });
    // "Load in Studio" restores an entire recovered setup (model, seed, steps,
    // cfg, dims, negative, prompt) via the studio's own context-restore path.
    const offSet = registerStudioSetupLoader('image', (setup) => {
      // Drag-to-restore hands the full captured context; apply it verbatim.
      if (setup?.format === 'studio-full-context' && setup.context) {
        restoreImageContext(setup.context);
        promptRef.current?.focus();
        return;
      }
      const localOk = isLocalAIAvailable();
      // Match against the DISCOVERED local models (auto-workflow models live in
      // s.localImageModels, not the static catalog). Trust the id if discovery
      // hasn't populated yet; only fall back if it ran and the model is gone.
      const discovered = Array.isArray(s.localImageModels) ? s.localImageModels : [];
      const matchedModel = setup?.modelId && (discovered.length === 0 || discovered.some((m) => m.id === setup.modelId))
        ? setup.modelId
        : s.selectedLocalModel;
      restoreImageContext({
        prompt: setup?.primaryPrompt || '',
        imageMode: false,
        useLocalModel: localOk,
        selectedModel: s.selectedModel,
        selectedModelName: s.selectedModelName,
        selectedLocalModel: matchedModel,
        localRuntimeMode: s.localRuntimeMode || 'one-off',
        aspectRatio: s.selectedAr,
        resolution: s.selectedResolution,
        negativePrompt: setup?.negativePrompt || '',
        guidanceScale: setup?.cfg ?? s.guidanceScale,
        steps: setup?.steps ?? s.steps,
        seed: (typeof setup?.seed === 'number') ? setup.seed : -1,
        style: s.selectedStyle,
        batchCount: 1,
        customWidth: setup?.width ?? s.customWidth,
        customHeight: setup?.height ?? s.customHeight,
        referenceStrength: s.referenceStrength,
        // Workflow-baked LoRAs are part of the model; restoring them as user
        // LoRAs would double-apply, so leave user LoRAs empty here.
        loras: [],
        referenceImages: [],
      });
      promptRef.current?.focus();
    });
    return () => { offInsert(); offSet(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Prompt textarea auto-grow (same 150/250px caps as the old oninput).
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = window.innerWidth < 768 ? 150 : 250;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  });

  /* ---------------- render ---------------- */

  const activeLocalModel = localModelById(s.selectedLocalModel);
  const modelLabel = s.useLocalModel ? (activeLocalModel?.name || s.selectedLocalModel || '—') : s.selectedModelName;
  const resolutions = s.useLocalModel ? [] : getCurrentResolutions(s.selectedModel);
  const aspectRatios = s.useLocalModel
    ? (activeLocalModel?.aspectRatios || ['1:1'])
    : getCurrentAspectRatios(s.selectedModel);
  const refsSupported = currentModelSupportsImage();
  const refCount = s.uploadedImageUrls.length;
  const refsIgnored = refCount > 0 && !refsSupported;
  const helper = currentPromptHelper();
  const runtimeModes = activeLocalModel?.runtimeModes || [];
  const showRuntimeMode = s.useLocalModel && runtimeModes.length > 0;
  const coupleOn = coupleActive();
  const viewerEntry = s.viewerUrl ? s.history.find((e) => e.url === s.viewerUrl) : null;
  const enhanced = [s.enhanceBase.trim(), Array.from(s.enhanceTags).join(', ')].filter(Boolean).join(', ');

  const generateLabel = s.generating
    ? (s.useLocalModel && s.localProgress.active && s.localProgress.label
      ? s.localProgress.label
      : t('common.generating'))
    : t('common.generate');

  const promptPlaceholder = refCount > 1
    ? `${refCount} ${t('image.multiImageNote') || 'images selected — describe the transformation (optional)'}`
    : refCount > 0
      ? t('image.placeholderTransform')
      : t('image.placeholder');

  const panel = (
    <>
      {isLocalAIAvailable() ? (
        <div className="flex flex-col gap-2">
          <SectionLabel>Source</SectionLabel>
          <Segmented
            value={s.useLocalModel ? 'local' : 'api'}
            onChange={(v) => setSource(v === 'local')}
            options={[
              { value: 'local', label: t('image.local') },
              { value: 'api', label: t('image.api') },
            ]}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <SectionLabel>Model</SectionLabel>
        <ModelMenu
          engine={s}
          modelLabel={modelLabel}
          hasRefs={refCount > 0}
          onSelectLocal={selectLocalModel}
          onSelectApi={selectApiModel}
        />
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>Format</SectionLabel>
        <Field label="Aspect ratio">
          <NativeSelect
            title={t('image.arTooltip')}
            value={s.selectedAr}
            onChange={(e) => { s.selectedAr = e.target.value; persistImagePreferences(); bump(); }}
          >
            {aspectRatios.map((r) => <option key={r} value={r}>{r}</option>)}
          </NativeSelect>
        </Field>
        {resolutions.length > 0 ? (
          <Field label="Resolution">
            <NativeSelect
              title={t('image.qualityTooltip')}
              value={s.selectedResolution}
              onChange={(e) => { s.selectedResolution = e.target.value; persistImagePreferences(); bump(); }}
            >
              {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
            </NativeSelect>
          </Field>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>{t('image.advancedOptions')}</SectionLabel>
        <Field label={t('image.steps')}>
          <Slider min={1} max={50} step={1} value={s.steps}
            onChange={(v) => { s.steps = v; bump(); }} />
        </Field>
        <Field label={t('image.guidanceScale')}>
          <Slider min={1} max={20} step={0.5} value={s.guidanceScale}
            onChange={(v) => { s.guidanceScale = v; bump(); }} />
        </Field>
        <Field label={t('image.seed')}>
          <div className="flex items-center gap-1.5">
            <TextInput
              type="number"
              className="font-mono"
              placeholder={t('image.seedPlaceholder')}
              value={s.seedText}
              onChange={(e) => { s.seedText = e.target.value; s.seed = parseInt(e.target.value) || -1; bump(); }}
            />
            <IconButton icon="refresh" label={t('common.randomize')} onClick={() => {
              s.seed = Math.floor(Math.random() * 999999999);
              s.seedText = String(s.seed);
              bump();
            }} />
          </div>
        </Field>
        <Field label={t('image.batchCount')}>
          <Slider min={1} max={4} step={1} value={s.batchCount}
            onChange={(v) => { s.batchCount = v; bump(); }} />
        </Field>
        <Field label={t('image.stylePreset')}>
          <NativeSelect value={s.selectedStyle} onChange={(e) => { s.selectedStyle = e.target.value; bump(); }}>
            {STYLE_PRESETS.map((preset) => <option key={preset} value={preset}>{preset}</option>)}
          </NativeSelect>
        </Field>
        <Field label={t('image.negPromptLabel')}>
          <TextInput
            placeholder={t('image.negPromptPlaceholder')}
            value={s.negativePrompt}
            onChange={(e) => { s.negativePrompt = e.target.value; bump(); }}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('image.width')}>
            <TextInput type="number" className="font-mono" placeholder={t('image.widthPlaceholder')}
              value={s.customWidth ? String(s.customWidth) : ''}
              onChange={(e) => { s.customWidth = parseInt(e.target.value) || 0; bump(); }} />
          </Field>
          <Field label={t('image.height')}>
            <TextInput type="number" className="font-mono" placeholder={t('image.heightPlaceholder')}
              value={s.customHeight ? String(s.customHeight) : ''}
              onChange={(e) => { s.customHeight = parseInt(e.target.value) || 0; bump(); }} />
          </Field>
        </div>
        <Field label={t('image.refStrength')} hint={t('image.refStrengthNote')}>
          <Slider min={0} max={100} step={5} value={s.referenceStrength} format={(v) => `${v}%`}
            onChange={(v) => { s.referenceStrength = v; bump(); }} />
        </Field>
      </div>

      {showRuntimeMode ? (
        <div className="flex flex-col gap-2">
          <SectionLabel>Local runtime mode</SectionLabel>
          <Segmented
            value={s.localRuntimeMode}
            onChange={(v) => { s.localRuntimeMode = v; bump(); }}
            options={[
              { value: 'one-off', label: 'One-off generation' },
              { value: 'persistent', label: 'Keep model loaded' },
            ]}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={warmModel} disabled={s.warmBusy}>{s.warmLabel}</Button>
            <Button size="sm" variant="danger" onClick={unloadModel} disabled={s.unloadBusy}>{s.unloadLabel}</Button>
          </div>
          <p className="text-xs leading-relaxed text-ink3">
            One-off frees RAM after each image. Keep loaded uses the loopback-only Apple Silicon MLX sidecar for faster follow-up images.
          </p>
        </div>
      ) : null}

      {coupleCapableModel() ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <SectionLabel>Couple mode</SectionLabel>
            <Toggle
              label="Couple mode"
              checked={s.coupleMode}
              onChange={(v) => { s.coupleMode = v; persistImagePreferences(); bump(); }}
            />
          </div>
          <p className="text-xs leading-relaxed text-ink3">
            Two-character mode: one prompt per character with a canvas split. Character text stays in this session only.
          </p>
          {coupleOn ? (
            <div className="flex flex-col gap-3">
              <Field label="Shared scene (optional)">
                <TextInput
                  placeholder="e.g. sitting by a bonfire at night"
                  value={s.coupleShared}
                  onChange={(e) => { s.coupleShared = e.target.value; bump(); }}
                />
              </Field>
              <Field label={s.couplePair === 'mixed' ? 'Character A (girl)' : 'Character A'}>
                <TextArea rows={2} placeholder="e.g. haruno sakura, pink hair, smiling"
                  value={s.coupleA}
                  onChange={(e) => { s.coupleA = e.target.value; bump(); }} />
              </Field>
              <Field label={s.couplePair === 'mixed' ? 'Character B (boy)' : 'Character B'}>
                <TextArea rows={2} placeholder="e.g. black hair, green eyes, crossed arms"
                  value={s.coupleB}
                  onChange={(e) => { s.coupleB = e.target.value; bump(); }} />
              </Field>
              <Field label="Pair">
                <Segmented size="sm" value={s.couplePair}
                  onChange={(v) => { s.couplePair = v; persistImagePreferences(); bump(); }}
                  options={[
                    { value: 'girls', label: 'Two girls' },
                    { value: 'mixed', label: 'Girl & boy' },
                    { value: 'boys', label: 'Two boys' },
                  ]}
                />
              </Field>
              <Field label="Layout">
                <Segmented size="sm" value={s.coupleDirection}
                  onChange={(v) => { s.coupleDirection = v; persistImagePreferences(); bump(); }}
                  options={[
                    { value: 'horizontal', label: 'Side by side' },
                    { value: 'vertical', label: 'Stacked' },
                  ]}
                />
              </Field>
              <Field
                label={s.coupleDirection === 'vertical'
                  ? `A ${Math.round(s.coupleSplit)}% top / B ${100 - Math.round(s.coupleSplit)}%`
                  : `A ${Math.round(s.coupleSplit)}% / B ${100 - Math.round(s.coupleSplit)}%`}
              >
                <div className="flex flex-col gap-1.5">
                  <div className="flex h-1.5 w-full overflow-hidden rounded-full">
                    <div className="bg-honey" style={{ width: `${Math.round(s.coupleSplit)}%` }} />
                    <div className="bg-info" style={{ width: `${100 - Math.round(s.coupleSplit)}%` }} />
                  </div>
                  <Slider min={10} max={90} step={5} value={s.coupleSplit}
                    onChange={(v) => { s.coupleSplit = v; bump(); }}
                    onCommit={() => persistImagePreferences()}
                    format={(v) => `${v}%`} />
                </div>
              </Field>
            </div>
          ) : null}
        </div>
      ) : null}

      {s.useLocalModel ? (
        <LoraSection
          open={s.loraOpen}
          onToggleOpen={() => {
            s.loraOpen = !s.loraOpen;
            bump();
            // Lazy-load exactly like the old Advanced panel toggle did.
            if (s.loraOpen) void loadLorasForCurrentModel();
          }}
          baseLabel={s.loraBaseLabel}
          status={s.loraCatalogStatus}
          message={s.loraCatalogMessage}
          loras={s.availableLoras}
          selection={currentLoraSelection()}
          onToggleLora={(lora) => {
            setCurrentLoraSelection(toggleLoraSelection(currentLoraSelection(), lora));
            bump();
          }}
          onSetStrength={(id, value) => {
            setCurrentLoraSelection(updateLoraStrength(currentLoraSelection(), id, value));
          }}
          onCommitStrength={(id, value) => {
            setCurrentLoraSelection(updateLoraStrength(currentLoraSelection(), id, value));
            bump();
          }}
          onClearAll={() => { setCurrentLoraSelection([]); bump(); }}
          onDownload={() => { s.civitaiOpen = true; bump(); }}
        />
      ) : null}
    </>
  );

  const composer = (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
      {s.promptHelper.open ? (
        <Card className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <SectionLabel className="text-honey">{s.promptHelper.title || 'Prompt helper'}</SectionLabel>
            <IconButton icon="x" label="Dismiss prompt helper" size="sm" onClick={() => { closePromptHelper(); bump(); }} />
          </div>
          <TextArea
            rows={4}
            disabled={s.promptHelper.busy}
            value={s.promptHelper.result}
            onChange={(e) => { s.promptHelper = { ...s.promptHelper, result: e.target.value }; bump(); }}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-xs text-ink3" role="status" aria-live="polite">
              {s.promptHelper.status}
            </span>
            <Button size="sm" variant="primary" disabled={!s.promptHelper.ready} onClick={usePromptHelperResult}>
              Use prompt
            </Button>
          </div>
        </Card>
      ) : null}

      {s.enhancerOpen ? (
        <Card className="flex flex-col gap-3 p-3">
          <div className="flex items-center justify-between gap-2">
            <SectionLabel>{t('image.promptEnhancer')}</SectionLabel>
            <IconButton icon="x" label={t('common.less')} size="sm" onClick={() => { s.enhancerOpen = false; bump(); }} />
          </div>
          <TextInput
            placeholder={t('image.basePromptPlaceholder')}
            value={s.enhanceBase}
            onChange={(e) => { s.enhanceBase = e.target.value; bump(); }}
          />
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">{t('image.enhancementTags')}</span>
            {Object.entries(ENHANCE_TAGS).map(([category, tags]) => (
              <div key={category} className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink3">{category}</span>
                {tags.map((tag) => {
                  const on = s.enhanceTags.has(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      data-tag={tag}
                      onClick={() => {
                        if (on) s.enhanceTags.delete(tag); else s.enhanceTags.add(tag);
                        bump();
                      }}
                      className={cx(
                        'rounded-full border px-2 py-0.5 text-[11px] transition-colors duration-150',
                        on ? 'border-honey/50 bg-honey-tint text-honey' : 'border-line1 bg-bg2 text-ink2 hover:border-line2',
                      )}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink3">{t('image.enhancedPrompt')}</span>
            <div className={cx('min-h-[40px] rounded-md border border-line1 bg-bg2 px-3 py-2 text-xs leading-relaxed', enhanced ? 'text-ink1' : 'text-ink3')}>
              {enhanced || t('image.enhancedPlaceholder')}
            </div>
            <div className="flex gap-2">
              <Button size="sm" icon="copy" onClick={() => {
                if (!enhanced) return;
                navigator.clipboard.writeText(enhanced);
                s.enhanceCopied = true;
                bump();
                setTimeout(() => { s.enhanceCopied = false; bump(); }, 1500);
              }}>
                {s.enhanceCopied ? t('common.copied') : t('common.copy')}
              </Button>
              <Button size="sm" variant="neutral" onClick={() => {
                if (!enhanced) return;
                setPromptValue(enhanced);
                s.enhancerOpen = false;
                bump();
              }}>
                {t('common.useInGenerator')}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="flex flex-col gap-2 rounded-lg border border-line1 bg-bg1 p-2.5 transition-colors focus-within:border-honey/40">
        {coupleOn ? (
          <div className="flex items-center gap-2 px-1 py-1.5 text-[13px] text-ink2">
            <Icon name="info" size={14} className="shrink-0 text-ink3" />
            Couple mode is on — set the character prompts in the settings panel; they compose into one generation.
          </div>
        ) : (
          <textarea
            ref={promptRef}
            rows={1}
            placeholder={promptPlaceholder}
            value={s.prompt}
            onChange={(e) => setPromptValue(e.target.value)}
            className="max-h-[150px] min-h-[40px] w-full resize-none overflow-y-auto border-none bg-transparent px-1 pt-1 text-[15px] leading-relaxed text-ink1 outline-none placeholder:text-ink3 md:max-h-[250px]"
          />
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <UploadPicker
            values={s.uploadedImageUrls}
            onChange={handlePickerChange}
            uploadFn={(file) => (s.useLocalModel ? fileToDataUrl(file) : muapi.uploadFile(file))}
            requireApiKey={() => !s.useLocalModel}
            maxImages={s.maxImages}
            accept="image/*"
            disabled={!refsSupported}
            compact
            label={refsSupported ? 'Reference image' : 'This model does not accept reference images'}
          />

          {refCount > 0 ? (
            <span
              className={cx(
                'inline-flex h-ctl-md shrink-0 items-center gap-2 rounded-md border border-honey/40 bg-honey-tint px-2.5 text-xs font-semibold text-honey',
                refsIgnored && 'opacity-60',
              )}
              title={refsIgnored
                ? 'The selected model does not accept image references; they stay attached but are not sent.'
                : 'These references are sent with your next generation.'}
            >
              {refsIgnored
                ? `${refCount} ${refCount === 1 ? 'reference image' : 'reference images'} — ignored by this model`
                : `Using ${refCount} ${refCount === 1 ? 'reference image' : 'reference images'}`}
              <button
                type="button"
                className="font-bold underline decoration-honey/40 underline-offset-2 transition-colors hover:text-ink1"
                onClick={clearReferences}
              >
                {t('common.clearReferences')}
              </button>
            </span>
          ) : null}

          <Menu
            up
            width="w-64"
            trigger={(open, toggle) => (
              <ChipButton icon="sparkles" label={t('common.tools')} active={open} onClick={toggle} title={t('image.toolsTooltip')} />
            )}
          >
            {(close) => (
              <>
                <MenuHeading>{t('image.quickStarters')}</MenuHeading>
                {QUICK_PROMPTS.map((q) => (
                  <MenuItem key={q.label} onClick={() => { setPromptValue(q.prompt); close(); }}>
                    {q.label}
                  </MenuItem>
                ))}
                <MenuHeading>{t('image.quickTools')}</MenuHeading>
                <MenuItem icon="wand" onClick={() => { s.enhancerOpen = true; bump(); close(); }}>
                  {t('image.promptEnhancer')}
                </MenuItem>
              </>
            )}
          </Menu>

          {helper ? (
            <ChipButton
              icon="wand"
              value={helper.label || 'Prompt helper'}
              chevron={false}
              disabled={s.promptHelper.busy}
              onClick={runPromptHelper}
              title="Refine with this workflow prompt helper"
              className="border-honey/40 text-honey"
            />
          ) : null}

          <div className="min-w-2 flex-1" />

          <Pill tone="neutral" className="hidden font-mono sm:inline-flex" title={t('image.modelTooltip')}>
            <Icon name={s.useLocalModel ? 'cpu' : 'cloud'} size={12} />
            {modelLabel}
          </Pill>

          <Button
            variant="primary"
            size="lg"
            loading={s.generating}
            onClick={generate}
            title={t('image.generateTooltip')}
            className="min-w-[130px]"
          >
            {generateLabel}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <StudioLayout panel={panel} panelTitle="Image settings" composer={composer}>
        <div className="flex flex-col gap-4 p-4 md:p-5">
          {s.generating ? (() => {
            const pct = Math.max(0, Math.min(1, Number(s.progressDisplay) || 0));
            const eta = Number(s.progressEstimateSec) > 0 ? formatElapsed(s.progressEstimateSec * 1000) : null;
            return (
              <Card className="flex flex-col gap-2.5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold text-ink2">
                    {s.useLocalModel ? t('image.generatingLocally') : t('common.generating')}
                  </span>
                  <span className="font-mono text-xs font-semibold text-honey">{Math.round(pct * 100)}%</span>
                </div>
                <ProgressBar value={pct} />
                <div className="flex items-center justify-between gap-3 font-mono text-[11px] text-ink3">
                  <span className="min-w-0 truncate">
                    {s.localProgress.label || (s.useLocalModel ? `local:${s.selectedLocalModel}` : (s.selectedModelName || s.selectedModel))}
                  </span>
                  <span className="shrink-0">
                    {formatElapsed(Date.now() - s.generationStartedAt)}{eta ? ` / ~${eta}` : ''}
                  </span>
                </div>
                {s.useLocalModel ? (
                  <div className="flex justify-end">
                    <Button size="sm" variant="ghost" onClick={cancelLocalGeneration}>{t('common.cancel')}</Button>
                  </div>
                ) : null}
              </Card>
            );
          })() : null}

          {s.history.length === 0 && !s.generating ? (
            <EmptyState
              icon="image"
              title="Create your first image"
              hint="Enter a prompt below and press Generate. Tip: be descriptive — include style, lighting, mood, and subject for best results."
              className="flex-1"
            />
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <SectionLabel>{t('common.history')}</SectionLabel>
                <span className="font-mono text-[11px] text-ink3">{s.history.length}</span>
              </div>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
                {s.history.map((entry, idx) => (
                  <GalleryCard
                    key={entry.id || `${entry.url}-${idx}`}
                    entry={entry}
                    active={s.viewerUrl ? s.viewerUrl === entry.url : idx === 0}
                    canReuse={refsSupported}
                    onOpen={() => viewImage(entry.url)}
                    onDownload={() => downloadImage(entry.url, `muapi-${entry.id || idx}.jpg`)}
                    onReuse={() => {
                      const next = [...s.uploadedImageUrls.filter((u) => u !== entry.url), entry.url]
                        .slice(0, Math.max(s.maxImages, 1));
                      handleReferencesSelected(next);
                    }}
                    onUpscale={isLocalAIAvailable() ? (mode) => upscaleEntry(entry, mode) : undefined}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </StudioLayout>

      {s.viewerUrl ? (
        <ViewerModal
          url={s.viewerUrl}
          entry={viewerEntry}
          onClose={() => { s.viewerUrl = null; bump(); promptRef.current?.focus(); }}
          onBackToSetup={() => {
            const viewed = s.contextStore.getViewed();
            if (viewed) restoreImageContext(viewed);
            s.viewerUrl = null;
            schedulePersist();
            bump();
            promptRef.current?.focus();
          }}
          onRegenerate={() => {
            const viewed = s.contextStore.getViewed();
            if (viewed) restoreImageContext(viewed);
            s.viewerUrl = null;
            bump();
            void generate();
          }}
          onDownload={() => {
            const entry = viewerEntry;
            downloadImage(s.viewerUrl, `muapi-${entry?.id || 'image'}.jpg`);
          }}
          onNew={newPrompt}
          onUpscale={isLocalAIAvailable() ? (mode) => upscaleEntry(viewerEntry, mode) : undefined}
        />
      ) : null}

      {s.authOpen ? (
        <AuthModal
          onClose={() => { s.authOpen = false; authRetryRef.current = null; bump(); }}
          onSaved={() => {
            s.authOpen = false;
            bump();
            const retry = authRetryRef.current;
            authRetryRef.current = null;
            if (retry) retry();
          }}
        />
      ) : null}

      {s.civitaiOpen ? (
        <CivitaiDownloadDialog
          api={localAI}
          onComplete={() => loadLorasForCurrentModel()}
          onClose={() => { s.civitaiOpen = false; bump(); }}
        />
      ) : null}

      {s.resumeRemaining > 0
        ? createPortal(
          <div className="fixed left-1/2 top-4 z-[200] flex -translate-x-1/2 items-center gap-2.5 rounded-lg border border-line1 bg-bg1 px-4 py-2.5 text-[13px] text-ink1 shadow-pop">
            <Spinner size={14} className="text-honey" />
            <span>{`Resuming ${s.resumeRemaining} pending generation${s.resumeRemaining > 1 ? 's' : ''}…`}</span>
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}

/* ---------------- model picker ---------------- */

function ModelMenu({ engine, modelLabel, hasRefs, onSelectLocal, onSelectApi }) {
  return (
    <Menu
      width="w-[300px]"
      panelClassName="max-h-[min(480px,70vh)]"
      trigger={(open, toggle) => (
        <ChipButton
          icon={engine.useLocalModel ? 'cpu' : 'cloud'}
          value={modelLabel}
          active={open}
          onClick={toggle}
          title={t('image.modelTooltip')}
          className="w-full max-w-full justify-between"
        />
      )}
    >
      {(close) => (
        <ModelMenuList
          engine={engine}
          hasRefs={hasRefs}
          close={close}
          onSelectLocal={onSelectLocal}
          onSelectApi={onSelectApi}
        />
      )}
    </Menu>
  );
}

function ModelMenuList({ engine: s, hasRefs, close, onSelectLocal, onSelectApi }) {
  const [filter, setFilter] = useState('');
  const query = filter.toLowerCase();
  const matches = (m) => m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query);

  const search = (
    <div className="sticky top-0 z-10 -mx-1.5 -mt-1.5 mb-1 border-b border-line1 bg-bg1 p-1.5">
      <div className="flex items-center gap-2 rounded-md border border-line1 bg-bg2 px-2.5 focus-within:border-honey/60">
        <Icon name="search" size={13} className="shrink-0 text-ink3" />
        <input
          type="text"
          autoFocus
          placeholder={t('common.searchModels')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-8 w-full border-none bg-transparent text-xs text-ink1 outline-none placeholder:text-ink3"
        />
      </div>
    </div>
  );

  if (s.useLocalModel) {
    // Runtime-discovered, launchable local image workflows — never filtered by refs.
    const filtered = s.localImageModels.filter(matches);
    return (
      <>
        {search}
        {filtered.length === 0 ? (
          <div className="px-2.5 py-4 text-center text-xs text-ink3">{t('common.noResults')}</div>
        ) : (
          filtered.map((m) => (
            <MenuItem
              key={m.id}
              selected={s.selectedLocalModel === m.id}
              meta={`${String(m.type || 'image').toUpperCase()} · ${m.family || 'local'}`}
              onClick={() => { onSelectLocal(m); close(); }}
            >
              <span className="inline-flex items-center gap-1.5">
                {m.name}
                {m.featured ? <Pill tone="honey" className="h-4 px-1.5 text-[9px]">Featured</Pill> : null}
                {m.requires?.image ? <Pill tone="warn" className="h-4 px-1.5 text-[9px]">Image required</Pill> : null}
              </span>
            </MenuItem>
          ))
        )}
      </>
    );
  }

  // Remote (API) model list — two labeled sections; models are never hidden
  // because of references. Editing models lead when references are attached.
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
  const any = sections.some((section) => section.models.length);

  return (
    <>
      {search}
      {!any ? (
        <div className="px-2.5 py-4 text-center text-xs text-ink3">{t('common.noResults')}</div>
      ) : (
        sections.map((section) => (
          section.models.length ? (
            <div key={section.label}>
              <MenuHeading>{section.label}</MenuHeading>
              {section.models.map((m) => {
                const requiresImage = section.editing && apiModelRequiresImage(m.id);
                return (
                  <MenuItem
                    key={m.id}
                    selected={s.selectedModel === m.id}
                    meta={m.family || ''}
                    onClick={() => { onSelectApi(m); close(); }}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {m.name}
                      {requiresImage ? (
                        <Pill tone="warn" className="h-4 px-1.5 text-[9px]">Image required</Pill>
                      ) : section.editing ? (
                        <Pill tone="honey" className="h-4 px-1.5 text-[9px]">Image</Pill>
                      ) : null}
                    </span>
                  </MenuItem>
                );
              })}
            </div>
          ) : null
        ))
      )}
    </>
  );
}
