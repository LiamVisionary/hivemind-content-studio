// Restore Studio — the arithmetic, the vocabulary and the gateway calls, kept
// out of the studio component.
//
// The plan maths here is a deliberate RESTATEMENT of the gateway's
// (packages/media-gateway/video_restore.py). The studio has to say "14 chunks,
// 2560x1440, about 40 minutes" while the file is still sitting in the picker —
// before anything is uploaded — and the only alternative is a round trip to be
// told. The gateway's copy is the one that decides; ours is the one that shows.
// `planRestore` returns the same field names so the two can be compared rather
// than trusted, and the studio swaps in the server's plan once a project exists.
//
// WHAT IS FREE AND WHAT IS PAID. Only one thing changes: which machine runs it.
// There are three, and each consequence below is surfaced in the panel rather
// than discovered afterwards.
//
//   this computer   Free. The gateway keeps the lossless chunks, so the seam
//                   dissolve and every finishing pass are re-runnable for the
//                   price of one ffmpeg pass.
//   a rented GPU    Billed by the hour, for as long as the box is rented —
//                   whether or not it is restoring. Its chunks come back sealed
//                   to your vault (the gateway cannot read them, by design), so
//                   the join happens here in the browser where the key is, and
//                   the render hard-cuts at its chunk boundaries.
//   hosted          Billed per render, in the credits you already have, and
//                   nothing runs between renders. The chunks come back as
//                   ordinary bytes, so it keeps the dissolve and the re-finish
//                   — and the price is quoted and approved before a byte moves.
//                   It is also the one lane where footage leaves the machine.

import { t, tf } from './i18n.js';

// The hosted lane's name, as the gateway reports it. Not a machine: there is
// nothing to attach, nothing to provision and nothing running between renders.
export const CLOUD_LANE = 'cloud';

// SeedVR2 denoises 4n+1 frames at a time. Not a preference: an off-lattice
// batch is refused by the model rather than rounded.
const BATCH_MODULUS = 4;
const BATCH_OFFSET = 1;

export const RESOLUTION_PRESETS = [
  { id: '720p', edge: 720, label: '720p', hint: 'Short edge 720 — the fast look at whether the model helps this footage.' },
  { id: '1080p', edge: 1080, label: '1080p', hint: 'Short edge 1080. 16:9 comes out 1920x1080.' },
  { id: '1440p', edge: 1440, label: '2K', hint: 'Short edge 1440. 16:9 comes out 2560x1440.' },
  { id: '4k', edge: 2160, label: '4K', hint: 'Short edge 2160. Slowest, and the one that needs the most memory.' },
];

// The node downloads a model it has not seen before, several GB on first use.
// Said in the picker, because a 16GB download is not a surprise anyone wants
// mid-render.
export const RESTORE_MODELS = [
  {
    id: 'seedvr2_ema_3b_fp8_e4m3fn.safetensors',
    label: '3B FP8', size: '~3.5GB',
    hint: 'Fastest and lightest. Good on clean-ish footage that mainly needs resolution.',
  },
  {
    id: 'seedvr2_ema_3b_fp16.safetensors',
    label: '3B FP16', size: '~7GB',
    hint: 'The 3B model at full precision — a little more stable, twice the memory.',
  },
  {
    id: 'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors',
    label: '7B FP8', size: '~8.5GB',
    hint: 'The usual choice: 7B quality at roughly half the memory of FP16.',
  },
  {
    id: 'seedvr2_ema_7b_fp16.safetensors',
    label: '7B FP16', size: '~16GB',
    hint: 'Full precision 7B. The most faithful, and the most memory.',
  },
  {
    id: 'seedvr2_ema_7b_sharp_fp8_e4m3fn_mixed_block35_fp16.safetensors',
    label: '7B Sharp FP8', size: '~8.5GB',
    hint: 'Sharp variant: more micro-detail, and more of it invented. Strong on soft or heavily compressed sources.',
  },
  {
    id: 'seedvr2_ema_7b_sharp_fp16.safetensors',
    label: '7B Sharp FP16', size: '~16GB',
    hint: 'The largest and slowest. The one to reach for on footage worth the wait.',
  },
];

