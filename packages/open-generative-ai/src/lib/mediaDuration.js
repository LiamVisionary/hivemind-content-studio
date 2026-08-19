// How long an attached reference actually runs.
//
// Metadata only: a detached <video>/<audio> with preload="metadata" reports its
// duration after a few KB of container header, without decoding a single frame.
// That matters because this runs over every attached reference to build the H3
// budget, and mediabunny's probeClip — which DOES decode — is far too heavy to
// point at nine references just to read a number the container already carries.
//
// Sealed sources decrypt through resolveMediaSrc first, same as every other
// media path here: the server holds no key, so the measurement can only happen
// in the browser.
import { resolveMediaSrc } from './e2eMedia.js';

// Durations never change for a given url, and the panel re-renders constantly,
// so a resolved measurement is remembered for the life of the tab.
const cache = new Map();

export function peekMediaDuration(url) {
  return cache.get(url) ?? null;
}

// Resolves to seconds, or null when the file cannot be read. Null is a real
// answer here — the budget reports it as unmeasured rather than assuming zero,
// because a zero would read as a "too short" violation that is not real.
export async function measureMediaDuration(url, { kind = 'video' } = {}) {
  if (!url) return null;
  if (cache.has(url)) return cache.get(url);

  let src;
  try {
    src = await resolveMediaSrc(url);
  } catch {
    return null;
  }

  const seconds = await new Promise((resolve) => {
    const element = document.createElement(kind === 'audios' || kind === 'audio' ? 'audio' : 'video');
    element.preload = 'metadata';
    element.muted = true;
    // A file the browser cannot demux never fires either event; without this
    // the panel would wait on it forever and never show a budget at all.
    const timer = setTimeout(() => finish(null), 15000);
    function finish(value) {
      clearTimeout(timer);
      element.onloadedmetadata = null;
      element.onerror = null;
      // Drop the source so the browser releases the buffered header.
      element.removeAttribute('src');
      element.load?.();
      resolve(value);
    }
    element.onloadedmetadata = () => {
      const value = Number(element.duration);
      // Streams with no known length report Infinity; that is not a measurement.
      finish(Number.isFinite(value) && value > 0 ? value : null);
    };
    element.onerror = () => finish(null);
    element.src = src;
  });

  // Cache failures too: retrying a file that cannot be demuxed on every render
  // is how a panel with one bad reference pins a core.
  cache.set(url, seconds);
  return seconds;
}

// Measures whatever is not already known, and reports progress as it goes so
// the budget can fill in rather than appearing all at once at the end.
export async function measureAll(entries, onMeasured) {
  const out = {};
  for (const { url, kind } of entries) {
    if (!url || url in out) continue;
    const seconds = await measureMediaDuration(url, { kind });
    if (seconds != null) {
      out[url] = seconds;
      onMeasured?.(url, seconds);
    }
  }
  return out;
}
