// Hivemind explore dock (React port of hivemindStudio.js installHivemindExploreDock).
// Rendered once by App (singleton); returns null outside studio mode.
//
// Contracts preserved verbatim:
// - sessionStorage 'hivemind.explore.videoSelection' = { provider: 'media-studio-mcp',
//   model: workflowId, modelId } and 'hivemind.explore.options' =
//   { promptHelper, passthrough, walkthrough } (same shapes as the module-private
//   saveHivemindVideoSelection / saveHivemindStudioOptions writers)
// - option mutual exclusivity: passthrough on -> promptHelper off, and vice versa
// - workflow select: save selection, dispatch window 'navigate' {page:'video'},
//   then AFTER setTimeout(0) dispatch 'hivemind-workflow-selected' {modelId}
// - template/ingredient click inserts via insertIntoActivePrompt (promptTarget bridge)
// - window 'message' (same-origin only): 'hivemind-owner-lock' -> clear private
//   state + reset vault session + clear resolved media cache;
//   'hivemind-explore-insert-prompt' {text}; 'hivemind-explore-refresh'
// - readiness handshake: postMessage {type:'hivemind-explore-ready'} to parent
// - install-time legacy plaintext scrub (via loadStudioGenerationHistory, which
//   scrubs 'muapi_history'/'video_history'/'muapi_pending_jobs' in studio mode)
import { useCallback, useEffect, useRef, useState } from 'react';
import { getExploreDock, setExploreDock, subscribeExploreDock } from '../app/exploreDockStore.js';
import { insertIntoActivePrompt } from '../app/promptTarget.js';
import { clearResolvedMediaCache } from '../lib/e2eMedia.js';
import {
  clearHivemindStudioPrivateState,
  getHivemindStudioOptions,
  getSavedHivemindVideoSelection,
  isHivemindStudioEnabled,
  loadHivemindStudioContext,
  loadStudioGenerationHistory,
} from '../lib/hivemindStudio.js';
import { resetVaultSession } from '../lib/vaultSession.js';
import { Icon } from '../ui/icons.jsx';
import { NativeSelect, SectionLabel, Toggle, cx } from '../ui/kit.jsx';

const OPTIONS_KEY = 'hivemind.explore.options';
const VIDEO_SELECTION_KEY = 'hivemind.explore.videoSelection';

const OPTION_ROWS = [
  {
    key: 'promptHelper',
    label: 'Prompt helper',
    description: 'Let the studio refine your prompt before generating.',
  },
  {
    key: 'passthrough',
    label: 'Passthrough',
    description: 'Send prompts exactly as written — turns the helper off.',
  },
  {
    key: 'walkthrough',
    label: 'Ask first',
    description: 'Walk through the options before each generation.',
  },
];

function PromptItemButton({ label, text, onInsert }) {
  return (
    <button
      type="button"
      onClick={onInsert}
      className="w-full rounded-md border border-line1 bg-bg2 px-2.5 py-2 text-left transition-colors duration-150 hover:border-line2 hover:bg-bg3"
    >
      <span className="block truncate text-xs font-medium text-ink1">{label}</span>
      <span className="block truncate text-[11px] text-ink3">{text}</span>
    </button>
  );
}

function PromptItemList({ items, kind, onInsert }) {
  if (!items.length) {
    return <p className="px-1 py-2 text-[11px] text-ink3">Nothing saved yet.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {items.slice(0, 8).map((item) => {
        const id = kind === 'template' ? item.id : item.prompt_id;
        const label = kind === 'template' ? item.title : item.prompt;
        const text = kind === 'template' ? item.description : item.prompt;
        return (
          <PromptItemButton key={id} label={label} text={text} onInsert={() => onInsert(item.prompt)} />
        );
      })}
    </div>
  );
}

