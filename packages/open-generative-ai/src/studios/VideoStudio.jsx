// Video Studio — React port of src/components/VideoStudio.js (3285 lines, vanilla).
// T2V / I2V / V2V / local Hivemind LTX workflows / Wan2GP, model+parameter
// selection, LTX Ingredients reference sheets, LoRA management, job-based
// generation with resume, results canvas, and history.
//
// Port rules honored here:
// - All src/lib modules are consumed unchanged (source of truth).
// - The imperative state cascades (mode switches, model defaults, restore) live
//   in ./video/videoLogic.jsx as pure transitions over an immutable `setup`
//   object; this component wires them to the UI and lib. Labels render FROM state
//   (the old getElementById sync layer is gone).
// - alert() -> toast.error() / an inline danger callout, with identical abort
//   semantics (a validation that aborted still aborts).
// - The two window listeners ('hivemind-workflow-selected',
//   'hivemind-context-updated') now add/remove in a mount effect, fixing the leak.
// - Media <video>/<img> srcs resolve through useMediaSrc (E2E decrypt, fail-open).
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'react-hot-toast';

import { muapi } from '../lib/muapi.js';
import { localAI, isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { isWan2gpModelId } from '../lib/localModels.js';
import { startCivitaiDownload } from '../lib/civitaiDownloadStore.js';
import { loraGenerationPayload, mergeLoraUpdates, replaceLoraInSelection, toggleLoraEnabled, toggleLoraSelection, updateLoraStrength } from '../lib/loraSelection.js';
import { createGenerationContextStore } from '../lib/generationContext.js';
import { resolveMediaSrc } from '../lib/e2eMedia.js';
import { downloadMedia } from '../lib/downloadMedia.js';
import { savePendingJob, removePendingJob, getPendingJobs } from '../lib/pendingJobs.js';
import { videoDownloadName } from '../lib/downloadNames.js';
import {
  isCompletionPingEnabled, setCompletionPingEnabled, subscribeCompletionPing,
  primeCompletionPing, playCompletionPing,
} from '../lib/completionPing.js';
import {
  generateHivemindVideo,
  cancelHivemindVideoJob,
  deleteHivemindStudioUpload,
  getSavedHivemindVideoSelection,
  isHivemindStudioEnabled,
  isHivemindVideoModelId,
  loadStudioGenerationHistory,
  loadHivemindStudioContext,
  pollHivemindVideoJob,
  previewHivemindIngredientSheet,
  saveStudioGenerationHistory,
  uploadFileToHivemindStudio,
  workflowIdFromHivemindModelId,
} from '../lib/hivemindStudio.js';
import { t } from '../lib/i18n.js';

import { registerPromptInserter, registerStudioSetupLoader } from '../app/promptTarget.js';
import { rememberGenerationSetup } from '../lib/generationSetupStore.js';
import { getComposerSection, hydrateComposerState, updateComposerSection } from '../lib/composerState.js';
import { useMediaSrc } from '../hooks/hooks.js';
import { Icon } from '../ui/icons.jsx';
import {
  Button, Card, EmptyState, Field, IconButton, NativeSelect, Pill, ProgressBar,
  SectionLabel, Segmented, Spinner, TextInput, Toggle, cx,
} from '../ui/kit.jsx';
import { ChipButton, Menu, MenuHeading, MenuItem } from '../ui/Menu.jsx';
import { ConfirmModal } from '../ui/Modal.jsx';
import { StudioLayout } from '../ui/kit.jsx';

import { UploadPicker } from './UploadPicker.jsx';
import { FrameSlotsPicker } from './video/FrameSlotsPicker.jsx';
import { AuthModal } from '../dialogs/AuthModal.jsx';
import { CivitaiDownloadDialog } from '../dialogs/CivitaiDownloadDialog.jsx';
import { PromptHelperDialog } from '../dialogs/PromptHelperDialog.jsx';
import { LoraSection } from './image/LoraSection.jsx';
import { SavedPromptsMenu } from './SavedPromptsMenu.jsx';
import { IngredientsPanel } from './video/IngredientsPanel.jsx';

import {
  VIDEO_PREFERENCES_KEY, zh,
  buildCatalogs, buildInitialSetup, adaptHivemindToVideoEntry, isLocalVideoModel, v2vModels,
  currentModel, currentIngredientModel, frameSlotsVisible, activeIngredientSheetItems, ingredientSelectionSignature,
  getIngredientsWorkflow,
  isMotionControlV2V, isHivemindVideoInputMode,
  aspectRatiosFor, durationsFor, resolutionsFor, modesFor, qualitiesFor, effectNamesFor,
  deriveControlVisibility, deriveExtendBanner, derivePromptUi,
  applyRestoredPreferences, applyGenerationContext,
  startFrameSelectedTransition, startFrameClearedTransition, clearVideoUploadTransition,
  videoUploadedTransition, selectV2VModelTransition, selectRegularModelTransition,
  selectHivemindWorkflowTransition, newPromptTransition, extendTransition,
  getAdvancedVideoInputs, getAdvancedVideoPayload,
  normalizeVideoPreferences, normalizeVideoIngredientSelections, normalizeSelectedVideoIngredientSheet,
  normalizeVideoGenerationProgress, classifyVideoGenerationStage, formatVideoGenerationElapsed,
  computeSmoothProgress,
  closestVideoAspectRatio, imageDimensions, redactPrivateHistoryEntry,
  groupModelTiers, activeTierFor, tierPairFor,
} from './video/videoLogic.jsx';

// Re-export the spec-listed pure helpers so tests/other callers keep importing
// them from a video studio module.
export {
  getAdvancedVideoInputs, getAdvancedVideoPayload, normalizeVideoPreferences,
  normalizeVideoIngredientSelections, normalizeSelectedVideoIngredientSheet,
  normalizeVideoGenerationProgress, classifyVideoGenerationStage, formatVideoGenerationElapsed,
  closestVideoAspectRatio,
} from './video/videoLogic.jsx';

/* ---------------- media leaves (E2E-transparent) ---------------- */

function ResultVideo({ url }) {
  const src = useMediaSrc(url);
  return (
    <video
      src={src}
      controls
      loop
      autoPlay
      muted
      playsInline
      className="max-h-[58vh] w-auto max-w-full rounded-lg border border-line1 bg-bg0 object-contain"
    />
  );
}

function HistoryThumb({ url }) {
  const src = useMediaSrc(url);
  return <video src={src} muted preload="metadata" className="aspect-square w-full bg-bg0 object-cover" />;
}

function ProgressPreview({ url }) {
  const src = useMediaSrc(url);
  return <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover opacity-60" />;
}

/* ---------------- one mutable engine per mount ---------------- */

function createEngine() {
  let persisted = null;
  try {
    persisted = normalizeVideoPreferences(JSON.parse(localStorage.getItem(VIDEO_PREFERENCES_KEY) || 'null'));
  } catch { /* corrupted prefs — boot with defaults */ }

  const videoLoraSelectionsByModel = new Map();
  Object.entries(persisted?.loraSelections || {}).forEach(([model, sel]) => videoLoraSelectionsByModel.set(model, sel));
  const sharedIngredientSelections = (persisted?.ingredientSelections || []).map((x) => ({ ...x }));
  const sharedIngredientSheets = (persisted?.ingredientSheets || []).map((x) => ({ ...x }));
  const selectedIngredientSheet = normalizeSelectedVideoIngredientSheet(
    persisted?.ingredientSelectedSheet, sharedIngredientSelections, sharedIngredientSheets,
  );

  // The hivemind lane is empty until loadHivemindStudioContext() lands; the
  // restore below resolves cloud/wan2gp models synchronously, and applyHivemind-
  // Workflows re-runs it once the local catalog arrives.
  const catalogs = buildCatalogs([]);
  let setup = buildInitialSetup(catalogs);
  const restored = applyRestoredPreferences(setup, persisted, catalogs);
  if (restored) setup = restored;

  return {
    persistedVideoPreferences: persisted,
    catalogs,
    setup,
    hivemindWorkflowSignature: '',
    // Mirror of the shared (all-studio) completion-ping setting, kept here only
    // so the toggle re-renders; lib/completionPing.js owns the value.
    pingWhenComplete: isCompletionPingEnabled(),
    contextStore: createGenerationContextStore(),
    lastSubmittedContext: null,
    lastGenerationId: null,
    lastGenerationModel: null,
    preserveNextStartFrameAspect: false,
    // Set when a start-frame pick switches to a model with keyframe slots, so the
    // FrameSlotsPicker that replaces the plain picker mounts already open. Consumed
    // by that mount and cleared on the next render.
    framesPanelAutoOpen: false,
    // LoRA
    videoLoraSelectionsByModel,
    availableVideoLoras: [],
    videoLoraCatalogStatus: 'idle',
    videoLoraCatalogMessage: '',
    videoLoraCatalogRequest: 0,
    videoLoraCatalogModelId: '',
    loraOpen: false,
    // Ingredients
    sharedIngredientSelections,
    sharedIngredientSheets,
    selectedIngredientSheet,
    ingredientUploadMessage: '',
    ingredientSheetPreviewRequest: 0,
    ingredientSheetPreview: {
      workflowId: '', signature: '', status: 'idle', url: '',
      columns: null, rows: null, width: null, height: null, sourceCount: 0, error: '',
    },
    // generation / canvas
    generating: false,
    generateError: '',
    videoUploading: false,
    progress: { stage: 'preparing', value: null },
    progressContext: null,
    generationStartedAt: 0,
    generationTimer: null,
    // Smoothed, monotonic bar (0-1) driven by elapsed/estimate and nudged upward by
    // real backend progress; progressReal = last real value; estimate in seconds.
    progressDisplay: 0,
    progressReal: 0,
    progressEstimateSec: null,
    // Job id of the in-flight LOCAL Media Studio render, mirrored to sessionStorage
    // (pendingJobs) so a tab switch / reload can resume its live progress.
    activeLocalJobId: null,
    // AbortController for the in-flight generation poll — the Cancel button aborts
    // it to stop polling immediately (independent of the backend interrupt).
    abortController: null,
    resultUrl: null,
    resultModel: null,
    // The concrete seed used by the most recent generation (for display/lock).
    lastSeed: null,
    // history + dialogs
    generationHistory: loadStudioGenerationHistory('video_history').map(redactPrivateHistoryEntry),
    authOpen: false,
    authRetry: null,
    civitaiOpen: false,
    promptHelperOpen: false,
    resumeRemaining: 0,
    deleteTarget: null,
    persistTimer: null,
  };
}

export function VideoStudio({ active = true } = {}) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = createEngine();
  const s = engineRef.current;
  const [, setTick] = useState(0);
  const mountedRef = useRef(true);
  const bump = () => { if (mountedRef.current) setTick((n) => n + 1); };

  const rootRef = useRef(null);
  const promptRef = useRef(null);
  const videoFileInputRef = useRef(null);
  const mountedOnceRef = useRef(false);

  const focusPrompt = () => promptRef.current?.focus();

  /* ---------------- persistence ---------------- */

  const persistVideoPreferences = () => {
    const prefs = normalizeVideoPreferences({
      modelId: s.setup.modelId,
      localMode: s.setup.localMode,
      duration: s.setup.duration,
      aspectRatio: s.setup.ar,
      resolution: s.setup.resolution,
      quality: s.setup.quality,
      mode: s.setup.mode,
      effectName: s.setup.effectName,
      matchStartFrameAr: s.setup.matchStartFrameAr,
      denoise: s.setup.denoise,
      seed: s.setup.seed,
      advancedValues: s.setup.advancedValues,
      loraSelections: Object.fromEntries(s.videoLoraSelectionsByModel),
      ingredientSelections: s.sharedIngredientSelections,
      ingredientSheets: s.sharedIngredientSheets,
      ingredientSelectedSheet: s.selectedIngredientSheet,
      // pingWhenComplete is deliberately NOT persisted here — it is a shared
      // all-studio setting owned by lib/completionPing.js.
    });
    if (!prefs) return;
    s.persistedVideoPreferences = prefs;
    try { localStorage.setItem(VIDEO_PREFERENCES_KEY, JSON.stringify(prefs)); } catch { /* quota */ }
  };
  const persistRef = useRef(persistVideoPreferences);
  persistRef.current = persistVideoPreferences;
  const schedulePersist = () => {
    if (s.persistTimer != null) clearTimeout(s.persistTimer);
    s.persistTimer = setTimeout(() => { s.persistTimer = null; persistRef.current(); }, 0);
  };

  /* ---------------- setup transitions ---------------- */

  const commit = (nextSetup, { persist = true } = {}) => {
    s.setup = nextSetup;
    if (persist) persistVideoPreferences();
    bump();
  };

  const selectRegularModel = (m) => commit(selectRegularModelTransition(s.setup, m, s.catalogs));
  const selectHiveModel = (m) => commit(selectHivemindWorkflowTransition(s.setup, m, s.catalogs));
  const selectV2VModel = (m) => commit(selectV2VModelTransition(s.setup, m, s.catalogs));

  const setLocalMode = (local) => {
    if (local === s.setup.localMode) return;
    commit({ ...s.setup, localMode: local });
  };
  const setAr = (v) => commit({ ...s.setup, ar: v });
  const setMatchStartFrameAr = (checked) => commit({ ...s.setup, matchStartFrameAr: checked });
  const setDuration = (v) => commit({ ...s.setup, duration: Number(v) });
  const setResolution = (v) => commit({ ...s.setup, resolution: v });
  const setQuality = (v) => commit({ ...s.setup, quality: v });
  const setMode = (v) => commit({ ...s.setup, mode: v });
  const setEffect = (v) => commit({ ...s.setup, effectName: v });
  const setAdvanced = (name, value) => commit({ ...s.setup, advancedValues: { ...s.setup.advancedValues, [name]: value } });
  // Seed: -1 = random (fresh each run); a typed value locks it. The dice re-randomizes.
  const setSeed = (v) => {
    const n = Number(v);
    commit({ ...s.setup, seed: Number.isFinite(n) && n >= 0 ? Math.floor(n) : -1 });
  };
  const randomizeSeed = () => commit({ ...s.setup, seed: -1 });
  const lockLastSeed = () => { if (typeof s.lastSeed === 'number' && s.lastSeed >= 0) commit({ ...s.setup, seed: s.lastSeed }); };

  const setPrompt = (v) => {
    s.setup = { ...s.setup, prompt: v };
    // Persist the prompt to the ENCRYPTED composer section (owner vault) so it
    // survives a reload — same as the image studio; the server never sees it.
    updateComposerSection('video', { prompt: v });
    bump();
  };

  // Negative prompt is prompt text, so it follows the positive one into the
  // encrypted composer section and never touches the plaintext settings store.
  const setNegativePrompt = (v) => {
    s.setup = { ...s.setup, negativePrompt: v };
    updateComposerSection('video', { negativePrompt: v });
    bump();
  };

  const setPing = (checked) => {
    s.pingWhenComplete = setCompletionPingEnabled(checked);
    bump();
    if (s.pingWhenComplete) void playCompletionPing();
  };

  /* ---------------- start / end frame (UploadPicker) ---------------- */

  const matchIngredientsAspectToStartFrame = async (url) => {
    try {
      const dims = await imageDimensions(url);
      if (s.setup.imageUrl !== url) return;
      const model = currentIngredientModel(s.setup, s.catalogs);
      if (!model) return;
      const matched = closestVideoAspectRatio(dims.width, dims.height, aspectRatiosFor(s.setup, model.id));
      if (!matched || matched === s.setup.ar) return;
      s.setup = { ...s.setup, ar: matched };
      persistVideoPreferences();
      bump();
      void refreshIngredientSheetPreview({ force: true });
    } catch { /* keep the current aspect when the image can't be inspected */ }
  };

  const onStartFrameChange = (urls) => {
    const url = (Array.isArray(urls) ? urls.filter(Boolean) : [])[0] || null;
    if (!url) {
      commit(startFrameClearedTransition(s.setup, s.catalogs));
      return;
    }
    const preserve = s.preserveNextStartFrameAspect;
    s.preserveNextStartFrameAspect = false;
    const hadFrameSlots = frameSlotsVisible(s.setup, s.catalogs);
    const { setup, matchAspect } = startFrameSelectedTransition(s.setup, url, s.catalogs);
    commit(setup);
    // The pick switched to a model with middle/end keyframe slots, which replaces
    // the plain picker the user was in. Open the slots picker so the rest of the
    // frames can be set in one go instead of the panel just disappearing.
    if (!hadFrameSlots && frameSlotsVisible(setup, s.catalogs)) {
      s.framesPanelAutoOpen = true;
      bump();
    }
    if (matchAspect && !preserve) void matchIngredientsAspectToStartFrame(url);
  };

  const onEndFrameChange = (urls) => {
    const url = (Array.isArray(urls) ? urls.filter(Boolean) : [])[0] || null;
    s.setup = { ...s.setup, endImageUrl: url };
    bump();
  };

  // LTX 2.3 first/middle/end keyframes (Hivemind local). Kept separate from the
  // remote muapi FLF endImageUrl above so the two flows never cross-contaminate.
  const onLtxMiddleFrameChange = (urls) => {
    const url = (Array.isArray(urls) ? urls.filter(Boolean) : [])[0] || null;
    s.setup = { ...s.setup, ltxMiddleUrl: url };
    bump();
  };

  const onLtxEndFrameChange = (urls) => {
    const url = (Array.isArray(urls) ? urls.filter(Boolean) : [])[0] || null;
    s.setup = { ...s.setup, ltxEndUrl: url };
    bump();
  };

  const uploadFnForFrame = (file) => (
    isHivemindVideoModelId(s.setup.modelId)
      ? uploadFileToHivemindStudio(file)
      : (isWan2gpModelId(s.setup.modelId) ? localAI.uploadFileToWan2gp(file) : muapi.uploadFile(file))
  );
  const frameRequiresApiKey = () => !isWan2gpModelId(s.setup.modelId) && !isHivemindVideoModelId(s.setup.modelId);

  /* ---------------- video reference (bespoke, mode-defining) ---------------- */

  const resolveVideoHive = () => {
    const currentHiveEntry = s.catalogs.hivemindI2V.find((m) => m.id === s.setup.modelId);
    const preferredHive = currentHiveEntry?.supportsVideoInput
      ? currentHiveEntry
      : (s.catalogs.hivemindI2V.find((m) => m.workflowId === 'ltx23-eros-fast' && m.supportsVideoInput)
        || s.catalogs.hivemindI2V.find((m) => m.supportsVideoInput));
    return { preferredHive, useHivemind: Boolean(preferredHive && isHivemindStudioEnabled()) };
  };

  const onVideoRefClick = () => {
    if (s.setup.videoUrl) commit(clearVideoUploadTransition(s.setup, s.catalogs));
    else videoFileInputRef.current?.click();
  };

  const handleVideoFile = async (file) => {
    if (!file) return;
    const { preferredHive, useHivemind } = resolveVideoHive();
    if (!useHivemind && !localStorage.getItem('muapi_key')) {
      s.authRetry = () => videoFileInputRef.current?.click();
      s.authOpen = true;
      bump();
      return;
    }
    s.videoUploading = true;
    bump();
    try {
      const upload = useHivemind ? await uploadFileToHivemindStudio(file) : { url: await muapi.uploadFile(file) };
      s.setup = videoUploadedTransition(s.setup, { url: upload.url, name: file.name, useHivemind, preferredHive }, s.catalogs);
      persistVideoPreferences();
    } catch (err) {
      console.error('[VideoStudio] Video upload failed:', err);
      toast.error(`${zh() ? '视频上传失败' : 'Video upload failed'}: ${err.message}`);
    } finally {
      s.videoUploading = false;
      bump();
    }
  };

  /* ---------------- ingredients ---------------- */

  const currentIngredientSelectionList = () => (currentIngredientModel(s.setup, s.catalogs) ? s.sharedIngredientSelections : []);
  const selectedUploadedIngredientSheet = () => s.sharedIngredientSheets.find((sheet) => sheet.url === s.selectedIngredientSheet) || null;
  const syncSelectedIngredientSheet = () => {
    s.selectedIngredientSheet = normalizeSelectedVideoIngredientSheet(
      s.selectedIngredientSheet, s.sharedIngredientSelections, s.sharedIngredientSheets,
    );
  };

  const releaseIngredientSheetPreview = () => {
    if (s.ingredientSheetPreview.url) URL.revokeObjectURL(s.ingredientSheetPreview.url);
  };

  const refreshIngredientSheetPreview = async ({ force = false } = {}) => {
    const model = currentIngredientModel(s.setup, s.catalogs);
    const selection = model ? s.sharedIngredientSelections : [];
    if (!model || !selection.length) {
      s.ingredientSheetPreviewRequest += 1;
      releaseIngredientSheetPreview();
      s.ingredientSheetPreview = {
        workflowId: model?.workflowId || '', signature: '', status: 'idle', url: '',
        columns: null, rows: null, width: null, height: null, sourceCount: 0, error: '',
      };
      bump();
      return;
    }
    const signature = ingredientSelectionSignature(model, selection, s.setup.ar);
    if (!force && s.ingredientSheetPreview.signature === signature && ['loading', 'ready'].includes(s.ingredientSheetPreview.status)) return;
    const request = ++s.ingredientSheetPreviewRequest;
    releaseIngredientSheetPreview();
    s.ingredientSheetPreview = {
      workflowId: model.workflowId, signature, status: 'loading', url: '',
      columns: null, rows: null, width: null, height: null, sourceCount: selection.length, error: '',
    };
    bump();
    try {
      const result = await previewHivemindIngredientSheet(
        selection.map((item) => ({ image: item.url, description: item.description })),
        { aspectRatio: s.setup.ar },
      );
      const url = URL.createObjectURL(result.blob);
      const liveModel = currentIngredientModel(s.setup, s.catalogs);
      const liveSelection = liveModel ? s.sharedIngredientSelections : [];
      if (request !== s.ingredientSheetPreviewRequest
        || signature !== ingredientSelectionSignature(liveModel, liveSelection, s.setup.ar)) {
        URL.revokeObjectURL(url);
        return;
      }
      s.ingredientSheetPreview = {
        workflowId: model.workflowId, signature, status: 'ready', url,
        columns: result.columns, rows: result.rows, width: result.width, height: result.height,
        sourceCount: result.sourceCount, error: '',
      };
    } catch (error) {
      if (request !== s.ingredientSheetPreviewRequest) return;
      s.ingredientSheetPreview = {
        workflowId: model.workflowId, signature, status: 'error', url: '',
        columns: null, rows: null, width: null, height: null, sourceCount: selection.length, error: error.message,
      };
    }
    bump();
  };

  const setCurrentIngredientSelection = (selection) => {
    const model = currentIngredientModel(s.setup, s.catalogs);
    if (!model) return;
    s.sharedIngredientSelections = selection.slice(0, model.ingredientInputs?.max_images || 12).map((item) => ({ ...item }));
    syncSelectedIngredientSheet();
    persistVideoPreferences();
    bump();
    void refreshIngredientSheetPreview();
  };

  const matchAspectToIngredientSheet = async (url) => {
    try {
      const dims = await imageDimensions(url);
      const model = currentIngredientModel(s.setup, s.catalogs);
      if (!model || s.selectedIngredientSheet !== url) return;
      const matched = closestVideoAspectRatio(dims.width, dims.height, aspectRatiosFor(s.setup, model.id));
      if (!matched || matched === s.setup.ar) return;
      s.setup = { ...s.setup, ar: matched };
      persistVideoPreferences();
      bump();
    } catch { /* keep the current aspect when the sheet can't be inspected */ }
  };

  const toggleIngredientSheetSelection = (sheetId) => {
    s.selectedIngredientSheet = s.selectedIngredientSheet === sheetId ? '' : sheetId;
    syncSelectedIngredientSheet();
    if (s.selectedIngredientSheet && s.selectedIngredientSheet !== 'stitched') void matchAspectToIngredientSheet(s.selectedIngredientSheet);
    persistVideoPreferences();
    bump();
  };

  const removeIngredientSheet = (url) => {
    s.sharedIngredientSheets = s.sharedIngredientSheets.filter((sheet) => sheet.url !== url);
    syncSelectedIngredientSheet();
    persistVideoPreferences();
    bump();
    void deleteHivemindStudioUpload(url).catch(() => {});
  };

  const addIngredientViews = async (files) => {
    const model = currentIngredientModel(s.setup, s.catalogs);
    if (!model) return;
    const existing = currentIngredientSelectionList();
    const maximum = Number(model.ingredientInputs?.max_images || 12);
    const toUpload = files.slice(0, Math.max(0, maximum - existing.length));
    if (!toUpload.length) return;
    s.ingredientUploadMessage = `${zh() ? '正在添加' : 'Adding'} ${toUpload.length} ${zh() ? '个视图…' : `view${toUpload.length === 1 ? '' : 's'}…`}`;
    bump();
    try {
      const uploaded = [];
      for (const file of toUpload) {
        const result = await uploadFileToHivemindStudio(file);
        uploaded.push({ url: result.url, description: '' });
      }
      // Fresh reference views make the stitched sheet the active selection.
      s.selectedIngredientSheet = 'stitched';
      setCurrentIngredientSelection([...existing, ...uploaded]);
      s.ingredientUploadMessage = '';
    } catch (error) {
      s.ingredientUploadMessage = `${zh() ? '上传失败' : 'Upload failed'}: ${error.message}`;
    }
    bump();
  };

  const addIngredientSheets = async (files) => {
    const model = currentIngredientModel(s.setup, s.catalogs);
    if (!model) return;
    const toUpload = files.slice(0, Math.max(0, 12 - s.sharedIngredientSheets.length));
    if (!toUpload.length) return;
    s.ingredientUploadMessage = `${zh() ? '正在添加' : 'Adding'} ${toUpload.length} ${zh() ? '张配料表…' : `sheet${toUpload.length === 1 ? '' : 's'}…`}`;
    bump();
    try {
      for (const file of toUpload) {
        const result = await uploadFileToHivemindStudio(file);
        s.sharedIngredientSheets = [...s.sharedIngredientSheets, { url: result.url, description: '' }];
        // A freshly uploaded finished sheet becomes the active selection.
        s.selectedIngredientSheet = result.url;
      }
      s.ingredientUploadMessage = '';
    } catch (error) {
      s.ingredientUploadMessage = `${zh() ? '上传失败' : 'Upload failed'}: ${error.message}`;
    }
    syncSelectedIngredientSheet();
    if (s.selectedIngredientSheet && s.selectedIngredientSheet !== 'stitched') void matchAspectToIngredientSheet(s.selectedIngredientSheet);
    persistVideoPreferences();
    bump();
  };

  const updateIngredientViewDescription = (index, value) => {
    const updated = currentIngredientSelectionList().map((entry, i) => (i === index ? { ...entry, description: value } : entry));
    setCurrentIngredientSelection(updated);
  };
  const updateIngredientSheetDescription = (url, value) => {
    s.sharedIngredientSheets = s.sharedIngredientSheets.map((sheet) => (sheet.url === url ? { ...sheet, description: value } : sheet));
    persistVideoPreferences();
    bump();
  };
  const removeIngredientView = (index) => {
    const item = currentIngredientSelectionList()[index];
    setCurrentIngredientSelection(currentIngredientSelectionList().filter((_, i) => i !== index));
    if (item) void deleteHivemindStudioUpload(item.url).catch(() => {});
  };
  const clearIngredients = () => {
    const removed = [...currentIngredientSelectionList(), ...s.sharedIngredientSheets];
    s.sharedIngredientSheets = [];
    setCurrentIngredientSelection([]);
    removed.forEach((item) => { void deleteHivemindStudioUpload(item.url).catch(() => {}); });
  };

  /* ---------------- LoRA ---------------- */

  const currentVideoLoraModel = () => {
    const m = currentModel(s.setup, s.catalogs);
    return m?.provider === 'hivemind-media-studio' && m.supportsLoras ? m : null;
  };
  const currentVideoLoraSelection = () => s.videoLoraSelectionsByModel.get(currentVideoLoraModel()?.workflowId) || [];
  const setCurrentVideoLoraSelection = (selection, { render = true } = {}) => {
    const m = currentVideoLoraModel();
    if (!m) return;
    s.videoLoraSelectionsByModel.set(m.workflowId, selection);
    persistVideoPreferences();
    if (render) bump();
  };

  const loadLorasForCurrentVideoModel = async () => {
    const model = currentVideoLoraModel();
    const request = ++s.videoLoraCatalogRequest;
    s.availableVideoLoras = [];
    if (!model) {
      s.videoLoraCatalogModelId = '';
      s.videoLoraCatalogStatus = 'unavailable';
      s.videoLoraCatalogMessage = '';
      bump();
      return;
    }
    s.videoLoraCatalogModelId = model.workflowId;
    s.videoLoraCatalogStatus = 'loading';
    s.videoLoraCatalogMessage = `${zh() ? '正在加载 LoRA：' : 'Loading LoRAs for '}${model.name}…`;
    bump();
    try {
      const data = await localAI.listLoras(model.workflowId, model.compatibleBaseModels);
      if (request !== s.videoLoraCatalogRequest || model.workflowId !== currentVideoLoraModel()?.workflowId) return;
      s.availableVideoLoras = Array.isArray(data?.loras) ? data.loras : [];
      s.videoLoraCatalogStatus = data?.supported === false ? 'unsupported' : 'ready';
      s.videoLoraCatalogMessage = data?.supported === false
        ? (zh() ? '此工作流未提供附加 LoRA 通道。' : 'This workflow does not expose an add-on LoRA path.')
        : s.availableVideoLoras.length
          ? `${s.availableVideoLoras.length} ${zh() ? '个兼容 LoRA 已安装。' : `compatible LoRA${s.availableVideoLoras.length === 1 ? '' : 's'} installed.`}`
          : (zh() ? '此工作流未安装兼容的 LoRA。' : 'No compatible LoRAs are installed for this workflow.');
      void refreshVideoLoraUpdates(request, model.compatibleBaseModels);
    } catch (error) {
      if (request !== s.videoLoraCatalogRequest) return;
      s.videoLoraCatalogStatus = 'error';
      s.videoLoraCatalogMessage = `${zh() ? '无法加载 LoRA：' : 'Unable to load LoRAs: '}${error.message}`;
    }
    bump();
  };

  // Update availability comes from Civitai, so it lands after the catalog rather
  // than holding it up. Same race token: a stale check never annotates a new list.
  const refreshVideoLoraUpdates = async (request, baseModels) => {
    const updates = await localAI.listLoraUpdates(baseModels);
    if (request !== s.videoLoraCatalogRequest || !Object.keys(updates).length) return;
    s.availableVideoLoras = mergeLoraUpdates(s.availableVideoLoras, updates);
    bump();
  };

  // Shared completion path for every Civitai download that lands a LoRA: refresh
  // the catalog, then carry the selection over when a file was replaced.
  const finishVideoLoraDownload = async (job, context) => {
    await loadLorasForCurrentVideoModel();
    const replacedId = String(context?.replaces || '');
    const newId = String(job?.result?.filename || '');
    if (!replacedId || !newId) return;
    const replacement = s.availableVideoLoras.find((lora) => lora.id === newId) || { id: newId, name: newId };
    setCurrentVideoLoraSelection(replaceLoraInSelection(currentVideoLoraSelection(), replacedId, replacement));
    bump();
  };

  const startVideoLoraUpdate = (lora, update, { replace }) => {
    if (!update?.url) return;
    void startCivitaiDownload(localAI, update.url, {
      replaces: replace ? lora.id : '',
      onComplete: finishVideoLoraDownload,
      onStarted: () => bump(),
    });
  };

  /* ---------------- generation progress ---------------- */

  const startGenerationProgress = (context, { stage = 'preparing', estimateSeconds = null } = {}) => {
    if (s.generationTimer) clearInterval(s.generationTimer);
    s.progressContext = context;
    s.progress = { stage, value: null };
    s.generationStartedAt = Date.now();
    s.progressDisplay = 0;
    s.progressReal = 0;
    s.progressEstimateSec = Number(estimateSeconds) || null;
    // Tick fast and derive a SMOOTH, MONOTONIC bar: it advances by elapsed/estimate
    // and is nudged up (never down) by real backend progress, so it never stalls or
    // jumps backward across native-MLX passes. Capped below 100% until the result
    // lands (see showVideoInCanvas), so "done" is always the video appearing.
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
  const stopGenerationProgress = () => {
    if (s.generationTimer) clearInterval(s.generationTimer);
    s.generationTimer = null;
  };
  const updateGenerationProgress = ({ status = '', progress = null, stage = '', estimateSeconds = null } = {}) => {
    const value = normalizeVideoGenerationProgress(progress);
    if (value != null) s.progressReal = value;
    if (Number(estimateSeconds) > 0) s.progressEstimateSec = Number(estimateSeconds);
    s.progress = { stage: stage || classifyVideoGenerationStage(status), value };
    bump();
  };

  /* ---------------- canvas / history ---------------- */

  const showVideoInCanvas = (url, model, { fromGeneration = false } = {}) => {
    s.contextStore.view(url);
    s.resultUrl = url;
    s.resultModel = model;
    if (fromGeneration) {
      s.progressDisplay = 1;
      s.progressReal = 1;
      stopGenerationProgress();
      void playCompletionPing();
    }
    bump();
  };

  const addToHistory = (entry, generationContext = null) => {
    const safeEntry = redactPrivateHistoryEntry(entry);
    if (generationContext && entry?.url) {
      s.contextStore.remember(entry.url, generationContext);
      // Seal the exact settings so this clip can be dragged back in later.
      void rememberGenerationSetup({
        url: entry.url,
        section: 'video',
        mediaType: 'video/*',
        context: generationContext,
        downloadName: videoDownloadName(entry.model, entry.id),
      });
    }
    s.generationHistory = [safeEntry, ...s.generationHistory];
    saveStudioGenerationHistory('video_history', s.generationHistory, 30);
    bump();
  };

  const openHistoryEntry = (entry) => {
    // Restore extend context only for the two seedance-v2.0 generation models.
    if (entry.model === 'seedance-v2.0-t2v' || entry.model === 'seedance-v2.0-i2v') {
      s.lastGenerationId = entry.id;
      s.lastGenerationModel = entry.model;
    } else {
      s.lastGenerationId = null;
      s.lastGenerationModel = null;
    }
    showVideoInCanvas(entry.url, entry.model);
  };

  const confirmDeleteHistoryEntry = () => {
    const entry = s.deleteTarget;
    if (!entry) return;
    s.generationHistory = s.generationHistory.filter((e) => e !== entry);
    saveStudioGenerationHistory('video_history', s.generationHistory, 30);
    if (s.resultUrl === entry.url) { s.resultUrl = null; s.resultModel = null; }
    s.deleteTarget = null;
    bump();
  };

  const downloadFile = downloadMedia;

  /* ---------------- generation context capture / restore ---------------- */

  const captureGenerationContext = (prompt) => {
    const model = currentModel(s.setup, s.catalogs);
    const ingModel = currentIngredientModel(s.setup, s.catalogs);
    return {
      prompt,
      model: s.setup.modelId,
      modelName: s.setup.modelName,
      aspectRatio: s.setup.ar,
      duration: s.setup.duration,
      resolution: s.setup.resolution,
      quality: s.setup.quality,
      mode: s.setup.mode,
      effectName: s.setup.effectName,
      advancedValues: { ...s.setup.advancedValues },
      loras: currentVideoLoraSelection().map((lora) => ({ ...lora })),
      ingredientImages: (ingModel ? s.sharedIngredientSelections : []).map((item) => ({ ...item })),
      ingredientSheets: (ingModel ? s.sharedIngredientSheets : []).map((item) => ({ ...item })),
      ingredientSelectedSheet: ingModel ? s.selectedIngredientSheet : '',
      imageMode: s.setup.imageMode,
      v2vMode: s.setup.v2vMode,
      imageUrl: s.setup.imageUrl,
      endImageUrl: s.setup.endImageUrl,
      videoUrl: s.setup.videoUrl,
      videoName: s.setup.videoName,
      sourceGenerationId: model?.requiresRequestId ? s.lastGenerationId : null,
    };
  };

  const restoreGenerationContext = (context) => {
    const applied = applyGenerationContext(s.setup, context, s.catalogs);
    if (!applied) return false;
    s.setup = applied.setup;
    const model = applied.model;
    if (model.workflowId && Array.isArray(context.loras)) {
      s.videoLoraSelectionsByModel.set(model.workflowId, context.loras.map((lora) => ({ ...lora })));
    }
    if (model.supportsIngredientImages && Array.isArray(context.ingredientImages)) {
      s.sharedIngredientSelections = normalizeVideoIngredientSelections(context.ingredientImages);
    }
    if (model.supportsIngredientImages) {
      if (Array.isArray(context.ingredientSheets)) {
        s.sharedIngredientSheets = normalizeVideoIngredientSelections(context.ingredientSheets);
      }
      s.selectedIngredientSheet = normalizeSelectedVideoIngredientSheet(
        context.ingredientSelectedSheet, s.sharedIngredientSelections, s.sharedIngredientSheets,
      );
    }
    // Silent restore sets the frame via controlled `values` (no onChange), so
    // the aspect auto-match never fires; arm the one-shot flag anyway to keep
    // the contract if a picker onChange ever runs first.
    if (s.setup.imageUrl) s.preserveNextStartFrameAspect = true;
    if (context.sourceGenerationId) s.lastGenerationId = context.sourceGenerationId;
    persistVideoPreferences();
    bump();
    return true;
  };

  /* ---------------- canvas action buttons ---------------- */

  const backToSetup = () => {
    const viewed = s.contextStore.getViewed();
    if (viewed) restoreGenerationContext(viewed);
    s.resultUrl = null;
    s.resultModel = null;
    bump();
    focusPrompt();
  };
  const regenerate = () => {
    const viewed = s.contextStore.getViewed();
    if (!viewed || !restoreGenerationContext(viewed)) {
      s.resultUrl = null;
      s.resultModel = null;
      bump();
      focusPrompt();
      return;
    }
    s.resultUrl = null;
    s.resultModel = null;
    bump();
    void generate();
  };
  const newPrompt = () => {
    s.setup = newPromptTransition(s.setup, s.catalogs);
    s.lastSubmittedContext = null;
    s.contextStore.clearViewed();
    s.resultUrl = null;
    s.resultModel = null;
    persistVideoPreferences();
    bump();
    focusPrompt();
  };
  const extend = () => {
    if (!s.lastGenerationId) return;
    s.setup = extendTransition(s.setup, s.catalogs);
    s.resultUrl = null;
    s.resultModel = null;
    persistVideoPreferences();
    bump();
    focusPrompt();
  };

  /* ---------------- generation ---------------- */

  const generate = async () => {
    const prompt = s.setup.prompt.trim();
    const setup = s.setup;
    const catalogs = s.catalogs;
    const model = currentModel(setup, catalogs);
    const isExtendMode = model?.requiresRequestId;
    const isWan2gpLocal = isWan2gpModelId(setup.modelId);
    const isHivemindLocal = isHivemindVideoModelId(setup.modelId);
    const isHivemindVideoInput = isHivemindLocal && Boolean(setup.videoUrl);
    const ingredientModel = currentIngredientModel(setup, catalogs);
    const activeItems = activeIngredientSheetItems(ingredientModel, {
      selectedSheet: s.selectedIngredientSheet,
      selections: s.sharedIngredientSelections,
      sheets: s.sharedIngredientSheets,
    });
    const hasIngredientReferences = isHivemindLocal && Boolean(model?.supportsIngredientImages) && activeItems.length > 0;

    // ── Validation (aborts stay aborts; alert() → toast.error()) ──────────────
    if (isHivemindVideoInput) {
      if (!model?.supportsVideoInput) {
        toast.error(zh() ? '此本地工作流不支持源视频延长。' : 'This local workflow does not support source-video extension.');
        return;
      }
    } else if (setup.v2vMode) {
      if (!setup.videoUrl) { toast.error(zh() ? '请先上传视频。' : 'Please upload a video first.'); return; }
      if (model?.imageField && !setup.imageUrl) { toast.error(zh() ? '请上传用于运动控制的参考图片。' : 'Please upload a reference image for motion control.'); return; }
      if (model?.promptRequired && !prompt) { toast.error(zh() ? '请描述您想要的动作。' : 'Please describe the motion you want.'); return; }
    } else if (isExtendMode) {
      if (!s.lastGenerationId) { toast.error(zh() ? '未找到可延长的 Seedance 2.0 生成，请先生成一个视频。' : 'No Seedance 2.0 generation found to extend. Generate a video first.'); return; }
    } else if (setup.imageMode) {
      // LTX 2.3 supports text-to-video: for a plain Hivemind LTX model (not an
      // ingredient/reference-sheet model), a prompt alone is a valid request —
      // the start frame is optional.
      const hiveTextToVideo = isHivemindLocal && !model?.supportsIngredientImages;
      if (!setup.imageUrl && !hasIngredientReferences) {
        if (hiveTextToVideo) {
          if (!prompt) { toast.error(zh() ? '请输入提示词以生成视频。' : 'Please enter a prompt to generate a video.'); return; }
        } else {
          toast.error(model?.supportsIngredientImages
            ? (zh() ? '请添加参考视图或选择一张配料表。' : 'Please add reference views or select an ingredients sheet.')
            : (zh() ? '请先上传起始帧图片。' : 'Please upload a start frame image first.'));
          return;
        }
      }
      if (model?.supportsIngredientImages && !prompt) { toast.error(zh() ? '请描述要从这些参考生成的镜头。' : 'Please describe the shot to generate from these references.'); return; }
    } else if (!prompt) {
      toast.error(zh() ? '请输入提示词以生成视频。' : 'Please enter a prompt to generate a video.');
      return;
    }

    // Re-assert the sheet-matched aspect at generation time even if a restored
    // session or a later model switch reverted it.
    if (hasIngredientReferences && selectedUploadedIngredientSheet()) {
      await matchAspectToIngredientSheet(s.selectedIngredientSheet);
    }

    const isLocal = isWan2gpLocal || isHivemindLocal;
    if (!isLocal) {
      const apiKey = localStorage.getItem('muapi_key');
      if (!apiKey) {
        s.authRetry = () => generate();
        s.authOpen = true;
        bump();
        return;
      }
    }

    s.lastSubmittedContext = captureGenerationContext(prompt);
    void primeCompletionPing();
    s.generateError = '';
    s.generating = true;
    s.abortController = new AbortController();
    s.resultUrl = null;
    s.resultModel = null;
    startGenerationProgress(s.lastSubmittedContext);
    bump();

    let unsubscribeProgress = null;
    if (isWan2gpLocal) {
      unsubscribeProgress = localAI.onProgress(({ status, progress }) => updateGenerationProgress({ status, progress }));
    } else {
      updateGenerationProgress({ stage: isHivemindLocal ? 'rendering' : 'queued' });
    }

    let hadError = false;
    let capturedRequestId = null;
    const historyMeta = { prompt, model: setup.modelId, aspect_ratio: setup.ar, duration: setup.duration };
    const onRequestId = (rid) => {
      capturedRequestId = rid;
      updateGenerationProgress({ stage: 'rendering' });
      savePendingJob({ requestId: rid, studioType: 'video', historyMeta, maxAttempts: 900, interval: 2000, submittedAt: Date.now() });
    };

    try {
      // ─── Local Media Studio (Hivemind) — job-based, 90-min poll in lib ──────
      if (isHivemindLocal) {
        const finishedSheet = selectedUploadedIngredientSheet();
        // "Use starting frame aspect ratio": when on with a start frame (and not
        // extending a video or using an ingredient sheet), send an empty aspect so
        // the backend derives output dimensions from the frame itself — no crop.
        const matchStartFrameAr = setup.matchStartFrameAr && Boolean(setup.imageUrl)
          && !isHivemindVideoInput && !hasIngredientReferences;
        // Resolve the seed: -1 means "random", so roll a fresh concrete seed each
        // run (otherwise the runner falls back to its FIXED default and every video
        // comes out identical). A locked seed (>= 0) is sent as-is. Record the seed
        // actually used so the UI can show/lock it.
        const resolvedSeed = (typeof setup.seed === 'number' && setup.seed >= 0)
          ? Math.floor(setup.seed)
          : Math.floor(Math.random() * 1_000_000_000);
        s.lastSeed = resolvedSeed;
        const localParams = {
          model: setup.modelId,
          workflow_id: workflowIdFromHivemindModelId(setup.modelId),
          prompt: prompt || '',
          aspect_ratio: matchStartFrameAr ? '' : setup.ar,
          resolution: String(setup.resolution || '').toLowerCase() === 'high' ? 'high' : 'standard',
          duration: setup.duration || 4,
          seed: resolvedSeed,
          denoise: setup.denoise || '',
          negative_prompt: String(setup.negativePrompt || '').trim(),
          ...(Number.isFinite(Number(setup.nagScale)) ? { nag_scale: Number(setup.nagScale) } : {}),
          loras: loraGenerationPayload(currentVideoLoraSelection()),
          ...(hasIngredientReferences ? {
            ingredientImages: activeItems.map((item) => ({ image: item.url, description: item.description })),
            // A finished sheet's description stands alone as the full sheet
            // description instead of a panel caption.
            ...(finishedSheet?.description?.trim() ? { referenceDescription: finishedSheet.description.trim() } : {}),
          } : {}),
        };
        if (isHivemindVideoInput) { localParams.video = setup.videoUrl; localParams.video_mode = 'extend'; }
        else if (setup.imageUrl) { localParams.image = setup.imageUrl; }
        // LTX 2.3 first/middle/end keyframes only apply to image-driven runs.
        if (!isHivemindVideoInput) {
          if (setup.ltxMiddleUrl) localParams.middleImage = setup.ltxMiddleUrl;
          if (setup.ltxEndUrl) localParams.endImage = setup.ltxEndUrl;
        }
        localParams.onProgress = (info) => {
          const data = (info && typeof info === 'object') ? info : { progress: info };
          updateGenerationProgress({ stage: 'rendering', progress: data.progress, estimateSeconds: data.estimateSeconds });
        };
        // Mirror the started job to sessionStorage so a tab switch / reload can
        // resume its live progress. Prompt text is deliberately NOT persisted
        // (it stays private); the resumed history entry is redacted anyway.
        localParams.onJobId = (jobId) => {
          s.activeLocalJobId = jobId;
          savePendingJob({
            requestId: jobId,
            studioType: 'video',
            kind: 'hivemind-local',
            historyMeta: { model: setup.modelId, aspect_ratio: setup.ar, duration: setup.duration },
            submittedAt: Date.now(),
          });
        };
        localParams.signal = s.abortController?.signal;
        const res = await generateHivemindVideo(localParams);
        if (res && res.url) {
          const genId = res.id || Date.now().toString();
          s.lastGenerationId = null;
          s.lastGenerationModel = null;
          addToHistory({ id: genId, url: res.url, prompt, model: setup.modelId, aspect_ratio: setup.ar, duration: setup.duration, timestamp: new Date().toISOString() }, s.lastSubmittedContext);
          showVideoInCanvas(res.url, setup.modelId, { fromGeneration: true });
        } else {
          throw new Error('No video URL returned by Hivemind Media Studio');
        }
        return;
      }

      // ─── Local Wan2GP ──────────────────────────────────────────────────────
      if (isWan2gpLocal) {
        const localParams = { model: setup.modelId, prompt: prompt || '', aspect_ratio: setup.ar };
        if (setup.imageMode && setup.imageUrl) localParams.image = setup.imageUrl;
        const res = await localAI.generate(localParams);
        if (res && res.url) {
          s.lastGenerationId = null;
          s.lastGenerationModel = null;
          addToHistory({ id: Date.now().toString(), url: res.url, prompt, model: setup.modelId, aspect_ratio: setup.ar, timestamp: new Date().toISOString() }, s.lastSubmittedContext);
          showVideoInCanvas(res.url, setup.modelId, { fromGeneration: true });
        } else {
          throw new Error('No video URL returned by Wan2GP');
        }
        return;
      }

      // ─── Remote V2V ────────────────────────────────────────────────────────
      if (setup.v2vMode) {
        const v2vParams = { model: setup.modelId, video_url: setup.videoUrl, onRequestId };
        if (model?.imageField && setup.imageUrl) v2vParams.image_url = setup.imageUrl;
        if (model?.hasPrompt && prompt) v2vParams.prompt = prompt;
        const res = await muapi.processV2V(v2vParams);
        if (res && res.url) {
          if (capturedRequestId) removePendingJob(capturedRequestId);
          const genId = res.id || capturedRequestId || Date.now().toString();
          s.lastGenerationId = null;
          s.lastGenerationModel = null;
          addToHistory({ id: genId, url: res.url, prompt: model?.hasPrompt ? prompt : '', model: setup.modelId, timestamp: new Date().toISOString() }, s.lastSubmittedContext);
          showVideoInCanvas(res.url, setup.modelId, { fromGeneration: true });
        } else {
          throw new Error('No video URL returned by API');
        }
        return;
      }

      // ─── Remote I2V ────────────────────────────────────────────────────────
      if (setup.imageMode) {
        const i2vParams = {
          model: setup.modelId,
          image_url: setup.imageUrl,
          onRequestId,
          ...getAdvancedVideoPayload(model, setup.advancedValues),
        };
        i2vParams.prompt = prompt || '';
        i2vParams.aspect_ratio = setup.ar;
        if (setup.endImageUrl && model?.lastImageField) i2vParams.last_image = setup.endImageUrl;
        if (durationsFor(setup, setup.modelId).length > 0) i2vParams.duration = setup.duration;
        if (resolutionsFor(setup, setup.modelId).length > 0) i2vParams.resolution = setup.resolution;
        if (setup.quality) i2vParams.quality = setup.quality;
        if (setup.mode) i2vParams.mode = setup.mode;
        if (setup.effectName) i2vParams.name = setup.effectName;
        const res = await muapi.generateI2V(i2vParams);
        if (res && res.url) {
          if (capturedRequestId) removePendingJob(capturedRequestId);
          const genId = res.id || capturedRequestId || Date.now().toString();
          if (setup.modelId === 'seedance-v2.0-i2v') { s.lastGenerationId = genId; s.lastGenerationModel = setup.modelId; }
          else { s.lastGenerationId = null; s.lastGenerationModel = null; }
          addToHistory({ id: genId, url: res.url, prompt, model: setup.modelId, aspect_ratio: setup.ar, duration: setup.duration, timestamp: new Date().toISOString() }, s.lastSubmittedContext);
          showVideoInCanvas(res.url, setup.modelId, { fromGeneration: true });
        } else {
          throw new Error('No video URL returned by API');
        }
        return;
      }

      // ─── Remote T2V (+ Seedance extend) ────────────────────────────────────
      const params = { model: setup.modelId, onRequestId, ...getAdvancedVideoPayload(model, setup.advancedValues) };
      if (prompt) params.prompt = prompt;
      if (isExtendMode) params.request_id = s.lastGenerationId;
      else params.aspect_ratio = setup.ar;
      if (durationsFor(setup, setup.modelId).length > 0) params.duration = setup.duration;
      if (resolutionsFor(setup, setup.modelId).length > 0) params.resolution = setup.resolution;
      if (setup.quality) params.quality = setup.quality;
      if (setup.mode) params.mode = setup.mode;
      const res = await muapi.generateVideo(params);
      if (res && res.url) {
        if (capturedRequestId) removePendingJob(capturedRequestId);
        const genId = res.id || capturedRequestId || Date.now().toString();
        if (setup.modelId === 'seedance-v2.0-t2v' || setup.modelId === 'seedance-v2.0-i2v') { s.lastGenerationId = genId; s.lastGenerationModel = setup.modelId; }
        else { s.lastGenerationId = null; s.lastGenerationModel = null; }
        addToHistory({ id: genId, url: res.url, prompt, model: setup.modelId, aspect_ratio: setup.ar, duration: setup.duration, timestamp: new Date().toISOString() }, s.lastSubmittedContext);
        showVideoInCanvas(res.url, setup.modelId, { fromGeneration: true });
      } else {
        throw new Error('No video URL returned by API');
      }
    } catch (e) {
      hadError = true;
      if (capturedRequestId) removePendingJob(capturedRequestId);
      stopGenerationProgress();
      if (e?.cancelled) {
        // User cancelled — reset quietly, no error surface (cancelGeneration
        // already handled the backend interrupt + state reset).
        s.generateError = '';
      } else {
        console.error(e);
        // Errors no longer vanish into the button label: a persistent, copyable
        // callout in the canvas plus a toast.
        s.generateError = e.message;
        toast.error(e.message);
      }
    } finally {
      if (typeof unsubscribeProgress === 'function') unsubscribeProgress();
      // This mount owns the local job to completion; clear its resume marker so
      // the next mount doesn't re-poll a finished render.
      if (s.activeLocalJobId) { removePendingJob(s.activeLocalJobId); s.activeLocalJobId = null; }
      s.abortController = null;
      s.generating = false;
      if (!hadError) s.generateError = '';
      bump();
    }
  };

  // Cancel / reset the in-flight generation. Aborts the poll immediately, forwards
  // a best-effort interrupt to whichever backend is running the job, and ALWAYS
  // resets local state — so a stuck or already-finished job (e.g. one whose output
  // never resolved a URL) still unblocks the studio for the next generation.
  const cancelGeneration = () => {
    const jobId = s.activeLocalJobId;
    // 1) Stop the client poll loop right away.
    try { s.abortController?.abort(); } catch { /* no-op */ }
    // 2) Best-effort backend interrupt (local Media Studio job + wan2gp/localAI).
    if (jobId) void cancelHivemindVideoJob(jobId);
    try { localAI.cancelGeneration?.(); } catch { /* not all runtimes support it */ }
    // 3) Reset local generation state unconditionally.
    if (jobId) removePendingJob(jobId);
    s.activeLocalJobId = null;
    s.abortController = null;
    stopGenerationProgress();
    s.generating = false;
    s.generateError = '';
    bump();
    toast.success(zh() ? '已取消生成。' : 'Generation cancelled.');
  };

  /* ---------------- hivemind catalog + window events ---------------- */

  const applyHivemindWorkflows = (context) => {
    const videoModels = Array.isArray(context?.videoModels) ? context.videoModels : [];
    if (!videoModels.length && s.catalogs.hivemindI2V.length) return;
    const signature = JSON.stringify(videoModels);
    if (signature === s.hivemindWorkflowSignature) return;
    s.hivemindWorkflowSignature = signature;
    // Catalogs fetched before owner-unlock come back empty and are memoized
    // module-wide; apply every later update so the local lane recovers in place.
    const hivemindI2V = videoModels.map(adaptHivemindToVideoEntry);
    s.catalogs = buildCatalogs(hivemindI2V);
    const restored = applyRestoredPreferences(s.setup, s.persistedVideoPreferences, s.catalogs);
    if (restored) {
      s.setup = restored;
    } else {
      const saved = getSavedHivemindVideoSelection();
      const preferredModelId = saved?.modelId
        || hivemindI2V.find((m) => m.workflowId === 'ltx23-eros-fast')?.id
        || hivemindI2V[0]?.id;
      if (preferredModelId && isHivemindStudioEnabled()) {
        const target = s.catalogs.allI2V.find((m) => m.id === preferredModelId);
        if (target) s.setup = selectHivemindWorkflowTransition(s.setup, target, s.catalogs);
      }
    }
    bump();
  };

  const refreshHivemindWorkflows = async () => {
    let context = await loadHivemindStudioContext();
    // Owner unlock and backend startup can race the iframe's first request.
    if (!context.videoModels?.length) context = await loadHivemindStudioContext({ refresh: true });
    applyHivemindWorkflows(context);
  };

  const trySelectHiveById = (modelId) => {
    const target = s.catalogs.allI2V.find((m) => m.id === modelId);
    if (!target) return false;
    s.setup = selectHivemindWorkflowTransition(s.setup, target, s.catalogs);
    persistVideoPreferences();
    bump();
    return true;
  };

  /* ---------------- mount effects ---------------- */

  useEffect(() => {
    mountedRef.current = true;
    if (mountedOnceRef.current) return undefined;
    mountedOnceRef.current = true;

    // Re-sanitize legacy saved history (purges any plaintext private prompt).
    if (s.generationHistory.length > 0) {
      saveStudioGenerationHistory('video_history', s.generationHistory, 30);
    }

    // Restore the encrypted composer draft prompt (owner vault) once it hydrates,
    // unless the user has already typed one this session.
    void hydrateComposerState().then(() => {
      const saved = getComposerSection('video');
      const savedPrompt = saved.prompt;
      const savedNegative = saved.negativePrompt;
      const next = { ...s.setup };
      let changed = false;
      if (typeof savedPrompt === 'string' && savedPrompt && !s.setup.prompt.trim()) {
        next.prompt = savedPrompt;
        changed = true;
      }
      if (typeof savedNegative === 'string' && savedNegative && !String(s.setup.negativePrompt || '').trim()) {
        next.negativePrompt = savedNegative;
        changed = true;
      }
      if (changed) {
        s.setup = next;
        bump();
      }
    });

    // Discover the Hivemind local video workflows (with owner-unlock retry).
    void refreshHivemindWorkflows();

    // Resume any pending video generations from a previous mount/session. Local
    // Media Studio jobs poll the gateway job endpoint (no API key); remote muapi
    // jobs poll muapi. A reload/remount otherwise drops the long local render.
    (async () => {
      const pending = getPendingJobs('video');
      if (!pending.length) return;
      const localPending = pending.filter((job) => job.kind === 'hivemind-local');
      const cloudPending = pending.filter((job) => job.kind !== 'hivemind-local');

      // ── Local Media Studio: restore the live progress canvas and keep polling.
      // Only one local render runs at a time, so resume the first pending job.
      const localJob = localPending[0];
      if (localJob && !s.generating) {
        s.activeLocalJobId = localJob.requestId;
        s.generating = true;
        s.generateError = '';
        s.resultUrl = null;
        s.resultModel = null;
        startGenerationProgress({
          aspectRatio: localJob.historyMeta?.aspect_ratio,
          duration: localJob.historyMeta?.duration,
        }, { stage: 'rendering' });
        // Preserve the true submit time so elapsed / ETA reflect the whole render.
        s.generationStartedAt = localJob.submittedAt || Date.now();
        bump();
        (async () => {
          try {
            const res = await pollHivemindVideoJob(localJob.requestId, {
              onProgress: (info) => {
                const data = (info && typeof info === 'object') ? info : { progress: info };
                updateGenerationProgress({ stage: 'rendering', progress: data.progress, estimateSeconds: data.estimateSeconds });
              },
            });
            if (res && res.url) {
              addToHistory({
                id: res.id || localJob.requestId,
                url: res.url,
                model: localJob.historyMeta?.model,
                aspect_ratio: localJob.historyMeta?.aspect_ratio,
                duration: localJob.historyMeta?.duration,
                timestamp: new Date().toISOString(),
              });
              showVideoInCanvas(res.url, localJob.historyMeta?.model, { fromGeneration: true });
            }
          } catch (e) {
            console.warn('[VideoStudio] Local video resume failed:', localJob.requestId, e.message);
            stopGenerationProgress();
            s.generateError = e.message;
          } finally {
            removePendingJob(localJob.requestId);
            s.activeLocalJobId = null;
            s.generating = false;
            bump();
          }
        })();
      }

      // ── Remote muapi jobs: silent poll into history (needs the API key).
      if (!cloudPending.length) return;
      const apiKey = localStorage.getItem('muapi_key');
      if (!apiKey) return; // can't poll without key; jobs remain for next time
      s.resumeRemaining = cloudPending.length;
      bump();
      cloudPending.forEach(async (job) => {
        const elapsedAttempts = Math.floor((Date.now() - job.submittedAt) / job.interval);
        const attemptsLeft = Math.max(1, job.maxAttempts - elapsedAttempts);
        try {
          const result = await muapi.pollForResult(job.requestId, apiKey, attemptsLeft, job.interval);
          const url = result.outputs?.[0] || result.url || result.output?.url;
          if (url) addToHistory({ id: job.requestId, url, ...job.historyMeta, timestamp: new Date().toISOString() });
        } catch (e) {
          console.warn('[VideoStudio] Pending job failed on resume:', job.requestId, e.message);
        } finally {
          removePendingJob(job.requestId);
          s.resumeRemaining -= 1;
          bump();
        }
      });
    })();

    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Window bridges — add/remove here (the old factory leaked these forever).
  useEffect(() => {
    const onWorkflowSelected = (event) => {
      const modelId = event.detail?.modelId;
      if (!modelId) return;
      if (trySelectHiveById(modelId)) return;
      refreshHivemindWorkflows().then(() => trySelectHiveById(modelId));
    };
    const onContextUpdated = (event) => {
      if (event.detail?.context) applyHivemindWorkflows(event.detail.context);
    };
    window.addEventListener('hivemind-workflow-selected', onWorkflowSelected);
    window.addEventListener('hivemind-context-updated', onContextUpdated);
    return () => {
      window.removeEventListener('hivemind-workflow-selected', onWorkflowSelected);
      window.removeEventListener('hivemind-context-updated', onContextUpdated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Explore dock / hub bridges insert into THIS studio's prompt — only while it is
  // the visible studio (studios stay mounted-hidden after first visit).
  useEffect(() => {
    if (!active) return undefined;
    const offInsert = registerPromptInserter((text) => {
      const current = s.setup.prompt;
      const needsNewline = current && !current.endsWith('\n');
      setPrompt(`${current}${needsNewline ? '\n' : ''}${text}`);
      focusPrompt();
    });
    const offSet = registerStudioSetupLoader('video', (setup) => {
      // Drag-to-restore hands the full captured context; apply it verbatim
      // (model, duration, resolution, aspect, keyframes, LoRAs, ingredients…).
      if (setup?.format === 'studio-full-context' && setup.context) {
        restoreGenerationContext(setup.context);
        focusPrompt();
        return;
      }
      // "Use as video starting frame" from the image viewer: the image is already
      // an uploaded reference, so this is exactly a picker selection (model flips
      // to image-to-video, aspect follows the frame).
      if (setup?.format === 'video-start-frame' && setup.imageUrl) {
        onStartFrameChange([setup.imageUrl]);
        focusPrompt();
        return;
      }
      setPrompt(setup?.primaryPrompt || '');
      focusPrompt();
    });
    return () => { offInsert(); offSet(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Debounced persistence backstop for any click/input/change inside the studio.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const schedule = () => schedulePersist();
    ['click', 'input', 'change'].forEach((name) => el.addEventListener(name, schedule, true));
    return () => {
      ['click', 'input', 'change'].forEach((name) => el.removeEventListener(name, schedule, true));
      if (s.persistTimer != null) { clearTimeout(s.persistTimer); s.persistTimer = null; persistRef.current(); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prompt textarea auto-grow (same 150/250px caps as the old oninput).
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = window.innerWidth < 768 ? 150 : 250;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  });

  // Ingredient stitched-sheet preview follows the selection + aspect signature
  // (replaces the old render-time queueMicrotask refresh).
  const ingModelForSig = currentIngredientModel(s.setup, s.catalogs);
  const ingSelectionForSig = ingModelForSig ? s.sharedIngredientSelections : [];
  const ingredientSignature = ingModelForSig && ingSelectionForSig.length
    ? ingredientSelectionSignature(ingModelForSig, ingSelectionForSig, s.setup.ar)
    : '';
  useEffect(() => {
    if (ingredientSignature) void refreshIngredientSheetPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ingredientSignature]);

  // Load LoRAs when the active LoRA workflow changes and the section is open.
  const loraWorkflowId = currentVideoLoraModel()?.workflowId || '';
  useEffect(() => {
    if (loraWorkflowId && s.loraOpen) void loadLorasForCurrentVideoModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loraWorkflowId]);

  // Drop a stale end-frame selection when leaving FLF-capable state.
  const model = currentModel(s.setup, s.catalogs);
  const endFrameVisible = s.setup.imageMode && !!model?.lastImageField;
  // LTX 2.3 first/middle/end keyframe slots (shared with onStartFrameChange, which
  // opens this picker when a start-frame pick lands on a slots-capable model).
  const ltxFramesVisible = frameSlotsVisible(s.setup, s.catalogs);
  // The grain pass runs on the gateway's own output file, so it only applies to
  // locally generated clips (the native MLX LTX route), not cloud providers.
  const denoiseAvailable = isHivemindVideoModelId(s.setup.modelId);
  useEffect(() => {
    if (!endFrameVisible && s.setup.endImageUrl) {
      s.setup = { ...s.setup, endImageUrl: null };
      bump();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endFrameVisible]);
  useEffect(() => {
    if (!ltxFramesVisible && (s.setup.ltxMiddleUrl || s.setup.ltxEndUrl)) {
      s.setup = { ...s.setup, ltxMiddleUrl: null, ltxEndUrl: null };
      bump();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ltxFramesVisible]);
  // The keyframe picker reads framesPanelAutoOpen when it mounts; clear it right
  // after so later remounts (a model change, clearing a source video) don't pop
  // the panel open on their own.
  useEffect(() => { s.framesPanelAutoOpen = false; });

  // The completion ping is shared with every other studio — follow the store so
  // the toggle stays truthful if it is flipped elsewhere.
  useEffect(() => subscribeCompletionPing((value) => { s.pingWhenComplete = value; bump(); }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);

  // Unmount: stop the elapsed timer + release the preview blob. Never abort an
  // in-flight generation poll — bump() is guarded by mountedRef instead.
  useEffect(() => () => {
    mountedRef.current = false;
    if (s.generationTimer) { clearInterval(s.generationTimer); s.generationTimer = null; }
    releaseIngredientSheetPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- derived render state ---------------- */

  const visibility = deriveControlVisibility(s.setup, s.catalogs);
  const promptUi = derivePromptUi(s.setup, s.catalogs);
  const extendBanner = deriveExtendBanner(s.setup, s.catalogs);
  const advancedInputs = getAdvancedVideoInputs(model);
  const loraModel = currentVideoLoraModel();
  const ingredientModel = currentIngredientModel(s.setup, s.catalogs);
  const modelIsLocal = isLocalVideoModel(s.setup.modelId);
  const hasSourceToggle = isLocalAIAvailable();

  const arOptions = aspectRatiosFor(s.setup, s.setup.modelId);
  // "Use starting frame aspect ratio": only relevant for a Hivemind LTX start
  // frame (image-driven, not video-extend/ingredients). When on, output matches
  // the frame exactly, so the fixed aspect-ratio selector is overridden.
  const startFrameArMatchAvailable = ltxFramesVisible && Boolean(s.setup.imageUrl);
  const arMatchedToFrame = startFrameArMatchAvailable && s.setup.matchStartFrameAr;
  const durationOptions = durationsFor(s.setup, s.setup.modelId);
  const resolutionOptions = resolutionsFor(s.setup, s.setup.modelId);
  const qualityOptions = qualitiesFor(s.setup, s.catalogs, s.setup.modelId);
  const modeOptions = modesFor(s.setup.modelId);
  const effectOptions = effectNamesFor(s.setup, s.catalogs, s.setup.modelId);

  const modeLabel = (() => {
    if (isMotionControlV2V(s.setup, s.catalogs)) return zh() ? '视频+图片 → 视频' : 'Video + image → video';
    if (s.setup.v2vMode) return zh() ? '视频工具' : 'Video tool';
    if (isHivemindVideoInputMode(s.setup)) return zh() ? '延长上传的镜头' : 'Extend uploaded shot';
    if (model?.requiresRequestId) return zh() ? '延长' : 'Extend';
    if (s.setup.imageMode) return zh() ? '图片 → 视频' : 'Image → video';
    return zh() ? '文本 → 视频' : 'Text → video';
  })();

  const isSeedanceResult = s.resultModel === 'seedance-v2.0-t2v' || s.resultModel === 'seedance-v2.0-i2v';
  const generateLabel = s.generating ? t('common.generating') : t('common.generate');

  const progressStageLabel = t(`video.progress.${s.progress.stage}`);
  const progressPct = Math.max(0, Math.min(1, Number(s.progressDisplay) || 0));
  const progressValueLabel = `${Math.round(progressPct * 100)}%`;
  const progressElapsed = formatVideoGenerationElapsed(Date.now() - s.generationStartedAt);
  const progressEta = Number(s.progressEstimateSec) > 0 ? formatVideoGenerationElapsed(s.progressEstimateSec * 1000) : null;
  const progressDetail = [s.progressContext?.aspectRatio, s.progressContext?.duration ? `${s.progressContext.duration}s` : null].filter(Boolean).join(' · ');

  /* ---------------- panel ---------------- */

  const panel = (
    <>
      {hasSourceToggle ? (
        <div className="flex flex-col gap-2">
          <SectionLabel>{zh() ? '来源' : 'Source'}</SectionLabel>
          <Segmented
            value={s.setup.localMode ? 'local' : 'api'}
            onChange={(v) => setLocalMode(v === 'local')}
            options={[
              { value: 'local', label: t('image.local') },
              { value: 'api', label: t('image.api') },
            ]}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <SectionLabel>{zh() ? '模型' : 'Model'}</SectionLabel>
        <VideoModelMenu
          engine={s}
          hasSourceToggle={hasSourceToggle}
          onSelectRegular={selectRegularModel}
          onSelectHive={selectHiveModel}
          onSelectV2V={selectV2VModel}
        />
        <Pill tone="honey" className="w-fit">{modeLabel}</Pill>
        {(() => {
          // Lite/Standard for models that ship both a distilled and a full-step
          // build. Only rendered when both are installed, and switching swaps the
          // selected model so exactly one is ever active.
          const pair = tierPairFor(s.catalogs.hivemindI2V, s.setup.modelId);
          if (!pair) return null;
          const active = pair.lite.id === s.setup.modelId ? 'lite' : 'standard';
          return (
            <Field
              label={zh() ? '质量' : 'Quality'}
              hint={active === 'lite'
                ? (zh() ? '蒸馏模型，约 8 步，速度最快' : 'Distilled — ~8 steps, fastest')
                : (zh() ? '完整步数 + CFG，约慢 3 倍' : 'Full-step CFG — around 3x slower')}
            >
              <Segmented
                value={active}
                onChange={(tier) => { if (pair[tier]) selectHiveModel(pair[tier]); }}
                options={[
                  { value: 'lite', label: zh() ? '精简' : 'Lite' },
                  { value: 'standard', label: zh() ? '标准' : 'Standard' },
                ]}
              />
            </Field>
          );
        })()}
        {(() => {
          // Quick jump to the LTX Ingredients workflow from any other model
          // (getIngredientsWorkflow's selected → ltx23-ic-ingredients-lora → any).
          const workflow = getIngredientsWorkflow(s.setup, s.catalogs.hivemindI2V);
          if (!workflow || workflow.id === s.setup.modelId) return null;
          return (
            <Button size="sm" icon="grid" className="w-fit" onClick={() => selectHiveModel(workflow)}>
              {zh() ? '打开 LTX 配料参考' : 'Open LTX Ingredients'}
            </Button>
          );
        })()}
      </div>

      {(visibility.ar || visibility.duration || visibility.resolution || visibility.quality || visibility.mode || visibility.effect) ? (
        <div className="flex flex-col gap-3">
          <SectionLabel>{zh() ? '格式' : 'Format'}</SectionLabel>
          {visibility.ar ? (
            <Field
              label={zh() ? '宽高比' : 'Aspect ratio'}
              hint={arMatchedToFrame ? (zh() ? '已匹配起始帧，不裁剪' : 'Matched to the starting frame — no cropping') : undefined}
            >
              <NativeSelect value={s.setup.ar} onChange={(e) => setAr(e.target.value)} disabled={arMatchedToFrame}>
                {arOptions.map((r) => <option key={r} value={r}>{r}</option>)}
              </NativeSelect>
            </Field>
          ) : null}
          {startFrameArMatchAvailable ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-ink2">
                {zh() ? '使用起始帧宽高比' : 'Use starting frame aspect ratio'}
              </span>
              <Toggle
                label={zh() ? '使用起始帧宽高比' : 'Use starting frame aspect ratio'}
                checked={s.setup.matchStartFrameAr}
                onChange={setMatchStartFrameAr}
              />
            </div>
          ) : null}
          {visibility.duration ? (
            <Field label={zh() ? '时长' : 'Duration'}>
              <NativeSelect value={String(s.setup.duration)} onChange={(e) => setDuration(e.target.value)}>
                {durationOptions.map((d) => <option key={d} value={String(d)}>{`${d}s`}</option>)}
              </NativeSelect>
            </Field>
          ) : null}
          {visibility.resolution ? (
            <Field label={zh() ? '分辨率' : 'Resolution'}>
              <NativeSelect value={s.setup.resolution} onChange={(e) => setResolution(e.target.value)}>
                {resolutionOptions.map((r) => <option key={r} value={r}>{r}</option>)}
              </NativeSelect>
            </Field>
          ) : null}
          {visibility.quality ? (
            <Field label={zh() ? '质量' : 'Quality'}>
              <NativeSelect value={s.setup.quality} onChange={(e) => setQuality(e.target.value)}>
                {qualityOptions.map((q) => <option key={q} value={q}>{q}</option>)}
              </NativeSelect>
            </Field>
          ) : null}
          {isHivemindVideoModelId(s.setup.modelId) ? (
            <Field label={zh() ? '种子' : 'Seed'}>
              <div className="flex items-center gap-1.5">
                <TextInput
                  type="number"
                  min={0}
                  step={1}
                  value={s.setup.seed >= 0 ? String(s.setup.seed) : ''}
                  placeholder={zh() ? '随机' : 'Random'}
                  onChange={(e) => setSeed(e.target.value === '' ? -1 : e.target.value)}
                  className="flex-1"
                />
                <IconButton
                  icon="refresh"
                  label={zh() ? '随机种子' : 'Randomize seed'}
                  title={zh() ? '每次生成使用随机种子' : 'Use a fresh random seed each generation'}
                  active={s.setup.seed < 0}
                  onClick={randomizeSeed}
                />
              </div>
              {s.setup.seed < 0 && typeof s.lastSeed === 'number' ? (
                <button
                  type="button"
                  onClick={lockLastSeed}
                  className="mt-1 text-left text-xs text-ink3 hover:text-honey"
                >
                  {(zh() ? '上次种子：' : 'Last seed: ') + s.lastSeed + (zh() ? '（点击锁定）' : ' · click to lock')}
                </button>
              ) : null}
            </Field>
          ) : null}
          {visibility.mode ? (
            <Field label={zh() ? '模式' : 'Mode'}>
              <NativeSelect value={s.setup.mode} onChange={(e) => setMode(e.target.value)}>
                {modeOptions.map((m) => <option key={m} value={m}>{m}</option>)}
              </NativeSelect>
            </Field>
          ) : null}
          {visibility.effect ? (
            <Field label={zh() ? '效果类型' : 'Effect type'}>
              <NativeSelect value={s.setup.effectName} onChange={(e) => setEffect(e.target.value)}>
                {effectOptions.map((eff) => <option key={eff} value={eff}>{eff}</option>)}
              </NativeSelect>
            </Field>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <SectionLabel>{zh() ? '高级' : 'Advanced'}</SectionLabel>
        {denoiseAvailable ? (
          <>
            <Field
              label={zh() ? '负面提示词' : 'Negative prompt'}
              hint={zh()
                ? '通过 NAG 生效（快速/精简通道 cfg=1，普通负面提示词无效）。'
                : 'Applied through NAG. The fast and Lite lanes run cfg=1, where an ordinary negative prompt does nothing.'}
            >
              <textarea
                rows={2}
                value={s.setup.negativePrompt || ''}
                onChange={(e) => setNegativePrompt(e.target.value)}
                placeholder={zh()
                  ? '模糊, 解剖错误, 多余手指, 水印'
                  : 'blurry, bad anatomy, extra fingers, deformed hands, watermark'}
                className="w-full resize-y rounded-md border border-line1 bg-bg2 px-2.5 py-2 text-xs text-ink1 outline-none placeholder:text-ink3 focus:border-honey/60"
              />
            </Field>
            {String(s.setup.negativePrompt || '').trim() ? (
              <Field
                label={zh() ? '负面引导强度' : 'Negative guidance'}
                hint={zh()
                  ? 'NAG 强度。约 +8% 生成时间。'
                  : 'NAG strength — costs about 8% more time. Raise it if the prompt still is not being followed.'}
              >
                <NativeSelect
                  value={String(s.setup.nagScale ?? '')}
                  onChange={(e) => commit({
                    ...s.setup,
                    nagScale: e.target.value === '' ? null : Number(e.target.value),
                  })}
                >
                  <option value="">{zh() ? '默认 (11)' : 'Default (11)'}</option>
                  <option value="5">{zh() ? '弱 (5)' : 'Subtle (5)'}</option>
                  <option value="15">{zh() ? '强 (15)' : 'Strong (15)'}</option>
                  <option value="1">{zh() ? '关闭' : 'Off'}</option>
                </NativeSelect>
              </Field>
            ) : null}
          </>
        ) : null}
        {denoiseAvailable ? (
          <Field
            label={zh() ? '颗粒清理' : 'Grain cleanup'}
            hint={s.setup.denoise
              ? (s.setup.denoise === 'strong'
                ? 'Motion-adaptive temporal pass + a spatial pass. Re-encodes after generation.'
                : 'Motion-adaptive temporal pass: averages static grain, leaves moving detail alone.')
              : 'Off — the clip is saved exactly as the model rendered it.'}
          >
            <NativeSelect
              value={s.setup.denoise || ''}
              onChange={(e) => commit({ ...s.setup, denoise: e.target.value })}
            >
              <option value="">Off</option>
              <option value="light">Light</option>
              <option value="strong">Strong</option>
            </NativeSelect>
          </Field>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-ink2">{t('common.pingWhenComplete')}</span>
          <Toggle label={t('common.pingWhenComplete')} checked={s.pingWhenComplete} onChange={setPing} />
        </div>
        {advancedInputs.map((input) => {
          const value = s.setup.advancedValues[input.name];
          if (input.type === 'boolean') {
            return (
              <div key={input.name} className="flex items-center justify-between gap-3" title={input.description || ''}>
                <span className="min-w-0 text-xs font-medium text-ink2">{input.title || input.name}</span>
                <Toggle label={input.title || input.name} checked={Boolean(value)} onChange={(v) => setAdvanced(input.name, v)} />
              </div>
            );
          }
          if (Array.isArray(input.enum) && input.enum.length > 0) {
            return (
              <Field key={input.name} label={input.title || input.name}>
                <NativeSelect
                  value={String(value)}
                  onChange={(e) => {
                    const match = input.enum.find((v) => String(v) === e.target.value);
                    setAdvanced(input.name, match ?? e.target.value);
                  }}
                >
                  {input.enum.map((v) => <option key={String(v)} value={String(v)}>{String(v).replaceAll('_', ' ')}</option>)}
                </NativeSelect>
              </Field>
            );
          }
          const numeric = ['int', 'float', 'number'].includes(input.type);
          return (
            <Field key={input.name} label={input.title || input.name}>
              <TextInput
                type={numeric ? 'number' : 'text'}
                value={value ?? ''}
                min={numeric && input.minValue != null ? input.minValue : undefined}
                max={numeric && input.maxValue != null ? input.maxValue : undefined}
                step={numeric ? (input.step ?? (input.type === 'int' ? 1 : 'any')) : undefined}
                className={numeric ? 'font-mono' : ''}
                onChange={(e) => setAdvanced(input.name, numeric && e.target.value !== '' ? Number(e.target.value) : e.target.value)}
              />
            </Field>
          );
        })}
      </div>

      {ingredientModel ? (
        <IngredientsPanel
          model={ingredientModel}
          selection={s.sharedIngredientSelections}
          sheets={s.sharedIngredientSheets}
          selectedSheet={s.selectedIngredientSheet}
          preview={s.ingredientSheetPreview}
          previewSignature={ingredientSignature}
          uploadMessage={s.ingredientUploadMessage}
          activeCount={activeIngredientSheetItems(ingredientModel, {
            selectedSheet: s.selectedIngredientSheet,
            selections: s.sharedIngredientSelections,
            sheets: s.sharedIngredientSheets,
          }).length}
          onAddViews={addIngredientViews}
          onAddSheets={addIngredientSheets}
          onClear={clearIngredients}
          onToggleSheet={toggleIngredientSheetSelection}
          onRemoveSheet={removeIngredientSheet}
          onRemoveView={removeIngredientView}
          onViewDescription={updateIngredientViewDescription}
          onSheetDescription={updateIngredientSheetDescription}
          onRetryPreview={() => refreshIngredientSheetPreview({ force: true })}
        />
      ) : null}

      {loraModel ? (
        <div className="border-t border-line1 pt-4">
          <LoraSection
            open={s.loraOpen}
            onToggleOpen={() => {
              s.loraOpen = !s.loraOpen;
              bump();
              if (s.loraOpen) void loadLorasForCurrentVideoModel();
            }}
            baseLabel={loraModel.compatibleBaseModels?.join(', ') || loraModel.name}
            baseModelId={loraModel.id || ''}
            status={s.videoLoraCatalogStatus}
            message={s.videoLoraCatalogMessage}
            loras={s.availableVideoLoras}
            selection={currentVideoLoraSelection()}
            getSelection={currentVideoLoraSelection}
            onToggleLora={(lora) => setCurrentVideoLoraSelection(toggleLoraSelection(currentVideoLoraSelection(), lora))}
            onToggleEnabled={(lora) => setCurrentVideoLoraSelection(toggleLoraEnabled(currentVideoLoraSelection(), lora.id))}
            onSetStrength={(id, value) => setCurrentVideoLoraSelection(updateLoraStrength(currentVideoLoraSelection(), id, value), { render: false })}
            onCommitStrength={(id, value) => setCurrentVideoLoraSelection(updateLoraStrength(currentVideoLoraSelection(), id, value))}
            onClearAll={() => setCurrentVideoLoraSelection([])}
            onDownload={() => { s.civitaiOpen = true; bump(); }}
            onUpdateLora={startVideoLoraUpdate}
            onLoadGroup={(selection) => setCurrentVideoLoraSelection(selection)}
          />
        </div>
      ) : null}
    </>
  );

  /* ---------------- composer ---------------- */

  const composer = (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
      {extendBanner ? (
        <div className="flex items-center gap-2 rounded-md border border-honey/30 bg-honey-tint px-3 py-2 text-xs text-honey">
          <Icon name="arrowRight" size={14} className="shrink-0" />
          <span>{extendBanner}</span>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 rounded-lg border border-line1 bg-bg1 p-2.5 transition-colors focus-within:border-honey/40">
        <textarea
          ref={promptRef}
          rows={1}
          placeholder={promptUi.placeholder}
          disabled={promptUi.disabled}
          value={s.setup.prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="max-h-[150px] min-h-[40px] w-full resize-none overflow-y-auto border-none bg-transparent px-1 pt-1 text-[15px] leading-relaxed text-ink1 outline-none placeholder:text-ink3 disabled:opacity-50 md:max-h-[250px]"
        />

        <div className="flex flex-wrap items-center gap-1.5">
          {ltxFramesVisible ? (
            // LTX 2.3: one control with Start / Middle / End rows (all optional).
            <FrameSlotsPicker
              label={zh() ? '关键帧' : 'Frames'}
              slots={[
                { key: 'start', label: zh() ? '起始帧' : 'Start', url: s.setup.imageUrl },
                { key: 'middle', label: zh() ? '中间帧' : 'Middle', url: s.setup.ltxMiddleUrl },
                { key: 'end', label: zh() ? '结束帧' : 'End', url: s.setup.ltxEndUrl },
              ]}
              onSlotChange={(key, url) => {
                const value = url ? [url] : [];
                if (key === 'start') onStartFrameChange(value);
                else if (key === 'middle') onLtxMiddleFrameChange(value);
                else onLtxEndFrameChange(value);
              }}
              uploadFn={uploadFnForFrame}
              requireApiKey={frameRequiresApiKey}
              autoOpen={s.framesPanelAutoOpen}
            />
          ) : (
            <UploadPicker
              values={s.setup.imageUrl ? [s.setup.imageUrl] : []}
              onChange={onStartFrameChange}
              uploadFn={uploadFnForFrame}
              requireApiKey={frameRequiresApiKey}
              maxImages={1}
              accept="image/*"
              compact
              label={zh() ? '起始帧' : 'Start frame'}
              // FLF models have an end frame to fill too — keep the panel up.
              keepOpenOnSelect={endFrameVisible}
            />
          )}

          {endFrameVisible ? (
            <UploadPicker
              values={s.setup.endImageUrl ? [s.setup.endImageUrl] : []}
              onChange={onEndFrameChange}
              uploadFn={uploadFnForFrame}
              requireApiKey={frameRequiresApiKey}
              maxImages={1}
              accept="image/*"
              compact
              label={zh() ? '结束帧（可选）' : 'End frame (optional)'}
            />
          ) : null}

          <input
            ref={videoFileInputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => { void handleVideoFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          <IconButton
            icon={s.setup.videoUrl ? 'film' : 'video'}
            label={s.setup.videoUrl
              ? `${s.setup.videoName || (zh() ? '参考视频' : 'Reference video')} — ${zh() ? '点击清除' : 'click to clear'}`
              : (zh() ? '上传源视频' : 'Upload a source video')}
            active={Boolean(s.setup.videoUrl)}
            className="border border-line1"
            onClick={onVideoRefClick}
          />
          {s.videoUploading ? <Spinner size={14} className="text-honey" /> : null}

          <SavedPromptsMenu
            section="video"
            prompt={s.setup.prompt}
            capture={() => captureGenerationContext(s.setup.prompt)}
            onLoadPrompt={({ prompt }) => { setPrompt(prompt); focusPrompt(); }}
            onLoadContext={(context) => restoreGenerationContext(context)}
          />

          <IconButton
            icon="sparkles"
            label={zh() ? '提示词助手' : 'Prompt helper'}
            className="border border-line1"
            disabled={!s.setup.prompt.trim()}
            onClick={() => { s.promptHelperOpen = true; bump(); }}
          />

          <Pill tone={s.setup.videoUrl ? 'honey' : 'neutral'} className="hidden sm:inline-flex">{modeLabel}</Pill>

          <div className="min-w-2 flex-1" />

          <Pill tone="neutral" className="hidden font-mono sm:inline-flex" title={s.setup.modelName}>
            <Icon name={modelIsLocal ? 'cpu' : 'cloud'} size={12} />
            {s.setup.modelName}
          </Pill>

          <Button
            variant="primary"
            size="lg"
            loading={s.generating}
            onClick={generate}
            title={t('video.generateTooltip')}
            className="min-w-[130px]"
          >
            {generateLabel}
          </Button>
          {s.generating ? (
            <Button
              variant="danger"
              size="lg"
              onClick={cancelGeneration}
              title={zh() ? '取消当前生成并重置状态' : 'Cancel the current generation and reset'}
              className="min-w-[100px]"
            >
              {zh() ? '取消' : 'Cancel'}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );

  /* ---------------- canvas ---------------- */

  const hasHistory = s.generationHistory.length > 0;

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <StudioLayout panel={panel} panelTitle={zh() ? '视频设置' : 'Video settings'} composer={composer}>
        <div className="flex flex-col gap-4 p-4 md:p-5">
          {s.generateError ? (
            <div className="flex items-start justify-between gap-3 rounded-md border border-danger/40 bg-danger-tint px-3.5 py-3">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-danger">{zh() ? '生成失败' : 'Generation failed'}</div>
                <div className="mt-1 break-words font-mono text-xs text-danger/90">{s.generateError}</div>
              </div>
              <IconButton icon="x" label={zh() ? '关闭' : 'Dismiss'} size="sm" onClick={() => { s.generateError = ''; bump(); }} />
            </div>
          ) : null}

          {s.generating ? (
            <Card className="flex flex-col gap-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Spinner size={16} className="text-honey" />
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-ink1">{t('video.progressTitle')}</div>
                    <div className="truncate text-[11px] text-ink3">{s.progressContext?.modelName || s.progressContext?.model || ''}</div>
                  </div>
                </div>
                <span className="shrink-0 font-mono text-xs font-semibold text-honey">{progressValueLabel}</span>
              </div>
              {s.progressContext?.imageUrl ? (
                <div className="relative aspect-video overflow-hidden rounded-md border border-line1 bg-bg0">
                  <ProgressPreview url={s.progressContext.imageUrl} />
                </div>
              ) : null}
              <ProgressBar value={progressPct} />
              <div className="flex items-center justify-between font-mono text-[11px] text-ink3">
                <span>{progressStageLabel}{progressDetail ? ` · ${progressDetail}` : ''}</span>
                <span>{t('video.progress.elapsed')} {progressElapsed}{progressEta ? ` / ~${progressEta}` : ''}</span>
              </div>
            </Card>
          ) : null}

          {s.resultUrl ? (
            <div className="flex flex-col items-center gap-3">
              <ResultVideo key={s.resultUrl} url={s.resultUrl} />
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button variant="neutral" icon="chevronLeft" onClick={backToSetup}>{t('video.backToSetup')}</Button>
                <Button variant="neutral" icon="refresh" onClick={regenerate}>{t('video.regenerate')}</Button>
                {isSeedanceResult ? (
                  <Button variant="neutral" icon="arrowRight" onClick={extend} title={zh() ? '使用 Seedance 2.0 延长此视频' : 'Extend this video using Seedance 2.0 Extend'}>
                    {t('video.extend')}
                  </Button>
                ) : null}
                <Button
                  variant="primary"
                  icon="download"
                  onClick={() => {
                    const entry = s.generationHistory.find((e) => e.url === s.resultUrl);
                    downloadFile(s.resultUrl, videoDownloadName(entry?.model || s.resultModel, entry?.id));
                  }}
                >
                  {t('video.download')}
                </Button>
                <Button variant="neutral" icon="plus" onClick={newPrompt}>{t('video.new')}</Button>
              </div>
            </div>
          ) : null}

          {hasHistory ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <SectionLabel>{t('video.history')}</SectionLabel>
                <span className="font-mono text-[11px] text-ink3">{s.generationHistory.length}</span>
              </div>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
                {s.generationHistory.map((entry, idx) => {
                  const active = s.resultUrl ? s.resultUrl === entry.url : idx === 0;
                  return (
                    <div
                      key={entry.id || `${entry.url}-${idx}`}
                      className={cx(
                        'group relative cursor-pointer overflow-hidden rounded-lg border bg-bg2 transition-colors duration-150',
                        active ? 'border-honey' : 'border-line1 hover:border-line2',
                      )}
                      role="button"
                      tabIndex={0}
                      draggable
                      onDragStart={(e) => {
                        try {
                          e.dataTransfer.setData('application/x-hivemind-output', JSON.stringify({ url: entry.url, section: 'video', mediaType: 'video/*' }));
                          e.dataTransfer.setData('text/uri-list', entry.url);
                          e.dataTransfer.effectAllowed = 'copy';
                        } catch { /* non-critical */ }
                      }}
                      onClick={() => openHistoryEntry(entry)}
                      onKeyDown={(e) => { if (e.key === 'Enter') openHistoryEntry(entry); }}
                    >
                      <HistoryThumb url={entry.url} />
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-bg0/90 to-transparent p-2 pt-6 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                        <div className="truncate text-[11px] text-ink1">
                          {entry.prompt_private ? (zh() ? '私密提示词（已隐去）' : 'Private prompt (hidden)') : (entry.prompt || '—')}
                        </div>
                        <div className="truncate font-mono text-[10px] text-ink3">{entry.model || ''}</div>
                      </div>
                      <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                        <button
                          type="button"
                          title={t('video.download')}
                          aria-label={zh() ? '下载视频' : 'Download video'}
                          className="grid h-7 w-7 place-items-center rounded-md border border-line1 bg-bg0/80 text-ink1 transition-colors hover:border-line2 hover:bg-bg1"
                          onClick={(e) => {
                            e.stopPropagation();
                            // No `|| idx` — see ImageStudio: the seal keys off entry.id.
                            downloadFile(entry.url, videoDownloadName(entry.model, entry.id));
                          }}
                        >
                          <Icon name="download" size={13} />
                        </button>
                        <button
                          type="button"
                          title={zh() ? '删除' : 'Delete'}
                          aria-label={zh() ? '从历史记录中删除' : 'Delete from history'}
                          className="grid h-7 w-7 place-items-center rounded-md border border-line1 bg-bg0/80 text-danger transition-colors hover:border-danger/40 hover:bg-bg1"
                          onClick={(e) => { e.stopPropagation(); s.deleteTarget = entry; bump(); }}
                        >
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

          {!hasHistory && !s.generating && !s.resultUrl ? (
            <EmptyState
              icon="clapper"
              title={zh() ? '创建你的第一个视频' : 'Create your first video'}
              hint={zh()
                ? '选择模型，添加提示词或起始帧，然后点击生成。本地 LTX 工作流支持配料参考和 LoRA。'
                : 'Pick a model, add a prompt or start frame, and press Generate. Local LTX workflows add ingredient references and LoRAs.'}
              className="flex-1"
            />
          ) : null}
        </div>
      </StudioLayout>

      {s.authOpen ? (
        <AuthModal
          onClose={() => { s.authOpen = false; s.authRetry = null; bump(); }}
          onSaved={() => {
            s.authOpen = false;
            bump();
            const retry = s.authRetry;
            s.authRetry = null;
            if (retry) retry();
          }}
        />
      ) : null}

      {s.civitaiOpen ? (
        <CivitaiDownloadDialog
          api={localAI}
          onComplete={finishVideoLoraDownload}
          // The progress lives on a card in the LoRA grid, so open the panel it is in.
          onStarted={() => {
            if (!s.loraOpen) { s.loraOpen = true; void loadLorasForCurrentVideoModel(); }
            bump();
          }}
          onClose={() => { s.civitaiOpen = false; bump(); }}
        />
      ) : null}

      {/* targetModel is the workflow id, not the picker id: the helper chooses its
          guidance from it, and 10Eros 1.3/1.4 want a different prompt shape than
          the 1.2-era lanes. */}
      <PromptHelperDialog
        open={Boolean(s.promptHelperOpen)}
        onClose={() => { s.promptHelperOpen = false; bump(); }}
        idea={s.setup.prompt}
        targetModel={workflowIdFromHivemindModelId(s.setup.modelId) || s.setup.modelId}
        mediaType="video"
        onUse={(prompt) => { setPrompt(prompt); focusPrompt(); }}
      />

      <ConfirmModal
        open={Boolean(s.deleteTarget)}
        onClose={() => { s.deleteTarget = null; bump(); }}
        onConfirm={confirmDeleteHistoryEntry}
        title={zh() ? '删除视频' : 'Delete video'}
        body={zh() ? '从历史记录中移除这个视频。此操作无法撤销。' : 'Remove this video from your history. This cannot be undone.'}
        confirmLabel={zh() ? '删除' : 'Delete'}
      />

      {s.resumeRemaining > 0
        ? createPortal(
          <div className="fixed left-1/2 top-4 z-[200] flex -translate-x-1/2 items-center gap-2.5 rounded-lg border border-line1 bg-bg1 px-4 py-2.5 text-[13px] text-ink1 shadow-pop">
            <Spinner size={14} className="text-honey" />
            <span>{zh()
              ? `正在恢复 ${s.resumeRemaining} 个待处理生成…`
              : `Resuming ${s.resumeRemaining} pending generation${s.resumeRemaining > 1 ? 's' : ''}…`}</span>
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}

/* ---------------- model picker ---------------- */

function VideoModelMenu({ engine: s, hasSourceToggle, onSelectRegular, onSelectHive, onSelectV2V }) {
  return (
    <Menu
      width="w-[300px]"
      panelClassName="max-h-[min(480px,70vh)]"
      trigger={(open, toggle) => (
        <ChipButton
          icon={isLocalVideoModel(s.setup.modelId) ? 'cpu' : 'cloud'}
          value={s.setup.modelName}
          active={open}
          onClick={toggle}
          className="w-full max-w-full justify-between"
        />
      )}
    >
      {(close) => (
        <VideoModelMenuList
          engine={s}
          hasSourceToggle={hasSourceToggle}
          close={close}
          onSelectRegular={onSelectRegular}
          onSelectHive={onSelectHive}
          onSelectV2V={onSelectV2V}
        />
      )}
    </Menu>
  );
}

function VideoModelMenuList({ engine: s, hasSourceToggle, close, onSelectRegular, onSelectHive, onSelectV2V }) {
  const [filter, setFilter] = useState('');
  const query = filter.toLowerCase();
  const matches = (m) => m.name.toLowerCase().includes(query) || m.id.toLowerCase().includes(query);

  // Regular generation models — t2v prepends hivemind workflows (old line 2082).
  const generationModels = groupModelTiers(
    (s.setup.imageMode ? s.catalogs.allI2V : [...s.catalogs.hivemindI2V, ...s.catalogs.allT2V])
      .filter((m) => !hasSourceToggle || isLocalVideoModel(m.id) === s.setup.localMode)
      .filter(matches),
  );

  // Video Tools (remote-only v2v) — hidden while filtering to Local sources.
  const toolModels = (hasSourceToggle && s.setup.localMode) ? [] : v2vModels.filter(matches);

  const metaFor = (m) => (
    isHivemindVideoModelId(m.id) ? (zh() ? 'Hivemind 本地工作流' : 'Hivemind local')
      : isWan2gpModelId(m.id) ? (zh() ? 'Wan2GP 本地服务' : 'Wan2GP local')
        : (m.family || (zh() ? '云端' : 'cloud'))
  );

  return (
    <>
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

      {generationModels.length === 0 && toolModels.length === 0 ? (
        <div className="px-2.5 py-4 text-center text-xs text-ink3">
          {s.setup.localMode
            ? (zh() ? '暂无本地视频工作流，稍后会自动刷新。' : 'No local video workflows yet — they refresh automatically.')
            : (zh() ? '没有匹配的视频模型。' : 'No video models match this search.')}
        </div>
      ) : null}

      {generationModels.length ? (
        <div>
          <MenuHeading>{zh() ? '视频模型' : 'Video models'}</MenuHeading>
          {generationModels.map((m) => {
            // A tier pair shows once here; Lite/Standard is chosen in settings.
            // Selecting the row keeps whichever tier is already active.
            const target = m.isTierGroup ? m.tiers[activeTierFor(m, s.setup.modelId)] : m;
            const selected = m.isTierGroup
              ? Object.values(m.tiers).some((entry) => entry.id === s.setup.modelId)
              : s.setup.modelId === m.id;
            return (
              <MenuItem
                key={m.isTierGroup ? m.tierGroup : m.id}
                selected={selected}
                meta={metaFor(m)}
                onClick={() => {
                  if (isHivemindVideoModelId(target.id)) onSelectHive(target);
                  else onSelectRegular(target);
                  close();
                }}
              >
                {m.name}
              </MenuItem>
            );
          })}
        </div>
      ) : null}

      {toolModels.length ? (
        <div>
          <MenuHeading>{t('video.videoTools')}</MenuHeading>
          {toolModels.map((m) => (
            <MenuItem
              key={m.id}
              selected={s.setup.modelId === m.id}
              meta={m.imageField ? (zh() ? '视频 + 图片' : 'Video + image') : (zh() ? '仅视频' : 'Video only')}
              onClick={() => { onSelectV2V(m); close(); }}
            >
              {m.name}
            </MenuItem>
          ))}
        </div>
      ) : null}
    </>
  );
}
