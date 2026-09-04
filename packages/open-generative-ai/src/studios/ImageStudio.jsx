// Image Studio — React port of the retired vanilla studio (git history: src/components/ImageStudio.js).
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
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'react-hot-toast';

import { adoptCloudOutput } from '../lib/cloudAdopt.js';
import { localRow, muapiRow, needsBrowserKey, runImage } from '../lib/modelRunner.js';
import { describeFailure } from '../lib/describeFailure.js';
import { runFailureRemedy } from '../lib/failureRemedy.js';
// Still imported for the NON-generation calls — polling a resumed job and
// uploading a reference. Generation goes through runImage().
import { muapi } from '../lib/muapi.js';
import {
  t2iModels, getAspectRatiosForModel, getResolutionsForModel, getQualityFieldForModel,
  i2iModels, getAspectRatiosForI2IModel, getResolutionsForI2IModel, getQualityFieldForI2IModel,
  getMaxImagesForI2IModel,
} from '../lib/cloudCatalog.js';
import { localAI, isHostedLocalAI, isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { LOCAL_MODEL_CATALOG, getLocalModelById } from '../lib/localModels.js';
import { RENTED_CHANGED_EVENT, consumeRentedModeRequest, rentedMachinesState, servedByAnyMachine } from '../lib/rentedMachines.js';
import { LocalCatalogNotice } from './LocalCatalogNotice.jsx';
import { RentedSourceStatus } from './RentedSourceStatus.jsx';
import { LaneMemoryNotice } from './LaneMemoryNotice.jsx';
import { t, zh } from '../lib/i18n.js';
import {
  savePendingJob, removePendingJob, getPendingJobs, pendingJobsForTab,
} from '../lib/pendingJobs.js';
import { imageDownloadName } from '../lib/downloadNames.js';
import {
  isHivemindStudioEnabled, loadStudioGenerationHistory, referenceToLocalImageInput, saveStudioGenerationHistory,
} from '../lib/hivemindStudio.js';
import { getComposerSection, hydrateComposerState, updateComposerSection } from '../lib/composerState.js';
import { resolveMediaSrc } from '../lib/e2eMedia.js';
import { civitaiResourcesFromLoras } from '../lib/civitaiPost.js';
import { downloadMedia } from '../lib/downloadMedia.js';
import { referencesNeedingApproval, resolveCloudReferences } from '../lib/cloudReferenceUpload.js';
import { OWNERSHIP_HEADING, applyReferenceRoles, normalizeReferenceRoles, referenceLabelStyleFor } from '../lib/imageReferenceRoles.js';
import { startCivitaiDownload } from '../lib/civitaiDownloadStore.js';
import { huntLoraIds, isLoraEnabled, loraGenerationPayload, mergeLoraUpdates, replaceLoraInSelection, toggleLoraEnabled, toggleLoraHunt, toggleLoraSelection, updateLoraStrength } from '../lib/loraSelection.js';
import { localModelSupportsImageInput, localModelSupportsNegativePrompt, negativePromptNeedsGuidance } from '../lib/localImageModelFilter.js';
import { editBudgetForShortSide, editOutputDimensions } from '../lib/editResolution.js';
import { composeRegionalPrompt, hasActiveRegions } from '../lib/regionPrompt.js';
import { createGenerationContextStore } from '../lib/generationContext.js';
import { IMAGE_TAB_FIELDS, cloneTabValue, snapshotTabFields } from '../lib/studioTabs.js';
import { createStudioGenerationQueue } from '../lib/studioGenerationQueue.js';
// The chime is one app-wide setting: this studio only PLAYS it (and primes the
// audio context near the click). Its toggle lives beside Generate, in
// ui/CompletionPingToggle.jsx, which owns the subscription.
import { primeCompletionPing, playCompletionPing } from '../lib/completionPing.js';

import { loadStudioSetup, registerPromptInserter, registerStudioSetupLoader } from '../app/promptTarget.js';
import { useApiStatus } from '../app/statusStore.js';
import { promoteOutputToReference } from '../lib/outputToReference.js';
import {
  attachDroppedReferences,
  dragCarriesDroppable,
  droppedOutputPayload,
  referenceKindForOutput,
  referenceUploader,
} from '../lib/referenceDrop.js';
import { rememberGenerationSetup } from '../lib/generationSetupStore.js';
import { useMediaSrc } from '../hooks/hooks.js';
import {
  Button, Card, EmptyState, FailureCallout, ProgressBar, SectionLabel, Spinner,
} from '../ui/kit.jsx';
import { Menu } from '../ui/Menu.jsx';
import { StudioLayout } from '../ui/kit.jsx';

import { ImageSettingsPanel } from './image/ImageSettingsPanel.jsx';
import { ImageComposer } from './image/ImageComposer.jsx';
import { ConfirmModal } from '../ui/Modal.jsx';
import { AuthModal } from '../dialogs/AuthModal.jsx';

import { computeSmoothProgress, formatElapsed, estimateGenerationSeconds, recordGenerationSeconds } from '../lib/genProgress.js';
import {
  IMAGE_PREFERENCES_KEY, STYLE_PRESETS,
  applyStylePreset, imageTimingProfile, normalizeImagePreferences,
  referenceRolesNeedRewrite, restoredReferenceLimit, startFreshPatch,
} from './image/imagePrefs.js';
import { applyUgcFirstFrame, hasUgcFirstFrame, ugcVariantAt } from '../lib/ugcMode.js';
import { CameraMenu } from './image/CameraMenu.jsx';
import { applyCameraRig, hasCameraRig, normalizeCameraRig } from '../lib/cameraRig.js';
import { onComposerMenuRequest, takeComposerMenuRequest } from '../app/composerMenuRequest.js';
import { GalleryCard, ViewerModal } from './image/GalleryAndViewer.jsx';
import { CompareViewer } from './image/CompareViewer.jsx';
import { ExpandDialog } from './image/ExpandDialog.jsx';
import { MaskEditorDialog } from './image/MaskEditorDialog.jsx';
import { AngleVariationsDialog } from './image/AngleVariationsDialog.jsx';
import { SequenceEditDialog } from './image/SequenceEditDialog.jsx';
import { angleDialectForModel, angleLabel, editAnglePrompt } from '../lib/editAngles.js';

// Dialogs that are shut on arrival. Statically imported they were part of the
// landing payload of the app's DEFAULT page: the prompt helper alone drags in
// the model-source picker, the cast/persona tables and the H3 character notes,
// and the Civitai poster its whole resource mapper. Loaded at their open sites
// instead, so the cost is paid by whoever opens them.
const CivitaiDownloadDialogLazy = lazy(() => import('../dialogs/CivitaiDownloadDialog.jsx').then((m) => ({ default: m.CivitaiDownloadDialog })));
const CivitaiPostDialogLazy = lazy(() => import('../components/CivitaiPostDialog.jsx').then((m) => ({ default: m.CivitaiPostDialog })));
const PromptHelperDialogLazy = lazy(() => import('../dialogs/PromptHelperDialog.jsx').then((m) => ({ default: m.PromptHelperDialog })));

// While a dialog's chunk is in flight: the same scrim the modal itself lands on,
// so opening one never flashes the studio unlit and then relights it.
function DialogLoading() {
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-scrim" aria-busy="true">
      <Spinner size={22} className="text-ink2" />
    </div>
  );
}

// Re-export the pure normalizer — tests and other callers import it from here.
export { normalizeImagePreferences };

// Cloud catalog capability flags: an API model "supports" references when it
// has an image-to-image configuration; models only in the editing catalog
// require one. Models are never hidden based on attached references.
const apiModelSupportsImage = (id) => i2iModels.some((m) => m.id === id);
const apiModelRequiresImage = (id) => apiModelSupportsImage(id) && !t2iModels.some((m) => m.id === id);

// Short-side resolutions offered for local workflows. 0 = the workflow's own
// default (1024 for the Krea/SDXL-class graphs).
const LOCAL_BASE_SIZES = [0, 1280, 1152, 1024, 896, 768, 640, 512];

// Display-only mirror of hosted-server.js arToDimensions() — keep the two in
// step. Explicit width/height always win; otherwise the aspect ratio is scaled
// off the chosen short side.
function resolveLocalDimensions({ aspectRatio, baseSize, customWidth, customHeight, model }) {
  if (customWidth && customHeight) return { width: customWidth, height: customHeight, custom: true };
  const requested = Number(baseSize);
  const base = Number.isFinite(requested) && requested > 0
    ? Math.round(Math.max(256, Math.min(2048, requested)) / 64) * 64
    : Number(model?.defaultWidth) || 1024;
  const long = Math.round(base * 16 / 9 / 64) * 64;
  const wide = Math.round(base * 4 / 3 / 64) * 64;
  const map = {
    '1:1': [base, base],
    '16:9': [long, base],
    '9:16': [base, long],
    '4:3': [wide, base],
    '3:4': [base, wide],
  };
  const [width, height] = map[aspectRatio] || [base, base];
  return { width, height, custom: false };
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Unable to read reference image'));
    reader.readAsDataURL(file);
  });
}