function DisclosureSection({ title, open, onToggle, children }) {
  return (
    <div className="rounded-md border border-line1 bg-bg2/50">
      <button
        type="button"
        onClick={onToggle}
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
  const [options, setOptions] = useState(getHivemindStudioOptions);
  const [selectedModelId, setSelectedModelId] = useState(
    () => getSavedHivemindVideoSelection()?.modelId || '',
  );
  const [section, setSection] = useState(null); // 'templates' | 'ingredients' | null
  const rootRef = useRef(null);

  useEffect(() => subscribeExploreDock(setOpenState), []);

  // Outside-click + Escape close, but ignore the topbar trigger (it toggles).
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && rootRef.current.contains(e.target)) return;
      if (e.target.closest?.('[data-explore-trigger]')) return;
      setExploreDock(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setExploreDock(false);
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
        setOptions(getHivemindStudioOptions());
        setSelectedModelId('');
        return;
      }
      if (type === 'hivemind-explore-insert-prompt') insertIntoActivePrompt(event.data.text || '');
      if (type === 'hivemind-explore-refresh') void refreshContext({ refresh: true });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refreshContext]);

  // The old dock re-read context + saved selection every time it opened.
  useEffect(() => {
    if (!open) return;
    void refreshContext();
    setSelectedModelId(getSavedHivemindVideoSelection()?.modelId || '');
    setOptions(getHivemindStudioOptions());
  }, [open, refreshContext]);

  const setOption = (key, checked) => {
    const current = { ...getHivemindStudioOptions(), [key]: Boolean(checked) };
    // Mutual exclusivity — passthrough and the prompt helper cannot both be on.
    if (key === 'passthrough' && checked) current.promptHelper = false;
    if (key === 'promptHelper' && checked) current.passthrough = false;
    try {
      sessionStorage.setItem(OPTIONS_KEY, JSON.stringify(current));
    } catch {
      /* non-critical */
    }
    setOptions(current);
  };

  const selectWorkflow = (modelId) => {
    setSelectedModelId(modelId);
    const model = context.videoModels?.find((candidate) => candidate.id === modelId);
    if (!model) return;
    try {
      sessionStorage.setItem(
        VIDEO_SELECTION_KEY,
        JSON.stringify({ provider: 'media-studio-mcp', model: model.workflowId, modelId: model.id }),
      );
    } catch {
      /* non-critical */
    }
    window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'video' } }));
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('hivemind-workflow-selected', { detail: { modelId: model.id } }));
    }, 0);
  };

  const insert = (text) => {
    if (text) insertIntoActivePrompt(text);
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
              <div className="text-[13px] font-semibold text-ink1">Studio tools</div>
            </div>
            <button
              type="button"
              onClick={() => setExploreDock(false)}
              aria-label="Close"
              className="grid h-7 w-7 place-items-center rounded-md text-ink3 transition-colors hover:bg-bg2 hover:text-ink1"
            >
              <Icon name="x" size={14} />
            </button>
          </div>

          <label className="flex flex-col gap-1.5">
            <SectionLabel>Local video workflow</SectionLabel>
            <NativeSelect value={selectedModelId} onChange={(e) => selectWorkflow(e.target.value)}>
              <option value="">Choose on generate</option>
              {context.videoModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </NativeSelect>
          </label>

          <div className="flex flex-col gap-1.5">
            <SectionLabel>Generation options</SectionLabel>
            {OPTION_ROWS.map((row) => (
              <div
                key={row.key}
                className="flex items-center justify-between gap-3 rounded-md border border-line1 bg-bg2/50 px-2.5 py-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium text-ink1">{row.label}</div>
                  <div className="text-[11px] leading-snug text-ink3">{row.description}</div>
                </div>
                <Toggle
                  checked={Boolean(options[row.key])}
                  onChange={(checked) => setOption(row.key, checked)}
                  label={row.label}
                />
              </div>
            ))}
          </div>

          <DisclosureSection
            title="Templates"
            open={section === 'templates'}
            onToggle={() => setSection(section === 'templates' ? null : 'templates')}
          >
            <PromptItemList items={templates} kind="template" onInsert={insert} />
          </DisclosureSection>

          <DisclosureSection
            title="Ingredients"
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
