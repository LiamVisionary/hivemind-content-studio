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
import { HivemindPromptBridge } from '../bridges/HivemindPromptBridge.jsx';
import { AccountDialog } from '../dialogs/AccountDialog.jsx';
import { CreditsDialog } from '../dialogs/CreditsDialog.jsx';
import { MEDIA_DOWNLOAD_BLOCKED_EVENT } from '../lib/downloadMedia.js';
import { cloudCatalogReady } from '../lib/cloudCatalog.js';
import { isFirstRunSetup } from '../lib/firstRun.js';
import { loadWithRetry, recoverFromStaleChunks } from '../lib/lazyChunk.js';
import { seedMuapiKeyLocation } from '../lib/muapiKey.js';
import { getPendingJobs } from '../lib/pendingJobs.js';
import { ensureVaultReady } from '../lib/vaultSession.js';
import { OutputRestoreDropZone } from './OutputRestoreDropZone.jsx';
import { VaultRecoveryModal } from '../bridges/VaultRecoveryModal.jsx';
import { VaultUnlockModal } from '../bridges/VaultUnlockModal.jsx';
import { LoadingState } from '../ui/kit.jsx';
import { t } from '../lib/i18n.js';
import { CommandPalette } from './CommandPalette.jsx';
import { ErrorBoundary } from './ErrorBoundary.jsx';
import { HUB_PAGES, PAGE_ALIASES, SHORTCUT_ITEMS, isKnownPage } from './navConfig.jsx';
import { requestComposerMenu } from './composerMenuRequest.js';
import { Shell } from './Shell.jsx';
import { startApiHeartbeat, stopApiHeartbeat } from './statusStore.js';
import { StudioTabs } from './StudioTabs.jsx';

// Studios that open in tabs. Each tab is a separate mount of the same studio, so
// tabs behave exactly like pages already do: independent settings, and a background
// tab's generation keeps running.
const TABBED_STUDIOS = new Set(['image', 'video']);

// The cloud model catalog is SERVED (see lib/cloudCatalog.js), and these three
// studios boot their default model straight off it — Image picks t2iModels[0]
// when nothing is persisted. So their chunk and the catalog are fetched
// together and the studio mounts once both are in: the alternative is a first
// paint with an empty model picker that fills in a moment later.
const withCloudCatalog = (load) => async () => (await Promise.all([load(), cloudCatalogReady()]))[0];

const STUDIO_LOADERS = {
  image: withCloudCatalog(() => import('../studios/ImageStudio.jsx').then((m) => m.ImageStudio)),
  video: withCloudCatalog(() => import('../studios/VideoStudio.jsx').then((m) => m.VideoStudio)),
  // No catalog wait: Music has no cloud row to boot off — its one model comes
  // from the machine's own audio lane list, fetched inside the studio.
  music: () => import('../studios/MusicStudio.jsx').then((m) => m.MusicStudio),
  sprite: () => import('../studios/SpriteStudio.jsx').then((m) => m.SpriteStudio),
  story: () => import('../studios/StoryStudio.jsx').then((m) => m.StoryStudio),
  lipsync: withCloudCatalog(() => import('../studios/LipSyncStudio.jsx').then((m) => m.LipSyncStudio)),
  restore: () => import('../studios/RestoreStudio.jsx').then((m) => m.RestoreStudio),
};

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
  // The catalog fetch goes out with the studio chunk rather than behind it —
  // cloudCatalogReady() is loaded once and shared, so this is the same promise
  // the loader above waits on.
  try { cloudCatalogReady(); } catch { /* non-critical */ }
  const landing = STUDIO_LOADERS[initialPage()];
  if (landing) { try { landing().catch(() => {}); } catch { /* non-critical */ } }
}

