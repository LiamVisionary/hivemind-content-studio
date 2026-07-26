// Frontend client for local inference — wraps window.localAI (Electron IPC).
// Two providers live behind the same surface:
//   - sd.cpp: bundled engine, downloads weights to disk, runs locally
//   - wan2gp: user-run Gradio server, generation is remote HTTP
// Provider is read off the model entry's `provider` field.

import { getLocalModelById } from './localModels.js';

export const isLocalAIAvailable = () => typeof window !== 'undefined' && !!window.localAI?.isElectron;

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
    async listModels() {
        if (!isLocalAIAvailable()) return [];
        const [sdcpp, wan2gp] = await Promise.all([
            window.localAI.listModels(),
            window.localAI.wan2gp.listModels().catch(() => []),
        ]);
        return [
            ...sdcpp.map(m => ({ ...m, provider: m.provider || 'sdcpp' })),
            ...wan2gp,
        ];
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

    async warmIdeogram4() {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.warmIdeogram4();
    }

    async unloadIdeogram4() {
        if (!isLocalAIAvailable()) throw new Error('Local AI only available in the desktop app.');
        return window.localAI.unloadIdeogram4();
    }

    cancelGeneration() {
        if (!isLocalAIAvailable()) return;
        // Ask both — only the running one reacts.
        window.localAI.cancelGeneration();
        window.localAI.wan2gp.cancelGeneration();
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
