// One model picker that shows the verdict and where it came from.
//
// Every studio stage that draws something has the same problem: the catalog
// lists thirty models, most of them can technically run the stage, and only a
// few are any good at it. Ordering alone does not say that — a picker sorted
// best-first still looks like a list of equals — so each row carries its rating,
// the reason, and how the reason was arrived at (measured here, reported by the
// owner, from a schema, or inferred).
//
// The verdicts come from the capability matrix, which is declared once in
// src/hivemind_content_studio/capability_matrix.py. Nothing here holds an
// opinion about which model suits which feature.
import { EVIDENCE_LABELS, RATING_LABELS } from '../lib/capabilityMatrix.js';
import { placeLabelFor } from '../lib/modelRunner.js';
import { Button, Pill, cx } from '../ui/kit.jsx';

/** Rating to badge colour. Ordered the same way the matrix ranks them. */
export const RATING_TONE = Object.freeze({
  good: 'ok',
  workable: 'honey',
  unmeasured: 'neutral',
  poor: 'warn',
  unsupported: 'danger',
});

/** One ranked model, with the verdict and its provenance shown rather than
 *  implied by position in the list. */
export function ModelOption({ row, selected, onSelect, readiness = null, onFixReadiness = null, busyAction = '' }) {
  const actionKey = readiness?.action ? `${readiness.action.kind}:${readiness.action.provider || row.key}` : '';
  return (
    <button
      type="button"
      onClick={() => onSelect(row)}
      className={cx(
        'flex w-full flex-col gap-1 rounded-md border p-2.5 text-left transition-colors',
        selected ? 'border-honey/60 bg-honey-tint' : 'border-line1 bg-bg2 hover:border-line2',
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-[13px] font-semibold text-ink1">{row.label}</span>
        <Pill tone={RATING_TONE[row.rating] || 'neutral'}>{RATING_LABELS[row.rating] || row.rating}</Pill>
      </span>
      <span className="text-[11px] leading-snug text-ink3">{row.reason}</span>
      <span className="text-[10px] uppercase tracking-wide text-ink3/70">
        {/* WHERE it runs and who pays, never the registry's own name for the
            provider: "Your OpenAI account", not "OpenAI · GPT Image OAuth". One
            table answers that for every picker (modelRunner.PROVIDER_TRANSPORTS). */}
        {placeLabelFor(row) ? `${placeLabelFor(row)} · ` : ''}
        {EVIDENCE_LABELS[row.evidence] || row.evidence}
      </span>
      {/* The state of the account, and the button that repairs it, ON the row
          that offers the model. Pressing Draw and reading "Invalid refresh
          token." is not a way to find out that ChatGPT needs reconnecting. */}
      {readiness && readiness.state !== 'ready' ? (
        <span className={cx('flex flex-wrap items-center gap-1.5 text-[10px] leading-snug',
          readiness.blocks ? 'text-warn' : 'text-ink3')}
        >
          <b>{readiness.label}</b>
          {readiness.detail ? <span className="opacity-90">{readiness.detail}</span> : null}
          {readiness.action ? (
            <Button
              size="sm"
              icon={readiness.state === 'reconnect' ? 'refresh' : 'key'}
              loading={busyAction === actionKey}
              onClick={(event) => { event.stopPropagation(); event.preventDefault(); onFixReadiness?.(readiness.action, row); }}
            >
              {readiness.action.label}
            </Button>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The collapsed picker: one line naming the current choice, opening to the
 * ranked list. Collapsed by default because the default pick is the best
 * available one and most sessions never need to argue with it.
 */
export function ModelFitPicker({
  label, rows, value, onChange, readinessFor = null, onFixReadiness = null, busyAction = '',
}) {
  if (!rows?.length) return null;
  const chosen = value ? readinessFor?.(value) : null;
  return (
    <details className="rounded-md border border-line1 bg-bg2">
      <summary className="cursor-pointer px-3 py-2 text-[12px] font-semibold text-ink2">
        {label} — {value?.label || 'pick one'}
        {/* The summary carries it too: a collapsed picker must not hide that
            the selected model cannot run until the moment it fails. */}
        {chosen && chosen.blocks ? <span className="ml-2 font-normal text-warn">· {chosen.label}</span> : null}
      </summary>
      <div className="grid gap-2 p-2 sm:grid-cols-2">
        {rows.map((row) => (
          <ModelOption
            key={row.key}
            row={row}
            selected={value?.key === row.key}
            onSelect={onChange}
            readiness={readinessFor?.(row) || null}
            onFixReadiness={onFixReadiness}
            busyAction={busyAction}
          />
        ))}
      </div>
    </details>
  );
}
