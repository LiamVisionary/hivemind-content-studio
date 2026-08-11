// Shared generation-progress helpers, used by BOTH the video and image studios.
//
// - computeSmoothProgress: a smooth, MONOTONIC bar value (0-1). It advances by
//   elapsed/estimate and is nudged UP (never down) by any real backend fraction,
//   so it never stalls or jumps backward. Capped just below 1 until the finished
//   result actually lands (the caller sets 1 then). Video has real per-pass
//   progress to correct with; image generation has none, so it runs purely on
//   time — same function, realFraction just stays 0.
//
// - A tiny CLIENT-SIDE duration store (localStorage). Image generation reaches
//   the Python control_api only as a transparent proxy and its backends emit no
//   real progress, so — unlike video — the browser is the only place that knows
//   the real submit->done wall time. Durations are keyed by an opaque signature
//   of the params that change the COST PROFILE (model, adapters, ...) — NEVER
//   prompt text — and tagged with the run's WORK UNITS (steps x megapixels),
//   which are what actually scale the duration. That split is what lets a run
//   measured at 4 steps estimate the same run at 8 steps as roughly double,
//   instead of falling back to a flat constant.

export function computeSmoothProgress({ elapsedSec = 0, estimateSec = 0, realFraction = 0, prevDisplay = 0 } = {}) {
  const timeFraction = estimateSec > 0 ? elapsedSec / estimateSec : 0;
  const real = Number.isFinite(realFraction) ? realFraction : 0;
  const target = Math.min(0.985, Math.max(timeFraction, real));
  return Math.max(Number(prevDisplay) || 0, target);
}

export function formatElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

const TIMINGS_KEY = 'generation_timings_v2';
// Per key, across every work value seen — enough to keep a few distinct step /
// resolution combinations alive so the fit below has two points to work with.
const MAX_PER_KEY = 30;

function readTimings() {
  try {
    const value = JSON.parse(localStorage.getItem(TIMINGS_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const roundWork = (work) => Math.round((Number(work) || 0) * 1000) / 1000;
const roundSeconds = (seconds) => Math.round(Number(seconds) * 10) / 10;

// Duration model: seconds ~= overhead + rate * work. Generation cost is very
// close to linear in both step count and pixel count, so measured runs scale to
// unmeasured configurations:
//   - an exact work match wins outright (it already carries every nonlinearity)
//   - a single measured work value scales proportionally
//   - two or more separate the fixed per-run overhead (model load, VAE decode,
//     upload) from the part that actually grows with steps/pixels
// `samples` is a list of [work, seconds] pairs. Returns null when unusable.
export function estimateSecondsForWork(samples, work) {
  const target = roundWork(work);
  if (!(target > 0) || !Array.isArray(samples)) return null;

  const byWork = new Map();
  for (const sample of samples) {
    const sampleWork = roundWork(Array.isArray(sample) ? sample[0] : sample?.work);
    const seconds = Number(Array.isArray(sample) ? sample[1] : sample?.seconds);
    if (!(sampleWork > 0) || !Number.isFinite(seconds) || seconds <= 0) continue;
    if (!byWork.has(sampleWork)) byWork.set(sampleWork, []);
    byWork.get(sampleWork).push(seconds);
  }
  if (!byWork.size) return null;
  if (byWork.has(target)) return roundSeconds(median(byWork.get(target)));

  const points = [...byWork.entries()]
    .map(([sampleWork, list]) => [sampleWork, median(list)])
    .sort((a, b) => a[0] - b[0]);
  if (points.length > 1) {
    const [lowWork, lowSeconds] = points[0];
    const [highWork, highSeconds] = points[points.length - 1];
    const rate = (highSeconds - lowSeconds) / (highWork - lowWork);
    const overhead = lowSeconds - rate * lowWork;
    // A flat/negative slope or a negative intercept means these samples are
    // dominated by noise rather than by work — scale off the nearest point.
    if (rate > 0 && overhead >= 0) return roundSeconds(overhead + rate * target);
  }
  const nearest = points.reduce((best, point) => (
    Math.abs(point[0] - target) < Math.abs(best[0] - target) ? point : best
  ));
  return roundSeconds(nearest[1] * (target / nearest[0]));
}

// Expected seconds for `work` units under `key`, from recorded runs. Falls back
// to `fallbackSecondsPerUnit` * work so a first-ever run still scales with its
// step count and resolution instead of showing one flat guess.
export function estimateGenerationSeconds(key, work = 1, fallbackSecondsPerUnit = null) {
  const units = roundWork(work) > 0 ? roundWork(work) : 1;
  const measured = key ? estimateSecondsForWork(readTimings()[key], units) : null;
  if (measured != null && measured > 0) return measured;
  const rate = Number(fallbackSecondsPerUnit);
  return rate > 0 ? roundSeconds(rate * units) : null;
}

export function recordGenerationSeconds(key, work, seconds) {
  const units = roundWork(work);
  if (!key || !(units > 0) || !(seconds > 0) || seconds > 86400) return;
  try {
    const all = readTimings();
    const kept = Array.isArray(all[key])
      ? all[key].filter((entry) => Array.isArray(entry) && entry[0] > 0 && entry[1] > 0)
      : [];
    kept.push([units, Math.round(seconds * 100) / 100]);
    all[key] = kept.slice(-MAX_PER_KEY);
    localStorage.setItem(TIMINGS_KEY, JSON.stringify(all));
  } catch { /* quota — timings are best-effort */ }
}

// Fold Spectrum's two passes back into the steps the user actually chose.
//
// MiniMax H3 runs with Spectrum's offline smoothing replay, which samples the
// schedule TWICE (a capture pass, then a replay pass) and reports progress
// across both — comfyui_spectrum_h3/sampling.py sets `total_work = steps * 2`.
// So Standard (15 steps) counted to 30 on screen and High detail (32) to 64,
// flatly contradicting the Refinement control that had just promised 15 or 32.
// Only an EXACT doubling is folded; any other total is passed through, so a
// workflow that genuinely runs a different count still reports the truth.
export function normalizeSamplerSteps(step, stepTotal, requestedSteps) {
  const total = Number(stepTotal) || 0;
  const current = Math.max(0, Number(step) || 0);
  const asked = Number(requestedSteps) || 0;
  if (total <= 0) return null;
  if (asked > 0 && total === asked * 2) {
    // Round up so the first tick of a pass reads as being in that step, and
    // clamp so the replay pass cannot run the label past the total.
    return { step: Math.min(asked, Math.ceil(current / 2)), total: asked };
  }
  return { step: current, total };
}