// One mutable state bag per mount. Studio tabs are just repeated mounts (see
// src/lib/studioTabs.js), so `boot` decides where this tab's starting state comes
// from: 'persisted' (the original tab), 'fresh' (a new tab — catalog defaults, no
// prompt, no LoRAs) or 'clone' (a duplicate, seeded from another tab's snapshot).
function createEngine({ boot = 'persisted', snapshot = null } = {}) {
  // Reads persisted settings from the warm encrypted composer cache first (tab
  // switches remount this component; the cache survives in-module), then falls back
  // to the localStorage copy of the NON-SENSITIVE settings — which is what makes the
  // model + params restore synchronously on a fresh reload, before the vault cache
  // has hydrated. Prompt text and the negative prompt stay in the encrypted cache.
  // A 'fresh'/'clone' tab skips this entirely — it must not inherit saved tuning.
  let persistedImagePreferences = null;
  if (boot === 'persisted') {
    try {
      persistedImagePreferences = normalizeImagePreferences(
        getComposerSection('image').preferences
          || JSON.parse(localStorage.getItem(IMAGE_PREFERENCES_KEY) || 'null'),
      );
    } catch { /* corrupted prefs — boot with defaults */ }
  }

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
  //
  // The static catalog is the DESKTOP build's inventory. A hosted bridge serves
  // registry workflows and rejects those ids with "Unknown local image
  // workflow", so seeding a hosted picker from it offered models that could not
  // run anywhere — and left Generate enabled while the engine was still down.
  // Hosted studios wait for discovery instead, and say why while they wait.
  const localImageModels = isHostedLocalAI() ? [] : LOCAL_MODEL_CATALOG.filter((m) => m.type !== 'video');
  // No saved preference yet: a hosted studio with local models boots on the
  // Local source (same default as the Video studio) instead of opening the cloud
  // key modal on the first Generate. A saved choice always wins.
  const useLocalModel = persistedImagePreferences
    ? Boolean(persistedImagePreferences.useLocalModel && isLocalAIAvailable())
    : Boolean(isHivemindStudioEnabled() && isLocalAIAvailable());
  const selectedLocalModel = persistedImagePreferences?.localModelId || localImageModels[0]?.id || null;
  const bootLocalModel = localImageModels.find((m) => m.id === selectedLocalModel) || getLocalModelById(selectedLocalModel);
  const localRuntimeMode = persistedImagePreferences?.localRuntimeMode || bootLocalModel?.defaultRuntimeMode || 'one-off';

  const seed = persistedImagePreferences?.seed ?? -1;

  const loraSelectionsByModel = new Map();
  Object.entries(persistedImagePreferences?.loraSelections || {}).forEach(([model, selections]) => {
    loraSelectionsByModel.set(model, selections);
  });

  const engine = {
    bootSource: boot,
    persistedImagePreferences,
    selectedModel,
    selectedModelName: defaultModel.name,
    imageMode: false,
    selectedAr,
    selectedResolution,
    uploadedImageUrls: [],
    // What each attached reference SUPPLIES. Not persisted on purpose: the
    // ownership block these write into the prompt is the durable artifact, and
    // it travels with a saved prompt — a second copy in preferences could only
    // ever disagree with it.
    referenceRoles: [],
    // UGC deal counters (which cast / room was dealt last) — session-only.
    ugcVariantIndex: null,
    ugcRoomIndex: null,
    // The camera rig (body / lens / focal / aperture) the Camera menu writes as
    // one prose clause. Persisted; whether it is ARMED is read from the prompt.
    cameraRig: normalizeCameraRig(persistedImagePreferences?.cameraRig),
    cameraMenuOpen: false,
    localImageModels,
    // Why the local menu looks the way it does: 'discovering' | 'ready' |
    // 'empty' | 'unreachable'. Read by the Model section and by the Generate
    // button, so a menu that cannot run anything never sits under a live press.
    localCatalogStatus: isLocalAIAvailable() ? 'discovering' : 'unreachable',
    useLocalModel,
    // Rented source mode: local mechanically (lane rules route by model
    // server-side); filters the menu to models an attached machine serves.
    rentedOnly: Boolean(persistedImagePreferences?.rentedOnly && useLocalModel),
    // This tab's "Run on" pin: the rented machine (rental id) every generation
    // it sends in Rented mode carries as run_on. Restored with the tab's other
    // settings; '' follows the Machines default.
    rentedMachineId: persistedImagePreferences?.rentedMachineId || '',
    rentedMachines: [],
    rentedPending: [],
    rentedProvisioning: [],
    rentedIdle: [],
    rentedBroken: [],
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
    // UI-only: keeps the Custom aspect tile (and its W/H inputs) open while the
    // user is mid-edit with one of the fields cleared. Dims persisting is what
    // makes custom stick across reloads.
    customArOpen: Boolean(persistedImagePreferences?.customWidth && persistedImagePreferences?.customHeight),
    // Sampler/scheduler override + short-side resolution for local workflows
    // that expose them. Empty/0 = the workflow's own step-appropriate choice.
    sampler: persistedImagePreferences?.sampler || '',
    scheduler: persistedImagePreferences?.scheduler || '',
    baseSize: persistedImagePreferences?.baseSize || 0,
    // Couple mode — OFF by default; character text is session-only, never persisted.
    coupleMode: Boolean(persistedImagePreferences?.coupleMode),
    coupleDirection: persistedImagePreferences?.coupleDirection === 'vertical' ? 'vertical' : 'horizontal',
    coupleSplit: persistedImagePreferences?.coupleSplit ?? 50,
    couplePair: ['girls', 'mixed', 'boys'].includes(persistedImagePreferences?.couplePair)
      ? persistedImagePreferences.couplePair : 'girls',
    coupleShared: '',
    coupleA: '',
    coupleB: '',
    // Region boxes — OFF by default. Only the toggle persists: the box
    // descriptions are prompt text, so they stay session-only like couple mode's
    // character fields.
    regionMode: Boolean(persistedImagePreferences?.regionMode),
    regions: [],
    // Character sheet — OFF by default; Klein reference-edit models only. The
    // gateway builds the per-view prompts, so the composer prompt is optional.
    characterSheetMode: Boolean(persistedImagePreferences?.characterSheetMode),
    characterSheetPreset: ['turnaround', 'standard', 'full'].includes(persistedImagePreferences?.characterSheetPreset)
      ? persistedImagePreferences.characterSheetPreset : 'turnaround',
    availableLoras: [],
    loraCatalogStatus: 'idle',
    loraCatalogMessage: 'LoRAs load automatically for the selected local workflow.',
    loraBaseLabel: 'Choose a local workflow to see compatible LoRAs.',
    // Base families of the current catalog (from listLoras) — scopes the saved
    // LoRA groups menu to groups made for this model.
    loraBaseModels: [],
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
    // A file dropped on the composer is uploading into a reference slot; the
    // composer's own overlay reports it.
    composerAttaching: false,
    maxImages: useLocalModel
      ? (bootLocalModel?.maxReferenceImages || 1)
      : (apiModelSupportsImage(selectedModel) ? getMaxImagesForI2IModel(selectedModel) : 1),
    generating: false,
    // The run in flight: { jobId, cancelled, unsub }. Cancel flips `cancelled`
    // and whatever the bridge still resolves afterwards is ignored — no history
    // entry, no viewer, no chime for a run the user gave up on.
    activeGeneration: null,
    // Last failure, kept on the canvas (copyable) until dismissed or the next run.
    generateError: '',
    // The same failure, read: { title, detail, remedy } from describeFailure.
    // The callout carries all three, which is why nothing toasts beside it.
    generateFailure: null,
    localProgress: { active: false, pct: 0, label: '' },
    // Smooth, time-based ETA bar. Image generation exposes no real per-step
    // progress on any path, so the bar is driven by elapsed / expected (from the
    // client-side per-signature duration store), nudged up by the coarse status.
    progressDisplay: 0,
    progressReal: 0,
    progressEstimateSec: null,
    progressSignature: '',
    // Work units (steps x megapixels) of the run in flight, captured at submit
    // so the recorded duration lands in the right bucket.
    progressWorkUnits: 1,
    generationStartedAt: 0,
    generationTimer: null,
    viewerUrl: null,
    // Upscaled entry whose before/after compare overlay is open (null = closed).
    compareEntry: null,
    civitaiPost: null,
    // Entry the Expand (outpaint) dialog is open for, and its in-flight state.
    expandEntry: null,
    expandBusy: false,
    // Entry the Edit-area (inpaint) mask editor is open for, and its state.
    inpaintEntry: null,
    inpaintBusy: false,
    // Angle-variation and sequence-edit dialogs (sequential client-side runs;
    // the Stop flag is honored between shots, never mid-generation).
    angleEntry: null,
    angleBusy: false,
    angleStop: false,
    angleProgress: '',
    sequenceEntry: null,
    sequenceBusy: false,
    sequenceStop: false,
    sequenceProgress: '',
    sendingToVideo: false,
    authOpen: false,
    // Sending a locally-held reference to a cloud model uploads a decrypted copy off
    // this Mac, so it waits on an explicit confirm. Approvals and the resulting CDN
    // URLs are session-only (never persisted): a fresh studio asks again.
    cloudRefConfirm: null,
    cloudRefApproved: new Set(),
    cloudRefUploads: new Map(),
    civitaiOpen: false,
    localPromptHelperOpen: false,
    resumeRemaining: 0,
    promptHelper: { open: false, busy: false, title: '', result: '', status: '', negative: '', ready: false },
    enhancerOpen: false,
    enhanceBase: '',
    enhanceTags: new Set(),
    persistTimer: null,
  };

  // A duplicate overlays the source tab's configuration on top of the defaults.
  // The snapshot was already deep-copied at capture; copying again keeps a tab
  // duplicated twice from sharing Maps/arrays with its sibling.
  if (boot === 'clone' && snapshot) Object.assign(engine, cloneTabValue(snapshot));
  return engine;
}

