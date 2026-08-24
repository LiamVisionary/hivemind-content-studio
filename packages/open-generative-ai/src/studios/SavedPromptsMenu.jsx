// Saved prompts — name a prompt and keep it, with the entire generation setup
// that produced it (model, seed, LoRAs, aspect/resolution, steps, references, …).
// Loading offers both: the prompt text alone, or the prompt AND its settings.
//
// The whole library is sealed to the owner vault (savedLibraryStore), so prompt
// text never reaches the server in a readable form — the same client-only E2E
// rule the composer, history, and generated media already follow.
//
// Below the saved entries sits the DEFAULT library (lib/defaultPrompts.js): the
// starters that ship with the app, filtered to the model that is selected right
// now — each is a finished prompt in that model's own format, so the ones for
// other models are hidden rather than listed. They are not vault data, so they
// show even while the vault is locked.
import { useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useSavedLibrary } from '../hooks/hooks.js';
import { LIBRARIES, deleteLibraryEntry, saveLibraryEntry } from '../lib/savedLibraryStore.js';
import { defaultPromptsFor, describeDefaultPrompt, describeDefaultPromptPart } from '../lib/defaultPrompts.js';
import { ConfirmModal } from '../ui/Modal.jsx';
import { ChipButton, Menu, MenuHeading, MenuItem } from '../ui/Menu.jsx';
import { LibraryDeleteButton, LibraryStateNote, SaveNameModal } from '../ui/SavedLibrary.jsx';
import { Button, TextInput } from '../ui/kit.jsx';

const SECTION_LABEL = { image: 'Image', video: 'Video' };
// Past this many saved prompts a name list stops being scannable, so a filter
// box appears above it. Below it the box would only be one more thing to read.
const SEARCH_FROM = 7;

// Name first, then the one-line summary, then the prompt text itself — so
// "night" finds a prompt about a night street even when its name is "Shot 3".
export function filterSavedPrompts(entries, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => [entry.name, entry.data?.summary, entry.data?.prompt]
    .some((field) => String(field || '').toLowerCase().includes(needle)));
}

// One line describing what "+ settings" would restore, built at save time from
// whichever context shape the studio produced.
export function describeSavedContext(section, context) {
  if (!context) return '';
  const parts = [];
  if (section === 'video') {
    parts.push(context.modelName || context.model);
    parts.push(context.resolution);
    parts.push(context.aspectRatio);
    if (Number(context.duration)) parts.push(`${context.duration}s`);
  } else {
    parts.push(context.useLocalModel
      ? (context.selectedLocalModel || 'local model')
      : (context.selectedModelName || context.selectedModel));
    parts.push(context.customWidth && context.customHeight
      ? `${context.customWidth}×${context.customHeight}`
      : (context.resolution || context.aspectRatio));
    if (Number(context.steps)) parts.push(`${context.steps} steps`);
    if (Number(context.seed) >= 0) parts.push(`seed ${context.seed}`);
  }
  const loras = (context.loras || []).filter((lora) => lora?.enabled !== false).length;
  if (loras) parts.push(`${loras} LoRA${loras === 1 ? '' : 's'}`);
  const refs = (context.referenceImages || []).length + (context.ingredientImages || []).length;
  if (refs) parts.push(`${refs} reference${refs === 1 ? '' : 's'}`);
  return parts.filter(Boolean).map(String).join(' · ');
}

