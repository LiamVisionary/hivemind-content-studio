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
import { zh } from '../lib/i18n.js';
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

const TEXT = {
  tab: (n) => (zh() ? `标签 ${n}` : `Tab ${n}`),
  newTab: () => (zh() ? '新建标签（默认设置）' : 'New tab — default settings, empty prompt'),
  duplicate: () => (zh() ? '复制此标签（含全部设置与提示词）' : 'Duplicate this tab with all its settings'),
  close: () => (zh() ? '关闭标签' : 'Close tab'),
  busyTitle: () => (zh() ? '此标签正在生成' : 'This tab is still generating'),
  busyBody: () => (zh()
    ? '关闭后此次生成的结果将无法在工作室中显示。仍要关闭吗？'
    : 'Closing it drops the result from the studio — the run itself keeps going on the backend. Close anyway?'),
  closeAnyway: () => (zh() ? '关闭' : 'Close tab'),
  cancel: () => (zh() ? '取消' : 'Cancel'),
  busyDot: () => (zh() ? '正在生成' : 'Generating'),
  tooMany: () => (zh() ? `最多打开 ${MAX_TABS} 个标签 — 先关闭一个。` : `Up to ${MAX_TABS} tabs can be open — close one first.`),
};

function TabChip({ index, on, busy, onSelect, onDuplicate, onClose, closable, chipRef, onKeyDown }) {
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
        title={busy ? TEXT.busyDot() : undefined}
        className="flex h-full items-center gap-1.5 pl-2.5 pr-1 text-xs font-semibold"
      >
        {busy ? (
          <span
            className="hive-motion-keep h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-honey"
            role="img"
            aria-label={TEXT.busyDot()}
          />
        ) : null}
        {TEXT.tab(index + 1)}
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

export function StudioTabs({ Studio, studioType = 'studio', active = true }) {
  // Restored from sessionStorage, so a reload brings the whole strip back and every
  // tab that was rendering can reclaim its run. Without this only Tab 1 survived and
  // every other tab's generation was orphaned mid-flight.
  const [state, setState] = useState(() => loadTabState(studioType));
  const [closeConfirm, setCloseConfirm] = useState(null); // id of a busy tab awaiting confirmation
  // Which tabs are generating right now (polled — the studios expose isBusy()
  // on their api handle, they do not push changes).
  const [busyIds, setBusyIds] = useState(() => new Set());
  // Per-tab api handles, keyed by the (never-reused) tab id.
  const apisRef = useRef(new Map());
  const chipRefs = useRef(new Map());
  // Held for the life of the browser tab, not the life of this mount: a resumed
  // generation must keep the scheduler lane it was submitted on.
  const instanceIdRef = useRef(null);
  if (!instanceIdRef.current) instanceIdRef.current = studioInstanceId();

  const apiFor = (id) => {
    if (!apisRef.current.has(id)) apisRef.current.set(id, { current: null });
    return apisRef.current.get(id);
  };

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
      const next = new Set();
      state.tabs.forEach((tab) => {
        if (apisRef.current.get(tab.id)?.current?.isBusy?.()) next.add(tab.id);
      });
      setBusyIds((prev) => {
        if (prev.size === next.size && [...next].every((id) => prev.has(id))) return prev;
        return next;
      });
    };
    poll();
    const id = window.setInterval(poll, BUSY_POLL_MS);
    return () => window.clearInterval(id);
  }, [state.tabs]);

  const duplicate = (id) => {
    const snapshot = apisRef.current.get(id)?.current?.snapshot?.();
    if (!snapshot) return; // studio hasn't published its api yet — nothing to copy
    setState((prev) => insertTabAfter(prev, id, { boot: 'clone', snapshot }));
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

  // ArrowLeft/Right move between tabs (roving focus lands on the selected chip).
  const onChipKeyDown = (event, index) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const count = state.tabs.length;
    const nextIndex = (index + (event.key === 'ArrowRight' ? 1 : -1) + count) % count;
    const next = state.tabs[nextIndex];
    setState((prev) => selectTab(prev, next.id));
    window.requestAnimationFrame(() => {
      chipRefs.current.get(next.id)?.querySelector('[role="tab"]')?.focus();
    });
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
            busy={busyIds.has(tab.id)}
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

      {state.tabs.map((tab) => {
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
