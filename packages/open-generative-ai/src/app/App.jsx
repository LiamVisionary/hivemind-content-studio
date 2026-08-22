// Root app — router.
// - studios mount once on first visit and are display-toggled thereafter, so an
//   in-flight generation (local OR cloud) keeps running and its progress/results
//   survive a tab switch. (The old app tore studios down on every nav, which lost
//   local generations outright.) A studio with unfinished work in the pending-job
//   registry is also mounted at boot, so a reload resumes it wherever you landed.
// - the visible studio receives active=true; only it owns the prompt-insert bridge.
// - hub layer mounts once and is display-toggled forever (iframes keep state)
// - navToken guards superseded navigations; page commits only after success
// - stale-chunk recovery reloads once when a rebuilt dist 404s a lazy import
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { toast, Toaster } from 'react-hot-toast';
import { ExploreDock } from '../bridges/ExploreDock.jsx';
import { MEDIA_DOWNLOAD_BLOCKED_EVENT } from '../lib/downloadMedia.js';
import { getPendingJobs } from '../lib/pendingJobs.js';
import { OutputRestoreDropZone } from './OutputRestoreDropZone.jsx';
import { VaultRecoveryModal } from '../bridges/VaultRecoveryModal.jsx';
import { VaultUnlockModal } from '../bridges/VaultUnlockModal.jsx';
import { Spinner } from '../ui/kit.jsx';
import { HUB_PAGES, isKnownPage } from './navConfig.jsx';
import { Shell } from './Shell.jsx';
import { StudioTabs } from './StudioTabs.jsx';

// Studios that open in tabs. Each tab is a separate mount of the same studio, so
// tabs behave exactly like pages already do: independent settings, and a background
// tab's generation keeps running.
const TABBED_STUDIOS = new Set(['image', 'video']);

const STUDIO_LOADERS = {
  image: () => import('../studios/ImageStudio.jsx').then((m) => m.ImageStudio),
  video: () => import('../studios/VideoStudio.jsx').then((m) => m.VideoStudio),
  cinema: () => import('../studios/CinemaStudio.jsx').then((m) => m.CinemaStudio),
  lipsync: () => import('../studios/LipSyncStudio.jsx').then((m) => m.LipSyncStudio),
  'mcp-cli': () => import('../studios/McpCliStudio.jsx').then((m) => m.McpCliStudio),
};

const SettingsModalLazy = lazy(() => import('../dialogs/SettingsModal.jsx').then((m) => ({ default: m.SettingsModal })));

// A rebuilt dist replaces hashed chunks; sessions opened before the rebuild 404 on
// lazy imports. One forced reload fetches fresh index.html; the timestamp guard
// stops reload loops when the server is really broken.
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

// One immediate retry absorbs transient failures during dist rebuilds.
async function loadWithRetry(loader) {
  try { return await loader(); }
  catch { return loader(); }
}

function initialPage() {
  const requested = new URLSearchParams(window.location.search).get('page');
  return isKnownPage(requested) ? requested : 'image';
}

