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
import { useState } from 'react';
import { toast } from 'react-hot-toast';
import { useSavedLibrary } from '../hooks/hooks.js';
import { LIBRARIES, deleteLibraryEntry, saveLibraryEntry } from '../lib/savedLibraryStore.js';
import { defaultPromptsFor, describeDefaultPrompt, describeDefaultPromptPart } from '../lib/defaultPrompts.js';
import { Icon } from '../ui/icons.jsx';
import { ConfirmModal } from '../ui/Modal.jsx';
import { ChipButton, Menu, MenuHeading } from '../ui/Menu.jsx';
import { LibraryDeleteButton, LibraryStateNote, SaveNameModal } from '../ui/SavedLibrary.jsx';
import { cx } from '../ui/kit.jsx';

const SECTION_LABEL = { image: 'Image', video: 'Video' };

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
export function SavedPromptsMenu({ section, prompt, negativePrompt = '', capture, modelSource = null, onLoadPrompt, onLoadContext }) {
  const { entries, loading, locked, retry } = useSavedLibrary(LIBRARIES.prompts);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const hasPrompt = Boolean(String(prompt || '').trim());
  const starters = defaultPromptsFor(section, modelSource);

  const save = async (name) => {
    setSaving(true);
    try {
      const context = capture?.() || null;
      await saveLibraryEntry(LIBRARIES.prompts, {
        name,
        data: {
          section,
          prompt: String(prompt || ''),
          negativePrompt: String(negativePrompt || ''),
          context,
          summary: describeSavedContext(section, context),
        },
      });
      setSaveOpen(false);
      toast.success(`Saved “${name}”.`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const loadPromptOnly = (entry) => {
    onLoadPrompt({ prompt: entry.data?.prompt || '', negativePrompt: entry.data?.negativePrompt || '' });
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
    onLoadPrompt({ prompt: part.prompt, negativePrompt });
    const name = entry.parts.length > 1
      ? `${entry.name} — part ${index + 1}`
      : entry.name;
    if (part.note) toast.success(`Loaded “${name}”. ${part.note}`, { duration: 8000 });
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
        {(close) => (
          <>
            <button
              type="button"
              disabled={!hasPrompt}
              onClick={() => { setSaveOpen(true); close(); }}
              title={hasPrompt ? 'Save this prompt with every current setting' : 'Write a prompt first'}
              className={cx(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors',
                hasPrompt ? 'text-ink1 hover:bg-honey-tint hover:text-honey' : 'cursor-not-allowed text-ink3 opacity-60',
              )}
            >
              <Icon name="plus" size={14} className="shrink-0" />
              Save current prompt…
            </button>

            <div className="my-1 h-px bg-line1" />

            <LibraryStateNote
              loading={loading}
              locked={locked}
              empty={!entries.length}
              emptyHint="Nothing saved yet. Write a prompt, dial in the settings, then use Save current prompt."
            />

            {entries.length ? (
              <div className="max-h-80 overflow-y-auto">
                {entries.map((entry) => {
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
                        <LibraryDeleteButton label={`Delete ${entry.name}`} onClick={() => { setConfirmDelete(entry); close(); }} />
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => { loadPromptOnly(entry); close(); }}
                          title="Replace the prompt text only — your current settings stay as they are"
                          className="rounded-sm border border-line1 bg-bg1 px-2 py-1 text-[11px] font-semibold text-ink1 transition-colors hover:border-honey/50 hover:text-honey"
                        >
                          Load prompt
                        </button>
                        <button
                          type="button"
                          disabled={!restorable}
                          onClick={() => { loadEverything(entry); close(); }}
                          title={
                            foreign
                              ? `Saved in the ${SECTION_LABEL[entry.data.section] || 'other'} studio — its settings do not apply here`
                              : restorable
                                ? 'Replace the prompt AND restore every setting saved with it'
                                : 'No settings were captured with this prompt'
                          }
                          className={cx(
                            'rounded-sm border px-2 py-1 text-[11px] font-semibold transition-colors',
                            restorable
                              ? 'border-honey/50 bg-honey-tint text-honey hover:border-honey'
                              : 'cursor-not-allowed border-line1 bg-bg1 text-ink3 opacity-60',
                          )}
                        >
                          Load prompt + settings
                        </button>
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
                          className={cx(
                            'flex w-full flex-col items-start rounded-md px-1.5 py-1 text-left transition-colors',
                            split ? '' : 'hover:bg-bg2',
                          )}
                        >
                          <span className="truncate text-[13px] font-medium text-ink1">{entry.name}</span>
                          <span className="truncate text-[10px] text-ink3">{describeDefaultPrompt(entry)}</span>
                        </Row>
                        {split ? (
                          <div className="mt-1 flex flex-wrap items-center gap-1 px-1.5 pb-1">
                            {entry.parts.map((part, index) => (
                              <button
                                key={part.label}
                                type="button"
                                onClick={() => { loadStarter(entry, part, index); close(); }}
                                title={[entry.note, part.note].filter(Boolean).join('\n\n')}
                                className="rounded-sm border border-line1 bg-bg1 px-2 py-1 text-[11px] font-semibold text-ink1 transition-colors hover:border-honey/50 hover:text-honey"
                              >
                                {describeDefaultPromptPart(part, index)}
                              </button>
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
        )}
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
    </>
  );
}
