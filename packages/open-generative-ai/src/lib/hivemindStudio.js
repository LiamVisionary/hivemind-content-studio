import { decryptMedia } from './e2eVault.js';
import { deviceRequesterHeaders } from './deviceIdentity.js';
import { ensureVaultReady } from './vaultSession.js';
import {
    hivemindVideoModelId,
    isHivemindVideoModelId,
    workflowIdFromHivemindModelId,
} from './hivemindModelIds.js';
import { isMinimaxFamilyModel } from './videoTasks.js';
import { isSoundOnlyReference, referenceVideoCanvas } from './h3References.js';

// Re-exported so the id format keeps one import path for existing callers.
export { isHivemindVideoModelId, workflowIdFromHivemindModelId };

const VIDEO_SELECTION_KEY = 'hivemind.explore.videoSelection';
const OPTIONS_KEY = 'hivemind.explore.options';
const PENDING_JOBS_KEY = 'muapi_pending_jobs';
const MEDIA_STUDIO_REFERENCE_PREFIX = '/api/media-studio/references/';

let contextPromise = null;
let contextCache = null;
let contextRequest = 0;
let hiveVideoModels = [];
const uploadedFiles = new Map();

const qs = () => new URLSearchParams(window.location.search);

export function isHivemindStudioEnabled() {
    // True when served by the Hivemind Content Studio server (which injects
    // the marker into index.html), or when explicitly flagged via URL — the
    // old hub-iframe convention, kept for /open-gen/ links and the desktop shell.
    return window.__HIVEMIND_STUDIO__ === 1 || qs().get('hivemindStudio') === '1';
}

function scrubLegacyPersistentCreativeState() {
    if (!isHivemindStudioEnabled()) return;
    try { localStorage.removeItem('muapi_history'); } catch {}
    try { localStorage.removeItem('video_history'); } catch {}
    try { localStorage.removeItem(PENDING_JOBS_KEY); } catch {}
}

