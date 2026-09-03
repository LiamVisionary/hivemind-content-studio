// Hivemind explore dock (React port of hivemindStudio.js installHivemindExploreDock).
// Rendered once by App (singleton); returns null outside studio mode.
//
// The dock is the prompt library: saved Templates and Ingredients, inserted into
// whichever studio composer is on screen. The generation-option switches and the
// local-video-workflow select it used to carry were removed on 2026-09-03 — the
// switches wrote a sessionStorage key nothing read, and the select duplicated the
// Video studio's own model picker.
//
// Contracts preserved verbatim:
// - template/ingredient click inserts via insertIntoActivePrompt (promptTarget bridge)
// - window 'message' (same-origin only): 'hivemind-owner-lock' -> clear private
//   state + reset vault session + clear resolved media cache;
//   'hivemind-explore-insert-prompt' {text}; 'hivemind-explore-refresh'
// - readiness handshake: postMessage {type:'hivemind-explore-ready'} to parent
// - install-time legacy plaintext scrub (via loadStudioGenerationHistory, which
//   scrubs 'muapi_history'/'video_history'/'muapi_pending_jobs' in studio mode)
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { getExploreDock, setExploreDock, subscribeExploreDock } from '../app/exploreDockStore.js';
import { insertIntoActivePrompt } from '../app/promptTarget.js';
import { clearResolvedMediaCache } from '../lib/e2eMedia.js';
import {
  clearHivemindStudioPrivateState,
  isHivemindStudioEnabled,
  loadHivemindStudioContext,
  loadStudioGenerationHistory,
} from '../lib/hivemindStudio.js';
import { resetVaultSession } from '../lib/vaultSession.js';
import { zh } from '../lib/i18n.js';
import { Icon } from '../ui/icons.jsx';
import { SectionLabel, cx } from '../ui/kit.jsx';

// How many templates/ingredients the dock lists before pointing at History.
const LIST_LIMIT = 8;
// The pages whose studio registers a prompt inserter while it is on screen
// (registerPromptInserter in each studio's `active` effect).
const PROMPT_PAGES = new Set(['image', 'video', 'cinema', 'lipsync']);

function PromptItemButton({ label, text, onInsert }) {
  return (
    <button
      type="button"
      onClick={onInsert}
      className="w-full rounded-md border border-line1 bg-bg2 px-2.5 py-2 text-left transition-colors duration-150 hover:border-line2 hover:bg-bg3"
    >
      <span className="block truncate text-xs font-medium text-ink1">{label}</span>
      {text ? <span className="block truncate text-[11px] text-ink3">{text}</span> : null}
    </button>
  );
}

