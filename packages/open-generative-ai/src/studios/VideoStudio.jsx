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
import { localRow, muapiKeyMissing, muapiRow, runVideo, studioRow } from '../lib/modelRunner.js';
import { describeFailure } from '../lib/describeFailure.js';
import { runFailureRemedy } from '../lib/failureRemedy.js';
import { toastFailure } from '../ui/failureToast.jsx';
import { localAI, isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { fitShotTimeline } from '../lib/shotTimeline.js';
import { isWan2gpModelId } from '../lib/localModels.js';
import { RENTED_CHANGED_EVENT, consumeRentedModeRequest, rentedMachinesState, servedByAnyMachine } from '../lib/rentedMachines.js';
import { RentedSourceStatus } from './RentedSourceStatus.jsx';
import { startCivitaiDownload } from '../lib/civitaiDownloadStore.js';
import { loraGenerationPayload, mergeLoraUpdates, replaceLoraInSelection, toggleLoraEnabled, toggleLoraSelection, updateLoraStrength } from '../lib/loraSelection.js';
import { createGenerationContextStore } from '../lib/generationContext.js';
import { applyCameraMotionPrompt, cameraMotionIdsInPrompt, cameraMotionPhrase, normalizeCameraMotions } from '../lib/cameraMotion.js';
import { CameraMotionMenu } from './video/CameraMotionMenu.jsx';
import { applyRestylePrompt } from '../lib/h3RestylePresets.js';
import { RestyleMenu } from './video/RestyleMenu.jsx';
import { CastStrip } from './video/CastStrip.jsx';
import {
  castPersonaIdentity, castRenderGender, castRows, castSubjects, isWovenForReference,
  reconcileCast, sceneMember, toCastMember, weavePrompt, weaveTarget,
} from '../lib/promptWeave.js';
import { allocateCast } from '../lib/castPrompt.js';
import { liveStandIns } from '../lib/subjectTemplate.js';
import { publishSendTarget } from '../lib/studioTargets.js';
import { videoSourceDescriptors } from './video/videoSendTargets.js';
import { VIDEO_TAB_FIELDS, cloneTabValue, snapshotTabFields } from '../lib/studioTabs.js';
import { createStudioGenerationQueue } from '../lib/studioGenerationQueue.js';
import { resolveMediaSrc } from '../lib/e2eMedia.js';
import { peekMediaDuration } from '../lib/mediaDuration.js';
import { CivitaiPostDialog } from '../components/CivitaiPostDialog.jsx';
import { civitaiResourcesFromLoras } from '../lib/civitaiPost.js';
import { downloadMedia } from '../lib/downloadMedia.js';
// joinClips itself is imported dynamically inside joinChainFrom — it carries
// mediabunny, which should not weigh down the studio chunk until a join runs.
import { collectChainClips, missingChainParent } from '../lib/chainLineage.js';
import { chainKey, chainTimelineModel } from '../lib/chainTimeline.js';
import { ChainTimeline } from './video/ChainTimeline.jsx';
import { TIMELINE_SEGMENT_DRAG_TYPE, TimelineStrip } from './video/TimelineStrip.jsx';
import {
  addTimelineSegment, captureIntoTimeline, filledTimelineSegments, fillTimelineSegment,
  insertTimelineSegment, loadTimelineState, moveTimelineSegment, newTimelineSegment,
  openTimeline, removeTimelineSegment, saveTimelineState, timelineCanCombine,
  timelineCombineKey, timelineContinuationPlan, timelineDropPlan,
} from '../lib/videoTimeline.js';
import { ShotBuilderChip, ShotBuilderDialog, blankTimeline } from './video/ShotBuilder.jsx';
import { PromptCheckMenu } from './video/PromptCheckMenu.jsx';
import { armChainPrompt } from '../lib/chainPrompt.js';
import { personaIdentity } from '../lib/personaId.js';
import { applyUgcVideoBrief, hasUgcVideoBrief, ugcSubjectLabel, ugcVariantAt } from '../lib/ugcMode.js';
import { UgcMenu } from './UgcMenu.jsx';
import { restoredHistoryEntry } from '../lib/restoredOutput.js';
import {
  savePendingJob, removePendingJob, getPendingJobs, pendingJobsForTab,
} from '../lib/pendingJobs.js';
import { videoDownloadName } from '../lib/downloadNames.js';
import {
  isCompletionPingEnabled, setCompletionPingEnabled, subscribeCompletionPing,
  primeCompletionPing, playCompletionPing,
} from '../lib/completionPing.js';
import {
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
  inpaintWorkflowForHivemindModel,
  selectableHivemindModelId,
  saveStudioGenerationHistory,
  uploadFileToHivemindStudio,
  workflowIdFromHivemindModelId, mediaSourceToDataUrl } from '../lib/hivemindStudio.js';
import { t, tf, aspectRatioName } from '../lib/i18n.js';

import { registerPromptInserter, registerStudioSetupLoader } from '../app/promptTarget.js';
import { useApiStatus } from '../app/statusStore.js';
import { basenameOf, rememberGenerationSetup } from '../lib/generationSetupStore.js';
import { getComposerSection, hydrateComposerState, updateComposerSection } from '../lib/composerState.js';
import { useMediaPoster, useMediaSrc } from '../hooks/hooks.js';
import { Icon } from '../ui/icons.jsx';
import {
  AspectRatioPicker, Button, Card, CollapsibleSection, EmptyState, FailureCallout, Field, IconButton,
  NativeSelect, Pill, ProgressBar, SectionLabel, Segmented, Slider, Spinner, TextArea, TextInput,
  Toggle, cx,
} from '../ui/kit.jsx';
import { ChipButton, Menu, MenuHeading, MenuItem } from '../ui/Menu.jsx';
import { ConfirmModal } from '../ui/Modal.jsx';
import { StudioLayout } from '../ui/kit.jsx';

import { UploadPicker } from './UploadPicker.jsx';
import { FrameSlotsPicker } from './video/FrameSlotsPicker.jsx';
import { ReferencesMenu } from './video/ReferencesMenu.jsx';
import { VideoInpaintDialog } from '../dialogs/VideoInpaintDialog.jsx';
import {
  composerFrameHint, composerReferenceHint, describeReferenceAttachment, describeReferenceRejection,
} from './video/referenceKinds.js';
import { AuthModal } from '../dialogs/AuthModal.jsx';
import { CivitaiDownloadDialog } from '../dialogs/CivitaiDownloadDialog.jsx';
import {
  referenceKindForFile,
  referenceKindsInDrag,
  referenceUrl,
} from '../lib/h3References.js';
import { promoteOutputToReference } from '../lib/outputToReference.js';
import {
  attachDroppedReferences,
  dragCarriesDroppable,
  droppedOutputPayload,
  referenceKindForOutput,
  referenceUploader,
} from '../lib/referenceDrop.js';
import { PromptHelperDialog } from '../dialogs/PromptHelperDialog.jsx';
import { LoraSection } from './image/LoraSection.jsx';
import { SavedPromptsMenu } from './SavedPromptsMenu.jsx';
import { IngredientsPanel } from './video/IngredientsPanel.jsx';

import {
  VIDEO_PREFERENCES_KEY, zh,
  buildCatalogs, buildInitialSetup, adaptHivemindToVideoEntry, isLocalVideoModel, v2vModels,
  currentModel, generationModelsFor, resolveVideoModel, withSelectedModel,
  currentIngredientModel, frameSlotsVisible, activeIngredientSheetItems, ingredientSelectionSignature,
  getIngredientsWorkflow,
  isMotionControlV2V, isHivemindVideoInputMode,
  activeVideoTask, headSwapReadiness, isLtxFamilyModel, isMinimaxFamilyModel, slotLabelsFor,
  sourceVideoSwitchCost, videoRequestPlan, videoTasksFor,
  aspectRatiosFor, durationsFor, resolutionsFor, modesFor, qualitiesFor, effectNamesFor,
  motionReferenceLimitFor, availableDurationsFor, clampDurationToMotionReference, probeVideoDurationSeconds,
  deriveControlVisibility, deriveExtendBanner, derivePromptUi,
  applyRestoredPreferences, applyGenerationContext, restylePresetIdInPrompt,
  startFrameSelectedTransition, startFrameClearedTransition, clearVideoUploadTransition,
  videoUploadedTransition, selectV2VModelTransition, selectRegularModelTransition,
  selectHivemindWorkflowTransition, newPromptTransition, extendTransition, withServedModel,
  getAdvancedVideoInputs, getAdvancedVideoPayload,
  normalizeVideoPreferences, normalizeVideoIngredientSelections, normalizeSelectedVideoIngredientSheet,
  normalizeVideoGenerationProgress, normalizeSamplerSteps, classifyVideoGenerationStage, formatVideoGenerationElapsed,
  computeSmoothProgress, supportsSpectrum, supportsFastHighRes, supportsQualitySteps,
  closestVideoAspectRatio, imageDimensions, redactPrivateHistoryEntry,
  groupModelTiers, activeTierFor, tierPairFor, servingMachineFor,
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

// `unmuted` — the clip reached the canvas through a user gesture (a strip
// click, Regenerate, a timeline pick), so it may play with sound; a clip that
// lands on its own (a finished generation, a restore) stays muted, which is
// what autoplay policy allows. H3 renders dialogue and soundscape, and a
// result that always started silent gave no cue that there was any.
function ResultVideo({ url, unmuted = false, hasAudio = false }) {
  const src = useMediaSrc(url);
  return (
    <div className="relative">
      <video
        src={src}
        controls controlsList="nodownload"
        loop
        autoPlay
        muted={!unmuted}
        playsInline
        className="max-h-[58vh] w-auto max-w-full rounded-lg border border-line1 bg-bg0 object-contain"
      />
      {hasAudio ? (
        <Pill tone="neutral" className="pointer-events-none absolute left-2 top-2 gap-1 bg-bg0/80">
          <Icon name="sound" size={11} />
          {zh() ? '有声' : 'Sound'}
        </Pill>
      ) : null}
    </div>
  );
}

// Strip tiles draw ONE decoded frame as an <img> (useMediaPoster), not a <video>
// per entry: thirty live media elements each holding a decoder for a 200px
// tile, and the frame re-decoded on every remount, was the cost of the old
// way. The clip itself is decrypted once (cached) and reused when it goes on
// the canvas.
function HistoryThumb({ url }) {
  const { poster, resolved, pending } = useMediaPoster(url, { kind: 'video' });
  if (poster) return <img src={poster} alt="" className="aspect-video w-full bg-bg0 object-contain" />;
  if (!resolved || pending) return <div className="aspect-video w-full animate-pulse bg-bg2" aria-label={zh() ? '解密中' : 'Decrypting'} />;
  return (
    <div className="grid aspect-video w-full place-items-center bg-bg0 text-ink3">
      <Icon name="film" size={18} />
    </div>
  );
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
    // The same failure, read: { title, detail, remedy } from describeFailure.
    // The sentence stays the server's (it is already sanitized); what this adds
    // is the button beside it and the raw tail behind Details.
    generateFailure: null,
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
    // Request id of the in-flight CLOUD (muapi) job, for the same reason: Cancel
    // has to drop its pending-job record, or a reload resumes a run the user
    // already gave up on.
    activeCloudRequestId: null,
    // AbortController for the in-flight generation poll — the Cancel button aborts
    // it to stop polling immediately (independent of the backend interrupt).
    abortController: null,
    resultUrl: null,
    resultModel: null,
    // The concrete seed used by the most recent generation (for display/lock).
    lastSeed: null,
    // history + dialogs
    generationHistory: loadStudioGenerationHistory('video_history').map(redactPrivateHistoryEntry),
    // A file dropped on the composer is uploading into a reference slot. The
    // composer's own overlay reports it — a 100 MB clip going up in silence
    // reads as a drop that did nothing.
    composerAttaching: false,
    authOpen: false,
    authRetry: null,
    civitaiOpen: false,
    // Posting a finished CLIP to Civitai — unrelated to civitaiOpen above,
    // which is the LoRA downloader.
    civitaiPost: null,
    promptHelperOpen: false,
    // Head replacement: which attached motion clip has its dialog open.
    inpaintOpenIndex: null,
    resumeRemaining: 0,
    deleteTarget: null,
    // A pending "attach this clip?" question: { lines, resolve } while the
    // ConfirmModal is up (confirmSourceVideoSwitch), else null.
    sourceSwitchConfirm: null,
    persistTimer: null,
    // A History "Load in Studio" that arrived before the workflow catalog did,
    // held until the catalog can resolve its model.
    pendingRestore: null,
    // A Story production waiting for the workflow catalog to name its model.
    pendingStory: null,
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
    // The MANUAL timeline (lib/videoTimeline.js): the strip of segment cards
    // the Timeline button opens. Segments + toggles survive a reload per tab
    // (sessionStorage, hydrated in a mount effect); the built cut is an object
    // URL and is rebuilt instead of persisted. Not in VIDEO_TAB_FIELDS on
    // purpose — like the strip, it is run state a duplicated tab starts without.
    timelineOn: false,
    timelineSegments: [],
    timelineSelectedId: '',
    timelineExtend: false,
    timelineShowCombined: false,
    timelineCombined: null,
    timelineBuilding: false,
    timelineBuildError: '',
    timelineBuildTimer: null,
    // Cut keys already stored as an output (localAI.saveEpisode), so viewing
    // or exporting the same cut twice does not file two copies.
    timelineSavedKeys: [],
    timelineDeleteTarget: null,
    timelineReplaceTarget: null,
    // What Auto-continue armed, so turning it off disarms only what IT did —
    // never a chain or start frame the user set by hand.
    timelineArmedChainUrl: '',
    timelineSeededFrame: '',
    // Who is in the shot. Held HERE rather than inside the Cast menu because a
    // prompt loaded from the library has to be recast on its way into the
    // composer, and a menu that only remembers its members while it is open
    // cannot do that — which is how a fight loaded over a cast kept addressing
    // the cast it was saved with.
    cast: [],
    castWarnings: [],
    // Transient: which member the media being attached right now belongs to.
    claimNewFor: '',
    // The stand-ins of the prompt in the composer — which words of a loaded
    // starter are the person it was written about (subjectTemplate.js), kept
    // until a cast member takes their place. Persisted with the prompt in the
    // encrypted composer draft; never in the plaintext settings store.
    standIns: [],
    // The shot timeline inside ONE generation — cuts, camera, timed beats and
    // dialogue. Held here rather than in the dialog for the same reason the
    // cast is: a builder that forgot its shots every time it closed would be a
    // scratchpad, not a timeline.
    shotTimeline: blankTimeline(),
    shotBuilderOpen: false,
  };

  // A duplicate overlays the source tab's configuration on top of the defaults.
  // The snapshot was already deep-copied at capture; copying again keeps a tab
  // duplicated twice from sharing objects with its sibling.
  if (boot === 'clone' && snapshot) Object.assign(engine, cloneTabValue(snapshot));
  return engine;
}

export function VideoStudio({
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
  const mountedRef = useRef(true);
  const bump = () => { if (mountedRef.current) setTick((n) => n + 1); };
  // One shared verdict on whether the studio is up (topbar pill, canvas banner,
  // this button) instead of each lane discovering it when a press fails.
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

  // Set when a handoff was claimed before any machine list had arrived, so the
  // model could not be re-pointed yet; the next sync with machines finishes it.
  const reconcileRentedModelRef = useRef(false);

  // "Use in Video Studio" is a one-shot handoff from the Machines view. Only the
  // front tab may claim it, or whichever background tab looked first would
  // swallow it.
  //
  // Claimed the moment it can be — on mount, on the Machines view's announcement,
  // and when this tab comes to the front. It used to be consumed inside the
  // rented-state poll's callback, which made the switch wait on a network
  // round-trip, and made a missed pass wait a whole poll interval for the next
  // one. That is the ~30 seconds of apparently doing nothing before the studio
  // switched itself to Rented.
  //
  // setLocalMode, not a raw commit of the flags: it is the same function the
  // source picker calls, and the part a raw commit skipped is the part that
  // lands on a model the machine can actually run. Skipping it is why the
  // handoff arrived in Rented mode still pointed at a cloud model.
  const claimRentedHandoff = () => {
    if (!tabActiveRef.current || !consumeRentedModeRequest('video')) return;
    // setLocalMode re-points the model itself when it can. It cannot yet if the
    // machine list or the local catalogue has not arrived — both are fetched,
    // both land after mount, and in no fixed order — so mark the handoff
    // unfinished and let finishRentedHandoff close it out on their arrival.
    reconcileRentedModelRef.current = true;
    setLocalMode(true, true);
    finishRentedHandoff();
  };

  // The other half of the handoff: land on a model the machine can actually run.
  // Called on every arrival that could make the answer knowable, and gives up
  // its claim only once it has really decided — an early attempt against an
  // empty catalogue used to clear the flag and leave the studio on the cloud
  // model it opened with.
  const finishRentedHandoff = () => {
    if (!reconcileRentedModelRef.current) return;
    if (!s.rentedMachines?.length || !s.catalogs.hivemindI2V?.length) return;
    reconcileRentedModelRef.current = false;
    const next = withServedModel(s.setup, s.rentedMachines, s.catalogs);
    // Persisted, unlike the old raw commit: this is the completion of a switch
    // the user made, and a reload should not undo half of it.
    if (next !== s.setup) commit(next);
  };

  // Rented source mode: keep attached-machine state fresh while mounted and
  // honor the one-shot "open in Rented" handoff from the Machines view.
  useEffect(() => {
    let alive = true;
    let timer = null;
    const schedule = (pending) => {
      // Watch a provisioning machine closely so "Ready" lands on its own.
      const wanted = pending ? 8000 : 30000;
      if (timer?.every !== wanted) {
        if (timer) clearInterval(timer.id);
        timer = { every: wanted, id: setInterval(() => sync(false), wanted) };
      }
    };
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
      // The card a run lands on decides the motion-reference budget (the
      // picker prices against this tab's pin, else the routing leader), so a
      // machine change re-clamps the duration exactly like a setup change.
      s.setup = withDurationThatFits(s.setup);
      schedule(state.pending.length);
      // A handoff claimed before the machine list existed could not pick a
      // model then. Finish it now there is one to pick from.
      finishRentedHandoff();
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
    window.addEventListener(RENTED_CHANGED_EVENT, onChanged);
    return () => {
      alive = false;
      if (timer) clearInterval(timer.id);
      window.removeEventListener(RENTED_CHANGED_EVENT, onChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A tab that becomes the front one inherits a handoff nobody could claim
  // while it was in the background.
  useEffect(() => {
    if (tabActive) claimRentedHandoff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabActive]);

  const rootRef = useRef(null);
  const promptRef = useRef(null);
  const videoFileInputRef = useRef(null);
  const mountedOnceRef = useRef(false);
  const registryRetryRef = useRef(null);

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
    rentedMachineId: s.setup.rentedMachineId || '',
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
    fastHighRes: s.setup.fastHighRes,
    motionContextUrl: s.setup.motionContextUrl,
    motionContextIndex: s.setup.motionContextIndex,
    // Advanced / Task settings. normalizeVideoPreferences already had fields
    // for these; nothing wrote them, so they reset on every reload.
    spectrum: s.setup.spectrum,
    nagScale: s.setup.nagScale,
    detailerStrength: s.setup.detailerStrength,
    videoTask: s.setup.videoTask,
    headSwapBackend: s.setup.headSwapBackend,
    headSwapFaceEnhancer: s.setup.headSwapFaceEnhancer,
    headSwapLoraStrength: s.setup.headSwapLoraStrength,
    // Selections only (ids) — the phrases live with the prompt, encrypted.
    cameraMotionIds: s.setup.cameraMotionIds,
    restylePresetId: s.setup.restylePresetId,
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

  // A motion reference collapses the duration range — it is trimmed to the
  // clip's own length, so it costs more the longer the clip is. Whenever the
  // canvas or the references change, pull the selected duration back onto what
  // can actually render: a 10s chosen before the reference was attached would
  // otherwise survive silently and die on the card minutes into the run.
  // Said out loud wherever it happens: refitting edits the user's own words, so
  // it may never be silent. The alternative — leaving it — is a beat that
  // disappears with no message at all, which is what happened before.
  const announceRefit = (fitted) => {
    toast(zh()
      ? `已按 ${fitted.to}秒 重新排布 ${fitted.moved.length} 个镜头的时间点（原脚本约 ${Math.round(fitted.from)}秒）。`
      : `Re-timed ${fitted.moved.length} shots to fit ${fitted.to}s — the prompt was written for about ${Math.round(fitted.from)}s.`);
  };

  // A prompt arriving WHOLE from somewhere that is not the keyboard — a starter,
  // a saved library entry, the Shot Builder, the hub's insert bridge, a canvas
  // restore. Every one of these is written against a length of its own and lands
  // in a composer whose length was decided by something else: the H3 starters are
  // fixed 15s scripts (00:00 / 00:05 / 00:10), and attaching references caps the
  // clip at 10s, so the third beat arrives already past the end. Refit on the way
  // IN — accepting a prompt is the moment the user expects it to change.
  //
  // Deliberately NOT on setPrompt: that also runs on every keystroke, and
  // re-timing mid-edit would fight someone typing a timestamp.
  const adoptPrompt = (text) => {
    const fitted = fitShotTimeline(text, Number(s.setup.duration) || 0);
    if (fitted.changed) announceRefit(fitted);
    return fitted.prompt;
  };

  /* ---------------- the weave ---------------- */
  //
  // One rule for every door into the composer — see lib/promptWeave.js. Who is
  // in the shot is DERIVED from what is attached (reconcileCast): whoever is in
  // your references is <Subject 1> without a menu, a loaded Persona ID names
  // them, a picked character joins them. Weaving recasts the prompt onto that
  // cast, binds a loaded starter's stand-in, writes the rows the cast occupies
  // and re-times the shots to the run's length — in one pass, from every door.
  const isH3 = () => /minimax-h3/.test(s.setup.modelId || '');
  const referenceLaneEntry = () => (isHivemindVideoModelId(s.setup.modelId)
    ? referenceWorkflowForHivemindModel(s.setup.modelId)
    : null);
  // Whether this FAMILY has a reference lane. The catalog entry is the
  // authority when it is live, but the catalog loads late and degrades — and
  // H3 always has its reference sibling — so the family answers when the
  // registry cannot. Gating on the entry alone told a user with seven pictures
  // attached that "pictures cannot join" (2026-08-24), and quietly wove in the
  // wrong grammar until the catalog arrived; videoRequestPlan routes reference
  // mode by FAMILY, so this must agree with it.
  const referenceLaneAvailable = () => Boolean(referenceLaneEntry()) || isH3();
  const weaveLimits = () => {
    const entry = referenceLaneEntry();
    return {
      images: entry?.referenceSlots?.images || 9,
      audios: entry?.referenceSlots?.audios || 3,
      videos: entry?.referenceSlots?.videos || 3,
    };
  };
  const currentRows = () => ({
    images: Array.isArray(s.setup.referenceImageUrls) ? s.setup.referenceImageUrls : [],
    videos: Array.isArray(s.setup.referenceVideos) ? s.setup.referenceVideos : [],
    audios: Array.isArray(s.setup.referenceAudios) ? s.setup.referenceAudios : [],
  });
  const weaveTargetNow = () => weaveTarget({
    h3: isH3(), referenceLane: referenceLaneAvailable(), rows: currentRows(),
  });
  const syncCast = () => {
    s.cast = reconcileCast(s.cast, currentRows(), {
      persona: s.setup.persona,
      // Who newly attached media is FOR — set only around a member chip's
      // "+ Pictures / clip / voice" flow, consumed by this reconcile.
      claimNew: s.claimNewFor || '',
    });
    return s.cast;
  };
  // The cast and the stand-ins persist WITH the prompt, in the encrypted
  // composer draft — a persona's name is sealed to the owner's vault and the
  // plaintext settings store must never learn it.
  const rememberCast = () => updateComposerDraft({ cast: s.cast, standIns: s.standIns });
  const setRows = (rows) => {
    s.setup = withDurationThatFits({
      ...s.setup,
      referenceImageUrls: rows.images,
      referenceVideos: rows.videos,
      referenceAudios: rows.audios,
    });
  };
  const runWeave = (text, { standIns, scaffold = false, template = null } = {}) => weavePrompt(text, {
    cast: s.cast,
    limits: weaveLimits(),
    durationSeconds: Number(s.setup.duration) || 0,
    target: weaveTargetNow(),
    standIns: standIns === undefined ? s.standIns : standIns,
    scaffold,
    // A door that arrives with the creative half already broken out rather than
    // flattened into one paragraph — the Story studio. Ignored by every target
    // that is not the six-section form, which then renders `text` as it came.
    template,
  });
  // A snapshot the Undo on a weave toast restores.
  const weaveSnapshot = () => ({
    prompt: s.setup.prompt, cast: s.cast, standIns: s.standIns, rows: currentRows(), persona: s.setup.persona,
  });
  const restoreWeaveSnapshot = (snapshot) => {
    // "+ New" snapshots the whole setup (frames, clip, model) as well.
    if (snapshot.setup) s.setup = { ...snapshot.setup };
    s.cast = snapshot.cast;
    s.standIns = snapshot.standIns;
    setRows(snapshot.rows);
    s.setup = { ...s.setup, persona: snapshot.persona };
    setPrompt(snapshot.prompt);
    rememberCast();
  };
  const announceWeave = (message, snapshot) => {
    toast((instance) => (
      <span className="flex items-center gap-3">
        <span>{message}</span>
        <button
          type="button"
          className="font-semibold text-honey hover:underline"
          onClick={() => { restoreWeaveSnapshot(snapshot); toast.dismiss(instance.id); }}
        >
          {zh() ? '撤销' : 'Undo'}
        </button>
      </span>
    ), { duration: 7000 });
  };
  // A prompt arriving through ANY door — a starter, the library, the helper,
  // the Shot Builder, the hub's insert bridge, a canvas restore, the Weave
  // button, or the attach that changed who is in the shot. `standIns` rides
  // with a freshly rendered starter; undefined means "what the composer holds".
  const acceptPrompt = (text, { standIns, scaffold = false, announce = true, template = null } = {}) => {
    syncCast();
    const woven = runWeave(text, { standIns, scaffold, template });
    if (announce && woven.refit.changed) announceRefit(woven.refit);
    s.standIns = woven.standIns;
    s.castWarnings = woven.warnings;
    if (woven.rows) {
      setRows(woven.rows);
      // The rows only still ARE one saved character when the cast is that one
      // persona; anything else and the name would be a lie about what is loaded.
      s.setup = { ...s.setup, persona: personaIdentity(woven.persona) };
    }
    setPrompt(woven.prompt);
    rememberCast();
    return woven;
  };
  // Members changed — added, removed, reordered, restyled. Members carry their
  // own media, so the rows they occupy are written FIRST (the reconcile that
  // follows must see every member's references attached), then the prompt is
  // woven onto the new cast.
  const applyMembers = (next) => {
    s.cast = Array.isArray(next) ? next : [];
    if (referenceLaneEntry()) {
      const { images, videos, audios } = allocateCast(s.cast.map(toCastMember), { limits: weaveLimits() });
      setRows({ images, videos, audios });
    }
    return acceptPrompt(s.setup.prompt);
  };
  /**
   * A whole Story studio production, landed in one pass.
   *
   * The character sheets are the subjects, the location plate and the board are
   * scene references, and the beats, soundscape and music are the creative
   * half. All of it is written BEFORE the weave runs, because the weave picks
   * its grammar from what is attached: attach first and the six-section H3 form
   * follows on its own. Handing the script over with nothing attached — which
   * is what this handoff used to do — could only ever produce prose about
   * references that were not there.
   *
   * Returns what actually landed, so the caller can say so rather than claim an
   * attachment a model with no reference lane quietly refused.
   */
  const applyStoryProduction = (setup) => {
    const cast = Array.isArray(setup?.cast) ? setup.cast : [];
    const ingredients = Array.isArray(setup?.ingredients) ? setup.ingredients : [];
    const runSeconds = Number(setup?.seconds) || 0;
    // What this target can actually take, checked against the LIVE studio
    // rather than trusted from the handoff: the story wrote itself for the
    // model the Send-to picker was looking at, and nothing stops the model
    // changing in between.
    // The source the sender picked, applied through the same transition the
    // studio's own toggle uses — a raw flag flip would leave a model the source
    // does not serve, which is exactly how the Machines handoff once landed on
    // the wrong model (rented-handoff-claim-and-model).
    if (setup?.source && hasSourceToggle) {
      const wantsRented = setup.source === 'rented';
      const wantsLocal = setup.source !== 'api';
      if (wantsLocal !== Boolean(s.setup.localMode) || wantsRented !== Boolean(s.setup.rentedOnly)) {
        setLocalMode(wantsLocal, wantsRented);
      }
    }
    // …then the model the sender wrote FOR. A tab opened for the first time
    // boots into its own default, which is not what the picker was looking at:
    // the story arrived compiled for H3's reference lane and landed on a cloud
    // model with nowhere to put its pictures. Selected through the studio's own
    // transitions, never a raw modelId write, so the family gates that read
    // `modelFamily` cannot answer for the previous model.
    if (setup?.modelId && setup.modelId !== s.setup.modelId) {
      const wanted = resolveVideoModel(setup.modelId, s.catalogs);
      if (wanted) {
        if (isHivemindVideoModelId(wanted.id)) selectHiveModel(wanted);
        else selectRegularModel(wanted);
      } else if (!s.catalogs.hivemindI2V.length) {
        // The workflow catalog loads over the network and a first visit to this
        // studio navigates here the moment the sender has its payload, so the
        // production can arrive BEFORE the catalog it names a model from. Hold
        // it and land it again when the catalog does — the same race, and the
        // same cure, as a "Load in Studio" that outran its catalog.
        s.pendingStory = setup;
        return { attached: 0, wanted: 0, deferred: true };
      }
    }
    const referenceOk = referenceLaneAvailable();
    const ingredientsModel = currentIngredientModel(s.setup, s.catalogs);
    const next = { ...s.setup };
    if (runSeconds > 0) next.duration = runSeconds;
    if (setup?.aspect) next.ar = String(setup.aspect);
    // Only where the target reads one. Written before the weave so a refit sees
    // the finished setup.
    if (typeof setup?.negativePrompt === 'string') next.negativePrompt = setup.negativePrompt;
    s.setup = next;
    let attached = 0;
    if (referenceOk && cast.length) {
      s.cast = cast;
      const { images, videos, audios } = allocateCast(cast.map(toCastMember), { limits: weaveLimits() });
      setRows({ images, videos, audios });
      attached = images.length;
    } else if (ingredientsModel && ingredients.length) {
      // LTX stitches reference views into one sheet, and each view carries its
      // own caption — which is what a character sheet and its identity lines
      // already are.
      const max = ingredientsModel.ingredientInputs?.max_images || 12;
      s.sharedIngredientSelections = ingredients.slice(0, max).map((item) => ({ ...item }));
      s.selectedIngredientSheet = 'stitched';
      attached = s.sharedIngredientSelections.length;
    }
    // After the rows, never before: attaching references is what can cap the
    // clip, so a length set first is one the reference budget may refuse.
    s.setup = withDurationThatFits(s.setup);
    // The written prompt is the story in THIS target's grammar; the script is
    // the prose the Story page showed, kept as the last resort.
    const text = String(setup?.prompt || '').trim() || String(setup?.script || '');
    acceptPrompt(text, { template: referenceOk && cast.length ? (setup?.template || null) : null });
    persistVideoPreferences();
    return { attached, wanted: Number(setup?.counts?.pictures) || 0 };
  };
  /**
   * What this tab would run on each source, published for anything that wants
   * to send work here (lib/studioTargets.js).
   *
   * A mounted tab publishes its LIVE setup, which is the half the picker cannot
   * get from storage — this tab may have been switched to another model since
   * the last save, and a background tab never saves at all. The resolution
   * itself is shared with the unmounted case (video/videoSendTargets.js): two
   * answers to "which model would this source land on" is the drift that rule
   * exists to prevent.
   */
  const sendSignature = [
    tabIdRef.current, tabActive, s.setup.modelId, s.setup.localMode, s.setup.rentedOnly,
    (s.rentedMachines || []).length, (s.rentedIdle || []).length,
    (s.rentedBroken || []).length, (s.rentedProvisioning || []).length,
    (s.catalogs?.hivemindI2V || []).length, (s.catalogs?.allT2V || []).length,
  ].join('|');
  useEffect(() => {
    const sources = videoSourceDescriptors({
      setup: s.setup,
      catalogs: s.catalogs,
      machines: {
        live: s.rentedMachines || [],
        idle: s.rentedIdle || [],
        broken: s.rentedBroken || [],
        provisioning: s.rentedProvisioning || [],
      },
      hasSourceToggle: isLocalAIAvailable(),
      zh: zh(),
    });
    return publishSendTarget(`video:${tabIdRef.current}`, {
      section: 'video',
      tabId: tabIdRef.current,
      index: tabIdRef.current,
      label: `${zh() ? '标签' : 'Tab'} ${tabIdRef.current || 1}`,
      active: Boolean(tabActive),
      current: s.setup.rentedOnly ? 'rented' : s.setup.localMode ? 'local' : 'api',
      sources,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendSignature]);
  // The rows changed by hand — a file dropped, a row removed, a Persona ID
  // loaded. The cast follows, and a written prompt has the new cast woven in;
  // an empty composer waits for text (there is nothing to weave into yet).
  // "Draft from pictures" on a cast member: up to three of its pictures are
  // decrypted in the browser and shown to the loaded local helper, which
  // writes the look (hair, face, build, wardrobe). Only the bytes travel — never
  // the persona's name — and only to the loopback llama-server.
  const draftLookFor = async (member) => {
    const urls = (member?.data?.images || []).slice(0, 3);
    if (!urls.length) throw new Error(zh() ? '这位成员没有图片。' : 'This member has no pictures.');
    const images = (await Promise.all(urls.map((url) => mediaSourceToDataUrl(url, 'image').catch(() => null)))).filter(Boolean);
    if (!images.length) throw new Error(zh() ? '无法读取图片。' : 'Could not read the pictures.');
    const response = await fetch('/api/prompt-helper/describe-look', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, gender: member?.data?.gender || '' }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.detail || payload?.error || (zh() ? '助手没有返回外貌描述。' : 'The helper did not return a look.'));
    }
    return String(payload.look || '');
  };

  // "+ Pictures / + Motion clip / + Voice clip" on a member's chip: the files
  // go up the same way a composer drop does, but land CLAIMED for that member
  // — all three rows are written in ONE update so the claim covers the whole
  // batch, then the weave runs once.
  const attachFilesForMember = async (key, files) => {
    if (!files.length) return;
    if (frameRequiresApiKey() && muapiKeyMissing()) {
      s.authRetry = () => { void attachFilesForMember(key, files); };
      s.authOpen = true;
      bump();
      return;
    }
    s.composerAttaching = true;
    bump();
    try {
      const current = currentRows();
      const { added, rejected } = await attachDroppedReferences({
        files,
        taken: { images: current.images.length, videos: current.videos.length, audios: current.audios.length },
        limits: weaveLimits(),
        upload: referenceUploader(uploadFnForFrame),
      });
      for (const rejection of rejected) {
        if (rejection.error) console.error('[VideoStudio] member attach failed:', rejection.error);
        toast.error(describeReferenceRejection(rejection));
      }
      const total = added.images.length + added.videos.length + added.audios.length;
      if (total) {
        s.claimNewFor = key;
        s.setup = withDurationThatFits({
          ...s.setup,
          referenceImageUrls: [...current.images, ...added.images.map((item) => item.url)],
          referenceVideos: [...current.videos, ...added.videos.map((item) => ({ ...item, useAudio: false, compact: false }))],
          referenceAudios: [...current.audios, ...added.audios],
        });
        afterRowsChanged();
      }
    } catch (err) {
      console.error('[VideoStudio] member attach failed:', err);
      toast.error(err?.message || (zh() ? '附加失败' : 'Could not attach that.'));
    } finally {
      s.claimNewFor = '';
      s.composerAttaching = false;
      bump();
    }
  };

  const memberFileInputRef = useRef(null);
  const addMediaForMember = (key, kind) => {
    const input = memberFileInputRef.current;
    if (!input) return;
    input.accept = kind === 'images' ? 'image/*' : (kind === 'videos' ? 'video/*' : 'audio/*');
    input.dataset.memberKey = key;
    input.click();
  };

  const afterRowsChanged = () => {
    const before = weaveSnapshot();
    syncCast();
    rememberCast();
    if (weaveTargetNow() === 'reference' && s.cast.length && s.setup.prompt.trim()) {
      const woven = acceptPrompt(s.setup.prompt);
      if (woven.prompt !== before.prompt) {
        announceWeave(zh() ? '已把参考织入提示词' : 'Wove your references into the prompt', before);
      }
    }
    bump();
  };

  const withDurationThatFits = (setup) => {
    const duration = clampDurationToMotionReference(setup, setup.modelId, s.rentedMachines);
    if (Number(duration) === Number(setup.duration)) return setup;
    // The clip just got shorter than what is written into the prompt. An H3
    // prompt carries its own timeline — "[Shot 3] At 00:10.000" — and a shot
    // stamped at or past the new end is a beat that NEVER RENDERS: the model
    // runs out of clip before reaching it and the last thing described is
    // silently missing. The starters make this certain rather than likely, they
    // are fixed scripts (the Korean home video is 15s: 00:00 / 00:05 / 00:10),
    // so choosing a length the reference budget allows used to throw the third
    // beat away without a word. Refit the anchors instead, and say so.
    //
    // Only on a duration CHANGE, never on every commit: this runs on each
    // keystroke in the prompt box too, and re-timing mid-edit would fight
    // someone typing a timestamp.
    const fitted = fitShotTimeline(setup.prompt, duration);
    if (!fitted.changed) return { ...setup, duration };
    announceRefit(fitted);
    return { ...setup, duration, prompt: fitted.prompt };
  };

  const commit = (nextSetup, { persist = true } = {}) => {
    s.setup = withDurationThatFits(nextSetup);
    if (persist) persistVideoPreferences();
    bump();
  };

  const selectRegularModel = (m) => commit(selectRegularModelTransition(s.setup, m, s.catalogs));
  const selectHiveModel = (m) => commit(selectHivemindWorkflowTransition(s.setup, m, s.catalogs));
  const selectV2VModel = (m) => commit(selectV2VModelTransition(s.setup, m, s.catalogs));

  // This tab's "Run on" pin, written by the Rented panel's picker ('' = follow
  // the Machines default). Part of `setup`, so it persists and copies with the tab.
  const pinMachine = (rentalId) => {
    const next = rentalId || '';
    if ((s.setup.rentedMachineId || '') === next) return;
    commit({ ...s.setup, rentedMachineId: next });
  };

  const setLocalMode = (local, rented = false) => {
    const nextRented = Boolean(local && rented);
    if (local === s.setup.localMode && nextRented === Boolean(s.setup.rentedOnly)) return;
    const next = { ...s.setup, localMode: local, rentedOnly: nextRented };
    // Switching INTO rented while the selected model is one the machine does
    // not serve would leave a model the box cannot run (and the generate guard
    // would just refuse). withServedModel is the one rule for that, shared with
    // the Machines-view handoff so both land the same way.
    commit(nextRented ? withServedModel(next, s.rentedMachines, s.catalogs) : next);
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
  // Who a UGC clip is about when reference pictures are attached and will be
  // sent: the person in them (named and gendered by the loaded persona, if
  // any), with the voice rows so the brief can bind the clone. Null means no
  // identity source — the brief deals a person instead.
  const ugcPersona = () => {
    const images = s.setup.referenceImageUrls || [];
    if (!images.length || !videoRequestPlan(s.setup).sendReferenceImages) return null;
    // The look comes from whoever holds the rows in the cast (a loaded persona
    // or the anonymous references member edited on the strip).
    const holder = s.cast.find((member) => member.kind === 'persona');
    return {
      name: s.setup.persona?.name || '',
      gender: s.setup.persona?.gender || holder?.data?.gender || '',
      look: s.setup.persona?.look || holder?.data?.look || '',
      images,
      videos: s.setup.referenceVideos || [],
      audios: s.setup.referenceAudios || [],
    };
  };
  const applyUgc = (index) => {
    // A loaded persona's gender picks the cast pool: the dealt person must be
    // the kind of person the attached pictures show.
    const variant = Number.isInteger(index) ? ugcVariantAt(index, { gender: s.setup.persona?.gender }) : null;
    const prompt = applyUgcVideoBrief(s.setup.prompt, variant, {
      durationSeconds: Number(s.setup.duration) || null,
      persona: ugcPersona(),
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
    afterRowsChanged();
  };

  /* ---------------- scene references ---------------- */
  //
  // A place or a staging sheet: the same <Picture N> row as the character
  // pictures, supplied last, but annotated in the cast as a `scene` member so
  // the compiler writes it its own retention contract instead of promising that
  // somebody's face carries out of an empty room. ONE member per picture, so
  // "is this a place or is it staging" is answerable per row.
  const sceneMembersNow = () => s.cast.filter((member) => member.kind === 'scene');
  const sceneUrls = () => sceneMembersNow().flatMap((member) => member.data?.images || []);
  const sceneRoleMap = () => Object.fromEntries(sceneMembersNow().flatMap(
    (member) => (member.data?.images || []).map((url) => [url, member.retention || 'attribute_transfer']),
  ));
  const onSceneRefsChange = (urls) => {
    const next = (Array.isArray(urls) ? urls : []).filter(Boolean);
    const roles = sceneRoleMap();
    // Kept across the rebuild: a sender's own sentence for a picture ("the
    // empty harbour bus stand plate for this clip") is only wrong once the
    // picture is deliberately re-classified, not because a different row was
    // edited.
    const said = Object.fromEntries(sceneMembersNow().flatMap(
      (member) => (member.data?.images || []).map(
        (url) => [url, { name: member.name || '', carries: member.carries || '' }],
      ),
    ));
    // Read BEFORE the cast is rebuilt. Asking afterwards makes a picture that
    // was just removed from the scene row look like it had never been one, so
    // it stayed in the list and reappeared among the character pictures.
    const wasScene = new Set(sceneUrls());
    const characters = (s.setup.referenceImageUrls || []).filter((url) => !wasScene.has(url));
    // Rebuilt rather than patched: the row IS the truth about which pictures are
    // scenes, and a member left holding a picture the row no longer has would
    // write a definition for a label nothing fills.
    const kept = s.cast.filter((member) => member.kind !== 'scene');
    s.cast = [...kept, ...next.map((url, index) => sceneMember({
      key: `scene:${index}:${url}`,
      name: said[url]?.name || '',
      carries: said[url]?.carries || '',
      images: [url],
      retention: roles[url] || 'attribute_transfer',
    }))];
    setRows({ ...currentRows(), images: [...characters, ...next] });
    afterRowsChanged();
  };
  const onSceneRole = (url, retention) => {
    s.cast = s.cast.map((member) => (member.kind === 'scene' && (member.data?.images || []).includes(url)
      // A picture re-classified by hand loses the sentence a sender wrote for
      // it: a plate called staging is no longer described as a plate.
      ? { ...member, retention, carries: '' }
      : member));
    rememberCast();
    if (weaveTargetNow() === 'reference' && s.setup.prompt.trim()) acceptPrompt(s.setup.prompt, { announce: false });
    bump();
  };

  // Voice clips (<Audio N>) and motion clips (<Video N>) of the same Reference
  // mode. Each entry keeps its filename for the row label, and a video keeps
  // whether its own soundtrack rides along.
  const onReferenceAudiosChange = (items) => {
    s.setup = { ...s.setup, referenceAudios: (Array.isArray(items) ? items : []).filter((item) => item?.url) };
    afterRowsChanged();
  };

  const onReferenceVideosChange = (items) => {
    const videos = (Array.isArray(items) ? items : []).filter((item) => item?.url);
    s.setup = withDurationThatFits({
      ...s.setup,
      referenceVideos: videos,
      // Head replacement is armed AGAINST one of these clips. Detaching that
      // clip disarms it: the alternative is a run pointed at footage no longer
      // in the panel, which would either fail at the gateway or — worse —
      // quietly rewrite a clip the user thought they had removed.
      inpaint: s.setup.inpaint && !videos.some((item) => item.url === s.setup.inpaint.url)
        ? null
        : s.setup.inpaint,
    });
    afterRowsChanged();
  };

  // Which Hive Persona ID the three reference rows currently ARE — set when one
  // is loaded or saved, cleared when the rows are emptied or the character is
  // deleted. Purely a label: it never adds or removes a reference itself.
  const onPersonaChange = (next) => {
    s.setup = { ...s.setup, persona: personaIdentity(next) };
    // The name belongs to whoever holds the rows: the cast member is renamed
    // (and learns the persona's gender and look) rather than doubled — and a
    // written prompt is re-woven, since its definition just changed.
    syncCast();
    if (weaveTargetNow() === 'reference' && s.cast.length && s.setup.prompt.trim()) acceptPrompt(s.setup.prompt, { announce: false });
    rememberCast();
    bump();
  };

  // The Cast menu: members added, removed, reordered or restyled. Every change
  // applies at once — writing the prompt without the rows (or the rows without
  // the prompt) is how a prompt ends up addressing a <Picture 7> that was never
  // attached, so there is no separate step to forget.
  const applyCast = (members, { announce = true } = {}) => {
    const before = weaveSnapshot();
    const woven = applyMembers(members);
    const total = (woven.rows?.images.length || 0) + (woven.rows?.videos.length || 0) + (woven.rows?.audios.length || 0);
    // An attribute edit (gender, look, a character's style) re-weaves silently
    // — a toast per keystroke in the look box is noise; add / remove / reorder
    // announce, with Undo.
    if (announce && (woven.prompt !== before.prompt || JSON.stringify(woven.rows) !== JSON.stringify(before.rows))) {
      announceWeave(
        zh()
          ? `已应用演员表 · ${s.cast.length} 位 · ${total} 个参考`
          : `Cast woven in — ${s.cast.length} member${s.cast.length === 1 ? '' : 's'}, ${total} reference${total === 1 ? '' : 's'}`,
        before,
      );
    }
  };

  // A prompt arriving from the library or the starters, woven on the way in.
  //
  // A saved prompt was written for whoever was in it when it was saved, and a
  // starter for a stand-in. Dropped into a composer with a cast and left alone,
  // it addresses the OLD one — the half-rewritten state the weave exists to
  // prevent. `standIns` are the starter's own record of which words are the
  // person; the references are deliberately NOT reshuffled by loading a prompt.
  const loadPromptText = (text, { standIns = [] } = {}) => {
    const before = weaveSnapshot();
    const woven = acceptPrompt(text, { standIns });
    if (!s.cast.length) return;
    if (weaveTargetNow() === 'reference') {
      announceWeave(
        zh()
          ? `已按当前演员表改写提示词 · ${s.cast.length} 位`
          : `Prompt woven onto your cast — ${s.cast.length} member${s.cast.length === 1 ? '' : 's'}`,
        before,
      );
    } else if (woven.prompt !== fitShotTimeline(text, Number(s.setup.duration) || 0).prompt) {
      // Changed by the cast, not merely re-timed.
      announceWeave(zh() ? '已把演员表织入提示词' : 'Cast woven into the prompt', before);
    }
  };

  // A starter that opts into setting the studio up for itself (the multi-shot
  // timeline sequences do): the slot's own length is applied when this model
  // offers it, and the timeline view opens so the finished clip lands as shot
  // 1 — the two steps its note would otherwise ask the user to do by hand.
  const applyStarterSetup = ({ timeline = false, durationSeconds = 0 } = {}) => {
    if (!timeline) return;
    const wanted = Number(durationSeconds);
    if (wanted > 0 && Number(s.setup.duration) !== wanted
        && durationsFor(s.setup, s.setup.modelId).map(Number).includes(wanted)) {
      commit({ ...s.setup, duration: wanted });
    }
    if (!s.timelineOn) openTimelineView();
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

  // Spells out both consequences and lets you back out — as a ConfirmModal
  // that RESOLVES: the file is already captured by the handler that asks, and
  // nothing uploads until the answer lands, so the async dialog costs nothing.
  // (The native confirm it replaces was the last one left in the
  // studios.)
  const confirmSourceVideoSwitch = (cost) => new Promise((resolve) => {
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
    s.sourceSwitchConfirm = { lines, resolve };
    bump();
  });
  const answerSourceSwitch = (answer) => {
    const pending = s.sourceSwitchConfirm;
    s.sourceSwitchConfirm = null;
    bump();
    pending?.resolve(answer);
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
        toastFailure(err, { operation: zh() ? '视频上传' : 'Video upload' });
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
    if (cost && !(await confirmSourceVideoSwitch(cost))) return;
    if (!useHivemind && muapiKeyMissing()) {
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
      toastFailure(err, { operation: zh() ? '视频上传' : 'Video upload' });
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
    s.progressOvertimeMin = null;
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
  const updateGenerationProgress = ({ status = '', progress = null, stage = '', estimateSeconds = null, step = null, stepTotal = null, overtimeMinutes = null } = {}) => {
    const value = normalizeVideoGenerationProgress(progress);
    if (value != null) s.progressReal = value;
    if (Number(estimateSeconds) > 0) s.progressEstimateSec = Number(estimateSeconds);
    // Well past the estimate but still alive on the server. Said out loud in
    // the progress card, next to a Cancel that is already there — the poller
    // no longer has a clock of its own to fail the run with.
    if (Number(overtimeMinutes) > 0) s.progressOvertimeMin = Number(overtimeMinutes);
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

  const showVideoInCanvas = (url, model, { fromGeneration = false, anchorChain = true, userInitiated = false } = {}) => {
    s.contextStore.view(url);
    s.resultUrl = url;
    s.resultModel = model;
    // Sound follows a gesture: only a clip the user asked for plays unmuted.
    s.resultUnmuted = Boolean(userInitiated);
    // Which chain the timeline is showing. Anchored to a SHOT, so previewing
    // the joined cut (a blob URL that is in no history) does not collapse the
    // timeline that produced it.
    if (anchorChain) s.chainAnchor = url;
    if (fromGeneration) {
      s.progressDisplay = 1;
      s.progressReal = 1;
      stopGenerationProgress();
      void playCompletionPing();
      // The manual timeline captures every finished generation: into the
      // selected slot when it is empty, as a new segment after it otherwise.
      if (s.timelineOn) captureTimelineResult(url, model);
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
    showVideoInCanvas(entry.url, entry.model, { userInitiated: true });
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
      persona: s.setup.persona ? { ...s.setup.persona } : null,
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

  // Only clears the canvas. It used to restore the viewed clip's settings too —
  // with the composer visible under the result, anything typed while the clip
  // was on screen was replaced by the clip's old prompt the moment this was
  // pressed, with no undo. Regenerate and drag-to-restore still restore.
  const backToSetup = () => {
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
  // "+ New" clears the prompt, the references, the persona and the frames in
  // one press — offered back through the same Undo toast the weave uses, since
  // there is no confirm and a press can land a second early.
  const newPrompt = () => {
    const before = { ...weaveSnapshot(), setup: s.setup };
    const hadSomething = Boolean(before.prompt.trim())
      || before.rows.images.length || before.rows.videos.length || before.rows.audios.length
      || Boolean(s.setup.imageUrl) || Boolean(s.setup.videoUrl);
    s.setup = newPromptTransition(s.setup, s.catalogs);
    s.lastSubmittedContext = null;
    s.contextStore.clearViewed();
    s.resultUrl = null;
    s.resultModel = null;
    // The cast follows the rows it was derived from; the stand-ins belonged to
    // the prompt that is gone.
    s.cast = [];
    s.standIns = [];
    s.castWarnings = [];
    rememberCast();
    updateComposerDraft({ prompt: '' });
    persistVideoPreferences();
    bump();
    focusPrompt();
    if (hadSomething) announceWeave(zh() ? '已清空提示词与输入' : 'Cleared the prompt and its inputs', before);
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

  /* ---------------- manual timeline (lib/videoTimeline.js) ---------------- */

  const timelineCutLabel = () => (zh() ? '时间线合成片' : 'Timeline cut');

  const persistTimeline = () => saveTimelineState(tabIdRef.current, {
    on: s.timelineOn,
    segments: s.timelineSegments,
    selectedId: s.timelineSelectedId,
    extend: s.timelineExtend,
    showCombined: s.timelineShowCombined,
  });

  const afterTimelineChange = () => {
    persistTimeline();
    scheduleTimelineBuild();
    bump();
  };

  // The model label a dropped clip lands with: the strip knows it, and the
  // sealed context knows it for clips restored from History.
  const clipModelFor = (url) => s.generationHistory.find((entry) => entry.url === url
      || (Array.isArray(entry.aliasUrls) && entry.aliasUrls.includes(url)))?.model
    || s.contextStore.recall(url)?.model
    || '';

  // The card's hover title: the clip's own prompt where it is recallable and
  // not private, else the model it was made with.
  const timelinePromptFor = (seg) => {
    const entry = s.generationHistory.find((item) => item.url === seg.url);
    if (entry?.prompt && !entry.prompt_private) return entry.prompt;
    return s.contextStore.recall(seg.url)?.prompt || seg.model || '';
  };

  const openTimelineView = () => {
    if (s.timelineOn) return;
    s.timelineOn = true;
    // First open seeds shot 1 from what is on screen — the timeline "starts
    // with the existing shot"; with an empty canvas it opens on an empty slot.
    if (!s.timelineSegments.length) {
      const opened = openTimeline(s.resultUrl || '', s.resultModel || '');
      s.timelineSegments = opened.segments;
      s.timelineSelectedId = opened.selectedId;
    }
    afterTimelineChange();
  };

  const closeTimelineView = () => {
    if (!s.timelineOn) return;
    s.timelineOn = false;
    s.timelineShowCombined = false;
    disarmTimelineContinuation();
    persistTimeline();
    bump();
  };

  const timelineSelect = (seg) => {
    s.timelineSelectedId = seg.id;
    s.timelineShowCombined = false;
    persistTimeline();
    if (seg.url) {
      showVideoInCanvas(seg.url, seg.model || clipModelFor(seg.url), { anchorChain: false, userInitiated: true });
      return;
    }
    // An empty slot is "write the next shot": clear the player, arm the
    // continuation if Auto-continue is on, and put the caret in the composer.
    s.resultUrl = null;
    s.resultModel = null;
    armTimelineContinuation();
    bump();
    focusPrompt();
  };

  const timelineAdd = () => {
    const next = addTimelineSegment(s.timelineSegments);
    s.timelineSegments = next.segments;
    s.timelineSelectedId = next.selectedId;
    s.timelineShowCombined = false;
    s.resultUrl = null;
    s.resultModel = null;
    armTimelineContinuation();
    afterTimelineChange();
    focusPrompt();
  };

  // A finished generation lands in the strip: into the selected slot when it
  // is empty, as a new segment right after it otherwise (never a silent
  // replacement). Called from showVideoInCanvas on the fromGeneration path.
  const captureTimelineResult = (url, model) => {
    const captured = captureIntoTimeline(s.timelineSegments, s.timelineSelectedId, { url, model });
    s.timelineSegments = captured.segments;
    s.timelineSelectedId = captured.selectedId;
    // The fresh clip is what plays now, not a stale full cut.
    s.timelineShowCombined = false;
    persistTimeline();
    scheduleTimelineBuild();
  };

  /* ---- Auto-continue: the next shot picks up from the previous clip ---- */

  // The mechanism is a property of the MODEL: H3 chains through Motion Context
  // (pinned tail, room tone carries), everything else with a start-image input
  // opens on the previous clip's last frame, grabbed on this device.
  const timelineExtendModeFor = (entry) => (entry?.supportsMotionContext ? 'chain'
    : (entry?.supportsStartFrame ? 'frame' : ''));

  const seedStartFrameFromClip = async (url) => {
    try {
      const src = await resolveMediaSrc(url);
      const blob = await (await fetch(src)).blob();
      // Dynamic import on purpose: clipPrep carries mediabunny, which should
      // not weigh down the studio chunk until a frame is actually grabbed.
      const { grabFrame, probeClip } = await import('../lib/clipPrep.js');
      const probed = await probeClip(blob);
      const frame = await grabFrame(blob, Math.max(0, (Number(probed?.duration) || 0) - 0.05));
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('could not read the grabbed frame'));
        reader.readAsDataURL(frame.blob);
      });
      // Never clobber a start frame the user picked by hand — only replace the
      // one this feature seeded.
      if (s.setup.imageUrl && s.setup.imageUrl !== s.timelineSeededFrame) return;
      s.timelineSeededFrame = dataUrl;
      commit({ ...s.setup, imageUrl: dataUrl });
    } catch (error) {
      toast.error(zh()
        ? `无法提取上一段的最后一帧：${error?.message || ''}`
        : `Could not grab the previous clip's last frame: ${error?.message || 'unknown error'}`);
    }
  };

  const armTimelineContinuation = () => {
    if (!s.timelineOn || !s.timelineExtend) return;
    const entry = currentModel(s.setup, s.catalogs);
    const plan = timelineContinuationPlan(entry, s.timelineSegments, s.timelineSelectedId);
    if (!plan) return;
    if (plan.mode === 'chain') {
      if (s.setup.motionContextUrl === plan.fromUrl) return;
      // Same shape as continueSceneFrom: the chain replaces the frames, and
      // the visible continuity scaffold keeps the prompt describing ONE scene.
      commit({
        ...s.setup,
        imageUrl: null,
        videoUrl: null,
        videoName: null,
        motionContextUrl: plan.fromUrl,
        motionContextIndex: plan.fromIndex + 1,
        prompt: armChainPrompt(s.setup.prompt),
      });
      s.timelineArmedChainUrl = plan.fromUrl;
      return;
    }
    void seedStartFrameFromClip(plan.fromUrl);
  };

  const disarmTimelineContinuation = () => {
    let next = s.setup;
    let changed = false;
    if (s.timelineArmedChainUrl && s.setup.motionContextUrl === s.timelineArmedChainUrl) {
      next = { ...next, motionContextUrl: null, motionContextIndex: null };
      changed = true;
    }
    if (s.timelineSeededFrame && s.setup.imageUrl === s.timelineSeededFrame) {
      next = { ...next, imageUrl: null };
      changed = true;
    }
    s.timelineArmedChainUrl = '';
    s.timelineSeededFrame = '';
    if (changed) commit(next);
  };

  const timelineToggleExtend = () => {
    s.timelineExtend = !s.timelineExtend;
    if (s.timelineExtend) armTimelineContinuation();
    else disarmTimelineContinuation();
    persistTimeline();
    bump();
  };

  /* ---- the full cut: built quietly after every change ---- */

  const scheduleTimelineBuild = () => {
    if (s.timelineBuildTimer) clearTimeout(s.timelineBuildTimer);
    s.timelineBuildTimer = setTimeout(() => {
      s.timelineBuildTimer = null;
      void buildTimelineCut();
    }, 450);
  };

  const dropTimelineCombined = () => {
    if (s.timelineCombined?.url) URL.revokeObjectURL(s.timelineCombined.url);
    s.timelineCombined = null;
  };

  // Joins the filled segments losslessly on this device (clipJoiner — the
  // clips are E2E-sealed at rest and only this side holds the key), silently:
  // this runs after every edit so the Full-cut toggle is always ready. Unlike
  // the chain's build there are no toasts — the only visible signs are the
  // spinner on the toggle and the note when clips cannot be joined.
  const buildTimelineCut = async () => {
    if (!s.timelineOn) return;
    const urls = filledTimelineSegments(s.timelineSegments).map((seg) => seg.url);
    const key = urls.join(' ');
    if (urls.length < 2) {
      dropTimelineCombined();
      s.timelineBuildError = '';
      bump();
      return;
    }
    if (s.timelineBuilding || (s.timelineCombined?.key === key && !s.timelineBuildError)) return;
    s.timelineBuilding = true;
    s.timelineBuildError = '';
    bump();
    try {
      const { joinClips } = await import('../lib/clipJoiner.js');
      const blobs = [];
      for (const url of urls) {
        const src = await resolveMediaSrc(url);
        blobs.push(await (await fetch(src)).blob());
      }
      const joined = await joinClips(blobs);
      const old = s.timelineCombined;
      s.timelineCombined = {
        url: URL.createObjectURL(joined.blob),
        seconds: joined.seconds,
        audioJoined: joined.audioJoined,
        key,
      };
      // Swap before revoking: the player may be holding the old URL.
      if (s.timelineShowCombined) {
        showVideoInCanvas(s.timelineCombined.url, timelineCutLabel(), { anchorChain: false });
        void saveTimelineCutIfNeeded();
      }
      if (old?.url) URL.revokeObjectURL(old.url);
    } catch (error) {
      s.timelineBuildError = error?.message || (zh() ? '拼接失败' : 'join failed');
      dropTimelineCombined();
      if (s.timelineShowCombined) s.timelineShowCombined = false;
    } finally {
      s.timelineBuilding = false;
      bump();
      // The strip changed while this build ran — build again for the new set.
      if (s.timelineOn && timelineCombineKey(s.timelineSegments) !== key) scheduleTimelineBuild();
    }
  };

  const timelineToggleCombined = (view) => {
    if (!view) {
      s.timelineShowCombined = false;
      persistTimeline();
      const seg = s.timelineSegments.find((item) => item.id === s.timelineSelectedId);
      if (seg?.url) {
        showVideoInCanvas(seg.url, seg.model || clipModelFor(seg.url), { anchorChain: false, userInitiated: true });
      } else {
        s.resultUrl = null;
        s.resultModel = null;
        bump();
      }
      return;
    }
    if (!timelineCanCombine(s.timelineSegments)) {
      toast(zh() ? '至少需要两段片段才能合成完整片。' : 'Add a second clip and the full cut builds itself.');
      return;
    }
    if (s.timelineBuildError) return; // the note under the header says why
    s.timelineShowCombined = true;
    persistTimeline();
    if (s.timelineCombined?.url && s.timelineCombined.key === timelineCombineKey(s.timelineSegments)) {
      showVideoInCanvas(s.timelineCombined.url, timelineCutLabel(), { anchorChain: false, userInitiated: true });
      void saveTimelineCutIfNeeded();
      return;
    }
    // Remembered intent: the build in flight (or scheduled here) swaps the
    // cut in the moment it lands.
    scheduleTimelineBuild();
    bump();
  };

  // The cut an object URL alone would lose with the tab: stored ONCE per shot
  // set as a real output — sealed like any clip, so it lands in History and
  // survives — the first time the user actually views or exports it. Building
  // is automatic and frequent; filing every intermediate build is not wanted.
  const saveTimelineCutIfNeeded = async () => {
    const cut = s.timelineCombined;
    if (!cut?.url || !isLocalAIAvailable() || s.timelineSavedKeys.includes(cut.key)) return;
    s.timelineSavedKeys = [...s.timelineSavedKeys, cut.key];
    try {
      const blob = await (await fetch(cut.url)).blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('could not read the joined cut'));
        reader.readAsDataURL(blob);
      });
      const saved = await localAI.saveEpisode({
        video_base64: dataUrl,
        shots: filledTimelineSegments(s.timelineSegments).length,
      });
      if (saved?.url) {
        addToHistory({
          id: `timeline-${Date.now()}`,
          url: saved.url,
          model: timelineCutLabel(),
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // Best-effort: the cut is on screen and exportable either way. Let a
      // later view retry.
      s.timelineSavedKeys = s.timelineSavedKeys.filter((value) => value !== cut.key);
    }
  };

  const exportTimelineCut = async () => {
    const cut = s.timelineCombined;
    if (!cut?.url) return;
    await downloadFile(cut.url, videoDownloadName(timelineCutLabel(), `cut-${filledTimelineSegments(s.timelineSegments).length}`));
    void saveTimelineCutIfNeeded();
  };

  /* ---- removing a segment (and, if asked, the clip on disk) ---- */

  const timelineRemoveRequest = (seg) => {
    // An empty slot holds nothing — no confirm for removing a placeholder.
    if (!seg.url) {
      const next = removeTimelineSegment(s.timelineSegments, seg.id, s.timelineSelectedId);
      s.timelineSegments = next.segments;
      s.timelineSelectedId = next.selectedId;
      afterTimelineChange();
      return;
    }
    s.timelineDeleteTarget = { segment: seg, deleteDisk: false, row: null, resolvingRow: true };
    bump();
    // Resolve whether this clip has a deletable file on this device — a cloud
    // result has nothing local, and the toggle must not promise a deletion
    // that cannot happen.
    void (async () => {
      let row = null;
      try {
        const hub = await import('../hub/hubData.js');
        await hub.ensureCanvasHistoryLoaded();
        row = hub.findCanvasOutputForUrl(seg.url, basenameOf(seg.url));
      } catch { /* no History reachable — the toggle stays off */ }
      if (s.timelineDeleteTarget?.segment?.id !== seg.id) return;
      s.timelineDeleteTarget = { ...s.timelineDeleteTarget, row, resolvingRow: false };
      bump();
    })();
  };

  const confirmTimelineRemove = async () => {
    const target = s.timelineDeleteTarget;
    if (!target) return;
    s.timelineDeleteTarget = null;
    const { segment } = target;
    const next = removeTimelineSegment(s.timelineSegments, segment.id, s.timelineSelectedId);
    s.timelineSegments = next.segments;
    s.timelineSelectedId = next.selectedId;
    if (s.resultUrl === segment.url) {
      s.resultUrl = null;
      s.resultModel = null;
    }
    afterTimelineChange();
    if (!target.deleteDisk || !target.row?.historyId) return;
    // Deleting the file: through the same route History uses —
    // delete_output_everywhere removes the file, every sidecar and cache, and
    // the History row (hubData toasts the outcome itself).
    try {
      const hub = await import('../hub/hubData.js');
      const deleted = await hub.deleteCanvasOutput(target.row.historyId);
      if (!deleted) return;
      s.generationHistory = s.generationHistory.filter((entry) => entry.url !== segment.url
        && !(Array.isArray(entry.aliasUrls) && entry.aliasUrls.includes(segment.url)));
      saveStudioGenerationHistory('video_history', s.generationHistory, 30);
      if (s.setup.motionContextUrl === segment.url) clearMotionContext();
      bump();
    } catch (error) {
      toast.error(error?.message || (zh() ? '删除文件失败' : 'Could not delete the file'));
    }
  };

  /* ---- drops: clips in, cards reordered ---- */

  const applyTimelinePlan = (plan, clip) => {
    if (!plan) return;
    if (plan.action === 'move') {
      s.timelineSegments = moveTimelineSegment(s.timelineSegments, plan.id, plan.index);
      s.timelineSelectedId = plan.id;
      s.timelineShowCombined = false;
      afterTimelineChange();
      return;
    }
    if (plan.action === 'replace') {
      // Replacing a clip the user placed loses work — ask first.
      s.timelineReplaceTarget = { id: plan.id, clip };
      bump();
      return;
    }
    let landedId = '';
    if (plan.action === 'fill') {
      s.timelineSegments = fillTimelineSegment(s.timelineSegments, plan.id, clip);
      landedId = plan.id;
    } else if (plan.action === 'insert' || plan.action === 'append') {
      const seg = newTimelineSegment(clip.url, clip.model);
      s.timelineSegments = insertTimelineSegment(
        s.timelineSegments,
        plan.action === 'append' ? s.timelineSegments.length : plan.index,
        seg,
      );
      landedId = seg.id;
    }
    if (!landedId) return;
    s.timelineSelectedId = landedId;
    s.timelineShowCombined = false;
    afterTimelineChange();
    if (clip?.url) showVideoInCanvas(clip.url, clip.model, { anchorChain: false, userInitiated: true });
  };

  const confirmTimelineReplace = () => {
    const target = s.timelineReplaceTarget;
    if (!target) return;
    s.timelineReplaceTarget = null;
    s.timelineSegments = fillTimelineSegment(s.timelineSegments, target.id, target.clip);
    s.timelineSelectedId = target.id;
    s.timelineShowCombined = false;
    afterTimelineChange();
    showVideoInCanvas(target.clip.url, target.clip.model, { anchorChain: false, userInitiated: true });
  };

  // OS files dropped on the strip: uploaded like any reference clip, then
  // landed through the same plan a dragged output takes. The first file gets
  // the drop's own position; the rest follow it in order.
  const timelineAttachFiles = async (target, files) => {
    if (!isHivemindStudioEnabled()) {
      toast.error(zh() ? '上传片段需要工作室正在运行。' : 'Uploading clips needs the studio to be running.');
      return;
    }
    const loadingId = toast.loading(zh()
      ? `正在上传 ${files.length} 段片段…`
      : `Uploading ${files.length} clip${files.length === 1 ? '' : 's'}…`);
    try {
      let landTarget = target;
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        const upload = await uploadFileToHivemindStudio(file);
        const clip = { url: upload.url, model: '' };
        const plan = timelineDropPlan(s.timelineSegments, landTarget, { kind: 'clip', ...clip });
        applyTimelinePlan(plan, clip);
        // Follow-on files insert directly after wherever the last one landed.
        landTarget = { id: s.timelineSelectedId, region: 'after' };
      }
      toast.success(zh() ? '片段已加入时间线。' : 'Clips added to the timeline.', { id: loadingId });
    } catch (error) {
      toast.error(`${zh() ? '上传失败' : 'Upload failed'}: ${error?.message || ''}`, { id: loadingId });
    }
  };

  const timelineHandleDrop = (target, dataTransfer) => {
    let segPayload = null;
    try {
      const raw = dataTransfer.getData(TIMELINE_SEGMENT_DRAG_TYPE);
      segPayload = raw ? JSON.parse(raw) : null;
    } catch { segPayload = null; }
    if (segPayload?.id) {
      applyTimelinePlan(timelineDropPlan(s.timelineSegments, target, { kind: 'segment', id: segPayload.id }), null);
      return;
    }
    const output = droppedOutputPayload(dataTransfer);
    if (output?.url) {
      const mediaType = String(output.mediaType || '').toLowerCase();
      if (!mediaType.startsWith('video/') && output.section !== 'video') {
        toast.error(zh() ? '时间线只接受视频片段。' : 'The timeline takes video clips only.');
        return;
      }
      const clip = { url: output.url, model: clipModelFor(output.url) };
      applyTimelinePlan(timelineDropPlan(s.timelineSegments, target, { kind: 'clip', ...clip }), clip);
      return;
    }
    const dropped = Array.from(dataTransfer.files || []);
    const videos = dropped.filter((file) => String(file.type).startsWith('video/'));
    if (videos.length) {
      void timelineAttachFiles(target, videos);
      return;
    }
    if (dropped.length) toast.error(zh() ? '时间线只接受视频文件。' : 'The timeline takes video files only.');
  };

  // Timeline segments + toggles survive a reload, per tab. The built cut is an
  // object URL and died with the last session, so the view resets to Shot and
  // the quiet build recreates it.
  useEffect(() => {
    const saved = loadTimelineState(tabIdRef.current);
    if (saved) {
      s.timelineOn = saved.on;
      s.timelineSegments = saved.segments;
      s.timelineSelectedId = saved.selectedId;
      s.timelineExtend = saved.extend;
      s.timelineShowCombined = false;
      bump();
      if (saved.on) scheduleTimelineBuild();
    }
    return () => {
      if (s.timelineBuildTimer) clearTimeout(s.timelineBuildTimer);
      dropTimelineCombined();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- generation ---------------- */

  const generateNow = async () => {
    // Rented mode promises WHERE this runs — refuse rather than quietly
    // falling back to this Mac's GPU.
    if (s.setup.rentedOnly
        && !servedByAnyMachine(s.rentedMachines, { id: s.setup.modelId, name: s.setup.modelName })) {
      // Same honesty as the source panel: name the actual blocker.
      toast.error(
        s.rentedBroken?.length
          ? (zh() ? '与租用机器的连接已断开——请在“来源”面板或“机器”页重新连接。' : 'Lost the connection to your rented machine — reconnect it from the Source panel or Machines.')
          : s.rentedIdle?.length
            ? (zh() ? '租用机器尚未接入本工作室——请在“来源”面板点击“用于本工作室”。' : 'Your rented machine is not connected to this studio yet — click "Use it here" in the Source panel.')
            : s.rentedProvisioning?.length
              ? (zh() ? '租用机器仍在上线中——“机器”页可查看进度。' : 'Your rented machine is still coming online — the Machines view shows its progress.')
              : (zh() ? '没有租用机器在运行此模型。请在“机器”页租用一台，或把来源切回本地。' : 'No rented machine is serving this model. Rent one in Machines, or switch the source to Local.'),
      );
      return;
    }
    // The last door: text TYPED straight into the composer, which no other
    // pass can see. References attached under a prompt that never mentions
    // them is the one shape H3 reliably turns into a stranger — so the weave
    // runs here too, visibly, before anything is sent. The composer shows
    // exactly what the model gets.
    syncCast();
    if (weaveTargetNow() === 'reference' && s.cast.length && s.setup.prompt.trim()
        && !isWovenForReference(s.setup.prompt)) {
      const before = weaveSnapshot();
      const woven = acceptPrompt(s.setup.prompt);
      if (woven.prompt !== before.prompt) {
        announceWeave(zh() ? '发送前已把参考织入提示词' : 'Wove your references into the prompt before sending', before);
      }
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
    // Head swap needs BOTH media; the readiness line under the Task strip was
    // display-only, so the request went out as a plain generation tagged
    // head-swap with no clip and failed on the backend.
    const swapCheck = headSwapReadiness(setup);
    if (swapCheck.active && !swapCheck.ready) {
      toast.error(`${zh() ? '还需要：' : 'Still needed: '}${swapCheck.missing.join(zh() ? '、' : ' and ')}`);
      return;
    }
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
      // The shared store counts: a machine holding MUAPI_API_KEY is never asked.
      if (muapiKeyMissing()) {
        s.authRetry = () => generate();
        s.authOpen = true;
        bump();
        return;
      }
    }

    s.lastSubmittedContext = captureGenerationContext(prompt);
    void primeCompletionPing();
    s.generateError = '';
    s.generateFailure = null;
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
    // This run's own signal. cancelGeneration() nulls s.abortController the
    // moment it fires, so the checks below read the captured one: a poll that
    // resolved in the same tick as Cancel must still count as cancelled, or the
    // "cancelled" clip lands on the canvas and plays the ping anyway.
    const runSignal = s.abortController.signal;
    const cancelledMarker = () => Object.assign(new Error('Generation cancelled'), { cancelled: true });
    const settled = (res) => { if (runSignal.aborted) throw cancelledMarker(); return res; };
    const historyMeta = { prompt, model: setup.modelId, aspect_ratio: setup.ar, duration: setup.duration };
    const onRequestId = (rid) => {
      capturedRequestId = rid;
      s.activeCloudRequestId = rid;
      updateGenerationProgress({ stage: 'rendering' });
      savePendingJob({
        requestId: rid, studioType: 'video', historyMeta,
        // Which tab is rendering this, and under what name: the tab claims the job
        // back after a reload, and the progress card has a model to show while it
        // does (the prompt stays out of storage — the resumed entry is redacted).
        tabId: tabIdRef.current, modelName: setup.modelName,
        maxAttempts: 900, interval: 2000, submittedAt: Date.now(),
      });
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
          studio_lane: studioLane,
          // The tab's "Run on" pin: tried ahead of the gateway's default order.
          ...(setup.rentedOnly && setup.rentedMachineId ? { run_on: setup.rentedMachineId } : {}),
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
          // typeof, not Number(): the "Default" option stores null, and
          // Number(null) is 0 — which sent nag_scale: 0 (NAG off) for "Default".
          ...(typeof setup.nagScale === 'number' && Number.isFinite(setup.nagScale) ? { nag_scale: setup.nagScale } : {}),
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
        // Head replacement takes precedence over the reference lane it is built
        // on. The same pictures say WHO, but the run rewrites an attached clip
        // instead of generating one, so it routes to the inpaint graph and
        // carries the clip and the mask with it.
        if (setup.inpaint?.url && setup.inpaint.maskSource) {
          const inpaintTarget = inpaintWorkflowForHivemindModel(setup.modelId);
          if (inpaintTarget) {
            localParams.workflow_id = inpaintTarget.workflowId;
            localParams.referenceImages = (setup.referenceImageUrls || []).filter(Boolean);
            localParams.inpaintSource = setup.inpaint.url;
            localParams.maskSource = setup.inpaint.maskSource;
            // SAM3 tracks inside the graph; a painted mask is only sent when it
            // IS the mask, because sending one alongside SAM3 would be ignored.
            if (setup.inpaint.maskSource === 'manual') localParams.inpaintMask = setup.inpaint.maskDataUrl;
            if (setup.inpaint.maskSource === 'sequence') localParams.inpaintMaskVideo = setup.inpaint.maskVideoBase64;
            localParams.inpaint = setup.inpaint.dials || {};
            // The clip decides the length. duration_seconds is only a trim cap
            // here, and the dialog already snapped it to H3's frame lattice.
            if (Number(setup.inpaint.seconds) > 0) localParams.duration = Number(setup.inpaint.seconds);
            // The inpaint graph has no motion or voice reference slots, and the
            // gateway REFUSES a run carrying references it has no slots for
            // rather than dropping them. It is also the right semantics: the
            // movement and the voice both come from the clip being rewritten.
            // The dialog says so before Apply, so this is not a silent drop.
            localParams.referenceVideos = [];
            localParams.referenceAudios = [];
          }
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
        // Fast high-res, gated on the capability for the same reason as the
        // refinement steps below: a preference left on from MiniMax H3 must not
        // ride along into an LTX graph, which has no upscaler to compile.
        if (setup.fastHighRes === true && supportsFastHighRes(currentModel(setup, s.catalogs))) {
          localParams.fast_high_res = true;
        }
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
            overtimeMinutes: data.overtimeMinutes,
          });
        };
        // Mirror the started job to sessionStorage so a tab switch / reload can
        // resume its live progress. Prompt text is deliberately NOT persisted
        // (it stays private); the resumed history entry is redacted anyway.
        // The server trims what it must (an over-long ingredient note) and says
        // so; pass it on instead of letting the cut happen silently.
        localParams.onWarning = (message) => toast(message, { duration: 6000 });
        localParams.onJobId = (jobId) => {
          s.activeLocalJobId = jobId;
          savePendingJob({
            requestId: jobId,
            studioType: 'video',
            kind: 'hivemind-local',
            // The tab that started it reclaims it after a reload; the model name
            // rides along so the resumed progress card names the run.
            tabId: tabIdRef.current,
            modelName: setup.modelName,
            historyMeta: { model: setup.modelId, aspect_ratio: setup.ar, duration: setup.duration },
            submittedAt: Date.now(),
          });
        };
        // Through the one dispatcher. The row is built from the RESOLVED
        // workflow id, not from setup.modelId: the two differ
        // (workflowIdFromHivemindModelId) and reference mode overrides it again
        // above, so taking the model id here would silently run a different
        // workflow than the one the composer configured.
        const { workflow_id: laneWorkflowId, signal: _laneSignal, ...laneParams } = localParams;
        const res = settled(await runVideo({
          row: studioRow(laneWorkflowId),
          shared: laneParams,
          signal: runSignal,
        }));
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
          throw new Error('The studio finished without returning a video.');
        }
        return;
      }

      // ─── Local Wan2GP ──────────────────────────────────────────────────────
      if (isWan2gpLocal) {
        const localParams = {
          model: setup.modelId,
          prompt: prompt || '',
          aspect_ratio: setup.ar,
          studio_lane: studioLane,
        };
        if (setup.imageMode && setup.imageUrl) localParams.image = setup.imageUrl;
        const res = settled(await runVideo({
          row: localRow(setup.modelId, 'wan2gp'),
          extra: { local: localParams },
        }));
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
        const v2vParams = { model: setup.modelId, video_url: setup.videoUrl, onRequestId, signal: runSignal };
        if (model?.imageField && setup.imageUrl) v2vParams.image_url = setup.imageUrl;
        if (model?.hasPrompt && prompt) v2vParams.prompt = prompt;
        // Through the one dispatcher: `method` names the MUAPI call so a V2V
        // gets the same readiness refusal a T2V already gets.
        const res = settled(await runVideo({
          row: muapiRow(setup.modelId),
          extra: { muapi: { ...v2vParams, method: 'processV2V' } },
          signal: runSignal,
        }));
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
          signal: runSignal,
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
        const res = settled(await runVideo({
          row: muapiRow(setup.modelId),
          extra: { muapi: { ...i2vParams, method: 'generateI2V' } },
          signal: runSignal,
        }));
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
      const params = { model: setup.modelId, onRequestId, signal: runSignal, ...getAdvancedVideoPayload(model, setup.advancedValues) };
      if (prompt) params.prompt = prompt;
      if (isExtendMode) params.request_id = s.lastGenerationId;
      else params.aspect_ratio = setup.ar;
      if (durationsFor(setup, setup.modelId).length > 0) params.duration = setup.duration;
      if (resolutionsFor(setup, setup.modelId).length > 0) params.resolution = setup.resolution;
      if (setup.quality) params.quality = setup.quality;
      if (setup.mode) params.mode = setup.mode;
      const res = settled(await runVideo({
        row: muapiRow(setup.modelId),
        extra: { muapi: params },
        signal: runSignal,
      }));
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
        s.generateFailure = null;
      } else {
        console.error(e);
        // Errors no longer vanish into the button label: a persistent callout in
        // the canvas (ONCE — not a callout and a toast saying the same thing),
        // with a Try again and, where the failure named one, the button that
        // repairs it. The lane's own sentences are already sanitized server-side,
        // so describeFailure keeps them and only adds the action.
        const failure = describeFailure(e, {
          transport: isWan2gpLocal ? 'local' : isHivemindLocal ? 'studio' : 'muapi',
          operation: zh() ? '生成' : 'Generation',
        });
        s.generateFailure = failure;
        s.generateError = failure.title || (zh() ? '生成失败' : 'Generation failed');
      }
    } finally {
      if (typeof unsubscribeProgress === 'function') unsubscribeProgress();
      // This mount owns the local job to completion; clear its resume marker so
      // the next mount doesn't re-poll a finished render.
      if (s.activeLocalJobId) { removePendingJob(s.activeLocalJobId); s.activeLocalJobId = null; }
      if (s.activeCloudRequestId) { removePendingJob(s.activeCloudRequestId); s.activeCloudRequestId = null; }
      s.abortController = null;
      s.generating = false;
      if (!hadError) { s.generateError = ''; s.generateFailure = null; }
      bump();
    }
  };
  const generate = () => generationQueueRef.current.enqueue(generateNow);

  // Cancel / reset the in-flight generation. Aborts the poll immediately, forwards
  // a best-effort interrupt to whichever backend is running the job, and ALWAYS
  // resets local state — so a stuck or already-finished job (e.g. one whose output
  // never resolved a URL) still unblocks the studio for the next generation.
  const cancelGeneration = () => {
    const jobId = s.activeLocalJobId;
    const cloudId = s.activeCloudRequestId;
    // 1) Stop the client poll loop right away. The cloud path reads the same
    //    signal (muapi.pollForResult), so a remote job stops being watched the
    //    moment this fires instead of landing minutes later.
    try { s.abortController?.abort(); } catch { /* no-op */ }
    // 2) Best-effort backend interrupt (local Media Studio job + wan2gp/localAI).
    //    The reply distinguishes "accepted" from "actually let go": a Comfy
    //    prompt part-way through loading a video model keeps the GPU until it
    //    reaches a checkpoint, and the next generation queues behind it. Saying
    //    "Generation cancelled" during that window is what made cancelling look
    //    like it did nothing, so wait for the verdict before claiming one.
    if (jobId) {
      void cancelHivemindVideoJob(jobId).then((result) => {
        if (result?.stopped === false) {
          // A plain toast with a lifetime: toast.loading() has none, and the
          // old one sat on screen for the rest of the session.
          toast(zh()
            ? '正在停止：租用机器需完成当前步骤才能释放，新的生成会排在其后。'
            : 'Still stopping — the machine finishes its current step before it frees up. A new generation will queue behind it.', { duration: 6000 });
        } else {
          toast.success(zh() ? '已取消生成。' : 'Generation cancelled.');
        }
      });
    }
    try { localAI.cancelGeneration?.(); } catch { /* not all runtimes support it */ }
    // 3) Reset local generation state unconditionally. The cloud job's pending
    //    record goes too — a reload must not resume a run the user gave up on.
    if (jobId) removePendingJob(jobId);
    if (cloudId) removePendingJob(cloudId);
    s.activeLocalJobId = null;
    s.activeCloudRequestId = null;
    s.abortController = null;
    stopGenerationProgress();
    s.generating = false;
    s.generateError = '';
    s.generateFailure = null;
    bump();
    // With a job id the toast comes from the backend's verdict above; without
    // one there is nothing to stop and the reset IS the whole cancel.
    if (!jobId) toast.success(zh() ? '已取消生成。' : 'Generation cancelled.');
  };

  /* ---------------- hivemind catalog + window events ---------------- */

  const applyHivemindWorkflows = (context, { keepSelection = false } = {}) => {
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
    // A whole Story production that arrived before this catalog did. Landed
    // first: it names the model everything else in the payload was written for.
    if (s.pendingStory) {
      const pending = s.pendingStory;
      s.pendingStory = null;
      applyStoryProduction(pending);
      return;
    }
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
    if (keepSelection) {
      // A catalog that arrived behind the user (the degraded-registry retry).
      // Refresh what the models CAN do, never what the user has since chosen:
      // re-running the restore below would hand back the persisted duration,
      // aspect ratio and steps over anything they touched while waiting. The
      // selection itself is already right — it is only the capability fields
      // that were a guess — so re-point it at its refreshed entry and stop.
      const target = resolveVideoModel(s.setup.modelId, s.catalogs);
      if (target) s.setup = withSelectedModel(s.setup, target);
      bump();
      return;
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

  // Backoff for a catalog whose workflow registry did not answer. Deliberately
  // short and finite: the server rebuilds on each miss, so a couple of tries
  // cover the window (a stack restart, a gateway busy mid-generation) without
  // turning a genuinely down endpoint into a polling loop.
  const REGISTRY_RETRY_DELAYS_MS = [1500, 4000, 10000];
  const retryDegradedRegistry = (attempt) => {
    if (attempt >= REGISTRY_RETRY_DELAYS_MS.length) return;
    clearTimeout(registryRetryRef.current);
    registryRetryRef.current = setTimeout(async () => {
      if (!mountedRef.current) return;
      const context = await loadHivemindStudioContext({ refresh: true });
      if (!mountedRef.current) return;
      applyHivemindWorkflows(context, { keepSelection: true });
      if (context.videoRegistryLive === false) retryDegradedRegistry(attempt + 1);
    }, REGISTRY_RETRY_DELAYS_MS[attempt]);
  };

  const refreshHivemindWorkflows = async ({ force = false } = {}) => {
    // `force` is the user pressing Refresh: the module-level context is cached,
    // so without it a stale-but-non-empty catalog would answer from memory.
    let context = await loadHivemindStudioContext({ refresh: force });
    // Owner unlock and backend startup can race the iframe's first request.
    if (!context.videoModels?.length) context = await loadHivemindStudioContext({ refresh: true });
    applyHivemindWorkflows(context);
    // The catalogue is the other thing a pending handoff was waiting on.
    finishRentedHandoff();
    // A catalog the server could not read live still carries a full model list,
    // so the empty-check above never fires for it — and it is the more damaging
    // miss of the two: the fallback list knows nothing of reference mode, so
    // MiniMax H3 renders with its pre-reference toolbar (one start-frame picker,
    // no References, no Frames) and stays that way, because the context is
    // memoized module-wide and nothing re-fetches. Reloading the page was the
    // only way out.
    if (context.videoRegistryLive === false) retryDegradedRegistry(0);
  };

  const trySelectHiveById = (modelId) => {
    const target = s.catalogs.allI2V.find((m) => m.id === modelId);
    if (!target) return false;
    s.setup = selectHivemindWorkflowTransition(s.setup, target, s.catalogs);
    persistVideoPreferences();
    bump();
    return true;
  };

  // Poll a muapi cloud job started before this mount. Attempts already spent while
  // the page was gone are deducted, so a job doesn't win a fresh full budget every
  // time the studio reloads.
  const resumeCloudVideoJob = async (job, { signal = null } = {}) => {
    if (muapiKeyMissing()) throw new Error('Cloud generation cannot resume without an API key');
    const interval = Number(job.interval) || 2000;
    const spent = Math.floor((Date.now() - (Number(job.submittedAt) || Date.now())) / interval);
    const attemptsLeft = Math.max(1, (Number(job.maxAttempts) || 900) - spent);
    // No key argument: the client resolves its own route (proxied or direct).
    const result = await muapi.pollForResult(job.requestId, '', attemptsLeft, interval, { signal });
    return { id: job.requestId, url: result.outputs?.[0] || result.url || result.output?.url };
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
      // The Camera / Style chips answer for the PROMPT: their ids came back from
      // plaintext settings and the phrase they stand for came back with the
      // prompt, and they can disagree (a prompt cleared or replaced since the
      // ids were saved). Reconcile from the prompt — a chip that claimed a
      // phrase the prompt lacked made re-applying stack a second sentence.
      const restoredPrompt = String(next.prompt || '');
      const cameraIds = cameraMotionIdsInPrompt(restoredPrompt);
      if (JSON.stringify(cameraIds) !== JSON.stringify(s.setup.cameraMotionIds || [])) {
        next.cameraMotionIds = cameraIds;
        changed = true;
      }
      const restyleId = restylePresetIdInPrompt(restoredPrompt);
      if ((restyleId || null) !== (s.setup.restylePresetId || null)) {
        next.restylePresetId = restyleId;
        changed = true;
      }
      if (typeof savedNegative === 'string' && savedNegative && !String(s.setup.negativePrompt || '').trim()) {
        next.negativePrompt = savedNegative;
        changed = true;
      }
      // The cast rides with the prompt it was woven into. Its members carry
      // their own media, so the reference rows come back with it — a reload no
      // longer strands a prompt that addresses <Picture 1> over empty rows.
      const rowsEmpty = !(s.setup.referenceImageUrls?.length || s.setup.referenceVideos?.length || s.setup.referenceAudios?.length);
      if (Array.isArray(saved.cast) && saved.cast.length && !s.cast.length && rowsEmpty) {
        s.cast = saved.cast;
        s.standIns = Array.isArray(saved.standIns) ? saved.standIns : [];
        const rows = castRows(s.cast);
        next.referenceImageUrls = rows.images;
        next.referenceVideos = rows.videos;
        next.referenceAudios = rows.audios;
        next.persona = personaIdentity(castPersonaIdentity(s.cast));
        changed = true;
      } else if (Array.isArray(saved.standIns) && saved.standIns.length && !s.standIns.length) {
        s.standIns = saved.standIns;
      }
      if (changed) {
        s.setup = next;
        syncCast();
        bump();
      }
    });

    // Discover the Hivemind local video workflows (with owner-unlock retry).
    void refreshHivemindWorkflows();

    // Resume the generations this tab had in flight when the page went away.
    //
    // A render outlives the page: the job id is in sessionStorage and the backend
    // keeps working, so a reload has to put the progress canvas back rather than
    // present an idle studio over a machine that is still rendering. Local Media
    // Studio jobs poll the gateway job endpoint (no API key); remote muapi jobs
    // poll muapi.
    //
    // Ownership is per TAB, because the whole strip comes back and every tab that
    // was rendering has its own run to reclaim. This tab restores ITS jobs live;
    // the primary tab additionally adopts the ownerless ones (a tab closed while
    // rendering, or a job saved before jobs carried a tab id) and lands those
    // quietly in History, since there is no canvas of theirs left to restore to.
    (async () => {
      const claimed = pendingJobsForTab(getPendingJobs('video'), tabIdRef.current, {
        primary: isPrimaryTab,
        openTabIds: openTabIdsRef.current,
      // A cloud job can only be polled with the muapi key. Without one, leave it in
      // the registry untouched for a session that has it, rather than claiming it
      // and discarding it.
      }).filter((job) => job.kind === 'hivemind-local' || !muapiKeyMissing());
      if (!claimed.length) return;
      const mine = (job) => Number(job?.tabId) === Number(tabIdRef.current)
        && Number.isSafeInteger(Number(tabIdRef.current));

      // The canvas can only show one run, so the tab restores its own newest job
      // and everything else is polled silently into History.
      const live = claimed.filter(mine).sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0))[0];
      const silent = claimed.filter((job) => job !== live);

      // ── This tab's own run: restore the live progress canvas and keep polling.
      if (live && !s.generating) {
        s.generating = true;
        s.generateError = '';
        s.generateFailure = null;
        s.resultUrl = null;
        s.resultModel = null;
        // A fresh controller so Cancel can still stop the resumed poll — without
        // one, cancelling reset the UI while the poll kept running underneath and
        // dropped its result into a studio the user had already moved on from.
        s.abortController = new AbortController();
        startGenerationProgress({
          modelName: live.modelName,
          model: live.historyMeta?.model,
          aspectRatio: live.historyMeta?.aspect_ratio,
          duration: live.historyMeta?.duration,
        }, { stage: 'rendering' });
        // Preserve the true submit time so elapsed / ETA reflect the whole render.
        s.generationStartedAt = live.submittedAt || Date.now();
        const isLocalJob = live.kind === 'hivemind-local';
        if (isLocalJob) s.activeLocalJobId = live.requestId;
        else s.activeCloudRequestId = live.requestId;
        bump();
        void (async () => {
          const signal = s.abortController?.signal;
          try {
            const res = isLocalJob
              ? await pollHivemindVideoJob(live.requestId, {
                signal,
                onProgress: (info) => {
                  const data = (info && typeof info === 'object') ? info : { progress: info };
                  updateGenerationProgress({
                    stage: 'rendering',
                    progress: data.progress,
                    estimateSeconds: data.estimateSeconds,
                    step: data.step,
                    stepTotal: data.stepTotal,
                    overtimeMinutes: data.overtimeMinutes,
                  });
                },
              })
              : await resumeCloudVideoJob(live, { signal });
            // Resolved in the same tick as Cancel: still cancelled.
            if (signal?.aborted) throw Object.assign(new Error('Generation cancelled'), { cancelled: true });
            const url = res?.url;
            if (url) {
              addToHistory({
                id: res.id || live.requestId,
                url,
                ...live.historyMeta,
                timestamp: new Date().toISOString(),
              });
              showVideoInCanvas(url, live.historyMeta?.model, { fromGeneration: true });
            }
          } catch (e) {
            if (!e?.cancelled && e?.name !== 'AbortError') {
              console.warn('[VideoStudio] Video resume failed:', live.requestId, e?.message);
              const failure = describeFailure(e, {
                transport: isLocalJob ? 'studio' : 'muapi',
                operation: zh() ? '生成' : 'Generation',
              });
              s.generateFailure = failure;
              s.generateError = failure.title || (zh() ? '生成失败' : 'Generation failed');
            }
            stopGenerationProgress();
          } finally {
            removePendingJob(live.requestId);
            if (isLocalJob) s.activeLocalJobId = null;
            else s.activeCloudRequestId = null;
            s.abortController = null;
            s.generating = false;
            bump();
          }
        })();
      }

      // ── Adopted / surplus jobs: poll them to completion straight into History.
      if (!silent.length) return;
      s.resumeRemaining = silent.length;
      bump();
      silent.forEach(async (job) => {
        try {
          const res = job.kind === 'hivemind-local'
            ? await pollHivemindVideoJob(job.requestId)
            : await resumeCloudVideoJob(job);
          if (res?.url) {
            addToHistory({
              id: res.id || job.requestId,
              url: res.url,
              ...job.historyMeta,
              timestamp: new Date().toISOString(),
            });
          }
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
      acceptPrompt(`${current}${needsNewline ? '\n' : ''}${text}`);
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
      // A whole production from the Story studio: sheets, plate, board, beats,
      // soundscape and length together. Reference mode has no start or end
      // frame — the registry is explicit that H3's reference lane takes up to
      // nine pictures INSTEAD of one — so there is nothing to put in a frame
      // slot here, and the pictures are the conditioning.
      if (setup?.format === 'story-production') {
        const landed = applyStoryProduction(setup);
        // Only when the model MOVED under the handoff. A story sent to a target
        // that never had a picture lane already said so on the Story page, and
        // one still waiting for its catalog has not been attempted yet.
        if (!landed.deferred && landed.wanted && !landed.attached) {
          toast(zh()
            ? `这个故事带来了 ${landed.wanted} 张图，但当前模型没有对应的通道，因此未附加。`
            : `${landed.wanted} picture${landed.wanted === 1 ? '' : 's'} came with this story, but the model now `
              + 'selected has no lane for them, so nothing was attached.',
          { duration: 12000 });
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
      acceptPrompt(setup?.primaryPrompt || '');
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
      isBusy: () => Boolean(s.generating || generationQueueRef.current.pending),
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

  // Measure any motion reference we have not measured yet. The duration decides
  // whether the clip's own length is capped at all (a reference shorter than
  // the card's ceiling leaves the full range open), and references arrive from
  // file drops, casts and saved personas alike — so they are measured here,
  // where all three land, rather than at each attach point. Until a reference
  // is measured it counts as long, so the picker errs toward the safe cap.
  const unmeasuredReferenceVideos = (s.setup.referenceVideos || [])
    .filter((item) => item?.url && !(Number(item.durationSeconds) > 0))
    .map((item) => item.url)
    .join('\n');
  useEffect(() => {
    if (!unmeasuredReferenceVideos) return;
    let cancelled = false;
    void (async () => {
      const urls = unmeasuredReferenceVideos.split('\n');
      const measured = await Promise.all(urls.map((url) => probeVideoDurationSeconds(url)));
      if (cancelled) return;
      const byUrl = new Map(urls.map((url, index) => [url, measured[index]]));
      const next = (s.setup.referenceVideos || []).map((item) => (
        byUrl.get(item?.url) > 0 ? { ...item, durationSeconds: byUrl.get(item.url) } : item
      ));
      // Straight through withDurationThatFits: measuring a reference can REMOVE
      // a cap (a short clip frees the range) as easily as impose one.
      s.setup = withDurationThatFits({ ...s.setup, referenceVideos: next });
      bump();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unmeasuredReferenceVideos]);

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
  // The family's head-replacement lane, if it has one. Only its EXISTENCE is
  // read here — the run is routed to it by s.setup.inpaint being armed, not by
  // the model picker, because head replacement is a thing you do to an attached
  // clip rather than a tier you select.
  const inpaintEntry = isHivemindVideoModelId(s.setup.modelId)
    ? inpaintWorkflowForHivemindModel(s.setup.modelId)
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
    clearTimeout(registryRetryRef.current);
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
  // The Advanced disclosure hides the LoRA and ingredient panels, so say on its
  // closed header what is switched on down there — an active adapter or a stale
  // negative prompt steers every generation and must never be invisible state.
  const activeVideoLoras = loraModel ? currentVideoLoraSelection().filter((l) => l.enabled !== false).length : 0;
  const activeIngredients = ingredientModel
    ? activeIngredientSheetItems(ingredientModel, {
      selectedSheet: s.selectedIngredientSheet,
      selections: s.sharedIngredientSelections,
      sheets: s.sharedIngredientSheets,
    }).length
    : 0;
  const advancedHint = [
    activeVideoLoras ? `${activeVideoLoras} LoRA${activeVideoLoras === 1 ? '' : 's'}` : '',
    String(s.setup.negativePrompt || '').trim() ? (zh() ? '负面' : 'negative') : '',
    s.setup.detailerStrength ? (zh() ? '细节增强' : 'detailer') : '',
    s.setup.spectrum === false ? (zh() ? '快速采样关' : 'Spectrum off') : '',
  ].filter(Boolean).join(' · ');

  const arOptions = aspectRatiosFor(s.setup, s.setup.modelId);
  // "Use starting frame aspect ratio": only relevant for a Hivemind LTX start
  // frame (image-driven, not video-extend/ingredients). When on, output matches
  // the frame exactly, so the fixed aspect-ratio selector is overridden.
  const startFrameArMatchAvailable = ltxFramesVisible && Boolean(s.setup.imageUrl);
  const arMatchedToFrame = startFrameArMatchAvailable && s.setup.matchStartFrameAr;
  // A motion reference is trimmed to the clip's own length, so it costs more
  // the longer the clip is and the duration range collapses while one is
  // attached. Offer only what will actually render: the run used to be accepted
  // and then die minutes later on the card, after the references were staged.
  const motionLimit = motionReferenceLimitFor(s.setup, s.setup.modelId, s.rentedMachines);
  const durationOptions = availableDurationsFor(s.setup, s.setup.modelId, s.rentedMachines);
  const fullDurationOptions = durationsFor(s.setup, s.setup.modelId);
  const durationCapped = Boolean(motionLimit) && durationOptions.length < fullDurationOptions.length;
  // WHY the range collapsed. A motion clip is trimmed to the clip's length, so
  // it is the clip's length that has to give; pictures and sound references
  // cost the same at every length, so when they are all that is attached the
  // honest advice is different — shorten the clip, or send fewer of them.
  const motionCapHint = (() => {
    if (!motionLimit) return null;
    const longest = durationOptions[durationOptions.length - 1];
    const card = motionLimit.cardVramGb ? ` on this ${motionLimit.cardVramGb} GB card` : '';
    const bigger = motionLimit.cardVramGb && motionLimit.cardVramGb < 96
      ? ' A bigger card (an RTX PRO 6000) lifts the cap.' : '';
    const biggerZh = motionLimit.cardVramGb && motionLimit.cardVramGb < 96
      ? '换用更大显存的显卡（RTX PRO 6000）可以提高上限。' : '';
    if (motionLimit.referenceVideoCount > 0) {
      return zh()
        ? `最长 ${longest} 秒 — 动作参考会被裁剪到成片长度，因此长参考会把成片也限制在同样长度。改用 ${motionLimit.maxSeconds.toFixed(1)} 秒以内的动作参考，它会保留自身长度、占用更少显存，完整时长即可恢复；移除动作参考同样可以。参考图片无论多长都是固定开销。${biggerZh}`
        : `Up to ${longest}s${card} — a motion reference is trimmed to the clip's own length, so a long reference caps the clip at the same length. Use a motion reference of ${motionLimit.maxSeconds.toFixed(1)}s or less and it keeps its own length instead, costing less and opening the full range. Removing it works too. Reference pictures cost the same whatever the length.${bigger}`;
    }
    const pics = motionLimit.referencePictureCount || 0;
    const sounds = motionLimit.referenceSoundCount || 0;
    const parts = [];
    const partsZh = [];
    if (pics) { parts.push(`${pics} reference picture${pics === 1 ? '' : 's'}`); partsZh.push(`${pics} 张参考图片`); }
    if (sounds) { parts.push(`${sounds} sound reference${sounds === 1 ? '' : 's'}`); partsZh.push(`${sounds} 段参考音频`); }
    const inventory = parts.join(' and ');
    return zh()
      ? `最长 ${longest} 秒 — 成片和${partsZh.join('、')}共用显卡上的同一段序列，成片越长留给参考的空间越少。参考的开销与时长无关，所以只能缩短成片，或少放几个参考。${biggerZh}`
      : `Up to ${longest}s${card} — the clip and everything attached to it share one sequence on the card, and a longer clip leaves less room. Your ${inventory} cost the same at every length, so the clip is what has to give: shorten it, or send fewer references for the full range.${bigger}`;
  })();
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
    // From the request plan, not from imageMode: every local workflow is
    // selected with imageMode true (the frame is an optional input), so H3
    // read "Image → video" with nothing attached — and with references armed.
    const plan = videoRequestPlan(s.setup);
    if (plan.sendReferenceImages) return zh() ? '参考 → 视频' : 'Reference → video';
    if (plan.sendMotionContext) return zh() ? '接续场景' : 'Continue scene';
    const hasFrame = isHivemindVideoModelId(s.setup.modelId) ? Boolean(s.setup.imageUrl) : s.setup.imageMode;
    if (hasFrame) return zh() ? '图片 → 视频' : 'Image → video';
    return zh() ? '文本 → 视频' : 'Text → video';
  })();

  const isSeedanceResult = s.resultModel === 'seedance-v2.0-t2v' || s.resultModel === 'seedance-v2.0-i2v';
  const generateLabel = s.generating ? t('common.generating') : t('common.generate');

  const progressStageLabel = t(`video.progress.${s.progress.stage}`);
  const progressPct = Math.max(0, Math.min(1, Number(s.progressDisplay) || 0));
  const progressValueLabel = `${Math.round(progressPct * 100)}%`;
  const progressElapsedMs = Date.now() - s.generationStartedAt;
  const progressElapsed = formatVideoGenerationElapsed(progressElapsedMs);
  // What is LEFT, not the whole estimate again: past the estimate the honest
  // word is "finishing", not a countdown that went negative.
  const progressRemainingMs = Number(s.progressEstimateSec) > 0 ? s.progressEstimateSec * 1000 - progressElapsedMs : null;
  const progressEta = progressRemainingMs == null
    ? null
    : (progressRemainingMs > 0
      ? `${zh() ? '约剩 ' : '~'}${formatVideoGenerationElapsed(progressRemainingMs)}${zh() ? '' : ' left'}`
      : (zh() ? '即将完成…' : 'finishing…'));
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
  const offlineBlocked = apiStatus.tone === 'offline';

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
          {s.setup.rentedOnly
            ? <RentedSourceStatus engine={s} page="video" pinned={s.setup.rentedMachineId || ''} onPin={pinMachine} />
            : null}
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
                hint={durationCapped
                  ? motionCapHint
                  : (zh()
                    ? '最长 15 秒 — 模型约在 15 秒内保持人物与场景一致，因此不提供更长时长。'
                    : 'Up to 15s — the model keeps people and scenes consistent for about 15 seconds, so longer takes are not offered.')}
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

      {/* The LTX Ingredients workflow's ONLY input, as its own section — it used
          to live inside the collapsed Advanced disclosure, so "Open LTX
          Ingredients" showed a panel with no place to add any. */}
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

      <CollapsibleSection title={zh() ? '高级' : 'Advanced'} hint={advancedHint} storageKey="video.advanced">
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
        {supportsFastHighRes(model) ? (
          <Field
            label={zh() ? '快速高清' : 'Fast high-res'}
            hint={zh()
              ? '先在约五分之一的画布上采样，再用 H3 自己的潜空间放大器把画面提升到目标尺寸，只有最后几步在全尺寸上运行。步数不变，但大部分步数跑在少得多的像素上——在 5090 上实测约快一倍。尺寸、时长和声音都不变。它走的是另一条采样路径，所以同一个种子给出的是另一条镜头，而不是同一条的加速版。'
              : 'Samples the opening steps on a canvas about a fifth the size, lifts the picture to full size with H3\u2019s own latent upscaler, and spends only the last few steps there. Same number of steps, most of them on far fewer pixels \u2014 measured at about half the render time on a 5090. Size, length and sound are unchanged. It samples a different path, so the same seed gives a DIFFERENT take rather than the same one faster.'}
          >
            <Toggle
              checked={s.setup.fastHighRes === true}
              onChange={(next) => commit({ ...s.setup, fastHighRes: next })}
              label={zh() ? '快速高清' : 'Fast high-res'}
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
              <TextArea
                rows={2}
                value={s.setup.negativePrompt || ''}
                onChange={(e) => setNegativePrompt(e.target.value)}
                placeholder={zh()
                  ? '模糊, 解剖错误, 多余手指, 水印'
                  : 'blurry, bad anatomy, extra fingers, deformed hands, watermark'}
                className="resize-y text-xs"
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
              ? (zh()
                ? 'Lightricks 的 IC-LoRA 细节增强会对片段再做一次采样以补足细节纹理，生成时间约为两倍。'
                : "Lightricks' IC-LoRA Detailer runs a second sampling pass over the clip to add fine texture. Roughly doubles generation time.")
              : (zh() ? '关闭 — 单次采样，速度不变。' : 'Off — one pass, exactly as fast as before.')}
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
                ? (zh() ? '运动自适应的时域去噪加一次空域去噪，生成后重新编码。' : 'Motion-adaptive temporal pass + a spatial pass. Re-encodes after generation.')
                : (zh() ? '运动自适应的时域去噪：平均静态颗粒，保留运动细节。' : 'Motion-adaptive temporal pass: averages static grain, leaves moving detail alone.'))
              : (zh() ? '关闭 — 按模型渲染的原样保存。' : 'Off — the clip is saved exactly as the model rendered it.')}
          >
            <NativeSelect
              value={s.setup.denoise || ''}
              onChange={(e) => commit({ ...s.setup, denoise: e.target.value })}
            >
              <option value="">{zh() ? '关闭' : 'Off'}</option>
              <option value="light">{zh() ? '轻度' : 'Light'}</option>
              <option value="strong">{zh() ? '强' : 'Strong'}</option>
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
      </CollapsibleSection>
        </>
      )}
    </>
  );

  /* ---------------- composer drops ---------------- */

  // Dropping a picture, a clip or a voice note ON THE COMPOSER attaches it as
  // an input rather than restoring the settings of whatever made it — that is
  // what the rest of the window is for. Which slot it lands in follows from
  // what the file is, and from what this model actually has: a workflow with
  // reference rows files them by kind; anything else takes a picture as its
  // start frame and a clip as its source video.
  const referenceLimits = () => ({
    images: referenceEntry?.referenceSlots?.images || 9,
    audios: referenceEntry?.referenceSlots?.audios || 3,
    videos: referenceEntry?.referenceSlots?.videos || 3,
  });
  const attachedReferences = () => ({
    images: Array.isArray(s.setup.referenceImageUrls) ? s.setup.referenceImageUrls : [],
    videos: Array.isArray(s.setup.referenceVideos) ? s.setup.referenceVideos : [],
    audios: Array.isArray(s.setup.referenceAudios) ? s.setup.referenceAudios : [],
  });
  // Measured clip lengths, as far as they are known. peekMediaDuration reads
  // the cache the References panel filled when it measured these; anything
  // never opened comes back null and the budget reports it as unmeasured
  // rather than as zero.
  const referenceDurations = () => {
    const { videos, audios } = attachedReferences();
    const out = {};
    for (const item of [...videos, ...audios]) {
      const url = referenceUrl(item);
      const seconds = url ? peekMediaDuration(url) : null;
      if (seconds != null) out[url] = seconds;
    }
    return out;
  };

  const attachDroppedToReferenceRows = async (files) => {
    const current = attachedReferences();
    const { added, rejected } = await attachDroppedReferences({
      files,
      taken: { images: current.images.length, videos: current.videos.length, audios: current.audios.length },
      limits: referenceLimits(),
      upload: referenceUploader(uploadFnForFrame),
    });
    if (added.images.length) onCharacterRefsChange([...current.images, ...added.images.map((item) => item.url)]);
    if (added.videos.length) {
      onReferenceVideosChange([...current.videos, ...added.videos.map((item) => ({ ...item, useAudio: false, compact: false }))]);
    }
    if (added.audios.length) onReferenceAudiosChange([...current.audios, ...added.audios]);
    for (const rejection of rejected) {
      if (rejection.error) console.error('[VideoStudio] composer drop upload failed:', rejection.error);
      toast.error(describeReferenceRejection(rejection));
    }
    // The rows are behind a closed panel, so the drop has to say where it went.
    const summary = describeReferenceAttachment({
      images: added.images.length,
      videos: added.videos.length,
      audios: added.audios.length,
    });
    if (summary) toast.success(summary);
  };

  // No reference rows on this model: a picture is the shot's first frame, a
  // clip is the source video (the same path its own button takes, confirms and
  // all), and a voice clip has nowhere to go — say so rather than swallow it.
  const attachDroppedToFrames = async (files) => {
    const picture = files.find((file) => referenceKindForFile(file) === 'images');
    const clip = files.find((file) => referenceKindForFile(file) === 'videos');
    if (picture) {
      const uploaded = await referenceUploader(uploadFnForFrame)('images', picture);
      onStartFrameChange([uploaded.url]);
      toast.success(zh() ? '已设为起始帧' : 'Attached as the start frame');
    }
    if (clip) await handleVideoFile(clip);
    for (const file of files) {
      if (file === picture || file === clip) continue;
      toast.error(describeReferenceRejection({
        name: file.name,
        code: referenceKindForFile(file) ? 'full' : 'unsupported',
        kind: referenceKindForFile(file),
        limit: 1,
      }));
    }
  };

  const handleComposerFiles = async (files) => {
    if (!files.length) return;
    // Same gate the pickers use, with the same retry continuation: the files
    // are attached once a key is saved.
    if (frameRequiresApiKey() && muapiKeyMissing()) {
      s.authRetry = () => { void handleComposerFiles(files); };
      s.authOpen = true;
      bump();
      return;
    }
    s.composerAttaching = true;
    bump();
    try {
      if (referenceEntry) await attachDroppedToReferenceRows(files);
      else await attachDroppedToFrames(files);
    } catch (err) {
      console.error('[VideoStudio] composer drop failed:', err);
      toast.error(err?.message || (zh() ? '附加失败' : 'Could not attach that.'));
    } finally {
      s.composerAttaching = false;
      bump();
    }
  };

  // An output dragged out of the strip carries a URL, not bytes. It goes up the
  // same way an imported persona's media does — decrypted in the browser, then
  // re-uploaded and re-sealed as a reference of its own.
  const handleComposerOutput = async (payload) => {
    const kind = referenceKindForOutput(payload);
    s.composerAttaching = true;
    bump();
    try {
      const current = attachedReferences();
      const limits = referenceLimits();
      if (!referenceEntry) {
        if (kind !== 'images') {
          toast.error(zh() ? '该模型只接受起始帧图片' : 'This model takes a picture as its start frame.');
          return;
        }
        onStartFrameChange([await promoteOutputToReference(payload.url)]);
        toast.success(zh() ? '已设为起始帧' : 'Attached as the start frame');
        return;
      }
      if (current[kind].length >= limits[kind]) {
        toast.error(describeReferenceRejection({
          name: basenameOf(payload.url),
          code: 'full',
          kind,
          limit: limits[kind],
        }));
        return;
      }
      const mediaKind = kind === 'images' ? 'image' : (kind === 'videos' ? 'video' : 'audio');
      const url = await promoteOutputToReference(payload.url, { kind: mediaKind });
      const name = basenameOf(payload.url);
      if (kind === 'images') onCharacterRefsChange([...current.images, url]);
      else if (kind === 'videos') onReferenceVideosChange([...current.videos, { url, name, useAudio: false, compact: false }]);
      else onReferenceAudiosChange([...current.audios, { url, name }]);
      toast.success(describeReferenceAttachment({
        images: kind === 'images' ? 1 : 0,
        videos: kind === 'videos' ? 1 : 0,
        audios: kind === 'audios' ? 1 : 0,
      }));
    } catch (err) {
      console.error('[VideoStudio] composer output drop failed:', err);
      toast.error(err?.message || (zh() ? '附加失败' : 'Could not attach that.'));
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
    hint: (dataTransfer) => (referenceEntry
      ? composerReferenceHint(referenceKindsInDrag(dataTransfer))
      : composerFrameHint(referenceKindsInDrag(dataTransfer))),
    onDrop: (dataTransfer) => {
      const files = Array.from(dataTransfer?.files || []);
      if (files.length) { void handleComposerFiles(files); return; }
      const payload = droppedOutputPayload(dataTransfer);
      if (payload) void handleComposerOutput(payload);
    },
  };

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
        {/* WHO is in the shot — every way of adding someone lands here, and the
            weave recasts the prompt the moment it changes. Every family shows
            it: on H3 a person from pictures becomes <Subject N> in reference
            mode, and on every model a known character is written into the
            scene by its source form. */}
        {!promptUi.disabled ? (
          <CastStrip
            members={s.cast}
            onMembersChange={applyCast}
            target={weaveTargetNow()}
            referenceLane={referenceLaneAvailable()}
            h3={isH3()}
            woven={isWovenForReference(s.setup.prompt)}
            promptEmpty={!s.setup.prompt.trim()}
            warnings={s.castWarnings}
            onAttach={() => { s.referencesOpenRequest = (s.referencesOpenRequest || 0) + 1; bump(); }}
            onWeave={() => {
              const before = weaveSnapshot();
              const woven = acceptPrompt(s.setup.prompt, { scaffold: true });
              if (woven.prompt !== before.prompt) announceWeave(zh() ? '已把参考织入提示词' : 'Wove your references into the prompt', before);
              focusPrompt();
            }}
            onDraftLook={draftLookFor}
            onAddMedia={referenceLaneAvailable() ? addMediaForMember : null}
          />
        ) : null}
        <textarea
          ref={promptRef}
          rows={1}
          placeholder={promptUi.placeholder}
          disabled={promptUi.disabled}
          value={s.setup.prompt}
          onChange={(e) => setPrompt(e.target.value)}
          // ⌘/Ctrl+Enter generates, the same as every other composer; the same
          // guards as the button, so it can never start what the button refuses.
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
            e.preventDefault();
            if (rentedBlocked || s.generating) return;
            void generate();
          }}
          className="max-h-[150px] min-h-[40px] w-full resize-none overflow-y-auto border-none bg-transparent px-1 pt-1 text-[15px] leading-relaxed text-ink1 outline-none placeholder:text-ink3 disabled:opacity-50 md:max-h-[250px]"
        />

        {/* Two groups: the chips wrap as a group, Generate stays pinned at the
            right on every width. One flex-wrap row held both, so below ~1280px
            the primary button dropped to a second row, left-aligned, under the
            chips — the one control a first-timer looks for, in the wrong place. */}
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
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
              // Labelled, not the compact square: it sits beside labelled chips,
              // and an unlabelled icon next to "Clip" read as a second clip button.
              <UploadPicker
                values={s.setup.imageUrl ? [s.setup.imageUrl] : []}
                onChange={onStartFrameChange}
                uploadFn={uploadFnForFrame}
                requireApiKey={frameRequiresApiKey}
                maxImages={1}
                accept="image/*"
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
                // The explicit Weave lives in ONE place now — Prompt Check, and
                // the cast strip's own readout — so the panel no longer shows a
                // third copy of the button. (It still accepts onWeave; nothing
                // is passed.)
                durationSeconds={Number(s.setup.duration) || 0}
                limits={{
                  images: referenceEntry.referenceSlots?.images || 9,
                  audios: referenceEntry.referenceSlots?.audios || 3,
                  videos: referenceEntry.referenceSlots?.videos || 3,
                }}
                scene={sceneUrls()}
                sceneRoles={sceneRoleMap()}
                onSceneRole={onSceneRole}
                onChange={{
                  images: onCharacterRefsChange,
                  scene: onSceneRefsChange,
                  audios: onReferenceAudiosChange,
                  videos: onReferenceVideosChange,
                }}
                persona={s.setup.persona || null}
                onPersonaChange={onPersonaChange}
                // What the strip already knows about the person in the rows —
                // so "Save as persona" starts from it.
                personaSeed={(() => {
                  const holder = s.cast.find((member) => member.kind === 'persona');
                  return holder ? { gender: holder.data?.gender || '', look: holder.data?.look || '' } : null;
                })()}
                uploadFn={uploadFnForFrame}
                requireApiKey={frameRequiresApiKey}
                openRequest={s.referencesOpenRequest || 0}
                // Head replacement's one door. Offered only on a family whose
                // registry actually carries an inpaint graph, so the thumbnail
                // never opens a dialog whose Apply the run would ignore.
                onOpenClip={inpaintEntry ? (index) => { s.inpaintOpenIndex = index; bump(); } : null}
              />
            ) : null}

            <input
              ref={videoFileInputRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => { void handleVideoFile(e.target.files?.[0]); e.target.value = ''; }}
            />
            {/* The cast strip's per-member attach — files land claimed for the
                member whose chip opened this picker. */}
            <input
              ref={memberFileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                const key = e.target.dataset.memberKey || '';
                e.target.value = '';
                if (key && files.length) void attachFilesForMember(key, files);
              }}
            />
            {/* A labelled chip like its neighbours. On H3 this arms scene
                chaining (continueSceneFrom), not the LTX extension graph, so the
                title says that rather than the generic slot hint. */}
            <ChipButton
              icon="video"
              label={zh() ? '片段' : 'Clip'}
              value={attachedClipUrl() ? (s.setup.videoName || (zh() ? '已附加' : 'attached')) : ''}
              active={Boolean(attachedClipUrl())}
              chevron={false}
              disabled={s.videoUploading}
              aria-label={attachedClipUrl()
                ? `${s.setup.videoName || slotLabels.video} — ${zh() ? '点击清除' : 'click to clear'}`
                : (chainCapableEntryFor(s.setup.modelId)
                  ? (zh() ? '从一段片段接续' : 'Continue from a clip')
                  : `${zh() ? '上传' : 'Upload'} ${slotLabels.video}`)}
              title={attachedClipUrl()
                ? `${s.setup.videoName || slotLabels.video} — ${zh() ? '点击清除' : 'click to clear'}`
                : (chainCapableEntryFor(s.setup.modelId)
                  ? (zh()
                    ? '从一段片段接续：下一个镜头从它的结尾开始（画面与环境音衔接）'
                    : 'Continue from a clip — the next shot picks up where it ends, motion and room tone carrying across')
                  : `${zh() ? '上传' : 'Upload'} ${slotLabels.video}${slotLabels.videoHint ? ` — ${slotLabels.videoHint}` : ''}`)}
              onClick={onVideoRefClick}
            />
            {s.videoUploading ? <Spinner size={14} className="text-honey" /> : null}

            {/* The prompt-writing chips mean nothing on a tool whose prompt is
                disabled (a watermark remover), so they go with the textarea. */}
            {promptUi.disabled ? null : (
            <>
              <SavedPromptsMenu
                section="video"
                prompt={s.setup.prompt}
                modelSource={s.setup}
                // Starters render for whoever holds <Subject 1> — the loaded
                // persona, or the first cast member — so the pronouns already fit
                // before the stand-in is bound.
                renderGender={castRenderGender(s.cast) || s.setup.persona?.gender || ''}
                standIns={liveStandIns(s.setup.prompt, s.standIns)}
                capture={() => captureGenerationContext(s.setup.prompt)}
                onLoadPrompt={({ prompt, standIns, timeline, durationSeconds }) => {
                  loadPromptText(prompt, { standIns: standIns || [] });
                  applyStarterSetup({ timeline, durationSeconds });
                  focusPrompt();
                }}
                onLoadContext={(context) => restoreGenerationContext(context)}
              />

              <CameraMotionMenu
                selectedIds={s.setup.cameraMotionIds || []}
                onApply={applyCameraMotions}
              />

              {/* Restyle presets, the UGC brief ([Shot 1] HOOK … / (S1) says …),
                  the Shot Builder and Prompt Check all write H3's own grammar, so
                  every one of them is H3-only — the UGC brief used to land in LTX
                  and cloud prompts too. */}
              {isH3() ? (
                <>
                  <UgcMenu
                    mode="video"
                    active={hasUgcVideoBrief(s.setup.prompt)}
                    variantIndex={Number.isInteger(s.setup.ugcVariantIndex) ? s.setup.ugcVariantIndex : null}
                    gender={s.setup.persona?.gender || ''}
                    subject={ugcSubjectLabel(ugcPersona())}
                    durationSeconds={Number(s.setup.duration) || null}
                    verticalAvailable={aspectRatiosFor(s.setup, s.setup.modelId).includes('9:16')}
                    onArm={applyUgc}
                  />
                  <RestyleMenu activeId={s.setup.restylePresetId || null} onApply={applyRestyle} />
                  {/* The cast needs reference slots to put its personas in, so it
                      only appears on a workflow that has them. */}
                  {/* The timeline inside one generation, and the gate in front of
                      it. Both read H3's own grammar, so both are H3-only. */}
                  <ShotBuilderChip
                    timeline={s.shotTimeline}
                    prompt={s.setup.prompt}
                    onOpen={() => { s.shotBuilderOpen = true; bump(); }}
                  />
                  <PromptCheckMenu
                    prompt={s.setup.prompt}
                    durationSeconds={Number(s.setup.duration) || 0}
                    {...attachedReferences()}
                    durations={referenceDurations()}
                    // The one finding with a mechanical fix, and the last door:
                    // adoptPrompt catches a prompt arriving from somewhere, and
                    // withDurationThatFits catches the length changing under one
                    // already written. This catches the rest — text TYPED or PASTED
                    // straight into the composer, which nothing else can see.
                    onRefit={() => commit({ ...s.setup, prompt: adoptPrompt(s.setup.prompt) })}
                    onWeave={() => {
                      const before = weaveSnapshot();
                      const woven = acceptPrompt(s.setup.prompt, { scaffold: true });
                      if (woven.prompt !== before.prompt) announceWeave(zh() ? '已把参考织入提示词' : 'Wove your references into the prompt', before);
                      focusPrompt();
                    }}
                    onRefine={() => { s.promptHelperOpen = true; bump(); }}
                  />
                </>
              ) : null}

              {/* The helper, named for what it does here: it refines what is in
                  the box — told the cast, the lane, the clip length and the
                  attached references — rather than replacing it. A labelled chip,
                  not an icon: this is the one button a first-timer needs to find.
                  `value`, not `label`: ChipButton paints a label muted, and this is
                  an action, not a menu. */}
              <ChipButton
                icon="sparkles"
                value={zh() ? '润色' : 'Refine'}
                chevron={false}
                disabled={!s.setup.prompt.trim()}
                onClick={() => { s.promptHelperOpen = true; bump(); }}
                title={zh()
                  ? '让本地助手按当前模型的提示词指南、演员表和片长改写提示词'
                  : "Rewrite what is in the box with the prompt helper — it knows this model's prompting guide, the cast, the lane and the clip length"}
              />
            </>
            )}
          </div>

          {/* Mode and model read out in the left panel — no duplicate badges here. */}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="primary"
              size="lg"
              loading={s.generating}
              disabled={offlineBlocked || rentedBlocked || (swapState.active && !swapState.ready)}
              onClick={generate}
              title={offlineBlocked
                ? (zh() ? '工作室没有运行——重新启动后即可生成。' : 'The studio is not running — start it again to generate.')
                : rentedBlocked
                ? (zh() ? '请先租用机器（或把来源切回本地）再生成。' : 'Rent a machine (or switch the source to Local) to generate.')
                : (swapState.active && !swapState.ready)
                  ? `${zh() ? '还需要：' : 'Still needed: '}${swapState.missing.join(zh() ? '、' : ' and ')}`
                  : `${t('video.generateTooltip')} (⌘/Ctrl+Enter)`}
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
    </div>
  );

  /* ---------------- canvas ---------------- */

  const hasHistory = s.generationHistory.length > 0;

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <StudioLayout
        panel={panel}
        panelTitle={zh() ? '视频设置' : 'Video settings'}
        composer={composer}
        composerDrop={composerDrop}
      >
        <div className="flex flex-col gap-4 p-4 md:p-5">
          {s.generateError ? (() => {
            // Name the box when the run was promised to a rented one — "it
            // failed" on a rental means a different next step.
            const onRented = (() => {
              if (!s.setup.rentedOnly) return '';
              const machine = servingMachineFor(s.setup, s.setup.modelId, s.rentedMachines);
              if (!machine) return zh() ? '（租用机器）' : ' on the rented machine';
              return zh()
                ? `（租用机器 ${machine.gpu || ''} ${machine.rental_id || ''}）`
                : ` on ${machine.gpu || 'the rented machine'} (${machine.rental_id || 'rented'})`;
            })();
            return (
              <FailureCallout
                title={`${s.generateError}${onRented}`}
                detail={s.generateFailure?.detail || ''}
                remedy={s.generateFailure?.remedy || null}
                onRemedy={(remedy) => void runFailureRemedy(remedy, {
                  onMuapiKey: () => { s.authRetry = () => generate(); s.authOpen = true; bump(); },
                  onRetry: () => { s.generateError = ''; s.generateFailure = null; bump(); void generate(); },
                })}
                onRetry={() => { s.generateError = ''; s.generateFailure = null; bump(); void generate(); }}
                retryLabel={zh() ? '重试' : 'Try again'}
                detailsLabel={zh() ? '详情' : 'Details'}
                onDismiss={() => { s.generateError = ''; s.generateFailure = null; bump(); }}
                dismissLabel={zh() ? '关闭' : 'Dismiss'}
              />
            );
          })() : null}

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
                <span>{t('video.progress.elapsed')} {progressElapsed}{progressEta ? ` · ${progressEta}` : ''}</span>
              </div>
              {s.progressOvertimeMin ? (
                <div className="text-[11px] text-ink3">
                  {zh()
                    ? `已渲染 ${s.progressOvertimeMin} 分钟，仍在进行 — 可以继续等待，或用上方的“取消”停止。`
                    : `Still rendering after ${s.progressOvertimeMin} min — keep waiting, or use Cancel above to stop.`}
                </div>
              ) : null}
            </Card>
          ) : null}

          {s.resultUrl ? (
            <div className="flex flex-col items-center gap-3">
              <ResultVideo
                key={s.resultUrl}
                url={s.resultUrl}
                unmuted={Boolean(s.resultUnmuted)}
                // H3 renders audio with every clip; other lanes are silent
                // unless a join carried sound through.
                hasAudio={/minimax/.test(String(s.resultModel || ''))
                  || (s.chainCombined?.url === s.resultUrl && Boolean(s.chainCombined?.audioJoined))
                  || (s.timelineCombined?.url === s.resultUrl && Boolean(s.timelineCombined?.audioJoined))}
              />
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
                  variant="neutral"
                  icon="download"
                  onClick={() => {
                    const entry = s.generationHistory.find((e) => e.url === s.resultUrl);
                    downloadFile(s.resultUrl, videoDownloadName(entry?.model || s.resultModel, entry?.id));
                  }}
                >
                  {t('video.download')}
                </Button>
                <Button
                  variant="neutral"
                  icon="upload"
                  onClick={() => {
                    const entry = s.generationHistory.find((e) => e.url === s.resultUrl);
                    // Same rule as the Image studio: the LoRAs recorded against
                    // THIS clip's context, never the composer's current pick.
                    const made = s.contextStore.recall(s.resultUrl);
                    s.civitaiPost = {
                      url: s.resultUrl,
                      entry: {
                        ...(entry || { model: s.resultModel }),
                        civitaiResources: civitaiResourcesFromLoras(made?.loras, s.availableVideoLoras),
                      },
                    };
                    bump();
                  }}
                  title={zh()
                    ? '把这段视频未加密地发布到 Civitai'
                    : 'Publish this clip to Civitai — it leaves this device unencrypted'}
                >
                  {zh() ? '发布到 Civitai' : 'Post to Civitai'}
                </Button>
                <Button variant="neutral" icon="plus" onClick={newPrompt}>{t('video.new')}</Button>
              </div>
            </div>
          ) : null}

          {/* The manual timeline: segment cards under the player. One button
              opens it; everything else — auto-insert, the quiet full-cut
              build, drops, Auto-continue — hangs off lib/videoTimeline.js. */}
          {(() => {
            if (!s.timelineOn) {
              return (
                <div className="flex justify-end">
                  <ChipButton
                    icon="layers"
                    value={zh() ? '时间线' : 'Timeline'}
                    chevron={false}
                    onClick={openTimelineView}
                    title={zh()
                      ? '把多段片段排成一条时间线：逐段生成、拖放片段、预览完整合成片'
                      : 'Arrange clips into a sequence: generate shot by shot, drag clips in, preview the full cut'}
                  />
                </div>
              );
            }
            const modelEntry = currentModel(s.setup, s.catalogs);
            const extendMode = timelineExtendModeFor(modelEntry);
            const selectedSeg = s.timelineSegments.find((seg) => seg.id === s.timelineSelectedId);
            return (
              <TimelineStrip
                zh={zh()}
                segments={s.timelineSegments}
                selectedId={s.timelineSelectedId}
                pendingSegmentId={s.generating && selectedSeg && !selectedSeg.url ? selectedSeg.id : ''}
                extendAvailable={Boolean(extendMode)}
                extendMode={extendMode}
                extendOn={s.timelineExtend}
                onToggleExtend={timelineToggleExtend}
                canCombine={timelineCanCombine(s.timelineSegments)}
                showCombined={s.timelineShowCombined}
                combined={s.timelineCombined}
                building={s.timelineBuilding}
                buildError={s.timelineBuildError}
                onToggleCombined={timelineToggleCombined}
                onExportCombined={() => void exportTimelineCut()}
                onSelect={timelineSelect}
                onAdd={timelineAdd}
                onRemove={timelineRemoveRequest}
                onClose={closeTimelineView}
                onDrop={timelineHandleDrop}
                promptFor={timelinePromptFor}
              />
            );
          })()}

          {/* The episode, above its shots: chaining produces one clip per shot,
              so without this the finished cut was only ever a downloaded file. */}
          {(() => {
            // The manual timeline supersedes the derived chain strip while it
            // is open — two rows of near-identical cards would fight over the
            // same clicks.
            if (s.timelineOn) return null;
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
                onSelect={(url, model) => showVideoInCanvas(url, model, { anchorChain: false, userInitiated: true })}
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
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        openHistoryEntry(entry);
                      }}
                    >
                      <HistoryThumb url={entry.url} />
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-bg0/90 to-transparent p-2 pt-6 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
                        <div className="truncate text-[11px] text-ink1">
                          {entry.prompt_private ? (zh() ? '私密提示词（已隐去）' : 'Private prompt (hidden)') : (entry.prompt || '—')}
                        </div>
                        <div className="truncate font-mono text-[10px] text-ink3">{entry.model || ''}</div>
                      </div>
                      {/* Visible on keyboard focus too, not only under a pointer. */}
                      <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
                        {chainCapableEntryFor(entry.model) ? (
                          <IconButton
                            icon="arrowRight"
                            size="sm"
                            label={zh() ? '接续场景：下一个镜头从这段结尾继续' : 'Continue scene: the next shot picks up where this clip ends'}
                            className="border border-line1 bg-bg0/80 hover:border-honey/40"
                            onClick={(e) => { e.stopPropagation(); continueSceneFrom(entry.url, entry.model); }}
                          />
                        ) : null}
                        <IconButton
                          icon="download"
                          size="sm"
                          label={zh() ? '下载视频' : 'Download video'}
                          className="border border-line1 bg-bg0/80 hover:border-line2"
                          onClick={(e) => {
                            e.stopPropagation();
                            // No `|| idx` — see ImageStudio: the seal keys off entry.id.
                            downloadFile(entry.url, videoDownloadName(entry.model, entry.id));
                          }}
                        />
                        <IconButton
                          icon="trash"
                          size="sm"
                          label={zh() ? '从列表中删除' : 'Remove from the strip'}
                          className="border border-line1 bg-bg0/80 text-danger hover:border-danger/40"
                          onClick={(e) => { e.stopPropagation(); s.deleteTarget = entry; bump(); }}
                        />
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

      {s.civitaiPost ? (
        <CivitaiPostDialog
          url={s.civitaiPost.url}
          entry={s.civitaiPost.entry}
          filename={videoDownloadName(s.civitaiPost.entry?.model || s.resultModel, s.civitaiPost.entry?.id)}
          onClose={() => { s.civitaiPost = null; bump(); }}
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

      {/* Same gate as the chip: the grammar it writes ([Shot N], <d>, the six
          sections) is H3's, so switching to another family closes it rather
          than leaving an H3 dialog open over a Seedance run. */}
      {/* Mounted only while open: its memo work (compose + check) otherwise
          ran on every composer keystroke with the dialog closed. */}
      {Boolean(s.shotBuilderOpen) && isH3() ? (
      <ShotBuilderDialog
        open
        onClose={() => { s.shotBuilderOpen = false; bump(); }}
        timeline={s.shotTimeline}
        onTimelineChange={(next) => { s.shotTimeline = next; bump(); }}
        prompt={s.setup.prompt}
        durationSeconds={Number(s.setup.duration) || 0}
        references={attachedReferences()}
        firstFrame={s.setup.imageUrl || ''}
        lastFrame={s.setup.endImageUrl || ''}
        onApply={(text) => { acceptPrompt(text); focusPrompt(); }}
      />
      ) : null}

      {/* targetModel is the workflow id, not the picker id: the helper chooses its
          guidance from it, and 10Eros 1.3/1.4 want a different prompt shape than
          the 1.2-era lanes. */}
      {/* Head replacement. Opened from an attached motion clip's own thumbnail;
          Apply arms s.setup.inpaint, which is the ONE thing that routes the run
          to the inpaint graph. Removing the clip disarms it (below), so a run
          can never be pointed at a clip that is no longer attached. */}
      {s.inpaintOpenIndex != null && (s.setup.referenceVideos || [])[s.inpaintOpenIndex]?.url ? (
        <VideoInpaintDialog
          open
          sourceUrl={s.setup.referenceVideos[s.inpaintOpenIndex].url}
          sourceName={s.setup.referenceVideos[s.inpaintOpenIndex].name || ''}
          referenceCount={(s.setup.referenceImageUrls || []).filter(Boolean).length}
          // What head replacement will NOT send, so the dialog can say so before
          // Apply rather than the run quietly dropping them.
          otherReferences={{
            motion: (s.setup.referenceVideos || []).filter((item, index) => item?.url && index !== s.inpaintOpenIndex).length,
            voice: (s.setup.referenceAudios || []).filter((item) => item?.url).length,
          }}
          initial={s.setup.inpaint?.url === s.setup.referenceVideos[s.inpaintOpenIndex].url
            ? s.setup.inpaint.settings
            : null}
          onClose={() => { s.inpaintOpenIndex = null; bump(); }}
          onApply={(result) => {
            const clip = s.setup.referenceVideos[s.inpaintOpenIndex];
            s.setup = {
              ...s.setup,
              inpaint: {
                url: clip.url,
                name: clip.name || '',
                maskSource: result.maskSource,
                maskDataUrl: result.maskDataUrl,
                // A hosted run produced a mask CLIP: one frame per source
                // frame, already tracked, so the lane needs no SAM3 of its own.
                maskVideoBase64: result.maskVideoBase64 || '',
                seconds: result.seconds,
                dials: result.dials,
                settings: result.settings,
              },
            };
            s.inpaintOpenIndex = null;
            updateComposerDraft({ prompt: s.setup.prompt });
            bump();
          }}
        />
      ) : null}
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
        // Measured lengths ride along so the writer knows what the motion
        // actually covers. peekMediaDuration reads the cache ReferencesMenu
        // filled when the panel measured these; anything unmeasured comes back
        // null and the server treats it as unmeasured rather than as zero.
        references={refsArmed ? {
          images: (s.setup.referenceImageUrls || []).length,
          videos: (s.setup.referenceVideos || []).map((item) => ({
            useAudio: Boolean(item?.useAudio),
            seconds: peekMediaDuration(referenceUrl(item)),
          })),
          audios: (s.setup.referenceAudios || []).length,
          audioSeconds: (s.setup.referenceAudios || []).map((item) => peekMediaDuration(referenceUrl(item))),
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
        // Only the gender travels, never the name: the saved persona is sealed
        // to the owner's vault and this host never learns what it is called.
        personaGender={s.setup.persona?.gender || ''}
        // Who is in the shot, by slot — so the helper writes <Subject N> into
        // the scene instead of inventing a stranger. Names travel only for
        // known characters; a persona's is vault-sealed.
        cast={castSubjects(s.cast)}
        onUse={(prompt) => {
          // The helper's draft is a prompt arriving through a door like any
          // other: woven onto the cast (its own definitions are replaced by
          // the cast's, which are the truth about what is attached) and
          // re-timed — small models overshoot the clip length anyway,
          // measured 2026-08-09.
          acceptPrompt(prompt);
          focusPrompt();
        }}
      />

      <ConfirmModal
        open={Boolean(s.deleteTarget)}
        onClose={() => { s.deleteTarget = null; bump(); }}
        onConfirm={confirmDeleteHistoryEntry}
        title={zh() ? '删除视频' : 'Delete video'}
        body={zh() ? '从本次会话的列表中移除这个视频（它仍保留在历史记录中心）。' : 'Remove this video from this session\'s strip. It stays in the History hub.'}
        confirmLabel={zh() ? '删除' : 'Delete'}
      />

      {/* Removing a timeline segment: the segment always goes; the FILE goes
          only when the toggle inside says so — and the toggle is only offered
          once a deletable file was actually found on this device. */}
      <ConfirmModal
        open={Boolean(s.timelineDeleteTarget)}
        onClose={() => { s.timelineDeleteTarget = null; bump(); }}
        onConfirm={() => void confirmTimelineRemove()}
        title={zh() ? '移除这一段？' : 'Remove this segment?'}
        body={(
          <div className="flex flex-col gap-3">
            <p className="text-[13px] leading-relaxed text-ink2">
              {zh()
                ? '把这一段从时间线中移除。片段本身仍保留在会话列表和历史记录中心。'
                : 'The segment comes off the timeline. The clip itself stays in the session strip and the History hub.'}
            </p>
            <label className={cx(
              'flex items-start gap-2.5',
              !s.timelineDeleteTarget?.row && 'cursor-default opacity-60',
            )}
            >
              <Toggle
                checked={Boolean(s.timelineDeleteTarget?.deleteDisk)}
                disabled={!s.timelineDeleteTarget?.row}
                onChange={(value) => {
                  if (!s.timelineDeleteTarget) return;
                  s.timelineDeleteTarget = { ...s.timelineDeleteTarget, deleteDisk: value };
                  bump();
                }}
                label={zh() ? '同时删除视频文件' : 'Also delete the video?'}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] text-ink1">{zh() ? '同时删除视频文件' : 'Also delete the video?'}</span>
                <span className={cx('text-[11px]', s.timelineDeleteTarget?.deleteDisk ? 'text-danger' : 'text-ink3')}>
                  {s.timelineDeleteTarget?.resolvingRow
                    ? (zh() ? '正在检查本机文件…' : 'Checking for the file on this device…')
                    : s.timelineDeleteTarget?.row
                      ? (zh()
                        ? '将从本机和历史记录中永久删除该文件，无法恢复。'
                        : 'Permanently deletes the file from this device, along with its History row. This cannot be undone.')
                      : (zh()
                        ? '本机上没有这个片段的文件可删（云端结果，或已被删除）。'
                        : 'No file to delete on this device — a cloud result, or one already gone.')}
                </span>
              </span>
            </label>
          </div>
        )}
        confirmLabel={s.timelineDeleteTarget?.deleteDisk
          ? (zh() ? '移除并删除文件' : 'Remove and delete file')
          : (zh() ? '移除' : 'Remove')}
      />

      {/* A drop onto a filled card replaces its clip — said out loud first,
          because the clip being replaced was placed there on purpose. */}
      <ConfirmModal
        open={Boolean(s.timelineReplaceTarget)}
        tone="primary"
        onClose={() => { s.timelineReplaceTarget = null; bump(); }}
        onConfirm={confirmTimelineReplace}
        title={zh() ? '替换这一段？' : 'Replace this clip?'}
        body={zh()
          ? '拖入的片段将取代这一段现有的片段。被替换的片段仍保留在会话列表和历史记录中。'
          : 'The dropped clip takes this segment\'s place. The clip it replaces stays in the strip and in History.'}
        confirmLabel={zh() ? '替换' : 'Replace'}
        cancelLabel={zh() ? '保留原片段' : 'Keep the current clip'}
      />

      {/* Attaching a source clip costs a model switch and/or the attached
          references — said out loud, with a way out, before anything uploads. */}
      <ConfirmModal
        open={Boolean(s.sourceSwitchConfirm)}
        tone="primary"
        onClose={() => answerSourceSwitch(false)}
        onConfirm={() => answerSourceSwitch(true)}
        title={zh() ? '附加这段片段？' : 'Attach this clip?'}
        body={(
          <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink2">
            {(s.sourceSwitchConfirm?.lines || []).map((line) => <p key={line}>{line}</p>)}
          </div>
        )}
        confirmLabel={zh() ? '切换并附加' : 'Switch and attach'}
        cancelLabel={zh() ? '保持不变' : 'Keep as is'}
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