export function loadStudioGenerationHistory(storageKey) {
    if (isHivemindStudioEnabled()) {
        scrubLegacyPersistentCreativeState();
        return [];
    }
    try {
        const parsed = JSON.parse(localStorage.getItem(storageKey) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function saveStudioGenerationHistory(storageKey, entries, limit) {
    if (isHivemindStudioEnabled()) {
        scrubLegacyPersistentCreativeState();
        return;
    }
    try {
        localStorage.setItem(storageKey, JSON.stringify(entries.slice(0, limit)));
    } catch {}
}

export function clearHivemindStudioPrivateState() {
    scrubLegacyPersistentCreativeState();
    void import('./composerState.js').then((mod) => mod.clearComposerStateCache()).catch(() => {});
    try { sessionStorage.removeItem(PENDING_JOBS_KEY); } catch {}
    try { sessionStorage.removeItem(VIDEO_SELECTION_KEY); } catch {}
    try { sessionStorage.removeItem(OPTIONS_KEY); } catch {}
    for (const url of uploadedFiles.keys()) URL.revokeObjectURL(url);
    uploadedFiles.clear();
    contextPromise = null;
    contextCache = null;
    contextRequest += 1;
    hiveVideoModels = [];
}

function defaultContext() {
    // videoRegistryLive true: there is nothing to retry when the hivemind studio
    // is switched off, and a false here would put callers in a retry loop.
    return { catalog: null, prompts: [], videoModels: [], videoRegistryLive: true };
}

function workflowProvider(catalog) {
    return catalog?.media?.video?.find((provider) => provider.id === 'media-studio-mcp') || null;
}

export function getHivemindVideoModelById(id) {
    return hiveVideoModels.find((model) => model.id === id) || null;
}

// The reference-mode sibling for a model: the workflow in the same registry
// family that accepts reference_images (minimax-h3-reference for the H3 tiers).
// A model that itself takes references is its own sibling. Null when the family
// has no reference lane — the composer hides the character-reference control.
// A routing-only workflow is never a tier the user picks — the studio sends a
// run there when references are attached to the family's normal tier. Landing
// ON one strands you: its graph has no frame inputs, so the Frames control
// vanishes, and it refuses to run at all without a reference. Anything holding
// such an id (a restored preference, a "Load in Studio" of a past reference
// run) is mapped back to the family's real tier.
export function selectableHivemindModelId(id) {
    const model = getHivemindVideoModelById(id);
    if (!model?.routingOnly) return id;
    const family = String(model.workflowFamily || '').toLowerCase();
    const siblings = hiveVideoModels.filter((entry) => !entry.routingOnly
        && String(entry.workflowFamily || '').toLowerCase() === family);
    // The plain tier over the experimental ones — turbo is a preview distill.
    return (siblings.find((entry) => !entry.beta) || siblings[0])?.id || id;
}

export function referenceWorkflowForHivemindModel(id) {
    const model = getHivemindVideoModelById(id);
    if (!model) return null;
    if (model.supportsReferenceImages) return model;
    const family = String(model.workflowFamily || '').toLowerCase();
    if (!family) return null;
    return hiveVideoModels.find((entry) => entry.supportsReferenceImages
        && String(entry.workflowFamily || '').toLowerCase() === family) || null;
}

export function mapHivemindWorkflowModels(catalog) {
    const provider = workflowProvider(catalog);
    if (!provider?.models?.length) return [];
    return provider.models.map((workflow) => ({
        ...(() => {
            const accepts = Array.isArray(workflow.accepts) ? workflow.accepts : [];
            return {
                accepts,
                supportsVideoInput: accepts.some((field) => String(field).startsWith('video_')),
                videoModes: accepts.includes('video_mode') ? ['extend'] : [],
                supportsLoras: Boolean(workflow.supports_loras),
                compatibleBaseModels: Array.isArray(workflow.compatible_base_models) ? workflow.compatible_base_models : [],
                supportsIngredientImages: accepts.includes('ingredient_images'),
                // The H3 checkpoint is the fl2va build and its node takes an
                // optional last_frame, so a workflow declaring end_image_* can
                // end on a supplied frame (FL2VA), or start from one (L2VA).
                supportsEndFrame: accepts.includes('end_image_base64') || accepts.includes('end_image_path'),
                // Scene chaining (MiniMax H3 Motion Context): a finished clip
                // can seed the next shot's opening frames + room tone. Distinct
                // from supportsVideoInput on purpose — video_* means the LTX
                // extend/head-swap lane and flips that UI.
                supportsMotionContext: accepts.includes('motion_context_base64'),
                // MiniMax H3 Reference mode: discrete character/subject pictures
                // (up to 9, order-preserving) instead of a start frame. Distinct
                // from ingredient_images, which LTX stitches into one sheet.
                supportsReferenceImages: accepts.includes('reference_images'),
                // Spectrum forecasting is a per-workflow capability: the registry
                // lists it in `accepts` only for graphs that carry the node, so
                // the toggle appears exactly where it does something.
                supportsSpectrum: accepts.includes('spectrum'),
                // Fast high-res (H3's two-pass latent upscale) is registry-gated
                // the same way: the graph needs a latent upscaler node on the
                // lane, so the switch appears only where the registry says the
                // workflow can compile it.
                supportsFastHighRes: accepts.includes('fast_high_res'),
                // The refinement (sampling steps) control needs a registry-mapped
                // steps slot AND a full-step lane. A distilled turbo build
                // registers 4-8 steps, where a 32-step "high detail" override
                // would fight the distillation (community consensus: past ~8 steps
                // a turbo LoRA over-sharpens), so it gets no control.
                supportsQualitySteps: accepts.includes('steps')
                    && Number(workflow.default_steps) >= 10,
                // Kept in this list so reference routing can still resolve it,
                // but filtered out of the picker by the studio.
                routingOnly: Boolean(workflow.routing_only),
                // How many of each kind the graph actually wired, read off the
                // registry so the References panel can never offer a slot that
                // does not exist. Absent on workflows without reference slots.
                referenceSlots: workflow.reference_slots && typeof workflow.reference_slots === 'object'
                    ? {
                        images: Number(workflow.reference_slots.images) || 0,
                        videos: Number(workflow.reference_slots.videos) || 0,
                        audios: Number(workflow.reference_slots.audios) || 0,
                    }
                    : null,
                ingredientInputs: workflow.ingredient_inputs && typeof workflow.ingredient_inputs === 'object'
                    ? workflow.ingredient_inputs
                    : null,
            };
        })(),
        id: hivemindVideoModelId(workflow.id),
        workflowId: workflow.id,
        // Models shipping both a distilled and a full-step build share a
        // tierGroup; the picker collapses them into one row with a switch.
        tierGroup: workflow.tier_group || null,
        tier: workflow.tier || null,
        beta: Boolean(workflow.beta),
        name: workflow.label || workflow.id,
        description: `${provider.label || 'Media Studio'} workflow`,
        type: 'video',
        family: 'hivemind-media-studio',
        // Registry family (ltx-2.3 / ltx / minimax): drives which controls
        // apply. `family` above is the display/provider grouping.
        workflowFamily: String(workflow.family || ''),
        provider: 'hivemind-media-studio',
        needsImage: !Array.isArray(workflow.accepts) || !workflow.accepts.some((field) => String(field).startsWith('video_')),
        ready: Boolean(provider.available),
        detail: provider.detail || '',
        aspectRatios: Array.isArray(workflow.aspect_ratios) && workflow.aspect_ratios.length
            ? workflow.aspect_ratios
            : ['16:9', '9:16', '1:1', '4:3', '3:4'],
        // MiniMax H3 runs its 17k+5 frame grid out to ~15s and holds a scene
        // together for the whole span, so its ceiling is 15; everything else
        // keeps the 10s list. Past 15s H3 visibly loses subject identity
        // (hair/wardrobe morphs), which is why the studio does not offer more.
        durations: isMinimaxFamilyModel({ workflowFamily: workflow.family })
            ? Array.from({ length: 15 }, (_, second) => second + 1)
            : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        defaultDuration: Number(workflow.default_duration_seconds) || 4,
        // Longest clip each canvas can render with a MOTION reference attached,
        // keyed "<tier>|<aspect>". A reference video is trimmed to the clip's
        // own length, so it costs more the longer the clip is — 36x per frame
        // against a still — which collapses H3's honest 15s range to under 6s.
        // Null for workflows with no measured budget: unmeasured is not the
        // same as impossible, so those keep the full range.
        motionReferenceMaxSeconds: workflow.motion_reference_max_seconds && typeof workflow.motion_reference_max_seconds === 'object'
            ? workflow.motion_reference_max_seconds
            : null,
        // The inputs behind that ceiling — budget, frame lattice, rows per
        // canvas, full vs compact reference rows, audio row rate — so the
        // picker can price the run ACTUALLY being sent (compact staging, a
        // trimmed clip, fewer pictures, no soundtrack) instead of the
        // pessimistic per-canvas worst case. Null without a measured budget.
        motionReferencePricing: workflow.motion_reference_pricing && typeof workflow.motion_reference_pricing === 'object'
            ? workflow.motion_reference_pricing
            : null,
        // Registered sampling-step default — distinguishes a full-step lane
        // (H3's 15) from a distilled turbo build (4-8), and labels the studio's
        // step presets truthfully.
        defaultSteps: Number(workflow.default_steps) > 0 ? Number(workflow.default_steps) : null,
        tags: ['video', 'workflow', 'local'],
    }));
}

export async function loadHivemindStudioContext({ refresh = false } = {}) {
    if (!isHivemindStudioEnabled()) return defaultContext();
    if (contextCache && !refresh) return contextCache;
    if (!contextPromise || refresh) {
        const request = ++contextRequest;
        contextPromise = Promise.all([
            fetch('/api/simple/catalog', { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.ok ? r.json() : null).catch(() => null),
            fetch('/api/simple/prompts?favorites=true&limit=40', { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.ok ? r.json() : null).catch(() => null),
        ]).then(([catalog, promptPayload]) => {
            const normalizedCatalog = catalog?.ok ? catalog : null;
            const catalogForContext = normalizedCatalog || contextCache?.catalog || null;
            const discoveredModels = mapHivemindWorkflowModels(catalogForContext);
            const provider = workflowProvider(catalogForContext);
            const candidate = {
                catalog: catalogForContext,
                prompts: Array.isArray(promptPayload?.prompts) ? promptPayload.prompts : (contextCache?.prompts || []),
                videoModels: discoveredModels.length ? discoveredModels : hiveVideoModels,
                // The server could not read the workflow registry live, so the
                // capability fields on these models are a guess. The list is
                // still FULL — the fallback names the same models — which is why
                // callers cannot detect this by counting. Absent on older
                // payloads, which predate the flag and were always live.
                videoRegistryLive: !catalogForContext || provider?.registry_live !== false,
            };
            if (request !== contextRequest) return contextCache || candidate;
            hiveVideoModels = candidate.videoModels;
            contextCache = candidate;
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                window.dispatchEvent(new CustomEvent('hivemind-context-updated', {
                    detail: { context: contextCache },
                }));
            }
            return contextCache;
        });
    }
    return contextPromise;
}

export async function uploadFileToHivemindStudio(file) {
    const form = new FormData();
    form.append('file', file, file.name || 'reference-image');
    const response = await fetch('/api/media-studio/references', {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false || !data.url) {
        throw new Error(data.detail || data.error || `Reference upload failed with HTTP ${response.status}`);
    }
    const posterUrl = data.poster_url ? String(data.poster_url) : null;
    return {
        url: data.url,
        path: data.url,
        // The server builds a poster while the plaintext is still in hand, so a
        // freshly uploaded clip draws its tile without decrypting the original.
        posterUrl,
        thumbnail: posterUrl || data.url,
        encryptedAtRest: Boolean(data.encrypted_at_rest),
    };
}

/**
 * Hand back a poster for a reference sealed before posters existed.
 *
 * The host cannot build one for those: it has no vault key, so it cannot read
 * them. The browser decrypts the clip to display it anyway, so it is the only
 * party that can produce the frame — it sends that one frame back, sealed on
 * arrival like any other reference. Best-effort: a failure just means the next
 * render decodes locally again.
 */
export async function backfillHivemindReferencePoster(referenceUrl, jpegBlob) {
    if (!isHivemindStudioEnabled() || !referenceUrl || !jpegBlob) return null;
    const path = mediaStudioReferencePath(referenceUrl);
    if (!path) return null;
    try {
        const form = new FormData();
        form.append('file', jpegBlob, 'poster.jpg');
        const response = await fetch(`${path}/poster`, {
            method: 'POST',
            credentials: 'same-origin',
            body: form,
        });
        if (!response.ok) return null;
        const data = await response.json().catch(() => ({}));
        return data.poster_url ? String(data.poster_url) : null;
    } catch {
        return null;
    }
}

export function mediaStudioReferencePath(value) {
    const source = String(value || '').trim();
    if (!source) return null;
    const normalizeReferencePath = (path) => {
        if (!path.startsWith(MEDIA_STUDIO_REFERENCE_PREFIX)) return null;
        const encodedName = path.slice(MEDIA_STUDIO_REFERENCE_PREFIX.length);
        if (!encodedName || encodedName.includes('/') || path.includes('?') || path.includes('#')) return null;
        try {
            const name = decodeURIComponent(encodedName);
            return name && name === name.split('/').pop() ? path : null;
        } catch {
            return null;
        }
    };
    if (source.startsWith(MEDIA_STUDIO_REFERENCE_PREFIX)) return normalizeReferencePath(source);
    if (typeof window === 'undefined') return null;
    try {
        const parsed = new URL(source, window.location.origin);
        return parsed.origin === window.location.origin && !parsed.search && !parsed.hash
            ? normalizeReferencePath(parsed.pathname)
            : null;
    } catch {
        return null;
    }
}

export async function deleteHivemindStudioUpload(value) {
    const reference = mediaStudioReferencePath(value);
    if (!reference) return false;
    const response = await fetch(reference, { method: 'DELETE', credentials: 'same-origin' });
    if (!response.ok && response.status !== 404) {
        throw new Error(`Reference deletion failed with HTTP ${response.status}`);
    }
    return true;
}

// List the owner's saved reference uploads (server-side, sealed to the vault) so
// past uploads reappear in the picker even when the browser's composer state is
// empty. Returns upload-history-shaped entries; each uploadedUrl points at the
// E2E envelope route, so the picker's Thumb decrypts it in-browser — this host
// never decrypts. Empty outside studio mode or when the endpoint is unavailable.
// Saved owner references. `kind` filters them by medium — a voice clip or a
// motion clip has no business in the picture grid, where its thumbnail would
// never resolve. Older servers omit the field, so an entry without one is
// treated as a picture (which is all this route used to hold).
export async function fetchHivemindReferences({ kind = 'image' } = {}) {
    if (!isHivemindStudioEnabled()) return [];
    try {
        const response = await fetch('/api/media-studio/references', { credentials: 'same-origin' });
        if (!response.ok) return [];
        const data = await response.json().catch(() => ({}));
        const references = Array.isArray(data.references) ? data.references : [];
        return references
            .filter((ref) => ref && ref.url)
            .filter((ref) => !kind || String(ref.kind || 'image') === kind)
            .map((ref) => ({
                id: String(ref.name || ref.url),
                name: String(ref.name || ''),
                kind: String(ref.kind || 'image'),
                uploadedUrl: String(ref.url),
                // A sealed few-KB poster. Without one, drawing a 32px tile means
                // fetching and decrypting the WHOLE asset — 62 MB for a screen
                // recording — which is what made this panel take seconds to fill.
                // Null for references sealed before posters existed; the browser
                // decrypts those once and backfills a poster for next time.
                posterUrl: ref.poster_url ? String(ref.poster_url) : null,
                thumbnail: ref.poster_url ? String(ref.poster_url) : null,
                timestamp: typeof ref.timestamp === 'number' ? new Date(ref.timestamp * 1000).toISOString() : '',
                serverReference: true,
            }));
    } catch {
        return [];
    }
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('Could not read image file'));
        reader.readAsDataURL(blob);
    });
}

export async function mediaSourceToDataUrl(source, kind) {
    if (!source) return null;
    if (String(source).startsWith(`data:${kind}/`)) return source;
    const remembered = uploadedFiles.get(source);
    if (remembered) return blobToDataUrl(remembered);
    // A saved reference is sealed to the owner vault. Fetch the source directly and,
    // if it is a client-only E2E envelope, decrypt it in-browser and re-send inline
    // as base64 (the server holds no key). We do NOT route this through
    // resolveMediaSrc: that helper is fail-OPEN, so on any hiccup it hands back the
    // raw reference URL — whose bytes are the ciphertext envelope, not an image —
    // and we would upload that as image_base64. The server then rejects a non-image
    // data URL, which the user sees as "did not return a job id: MediaStudioError".
    const response = await fetch(source, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not read the selected ${kind}.`);
    const contentType = response.headers.get('Content-Type') || '';
    if (response.headers.get('X-E2E-Media') === '1' || contentType.includes('hivemind.e2e')) {
        if (!(await ensureVaultReady())) throw new Error(`Unlock the studio to reuse the selected ${kind}.`);
        const envelope = await response.json();
        const bytes = await decryptMedia(envelope.ciphertext, envelope.wrapped_dek);
        return blobToDataUrl(new Blob([bytes], { type: envelope.media_type || `${kind}/png` }));
    }
    return blobToDataUrl(await response.blob());
}

// Turn a picked reference into the request fields a LOCAL image workflow takes.
// A reference chosen from the saved list is a same-origin path to an owner-sealed
// envelope — this host has no key, so its bytes must be decrypted in-browser and
// sent inline, exactly as the video path does. A past cloud upload is an absolute
// URL the bridge can fetch itself, so it stays a URL (its bytes are not sealed,
// and fetching it here would be a cross-origin read the browser blocks).
export async function referenceToLocalImageInput(source) {
    const value = String(source || '').trim();
    if (!value) return {};
    if (value.startsWith('data:')) return { image_base64: value };
    if (/^https?:\/\//i.test(value)) return { image_url: value };
    return { image_base64: await mediaSourceToDataUrl(value, 'image') };
}

export function getHivemindStudioOptions() {
    try {
        return { promptHelper: true, passthrough: false, walkthrough: false, ...JSON.parse(sessionStorage.getItem(OPTIONS_KEY) || '{}') };
    } catch {
        return { promptHelper: true, passthrough: false, walkthrough: false };
    }
}

function saveHivemindStudioOptions(options) {
    sessionStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
}

export function getSavedHivemindVideoSelection() {
    try {
        return JSON.parse(sessionStorage.getItem(VIDEO_SELECTION_KEY) || 'null');
    } catch {
        return null;
    }
}

function saveHivemindVideoSelection(selection) {
    sessionStorage.setItem(VIDEO_SELECTION_KEY, JSON.stringify(selection));
}

async function ingredientImagesToRequest(items) {
    // References are always sent as inline base64: they are sealed to the owner
    // vault at rest, so the server cannot decrypt a reference path — the browser
    // decrypts each envelope (mediaSourceToDataUrl) and re-sends the bytes.
    return Promise.all((Array.isArray(items) ? items : [])
        .slice(0, 12)
        .map(async (item) => {
            const source = item?.image || item?.image_url || item?.url;
            return {
                image_base64: item?.image_base64 || await mediaSourceToDataUrl(source, 'image'),
                ...(String(item?.description || '').trim() ? { description: String(item.description).trim() } : {}),
            };
        }));
}

export async function previewHivemindIngredientSheet(items, { aspectRatio = '16:9' } = {}) {
    const ingredientImages = await ingredientImagesToRequest(items);
    if (!ingredientImages.length) throw new Error('Add at least one ingredient reference.');
    const response = await fetch('/api/media-studio/ingredients/preview', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ingredient_images: ingredientImages, aspect_ratio: aspectRatio }),
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || data.error || `Ingredients preview failed with HTTP ${response.status}`);
    }
    return {
        blob: await response.blob(),
        columns: Number(response.headers?.get?.('X-Ingredients-Columns')) || null,
        rows: Number(response.headers?.get?.('X-Ingredients-Rows')) || null,
        sourceCount: Number(response.headers?.get?.('X-Ingredients-Sources')) || ingredientImages.length,
        width: Number(response.headers?.get?.('X-Ingredients-Width')) || null,
        height: Number(response.headers?.get?.('X-Ingredients-Height')) || null,
    };
}

export async function generateHivemindVideo(params) {
    // References (image + video) are sealed to the owner vault at rest, so they
    // are always decrypted in-browser and re-sent inline as base64 — the server
    // holds no key to stage a reference path.
    const videoSource = params.video || params.video_url;
    const videoBase64 = params.video_base64 || await mediaSourceToDataUrl(videoSource, 'video');
    const imageSource = params.image || params.image_url;
    // Derived from the TASK, not from "is there a video". This line used to read
    // `videoBase64 ? null : …`, which discarded the face image before the request
    // body was even assembled — so head swap always reached the server with no
    // face and failed claiming one was never supplied.
    const videoExcludesImage = Boolean(videoBase64) && (params.task || 'generate') !== 'head-swap';
    const imageBase64 = videoExcludesImage
        ? null
        : (params.image_base64 || await mediaSourceToDataUrl(imageSource, 'image'));
    // LTX 2.3 first/middle/end keyframes. Like the start frame, a saved reference
    // is sealed to the owner vault, so it is decrypted in-browser and re-sent
    // inline as base64. Middle/end anchors only apply to image-driven generation.
    const middleSource = params.middleImage || params.middle_image_url;
    const endSource = params.endImage || params.end_image_url;
    const middleBase64 = (videoBase64 || !middleSource)
        ? null
        : (params.middle_image_base64 || await mediaSourceToDataUrl(middleSource, 'image'));
    const endBase64 = (videoBase64 || !endSource)
        ? null
        : (params.end_image_base64 || await mediaSourceToDataUrl(endSource, 'image'));
    // Scene chaining (MiniMax H3): the previous clip is a sealed OUTPUT, so it
    // is decrypted in-browser like any reference and re-sent inline. It rides
    // its own field — video_base64 means the LTX extend/head-swap lane.
    const motionContextSource = params.motionContext || params.motion_context_url;
    const motionContextBase64 = params.motion_context_base64
        || await mediaSourceToDataUrl(motionContextSource, 'video');
    const ingredientImages = await ingredientImagesToRequest(params.ingredientImages);
    // MiniMax H3 Reference mode: discrete pictures, order-preserving (<Picture N>
    // is the Nth entry). Sealed refs decrypt in-browser and re-send inline, same
    // as every other reference — the server holds no key to stage a path.
    const referenceImages = await Promise.all((Array.isArray(params.referenceImages) ? params.referenceImages : [])
        .filter(Boolean)
        .map(async (source) => ({ image_base64: await mediaSourceToDataUrl(source, 'image') })));
    // The other two reference kinds ride the same inline path: a voice clip
    // becomes <Audio N>, a motion clip becomes <Video N>, and use_audio decides
    // whether that clip's own soundtrack is conditioned in too.
    const referenceVideoRows = (Array.isArray(params.referenceVideos) ? params.referenceVideos : [])
        .map((item) => (typeof item === 'string' ? { url: item } : item))
        .filter((item) => item?.url);
    // A motion row switched to SOUND ONLY travels as a voice clip — in
    // reference_audios, after the explicit ones, which is the order the model
    // numbers <Audio N> and the order referenceLabels shows. The MCP extracts
    // the soundtrack; the clip's pixels are never staged for the lane.
    const referenceAudios = await Promise.all([
        ...(Array.isArray(params.referenceAudios) ? params.referenceAudios : [])
            .map((item) => (typeof item === 'string' ? { url: item } : item))
            .filter((item) => item?.url)
            .map(async (item) => ({ audio_base64: await mediaSourceToDataUrl(item.url, 'audio') })),
        ...referenceVideoRows
            .filter((item) => isSoundOnlyReference(item))
            .map(async (item) => ({
                audio_base64: await mediaSourceToDataUrl(item.url, 'video'),
                ...(Number(item.durationSeconds) > 0 ? { duration_seconds: Number(item.durationSeconds) } : {}),
            })),
    ]);
    const referenceVideos = await Promise.all(referenceVideoRows
        .filter((item) => !isSoundOnlyReference(item))
        .map(async (item) => ({
            video_base64: await mediaSourceToDataUrl(item.url, 'video'),
            use_audio: Boolean(item.useAudio),
            // How the clip is staged for the node: "compact" (a 384x1152 box,
            // about a third of the rows and half the step time, the same
            // motion) when the row switched it on, "full" otherwise — and
            // always full while no picture is attached, because then the clip
            // is the character reference and identity needs pixels. The rule
            // lives in referenceVideoCanvas so the panel's switch and what is
            // sent can never disagree.
            canvas: referenceVideoCanvas(item, { images: referenceImages }),
            // The clip's own length, so the gateway can refuse an over-budget
            // run before it stages anything. A reference is trimmed to
            // min(its own length, the clip's), so this is what decides the
            // cost. Omitted when unmeasured, which the gateway reads as "long"
            // and re-checks against the real file after staging either way.
            ...(Number(item.durationSeconds) > 0
                ? { duration_seconds: Number(item.durationSeconds) }
                : {}),
        })));
    // LTX 2.3 supports text-to-video: a prompt alone is enough. Only a completely
    // empty request (no prompt and no media) is rejected.
    if (!videoBase64 && !imageBase64 && !ingredientImages.length && !referenceImages.length
        && !referenceVideos.length && !String(params.prompt || '').trim()) {
        throw new Error('Enter a prompt, or add a start image or source video.');
    }
    const rawWorkflowId = params.workflow_id || workflowIdFromHivemindModelId(params.model);
    // "workflow-default" is a catalog placeholder meaning "use the server's default
    // workflow", not a real workflow id. Sending it verbatim makes the MCP reject
    // the job ("unknown video workflow_id: workflow-default"), which the redaction
    // hides as a generic MediaStudioError. Send empty so the server picks its default.
    const workflowId = rawWorkflowId === 'workflow-default' ? '' : rawWorkflowId;
    const requestBody = JSON.stringify({
        prompt: params.prompt || '',
        workflow_id: workflowId,
        ...(String(params.studio_lane || '').trim()
            ? { studio_lane: String(params.studio_lane).trim().slice(0, 512) }
            : {}),
        // The tab's "Run on" pin: the rented machine this job runs on when it
        // serves the workflow (tried ahead of the gateway's default order).
        ...(String(params.run_on || '').trim()
            ? { run_on: String(params.run_on).trim().slice(0, 128) }
            : {}),
        ...(String(params.referenceDescription || '').trim()
            ? { reference_description: String(params.referenceDescription).trim() }
            : {}),
        ...(ingredientImages.length ? { ingredient_images: ingredientImages } : {}),
        ...(referenceImages.length ? { reference_images: referenceImages } : {}),
        ...(referenceAudios.length ? { reference_audios: referenceAudios } : {}),
        ...(referenceVideos.length ? { reference_videos: referenceVideos } : {}),
        // `task` was decided once in videoTasks.js and is forwarded verbatim.
        // This layer attaches whatever media it was handed and states the task;
        // it does NOT re-infer the job from which media are present, which is the
        // mistake that made every attached video mean "extend".
        task: params.task || 'generate',
        ...(videoBase64 ? { video_base64: videoBase64 } : {}),
        ...(imageBase64 ? { image_base64: imageBase64 } : {}),
        ...(motionContextBase64 ? { motion_context_base64: motionContextBase64 } : {}),
        ...(params.video_mode ? { video_mode: params.video_mode } : {}),
        ...(middleBase64 ? { middle_image_base64: middleBase64 } : {}),
        ...(endBase64 ? { end_image_base64: endBase64 } : {}),
        duration_seconds: params.duration || params.duration_seconds || 4,
        aspect_ratio: params.aspect_ratio || '',
        ...(String(params.resolution || '').trim()
            ? { resolution: String(params.resolution).trim().toLowerCase() }
            : {}),
        // A concrete seed makes each run differ; omit for the runner's default.
        ...(Number.isFinite(params.seed) && params.seed >= 0 ? { seed: Math.floor(params.seed) } : {}),
        ...(params.denoise === 'light' || params.denoise === 'strong' ? { denoise: params.denoise } : {}),
        // Negative prompt rides the encrypted request like the positive one. On
        // the distilled lanes the runner applies it through NAG, since those run
        // cfg=1 where a CFG negative prompt has no effect.
        ...(String(params.negative_prompt || '').trim() ? { negative_prompt: String(params.negative_prompt).trim() } : {}),
        ...(Number.isFinite(Number(params.nag_scale)) ? { nag_scale: Number(params.nag_scale) } : {}),
        // The BFS adapter is attached by the head-swap task server-side; this is
        // the operator's one knob on it.
        ...(Number.isFinite(Number(params.head_swap_lora_strength))
            ? { head_swap_lora_strength: Number(params.head_swap_lora_strength) } : {}),
        ...(params.head_swap_backend ? { head_swap_backend: String(params.head_swap_backend) } : {}),
        ...(params.head_swap_face_enhancer ? { head_swap_face_enhancer: true } : {}),
        // Tri-state: only send an explicit choice, so leaving the toggle alone
        // keeps whatever the registered workflow ships with.
        ...(typeof params.spectrum === 'boolean' ? { spectrum: params.spectrum } : {}),
        ...(typeof params.fast_high_res === 'boolean' ? { fast_high_res: params.fast_high_res } : {}),
        // Sampling-steps override (H3 refinement). Omitted = workflow default.
        ...(Number.isFinite(Number(params.steps)) && Number(params.steps) > 0
            ? { steps: Math.round(Number(params.steps)) }
            : {}),
        ...(Array.isArray(params.loras) && params.loras.length ? { loras: params.loras } : {}),
    });
    // Present this device's key on the submit: the gateway seals the finished
    // media to whoever asked for it, so without this the clip is sealed to
    // whichever server process relayed the request and this browser can never
    // open its own generation.
    const requesterHeaders = await deviceRequesterHeaders();
    const postJson = async (path) => {
        const response = await fetch(path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', ...requesterHeaders },
            body: requestBody,
        });
        const data = await response.json().catch(() => ({}));
        return { response, data };
    };
    const finished = (data) => ({ ...data, id: data.job_id || data.id, url: data.url || data.media_url || data.output_url });

    // Job-based flow: high-resolution runs take tens of minutes — far beyond
    // what one blocking HTTP request survives — so start the job, then poll.
    const start = await postJson('/api/media-studio/video/start');
    if (start.response.status === 404 || start.response.status === 405) {
        // Older studio API without the start route: single blocking request.
        const legacy = await postJson('/api/media-studio/video');
        if (!legacy.response.ok || legacy.data.ok === false) {
            throw new Error(legacy.data.detail || legacy.data.error || `Media Studio generation failed with HTTP ${legacy.response.status}`);
        }
        return finished(legacy.data);
    }
    if (!start.response.ok || start.data.ok === false || !start.data.job_id) {
        throw new Error(start.data.detail || start.data.error || `Media Studio generation failed with HTTP ${start.response.status}`);
    }
    // A server that already finished synchronously answers with the media URL.
    if (start.data.url || start.data.media_url || start.data.output_url) return finished(start.data);
    const jobId = String(start.data.job_id);
    // Surface the job id so the studio can persist it (sessionStorage) and resume
    // polling after a tab switch / reload — a long local render must not be lost
    // just because the studio component remounts.
    if (typeof params.onJobId === 'function') params.onJobId(jobId);
    // Seed the expected-duration estimate (from historical timings) so the bar can
    // show elapsed / ~expected immediately, before the first status poll lands.
    const estimateSeconds = Number(start.data.estimate_seconds) || null;
    if (typeof params.onProgress === 'function' && estimateSeconds) {
        params.onProgress({ progress: null, estimateSeconds });
    }
    return pollHivemindVideoJob(jobId, { onProgress: params.onProgress, estimateSeconds, signal: params.signal });
}

// Best-effort cancel of a started Media Studio video job: tells the server to stop
// finalizing/polling it and to forward an interrupt to whichever backend is running
// it. Always resolves (never throws) — the studio resets its local generation state
// regardless, so a job that already finished or vanished still unblocks the UI.
export async function cancelHivemindVideoJob(jobId) {
    if (!jobId) return { ok: false, reason: 'no-job-id' };
    try {
        const response = await fetch(`/api/media-studio/video/job/${encodeURIComponent(String(jobId))}/cancel`, {
            method: 'POST',
            credentials: 'same-origin',
        });
        return await response.json().catch(() => ({ ok: response.ok }));
    } catch (error) {
        return { ok: false, reason: String(error?.message || error) };
    }
}

// Poll an already-started Media Studio video job to completion. Shared by the
// initial generation (above) and the mount-time resume path in VideoStudio, so a
// generation survives the studio remounting mid-render. Resolves to the same
// { id, url, ... } shape as generateHivemindVideo.
export async function pollHivemindVideoJob(jobId, { onProgress, estimateSeconds = null, signal = null } = {}) {
    const id = String(jobId);
    let estimate = Number(estimateSeconds) || null;
    const cancelled = () => Object.assign(new Error('Generation cancelled'), { cancelled: true });
    const done = (payload) => ({
        ...payload,
        id: payload.job_id || payload.id || id,
        url: payload.url || payload.media_url || payload.output_url,
    });
    const deadline = Date.now() + 90 * 60 * 1000;
    let missing = 0;
    while (Date.now() < deadline) {
        if (signal?.aborted) throw cancelled();
        // 2s poll: the bar is smoothed client-side between polls, so this only needs
        // to keep real progress / estimate / completion reasonably fresh.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (signal?.aborted) throw cancelled();
        let payload;
        try {
            const response = await fetch(`/api/media-studio/video/job/${encodeURIComponent(id)}`, { credentials: 'same-origin', ...(signal ? { signal } : {}) });
            if (response.status === 404) {
                // The studio API restarted and lost the job registry. The
                // gateway job itself keeps running and lands in History.
                missing += 1;
                if (missing >= 3) throw new Error('The studio restarted mid-generation. The finished video will appear in the History tab.');
                continue;
            }
            missing = 0;
            payload = await response.json().catch(() => ({}));
        } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw cancelled();
            if (missing >= 3) throw error;
            continue; // transient network blip — the job survives server-side
        }
        if (payload.status === 'error' || payload.ok === false) {
            throw new Error(payload.detail || payload.error || 'Media Studio reported a failed generation');
        }
        if (payload.status === 'running') {
            estimate = Number(payload.estimate_seconds) || estimate;
            if (typeof onProgress === 'function') {
                onProgress({
                    progress: typeof payload.progress === 'number' ? payload.progress : null,
                    estimateSeconds: estimate,
                    elapsedSeconds: Number(payload.elapsed_seconds) || null,
                    // Present only when the backend reports real sampler
                    // counters (a rented lane does); absent on paths where the
                    // bar is still a time estimate, so the label never implies
                    // a precision we do not have.
                    step: Number(payload.progress_step) || null,
                    stepTotal: Number(payload.progress_total) || null,
                });
            }
            continue;
        }
        if (payload.ok && (payload.url || payload.media_url || payload.output_url)) return done(payload);
    }
    throw new Error('Media Studio generation timed out. If it finishes later, the video will appear in the History tab.');
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[char]));
}

function insertIntoPrompt(text) {
    const active = document.activeElement;
    const target = active?.tagName === 'TEXTAREA' && !active.disabled
        ? active
        : document.querySelector('#content-area textarea:not([disabled])') || document.querySelector('textarea:not([disabled])');
    if (!target) return false;
    const current = target.value.trim();
    target.value = current ? `${target.value.replace(/\s+$/, '')}\n${text}` : text;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.focus();
    target.setSelectionRange(target.value.length, target.value.length);
    return true;
}

function renderItems(items, kind) {
    if (!items.length) return '<p class="text-[11px] text-white/40 px-2 py-3">Nothing saved yet.</p>';
    return items.slice(0, 8).map((item) => {
        const label = kind === 'template' ? item.title : item.prompt;
        const text = kind === 'template' ? item.description : item.prompt;
        const id = kind === 'template' ? item.id : item.prompt_id;
        return `
            <button type="button" data-hive-${kind}="${escapeHtml(id)}" class="w-full text-left rounded-xl border border-white/5 bg-white/[0.03] hover:bg-white/[0.07] px-3 py-2 transition-colors">
                <span class="block text-xs font-bold text-white truncate">${escapeHtml(label)}</span>
                <span class="block text-[10px] text-white/45 truncate">${escapeHtml(text)}</span>
            </button>
        `;
    }).join('');
}

function renderDock(panel, context) {
    const templates = context.catalog?.templates || [];
    const options = getHivemindStudioOptions();
    panel.innerHTML = `
        <div class="flex items-center justify-between gap-3 border-b border-white/10 pb-3">
            <div>
                <div class="text-[10px] font-black uppercase tracking-[0.22em] text-primary">Hivemind</div>
                <div class="text-sm font-black text-white">Studio tools</div>
            </div>
            <button type="button" data-hive-close class="h-8 w-8 rounded-lg bg-white/5 text-white/70 hover:bg-white/10">x</button>
        </div>
        <div class="grid gap-3 pt-3">
            <label class="grid gap-1.5">
                <span class="text-[10px] font-bold uppercase tracking-widest text-white/45">Local video workflow</span>
                <select data-hive-video-workflow class="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs font-bold text-white outline-none">
                    <option value="">Choose on generate</option>
                    ${context.videoModels.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}</option>`).join('')}
                </select>
            </label>
            <div class="grid grid-cols-3 gap-2">
                <label class="flex items-center justify-between gap-2 rounded-xl border border-white/5 bg-white/[0.03] px-2 py-2 text-[10px] font-bold text-white/70"><span>Helper</span><input data-hive-option="promptHelper" type="checkbox" ${options.promptHelper ? 'checked' : ''}></label>
                <label class="flex items-center justify-between gap-2 rounded-xl border border-white/5 bg-white/[0.03] px-2 py-2 text-[10px] font-bold text-white/70"><span>Pass</span><input data-hive-option="passthrough" type="checkbox" ${options.passthrough ? 'checked' : ''}></label>
                <label class="flex items-center justify-between gap-2 rounded-xl border border-white/5 bg-white/[0.03] px-2 py-2 text-[10px] font-bold text-white/70"><span>Ask</span><input data-hive-option="walkthrough" type="checkbox" ${options.walkthrough ? 'checked' : ''}></label>
            </div>
            <details class="rounded-xl border border-white/5 bg-white/[0.03] p-2">
                <summary class="cursor-pointer text-xs font-black text-white">Templates</summary>
                <div class="mt-2 grid gap-2">${renderItems(templates, 'template')}</div>
            </details>
            <details class="rounded-xl border border-white/5 bg-white/[0.03] p-2">
                <summary class="cursor-pointer text-xs font-black text-white">Ingredients</summary>
                <div class="mt-2 grid gap-2">${renderItems(context.prompts, 'ingredient')}</div>
            </details>
        </div>
    `;
    const saved = getSavedHivemindVideoSelection();
    const select = panel.querySelector('[data-hive-video-workflow]');
    if (select && saved?.modelId) select.value = saved.modelId;
}

export function installHivemindExploreDock() {
    if (!isHivemindStudioEnabled() || document.getElementById('hivemind-explore-dock')) return;
    scrubLegacyPersistentCreativeState();
    const root = document.createElement('div');
    root.id = 'hivemind-explore-dock';
    root.className = 'fixed right-3 top-[112px] lg:top-[64px] z-[90] flex flex-col items-end gap-2';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'h-10 rounded-xl border border-white/10 bg-elevated-bg/90 px-3 text-xs font-bold text-white shadow-2xl backdrop-blur-xl transition-colors hover:border-primary/50';
    toggle.textContent = 'Hivemind';
    const panel = document.createElement('div');
    panel.className = 'hidden w-[min(21rem,calc(100vw-1.5rem))] rounded-2xl border border-white/10 bg-black/90 p-3 shadow-2xl backdrop-blur-xl';
    root.appendChild(toggle);
    root.appendChild(panel);
    document.body.appendChild(root);

    const open = async () => {
        const context = await loadHivemindStudioContext();
        renderDock(panel, context);
        panel.classList.remove('hidden');
    };
    const close = () => panel.classList.add('hidden');
    toggle.onclick = () => panel.classList.contains('hidden') ? void open() : close();

    panel.addEventListener('click', (event) => {
        const closeButton = event.target.closest('[data-hive-close]');
        if (closeButton) { close(); return; }
        const template = event.target.closest('[data-hive-template]');
        if (template) {
            const item = contextCache?.catalog?.templates?.find((candidate) => candidate.id === template.dataset.hiveTemplate);
            if (item) insertIntoPrompt(item.prompt);
            return;
        }
        const ingredient = event.target.closest('[data-hive-ingredient]');
        if (ingredient) {
            const item = contextCache?.prompts?.find((candidate) => candidate.prompt_id === ingredient.dataset.hiveIngredient);
            if (item) insertIntoPrompt(item.prompt);
        }
    });

    panel.addEventListener('change', (event) => {
        const option = event.target.closest('[data-hive-option]');
        if (option) {
            const current = getHivemindStudioOptions();
            current[option.dataset.hiveOption] = Boolean(option.checked);
            if (option.dataset.hiveOption === 'passthrough' && option.checked) current.promptHelper = false;
            if (option.dataset.hiveOption === 'promptHelper' && option.checked) current.passthrough = false;
            saveHivemindStudioOptions(current);
            renderDock(panel, contextCache || defaultContext());
            return;
        }
        const select = event.target.closest('[data-hive-video-workflow]');
        if (!select) return;
        const model = contextCache?.videoModels?.find((candidate) => candidate.id === select.value);
        if (!model) return;
        saveHivemindVideoSelection({ provider: 'media-studio-mcp', model: model.workflowId, modelId: model.id });
        window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'video' } }));
        window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent('hivemind-workflow-selected', { detail: { modelId: model.id } }));
        }, 0);
    });

    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type === 'hivemind-owner-lock') {
            clearHivemindStudioPrivateState();
            return;
        }
        if (event.data?.type === 'hivemind-explore-insert-prompt') insertIntoPrompt(event.data.text || '');
        if (event.data?.type === 'hivemind-explore-refresh') {
            void loadHivemindStudioContext({ refresh: true }).then((context) => {
                if (!panel.classList.contains('hidden')) renderDock(panel, context);
            });
        }
    });

    window.parent?.postMessage?.({ type: 'hivemind-explore-ready' }, window.location.origin);
    void loadHivemindStudioContext();
}
