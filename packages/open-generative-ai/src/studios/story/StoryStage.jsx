// Stage 1 — the story: many directions, one locked contract.
//
// The whole stage is one decision, so it is laid out as one: write the brief,
// press once, read the options side by side, lock one. Everything that is not
// that decision — the tone, the count, what must never appear, the art
// direction, the six contract slots — is behind a disclosure, because a field
// that is only touched when you disagree with the answer should not be in the
// way of reading the answer.
import { Icon } from '../../ui/icons.jsx';
import { Button, NativeSelect, Segmented, TextArea, cx } from '../../ui/kit.jsx';
import { SHORTLIST_CRITERIA, TONES, conceptCount } from './concept.js';
import { producerIsRunning } from './state.js';
import { Disclosure, DraftButton, FieldGrid, Plate, Rule, StageHead, WriteField } from './parts.jsx';

const CONTRACT_SLOTS = [
  ['pressure', 'When this happens'],
  ['who', 'this character'],
  ['goal', 'tries to'],
  ['other', 'while this one'],
  ['behavior', 'responds by'],
  ['reward', 'turning it into'],
];

/** The contract as the sentence it is, with every slot the director filled in
 *  set in bold and every one they have not left as a visible blank. */
function ContractSentence({ contract }) {
  const slot = (key) => {
    const value = String(contract?.[key] || '').trim();
    return value
      ? <b className="font-semibold text-ink1">{value}</b>
      : <span className="font-semibold text-warn">___</span>;
  };
  return (
    <p className="m-0 text-[14px] leading-relaxed text-ink2">
      When {slot('pressure')} happens, {slot('who')} tries to {slot('goal')}, while {slot('other')}{' '}
      responds by {slot('behavior')} — turning it into {slot('reward')}.
    </p>
  );
}

function ConceptCard({ concept, ranked, shortlisted, locked, busy, onShortlist, onLock }) {
  return (
    <div
      className={cx(
        'flex flex-col gap-1.5 rounded-xl border p-3 transition-colors',
        locked ? 'border-ok/40 bg-ok/[0.06]'
          : shortlisted ? 'border-honey/50 bg-honey-tint'
            : 'border-line1 bg-bg2 hover:border-line2',
      )}
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink1">{concept.title || concept.pair}</span>
        {ranked ? (
          <span className="shrink-0 text-[10px] font-semibold text-honey" title={ranked.why || 'Score across the five criteria'}>
            {Object.values(ranked.scores || {}).reduce((sum, value) => sum + (Number(value) || 0), 0) || '—'}
          </span>
        ) : null}
        {locked ? (
          <span className="inline-flex h-[18px] shrink-0 items-center rounded-full bg-ok-tint px-[7px] text-[10px] font-semibold text-ok">
            locked
          </span>
        ) : (
          <span className="shrink-0 text-[11px] font-bold text-ink3">{concept.id}</span>
        )}
      </div>
      {concept.title && concept.pair ? <p className="m-0 text-[12px] leading-snug text-ink2">{concept.pair}</p> : null}
      {concept.hook ? <p className="m-0 text-[12px] leading-snug text-ink3">{concept.hook}</p> : null}
      {concept.friction || concept.reward ? (
        <p className="m-0 text-[11px] leading-snug text-ink3/80">
          {[concept.friction, concept.reward].filter(Boolean).join(' → ')}
        </p>
      ) : null}
      {ranked?.why ? <p className="m-0 text-[11px] italic leading-snug text-ink3">{ranked.why}</p> : null}
      <div className="mt-auto flex items-center gap-1.5 pt-1">
        <Button
          size="sm"
          onClick={() => onLock(concept)}
          loading={producerIsRunning(busy, 'contract') && locked}
          disabled={Boolean(busy)}
          className={cx('!px-3', locked && '!border-ok/40 !bg-ok-tint !text-ok')}
        >
          {locked ? 'Locked' : 'Lock'}
        </Button>
        <button
          type="button"
          onClick={() => onShortlist(concept.id)}
          title={shortlisted ? 'Drop it from the shortlist' : 'Keep it for the comparison'}
          className={cx(
            'grid h-6 w-6 shrink-0 place-items-center rounded-sm transition-colors',
            shortlisted ? 'bg-honey-tint text-honey' : 'text-ink3 hover:bg-bg3 hover:text-ink1',
          )}
        >
          <Icon name={shortlisted ? 'star' : 'plus'} size={12} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink3" title={concept.signature}>
          {concept.signature}
        </span>
      </div>
    </div>
  );
}

