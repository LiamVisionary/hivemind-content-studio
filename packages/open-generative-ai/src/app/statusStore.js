// Tiny pub/sub for the topbar API status pill.
// The hub data layer reports here (replaces the old #hub-api-status DOM mutation).
let state = { tone: 'connecting', label: 'Connecting' }; // tone: 'connecting' | 'online' | 'offline'
const listeners = new Set();

export function setApiStatus(tone, label) {
  state = { tone, label: label || (tone === 'online' ? 'Online' : tone === 'offline' ? 'API unavailable' : 'Connecting') };
  listeners.forEach((fn) => fn(state));
}

export function getApiStatus() {
  return state;
}

export function subscribeApiStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// The hub data layer only reports once a hub page has been visited, so a session
// that opens on a studio used to show "Connecting" until the user happened to
// click Planner or History. One cheap ping at boot settles the pill; the hub's
// refresh loop keeps it honest afterwards. /api/catalog is machine-allowed, so
// a 401 from a locked account still means "the API is up".
let pinged = false;
export async function pingApiStatus() {
  if (pinged) return;
  pinged = true;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch('/api/catalog', { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (state.tone !== 'connecting') return; // the hub got there first
    setApiStatus(response.ok || response.status === 401 || response.status === 403 ? 'online' : 'offline',
      response.ok || response.status === 401 || response.status === 403 ? 'Local API ready' : 'API unavailable');
  } catch {
    if (state.tone === 'connecting') setApiStatus('offline', 'API unavailable');
  }
}