export function ImageStudio({
  active = true, tabActive = true, seed = null, apiRef = null, studioLane = '',
  tabId = 0, primary = null, openTabIds = null,
} = {}) {
  const engineRef = useRef(null);
  // The seed is read once, at mount — StudioTabs clears it afterwards, so every
  // later "am I the original tab?" question reads the captured value.
  const seedRef = useRef(seed);
  if (!engineRef.current) engineRef.current = createEngine(seedRef.current || undefined);
  const s = engineRef.current;
  const generationQueueRef = useRef(null);
  if (!generationQueueRef.current) generationQueueRef.current = createStudioGenerationQueue();
  const [, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);
  // One shared verdict on whether the studio is up, rather than each lane
  // discovering it separately when a press fails.
  const apiStatus = useApiStatus();

  // The primary tab adopts the composer draft and any pending generation no open
  // tab owns; new and duplicated tabs start clean. StudioTabs decides which tab
  // that is — a reload restores every tab with a null seed, so the old "no seed =
  // original tab" test would have made all of them primary at once. The fallback
  // keeps a standalone mount (no StudioTabs) behaving as it always did.
  const isPrimaryTab = primary == null ? !seedRef.current : Boolean(primary);
  // This tab's own id, captured at mount: it stamps the generations this tab
  // starts, which is how the tab reclaims them after a reload.
  const tabIdRef = useRef(tabId);
  const openTabIdsRef = useRef(openTabIds);
  openTabIdsRef.current = openTabIds;
  // Front tab of this studio: owns preference persistence and one-shot handoffs.
  const tabActiveRef = useRef(tabActive);
  tabActiveRef.current = tabActive;

  const rootRef = useRef(null);
  const promptRef = useRef(null);
  const authRetryRef = useRef(null);
  const mountedOnceRef = useRef(false);
  const mountedRef = useRef(true);

  /* ---------------- derived helpers (verbatim logic) ---------------- */

  const localModelById = (id) => s.localImageModels.find((m) => m.id === id) || getLocalModelById(id);
  // Every local model is always listed; attaching an image never hides
  // text-to-image models — unsupported models simply ignore references.
  const compatibleLocalModels = () => ((s.rentedOnly && s.rentedMachines?.length)
    ? s.localImageModels.filter((m) => servedByAnyMachine(s.rentedMachines, m))
    : s.localImageModels);

  // The tab's "Run on" pin rides every generation this tab sends while the
  // source is Rented; the gateway tries that machine ahead of its default order.
  const runOn = () => (s.rentedOnly && s.rentedMachineId ? { run_on: s.rentedMachineId } : {});
  // Written by the Rented panel's picker ('' = follow the Machines default).
  const pinMachine = (rentalId) => {
    const next = rentalId || '';
    if ((s.rentedMachineId || '') === next) return;
    s.rentedMachineId = next;
    persistImagePreferences();
    bump();
  };

  // With nothing chosen, the pick is the workflow the registry flags `featured`,
  // and otherwise the cheapest one to run. Index 0 used to decide it, which is
  // whatever order the catalog happened to be written in.
  const preferredLocalModel = (list) => list.find((model) => model.featured)
    || [...list].sort((a, b) => (
      (Number.isFinite(Number(a.defaultSteps)) ? Number(a.defaultSteps) : Number.MAX_SAFE_INTEGER)
      - (Number.isFinite(Number(b.defaultSteps)) ? Number(b.defaultSteps) : Number.MAX_SAFE_INTEGER)
    ))[0]
    || null;

  const ensureCompatibleLocalModel = () => {
    const compatible = compatibleLocalModels();
    const selected = compatible.find((model) => model.id === s.selectedLocalModel) || preferredLocalModel(compatible);
    s.selectedLocalModel = selected?.id || null;
    return selected;
  };

  /**
   * Ask the bridge what this machine can run, and record WHY when the answer is
   * nothing. Re-runnable: the mount runs it, the hub's refresh broadcast runs
   * it, and the Model section's "Check again" runs it.
   */
  const discoverLocalCatalog = async () => {
    try {
      await runLocalCatalogDiscovery();
    } catch (error) {
      // Applying a discovered model's settings must never leave the studio
      // stuck on "discovering" with no way back.
      console.warn('[Local] Unable to discover runtime image workflows:', error);
      s.localCatalogStatus = 'unreachable';
      bump();
    }
  };

  const runLocalCatalogDiscovery = async () => {
    s.localCatalogStatus = 'discovering';
    bump();
    const { models, status } = await localAI.listModels();
    s.localCatalogStatus = status;
    const discovered = models.filter((model) => (
      model?.type !== 'video' && model?.state !== 'not-downloaded' && model?.ready !== false
    ));
    if (discovered.length === 0) {
      // A hosted bridge that answered with nothing is the truth about this
      // machine; keeping the desktop catalog here is what used to leave a menu
      // of unrunnable ids under a live Generate button.
      if (isHostedLocalAI()) s.localImageModels = [];
      bump();
      return;
    }
    s.localImageModels = discovered;
    const localModel = ensureCompatibleLocalModel();
    if (!localModel) { bump(); return; }
    // A duplicated tab arrives with a fully resolved configuration. Re-applying
    // the boot defaults below would quietly reset its aspect ratio and tuning to
    // the model's, which is exactly what "duplicate" must not do. It does need
    // one refresh though: its LoRA panel loaded against the STATIC catalog, so
    // its header names the stock workflow until the discovered one lands.
    if (s.bootSource === 'clone') {
      if (s.loraOpen) void loadLorasForCurrentModel();
      bump();
      return;
    }
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
  };
  const currentModelSupportsImage = () => {
    if (!s.useLocalModel) return apiModelSupportsImage(s.selectedModel);
    const model = localModelById(s.selectedLocalModel);
    // Fail OPEN while the runtime catalog is still loading — an unknown
    // model must not lock the upload button.
    return model ? localModelSupportsImageInput(model) : true;
  };

  // Edit workflows (requires.image) size their canvas from the reference on the
  // server: the aspect is the reference's, and the requested width/height only
  // set the pixel budget. Both the Format panel and the payload key off this.
  const referenceDrivenEdit = () => s.useLocalModel
    && s.uploadedImageUrls.length > 0
    && Boolean(localModelById(s.selectedLocalModel)?.requires?.image);

  // Whether the negative prompt reaches the sampler at all. Local workflows declare
  // it in `accepts`; the Krea 2 identity graph, for one, hardcodes an empty negative
  // encoder, so showing the field there would be a dead input.
  const currentModelSupportsNegativePrompt = () => {
    if (!s.useLocalModel) return true;
    const model = localModelById(s.selectedLocalModel);
    return model ? localModelSupportsNegativePrompt(model) : true;
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
  // Regions need no node and no capability flag — they only rewrite the prompt.
  // Couple mode wins when both are on, so this asks the same question generate() does.
  const regionsActive = () => s.regionMode && !coupleActive() && hasActiveRegions(s.regions);
  // The frame the boxes are drawn on should match what will be generated.
  const selectedArNumber = () => {
    const [w, h] = String(s.selectedAr || '1:1').split(':').map(Number);
    return w > 0 && h > 0 ? w / h : 1;
  };

  const currentPromptHelper = () => s.useLocalModel ? localModelById(s.selectedLocalModel)?.promptHelper : null;

  const currentLoraModel = () => s.useLocalModel ? localModelById(s.selectedLocalModel) : null;
  const currentLoraSelection = () => s.loraSelectionsByModel.get(currentLoraModel()?.id) || [];

  // Strength Hunt rides the krea2 identity lane only (the gateway's sweep
  // runner is built on that graph family); other backends hide the toggle.
  const strengthHuntCapable = () =>
    s.useLocalModel && localModelById(s.selectedLocalModel)?.backend === 'comfy-krea2-turbo-identity-edit';
  const armedHuntIds = () => (strengthHuntCapable() ? huntLoraIds(currentLoraSelection()) : []);

  // Character Sheet rides the Klein reference-edit lane only (the gateway's
  // multi-view runner drives the native Klein engine); other models hide it.
  const characterSheetCapable = () => {
    if (!s.useLocalModel) return false;
    const model = localModelById(s.selectedLocalModel);
    return Boolean(model?.requires?.image)
      && (model?.family === 'flux-2-klein' || model?.backend === 'comfy-bigloves-klein3-edit');
  };
  const characterSheetActive = () => s.characterSheetMode && characterSheetCapable();
  const CHARACTER_SHEET_PRESETS = [
    { value: 'turnaround', label: 'Turnaround (4)' },
    { value: 'standard', label: 'Standard (6)' },
    { value: 'full', label: 'Full (9)' },
  ];

  /* ---------------- generation progress (smooth time-based ETA) ---------------- */

  // Seconds per work unit before anything has been measured. Local work units
  // are steps x megapixels, so ~1.2 puts a stock 25-step 1024^2 run near 30s;
  // cloud runs expose no steps or dimensions, so they carry one unit of work
  // and the whole 30s estimate sits in the rate.
  const DEFAULT_LOCAL_IMAGE_RATE_SEC = 1.2;
  const DEFAULT_API_IMAGE_ESTIMATE_SEC = 30;
  // Opaque key over the params that change the COST PROFILE (model, adapters,
  // graph shape) — never prompt text — so similar runs share an elapsed/expected
  // estimate. Steps and dimensions deliberately stay OUT of the key: they belong
  // in the work units below, which scale a measured run to an unmeasured one.
  // Cost profile (opaque key) + work units (steps x megapixels) for this run —
  // see imageTimingProfile. Only active LoRAs change the loaded adapter set, so
  // only they change timing.
  const currentTimingProfile = () => {
    const model = localModelById(s.selectedLocalModel);
    return imageTimingProfile({
      settings: s,
      model,
      loraCount: (currentLoraSelection() || []).filter(isLoraEnabled).length,
      dimensions: s.useLocalModel ? resolveLocalDimensions({
        aspectRatio: s.selectedAr,
        baseSize: s.baseSize,
        customWidth: s.customWidth,
        customHeight: s.customHeight,
        model,
      }) : null,
    });
  };
  const startImageProgress = () => {
    // Unlock audio while we are still close to the Generate click, so the
    // completion chime is allowed to play when the result lands.
    void primeCompletionPing();
    if (s.generationTimer) clearInterval(s.generationTimer);
    const profile = currentTimingProfile();
    s.progressSignature = profile.key;
    s.progressWorkUnits = profile.work;
    s.generationStartedAt = Date.now();
    s.progressDisplay = 0;
    s.progressReal = 0;
    s.progressEstimateSec = estimateGenerationSeconds(
      s.progressSignature,
      s.progressWorkUnits,
      s.useLocalModel ? DEFAULT_LOCAL_IMAGE_RATE_SEC : DEFAULT_API_IMAGE_ESTIMATE_SEC,
    );
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
      recordGenerationSeconds(
        s.progressSignature,
        s.progressWorkUnits,
        (Date.now() - s.generationStartedAt) / 1000,
      );
    }
    s.progressDisplay = success ? 1 : 0;
    if (success) void playCompletionPing();
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
      sampler: s.sampler,
      scheduler: s.scheduler,
      baseSize: s.baseSize,
      coupleMode: s.coupleMode,
      coupleDirection: s.coupleDirection,
      coupleSplit: s.coupleSplit,
      couplePair: s.couplePair,
      characterSheetMode: s.characterSheetMode,
      characterSheetPreset: s.characterSheetPreset,
      regionMode: s.regionMode,
    });
  };

  // The live, normalized preference object for THIS tab. Split out of the persist
  // path because duplicating a tab needs the same value without writing it.
  const currentImagePreferences = () => {
    snapshotCurrentModelSettings();
    return normalizeImagePreferences({
      modelId: s.selectedModel,
      imageMode: s.imageMode,
      useLocalModel: s.useLocalModel,
      rentedOnly: s.rentedOnly,
      rentedMachineId: s.rentedMachineId,
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
      sampler: s.sampler,
      scheduler: s.scheduler,
      baseSize: s.baseSize,
      coupleMode: s.coupleMode,
      coupleDirection: s.coupleDirection,
      coupleSplit: s.coupleSplit,
      couplePair: s.couplePair,
      characterSheetMode: s.characterSheetMode,
      characterSheetPreset: s.characterSheetPreset,
      regionMode: s.regionMode,
      cameraRig: s.cameraRig,
      modelSettings: Object.fromEntries(s.modelSettingsById),
      loraSelections: Object.fromEntries(s.loraSelectionsByModel),
    });
  };

  const persistImagePreferences = () => {
    const preferences = currentImagePreferences();
    if (!preferences) return;
    // Only the studio's FRONT tab owns the saved configuration. Background tabs are
    // independent working copies — letting them write would mean the last tab that
    // happened to fire an effect decided what a reload restores.
    if (!tabActiveRef.current) return;
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
  // Set when a handoff was claimed before any machine list had arrived, so the
  // model could not be re-picked yet; the next sync with machines finishes it.
  const reconcileRentedModelRef = useRef(false);

  // "Use in Image Studio" is a one-shot handoff from the Machines view. Only the
  // front tab may claim it, or whichever background tab looked first would
  // swallow it. Claimed the moment it can be rather than inside the poll
  // callback, and through setSource — the same function the source picker calls,
  // which is what re-picks a model the machine can actually serve. Setting the
  // two flags raw skipped all of that (2026-08-24).
  const claimRentedHandoff = () => {
    if (!tabActiveRef.current || !consumeRentedModeRequest('image')) return;
    reconcileRentedModelRef.current = !s.rentedMachines?.length;
    setSource(true, true);
  };

  // Rented source mode: track attached machines while mounted (the studio
  // component stays mounted across navigations, so a one-shot fetch would
  // freeze the boot-time answer — usually "none", vault still locked). A
  // 30s poll plus the Machines view's change event keep it current, and the
  // one-shot handoff opens the studio in Rented mode after "Use in Studio".
  useEffect(() => {
    let alive = true;
    let timer = null;
    const schedule = (pending) => {
      // Watch a provisioning machine closely so "Ready" lands on its own.
      const wanted = pending ? 8000 : 30000;
      if (timer?.every !== wanted) {
        if (timer) clearInterval(timer.id);
        // A hidden window is a window nobody is reading. Skipping the beat
        // matters more here than for most polls: /api/gpu-rentals lists every
        // configured marketplace and probes each box, so a backgrounded studio
        // was doing that every 30s (every 8s while a box provisions) forever.
        // The wake handler below asks the moment the window comes back, so
        // nothing is stale by the time it is on screen.
        timer = { every: wanted, id: setInterval(() => { if (!document.hidden) sync(false); }, wanted) };
      }
    };
    // Rented stays selected even with no machine (the panel then offers to
    // rent one) — bouncing the user back to Local would hide the feature.
    const sync = (force) => rentedMachinesState({ force }).then((state) => {
      if (!alive) return;
      s.rentedMachines = state.live;
      s.rentedPending = state.pending;
      // Split states so the panel can name what is actually wrong: only a
      // provisioning box is "coming online".
      s.rentedProvisioning = state.provisioning;
      s.rentedIdle = state.idle;
      s.rentedBroken = state.broken;
      schedule(state.pending.length);
      // A handoff claimed before any machine list arrived could not re-pick a
      // model then. Finish it now there is one to pick from.
      if (reconcileRentedModelRef.current && s.rentedMachines.length) {
        reconcileRentedModelRef.current = false;
        const lm = ensureCompatibleLocalModel();
        if (lm) applyStoredModelSettings(`local:${lm.id}`, lm);
        void loadLorasForCurrentModel();
      }
      bump();
    }).catch(() => {
      if (!alive) return;
      // A read that fails must not stop the polling. The interval used to be
      // created inside the resolve path, so a single rejected fetch — vault
      // locked, stack mid-restart — left this studio never asking again.
      schedule(false);
      bump();
    });
    claimRentedHandoff();
    sync(false);
    // Claim BEFORE syncing: the Machines view announces this immediately after
    // setting the handoff, and waiting for the fetch is what made the switch
    // arrive late.
    const onChanged = () => { claimRentedHandoff(); sync(true); };
    const onVisible = () => { if (!document.hidden) sync(false); };
    window.addEventListener(RENTED_CHANGED_EVENT, onChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      if (timer) clearInterval(timer.id);
      window.removeEventListener(RENTED_CHANGED_EVENT, onChanged);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A tab that becomes the front one inherits a handoff nobody could claim
  // while it was in the background.
  useEffect(() => {
    if (tabActive) claimRentedHandoff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabActive]);

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
    s.sampler = stored.sampler || '';
    s.scheduler = stored.scheduler || '';
    s.baseSize = stored.baseSize || 0;
    s.coupleMode = Boolean(stored.coupleMode);
    s.coupleDirection = stored.coupleDirection === 'vertical' ? 'vertical' : 'horizontal';
    s.coupleSplit = stored.coupleSplit ?? s.coupleSplit;
    s.couplePair = stored.couplePair || s.couplePair;
    s.characterSheetMode = Boolean(stored.characterSheetMode);
    s.characterSheetPreset = ['turnaround', 'standard', 'full'].includes(stored.characterSheetPreset)
      ? stored.characterSheetPreset : s.characterSheetPreset;
    s.regionMode = Boolean(stored.regionMode);
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
    s.loraBaseModels = [];
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
      s.loraBaseModels = bases;
      s.loraBaseLabel = data?.supported === false
        ? `${model.name} does not expose an add-on LoRA path.`
        : `${model.name} · ${bases.join(', ') || 'compatible local adapters'}`;
      s.loraCatalogStatus = data?.supported === false ? 'unsupported' : 'ready';
      s.loraCatalogMessage = data?.supported === false
        ? 'This workflow does not support add-on LoRAs.'
        : s.availableLoras.length
          ? `${s.availableLoras.length} compatible LoRA${s.availableLoras.length === 1 ? '' : 's'} installed. Tap a card to load it.`
          : 'No compatible LoRAs are installed for this workflow.';
      void refreshLoraUpdates(request, bases);
    } catch (error) {
      if (request !== s.loraCatalogRequest) return;
      s.loraCatalogStatus = 'error';
      s.loraCatalogMessage = `Unable to load LoRAs: ${error.message}`;
    }
    bump();
  };

  // Update availability comes from Civitai, so it lands after the catalog rather
  // than holding it up. Same race token: a stale check never annotates a new list.
  const refreshLoraUpdates = async (request, baseModels) => {
    const updates = await localAI.listLoraUpdates(baseModels);
    if (request !== s.loraCatalogRequest || !Object.keys(updates).length) return;
    s.availableLoras = mergeLoraUpdates(s.availableLoras, updates);
    bump();
  };

  // Shared completion path for every Civitai download that lands a LoRA: refresh
  // the catalog, then carry the selection over when a file was replaced.
  const finishLoraDownload = async (job, context) => {
    await loadLorasForCurrentModel();
    const replacedId = String(context?.replaces || '');
    const newId = String(job?.result?.filename || '');
    if (!replacedId || !newId) return;
    const replacement = s.availableLoras.find((lora) => lora.id === newId) || { id: newId, name: newId };
    setCurrentLoraSelection(replaceLoraInSelection(currentLoraSelection(), replacedId, replacement));
    bump();
  };

  const startLoraUpdate = (lora, update, { replace }) => {
    if (!update?.url) return;
    void startCivitaiDownload(localAI, update.url, {
      replaces: replace ? lora.id : '',
      onComplete: finishLoraDownload,
      onStarted: () => bump(),
    });
  };

  /* ---------------- references ---------------- */

  // Composer drafts (prompt, negative, reference selection) are a single
  // owner-vault section, so only the front tab writes to it — a background tab
  // would otherwise overwrite the draft the next reload restores.
  const updateComposerDraft = (patch) => {
    if (tabActiveRef.current) updateComposerSection('image', patch);
  };

  // The reference-ownership block in the prompt names pictures BY POSITION, so
  // it is only true for the count it was written for. Re-written (or stripped)
  // whenever the count changes; a prompt that never carried one is left alone.
  const syncRolesToReferenceCount = () => {
    if (!referenceRolesNeedRewrite(s.prompt, s.referenceRoles, OWNERSHIP_HEADING)) return;
    applyRoles(normalizeReferenceRoles(s.referenceRoles, s.uploadedImageUrls.length));
  };

  // onChange add/update path — mirrors the old picker onSelect side effects.
  // Attaching never touches the aspect ratio: the user's pick stands, and an
  // edit workflow that takes its aspect from the reference hides the picker
  // (referenceDrivenEdit) rather than overwriting the choice. It also never
  // reloads the LoRA catalog — the model did not change, so the list is the same.
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
      if (localModel) s.maxImages = localModel.maxReferenceImages || 1;
      updatePromptHelperVisibility();
    }
    syncRolesToReferenceCount();
    persistImagePreferences();
    updateComposerDraft({ references: s.uploadedImageUrls.slice() });
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
      ensureCompatibleLocalModel();
      updatePromptHelperVisibility();
    }
    // No pictures, no roles: the block comes out of the prompt.
    syncRolesToReferenceCount();
    persistImagePreferences();
    updateComposerDraft({ references: [] });
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
    updateComposerDraft({ prompt: value });
    bump();
  };

  // Reference roles -> the ownership block at the end of the prompt. Idempotent:
  // applyReferenceRoles strips whatever block is already there before writing
  // the new one, so tweaking a role five times leaves one block, not five.
  const applyRoles = (roles) => {
    s.referenceRoles = roles;
    setPromptValue(applyReferenceRoles(
      s.prompt,
      roles,
      s.uploadedImageUrls.length,
      { labelStyle: referenceLabelStyleFor(s.useLocalModel ? s.selectedLocalModel : s.selectedModel) },
    ));
  };

  // Same source the aspect picker renders from — local models carry their own
  // list, API models get theirs from the catalog.
  const ugcVerticalAvailable = () => (s.useLocalModel
    ? (localModelById(s.selectedLocalModel)?.aspectRatios || [])
    : getCurrentAspectRatios(s.selectedModel)).includes('9:16');

  // UGC mode — the first-frame half of the two-prompt workflow: the realism
  // stack (phone front camera, named light source, pores and under-eye shadows,
  // one imperfect detail) written into the prompt as an idempotent block, so
  // dealing a new cast replaces it rather than stacking. Only the deal number
  // lives in state; the text is derived from it. Passing null clears.
  const applyUgc = (index, roomIndex = null) => {
    const variant = Number.isInteger(index) ? ugcVariantAt(index, roomIndex) : null;
    const prompt = applyUgcFirstFrame(s.prompt, variant);
    s.prompt = prompt;
    // Kept when clearing, so turning UGC back on deals the NEXT cast instead of
    // restarting the cycle at the one you just used. The room is dealt on its
    // own number so the same face can be shot in a different place.
    if (variant) {
      s.ugcVariantIndex = variant.index;
      s.ugcRoomIndex = variant.roomIndex;
    }
    // A first frame for a phone-selfie clip is portrait. Said out loud in the menu.
    if (variant && ugcVerticalAvailable()) s.selectedAr = '9:16';
    updateComposerDraft({ prompt });
    persistImagePreferences();
    bump();
    promptRef.current?.focus();
  };

  // The camera rig — what the Cinema studio used to be. One prose clause at the
  // end of the prompt (body, lens, focal length, depth of field), model-agnostic
  // and idempotent: applyCameraRig strips whatever clause is already there
  // before writing the new one, so re-arming replaces rather than stacks.
  const applyCamera = (rig) => {
    const prompt = applyCameraRig(s.prompt, rig ? normalizeCameraRig(rig) : null);
    if (rig) s.cameraRig = normalizeCameraRig(rig);
    s.prompt = prompt;
    updateComposerDraft({ prompt });
    persistImagePreferences();
    bump();
  };

  // Moving a control remembers the rig either way; while the clause is in the
  // prompt it is rewritten in place, so the preview and the prompt never drift.
  const setCameraRig = (rig) => {
    if (hasCameraRig(s.prompt)) { applyCamera(rig); return; }
    s.cameraRig = normalizeCameraRig(rig);
    persistImagePreferences();
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

  const setSource = (nextLocal, nextRented = false) => {
    if (nextLocal === s.useLocalModel && nextRented === s.rentedOnly) return;
    snapshotCurrentModelSettings();
    s.rentedOnly = Boolean(nextLocal && nextRented);
    s.useLocalModel = nextLocal;
    // Entering rented with a model the machine cannot serve leaves a dead
    // selection; ensureCompatibleLocalModel below re-picks from the filtered
    // list, which compatibleLocalModels() narrows to served models.
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
    // Local sampling choices and the short-side resolution — without them a
    // restored run came back on Auto sampler at the workflow default.
    sampler: s.sampler,
    scheduler: s.scheduler,
    baseSize: s.baseSize,
    // Couple mode, whole: a couple generation must not restore as a plain one.
    // The character text is session-only everywhere else, but this context is
    // sealed to the owner vault — the one place it is allowed to be written.
    coupleMode: s.coupleMode,
    coupleDirection: s.coupleDirection,
    coupleSplit: s.coupleSplit,
    couplePair: s.couplePair,
    coupleShared: s.coupleShared,
    coupleA: s.coupleA,
    coupleB: s.coupleB,
    characterSheetMode: s.characterSheetMode,
    characterSheetPreset: s.characterSheetPreset,
    // The boxes, not just the sentences they produced — restoring a generation
    // should give back an editable layout. This context is sealed to the owner
    // vault, which is the one place region text is allowed to be written down.
    regionMode: s.regionMode,
    regions: s.regions.map((region) => ({ ...region })),
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
    // `??` on purpose: a context captured before these fields existed leaves the
    // current values alone; a new one restores them exactly (false included).
    s.sampler = context.sampler ?? s.sampler;
    s.scheduler = context.scheduler ?? s.scheduler;
    s.baseSize = context.baseSize ?? s.baseSize;
    s.coupleMode = context.coupleMode ?? s.coupleMode;
    s.coupleDirection = context.coupleDirection === 'vertical' ? 'vertical'
      : context.coupleDirection === 'horizontal' ? 'horizontal' : s.coupleDirection;
    s.coupleSplit = context.coupleSplit ?? s.coupleSplit;
    s.couplePair = ['girls', 'mixed', 'boys'].includes(context.couplePair) ? context.couplePair : s.couplePair;
    s.coupleShared = context.coupleShared ?? s.coupleShared;
    s.coupleA = context.coupleA ?? s.coupleA;
    s.coupleB = context.coupleB ?? s.coupleB;
    s.characterSheetMode = Boolean(context.characterSheetMode);
    s.characterSheetPreset = ['turnaround', 'standard', 'full'].includes(context.characterSheetPreset)
      ? context.characterSheetPreset : s.characterSheetPreset;

    // Reference images — restored silently (no upload side effects re-run).
    // The slot count comes from the model that RAN it: a local Klein run keeps
    // its four references even though the cloud model selection allows one.
    const refs = Array.isArray(context.referenceImages) ? context.referenceImages.filter(Boolean) : [];
    const maxRefs = restoredReferenceLimit({
      imageMode: s.imageMode,
      useLocalModel: s.useLocalModel,
      localModel: s.useLocalModel ? localModelById(s.selectedLocalModel) : null,
      cloudLimit: s.useLocalModel ? 1 : getMaxImagesForI2IModel(s.selectedModel),
      referenceCount: refs.length,
    });
    s.maxImages = maxRefs;
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

    s.regionMode = Boolean(context.regionMode);
    s.regions = Array.isArray(context.regions) ? context.regions.map((region) => ({ ...region })) : [];

    updatePromptHelperVisibility();
    void loadLorasForCurrentModel();

    s.prompt = context.prompt || '';
    updateComposerDraft({ prompt: s.prompt });

    persistImagePreferences();
    bump();
    return true;
  };

  /* ---------------- hand off to the video studio ---------------- */

  // Re-uploads the viewed image through the normal reference path (so it is
  // sealed server-side and shows up in the pickers' recent grid), then opens the
  // Video studio with it already set as the starting frame.
  const sendToVideoStartFrame = async (url) => {
    if (!url || s.sendingToVideo) return;
    s.sendingToVideo = true;
    bump();
    try {
      const referenceUrl = await promoteOutputToReference(url);
      loadStudioSetup('video', { format: 'video-start-frame', imageUrl: referenceUrl });
      s.viewerUrl = null;
      window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'video' } }));
      toast.success('Starting frame set in the Video studio.');
    } catch (e) {
      console.error('[ImageStudio] Use as video starting frame failed:', e);
      toast.error(e.message || 'Could not send that image to the Video studio.');
    } finally {
      s.sendingToVideo = false;
      bump();
    }
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
        downloadName: imageDownloadName(entry.model, entry.id),
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
      const result = await localAI.upscale({ image_base64: dataUrl, mode, scale: 1.5, prompt: entry.prompt || '', ...runOn() });
      if (!result?.url) throw new Error('Upscale finished without an image');
      addToHistory({
        id: `upscale-${entry.id || 'img'}-${mode}-${Date.now()}`,
        url: result.url,
        prompt: entry.prompt || '',
        model: `${entry.model || 'Anima'} · upscaled${mode === 'max' ? ' (max)' : ''}`,
        aspect_ratio: entry.aspect_ratio,
        timestamp: new Date().toISOString(),
        // Pairs this result with what it upscaled so the viewer can offer the
        // synchronized before/after compare.
        sourceUrl: entry.url,
      });
      toast.success('Upscaled image added to the gallery.', { id: loadingId });
    } catch (error) {
      toast.error(error?.message || 'Upscale failed', { id: loadingId });
    }
  };

  // Canvas expansion rides the krea2 lane; the button appears only when that
  // lane is installed locally.
  const krea2LocalModel = () => s.localImageModels.find((m) => m.backend === 'comfy-krea2-turbo-identity-edit') || null;

  const runExpand = async (entry, { width, height, prompt, offsetX, offsetY }) => {
    const model = krea2LocalModel();
    if (!model || !entry?.url) return;
    s.expandBusy = true;
    bump();
    const loadingId = toast.loading(`Expanding to ${width}×${height} — only the new border is generated…`);
    try {
      const src = await resolveMediaSrc(entry.url);
      const blob = await (await fetch(src)).blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read the image'));
        reader.readAsDataURL(blob);
      });
      const result = await runImage({
        row: localRow(model.id, model.provider),
        shared: { prompt: prompt || entry.prompt || '', seed: -1 },
        // Outpaint is a local-only capability. Keying it by transport is also
        // the declaration that this call builds a LOCAL request — a row that
        // resolved elsewhere is refused rather than quietly losing the frame.
        extra: { local: {
          studio_lane: studioLane,
          ...runOn(),
          image_base64: dataUrl,
          outpaint: {
            width,
            height,
            ...(offsetX != null ? { offset_x: offsetX } : {}),
            ...(offsetY != null ? { offset_y: offsetY } : {}),
          },
        } },
      });
      if (!result?.url) throw new Error('Expand finished without an image');
      addToHistory({
        id: `expand-${entry.id || 'img'}-${Date.now()}`,
        url: result.url,
        prompt: prompt || entry.prompt || '',
        model: `${entry.model || model.name} · expanded`,
        aspect_ratio: `${width}:${height}`,
        timestamp: new Date().toISOString(),
        // Pairs with the source so Compare works on expansions too.
        sourceUrl: entry.url,
      });
      s.expandEntry = null;
      // Bring the result forward: it lands in the gallery behind the open viewer
      // otherwise, and the toast is the only sign anything happened.
      viewImage(result.url);
      toast.success('Expanded image added to the gallery.', { id: loadingId });
    } catch (error) {
      toast.error(error?.message || 'Expand failed', { id: loadingId });
    } finally {
      s.expandBusy = false;
      bump();
    }
  };

  // SAM3 smart-select: name an object ("the jacket") or tap it, and get its
  // silhouette back as a mask the dialog paints into its canvas. The image is
  // sealed at rest, so it is decrypted here and sent inline — same round trip
  // as the inpaint itself, and the mask comes back inline rather than becoming
  // an output, so a selection is never written down.
  const smartSelectMask = async (entry, { prompt, points } = {}) => {
    if (!entry?.url) throw new Error('No image to select from');
    const src = await resolveMediaSrc(entry.url);
    const blob = await (await fetch(src)).blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read the image'));
      reader.readAsDataURL(blob);
    });
    return localAI.smartMask({ image_base64: dataUrl, prompt: prompt || '', points: points || undefined });
  };

  const runInpaint = async (entry, { maskDataUrl, prompt, maskExpand, maskInfluence }) => {
    const model = krea2LocalModel();
    if (!model || !entry?.url || !maskDataUrl) return;
    s.inpaintBusy = true;
    bump();
    const loadingId = toast.loading('Editing the painted area — the rest keeps its pixels…');
    try {
      const src = await resolveMediaSrc(entry.url);
      const blob = await (await fetch(src)).blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read the image'));
        reader.readAsDataURL(blob);
      });
      const result = await runImage({
        row: localRow(model.id, model.provider),
        shared: { prompt: prompt || '', seed: -1 },
        extra: { local: {
          studio_lane: studioLane,
          ...runOn(),
          image_base64: dataUrl,
          inpaint: { mask_base64: maskDataUrl, mask_expand: maskExpand, mask_influence: maskInfluence },
        } },
      });
      if (!result?.url) throw new Error('Edit finished without an image');
      addToHistory({
        id: `inpaint-${entry.id || 'img'}-${Date.now()}`,
        url: result.url,
        prompt: prompt || entry.prompt || '',
        model: `${entry.model || model.name} · edited area`,
        aspect_ratio: entry.aspect_ratio,
        timestamp: new Date().toISOString(),
        // Pairs with the source so Compare shows exactly what changed.
        sourceUrl: entry.url,
      });
      s.inpaintEntry = null;
      viewImage(result.url);
      toast.success('Edited image added to the gallery.', { id: loadingId });
    } catch (error) {
      toast.error(error?.message || 'Edit failed', { id: loadingId });
    } finally {
      s.inpaintBusy = false;
      bump();
    }
  };

  // First installed edit-capable model that speaks an angle dialect (Klein
  // preferred by catalog order). Angle + sequence runs both use it.
  const angleEditModel = () => s.localImageModels.find(
    (m) => angleDialectForModel(m) && localModelSupportsImageInput(m),
  ) || null;

  const entryToDataUrl = async (url) => {
    const src = await resolveMediaSrc(url);
    const blob = await (await fetch(src)).blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read the image'));
      reader.readAsDataURL(blob);
    });
  };

  const runAngleVariations = async (entry, { angles, extraPrompt }) => {
    const model = angleEditModel();
    if (!model || !entry?.url || !angles?.length) return;
    s.angleBusy = true;
    s.angleStop = false;
    bump();
    let completed = 0;
    let lastUrl = null;
    try {
      const dataUrl = await entryToDataUrl(entry.url);
      const dialect = angleDialectForModel(model);
      for (let i = 0; i < angles.length; i += 1) {
        if (s.angleStop) break;
        const angle = angles[i];
        s.angleProgress = `Shot ${i + 1} of ${angles.length} — ${angleLabel(angle)}`;
        bump();
        const result = await runImage({
          row: localRow(model.id, model.provider),
          shared: { prompt: editAnglePrompt(dialect, angle, extraPrompt), seed: -1 },
          extra: { local: { studio_lane: studioLane, ...runOn(), image_base64: dataUrl } },
        });
        if (!result?.url) throw new Error(`No output for ${angleLabel(angle)}`);
        addToHistory({
          id: `angle-${entry.id || 'img'}-${Date.now()}-${i}`,
          url: result.url,
          prompt: editAnglePrompt(dialect, angle, extraPrompt),
          model: `${model.name} · angle: ${angleLabel(angle)}`,
          aspect_ratio: entry.aspect_ratio,
          timestamp: new Date().toISOString(),
          sourceUrl: entry.url,
        });
        completed += 1;
        lastUrl = result.url;
      }
      s.angleEntry = null;
      if (lastUrl) viewImage(lastUrl);
      toast.success(s.angleStop && completed < angles.length
        ? `Stopped after ${completed} of ${angles.length} viewpoints.`
        : `${completed} viewpoint${completed === 1 ? '' : 's'} added to the gallery.`);
    } catch (error) {
      toast.error(error?.message || 'Angle variations failed');
    } finally {
      s.angleBusy = false;
      s.angleProgress = '';
      bump();
    }
  };

  const runEditSequence = async (entry, { prompts }) => {
    const model = angleEditModel();
    if (!model || !entry?.url || !Array.isArray(prompts) || prompts.length < 2) return;
    s.sequenceBusy = true;
    s.sequenceStop = false;
    bump();
    // One random base seed; each step advances it by one (donor behavior) so
    // the chain is reproducible from the recorded per-step seeds.
    const baseSeed = Math.floor(Math.random() * 2 ** 31);
    let sourceUrl = entry.url;
    let completed = 0;
    try {
      let dataUrl = await entryToDataUrl(entry.url);
      for (let i = 0; i < prompts.length; i += 1) {
        if (s.sequenceStop) break;
        s.sequenceProgress = `Step ${i + 1} of ${prompts.length}`;
        bump();
        const result = await runImage({
          row: localRow(model.id, model.provider),
          shared: { prompt: prompts[i], seed: baseSeed + i },
          extra: { local: { studio_lane: studioLane, ...runOn(), image_base64: dataUrl } },
        });
        if (!result?.url) throw new Error(`Step ${i + 1} finished without an image`);
        addToHistory({
          id: `seq-${entry.id || 'img'}-${Date.now()}-${i}`,
          url: result.url,
          prompt: prompts[i],
          model: `${model.name} · step ${i + 1}/${prompts.length}`,
          aspect_ratio: entry.aspect_ratio,
          timestamp: new Date().toISOString(),
          seed: result.seed,
          // Each step pairs with ITS input, so Compare shows that step's change.
          sourceUrl,
        });
        completed += 1;
        sourceUrl = result.url;
        dataUrl = await entryToDataUrl(result.url);
      }
      s.sequenceEntry = null;
      if (completed > 0 && sourceUrl !== entry.url) viewImage(sourceUrl);
      toast.success(s.sequenceStop && completed < prompts.length
        ? `Stopped after step ${completed} of ${prompts.length}.`
        : `Sequence finished — ${completed} steps in the gallery.`);
    } catch (error) {
      toast.error(error?.message || 'Edit sequence failed');
    } finally {
      s.sequenceBusy = false;
      s.sequenceProgress = '';
      bump();
    }
  };

  const viewImage = (imageUrl) => {
    // Track the setup behind the on-screen image so "Back to setup"/"Regenerate"
    // can restore it (resolved from the shared store by output URL).
    s.contextStore.view(imageUrl);
    s.viewerUrl = imageUrl;
    bump();
  };

  const downloadImage = downloadMedia;

  const newPrompt = () => {
    // Start fresh — a blank canvas: prompt, references (and their roles), region
    // boxes, couple text, the enhancer and the viewed setup all go. The source,
    // the model, the aspect and the saved tuning stay: starting over is not a
    // reason to switch workflows, and on the Local source the cloud model is
    // not even on screen.
    s.contextStore.clearViewed();
    closePromptHelper();
    Object.assign(s, startFreshPatch());
    if (!s.useLocalModel) {
      // The selected cloud model stays; with no references its text-to-image
      // configuration is the active one again (aspect list, slot count).
      refreshModelConfigControls();
    } else {
      const localModel = ensureCompatibleLocalModel();
      s.maxImages = localModel?.maxReferenceImages || 1;
    }
    // Through the draft writers, so the encrypted composer forgets them too —
    // a bare `s.prompt = ''` left the old prompt and references in the draft,
    // and the next reload brought them straight back.
    setPromptValue('');
    updateComposerDraft({ references: [] });
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
      // A reference picked from the saved list is a sealed envelope, so it has to be
      // decrypted here too — sending only bare `data:` refs meant the helper silently
      // refined the prompt without ever seeing the image the owner attached.
      const referenceInput = await referenceToLocalImageInput(sourceImage);
      const result = await localAI.generatePrompt({
        model: modelId,
        idea,
        negative_prompt: s.negativePrompt || undefined,
        seed: s.seed,
        active_loras: loraGenerationPayload(currentLoraSelection()),
        ...(String(referenceInput.image_base64 || '').startsWith('data:image/')
          ? { reference_image: referenceInput.image_base64 }
          : {}),
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

  // Cancel the run in flight. The flag is what makes it honest: the bridge's
  // promise may still settle later (the hosted bridge stops polling at once; an
  // Electron/wan2gp runtime gets a best-effort interrupt and may finish anyway)
  // and the run's continuation checks the flag before it touches history, the
  // viewer or the chime. The timer and the progress listener are torn down here
  // rather than "when the promise comes back" — which used to be minutes later.
  const cancelGeneration = () => {
    const run = s.activeGeneration;
    if (run) {
      run.cancelled = true;
      try { run.abort?.abort(); } catch { /* already settled */ }
      try {
        // Hosted bridge: stop polling THIS job (a sibling tab's run keeps going).
        // Other runtimes: the global best-effort interrupt they expose.
        if (run.jobId && window.localAI?.isHosted && typeof window.localAI.cancelGeneration === 'function') {
          void window.localAI.cancelGeneration(run.jobId);
        } else if (s.useLocalModel) {
          localAI.cancelGeneration();
        }
      } catch { /* not all runtimes support it */ }
      if (typeof run.unsub === 'function') { try { run.unsub(); } catch { /* already gone */ } run.unsub = null; }
      if (run.jobId) removePendingJob(run.jobId);
    }
    s.activeGeneration = null;
    s.localProgress = { active: false, pct: 0, label: '' };
    finishImageProgress(false);
    s.generating = false;
    s.generateError = '';
    s.generateFailure = null;
    bump();
    toast(zh() ? '已取消生成。' : 'Generation cancelled.');
  };

  /**
   * One reading of a failed run, kept on the canvas and nowhere else.
   *
   * `describeFailure` turns whatever threw into a sentence plus the button that
   * repairs it; the callout renders all three parts, so there is deliberately
   * no toast beside this (DESIGN.md §4: a failure is shown once).
   */
  const failGeneration = (error, transport) => {
    const failure = describeFailure(error, {
      transport,
      operation: zh() ? '生成' : 'Generation',
      // Only the local lane has a size dial to step down; a cloud model's
      // "Lower resolution" would point at a control this screen does not own.
      canLowerResolution: transport === 'local' && LOCAL_BASE_SIZES.some((size) => size && size < (s.baseSize || 1280)),
    });
    s.generateFailure = failure;
    s.generateError = failure.title || (zh() ? '生成失败' : 'Generation failed');
  };

  /** Step the local short side down one tier — what "Lower resolution" means. */
  const lowerResolution = () => {
    const sizes = LOCAL_BASE_SIZES.filter(Boolean).sort((a, b) => b - a);
    const current = s.baseSize || sizes[0];
    const next = sizes.find((size) => size < current);
    if (!next) return;
    s.baseSize = next;
    persistImagePreferences();
    s.generateError = '';
    s.generateFailure = null;
    bump();
    toast(zh() ? `分辨率已降到 ${next} 短边。` : `Resolution lowered to a ${next}px short side.`);
  };

  const generateNow = async () => {
    // Rented mode is a promise about WHERE this runs. If no live machine
    // serves the selected model, stop instead of quietly using this Mac.
    if (s.rentedOnly && !servedByAnyMachine(s.rentedMachines, localModelById(s.selectedLocalModel) || { id: s.selectedLocalModel })) {
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
    // Region boxes turn into placement sentences appended to the scene prompt.
    // This is pure text, so it rides along on every model, local or cloud —
    // except couple mode, which owns a strict line-per-character contract.
    if (!coupleOptions && regionsActive()) prompt = composeRegionalPrompt(prompt, s.regions);
    // The Style Preset dropdown appends its phrase here — for BOTH the local and
    // cloud paths — instead of being the dead control it shipped as. Couple mode
    // keeps its strict line-per-character contract, so presets stand down there.
    if (!coupleOptions) prompt = applyStylePreset(prompt, s.selectedStyle);

    // References are sent only when the selected model can take them.
    const sendingRefs = s.uploadedImageUrls.length > 0 && currentModelSupportsImage();
    const sheetActive = !coupleOptions && characterSheetActive();
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
      // A character sheet builds its view prompts server-side — the composer
      // prompt is an optional style/identity suffix, so it may stay empty.
      if (lm.requires?.prompt && !prompt && !sheetActive) { toast.error('Please enter an edit prompt.'); return; }
      if (lm.requires?.image && s.uploadedImageUrls.length === 0) {
        toast.error(`${lm.name} requires a reference image.`);
        return;
      }

      const huntIds = coupleOptions || sheetActive ? [] : armedHuntIds();
      if (huntIds.length) {
        toast(`Strength Hunt: sweeping ${huntIds.length === 2 ? 'two LoRAs' : 'one LoRA'} 0 → current — the labeled sheet arrives as the result.`);
      }
      if (sheetActive) {
        const preset = CHARACTER_SHEET_PRESETS.find((p) => p.value === s.characterSheetPreset);
        toast(`Character sheet: generating ${preset?.label || s.characterSheetPreset} views of your reference — the labeled sheet arrives as the result.`);
      }

      s.generating = true;
      s.generateError = '';
      s.generateFailure = null;
      s.localProgress = { active: true, pct: 0, label: t('common.generating') };
      const run = { jobId: null, cancelled: false, unsub: null };
      s.activeGeneration = run;
      startImageProgress();
      bump();

      run.unsub = localAI.onProgress(({ progress, status, message }) => {
        if (run.cancelled) return;
        const pct = Math.round((progress ?? 0) * 100);
        const label = message || (status === 'starting' ? 'Starting...' : `${pct}%`);
        s.localProgress = { active: true, pct, label };
        // Coarse status nudges the bar up (never down); elapsed/estimate drives it.
        s.progressReal = Math.min(1, Math.max(0, progress ?? 0));
        bump();
      });
      const unsub = () => { if (typeof run.unsub === 'function') run.unsub(); run.unsub = null; };
      const historyMeta = { model: `local:${s.selectedLocalModel}`, aspect_ratio: s.selectedAr };
      // The hosted bridge hands the gateway job id back as soon as it is
      // queued: a reload mid-render then finds the run again (pending job, same
      // registry as the cloud path) and Cancel can stop this one poll by id.
      // Only the hosted bridge takes a callback — an Electron runtime sends the
      // params over IPC, where a function cannot travel.
      const onJobId = window.localAI?.isHosted ? (jobId) => {
        if (run.cancelled || !jobId) return;
        run.jobId = jobId;
        savePendingJob({
          requestId: jobId, studioType: 'image', kind: 'hosted-local', historyMeta, tabId: tabIdRef.current,
          submittedAt: Date.now(),
        });
      } : null;

      // Batch Count was the second dead control: rendered, persisted, never
      // sent. The gateway runs one image per request, so a batch is N
      // sequential requests; a Strength Hunt is already its own batch.
      const batchTotal = (huntIds.length || sheetActive) ? 1 : Math.max(1, Math.min(4, Number(s.batchCount) || 1));
      // A reference-driven edit gets an explicit canvas: the Resolution tier's
      // pixel budget, shaped like the model's own bucket. The server keeps the
      // budget and swaps in the reference's aspect. Without it the request would
      // carry the aspect preset's dimensions — an aspect this run does not use.
      const editBudget = referenceDrivenEdit() ? editBudgetForShortSide(s.baseSize) : null;
      try {
        // References are ignored (not sent) when the model can't take them.
        const sourceImage = localModelSupportsImageInput(lm) ? (s.uploadedImageUrls[0] || '') : '';
        // A reference picked from the saved list is a sealed same-origin envelope,
        // not something the bridge can read: decrypt it here and send the bytes
        // inline. Sending the bare path made the bridge fail on "Invalid URL".
        const referenceInput = await referenceToLocalImageInput(sourceImage);
        // Models that condition on several references (Klein takes up to 4)
        // get the rest of the attached refs too, decrypted the same way.
        const extraReferences = [];
        if (localModelSupportsImageInput(lm) && (lm.maxReferenceImages || 1) > 1) {
          for (const ref of s.uploadedImageUrls.slice(1, Math.max(1, lm.maxReferenceImages || 1))) {
            const input = await referenceToLocalImageInput(ref);
            const value = input.image_base64 || input.image_url;
            if (value) extraReferences.push(value);
          }
        }
        let lastUrl = null;
        for (let shot = 0; shot < batchTotal; shot += 1) {
          if (run.cancelled) break;
          if (batchTotal > 1) {
            s.localProgress = { active: true, pct: 0, label: `Shot ${shot + 1} of ${batchTotal}` };
            bump();
          }
          const res = await runImage({
            row: localRow(s.selectedLocalModel),
            shared: {
              prompt,
              aspect_ratio: s.selectedAr,
              // Explicit seeds advance per shot so a batch is N different
              // images, never N copies; -1 stays -1 (the server randomizes each
              // run).
              seed: (typeof s.seed === 'number' && s.seed >= 0) ? s.seed + shot : s.seed,
            },
            extra: { local: {
            ...(onJobId ? { onJobId } : {}),
            studio_lane: studioLane,
            ...runOn(),
            // Not sent to workflows that ignore it — the UI says as much, and a field
            // the user can no longer see must not keep riding along in the payload.
            negative_prompt: (currentModelSupportsNegativePrompt() && s.negativePrompt) || undefined,
            steps: s.steps,
            guidance_scale: s.guidanceScale,
            runtime_mode: s.localRuntimeMode,
            width: editBudget ? editBudget.width : (s.customWidth || undefined),
            height: editBudget ? editBudget.height : (s.customHeight || undefined),
            // Width/height, when set, ARE the resolution and win outright; base_size
            // only scales the aspect-ratio preset (short side) when they are Auto.
            base_size: (!editBudget && !s.customWidth && !s.customHeight && s.baseSize) ? s.baseSize : undefined,
            sampler_name: s.sampler || undefined,
            scheduler: s.scheduler || undefined,
            loras: loraGenerationPayload(currentLoraSelection()),
            // Strength Hunt: 1-2 armed LoRA axes → the gateway sweeps them over a
            // fixed prompt+seed and returns the labeled sheet as the first output.
            // Couple mode owns the prompt-line contract, so hunts stand down there.
            ...(huntIds.length && !coupleOptions ? { strength_hunt: { lora_ids: huntIds } } : {}),
            // Character sheet (Civitai multi-view port): the gateway loops the
            // preset's views over the same reference(s) + seed and returns the
            // labeled sheet as the first output.
            ...(sheetActive ? { character_sheet: { preset: s.characterSheetPreset } } : {}),
            ...(coupleOptions || {}),
            ...referenceInput,
            ...(extraReferences.length ? { images_base64: extraReferences } : {}),
            } },
          });
          // Cancelled while this shot was rendering: the result is not ours any
          // more — no history entry, no viewer, no chime.
          if (run.cancelled) break;
          if (run.jobId) { removePendingJob(run.jobId); run.jobId = null; }
          if (!res?.url) throw new Error('No output returned from local generation');
          if (res.mediaType === 'video') {
            throw new Error('This model produces video — use the Video studio instead.');
          }
          addToHistory({
            id: `${Date.now()}-${shot}`,
            url: res.url,
            prompt,
            model: `local:${s.selectedLocalModel}${huntIds.length ? ' · strength hunt' : ''}${sheetActive ? ' · character sheet' : ''}`,
            aspect_ratio: s.selectedAr,
            seed: res.seed,
            timestamp: new Date().toISOString(),
          }, s.lastSubmittedContext);
          lastUrl = res.url;
        }
        if (run.cancelled) return;
        unsub();
        s.localProgress = { active: false, pct: 0, label: '' };
        finishImageProgress(true);
        if (lastUrl) viewImage(lastUrl);
      } catch (e) {
        // A cancelled run already reset everything in cancelGeneration; a
        // rejection that arrives afterwards (the bridge stopping its poll, or a
        // runtime's interrupt) is the expected ending, not an error.
        if (run.cancelled || e?.cancelled) return;
        unsub();
        s.localProgress = { active: false, pct: 0, label: '' };
        finishImageProgress(false);
        // Message only — the error object carries the request (prompt included),
        // which has no business in the console.
        console.warn('[ImageStudio] local generation failed:', e?.message || e);
        failGeneration(e, 'local');
      } finally {
        if (run.jobId) removePendingJob(run.jobId);
        if (s.activeGeneration === run) {
          s.activeGeneration = null;
          s.generating = false;
        }
        bump();
      }
      return;
    }

    // ── Remote API path ───────────────────────────────────────────────────
    // The key this machine holds counts: needsBrowserKey is false when the
    // shared store has MUAPI_API_KEY (seeded once at boot), so a configured
    // machine never sees this dialog.
    if (needsBrowserKey(muapiRow(s.selectedModel))) {
      authRetryRef.current = () => generate();
      s.authOpen = true;
      bump();
      return;
    }

    // A cloud model fetches references by URL, so one held only on this Mac has to be
    // decrypted and uploaded to MUAPI first — the bytes leave the machine. Stop here
    // and let the owner decide; confirming re-enters generate() with it approved.
    if (sendingRefs) {
      const awaitingApproval = referencesNeedingApproval(s.uploadedImageUrls, s.cloudRefApproved);
      if (awaitingApproval.length) {
        s.cloudRefConfirm = { sources: awaitingApproval, model: s.selectedModelName || s.selectedModel };
        bump();
        return;
      }
    }

    s.generating = true;
    s.generateError = '';
    s.generateFailure = null;
    // The muapi client polls with this signal, so Cancel stops the provider poll
    // at once (and frees the serial queue) instead of just ignoring a late result.
    const run = { jobId: null, cancelled: false, unsub: null, abort: new AbortController() };
    s.activeGeneration = run;
    startImageProgress();
    bump();

    let capturedRequestId = null;
    const historyMeta = { prompt, model: s.selectedModel, aspect_ratio: s.selectedAr };

    try {
      let res;
      const qualityLabel = s.selectedResolution;
      // An explicit seed rides along on both cloud paths (the lib drops -1).
      const seed = (typeof s.seed === 'number' && s.seed >= 0) ? s.seed : -1;
      if (sendingRefs) {
        // Approved above: decrypt anything held locally and upload it so the provider
        // has a URL it can fetch. Already-public references pass straight through.
        const cloudRefs = await resolveCloudReferences(s.uploadedImageUrls, { cache: s.cloudRefUploads });
        if (run.cancelled) return;
        const genParams = {
          model: s.selectedModel,
          images_list: cloudRefs,
          image_url: cloudRefs[0], // backward compat for single-image models
          aspect_ratio: s.selectedAr,
          seed,
          signal: run.abort.signal,
          onRequestId: (rid) => {
            capturedRequestId = rid;
            run.jobId = rid;
            // Stamped with the tab that started it, so it is that tab — and no
            // other — that reclaims the run after a reload.
            savePendingJob({
              requestId: rid, studioType: 'image', historyMeta, tabId: tabIdRef.current,
              maxAttempts: 60, interval: 2000, submittedAt: Date.now(),
            });
          },
        };
        if (prompt) genParams.prompt = prompt;
        const qualityField = getCurrentQualityField(s.selectedModel);
        if (qualityField && qualityLabel) genParams[qualityField] = qualityLabel;
        res = await runImage({
          row: muapiRow(s.selectedModel),
          shared: { prompt: prompt || '', aspect_ratio: s.selectedAr, seed },
          // generateI2I, not generateImage: the reference rows are the point of
          // this branch, and the two endpoints take different bodies.
          extra: { muapi: { method: 'generateI2I', ...genParams } },
          signal: run.abort.signal,
        });
      } else {
        const genParams = {
          model: s.selectedModel,
          prompt,
          aspect_ratio: s.selectedAr,
          seed,
          signal: run.abort.signal,
          onRequestId: (rid) => {
            capturedRequestId = rid;
            run.jobId = rid;
            savePendingJob({
              requestId: rid, studioType: 'image', historyMeta, tabId: tabIdRef.current,
              maxAttempts: 60, interval: 2000, submittedAt: Date.now(),
            });
          },
        };
        const qualityField = getCurrentQualityField(s.selectedModel);
        if (qualityField && qualityLabel) genParams[qualityField] = qualityLabel;
        res = await runImage({
          row: muapiRow(s.selectedModel),
          shared: { prompt: prompt || '', aspect_ratio: s.selectedAr, seed },
          extra: { muapi: genParams },
          signal: run.abort.signal,
        });
      }

      // Cancelled while the provider was working: the pending job is already
      // gone and this result belongs to nobody.
      if (run.cancelled) return;
      if (res && res.url) {
        if (capturedRequestId) removePendingJob(capturedRequestId);
        // The kept copy is the one this studio remembers: the provider's URL
        // expires, and an entry pointing at it is empty by tomorrow. `saved`
        // false means the keep did not happen — the viewer says so beside
        // Download instead of letting the loss be discovered later.
        const kept = res.savedUrl || res.url;
        addToHistory({
          id: res.id || capturedRequestId || Date.now().toString(),
          url: kept,
          prompt,
          model: s.selectedModel,
          aspect_ratio: s.selectedAr,
          timestamp: new Date().toISOString(),
          saved: Boolean(res.savedUrl),
        }, s.lastSubmittedContext);
        finishImageProgress(true);
        viewImage(kept);
      } else {
        throw new Error('No image URL returned by API');
      }
    } catch (e) {
      if (run.cancelled || e?.cancelled) return;
      if (capturedRequestId) removePendingJob(capturedRequestId);
      finishImageProgress(false);
      console.warn('[ImageStudio] cloud generation failed:', e?.message || e);
      failGeneration(e, 'muapi');
    } finally {
      if (s.activeGeneration === run) {
        s.activeGeneration = null;
        s.generating = false;
      }
      bump();
    }
  };
  const generate = () => generationQueueRef.current.enqueue(generateNow);

  /* ---------------- mount effects (replicate factory boot order) ---------------- */

  useEffect(() => {
    if (mountedOnceRef.current) return undefined;
    mountedOnceRef.current = true;

    // --- Resume the generations this tab had in flight when the page went away ---
    // Ownership is per TAB: a reload brings the whole strip back, and each tab
    // reclaims the run IT started — otherwise one tab polls another's job and files
    // the result in the wrong tab's history. This tab puts its own run back on the
    // canvas; the primary tab additionally adopts the ownerless ones (a tab closed
    // mid-render, or a job saved before jobs carried a tab id) into history.
    (async () => {
      // A cloud job is claimable whenever a key exists ANYWHERE this page can
      // reach — this machine's shared store as much as this browser. The route
      // resolves itself, so the poll below needs no key argument.
      const cloudRunnable = !needsBrowserKey(muapiRow(s.selectedModel));
      // A local (hosted-bridge) job is polled through the bridge by id — no cloud
      // key involved. Only the hosted bridge can resume one; a job left behind by
      // another runtime would poll forever, so it is dropped instead of kept.
      const isLocalJob = (job) => job?.kind === 'hosted-local';
      const canResumeLocal = Boolean(window.localAI?.isHosted) && typeof window.localAI?.resumeGeneration === 'function';
      const owned = pendingJobsForTab(getPendingJobs('image'), tabIdRef.current, {
        primary: isPrimaryTab,
        openTabIds: openTabIdsRef.current,
      });
      owned.filter((job) => isLocalJob(job) && !canResumeLocal).forEach((job) => removePendingJob(job.requestId));
      // Cloud jobs wait for a key (they remain for next time); local ones never needed one.
      const claimed = owned.filter((job) => (isLocalJob(job) ? canResumeLocal : cloudRunnable));
      if (!claimed.length) return;
      const ownTab = Number.isSafeInteger(Number(tabIdRef.current)) ? Number(tabIdRef.current) : null;
      // The canvas shows one run, so restore this tab's newest job there and poll
      // the rest quietly into history.
      const live = ownTab == null ? undefined : claimed
        .filter((job) => Number(job?.tabId) === ownTab)
        .sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0))[0];
      const silent = claimed.filter((job) => job !== live);

      // `{ url, saved }`: a local job is already a kept output, a cloud one is
      // only kept once it has been adopted — a run recovered after a reload
      // must not be the one result that stays a soon-dead CDN link.
      const pollJob = async (job) => {
        if (isLocalJob(job)) {
          const result = await window.localAI.resumeGeneration(job.requestId);
          return { url: result?.url || '', saved: true };
        }
        const interval = Number(job.interval) || 2000;
        const spent = Math.floor((Date.now() - (Number(job.submittedAt) || Date.now())) / interval);
        const attemptsLeft = Math.max(1, (Number(job.maxAttempts) || 60) - spent);
        const result = await muapi.pollForResult(job.requestId, '', attemptsLeft, interval);
        const url = result.outputs?.[0] || result.url || result.output?.url || '';
        if (!url) return { url: '', saved: false };
        const savedUrl = await adoptCloudOutput(url, {
          kind: 'image', model: job.historyMeta?.model || '', provider: 'muapi',
        });
        return { url: savedUrl || url, saved: Boolean(savedUrl) };
      };

      if (live && !s.generating) {
        s.generating = true;
        s.generateError = '';
        s.generateFailure = null;
        // Cancel has to be able to stop a resumed poll too — by job id, the same
        // way it stops a fresh one.
        const run = { jobId: live.requestId, cancelled: false, unsub: null };
        s.activeGeneration = run;
        startImageProgress();
        // A resumed job was configured before this mount, so its wall time is not a
        // measurement of what the panels currently say — don't file it as one.
        s.progressSignature = null;
        // The true submit time, so elapsed covers the whole render rather than
        // restarting the clock at the reload.
        s.generationStartedAt = Number(live.submittedAt) || Date.now();
        bump();
        void (async () => {
          try {
            const { url, saved } = await pollJob(live);
            if (run.cancelled) return;
            if (url) {
              addToHistory({ id: live.requestId, url, ...live.historyMeta, saved, timestamp: new Date().toISOString() });
              finishImageProgress(true);
              viewImage(url);
            } else {
              finishImageProgress(false);
            }
          } catch (e) {
            if (run.cancelled || e?.cancelled) return;
            console.warn('[ImageStudio] Image resume failed:', live.requestId, e.message);
            failGeneration(e, 'muapi');
            finishImageProgress(false);
          } finally {
            removePendingJob(live.requestId);
            if (s.activeGeneration === run) {
              s.activeGeneration = null;
              s.generating = false;
            }
            bump();
          }
        })();
      }

      if (!silent.length) return;
      s.resumeRemaining = silent.length;
      bump();
      silent.forEach(async (job) => {
        try {
          const { url, saved } = await pollJob(job);
          if (url) {
            addToHistory({ id: job.requestId, url, ...job.historyMeta, saved, timestamp: new Date().toISOString() });
            void playCompletionPing();
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
    void discoverLocalCatalog();

    // A duplicate keeps the LoRA panel open on the same selection — load its
    // catalog, which the boot path above only does for the persisted tab.
    if (s.bootSource === 'clone' && s.loraOpen) void loadLorasForCurrentModel();

    // --- Restore the encrypted composer draft (prompt + reference selection) ---
    // Hydration is a module-level cache, so every tab may await it; only the
    // original tab ADOPTS the draft. New/duplicated tabs already know what they are.
    void hydrateComposerState().then(() => {
      if (!isPrimaryTab) return;
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

    // The hub broadcasts this when a model download lands or the stack comes
    // back. Without it the boot answer — including "the engine is starting" —
    // stood for the lifetime of the tab.
    const onHubRefresh = () => { void discoverLocalCatalog(); };
    window.addEventListener('hivemind-hub-refresh', onHubRefresh);
    return () => window.removeEventListener('hivemind-hub-refresh', onHubRefresh);
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

  // Publish this tab's handle for the tab strip: Copy reads a full snapshot of the
  // engine's configuration, Close asks whether a generation is still running.
  useEffect(() => {
    if (!apiRef) return undefined;
    apiRef.current = {
      snapshot: () => ({
        ...snapshotTabFields(s, IMAGE_TAB_FIELDS),
        // The live prefs, not the last-persisted ones — a background tab stops
        // persisting, so s.persistedImagePreferences can be stale here.
        persistedImagePreferences: currentImagePreferences(),
      }),
      isBusy: () => Boolean(s.generating || generationQueueRef.current.pending),
      // Cheap enough to call on the strip's poll (snapshot() deep-copies the
      // references): what this tab is called, and the last thing it made.
      chip: () => ({
        prompt: s.prompt,
        model: s.useLocalModel ? s.selectedLocalModel : (s.selectedModelName || s.selectedModel),
        previewUrl: s.history[0]?.url || '',
        previewKind: 'image',
      }),
    };
    return () => { apiRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Unmount: mark unmounted (guards the progress timer's bump) and stop the timer.
  useEffect(() => () => {
    mountedRef.current = false;
    if (s.generationTimer) { clearInterval(s.generationTimer); s.generationTimer = null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ?page=cinema folded into the Camera menu, and still resolves: the route asks
  // for the menu by name and the VISIBLE composer opens it. Latched, because the
  // request lands before this studio has finished loading.
  useEffect(() => {
    if (!active) return undefined;
    const claim = () => {
      if (!takeComposerMenuRequest('image', 'camera')) return;
      s.cameraMenuOpen = true;
      bump();
    };
    claim();
    return onComposerMenuRequest(claim);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

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

  // The reference's own pixel size, measured from the decrypted bytes: it is
  // what the server reshapes the edit budget onto, so it is the only way the
  // Resolution hint can name the size this run will actually render.
  const [referenceDims, setReferenceDims] = useState(null);
  const referenceSrc = useMediaSrc(s.uploadedImageUrls[0] || '');
  useEffect(() => {
    if (!referenceSrc) { setReferenceDims(null); return undefined; }
    let alive = true;
    const probe = new Image();
    probe.onload = () => {
      if (alive) setReferenceDims({ width: probe.naturalWidth, height: probe.naturalHeight });
    };
    probe.src = referenceSrc;
    return () => { alive = false; probe.onload = null; };
  }, [referenceSrc]);

  // Prompt textarea auto-grow (same 150/250px caps as the old oninput). Keyed
  // on the text: measuring scrollHeight forces a reflow, and without a
  // dependency list it ran on every render — every 300 ms progress tick, every
  // slider drag.
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = window.innerWidth < 768 ? 150 : 250;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [s.prompt, coupleActive()]);

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
  const samplerChoices = s.useLocalModel ? (activeLocalModel?.samplers || []) : [];
  const schedulerChoices = s.useLocalModel ? (activeLocalModel?.schedulers || []) : [];
  const showSampler = samplerChoices.length > 0;
  // The Resolution / Sampler hints quote Krea 2's measured internals; they are
  // only true for Krea 2.
  const krea2Selected = s.useLocalModel && /krea2/i.test(String(activeLocalModel?.backend || activeLocalModel?.id || ''));
  // Sampling cost tracks pixel count, so the resolved size is worth showing:
  // 16:9 at 1024 is ~1.75x the work of 1:1 at 1024.
  const resolvedDims = s.useLocalModel
    ? resolveLocalDimensions({
      aspectRatio: s.selectedAr,
      baseSize: s.baseSize,
      customWidth: s.customWidth,
      customHeight: s.customHeight,
      model: activeLocalModel,
    })
    : null;
  // Custom tile stays open while a W/H field is cleared mid-edit (customArOpen),
  // and re-derives from persisted dims on reload. Local-only: cloud APIs accept
  // enumerated ratios, not free sizes.
  const customDimsActive = s.useLocalModel && Boolean(s.customArOpen || (s.customWidth && s.customHeight));
  // Rented selected with nothing to run on: every setting below is moot,
  // so the panel collapses to the Source block and its rent/provisioning CTA.
  const rentedBlocked = Boolean(s.rentedOnly && !s.rentedMachines?.length);
  // The same rule for the Local source: an engine that is not answering, or a
  // machine with nothing installed, cannot run a press. Discovery in flight is
  // not a block — it resolves in milliseconds and greying the button out on
  // every mount would be its own bug.
  const localBlocked = Boolean(
    s.useLocalModel && !s.rentedOnly
    && s.localCatalogStatus !== 'ready' && s.localCatalogStatus !== 'discovering',
  );
  const localBlockedReason = localBlocked
    ? (s.localCatalogStatus === 'empty'
      ? (zh() ? '这台机器上尚未安装图像模型——打开“模型”安装一个，或改用云端。' : 'No image model is installed on this machine yet — open Models to install one, or switch the source to Cloud.')
      : (zh() ? '本地引擎正在启动——它响应后即可生成，或改用云端。' : 'The local engine is starting — generate as soon as it answers, or switch the source to Cloud.'))
    : '';
  // The studio itself is down: every lane below it is moot, so the press is
  // greyed out with that reason rather than failing one provider at a time.
  // The banner above the canvas (StudioLayout) carries the fix.
  const offlineBlocked = apiStatus.tone === 'offline';
  const offlineReason = offlineBlocked
    ? (zh() ? '工作室没有运行——重新启动后即可生成。' : 'The studio is not running — start it again to generate.')
    : '';
  const generateBlocked = rentedBlocked || localBlocked || offlineBlocked;
  // Edit workflows (requires.image) take their ASPECT from the reference on the
  // server, so the aspect-ratio preset would be a lie while a reference is
  // attached — replace it with the truth. The size is still the caller's to set:
  // what reaches the server is a pixel budget it reshapes onto that aspect.
  const referenceDrivesAspect = referenceDrivenEdit();
  const editBudget = referenceDrivesAspect ? editBudgetForShortSide(s.baseSize) : null;
  const editOutput = editOutputDimensions(editBudget, referenceDims?.width, referenceDims?.height);
  const coupleOn = coupleActive();
  const sheetOn = characterSheetActive();
  const viewerIndex = s.viewerUrl ? s.history.findIndex((e) => e.url === s.viewerUrl) : -1;
  const viewerEntry = viewerIndex >= 0 ? s.history[viewerIndex] : null;

  // "~40 s" — what this exact setup has taken before, from the same store the
  // progress bar uses. It reads out beside Generate and stands in for the
  // hard-coded Krea-2 timings the Resolution hint used to quote.
  const etaLabel = (() => {
    const profile = currentTimingProfile();
    const seconds = estimateGenerationSeconds(
      profile.key,
      profile.work,
      s.useLocalModel ? DEFAULT_LOCAL_IMAGE_RATE_SEC : DEFAULT_API_IMAGE_ESTIMATE_SEC,
    );
    if (!(seconds > 0)) return '';
    return seconds >= 90 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`;
  })();

  // The button says one thing while working; the bridge's status text ("Queued
  // on hosted…") belongs to the progress card, not to a 130px button that
  // swelled to 300px and reflowed the chip row.
  const generateLabel = s.generating ? t('common.generating') : t('common.generate');

  const promptPlaceholder = refCount > 1
    ? `${refCount} ${t('image.multiImageNote')}`
    : refCount > 0
      ? t('image.placeholderTransform')
      : t('image.placeholder');

  // The LoRA panel's whole prop set, kept here (not in the panel component) so
  // the selection plumbing stays next to the state it mutates.
  const loraProps = {
    open: s.loraOpen,
    onToggleOpen: () => {
      s.loraOpen = !s.loraOpen;
      bump();
      // Lazy-load exactly like the old Advanced panel toggle did.
      if (s.loraOpen) void loadLorasForCurrentModel();
    },
    baseLabel: s.loraBaseLabel,
    baseModelId: currentLoraModel()?.id || '',
    baseModels: s.loraBaseModels,
    status: s.loraCatalogStatus,
    message: s.loraCatalogMessage,
    loras: s.availableLoras,
    rentedOnly: Boolean(s.rentedOnly),
    onSwitchToLocal: () => setSource(true, false),
    selection: currentLoraSelection(),
    getSelection: currentLoraSelection,
    onToggleLora: (lora) => {
      setCurrentLoraSelection(toggleLoraSelection(currentLoraSelection(), lora));
      bump();
    },
    onToggleEnabled: (lora) => {
      setCurrentLoraSelection(toggleLoraEnabled(currentLoraSelection(), lora.id));
      persistImagePreferences();
      bump();
    },
    onSetStrength: (id, value) => {
      setCurrentLoraSelection(updateLoraStrength(currentLoraSelection(), id, value));
    },
    onCommitStrength: (id, value) => {
      setCurrentLoraSelection(updateLoraStrength(currentLoraSelection(), id, value));
      bump();
    },
    onClearAll: () => { setCurrentLoraSelection([]); bump(); },
    onDownload: () => { s.civitaiOpen = true; bump(); },
    onUpdateLora: startLoraUpdate,
    onLoadGroup: (selection) => {
      setCurrentLoraSelection(selection);
      persistImagePreferences();
      bump();
    },
    onToggleHunt: strengthHuntCapable() ? (lora) => {
      setCurrentLoraSelection(toggleLoraHunt(currentLoraSelection(), lora.id));
      persistImagePreferences();
      bump();
    } : undefined,
  };

  const panel = (
    <ImageSettingsPanel
      engine={s}
      bump={bump}
      persist={persistImagePreferences}
      localAvailable={isLocalAIAvailable()}
      activeLocalModel={activeLocalModel}
      modelLabel={modelLabel}
      aspectRatios={aspectRatios}
      resolutions={resolutions}
      resolvedDims={resolvedDims}
      customDimsActive={customDimsActive}
      referenceDrivesAspect={referenceDrivesAspect}
      editBudget={editBudget}
      editOutput={editOutput}
      rentedBlocked={rentedBlocked}
      refCount={refCount}
      showSampler={showSampler}
      showRuntimeMode={showRuntimeMode}
      samplerChoices={samplerChoices}
      schedulerChoices={schedulerChoices}
      krea2Selected={krea2Selected}
      etaLabel={etaLabel}
      coupleOn={coupleOn}
      sheetOn={sheetOn}
      coupleCapable={coupleCapableModel()}
      characterSheetCapable={characterSheetCapable()}
      characterSheetPresets={CHARACTER_SHEET_PRESETS}
      strengthHuntCapable={strengthHuntCapable()}
      huntArmedCount={armedHuntIds().length}
      supportsNegativePrompt={currentModelSupportsNegativePrompt()}
      negativePromptInactive={s.useLocalModel && negativePromptNeedsGuidance(s.guidanceScale)}
      negativePromptUnsupportedBy={localModelById(s.selectedLocalModel)?.name || ''}
      selectedArNumber={selectedArNumber()}
      tabActive={tabActive}
      loraProps={loraProps}
      onSetSource={setSource}
      onPinMachine={pinMachine}
      onDiscoverLocalCatalog={discoverLocalCatalog}
      onSelectLocalModel={selectLocalModel}
      onSelectApiModel={selectApiModel}
    />
  );

  /* ---------------- composer drops ---------------- */

  // A picture dropped ON THE COMPOSER is a reference for the next image, not a
  // past run to restore — that is what the rest of the window does. This studio
  // makes pictures from pictures, so a clip or a voice note has nowhere to go
  // here and says so instead of being swallowed.
  //
  // Three unrelated refusals, kept apart: the wrong kind of file, no slot left,
  // and an upload the server turned down (which explains itself).
  const describeImageDropRejection = ({ name, code, kind, error, size }) => {
    if (code === 'unsupported') return `${name} — not a picture`;
    if (code === 'full') {
      return kind === 'images'
        ? `${name} — all ${s.maxImages} reference ${s.maxImages === 1 ? 'slot is' : 'slots are'} used`
        : `${name} — the Image studio takes pictures; drop a clip in the Video studio`;
    }
    const megabytes = size ? ` (${(size / 1024 / 1024).toFixed(1)} MB)` : '';
    return `${name} — ${error?.message || 'upload failed'}${megabytes}`;
  };

  const attachDroppedImages = async (files) => {
    const { added, rejected } = await attachDroppedReferences({
      files,
      taken: { images: s.uploadedImageUrls.length },
      limits: { images: s.maxImages, videos: 0, audios: 0 },
      // A data: URL, on BOTH sources. Bytes reach MUAPI only at Generate, once
      // the cloud-reference confirm has been answered — see
      // lib/cloudReferenceUpload.js (referencesNeedingApproval).
      upload: referenceUploader(fileToDataUrl),
    });
    if (added.images.length) {
      handlePickerChange([...s.uploadedImageUrls, ...added.images.map((item) => item.url)].slice(0, s.maxImages));
    }
    for (const rejection of rejected) {
      if (rejection.error) console.error('[ImageStudio] composer drop upload failed:', rejection.error);
      toast.error(describeImageDropRejection(rejection));
    }
    if (added.images.length) {
      toast.success(added.images.length === 1
        ? 'Attached as a reference image.'
        : `Attached ${added.images.length} reference images.`);
    }
  };

  const handleComposerFiles = async (files) => {
    if (!files.length) return;
    if (!refsSupported) {
      toast.error('The selected model does not accept reference images.');
      return;
    }
    s.composerAttaching = true;
    bump();
    try {
      await attachDroppedImages(files);
    } catch (err) {
      console.error('[ImageStudio] composer drop failed:', err);
      toast.error(err?.message || 'Could not attach that.');
    } finally {
      s.composerAttaching = false;
      bump();
    }
  };

  // An image dragged out of the gallery carries a URL, not bytes: it goes up
  // through the same reference upload "Use as starting frame" uses, so it is
  // re-sealed and joins the recent-references grid.
  const handleComposerOutput = async (payload) => {
    if (!refsSupported) {
      toast.error('The selected model does not accept reference images.');
      return;
    }
    if (referenceKindForOutput(payload) !== 'images') {
      toast.error('The image studio takes pictures — drop a clip in the Video studio.');
      return;
    }
    if (s.uploadedImageUrls.length >= s.maxImages) {
      toast.error(`All ${s.maxImages} reference slots are used.`);
      return;
    }
    s.composerAttaching = true;
    bump();
    try {
      const url = await promoteOutputToReference(payload.url);
      handlePickerChange([...s.uploadedImageUrls, url]);
      toast.success('Attached as a reference image.');
    } catch (err) {
      console.error('[ImageStudio] composer output drop failed:', err);
      toast.error(err?.message || 'Could not attach that.');
    } finally {
      s.composerAttaching = false;
      bump();
    }
  };

  const composerDrop = {
    busy: s.composerAttaching,
    // An UploadPicker inside the composer keeps its own drop; without this the
    // file would be attached twice, once by each.
    accepts: (dataTransfer, target) => dragCarriesDroppable(dataTransfer)
      && !target?.closest?.('[data-upload-picker]'),
    hint: () => (refsSupported
      ? 'Attach as a reference image'
      : 'This model takes no reference images'),
    onDrop: (dataTransfer) => {
      const files = Array.from(dataTransfer?.files || []);
      if (files.length) { void handleComposerFiles(files); return; }
      const payload = droppedOutputPayload(dataTransfer);
      if (payload) void handleComposerOutput(payload);
    },
  };

  const composer = (
    <ImageComposer
      engine={s}
      bump={bump}
      persist={persistImagePreferences}
      promptRef={promptRef}
      setPromptValue={setPromptValue}
      refsSupported={refsSupported}
      refsIgnored={refsIgnored}
      refCount={refCount}
      referenceLabelStyle={referenceLabelStyleFor(s.useLocalModel ? s.selectedLocalModel : s.selectedModel)}
      uploadFn={fileToDataUrl}
      requireApiKey={() => false}
      onPickerChange={handlePickerChange}
      onClearReferences={clearReferences}
      onApplyRoles={applyRoles}
      helper={helper}
      onRunWorkflowHelper={runPromptHelper}
      onClosePromptHelper={closePromptHelper}
      onUsePromptHelperResult={usePromptHelperResult}
      modelLabel={modelLabel}
      onSelectLocalModel={selectLocalModel}
      onSelectApiModel={selectApiModel}
      captureContext={() => captureImageContext(s.prompt)}
      onRestoreContext={(context) => restoreImageContext(context)}
      onApplyUgc={applyUgc}
      cameraRig={s.cameraRig}
      cameraArmed={hasCameraRig(s.prompt)}
      cameraMenuOpen={s.cameraMenuOpen}
      onCameraMenuOpenChange={(open) => { s.cameraMenuOpen = open; bump(); }}
      onCameraChange={setCameraRig}
      onArmCamera={applyCamera}
      ugcArmed={hasUgcFirstFrame(s.prompt)}
      ugcVerticalAvailable={ugcVerticalAvailable()}
      coupleOn={coupleOn}
      promptPlaceholder={promptPlaceholder}
      generateLabel={generateLabel}
      generateBlocked={generateBlocked}
      generateTitle={offlineBlocked
        ? offlineReason
        : rentedBlocked
          ? 'Rent a machine (or switch the source to Local) to generate.'
          : (localBlockedReason || t('image.generateTooltip'))}
      etaLabel={etaLabel}
      onGenerate={generate}
      onCancel={cancelGeneration}
      onNewPrompt={newPrompt}
    />
  );

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <StudioLayout panel={panel} panelTitle={zh() ? '图像设置' : 'Image settings'} composer={composer} composerDrop={composerDrop}>
        <div className="flex flex-col gap-4 p-4 md:p-5">
          {/* The last failure stays on the canvas until dismissed or the next
              run — one sentence, the button that repairs it, and the raw text
              behind Details. Nothing toasts beside it (DESIGN.md §4). */}
          {s.generateError ? (
            <FailureCallout
              title={s.generateError}
              detail={s.generateFailure?.detail || ''}
              remedy={s.generateFailure?.remedy || null}
              onRemedy={(remedy) => void runFailureRemedy(remedy, {
                onMuapiKey: () => { authRetryRef.current = () => generate(); s.authOpen = true; bump(); },
                onLowerResolution: lowerResolution,
                onRetry: () => { s.generateError = ''; s.generateFailure = null; bump(); void generate(); },
              })}
              onRetry={generate}
              retryDisabled={s.generating || generateBlocked}
              retryLabel={zh() ? '重试' : 'Try again'}
              detailsLabel={zh() ? '详情' : 'Details'}
              onDismiss={() => { s.generateError = ''; s.generateFailure = null; bump(); }}
              dismissLabel={zh() ? '关闭' : 'Dismiss'}
            />
          ) : null}

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
                <ProgressBar value={pct} label={zh() ? '生成进度' : 'Generation progress'} />
                <div className="flex items-center justify-between gap-3 font-mono text-[11px] text-ink3">
                  {/* The bridge's status text lives here, not on the Generate button. */}
                  <span className="min-w-0 truncate">
                    {s.localProgress.label || (s.useLocalModel ? `local:${s.selectedLocalModel}` : (s.selectedModelName || s.selectedModel))}
                  </span>
                  <span className="shrink-0">
                    {formatElapsed(Date.now() - s.generationStartedAt)}{eta ? ` / ~${eta}` : ''}
                  </span>
                </div>
              </Card>
            );
          })() : null}

          {s.history.length === 0 && !s.generating ? (
            <EmptyState
              icon="image"
              title={zh() ? '还没有图像' : 'Nothing here yet'}
              hint={zh()
                ? '在下方输入提示词并点击生成。之前的作品都在作品库里。'
                : 'Describe the image below and press Generate. Everything you have made before is in the Library.'}
              action={(
                <Button
                  size="sm"
                  variant="neutral"
                  icon="history"
                  onClick={() => window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'history' } }))}
                >
                  {zh() ? '打开作品库' : 'Open Library'}
                </Button>
              )}
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
                    onDownload={() => {
                      // No `|| idx` fallback: the seal keys off entry.id, so an index
                      // would name the file something the vault never recorded — and
                      // idx shifts as new generations arrive, so it isn't even stable
                      // for the same output.
                      downloadImage(entry.url, imageDownloadName(entry.model, entry.id));
                    }}
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
          // Walk the gallery from the viewer. The grid reads newest-first, so
          // "previous" is the newer neighbour (left) and "next" the older (right).
          position={viewerIndex >= 0 ? { index: viewerIndex, total: s.history.length } : null}
          onPrev={viewerIndex > 0 ? () => viewImage(s.history[viewerIndex - 1].url) : undefined}
          onNext={viewerIndex >= 0 && viewerIndex < s.history.length - 1 ? () => viewImage(s.history[viewerIndex + 1].url) : undefined}
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
            downloadImage(s.viewerUrl, imageDownloadName(entry?.model, entry?.id));
          }}
          onPostToCivitai={() => {
            // Resources come from the context captured for THIS output, not the
            // panel's current selection — a public post must not credit a LoRA
            // that had nothing to do with the picture.
            const made = s.contextStore.recall(s.viewerUrl);
            s.civitaiPost = {
              url: s.viewerUrl,
              entry: { ...viewerEntry, civitaiResources: civitaiResourcesFromLoras(made?.loras, s.availableLoras) },
            };
            bump();
          }}
          onUpscale={isLocalAIAvailable() ? (mode) => upscaleEntry(viewerEntry, mode) : undefined}
          onCompare={viewerEntry?.sourceUrl ? () => { s.compareEntry = viewerEntry; bump(); } : undefined}
          onExpand={isLocalAIAvailable() && krea2LocalModel() && viewerEntry
            ? () => { s.expandEntry = viewerEntry; bump(); }
            : undefined}
          onInpaint={isLocalAIAvailable() && krea2LocalModel() && viewerEntry
            ? () => { s.inpaintEntry = viewerEntry; bump(); }
            : undefined}
          onAngles={isLocalAIAvailable() && angleEditModel() && viewerEntry
            ? () => { s.angleEntry = viewerEntry; bump(); }
            : undefined}
          onSequence={isLocalAIAvailable() && angleEditModel() && viewerEntry
            ? () => { s.sequenceEntry = viewerEntry; bump(); }
            : undefined}
          onUseAsVideoFrame={() => void sendToVideoStartFrame(s.viewerUrl)}
          videoFrameBusy={s.sendingToVideo}
        />
      ) : null}

      {s.compareEntry ? (
        <CompareViewer
          beforeUrl={s.compareEntry.sourceUrl}
          afterUrl={s.compareEntry.url}
          // Expansions, masked edits, angles and steps all pair with a source
          // now — only actual upscales should say "Upscaled".
          afterLabel={/upscaled/i.test(s.compareEntry.model || '') ? 'Upscaled' : 'Result'}
          onClose={() => { s.compareEntry = null; bump(); }}
        />
      ) : null}

      {s.civitaiPost ? (
        <Suspense fallback={<DialogLoading />}>
          <CivitaiPostDialogLazy
            url={s.civitaiPost.url}
            entry={s.civitaiPost.entry}
            filename={imageDownloadName(s.civitaiPost.entry?.model, s.civitaiPost.entry?.id)}
            onClose={() => { s.civitaiPost = null; bump(); }}
          />
        </Suspense>
      ) : null}

      {s.expandEntry ? (
        <ExpandDialog
          entry={s.expandEntry}
          busy={s.expandBusy}
          onClose={() => { s.expandEntry = null; bump(); }}
          onExpand={(target) => void runExpand(s.expandEntry, target)}
        />
      ) : null}

      {s.inpaintEntry ? (
        <MaskEditorDialog
          entry={s.inpaintEntry}
          busy={s.inpaintBusy}
          onClose={() => { s.inpaintEntry = null; bump(); }}
          onSubmit={(mask) => void runInpaint(s.inpaintEntry, mask)}
          onSmartSelect={isLocalAIAvailable() ? (request) => smartSelectMask(s.inpaintEntry, request) : undefined}
        />
      ) : null}

      {s.angleEntry ? (
        <AngleVariationsDialog
          entry={s.angleEntry}
          modelName={angleEditModel()?.name || 'the edit model'}
          busy={s.angleBusy}
          progress={s.angleProgress}
          onClose={() => {
            // While running, "Cancel" means stop after the current shot.
            if (s.angleBusy) { s.angleStop = true; }
            else { s.angleEntry = null; }
            bump();
          }}
          onRun={(config) => void runAngleVariations(s.angleEntry, config)}
        />
      ) : null}

      {s.sequenceEntry ? (
        <SequenceEditDialog
          entry={s.sequenceEntry}
          modelName={angleEditModel()?.name || 'the edit model'}
          busy={s.sequenceBusy}
          progress={s.sequenceProgress}
          onClose={() => {
            if (s.sequenceBusy) { s.sequenceStop = true; }
            else { s.sequenceEntry = null; }
            bump();
          }}
          onRun={(config) => void runEditSequence(s.sequenceEntry, config)}
        />
      ) : null}

      {s.cloudRefConfirm ? (
        <ConfirmModal
          open
          title="Send this reference to the cloud?"
          confirmLabel="Upload and generate"
          body={`${s.cloudRefConfirm.sources.length === 1
            ? 'Your reference image is'
            : `${s.cloudRefConfirm.sources.length} of your reference images are`} encrypted on this Mac. ${s.cloudRefConfirm.model} runs in the cloud and reads references by URL, so continuing uploads a decrypted copy to MUAPI — those bytes leave your machine and are out of your control. Local workflows never do this.`}
          onClose={() => { s.cloudRefConfirm = null; bump(); }}
          onConfirm={() => {
            s.cloudRefConfirm.sources.forEach((source) => s.cloudRefApproved.add(source));
            s.cloudRefConfirm = null;
            bump();
            void generate();
          }}
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

      {/* Gated on the flag rather than handed `open={false}`: the dialog already
          rendered nothing while shut, and this keeps its chunk out of the
          landing payload entirely. */}
      {s.localPromptHelperOpen ? (
        <Suspense fallback={<DialogLoading />}>
          <PromptHelperDialogLazy
            open
            onClose={() => { s.localPromptHelperOpen = false; bump(); }}
            idea={s.prompt}
            targetModel={s.useLocalModel ? s.selectedLocalModel : s.selectedModel}
            mediaType="image"
            // UGC first frames are judged on looking un-produced, which is the
            // opposite of what the default image guidance optimises for.
            ugc={hasUgcFirstFrame(s.prompt)}
            onUse={(prompt) => { setPromptValue(prompt); persistImagePreferences(); }}
          />
        </Suspense>
      ) : null}

      {s.civitaiOpen ? (
        <Suspense fallback={<DialogLoading />}>
          <CivitaiDownloadDialogLazy
            api={localAI}
            onComplete={finishLoraDownload}
            // The progress lives on a card in the LoRA grid, so open the panel it is in.
            onStarted={() => {
              if (!s.loraOpen) { s.loraOpen = true; void loadLorasForCurrentModel(); }
              bump();
            }}
            onClose={() => { s.civitaiOpen = false; bump(); }}
          />
        </Suspense>
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

