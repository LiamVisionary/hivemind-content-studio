// LoRA groups — save the loaded adapters and their weights under a name, load
// them back in one click. Shared by the Image and Video studios through
// LoraSection. Groups are sealed to the owner vault (savedLibraryStore), so the
// server holds one opaque blob and never learns the names or their contents.
import { useState } from 'react';
import { toast } from 'react-hot-toast';
import { useSavedLibrary } from '../../hooks/hooks.js';
import { loraGroupFromSelection, loraGroupMatchesBase, loraSelectionFromGroup } from '../../lib/loraSelection.js';
import { LIBRARIES, deleteLibraryEntry, saveLibraryEntry } from '../../lib/savedLibraryStore.js';
import { Icon } from '../../ui/icons.jsx';
import { ConfirmModal } from '../../ui/Modal.jsx';
import { Menu } from '../../ui/Menu.jsx';
import { LibraryDeleteButton, LibraryStateNote, SaveNameModal } from '../../ui/SavedLibrary.jsx';
import { Button, cx } from '../../ui/kit.jsx';

const sameName = (left, right) => String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();

function groupSummary(group) {
  const total = group?.loras?.length || 0;
  const muted = (group?.loras || []).filter((lora) => lora.enabled === false).length;
  const parts = [`${total} LoRA${total === 1 ? '' : 's'}`];
  if (muted) parts.push(`${muted} muted`);
  if (group?.baseLabel) parts.push(group.baseLabel);
  return parts.join(' · ');
}

// `selection` drives the rendering (is Save enabled, how many LoRAs). `getSelection`
// is what actually gets SAVED: editing a weight only re-renders on commit, and
// clicking "Save group" is itself what commits it — so the rendered prop can still
// be one edit behind at the moment of the click. Read the live selection instead.
export function LoraGroupsMenu({ selection, getSelection, loras, baseModelId, baseLabel, baseModels, onLoad }) {
  const { entries, loading, locked, retry } = useSavedLibrary(LIBRARIES.loraGroups);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  // Groups from other models stay reachable but out of the way — the library is
  // shared across both studios, so an LTX stack must not crowd a Klein session.
  const [showOther, setShowOther] = useState(false);
  // The group this stack came from (loaded or last saved). Pre-filling its name
  // makes the common edit — load a group, retune a weight, save — an overwrite
  // rather than a near-duplicate the user then has to clean up.
  const [activeName, setActiveName] = useState('');

  const matching = entries.filter((entry) => loraGroupMatchesBase(entry.data, { baseModelId, baseModels }));
  const other = entries.filter((entry) => !loraGroupMatchesBase(entry.data, { baseModelId, baseModels }));

  const save = async (name) => {
    setSaving(true);
    try {
      await saveLibraryEntry(LIBRARIES.loraGroups, {
        name,
        data: loraGroupFromSelection(getSelection?.() || selection, { baseModelId, baseLabel, baseModels }),
      });
      const replaced = entries.some((entry) => sameName(entry.name, name));
      setActiveName(name);
      setSaveOpen(false);
      toast.success(replaced ? `Updated “${name}”.` : `Saved “${name}”.`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const load = (entry) => {
    const { selection: next, missing } = loraSelectionFromGroup(entry.data, loras);
    onLoad(next);
    setActiveName(entry.name);
    if (missing.length) {
      // Never silently apply a smaller stack than the one that was saved.
      toast(`Loaded “${entry.name}” — ${missing.length} not installed for this model: ${missing.join(', ')}`, { duration: 6000 });
    } else {
      toast.success(`Loaded “${entry.name}”.`);
    }
  };

  const remove = async () => {
    const entry = confirmDelete;
    setConfirmDelete(null);
    try {
      await deleteLibraryEntry(LIBRARIES.loraGroups, entry.id);
      // Don't keep aiming the save dialog at a group that no longer exists.
      if (sameName(entry.name, activeName)) setActiveName('');
      toast(`Deleted “${entry.name}”.`);
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <>
      <Menu
        width="w-72"
        trigger={(open, toggle) => (
          <Button
            size="sm"
            variant="neutral"
            icon="stack"
            // Re-check on open — see SavedPromptsMenu.
            onClick={() => { if (locked) retry(); toggle(); }}
            title="Load a saved LoRA group"
            className={cx(open && 'border-honey/50 text-honey')}
          >
            Groups
            {matching.length ? <span className="font-mono text-[10px] text-ink3">{matching.length}</span> : null}
          </Button>
        )}
      >
        {(close) => {
          const row = (entry, dimmed) => (
            <div
              key={entry.id}
              className={cx('flex items-center gap-1 rounded-md px-1 transition-colors hover:bg-bg2', dimmed && 'opacity-70 hover:opacity-100')}
            >
              <button
                type="button"
                onClick={() => { load(entry); close(); }}
                title={`Load ${entry.name}`}
                className="min-w-0 flex-1 px-1.5 py-1.5 text-left"
              >
                <div className="truncate text-[13px] font-medium text-ink1">{entry.name}</div>
                <div className="truncate text-[10px] text-ink3">{groupSummary(entry.data)}</div>
              </button>
              <LibraryDeleteButton label={`Delete ${entry.name}`} onClick={() => { setConfirmDelete(entry); close(); }} />
            </div>
          );
          return (
            <>
              <LibraryStateNote
                loading={loading}
                locked={locked}
                empty={!entries.length}
                emptyHint="No saved groups yet. Load the LoRAs you want, tune their weights, then use Save group."
              />
              {entries.length && !matching.length ? (
                <p className="px-2.5 py-2 text-xs leading-relaxed text-ink3">No saved groups for this model yet.</p>
              ) : null}
              <div className="max-h-72 overflow-y-auto">
                {matching.map((entry) => row(entry, false))}
                {other.length ? (
                  <>
                    <button
                      type="button"
                      aria-expanded={showOther}
                      onClick={() => setShowOther((current) => !current)}
                      title="Groups saved for other models — their LoRAs may not be installed here"
                      className="flex w-full items-center gap-1 px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-ink3 transition-colors hover:text-ink2"
                    >
                      <Icon name="chevronDown" size={11} className={cx('transition-transform duration-150', showOther && 'rotate-180')} />
                      Other models ({other.length})
                    </button>
                    {showOther ? other.map((entry) => row(entry, true)) : null}
                  </>
                ) : null}
              </div>
            </>
          );
        }}
      </Menu>

      <Button
        size="sm"
        variant="neutral"
        icon="plus"
        disabled={!selection.length}
        onClick={() => setSaveOpen(true)}
        title={selection.length ? 'Save these LoRAs and weights as a named group' : 'Load some LoRAs first'}
      >
        Save group
      </Button>

      <SaveNameModal
        open={saveOpen}
        busy={saving}
        title="Save LoRA group"
        label="Group name"
        placeholder="e.g. Anime portrait stack"
        hint={`${selection.length} LoRA${selection.length === 1 ? '' : 's'} and their weights${baseLabel ? ` · ${baseLabel}` : ''}`}
        initialName={activeName}
        existingLabel="Or overwrite a saved group"
        existing={entries.map((entry) => ({ id: entry.id, name: entry.name, hint: groupSummary(entry.data) }))}
        onClose={() => setSaveOpen(false)}
        onSave={save}
      />

      <ConfirmModal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={remove}
        title={`Delete “${confirmDelete?.name}”?`}
        body="This removes the saved group. The LoRA files themselves stay installed."
        confirmLabel="Delete group"
      />
    </>
  );
}