export function App() {
  const [page, setPage] = useState(null);
  const [studioComps, setStudioComps] = useState({}); // page -> resolved Component, kept mounted
  const [HubComp, setHubComp] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const navTokenRef = useRef(0);
  const pageRef = useRef(null);
  const loadedStudiosRef = useRef({}); // synchronous mirror of studioComps for navigate()

  const navigate = useCallback(async (target) => {
    if (!isKnownPage(target)) return;
    if (target === pageRef.current) return; // active-tab re-press: keep the live view
    const token = ++navTokenRef.current;

    // Keep the URL shareable without reloads; written up front so a stale-chunk
    // recovery reload lands on the requested page.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('page', target);
      window.history.replaceState(null, '', url);
    } catch { /* non-critical */ }

    if (HUB_PAGES[target]) {
      let mod;
      try {
        mod = await loadWithRetry(() => import('../hub/HubLayer.jsx'));
      } catch (error) {
        console.error(`[studio] failed to load hub view "${target}":`, error);
        recoverFromStaleChunks(error);
        return;
      }
      if (token !== navTokenRef.current) return;
      pageRef.current = target;
      setHubComp(() => mod.HubLayer);
      // Studios stay mounted (hidden) while a hub page is active — display-toggled,
      // never torn down, so their in-flight generations keep running.
      setPage(target);
      return;
    }

    // Load the studio module once; keep it in the map so it stays mounted forever.
    // Pre-loading here (rather than via <Suspense>) keeps the stale-chunk recovery
    // path intact — a 404'd chunk rejects here and reloads once.
    let Component = loadedStudiosRef.current[target];
    if (!Component) {
      try {
        Component = await loadWithRetry(STUDIO_LOADERS[target]);
      } catch (error) {
        console.error(`[studio] failed to load "${target}" view:`, error);
        recoverFromStaleChunks(error);
        return;
      }
    }
    if (token !== navTokenRef.current) return; // superseded; keep current view
    pageRef.current = target;
    if (!loadedStudiosRef.current[target]) {
      loadedStudiosRef.current = { ...loadedStudiosRef.current, [target]: Component };
      setStudioComps(loadedStudiosRef.current);
    }
    setPage(target);
  }, []);

  // Inbound router API — hubApp/explore-dock dispatch window 'navigate' events;
  // detail.page === 'settings' opens the settings modal instead of routing.
  useEffect(() => {
    const onNavigate = (e) => {
      if (e.detail?.page === 'settings') setSettingsOpen(true);
      else navigate(e.detail?.page);
    };
    window.addEventListener('navigate', onNavigate);
    return () => window.removeEventListener('navigate', onNavigate);
  }, [navigate]);

  // Initial route.
  useEffect(() => {
    navigate(initialPage());
  }, [navigate]);

  // A generation outlives the page. Its job id is in sessionStorage and the backend
  // keeps rendering, but only the studio that owns it can put the progress back —
  // and a studio is normally loaded on first VISIT. Reload while looking at History
  // or the Image studio and a running video therefore stayed invisible until the
  // user happened to click Video. So any studio with unfinished work is mounted
  // (hidden) at boot, which is enough for its tabs to reclaim their runs.
  useEffect(() => {
    const waiting = [...new Set(getPendingJobs().map((job) => String(job?.studioType || '')))]
      .filter((studio) => STUDIO_LOADERS[studio]);
    if (!waiting.length) return;
    void (async () => {
      for (const studio of waiting) {
        if (loadedStudiosRef.current[studio]) continue;
        let Component;
        try {
          Component = await loadWithRetry(STUDIO_LOADERS[studio]);
        } catch (error) {
          console.warn(`[studio] could not mount "${studio}" to resume its generations:`, error);
          continue;
        }
        // Re-read the ref rather than closing over it: navigate() may have loaded
        // this studio, or another one, while the import was in flight.
        if (loadedStudiosRef.current[studio]) continue;
        loadedStudiosRef.current = { ...loadedStudiosRef.current, [studio]: Component };
        setStudioComps(loadedStudiosRef.current);
      }
    })();
  }, []);

  // A refused download (sealed media this tab can't decrypt) has to say so — the
  // alternative was writing envelope JSON under a .mp4 name and letting the owner
  // discover it in ~/Downloads as a corrupt file.
  useEffect(() => {
    const onBlocked = (e) => toast.error(
      e.detail?.message || "This output is encrypted and your vault can't open it.",
      { duration: 7000 },
    );
    window.addEventListener(MEDIA_DOWNLOAD_BLOCKED_EVENT, onBlocked);
    return () => window.removeEventListener(MEDIA_DOWNLOAD_BLOCKED_EVENT, onBlocked);
  }, []);

  const isHub = Boolean(HUB_PAGES[page]);

  return (
    <>
      <Shell page={page} onNavigate={navigate} onOpenSettings={() => setSettingsOpen(true)}>
        {/* Studio layer — each visited studio mounts once and is display-toggled,
            so in-flight generations survive tab switches. Only the visible studio
            is active (owns the prompt-insert bridge). */}
        {Object.entries(studioComps).map(([p, Comp]) => {
          const visible = p === page && !isHub;
          return (
            <div key={p} className={visible ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
              {TABBED_STUDIOS.has(p)
                ? <StudioTabs Studio={Comp} studioType={p} active={visible} />
                : <Comp active={visible} />}
            </div>
          );
        })}
        {/* Hub layer — mounted once, display-toggled forever (iframe state) */}
        {HubComp ? <HubComp visible={isHub} view={isHub ? HUB_PAGES[page] : null} /> : null}
      </Shell>

      {settingsOpen ? (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-[100] grid place-items-center bg-scrim">
              <Spinner size={22} className="text-ink2" />
            </div>
          }
        >
          <SettingsModalLazy onClose={() => setSettingsOpen(false)} />
        </Suspense>
      ) : null}

      <VaultRecoveryModal />
      <VaultUnlockModal />
      <ExploreDock />
      <OutputRestoreDropZone />
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--bg-3)',
            color: 'var(--ink-1)',
            border: '1px solid var(--line-1)',
            borderRadius: 'var(--r-md)',
            fontSize: '13px',
            boxShadow: 'var(--shadow-pop)',
          },
          success: { iconTheme: { primary: 'var(--ok)', secondary: 'var(--bg-0)' } },
          error: { iconTheme: { primary: 'var(--danger)', secondary: 'var(--bg-0)' } },
        }}
      />
    </>
  );
}
