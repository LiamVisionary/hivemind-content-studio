// Slim per-view toolbar: kicker + title on the left, view-specific filters and
// actions on the right. Replaces the old page-level hero headers — the shell
// topbar already names the page (DESIGN.md §2).
import { useEffect, useRef, useState } from 'react';
import { SectionLabel } from '../../ui/kit.jsx';
import { Icon } from '../../ui/icons.jsx';
import { t } from '../../lib/i18n.js';

// How long the icon spins after a press. Most of these pages refill silently —
// a poll tick that lands with the same rows repaints nothing — so a click with
// no visible answer reads as a dead button. Long enough to see, short enough
// that it is never mistaken for a load still in flight.
const SPIN_MS = 900;

// The shell topbar's one global Refresh stood on every page, including the ones
// with nothing to re-read. This is the same control, opted into per view:
// `refresh={true}` dispatches the shared 'hivemind-hub-refresh' event (the hub
// poll, the studios' catalogs, the local-model list and the Comfy probe all
// listen for it), and a function is for a page that fetches on its own, so the
// press re-reads what THAT page actually shows instead of the hub's poll.
function ToolbarRefresh({ onRefresh }) {
  const [busy, setBusy] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const press = () => {
    if (typeof onRefresh === 'function') onRefresh();
    else window.dispatchEvent(new Event('hivemind-hub-refresh'));
    setBusy(true);
    // A second press mid-spin restarts the beat; without dropping the first
    // press's timer it would inherit that deadline and stop almost at once.
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setBusy(false), SPIN_MS);
  };
  return (
    <button
      type="button"
      onClick={press}
      // Icon-only, so it carries both: the title says what gets re-read, the
      // label is the name a screen reader announces.
      title={t('app.refreshTitle')}
      aria-label={t('app.refresh')}
      className="grid h-ctl-md w-[36px] shrink-0 place-items-center rounded-md text-ink2 transition-colors hover:bg-bg2 hover:text-ink1"
    >
      <Icon name="refresh" size={17} className={busy ? 'hive-motion-keep animate-[hive-spin_0.7s_linear_infinite]' : ''} />
    </button>
  );
}

export function HubToolbar({ kicker, title, subtitle, right, refresh, children }) {
  return (
    <div className="flex shrink-0 flex-wrap items-end justify-between gap-3 border-b border-line1 bg-bg1 px-4 py-3 md:px-5">
      <div className="min-w-0">
        {kicker ? <SectionLabel className="mb-1">{kicker}</SectionLabel> : null}
        <h2 className="truncate text-[15px] font-semibold text-ink1">{title}</h2>
        {subtitle ? <p className="mt-0.5 truncate text-xs text-ink3">{subtitle}</p> : null}
      </div>
      {right || children || refresh ? (
        // Refresh composes with whatever the view already puts here (several
        // pass `right`), and always sits last so it is in the same place on
        // every page that has one.
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {right}
          {children}
          {refresh ? <ToolbarRefresh onRefresh={refresh} /> : null}
        </div>
      ) : null}
    </div>
  );
}
