// Video Studio — React port of the retired vanilla studio (git history: src/components/VideoStudio.js).
// T2V / I2V / V2V / local Hivemind LTX workflows / Wan2GP, model+parameter
// selection, LTX Ingredients reference sheets, LoRA management, job-based
// generation with resume, and history.
//
// This file is the STATE and the WIRING; it no longer draws the route. Its
// render mounts StudioFrame with four surfaces — video/VideoStage.jsx (the
// player, the mid-render readout, the empty state), video/VideoRail.jsx (the
// sequence and the earlier clips), video/VideoComposerBar.jsx (the prompt, the
// recipe sentence and the tool doors) and video/VideoAdvanced.jsx (the drawer
// that replaced the permanent settings column) — and hands each one values it
// already had and handlers it already called. The failure callout and the
// dependency prompt ride StudioFrame's `notices` slot, which is their only
// home: VideoStage deliberately carries neither.
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
// - Media <video>/<img> srcs resolve through useMediaSrc / useMediaPoster (E2E
//   decrypt, fail-open) inside the surfaces above.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'react-hot-toast';

import { muapi } from '../lib/muapi.js';
import { localRow, muapiKeyMissing, muapiRow, runVideo, studioRow } from '../lib/modelRunner.js';
import { describeFailure } from '../lib/describeFailure.js';
import { runFailureRemedy } from '../lib/failureRemedy.js';
import { WorkflowDependencyPrompt } from '../components/WorkflowDependencyPrompt.jsx';
import { checkWorkflowDependencies, dependenciesBlockGeneration } from '../lib/workflowDependencies.js';
import { toastFailure } from '../ui/failureToast.jsx';
import { localAI, isLocalAIAvailable } from '../lib/localInferenceClient.js';
import { fitShotTimeline } from '../lib/shotTimeline.js';
import { isWan2gpModelId } from '../lib/localModels.js';
import { RENTED_CHANGED_EVENT, consumeRentedModeRequest, rentedMachinesState, servedByAnyMachine } from '../lib/rentedMachines.js';
import { startCivitaiDownload } from '../lib/civitaiDownloadStore.js';
import { loraGenerationPayload, mergeLoraUpdates, replaceLoraInSelection, toggleLoraEnabled, toggleLoraSelection, updateLoraStrength } from '../lib/loraSelection.js';
import { createGenerationContextStore } from '../lib/generationContext.js';
import { applyCameraMotionPrompt, cameraMotionIdsInPrompt, cameraMotionPhrase, normalizeCameraMotions } from '../lib/cameraMotion.js';
import { CameraMotionMenu } from './video/CameraMotionMenu.jsx';
import { applyRestylePrompt } from '../lib/h3RestylePresets.js';
import { RestyleMenu } from './video/RestyleMenu.jsx';
import { applyEmotionPrompt, emotionDirectionIdInPrompt } from '../lib/emotionDirection.js';
import { EmotionMenu } from './video/EmotionMenu.jsx';
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
import { civitaiResourcesFromLoras, postMetaFromEntry } from '../lib/civitaiPost.js';
import { downloadMedia } from '../lib/downloadMedia.js';
// joinClips itself is imported dynamically inside joinChainFrom — it carries
// mediabunny, which should not weigh down the studio chunk until a join runs.
import { collectChainClips, missingChainParent } from '../lib/chainLineage.js';
import { chainKey, chainTimelineModel } from '../lib/chainTimeline.js';
import { TIMELINE_SEGMENT_DRAG_TYPE, TimelineStrip } from './video/TimelineStrip.jsx';
import {
  addTimelineSegment, captureIntoTimeline, fillTimelineSegment,
  insertTimelineSegment, loadTimelineState, moveTimelineSegment, newTimelineSegment,
  openTimeline, removeTimelineSegment, saveTimelineState, timelineCanCombine,
  timelineCombineKey, timelineContinuationPlan, timelineCutSegments, timelineDropPlan,
  timelineFromChainShots, toggleTimelineSegmentExcluded,
} from '../lib/videoTimeline.js';
import { ShotBuilderDialog, blankTimeline } from './video/ShotBuilder.jsx';
import { armChainPrompt } from '../lib/chainPrompt.js';
import { personaIdentity } from '../lib/personaId.js';
import { UGC_DEFAULT_FORMAT, applyUgcVideoBrief, hasUgcVideoBrief, ugcFormatInPrompt, ugcSubjectLabel, ugcVariantAt } from '../lib/ugcMode.js';
import { UgcMenu } from './UgcMenu.jsx';
import { restoredHistoryEntry } from '../lib/restoredOutput.js';
import {
  savePendingJob, removePendingJob, getPendingJobs, pendingJobsForTab,
} from '../lib/pendingJobs.js';
import { videoDownloadName } from '../lib/downloadNames.js';
// The chime is one app-wide setting: this studio only PLAYS it (and primes the
// audio context near the click). Its toggle lives beside Generate, in
// ui/CompletionPingToggle.jsx, which owns the subscription.
import { primeCompletionPing, playCompletionPing } from '../lib/completionPing.js';
import {
  cancelHivemindVideoJob,
  deleteHivemindStudioUpload,
  hivemindStudioContextCached,
  isHivemindStudioEnabled,
  isHivemindVideoModelId,
  loadHivemindStudioContext,
  loadStudioGenerationHistory,
  pollHivemindVideoJob,
  previewHivemindIngredientSheet,
  referenceWorkflowForHivemindModel,
  inpaintWorkflowForHivemindModel,
  selectableHivemindModelId,
  saveStudioGenerationHistory,
  uploadFileToHivemindStudio,
  workflowIdFromHivemindModelId, mediaSourceToDataUrl } from '../lib/hivemindStudio.js';
import { t, tf } from '../lib/i18n.js';

import { registerPromptInserter, registerStudioSetupLoader } from '../app/promptTarget.js';
import { useApiStatus } from '../app/statusStore.js';
import { useRunTargets } from '../lib/useRunTargets.js';
import { useProviderReadiness } from '../lib/useProviderReadiness.js';
import { PLACE_THIS_MAC, pickRunTarget } from '../lib/runTargets.js';
import { videoRunTargets } from './video/videoRunTargets.js';
import { basenameOf, rememberGenerationSetup } from '../lib/generationSetupStore.js';
import { getComposerSection, hydrateComposerState, updateComposerSection } from '../lib/composerState.js';
import { Icon } from '../ui/icons.jsx';
import { FailureCallout, Spinner, Toggle, cx } from '../ui/kit.jsx';
import { ChipButton } from '../ui/Menu.jsx';
import { ConfirmModal } from '../ui/Modal.jsx';
// The redesigned route frame and the four surfaces it mounts. The stage owns
// the window, the sequence rail owns the right edge, one composer floats over
// the bottom and every remaining control is one press away behind Advanced —
// StudioLayout's permanent 320px column and scrolling result grid are gone.
import { StudioFrame } from './frame/StudioFrame.jsx';
import { VideoAdvanced } from './video/VideoAdvanced.jsx';
import { VideoComposerBar } from './video/VideoComposerBar.jsx';
import { VideoRail } from './video/VideoRail.jsx';
import { VideoStage, VideoStageActions } from './video/VideoStage.jsx';

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
import { IngredientsPanel } from './video/IngredientsPanel.jsx';

import {
  VIDEO_PREFERENCES_KEY,
  buildCatalogs, buildInitialSetup, adaptHivemindToVideoEntry, v2vModels,
  allVideoModels, currentModel, generationModelsFor, resolveVideoModel, withSelectedModel,
  currentIngredientModel, frameSlotsVisible, activeIngredientSheetItems, ingredientSelectionSignature,
  isMotionControlV2V, isHivemindVideoInputMode,
  activeVideoTask, headSwapReadiness, isLtxFamilyModel, isMinimaxFamilyModel, slotLabelsFor,
  sourceVideoSwitchCost, videoRequestPlan, videoTasksFor,
  aspectRatiosFor, durationsFor, resolutionsFor, modesFor, qualitiesFor, effectNamesFor,
  motionReferenceLimitFor, availableDurationsFor, clampDurationToMotionReference, probeVideoDurationSeconds,
  deriveControlVisibility, deriveExtendBanner, derivePromptUi,
  applyRestoredPreferences, applyGenerationContext, restylePresetIdInPrompt,
  startFrameSelectedTransition, startFrameClearedTransition, clearVideoUploadTransition,
  videoUploadedTransition, selectV2VModelTransition, selectRegularModelTransition,
  selectHivemindWorkflowTransition, newPromptTransition, startFreshSummary, extendTransition, withServedModel,
  getAdvancedVideoInputs, getAdvancedVideoPayload,
  normalizeVideoPreferences, normalizeVideoIngredientSelections, normalizeSelectedVideoIngredientSheet,
  videoIngredientDescriptions, withVideoIngredientDescriptions,
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
  videoIngredientDescriptions, withVideoIngredientDescriptions,
  normalizeVideoGenerationProgress, classifyVideoGenerationStage, formatVideoGenerationElapsed,
  closestVideoAspectRatio,
} from './video/videoLogic.js';

