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
// Lives in src/lib rather than videoLogic.jsx so the node:test suite can import
// it; that suite cannot load JSX, which is precisely why the two rules that stayed
// in the JSX file were the ones no test caught.

import { isHivemindVideoModelId } from './hivemindStudio.js';

/** Extend and head swap are LTX-GRAPH features (the extension graph and the
 *  BFS head-swap LoRA). Other families — MiniMax H3 and anything added later
 *  — can only generate, so offering those tabs there is a lie. Family comes
 *  from the workflow registry; the id prefix is the fallback for setups
 *  persisted before the field existed. */
export function isLtxFamilyModel(setup) {
    const family = String(setup?.modelFamily || '').toLowerCase();
    if (family) return family.startsWith('ltx');
    // Fallback for setups persisted before modelFamily existed. The workflow
    // id sits AFTER the provider prefix ("hivemind-media:ltx23-eros-…"), so
    // testing the raw id would never match a real selection.
    const id = String(setup?.modelId || '');
    return /^ltx/i.test(id.includes(':') ? id.slice(id.indexOf(':') + 1) : id);
}

/** MiniMax H3-family workflows get their own quality controls (15s duration
 *  ceiling, native-canvas resolution tier, refinement steps) because those
 *  tradeoffs are measured properties of THIS model, not of local video
 *  generally. Same family/id-fallback contract as isLtxFamilyModel. */
export function isMinimaxFamilyModel(setup) {
    const family = String(setup?.modelFamily || '').toLowerCase();
    if (family) return family.startsWith('minimax');
    const id = String(setup?.modelId || '');
    return /^minimax/i.test(id.includes(':') ? id.slice(id.indexOf(':') + 1) : id);
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
export function slotLabelsFor(task, zh = false) {
    if (task === 'head-swap') {
        return zh
            ? { image: '新面孔', video: '源视频', imageHint: '要换上的面孔', videoHint: '要被换脸的素材' }
            : { image: 'New face', video: 'Source video', imageHint: 'The face to swap in', videoHint: 'Footage whose face gets replaced' };
    }
    if (task === 'extend') {
        return zh
            ? { image: '起始帧', video: '要延长的视频', imageHint: '', videoHint: '在其结尾追加新画面' }
            : { image: 'Start frame', video: 'Video to extend', imageHint: '', videoHint: 'New footage is appended to its end' };
    }
    return zh
        ? { image: '起始帧', video: '参考视频', imageHint: '第一帧', videoHint: '' }
        : { image: 'Start frame', video: 'Reference video', imageHint: 'Becomes the first frame', videoHint: '' };
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
    // Reference mode (MiniMax H3): attached character/subject pictures REPLACE
    // the start/end frames — the reference graph has no frame inputs at all —
    // the same way an armed chain replaces the start frame. Motion context
    // still composes with references (the registry accepts both).
    const sendReferenceImages = local && isMinimaxFamilyModel(setup) && !setup?.videoUrl
        && (Array.isArray(setup?.referenceImageUrls) ? setup.referenceImageUrls.filter(Boolean) : []).length > 0;
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
