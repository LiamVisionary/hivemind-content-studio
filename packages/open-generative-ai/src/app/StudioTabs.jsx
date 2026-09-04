// Tab strip for the Image and Video studios.
//
// Every tab is its own mount of the studio component, display-toggled the same way
// App display-toggles studios — so a background tab keeps its in-flight generation,
// its results and its settings. Contract with the studio (see src/lib/studioTabs.js):
//   seed      — null on the original tab (restores persisted prefs), {boot:'fresh'}
//               for a new blank tab, {boot:'clone', snapshot} for a duplicate.
//   tabId     — stable id of this tab, used to claim the generations it started.
//   primary   — this is the FIRST tab: it adopts the composer draft and any pending
//               generation no open tab owns. Told explicitly rather than derived
//               from a null seed, which every tab has once a reload restores them.
//   openTabIds— the strip as it stands, so a tab can tell an ownerless job from one
//               belonging to a tab that is still on screen.
//   tabActive — this is the studio's front tab: it owns preference persistence and
//               the one-shot handoffs (rented mode, workflow-selected events).
//   active    — front tab AND the visible page: owns the prompt-insert bridge.
//   apiRef    — the studio publishes {snapshot(), isBusy()} here for Copy/Close.
//   studioLane — opaque per-app/per-tab id used only for local generation queues.
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useMediaPoster } from '../hooks/hooks.js';
import { zh } from '../lib/i18n.js';
import { getPendingJobs, pendingJobsForTab } from '../lib/pendingJobs.js';
import { publishTabLabels, tabChipLabel } from '../lib/studioTabLabel.js';
import {
  addTab, closeTab, consumeSeed, insertTabAfter, loadTabState, saveTabState, selectTab,
  studioInstanceId, studioLaneId,
} from '../lib/studioTabs.js';
import { Icon } from '../ui/icons.jsx';
import { ConfirmModal } from '../ui/Modal.jsx';
import { cx } from '../ui/kit.jsx';

// Each tab mounts a whole studio; the strip's restore cap (studioTabs.js
// MAX_RESTORED_TABS) is the ceiling here too, so what can be opened can also
// come back after a reload.
const MAX_TABS = 24;
// How often a background tab is asked whether it is still generating. A dot on
// the chip is the only sign a hidden tab has a run out.
const BUSY_POLL_MS = 1500;
// Shown once, ever: the first time a generation starts in a studio that still has
// only one tab. The whole point of tabs is that a four-minute render does not
// stop you working, and nothing else in the app says so.
const TABS_HINT_KEY = 'studio.tabsHintShown';

const TEXT = {
  tab: (n) => (zh() ? `标签 ${n}` : `Tab ${n}`),
  emptyTab: () => (zh() ? '新标签' : 'New tab'),
  tabsHint: () => {
    const key = typeof navigator !== 'undefined' && navigator.platform?.startsWith('Mac') ? '⌘T' : 'Ctrl+T';
    return zh()
      ? `再开一个标签（${key}），渲染的同时继续工作。`
      : `Open another tab (${key}) to keep working while this renders`;
  },
  newTab: () => (zh() ? '新建标签（默认设置）— ⌘T' : 'New tab — default settings, empty prompt (⌘T)'),
  duplicate: () => (zh() ? '复制此标签（含全部设置与提示词）' : 'Duplicate this tab with all its settings'),
  close: () => (zh() ? '关闭标签（⌘W）' : 'Close tab (⌘W)'),
  busyTitle: () => (zh() ? '此标签正在生成' : 'This tab is still generating'),
  busyBody: () => (zh()
    ? '渲染会继续进行，文件仍会保存——只是不会出现在这个标签里。仍要关闭吗？'
    : "The render keeps going and the file is still saved — you just won't see it land in this tab. Close anyway?"),
  closeAnyway: () => (zh() ? '关闭' : 'Close tab'),
  cancel: () => (zh() ? '取消' : 'Cancel'),
  busyDot: () => (zh() ? '正在生成' : 'Generating'),
  // A restored tab nobody has opened yet: the strip knows its position, not
  // what is in it, because the studio behind it has not booted. One click and
  // it says what it really is.
  sleeping: () => (zh() ? '点击打开此标签' : 'Click to open this tab'),
  tooMany: () => (zh() ? `最多打开 ${MAX_TABS} 个标签 — 先关闭一个。` : `Up to ${MAX_TABS} tabs can be open — close one first.`),
};

