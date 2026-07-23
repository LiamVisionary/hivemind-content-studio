const bridgeEnabled = new URLSearchParams(window.location.search).get('hivemindBridge') === '1' && window.parent !== window;

if (bridgeEnabled && !window.localAI) {
  const pending = new Map();
  const progressListeners = new Set();
  const downloadListeners = new Set();
  let requestId = 0;

  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = `local-ai-${Date.now()}-${requestId += 1}`;
    pending.set(id, { resolve, reject });
    window.parent.postMessage({ type: 'hivemind-local-ai-request', id, method, args }, window.location.origin);
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    const message = event.data;
    if (message?.type === 'hivemind-local-ai-response') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
      return;
    }
    if (message?.type === 'hivemind-local-ai-event') {
      const listeners = message.event === 'download-progress' ? downloadListeners : progressListeners;
      listeners.forEach((listener) => listener(message.data));
    }
  });

  const subscribe = (listeners, callback) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  };

  window.localAI = {
    isElectron: true,
    getBinaryStatus: () => call('getBinaryStatus'),
    downloadBinary: () => call('downloadBinary'),
    listModels: () => call('listModels'),
    listLoras: (modelId) => call('listLoras', modelId),
    generatePrompt: (params) => call('generatePrompt', params),
    startCivitaiDownload: (url) => call('startCivitaiDownload', url),
    getCivitaiDownloadJob: (jobId) => call('getCivitaiDownloadJob', jobId),
    downloadModel: (modelId) => call('downloadModel', modelId),
    downloadAuxiliary: (auxKey) => call('downloadAuxiliary', auxKey),
    deleteModel: (modelId) => call('deleteModel', modelId),
    cancelDownload: (modelId) => call('cancelDownload', modelId),
    generate: (params) => call('generate', params),
    warmIdeogram4: () => call('warmIdeogram4'),
    unloadIdeogram4: () => call('unloadIdeogram4'),
    cancelGeneration: () => call('cancelGeneration'),
    onProgress: (callback) => subscribe(progressListeners, callback),
    onDownloadProgress: (callback) => subscribe(downloadListeners, callback),
    wan2gp: {
      getConfig: () => call('wan2gp.getConfig'),
      setUrl: (url) => call('wan2gp.setUrl', url),
      probe: (url) => call('wan2gp.probe', url),
      listModels: () => call('wan2gp.listModels'),
      generate: (params) => call('wan2gp.generate', params),
      cancelGeneration: () => call('wan2gp.cancelGeneration'),
      uploadFile: (payload) => call('wan2gp.uploadFile', payload),
    },
  };
}
