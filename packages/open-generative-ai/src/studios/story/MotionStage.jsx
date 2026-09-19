// Stage 3 — what happens: the only thing the references cannot say.
//
// The sheets carry who and the plate carries where, so everything spent
// restating them is budget not spent on the clip's actual subject: what happens
// and when, what moves because of what, why the camera moved, and what it
// sounds like.
//
// Two failures this page is laid out against. The animated poster — a beautiful
// still where the subject blinks and the camera drifts — which is why the force
// and the seven depths are one card with a count on it rather than seven fields
// in a list. And the mushy beat, three actions inside one three-second window,
// which is why a beat is one box for one action with its emotional result
// attached underneath rather than a paragraph.
import { useRef, useState } from 'react';

import { Icon } from '../../ui/icons.jsx';
import { Button, NativeSelect, TextArea, TextInput, cx } from '../../ui/kit.jsx';
import { RunOnPicker } from '../../components/RunOnPicker.jsx';
import { BOARD_FORMATS, SHOT_REASONS, boardFormat, recommendBoard } from './board.js';
import { AUDIO_LAYERS, MOTION_LAYERS, MUSIC_RULES, relayBeats } from './motionScript.js';
import { producerIsRunning } from './state.js';
import { Disclosure, DraftButton, FieldGrid, Notes, PlateSlot, Rule, StageHead, WriteField } from './parts.jsx';

/** Lengths worth one press. Anything else the director typed stays offered. */
const LENGTHS = [10, 15, 20, 30];

const round1 = (value) => Math.round((Number(value) || 0) * 10) / 10;

/** What this beat is FOR, in the shape of a three-act clip. */
function beatRole(index, total) {
  if (total <= 1) return 'the whole thing';
  if (index === 0) return 'sets it up';
  if (index === total - 1) return 'pays it off';
  return 'turns it';
}