// The last thing this tab made, at 20px. A poster (one decoded frame) rather
// than a <video>: the strip is always on screen, and a live media element per
// chip would hold a decoder for a thumbnail.
function TabThumb({ url, kind }) {
  const { poster } = useMediaPoster(url, { kind: kind === 'image' ? 'image' : 'video' });
  if (!poster) return null;
  return (
    <img
      src={poster}
      alt=""
      className="h-5 w-5 shrink-0 rounded-sm border border-line1 bg-bg0 object-cover"
    />
  );
}

function TabChip({ index, on, busy, label, preview, asleep = false, onSelect, onDuplicate, onClose, closable, chipRef, onKeyDown }) {
  return (
    <div
      ref={chipRef}
      className={cx(
        'group/tab inline-flex h-7 shrink-0 items-center rounded-md border pr-0.5 transition-colors duration-150',
        on
          ? 'border-honey/50 bg-honey-tint text-honey'
          : 'border-line1 bg-bg2 text-ink2 hover:border-line2 hover:text-ink1',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={on}
        aria-current={on ? 'page' : undefined}
        tabIndex={on ? 0 : -1}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        title={asleep
          ? `${TEXT.tab(index + 1)} — ${TEXT.sleeping()}`
          : `${TEXT.tab(index + 1)} — ${label}${busy ? ` · ${TEXT.busyDot()}` : ''}`}
        className="flex h-full max-w-[190px] items-center gap-1.5 pl-1.5 pr-1 text-xs font-semibold"
      >
        {busy ? (
          <span
            className="hive-motion-keep ml-1 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-honey"
            role="img"
            aria-label={TEXT.busyDot()}
          />
        ) : null}
        {preview?.url ? <TabThumb url={preview.url} kind={preview.kind} /> : null}
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {/* Duplicate stays on the active chip; on the others it appears on hover
          so a long strip is not a row of copy icons. */}
      <button
        type="button"
        onClick={onDuplicate}
        title={TEXT.duplicate()}
        aria-label={TEXT.duplicate()}
        tabIndex={on ? 0 : -1}
        className={cx(
          'grid h-6 w-6 place-items-center rounded text-current transition-opacity hover:opacity-100 focus-visible:opacity-100',
          on ? 'opacity-60' : 'opacity-0 group-hover/tab:opacity-60',
        )}
      >
        <Icon name="copy" size={12} />
      </button>
      {closable ? (
        <button
          type="button"
          onClick={onClose}
          title={TEXT.close()}
          aria-label={TEXT.close()}
          className="grid h-6 w-6 place-items-center rounded text-current opacity-60 transition-opacity hover:opacity-100"
        >
          <Icon name="x" size={12} />
        </button>
      ) : null}
    </div>
  );
}

// The hint that makes tabs visible: shown the first time a render starts in a
// studio that still has one tab, and never again on this machine.
function showTabsHint() {
  try {
    if (localStorage.getItem(TABS_HINT_KEY)) return;
    localStorage.setItem(TABS_HINT_KEY, '1');
  } catch {
    return; // storage disabled — better silent than shown on every render
  }
  toast(TEXT.tabsHint(), { duration: 7000 });
}

export function StudioTabs({ Studio, studioType = 'studio', active = true }) {
  // Restored from sessionStorage, so a reload brings the whole strip back and every
  // tab that was rendering can reclaim its run. Without this only Tab 1 survived and
  // every other tab's generation was orphaned mid-flight.
  const [state, setState] = useState(() => loadTabState(studioType));
  // Which tabs are actually MOUNTED. A restored strip can be 24 tabs deep and a
  // tab is a whole studio: its model list, its saved-library reads, its
  // rented-machine timer, its composer hydration. Mounting all of them put
  // dozens of requests in front of the one tab the user is looking at. So: the
  // front tab, plus any tab that owns a generation still in flight — that one
  // has to be alive to reclaim its run (and the first tab additionally adopts
  // the ownerless ones, which is what pendingJobsForTab's `primary` means).
  // Every other tab boots the first time it is fronted, from the same persisted
  // preferences it would have booted from at reload.
  const [mounted, setMounted] = useState(() => {
    const jobs = getPendingJobs().filter((job) => String(job?.studioType || '') === studioType);
    const openTabIds = state.tabs.map((tab) => tab.id);
    const live = new Set([state.activeId]);
    state.tabs.forEach((tab, index) => {
      const owned = pendingJobsForTab(jobs, tab.id, { primary: index === 0 && !tab.seed, openTabIds });
      if (owned.length) live.add(tab.id);
    });
    return live;
  });
  const [closeConfirm, setCloseConfirm] = useState(null); // id of a busy tab awaiting confirmation
  // What each tab is: whether it is generating, what to call it, and the last
  // thing it made. Polled — the studios expose chip()/isBusy() on their api
  // handle, they do not push changes.
  const [chips, setChips] = useState(() => new Map());
  // Was anything generating on the previous poll? The one-time "open another
  // tab" hint fires on the false → true edge, not on every poll while busy.
  const wasBusyRef = useRef(false);
  // Per-tab api handles, keyed by the (never-reused) tab id.
  const apisRef = useRef(new Map());
  const chipRefs = useRef(new Map());
  // Duplicate pressed on a tab that had not booted: the id to copy once it has.
  const duplicateWhenReadyRef = useRef(null);
  // Latest keyboard handler, so the window listener below is bound once.
  const shortcutRef = useRef(null);
  // Held for the life of the browser tab, not the life of this mount: a resumed
  // generation must keep the scheduler lane it was submitted on.
  const instanceIdRef = useRef(null);
  if (!instanceIdRef.current) instanceIdRef.current = studioInstanceId();

  const apiFor = (id) => {
    if (!apisRef.current.has(id)) apisRef.current.set(id, { current: null });
    return apisRef.current.get(id);
  };

  // Fronting a tab is what boots it. Never unmounted again: a studio that has
  // started a render must keep running while it is in the background, which is
  // the whole point of the strip.
  useEffect(() => {
    setMounted((prev) => (prev.has(state.activeId) ? prev : new Set(prev).add(state.activeId)));
  }, [state.activeId]);

  // The studio consumes its seed on first render; drop it afterwards so a
  // duplicate's reference images aren't retained twice for the session.
  useEffect(() => {
    const seeded = state.tabs.find((tab) => tab.seed);
    if (seeded) setState((prev) => consumeSeed(prev, seeded.id));
  }, [state]);

  useEffect(() => { saveTabState(studioType, state); }, [studioType, state]);

  // Another studio asking for a specific tab before it sends work there. The
  // one-shot setup bridge only drains into the tab that is mounted AND active
  // (app/promptTarget.js), so choosing a target means fronting it first.
  useEffect(() => {
    const onSelect = (event) => {
      if (event?.detail?.studioType !== studioType) return;
      const wanted = Number(event.detail.tabId);
      setState((prev) => (prev.tabs.some((tab) => tab.id === wanted) ? selectTab(prev, wanted) : prev));
    };
    window.addEventListener('studio-select-tab', onSelect);
    return () => window.removeEventListener('studio-select-tab', onSelect);
  }, [studioType]);

  // A new or re-selected tab scrolls into view: once the strip overflows, the
  // + button and the newest tab used to vanish off the right edge.
  useEffect(() => {
    const chip = chipRefs.current.get(state.activeId);
    try { chip?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch { /* non-critical */ }
  }, [state.activeId, state.tabs.length]);

  useEffect(() => {
    const poll = () => {
      const next = new Map();
      state.tabs.forEach((tab, index) => {
        const api = apisRef.current.get(tab.id)?.current;
        let info = null;
        try { info = api?.chip?.() || null; } catch { info = null; }
        // A tab that has not booted has nothing to describe itself with, and
        // "New tab" would be a lie about a tab that is full of settings. It is
        // named by its position until the click that opens it.
        const asleep = !mounted.has(tab.id);
        next.set(tab.id, {
          index,
          asleep,
          busy: Boolean(api?.isBusy?.()),
          label: asleep ? TEXT.tab(index + 1) : tabChipLabel(info, { fallback: TEXT.emptyTab() }),
          previewUrl: String(info?.previewUrl || ''),
          previewKind: info?.previewKind === 'image' ? 'image' : 'video',
        });
      });

      // The command palette lists the tabs of the page you are on; this is where
      // it reads their names from (lib/studioTabLabel.js).
      publishTabLabels(studioType, [...next].map(([id, chip]) => ({
        id, index: chip.index, label: chip.label, busy: chip.busy,
      })));

      const busyNow = [...next.values()].some((chip) => chip.busy);
      if (active && busyNow && !wasBusyRef.current && state.tabs.length === 1) showTabsHint();
      wasBusyRef.current = busyNow;

      setChips((prev) => {
        if (prev.size === next.size && [...next].every(([id, chip]) => {
          const before = prev.get(id);
          return before && before.busy === chip.busy && before.label === chip.label
            && before.previewUrl === chip.previewUrl && before.index === chip.index;
        })) return prev;
        return next;
      });

      // Duplicate pressed on a tab that had not booted yet: it was fronted so it
      // would, and this is the first poll where it has an api to copy.
      const wanted = duplicateWhenReadyRef.current;
      if (wanted != null) {
        const snapshot = apisRef.current.get(wanted)?.current?.snapshot?.();
        if (snapshot) {
          duplicateWhenReadyRef.current = null;
          setState((prev) => insertTabAfter(prev, wanted, { boot: 'clone', snapshot }));
        }
      }
    };
    poll();
    const id = window.setInterval(poll, BUSY_POLL_MS);
    return () => window.clearInterval(id);
  }, [state.tabs, studioType, active, mounted]);

  const duplicate = (id) => {
    const snapshot = apisRef.current.get(id)?.current?.snapshot?.();
    if (snapshot) {
      setState((prev) => insertTabAfter(prev, id, { boot: 'clone', snapshot }));
      return;
    }
    if (!state.tabs.some((tab) => tab.id === id)) return;
    // Not booted yet (a restored tab nobody has opened). Front it — which is what
    // mounts it — and take the copy on the poll where its api appears. Returning
    // silently here is what a lazily mounted strip would otherwise do to every
    // Duplicate press on a background tab.
    duplicateWhenReadyRef.current = id;
    setState((prev) => selectTab(prev, id));
  };

  const forget = (id) => {
    apisRef.current.delete(id);
    setState((prev) => closeTab(prev, id));
  };

  const requestClose = (id) => {
    if (apisRef.current.get(id)?.current?.isBusy?.()) setCloseConfirm(id);
    else forget(id);
  };

  const openNewTab = () => {
    if (state.tabs.length >= MAX_TABS) { toast.error(TEXT.tooMany()); return; }
    setState((prev) => addTab(prev, { boot: 'fresh' }));
  };

  const focusTabAt = (index) => {
    const count = state.tabs.length;
    if (!count) return;
    const next = state.tabs[((index % count) + count) % count];
    setState((prev) => selectTab(prev, next.id));
    window.requestAnimationFrame(() => {
      chipRefs.current.get(next.id)?.querySelector('[role="tab"]')?.focus();
    });
  };

  const cycleTab = (delta) => {
    const at = state.tabs.findIndex((tab) => tab.id === state.activeId);
    focusTabAt((at < 0 ? 0 : at) + delta);
  };

  // ⌘T new, ⌘W close, ⌘⇧[ / ⌘⇧] cycle. Returns true when it handled the event,
  // so both callers below can stop it. ⇧ makes the bracket a { or } on most
  // layouts, hence the code fallback.
  const handleTabShortcut = (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
    const key = String(event.key || '').toLowerCase();
    if (!event.shiftKey && key === 't') { openNewTab(); return true; }
    if (!event.shiftKey && key === 'w') {
      if (state.tabs.length > 1) requestClose(state.activeId);
      return true;
    }
    if (event.shiftKey && (key === ']' || key === '}' || event.code === 'BracketRight')) { cycleTab(1); return true; }
    if (event.shiftKey && (key === '[' || key === '{' || event.code === 'BracketLeft')) { cycleTab(-1); return true; }
    return false;
  };

  // The strip's shortcuts work from anywhere in the studio, not only from a
  // focused chip — the composer is where the hands are. The handler goes through
  // a ref so the listener is bound once per activation while still seeing the
  // current strip.
  shortcutRef.current = handleTabShortcut;
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (event) => { if (shortcutRef.current?.(event)) event.preventDefault(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  // ArrowLeft/Right move between tabs (roving focus lands on the selected chip).
  const onChipKeyDown = (event, index) => {
    if (handleTabShortcut(event)) { event.preventDefault(); return; }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    focusTabAt(index + (event.key === 'ArrowRight' ? 1 : -1));
  };

  const openTabIds = state.tabs.map((tab) => tab.id);

  return (
    <>
      <div
        role="tablist"
        aria-label="Studio tabs"
        className="no-scrollbar flex h-10 w-full shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line1 bg-bg1 px-3"
      >
        {state.tabs.map((tab, index) => (
          <TabChip
            key={tab.id}
            index={index}
            on={tab.id === state.activeId}
            busy={Boolean(chips.get(tab.id)?.busy)}
            label={chips.get(tab.id)?.label || TEXT.tab(index + 1)}
            asleep={Boolean(chips.get(tab.id)?.asleep)}
            preview={{ url: chips.get(tab.id)?.previewUrl || '', kind: chips.get(tab.id)?.previewKind || 'video' }}
            closable={state.tabs.length > 1}
            chipRef={(node) => { if (node) chipRefs.current.set(tab.id, node); else chipRefs.current.delete(tab.id); }}
            onKeyDown={(event) => onChipKeyDown(event, index)}
            onSelect={() => setState((prev) => selectTab(prev, tab.id))}
            onDuplicate={() => duplicate(tab.id)}
            onClose={() => requestClose(tab.id)}
          />
        ))}
        <button
          type="button"
          onClick={openNewTab}
          title={TEXT.newTab()}
          aria-label={TEXT.newTab()}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line1 bg-bg2 text-ink2 transition-colors hover:border-line2 hover:text-ink1"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>

      {state.tabs.filter((tab) => mounted.has(tab.id)).map((tab) => {
        const front = tab.id === state.activeId;
        return (
          <div key={tab.id} className={front ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
            <Studio
              active={active && front}
              tabActive={front}
              seed={tab.seed}
              tabId={tab.id}
              primary={tab.id === state.tabs[0].id && !tab.seed}
              openTabIds={openTabIds}
              apiRef={apiFor(tab.id)}
              studioLane={studioLaneId(studioType, instanceIdRef.current, tab.id)}
            />
          </div>
        );
      })}

      <ConfirmModal
        open={closeConfirm != null}
        onClose={() => setCloseConfirm(null)}
        onConfirm={() => { forget(closeConfirm); setCloseConfirm(null); }}
        title={TEXT.busyTitle()}
        body={TEXT.busyBody()}
        confirmLabel={TEXT.closeAnyway()}
        cancelLabel={TEXT.cancel()}
      />
    </>
  );
}