export const COLOR_CORRECTIONS = [
  { id: 'lab', label: 'Lab', hint: 'Match the original colour in Lab space. The safe default.' },
  { id: 'wavelet', label: 'Wavelet', hint: 'Keeps the source grade at every scale — good when the restore drifts warm or cold.' },
  { id: 'wavelet_adaptive', label: 'Wavelet (adaptive)', hint: 'Wavelet, weighted by local contrast.' },
  { id: 'hsv', label: 'HSV', hint: 'Match hue and saturation only.' },
  { id: 'adain', label: 'AdaIN', hint: 'Match the statistics rather than the pixels. The loosest.' },
  { id: 'none', label: 'None', hint: 'Whatever the model produces, ungraded.' },
];

export const COMPARE_MODES = [
  { id: 'restored', label: 'Restored' },
  { id: 'original', label: 'Original' },
  { id: 'wipe', label: 'Compare' },
  { id: 'split', label: 'Side by side' },
];

export const RESTORE_DEFAULTS = Object.freeze({
  model: 'seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors',
  resolution: '1440p',
  maxResolution: 0,
  batchSize: 5,
  chunkSeconds: 4,
  contextFrames: 5,
  seamFrames: 3,
  colorCorrection: 'lab',
  seed: 42,
  temporalOverlap: 0,
  tiledVae: false,
});

export const FINISH_DEFAULTS = Object.freeze({
  sharpen: 0,
  grain: 0,
  skinSoftening: 0,
  aspect: 'source',
  aspectRatio: '',
  quality: 16,
});

const clampInt = (value, fallback, low, high) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
};

/** The nearest legal 4n+1 batch at or below `value`. */
export function snapBatchSize(value, fallback = 5) {
  const raw = clampInt(value, fallback, 1, 121);
  if (raw < BATCH_OFFSET) return 1;
  return BATCH_OFFSET + Math.floor((raw - BATCH_OFFSET) / BATCH_MODULUS) * BATCH_MODULUS;
}

export function shortEdgeFor(resolution) {
  const preset = RESOLUTION_PRESETS.find((item) => item.id === resolution);
  if (preset) return preset.edge;
  const edge = clampInt(resolution, 1440, 128, 4320);
  return edge - (edge % 2);
}

/** What the model will actually output, so the studio can say it up front. */
export function targetDimensions(width, height, shortEdge, maxEdge = 0) {
  if (!width || !height) return { width: 0, height: 0 };
  const scale = shortEdge / Math.min(width, height);
  let outW = width * scale;
  let outH = height * scale;
  if (maxEdge && Math.max(outW, outH) > maxEdge) {
    const shrink = maxEdge / Math.max(outW, outH);
    outW *= shrink;
    outH *= shrink;
  }
  const even = (value) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(outW), height: even(outH) };
}

/**
 * The chunk plan, mirroring the gateway's.
 *
 * `frames` is the count the browser measured off the file. Everything the panel
 * shows — chunk count, output size, how much of the clip a preview covers —
 * comes from here, so the numbers on screen and the numbers in the request are
 * the same numbers.
 */