// The four media leaves that used to live here — ResultVideo, HistoryThumb,
// scrollTileIntoView and ProgressPreview — moved with the surfaces that drew
// them: the player is VideoStage's StageClip, the strip tiles are VideoRail's,
// and the mid-render preview is the stage overlay. Each still resolves its src
// through useMediaSrc / useMediaPoster (E2E decrypt, fail-open) in its new home.

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
  // A tab that has never been told otherwise follows Automatic, the same as
  // Image (ImageStudio.jsx) and Sprite. Video used to boot with this unset, so
  // the readout said "Workflow default — free, stays here" while the menu's
  // Automatic row sat unselected naming a different model: the one control
  // that says where work runs disagreed with itself on the tab that had made
  // no choice at all.
  setup = { ...setup, runOnAutomatic: !restored };

  const engine = {
    persistedVideoPreferences: persisted,
    catalogs,
    setup,
    hivemindWorkflowSignature: '',
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
    // Workflow preflight: the lane's report for the selected local workflow,
    // and whether the install prompt is open. The report is re-asked when the
    // workflow or the "Run on" pin changes (workflowDependencies.js caches).
    dependencyReport: null,
    dependencyPromptOpen: false,
    dependencyCheckRequest: 0,
    loraOpen: false,
    // Advanced (the frame's left drawer). View state, deliberately not
    // persisted — see toggleAdvanced in the render.
    advancedOpen: false,
    // Ingredients
    sharedIngredientSelections,
    sharedIngredientSheets,
    selectedIngredientSheet,
    // True once the encrypted composer section has been read, which is what
    // gates writing reference descriptions back into it.
    composerHydrated: false,
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
    // Start fresh asks first, because it takes more than the prompt: true while
    // that dialog is up. Never set when there is nothing to lose.
    startFreshConfirm: false,
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
  // The floating tab strip, built by StudioTabs and handed to the FRONT tab only.
  // Null when this studio is mounted without tabs.
  tabStrip = null,
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
  // Runs-on picker calls, and the part a raw commit skipped is the part that
  // lands on a model the machine can actually run. Skipping it is why the
  // handoff arrived pointed at a cloud model the box could not run.
  const claimRentedHandoff = () => {
    if (!tabActiveRef.current || !consumeRentedModeRequest('video')) return;
    // setLocalMode re-points the model itself when it can. It cannot yet if the
    // machine list or the local catalogue has not arrived — both are fetched,
    // both land after mount, and in no fixed order — so mark the handoff
    // unfinished and let finishRentedHandoff close it out on their arrival.
    reconcileRentedModelRef.current = true;
    setLocalMode(true);
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
        // A hidden window is a window nobody is reading. Skipping the beat
        // matters more here than for most polls: /api/gpu-rentals lists every
        // configured marketplace and probes each box, so a backgrounded studio
        // was doing that every 30s (every 8s while a box provisions) forever.
        // The wake handler below asks the moment the window comes back, so
        // nothing is stale by the time it is on screen.
        timer = { every: wanted, id: setInterval(() => { if (!document.hidden) sync(false); }, wanted) };
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

  const rootRef = useRef(null);
  const promptRef = useRef(null);
  // The stage's <video>. VideoStage assigns it and VideoStageActions' Expand
  // reads it, so the two halves of one clip share one element.
  const stageVideoRef = useRef(null);
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
    // The per-tab "Run on" pin, and nothing beside it: a rental is a property
    // of This Mac (the box its work lands on), never a third source.
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
    // The blob above carries the reference SELECTION and none of the words: a
    // description is a sentence about a picture of somebody's own life, so it
    // follows the negative prompt into the encrypted composer section. Written
    // only once the composer has hydrated — before that the cache is still
    // empty and this would race the restore below to nothing.
    if (s.composerHydrated) {
      updateComposerSection('video', {
        ingredientDescriptions: videoIngredientDescriptions(
          s.sharedIngredientSelections, s.sharedIngredientSheets,
        ),
      });
    }
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
    toast(`Re-timed ${fitted.moved.length} shots to fit ${fitted.to}s — the prompt was written for about ${Math.round(fitted.from)}s.`);
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
          Undo
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
      // 'rented' is a source a sender written before the pin existed may still
      // name; it means This Mac, which is what it always meant mechanically.
      const wantsLocal = setup.source !== 'api';
      if (wantsLocal !== Boolean(s.setup.localMode)) setLocalMode(wantsLocal);
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
    tabIdRef.current, tabActive, s.setup.modelId, s.setup.localMode, s.setup.rentedMachineId,
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
    });
    return publishSendTarget(`video:${tabIdRef.current}`, {
      section: 'video',
      tabId: tabIdRef.current,
      index: tabIdRef.current,
      label: `${'Tab'} ${tabIdRef.current || 1}`,
      active: Boolean(tabActive),
      current: s.setup.localMode ? 'local' : 'api',
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
    if (!urls.length) throw new Error('This member has no pictures.');
    const images = (await Promise.all(urls.map((url) => mediaSourceToDataUrl(url, 'image').catch(() => null)))).filter(Boolean);
    if (!images.length) throw new Error('Could not read the pictures.');
    const response = await fetch('/api/prompt-helper/describe-look', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, gender: member?.data?.gender || '' }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.detail || payload?.error || 'The helper did not return a look.');
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
      toast.error(err?.message || 'Could not attach that.');
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
        announceWeave('Wove your references into the prompt', before);
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

  // One join for the whole studio: the media catalog, the attached machines,
  // the OAuth grants and the readiness that the Automatic ladder reads.
  const runOnState = useRunTargets({ kind: 'video', pinned: s.setup.rentedMachineId || '' });
  // One readiness module, one repair, shared with every other studio's picker.
  const {
    readinessFor: rowReadiness, onFixReadiness: fixReadiness, busyAction: fixingReadiness,
  } = useProviderReadiness({
    onMuapiKey: () => { s.authOpen = true; bump(); },
  });

  const selectRegularModel = (m) => commit(selectRegularModelTransition(s.setup, m, s.catalogs));
  const selectHiveModel = (m) => commit(selectHivemindWorkflowTransition(s.setup, m, s.catalogs));

  /**
   * The one place a run target becomes a selection.
   *
   * A target carries its own place, so nothing here has to decide whether the
   * user meant "Local", "API" or "Rented" — the three words this replaced. The
   * three existing transitions still do the work; this only says which one, and
   * folds the source flags into the SAME commit so the model and the place can
   * never disagree for a render.
   */
  const chooseRunTarget = (target, { automatic = false } = {}) => {
    if (!target) return;
    const entry = allVideoModels(s.catalogs).find((m) => m.id === target.id);
    if (!entry) return;
    const base = {
      ...s.setup,
      localMode: target.place === PLACE_THIS_MAC,
      runOnAutomatic: Boolean(automatic),
    };
    if (isHivemindVideoModelId(entry.id)) commit(selectHivemindWorkflowTransition(base, entry, s.catalogs));
    else if (v2vModels.some((tool) => tool.id === entry.id)) commit(selectV2VModelTransition(base, entry, s.catalogs));
    else commit(selectRegularModelTransition(base, entry, s.catalogs));
  };

  // This tab's "Run on" pin, written by the Rented panel's picker ('' = follow
  // the Machines default). Part of `setup`, so it persists and copies with the tab.
  const pinMachine = (rentalId) => {
    const next = rentalId || '';
    if ((s.setup.rentedMachineId || '') === next) return;
    commit({ ...s.setup, rentedMachineId: next });
  };

  const setLocalMode = (local) => {
    if (local === s.setup.localMode) return;
    const next = { ...s.setup, localMode: local };
    // Coming back to This Mac while PINNED to a machine that does not serve the
    // selected model would leave a model the box cannot run (and the generate
    // guard would just refuse). withServedModel is the one rule for that,
    // shared with the Machines-view handoff so both land the same way.
    commit(local && s.setup.rentedMachineId ? withServedModel(next, s.rentedMachines, s.catalogs) : next);
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

  // Performance direction — same idempotent phrase contract again, with one
  // difference: which TEXT is written depends on the model. H3 renders the
  // audio too, so it gets the rewrite that names the sound the body makes, and
  // the phrase is inserted into the description rather than appended past the
  // end (an H3 prompt finishes with non_diegetic_music, and appending writes
  // acting direction into the music field). Both dialects are stripped on the
  // way out, because the model can change under an armed phrase.
  const applyEmotion = (id) => {
    const next = applyEmotionPrompt(s.setup.prompt, s.setup.emotionDirectionId, id, { h3: isH3() });
    s.setup = { ...s.setup, prompt: next.prompt, emotionDirectionId: next.id };
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
  const applyUgc = (index, formatId = undefined) => {
    // Which ad format the brief is written as. Read from the PROMPT first, so
    // re-arming replaces the brief that is actually in the box rather than the
    // one the chip last remembered; the explicit argument is a format button.
    const format = formatId || ugcFormatInPrompt(s.setup.prompt) || s.setup.ugcFormat || UGC_DEFAULT_FORMAT;
    // A loaded persona's gender picks the cast pool: the dealt person must be
    // the kind of person the attached pictures show. The SETTING comes from the
    // format's own bank — a street interview has no bathroom in it.
    const variant = Number.isInteger(index) ? ugcVariantAt(index, { gender: s.setup.persona?.gender, format }) : null;
    const prompt = applyUgcVideoBrief(s.setup.prompt, variant, {
      durationSeconds: Number(s.setup.duration) || null,
      persona: ugcPersona(),
      format,
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
      // Kept when clearing too, so turning UGC back on comes back in the format
      // you were working in rather than resetting to the selfie.
      ugcFormat: format,
      ar: variant && vertical ? '9:16' : s.setup.ar,
    };
    updateComposerDraft({ prompt });
    persistVideoPreferences();
    bump();
    focusPrompt();
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
        `Cast woven in — ${s.cast.length} member${s.cast.length === 1 ? '' : 's'}, ${total} reference${total === 1 ? '' : 's'}`,
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
        `Prompt woven onto your cast — ${s.cast.length} member${s.cast.length === 1 ? '' : 's'}`,
        before,
      );
    } else if (woven.prompt !== fitShotTimeline(text, Number(s.setup.duration) || 0).prompt) {
      // Changed by the cast, not merely re-timed.
      announceWeave('Cast woven into the prompt', before);
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
      lines.push(`${cost.fromModel} cannot extend or edit a clip, so this switches to ${cost.toModel}.`);
    }
    if (cost.droppedReferences) {
      lines.push(`Your ${cost.droppedReferences} attached reference${cost.droppedReferences === 1 ? '' : 's'} will be removed — a source clip and reference mode cannot be used together.`);
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
        toastFailure(err, { operation: 'Video upload' });
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
      toastFailure(err, { operation: 'Video upload' });
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
    s.ingredientUploadMessage = `${'Adding'} ${toUpload.length} ${`view${toUpload.length === 1 ? '' : 's'}…`}`;
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
      s.ingredientUploadMessage = `${'Upload failed'}: ${error.message}`;
    }
    bump();
  };

  const addIngredientSheets = async (files) => {
    const model = currentIngredientModel(s.setup, s.catalogs);
    if (!model) return;
    const toUpload = files.slice(0, Math.max(0, 12 - s.sharedIngredientSheets.length));
    if (!toUpload.length) return;
    s.ingredientUploadMessage = `${'Adding'} ${toUpload.length} ${`sheet${toUpload.length === 1 ? '' : 's'}…`}`;
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
      s.ingredientUploadMessage = `${'Upload failed'}: ${error.message}`;
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
    s.videoLoraCatalogMessage = `${'Loading LoRAs for '}${model.name}…`;
    bump();
    try {
      const data = await localAI.listLoras(model.workflowId, model.compatibleBaseModels);
      if (request !== s.videoLoraCatalogRequest || model.workflowId !== currentVideoLoraModel()?.workflowId) return;
      s.availableVideoLoras = Array.isArray(data?.loras) ? data.loras : [];
      s.videoLoraCatalogStatus = data?.supported === false ? 'unsupported' : 'ready';
      s.videoLoraCatalogMessage = data?.supported === false
        ? 'This workflow does not expose an add-on LoRA path.'
        : s.availableVideoLoras.length
          ? `${s.availableVideoLoras.length} ${`compatible LoRA${s.availableVideoLoras.length === 1 ? '' : 's'} installed.`}`
          : 'No compatible LoRAs are installed for this workflow.';
      void refreshVideoLoraUpdates(request, model.compatibleBaseModels);
    } catch (error) {
      if (request !== s.videoLoraCatalogRequest) return;
      s.videoLoraCatalogStatus = 'error';
      s.videoLoraCatalogMessage = `${'Unable to load LoRAs: '}${error.message}`;
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
    s.progressQueuePosition = null;
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
  const updateGenerationProgress = ({ status = '', progress = null, stage = '', estimateSeconds = null, step = null, stepTotal = null, overtimeMinutes = null, queuePosition = null } = {}) => {
    const value = normalizeVideoGenerationProgress(progress);
    if (value != null) s.progressReal = value;
    if (Number(estimateSeconds) > 0) s.progressEstimateSec = Number(estimateSeconds);
    // Well past the estimate but still alive on the server. Said out loud in
    // the progress card, next to a Cancel that is already there — the poller
    // no longer has a clock of its own to fail the run with.
    if (Number(overtimeMinutes) > 0) s.progressOvertimeMin = Number(overtimeMinutes);
    // Not sticky, unlike the counters: the moment the machine's GPU frees up
    // this stops arriving, and the card has to stop saying "waiting" at once.
    s.progressQueuePosition = Number(queuePosition) > 0 ? Number(queuePosition) : null;
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
    const loadingId = toast.loading(`Smoothing ${factor}× with RIFE — inserting frames between the existing ones…`);
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
      toast.success(`Smoothed ${factor}× — added to history.`, { id: loadingId });
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
        model: 'Joined episode',
        timestamp: new Date().toISOString(),
      });
      toast.success('Episode saved — it is in History now.');
    } catch (error) {
      // Not fatal: the cut is on screen and the export button still works.
      toast.error(`Could not save the episode to History: ${error?.message || 'unknown error'}`);
    }
  };

  // Builds the cut and PUTS IT ON SCREEN. It used to only download the file,
  // which meant the one thing the whole feature exists to produce was the one
  // thing you could not look at.
  const buildChainCut = async (urls, key) => {
    if (s.joiningChain) return null;
    if (!Array.isArray(urls) || urls.length < 2) {
      toast.error('No chained shots to join for this clip.');
      return null;
    }
    s.joiningChain = true;
    bump();
    const loadingId = toast.loading(`Joining ${urls.length} shots losslessly on this device…`);
    try {
      const { joinClips } = await import('../lib/clipJoiner.js');
      const blobs = [];
      for (const url of urls) {
        const src = await resolveMediaSrc(url);
        blobs.push(await (await fetch(src)).blob());
      }
      const joined = await joinClips(blobs, {
        onProgress: (index, total) => {
          toast.loading(`Joining shot ${index + 1} of ${total}…`, { id: loadingId });
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
      showVideoInCanvas(s.chainCombined.url, 'Joined episode', { anchorChain: false });
      toast.success(`Joined ${urls.length} shots (${Math.round(joined.seconds)}s)${joined.audioJoined ? '' : ' — video only, a shot had no audio'}.`, { id: loadingId });
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

  // Dropping a shot from a cut is the Scene strip's job now (a card's "put
  // back" toggle), so joining takes the whole lineage.
  const joinChainFrom = (entry) => {
    const chain = collectChainClips(entry, s.generationHistory);
    const urls = chain.map((clip) => clip.url);
    return buildChainCut(urls, chainKey(urls));
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
  // The prompt alone, in one press, from the badge in the box's corner. This is
  // what most "start over" presses actually wanted: the frames, the cast, the
  // clip and every setting stay. One field, so it asks nothing — the weave's
  // own Undo toast is the whole safety net it needs.
  const clearPromptOnly = () => {
    if (!s.setup.prompt.trim()) return;
    const before = { ...weaveSnapshot(), setup: s.setup };
    setPrompt('');
    focusPrompt();
    announceWeave('Cleared the prompt', before);
  };

  // "Start fresh" clears the prompt, the references, the persona and the frames
  // in one press. It ASKS first (the dialog lists what is on screen), and the
  // weave's Undo toast still catches the press that landed a second early.
  const newPrompt = () => {
    s.startFreshConfirm = false;
    const before = { ...weaveSnapshot(), setup: s.setup };
    const hadSomething = Boolean(before.prompt.trim())
      || before.rows.images.length || before.rows.videos.length || before.rows.audios.length
      || Boolean(s.setup.imageUrl) || Boolean(s.setup.videoUrl);
    s.setup = newPromptTransition(s.setup);
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
    if (hadSomething) announceWeave('Cleared the prompt and its inputs', before);
  };

  // Asked before it is done: the press was being read as "clear the prompt",
  // and it is not. startFreshSummary names what is actually attached, off the
  // same setup newPromptTransition clears. Nothing to lose means nothing to
  // ask — an empty composer starts fresh on the press.
  const requestNewPrompt = () => {
    if (!startFreshSummary(s.setup).length) { newPrompt(); return; }
    s.startFreshConfirm = true;
    bump();
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
  //
  // ONE arming path. Continue scene does NOT write motionContextUrl itself: it
  // opens the Scene strip on the clip with Auto-continue on and lets
  // armTimelineContinuation do the arming, so a scene can never be armed two
  // ways (the strip's Auto-continue and a stray Continue press used to write
  // the same field from two places, on two different clips).
  const continueSceneFrom = (url, sourceModelId) => {
    const target = chainCapableEntryFor(sourceModelId);
    if (!url || !target) return;
    if (s.setup.modelId !== target.id) {
      commit(selectHivemindWorkflowTransition(s.setup, target, s.catalogs));
    }
    // Keep the armed clip on screen — it IS this shot's opening. Blanking the
    // canvas here read as "my clip got erased" the moment Continue was pressed.
    showVideoInCanvas(url, target.id);
    openSceneAt(url, target.id);
    focusPrompt();
  };
  const clearMotionContext = () => {
    if (!s.setup.motionContextUrl) return;
    commit({ ...s.setup, motionContextUrl: null, motionContextIndex: null });
  };

  /* ---------------- manual timeline (lib/videoTimeline.js) ---------------- */

  const timelineCutLabel = () => 'Timeline cut';

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

  // The scene a chain lineage already describes, as strip segments — or null
  // when nothing on record is chained.
  //
  // The strip is per-session state; the chain that produced it is not (it lives
  // in History and the sealed per-generation context). Seeding from the lineage
  // on open AND on restore is what makes an episode you chained yesterday show
  // up in the one Scene surface today, instead of an empty strip beside a scene
  // that plainly still exists.
  const chainSceneSeed = () => {
    const anchor = s.generationHistory.find((entry) => entry.url === s.chainAnchor)
      || s.generationHistory[0];
    if (!anchor) return null;
    const model = chainTimelineModel(anchor, s.generationHistory);
    if (!model || model.shots.length < 2) return null;
    return timelineFromChainShots(model.shots);
  };

  const seedTimelineSegments = () => {
    if (s.timelineSegments.length) return;
    const seeded = chainSceneSeed() || openTimeline(s.resultUrl || '', s.resultModel || '');
    s.timelineSegments = seeded.segments;
    s.timelineSelectedId = seeded.selectedId;
  };

  const openTimelineView = () => {
    if (s.timelineOn) return;
    s.timelineOn = true;
    // First open seeds the strip from a chain lineage where one exists, and
    // otherwise from what is on screen — the scene "starts with the existing
    // shot"; with an empty canvas it opens on an empty slot.
    seedTimelineSegments();
    afterTimelineChange();
  };

  // Open the Scene strip on a finished clip with the next slot selected and
  // Auto-continue on. The single arming path: everything that continues a
  // scene comes through here and then through armTimelineContinuation.
  const openSceneAt = (url, modelId) => {
    if (!s.timelineOn) {
      s.timelineOn = true;
      seedTimelineSegments();
    }
    let index = s.timelineSegments.findIndex((seg) => seg.url === url);
    if (index < 0) {
      const captured = captureIntoTimeline(s.timelineSegments, s.timelineSelectedId, { url, model: modelId });
      s.timelineSegments = captured.segments;
      index = s.timelineSegments.findIndex((seg) => seg.id === captured.selectedId);
    }
    const after = s.timelineSegments[index + 1];
    if (after && !after.url) {
      s.timelineSelectedId = after.id;
    } else {
      const slot = newTimelineSegment();
      s.timelineSegments = insertTimelineSegment(s.timelineSegments, index + 1, slot);
      s.timelineSelectedId = slot.id;
    }
    s.timelineShowCombined = false;
    s.timelineExtend = true;
    armTimelineContinuation();
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
      toast.error(`Could not grab the previous clip's last frame: ${error?.message || 'unknown error'}`);
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
    const urls = timelineCutSegments(s.timelineSegments).map((seg) => seg.url);
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
      s.timelineBuildError = error?.message || 'Join failed';
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
      toast('Add a second clip and the full cut builds itself.');
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
        shots: timelineCutSegments(s.timelineSegments).length,
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
    await downloadFile(cut.url, videoDownloadName(timelineCutLabel(), `cut-${timelineCutSegments(s.timelineSegments).length}`));
    void saveTimelineCutIfNeeded();
  };

  /* ---- one shot: export it, or drop it from the cut without losing it ---- */

  const timelineExportSegment = async (seg) => {
    if (!seg?.url) return;
    await downloadFile(seg.url, videoDownloadName(seg.model || clipModelFor(seg.url), seg.id));
  };

  // Non-destructive, and the sibling of the "x" beside it: the card stays in the
  // scene and the file is untouched — it just stops feeding the full cut.
  const timelineToggleExcluded = (seg) => {
    s.timelineSegments = toggleTimelineSegmentExcluded(s.timelineSegments, seg.id);
    s.timelineShowCombined = false;
    afterTimelineChange();
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
      toast.error(error?.message || 'Could not delete the file');
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
      toast.error('Uploading clips needs the studio to be running.');
      return;
    }
    const loadingId = toast.loading(`Uploading ${files.length} clip${files.length === 1 ? '' : 's'}…`);
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
      toast.success('Clips added to the timeline.', { id: loadingId });
    } catch (error) {
      toast.error(`${'Upload failed'}: ${error?.message || ''}`, { id: loadingId });
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
        toast.error('The timeline takes video clips only.');
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
    if (dropped.length) toast.error('The timeline takes video files only.');
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
    } else {
      // Nothing saved — a new browser session. The chain lineage in History
      // outlives the session, so a scene chained before the restart is seeded
      // back into the one surface rather than vanishing with the strip.
      const seeded = chainSceneSeed();
      if (seeded) {
        s.timelineOn = true;
        s.timelineSegments = seeded.segments;
        s.timelineSelectedId = seeded.selectedId;
        bump();
        scheduleTimelineBuild();
      }
    }
    return () => {
      if (s.timelineBuildTimer) clearTimeout(s.timelineBuildTimer);
      dropTimelineCombined();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- generation ---------------- */

  const generateNow = async () => {
    // The pin promises WHERE this runs — refuse rather than quietly falling
    // back to this Mac's GPU.
    if (s.setup.localMode && s.setup.rentedMachineId
        && !servedByAnyMachine(s.rentedMachines, { id: s.setup.modelId, name: s.setup.modelName })) {
      // Same honesty as the source panel: name the actual blocker.
      toast.error(
        s.rentedBroken?.length
          ? 'Lost the connection to your rented machine — reconnect it from the Source panel or Rented GPUs.'
          : s.rentedIdle?.length
            ? 'Your rented machine is not connected to this studio yet — click "Use it here" in the Source panel.'
            : s.rentedProvisioning?.length
              ? 'Your rented machine is still coming online — the Rented GPUs page shows its progress.'
              : 'No rented machine is serving this model. Rent one on the Rented GPUs page, or switch the source to Local.',
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
        announceWeave('Wove your references into the prompt before sending', before);
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
      toast.error(`${'Still needed: '}${swapCheck.missing.join(' and ')}`);
      return;
    }
    if (isHivemindVideoInput) {
      if (!model?.supportsVideoInput) {
        toast.error('This local workflow does not support source-video extension.');
        return;
      }
    } else if (setup.v2vMode) {
      if (!setup.videoUrl) { toast.error('Please upload a video first.'); return; }
      if (model?.imageField && !setup.imageUrl) { toast.error('Please upload a reference image for motion control.'); return; }
      if (model?.promptRequired && !prompt) { toast.error('Please describe the motion you want.'); return; }
    } else if (isExtendMode) {
      if (!s.lastGenerationId) { toast.error('No Seedance 2.0 generation found to extend. Generate a video first.'); return; }
    } else if (setup.imageMode) {
      // LTX 2.3 supports text-to-video: for a plain Hivemind LTX model (not an
      // ingredient/reference-sheet model), a prompt alone is a valid request —
      // the start frame is optional.
      const hiveTextToVideo = isHivemindLocal && !model?.supportsIngredientImages;
      if (!setup.imageUrl && !hasIngredientReferences) {
        if (hiveTextToVideo) {
          if (!prompt) { toast.error('Please enter a prompt to generate a video.'); return; }
        } else {
          toast.error(model?.supportsIngredientImages
            ? 'Please add reference views or select an ingredients sheet.'
            : 'Please upload a start frame image first.');
          return;
        }
      }
      if (model?.supportsIngredientImages && !prompt) { toast.error('Please describe the shot to generate from these references.'); return; }
    } else if (!prompt) {
      toast.error('Please enter a prompt to generate a video.');
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
          ...(setup.rentedMachineId ? { run_on: setup.rentedMachineId } : {}),
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
            queuePosition: data.queuePosition,
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
          operation: 'Generation',
        });
        s.generateFailure = failure;
        s.generateError = failure.title || 'Generation failed';
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
          toast('Stopping… the machine finishes its current step before it frees up, and a new generation queues behind it.', { duration: 6000 });
        } else {
          toast.success('Generation cancelled.');
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
    if (!jobId) toast.success('Generation cancelled.');
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
      // Every tab with no restored preferences opens on the workflow default.
      const preferredModelId = hivemindI2V.find((m) => m.workflowId === 'ltx23-eros-fast')?.id
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
    const cachedBefore = hivemindStudioContextCached();
    let context = await loadHivemindStudioContext({ refresh: force });
    // Owner unlock and backend startup can race the iframe's first request — so
    // an EMPTY answer that came out of the module cache is worth asking again.
    // One that this call just fetched is not: re-asking discarded the promise it
    // had only now resolved and put a second /api/simple/catalog on the wire at
    // every mount, which is the most expensive route the studio has.
    if (!context.videoModels?.length && (force || cachedBefore)) {
        context = await loadHivemindStudioContext({ refresh: true });
    }
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
      s.composerHydrated = true;
      if (!isPrimaryTab) return;
      const saved = getComposerSection('video');
      // Reference descriptions come back from the encrypted section and are put
      // back on the selection localStorage restored — the settings blob knows
      // WHICH pictures, this knows what was written about them.
      const withDescriptions = withVideoIngredientDescriptions(
        s.sharedIngredientSelections, saved.ingredientDescriptions,
      );
      const sheetsWithDescriptions = withVideoIngredientDescriptions(
        s.sharedIngredientSheets, saved.ingredientDescriptions,
      );
      const savedPrompt = saved.prompt;
      const savedNegative = saved.negativePrompt;
      const next = { ...s.setup };
      let changed = false;
      // Descriptions are not part of `setup`, so they get their own flag: they
      // must not drag the setup/cast restore below through a re-derive.
      let ingredientsChanged = false;
      if (JSON.stringify(withDescriptions) !== JSON.stringify(s.sharedIngredientSelections)) {
        s.sharedIngredientSelections = withDescriptions;
        ingredientsChanged = true;
      }
      if (JSON.stringify(sheetsWithDescriptions) !== JSON.stringify(s.sharedIngredientSheets)) {
        s.sharedIngredientSheets = sheetsWithDescriptions;
        ingredientsChanged = true;
      }
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
      const emotionId = emotionDirectionIdInPrompt(restoredPrompt);
      if ((emotionId || null) !== (s.setup.emotionDirectionId || null)) {
        next.emotionDirectionId = emotionId;
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
      } else if (ingredientsChanged) {
        bump();
      }
      // The stitched sheet DRAWS the descriptions onto it, but its signature is
      // built from urls alone — so descriptions arriving a beat after the
      // selection (which is the whole point of keeping them encrypted) would
      // leave a reloaded sheet captionless until the next edit. Redraw once.
      if (ingredientsChanged && s.sharedIngredientSelections.length) {
        void refreshIngredientSheetPreview({ force: true });
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
                    queuePosition: data.queuePosition,
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
                operation: 'Generation',
              });
              s.generateFailure = failure;
              s.generateError = failure.title || 'Generation failed';
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
          toast(`${landed.wanted} picture${landed.wanted === 1 ? '' : 's'} came with this story, but the model now `
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
      // Cheap enough to call on the strip's poll (snapshot() deep-copies the
      // whole setup): what this tab is called, and the last clip it made.
      chip: () => ({
        prompt: s.setup?.prompt,
        model: s.setup?.modelName || s.setup?.modelId,
        previewUrl: s.resultUrl || s.generationHistory[0]?.url || '',
        previewKind: 'video',
      }),
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

  // Ask the lane what it lacks for the selected local workflow, before
  // Generate: a missing node pack or model file opens the install prompt
  // now, with progress bars, instead of a refusal after the upload.
  const dependencyModel = currentModel(s.setup, s.catalogs);
  const dependencyWorkflowId = dependencyModel?.provider === 'hivemind-media-studio' ? String(dependencyModel.workflowId || '') : '';
  const dependencyRunOn = s.setup.rentedMachineId || '';
  const openDependencyPrompt = async ({ force = false } = {}) => {
    if (!dependencyWorkflowId) return;
    const request = ++s.dependencyCheckRequest;
    try {
      const report = await checkWorkflowDependencies(localAI, { workflowId: dependencyWorkflowId, runOn: dependencyRunOn, force });
      if (request !== s.dependencyCheckRequest) return;
      s.dependencyReport = report;
      s.dependencyPromptOpen = force || dependenciesBlockGeneration(report);
      bump();
    } catch {
      // A lane that cannot be asked is not a lane that is missing things;
      // Generate says what it says, and the callout's remedy reopens this.
    }
  };
  useEffect(() => {
    if (!dependencyWorkflowId) { s.dependencyReport = null; s.dependencyPromptOpen = false; return; }
    void openDependencyPrompt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dependencyWorkflowId, dependencyRunOn]);

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
  const slotLabels = slotLabelsFor(videoTask);
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
  // Does attaching a clip CHAIN (its tail seeds the next shot's opening frames)
  // or is the clip an INPUT to this run? Read from the request plan's task and
  // the workflow's declared motion-context capability — never from the model's
  // name — because that is the difference between "Continue from clip" and
  // "Source video", and one chip saying "Clip" for both was unguessable.
  const clipChipContinues = videoRequestPlan(s.setup).task === 'generate'
    && Boolean(chainCapableEntryFor(s.setup.modelId));
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
  // Where this tab's work runs. The lane registry is richer than the server
  // catalog's video block, so the studio's own list stays the inventory and the
  // shared join answers the other half — which place each model runs in, which
  // rental is serving it, and which places cannot serve a clip at all yet.
  const videoTargets = videoRunTargets({
    // Tier pairs collapse to ONE row here as they did in the old menu: Lite and
    // Standard are the same model, and the Quality switch below chooses between
    // them. Two rows would read as two models.
    models: groupModelTiers(generationModelsFor(s.setup, s.catalogs))
      .map((row) => (row.isTierGroup ? row.tiers[activeTierFor(row, s.setup.modelId)] : row)),
    tools: v2vModels,
    catalogProviders: runOnState.catalogProviders,
    machines: runOnState.machines,
    pinned: s.setup.rentedMachineId || '',
  });
  const videoAutomatic = pickRunTarget('video', {
    catalog: videoTargets.targets,
    machines: runOnState.machines,
    readiness: runOnState.readiness,
  });
  const runOn = {
    targets: videoTargets.targets,
    unreachable: videoTargets.unreachable,
    // The state of the account behind each row, and the button that repairs it
    // — on the row, before the press. The MUAPI key opens this studio's own
    // dialog; every other credential goes through the shared remedy runner.
    readinessFor: rowReadiness,
    onFixReadiness: fixReadiness,
    busyAction: fixingReadiness,
    automatic: videoAutomatic,
    isAutomatic: Boolean(s.setup.runOnAutomatic),
    // A selection the joined list does not carry (a catalog still landing, a
    // model retired) still reads out as what is loaded, rather than as nothing.
    value: videoTargets.targets.find((target) => target.id === s.setup.modelId) || {
      id: s.setup.modelId,
      provider: '',
      place: s.setup.localMode ? PLACE_THIS_MAC : '',
      placeLabel: s.setup.localMode ? 'This Mac' : 'Your accounts',
      label: s.setup.modelName || s.setup.modelId || '',
      machine: null,
      ready: true,
      reason: '',
    },
    onChange: (target) => chooseRunTarget(target),
    onAutomatic: () => chooseRunTarget(videoAutomatic?.target, { automatic: true }),
    pinned: s.setup.rentedMachineId || '',
    onPin: pinMachine,
  };
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
  // The Advanced tier now holds the seed, the refinement switch and the quality
  // tier as well as the adapters, so the closed header names every one of them
  // that is armed. A locked seed or a doubled render time is state that steers
  // the run; hidden behind the disclosure is fine, unsaid is not.
  const standardTierSelected = (() => {
    const pair = tierPairFor(s.catalogs.hivemindI2V, s.setup.modelId);
    return Boolean(pair && pair.lite.id !== s.setup.modelId);
  })();
  const advancedHint = [
    activeVideoLoras ? `${activeVideoLoras} LoRA${activeVideoLoras === 1 ? '' : 's'}` : '',
    String(s.setup.negativePrompt || '').trim() ? 'avoid list' : '',
    s.setup.detailerStrength ? 'detailer' : '',
    s.setup.spectrum === false ? 'full sampling' : '',
    standardTierSelected ? 'best quality' : '',
    minimaxStepsAvailable && minimaxRefinement === 'high' ? 'high detail' : '',
    Number(s.setup.seed) >= 0 ? `seed ${s.setup.seed}` : '',
  ].filter(Boolean).join(' · ');

  // "Use this person" is ONE control. The LTX graph's reference views — the
  // ones stitched into a sheet — used to be a section of the settings panel
  // with a jump button pointing at it, so the same intent was a chip on one
  // model and a panel on another. It renders inside the References control now,
  // as that model's own reference kind, with the stitched preview and the
  // per-view captions unchanged.
  const ingredientViews = ingredientModel ? (
    <IngredientsPanel
      model={ingredientModel}
      selection={s.sharedIngredientSelections}
      sheets={s.sharedIngredientSheets}
      selectedSheet={s.selectedIngredientSheet}
      preview={s.ingredientSheetPreview}
      previewSignature={ingredientSignature}
      uploadMessage={s.ingredientUploadMessage}
      activeCount={activeIngredients}
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
  ) : null;

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
    if (motionLimit.referenceVideoCount > 0) {
      return `Up to ${longest}s${card} — a motion reference is trimmed to the clip's own length, so a long reference caps the clip at the same length. Use a motion reference of ${motionLimit.maxSeconds.toFixed(1)}s or less and it keeps its own length instead, costing less and opening the full range. Removing it works too. Reference pictures cost the same whatever the length.${bigger}`;
    }
    const pics = motionLimit.referencePictureCount || 0;
    const sounds = motionLimit.referenceSoundCount || 0;
    const parts = [];
    if (pics) parts.push(`${pics} reference picture${pics === 1 ? '' : 's'}`);
    if (sounds) parts.push(`${sounds} sound reference${sounds === 1 ? '' : 's'}`);
    const inventory = parts.join(' and ');
    return `Up to ${longest}s${card} — the clip and everything attached to it share one sequence on the card, and a longer clip leaves less room. Your ${inventory} cost the same at every length, so the clip is what has to give: shorten it, or send fewer references for the full range.${bigger}`;
  })();
  const resolutionOptions = resolutionsFor(s.setup, s.setup.modelId);
  const qualityOptions = qualitiesFor(s.setup, s.catalogs, s.setup.modelId);
  const modeOptions = modesFor(s.setup.modelId);
  const effectOptions = effectNamesFor(s.setup, s.catalogs, s.setup.modelId);

  const modeLabel = (() => {
    if (isMotionControlV2V(s.setup, s.catalogs)) return 'Video + image → video';
    if (s.setup.v2vMode) return 'Video tool';
    if (videoTask === 'head-swap') return 'Head swap';
    if (isHivemindVideoInputMode(s.setup)) return 'Extend uploaded shot';
    if (model?.requiresRequestId) return 'Extend';
    // From the request plan, not from imageMode: every local workflow is
    // selected with imageMode true (the frame is an optional input), so H3
    // read "Image → video" with nothing attached — and with references armed.
    const plan = videoRequestPlan(s.setup);
    if (plan.sendReferenceImages) return 'Reference → video';
    if (plan.sendMotionContext) return 'Continue scene';
    const hasFrame = isHivemindVideoModelId(s.setup.modelId) ? Boolean(s.setup.imageUrl) : s.setup.imageMode;
    if (hasFrame) return 'Image → video';
    return 'Text → video';
  })();

  const isSeedanceResult = s.resultModel === 'seedance-v2.0-t2v' || s.resultModel === 'seedance-v2.0-i2v';
  const generateLabel = s.generating ? t('common.generating') : t('common.generate');

  const progressStageLabel = t(`video.progress.${s.progress.stage}`);
  const progressPct = Math.max(0, Math.min(1, Number(s.progressDisplay) || 0));
  const progressElapsedMs = Date.now() - s.generationStartedAt;
  const progressElapsed = formatVideoGenerationElapsed(progressElapsedMs);
  // What is LEFT, not the whole estimate again: past the estimate the honest
  // word is "finishing", not a countdown that went negative.
  const progressRemainingMs = Number(s.progressEstimateSec) > 0 ? s.progressEstimateSec * 1000 - progressElapsedMs : null;
  const progressEta = progressRemainingMs == null
    ? null
    : (progressRemainingMs > 0
      ? `${'~'}${formatVideoGenerationElapsed(progressRemainingMs)}${' left'}`
      : 'finishing…');
  const progressSteps = s.progressSteps?.total
    ? tf('video.progress.step', s.progressSteps.step, s.progressSteps.total)
    : null;
  // The stage prints the step counter beside the PHASE, so this line carries
  // only the shape of the render. With progressSteps still in it, the same
  // "step 12 of 32" would be printed twice on one readout.
  const progressDetail = [
    s.progressContext?.aspectRatio,
    s.progressContext?.duration ? `${s.progressContext.duration}s` : null,
  ].filter(Boolean).join(' · ');

  // Pinned to a machine that is no longer attached: collapse the panel to the
  // Source block and its reconnect CTA.
  const rentedBlocked = Boolean(s.setup.rentedMachineId && !s.rentedMachines?.length);
  const offlineBlocked = apiStatus.tone === 'offline';

  /* ---------------- Advanced ---------------- */

  // The drawer that replaced the permanent settings column. View state,
  // deliberately not persisted — a drawer that reopens itself on every reload
  // is a settings column again. Same pair the Image route uses.
  const toggleAdvanced = () => { s.advancedOpen = !s.advancedOpen; bump(); };
  const closeAdvanced = () => { s.advancedOpen = false; bump(); };

  /* ---------------- the controls the drawer borrows from the composer ---------------- */

  // Weaving the cast into the prompt is ONE action reached from three doors —
  // the cast strip's readout, Prompt Check, and the drawer's own copy of the
  // strip — so the closure is written once instead of three times. Byte for
  // byte what each of those three doors already ran.
  const weavePromptNow = () => {
    const before = weaveSnapshot();
    const woven = acceptPrompt(s.setup.prompt, { scaffold: true });
    if (woven.prompt !== before.prompt) announceWeave('Wove your references into the prompt', before);
    focusPrompt();
  };
  const openPromptHelper = () => { s.promptHelperOpen = true; bump(); };
  const openReferences = () => { s.referencesOpenRequest = (s.referencesOpenRequest || 0) + 1; bump(); };

  // What the strip already knows about the person in the rows — so "Save as
  // persona" starts from it.
  const personaSeed = (() => {
    const holder = s.cast.find((member) => member.kind === 'persona');
    return holder ? { gender: holder.data?.gender || '', look: holder.data?.look || '' } : null;
  })();

  // The Advanced drawer takes RENDERED controls for the cast, the frames, the
  // references, the clip and the four prompt-writing menus — VideoAdvanced says
  // why in its own header: those call sites are forty props wide and belong to
  // the studio rather than to a settings file. The composer builds its own from
  // primitives, so these are the drawer's copies: same engine object, same
  // handlers, same render conditions, and they only mount while it is open.
  const drawerCast = promptUi.disabled ? null : (
    <CastStrip
      members={s.cast}
      onMembersChange={applyCast}
      target={weaveTargetNow()}
      referenceLane={referenceLaneAvailable()}
      h3={isH3()}
      woven={isWovenForReference(s.setup.prompt)}
      promptEmpty={!s.setup.prompt.trim()}
      warnings={s.castWarnings}
      onAttach={openReferences}
      onWeave={weavePromptNow}
      onDraftLook={draftLookFor}
      onAddMedia={referenceLaneAvailable() ? addMediaForMember : null}
    />
  );

  // The four keyframe controls are mutually exclusive and in THIS order — the
  // three-slot picker, the chain chip, the two-slot picker, the plain start
  // frame. Only one ever renders, and the studio's own effects null the stale
  // halves when the branch changes.
  const drawerFrames = ltxFramesVisible ? (
    // LTX 2.3: one control with Start / Middle / End rows (all optional).
    <FrameSlotsPicker
      label="Frames"
      slots={[
        { key: 'start', label: slotLabels.image, url: s.setup.imageUrl },
        { key: 'middle', label: 'Middle', url: s.setup.ltxMiddleUrl },
        { key: 'end', label: 'End', url: s.setup.ltxEndUrl },
      ]}
      onSlotChange={(key, url) => {
        const value = url ? [url] : [];
        if (key === 'start') onStartFrameChange(value);
        else if (key === 'middle') onLtxMiddleFrameChange(value);
        else onLtxEndFrameChange(value);
      }}
      uploadFn={uploadFnForFrame}
      requireApiKey={frameRequiresApiKey}
      // No autoOpen here: s.framesPanelAutoOpen is a one-render pulse cleared by
      // an effect, and the composer's copy is the one that should answer it. Two
      // pickers reading it would both fly open on a single start-frame pick.
    />
  ) : chainArmed ? (
    // Scene chaining replaces the start frame: the armed clip's tail IS the
    // opening of this shot, so the picker gives way to the chain chip.
    <div
      className="flex items-center gap-1.5 rounded-md border border-honey/40 bg-honey-tint px-2 py-1"
      title="The pinned frames carry motion and room tone — the SCENE carries through the prompt. Keep the shot's style and subject words, hold the previous closing framing for a beat, then describe what happens next."
    >
      <Icon name="film" size={13} className="text-honey" />
      <span className="text-xs font-medium text-honey">{`Continuing shot ${chainShot}`}</span>
      <button
        type="button"
        title="Stop continuing the scene"
        aria-label="Stop continuing the scene"
        className="grid h-4 w-4 place-items-center rounded text-honey transition-colors hover:bg-honey/20"
        onClick={clearMotionContext}
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  ) : endFrameVisible ? (
    // First/last-frame models (H3 FL2VA, remote FLF): ONE control with Start /
    // End rows, same pattern as the LTX three-slot picker. Armed character
    // references replace these frames for the run, but the picker stays mounted
    // (dimmed, with a note) — hiding it stranded an already-set start frame with
    // no way to change it or add the end frame.
    <FrameSlotsPicker
      label="Frames"
      slots={[
        { key: 'start', label: slotLabels.image, url: s.setup.imageUrl },
        { key: 'end', label: 'End (optional)', url: s.setup.endImageUrl },
      ]}
      onSlotChange={(key, url) => {
        const value = url ? [url] : [];
        if (key === 'start') onStartFrameChange(value);
        else onEndFrameChange(value);
      }}
      uploadFn={uploadFnForFrame}
      requireApiKey={frameRequiresApiKey}
      inactiveNote={refsArmed ? 'Character references replace these frames while attached' : ''}
    />
  ) : (
    <UploadPicker
      values={s.setup.imageUrl ? [s.setup.imageUrl] : []}
      onChange={onStartFrameChange}
      uploadFn={uploadFnForFrame}
      requireApiKey={frameRequiresApiKey}
      maxImages={1}
      accept="image/*"
      label="Start frame"
      ignored={refsArmed}
    />
  );

  // One control for every reference kind this model has. The slot counts come
  // from the workflow entry rather than being restated here, so the drawer can
  // never offer a slot the graph has not wired — and a model whose only
  // reference kind is stitched views shows just those.
  const drawerReferences = referenceEntry || ingredientModel ? (
    <ReferencesMenu
      images={Array.isArray(s.setup.referenceImageUrls) ? s.setup.referenceImageUrls : []}
      audios={Array.isArray(s.setup.referenceAudios) ? s.setup.referenceAudios : []}
      videos={Array.isArray(s.setup.referenceVideos) ? s.setup.referenceVideos : []}
      prompt={s.setup.prompt}
      durationSeconds={Number(s.setup.duration) || 0}
      limits={{
        images: referenceEntry?.referenceSlots?.images || 9,
        audios: referenceEntry?.referenceSlots?.audios || 3,
        videos: referenceEntry?.referenceSlots?.videos || 3,
      }}
      views={ingredientViews}
      viewsOnly={!referenceEntry}
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
      personaSeed={personaSeed}
      uploadFn={uploadFnForFrame}
      requireApiKey={frameRequiresApiKey}
      // Deliberately not wired to s.referencesOpenRequest: the composer's copy
      // owns that pulse, and two menus answering one request would both fly open.
      openRequest={0}
      // Head replacement's one door. Offered only on a family whose registry
      // actually carries an inpaint graph, so the thumbnail never opens a dialog
      // whose Apply the run would ignore.
      onOpenClip={inpaintEntry ? (index) => { s.inpaintOpenIndex = index; bump(); } : null}
    />
  ) : null;

  // One chip, two meanings, and the chip SAYS which. The request plan decides:
  // where a clip seeds the next shot's opening frames (motion context) it is
  // "Continue from clip"; everywhere else a clip is an INPUT to the run, so it
  // is the source video. One icon and the word "Clip" for both was unguessable.
  const drawerClip = (() => {
    const label = clipChipContinues ? 'Continue from clip' : 'Source video';
    const idle = clipChipContinues
      ? 'Continue from a clip — the next shot picks up where it ends, motion and room tone carrying across'
      : `${'Upload'}: ${slotLabels.video}${slotLabels.videoHint ? ` — ${slotLabels.videoHint}` : ''}`;
    const attachedText = `${s.setup.videoName || label} — ${'click to clear'}`;
    return (
      <ChipButton
        icon={clipChipContinues ? 'film' : 'upload'}
        label={label}
        value={attachedClipUrl() ? (s.setup.videoName || 'attached') : ''}
        active={Boolean(attachedClipUrl())}
        chevron={false}
        disabled={s.videoUploading}
        aria-label={attachedClipUrl() ? attachedText : `${label} — ${idle}`}
        title={attachedClipUrl() ? attachedText : idle}
        onClick={onVideoRefClick}
      />
    );
  })();

  /* ---------------- the Advanced drawer ---------------- */

  // Was ~460 lines of inline JSX in a permanent 320px column. VideoAdvanced.jsx
  // holds the same controls, re-tiered by what each one decides; every value it
  // reads and every writer it calls is still this file's.
  const panel = (
    <VideoAdvanced
      engine={s}
      commit={commit}
      rentedBlocked={rentedBlocked}
      modeLabel={modeLabel}
      runOn={runOn}
      tabActive={tabActive}
      videoTask={videoTask}
      availableTasks={availableTasks}
      swapState={swapState}
      visibility={visibility}
      arOptions={arOptions}
      setAr={setAr}
      arMatchedToFrame={arMatchedToFrame}
      startFrameArMatchAvailable={startFrameArMatchAvailable}
      setMatchStartFrameAr={setMatchStartFrameAr}
      minimaxSelected={minimaxSelected}
      durationOptions={durationOptions}
      durationCapped={durationCapped}
      motionCapHint={motionCapHint}
      setDuration={setDuration}
      resolutionOptions={resolutionOptions}
      setResolution={setResolution}
      qualityOptions={qualityOptions}
      setQuality={setQuality}
      modeOptions={modeOptions}
      setMode={setMode}
      effectOptions={effectOptions}
      setEffect={setEffect}
      advancedHint={advancedHint}
      tierPair={tierPairFor(s.catalogs.hivemindI2V, s.setup.modelId)}
      selectHiveModel={selectHiveModel}
      minimaxStepsAvailable={minimaxStepsAvailable}
      minimaxRefinement={minimaxRefinement}
      modelDefaultSteps={model?.defaultSteps}
      seedAvailable={isHivemindVideoModelId(s.setup.modelId)}
      setSeed={setSeed}
      randomizeSeed={randomizeSeed}
      lockLastSeed={lockLastSeed}
      spectrumAvailable={supportsSpectrum(model)}
      chainArmed={chainArmed}
      fastHighResAvailable={supportsFastHighRes(model)}
      denoiseAvailable={denoiseAvailable}
      setNegativePrompt={setNegativePrompt}
      advancedInputs={advancedInputs}
      setAdvanced={setAdvanced}
      loraProps={loraModel ? {
        open: s.loraOpen,
        onToggleOpen: () => {
          s.loraOpen = !s.loraOpen;
          bump();
          if (s.loraOpen) void loadLorasForCurrentVideoModel();
        },
        baseLabel: loraModel.compatibleBaseModels?.join(', ') || loraModel.name,
        baseModelId: loraModel.id || '',
        baseModels: loraModel.compatibleBaseModels || [],
        status: s.videoLoraCatalogStatus,
        message: s.videoLoraCatalogMessage,
        loras: s.availableVideoLoras,
        onRentedMachine: Boolean(s.setup.localMode && s.setup.rentedMachineId),
        selection: currentVideoLoraSelection(),
        getSelection: currentVideoLoraSelection,
        onToggleLora: (lora) => setCurrentVideoLoraSelection(toggleLoraSelection(currentVideoLoraSelection(), lora)),
        onToggleEnabled: (lora) => setCurrentVideoLoraSelection(toggleLoraEnabled(currentVideoLoraSelection(), lora.id)),
        onSetStrength: (id, value) => setCurrentVideoLoraSelection(updateLoraStrength(currentVideoLoraSelection(), id, value), { render: false }),
        onCommitStrength: (id, value) => setCurrentVideoLoraSelection(updateLoraStrength(currentVideoLoraSelection(), id, value)),
        onClearAll: () => setCurrentVideoLoraSelection([]),
        onDownload: () => { s.civitaiOpen = true; bump(); },
        onUpdateLora: startVideoLoraUpdate,
        onLoadGroup: (selection) => setCurrentVideoLoraSelection(selection),
      } : null}
      // This studio does not track a local-catalog status today (only Image,
      // Story and Sprite do). The home exists either way, so the notice never
      // has to be re-invented the day it grows one.
      localCatalog={null}
      onSwitchToCloud={() => setLocalMode(false)}
      cast={drawerCast}
      frames={drawerFrames}
      references={drawerReferences}
      clip={drawerClip}
      cameraMotion={promptUi.disabled ? null : (
        <CameraMotionMenu selectedIds={s.setup.cameraMotionIds || []} onApply={applyCameraMotions} />
      )}
      restyle={!promptUi.disabled && isH3() ? (
        <RestyleMenu activeId={s.setup.restylePresetId || null} onApply={applyRestyle} />
      ) : null}
      emotion={promptUi.disabled ? null : (
        <EmotionMenu activeId={s.setup.emotionDirectionId || null} onApply={applyEmotion} />
      )}
      ugcBrief={!promptUi.disabled && isH3() ? (
        <UgcMenu
          mode="video"
          active={hasUgcVideoBrief(s.setup.prompt)}
          variantIndex={Number.isInteger(s.setup.ugcVariantIndex) ? s.setup.ugcVariantIndex : null}
          formatId={ugcFormatInPrompt(s.setup.prompt) || s.setup.ugcFormat || UGC_DEFAULT_FORMAT}
          gender={s.setup.persona?.gender || ''}
          subject={ugcSubjectLabel(ugcPersona())}
          durationSeconds={Number(s.setup.duration) || null}
          verticalAvailable={aspectRatiosFor(s.setup, s.setup.modelId).includes('9:16')}
          onArm={applyUgc}
        />
      ) : null}
    />
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
      toast.success('Attached as the start frame');
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
      toast.error(err?.message || 'Could not attach that.');
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
          toast.error('This model takes a picture as its start frame.');
          return;
        }
        onStartFrameChange([await promoteOutputToReference(payload.url)]);
        toast.success('Attached as the start frame');
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

  /* ---------------- the sequence, and the composer ---------------- */

  const selectedSeg = s.timelineSegments.find((seg) => seg.id === s.timelineSelectedId);
  // The manual sequence surface, handed to the composer's `more` menu as a node.
  // The rail draws the shots, but it cannot express reorder-by-drag, exclude,
  // cut, combine or delete-with-file — so the full strip stays one press away
  // rather than being replaced by the rail.
  const timelineStrip = s.timelineOn ? (() => {
    const modelEntry = currentModel(s.setup, s.catalogs);
    const extendMode = timelineExtendModeFor(modelEntry);
    return (
      <TimelineStrip
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
        onExportSegment={(seg) => void timelineExportSegment(seg)}
        onToggleExcluded={timelineToggleExcluded}
      />
    );
  })() : null;

  // Thirteen labelled chips over two lines became a sentence plus five doors.
  // VideoComposerBar draws it; every value below is the one the drawer renders
  // and every handler is the one the chip row called, so a shortcut can never
  // diverge from the control it shortcuts.
  const composer = (
    <VideoComposerBar
      engine={s}
      promptRef={promptRef}
      promptUi={promptUi}
      setPrompt={setPrompt}
      extendBanner={extendBanner}
      castTarget={weaveTargetNow()}
      referenceLane={referenceLaneAvailable()}
      h3={isH3()}
      castWoven={isWovenForReference(s.setup.prompt)}
      onCastChange={applyCast}
      onCastAttach={openReferences}
      onCastWeave={weavePromptNow}
      onDraftLook={draftLookFor}
      onAddMedia={referenceLaneAvailable() ? addMediaForMember : null}
      ltxFramesVisible={ltxFramesVisible}
      endFrameVisible={endFrameVisible}
      chainArmed={chainArmed}
      chainShot={chainShot}
      onClearChain={clearMotionContext}
      slotLabels={slotLabels}
      refsArmed={refsArmed}
      uploadFn={uploadFnForFrame}
      requireApiKey={frameRequiresApiKey}
      onStartFrameChange={onStartFrameChange}
      onMiddleFrameChange={onLtxMiddleFrameChange}
      onLtxEndFrameChange={onLtxEndFrameChange}
      onEndFrameChange={onEndFrameChange}
      referenceEntry={referenceEntry}
      ingredientModel={ingredientModel}
      ingredientViews={ingredientViews}
      referenceLimits={referenceLimits()}
      sceneRefs={sceneUrls()}
      sceneRoles={sceneRoleMap()}
      onSceneRole={onSceneRole}
      onCharacterRefsChange={onCharacterRefsChange}
      onSceneRefsChange={onSceneRefsChange}
      onReferenceAudiosChange={onReferenceAudiosChange}
      onReferenceVideosChange={onReferenceVideosChange}
      onPersonaChange={onPersonaChange}
      personaSeed={personaSeed}
      onOpenClip={inpaintEntry ? (index) => { s.inpaintOpenIndex = index; bump(); } : null}
      videoFileInputRef={videoFileInputRef}
      memberFileInputRef={memberFileInputRef}
      onVideoFile={handleVideoFile}
      onMemberFiles={attachFilesForMember}
      clipChipContinues={clipChipContinues}
      clipUrl={attachedClipUrl()}
      onVideoRefClick={onVideoRefClick}
      starterGender={castRenderGender(s.cast) || s.setup.persona?.gender || ''}
      standIns={liveStandIns(s.setup.prompt, s.standIns)}
      captureContext={() => captureGenerationContext(s.setup.prompt)}
      onLoadPrompt={({ prompt, standIns, timeline, durationSeconds }) => {
        loadPromptText(prompt, { standIns: standIns || [] });
        applyStarterSetup({ timeline, durationSeconds });
        focusPrompt();
      }}
      onLoadContext={(context) => restoreGenerationContext(context)}
      cameraMotionIds={s.setup.cameraMotionIds || []}
      onApplyCameraMotions={applyCameraMotions}
      emotionDirectionId={s.setup.emotionDirectionId || null}
      onApplyEmotion={applyEmotion}
      ugcActive={hasUgcVideoBrief(s.setup.prompt)}
      ugcVariantIndex={Number.isInteger(s.setup.ugcVariantIndex) ? s.setup.ugcVariantIndex : null}
      ugcFormatId={ugcFormatInPrompt(s.setup.prompt) || s.setup.ugcFormat || UGC_DEFAULT_FORMAT}
      ugcGender={s.setup.persona?.gender || ''}
      ugcSubject={ugcSubjectLabel(ugcPersona())}
      ugcDuration={Number(s.setup.duration) || null}
      ugcVerticalAvailable={aspectRatiosFor(s.setup, s.setup.modelId).includes('9:16')}
      onApplyUgc={applyUgc}
      restylePresetId={s.setup.restylePresetId || null}
      onApplyRestyle={applyRestyle}
      shotTimeline={s.shotTimeline}
      onOpenShotBuilder={() => { s.shotBuilderOpen = true; bump(); }}
      promptCheckRefs={attachedReferences()}
      promptCheckDurations={referenceDurations()}
      onRefit={() => commit({ ...s.setup, prompt: adoptPrompt(s.setup.prompt) })}
      onWeave={weavePromptNow}
      onRefine={openPromptHelper}
      onOpenPromptHelper={openPromptHelper}
      videoTask={videoTask}
      durationVisible={visibility.duration}
      durationIsSlider={minimaxSelected}
      durationOptions={durationOptions}
      durationHint={durationCapped ? motionCapHint : ''}
      onDurationChange={setDuration}
      aspectVisible={visibility.ar}
      aspectOptions={arOptions}
      aspectMatchedToFrame={arMatchedToFrame}
      startFrameArMatchAvailable={startFrameArMatchAvailable}
      onAspectChange={setAr}
      onMatchStartFrameAr={setMatchStartFrameAr}
      runOn={runOn}
      advancedOpen={s.advancedOpen}
      onToggleAdvanced={toggleAdvanced}
      onNewPrompt={requestNewPrompt}
      onClearPrompt={clearPromptOnly}
      timeline={timelineStrip}
      generateLabel={generateLabel}
      generateBlocked={offlineBlocked || rentedBlocked || (swapState.active && !swapState.ready)}
      generateTitle={offlineBlocked
        ? t('video.generateOffline')
        : rentedBlocked
          ? 'Rent a machine (or switch the source to Local) to generate.'
          : (swapState.active && !swapState.ready)
            ? `${'Still needed: '}${swapState.missing.join(' and ')}`
            : `${t('video.generateTooltip')} (⌘/Ctrl+Enter)`}
      rentedBlocked={rentedBlocked}
      onGenerate={generate}
      onCancel={cancelGeneration}
    />
  );

  /* ---------------- stage, rail, notices ---------------- */

  const hasHistory = s.generationHistory.length > 0;
  const currentEntry = s.generationHistory.find((e) => e.url === s.resultUrl);
  // The sequence position the stage names. While a render is in flight the
  // pending slot is the selected segment, not the clip that is still on screen.
  const stageShotLabel = (() => {
    const index = s.generating
      ? s.timelineSegments.findIndex((seg) => seg.id === s.timelineSelectedId)
      : s.timelineSegments.findIndex((seg) => seg.url === s.resultUrl);
    return index >= 0 ? `shot ${String(index + 1).padStart(2, '0')}` : '';
  })();
  // This machine renders one clip at a time, so a second tab is a queue, not a
  // stall. Saying which place it is in is what keeps a motionless bar from
  // reading as a hang. Composed HERE and handed to the stage as finished
  // sentences — renderCostBudget.test.js pins both templates to this file.
  const queueNote = s.progressQueuePosition
    ? `Waiting behind ${s.progressQueuePosition === 1 ? 'one render' : `${s.progressQueuePosition} renders`} — this one starts by itself when the GPU is free.`
    : '';
  const overtimeNote = s.progressOvertimeMin
    ? `Still rendering after ${s.progressOvertimeMin} min — keep waiting, or use Cancel above to stop.`
    : '';
  const downloadResult = () => {
    downloadFile(s.resultUrl, videoDownloadName(currentEntry?.model || s.resultModel, currentEntry?.id));
  };
  // The settings that travel INSIDE a clip the owner asked to save unencrypted.
  // Same rule and the same mapper as the Image studio: the context captured for
  // THIS clip, never the composer's current state.
  const downloadSettingsForResult = () => {
    if (!s.resultUrl) return {};
    const made = s.contextStore.recall(s.resultUrl);
    const entry = currentEntry || { model: s.resultModel };
    // A video lane's dials are not fixed fields: each model declares its own
    // advanced inputs, so seed/steps/cfg live under whatever name that model
    // uses. Read the handful of names the ecosystem's metadata actually has a
    // slot for and leave the rest — a missing setting stays missing rather than
    // becoming a plausible-looking default.
    const advanced = made?.advancedValues || {};
    const dial = (...names) => {
      for (const name of names) {
        const value = advanced[name];
        if (value !== undefined && value !== null && value !== '') return value;
      }
      return undefined;
    };
    return postMetaFromEntry({
      ...entry,
      prompt: entry.prompt || made?.prompt || '',
      negativePrompt: dial('negative_prompt', 'negativePrompt') || '',
      model: made?.modelName || entry.model || made?.model || s.resultModel || '',
      seed: entry.seed ?? dial('seed'),
      steps: dial('steps', 'num_inference_steps', 'inference_steps'),
      cfg: dial('cfg', 'cfg_scale', 'guidance_scale', 'guidanceScale'),
      sampler: dial('sampler', 'sampler_name'),
      scheduler: dial('scheduler'),
      civitaiResources: civitaiResourcesFromLoras(made?.loras, s.availableVideoLoras),
    });
  };

  const postResultToCivitai = () => {
    // Same rule as the Image studio: the LoRAs recorded against THIS clip's
    // context, never the composer's current pick.
    const made = s.contextStore.recall(s.resultUrl);
    s.civitaiPost = {
      url: s.resultUrl,
      entry: {
        ...(currentEntry || { model: s.resultModel }),
        civitaiResources: civitaiResourcesFromLoras(made?.loras, s.availableVideoLoras),
      },
    };
    bump();
  };

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <StudioFrame
        railWidth={108}
        tabs={tabStrip}
        drop={composerDrop}
        composer={composer}
        drawerTitle={t('common.advanced')}
        drawerOpen={s.advancedOpen}
        onDrawerClose={closeAdvanced}
        drawer={panel}
        notices={(
          <>
            {/* The last failure, and the dependency report, used to head a
                scrolling column. The stage does not scroll, so they float over
                its top edge where they cannot be scrolled past — and VideoStage
                deliberately carries neither, so this slot is their only home. */}
            {s.generateError ? (() => {
              // Name the box when the run was promised to a rented one — "it
              // failed" on a rental means a different next step.
              const onRented = (() => {
                if (!s.setup.rentedMachineId) return '';
                const machine = servingMachineFor(s.setup, s.setup.modelId, s.rentedMachines);
                if (!machine) return ' on the rented machine';
                return ` on ${machine.gpu || 'the rented machine'} (${machine.rental_id || 'rented'})`;
              })();
              return (
                <FailureCallout
                  title={`${s.generateError}${onRented}`}
                  detail={s.generateFailure?.detail || ''}
                  remedy={s.generateFailure?.remedy || null}
                  onRemedy={(remedy) => void runFailureRemedy(remedy, {
                    onMuapiKey: () => { s.authRetry = () => generate(); s.authOpen = true; bump(); },
                    onRetry: () => { s.generateError = ''; s.generateFailure = null; bump(); void generate(); },
                    // The lane lacks something installable: open the installer
                    // on a fresh report rather than sending anyone to a terminal.
                    onInstallDependencies: () => void openDependencyPrompt({ force: true }),
                  })}
                  onRetry={() => { s.generateError = ''; s.generateFailure = null; bump(); void generate(); }}
                  retryLabel="Try again"
                  detailsLabel="Details"
                  onDismiss={() => { s.generateError = ''; s.generateFailure = null; bump(); }}
                  dismissLabel="Dismiss"
                />
              );
            })() : null}
            {s.dependencyPromptOpen && s.dependencyReport && dependencyWorkflowId ? (
              <WorkflowDependencyPrompt
                report={s.dependencyReport}
                workflowId={dependencyWorkflowId}
                runOn={dependencyRunOn}
                onReport={(report) => { s.dependencyReport = report; bump(); }}
                onRemedy={(remedy) => void runFailureRemedy(remedy, {})}
                onClose={() => { s.dependencyPromptOpen = false; bump(); }}
              />
            ) : null}
          </>
        )}
        stageActions={(
          <VideoStageActions
            clipUrl={s.resultUrl}
            canContinue={Boolean(chainCapableEntryFor(s.resultModel))}
            chainLength={currentEntry ? collectChainClips(currentEntry, s.generationHistory).length : 0}
            joining={s.joiningChain}
            smoothing={s.smoothingClip}
            canSmooth={isLocalAIAvailable()}
            isSeedanceResult={isSeedanceResult}
            onDownload={downloadResult}
            downloadSettings={downloadSettingsForResult}
            downloadFilename={videoDownloadName(currentEntry?.model || s.resultModel, currentEntry?.id)}
            videoRef={stageVideoRef}
            onContinueScene={() => continueSceneFrom(s.resultUrl, s.resultModel)}
            onNewPrompt={requestNewPrompt}
            onRegenerate={regenerate}
            onBackToSetup={backToSetup}
            onExtend={extend}
            onSmoothClip={() => void smoothClip(s.resultUrl, s.resultModel, 2)}
            onJoinChain={() => void joinChainFrom(currentEntry)}
            onPostToCivitai={postResultToCivitai}
            onDelete={() => { s.deleteTarget = currentEntry; bump(); }}
            labels={{
              newPrompt: t('common.new'),
              download: t('common.download'),
              regenerate: t('common.regenerate'),
              backToSetup: t('common.backToSetup'),
              extend: t('video.extend'),
            }}
          />
        )}
        rail={(
          <VideoRail
            segments={s.timelineSegments}
            selectedId={s.timelineSelectedId}
            showCombined={s.timelineShowCombined}
            pendingSegmentId={s.generating && selectedSeg && !selectedSeg.url ? selectedSeg.id : ''}
            timelineOn={s.timelineOn}
            generating={s.generating}
            progress={progressPct}
            secondsFor={(seg) => Number(
              s.generationHistory.find((entry) => entry.url === seg.url)?.duration
              || s.contextStore.recall(seg.url)?.duration
              || 0,
            )}
            promptFor={timelinePromptFor}
            onSelect={timelineSelect}
            onAdd={timelineAdd}
            onOpenTimeline={openTimelineView}
            onRemove={timelineRemoveRequest}
            onDrop={timelineHandleDrop}
            onExportSegment={(seg) => void timelineExportSegment(seg)}
            onToggleExcluded={timelineToggleExcluded}
            onOpenSceneTools={openTimelineView}
            history={s.generationHistory}
            resultUrl={s.resultUrl}
            onOpenHistory={openHistoryEntry}
            onDownloadHistory={(entry) => downloadFile(entry.url, videoDownloadName(entry.model, entry.id))}
            onRemoveHistory={(entry) => { s.deleteTarget = entry; bump(); }}
            onContinueHistory={(entry) => continueSceneFrom(entry.url, entry.model)}
            canContinue={(entry) => Boolean(chainCapableEntryFor(entry.model))}
          />
        )}
        stage={(
          <VideoStage
            clipUrl={s.resultUrl}
            clipModel={s.resultModel}
            clipUnmuted={Boolean(s.resultUnmuted)}
            // H3 renders audio with every clip; other lanes are silent unless a
            // join carried sound through.
            clipHasAudio={/minimax/.test(String(s.resultModel || ''))
              || (s.chainCombined?.url === s.resultUrl && Boolean(s.chainCombined?.audioJoined))
              || (s.timelineCombined?.url === s.resultUrl && Boolean(s.timelineCombined?.audioJoined))}
            clipAspect={String(s.progressContext?.aspectRatio || s.setup.ar || '16:9').replace(':', ' / ')}
            shotLabel={stageShotLabel}
            videoRef={stageVideoRef}
            generating={s.generating}
            progressTitle={t('video.progressTitle')}
            progressPhase={progressStageLabel}
            progressSteps={progressSteps}
            progressValue={progressPct}
            progressModelName={s.progressContext?.modelName || s.progressContext?.model || ''}
            progressDetail={progressDetail}
            progressPreviewUrl={s.progressContext?.imageUrl || ''}
            progressElapsed={progressElapsed}
            progressEta={progressEta}
            elapsedLabel={t('video.progress.elapsed')}
            queueNote={queueNote}
            overtimeNote={overtimeNote}
            onCancel={cancelGeneration}
            hasHistory={hasHistory}
            labels={{ cancel: t('common.cancel') }}
          />
        )}
      />

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
          // The fix for "no reference picture", in the dialog that raises it:
          // close it and open the References panel on the picture rows.
          onAttachReference={() => {
            s.inpaintOpenIndex = null;
            s.referencesOpenRequest = (s.referencesOpenRequest || 0) + 1;
            bump();
          }}
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
        title="Delete video"
        body="Remove this video from this session's strip. It stays in the History hub."
        confirmLabel="Delete"
      />

      {/* Removing a timeline segment: the segment always goes; the FILE goes
          only when the toggle inside says so — and the toggle is only offered
          once a deletable file was actually found on this device. */}
      <ConfirmModal
        open={Boolean(s.timelineDeleteTarget)}
        onClose={() => { s.timelineDeleteTarget = null; bump(); }}
        onConfirm={() => void confirmTimelineRemove()}
        title="Remove this segment?"
        body={(
          <div className="flex flex-col gap-3">
            <p className="text-[13px] leading-relaxed text-ink2">
              The segment comes off the timeline. The clip itself stays in the session strip and the History hub.
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
                label="Also delete the video?"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] text-ink1">Also delete the video?</span>
                <span className={cx('text-[11px]', s.timelineDeleteTarget?.deleteDisk ? 'text-danger' : 'text-ink3')}>
                  {s.timelineDeleteTarget?.resolvingRow
                    ? 'Checking for the file on this device…'
                    : s.timelineDeleteTarget?.row
                      ? 'Permanently deletes the file from this device, along with its History row. This cannot be undone.'
                      : 'No file to delete on this device — a cloud result, or one already gone.'}
                </span>
              </span>
            </label>
          </div>
        )}
        confirmLabel={s.timelineDeleteTarget?.deleteDisk
          ? 'Remove and delete file'
          : 'Remove'}
      />

      {/* A drop onto a filled card replaces its clip — said out loud first,
          because the clip being replaced was placed there on purpose. */}
      <ConfirmModal
        open={Boolean(s.timelineReplaceTarget)}
        tone="primary"
        onClose={() => { s.timelineReplaceTarget = null; bump(); }}
        onConfirm={confirmTimelineReplace}
        title="Replace this clip?"
        body="The dropped clip takes this segment's place. The clip it replaces stays in the strip and in History."
        confirmLabel="Replace"
        cancelLabel="Keep the current clip"
      />

      {/* Start fresh takes more than the prompt, so it says what it is about to
          take — in the words on screen, listed from the same setup the
          transition clears. `tone="primary"` rather than danger: nothing here
          is deleted. Every clip it drops is still in History. */}
      <ConfirmModal
        open={s.startFreshConfirm}
        tone="primary"
        title={t('common.startFreshTitle')}
        confirmLabel={t('common.startFresh')}
        cancelLabel={t('common.keepWhatIHave')}
        body={(
          <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink2">
            <p>This empties the composer. It clears:</p>
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {startFreshSummary(s.setup).map((item) => <li key={item}>{item}</li>)}
            </ul>
            <p>
              Your model, clip length, aspect and everything in Advanced stay exactly as they are,
              and the clips you have already made stay in History.
            </p>
          </div>
        )}
        onClose={() => { s.startFreshConfirm = false; bump(); }}
        onConfirm={newPrompt}
      />

      {/* Attaching a source clip costs a model switch and/or the attached
          references — said out loud, with a way out, before anything uploads. */}
      <ConfirmModal
        open={Boolean(s.sourceSwitchConfirm)}
        tone="primary"
        onClose={() => answerSourceSwitch(false)}
        onConfirm={() => answerSourceSwitch(true)}
        title="Attach this clip?"
        body={(
          <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink2">
            {(s.sourceSwitchConfirm?.lines || []).map((line) => <p key={line}>{line}</p>)}
          </div>
        )}
        confirmLabel="Switch and attach"
        cancelLabel="Keep as is"
      />

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

