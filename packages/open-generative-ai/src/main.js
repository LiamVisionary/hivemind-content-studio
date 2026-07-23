import './style.css';
import './lib/browserLocalAI.js';
import { AppShell } from './components/AppShell.js';
import { ImageStudio } from './components/ImageStudio.js';
import { installHivemindExploreDock } from './lib/hivemindStudio.js';
import { installVaultRecoveryBanner } from './lib/vaultRecoveryBanner.js';

const app = document.querySelector('#app');

// Native studio pages — each builder returns a fresh element.
const builders = {
  image: () => ImageStudio(),
  video: () => import('./components/VideoStudio.js').then((m) => m.VideoStudio()),
  cinema: () => import('./components/CinemaStudio.js').then((m) => m.CinemaStudio()),
  lipsync: () => import('./components/LipSyncStudio.js').then((m) => m.LipSyncStudio()),
  'mcp-cli': () => import('./components/McpCliStudio.js').then((m) => m.McpCliStudio()),
};

// Hub pages — one persistent root (views ported from the 8765 hub SPA).
// The hub layer is hidden rather than detached on page switches so the
// Canvas/Models iframes keep their state instead of reloading.
const HUB_PAGES = {
  planner: 'create',
  canvas: 'canvas',
  models: 'models',
  runs: 'runs',
  history: 'history',
  telemetry: 'telemetry',
  providers: 'providers',
};

let currentPage = null;
let navToken = 0;
let hubLayer = null;

// A rebuilt dist replaces the hashed chunk files, so sessions opened before the
// rebuild 404 when they lazy-import a studio. One forced reload fetches the fresh
// index.html; the timestamp guard stops reload loops when the server is really broken.
const CHUNK_RELOAD_KEY = 'studio.chunkReloadedAt';
function recoverFromStaleChunks(error) {
  const message = String(error?.message || error || '');
  if (!/dynamically imported module|Importing a module script failed/i.test(message)) return;
  let lastReload = 0;
  try { lastReload = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY)) || 0; } catch { /* non-critical */ }
  if (Date.now() - lastReload < 60_000) return;
  try { sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now())); } catch { /* non-critical */ }
  window.location.reload();
}

// A failed lazy import (dist rebuilt mid-session, stack restarting under the
// user) used to silently snap the rail back to the previous view until the
// user toggled away and back. One immediate retry absorbs those transient
// failures; a genuinely stale chunk still reaches recoverFromStaleChunks.
async function loadPageModule(loader) {
  try { return await loader(); }
  catch { return loader(); }
}

// Router: switching tabs rebuilds the target studio (so each view re-runs its own setup,
// e.g. the video view re-loading its LTX workflow catalog). The one guard: re-pressing the
// tab you're ALREADY on is a no-op, so it never tears down a live view mid-generation.
// currentPage is only committed after a successful mount — a failed lazy import must
// leave the router retryable instead of bricking the tab on the no-op guard.
async function navigate(page) {
  if (!contentArea || (!builders[page] && !HUB_PAGES[page])) return;
  if (page === currentPage) return;   // active-tab re-press: keep the live view, clear nothing
  const token = ++navToken;
  shell.setActive(page);

  // Keep the URL shareable/bookmarkable without triggering a reload. Updated up
  // front so a stale-chunk recovery reload lands on the page the user asked for.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('page', page);
    window.history.replaceState(null, '', url);
  } catch { /* non-critical */ }

  if (HUB_PAGES[page]) {
    let hub;
    try {
      hub = await loadPageModule(() => import('./views/hub/hubApp.js'));
    } catch (error) {
      console.error(`[studio] failed to load hub view "${page}":`, error);
      if (token === navToken) shell.setActive(currentPage || 'image');
      recoverFromStaleChunks(error);
      return;
    }
    if (token !== navToken) return;
    currentPage = page;
    if (!hubLayer) {
      hubLayer = hub.ensureHub();
      hubLayer.style.flex = '1 1 auto';
      hubLayer.style.minHeight = '0';
      hubLayer.style.height = '';
      contentArea.appendChild(hubLayer);
    }
    hub.setActiveHubView(HUB_PAGES[page]);
    studioLayer.replaceChildren();
    studioLayer.style.display = 'none';
    hubLayer.style.display = '';
    return;
  }

  let el;
  try {
    el = await loadPageModule(builders[page]);
  } catch (error) {
    console.error(`[studio] failed to load "${page}" view:`, error);
    if (token === navToken) shell.setActive(currentPage || 'image');
    recoverFromStaleChunks(error);
    return;
  }
  if (token !== navToken) return;      // a newer navigation superseded this one; keep old view
  currentPage = page;

  studioLayer.replaceChildren();
  if (el) studioLayer.appendChild(el);
  studioLayer.style.display = '';
  if (hubLayer) hubLayer.style.display = 'none';
}

app.innerHTML = '';
const shell = AppShell(navigate);
const contentArea = shell.contentArea;
app.appendChild(shell.root);

// Layer that hosts the native studios (rebuilt per navigation).
const studioLayer = document.createElement('div');
studioLayer.className = 'flex min-h-0 flex-1 flex-col';
contentArea.appendChild(studioLayer);

installHivemindExploreDock();
installVaultRecoveryBanner();

// Initial Route
const requestedPage = new URLSearchParams(window.location.search).get('page');
navigate(builders[requestedPage] || HUB_PAGES[requestedPage] ? requestedPage : 'image');

// Event Listener for Navigation
window.addEventListener('navigate', (e) => {
  if (e.detail.page === 'settings') {
    import('./components/SettingsModal.js').then(({ SettingsModal }) => {
      document.body.appendChild(SettingsModal());
    });
  } else {
    navigate(e.detail.page);
  }
});
