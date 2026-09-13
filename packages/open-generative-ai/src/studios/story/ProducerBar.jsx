// Who writes for you, and what this production is — the studio's own header row.
//
// The producer is a session decision, not a stage decision, so it sits above all
// four stages rather than inside the one that happens to be asking. It stays a
// popover rather than a card because the answer is one line ("Qwen3 30B ·
// local") ninety-nine times out of a hundred, and a permanent panel spends a
// quarter of the page saying it.
import { useEffect, useRef } from 'react';

import { Icon } from '../../ui/icons.jsx';
import { Button, IconButton, Spinner, cx } from '../../ui/kit.jsx';
import { ModelSourcePicker } from '../../components/ModelSourcePicker.jsx';
import { privacyLine, summaryLine } from '../../lib/textModels.js';

export function ProducerBar({
  summary, producer, open, onOpen, busy, thinking, onCancel, picker, warning,
}) {
  const ref = useRef(null);

  // A popover that only closes on its own button is a popover you have to
  // remember how to shut. Outside-click and Escape both close it; the panel
  // itself stops the click so picking a model does not close it out from under
  // the account form.
  useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (ref.current && !ref.current.contains(event.target)) onOpen(false); };
    const key = (event) => { if (event.key === 'Escape') onOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open, onOpen]);

  return (
    // Floating rather than a bar across the top: detached, rounded, translucent
    // over whatever it covers, and STICKY, so it keeps answering "who is
    // writing and what is this" while the stage below it scrolls. Aligned to
    // the same 820px column the stages use, so it reads as part of the page
    // rather than as chrome bolted above it.
    <div className="sticky top-0 z-30 mx-auto mb-1 mt-3 flex w-full max-w-[820px] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] bg-bg0/85 px-4 py-2 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.07)] backdrop-blur-xl">
      <span className="min-w-0 truncate text-[12px] text-ink3">{summary}</span>

      {busy ? (
        <span className="flex min-w-0 items-center gap-1.5 truncate text-[11.5px] text-honey">
          <Spinner size={12} />
          <span className="truncate">{thinking || 'Working…'}</span>
          <Button size="sm" onClick={onCancel}>Cancel</Button>
        </span>
      ) : null}

      {warning ? (
        <span className="min-w-0 truncate text-[11.5px] text-warn" title={warning}>{warning}</span>
      ) : null}

      <span className="relative ml-auto inline-flex" ref={ref}>
        <button
          type="button"
          onClick={() => onOpen(!open)}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={cx(
            'inline-flex h-ctl-md items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-semibold transition-colors',
            open ? 'border-honey/50 bg-honey-tint text-honey' : 'border-line1 bg-bg2 text-ink2 hover:border-line2 hover:text-ink1',
          )}
        >
          <Icon name="persona" size={14} />
          <span className="max-w-[320px] truncate">{summaryLine(producer)}</span>
          <Icon name="chevronDown" size={13} />
        </button>

        {open ? (
          <div
            role="dialog"
            aria-label="Who writes for you"
            className="hive-scale-in absolute right-0 top-[calc(100%+8px)] z-40 flex w-[min(540px,92vw)] flex-col gap-2 rounded-lg border border-line1 bg-bg1 p-3 shadow-overlay"
          >
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-semibold text-ink1">Who writes for you</span>
              <IconButton icon="x" label="Close" size="sm" className="ml-auto" onClick={() => onOpen(false)} />
            </div>
            <p className="m-0 text-[11px] leading-snug text-ink3">
              It drafts options; you pick. {privacyLine(producer)}
            </p>
            <ModelSourcePicker {...picker} />
          </div>
        ) : null}
      </span>
    </div>
  );
}
