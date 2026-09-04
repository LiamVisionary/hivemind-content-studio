// THE single source of truth for "what job is the Video Studio running, and what
// does that imply".
//
// Every consequence of the task — which media get sent, whether an attached video
// means "extend", whether the frame slots are shown, what those slots are called,
// whether uploading footage should discard a start frame — is derived HERE and
// nowhere else. Layers consume `videoRequestPlan()`; they never re-inspect which
// files happen to be attached.
//
// This exists because that inference used to be duplicated across eight sites
// (studio payload, request builder, two server modules, three MCP branches, and
// the slot-visibility rule). Each copy independently assumed "a video is attached
// ⇒ this is an extension ⇒ there is no image", so head swap — which needs a video
// AND an image — was silently impossible, and every fix only moved the failure to
// the next copy. Adding a task must mean editing this file, not eight of them.
//
// Lives in src/lib rather than videoLogic.js so the node:test suite can import
// it; that suite cannot load JSX, which is precisely why the two rules that stayed
// in the JSX file were the ones no test caught.

import { isHivemindVideoModelId, workflowIdFromHivemindModelId } from './hivemindModelIds.js';

/**
 * The workflow-registry family of a studio SETUP or a catalog MODEL ENTRY,
 * lower-cased, or '' when the thing has no registry family at all.
 *
 * One fact, two field names, because it is denormalized: the studio copies it
 * into `setup.modelFamily`, and catalog entries carry it as `workflowFamily`.
 * Accepting both is what lets every family question be asked of whichever
 * object a caller happens to be holding — the alternative (a setup-only
 * predicate plus an inline `String(entry.workflowFamily).startsWith(...)` at
 * each model-shaped call site) is how the two drifted apart in the first place.
 *
 * The cloud catalogs' own `family` field is DELIBERATELY not consulted. It is a
 * different namespace that happens to collide: `ltx-2-pro-image-to-video` is
 * family "ltx" and MiniMax Hailuo is "minimax-2", and reading it here would
 * hand a remote provider's model the local graph's controls.
 */
function registryFamily(source) {
    const family = String(source?.modelFamily ?? source?.workflowFamily ?? '').toLowerCase();
    if (family) return family;
    // Fallback for setups persisted before modelFamily existed. Only local
    // workflow ids carry the provider prefix, and only local workflows have a
    // registry family, so a bare cloud id is never guessed at — that guess is
    // what would misread `ltx-2-pro-image-to-video` as an LTX-graph workflow.
    const id = String(source?.modelId ?? source?.id ?? '');
    return isHivemindVideoModelId(id) ? workflowIdFromHivemindModelId(id).toLowerCase() : '';
}

/** Extend and head swap are LTX-GRAPH features (the extension graph and the
 *  BFS head-swap LoRA). Other families — MiniMax H3 and anything added later
 *  — can only generate, so offering those tabs there is a lie. */
export function isLtxFamilyModel(source) {
    return registryFamily(source).startsWith('ltx');
}

/** MiniMax H3-family workflows get their own quality controls (15s duration
 *  ceiling, native-canvas resolution tier, refinement steps) because those
 *  tradeoffs are measured properties of THIS model, not of local video
 *  generally. */
export function isMinimaxFamilyModel(source) {
    return registryFamily(source).startsWith('minimax');
}

/**
 * What attaching a SOURCE clip is about to cost, or null when it costs nothing.
 *
 * Extend and head swap are LTX-graph features, so attaching a clip while a
 * non-LTX workflow is selected moves you to an LTX one — and a source clip and
 * reference mode never combine, so any attached references are dropped. Both
 * used to happen silently: you picked MiniMax H3, dropped in a clip, and were
 * quietly on a different model with your references gone.
 *
 * Returns the facts; the studio does the asking.
 */
export function sourceVideoSwitchCost({ setup, target } = {}) {
    const fromId = String(setup?.modelId || '');
    const toId = String(target?.id || '');
    const referenceCount = ['referenceImageUrls', 'referenceVideos', 'referenceAudios']
        .reduce((total, key) => total + (Array.isArray(setup?.[key]) ? setup[key].filter(Boolean).length : 0), 0);
    const switchesModel = Boolean(toId) && toId !== fromId;
    if (!switchesModel && !referenceCount) return null;
    return {
        switchesModel,
        fromModel: String(setup?.modelName || fromId),
        toModel: String(target?.name || toId),
        droppedReferences: referenceCount,
    };
}

export const VIDEO_TASKS = ['generate', 'extend', 'head-swap'];

/** Tasks the selected model can actually perform. */
export function videoTasksFor(setup) {
    if (!isHivemindVideoModelId(setup?.modelId)) return ['generate'];
    return isLtxFamilyModel(setup) ? [...VIDEO_TASKS] : ['generate'];
}