function BeatCard({ beat, index, total, busy, onFill, onPatch, onRemove, onMove, onDragStart, onDragEnd, onDrop, dragging }) {
  return (
    <div
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
      onDrop={(event) => { event.preventDefault(); onDrop(index); }}
      className={cx(
        'flex flex-col gap-0.5 rounded-xl border bg-bg2 px-3 py-2.5 transition-colors',
        dragging ? 'border-honey/60 opacity-60' : 'border-line1 hover:border-line2',
      )}
    >
      <div className="flex items-center gap-2">
        {/* The two numbers inside this pill are fields, so the coarse-pointer
            16px floor applies to them — which a 17.5px pill clips. It grows
            with them. */}
        <span className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full bg-honey-tint px-2 font-mono text-[11px] font-semibold text-honey touch:h-ctl-md touch:px-2.5 touch:text-[13px]">
          <input
            type="number"
            step="0.5"
            value={beat.from}
            onChange={(event) => onPatch(index, { from: Number(event.target.value) })}
            aria-label={`Beat ${index + 1} starts at`}
            className="w-[2.4em] bg-transparent text-right tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
          –
          <input
            type="number"
            step="0.5"
            value={beat.to}
            onChange={(event) => onPatch(index, { to: Number(event.target.value) })}
            aria-label={`Beat ${index + 1} ends at`}
            className="w-[2.4em] bg-transparent tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
          />
          s
        </span>
        <span className="text-[11px] text-ink3">{beatRole(index, total)}</span>
        <span className="ml-auto flex items-center gap-0.5 touch:gap-1">
          <button
            type="button"
            title="Write this action from the rest of the story"
            aria-label="Write this action from the rest of the story"
            onClick={() => onFill([`motion.beats[${index}].action`])}
            disabled={Boolean(busy)}
            className={cx(
              'grid h-[22px] w-[22px] place-items-center rounded-md text-ink3 transition-colors hover:bg-bg3 hover:text-ink1 disabled:opacity-40',
              'touch:h-ctl-md touch:w-ctl-md',
              producerIsRunning(busy, `fill:motion.beats[${index}].action`) && 'animate-spin text-honey',
            )}
          >
            <Icon name={producerIsRunning(busy, `fill:motion.beats[${index}].action`) ? 'refresh' : 'wand'} size={12} />
          </button>
          {/* Order is part of the script, and until now the ONLY way to change
              it was HTML5 drag-and-drop — which a touch browser never fires, so
              on a phone the beats were frozen in the order the producer wrote
              them. The handle stays for the pointer it was built for; the two
              chevrons are the same move for the pointer that cannot drag. */}
          <span
            draggable
            onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; onDragStart(index); }}
            onDragEnd={onDragEnd}
            title="Drag to reorder"
            className="grid h-[22px] w-[22px] cursor-grab place-items-center rounded-md text-ink3 transition-colors hover:bg-bg3 hover:text-ink2 active:cursor-grabbing touch:hidden"
          >
            <Icon name="more" size={12} />
          </span>
          <button
            type="button"
            onClick={() => onMove(index, -1)}
            disabled={index === 0}
            aria-label={`Move beat ${index + 1} earlier`}
            className="hidden h-ctl-md w-ctl-md place-items-center rounded-md text-ink3 transition-colors hover:bg-bg3 hover:text-ink1 disabled:opacity-30 touch:grid"
          >
            <Icon name="chevronUp" size={15} />
          </button>
          <button
            type="button"
            onClick={() => onMove(index, 1)}
            disabled={index === total - 1}
            aria-label={`Move beat ${index + 1} later`}
            className="hidden h-ctl-md w-ctl-md place-items-center rounded-md text-ink3 transition-colors hover:bg-bg3 hover:text-ink1 disabled:opacity-30 touch:grid"
          >
            <Icon name="chevronDown" size={15} />
          </button>
          <button
            type="button"
            onClick={() => onRemove(index)}
            title="Remove this beat"
            aria-label="Remove this beat"
            className="grid h-[22px] w-[22px] place-items-center rounded-md text-ink3 transition-colors hover:bg-bg3 hover:text-danger touch:h-ctl-md touch:w-ctl-md"
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      </div>

      <TextArea
        rows={1}
        value={beat.action}
        onChange={(event) => onPatch(index, { action: event.target.value })}
        placeholder="one dominant action — no “then”"
        aria-label={`Beat ${index + 1} — the one dominant action`}
        className="!rounded-lg !border-transparent !bg-transparent !px-1.5 !py-[3px] !text-[14px] touch:!text-[16px] !leading-snug hover:!border-line1 hover:!bg-bg1 focus:!bg-bg1"
      />

      <div className="flex items-baseline gap-1.5">
        <span className="shrink-0 pl-1.5 text-[11px] text-ink3">reads as</span>
        <TextArea
          rows={1}
          value={beat.emotion}
          onChange={(event) => onPatch(index, { emotion: event.target.value })}
          placeholder="what is different afterwards"
          className="!min-w-0 !flex-1 !rounded-lg !border-transparent !bg-transparent !px-1.5 !py-[3px] !text-[12px] touch:!text-[16px] !leading-snug !text-ink2 hover:!border-line1 hover:!bg-bg1 focus:!bg-bg1"
        />
        <button
          type="button"
          title="Write what this beat changes, from the rest of the story"
          aria-label="Write what this beat changes, from the rest of the story"
          onClick={() => onFill([`motion.beats[${index}].emotion`])}
          disabled={Boolean(busy)}
          className={cx(
            'grid h-5 w-5 shrink-0 place-items-center rounded-sm text-ink3 transition-colors hover:bg-bg3 hover:text-ink1 disabled:opacity-40',
            'touch:-my-3 touch:h-ctl-md touch:w-ctl-md',
            producerIsRunning(busy, `fill:motion.beats[${index}].emotion`) && 'animate-spin text-honey',
          )}
        >
          <Icon name={producerIsRunning(busy, `fill:motion.beats[${index}].emotion`) ? 'refresh' : 'wand'} size={12} />
        </button>
      </div>
    </div>
  );
}

