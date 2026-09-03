// Stage 4 — the gate: what has to be true before a clip is worth finishing.
//
// It records an APPROVAL and nothing else. It used to say "Ship it", which
// promised the one thing it cannot do — nothing is posted, nothing is queued,
// no artifact moves — while the product's real publishing path lives behind the
// Planner's approval gate.
//
// The nine checks are in the order they are cheap to fix, and a failure names
// ONE layer to change. That is the whole point of the stage: the instinct on a
// bad take is to regenerate everything, which changes every variable at once
// and teaches you nothing about which one was wrong.
import { Icon } from '../../ui/icons.jsx';
import { Button, Slider, TextArea, cx } from '../../ui/kit.jsx';
import { CAPTION_BEATS, FINISH_ORDER, ITERATION_LAYERS, QA_CHECKS, SIGNAL_READS, repairsFor } from './qa.js';
import { producerIsRunning } from './state.js';
import { Disclosure, FieldGrid, Notes, StageHead, WriteField } from './parts.jsx';

const TONE = {
  ship: { ring: 'border-ok/40 bg-ok/[0.06]', chip: 'bg-ok-tint text-ok', icon: 'check' },
  repair: { ring: 'border-honey/40 bg-honey/[0.06]', chip: 'bg-honey-tint text-honey', icon: 'info' },
  untested: { ring: 'border-line1 bg-bg2', chip: 'bg-bg3 text-ink3', icon: 'info' },
  blocked: { ring: 'border-danger/40 bg-danger/[0.06]', chip: 'bg-danger-tint text-danger', icon: 'warning' },
};