export function StoryStage({
  story, specs, busy, thinking, drawing, onFill, onUpdate, onBrief,
  draft, onCancel, onCompare, onContactSheet, onShortlist, onLock, onFillContract,
}) {
  const brief = story.brief;
  const asked = conceptCount(brief.count);
  const locked = story.concepts.find((concept) => concept.id === story.lockedId);
  const contractWritten = CONTRACT_SLOTS.some(([key]) => String(story.contract[key] || '').trim());

  return (
    <div className="flex flex-col gap-5">
      <StageHead title="The story">
        A pair, a place, and one thing only they would do. Everything after this is built on it,
        so it is the one decision worth comparing options for.
      </StageHead>

      {/* The brief, and the one press that answers it. */}
      <div className="flex flex-col gap-2.5 rounded-xl border border-line1 bg-bg2 p-3.5">
        <TextArea
          rows={3}
          value={brief.pitch}
          onChange={(event) => onBrief({ pitch: event.target.value })}
          placeholder="A night bus driver and a large pale moth, in an empty estuary terminus at 2am. Strange, no dialogue."
          className="!min-h-[76px] !rounded-none !border-0 !bg-transparent !px-0 !py-0 !text-[15px] !leading-normal focus:!border-0"
        />
        <div className="flex flex-col gap-2.5 border-t border-line1 pt-2.5">
          <DraftButton
            label={`Draft ${asked} directions`}
            running={producerIsRunning(busy, 'concepts')}
            blocked={Boolean(busy) && !producerIsRunning(busy, 'concepts')}
            hint={`${asked} at a time · the producer drafts, you lock one`}
            status={thinking}
            onPress={draft}
            onCancel={onCancel}
          />
          <Disclosure label="Constraints" className="border-t border-line1 pt-2">
            <FieldGrid>
              <WriteField
                id="brief.avoid" spec={specs.get('brief.avoid')} label="Must never appear" hint=""
                busy={busy} onFill={onFill}
                value={brief.avoid} onChange={(event) => onBrief({ avoid: event.target.value })}
                placeholder="no dialogue, no on-screen text"
              />
              <WriteField
                id="style" spec={specs.get('style')} label="Visual style" hint=""
                busy={busy} onFill={onFill}
                value={story.style} onChange={(event) => onUpdate({ style: event.target.value })}
                placeholder="muted painterly animation, soft grain"
              />
              <WriteField
                id="brief.person" spec={specs.get('brief.person')} label="Human" hint=""
                busy={busy} onFill={onFill}
                value={brief.person} onChange={(event) => onBrief({ person: event.target.value })}
                placeholder="a night-shift florist"
              />
              <WriteField
                id="brief.companion" spec={specs.get('brief.companion')} label="Companion" hint=""
                busy={busy} onFill={onFill}
                value={brief.companion} onChange={(event) => onBrief({ companion: event.target.value })}
                placeholder="a stubborn pigeon"
              />
              <WriteField
                id="brief.world" spec={specs.get('brief.world')} label="World" hint=""
                busy={busy} onFill={onFill}
                value={brief.world} onChange={(event) => onBrief({ world: event.target.value })}
                placeholder="a harbour tram shelter in the rain"
                className="sm:col-span-2"
              />
            </FieldGrid>
            <div className="flex flex-wrap items-center gap-3 border-t border-line1 pt-2.5">
              <span className="text-[11px] font-medium text-ink3">The relationship should feel</span>
              <Segmented
                size="sm"
                value={brief.tone}
                onChange={(value) => onBrief({ tone: value })}
                options={TONES.map((entry) => ({ value: entry.id, label: entry.label }))}
              />
              <span className="ml-auto flex items-center gap-2">
                <span className="text-[11px] font-medium text-ink3">How many directions</span>
                <NativeSelect
                  value={String(asked)}
                  onChange={(event) => onBrief({ count: conceptCount(event.target.value) })}
                  className="w-[74px]"
                >
                  {[3, 4, 5, 6, 8, 10, 12].map((n) => <option key={n} value={n}>{n}</option>)}
                </NativeSelect>
              </span>
            </div>
          </Disclosure>
        </div>
      </div>

      {story.concepts.length ? (
        <>
          <Rule
            label={`${story.concepts.length} direction${story.concepts.length === 1 ? '' : 's'}`}
            hint={story.ranking ? '' : SHORTLIST_CRITERIA.slice(0, 3).map((entry) => entry.label.toLowerCase()).join(', ')}
          >
            <Button
              size="sm" icon="stack" onClick={onCompare}
              loading={producerIsRunning(busy, 'shortlist')} disabled={Boolean(busy)}
            >
              Compare them
            </Button>
            <Button
              size="sm" icon="grid" onClick={onContactSheet}
              loading={drawing === 'contact'} disabled={Boolean(drawing)}
              title={story.shortlist.length
                ? `Draw the ${story.shortlist.length} shortlisted directions side by side`
                : 'Draw all of them side by side — star a few first to narrow it'}
            >
              Contact sheet
            </Button>
          </Rule>

          {story.ranking?.reason ? (
            <p className="m-0 rounded-lg border border-line1 bg-bg2 p-2.5 text-[12px] leading-snug text-ink2">
              {story.ranking.reason}
            </p>
          ) : null}

          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
            {story.concepts.map((concept) => (
              <ConceptCard
                key={concept.id}
                concept={concept}
                ranked={story.ranking?.ranked?.find((row) => String(row.id) === concept.id) || null}
                shortlisted={story.shortlist.includes(concept.id)}
                locked={story.lockedId === concept.id}
                busy={busy}
                onShortlist={onShortlist}
                onLock={onLock}
              />
            ))}
          </div>

          {story.contactSheetUrl ? (
            <Plate url={story.contactSheetUrl} alt="Contact sheet of the shortlisted directions" className="w-full rounded-md object-contain" />
          ) : null}
        </>
      ) : (
        <div className="flex flex-col gap-1.5 rounded-xl border border-dashed border-line2 bg-bg1 p-5 text-center">
          <span className="text-[13px] font-medium text-ink2">
            {producerIsRunning(busy, 'concepts') ? (thinking || 'Working…') : 'No directions yet'}
          </span>
          <span className="text-[11.5px] leading-snug text-ink3">
            {producerIsRunning(busy, 'concepts')
              ? 'A cold local model takes a minute to load before it writes anything.'
              : SHORTLIST_CRITERIA.map((entry) => entry.label).join(' · ')}
          </span>
        </div>
      )}

      {/* The contract. Green once it is whole, because everything downstream
          quotes it and a half-written one reads as finished to all of them. */}
      <div
        className={cx(
          'flex flex-col gap-2.5 rounded-xl border p-3.5',
          contractWritten ? 'border-ok/35 bg-ok/[0.06]' : 'border-line1 bg-bg2',
        )}
      >
        <div className="flex items-center gap-2">
          <Icon name={contractWritten ? 'check' : 'info'} size={14} className={contractWritten ? 'text-ok' : 'text-ink3'} />
          <span className={cx(
            'text-[11px] font-semibold uppercase tracking-[0.08em]',
            contractWritten ? 'text-ok' : 'text-ink3',
          )}
          >
            {contractWritten ? `Locked — the contract${locked?.title ? ` · ${locked.title}` : ''}` : 'The contract — not written yet'}
          </span>
          {/* Locking a direction writes the contract, but a director who wrote
              their own idea never locked one — so the blanks are still one
              press, from whatever else the page already says. */}
          <Button
            size="sm"
            className="ml-auto"
            icon={producerIsRunning(busy, 'fill-section:story') ? 'refresh' : 'wand'}
            onClick={onFillContract}
            loading={producerIsRunning(busy, 'fill-section:story')}
            disabled={Boolean(busy)}
          >
            Write the blanks
          </Button>
        </div>
        <ContractSentence contract={story.contract} />
        <Disclosure label="Edit the contract, title and promise">
          <FieldGrid>
            {CONTRACT_SLOTS.map(([key, label]) => (
              <WriteField
                key={key}
                id={`contract.${key}`}
                spec={specs.get(`contract.${key}`)}
                label={label}
                hint=""
                busy={busy}
                onFill={onFill}
                value={story.contract[key]}
                onChange={(event) => onUpdate((current) => ({
                  ...current, contract: { ...current.contract, [key]: event.target.value },
                }))}
              />
            ))}
            <WriteField
              id="title" spec={specs.get('title')} label="Title" hint=""
              busy={busy} onFill={onFill}
              value={story.title} onChange={(event) => onUpdate({ title: event.target.value })}
            />
            <WriteField
              id="promise" spec={specs.get('promise')} label="Story promise" hint=""
              busy={busy} onFill={onFill}
              value={story.promise} onChange={(event) => onUpdate({ promise: event.target.value })}
            />
          </FieldGrid>
        </Disclosure>
      </div>
    </div>
  );
}