/** The task in effect, coerced to one the current model supports. */
export function activeVideoTask(setup) {
    const task = setup?.videoTask || 'generate';
    return videoTasksFor(setup).includes(task) ? task : 'generate';
}

/** Is head swap ready to run, and if not, what is missing? */
export function headSwapReadiness(setup) {
    if (activeVideoTask(setup) !== 'head-swap') return { active: false, ready: false, missing: [] };
    const missing = [];
    if (!setup?.videoUrl) missing.push('source video');
    if (!setup?.imageUrl) missing.push('face image');
    return { active: true, ready: missing.length === 0, missing };
}

/** Labels for the frame/video slots, which mean different things per task. */
export function slotLabelsFor(task) {
    if (task === 'head-swap') {
        return { image: 'New face', video: 'Source video', imageHint: 'The face to swap in', videoHint: 'Footage whose face gets replaced' };
    }
    if (task === 'extend') {
        return { image: 'Start frame', video: 'Video to extend', imageHint: '', videoHint: 'New footage is appended to its end' };
    }
    // NOT "Reference video". This slot is the SOURCE clip — attaching one puts
    // the run on the extend/tools path and clears any references. Naming it
    // "Reference video" put it one word away from the References menu beside
    // it, which conditions on motion clips and is a different input entirely.
    return {
            image: 'Start frame',
            video: 'Clip to extend or edit',
            imageHint: 'Becomes the first frame',
            videoHint: 'Switches to the extend / video-tools path',
        };
}

/**
 * Everything downstream needs to know, decided once.
 *
 * `sendVideo`/`sendImage` are the contract that replaced the old
 * `video ? {video} : image ? {image} : {}` chains. They are properties of the
 * TASK, not of which uploads happen to exist, so a task needing both media can
 * simply say so.
 */
export function videoRequestPlan(setup) {
    const task = activeVideoTask(setup);
    const local = isHivemindVideoModelId(setup?.modelId);
    if (task === 'head-swap') {
        return {
            task,
            sendVideo: true,
            sendImage: true,
            // Not an extension. Sending a mode here is what made servers treat it
            // as one regardless of the task.
            videoMode: null,
            sendMotionContext: false,
            showFrameSlots: true,
            keepImageOnVideoUpload: true,
        };
    }
    if (task === 'extend') {
        return {
            task,
            sendVideo: true,
            sendImage: false,
            videoMode: 'extend',
            sendMotionContext: false,
            showFrameSlots: false,
            keepImageOnVideoUpload: false,
        };
    }
    // Scene chaining (MiniMax H3 Motion Context): an armed previous clip seeds
    // the new shot's opening frames AND room tone. It REPLACES the start frame
    // — the model renders a chain head and a frame-0 pin as a union — so the
    // plan drops the image whenever a chain is armed. LTX families ignore the
    // armed state entirely (their continuation is the extend task above).
    const sendMotionContext = local && isMinimaxFamilyModel(setup)
        && !setup?.videoUrl && Boolean(String(setup?.motionContextUrl || '').trim());
    // Reference mode (MiniMax H3): attached references REPLACE the start/end
    // frames — the reference graph has no frame inputs at all — the same way an
    // armed chain replaces the start frame. Motion context still composes with
    // references (the registry accepts both). ANY reference kind arms the mode:
    // a motion clip alone is valid conditioning, and a voice clip alone is not
    // (the server refuses it) but must still route to the reference workflow to
    // be told so, rather than being silently dropped from a frame-based run.
    const referenceCount = ['referenceImageUrls', 'referenceVideos', 'referenceAudios']
        .reduce((total, key) => total + (Array.isArray(setup?.[key]) ? setup[key].filter(Boolean).length : 0), 0);
    const sendReferenceImages = local && isMinimaxFamilyModel(setup) && !setup?.videoUrl
        && referenceCount > 0;
    return {
        task,
        // Plain generation still accepts a dropped-in clip, which historically
        // meant "extend"; keep that, but as an explicit consequence of the task.
        sendVideo: Boolean(setup?.videoUrl),
        sendImage: !setup?.videoUrl && !sendMotionContext && !sendReferenceImages,
        videoMode: setup?.videoUrl ? 'extend' : null,
        sendMotionContext,
        sendReferenceImages,
        // Start/Middle/End keyframes are an LTX-graph capability. Other
        // families (H3) map a single start image, so they get the plain
        // start-frame picker instead of the three-slot control.
        showFrameSlots: local && isLtxFamilyModel(setup) && !setup?.videoUrl,
        keepImageOnVideoUpload: false,
    };
}
