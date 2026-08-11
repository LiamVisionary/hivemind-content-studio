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
      emitProgress({ status, progress, message: status === 'success' ? 'Done' : 'Generating on hosted Open Generative AI' });
      if (status === 'success') {
        if (!last.url) throw new Error('Generation finished without an image');
        return { url: last.url, seed: last.seed };
      }
      if (status === 'error') throw new Error(last.error || 'Generation failed');
    }
  }

  async function upscale(params) {
    emitProgress({ status: 'queued', progress: 0, message: 'Upscaling on hosted Open Generative AI' });
    const submitted = await jsonFetch('/local-ai/upscale', {
      method: 'POST',
      body: JSON.stringify(params || {}),
    });
    const jobId = submitted.id;
    if (!jobId) throw new Error('No job id returned by upscaler');

    let last = null;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, last ? 1500 : 800));
      last = await jsonFetch(`/local-ai/job/${encodeURIComponent(jobId)}`);
      const status = last.status || 'running';
      const progress = status === 'success' ? 1 : status === 'running' ? 0.4 : 0.1;
      emitProgress({ status, progress, message: status === 'success' ? 'Upscaled' : 'Upscaling' });
      if (status === 'success') {
        if (!last.url) throw new Error('Upscale finished without an image');
        return { url: last.url, seed: last.seed };
      }
      if (status === 'error') throw new Error(last.error || 'Upscale failed');
    }
  }

  // Proper RIFE frame interpolation (2x/4x) on a finished clip; the decrypted
  // bytes ride up as base64 and the smoothed clip rides back inlined, so the
  // sealed store stays the only copy at rest.
  async function interpolate(params) {
    emitProgress({ status: 'queued', progress: 0, message: 'Interpolating frames (RIFE)' });
    const submitted = await jsonFetch('/local-ai/interpolate', {
      method: 'POST',
      body: JSON.stringify(params || {}),
    });
    const jobId = submitted.id;
    if (!jobId) throw new Error('No job id returned by the interpolator');

    let last = null;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, last ? 2000 : 1000));
      last = await jsonFetch(`/local-ai/job/${encodeURIComponent(jobId)}`);
      const status = last.status || 'running';
      const progress = status === 'success' ? 1 : status === 'running' ? 0.4 : 0.1;
      emitProgress({ status, progress, message: status === 'success' ? 'Interpolated' : 'Interpolating frames (RIFE)' });
      if (status === 'success') {
        if (!last.url) throw new Error('Interpolation finished without a clip');
        return { url: last.url, mediaType: last.mediaType || 'video' };
      }
      if (status === 'error') throw new Error(last.error || 'Interpolation failed');
    }
  }

  // Store a chained episode the browser joined as a real output, so it lands
  // in History like any generated clip instead of living as a blob URL in one
  // tab. Same round trip as interpolate: bytes up, sealed clip back.
  async function saveEpisode(params) {
    emitProgress({ status: 'queued', progress: 0, message: 'Saving the episode' });
    const submitted = await jsonFetch('/local-ai/episode', {
      method: 'POST',
      body: JSON.stringify(params || {}),
    });
    const jobId = submitted.id;
    if (!jobId) throw new Error('No job id returned when saving the episode');

    let last = null;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, last ? 1500 : 800));
      last = await jsonFetch(`/local-ai/job/${encodeURIComponent(jobId)}`);
      const status = last.status || 'running';
      emitProgress({
        status,
        progress: status === 'success' ? 1 : 0.5,
        message: status === 'success' ? 'Episode saved' : 'Saving the episode',
      });
      if (status === 'success') {
        if (!last.url) throw new Error('Saving finished without a clip');
        return { url: last.url, mediaType: last.mediaType || 'video' };
      }
      if (status === 'error') throw new Error(last.error || 'Saving the episode failed');
    }
  }

  // LTX Director: render one window of a multi-track timeline. Slow by nature
  // — a cold run loads a 27GB checkpoint and a 13GB text encoder before the
  // first step — so the poll is patient and reports elapsed time rather than a
  // fake percentage the node does not publish.
  async function ltxDirector(params) {
    emitProgress({ status: 'queued', progress: 0, message: 'Preparing the timeline' });
    const submitted = await jsonFetch('/local-ai/ltx-director', {
      method: 'POST',
      body: JSON.stringify(params || {}),
    });
    const jobId = submitted.id;
    if (!jobId) throw new Error('No job id returned by LTX Director');

    const startedAt = Date.now();
    let last = null;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, last ? 3000 : 1000));
      last = await jsonFetch(`/local-ai/job/${encodeURIComponent(jobId)}`);
      const status = last.status || 'running';
      const mins = Math.floor((Date.now() - startedAt) / 60000);
      emitProgress({
        status,
        progress: status === 'success' ? 1 : 0.5,
        message: status === 'success'
          ? 'Rendered'
          : `Rendering the timeline${mins ? ` — ${mins} min` : ''}`,
      });
      if (status === 'success') {
        const url = (last.outputs || [])[0];
        if (!url) throw new Error('LTX Director finished without a clip');
        return { url, mediaType: 'video', elapsedSeconds: last.elapsed_seconds };
      }
      if (status === 'error') throw new Error(last.error || 'LTX Director failed');
    }
  }

  // SAM3 smart-select: name or tap an object, get its silhouette back as a
  // mask. The mask returns INLINE (never an output), so nothing about the
  // selection is stored anywhere.
  async function smartMask(params) {
    emitProgress({ status: 'queued', progress: 0, message: 'Finding the object (SAM3)' });
    const submitted = await jsonFetch('/local-ai/smart-mask', {
      method: 'POST',
      body: JSON.stringify(params || {}),
    });
    const jobId = submitted.id;
    if (!jobId) throw new Error('No job id returned by smart select');

    let last = null;
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, last ? 1500 : 800));
      last = await jsonFetch(`/local-ai/job/${encodeURIComponent(jobId)}`);
      const status = last.status || 'running';
      emitProgress({
        status,
        progress: status === 'success' ? 1 : 0.5,
        message: status === 'success' ? 'Selected' : 'Finding the object (SAM3)',
      });
      if (status === 'success') {
        if (!last.mask_base64) throw new Error('Smart select finished without a mask');
        return { maskBase64: last.mask_base64 };
      }
      if (status === 'error') throw new Error(last.error || 'Smart select failed');
    }
  }

  async function listLoras(modelId, baseModels) {
    // Video workflows are defined in the Media Studio MCP, not in the registry the
    // bridge reads, so carry the base models from the catalog we were given.
    const list = Array.isArray(baseModels) ? baseModels.filter(Boolean) : [];
    const query = list.length ? `?baseModels=${encodeURIComponent(list.join(','))}` : '';
    const data = await jsonFetch(`/local-ai/loras/${encodeURIComponent(modelId)}${query}`);
    return {
      ...data,
      loras: (data.loras || []).map((lora) => ({
        ...lora,
        previewUrl: lora.previewPath ? `${apiBase}${lora.previewPath}` : '',
      })),
    };
  }

  // Installed models, and Civitai browse. Both carry preview paths that are relative
  // to this bridge, so they get the same apiBase treatment as LoRA card art.
  async function listLibrary() {
    const data = await jsonFetch('/local-ai/library');
    return {
      ...data,
      assets: (data.assets || []).map((asset) => ({
        ...asset,
        previewUrl: asset.previewPath ? `${apiBase}${asset.previewPath}` : '',
        motionUrl: asset.motionPath ? `${apiBase}${asset.motionPath}` : '',
      })),
    };
  }

  async function searchCivitai(params) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== '' && value !== false) query.set(key, String(value));
    }
    const data = await jsonFetch(`/local-ai/civitai-search?${query}`);
    return {
      ...data,
      items: (data.items || []).map((item) => ({
        ...item,
        previewUrl: item.previewPath ? `${apiBase}${item.previewPath}` : '',
      })),
    };
  }

  window.localAI = {
    isElectron: true,
    isHosted: true,
    getBinaryStatus: () => jsonFetch('/local-ai/binary-status'),
    listLibrary,
    searchCivitai,
    listCivitaiBaseModels: () => jsonFetch('/local-ai/civitai-base-models'),
    downloadBinary: async () => ({ ok: true, source: 'hosted' }),
    listModels: () => jsonFetch('/local-ai/models'),
    listLoras,
    generatePrompt: (params) => jsonFetch('/local-ai/prompt-helper', {
      method: 'POST',
      body: JSON.stringify(params || {}),
    }),
    startCivitaiDownload: (url, options) => jsonFetch('/local-ai/civitai-download', {
      method: 'POST',
      // replaceId marks an update-and-replace of an installed LoRA.
      body: JSON.stringify({ url, ...(options?.replaceId ? { replaceId: options.replaceId } : {}) }),
    }),
    listLoraUpdates: (baseModels) => {
      const list = Array.isArray(baseModels) ? baseModels.filter(Boolean) : [];
      const query = list.length ? `?baseModels=${encodeURIComponent(list.join(','))}` : '';
      return jsonFetch(`/local-ai/lora-updates${query}`);
    },
    getCivitaiDownloadJob: (jobId) => jsonFetch(`/local-ai/civitai-download/${encodeURIComponent(jobId)}`),
    cancelCivitaiDownload: (jobId) => jsonFetch(`/local-ai/civitai-download/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
    }),
    downloadModel: async (modelId) => ({ ok: true, id: modelId, source: 'hosted' }),
    downloadAuxiliary: async (auxKey) => ({ ok: true, id: auxKey, source: 'hosted' }),
    deleteModel: async () => ({ ok: false, error: 'Hosted mode keeps shared models managed by the Mac.' }),
    generate,
    upscale,
    interpolate,
    saveEpisode,
    smartMask,
    ltxDirector,
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
