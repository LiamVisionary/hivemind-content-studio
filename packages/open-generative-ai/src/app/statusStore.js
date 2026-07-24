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
