// Portal modal — scrim, esc/outside close, sizes. One modal pattern for the whole app.
// Focus is managed here so every dialog behaves the same: focus moves into the
// panel on open (the first [autofocus] control, else the panel itself), Tab
// cycles inside it, and focus returns to the opener on close. Without this a
// keyboard user's focus stayed on the button behind the scrim and Tab walked
// the page underneath.
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.jsx';
import { lockBodyScroll } from '../lib/scrollLock.js';
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
    // Counted, not saved-and-restored: CompareViewer opens over this one, and
    // two naive locks unmounting in the same commit leave the page frozen with
    // nothing on screen to close. See lib/scrollLock.js.
    const releaseScroll = lockBodyScroll();
    if (panel) {
      const preferred = initialFocus === 'auto'
        ? panel.querySelector('[autofocus]') || panel.querySelector('[data-autofocus]')
        : null;
      const target = preferred || panel;
      // Let the scale-in animation start before stealing focus (no scroll jump).
      const raf = requestAnimationFrame(() => { try { target.focus({ preventScroll: true }); } catch { /* detached */ } });
      return () => {
        cancelAnimationFrame(raf);
        releaseScroll();
        if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
          try { opener.focus({ preventScroll: true }); } catch { /* non-critical */ }
        }
      };
    }
    return releaseScroll;
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
    // Below sm this is a BOTTOM SHEET, above it the centred dialog it has always
    // been. Same panel, same focus trap, same children — only where it is
    // anchored changes, which is the whole difference between a phone dialog
    // and a desktop one: a sheet comes up from the edge the thumb is already
    // at, keeps a strip of the page it came from visible above it, and is
    // dismissed by pressing that strip.
    //
    // `items-end` + `p-0` do the anchoring; the panel drops its bottom corners
    // and its bottom border, takes the home indicator as padding, and is capped
    // in dvh rather than vh so a mobile browser's own chrome is counted.
    <div className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-4" role="presentation">
      <div className="absolute inset-0 bg-scrim backdrop-blur-[2px]" onClick={dismissable ? onClose : undefined} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cx(
          'hive-sheet-in relative flex w-full flex-col overflow-hidden border border-line1 bg-bg1 shadow-overlay outline-none',
          'max-h-[88dvh] rounded-t-2xl border-b-0 pb-[env(safe-area-inset-bottom)]',
          'sm:max-h-[86vh] sm:rounded-xl sm:border-b sm:pb-0',
          SIZES[size],
        )}
      >
        {/* The grab handle. It is not a control — the sheet is dismissed by the
            scrim, the X and Escape — but its absence is what makes a web sheet
            read as a page that has slid up rather than as a sheet. */}
        <div className="flex shrink-0 justify-center pt-2 sm:hidden" aria-hidden="true">
          <span className="h-1 w-9 rounded-full bg-white/15" />
        </div>
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
                  // Through the control ladder, so a thumb gets 44px and a
                  // cursor keeps 24.5. `hover:` says nothing on touch, so the
                  // press has an active state of its own to answer with.
                  className="grid h-7 w-7 place-items-center rounded-md text-ink3 transition-colors hover:bg-bg2 hover:text-ink1 active:bg-bg2 touch:h-ctl-md touch:w-ctl-md"
                >
                  <Icon name="x" size={15} />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
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
