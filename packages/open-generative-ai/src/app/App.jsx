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
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast, Toaster } from 'react-hot-toast';
import { ExploreDock } from '../bridges/ExploreDock.jsx';
import { MEDIA_DOWNLOAD_BLOCKED_EVENT } from '../lib/downloadMedia.js';
import { isFirstRunSetup } from '../lib/firstRun.js';
import { seedMuapiKeyLocation } from '../lib/muapiKey.js';
import { getPendingJobs } from '../lib/pendingJobs.js';
import { ensureVaultReady } from '../lib/vaultSession.js';
import { OutputRestoreDropZone } from './OutputRestoreDropZone.jsx';
import { VaultRecoveryModal } from '../bridges/VaultRecoveryModal.jsx';
import { VaultUnlockModal } from '../bridges/VaultUnlockModal.jsx';
import { Spinner } from '../ui/kit.jsx';
import { CommandPalette } from './CommandPalette.jsx';
import { ErrorBoundary } from './ErrorBoundary.jsx';
import { HUB_PAGES, NAV_SECTIONS, PAGE_ALIASES, isKnownPage } from './navConfig.jsx';
import { requestComposerMenu } from './composerMenuRequest.js';
import { Shell } from './Shell.jsx';
import { startApiHeartbeat, stopApiHeartbeat } from './statusStore.js';
import { StudioTabs } from './StudioTabs.jsx';

// Studios that open in tabs. Each tab is a separate mount of the same studio, so
// tabs behave exactly like pages already do: independent settings, and a background
// tab's generation keeps running.
const TABBED_STUDIOS = new Set(['image', 'video']);

const STUDIO_LOADERS = {
  image: () => import('../studios/ImageStudio.jsx').then((m) => m.ImageStudio),
  video: () => import('../studios/VideoStudio.jsx').then((m) => m.VideoStudio),
  sprite: () => import('../studios/SpriteStudio.jsx').then((m) => m.SpriteStudio),
  story: () => import('../studios/StoryStudio.jsx').then((m) => m.StoryStudio),
  lipsync: () => import('../studios/LipSyncStudio.jsx').then((m) => m.LipSyncStudio),
  restore: () => import('../studios/RestoreStudio.jsx').then((m) => m.RestoreStudio),
};

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

// Start the landing studio's chunk NOW, at module scope, rather than after React
// has mounted and navigate() has run: those were two round trips in a row (the
// entry, then the studio and its deps) with nothing on screen between them.
// Kicked here, the fetch overlaps React's boot and navigate() finds the promise
// already in flight — STUDIO_LOADERS returns the same module promise, so this
// costs one extra import() call and no extra request. A rejection is left to
// navigate()'s own retry/stale-chunk recovery; swallowed here only so a failed
// preload is never an unhandled rejection.
if (typeof window !== 'undefined') {
  const landing = STUDIO_LOADERS[initialPage()];
  if (landing) { try { landing().catch(() => {}); } catch { /* non-critical */ } }
}

