// Browser-hosted localAI bridge for Liam's hosted Open Generative AI.
// Provides the Electron preload surface over same-origin HTTP endpoints.
(() => {
  const bridgeEnabled = new URLSearchParams(window.location.search).get('hivemindBridge') === '1' && window.parent !== window;
  if (bridgeEnabled) return;
  if (window.localAI) return;

  const apiBase = window.location.pathname.startsWith('/open-gen') ? '/open-gen-api' : '';

  const progressListeners = new Set();
  const downloadListeners = new Set();

  async function jsonFetch(url, options = {}) {
    const res = await fetch(`${apiBase}${url}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function emitProgress(event) {
    for (const cb of progressListeners) {
      try { cb(event); } catch (_) {}
    }
  }

  async function generate(params) {
    emitProgress({ status: 'queued', progress: 0, message: 'Queued on hosted Open Generative AI' });
    const submitted = await jsonFetch('/local-ai/generate', {
      method: 'POST',
      body: JSON.stringify(params || {}),
    });
    const jobId = submitted.id;
    if (!jobId) throw new Error('No job id returned by hosted generator');

    let last = null;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, last ? 1200 : 600));
      last = await jsonFetch(`/local-ai/job/${encodeURIComponent(jobId)}`);
      const status = last.status || 'running';
      const progress = status === 'success' ? 1 : status === 'running' ? 0.35 : 0.1;
      emitProgress({ status, progress, message: status === 'success' ? 'Done' : 'Generating on hosted Z-Image stack' });
      if (status === 'success') {
        if (!last.url) throw new Error('Generation finished without an image');
        return { url: last.url, seed: last.seed };
      }
      if (status === 'error') throw new Error(last.error || 'Generation failed');
    }
  }

  window.localAI = {
    isElectron: true,
    isHosted: true,
    getBinaryStatus: () => jsonFetch('/local-ai/binary-status'),
    downloadBinary: async () => ({ ok: true, source: 'hosted' }),
    listModels: () => jsonFetch('/local-ai/models'),
    downloadModel: async (modelId) => ({ ok: true, id: modelId, source: 'hosted' }),
    downloadAuxiliary: async (auxKey) => ({ ok: true, id: auxKey, source: 'hosted' }),
    deleteModel: async () => ({ ok: false, error: 'Hosted mode keeps shared models managed by the Mac.' }),
    generate,
    cancelGeneration: async () => ({ ok: true }),
    wan2gp: {
      getConfig: async () => ({ url: '' }),
      setUrl: async () => ({ ok: false, error: 'Wan2GP config is not enabled in hosted mode.' }),
      probe: async () => ({ ok: false, error: 'Wan2GP is not configured in hosted mode.' }),
      listModels: async () => [],
      generate,
      cancelGeneration: async () => ({ ok: true }),
      uploadFile: async () => { throw new Error('Hosted Wan2GP upload is not enabled.'); },
    },
    onProgress: (callback) => {
      progressListeners.add(callback);
      return () => progressListeners.delete(callback);
    },
    onDownloadProgress: (callback) => {
      downloadListeners.add(callback);
      return () => downloadListeners.delete(callback);
    },
  };
})();
