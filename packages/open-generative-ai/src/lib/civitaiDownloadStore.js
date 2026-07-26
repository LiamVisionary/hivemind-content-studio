// Background-safe state for Civitai downloads.
//
// The poll loops live HERE, not in the dialog, so closing the download modal no
// longer stops progress tracking (it used to abort on unmount). Several downloads
// run at once: the store is a keyed list, and every view renders from it — a
// pending card per plain download, and an in-place updating state on the LoRA card
// a replace supersedes. `onComplete` still fires (LoRA list refresh) even if
// nothing is mounted at all.
import { downloadCivitaiLora, formatDownloadBytes } from './civitaiDownload.js';

let downloads = [];
let nextKey = 0;
const listeners = new Set();

function emit(next) {
  downloads = next;
  listeners.forEach((fn) => fn(downloads));
}

function patch(key, fields) {
  emit(downloads.map((item) => (item.key === key ? { ...item, ...fields } : item)));
}

export function getCivitaiDownloads() {
  return downloads;
}

export function subscribeCivitaiDownloads(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getCivitaiDownload(key) {
  return downloads.find((item) => item.key === key) || null;
}

/** The download replacing this installed LoRA, if one is in flight. */
export function civitaiDownloadReplacing(loraId) {
  const id = String(loraId || '');
  if (!id) return null;
  return downloads.find((item) => item.replaces === id && item.status === 'running') || null;
}

/** Downloads that own a card of their own — plain downloads, plus failed replaces. */
export function pendingCivitaiDownloads() {
  return downloads.filter((item) => !item.replaces || item.status === 'error');
}

export function isCivitaiDownloadRunning() {
  return downloads.some((item) => item.status === 'running');
}

/** Drop a settled download. Running ones are left alone — cancel those instead. */
export function clearCivitaiDownload(key) {
  emit(downloads.filter((item) => !(item.key === key && item.status !== 'running')));
}

/** Drop every settled download, e.g. when a panel wants a clean slate. */
export function clearSettledCivitaiDownloads() {
  emit(downloads.filter((item) => item.status === 'running'));
}

/**
 * Start a download and poll it to completion.
 *
 * Returns the key identifying it in the store. Several downloads run concurrently;
 * the same URL (or the same replace target) is not started twice, so a double click
 * joins the download already in flight instead of racing it.
 *
 * Never rejects — failures land on the entry's `error` so every view reports them
 * identically. A cancelled job settles as `status: 'cancelled'`, which is not an error.
 */
export function startCivitaiDownload(api, url, { onComplete, onStarted, replaces = '' } = {}) {
  const trimmed = String(url || '').trim();
  const duplicate = downloads.find((item) => (
    item.status === 'running' && (item.url === trimmed || (replaces && item.replaces === replaces))
  ));
  if (duplicate) return duplicate.key;

  const key = `civitai-${nextKey += 1}`;
  emit([...downloads, { key, url: trimmed, replaces, status: 'running', job: null, error: null, cancelling: false }]);

  let announced = false;
  void (async () => {
    try {
      const finished = await downloadCivitaiLora(api, trimmed, {
        replaceId: replaces,
        onUpdate: (job) => {
          patch(key, { job });
          // Fired once the gateway has a job id: the download is real from here on,
          // which is what lets the UI hand progress over to the cards.
          if (!announced && job?.id) {
            announced = true;
            onStarted?.(job, { key, replaces });
          }
        },
      });
      patch(key, { status: 'success', job: finished, error: null, cancelling: false });
      await onComplete?.(finished, { replaces, key });
    } catch (err) {
      patch(key, err?.cancelled
        ? { status: 'cancelled', error: null, cancelling: false }
        : { status: 'error', error: err?.message || 'Civitai download failed.', cancelling: false });
    }
  })();

  return key;
}

/**
 * Ask the gateway to stop one running download.
 *
 * The poll loop is what settles the state — this only flags the job and marks the
 * entry as cancelling, so a failed cancel leaves the download visibly running.
 */
export async function cancelCivitaiDownload(api, key) {
  const entry = getCivitaiDownload(key);
  const jobId = entry?.job?.id;
  if (!entry || entry.status !== 'running' || !jobId) return;
  patch(key, { cancelling: true });
  try {
    await api.cancelCivitaiDownload(jobId);
  } catch (err) {
    patch(key, { cancelling: false, error: err?.message || 'Could not cancel the download.' });
  }
}

export function civitaiDownloadPercent(download) {
  return Math.max(0, Math.min(100, Number(download?.job?.percent) || 0));
}

/** ComfyUI folder the gateway filed the download under, e.g. `loras`, `checkpoints`. */
export function civitaiDownloadFolder(download) {
  const directory = String(download?.job?.result?.directory || '');
  return directory.split('/').filter(Boolean).pop() || '';
}

// Civitai's own type strings are API-shaped (`LORA`, `TextualInversion`), so they
// get a display label before they reach the UI. Unknown types pass through.
const TYPE_LABELS = {
  lora: 'LoRA',
  locon: 'LoCon',
  lycoris: 'LyCORIS',
  dora: 'DoRA',
  textualinversion: 'Embedding',
  aestheticgradient: 'Aesthetic gradient',
  controlnet: 'ControlNet',
  motionmodule: 'Motion module',
  vae: 'VAE',
  upscaler: 'Upscaler',
};

/** Display label for the model type of a finished download, e.g. `LoRA`, `Checkpoint`. */
export function civitaiDownloadType(download) {
  const raw = String(download?.job?.result?.modelType || '').trim();
  return TYPE_LABELS[raw.toLowerCase().replace(/[^a-z0-9]/g, '')] || raw;
}

/**
 * Name for a download in flight: the gateway resolves the Civitai model name before
 * the file lands, so a card is never an anonymous progress bar. Falls back to the
 * finished filename, then to the model id in the URL.
 */
export function civitaiDownloadName(download) {
  const job = download?.job;
  if (job?.name) return String(job.name);
  if (job?.result?.filename) return String(job.result.filename);
  const match = String(download?.url || '').match(/\/models\/(\d+)/);
  return match ? `Civitai model ${match[1]}` : 'Civitai download';
}

/** Single source of truth for the status line — every view must not drift. */
export function describeCivitaiDownload(download) {
  if (!download) return null;
  if (download.status === 'error') return download.error || 'Download failed.';
  if (download.status === 'cancelled') return 'Download cancelled';
  if (download.status === 'success') {
    const filename = download.job?.result?.filename || 'Model';
    // Any model type is downloadable, so say what it was and where it landed —
    // a checkpoint will not show up in the LoRA list, and that is not a failure.
    const folder = civitaiDownloadFolder(download);
    const detail = [civitaiDownloadType(download), download.job?.result?.baseModel, folder && `models/${folder}`]
      .filter(Boolean)
      .join(' · ');
    return detail ? `${filename} downloaded · ${detail}` : `${filename} downloaded`;
  }
  if (download.cancelling) return 'Cancelling…';
  if (download.job) {
    return download.job.total_bytes
      ? `Downloading ${civitaiDownloadPercent(download)}% · ${formatDownloadBytes(download.job.downloaded_bytes)} / ${formatDownloadBytes(download.job.total_bytes)}`
      : 'Preparing download…';
  }
  return 'Resolving Civitai URL…';
}
