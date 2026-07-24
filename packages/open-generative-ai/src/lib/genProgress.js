// Shared generation-progress helpers, used by BOTH the video and image studios.
//
// - computeSmoothProgress: a smooth, MONOTONIC bar value (0-1). It advances by
//   elapsed/estimate and is nudged UP (never down) by any real backend fraction,
//   so it never stalls or jumps backward. Capped just below 1 until the finished
//   result actually lands (the caller sets 1 then). Video has real per-pass
//   progress to correct with; image generation has none, so it runs purely on
//   time — same function, realFraction just stays 0.
//
// - A tiny CLIENT-SIDE per-signature duration store (localStorage). Image
//   generation reaches the Python control_api only as a transparent proxy and its
//   backends emit no real progress, so — unlike video — the browser is the only
//   place that knows the real submit->done wall time. Keyed by an opaque signature
//   of the time-affecting params (model, steps, quality, dims, ...) — NEVER prompt
//   text — so similar runs can show elapsed / expected.

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

const TIMINGS_KEY = 'generation_timings_v1';
const MAX_PER_SIGNATURE = 10;

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

// Median of recent durations for this exact signature, else `fallback`.
export function estimateGenerationSeconds(signature, fallback = null) {
  if (!signature) return fallback;
  const samples = readTimings()[signature];
  const valid = Array.isArray(samples) ? samples.filter((n) => Number.isFinite(n) && n > 0) : [];
  if (valid.length) return Math.round(median(valid) * 10) / 10;
  return fallback != null ? fallback : null;
}

export function recordGenerationSeconds(signature, seconds) {
  if (!signature || !(seconds > 0) || seconds > 86400) return;
  try {
    const all = readTimings();
    const arr = Array.isArray(all[signature]) ? all[signature].filter((n) => Number.isFinite(n) && n > 0) : [];
    arr.push(Math.round(seconds * 100) / 100);
    all[signature] = arr.slice(-MAX_PER_SIGNATURE);
    localStorage.setItem(TIMINGS_KEY, JSON.stringify(all));
  } catch { /* quota — timings are best-effort */ }
}