export function planRestore({ frames, fps, width, height, settings = {}, previewFrames = 0, previewStartFrame = 0 }) {
  const total = clampInt(frames, 0, 0, 10_000_000);
  const rate = Number(fps) > 0 ? Number(fps) : 24;
  const batch = snapBatchSize(settings.batchSize ?? RESTORE_DEFAULTS.batchSize);
  const shortEdge = shortEdgeFor(settings.resolution ?? RESTORE_DEFAULTS.resolution);
  const maxEdge = clampInt(settings.maxResolution, 0, 0, 8192);
  const { width: outW, height: outH } = targetDimensions(width, height, shortEdge, maxEdge);
  if (!total) {
    return { frames: 0, chunks: [], width: outW, height: outH, batchSize: batch, chunkFrames: 0, contextFrames: 0, seamFrames: 0 };
  }

  const wantedSeconds = Math.max(0.5, Math.min(120, Number(settings.chunkSeconds ?? RESTORE_DEFAULTS.chunkSeconds) || 4));
  const chunkFrames = Math.max(5, Math.min(2048, Math.max(batch, Math.round((wantedSeconds * rate) / batch) * batch)));
  let context = clampInt(settings.contextFrames ?? batch, batch, 0, 4 * batch);
  context = Math.min(Math.floor(context / batch) * batch, chunkFrames);
  let seam = Math.min(clampInt(settings.seamFrames ?? RESTORE_DEFAULTS.seamFrames, 3, 0, 32), context);

  if (previewFrames > 0) {
    // A playhead parked in the last second slides back rather than asking for
    // frames past the end.
    const start = clampInt(previewStartFrame, 0, 0, Math.max(0, total - Math.min(batch, total)));
    const length = Math.max(1, Math.min(Math.max(batch, Math.round(previewFrames / batch) * batch), total - start));
    return {
      frames: total, fps: rate, width: outW, height: outH, shortEdge, maxEdge,
      batchSize: batch, chunkFrames: length, contextFrames: 0, seamFrames: 0, preview: true,
      chunks: [{ index: 0, sourceStart: start, sourceLength: length, context: 0, outputLength: length }],
    };
  }

  const chunks = [];
  for (let start = 0, index = 0; start < total; start += chunkFrames, index += 1) {
    const lead = Math.min(context, start);
    const body = Math.min(chunkFrames, total - start);
    chunks.push({ index, sourceStart: start - lead, sourceLength: lead + body, context: lead, outputLength: body });
  }
  if (chunks.length < 2) seam = 0;
  return {
    frames: total, fps: rate, width: outW, height: outH, shortEdge, maxEdge,
    batchSize: batch, chunkFrames, contextFrames: context, seamFrames: seam, preview: false, chunks,
  };
}

/** How much longer a render is than the footage, because of the lead-in frames. */
export function contextOverhead(plan) {
  const body = plan.chunks.reduce((total, chunk) => total + chunk.outputLength, 0);
  const rendered = plan.chunks.reduce((total, chunk) => total + chunk.sourceLength, 0);
  return body ? rendered / body : 1;
}

/**
 * Options as the gateway names them. Only what differs from its own defaults.
 *
 * A RESUME sends almost nothing. Its plan was settled when the project started
 * and its finished chunks were rendered under it, so re-sending whatever the
 * panel happens to show now would be a set of dials the gateway is right to
 * ignore — and a user is right to expect it to honour. Which machine to
 * continue on is the one thing that can still change.
 */
export function restoreRequestBody(settings, {
  previewFrames = 0, previewStartFrame = 0, projectId = '', runOn = '', resume = false, maxSpendUsd = 0,
} = {}) {
  // The approval rides on a resume too, and it has to: a resume is a fresh
  // decision at that day's price, and the chunks already paid for are recorded
  // on the project rather than re-charged.
  const approval = Number(maxSpendUsd) > 0 ? { max_spend_usd: Number(maxSpendUsd) } : {};
  if (resume && projectId) {
    return { project_id: projectId, ...(runOn ? { run_on: runOn } : {}), ...approval };
  }
  const body = {
    model: settings.model || RESTORE_DEFAULTS.model,
    resolution: settings.resolution ?? RESTORE_DEFAULTS.resolution,
    batch_size: snapBatchSize(settings.batchSize ?? RESTORE_DEFAULTS.batchSize),
    chunk_seconds: Number(settings.chunkSeconds ?? RESTORE_DEFAULTS.chunkSeconds),
    context_frames: clampInt(settings.contextFrames, RESTORE_DEFAULTS.contextFrames, 0, 64),
    seam_frames: clampInt(settings.seamFrames, RESTORE_DEFAULTS.seamFrames, 0, 32),
    color_correction: settings.colorCorrection || RESTORE_DEFAULTS.colorCorrection,
    seed: clampInt(settings.seed, RESTORE_DEFAULTS.seed, 0, 4294967295),
  };
  if (Number(settings.maxResolution) > 0) body.max_resolution = clampInt(settings.maxResolution, 0, 0, 8192);
  if (Number(settings.temporalOverlap) > 0) body.temporal_overlap = clampInt(settings.temporalOverlap, 0, 0, 16);
  if (settings.tiledVae) body.tiled_vae = true;
  if (settings.attentionMode) body.attention_mode = settings.attentionMode;
  if (previewFrames > 0) {
    body.preview_frames = previewFrames;
    body.preview_start_frame = Math.max(0, Math.round(previewStartFrame));
  }
  if (projectId) body.project_id = projectId;
  if (runOn) body.run_on = runOn;
  return { ...body, ...approval };
}

