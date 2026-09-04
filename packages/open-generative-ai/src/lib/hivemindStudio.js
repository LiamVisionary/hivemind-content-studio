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
// Retired 2026-09-03 with the explore dock's generation-option switches. The key
// is still scrubbed on owner lock so a tab left open before the change is cleaned.
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

// Whether this machine holds MUAPI_API_KEY, as last reported by /api/muapi/status
// (modelRunner.setMuapiKeyOnServer). The browser copy of the key is only stale
// once that is true; scrubbing it earlier would break the direct route on a
// machine that has nothing else.
let muapiKeyOnServer = false;
export function markMuapiKeyOnServer(present) {
    muapiKeyOnServer = Boolean(present);
}

function scrubLegacyPersistentCreativeState() {
    if (!isHivemindStudioEnabled()) return;
    // The key itself lived here until 2026-09-03; it now lives in the machine's
    // shared store (lib/muapiKey.js migrates it) and the proxy never reads this.
    if (muapiKeyOnServer) { try { localStorage.removeItem('muapi_key'); } catch {} }
    try { localStorage.removeItem('muapi_history'); } catch {}
    try { localStorage.removeItem('video_history'); } catch {}
    // Cinema / Lip sync wrote prompts + result URLs here in the clear until 2026-08-24.
    try { localStorage.removeItem('cinema_history'); } catch {}
    try { localStorage.removeItem('lipsync_history'); } catch {}
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

// Lock must clear the bridge's private state even in a tab where the explore
// dock is not mounted: the Shell broadcasts 'hivemind-owner-lock-broadcast' and
// hubData relays 'hivemind-owner-lock' to the surfaces; the bridge itself
// listens here so the clear does not depend on which React views are alive.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('hivemind-owner-lock-broadcast', () => clearHivemindStudioPrivateState());
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

// The head-replacement sibling for a model: the workflow in the same registry
// family that rewrites an existing clip through a mask (minimax-h3-inpaint for
// the H3 tiers). Null when the family has no inpaint lane, which is what keeps
// the clip thumbnail a plain preview there instead of a door to a dialog whose
// Apply nothing would honour.
export function inpaintWorkflowForHivemindModel(id) {
    const model = getHivemindVideoModelById(id);
    if (!model) return null;
    if (model.supportsHeadReplacement) return model;
    const family = String(model.workflowFamily || '').toLowerCase();
    if (!family) return null;
    return hiveVideoModels.find((entry) => entry.supportsHeadReplacement
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
                // A start-image (frame zero) input. The timeline's Auto-continue
                // reads this on families without motion context: the next clip
                // opens on the previous clip's LAST frame, grabbed client-side,
                // so each segment stays its own file (the LTX extend graph
                // appends to the same file, which a segment strip cannot hold).
                supportsStartFrame: accepts.includes('image_base64') || accepts.includes('image_path'),
                // Scene chaining (MiniMax H3 Motion Context): a finished clip
                // can seed the next shot's opening frames + room tone. Distinct
                // from supportsVideoInput on purpose — video_* means the LTX
                // extend/head-swap lane and flips that UI.
                supportsMotionContext: accepts.includes('motion_context_base64'),
                // MiniMax H3 Reference mode: discrete character/subject pictures
                // (up to 9, order-preserving) instead of a start frame. Distinct
                // from ingredient_images, which LTX stitches into one sheet.
                supportsReferenceImages: accepts.includes('reference_images'),
                // Head replacement: the workflow rewrites an EXISTING clip
                // through a mask instead of generating one. source_video_* is
                // deliberately its own field family — video_* means the LTX
                // extend/head-swap lane, and reference_videos are conditioning.
                supportsHeadReplacement: accepts.includes('source_video_base64')
                    || accepts.includes('source_video_path'),
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
        description: `${provider.label || 'Studio'} workflow`,
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

// Has a context already been fetched in this session? Callers that follow an
// empty answer with a forced refetch use this to tell "the cache answered with
// nothing" from "the wire just answered with nothing" — a forced refetch after
// the second is the same request twice in a row.
export function hivemindStudioContextCached() {
    return contextCache !== null;
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
                //
                // `pending` is the same condition from the other direction: the
                // control API is still building its catalog behind a boot warm-up
                // and answered immediately with an empty media block rather than
                // holding the request open for it. Marked not-live so the studio's
                // existing degraded-registry backoff asks again, which is exactly
                // what this window needs.
                videoRegistryLive: !catalogForContext
                    || (catalogForContext.pending !== true && provider?.registry_live !== false),
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

/**
 * A lane refusal as an Error that still carries its repair.
 *
 * The routes answer `{message, remedy, provider}` when a failure has a fix —
 * an account to connect, a balance to top up — and `new Error(detail)` on that
 * object produced the string "[object Object]". So the message is read out of
 * the shape, and the remedy is attached the way modelRunner.js attaches it, so
 * the studio's callout can render the button instead of the sentence alone.
 */
function laneError(detail, fallback) {
    const shape = detail && typeof detail === 'object' ? detail : null;
    const error = new Error(
        (shape ? String(shape.message || shape.error || '') : String(detail || '')) || fallback,
    );
    if (shape) {
        error.remedy = String(shape.remedy || '');
        error.oauthProvider = String(shape.provider || '');
    }
    return error;
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
    // Head replacement: the clip being REWRITTEN, plus the painted region that
    // says which pixels may change. The clip is normally a sealed reference
    // already attached in the references panel, so it decrypts in-browser and
    // re-sends inline like every other reference — the server holds no key to
    // stage a path. The mask never was sealed: the canvas in the inpaint dialog
    // just drew it, so it arrives as a data URL and goes up as one.
    const inpaintSourceBase64 = params.source_video_base64
        || await mediaSourceToDataUrl(params.inpaintSource, 'video');
    const inpaintMaskBase64 = params.mask_image_base64
        || await mediaSourceToDataUrl(params.inpaintMask, 'image');
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
        ...(inpaintSourceBase64 ? { source_video_base64: inpaintSourceBase64 } : {}),
        ...(inpaintMaskBase64 ? { mask_image_base64: inpaintMaskBase64 } : {}),
        // A tracked mask CLIP, when one was produced. Already base64 — it never
        // was a sealed reference, it came back from the masking service.
        ...(params.inpaintMaskVideo ? { mask_video_base64: String(params.inpaintMaskVideo) } : {}),
        ...(params.maskSource === 'manual' || params.maskSource === 'sam3'
            ? { mask_source: params.maskSource }
            : {}),
        // Only the dials the dialog actually changed. An unset dial is left out
        // so the workflow's own default stays the one place it is written down.
        ...(params.inpaint && Object.keys(params.inpaint).length ? { inpaint: params.inpaint } : {}),
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
            throw laneError(legacy.data.detail || legacy.data.error,
                `The studio could not start that generation (HTTP ${legacy.response.status}).`);
        }
        return finished(legacy.data);
    }
    if (!start.response.ok || start.data.ok === false || !start.data.job_id) {
        throw laneError(start.data.detail || start.data.error,
            `The studio could not start that generation (HTTP ${start.response.status}).`);
    }
    // A server that already finished synchronously answers with the media URL.
    if (start.data.url || start.data.media_url || start.data.output_url) return finished(start.data);
    const jobId = String(start.data.job_id);
    // Surface the job id so the studio can persist it (sessionStorage) and resume
    // polling after a tab switch / reload — a long local render must not be lost
    // just because the studio component remounts.
    if (typeof params.onJobId === 'function') params.onJobId(jobId);
    // The server may have trimmed something on the way in (an over-long
    // ingredient note, say); it says so instead of cutting silently.
    if (Array.isArray(start.data.warnings) && start.data.warnings.length && typeof params.onWarning === 'function') {
        for (const warning of start.data.warnings) params.onWarning(String(warning));
    }
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

// How long past its own estimate a render is allowed to run before the poller
// says something. Not a deadline: the server owns the terminal states now (it
// ends a job whose backend stopped answering), so passing this only earns a
// "still rendering — keep waiting or Cancel" line. A wall-clock deadline here
// used to fail renders that were fine: timers pause while a laptop sleeps but
// Date.now() does not, so a lid closed for two hours woke to a timeout for a
// clip the server was still tracking.
const VIDEO_OVERTIME_MULTIPLE = 3;
const VIDEO_OVERTIME_FLOOR_SECONDS = 30 * 60;

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
    const startedAt = Date.now();
    // Three in a row, not one: a single failed poll is a blip, and the job on
    // the other side survives blips.
    let failures = 0;
    let overtimeAnnounced = 0;
    for (;;) {
        if (signal?.aborted) throw cancelled();
        // 2s poll: the bar is smoothed client-side between polls, so this only needs
        // to keep real progress / estimate / completion reasonably fresh. The wait
        // itself is abortable so Cancel frees the serial queue at once instead of
        // sitting out the rest of the tick.
        await new Promise((resolve) => {
            const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, 2000);
            function onAbort() { clearTimeout(timer); resolve(); }
            signal?.addEventListener?.('abort', onAbort, { once: true });
        });
        if (signal?.aborted) throw cancelled();
        let payload;
        try {
            const response = await fetch(`/api/media-studio/video/job/${encodeURIComponent(id)}`, { credentials: 'same-origin', ...(signal ? { signal } : {}) });
            if (response.status === 404) {
                // Nobody has this job: not the registry, not the gateway, not
                // its history. The server re-adopts a job that is still running
                // before it ever answers 404, so this is the end of the road —
                // and it must not promise a clip that may never arrive.
                failures += 1;
                if (failures >= 3) {
                    throw Object.assign(
                        new Error('The studio restarted and this render was lost. Generate again — anything that did finish is in the History tab.'),
                        { retryable: true },
                    );
                }
                continue;
            }
            if (!response.ok) {
                // A 5xx used to fall straight through to the bare `continue`
                // below and poll a broken server until the wall clock gave up.
                failures += 1;
                if (failures >= 3) {
                    throw Object.assign(
                        new Error('The studio stopped answering about this render. Generate again — anything that did finish is in the History tab.'),
                        { retryable: true },
                    );
                }
                continue;
            }
            failures = 0;
            payload = await response.json().catch(() => ({}));
        } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw cancelled();
            if (error?.retryable || failures >= 3) throw error;
            failures += 1;
            continue; // transient network blip — the job survives server-side
        }
        if (payload.status === 'error' || payload.ok === false) {
            // laneError carries the server's remedy so the callout can render a
            // button; `retryable` is the backend saying this one is worth
            // pressing it for (a restart or a lane that stopped answering).
            throw Object.assign(
                laneError(payload.detail || payload.error, 'The studio reported a failed generation.'),
                ...(payload.retryable ? [{ retryable: true }] : []),
            );
        }
        if (payload.status === 'running') {
            estimate = Number(payload.estimate_seconds) || estimate;
            const elapsed = Number(payload.elapsed_seconds) || (Date.now() - startedAt) / 1000;
            // Past its own estimate by a wide margin: say so once a minute
            // rather than calling a live render a failure.
            const ceiling = Math.max((estimate || 0) * VIDEO_OVERTIME_MULTIPLE, VIDEO_OVERTIME_FLOOR_SECONDS);
            const overtimeMinutes = elapsed > ceiling ? Math.floor(elapsed / 60) : 0;
            if (overtimeMinutes > overtimeAnnounced) overtimeAnnounced = overtimeMinutes;
            if (typeof onProgress === 'function') {
                onProgress({
                    progress: typeof payload.progress === 'number' ? payload.progress : null,
                    estimateSeconds: estimate,
                    elapsedSeconds: Number(payload.elapsed_seconds) || null,
                    // Minutes so far, only once the run is well past its
                    // estimate. The studio turns this into "still rendering —
                    // keep waiting or Cancel", never an error.
                    overtimeMinutes: overtimeAnnounced || null,
                    // Present only when the backend reports real sampler
                    // counters (a rented lane does); absent on paths where the
                    // bar is still a time estimate, so the label never implies
                    // a precision we do not have.
                    step: Number(payload.progress_step) || null,
                    stepTotal: Number(payload.progress_total) || null,
                    // This machine has one GPU and it is busy with someone
                    // else's render: how many are ahead of this one. Present
                    // only while waiting, so it clears itself when work starts.
                    queuePosition: Number(payload.queue_position) || null,
                });
            }
            continue;
        }
        if (payload.ok && (payload.url || payload.media_url || payload.output_url)) return done(payload);
    }
}