// `modelSource` is the current studio setup — used only to float the starters
// written for the selected model to the top, so it stays optional.
export function SavedPromptsMenu({
  section, prompt, negativePrompt = '', capture, modelSource = null, onLoadPrompt, onLoadContext,
  // Who the starters should be rendered for (the gender of whoever holds
  // <Subject 1>), and the stand-ins of the prompt in the composer — saved with
  // it so a library prompt binds its person when it is loaded onto a cast.
  renderGender = undefined, standIns = [],
}) {
  const { entries, loading, locked, error, unreadable, retry } = useSavedLibrary(LIBRARIES.prompts);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  // A save that met a library this key cannot open: held here until the user
  // says replacing that library is what they want.
  const [confirmReplace, setConfirmReplace] = useState(null);
  const [query, setQuery] = useState('');
  // The menu's close(), captured from the render prop so a delete can shut the
  // menu AFTER the confirm — not before it, which left a cancel with the menu gone.
  const closeMenuRef = useRef(null);

  const hasPrompt = Boolean(String(prompt || '').trim());
  const starters = defaultPromptsFor(section, modelSource, { gender: renderGender });
  const searchable = entries.length >= SEARCH_FROM;
  const shown = searchable ? filterSavedPrompts(entries, query) : entries;

  const save = async (name, { overwriteUnreadable = false } = {}) => {
    setSaving(true);
    try {
      const context = capture?.() || null;
      await saveLibraryEntry(LIBRARIES.prompts, {
        name,
        data: {
          section,
          prompt: String(prompt || ''),
          negativePrompt: String(negativePrompt || ''),
          // Which words of the prompt are its stand-in person, when it still
          // has one — so loading it onto a cast binds them (subjectTemplate.js).
          ...(Array.isArray(standIns) && standIns.length ? { standIns } : {}),
          context,
          summary: describeSavedContext(section, context),
        },
      }, { overwriteUnreadable });
      setSaveOpen(false);
      toast.success(`Saved “${name}”.`);
    } catch (error) {
      // The stored library could not be decrypted with this key. Never replace
      // it on the strength of a Save click alone — ask, then retry with consent.
      if (error?.unreadable) { setConfirmReplace(name); return; }
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const loadPromptOnly = (entry) => {
    onLoadPrompt({
      prompt: entry.data?.prompt || '',
      negativePrompt: entry.data?.negativePrompt || '',
      standIns: Array.isArray(entry.data?.standIns) ? entry.data.standIns : [],
    });
    toast.success(`Loaded the prompt from “${entry.name}”.`);
  };

  // A starter carries no negative prompt of its own, so the current one is
  // passed straight back rather than cleared — replacing the prompt text is what
  // was asked for, wiping a negative prompt is not.
  //
  // The toast carries the part's own instruction (arm the chain, press Extend)
  // because that step happens BEFORE the pasted prompt makes sense, and the
  // hover title it came from is gone the moment the menu closes.
  const loadStarter = (entry, part, index = 0) => {
    onLoadPrompt({ prompt: part.prompt, negativePrompt, standIns: part.standIns || [] });
    const name = entry.parts.length > 1
      ? `${entry.name} — part ${index + 1}`
      : entry.name;
    // The part's own step where there is one (arm the chain, press Extend),
    // otherwise the entry's (attach the reference clip, fill in the brackets).
    const step = part.note || entry.note;
    if (step) toast.success(`Loaded “${name}”. ${step}`, { duration: 10000 });
    else toast.success(`Loaded “${name}”.`);
  };

  const loadEverything = (entry) => {
    if (!onLoadContext?.(entry.data?.context)) {
      toast.error('Those settings could not be restored — the model may no longer be installed.');
      return;
    }
    toast.success(`Loaded “${entry.name}” with its settings.`);
  };

  const remove = async () => {
    const entry = confirmDelete;
    setConfirmDelete(null);
    try {
      await deleteLibraryEntry(LIBRARIES.prompts, entry.id);
      toast(`Deleted “${entry.name}”.`);
      closeMenuRef.current?.();
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <>
      <Menu
        up
        width="w-[22rem]"
        trigger={(open, toggle) => (
          <ChipButton
            icon="database"
            label="Prompts"
            active={open}
            // Re-check on open: the studio can mount before the owner unlocks,
            // and the locked note tells them to go and unlock.
            onClick={() => { if (locked) retry(); toggle(); }}
            title="Save this prompt and its settings, or load a saved one"
          />
        )}
      >
        {(close) => {
          closeMenuRef.current = close;
          return (
          <>
            <MenuItem
              icon="plus"
              disabled={!hasPrompt}
              onClick={() => { setSaveOpen(true); close(); }}
              title={hasPrompt ? 'Save this prompt with every current setting' : 'Write a prompt first'}
              className="font-medium text-ink1"
            >
              Save current prompt…
            </MenuItem>

            <div className="my-1 h-px bg-line1" />

            <LibraryStateNote
              loading={loading}
              locked={locked}
              error={error}
              onRetry={retry}
              unreadable={unreadable}
              empty={!entries.length}
              emptyHint="Nothing saved yet. Write a prompt, dial in the settings, then use Save current prompt."
            />

            {searchable ? (
              <div className="px-1 pb-1.5">
                <TextInput
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${entries.length} saved prompts`}
                  aria-label="Search saved prompts"
                  className="text-xs"
                />
              </div>
            ) : null}

            {entries.length && !shown.length ? (
              <p className="px-2.5 py-3 text-xs text-ink3">No saved prompt matches “{query.trim()}”.</p>
            ) : null}

            {shown.length ? (
              <div className="max-h-80 overflow-y-auto">
                {shown.map((entry) => {
                  const foreign = entry.data?.section && entry.data.section !== section;
                  const restorable = Boolean(entry.data?.context) && !foreign;
                  return (
                    <div key={entry.id} className="rounded-md px-1.5 py-1.5 transition-colors hover:bg-bg2">
                      <div className="flex items-start gap-1.5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-ink1">{entry.name}</div>
                          <div className="truncate text-[10px] text-ink3">
                            {foreign ? `${SECTION_LABEL[entry.data.section] || entry.data.section} · ` : ''}
                            {entry.data?.summary || 'Prompt only'}
                          </div>
                        </div>
                        {/* The menu stays open under the confirm: cancelling
                            used to drop you back with the menu shut. */}
                        <LibraryDeleteButton label={`Delete ${entry.name}`} onClick={() => setConfirmDelete(entry)} />
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="neutral"
                          onClick={() => { loadPromptOnly(entry); close(); }}
                          title="Replace the prompt text only — your current settings stay as they are"
                        >
                          Load prompt
                        </Button>
                        {/* Honey-outlined rather than a filled primary: a list of
                            entries would otherwise hold a primary per row. The
                            `!` is needed — the neutral variant's own border/text
                            colour utilities sort after these in the sheet. */}
                        <Button
                          size="sm"
                          variant="neutral"
                          className={restorable ? '!border-honey/50 !bg-honey-tint !text-honey hover:!border-honey' : ''}
                          disabled={!restorable}
                          onClick={() => { loadEverything(entry); close(); }}
                          title={
                            foreign
                              ? `Saved in the ${SECTION_LABEL[entry.data.section] || 'other'} studio — its settings do not apply here`
                              : restorable
                                ? 'Replace the prompt AND restore every setting saved with it'
                                : 'No settings were captured with this prompt'
                          }
                        >
                          Load prompt + settings
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {starters.length ? (
              <>
                <div className="my-1 h-px bg-line1" />
                <MenuHeading>Starter prompts</MenuHeading>
                <div className="max-h-72 overflow-y-auto">
                  {starters.map((entry) => {
                    const split = entry.parts.length > 1;
                    // A single-part starter is the row itself. A split one keeps
                    // the row as a label and gives each part its own button —
                    // the parts are generated in separate runs, so there is no
                    // "load the whole thing" to offer.
                    const Row = split ? 'div' : 'button';
                    return (
                      <div key={entry.id} className="rounded-md px-1 py-0.5">
                        <Row
                          {...(split ? {} : {
                            type: 'button',
                            onClick: () => { loadStarter(entry, entry.parts[0]); close(); },
                            title: entry.note || 'Replace the prompt text with this starter',
                          })}
                          className={`flex w-full flex-col items-start rounded-md px-1.5 py-1 text-left transition-colors ${split ? '' : 'hover:bg-bg2'}`}
                        >
                          <span className="truncate text-[13px] font-medium text-ink1">{entry.name}</span>
                          <span className="truncate text-[10px] text-ink3">{describeDefaultPrompt(entry)}</span>
                          {/* Media the prompt cannot run without — pasting one of
                              these into an empty composer and pressing Generate
                              produces a clip with no clip in it. */}
                          {entry.requires ? (
                            <span className="truncate text-[10px] text-honey">Needs {entry.requires}</span>
                          ) : null}
                        </Row>
                        {split ? (
                          <div className="mt-1 flex flex-wrap items-center gap-1 px-1.5 pb-1">
                            {entry.parts.map((part, index) => (
                              <Button
                                key={part.label}
                                size="sm"
                                variant="neutral"
                                onClick={() => { loadStarter(entry, part, index); close(); }}
                                title={[entry.note, part.note].filter(Boolean).join('\n\n')}
                              >
                                {describeDefaultPromptPart(part, index)}
                              </Button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}
          </>
          );
        }}
      </Menu>

      <SaveNameModal
        open={saveOpen}
        busy={saving}
        title="Save prompt"
        label="Name"
        placeholder="e.g. Cinematic night portrait"
        hint="Saved with every current setting — model, seed, LoRAs, aspect ratio, resolution, references."
        takenNames={entries.map((entry) => entry.name)}
        onClose={() => setSaveOpen(false)}
        onSave={save}
      />

      <ConfirmModal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={remove}
        title={`Delete “${confirmDelete?.name}”?`}
        body="This permanently removes the saved prompt and the settings stored with it."
        confirmLabel="Delete prompt"
      />

      <ConfirmModal
        open={Boolean(confirmReplace)}
        onClose={() => setConfirmReplace(null)}
        onConfirm={() => { const name = confirmReplace; setConfirmReplace(null); void save(name, { overwriteUnreadable: true }); }}
        title="Replace your unreadable prompt library?"
        body="The saved prompts on the server could not be decrypted with this key — they may have been sealed under an earlier vault. Saving now replaces that library with this one prompt. The old entries cannot be recovered afterwards."
        confirmLabel="Replace and save"
        cancelLabel="Keep the old library"
      />
    </>
  );
}