/** Finishing options as the gateway names them. */
export function finishRequestBody(finish = {}) {
  const body = {
    sharpen: Number(finish.sharpen) || 0,
    grain: Number(finish.grain) || 0,
    skin_softening: Number(finish.skinSoftening) || 0,
    quality: clampInt(finish.quality, FINISH_DEFAULTS.quality, 8, 30),
  };
  if (finish.aspect === 'pad' || finish.aspect === 'crop') {
    body.aspect = finish.aspect;
    body.aspect_ratio = String(finish.aspectRatio || '');
  }
  return body;
}

/**
 * What is switched on inside the fold, for the closed header.
 *
 * A collapsed section that hides an active control turns a setting into
 * invisible state, which is the one way this tiering could make things worse.
 * Only values that DIFFER from RESTORE_DEFAULTS appear.
 */
export function advancedSummary(settings = {}) {
  const at = (key) => settings[key] ?? RESTORE_DEFAULTS[key];
  const colour = COLOR_CORRECTIONS.find((item) => item.id === at('colorCorrection'));
  return [
    Number(at('maxResolution')) > 0 ? `cap ${at('maxResolution')}px` : '',
    at('batchSize') !== RESTORE_DEFAULTS.batchSize ? `batch ${at('batchSize')}` : '',
    at('chunkSeconds') !== RESTORE_DEFAULTS.chunkSeconds ? `${at('chunkSeconds')}s chunks` : '',
    at('contextFrames') !== RESTORE_DEFAULTS.contextFrames ? `lead-in ${at('contextFrames')}` : '',
    at('seamFrames') !== RESTORE_DEFAULTS.seamFrames
      ? (Number(at('seamFrames')) ? `seam ${at('seamFrames')}` : 'hard cuts') : '',
    at('colorCorrection') !== RESTORE_DEFAULTS.colorCorrection ? (colour?.label || at('colorCorrection')) : '',
    Number(at('seed')) !== RESTORE_DEFAULTS.seed ? `seed ${at('seed')}` : '',
    at('tiledVae') ? 'tiled VAE' : '',
  ].filter(Boolean).join(' · ');
}

// --- what to say when a render stops -----------------------------------------

// The classes a restore actually fails in. Every one of them was, until now,
// shown to the owner as whatever `str(exc)` happened to be — a CUDA allocator
// dump, an ffmpeg stderr tail, a Python exception name — on the project card
// and in every toast. The owner's rule is that raw backend text is evidence,
// never the sentence.
//
// The same OOM test the media gateway and lib/describeFailure.js use, so the
// three ends agree on what "the card ran out" looks like.
const RESTORE_OOM = /out of memory|outofmemory|cuda error: out of memory|mps backend out of memory|allocation on device|cuda_error_out_of_memory/i;
const RESTORE_DOWNLOAD = /(download|fetch|huggingface|hf_hub|safetensors).{0,60}(failed|error|timed out)|could not download|failed to download|no such file.*\.safetensors/i;
const RESTORE_UNREACHABLE = /failed to fetch|load failed|networkerror|connection refused|econnrefused|errno 61|urlopen error|not answering|did not answer|is not listening|timed out — the lane|may be stuck/i;
const RESTORE_CANCELLED = /^stopped$|\bstopped\.|was cancelled|cancelled by/i;
const RESTORE_RENTAL_GONE = /rental|rented machine|lane '[^']+' is (?:gone|unknown)|no longer attached|lane is not attached|machine is no longer/i;
const RESTORE_SOURCE_GONE = /source clip is gone|has no staged source|upload is no longer/i;
// The reaper, seen from the studio. A project that aged out is not a render
// that failed, and the sentence for it is the retention rule rather than
// "resume" — there is nothing left to resume from.
const RESTORE_PROJECT_GONE = /no such restoration project|lost track of/i;
const RESTORE_SPEND = /spent the \$|spending limit|balance|top up/i;
const RESTORE_MODEL_MISSING = /(model|checkpoint).{0,40}(not installed|is missing|was not found)|seedvr2 nodes/i;