export function ShipStage({
  story, specs, busy, verdict, caption, segments, onFill, onUpdate, onVerdict, onCaption,
  onApprove, onFillCaption,
}) {
  const tone = TONE[verdict.state] || TONE.untested;
  const answered = QA_CHECKS.length - verdict.untested.length;
  // `qa.shipped` is the stored field's name and stays one — the timestamp
  // written before this stage was honest about what it does. What it MEANS,
  // and everything the owner reads, is approval.
  const approved = story.qa.shipped || '';

  return (
    <div className="flex flex-col gap-5">
      <StageHead title="Approve">
        Watch the clip once and answer nine questions. A failure names the one layer to change —
        not a full regeneration.
      </StageHead>

      <div className={cx('flex items-center gap-3 rounded-xl border p-3.5', tone.ring)}>
        <span className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-full', tone.chip)}>
          <Icon name={tone.icon} size={18} />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink1">
            {answered} of {QA_CHECKS.length} checked · {verdict.headline}
          </div>
          <p className="m-0 mt-0.5 text-[12px] leading-snug text-ink2">
            {approved
              ? `Approved ${new Date(approved).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}. Every check stays editable — a re-cut re-opens it.`
              : verdict.detail}
          </p>
        </div>
        <Button
          variant={approved ? 'neutral' : 'primary'}
          className="ml-auto shrink-0"
          onClick={onApprove}
          disabled={!approved && verdict.state === 'blocked'}
          title={verdict.state === 'blocked'
            ? 'A blocking check has failed — repair it first.'
            : 'Record that this production passed its checks'}
        >
          {approved ? 'Approved — undo' : 'Approve'}
        </Button>
      </div>

      <div className="flex flex-col gap-1.5">
        {QA_CHECKS.map((check) => {
          const state = story.qa.verdicts[check.id] || '';
          return (
            <div key={check.id} className="flex flex-col gap-1.5 rounded-xl border border-line1 bg-bg2 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <span
                  className={cx(
                    'h-[7px] w-[7px] shrink-0 rounded-full',
                    state === 'pass' ? 'bg-ok' : state === 'fail' ? 'bg-warn' : 'bg-line2',
                  )}
                />
                <span className="text-[13px] font-medium text-ink1">{check.label}</span>
                {check.blocks ? (
                  <span className="inline-flex h-[18px] shrink-0 items-center rounded-full border border-line1 px-[7px] text-[10px] font-semibold text-ink3">
                    blocks publishing
                  </span>
                ) : null}
                <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-line1 bg-bg1 p-0.5">
                  <button
                    type="button"
                    onClick={() => onVerdict(check.id, 'pass')}
                    aria-pressed={state === 'pass'}
                    className={cx(
                      'h-6 rounded-md px-2.5 text-[11px] font-semibold transition-colors',
                      state === 'pass' ? 'bg-ok-tint text-ok' : 'text-ink2 hover:text-ink1',
                    )}
                  >
                    Pass
                  </button>
                  <button
                    type="button"
                    onClick={() => onVerdict(check.id, 'fail')}
                    aria-pressed={state === 'fail'}
                    className={cx(
                      'h-6 rounded-md px-2.5 text-[11px] font-semibold transition-colors',
                      state === 'fail' ? 'bg-warn/10 text-warn' : 'text-ink2 hover:text-ink1',
                    )}
                  >
                    Fail
                  </button>
                </span>
              </div>
              <p className="m-0 text-[11px] leading-snug text-ink3">{check.asks}</p>
              {state === 'fail' ? repairsFor(check.id).map((repair) => (
                <div
                  key={repair.id}
                  className="rounded-lg border border-warn/40 bg-warn/[0.08] px-2.5 py-2 text-[11px] leading-relaxed text-ink2"
                >
                  <b className="font-semibold text-ink1">{repair.label}</b> — {repair.cause}
                  <br />
                  Repair the <b className="font-semibold text-ink1">{repair.stage}</b> stage: {repair.fix}
                </div>
              )) : null}
            </div>
          );
        })}
      </div>

      <Disclosure tone="card" label="Caption, splitting and finishing order" hint="· for when the clip is approved">
        {/* Caption. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink3">Caption</span>
            <Button
              size="sm"
              icon={producerIsRunning(busy, 'fill-section:ship') ? 'refresh' : 'wand'}
              className="ml-auto"
              onClick={onFillCaption}
              loading={producerIsRunning(busy, 'fill-section:ship')}
              disabled={Boolean(busy)}
            >
              Draft all seven
            </Button>
          </div>
          <TextArea
            rows={3}
            value={caption.caption}
            readOnly
            placeholder="The seven beats below are joined into the caption as you write them."
            className="!bg-bg1 !text-[12px]"
          />
          <span className="text-[10.5px] leading-snug text-ink3">
            Hook, scene, friction, signature, turn, invitation, one CTA — the producer drafts all seven from the story.
          </span>
          <Notes items={caption.problems} />
          <FieldGrid>
            {CAPTION_BEATS.map((beat) => (
              <WriteField
                key={beat.id}
                id={`qa.caption.${beat.id}`}
                spec={specs.get(`qa.caption.${beat.id}`)}
                label={beat.label}
                hint={beat.asks}
                multiline
                busy={busy}
                onFill={onFill}
                value={story.qa.caption[beat.id] || ''}
                onChange={(event) => onCaption(beat.id, event.target.value)}
              />
            ))}
          </FieldGrid>
        </div>

        {/* Splitting. */}
        <div className="flex flex-col gap-2 border-t border-line1 pt-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink3">Longer than one generation</span>
          <p className="m-0 text-[12px] leading-snug text-ink2">
            {story.motion.seconds}s fits in one. Above one generation the story splits, with a stated
            handoff at each seam.
          </p>
          <FieldGrid>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-[11px] font-medium text-ink3">Whole story</span>
              <Slider
                value={story.segments.total} min={5} max={120} step={5}
                onChange={(value) => onUpdate((current) => ({ ...current, segments: { ...current.segments, total: value } }))}
                format={(value) => `${value}s`}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-[11px] font-medium text-ink3">Per generation</span>
              <Slider
                value={story.segments.per} min={5} max={30} step={1}
                onChange={(value) => onUpdate((current) => ({ ...current, segments: { ...current.segments, per: value } }))}
                format={(value) => `${value}s`}
              />
            </label>
          </FieldGrid>
          <div className="flex flex-col gap-1">
            {segments.map((segment) => (
              <div key={segment.index} className="text-[12px] leading-snug text-ink2">
                <b className="font-semibold">Generation {segment.index}</b> · {segment.from}–{segment.to}s — one job: {segment.job}.
                {segment.boundary ? <span className="text-ink3"> {segment.boundary}</span> : null}
              </div>
            ))}
          </div>
        </div>

        {/* Finishing. */}
        <div className="grid gap-3 border-t border-line1 pt-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink3">Finish in this order</span>
            <ol className="m-0 flex list-none flex-col gap-0.5 p-0 text-[12px] text-ink2">
              {FINISH_ORDER.map((step, index) => <li key={step}>{index + 1}. {step}</li>)}
            </ol>
            <p className="m-0 mt-1 text-[11px] leading-snug text-ink3">
              An upscale sharpens pixels. It does not repair acting, an unclear action, a broken
              identity or a dead world.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink3">Then change one thing</span>
            <p className="m-0 text-[11px] leading-snug text-ink3">{ITERATION_LAYERS.join(' · ')}</p>
            <div className="mt-1 flex flex-col gap-1 text-[11px] leading-snug text-ink3">
              {SIGNAL_READS.map((row) => (
                <div key={row.id}>
                  <b className="font-semibold text-ink2">{row.signal}</b> — {row.means} <i>{row.next}</i>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Disclosure>
    </div>
  );
}
