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
import { getLang } from '../lib/i18n.js';
import {
  addTab, closeTab, consumeSeed, insertTabAfter, loadTabState, saveTabState, selectTab,
  studioInstanceId, studioLaneId,
} from '../lib/studioTabs.js';
import { Icon } from '../ui/icons.jsx';
import { ConfirmModal } from '../ui/Modal.jsx';
import { cx } from '../ui/kit.jsx';

const zh = () => getLang() === 'zh-CN';
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
};

function TabChip({ index, on, onSelect, onDuplicate, onClose, closable }) {
  return (
    <div
      className={cx(
        'inline-flex h-7 shrink-0 items-center rounded-md border pr-0.5 transition-colors duration-150',
        on
          ? 'border-honey/50 bg-honey-tint text-honey'
          : 'border-line1 bg-bg2 text-ink2 hover:border-line2 hover:text-ink1',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={on ? 'page' : undefined}
        className="h-full pl-2.5 pr-1 text-xs font-semibold"
      >
        {TEXT.tab(index + 1)}
      </button>
      <button
        type="button"
        onClick={onDuplicate}
        title={TEXT.duplicate()}
        aria-label={TEXT.duplicate()}
        className="grid h-6 w-6 place-items-center rounded text-current opacity-60 transition-opacity hover:opacity-100"
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
  // Per-tab api handles, keyed by the (never-reused) tab id.
  const apisRef = useRef(new Map());
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
            closable={state.tabs.length > 1}
            onSelect={() => setState((prev) => selectTab(prev, tab.id))}
            onDuplicate={() => duplicate(tab.id)}
            onClose={() => requestClose(tab.id)}
          />
        ))}
        <button
          type="button"
          onClick={() => setState((prev) => addTab(prev, { boot: 'fresh' }))}
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
      />
    </>
  );
}
