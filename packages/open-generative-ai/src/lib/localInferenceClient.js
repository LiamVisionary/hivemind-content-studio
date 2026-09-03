// Frontend client for local inference — wraps window.localAI (Electron IPC).
// Two providers live behind the same surface:
//   - sd.cpp: bundled engine, downloads weights to disk, runs locally
//   - wan2gp: user-run Gradio server, generation is remote HTTP
// Provider is read off the model entry's `provider` field.

import { getLocalModelById } from './localModels.js';

export const isLocalAIAvailable = () => typeof window !== 'undefined' && !!window.localAI?.isElectron;

// Hosted mode: the weights are managed by the Mac running the stack, not by this
// app. The bundled-engine install / per-model download / delete controls are no-ops
// there, so surfaces that offer them must ask first — the Models view is the real
// manager in hosted mode.
export const isHostedLocalAI = () => isLocalAIAvailable() && !!window.localAI?.isHosted;

// ── One readiness answer for every studio ─────────────────────────────────
//
// Image, Story and Sprite all used to decide "can this machine run anything?"
// on their own, and all three got it wrong the same way: a bridge that did not
// answer left the static boot catalog on screen with a live Generate button.
// The catalog fetch now reports WHY it is empty, and one module-level copy of
// that verdict is what `modelRunner.transportFor` reads, so the three studios
// refuse a local row with the same sentence.
//
//   discovering  nobody has asked yet — assume nothing, block nothing
//   ready        at least one installed model this machine can run
//   empty        the bridge answered, and there is no model to run
//   unreachable  the bridge did not answer, or the engine behind it is down
export const LOCAL_CATALOG_STATUSES = Object.freeze(['discovering', 'ready', 'empty', 'unreachable']);

let localCatalogStatus = 'discovering';

/** The last verdict the catalog fetch reached. Synchronous on purpose: the
 *  routing check (`transportFor`) runs during render and cannot await. */
export const localCatalogStatusNow = () => (isLocalAIAvailable() ? localCatalogStatus : 'unreachable');

/** Test seam and re-discovery reset — a "Check again" press starts over. */
export const setLocalCatalogStatus = (status) => {
    localCatalogStatus = LOCAL_CATALOG_STATUSES.includes(status) ? status : 'discovering';
};

// A model the bridge marked unrunnable is not inventory. `ready === false` is
// the hosted bridge's answer (weights missing, or the lane is not answering);
// `state === 'not-downloaded'` is the desktop build's.
const isRunnableEntry = (model) => model?.state !== 'not-downloaded' && model?.ready !== false;

function statusForModels(models) {
    if (models.some(isRunnableEntry)) return 'ready';
    // Nothing runnable AND every entry blames the engine: the models are
    // installed, the thing that runs them is not up. That is not "empty".
    if (models.length && models.every((model) => model?.readyReason === 'engine-offline')) return 'unreachable';
    return 'empty';
}