export function App() {
  const [page, setPage] = useState(null);
  const [studioComps, setStudioComps] = useState({}); // page -> resolved Component, kept mounted
  const [HubComp, setHubComp] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The two account sheets are dialogs rather than pages: they are opened from
  // a row that is on screen on EVERY page, and turning that press into a
  // navigation would throw away whatever studio the person was in the middle
  // of. `'account' | 'credits' | ''` — one at a time, and Add credits inside
  // the account sheet swaps rather than stacks.
  const [accountSheet, setAccountSheet] = useState('');
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

    // Every route change in the app funnels through here, so this is the one
    // place that can say WHO asked. Kept in memory (no console noise, nothing
    // persisted): read `window.__navLog` after a page changes on its own and
    // the stack names the caller. Added 2026-09-12 after a render finished and
    // the app moved itself to the Library — every navigate dispatch in the tree
    // is a click handler, nothing calls history.back(), and the video studio
    // dispatches none at all, so the next occurrence has to identify itself.
    try {
      const log = (window.__navLog = window.__navLog || []);
      log.push({ at: new Date().toISOString(), from: pageRef.current, to: target, fromHistory, stack: new Error().stack });
      if (log.length > 40) log.shift();
    } catch { /* diagnostics must never break a route change */ }

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
  //   ⌘1..⌘9  SHORTCUT_ITEMS — the first nine nav rows, in sidebar order,
  //           and exactly the nine the command palette advertises
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
        const target = SHORTCUT_ITEMS[Number(e.key) - 1];
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

  // Same inbound API for the credits sheet. It is a sheet rather than a page,
  // so it cannot be reached through 'navigate', and the hub views are not in
  // Shell's prop chain — without this a hub page wanting "Add credits" has to
  // grow its own checkout, which is how one balance becomes two.
  useEffect(() => {
    const onOpenCredits = () => setAccountSheet('credits');
    window.addEventListener('open-credits', onOpenCredits);
    return () => window.removeEventListener('open-credits', onOpenCredits);
  }, []);

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
        onOpenAccount={() => setAccountSheet('account')}
        onOpenCredits={() => setAccountSheet('credits')}
      >
        {/* First studio chunk still loading: a centred spinner instead of a black area. */}
        {page === null ? (
          <LoadingState label={t('app.loading')} />
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

      {accountSheet === 'account' ? (
        <ErrorBoundary label="Your account">
          <AccountDialog
            onClose={() => setAccountSheet('')}
            onOpenCredits={() => setAccountSheet('credits')}
          />
        </ErrorBoundary>
      ) : null}
      {accountSheet === 'credits' ? (
        <ErrorBoundary label="Credits">
          <CreditsDialog onClose={() => setAccountSheet('')} />
        </ErrorBoundary>
      ) : null}

      <VaultRecoveryModal />
      <VaultUnlockModal />
      <HivemindPromptBridge />
      <OutputRestoreDropZone />
      <Toaster
        position="bottom-right"
        // The studios float their composer over the bottom of the stage, so the
        // default 16px gutter put every toast on top of Generate — on a phone
        // squarely on it, and on the home indicator besides. The container is
        // lifted clear of the composer instead.
        //
        // --app-composer-h is the composer's MEASURED height, published at :root
        // by StudioFrame for exactly this — the container is a child of <body>,
        // so the frame's own --frame-composer-h is out of scope. base.css zeroes
        // it from sm up, so the lift is a phone's and a desktop keeps the 24px
        // gutter it has always had. left/right restate the library's own default
        // so that merging this object does not drop them.
        containerStyle={{
          bottom: 'calc(var(--app-composer-h, 0px) + 24px + env(safe-area-inset-bottom, 0px))',
          left: 16,
          right: 16,
        }}
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
    // dvh, not `min-h-screen`: on iOS `vh` is the LARGE viewport, so a crash
    // screen sized in it stands taller than the window under the URL bar and
    // pushes its own two buttons off the bottom — on the one screen in the app
    // that has nothing else to press.
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-bg0 px-6 text-center text-ink1">
      <div className="text-base font-semibold">Hivemind Content Studio hit an error</div>
      <div className="max-w-md text-[13px] leading-relaxed text-ink3">
        Nothing was lost on the server side — running generations keep running. Reload to pick them back up.
      </div>
      <div className="max-w-lg rounded-md border border-line1 bg-bg2 px-3 py-2 font-mono text-[11px] text-ink2 break-words">
        {String(error?.message || error || 'Unknown error').slice(0, 240)}
      </div>
      {/* Raw h-9 is 31.5px on this 14px root and misses the --ctl-* ladder
          entirely, so the coarse-pointer bump never reached the only two
          controls on this screen. h-ctl-md is what every other 13px button in
          the app stands on (kit's BTN_SIZES.md): 36px under a cursor, 44 under
          a thumb. */}
      <div className="flex items-center gap-2">
        <button type="button" onClick={retry} className="h-ctl-md rounded-md bg-honey px-4 text-[13px] font-semibold text-on-honey hover:bg-honey-bright">Try again</button>
        <button type="button" onClick={() => window.location.reload()} className="h-ctl-md rounded-md border border-line1 bg-bg2 px-4 text-[13px] font-medium text-ink1 hover:border-line2">Reload page</button>
      </div>
    </div>
  );
}
