// ⌘K — one search box over the whole app.
//
// Eighteen pages, a strip of studio tabs, a sealed prompt library and whatever
// models this machine has installed were all reachable only by mouse. This is the
// keyboard door to all four: type, arrow, Enter. It is also the map — a new user
// who presses ⌘K once sees everything the app can do in one list.
//
// Nothing is fetched until it opens (App renders this only while open), and the
// prompt library is read through the same sealed store the composer uses, so a
// locked vault lists no prompts and offers the unlock instead of a dead group.
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useSavedLibrary } from '../hooks/hooks.js';
import { buildPaletteEntries, filterPaletteEntries, paletteGroupLabel } from '../lib/commandPalette.js';
import { localAI } from '../lib/localInferenceClient.js';
import { LIBRARIES } from '../lib/savedLibraryStore.js';
import { readTabLabels } from '../lib/studioTabLabel.js';
import { selectSendTarget } from '../lib/studioTargets.js';
import { requestVaultUnlock } from '../lib/vaultSession.js';
import { Icon } from '../ui/icons.jsx';
import { Modal } from '../ui/Modal.jsx';
import { Kbd, TextInput, cx } from '../ui/kit.jsx';
import { NAV_ITEMS } from './navConfig.jsx';
import { insertIntoActivePrompt } from './promptTarget.js';


const TEXT = {
  title: () => 'Go to',
  placeholder: () => 'Search pages, tabs, prompts, models…',
  empty: () => 'Nothing matches that.',
  unlock: () => 'Unlock your vault to search saved prompts',
  inserted: () => 'Prompt added to the composer',
  noComposer: () => 'This page has no prompt box — open a studio first.',
  handoffFailed: () => "Couldn't open that model — try it from the Models page.",
  hintNav: () => 'to select',
  hintOpen: () => 'to open',
};

export function CommandPalette({ open, page, onClose, onNavigate }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [models, setModels] = useState([]);
  const listRef = useRef(null);
  const library = useSavedLibrary(LIBRARIES.prompts);

  // Installed models, asked for once per opening. A silent [] is right here: the
  // Models page is where a dead catalog gets reported and repaired.
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    void localAI.listModels()
      .then((catalog) => { if (alive) setModels(Array.isArray(catalog?.models) ? catalog.models : []); })
      .catch(() => { if (alive) setModels([]); });
    return () => { alive = false; };
  }, [open]);

  useEffect(() => { if (open) { setQuery(''); setCursor(0); } }, [open]);

  const entries = useMemo(() => {
    if (!open) return [];
    // Only the tabbed studios ever publish a strip, so a page with none simply
    // reads back an empty list — no second list of which pages have tabs.
    const tabs = readTabLabels(page);
    return buildPaletteEntries({
      navItems: NAV_ITEMS,
      studioType: tabs.length ? page : '',
      tabs,
      prompts: library.entries || [],
      models,
    });
  }, [open, page, library.entries, models]);

  const shown = useMemo(() => filterPaletteEntries(entries, query), [entries, query]);
  const active = shown[Math.min(cursor, Math.max(shown.length - 1, 0))] || null;

  const run = (entry) => {
    if (!entry || entry.disabled) return;
    onClose();
    if (entry.kind === 'page') onNavigate(entry.payload.page);
    else if (entry.kind === 'tab') selectSendTarget(entry.payload.studioType, entry.payload.tabId);
    // The Models tab's own handoff, loaded on use so its studio preference
    // modules stay out of the app's first chunk.
    else if (entry.kind === 'model') {
      void import('../hub/views/models/openInStudio.js')
        .then(({ openModelInStudio }) => openModelInStudio(entry.payload.model))
        .catch(() => toast.error(TEXT.handoffFailed()));
    }
    else if (entry.kind === 'prompt') {
      if (insertIntoActivePrompt(entry.payload.prompt)) toast.success(TEXT.inserted());
      else toast.error(TEXT.noComposer());
    }
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!shown.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setCursor((prev) => (prev + step + shown.length) % shown.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      run(active);
    }
  };

  // Keep the highlighted row on screen while the arrows walk a long list.
  useEffect(() => {
    const node = listRef.current?.querySelector('[data-palette-active="true"]');
    try { node?.scrollIntoView({ block: 'nearest' }); } catch { /* non-critical */ }
  }, [cursor, shown.length]);

  if (!open) return null;

  let lastKind = '';
  return (
    <Modal open onClose={onClose} title={TEXT.title()} size="lg">
      <div onKeyDown={onKeyDown}>
        <TextInput
          data-autofocus
          value={query}
          onChange={(event) => { setQuery(event.target.value); setCursor(0); }}
          placeholder={TEXT.placeholder()}
          aria-label={TEXT.placeholder()}
        />

        {/* The vault is locked: say so where the prompts would have been, with
            the button that opens it — not a silently empty group. */}
        {library.locked ? (
          <button
            type="button"
            onClick={() => { onClose(); requestVaultUnlock(); }}
            className="mt-3 flex w-full items-center gap-2.5 rounded-md border border-honey/40 bg-honey-tint px-2.5 py-2 text-left text-[13px] font-semibold text-honey"
          >
            <Icon name="unlock" size={15} />
            {TEXT.unlock()}
          </button>
        ) : null}

        <div ref={listRef} className="mt-3 max-h-[52vh] overflow-y-auto" role="listbox" aria-label={TEXT.title()}>
          {shown.length === 0 ? (
            <p className="px-1 py-6 text-center text-[13px] text-ink3">{TEXT.empty()}</p>
          ) : null}
          {shown.map((entry, index) => {
            const heading = entry.kind !== lastKind ? paletteGroupLabel(entry.kind) : '';
            lastKind = entry.kind;
            const on = index === Math.min(cursor, shown.length - 1);
            return (
              <div key={entry.id}>
                {heading ? (
                  <div className="px-2.5 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink3">{heading}</div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  data-palette-active={on ? 'true' : undefined}
                  disabled={entry.disabled}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => run(entry)}
                  className={cx(
                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors duration-150',
                    on ? 'bg-honey-tint text-ink1' : 'text-ink2 hover:bg-bg2 hover:text-ink1',
                    entry.disabled && 'opacity-40',
                  )}
                >
                  <Icon name={entry.icon} size={15} className={on ? 'shrink-0 text-honey' : 'shrink-0 text-ink3'} />
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  {entry.hint ? <span className="shrink-0 truncate font-mono text-[11px] text-ink3">{entry.hint}</span> : null}
                </button>
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex items-center gap-3 border-t border-line1 pt-2.5 text-[11px] text-ink3">
          <span className="inline-flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> {TEXT.hintNav()}</span>
          <span className="inline-flex items-center gap-1"><Kbd>↵</Kbd> {TEXT.hintOpen()}</span>
          <span className="inline-flex items-center gap-1"><Kbd>esc</Kbd> to close</span>
        </div>
      </div>
    </Modal>
  );
}
