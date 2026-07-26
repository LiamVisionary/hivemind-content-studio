// Shared chrome for the owner-sealed named libraries (LoRA groups, saved
// prompts): the name dialog and the non-list states every library menu needs.
// The libraries themselves live in src/lib/savedLibraryStore.js.
import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.jsx';
import { Modal } from './Modal.jsx';
import { Button, Field, Spinner, TextInput } from './kit.jsx';

/**
 * Name-this-and-save dialog. Enter submits, Escape closes (Modal owns Escape).
 * Warns before overwriting rather than silently creating a second entry with the
 * same name, which the user could not tell apart afterwards.
 */
export function SaveNameModal({
  open, title, label, hint, placeholder, initialName = '', takenNames = [], busy = false, confirmLabel = 'Save', onClose, onSave,
}) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    // Autofocus after the portal paints so the caret lands in the field.
    const id = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(id);
  }, [open, initialName]);

  const clean = name.trim();
  const overwrites = takenNames.some((taken) => taken.trim().toLowerCase() === clean.toLowerCase());
  const submit = () => { if (clean && !busy) onSave(clean); };

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
