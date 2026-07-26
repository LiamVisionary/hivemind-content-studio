// Portal modal — scrim, esc/outside close, sizes. One modal pattern for the whole app.
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.jsx';
import { Button, cx } from './kit.jsx';

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

export function Modal({ open = true, onClose, title, size = 'md', children, footer, dismissable = true }) {
  useEffect(() => {
    if (!open || !dismissable) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, dismissable, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-scrim backdrop-blur-[2px]" onClick={dismissable ? onClose : undefined} />
      <div
        className={cx(
          'hive-scale-in relative flex max-h-[86vh] w-full flex-col overflow-hidden rounded-xl border border-line1 bg-bg1 shadow-overlay',
          SIZES[size],
        )}
      >
        {title ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line1 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-ink1">{title}</h2>
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
export function ConfirmModal({ open, onClose, onConfirm, title, body, confirmLabel = 'Delete', busy = false }) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm} loading={busy}>{confirmLabel}</Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-ink2">{body}</p>
    </Modal>
  );
}