/**
 * → `{ title, action, detail }` for a render that stopped.
 *
 * `title` is what happened in one sentence, `action` is what to change (empty
 * when there is genuinely nothing to change), and `detail` is the raw text the
 * caller keeps behind a Details disclosure. It mirrors lib/muapiErrors.js:
 * pure, no React, no toast, so every branch is testable in node.
 *
 * Every branch that names an action names one the Restore studio can actually
 * perform — the panel's own dials, or the Resume button that sits beside this
 * card — because an action offered by a screen that cannot do it is the same
 * dead end as no action at all.
 */
export function describeRestoreFailure(error) {
  const raw = String(error?.message || error?.error || error || '').trim();
  const say = (title, action) => ({ title, action, detail: raw === title ? '' : raw });
  if (!raw) return say(t('restore.stopped'), t('restore.stoppedResume'));
  if (RESTORE_CANCELLED.test(raw)) return say(t('restore.cancelled'), t('restore.cancelledResume'));
  if (RESTORE_OOM.test(raw)) return say(t('restore.oom'), t('restore.oomFix'));
  if (RESTORE_PROJECT_GONE.test(raw)) return say(t('restore.projectGone'), t('restore.projectGoneFix'));
  if (RESTORE_SOURCE_GONE.test(raw)) return say(t('restore.sourceGone'), t('restore.sourceGoneFix'));
  if (RESTORE_DOWNLOAD.test(raw)) return say(t('restore.weightsFailed'), t('restore.weightsFailedFix'));
  if (RESTORE_MODEL_MISSING.test(raw)) return say(t('restore.modelMissing'), t('restore.modelMissingFix'));
  if (RESTORE_SPEND.test(raw)) return say(t('restore.spendReached'), t('restore.spendReachedFix'));
  if (RESTORE_RENTAL_GONE.test(raw)) return say(t('restore.rentalGone'), t('restore.rentalGoneFix'));
  if (RESTORE_UNREACHABLE.test(raw)) return say(t('restore.unreachable'), t('restore.unreachableFix'));
  return say(t('restore.stopped'), t('restore.stoppedDetail'));
}

/** The same reading where there is only room for one line — a toast, a row. */
export function restoreFailureLine(error) {
  const read = describeRestoreFailure(error);
  return read.action ? `${read.title} ${read.action}` : read.title;
}

// --- what to say about a machine ---------------------------------------------

/**
 * One sentence per lane, and it has to be the truthful one.
 *
 * A rented machine is the paid rail whether or not it is faster, because it
 * bills by the hour while it thinks. Saying that beside the button is the whole
 * difference between "the free version" and "the paid version" being a real
 * choice rather than a surprise on the invoice.
 */
export function describeLane(lane) {
  if (!lane) return '';
  if (!lane.available) {
    const missing = (lane.missing || []).join(', ');
    return `${t('place.thisMac')} has no SeedVR2 nodes${missing ? ` (missing ${missing})` : ''}.`;
  }
  if (lane.lane === CLOUD_LANE) {
    return 'Hosted GPU, billed per render in your HivemindOS credits. Nothing is rented and nothing runs between renders — and the price is quoted before anything is sent. This is the one machine your footage leaves this computer to reach.';
  }
  if (lane.paid) {
    return 'Rented GPU — billed by the hour for as long as it is rented. Chunks come back sealed and are joined here in the browser, so its seams are hard cuts.';
  }
  return `${t('place.thisMac')} — free. Chunks are kept losslessly here, so seams dissolve and the finish can be redone any time.`;
}

/**
 * What a machine's VAE acceleration is doing, in one line.
 *
 * Four different states that all look the same from a distance, and only some
 * of them are anybody's problem: not installed (a re-provision), installed but
 * this card is not NVIDIA (nothing to do), installed and working (say the
 * MEASURED speedup, never a promise), or working but nothing built yet.
 * "TensorRT: off" with no reason is indistinguishable from a bug.
 */
