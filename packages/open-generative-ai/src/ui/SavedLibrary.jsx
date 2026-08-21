// Shared chrome for the owner-sealed named libraries (LoRA groups, saved
// prompts): the name dialog and the non-list states every library menu needs.
// The libraries themselves live in src/lib/savedLibraryStore.js.
import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.jsx';
import { Modal } from './Modal.jsx';
import { Button, Field, SectionLabel, Spinner, TextInput, cx } from './kit.jsx';

const same = (left, right) => String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();

/**
 * Name-this-and-save dialog. Enter submits, Escape closes (Modal owns Escape).
 * Saving is an upsert by name, so an existing entry can be replaced two ways:
 * type its name, or pick it from `existing` — nobody should have to remember the
 * exact spelling of a name they saved to update it.
 *
 * `existing`: [{ id, name, hint }] — omit to hide the picker. `takenNames` is
 * derived from it, and only needs passing when there is no picker.
 */
export function SaveNameModal({
  open, title, label, hint, placeholder, initialName = '', existing = [], existingLabel = 'Or replace one you saved',
  takenNames = existing.map((entry) => entry.name), busy = false, confirmLabel = 'Save', onClose, onSave,
  // Anything a library needs to ask for beside the name (a persona's gender),
  // rendered under the name field. The dialog stays the one place a named
  // thing is saved, rather than each library growing a dialog of its own.
  children = null,
}) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    // Autofocus after the portal paints so the caret lands in the field. select()
    // (not focus) so a pre-filled name is replaced by typing but kept by Enter.
    const id = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(id);
  }, [open, initialName]);

  const clean = name.trim();
  const overwrites = takenNames.some((taken) => same(taken, clean));
  const submit = () => { if (clean && !busy) onSave(clean); };

  // Picking a row only targets it — the save still goes through the same button,
  // so an accidental tap on the list never overwrites anything.
  const pick = (entry) => {
    setName(entry.name);
    inputRef.current?.focus();
  };

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      title={title}
      size="sm"
      dismissable={!busy}
      footer={(
        <>
          <Button variant="neutral" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!clean} loading={busy}>
            {overwrites ? 'Overwrite' : confirmLabel}
          </Button>
        </>
      )}
    >
      <Field label={label} hint={overwrites ? `Replaces the “${clean}” you already saved.` : hint}>
        <TextInput
          ref={inputRef}
          value={name}
          placeholder={placeholder}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        />
      </Field>
      {children}

      {existing.length ? (
        <div className="mt-3">
          <SectionLabel>{existingLabel}</SectionLabel>
          <div className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-line1">
            {existing.map((entry) => {
              const targeted = same(entry.name, clean);
              return (
                <button
                  type="button"
                  key={entry.id || entry.name}
                  onClick={() => pick(entry)}
                  disabled={busy}
                  aria-pressed={targeted}
                  title={`Save over “${entry.name}”`}
                  className={cx(
                    'flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors disabled:opacity-50',
                    targeted ? 'bg-honey-tint' : 'hover:bg-bg2',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink1">{entry.name}</span>
                    {entry.hint ? <span className="block truncate text-[10px] text-ink3">{entry.hint}</span> : null}
                  </span>
                  {targeted ? <Icon name="check" size={13} className="shrink-0 text-honey" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink3">
        <Icon name="lock" size={12} className="mt-px shrink-0" />
        Encrypted with your key before it leaves the browser — the name and its contents are unreadable to the server.
      </p>
    </Modal>
  );
}

/**
 * The loading / locked / empty states of a library menu. Returns null once there
 * is something to list, so callers render `<LibraryStateNote …/>` then the rows.
 */
export function LibraryStateNote({ loading, locked, empty, emptyHint }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 px-2.5 py-3 text-xs text-ink3">
        <Spinner size={12} /> Opening your encrypted library…
      </div>
    );
  }
  if (locked) {
    return (
      <div className="flex items-start gap-2 px-2.5 py-3 text-xs leading-relaxed text-ink3">
        <Icon name="lock" size={13} className="mt-px shrink-0" />
        <span>Unlock the studio (top right) to reach your saved items — they are encrypted with your key.</span>
      </div>
    );
  }
  if (empty) return <p className="px-2.5 py-3 text-xs leading-relaxed text-ink3">{emptyHint}</p>;
  return null;
}

/** Trailing delete affordance for a library row. Never nested inside a button. */
export function LibraryDeleteButton({ label, onClick }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid h-6 w-6 shrink-0 place-items-center rounded-sm text-ink3 transition-colors hover:bg-danger-tint hover:text-danger"
    >
      <Icon name="trash" size={12} />
    </button>
  );
}