class LocalInferenceClient {
    // ── sd.cpp APIs ───────────────────────────────────────────────────────
    async getBinaryStatus() {
        if (!isLocalAIAvailable()) return { exists: false };
        return window.localAI.getBinaryStatus();
    }
    async downloadBinary() {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.downloadBinary();
    }
    async downloadModel(modelId) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.downloadModel(modelId);
    }
    async downloadAuxiliary(auxKey) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.downloadAuxiliary(auxKey);
    }
    async deleteModel(modelId) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.deleteModel(modelId);
    }

    // ── Wan2GP APIs ───────────────────────────────────────────────────────
    async getWan2gpConfig() {
        if (!isLocalAIAvailable()) return { url: '' };
        return window.localAI.wan2gp.getConfig();
    }
    async setWan2gpUrl(url) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.wan2gp.setUrl(url);
    }
    async probeWan2gp(url) {
        if (!isLocalAIAvailable()) return { ok: false, error: 'Not in desktop app' };
        return window.localAI.wan2gp.probe(url);
    }
    // Pushes a File/Blob to the configured Wan2GP server's /upload endpoint
    // and returns { url, path }. URL is a previewable HTTP link; the provider
    // also remembers the path so a subsequent generate(params.image=url) call
    // can rehydrate it as a Gradio file descriptor.
    async uploadFileToWan2gp(file) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        const buf = await file.arrayBuffer();
        return window.localAI.wan2gp.uploadFile({
            name: file.name,
            type: file.type,
            bytes: new Uint8Array(buf),
        });
    }

    // ── Unified model list (both providers merged) ────────────────────────
    //
    // Resolves `{ models, status }` — never rejects. A caller that only wants
    // the rows reads `.models`; a caller that has to explain an empty picker
    // reads `.status`. The two used to be the same value (an empty array), and
    // "the engine is starting" was indistinguishable from "nothing installed".
    async listModels() {
        if (!isLocalAIAvailable()) {
            setLocalCatalogStatus('unreachable');
            return { models: [], status: 'unreachable' };
        }
        let sdcpp;
        try {
            sdcpp = await window.localAI.listModels();
        } catch (error) {
            setLocalCatalogStatus('unreachable');
            return { models: [], status: 'unreachable', error };
        }
        const wan2gp = await Promise.resolve(window.localAI.wan2gp?.listModels?.()).catch(() => []);
        const models = [
            ...(Array.isArray(sdcpp) ? sdcpp : []).map(m => ({ ...m, provider: m.provider || 'sdcpp' })),
            ...(Array.isArray(wan2gp) ? wan2gp : []),
        ];
        const status = statusForModels(models);
        setLocalCatalogStatus(status);
        return { models, status };
    }

    // baseModels: optional compatible-base list from the workflow catalog. Video
    // workflows live in the MCP registry, which the hosted bridge cannot read, so
    // passing them keeps LoRAs working for every workflow without an id allowlist.
    async listLoras(modelId, baseModels) {
        if (!isLocalAIAvailable() || typeof window.localAI.listLoras !== 'function') {
            return { model: modelId, supported: false, baseModels: [], loras: [] };
        }
        return window.localAI.listLoras(modelId, baseModels);
    }

    async generatePrompt(params) {
        if (!isLocalAIAvailable() || typeof window.localAI.generatePrompt !== 'function') {
            throw new Error('This local workflow does not expose a prompt helper.');
        }
        return window.localAI.generatePrompt(params);
    }

    // ── Installed library + Civitai browse (hosted bridge only) ───────────
    // The desktop build manages its own weights, so these are absent there: the
    // Models view asks `supportsLibrary()` first and hides the surface instead.
    supportsLibrary() {
        return isLocalAIAvailable() && typeof window.localAI.listLibrary === 'function';
    }

    async listLibrary() {
        if (!this.supportsLibrary()) return { assets: [], stats: {}, baseModels: [], tags: [] };
        const data = await window.localAI.listLibrary();
        return {
            assets: Array.isArray(data?.assets) ? data.assets : [],
            stats: data?.stats && typeof data.stats === 'object' ? data.stats : {},
            baseModels: Array.isArray(data?.baseModels) ? data.baseModels : [],
            tags: Array.isArray(data?.tags) ? data.tags : [],
        };
    }

    supportsCivitaiSearch() {
        return isLocalAIAvailable() && typeof window.localAI.searchCivitai === 'function';
    }

    async searchCivitai(params) {
        if (!this.supportsCivitaiSearch()) throw new Error('Civitai browsing is available through Unified Studio.');
        const data = await window.localAI.searchCivitai(params);
        return {
            items: Array.isArray(data?.items) ? data.items : [],
            installedVersionIds: Array.isArray(data?.installedVersionIds) ? data.installedVersionIds : [],
            installedFileIds: Array.isArray(data?.installedFileIds) ? data.installedFileIds : [],
            baseModelOptions: Array.isArray(data?.baseModelOptions) ? data.baseModelOptions : [],
            nextCursor: typeof data?.nextCursor === 'string' ? data.nextCursor : '',
        };
    }

    // ── Civitai inspiration finder ────────────────────────────────────────
    // Same bridge and same key as the model browser, different endpoint: this
    // one browses generated images and videos for the prompt attached to them.
    supportsCivitaiImages() {
        return isLocalAIAvailable() && typeof window.localAI.searchCivitaiImages === 'function';
    }

    async searchCivitaiImages(params) {
        if (!this.supportsCivitaiImages()) throw new Error('The inspiration finder is available through Unified Studio.');
        const data = await window.localAI.searchCivitaiImages(params);
        return {
            items: Array.isArray(data?.items) ? data.items : [],
            baseModelOptions: Array.isArray(data?.baseModelOptions) ? data.baseModelOptions : [],
            nextCursor: typeof data?.nextCursor === 'string' ? data.nextCursor : '',
            // How many raw results the gateway read to fill this page. Shown so
            // a thin page reads as "Civitai had little with a prompt", not as a
            // broken filter.
            scanned: Number(data?.scanned) || 0,
        };
    }

    // Civitai's own base-model vocabulary for the browse filter. Never throws: the
    // filter falls back to the values the search results carry.
    async listCivitaiBaseModels() {
        if (!isLocalAIAvailable() || typeof window.localAI.listCivitaiBaseModels !== 'function') return [];
        try {
            const data = await window.localAI.listCivitaiBaseModels();
            return Array.isArray(data?.baseModels) ? data.baseModels : [];
        } catch {
            return [];
        }
    }

    async startCivitaiDownload(url, options) {
        if (!isLocalAIAvailable() || typeof window.localAI.startCivitaiDownload !== 'function') {
            throw new Error('Civitai downloads are available through Unified Studio.');
        }
        return window.localAI.startCivitaiDownload(url, options);
    }

    // Which installed LoRAs have a newer Civitai version. Never throws: an update
    // check is an enhancement, so a rate limit must not break the LoRA panel.
    async listLoraUpdates(baseModels) {
        if (!isLocalAIAvailable() || typeof window.localAI.listLoraUpdates !== 'function') {
            return {};
        }
        try {
            const data = await window.localAI.listLoraUpdates(baseModels);
            return data?.updates && typeof data.updates === 'object' ? data.updates : {};
        } catch {
            return {};
        }
    }

    async getCivitaiDownloadJob(jobId) {
        if (!isLocalAIAvailable() || typeof window.localAI.getCivitaiDownloadJob !== 'function') {
            throw new Error('Civitai downloads are available through Unified Studio.');
        }
        return window.localAI.getCivitaiDownloadJob(jobId);
    }

    async cancelCivitaiDownload(jobId) {
        if (!isLocalAIAvailable() || typeof window.localAI.cancelCivitaiDownload !== 'function') {
            throw new Error('Cancelling a Civitai download is available through Unified Studio.');
        }
        return window.localAI.cancelCivitaiDownload(jobId);
    }

    // ── Provider-aware generate ───────────────────────────────────────────
    async generate(params) {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        const model = getLocalModelById(params.model);
        if (model?.provider === 'wan2gp') {
            return window.localAI.wan2gp.generate(params);
        }
        return window.localAI.generate(params);
    }

    // Post-generation upscale (fast R-ESRGAN, or max = ESRGAN + diffusion refine).
    async upscale(params) {
        if (!isLocalAIAvailable() || typeof window.localAI.upscale !== 'function') {
            throw new Error('Upscale is available through Unified Studio.');
        }
        return window.localAI.upscale(params);
    }

    // RIFE frame interpolation (2x/4x) on a finished clip — hosted bridge only.
    async interpolate(params) {
        if (!isLocalAIAvailable() || typeof window.localAI.interpolate !== 'function') {
            throw new Error('Frame interpolation is available through Unified Studio.');
        }
        return window.localAI.interpolate(params);
    }

    // Store a browser-joined chained episode as a real output — hosted bridge only.
    async saveEpisode(params) {
        if (!isLocalAIAvailable() || typeof window.localAI.saveEpisode !== 'function') {
            throw new Error('Saving an episode is available through Unified Studio.');
        }
        return window.localAI.saveEpisode(params);
    }

    // LTX Director timeline render — hosted bridge only.
    async ltxDirector(params) {
        if (!isLocalAIAvailable() || typeof window.localAI.ltxDirector !== 'function') {
            throw new Error('LTX Director is available through Unified Studio.');
        }
        return window.localAI.ltxDirector(params);
    }

    // SAM3 smart-select mask (name or tap an object) — hosted bridge only.
    async smartMask(params) {
        if (!isLocalAIAvailable() || typeof window.localAI.smartMask !== 'function') {
            throw new Error('Smart select is available through Unified Studio.');
        }
        return window.localAI.smartMask(params);
    }

    async warmIdeogram4() {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.warmIdeogram4();
    }

    async unloadIdeogram4() {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.unloadIdeogram4();
    }

    cancelGeneration(jobId) {
        if (!isLocalAIAvailable()) return;
        // Ask both — only the running one reacts. The hosted bridge cancels by
        // job id (it stops that job's poll); the desktop bridge ignores the arg.
        try { window.localAI.cancelGeneration(jobId); } catch { /* bridge without cancel */ }
        try { window.localAI.wan2gp?.cancelGeneration?.(); } catch { /* no wan2gp */ }
    }

    /**
     * Subscribe to generation progress events.
     * sd.cpp emits { step, totalSteps, progress, status }.
     * Wan2GP emits { progress, status }.
     */
    onProgress(callback) {
        if (!isLocalAIAvailable()) return () => {};
        return window.localAI.onProgress(callback);
    }

    onDownloadProgress(callback) {
        if (!isLocalAIAvailable()) return () => {};
        return window.localAI.onDownloadProgress(callback);
    }
}

export const localAI = new LocalInferenceClient();
