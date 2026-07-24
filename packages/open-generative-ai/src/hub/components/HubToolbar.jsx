// Slim per-view toolbar: kicker + title on the left, view-specific filters and
// actions on the right. Replaces the old page-level hero headers — the shell
// topbar already names the page (DESIGN.md §2).
import { SectionLabel } from '../../ui/kit.jsx';

export function HubToolbar({ kicker, title, subtitle, right, children }) {
  return (
    <div className="flex shrink-0 flex-wrap items-end justify-between gap-3 border-b border-line1 bg-bg1 px-4 py-3 md:px-5">
      <div className="min-w-0">
        {kicker ? <SectionLabel className="mb-1">{kicker}</SectionLabel> : null}
        <h2 className="truncate text-[15px] font-semibold text-ink1">{title}</h2>
        {subtitle ? <p className="mt-0.5 truncate text-xs text-ink3">{subtitle}</p> : null}
      </div>
      {right || children ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{right}{children}</div>
      ) : null}
    </div>
  );
}
