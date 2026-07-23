export function isCivitaiUrl(value = '') {
    try {
        const parsed = new URL(String(value).trim());
        const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
        return parsed.protocol === 'https:' && (host === 'civitai.com' || host === 'civitai.red');
    } catch {
        return false;
    }
}

export function formatDownloadBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function wait(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('Download monitoring stopped'));
            return;
        }
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Download monitoring stopped'));
        }, { once: true });
    });
}

export async function downloadCivitaiLora(api, url, options = {}) {
    if (!isCivitaiUrl(url)) throw new Error('Enter a valid civitai.com or civitai.red URL.');
    const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
    const pollInterval = Math.max(0, Number(options.pollInterval ?? 900));
    let job = await api.startCivitaiDownload(String(url).trim());
    if (!job?.id) throw new Error('The downloader did not return a job id.');
    onUpdate(job);
    while (job.status === 'queued' || job.status === 'running') {
        await wait(pollInterval, options.signal);
        job = await api.getCivitaiDownloadJob(job.id);
        onUpdate(job);
    }
    if (job.status !== 'success') throw new Error(job.error || 'Civitai download failed.');
    return job;
}
