// Is the studio running? One shared answer, kept fresh by a heartbeat.
//
// This used to be a single ping behind a `pinged` latch, so the verdict was
// decided at boot and never revisited: a session that opened while the studio
// was restarting said "not running" for the rest of its life, and a session
// whose studio died mid-flight kept saying "ready" while every press failed on
// its own. Offline is a state the whole app shares, not a pill frozen at boot.
import { useSyncExternalStore } from 'react';

// /healthz answers before the owner gate, so a locked account still gets a
// truthful "the studio is up" rather than a 401 read as death.
const HEALTH_PATH = '/healthz';
const PROBE_TIMEOUT_MS = 6000;
export const BEAT_MS = 15000;
export const MAX_BACKOFF_MS = 60000;

// Three words, no backend name: the user installed one thing.
const LABELS = { online: 'Ready', connecting: 'Starting', offline: 'Not running' };
const ZH_LABELS = { online: '就绪', connecting: '启动中', offline: '未运行' };

/** The pill label in the reader's language. */
export function apiStatusLabel(status, zh) {
  const tone = status?.tone || 'connecting';
  if (zh) return ZH_LABELS[tone] || ZH_LABELS.connecting;
  return status?.label || LABELS[tone] || LABELS.connecting;
}

// Never a problem without its fix: the one sentence and the one command live
// here, so the pill, the studio banner and anything else that has to explain
// the offline state all say exactly the same thing.
// TODO(tauri): when the desktop shell is in, replace the command with a
// "Restart studio" action wired to the supervisor sidecar.
export const STUDIO_RESTART_COMMAND = 'scripts/hivemind-studio-stack restart';

export function apiOfflineSentence(zh) {
  return zh
    ? '工作室的本地服务没有响应，生成暂时无法运行。在终端里运行下面这行重新启动它：'
    : 'The studio’s local service is not answering, so nothing can generate. Start it again by running:';
}

let state = { tone: 'connecting', online: false, since: null, label: LABELS.connecting };
const listeners = new Set();

export function setApiStatus(tone, label) {
  const next = tone === 'online' ? 'online' : tone === 'offline' ? 'offline' : 'connecting';
  const changed = next !== state.tone;
  state = {
    tone: next,
    online: next === 'online',
    // When this verdict started holding — "not running for the last 3 minutes"
    // is a different sentence from "not running for the last 3 seconds".
    since: changed || state.since == null ? Date.now() : state.since,
    label: label || LABELS[next],
  };
  listeners.forEach((fn) => fn(state));
  return changed;
}

export function getApiStatus() {
  return state;
}

export function subscribeApiStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Subscribe a component to {online, since, label, tone}. */
export function useApiStatus() {
  return useSyncExternalStore(subscribeApiStatus, getApiStatus, getApiStatus);
}

/**
 * How long until the next beat. Live sessions ask every 15 s; a studio that is
 * down is asked less and less often, up to a minute, so a laptop left on an
 * offline app is not spinning a request every quarter minute all afternoon.
 */
export function heartbeatDelay({ online = false, failures = 0 } = {}) {
  if (online) return BEAT_MS;
  return Math.min(MAX_BACKOFF_MS, BEAT_MS * 2 ** Math.max(0, failures - 1));
}

let timer = null;
let running = false;
let inflight = false;
let failures = 0;
// Our own reconnect refresh must not be read back as "somebody asked for a
// refresh", or a recovery would beat twice.
let selfDispatch = false;

const hidden = () => typeof document !== 'undefined' && document.hidden === true;

async function probe() {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const abort = controller ? setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS) : null;
  try {
    const response = await fetch(HEALTH_PATH, { signal: controller?.signal, cache: 'no-store' });
    if (!response?.ok) return false;
    // A 200 is not enough: a static host (or the dev server) answers an unknown
    // path with index.html, and "the page loaded" is not "the studio is up".
    const body = await response.json();
    return body?.ok !== false;
  } catch {
    return false;
  } finally {
    if (abort !== null) clearTimeout(abort);
  }
}

function schedule() {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  if (!running) return;
  timer = setTimeout(() => { timer = null; scheduledBeat(); }, heartbeatDelay({ online: state.online, failures }));
}

// A hidden tab is a tab nobody is reading: the beat pauses rather than polling a
// background window, and visibilitychange asks again the moment it comes back.
function scheduledBeat() {
  if (hidden()) { schedule(); return; }
  void pingApiStatus();
}

/** Ask now. This is what "Retry now" calls, and it runs even in a hidden tab. */
export async function pingApiStatus() {
  if (inflight) return state;
  inflight = true;
  let ok = false;
  try {
    ok = await probe();
  } finally {
    inflight = false;
  }
  // Only a recovery from a KNOWN-down studio is a reconnect: the first verdict
  // of a session has nothing stale behind it to refill.
  const wasOffline = state.tone === 'offline';
  failures = ok ? 0 : failures + 1;
  setApiStatus(ok ? 'online' : 'offline');
  if (ok && wasOffline) {
    // Everything that cached a server answer while it was down — the hub poll,
    // the studios' workflow lists — refills on this one event, so coming back
    // does not need a reload.
    selfDispatch = true;
    try {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('hivemind-hub-refresh'));
    } catch { /* no window (tests, SSR) */ } finally {
      selfDispatch = false;
    }
  }
  schedule();
  return state;
}

const onWake = () => { if (!hidden()) void pingApiStatus(); };
const onHubRefresh = () => { if (!selfDispatch) onWake(); };

/** Start the heartbeat. Idempotent; returns the stopper. */
export function startApiHeartbeat() {
  if (running) return stopApiHeartbeat;
  running = true;
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onWake);
    window.addEventListener('hivemind-hub-refresh', onHubRefresh);
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', onWake);
  }
  void pingApiStatus();
  return stopApiHeartbeat;
}

export function stopApiHeartbeat() {
  running = false;
  failures = 0;
  if (timer !== null) { clearTimeout(timer); timer = null; }
  if (typeof window !== 'undefined') {
    window.removeEventListener('online', onWake);
    window.removeEventListener('hivemind-hub-refresh', onHubRefresh);
  }
  if (typeof document !== 'undefined' && document.removeEventListener) {
    document.removeEventListener('visibilitychange', onWake);
  }
}
