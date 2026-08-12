// Video Studio — React port of the retired vanilla studio (git history: src/components/VideoStudio.js).
// T2V / I2V / V2V / local Hivemind LTX workflows / Wan2GP, model+parameter
// selection, LTX Ingredients reference sheets, LoRA management, job-based
// generation with resume, results canvas, and history.
//
// Port rules honored here:
// - All src/lib modules are consumed unchanged (source of truth).
// - The imperative state cascades (mode switches, model defaults, restore) live
//   in ./video/videoLogic.js as pure transitions over an immutable `setup`
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
import { RENTED_CHANGED_EVENT, consumeRentedModeRequest, rentedMachinesState, servedByAnyMachine } from '../lib/rentedMachines.js';
import { RentedSourceStatus } from './RentedSourceStatus.jsx';
import { startCivitaiDownload } from '../lib/civitaiDownloadStore.js';
import { loraGenerationPayload, mergeLoraUpdates, replaceLoraInSelection, toggleLoraEnabled, toggleLoraSelection, updateLoraStrength } from '../lib/loraSelection.js';
import { createGenerationContextStore } from '../lib/generationContext.js';
import { applyCameraMotionPrompt, cameraMotionPhrase, normalizeCameraMotions } from '../lib/cameraMotion.js';
import { CameraMotionMenu } from './video/CameraMotionMenu.jsx';
import { applyRestylePrompt } from '../lib/h3RestylePresets.js';
import { RestyleMenu } from './video/RestyleMenu.jsx';
import { CharacterMenu } from './video/CharacterMenu.jsx';
import { applyCharacterToPrompt } from '../lib/h3Characters.js';
import { VIDEO_TAB_FIELDS, cloneTabValue, snapshotTabFields } from '../lib/studioTabs.js';
import { resolveMediaSrc } from '../lib/e2eMedia.js';
import { downloadMedia } from '../lib/downloadMedia.js';
// joinClips itself is imported dynamically inside joinChainFrom — it carries
// mediabunny, which should not weigh down the studio chunk until a join runs.
import { collectChainClips, missingChainParent } from '../lib/chainLineage.js';
import { chainKey, chainTimelineModel } from '../lib/chainTimeline.js';
import { ChainTimeline } from './video/ChainTimeline.jsx';
import { armChainPrompt } from '../lib/chainPrompt.js';
import { applyUgcVideoBrief, hasUgcVideoBrief, ugcVariantAt } from '../lib/ugcMode.js';
import { UgcMenu } from './UgcMenu.jsx';
import { restoredHistoryEntry } from '../lib/restoredOutput.js';
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
  referenceWorkflowForHivemindModel,
  selectableHivemindModelId,
  saveStudioGenerationHistory,
  uploadFileToHivemindStudio,
  workflowIdFromHivemindModelId,
} from '../lib/hivemindStudio.js';
import { t, tf, aspectRatioName } from '../lib/i18n.js';

import { registerPromptInserter, registerStudioSetupLoader } from '../app/promptTarget.js';
import { rememberGenerationSetup } from '../lib/generationSetupStore.js';
import { getComposerSection, hydrateComposerState, updateComposerSection } from '../lib/composerState.js';
import { useMediaSrc } from '../hooks/hooks.js';
import { Icon } from '../ui/icons.jsx';
import {
  AspectRatioPicker, Button, Card, EmptyState, Field, IconButton, NativeSelect, Pill, ProgressBar,
  SectionLabel, Segmented, Slider, Spinner, TextInput, Toggle, cx,
} from '../ui/kit.jsx';
import { ChipButton, Menu, MenuHeading, MenuItem } from '../ui/Menu.jsx';
import { ConfirmModal } from '../ui/Modal.jsx';
import { StudioLayout } from '../ui/kit.jsx';

import { UploadPicker } from './UploadPicker.jsx';
import { FrameSlotsPicker } from './video/FrameSlotsPicker.jsx';
import { ReferencesMenu } from './video/ReferencesMenu.jsx';
import { AuthModal } from '../dialogs/AuthModal.jsx';
import { CivitaiDownloadDialog } from '../dialogs/CivitaiDownloadDialog.jsx';
import { withReferenceTags } from '../lib/h3References.js';
import { PromptHelperDialog } from '../dialogs/PromptHelperDialog.jsx';
import { LoraSection } from './image/LoraSection.jsx';
import { SavedPromptsMenu } from './SavedPromptsMenu.jsx';
import { IngredientsPanel } from './video/IngredientsPanel.jsx';

import {
  VIDEO_PREFERENCES_KEY, zh,
  buildCatalogs, buildInitialSetup, adaptHivemindToVideoEntry, isLocalVideoModel, v2vModels,
  currentModel, generationModelsFor,
  currentIngredientModel, frameSlotsVisible, activeIngredientSheetItems, ingredientSelectionSignature,
  getIngredientsWorkflow,
  isMotionControlV2V, isHivemindVideoInputMode,
  activeVideoTask, headSwapReadiness, isLtxFamilyModel, isMinimaxFamilyModel, slotLabelsFor,
  sourceVideoSwitchCost, videoRequestPlan, videoTasksFor,
  aspectRatiosFor, durationsFor, resolutionsFor, modesFor, qualitiesFor, effectNamesFor,
  deriveControlVisibility, deriveExtendBanner, derivePromptUi,
  applyRestoredPreferences, applyGenerationContext,
  startFrameSelectedTransition, startFrameClearedTransition, clearVideoUploadTransition,
  videoUploadedTransition, selectV2VModelTransition, selectRegularModelTransition,
  selectHivemindWorkflowTransition, newPromptTransition, extendTransition,
  getAdvancedVideoInputs, getAdvancedVideoPayload,
  normalizeVideoPreferences, normalizeVideoIngredientSelections, normalizeSelectedVideoIngredientSheet,
  normalizeVideoGenerationProgress, normalizeSamplerSteps, classifyVideoGenerationStage, formatVideoGenerationElapsed,
  computeSmoothProgress, supportsSpectrum, supportsQualitySteps,
  closestVideoAspectRatio, imageDimensions, redactPrivateHistoryEntry,
  groupModelTiers, activeTierFor, tierPairFor,
} from './video/videoLogic.js';

// Re-export the spec-listed pure helpers so tests/other callers keep importing
// them from a video studio module.
export {
  getAdvancedVideoInputs, getAdvancedVideoPayload, normalizeVideoPreferences,
  normalizeVideoIngredientSelections, normalizeSelectedVideoIngredientSheet,
  normalizeVideoGenerationProgress, classifyVideoGenerationStage, formatVideoGenerationElapsed,
  closestVideoAspectRatio,
} from './video/videoLogic.js';

/* ---------------- media leaves (E2E-transparent) ---------------- */