export function describeTensorRt(lane) {
  const trt = lane?.tensorrt;
  if (!trt) return '';
  if (trt.available) {
    if (trt.speedup > 1) {
      return `TensorRT VAE decode — measured ${trt.speedup}x faster on this machine`;
    }
    return 'TensorRT ready — the first chunk builds the engine, every chunk after it reuses it';
  }
  // The lane's own sentence, verbatim: each one already explains itself, and
  // prefixing "No TensorRT —" onto a sentence that ends "— TensorRT is NVIDIA
  // only" reads as two dashes and one thought.
  const reason = String(trt.reason || '').trim();
  if (reason) return reason.charAt(0).toUpperCase() + reason.slice(1);
  return 'No TensorRT on this machine';
}

/** Whether it is worth showing the acceleration line at all for this lane. */
export function laneHasTensorRt(lane) {
  return Boolean(lane?.tensorrt?.available);
}

export function describeChunkPlan(plan) {
  if (!plan?.chunks?.length) return '';
  const count = plan.chunks.length;
  const seconds = plan.chunkFrames / (plan.fps || 24);
  return `${count} chunk${count === 1 ? '' : 's'} of about ${seconds.toFixed(1)}s → ${plan.width}x${plan.height}`;
}

/** An ETA only ever extrapolated from chunks this project actually finished. */
export function describeEta(progress) {
  const seconds = Number(progress?.eta_seconds) || 0;
  if (!seconds) return '';
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'under a minute left';
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours}h ${minutes % 60}m left`;
}

// --- reading the file the owner picked ---------------------------------------

/**
 * Frames, rate and size of a local file — exactly, not estimated.
 *
 * `<video>` gives duration and dimensions but no frame rate and no frame count,
 * and the plan is built out of FRAMES: a clip guessed at 30fps that is really
 * 23.976 plans the wrong number of chunks and reports a length the master will
 * not match. mediabunny (already here, for the client-side clip join) demuxes
 * without decoding, so this is a packet count rather than an assumption.
 */
export async function measureClip(file) {
  const { ALL_FORMATS, BlobSource, Input } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('That file has no video track to restore.');
  const stats = await track.computePacketStats();
  const duration = await input.computeDuration([track]);
  const fps = Number(stats.averagePacketRate) || (duration ? stats.packetCount / duration : 24);
  return {
    frames: Number(stats.packetCount) || Math.max(1, Math.round(duration * fps)),
    fps,
    duration,
    width: track.displayWidth || track.codedWidth || 0,
    height: track.displayHeight || track.codedHeight || 0,
    hasAudio: Boolean(await input.getPrimaryAudioTrack()),
  };
}

// --- getting the clip to the machine ------------------------------------------

// What the gateway will take when it has not said. A restore source is the one
// upload in this app that is routinely hundreds of megabytes, and the capability
// payload carries the real number (`max_source_bytes`) — this is only the figure
// to reason with while that is still in flight.
export const DEFAULT_MAX_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;

export function maxSourceBytes(capabilities) {
  const advertised = Number(capabilities?.max_source_bytes
    ?? capabilities?.retention?.max_source_bytes);
  return Number.isFinite(advertised) && advertised > 0 ? advertised : DEFAULT_MAX_SOURCE_BYTES;
}

export function describeBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  return `${Math.round(value / (1024 * 1024))}MB`;
}

/**
 * Is this clip past the machine's ceiling — said BEFORE the upload, with the
 * fix in the same sentence.
 *
 * The old transport discovered this after building a base64 string of the whole
 * file, which is to say after the wait, and then only as "could not be started".
 * Returns '' when the file fits.
 */
export function sourceTooLargeAdvice(file, capabilities) {
  const size = Number(file?.size) || 0;
  const ceiling = maxSourceBytes(capabilities);
  if (!size || size <= ceiling) return '';
  return tf('restore.tooLarge', describeBytes(size), describeBytes(ceiling));
}

/** How long the machine keeps a project's working files, in one line. */
export function describeRetention(capabilities) {
  const days = Number(capabilities?.retention?.project_ttl_days) || 0;
  if (days <= 0) return '';
  return tf('restore.retention', days);
}

/**
 * Stream a clip up and get back the id the start request references.
 *
 * XMLHttpRequest rather than fetch, for one reason: fetch cannot report upload
 * progress, and this is a several-minute upload of a file the owner is watching.
 * The body is the File itself — no base64, no JSON, no copy — so the browser
 * streams it from disk and this tab's memory stays flat where it used to build
 * a string a third larger than the film and then fail outright past a few
 * hundred megabytes.
 */
export function uploadRestoreSource(file, { onProgress = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/restore/upload', true);
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable && event.total > 0) {
        onProgress(Math.min(1, event.loaded / event.total));
      }
    };
    const fail = (message, status = 0, remedy = '') => {
      const error = new Error(message);
      error.status = status;
      error.remedy = remedy;
      reject(error);
    };
    request.onload = () => {
      let data = {};
      try { data = JSON.parse(request.responseText || '{}'); } catch { data = {}; }
      const detail = data?.detail;
      if (request.status >= 200 && request.status < 300 && data.source_id) {
        if (onProgress) onProgress(1);
        resolve(data);
        return;
      }
      fail(
        String(detail?.error || detail?.message || detail || data?.error
          || 'That clip could not be uploaded.'),
        request.status,
        String(detail?.remedy || data?.remedy || ''),
      );
    };
    request.onerror = () => fail('The upload stopped before it finished — check the connection and try again.');
    request.ontimeout = () => fail('The upload timed out before it finished.');
    request.onabort = () => fail('That upload was cancelled.');
    if (signal) {
      if (signal.aborted) { request.abort(); return; }
      signal.addEventListener('abort', () => request.abort(), { once: true });
    }
    request.send(file);
  });
}

// --- what a rented render costs ----------------------------------------------

/**
 * The price of a rented render, from the SAME hourly rate the Machines page
 * shows and a duration this project actually measured.
 *
 * Returns `usd: null` rather than a guess whenever either half is unknown, and
 * the panel then says "billed by the hour on that machine" — which is true —
 * instead of a figure somebody would budget against.
 */
export function estimatePrice({ usdPerHour, seconds }) {
  const hourly = Number(usdPerHour) || 0;
  const duration = Number(seconds) || 0;
  if (hourly <= 0 || duration <= 0) return { usd: null, usdPerHour: hourly || null, seconds: duration || null };
  return { usd: Math.round(((hourly * duration) / 3600) * 100) / 100, usdPerHour: hourly, seconds: duration };
}

export function describePrice(estimate) {
  if (!estimate) return '';
  if (estimate.usd == null) {
    if (!estimate.usdPerHour) return 'Billed by the hour on that machine.';
    return `$${estimate.usdPerHour}/hr — the estimate needs one finished chunk before it means anything.`;
  }
  const minutes = Math.max(1, Math.round(estimate.seconds / 60));
  return `About $${estimate.usd.toFixed(2)} — ${minutes} min at $${estimate.usdPerHour}/hr`;
}

/**
 * What a hosted render costs, as a person reads it.
 *
 * The figure comes from the SERVICE, not from arithmetic here: it is the sum of
 * what each chunk will actually be invoiced at, floor and rounding included, so
 * that the number on the button is the number on the bill rather than a
 * smoother one the invoices then exceed. `null` when it could not be priced —
 * an unpriced lane is offered as unpriced, never as free.
 */
export function describeCloudPrice(quote) {
  const total = Number(quote?.totalUsd);
  if (!Number.isFinite(total) || total <= 0) return '';
  const chunks = quote?.chunks?.length || 0;
  const money = total < 1 ? `${Math.round(total * 100)}¢` : `$${total.toFixed(2)}`;
  return `About ${money} for this render — ${chunks} ${chunks === 1 ? 'chunk' : 'chunks'}, charged as each one finishes.`;
}

/**
 * The ceiling to send back with the render.
 *
 * The service refuses rather than charges when its own price exceeds what was
 * approved, so this is what makes the figure the panel showed binding. A little
 * headroom, because a chunk that prices a cent higher than the quote should
 * finish the render rather than stop it — but not so much that a price which
 * genuinely moved goes through unnoticed.
 */
export function approvedSpendUsd(quote) {
  const total = Number(quote?.totalUsd);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.round(total * 1.1 * 100) / 100;
}

/** The rented machine behind a lane, from the Machines list. Null when local. */
export async function rentalForLane(laneName) {
  if (!laneName || laneName === 'default') return null;
  try {
    const response = await fetch('/api/gpu-rentals', { credentials: 'same-origin' });
    if (!response.ok) return null;
    const data = await response.json();
    const rentals = Array.isArray(data.rentals) ? data.rentals : [];
    return rentals.find((item) => String(item.lane || '') === String(laneName)) || null;
  } catch {
    return null;
  }
}

// --- gateway calls -----------------------------------------------------------

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(String(data?.detail?.error || data?.detail?.message || data?.detail || data?.error || 'The restore service refused that.'));
    error.operational = Boolean(data?.operational);
    // The refusal names its repair — an unconnected account, an empty balance —
    // so the caller can offer the button instead of the sentence alone.
    error.remedy = String(data?.detail?.remedy || data?.remedy || '');
    throw error;
  }
  return data;
}

/** Which machines can restore, and which of them costs money. Never throws. */
export async function restoreCapabilities() {
  try {
    const response = await fetch('/api/restore/capabilities', { credentials: 'same-origin' });
    if (!response.ok) return { lanes: [], any: false };
    return await response.json();
  } catch {
    return { lanes: [], any: false };
  }
}

/**
 * The plan the GATEWAY would run — and, for the hosted lane, its price.
 *
 * The studio does this arithmetic itself (see `planRestore`) so it can put
 * "14 chunks, 2560x1440" on screen while the file is still in the picker. This
 * is the other copy: the one that decides. It is asked when the hosted lane is
 * selected, because that is when there is a second thing only the server knows
 * — what the render will cost — and because it is worth the two copies meeting
 * before money is involved rather than after.
 *
 * Never throws: an unpriced lane is a lane the panel says it cannot price.
 */
export async function fetchRestorePlan({
  frames, fps, width, height, settings = {}, runOn = '', previewFrames = 0, previewStartFrame = 0,
}) {
  try {
    const response = await fetch('/api/restore/plan', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        frames, fps, width, height,
        // NESTED, not flat. The gateway's plan route reads its dials from
        // `options`; the start route reads them from the top level. Sending
        // them flat here returns a plan built entirely from defaults, which
        // looks like a working answer and is not one.
        options: restoreRequestBody(settings, { runOn, previewFrames, previewStartFrame }),
      }),
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    return data && data.plan ? data : null;
  } catch {
    return null;
  }
}

/** Start (or resume) a render against a source already streamed up. */
export async function startRestore({ sourceId = '', ...rest }) {
  return readJson(await fetch('/api/restore', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...restoreRequestBody(rest.settings || {}, rest),
      ...(sourceId ? { source_id: sourceId } : {}),
    }),
  }));
}

export async function fetchRestoreProjects() {
  try {
    const response = await fetch('/api/restore/projects', { credentials: 'same-origin' });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data.projects) ? data.projects : [];
  } catch {
    return [];
  }
}

export async function fetchRestoreProject(projectId) {
  return readJson(await fetch(`/api/restore/project/${encodeURIComponent(projectId)}`, { credentials: 'same-origin' }));
}

export async function stopRestore(projectId) {
  return readJson(await fetch(`/api/restore/cancel/${encodeURIComponent(projectId)}`, {
    method: 'POST', credentials: 'same-origin',
  }));
}

export async function deleteRestoreProject(projectId) {
  return readJson(await fetch(`/api/restore/delete/${encodeURIComponent(projectId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }));
}

/**
 * Re-finish from the saved chunks — or, for a rented project, from the join.
 *
 * `sourceId` names a clip this tab already streamed up (the master it joined
 * out of the sealed chunks). Same transport as the source, for the same reason:
 * a joined 4K master is the biggest file in the whole feature.
 */
export async function finishRestore(projectId, finish, sourceId = '') {
  return readJson(await fetch('/api/restore/finish', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: projectId,
      finish: finishRequestBody(finish),
      ...(sourceId ? { source_id: sourceId } : {}),
    }),
  }));
}

/** Sealed chunk clips, in order, as the gateway serves them. */
export function chunkOutputUrls(project) {
  const plan = project?.plan || {};
  const chunks = project?.chunks || {};
  return (plan.chunks || [])
    .map((chunk) => chunks[String(chunk.index)]?.output)
    .filter(Boolean)
    .map((name) => `/api/media-studio/gateway/${encodeURIComponent(name)}`);
}
