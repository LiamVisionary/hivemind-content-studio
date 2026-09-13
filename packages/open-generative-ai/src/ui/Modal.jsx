// Portal modal — scrim, esc/outside close, sizes. One modal pattern for the whole app.
// Focus is managed here so every dialog behaves the same: focus moves into the
// panel on open (the first [autofocus] control, else the panel itself), Tab
// cycles inside it, and focus returns to the opener on close. Without this a
// keyboard user's focus stayed on the button behind the scrim and Tab walked
// the page underneath.
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.jsx';
import { Button, cx } from './kit.jsx';

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  // The root font is 14px, so `lg` is 588px and `xl` is 784px — nothing lands
  // on the ~760px a reading column wants, hence one pinned width rather than a
  // rem step that means something different here than it does in the docs.
  wide: 'max-w-[760px]',
  xl: 'max-w-4xl',
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

export function Modal({
  open = true, onClose, title,
  // A control that belongs BESIDE the title rather than in the footer — the
  // prompt helper's model pill, which is a property of the whole dialog and not
  // of any one action in it. A sibling of the <h2> rather than part of it, so
  // the dialog's accessible name stays the title alone.
  titleAside = null,
  size = 'md', children, footer, dismissable = true, initialFocus = 'auto',
}) {
  const panelRef = useRef(null);
  const titleId = useId();

  // Escape belongs to the TOPMOST dialog only: the image viewer stays mounted
  // under Expand/Edit/Compare, and one keypress used to close both.
  useEffect(() => {
    if (!open || !dismissable) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const dialogs = document.querySelectorAll('[role="dialog"]');
      const top = dialogs[dialogs.length - 1];
      if (top && panelRef.current && top !== panelRef.current && !panelRef.current.contains(top)) return;
      onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, dismissable, onClose]);

  // Focus in on open, restore on close; lock page scroll while open.
  useEffect(() => {
    if (!open) return undefined;
    const panel = panelRef.current;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (panel) {
      const preferred = initialFocus === 'auto'
        ? panel.querySelector('[autofocus]') || panel.querySelector('[data-autofocus]')
        : null;
      const target = preferred || panel;
      // Let the scale-in animation start before stealing focus (no scroll jump).
      const raf = requestAnimationFrame(() => { try { target.focus({ preventScroll: true }); } catch { /* detached */ } });
      return () => {
        cancelAnimationFrame(raf);
        document.body.style.overflow = previousOverflow;
        if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
          try { opener.focus({ preventScroll: true }); } catch { /* non-critical */ }
        }
      };
    }
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open, initialFocus]);

  if (!open) return null;

  // Keep Tab inside the panel (a minimal trap; no dependency).
  const onKeyDown = (e) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = focusables(panelRef.current);
    if (!items.length) { e.preventDefault(); panelRef.current.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="presentation">
      <div className="absolute inset-0 bg-scrim backdrop-blur-[2px]" onClick={dismissable ? onClose : undefined} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cx(
          'hive-scale-in relative flex max-h-[86vh] w-full flex-col overflow-hidden rounded-xl border border-line1 bg-bg1 shadow-overlay outline-none',
          SIZES[size],
        )}
      >
        {title ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line1 px-5 py-3.5">
            {/* Truncation is for a header that has to SHARE its row. Applied to
                every dialog it would ellipsize the small confirms, whose title
                is the only place the thing being deleted is named. */}
            <h2 id={titleId} className={cx('text-sm font-semibold text-ink1', titleAside && 'min-w-0 truncate')}>{title}</h2>
            <div className="flex min-w-0 shrink-0 items-center gap-2">
              {titleAside}
              {dismissable ? (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="grid h-7 w-7 place-items-center rounded-md text-ink3 transition-colors hover:bg-bg2 hover:text-ink1"
                >
                  <Icon name="x" size={15} />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {/* Footer wraps: an action row that outgrows the dialog falls to a second
            row instead of running off the left edge under justify-end. */}
        {footer ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line1 px-5 py-3.5">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

// Standard destructive confirm — the ONE pattern for delete/discard everywhere.
// Destructive confirms land focus on Cancel (a stray Enter must never delete);
// `tone="primary"` is for money/irreversible-but-not-destructive actions (Rent,
// Stock) — those focus the confirm button and use the primary colour.
export function ConfirmModal({
  open, onClose, onConfirm, title, body, confirmLabel = 'Delete', cancelLabel = 'Cancel', busy = false, tone = 'danger',
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy} data-autofocus={tone === 'danger' ? true : undefined}>{cancelLabel}</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} data-autofocus={tone === 'danger' ? undefined : true}>{confirmLabel}</Button>
        </>
      }
    >
      {typeof body === 'string' ? <p className="text-[13px] leading-relaxed text-ink2">{body}</p> : body}
    </Modal>
  );
}