export function App() {
  const [page, setPage] = useState(null);
  const [studioComps, setStudioComps] = useState({}); // page -> resolved Component, kept mounted
  const [HubComp, setHubComp] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navTokenRef = useRef(0);
  const pageRef = useRef(null);
  const loadedStudiosRef = useRef({}); // synchronous mirror of studioComps for navigate()

  const navigate = useCallback(async (requested, { fromHistory = false } = {}) => {
    if (!isKnownPage(requested)) return;
    // A retired page key still resolves: it redirects, and asks the control it
    // folded into to open itself (?page=cinema -> Image, Camera menu).
    const alias = PAGE_ALIASES[requested];
    const target = alias ? alias.page : requested;
    if (alias) requestComposerMenu(alias.page, alias.menu);
    if (target === pageRef.current) return; // active-tab re-press: keep the live view
    const token = ++navTokenRef.current;

    // Keep the URL shareable without reloads; written up front so a stale-chunk
    // recovery reload lands on the requested page. The first route replaces
    // (no ghost entry behind the app); later ones push so the browser's Back and
    // Forward move between pages instead of leaving the app.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('page', target);
      if (pageRef.current === null || fromHistory) window.history.replaceState({ page: target }, '', url);
      else window.history.pushState({ page: target }, '', url);
    } catch { /* non-critical */ }

    if (HUB_PAGES[target]) {
      let mod;
      try {
        mod = await loadWithRetry(() => import('../hub/HubLayer.jsx'));
      } catch (error) {
        console.error(`[studio] failed to load hub view "${target}":`, error);
        recoverFromStaleChunks(error);
        toast.error("Couldn't open that page — check the connection and try again.");
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
        toast.error("Couldn't open that studio — check the connection and try again.");
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

  // App-wide shortcuts (the composers own ⌘↵, the tab strip owns ⌘T/⌘W):
  //   ⌘,      Settings
  //   ⌘K      the command palette — pages, tabs, saved prompts, installed models
  //   ⌘1..⌘9  the first nav tier, in the order the sidebar lists it
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === ',' && !e.shiftKey) {
        e.preventDefault();
        void navigate('settings');
        return;
      }
      if ((e.key === 'k' || e.key === 'K') && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        const target = (NAV_SECTIONS[0]?.items || [])[Number(e.key) - 1];
        if (!target) return;
        e.preventDefault();
        void navigate(target.page);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  // Inbound router API — hubApp/explore-dock dispatch window 'navigate' events.
  // 'settings' used to open a modal; it is a hub page now, so it routes like
  // every other key and old callers keep working unchanged.
  useEffect(() => {
    const onNavigate = (e) => {
      navigate(e.detail?.page);
    };
    window.addEventListener('navigate', onNavigate);
    return () => window.removeEventListener('navigate', onNavigate);
  }, [navigate]);

  // Initial route, then Back/Forward: the URL is the source of truth.
  useEffect(() => {
    navigate(initialPage());
    // One heartbeat for the whole app: the pill, the studio banners and the
    // Generate gates all read the answer it publishes.
    startApiHeartbeat();
    const onPopState = () => { void navigate(initialPage(), { fromHistory: true }); };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      stopApiHeartbeat();
    };
  }, [navigate]);

  // First run: the gate's setup card signed this person in one reload ago, so
  // create the vault HERE, deliberately, instead of leaving it to whichever
  // media resolve or composer hydrate happened to await ensureVaultReady first.
  // That accident is what made the one-time recovery key land on top of a
  // half-loaded studio; now it is step two of setting the studio up.
  useEffect(() => {
    if (!isFirstRunSetup()) return;
    void ensureVaultReady();
  }, []);

  // Does this machine hold the MUAPI key? Asked ONCE here, for every studio:
  // each gate reads the answer (modelRunner.needsBrowserKey), so a machine that
  // already has the key never opens the key dialog — in Image, Video, Lip sync
  // or Sprite, whichever is visited first. A key an older build left in
  // this browser is moved into the shared store on the way.
  useEffect(() => {
    let alive = true;
    void seedMuapiKeyLocation().then(({ migrated }) => {
      if (alive && migrated) {
        toast.success('Your MUAPI key now lives in this machine’s shared store, where every Hive app can use it.');
      }
    });
    return () => { alive = false; };
  }, []);

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
    <ErrorBoundary label="The studio" fallback={AppCrash}>
      <Shell
        page={page}
        onNavigate={navigate}
        onOpenSettings={() => navigate('settings')}
        onOpenPalette={() => setPaletteOpen(true)}
      >
        {/* First studio chunk still loading: a centred spinner instead of a black area. */}
        {page === null ? (
          <div className="grid min-h-0 flex-1 place-items-center" aria-busy="true">
            <Spinner size={22} className="text-ink3" />
          </div>
        ) : null}
        {/* Studio layer — each visited studio mounts once and is display-toggled,
            so in-flight generations survive tab switches. Only the visible studio
            is active (owns the prompt-insert bridge). */}
        {Object.entries(studioComps).map(([p, Comp]) => {
          const visible = p === page && !isHub;
          return (
            <div key={p} className={visible ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
              <ErrorBoundary label={`The ${p} studio`}>
                {TABBED_STUDIOS.has(p)
                  ? <StudioTabs Studio={Comp} studioType={p} active={visible} />
                  : <Comp active={visible} />}
              </ErrorBoundary>
            </div>
          );
        })}
        {/* Hub layer — mounted once, display-toggled forever (iframe state) */}
        {HubComp ? (
          <ErrorBoundary label="This page">
            <HubComp visible={isHub} view={isHub ? HUB_PAGES[page] : null} />
          </ErrorBoundary>
        ) : null}
      </Shell>

      <CommandPalette
        open={paletteOpen}
        page={page}
        onClose={() => setPaletteOpen(false)}
        onNavigate={navigate}
      />

      <VaultRecoveryModal />
      <VaultUnlockModal />
      <ExploreDock />
      <OutputRestoreDropZone />
      <Toaster
        position="bottom-right"
        toastOptions={{
          // One baseline for the whole app: success messages are short and
          // confirm an action (3.5 s); errors need to be read (6 s); plain notices
          // sit in between. Call sites only override for genuinely long copy.
          duration: 4500,
          success: { duration: 3500, iconTheme: { primary: 'var(--ok)', secondary: 'var(--bg-0)' } },
          error: { duration: 6000, iconTheme: { primary: 'var(--danger)', secondary: 'var(--bg-0)' } },
          style: {
            background: 'var(--bg-3)',
            color: 'var(--ink-1)',
            border: '1px solid var(--line-1)',
            borderRadius: 'var(--r-md)',
            fontSize: '13px',
            boxShadow: 'var(--shadow-pop)',
          },
        }}
      />
    </ErrorBoundary>
  );
}

// Whole-app fallback: the shell itself failed, so there is no sidebar to lean on.
function AppCrash({ error, retry }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg0 px-6 text-center text-ink1">
      <div className="text-base font-semibold">Hivemind Content Studio hit an error</div>
      <div className="max-w-md text-[13px] leading-relaxed text-ink3">
        Nothing was lost on the server side — running generations keep running. Reload to pick them back up.
      </div>
      <div className="max-w-lg rounded-md border border-line1 bg-bg2 px-3 py-2 font-mono text-[11px] text-ink2 break-words">
        {String(error?.message || error || 'Unknown error').slice(0, 240)}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={retry} className="h-9 rounded-md bg-honey px-4 text-[13px] font-semibold text-on-honey hover:bg-honey-bright">Try again</button>
        <button type="button" onClick={() => window.location.reload()} className="h-9 rounded-md border border-line1 bg-bg2 px-4 text-[13px] font-medium text-ink1 hover:border-line2">Reload page</button>
      </div>
    </div>
  );
}