function PromptItemList({ items, kind, onInsert }) {
  if (!items.length) {
    return <p className="px-1 py-2 text-[11px] text-ink3">{zh() ? '还没有保存的内容。' : 'Nothing saved yet.'}</p>;
  }
  const shown = items.slice(0, LIST_LIMIT);
  return (
    <div className="flex flex-col gap-1.5">
      {shown.map((item) => {
        const id = kind === 'template' ? item.id : item.prompt_id;
        // An ingredient IS its prompt — it was listed twice (title line and
        // muted line both the prompt). Now: its title over the prompt when it
        // has one, else the prompt alone with its lane as the muted line.
        const titled = kind !== 'template' && item.title;
        const label = kind === 'template' ? item.title : (titled ? item.title : item.prompt);
        const text = kind === 'template' ? item.description : (titled ? item.prompt : (item.lane || ''));
        return (
          <PromptItemButton key={id} label={label} text={text} onInsert={() => onInsert(item.prompt)} />
        );
      })}
      {items.length > shown.length ? (
        <div className="flex items-center justify-between px-1 pt-0.5 text-[11px] text-ink3">
          <span>{zh() ? `显示 ${shown.length} / ${items.length}` : `${shown.length} of ${items.length}`}</span>
          <button
            type="button"
            onClick={() => { window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'history' } })); setExploreDock(false); }}
            className="font-medium text-honey hover:underline"
          >
            {zh() ? '打开历史记录' : 'Open History'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DisclosureSection({ title, open, onToggle, children }) {
  return (
    <div className="rounded-md border border-line1 bg-bg2/50">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-2.5 py-2 text-left text-xs font-semibold text-ink1"
      >
        {title}
        <Icon name="chevronDown" size={13} className={cx('text-ink3 transition-transform duration-150', open && 'rotate-180')} />
      </button>
      {open ? <div className="px-2 pb-2">{children}</div> : null}
    </div>
  );
}

function ExploreDockInner() {
  // Open state lives in the shared store so the trigger can live in the topbar
  // (out of the way of each studio's docked composer / Generate button).
  const [open, setOpenState] = useState(getExploreDock);
  const [context, setContext] = useState({ catalog: null, prompts: [], videoModels: [] });
  const [section, setSection] = useState(null); // 'templates' | 'ingredients' | null

  useEffect(() => subscribeExploreDock(setOpenState), []);

  const rootRef = useRef(null);

  // Outside-click + Escape close, with the same two guards ui/Menu.jsx's
  // useDismissable applies (a click inside a Modal is the modal's own; Escape
  // belongs to the topmost dialog) — the dock used to close under a dialog. Not
  // the hook itself: its close() carries no event, and the topbar trigger has
  // to be exempt or its click would close-then-reopen the dock.
  useEffect(() => {
    if (!open) return undefined;
    const inModal = (node) => Boolean(node?.closest?.('[role="dialog"]'));
    const modalOpen = () => Boolean(document.querySelector('[role="dialog"]'));
    const onDown = (e) => {
      if (inModal(e.target)) return;
      if (rootRef.current && rootRef.current.contains(e.target)) return;
      if (e.target.closest?.('[data-explore-trigger]')) return;
      setExploreDock(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && !modalOpen()) setExploreDock(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const refreshContext = useCallback(
    (opts) =>
      loadHivemindStudioContext(opts).then((ctx) => {
        setContext(ctx);
        return ctx;
      }),
    [],
  );

  // Install-time behaviors: legacy plaintext-state scrub (studio mode), parent
  // readiness handshake, initial context discovery.
  useEffect(() => {
    loadStudioGenerationHistory('muapi_history');
    window.parent?.postMessage?.({ type: 'hivemind-explore-ready' }, window.location.origin);
    void refreshContext();
  }, [refreshContext]);

  // Keep in sync with context refreshes triggered elsewhere (studios, hub).
  useEffect(() => {
    const onCtx = (e) => {
      if (e.detail?.context) setContext(e.detail.context);
    };
    window.addEventListener('hivemind-context-updated', onCtx);
    return () => window.removeEventListener('hivemind-context-updated', onCtx);
  }, []);

  // Hub postMessage bridge — same-origin only, exact message types preserved.
  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      const type = event.data?.type;
      if (type === 'hivemind-owner-lock') {
        clearHivemindStudioPrivateState();
        resetVaultSession();
        clearResolvedMediaCache();
        return;
      }
      if (type === 'hivemind-explore-insert-prompt') insertIntoActivePrompt(event.data.text || '');
      if (type === 'hivemind-explore-refresh') void refreshContext({ refresh: true });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refreshContext]);

  // The old dock re-read its context every time it opened.
  useEffect(() => {
    if (!open) return;
    void refreshContext();
  }, [open, refreshContext]);

  // Only a studio page has a prompt to insert into. On a hub page the legacy
  // fallback probed the DOM for ANY textarea, which could append a template into
  // whatever the hub happened to show.
  const insert = (text) => {
    if (!text) return;
    const page = new URLSearchParams(window.location.search).get('page') || '';
    if (!PROMPT_PAGES.has(page)) {
      toast(zh() ? '打开图像或视频工作室后再插入提示词。' : 'Open the Image or Video studio to insert prompts.');
      return;
    }
    insertIntoActivePrompt(text);
  };

  const templates = context.catalog?.templates || [];

  if (!open) return null;

  // Anchored below the topbar's Hive-tools trigger (top-right), so it never
  // overlaps a studio's docked composer / Generate button.
  return (
    <div
      id="hivemind-explore-dock"
      ref={rootRef}
      className="hive-scale-in fixed right-3 top-[calc(var(--topbar-h)+8px)] z-[70] flex max-h-[min(560px,78vh)] w-[min(21rem,calc(100vw-1.5rem))] flex-col gap-3 overflow-y-auto rounded-lg border border-line1 bg-bg1 p-3 shadow-pop"
    >
          <div className="flex items-center justify-between gap-3 border-b border-line1 pb-2.5">
            <div>
              <SectionLabel className="text-honey">Hivemind</SectionLabel>
              <div className="text-[13px] font-semibold text-ink1">{zh() ? '提示词库' : 'Prompt library'}</div>
            </div>
            <button
              type="button"
              onClick={() => setExploreDock(false)}
              aria-label={zh() ? '关闭' : 'Close'}
              className="grid h-7 w-7 place-items-center rounded-md text-ink3 transition-colors hover:bg-bg2 hover:text-ink1"
            >
              <Icon name="x" size={14} />
            </button>
          </div>

          <DisclosureSection
            title={zh() ? '模板' : 'Templates'}
            open={section === 'templates'}
            onToggle={() => setSection(section === 'templates' ? null : 'templates')}
          >
            <PromptItemList items={templates} kind="template" onInsert={insert} />
          </DisclosureSection>

          <DisclosureSection
            title={zh() ? '配料' : 'Ingredients'}
            open={section === 'ingredients'}
            onToggle={() => setSection(section === 'ingredients' ? null : 'ingredients')}
          >
            <PromptItemList items={context.prompts || []} kind="ingredient" onInsert={insert} />
          </DisclosureSection>
    </div>
  );
}

export function ExploreDock() {
  // Studio-mode gate is URL/global-derived and constant per page load.
  if (!isHivemindStudioEnabled()) return null;
  return <ExploreDockInner />;
}