function BoardPanel({ panel, index, specs, busy, onFill, onPatch, aspect }) {
  return (
    <div className="flex flex-col gap-1.5">
      <PlateSlot
        url=""
        alt=""
        lines={[String(panel.n)]}
        box={cx('w-full rounded-lg', aspect === '16:9' ? 'aspect-video' : aspect === '1:1' ? 'aspect-square' : 'aspect-[9/16]')}
      />
      <span className="text-[11px] font-semibold text-ink2">{panel.job || `Panel ${panel.n}`}</span>
      <TextArea
        rows={2}
        value={panel.verb}
        onChange={(event) => onPatch(index, { verb: event.target.value })}
        placeholder={panel.asks || 'the one thing that happens'}
        className="!rounded-lg !bg-bg1 !px-2 !py-1.5 !text-[11px] touch:!text-[16px] !leading-snug"
      />
      <NativeSelect
        value={panel.shot}
        onChange={(event) => onPatch(index, { shot: event.target.value })}
        className="[&>select]:!bg-bg1 [&>select]:!px-2"
      >
        <option value="">shot?</option>
        {SHOT_REASONS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </NativeSelect>
      <WriteField
        id={`board.panels[${index}].reason`}
        spec={specs.get(`board.panels[${index}].reason`)}
        label="Camera reason"
        hint=""
        busy={busy}
        onFill={onFill}
        value={panel.reason}
        onChange={(event) => onPatch(index, { reason: event.target.value })}
        placeholder="the viewer now needs to discover…"
      />
      <WriteField
        id={`board.panels[${index}].motion`}
        spec={specs.get(`board.panels[${index}].motion`)}
        label="What moves"
        hint=""
        busy={busy}
        onFill={onFill}
        value={panel.motion}
        onChange={(event) => onPatch(index, { motion: event.target.value })}
      />
    </div>
  );
}

export function MotionStage({
  story, specs, busy, thinking, drawing, onFill, onMotion, onPatchBeat, onBoard, onPatchPanel,
  draft, onCancel, onDraftBoard, onDrawBoard, onChangeFormat, boardText, boardNotes, notes,
  boardChoices, boardModel, onBoardModel, boardAutomatic, readinessFor, onFixReadiness, fixing, localNotice = null,
}) {
  // The dragged row lives in a ref as well as in state. `drop` can land in the
  // same tick as `dragstart` — a fast flick, or anything driving the events
  // programmatically — and a re-render is not guaranteed in between, so reading
  // the source index off state silently dropped the reorder. State is only what
  // the card is dimmed by.
  const from = useRef(-1);
  const [dragging, setDragging] = useState(-1);
  const motion = story.motion;
  const beats = motion.beats;
  const seconds = motion.seconds;
  const lengths = LENGTHS.includes(seconds) ? LENGTHS : [...LENGTHS, seconds].sort((a, b) => a - b);
  const answered = MOTION_LAYERS.filter((layer) => String(motion.layers?.[layer.id] || '').trim());
  const written = beats.filter((beat) => String(beat.action || '').trim()).length;
  const each = beats.length ? round1(seconds / beats.length) : 0;
  const format = boardFormat(story.board.format);
  const drafted = story.board.panels.filter((panel) => String(panel.verb || '').trim()).length;
  const recommendation = recommendBoard({ beats: written, seconds });

  const startDrag = (index) => { from.current = index; setDragging(index); };
  const reorder = (source, target) => {
    if (source < 0 || source === target || target < 0 || target >= beats.length) return;
    const next = [...beats];
    const [moved] = next.splice(source, 1);
    next.splice(target, 0, moved);
    onMotion({ beats: relayBeats(next) });
  };
  const dropAt = (target) => {
    const source = from.current;
    from.current = -1;
    setDragging(-1);
    reorder(source, target);
  };

  return (
    <div className="flex flex-col gap-5">
      <StageHead title="What happens">
        The references already say who and where. This is the part they cannot: timed action, the
        turn, and one force the whole world responds to.
      </StageHead>

      <DraftButton
        label="Draft the motion"
        running={producerIsRunning(busy, 'beats')}
        blocked={Boolean(busy) && !producerIsRunning(busy, 'beats')}
        hint="beats, force, camera and audio in one pass"
        status={thinking}
        onPress={draft}
        onCancel={onCancel}
      >
        <span className="ml-auto inline-flex items-center gap-0.5 rounded-[10px] border border-line1 bg-bg1 p-0.5">
          {lengths.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onMotion({ seconds: n })}
              aria-pressed={n === seconds}
              className={cx(
                'h-7 rounded-[7px] px-3 text-xs font-medium transition-colors',
                'touch:h-ctl-md touch:px-4 touch:text-[13px]',
                n === seconds ? 'bg-bg3 text-ink1' : 'text-ink2 hover:text-ink1',
              )}
            >
              {n}s
            </button>
          ))}
        </span>
      </DraftButton>

      {/* Beats. */}
      <div className="flex flex-col gap-2.5">
        <Rule label="Beats" hint="one action each · and how the moment reads" />
        <p className="m-0 text-[10.5px] leading-snug text-ink3/80">
          “Reads as” is the emotional result a viewer with no explanation would name, once the
          action has happened. Beats that read as nothing make a clip a list of attractive shots.
        </p>
        <div className="flex h-1.5 gap-[3px]">
          {beats.map((beat, index) => (
            // Width is the beat's real span and the fade follows its position,
            // so the bar shows the shape of the clip rather than N equal blocks.
            <span
              key={index}
              title={`${beat.from}–${beat.to}s · ${beatRole(index, beats.length)}`}
              style={{
                flexGrow: Math.max(0.05, round1(beat.to) - round1(beat.from)),
                opacity: Math.max(0.28, 1 - index * 0.22),
              }}
              className="rounded-full bg-honey"
            />
          ))}
        </div>
        {beats.map((beat, index) => (
          <BeatCard
            key={index}
            beat={beat}
            index={index}
            total={beats.length}
            busy={busy}
            onFill={onFill}
            onPatch={onPatchBeat}
            onRemove={(i) => onMotion({ beats: relayBeats(beats.filter((_, row) => row !== i)) })}
            onMove={(row, step) => reorder(row, row + step)}
            onDragStart={startDrag}
            onDragEnd={() => { from.current = -1; setDragging(-1); }}
            onDrop={dropAt}
            dragging={dragging === index}
          />
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const from = round1(beats.at(-1)?.to || 0);
              return onMotion({ beats: [...beats, { from, to: round1(from + (each || 5)), action: '', emotion: '' }] });
            }}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-dashed border-line2 px-2.5 text-[12px] text-ink2 transition-colors hover:text-ink1 touch:h-ctl-md touch:px-3.5"
          >
            <Icon name="plus" size={13} />
            Add a beat
          </button>
          <span className="text-[11px] text-ink3">
            {beats.length} beat{beats.length === 1 ? '' : 's'} across {seconds}s — {each}s each
            {each >= 3 ? ', room to act' : ', which is montage pacing'}
          </span>
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => onMotion({
              beats: beats.map((beat, index) => ({
                ...beat,
                from: round1((index * seconds) / beats.length),
                to: round1(((index + 1) * seconds) / beats.length),
              })),
            })}
          >
            Re-time to {seconds}s
          </Button>
        </div>
      </div>

      {/* The force, and what answers it. */}
      <div className="flex flex-col gap-2.5 rounded-xl border border-line1 bg-bg2 p-3.5">
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink3">The one force</span>
          <TextInput
            value={motion.force}
            onChange={(event) => onMotion({ force: event.target.value })}
            placeholder="still cold air off the water, and the pull of the one working lamp"
            className="!rounded-[10px] !bg-bg1 !text-[14px] touch:!text-[16px]"
          />
        </label>
        <p className="m-0 text-[12px] leading-relaxed text-ink3">
          Everything else in frame is a response to it.{' '}
          <b className="font-semibold text-ink2">{answered.length} of {MOTION_LAYERS.length} depths</b>
          {answered.length
            ? <> answer it — {answered.map((layer) => layer.label.toLowerCase()).join(', ')}.</>
            : <> answer it. Give the subject, something it touches and something behind it each a response, or this is an animated poster.</>}
        </p>
        <Disclosure label="Edit each depth, camera and audio">
          <FieldGrid>
            {MOTION_LAYERS.map((layer) => (
              <WriteField
                key={layer.id}
                id={`motion.layers.${layer.id}`}
                spec={specs.get(`motion.layers.${layer.id}`)}
                label={layer.label}
                hint=""
                multiline
                busy={busy}
                onFill={onFill}
                value={motion.layers?.[layer.id] || ''}
                onChange={(event) => onMotion({ layers: { ...motion.layers, [layer.id]: event.target.value } })}
              />
            ))}
          </FieldGrid>
          <FieldGrid className="border-t border-line1 pt-2.5">
            <WriteField
              id="motion.camera"
              spec={specs.get('motion.camera')}
              hint="Two to four motivated changes. Each one because the viewer now needs to discover something."
              multiline
              busy={busy}
              onFill={onFill}
              value={motion.camera}
              onChange={(event) => onMotion({ camera: event.target.value })}
            />
            <WriteField
              id="motion.audio"
              spec={specs.get('motion.audio')}
              hint={AUDIO_LAYERS.map((layer) => layer.label).join(' · ')}
              multiline
              busy={busy}
              onFill={onFill}
              value={motion.audio}
              onChange={(event) => onMotion({ audio: event.target.value })}
            />
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-[11px] font-medium text-ink3">Music</span>
              <NativeSelect
                value={motion.music}
                onChange={(event) => onMotion({ music: event.target.value })}
                // The desktop values are the ones this row was drawn at; only
                // the touch overrides are new. A pass that grows a control for
                // a thumb must leave the cursor's version exactly where it was.
                className="[&>select]:!h-7 touch:[&>select]:!h-ctl-md [&>select]:!bg-bg1 [&>select]:!text-[11px] touch:[&>select]:!text-[16px]"
              >
                {MUSIC_RULES.map((rule) => <option key={rule.id} value={rule.id}>{rule.label}</option>)}
              </NativeSelect>
            </label>
            <WriteField
              id="motion.negatives"
              spec={specs.get('motion.negatives')}
              hint=""
              busy={busy}
              onFill={onFill}
              value={motion.negatives}
              onChange={(event) => onMotion({ negatives: event.target.value })}
            />
          </FieldGrid>
        </Disclosure>
        <Notes items={notes} />
      </div>

      {/* The board — direction for the render, not a shot list it will trace. */}
      <Disclosure
        tone="card"
        label="Storyboard"
        hint={`· ${drafted} of ${story.board.panels.length} panels drafted · optional direction for the render`}
      >
        <p className="m-0 text-[12px] leading-snug text-ink3">
          {format.best} Expect the video model to interpret it — when a beat has to be exact, drop to
          two frames and generate only that.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-0.5 rounded-[10px] border border-line1 bg-bg1 p-0.5">
            {BOARD_FORMATS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => onChangeFormat(entry.id)}
                aria-pressed={entry.id === story.board.format}
                className={cx(
                  'h-7 rounded-[7px] px-2.5 text-[11px] font-medium transition-colors',
                  'touch:h-ctl-md touch:px-3.5 touch:text-[13px]',
                  entry.id === story.board.format ? 'bg-bg3 text-ink1' : 'text-ink2 hover:text-ink1',
                )}
              >
                {entry.label}
              </button>
            ))}
          </span>
          <Button
            size="sm" icon="wand"
            onClick={onDraftBoard}
            loading={producerIsRunning(busy, 'board')}
            disabled={Boolean(busy)}
          >
            Draft the panels
          </Button>
          <WriteField
            id="board.arc"
            spec={specs.get('board.arc')}
            hint=""
            busy={busy}
            onFill={onFill}
            value={story.board.arc}
            onChange={(event) => onBoard({ arc: event.target.value })}
            placeholder="from what feeling to what feeling"
            className="min-w-[180px] flex-1"
          />
        </div>

        {recommendation.id !== story.board.format ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-honey/40 bg-honey-tint p-2 text-[11.5px] text-ink2">
            <span>Suggested: <b>{boardFormat(recommendation.id).label}</b> — {recommendation.why}</span>
            <Button size="sm" className="ml-auto" onClick={() => onChangeFormat(recommendation.id)}>Use it</Button>
          </div>
        ) : null}

        {/* One panel per row below sm. auto-fit's 132px track fits TWICE on a
            phone, which drew each panel's column of fields at half of 343px. */}
        <div className="grid grid-cols-1 gap-2 sm:[grid-template-columns:repeat(auto-fit,minmax(132px,1fr))]">
          {story.board.panels.map((panel, index) => (
            <BoardPanel
              key={panel.n}
              panel={panel}
              index={index}
              specs={specs}
              busy={busy}
              onFill={onFill}
              onPatch={onPatchPanel}
              aspect={story.aspect}
            />
          ))}
        </div>

        <Notes items={boardNotes} />

        {localNotice}
        <RunOnPicker
          label="Board model"
          targets={boardChoices}
          value={boardModel}
          onChange={onBoardModel}
          automatic={boardAutomatic}
          onAutomatic={() => onBoardModel(null)}
          isAutomatic={boardModel === boardAutomatic?.target}
          readinessFor={readinessFor}
          onFixReadiness={onFixReadiness}
          busyAction={fixing}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm" icon="grid"
            onClick={onDrawBoard}
            loading={drawing === 'board'}
            disabled={Boolean(drawing) || !boardText}
          >
            {drawing === 'board' ? 'Drawing…' : story.board.sheetUrl ? 'Redraw the board' : 'Draw the board'}
          </Button>
          <span className="text-[11px] text-ink3">
            The sheets and this board travel to the Video studio with the script — sheets as subjects, plate and board as places.
          </span>
        </div>
        {story.board.sheetUrl ? (
          <PlateSlot url={story.board.sheetUrl} alt="Storyboard sheet" box="w-full max-h-[420px] rounded-md" fit="object-contain" />
        ) : null}
        <Disclosure label="The prompt this draws from">
          <TextArea rows={10} value={boardText} readOnly className="!bg-bg1 font-mono !text-[11px] touch:!text-[16px]" />
        </Disclosure>
      </Disclosure>
    </div>
  );
}