function ResultVideo({ url }) {
  const src = useMediaSrc(url);
  return (
    <video
      src={src}
      controls controlsList="nodownload"
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

// Studio tabs are repeated mounts (see src/lib/studioTabs.js). `boot` says where
// this tab's starting state comes from: 'persisted' (the original tab), 'fresh' (a
// new tab — catalog defaults, no prompt, no LoRAs) or 'clone' (a duplicate, seeded
// from a snapshot of another tab).
function createEngine({ boot = 'persisted', snapshot = null } = {}) {
  // A 'fresh'/'clone' tab deliberately skips the saved preferences: a new tab must
  // open on the defaults, and a duplicate carries its source's settings instead.
  let persisted = null;
  if (boot === 'persisted') {
    try {
      persisted = normalizeVideoPreferences(JSON.parse(localStorage.getItem(VIDEO_PREFERENCES_KEY) || 'null'));
    } catch { /* corrupted prefs — boot with defaults */ }
  }

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

  const engine = {
    bootSource: boot,
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
    // A History "Load in Studio" that arrived before the workflow catalog did,
    // held until the catalog can resolve its model.
    pendingRestore: null,
    // Scene timeline: which chain is on screen, which shots the user dropped
    // from the cut, and the built cut itself (an object URL — revoked when it
    // is replaced, so a rebuild never leaks the old one).
    chainAnchor: null,
    chainExcluded: [],
    chainCombined: null,
    resolvingChain: false,
    // Shot sets already stored as an output, so rebuilding the same episode
    // does not file a second copy of it.
    chainSavedKeys: [],
  };

  // A duplicate overlays the source tab's configuration on top of the defaults.
  // The snapshot was already deep-copied at capture; copying again keeps a tab
  // duplicated twice from sharing objects with its sibling.
  if (boot === 'clone' && snapshot) Object.assign(engine, cloneTabValue(snapshot));
  return engine;
}

export function VideoStudio({ active = true, tabActive = true, seed = null, apiRef = null } = {}) {
  const engineRef = useRef(null);
  // The seed is read once, at mount — StudioTabs clears it afterwards, so every
  // later "am I the original tab?" question reads the captured value.
  const seedRef = useRef(seed);
  if (!engineRef.current) engineRef.current = createEngine(seedRef.current || undefined);
  const s = engineRef.current;
  const [, setTick] = useState(0);
  const mountedRef = useRef(true);
  const bump = () => { if (mountedRef.current) setTick((n) => n + 1); };

  // The original tab restores the session (pending jobs, composer draft); new and
  // duplicated tabs start clean and must not re-claim either.
  const isPrimaryTab = !seedRef.current;
  // Front tab of this studio: owns preference persistence and one-shot handoffs.
  const tabActiveRef = useRef(tabActive);
  tabActiveRef.current = tabActive;

  // Rented source mode: keep attached-machine state fresh while mounted and
  // honor the one-shot "open in Rented" handoff from the Machines view.
  useEffect(() => {
    let alive = true;
    let timer = null;
    // Rented stays selected even with no machine (the panel offers to rent
    // one) — bouncing back to Local would hide the feature.
    const sync = (force) => rentedMachinesState({ force }).then((state) => {
      if (!alive) return;
      s.rentedMachines = state.live;
      s.rentedPending = state.pending;
      // Split states so the panel can name what is actually wrong: only a
      // provisioning box is "coming online".
      s.rentedProvisioning = state.provisioning;
      s.rentedIdle = state.idle;
      s.rentedBroken = state.broken;
      const wanted = state.pending.length ? 8000 : 30000;
      if (timer?.every !== wanted) {
        if (timer) clearInterval(timer.id);
        timer = { every: wanted, id: setInterval(() => sync(false), wanted) };
      }
      // "Use in Studio" is a one-shot handoff — only the front tab may claim it,
      // or whichever background tab's poll fired first would swallow it.
      if (tabActiveRef.current && consumeRentedModeRequest('video')) {
        commit({ ...s.setup, localMode: true, rentedOnly: true }, { persist: false });
      } else {
        bump();
      }
    });
    sync(false);
    const onChanged = () => sync(true);
    window.addEventListener(RENTED_CHANGED_EVENT, onChanged);
    return () => {
      alive = false;
      if (timer) clearInterval(timer.id);
      window.removeEventListener(RENTED_CHANGED_EVENT, onChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rootRef = useRef(null);
  const promptRef = useRef(null);
  const videoFileInputRef = useRef(null);
  const mountedOnceRef = useRef(false);

  const focusPrompt = () => promptRef.current?.focus();

  /* ---------------- persistence ---------------- */

  // The live, normalized preference object for THIS tab. Split out of the persist
  // path because duplicating a tab needs the same value without writing it.
  const currentVideoPreferences = () => normalizeVideoPreferences({
    modelId: s.setup.modelId,
    localMode: s.setup.localMode,
    // Rented is a THIRD source, not a flavour of Local: without it here the
    // toggle reverts to Local on every reload (applyRestoredPreferences reads
    // it back, but nothing ever wrote it).
    rentedOnly: s.setup.rentedOnly,
    duration: s.setup.duration,
    aspectRatio: s.setup.ar,
    resolution: s.setup.resolution,
    quality: s.setup.quality,
    mode: s.setup.mode,
    effectName: s.setup.effectName,
    matchStartFrameAr: s.setup.matchStartFrameAr,
    denoise: s.setup.denoise,
    seed: s.setup.seed,
    steps: s.setup.steps,
    motionContextUrl: s.setup.motionContextUrl,
    motionContextIndex: s.setup.motionContextIndex,
    advancedValues: s.setup.advancedValues,
    loraSelections: Object.fromEntries(s.videoLoraSelectionsByModel),
    ingredientSelections: s.sharedIngredientSelections,
    ingredientSheets: s.sharedIngredientSheets,
    ingredientSelectedSheet: s.selectedIngredientSheet,
    // pingWhenComplete is deliberately NOT persisted here — it is a shared
    // all-studio setting owned by lib/completionPing.js.
  });

  const persistVideoPreferences = () => {
    const prefs = currentVideoPreferences();
    if (!prefs) return;
    // Only the studio's FRONT tab owns the saved configuration. Background tabs are
    // independent working copies — letting them write would mean the last tab that
    // happened to fire an effect decided what a reload restores.
    if (!tabActiveRef.current) return;
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

  const setLocalMode = (local, rented = false) => {
    const nextRented = Boolean(local && rented);
    if (local === s.setup.localMode && nextRented === Boolean(s.setup.rentedOnly)) return;
    let next = { ...s.setup, localMode: local, rentedOnly: nextRented };
    // Switching INTO rented while the selected model is one the machine does
    // not serve would leave a model the box cannot run (and the generate guard
    // would just refuse). Land on something it actually serves.
    if (nextRented && s.rentedMachines?.length
        && !servedByAnyMachine(s.rentedMachines, { id: next.modelId, name: next.modelName })) {
      const served = [...(s.catalogs.hivemindI2V || []), ...(s.catalogs.allT2V || [])]
        .find((m) => servedByAnyMachine(s.rentedMachines, m));
      if (served) {
        commit(selectHivemindWorkflowTransition(next, served, s.catalogs));
        return;
      }
    }
    commit(next);
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

  // Composer drafts (prompt, negative prompt) are a single owner-vault section, so
  // only the front tab writes to it — a background tab would otherwise overwrite the
  // draft the next reload restores.
  const updateComposerDraft = (patch) => {
    if (tabActiveRef.current) updateComposerSection('video', patch);
  };

  const setPrompt = (v) => {
    s.setup = { ...s.setup, prompt: v };
    // Persist the prompt to the ENCRYPTED composer section (owner vault) so it
    // survives a reload — same as the image studio; the server never sees it.
    updateComposerDraft({ prompt: v });
    bump();
  };

  // Negative prompt is prompt text, so it follows the positive one into the
  // encrypted composer section and never touches the plaintext settings store.
  const setNegativePrompt = (v) => {
    s.setup = { ...s.setup, negativePrompt: v };
    updateComposerDraft({ negativePrompt: v });
    bump();
  };

  // Camera motions ride inside the prompt as one generated phrase. Only the
  // motion IDS live in setup (the phrase is derived from them), so re-applying
  // can strip the previous phrase instead of stacking, and nothing prompt-like
  // lands in the plaintext settings store.
  const applyCameraMotions = (ids) => {
    const previousPhrase = cameraMotionPhrase(s.setup.cameraMotionIds || []);
    const next = applyCameraMotionPrompt(s.setup.prompt, previousPhrase, ids);
    s.setup = { ...s.setup, prompt: next.prompt, cameraMotionIds: normalizeCameraMotions(ids) };
    updateComposerDraft({ prompt: next.prompt });
    bump();
  };

  // H3 restyle preset — same idempotent phrase contract as camera motions:
  // only the preset ID lives in setup, the phrase is derived, switching
  // replaces the previous phrase in the prompt.
  const applyRestyle = (id) => {
    const next = applyRestylePrompt(s.setup.prompt, s.setup.restylePresetId, id);
    s.setup = { ...s.setup, prompt: next.prompt, restylePresetId: next.id };
    updateComposerDraft({ prompt: next.prompt });
    bump();
  };

  // UGC mode — same idempotent-block contract as the phrases above, with one
  // difference that matters: re-dealing the cast KEEPS the script already
  // written into the block, because varying the person/room/light/beats while
  // the words stay put is exactly how a batch is made. Passing null clears.
  // Only the deal number lives in setup; the block is derived from it and the
  // clip length, so nothing prompt-like reaches the plaintext settings store.
  const applyUgc = (index) => {
    const variant = Number.isInteger(index) ? ugcVariantAt(index) : null;
    const prompt = applyUgcVideoBrief(s.setup.prompt, variant, {
      durationSeconds: Number(s.setup.duration) || null,
    });
    // A UGC clip is a phone held in portrait. Switching here rather than
    // leaving it to the user, and said out loud in the menu.
    const vertical = aspectRatiosFor(s.setup, s.setup.modelId).includes('9:16');
    s.setup = {
      ...s.setup,
      prompt,
      // Kept when clearing, so turning UGC back on deals the NEXT cast instead
      // of restarting the cycle at the one you just used.
      ugcVariantIndex: variant ? variant.index : s.setup.ugcVariantIndex ?? null,
      ar: variant && vertical ? '9:16' : s.setup.ar,
    };
    updateComposerDraft({ prompt });
    persistVideoPreferences();
    bump();
    focusPrompt();
  };

  // H3 character quick-add — unlike camera/restyle phrases these are plain
  // prompt text. The lib inserts the full source form (name, casting, series,
  // year), enriching a bare name in place; re-picking is a no-op.
  const addH3Character = (entry) => {
    const next = applyCharacterToPrompt(s.setup.prompt, entry);
    if (next !== s.setup.prompt) setPrompt(next);
    focusPrompt();
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

  // MiniMax H3 Reference mode: character/subject pictures, order-preserving —
  // reference N is the prompt's <Picture N>. Attaching any routes the run to
  // the family's reference workflow and replaces the start/end frames.
  const onCharacterRefsChange = (urls) => {
    s.setup = { ...s.setup, referenceImageUrls: (Array.isArray(urls) ? urls : []).filter(Boolean) };
    bump();
  };

  // Voice clips (<Audio N>) and motion clips (<Video N>) of the same Reference
  // mode. Each entry keeps its filename for the row label, and a video keeps
  // whether its own soundtrack rides along.
  const onReferenceAudiosChange = (items) => {
    s.setup = { ...s.setup, referenceAudios: (Array.isArray(items) ? items : []).filter((item) => item?.url) };
    bump();
  };

  const onReferenceVideosChange = (items) => {
    s.setup = { ...s.setup, referenceVideos: (Array.isArray(items) ? items : []).filter((item) => item?.url) };
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

  // One control, two ways a clip can be attached: the LTX extension graph holds
  // it as setup.videoUrl, and a chain-capable workflow (H3) holds it as the
  // armed motion context. Clearing has to know which, or the button offers to
  // clear something it did not attach.
  const attachedClipUrl = () => s.setup.videoUrl
    || (chainCapableEntryFor(s.setup.modelId) ? s.setup.motionContextUrl : null)
    || null;

  const onVideoRefClick = () => {
    if (s.setup.videoUrl) commit(clearVideoUploadTransition(s.setup, s.catalogs));
    else if (attachedClipUrl()) clearMotionContext();
    else videoFileInputRef.current?.click();
  };

  // Spells out both consequences and lets you back out. A native confirm is
  // deliberate here: this fires from a file-input change handler, and a modal
  // that resolves asynchronously would let the upload start before the answer.
  const confirmSourceVideoSwitch = (cost) => {
    const lines = [];
    if (cost.switchesModel) {
      lines.push(zh()
        ? `${cost.fromModel} 无法延长视频，将切换到 ${cost.toModel}。`
        : `${cost.fromModel} cannot extend or edit a clip, so this switches to ${cost.toModel}.`);
    }
    if (cost.droppedReferences) {
      lines.push(zh()
        ? `已添加的 ${cost.droppedReferences} 个参考会被移除（源视频与参考模式不能同时使用）。`
        : `Your ${cost.droppedReferences} attached reference${cost.droppedReferences === 1 ? '' : 's'} will be removed — a source clip and reference mode cannot be used together.`);
    }
    lines.push(zh() ? '继续吗？' : 'Continue?');
    return window.confirm(lines.join('\n\n'));
  };

  const handleVideoFile = async (file) => {
    if (!file) return;
    const { preferredHive, useHivemind } = resolveVideoHive();
    // The selected workflow may continue a clip on its OWN terms rather than
    // through the LTX extension graph: MiniMax H3 does it with Motion Context,
    // seeding the next shot's opening frames and room tone. Where that is on
    // offer, take it — it keeps the model you chose and your references (the
    // registry accepts both), instead of moving you somewhere else to do it.
    const chainEntry = chainCapableEntryFor(s.setup.modelId);
    if (chainEntry) {
      s.videoUploading = true;
      bump();
      try {
        const upload = await uploadFileToHivemindStudio(file);
        continueSceneFrom(upload.url, s.setup.modelId);
      } catch (err) {
        console.error('[VideoStudio] Clip upload failed:', err);
        toast.error(`${zh() ? '视频上传失败' : 'Video upload failed'}: ${err.message}`);
      } finally {
        s.videoUploading = false;
        bump();
      }
      return;
    }
    // Otherwise attaching a clip moves you to the LTX extension graph and
    // clears reference mode. Ask before doing either, and ask BEFORE the
    // upload so declining costs nothing.
    const cost = sourceVideoSwitchCost({ setup: s.setup, target: useHivemind ? preferredHive : null });
    if (cost && !confirmSourceVideoSwitch(cost)) return;
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
    s.progressSteps = null;
    s.progressEstimateSec = Number(estimateSeconds) || null;
    // Cleared per run, and re-set by the submit below (which happens after
    // this call): a count left over from the previous generation would
    // mis-normalize this one's readout.
    s.requestedSteps = null;
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
  const updateGenerationProgress = ({ status = '', progress = null, stage = '', estimateSeconds = null, step = null, stepTotal = null } = {}) => {
    const value = normalizeVideoGenerationProgress(progress);
    if (value != null) s.progressReal = value;
    if (Number(estimateSeconds) > 0) s.progressEstimateSec = Number(estimateSeconds);
    // Sampler step counters, when the backend measures them. Sticky: the
    // counters stop arriving once sampling ends and the untracked tail
    // (decode, mux, fetch-back) begins, and blanking the label there would
    // read as "it lost track" rather than "the steps are done".
    if (Number(stepTotal) > 0) {
      // Spectrum reports both of its passes; normalizeSamplerSteps folds them
      // back into the Refinement setting the user actually picked.
      s.progressSteps = normalizeSamplerSteps(step, stepTotal, s.requestedSteps)
        || s.progressSteps;
    }
    s.progress = { stage: stage || classifyVideoGenerationStage(status), value };
    bump();
  };

  /* ---------------- canvas / history ---------------- */

  const showVideoInCanvas = (url, model, { fromGeneration = false, anchorChain = true } = {}) => {
    s.contextStore.view(url);
    s.resultUrl = url;
    s.resultModel = model;
    // Which chain the timeline is showing. Anchored to a SHOT, so previewing
    // the joined cut (a blob URL that is in no history) does not collapse the
    // timeline that produced it.
    if (anchorChain) s.chainAnchor = url;
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

  // Proper RIFE frame interpolation (Practical-RIFE 4.25, Apple-MLX port) on a
  // finished clip: 2x/4x the frame rate, audio remuxed untouched. Runs as a
  // post-process on the decrypted bytes, so it works for ANY lane's output —
  // native MLX, local Comfy, or fetched-back rentals — and on old clips too.
  const smoothClip = async (url, model, factor = 2) => {
    if (s.smoothingClip || !url) return;
    s.smoothingClip = true;
    bump();
    const loadingId = toast.loading(zh()
      ? `RIFE ${factor}× 平滑中——在现有帧之间插入新帧…`
      : `Smoothing ${factor}× with RIFE — inserting frames between the existing ones…`);
    try {
      const src = await resolveMediaSrc(url);
      const blob = await (await fetch(src)).blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read the clip'));
        reader.readAsDataURL(blob);
      });
      const result = await localAI.interpolate({ video_base64: dataUrl, factor });
      if (!result?.url) throw new Error('Interpolation finished without a clip');
      const entry = {
        id: `rife-${Date.now()}`,
        url: result.url,
        model: `${model || 'video'} · RIFE ${factor}×`,
        timestamp: new Date().toISOString(),
      };
      addToHistory(entry);
      showVideoInCanvas(result.url, entry.model);
      toast.success(zh() ? `已平滑 ${factor}× — 已加入历史。` : `Smoothed ${factor}× — added to history.`, { id: loadingId });
    } catch (error) {
      toast.error(error?.message || 'Interpolation failed', { id: loadingId });
    } finally {
      s.smoothingClip = false;
      bump();
    }
  };

  // Join a chained episode into one MP4 — entirely on this client. The shots
  // are E2E-sealed at rest and the server cannot read them by design, so the
  // browser (which holds the vault key) decrypts each shot and packet-copies
  // them into a single file: a lossless concat, no re-encode, audio included
  // when every shot carries it. The result downloads straight to disk.
  // Store a built cut as a first-class output: sealed into the same place
  // every generated clip goes, so it shows up in History and survives the tab.
  // The shots themselves never leave the device unencrypted — this uploads the
  // JOINED file the same way Smooth 2x already uploads a clip.
  const saveChainCut = async (blob, shots, key) => {
    if (!isLocalAIAvailable() || s.chainSavedKeys.includes(key)) return;
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read the joined episode'));
        reader.readAsDataURL(blob);
      });
      const saved = await localAI.saveEpisode({ video_base64: dataUrl, shots });
      if (!saved?.url) return;
      // Same shot set, already stored — a rebuild after dropping a shot is a
      // different episode and does get its own output.
      s.chainSavedKeys = [...s.chainSavedKeys, key];
      addToHistory({
        id: `episode-${Date.now()}`,
        url: saved.url,
        model: zh() ? '合成片' : 'Joined episode',
        timestamp: new Date().toISOString(),
      });
      toast.success(zh() ? '合成片已保存到历史记录。' : 'Episode saved — it is in History now.');
    } catch (error) {
      // Not fatal: the cut is on screen and the export button still works.
      toast.error(zh()
        ? `合成片未能保存到历史记录：${error?.message || ''}`
        : `Could not save the episode to History: ${error?.message || 'unknown error'}`);
    }
  };

  // Builds the cut and PUTS IT ON SCREEN. It used to only download the file,
  // which meant the one thing the whole feature exists to produce was the one
  // thing you could not look at.
  const buildChainCut = async (urls, key) => {
    if (s.joiningChain) return null;
    if (!Array.isArray(urls) || urls.length < 2) {
      toast.error(zh() ? '没有可拼接的接续镜头。' : 'No chained shots to join for this clip.');
      return null;
    }
    s.joiningChain = true;
    bump();
    const loadingId = toast.loading(zh()
      ? `拼接 ${urls.length} 段镜头（无损，本机完成）…`
      : `Joining ${urls.length} shots losslessly on this device…`);
    try {
      const { joinClips } = await import('../lib/clipJoiner.js');
      const blobs = [];
      for (const url of urls) {
        const src = await resolveMediaSrc(url);
        blobs.push(await (await fetch(src)).blob());
      }
      const joined = await joinClips(blobs, {
        onProgress: (index, total) => {
          toast.loading(zh() ? `拼接第 ${index + 1}/${total} 段…` : `Joining shot ${index + 1} of ${total}…`, { id: loadingId });
        },
      });
      // The previous cut's object URL is dead the moment a new one replaces it.
      if (s.chainCombined?.url) URL.revokeObjectURL(s.chainCombined.url);
      s.chainCombined = {
        url: URL.createObjectURL(joined.blob),
        seconds: joined.seconds,
        audioJoined: joined.audioJoined,
        key,
      };
      showVideoInCanvas(s.chainCombined.url, zh() ? '合成片' : 'Joined episode', { anchorChain: false });
      toast.success(zh()
        ? `已拼接 ${urls.length} 段（${Math.round(joined.seconds)} 秒）。`
        : `Joined ${urls.length} shots (${Math.round(joined.seconds)}s)${joined.audioJoined ? '' : ' — video only, a shot had no audio'}.`, { id: loadingId });
      // Keep it: an object URL dies with the tab, so the finished episode is
      // stored as a real output — sealed like any other, and therefore in
      // History and restorable later. Best-effort: the cut is already on
      // screen and exportable if this fails.
      void saveChainCut(joined.blob, urls.length, s.chainCombined.key);
      return s.chainCombined;
    } catch (error) {
      toast.error(error?.message || 'Join failed', { id: loadingId });
      return null;
    } finally {
      s.joiningChain = false;
      bump();
    }
  };

  // Pull a chain's earlier shots out of the durable History view.
  //
  // The strip is session-only, so after a reload an episode's earlier shots
  // live only in History — the lineage still names them, by the URL they had
  // when they were generated. Match those against History's rows, adopt what
  // is found, and record the old URL as an alias so the walk reconnects.
  const resolveChainAncestors = async (entry) => {
    if (s.resolvingChain) return;
    let missing = missingChainParent(entry, s.generationHistory);
    if (!missing) return;
    s.resolvingChain = true;
    bump();
    try {
      const [hub, store] = await Promise.all([
        import('../hub/hubData.js'),
        import('../lib/generationSetupStore.js'),
      ]);
      await hub.ensureCanvasHistoryLoaded();
      // Bounded: a corrupt link must not spin, and no real episode is 24 shots
      // of chained H3 (that is over three minutes of generation).
      for (let hop = 0; missing && hop < 24; hop += 1) {
        const row = hub.findCanvasOutputForUrl(missing, store.basenameOf(missing));
        if (!row) break;
        const found = await store
          .resolveGenerationSetup({ url: row.mediaUrl, basename: row.basename })
          .catch(() => null);
        const context = found?.context || null;
        const restored = restoredHistoryEntry(
          { url: row.mediaUrl, id: row.historyId, timestamp: row.createdAt, aliasUrls: [missing] },
          context,
          {
            history: s.generationHistory,
            modelId: context?.model || null,
            aspectRatio: context?.aspectRatio || null,
            duration: context?.duration || null,
          },
        );
        if (context) s.contextStore.remember(row.mediaUrl, context);
        if (restored) {
          addToHistory(restored);
        } else {
          // Already in the strip under its history URL, just not linked to the
          // URL the lineage names. Teach the existing entry that alias rather
          // than adding the same clip twice.
          const existing = s.generationHistory.find((item) => item.url === row.mediaUrl);
          if (!existing) break;
          existing.aliasUrls = [...new Set([...(existing.aliasUrls || []), missing])];
        }
        const next = missingChainParent(entry, s.generationHistory);
        if (next === missing) break; // nothing moved — stop rather than spin
        missing = next;
      }
    } catch { /* the timeline still shows the shots it has */ } finally {
      s.resolvingChain = false;
      bump();
    }
  };

  const joinChainFrom = (entry) => {
    const chain = collectChainClips(entry, s.generationHistory);
    const urls = chain.map((clip) => clip.url).filter((url) => !s.chainExcluded.includes(url));
    return buildChainCut(urls, chainKey(urls));
  };

  const exportChainCut = async () => {
    const cut = s.chainCombined;
    if (!cut?.url) return;
    const anchor = s.generationHistory.find((entry) => entry.url === s.chainAnchor);
    await downloadFile(cut.url, videoDownloadName(`${anchor?.model || 'video'} joined`, anchor?.id || 'episode'));
  };

  const toggleChainShot = (url) => {
    s.chainExcluded = s.chainExcluded.includes(url)
      ? s.chainExcluded.filter((value) => value !== url)
      : [...s.chainExcluded, url];
    bump();
  };

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
      referenceImageUrls: Array.isArray(s.setup.referenceImageUrls)
        ? s.setup.referenceImageUrls.filter(Boolean)
        : [],
      referenceAudios: Array.isArray(s.setup.referenceAudios)
        ? s.setup.referenceAudios.filter((item) => item?.url).map((item) => ({ ...item }))
        : [],
      referenceVideos: Array.isArray(s.setup.referenceVideos)
        ? s.setup.referenceVideos.filter((item) => item?.url).map((item) => ({ ...item }))
        : [],
      videoUrl: s.setup.videoUrl,
      videoName: s.setup.videoName,
      motionContextUrl: s.setup.motionContextUrl || null,
      motionContextIndex: s.setup.motionContextIndex || null,
      sourceGenerationId: model?.requiresRequestId ? s.lastGenerationId : null,
    };
  };

  // Adopt an output that already exists (History's "Load in Studio") into this
  // session. The studio's own strip never persists — prompts and output URLs
  // would then sit in plaintext localStorage — so History is where a clip from
  // a previous session lives, and this is how it becomes actionable again:
  // back on the canvas, so Continue scene / Smooth / Compare / Download apply
  // to it, and back in the strip so it survives navigating away from the result.
  const adoptRestoredOutput = (output, context, model) => {
    const url = String(output?.url || '').trim();
    if (!url) return;
    const entry = restoredHistoryEntry(output, context, {
      history: s.generationHistory,
      modelId: model,
      aspectRatio: s.setup.ar,
      duration: s.setup.duration,
    });
    // No generation context is passed to addToHistory: these settings are
    // already sealed for this output (they are what we just restored), so
    // re-sealing would only rewrite the same vault record.
    if (entry) addToHistory(entry);
    // Session-only recall, so "Back to setup" on the restored clip returns to
    // the settings it was made with rather than whatever is in the composer.
    if (context) s.contextStore.remember(url, context);
    showVideoInCanvas(url, model);
    // If this clip continues an episode whose earlier shots are not in this
    // session, go and get them — otherwise the timeline shows half a story and
    // the cut would silently be missing its opening.
    const anchor = entry || s.generationHistory.find((item) => item.url === url);
    if (anchor?.chainFromUrl) void resolveChainAncestors(anchor);
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

  // Scene chaining (MiniMax H3 Motion Context): arm a finished clip as the
  // seed for the next shot. Arming clears the start frame / source video —
  // the chain provides the opening frames — and each successful generation
  // advances the chain onto the clip it just made.
  const chainCapableEntryFor = (modelId) => (s.catalogs.hivemindI2V || [])
    .find((entry) => entry.id === modelId && entry.supportsMotionContext) || null;
  const continueSceneFrom = (url, sourceModelId) => {
    const target = chainCapableEntryFor(sourceModelId);
    if (!url || !target) return;
    let next = s.setup;
    if (next.modelId !== target.id) next = selectHivemindWorkflowTransition(next, target, s.catalogs);
    commit({
      ...next,
      imageUrl: null,
      videoUrl: null,
      videoName: null,
      motionContextUrl: url,
      motionContextIndex: 1,
      // The pinned frames carry motion, not the scene: a chained prompt that
      // stops describing the established subjects/style renders as a hard cut
      // into an unrelated take (live-verified on the rental). Keep the shot's
      // description in the composer and append the visible continuity scaffold
      // for the user to finish with the next beat.
      prompt: armChainPrompt(next.prompt),
    });
    // Keep the armed clip on screen — it IS this shot's opening. Blanking the
    // canvas here read as "my clip got erased" the moment Continue was pressed.
    showVideoInCanvas(url, target.id);
    focusPrompt();
  };
  const clearMotionContext = () => {
    if (!s.setup.motionContextUrl) return;
    commit({ ...s.setup, motionContextUrl: null, motionContextIndex: null });
  };

  /* ---------------- generation ---------------- */

  const generate = async () => {
    // Rented mode promises WHERE this runs — refuse rather than quietly
    // falling back to this Mac's GPU.
    if (s.setup.rentedOnly
        && !servedByAnyMachine(s.rentedMachines, { id: s.setup.modelId, name: s.setup.modelName })) {
      // Same honesty as the source panel: name the actual blocker.
      toast.error(
        s.rentedBroken?.length
          ? 'Lost the connection to your rented machine — reconnect it from the Source panel or Machines.'
          : s.rentedIdle?.length
            ? 'Your rented machine is not connected to this studio yet — click "Use it here" in the Source panel.'
            : s.rentedProvisioning?.length
              ? 'Your rented machine is still coming online — the Machines view shows its progress.'
              : 'No rented machine is serving this model. Rent one in Machines, or switch the source to Local.',
      );
      return;
    }
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
          // 'max' is the ~1.0MP native-canvas tier (minimax-family only).
          resolution: ['high', 'max'].includes(String(setup.resolution || '').toLowerCase())
            ? String(setup.resolution).toLowerCase()
            : 'standard',
          duration: setup.duration || 4,
          seed: resolvedSeed,
          denoise: setup.denoise || '',
          negative_prompt: String(setup.negativePrompt || '').trim(),
          ...(Number.isFinite(Number(setup.nagScale)) ? { nag_scale: Number(setup.nagScale) } : {}),
          ...(Number(setup.detailerStrength) > 0 ? { detailer_strength: Number(setup.detailerStrength) } : {}),
          loras: loraGenerationPayload(currentVideoLoraSelection()),
          ...(hasIngredientReferences ? {
            ingredientImages: activeItems.map((item) => ({ image: item.url, description: item.description })),
            // A finished sheet's description stands alone as the full sheet
            // description instead of a panel caption.
            ...(finishedSheet?.description?.trim() ? { referenceDescription: finishedSheet.description.trim() } : {}),
          } : {}),
        };
        // One decision, taken in videoTasks.js. No branch here re-reads which
        // uploads exist to guess what kind of job this is.
        const plan = videoRequestPlan(setup);
        localParams.task = plan.task;
        if (plan.task === 'head-swap') {
          localParams.head_swap_backend = setup.headSwapBackend === 'facefusion' ? 'facefusion' : 'bfs';
          if (localParams.head_swap_backend === 'facefusion') {
            if (setup.headSwapFaceEnhancer) localParams.head_swap_face_enhancer = true;
          } else if (Number.isFinite(Number(setup.headSwapLoraStrength))) {
            localParams.head_swap_lora_strength = Number(setup.headSwapLoraStrength);
          }
        }
        if (plan.sendVideo && setup.videoUrl) localParams.video = setup.videoUrl;
        if (plan.sendImage && setup.imageUrl) localParams.image = setup.imageUrl;
        if (plan.videoMode && setup.videoUrl) localParams.video_mode = plan.videoMode;
        // Scene chaining: the armed previous clip seeds this shot's opening
        // frames + room tone. It is a sealed output; the lib decrypts it
        // in-browser at submit, like any saved reference.
        if (plan.sendMotionContext) localParams.motionContext = setup.motionContextUrl;
        // Character references route the run to the family's reference workflow
        // (minimax-h3-reference): discrete pictures, order-preserving, no
        // start/end frames — the reference graph has no frame inputs.
        if (plan.sendReferenceImages) {
          const refTarget = referenceWorkflowForHivemindModel(setup.modelId);
          if (refTarget) localParams.workflow_id = refTarget.workflowId;
          localParams.referenceImages = (setup.referenceImageUrls || []).filter(Boolean);
          // Voice clips (<Audio N>) and motion clips (<Video N>) ride the same
          // reference workflow; each video carries its own soundtrack flag.
          localParams.referenceAudios = (setup.referenceAudios || []).filter((item) => item?.url);
          localParams.referenceVideos = (setup.referenceVideos || []).filter((item) => item?.url);
        }
        // LTX 2.3 first/middle/end keyframes only apply to image-driven runs.
        if (videoRequestPlan(setup).showFrameSlots) {
          if (setup.ltxMiddleUrl) localParams.middleImage = setup.ltxMiddleUrl;
          if (setup.ltxEndUrl) localParams.endImage = setup.ltxEndUrl;
        } else if (setup.endImageUrl) {
          // FL2VA/L2VA on H3: the same end_image_* fields, from the single
          // end-frame picker rather than the LTX three-slot control.
          localParams.endImage = setup.endImageUrl;
        }
        // Only an explicit choice is sent; null leaves the workflow default.
        if (typeof setup.spectrum === 'boolean') localParams.spectrum = setup.spectrum;
        // Refinement steps: only for models whose registry maps a full-step
        // lane (supportsQualitySteps), so a preference saved on MiniMax H3
        // can never leak into a turbo or LTX graph.
        if (Number(setup.steps) > 0 && supportsQualitySteps(currentModel(setup, s.catalogs))) {
          localParams.steps = Math.round(Number(setup.steps));
        }
        // What the Refinement control promised, so the progress readout can be
        // held to it. Spectrum reports twice this (see updateGenerationProgress).
        s.requestedSteps = Math.round(
          Number(localParams.steps) || Number(currentModel(setup, s.catalogs)?.defaultSteps) || 0,
        ) || null;
        localParams.onProgress = (info) => {
          const data = (info && typeof info === 'object') ? info : { progress: info };
          updateGenerationProgress({
            stage: 'rendering',
            progress: data.progress,
            estimateSeconds: data.estimateSeconds,
            step: data.step,
            stepTotal: data.stepTotal,
          });
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
          addToHistory({
            id: genId, url: res.url, prompt, model: setup.modelId, aspect_ratio: setup.ar, duration: setup.duration, timestamp: new Date().toISOString(),
            // Chain lineage: which clip this shot continued. The client-side
            // "Join shots" walks these links to rebuild the whole episode —
            // the server never can, since clips are E2E-sealed once at rest.
            ...(plan.sendMotionContext && setup.motionContextUrl
              ? { chainFromUrl: setup.motionContextUrl, chainShot: (Number(setup.motionContextIndex) || 1) + 1 }
              : {}),
          }, s.lastSubmittedContext);
          showVideoInCanvas(res.url, setup.modelId, { fromGeneration: true });
          // Chain mode advances itself: the clip just made becomes the context
          // for the next shot, so prompt → Generate walks the episode forward
          // clip by clip. Only advance if the armed clip is still the one this
          // run consumed — the user may have re-armed or left chain mode.
          if (plan.sendMotionContext && s.setup.motionContextUrl === setup.motionContextUrl) {
            s.setup = {
              ...s.setup,
              motionContextUrl: res.url,
              motionContextIndex: (Number(s.setup.motionContextIndex) || 1) + 1,
            };
          }
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
    // Routing-only workflows are dropped here and ONLY here: reference mode is
    // reached by attaching references to the normal tier, so listing it as its
    // own model just strands the user on a graph with no frame inputs that
    // cannot run without a reference. It stays in the lib's list, which is what
    // reference routing resolves against.
    const hivemindI2V = videoModels.filter((m) => !m.routingOnly).map(adaptHivemindToVideoEntry);
    s.catalogs = buildCatalogs(hivemindI2V);
    // Anything still pointing at a routing-only id — a preference persisted
    // before it was hidden, or a "Load in Studio" of a past reference run —
    // is rewritten to the family's real tier. This has to happen BEFORE the
    // restore below reads it: an id the catalog cannot resolve makes the
    // restore give up entirely and fall back to the generic default, which is
    // how a MiniMax H3 session came back as LTX.
    if (s.persistedVideoPreferences?.modelId) {
      const selectableId = selectableHivemindModelId(s.persistedVideoPreferences.modelId);
      if (selectableId !== s.persistedVideoPreferences.modelId) {
        s.persistedVideoPreferences = { ...s.persistedVideoPreferences, modelId: selectableId };
      }
    }
    // A "Load in Studio" that arrived before this catalog did. It outranks the
    // persisted preferences below — the user asked for THIS clip's setup, and
    // letting the defaults win would quietly hand back the wrong settings.
    if (s.pendingRestore) {
      const pending = s.pendingRestore;
      s.pendingRestore = null;
      if (restoreGenerationContext(pending.context)) {
        // The clip is already on the canvas; re-point it at the model that
        // actually made it, now that the catalog can resolve it.
        if (pending.output?.url) {
          s.contextStore.remember(pending.output.url, pending.context);
          showVideoInCanvas(pending.output.url, s.setup.modelId);
        }
        return;
      }
    }
    const restored = applyRestoredPreferences(s.setup, s.persistedVideoPreferences, s.catalogs);
    if (restored) {
      s.setup = restored;
    } else {
      // A NEW tab opens on the workflow default; only the tab that restores
      // preferences also restores the session's last hand-picked workflow.
      const saved = s.bootSource === 'persisted' ? getSavedHivemindVideoSelection() : null;
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

  const refreshHivemindWorkflows = async ({ force = false } = {}) => {
    // `force` is the user pressing Refresh: the module-level context is cached,
    // so without it a stale-but-non-empty catalog would answer from memory.
    let context = await loadHivemindStudioContext({ refresh: force });
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
    // unless the user has already typed one this session. Hydration is a
    // module-level cache so every tab may await it, but only the original tab
    // ADOPTS the draft — a new/duplicated tab already knows what it is.
    void hydrateComposerState().then(() => {
      if (!isPrimaryTab) return;
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
    // Only the original tab resumes: every tab shares one pending-job store, so a
    // second tab polling it would race the first and double the history entry.
    (async () => {
      if (!isPrimaryTab) return;
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
                updateGenerationProgress({
                  stage: 'rendering',
                  progress: data.progress,
                  estimateSeconds: data.estimateSeconds,
                  step: data.step,
                  stepTotal: data.stepTotal,
                });
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
      // A workflow picked in the hub lands in the tab the user is looking at —
      // without this every open tab would silently switch model together.
      if (!tabActiveRef.current) return;
      const modelId = event.detail?.modelId;
      if (!modelId) return;
      if (trySelectHiveById(modelId)) return;
      refreshHivemindWorkflows().then(() => trySelectHiveById(modelId));
    };
    const onContextUpdated = (event) => {
      if (event.detail?.context) applyHivemindWorkflows(event.detail.context);
    };
    // The catalog is fetched twice at mount and then never again, so a tab that
    // asked while the stack was restarting keeps an EMPTY workflow list for the
    // rest of its life — the model picker and every capability gated on it
    // (Continue scene, Spectrum, refinement) silently vanish, and only a full
    // page reload brings them back. Refresh now covers the studio too.
    const onHubRefresh = () => { void refreshHivemindWorkflows({ force: true }); };
    window.addEventListener('hivemind-workflow-selected', onWorkflowSelected);
    window.addEventListener('hivemind-context-updated', onContextUpdated);
    window.addEventListener('hivemind-hub-refresh', onHubRefresh);
    return () => {
      window.removeEventListener('hivemind-workflow-selected', onWorkflowSelected);
      window.removeEventListener('hivemind-context-updated', onContextUpdated);
      window.removeEventListener('hivemind-hub-refresh', onHubRefresh);
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
        const restored = restoreGenerationContext(setup.context);
        // The workflow catalog loads over the network, and "Load in Studio"
        // navigates here the moment it has the settings — so the payload can
        // arrive BEFORE the catalog does. applyGenerationContext resolves the
        // model out of that catalog, so it just fails, and the settings were
        // silently dropped while the toast said they had been restored. Keep
        // the payload and re-apply it when the catalog lands.
        if (!restored && !s.catalogs.hivemindI2V.length) s.pendingRestore = setup;
        // "Load in Studio" also hands over the clip itself (drag-to-restore
        // does not — the dragged output is already on screen). If the settings
        // could not be applied, still show the clip, but under the model it was
        // actually made with rather than whatever the composer happens to hold.
        if (setup.output?.url) {
          adoptRestoredOutput(
            setup.output,
            restored ? setup.context : null,
            restored ? s.setup.modelId : (setup.context.model || null),
          );
        }
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
      // Canvas-bridge restores carry no captured context, but the clip is still
      // worth putting back on the canvas.
      if (setup?.output?.url) adoptRestoredOutput(setup.output, null, s.setup.modelId);
      focusPrompt();
    });
    return () => { offInsert(); offSet(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Publish this tab's handle for the tab strip: Copy reads a full snapshot of the
  // engine's configuration, Close asks whether a generation is still running.
  useEffect(() => {
    if (!apiRef) return undefined;
    apiRef.current = {
      snapshot: () => ({
        ...snapshotTabFields(s, VIDEO_TAB_FIELDS),
        // The live prefs, not the last-persisted ones — a background tab stops
        // persisting, so s.persistedVideoPreferences can be stale here.
        persistedVideoPreferences: currentVideoPreferences(),
      }),
      isBusy: () => Boolean(s.generating),
    };
    return () => { apiRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  // LTX 2.3 first/middle/end keyframe slots (shared with onStartFrameChange, which
  // opens this picker when a start-frame pick lands on a slots-capable model).
  const ltxFramesVisible = frameSlotsVisible(s.setup, s.catalogs);
  // Remote MUAPI first-last models declare lastImageField; local workflows
  // declare it through the registry's end_image_* accepts. The LTX three-slot
  // control carries its own end frame, so this is the picker for everything
  // else that can end on a supplied frame. Declared AFTER ltxFramesVisible on
  // purpose — it reads it, and a const cannot be read before its line.
  const endFrameVisible = (s.setup.imageMode && !!model?.lastImageField)
    || (!!model?.supportsEndFrame && !ltxFramesVisible && !s.setup.videoUrl);
  // The grain pass runs on the gateway's own output file, so it only applies to
  // locally generated clips (the native MLX LTX route), not cloud providers.
  // NAG negative prompt, Detailer and Grain cleanup are LTX-graph features.
  // H3 has no negative conditioning lane, so showing them there is a lie.
  const denoiseAvailable = isHivemindVideoModelId(s.setup.modelId) && isLtxFamilyModel(s.setup);
  // MiniMax H3 family: quality controls with measured tradeoffs — a 15s
  // duration slider, a Draft/High/Native resolution ladder capped at the
  // model's ~1MP stability knee, and a refinement (steps) preset on the
  // full-step lane only.
  const minimaxSelected = isHivemindVideoModelId(s.setup.modelId) && isMinimaxFamilyModel(s.setup);
  const minimaxStepsAvailable = minimaxSelected && supportsQualitySteps(model);
  // Preset boundary at 24: anything the High preset wrote (32) reads back as
  // High; the model default (null) and small values read as Standard.
  const minimaxRefinement = Number(s.setup.steps) >= 24 ? 'high' : 'standard';
  const videoTask = activeVideoTask(s.setup);
  const availableTasks = videoTasksFor(s.setup);
  const swapState = headSwapReadiness(s.setup);
  const slotLabels = slotLabelsFor(videoTask, zh());
  // Scene chaining (MiniMax H3): armed = the next generation continues the
  // armed clip. One decision, taken in videoTasks.js like every other plan.
  const chainArmed = videoRequestPlan(s.setup).sendMotionContext;
  const chainShot = Number(s.setup.motionContextIndex) > 0 ? Number(s.setup.motionContextIndex) : 1;
  // Character references (MiniMax H3 Reference mode): the control shows whenever
  // the selected model's family has a reference lane; attached refs route the
  // run there and replace the start/end frames (the reference graph has none).
  const referenceEntry = isHivemindVideoModelId(s.setup.modelId)
    ? referenceWorkflowForHivemindModel(s.setup.modelId)
    : null;
  const refsArmed = videoRequestPlan(s.setup).sendReferenceImages;
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
    // The joined cut lives only as an object URL; a closed tab that never
    // revoked it holds the whole episode in memory for the page's lifetime.
    if (s.chainCombined?.url) { URL.revokeObjectURL(s.chainCombined.url); s.chainCombined = null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- derived render state ---------------- */

  const visibility = deriveControlVisibility(s.setup, s.catalogs);
  const promptUi = derivePromptUi(s.setup, s.catalogs);
  const extendBanner = deriveExtendBanner(s.setup, s.catalogs);
  const advancedInputs = getAdvancedVideoInputs(model);
  const loraModel = currentVideoLoraModel();
  const ingredientModel = currentIngredientModel(s.setup, s.catalogs);
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
    if (videoTask === 'head-swap') return zh() ? '换脸' : 'Head swap';
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
  const progressSteps = s.progressSteps?.total
    ? tf('video.progress.step', s.progressSteps.step, s.progressSteps.total)
    : null;
  const progressDetail = [
    progressSteps,
    s.progressContext?.aspectRatio,
    s.progressContext?.duration ? `${s.progressContext.duration}s` : null,
  ].filter(Boolean).join(' · ');

  // Rented selected with nothing to run on: collapse the panel to the
  // Source block and its rent/provisioning CTA.
  const rentedBlocked = Boolean(s.setup.rentedOnly && !s.rentedMachines?.length);

  /* ---------------- panel ---------------- */

  const panel = (
    <>
      {hasSourceToggle ? (
        <div className="flex flex-col gap-2">
          <SectionLabel>{zh() ? '来源' : 'Source'}</SectionLabel>
          <Segmented
            value={s.setup.rentedOnly ? 'rented' : s.setup.localMode ? 'local' : 'api'}
            onChange={(v) => setLocalMode(v !== 'api', v === 'rented')}
            options={[
              { value: 'local', label: t('image.local') },
              { value: 'api', label: t('image.api') },
              { value: 'rented', label: t('image.rented') },
            ]}
          />
          {s.setup.rentedOnly ? <RentedSourceStatus engine={s} page="video" /> : null}
        </div>
      ) : null}

      {rentedBlocked ? null : (
        <>
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
          // Quick jump to the LTX Ingredients workflow — LTX-family models
          // only; it is meaningless from an H3 (or any non-LTX) workflow.
          if (!isLtxFamilyModel(s.setup)) return null;
          const workflow = getIngredientsWorkflow(s.setup, s.catalogs.hivemindI2V);
          if (!workflow || workflow.id === s.setup.modelId) return null;
          return (
            <Button size="sm" icon="grid" className="w-fit" onClick={() => selectHiveModel(workflow)}>
              {zh() ? '打开 LTX 配料参考' : 'Open LTX Ingredients'}
            </Button>
          );
        })()}
      </div>

      {availableTasks.length > 1 ? (
        <div className="flex flex-col gap-3">
          <SectionLabel>{zh() ? '任务' : 'Task'}</SectionLabel>
          {/* Explicit, and first: every input slot below reads its meaning from
              this. Inferring it from whichever files were attached is what made
              an uploaded clip always mean "extend". */}
          <Segmented
            value={videoTask}
            onChange={(next) => commit({ ...s.setup, videoTask: next })}
            options={[
              { value: 'generate', label: zh() ? '生成' : 'Generate' },
              { value: 'extend', label: zh() ? '延长' : 'Extend' },
              { value: 'head-swap', label: zh() ? '换脸' : 'Head swap' },
            ]}
          />
          <p className="text-[11px] leading-relaxed text-ink3">
            {videoTask === 'head-swap'
              ? (zh()
                ? '用“新面孔”替换“源视频”中的人脸。换脸 LoRA 由本模式自动启用；提示词格式为 “head_swap: FACE: … ACTION: …”。'
                : 'Replaces the face in the source video with the new face. The BFS head-swap LoRA is switched on by this mode — you do not need to select it. Prompt shaped "head_swap: FACE: … ACTION: …".')
              : videoTask === 'extend'
                ? (zh() ? '在上传视频的结尾追加新画面。' : 'Appends new footage to the end of the uploaded video.')
                : (zh() ? '从提示词生成；可选起始帧。' : 'Generates from the prompt, optionally starting from a frame you attach.')}
          </p>
          {videoTask === 'head-swap' ? (
            <>
              <Field
                label={zh() ? '换脸引擎' : 'Swap engine'}
                hint={s.setup.headSwapBackend === 'facefusion'
                  ? (zh()
                    ? '仅替换面部区域，其余画面与原视频完全一致；速度快约 10 倍，但发型和头型保持原样。'
                    : 'Swaps only the face region — body, clothing, background and motion stay identical to your source, and it runs about 10× quicker. Hair and head shape stay the original actor\'s.')
                  : (zh()
                    ? '重绘每一帧，可改变发型与头型，但整个画面会被重新生成。'
                    : 'Regenerates every frame, so it can change hair and head shape — but the whole picture is reinvented rather than preserved.')}
              >
                <Segmented
                  value={s.setup.headSwapBackend === 'facefusion' ? 'facefusion' : 'bfs'}
                  onChange={(next) => commit({ ...s.setup, headSwapBackend: next })}
                  options={[
                    { value: 'bfs', label: zh() ? 'BFS 重绘' : 'BFS (regenerate)' },
                    { value: 'facefusion', label: zh() ? 'FaceFusion' : 'FaceFusion' },
                  ]}
                />
              </Field>
              {s.setup.headSwapBackend === 'facefusion' ? (
                <Toggle
                  checked={Boolean(s.setup.headSwapFaceEnhancer)}
                  onChange={(next) => commit({ ...s.setup, headSwapFaceEnhancer: next })}
                  label={zh() ? '面部增强（约慢一倍）' : 'Face enhancer (about 2× slower)'}
                />
              ) : (
                <Field
                  label={zh() ? '换脸强度' : 'Head-swap strength'}
                  hint={zh()
                    ? '1.0 动作最自然；高于 1.0 更强的身份与发型还原，但可能失真。'
                    : '1.0 gives the best motion fidelity. Above 1.0 captures identity and hair more strongly, but can distort.'}
                >
                  <Slider
                    min={0.5}
                    max={1.5}
                    step={0.05}
                    value={Number(s.setup.headSwapLoraStrength ?? 1)}
                    onChange={(next) => commit({ ...s.setup, headSwapLoraStrength: next })}
                    format={(v) => Number(v).toFixed(2)}
                  />
                </Field>
              )}
            </>
          ) : null}
          {swapState.active && !swapState.ready ? (
            <p className="text-[11px] font-medium text-danger">
              {zh() ? '还需要：' : 'Still needed: '}{swapState.missing.join(zh() ? '、' : ' and ')}
            </p>
          ) : null}
        </div>
      ) : null}

      {(visibility.ar || visibility.duration || visibility.resolution || visibility.quality || visibility.mode || visibility.effect) ? (
        <div className="flex flex-col gap-3">
          <SectionLabel>{zh() ? '格式' : 'Format'}</SectionLabel>
          {visibility.ar ? (
            <Field
              label={zh() ? '宽高比' : 'Aspect ratio'}
              hint={arMatchedToFrame ? (zh() ? '已匹配起始帧，不裁剪' : 'Matched to the starting frame — no cropping') : undefined}
            >
              <AspectRatioPicker
                options={arOptions}
                value={s.setup.ar}
                onChange={setAr}
                disabled={arMatchedToFrame}
                nameFor={aspectRatioName}
              />
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
            minimaxSelected ? (
              <Field
                label={zh() ? '时长' : 'Duration'}
                hint={zh()
                  ? '最长 15 秒 — 模型约在 15 秒内保持人物与场景一致，因此不提供更长时长。'
                  : 'Up to 15s — the model keeps people and scenes consistent for about 15 seconds, so longer takes are not offered.'}
              >
                <Slider
                  min={Number(durationOptions[0]) || 1}
                  max={Number(durationOptions[durationOptions.length - 1]) || 15}
                  step={1}
                  value={Number(s.setup.duration) || 5}
                  onChange={setDuration}
                  format={(v) => `${v}s`}
                />
              </Field>
            ) : (
              <Field label={zh() ? '时长' : 'Duration'}>
                <NativeSelect value={String(s.setup.duration)} onChange={(e) => setDuration(e.target.value)}>
                  {durationOptions.map((d) => <option key={d} value={String(d)}>{`${d}s`}</option>)}
                </NativeSelect>
              </Field>
            )
          ) : null}
          {visibility.resolution ? (
            minimaxSelected ? (
              <Field
                label={zh() ? '分辨率' : 'Resolution'}
                hint={{
                  Standard: zh()
                    ? '草稿 · 0.3MP — 最快，适合先试想法再正式渲染。'
                    : 'Draft · 0.3MP — fastest; try an idea cheaply before a real render.',
                  High: zh()
                    ? '高清 · 0.9MP — 速度与细节的均衡默认档。'
                    : 'High · 0.9MP — the balanced default for speed and detail.',
                  Max: zh()
                    ? '原生 · 1.0MP — 模型的原生画布：细节、音频与画面文字最佳，渲染最慢。超过 1MP 模型会变得不稳定，因此以此为上限。'
                    : "Native · 1.0MP — the model's own canvas: sharpest detail, audio and on-screen text; slowest. Above 1MP the model grows unstable, so this is the ceiling.",
                }[s.setup.resolution] || undefined}
              >
                <Segmented
                  value={s.setup.resolution}
                  onChange={setResolution}
                  options={[
                    { value: 'Standard', label: zh() ? '草稿' : 'Draft' },
                    { value: 'High', label: zh() ? '高清' : 'High' },
                    { value: 'Max', label: zh() ? '原生' : 'Native' },
                  ]}
                />
              </Field>
            ) : (
              <Field label={zh() ? '分辨率' : 'Resolution'}>
                <NativeSelect value={s.setup.resolution} onChange={(e) => setResolution(e.target.value)}>
                  {resolutionOptions.map((r) => <option key={r} value={r}>{r}</option>)}
                </NativeSelect>
              </Field>
            )
          ) : null}
          {minimaxStepsAvailable ? (
            <Field
              label={zh() ? '精修' : 'Refinement'}
              hint={minimaxRefinement === 'high'
                ? (zh()
                  ? '32 步采样 — 动作更流畅、手部面部更清晰、音频更干净；渲染时间约为两倍。'
                  : '32 sampling passes — smoother motion, sharper hands and faces, cleaner audio. Roughly twice the render time.')
                : (zh()
                  ? `${Math.round(model?.defaultSteps || 15)} 步采样（模型默认）— 最快。`
                  : `${Math.round(model?.defaultSteps || 15)} sampling passes (the model default) — quickest.`)}
            >
              <Segmented
                value={minimaxRefinement}
                onChange={(next) => commit({ ...s.setup, steps: next === 'high' ? 32 : null })}
                options={[
                  { value: 'standard', label: zh() ? '标准' : 'Standard' },
                  { value: 'high', label: zh() ? '高细节' : 'High detail' },
                ]}
              />
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
        {supportsSpectrum(model) ? (
          <Field
            label={zh() ? '快速采样（Spectrum）' : 'Fast sampling (Spectrum)'}
            hint={chainArmed
              ? (zh()
                ? '场景接续期间强制关闭：步进预测会算错拼接处固定的画面行。'
                : 'Forced off while chaining scenes: step forecasting mispredicts the pinned join frames.')
              : (zh()
                ? '预测约一半的采样步而非全部计算：采样时间约减半，但细节会变柔、高光可能发散。追求最高画质时请关闭。'
                : 'Predicts about half the sampling steps instead of computing them — roughly half the sampling time, but fine detail softens and highlights can bloom. Turn it off for maximum fidelity.')}
          >
            <Toggle
              checked={!chainArmed && s.setup.spectrum !== false}
              disabled={chainArmed}
              onChange={(next) => commit({ ...s.setup, spectrum: next })}
              label={zh() ? '快速采样' : 'Fast sampling'}
            />
          </Field>
        ) : null}
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
            label={zh() ? '细节增强' : 'Detailer'}
            hint={s.setup.detailerStrength
              ? "Lightricks' IC-LoRA Detailer runs a second sampling pass over the clip to add fine texture. Roughly doubles generation time."
              : 'Off — one pass, exactly as fast as before.'}
          >
            <NativeSelect
              value={String(s.setup.detailerStrength || 0)}
              onChange={(e) => commit({ ...s.setup, detailerStrength: Number(e.target.value) })}
            >
              <option value="0">{zh() ? '关闭' : 'Off'}</option>
              <option value="0.4">{zh() ? '弱 (0.4)' : 'Subtle (0.4)'}</option>
              <option value="0.6">{zh() ? '推荐 (0.6)' : 'Recommended (0.6)'}</option>
              <option value="0.9">{zh() ? '强 (0.9)' : 'Strong (0.9)'}</option>
            </NativeSelect>
          </Field>
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
            baseModels={loraModel.compatibleBaseModels || []}
            status={s.videoLoraCatalogStatus}
            message={s.videoLoraCatalogMessage}
            loras={s.availableVideoLoras}
            rentedOnly={Boolean(s.setup.rentedOnly)}
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
      )}
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
                { key: 'start', label: slotLabels.image, url: s.setup.imageUrl },
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
          ) : chainArmed ? (
            // Scene chaining replaces the start frame: the armed clip's tail IS
            // the opening of this shot, so the picker gives way to the chain chip.
            <div
              className="flex items-center gap-1.5 rounded-md border border-honey/40 bg-honey-tint px-2 py-1"
              title={zh()
                ? '接续的画面会延续上一段的运动与环境音，但场景要靠提示词维持：保留原有的风格与主体描述，先按上一段的收尾构图停一拍，再写接下来发生什么。'
                : "The pinned frames carry motion and room tone — the SCENE carries through the prompt. Keep the shot's style and subject words, hold the previous closing framing for a beat, then describe what happens next."}
            >
              <Icon name="film" size={13} className="text-honey" />
              <span className="text-xs font-medium text-honey">
                {zh() ? `接续第 ${chainShot} 段` : `Continuing shot ${chainShot}`}
              </span>
              <button
                type="button"
                title={zh() ? '退出场景接续' : 'Leave scene chaining'}
                aria-label={zh() ? '退出场景接续' : 'Leave scene chaining'}
                className="grid h-4 w-4 place-items-center rounded text-honey transition-colors hover:bg-honey/20"
                onClick={clearMotionContext}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          ) : endFrameVisible ? (
            // First/last-frame models (H3 FL2VA, remote FLF): ONE control with
            // Start / End rows, same pattern as the LTX three-slot picker —
            // never two lookalike icon buttons side by side. Armed character
            // references replace these frames for the run, but the picker stays
            // mounted (dimmed, with a note) — hiding it stranded an already-set
            // start frame with no way to change it or add the end frame.
            <FrameSlotsPicker
              label={zh() ? '关键帧' : 'Frames'}
              slots={[
                { key: 'start', label: slotLabels.image, url: s.setup.imageUrl },
                { key: 'end', label: zh() ? '结束帧（可选）' : 'End (optional)', url: s.setup.endImageUrl },
              ]}
              onSlotChange={(key, url) => {
                const value = url ? [url] : [];
                if (key === 'start') onStartFrameChange(value);
                else onEndFrameChange(value);
              }}
              uploadFn={uploadFnForFrame}
              requireApiKey={frameRequiresApiKey}
              inactiveNote={refsArmed
                ? (zh() ? '已附加角色参考——生成时将使用参考，替代首尾帧' : 'Character references replace these frames while attached')
                : ''}
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
              ignored={refsArmed}
            />
          )}

          {referenceEntry ? (
            // One control for all three reference kinds. The slot counts come
            // from the workflow entry rather than being restated here, so the
            // panel can never offer a slot the graph has not wired.
            <ReferencesMenu
              images={Array.isArray(s.setup.referenceImageUrls) ? s.setup.referenceImageUrls : []}
              audios={Array.isArray(s.setup.referenceAudios) ? s.setup.referenceAudios : []}
              videos={Array.isArray(s.setup.referenceVideos) ? s.setup.referenceVideos : []}
              prompt={s.setup.prompt}
              onPromptChange={(next) => { setPrompt(next); focusPrompt(); }}
              limits={{
                images: referenceEntry.referenceSlots?.images || 9,
                audios: referenceEntry.referenceSlots?.audios || 3,
                videos: referenceEntry.referenceSlots?.videos || 3,
              }}
              onChange={{
                images: onCharacterRefsChange,
                audios: onReferenceAudiosChange,
                videos: onReferenceVideosChange,
              }}
              uploadFn={uploadFnForFrame}
              requireApiKey={frameRequiresApiKey}
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
            icon={attachedClipUrl() ? 'film' : 'video'}
            label={attachedClipUrl()
              ? `${s.setup.videoName || slotLabels.video} — ${zh() ? '点击清除' : 'click to clear'}`
              : `${zh() ? '上传' : 'Upload'} ${slotLabels.video}${slotLabels.videoHint ? ` — ${slotLabels.videoHint}` : ''}`}
            active={Boolean(attachedClipUrl())}
            className="border border-line1"
            onClick={onVideoRefClick}
          />
          {s.videoUploading ? <Spinner size={14} className="text-honey" /> : null}

          <SavedPromptsMenu
            section="video"
            prompt={s.setup.prompt}
            modelSource={s.setup}
            capture={() => captureGenerationContext(s.setup.prompt)}
            onLoadPrompt={({ prompt }) => { setPrompt(prompt); focusPrompt(); }}
            onLoadContext={(context) => restoreGenerationContext(context)}
          />

          <CameraMotionMenu
            selectedIds={s.setup.cameraMotionIds || []}
            onApply={applyCameraMotions}
          />

          <UgcMenu
            mode="video"
            active={hasUgcVideoBrief(s.setup.prompt)}
            variantIndex={Number.isInteger(s.setup.ugcVariantIndex) ? s.setup.ugcVariantIndex : null}
            durationSeconds={Number(s.setup.duration) || null}
            verticalAvailable={aspectRatiosFor(s.setup, s.setup.modelId).includes('9:16')}
            onArm={applyUgc}
          />

          {/* Restyle presets + character quick-add are tuned for the MiniMax H3 family. */}
          {/minimax-h3/.test(s.setup.modelId || '') ? (
            <>
              <RestyleMenu activeId={s.setup.restylePresetId || null} onApply={applyRestyle} />
              <CharacterMenu prompt={s.setup.prompt} onPick={addH3Character} />
            </>
          ) : null}

          <IconButton
            icon="sparkles"
            label={zh() ? '提示词助手' : 'Prompt helper'}
            className="border border-line1"
            disabled={!s.setup.prompt.trim()}
            onClick={() => { s.promptHelperOpen = true; bump(); }}
          />

          {/* Mode and model read out in the left panel — no duplicate badges here. */}
          <div className="min-w-2 flex-1" />

          <Button
            variant="primary"
            size="lg"
            loading={s.generating}
            disabled={rentedBlocked}
            onClick={generate}
            title={rentedBlocked
              ? 'Rent a machine (or switch the source to Local) to generate.'
              : t('video.generateTooltip')}
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
                {chainCapableEntryFor(s.resultModel) ? (
                  <Button
                    variant="neutral"
                    icon="arrowRight"
                    onClick={() => continueSceneFrom(s.resultUrl, s.resultModel)}
                    title={zh()
                      ? '下一个镜头将从这段视频的结尾继续（画面与环境音无缝衔接）'
                      : 'The next shot picks up exactly where this clip ends — motion and room tone carry across the cut'}
                  >
                    {zh() ? '接续场景' : 'Continue scene'}
                  </Button>
                ) : null}
                {isLocalAIAvailable() ? (
                  <Button
                    variant="neutral"
                    icon="film"
                    loading={s.smoothingClip}
                    onClick={() => void smoothClip(s.resultUrl, s.resultModel, 2)}
                    title={zh()
                      ? '真 RIFE 插帧（本地 MLX）：帧率翻倍，音频保持不变'
                      : 'Real RIFE interpolation (local MLX): doubles the frame rate; audio passes through untouched'}
                  >
                    {zh() ? 'RIFE 平滑 2×' : 'Smooth 2×'}
                  </Button>
                ) : null}
                {(() => {
                  const currentEntry = s.generationHistory.find((e) => e.url === s.resultUrl);
                  const chainLength = currentEntry ? collectChainClips(currentEntry, s.generationHistory).length : 0;
                  return chainLength >= 2 ? (
                    <Button
                      variant="neutral"
                      icon="layers"
                      loading={s.joiningChain}
                      onClick={() => void joinChainFrom(currentEntry)}
                      title={zh()
                        ? '在本机把整条接续镜头无损拼接成一个 MP4（内容不离开这台设备）'
                        : 'Join the whole chained episode into one MP4, losslessly, on this device — the clips never leave it'}
                    >
                      {zh() ? `拼接 ${chainLength} 段` : `Join ${chainLength} shots`}
                    </Button>
                  ) : null;
                })()}
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

          {/* The episode, above its shots: chaining produces one clip per shot,
              so without this the finished cut was only ever a downloaded file. */}
          {(() => {
            const anchor = s.generationHistory.find((entry) => entry.url === s.chainAnchor);
            const timeline = anchor
              ? chainTimelineModel(anchor, s.generationHistory, {
                excludedUrls: s.chainExcluded,
                combined: s.chainCombined,
                // Armed chain → the episode starts existing now, not once the
                // second clip has rendered.
                armedFromUrl: chainArmed ? (s.setup.motionContextUrl || '') : '',
              })
              : null;
            if (!timeline) return null;
            return (
              <ChainTimeline
                model={timeline}
                activeUrl={s.resultUrl}
                zh={zh()}
                building={s.joiningChain}
                // Previewing from the timeline never re-anchors it: the anchor
                // is the episode's LAST shot, and clicking shot 1 (which has no
                // ancestors) would otherwise collapse the timeline you are
                // browsing. Only a generation or a pick from the strip below
                // moves it.
                onSelect={(url, model) => showVideoInCanvas(url, model, { anchorChain: false })}
                onToggleExcluded={toggleChainShot}
                onExport={(shot) => downloadFile(shot.url, videoDownloadName(shot.model, shot.id))}
                onBuild={() => void buildChainCut(timeline.includedUrls, timeline.key)}
                onExportCombined={() => void exportChainCut()}
              />
            );
          })()}

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
                        {chainCapableEntryFor(entry.model) ? (
                          <button
                            type="button"
                            title={zh() ? '接续场景：下一个镜头从这段结尾继续' : 'Continue scene: the next shot picks up where this clip ends'}
                            aria-label={zh() ? '接续场景' : 'Continue scene'}
                            className="grid h-7 w-7 place-items-center rounded-md border border-line1 bg-bg0/80 text-ink1 transition-colors hover:border-honey/40 hover:bg-bg1"
                            onClick={(e) => { e.stopPropagation(); continueSceneFrom(entry.url, entry.model); }}
                          >
                            <Icon name="arrowRight" size={13} />
                          </button>
                        ) : null}
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
        // The workflow this run will ACTUALLY use, which for armed references is
        // the reference lane — the same decision videoRequestPlan makes at
        // submit. Sending the picker's id instead handed the helper the plain
        // text-to-video profile, so it wrote a prompt with no <Picture N> /
        // <Video N> / <Audio N> labels at all and replaced the ones already
        // there. The reference profile knows every rule this needs; it was
        // simply never being selected.
        targetModel={(refsArmed && referenceEntry?.workflowId)
          || workflowIdFromHivemindModelId(s.setup.modelId)
          || s.setup.modelId}
        // How many of each are attached, so the labels it writes are the labels
        // the graph will actually carry.
        references={refsArmed ? {
          images: (s.setup.referenceImageUrls || []).length,
          videos: (s.setup.referenceVideos || []).map((item) => ({ useAudio: Boolean(item?.useAudio) })),
          audios: (s.setup.referenceAudios || []).length,
        } : null}
        mediaType="video"
        hasFirstFrame={Boolean(s.setup.imageUrl)}
        hasLastFrame={Boolean(s.setup.endImageUrl || s.setup.ltxEndUrl)}
        imageUrl={s.setup.imageUrl || ''}
        videoUrl={s.setup.videoUrl || ''}
        continuingFromUrl={chainArmed ? (s.setup.motionContextUrl || '') : ''}
        continuingFromPrompt={chainArmed
          ? (s.contextStore.recall(s.setup.motionContextUrl)?.prompt || '')
          : ''}
        durationSeconds={Number(s.setup.duration) || null}
        // UGC inverts several of the per-model defaults — speech becomes
        // required rather than optional, polish becomes the failure mode — so
        // the helper has to be told, the same way it is told about a chain.
        ugc={hasUgcVideoBrief(s.setup.prompt)}
        onUse={(prompt) => {
          // A helper result that omits a label would silently unbind that
          // reference. Re-applying the scaffold puts back only what is missing.
          setPrompt(refsArmed
            ? withReferenceTags(prompt, {
              videos: s.setup.referenceVideos || [],
              audios: s.setup.referenceAudios || [],
            })
            : prompt);
          focusPrompt();
        }}
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
    generationModelsFor(s.setup, s.catalogs)
      .filter((m) => !hasSourceToggle || isLocalVideoModel(m.id) === s.setup.localMode)
      .filter((m) => !(s.setup.rentedOnly && s.rentedMachines?.length) || servedByAnyMachine(s.rentedMachines, m))
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
                {(m.isTierGroup ? target.beta : m.beta) ? (
                  <span className="ml-1.5 inline-block rounded-sm border border-honey/40 bg-honey-tint px-1 py-px align-middle font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-honey">
                    {zh() ? '测试' : 'beta'}
                  </span>
                ) : null}
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
