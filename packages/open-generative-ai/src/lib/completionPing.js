// Completion ping — the SINGLE SOURCE OF TRUTH for the "your generation is
// done" chime, shared by every studio (image, video, …).
//
// One WebAudio context, one two-note chime, one preference. The toggle used to
// live inside the video studio only; it is now a global UI setting stored in
// localStorage (non-sensitive — no prompt/media data), so flipping it in any
// studio applies everywhere and survives a reload.
//
// Autoplay policy: browsers only let audio start from a user gesture, so call
// primeCompletionPing() synchronously from the Generate click (it plays a
// silent 10ms blip to unlock the context) and playCompletionPing() when the
// result lands.

const PING_PREF_KEY = 'completion_ping_enabled';
// Legacy locations of the video-studio-only toggle, read once for migration.
const LEGACY_VIDEO_PREFS_KEY = 'video_generation_preferences';
const LEGACY_VIDEO_SESSION_KEY = 'video_ping_when_complete';

let audioContext = null;
const listeners = new Set();

function readStoredPreference() {
  try {
    const stored = localStorage.getItem(PING_PREF_KEY);
    if (stored != null) return stored === '1';
  } catch { /* no local storage */ }
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_VIDEO_PREFS_KEY) || 'null');
    if (legacy && typeof legacy.pingWhenComplete === 'boolean') return legacy.pingWhenComplete;
  } catch { /* corrupted prefs */ }
  try { return sessionStorage.getItem(LEGACY_VIDEO_SESSION_KEY) === '1'; } catch { /* no session storage */ }
  return false;
}

let enabled = readStoredPreference();

export function isCompletionPingEnabled() {
  return enabled;
}

export function setCompletionPingEnabled(next) {
  enabled = Boolean(next);
  try { localStorage.setItem(PING_PREF_KEY, enabled ? '1' : '0'); } catch { /* quota */ }
  listeners.forEach((listener) => {
    try { listener(enabled); } catch { /* listener owns its errors */ }
  });
  return enabled;
}

// Studios subscribe so a toggle flipped in one place re-renders the other.
export function subscribeCompletionPing(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getAudioContext() {
  if (typeof window === 'undefined') return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContextClass();
  return audioContext;
}

async function runningAudioContext() {
  if (!enabled) return null;
  const context = getAudioContext();
  if (!context) return null;
  if (context.state !== 'running') await context.resume();
  return context.state === 'running' ? context : null;
}

// Call from the Generate click so the chime is allowed to play later.
export async function primeCompletionPing() {
  try {
    const context = await runningAudioContext();
    if (!context) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.01);
  } catch (error) {
    console.warn('[completionPing] could not be enabled:', error?.message || 'audio unavailable');
  }
}

export async function playCompletionPing() {
  try {
    const context = await runningAudioContext();
    if (!context) return;
    const start = context.currentTime + 0.02;
    [[659.25, start, 0.2], [880, start + 0.16, 0.34]].forEach(([frequency, noteStart, duration]) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.linearRampToValueAtTime(0.2, noteStart + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + duration);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + duration + 0.02);
    });
  } catch (error) {
    console.warn('[completionPing] could not play:', error?.message || 'audio unavailable');
  }
}
