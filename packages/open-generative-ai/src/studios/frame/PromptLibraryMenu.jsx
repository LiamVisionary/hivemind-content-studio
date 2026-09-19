// The Hivemind prompt library — saved Templates and Ingredients, written into
// the composer this popover is anchored in.
//
// It used to be a fixed panel pinned to the window's top-right corner (the
// "explore dock"), opened by a row in the composer's `more` menu at the bottom
// of the screen. The press and the panel were at opposite corners, and the row
// carried a check mark that made a prompt door look like a setting. Now it
// behaves like every other door in this row — Camera, Improve, Starters: press
// it, a popover opens over the press, and it dismisses on Escape, on a click
// outside, or as soon as it has written the box.
//
// Mounted only while it is open (the `more` row flips the shared store, exactly
// as CameraMenu is mounted by its own row), so a composer that never opens it
// pays nothing and the tool row does not grow a fifth permanent button.
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';

import { getPromptLibraryOpen, setPromptLibraryOpen, subscribePromptLibrary } from '../../app/promptLibraryStore.js';
import { insertIntoActivePrompt } from '../../app/promptTarget.js';
import { isHivemindStudioEnabled, loadHivemindStudioContext } from '../../lib/hivemindStudio.js';
import { Icon } from '../../ui/icons.jsx';
import { cx } from '../../ui/kit.jsx';
import { Menu } from '../../ui/Menu.jsx';
import { ComposerTool } from './ComposerPanel.jsx';

// How many templates/ingredients the list shows before pointing at History.
const LIST_LIMIT = 8;

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
    return <p className="px-1 py-2 text-[11px] text-ink3">Nothing saved yet.</p>;
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
          <span>{`${shown.length} of ${items.length}`}</span>
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'history' } }));
              setPromptLibraryOpen(false);
            }}
            className="font-medium text-honey hover:underline"
          >
            Open History
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DisclosureSection({ title, count, open, onToggle, children }) {
  return (
    <div className="rounded-md border border-line1 bg-bg2/50">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-xs font-semibold text-ink1"
      >
        <span>{title}</span>
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[11px] font-normal text-ink3">{count}</span>
          <Icon name="chevronDown" size={13} className={cx('text-ink3 transition-transform duration-150', open && 'rotate-180')} />
        </span>
      </button>
      {open ? <div className="px-2 pb-2">{children}</div> : null}
    </div>
  );
}

function PromptLibraryPanel() {
  const [context, setContext] = useState({ catalog: null, prompts: [] });
  // Which section is expanded. Null until the first context lands, then the
  // fullest one opens itself: two collapsed accordions in a popover you pressed
  // for prompts is two more presses before it shows a single prompt.
  const [section, setSection] = useState(null);
  const [touched, setTouched] = useState(false);

  const close = useCallback(() => setPromptLibraryOpen(false), []);

  // Re-read on open, as the dock did. The loader caches and dispatches
  // 'hivemind-context-updated', which the bridge and the studios also listen to.
  useEffect(() => {
    let live = true;
    void loadHivemindStudioContext().then((ctx) => { if (live) setContext(ctx); });
    const onCtx = (e) => { if (e.detail?.context) setContext(e.detail.context); };
    window.addEventListener('hivemind-context-updated', onCtx);
    return () => { live = false; window.removeEventListener('hivemind-context-updated', onCtx); };
  }, []);

  const templates = context.catalog?.templates || [];
  const ingredients = context.prompts || [];
  const shownSection = touched ? section : (templates.length ? 'templates' : (ingredients.length ? 'ingredients' : null));
  const toggle = (name) => { setTouched(true); setSection(shownSection === name ? null : name); };

  // The door that writes the box closes when it writes it — the popover is
  // anchored over the composer, so leaving it open would hide the very prompt
  // the press just changed.
  const insert = (text) => {
    if (!text) return;
    if (!insertIntoActivePrompt(text)) {
      toast('Open the Image or Video studio to insert prompts.');
      return;
    }
    close();
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="px-1 pb-0.5 text-[11px] text-ink3">
        Saved templates and ingredients, written into the prompt box.
      </div>
      <DisclosureSection
        title="Templates"
        count={templates.length}
        open={shownSection === 'templates'}
        onToggle={() => toggle('templates')}
      >
        <PromptItemList items={templates} kind="template" onInsert={insert} />
      </DisclosureSection>
      <DisclosureSection
        title="Ingredients"
        count={ingredients.length}
        open={shownSection === 'ingredients'}
        onToggle={() => toggle('ingredients')}
      >
        <PromptItemList items={ingredients} kind="ingredient" onInsert={insert} />
      </DisclosureSection>
    </div>
  );
}

export function PromptLibraryMenu() {
  const [open, setOpen] = useState(getPromptLibraryOpen);
  useEffect(() => subscribePromptLibrary(setOpen), []);
  // Studio mode only, exactly as the retired topbar button was: outside it there
  // is no Hivemind server to read templates and ingredients from.
  if (!isHivemindStudioEnabled() || !open) return null;
  return (
    <Menu
      up
      align="end"
      width="w-[20rem]"
      open
      onOpenChange={(next) => setPromptLibraryOpen(next)}
      trigger={() => (
        <ComposerTool
          icon="logo"
          label="Hivemind prompt library"
          active
          onClick={() => setPromptLibraryOpen(false)}
        />
      )}
    >
      <PromptLibraryPanel />
    </Menu>
  );
}
