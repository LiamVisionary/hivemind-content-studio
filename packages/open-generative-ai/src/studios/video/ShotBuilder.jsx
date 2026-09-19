// The Shot Builder — a timeline INSIDE one generation.
//
// Scene chaining joins clips end to end. This is the other axis: H3 holds
// several shots inside a single clip, marked [Shot N], cut at a stated
// timecode, with action stamped in seconds and speech in <d> tags carrying a
// language and a speaker id. That grammar is easy to get subtly wrong by hand,
// and H3 answers a malformed timeline by ignoring the timeline — so the parts
// that have exact spellings are chosen here rather than typed.
//
// It writes the DESCRIPTION half of a prompt and nothing else. Who everyone is
// stays where it was: subject_definitions and retention_analysis are carried
// through untouched, because the Cast owns those and a builder that rewrote
// them would silently un-cast the shot.
//
// Grammar lives in lib/h3Shots.js and lib/h3Camera.js; this file is the panel.
import { useEffect, useMemo, useState } from 'react';
import {
  CAMERA_ANGLES,
  CAMERA_AMPLITUDES,
  CAMERA_COMPOSITIONS,
  CAMERA_DEPTH,
  CAMERA_FOCUS_AREAS,
  CAMERA_FOCUS_BEHAVIOUR,
  CAMERA_FRAMINGS,
  CAMERA_LENSES,
  CAMERA_MOVE_OPTIONS,
  CAMERA_SPEEDS,
  CAMERA_STABILITY,
  CAMERA_TIMINGS,
  CAMERA_VIEWPOINTS,
  blankCamera,
  cameraIsSet,
} from '../../lib/h3Camera.js';
import {
  SHOT_TRANSITIONS,
  composeH3Prompt,
  h3Mode,
  newBeat,
  newDialogue,
  newShot,
  parseShotBlocks,
  speakerIds,
  timecode,
  timelineEndSec,
  timelineShotsFromPrompt,
} from '../../lib/h3Shots.js';
import { checkH3Prompt, sectionBodyIn } from '../../lib/h3PromptCheck.js';
import { checkSummaryText, describeCheckFinding } from './promptCheckText.js';
import { Modal } from '../../ui/Modal.jsx';
import { Icon } from '../../ui/icons.jsx';
import {
  Button, CollapsibleSection, Field, NativeSelect, SectionLabel, TextArea, TextInput, cx,
} from '../../ui/kit.jsx';
import { ChipButton } from '../../ui/Menu.jsx';
/** The builder's whole state, held by the studio so it survives closing. */
export function blankTimeline() {
  return {
    shots: [newShot()],
    subject: '<Subject 1>',
    secondary: '',
    style: '',
    summary: '',
    soundscape: '',
    music: '',
  };
}

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

// H3's own names for its shapes (Ref2VA, FL2VA, I2VA, L2VA, T2VA) are jargon in
// a footer; say what is attached instead.
const MODE_TEXT = {
  reference: () => 'Reference',
  flf: () => 'First + last frame',
  first: () => 'First frame',
  last: () => 'Last frame',
  text: () => 'Text',
};

const options = (list) => list.map(([value, label]) => (
  <option key={value || '_'} value={value}>{label}</option>
));

/**
 * The prompt this timeline would produce, with the cast's half of the current
 * prompt carried through. Exported so the Apply button and the preview can
 * never disagree about what is about to be written.
 */
export function timelinePrompt(timeline, { prompt = '', mode = 'text', durationSeconds = 0 } = {}) {
  const subjects = sectionBodyIn(prompt, 'subject_definitions');
  const retention = sectionBodyIn(prompt, 'retention_analysis');
  const existingSummary = sectionBodyIn(prompt, 'summary');
  return composeH3Prompt({
    mode,
    shots: timeline.shots,
    style: timeline.style,
    // The builder's own summary wins; otherwise whatever the prompt already
    // said stays, and only a prompt with neither gets one derived.
    summary: timeline.summary.trim() || existingSummary || '',
    subjects: subjects ? subjects.split('\n').filter(Boolean) : [],
    retention: retention ? retention.split('\n').filter(Boolean) : [],
    soundscape: timeline.soundscape,
    music: timeline.music,
    durationSeconds,
    subject: timeline.subject || '<Subject 1>',
    secondary: timeline.secondary,
  });
}

function CameraFields({ camera, onChange }) {
  const set = (patch) => onChange({ ...camera, ...patch });
  const grid = 'grid grid-cols-2 gap-2 sm:grid-cols-4';
  return (
    <div className="flex flex-col gap-2">
      <div className={grid}>
        <Field label="Framing">
          <NativeSelect value={camera.framing} onChange={(e) => set({ framing: e.target.value })}>{options(CAMERA_FRAMINGS)}</NativeSelect>
        </Field>
        <Field label="On">
          <NativeSelect value={camera.focusArea} onChange={(e) => set({ focusArea: e.target.value })}>{options(CAMERA_FOCUS_AREAS)}</NativeSelect>
        </Field>
        <Field label="Viewpoint">
          <NativeSelect value={camera.viewpoint} onChange={(e) => set({ viewpoint: e.target.value })}>{options(CAMERA_VIEWPOINTS)}</NativeSelect>
        </Field>
        <Field label="Angle">
          <NativeSelect value={camera.angle} onChange={(e) => set({ angle: e.target.value })}>{options(CAMERA_ANGLES)}</NativeSelect>
        </Field>
      </div>
      <div className={grid}>
        <Field label="Composition">
          <NativeSelect value={camera.composition} onChange={(e) => set({ composition: e.target.value })}>{options(CAMERA_COMPOSITIONS)}</NativeSelect>
        </Field>
        <Field label="Move">
          <NativeSelect value={camera.moveId} onChange={(e) => set({ moveId: e.target.value })}>{options(CAMERA_MOVE_OPTIONS)}</NativeSelect>
        </Field>
        {/* H3's own qualifiers — spelled the way the model was trained to read
            them, which is why they are picked rather than typed. */}
        <Field label="Range">
          <NativeSelect value={camera.amplitude} onChange={(e) => set({ amplitude: e.target.value })}>{options(CAMERA_AMPLITUDES)}</NativeSelect>
        </Field>
        <Field label="Speed">
          <NativeSelect value={camera.speed} onChange={(e) => set({ speed: e.target.value })}>{options(CAMERA_SPEEDS)}</NativeSelect>
        </Field>
      </div>
      <div className={grid}>
        <Field
          label="Move happens"
          hint="Where in the shot the move is stated"
        >
          <NativeSelect value={camera.timing} onChange={(e) => set({ timing: e.target.value })}>{options(CAMERA_TIMINGS)}</NativeSelect>
        </Field>
        <Field label="Operator">
          <NativeSelect value={camera.stability} onChange={(e) => set({ stability: e.target.value })}>{options(CAMERA_STABILITY)}</NativeSelect>
        </Field>
        <Field label="Lens">
          <NativeSelect value={camera.lens} onChange={(e) => set({ lens: e.target.value })}>{options(CAMERA_LENSES)}</NativeSelect>
        </Field>
        <Field label="Depth">
          <NativeSelect value={camera.depth} onChange={(e) => set({ depth: e.target.value })}>{options(CAMERA_DEPTH)}</NativeSelect>
        </Field>
      </div>
      <div className={grid}>
        <Field label="Focus">
          <NativeSelect value={camera.focusBehaviour} onChange={(e) => set({ focusBehaviour: e.target.value })}>{options(CAMERA_FOCUS_BEHAVIOUR)}</NativeSelect>
        </Field>
        {camera.focusBehaviour === 'rack' || camera.focusBehaviour === 'enter' ? (
          <>
            <Field label="From">
              <TextInput value={camera.focusFrom} onChange={(e) => set({ focusFrom: e.target.value })} placeholder="the opening target" />
            </Field>
            <Field label="To">
              <TextInput value={camera.focusTo} onChange={(e) => set({ focusTo: e.target.value })} placeholder="the ending target" />
            </Field>
          </>
        ) : null}
        {/* Where the move LANDS. Only the framing is offered: an endpoint that
            re-specifies everything reads to the model as a second shot. */}
        <Field label="Ends on">
          <NativeSelect value={camera.endFraming} onChange={(e) => set({ endFraming: e.target.value })}>{options(CAMERA_FRAMINGS)}</NativeSelect>
        </Field>
      </div>
      <Field label="Ending note (optional)">
        <TextInput value={camera.endNote} onChange={(e) => set({ endNote: e.target.value })} placeholder="the door closes behind her" />
      </Field>
      <Field
        label="Custom move (replaces the move above)"
        hint="Written here, the picked move stops generating a sentence"
      >
        <TextInput value={camera.custom} onChange={(e) => set({ custom: e.target.value })} placeholder="the camera swings wildly, losing her for a moment" />
      </Field>
    </div>
  );
}

function DialogueRow({ line, beats, onChange, onRemove }) {
  const set = (patch) => onChange({ ...line, ...patch });
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line1 bg-bg0 p-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label="Speaker">
          <TextInput value={line.speaker} onChange={(e) => set({ speaker: e.target.value })} placeholder="<Subject 1>" />
        </Field>
        <Field label="Language" hint="Decides the accent">
          <TextInput value={line.lang} onChange={(e) => set({ lang: e.target.value })} placeholder="English" />
        </Field>
        <Field label="Delivery">
          <TextInput value={line.delivery} onChange={(e) => set({ delivery: e.target.value })} placeholder="in an urgent whisper" />
        </Field>
        <Field label="Timing">
          <NativeSelect value={line.beatId} onChange={(e) => set({ beatId: e.target.value })}>
            <option value="">After the action</option>
            {beats.map((beat, index) => (
              <option key={beat.id} value={beat.id}>
                {`Beat ${index + 1}`} · {num(beat.startSec).toFixed(2)}–{num(beat.endSec).toFixed(2)}s
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Field label="Line">
        <TextArea rows={2} value={line.line} onChange={(e) => set({ line: e.target.value })} placeholder="I don't think I'm ready to open it." />
      </Field>
      <div className="flex flex-wrap items-center gap-1">
        {[
          ['voiceover', 'voiceover'],
          ['offscreen', 'off-screen'],
          ['cutoff', 'cut off by the end'],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => set({ [key]: !line[key] })}
            className={cx(
              'rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
              line[key] ? 'bg-honey-tint text-honey' : 'text-ink3 hover:bg-bg3 hover:text-ink2',
            )}
          >
            {label}
          </button>
        ))}
        {/* A line that runs across the cut needs its other half in the next
            shot — Check says so when only one end is marked. */}
        <NativeSelect
          className="ml-auto max-w-[11rem]"
          value={line.carry === true ? 'out' : line.carry}
          onChange={(e) => set({ carry: e.target.value })}
        >
          <option value="">stays in this shot</option>
          <option value="out">runs into the next shot</option>
          <option value="in">carries over from the previous</option>
        </NativeSelect>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove line"
          className="grid h-6 w-6 place-items-center rounded text-ink3 transition-colors hover:bg-bg3 hover:text-ink1"
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    </div>
  );
}

/** Nothing written in it yet — so a just-added shot opens instead of hiding. */
const shotIsBlank = (shot) => !(
  shot.action.trim() || shot.openingState.trim() || shot.cutTo.trim() || shot.sound.trim()
  || cameraIsSet(shot.camera)
  || shot.beats.some((beat) => beat.action.trim())
  || shot.dialogue.some((line) => line.line.trim())
);

function ShotCard({ shot, index, total, durationSeconds, onChange, onRemove, onMove }) {
  // The first shot, and any shot with nothing in it — adding a shot that stayed
  // folded shut reads as a click that did nothing.
  const [open, setOpen] = useState(() => index === 0 || shotIsBlank(shot));
  const set = (patch) => onChange({ ...shot, ...patch });
  const cameraSet = cameraIsSet(shot.camera);

  const setBeat = (id, patch) => set({ beats: shot.beats.map((beat) => (beat.id === id ? { ...beat, ...patch } : beat)) });
  const setLine = (id, next) => set({ dialogue: shot.dialogue.map((line) => (line.id === id ? next : line)) });

  const addBeat = () => {
    const last = shot.beats[shot.beats.length - 1];
    const start = last ? num(last.endSec) : 0;
    set({ beats: [...shot.beats, newBeat(start, Math.max(start, durationSeconds || start + 2))] });
  };

  return (
    <div className="rounded-lg border border-line1 bg-bg1">
      <div className="flex items-center gap-2 border-b border-line1 px-2.5 py-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} className="shrink-0 text-ink3" />
          <span className="text-[12px] font-semibold text-ink1">
            {`Shot ${index + 1}`}
          </span>
          {index > 0 ? (
            <span className="shrink-0 font-mono text-[10px] text-ink3">{timecode(shot.cutSec)}</span>
          ) : (
            <span className="shrink-0 font-mono text-[10px] text-ink3">00:00.000</span>
          )}
          {cameraSet ? <Icon name="camera" size={11} className="shrink-0 text-honey" /> : null}
          {shot.dialogue.some((line) => line.line.trim())
            ? <Icon name="mic" size={11} className="shrink-0 text-honey" /> : null}
          <span className="min-w-0 flex-1 truncate text-[10px] text-ink3">
            {shot.action || shot.openingState || 'nothing written yet'}
          </span>
        </button>
        <span className="flex shrink-0 items-center">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onMove(index, -1)}
            aria-label="Move up"
            className="grid h-6 w-5 place-items-center rounded text-ink3 transition-colors hover:bg-bg3 hover:text-ink1 disabled:opacity-30"
          >
            <Icon name="chevronDown" size={11} className="rotate-180" />
          </button>
          <button
            type="button"
            disabled={index === total - 1}
            onClick={() => onMove(index, 1)}
            aria-label="Move down"
            className="grid h-6 w-5 place-items-center rounded text-ink3 transition-colors hover:bg-bg3 hover:text-ink1 disabled:opacity-30"
          >
            <Icon name="chevronDown" size={11} />
          </button>
          <button
            type="button"
            disabled={total === 1}
            onClick={() => onRemove(shot.id)}
            aria-label="Remove shot"
            className="grid h-6 w-6 place-items-center rounded text-ink3 transition-colors hover:bg-bg3 hover:text-ink1 disabled:opacity-30"
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      </div>

      {open ? (
        <div className="flex flex-col gap-2.5 p-2.5">
          {index > 0 ? (
            <div className="grid grid-cols-2 gap-2">
              <Field
                label="Cuts at (seconds)"
                hint={durationSeconds && num(shot.cutSec) >= durationSeconds
                  ? 'past the end — this shot never happens'
                  : ''}
              >
                <TextInput
                  type="number"
                  min="0"
                  step="0.1"
                  value={shot.cutSec}
                  onChange={(e) => set({ cutSec: num(e.target.value) })}
                />
              </Field>
              <Field label="Transition">
                <NativeSelect value={shot.transition} onChange={(e) => set({ transition: e.target.value })}>
                  {options(SHOT_TRANSITIONS)}
                </NativeSelect>
              </Field>
              <Field className="col-span-2" label="Cuts to">
                <TextInput
                  value={shot.cutTo}
                  onChange={(e) => set({ cutTo: e.target.value })}
                  placeholder="a close-up of her hands"
                />
              </Field>
            </div>
          ) : null}

          <Field
            label="Opening state"
            hint="How things already are when the shot starts"
          >
            <TextArea rows={2} value={shot.openingState} onChange={(e) => set({ openingState: e.target.value })} />
          </Field>
          <Field label="Action">
            <TextArea rows={2} value={shot.action} onChange={(e) => set({ action: e.target.value })} />
          </Field>

          {/* Thirteen selects, folded: open when something is set, else one
              line — every open shot used to unroll all of them. */}
          <CollapsibleSection
            title="Camera"
            hint={cameraSet ? 'set' : ''}
            defaultOpen={cameraSet}
          >
            {cameraSet ? (
              <button
                type="button"
                onClick={() => set({ camera: blankCamera() })}
                className="-mt-1 self-end text-[10px] text-ink3 transition-colors hover:text-ink1"
              >
                Clear camera
              </button>
            ) : null}
            <CameraFields camera={shot.camera} onChange={(camera) => set({ camera })} />
          </CollapsibleSection>

          <div>
            <div className="mb-1 flex items-center gap-2">
              <SectionLabel>Timed beats</SectionLabel>
              <button
                type="button"
                onClick={addBeat}
                className="ml-auto text-[10px] font-semibold text-honey transition-colors hover:underline"
              >
                + Add beat
              </button>
            </div>
            {shot.beats.length ? (
              <div className="flex flex-col gap-1.5">
                {shot.beats.map((beat, at) => (
                  <div key={beat.id} className="flex items-end gap-1.5">
                    <Field className="w-20 shrink-0" label={at === 0 ? 'From' : ''}>
                      <TextInput type="number" min="0" step="0.1" value={beat.startSec} onChange={(e) => setBeat(beat.id, { startSec: num(e.target.value) })} />
                    </Field>
                    <Field className="w-20 shrink-0" label={at === 0 ? 'To' : ''}>
                      <TextInput type="number" min="0" step="0.1" value={beat.endSec} onChange={(e) => setBeat(beat.id, { endSec: num(e.target.value) })} />
                    </Field>
                    <Field className="min-w-0 flex-1" label={at === 0 ? 'What happens in that span' : ''}>
                      <TextInput value={beat.action} onChange={(e) => setBeat(beat.id, { action: e.target.value })} />
                    </Field>
                    <button
                      type="button"
                      onClick={() => set({
                        beats: shot.beats.filter((item) => item.id !== beat.id),
                        // A line pinned to a beat that no longer exists would
                        // silently stop being timed; unpin it instead.
                        dialogue: shot.dialogue.map((line) => (line.beatId === beat.id ? { ...line, beatId: '' } : line)),
                      })}
                      aria-label="Remove beat"
                      className="mb-1 grid h-7 w-7 shrink-0 place-items-center rounded text-ink3 transition-colors hover:bg-bg3 hover:text-ink1"
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[10px] leading-snug text-ink3">
                Optional. A beat tells H3 what happens between two stamped seconds, so the order of events stops being its choice.
              </p>
            )}
          </div>

          <div>
            <div className="mb-1 flex items-center gap-2">
              <SectionLabel>Dialogue</SectionLabel>
              <button
                type="button"
                onClick={() => set({ dialogue: [...shot.dialogue, newDialogue()] })}
                className="ml-auto text-[10px] font-semibold text-honey transition-colors hover:underline"
              >
                + Add line
              </button>
            </div>
            {shot.dialogue.length ? (
              <div className="flex flex-col gap-1.5">
                {shot.dialogue.map((line) => (
                  <DialogueRow
                    key={line.id}
                    line={line}
                    beats={shot.beats}
                    onChange={(next) => setLine(line.id, next)}
                    onRemove={() => set({ dialogue: shot.dialogue.filter((item) => item.id !== line.id) })}
                  />
                ))}
              </div>
            ) : null}
          </div>

          <Field
            label="This shot's sound"
            hint="Synchronised physical sound, not the overall ambience"
          >
            <TextInput value={shot.sound} onChange={(e) => set({ sound: e.target.value })} placeholder="paper tearing" />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

/**
 * @param {object}   props
 * @param {boolean}  props.open
 * @param {Function} props.onClose
 * @param {object}   props.timeline        owned by the studio, so it survives closing
 * @param {Function} props.onTimelineChange
 * @param {string}   props.prompt          what is in the composer now
 * @param {number}   props.durationSeconds
 * @param {object}   props.references      { images, videos, audios } as attached
 * @param {string}   props.firstFrame      the start-frame url, if any
 * @param {string}   props.lastFrame       the end-frame url, if any
 * @param {Function} props.onApply         (promptText) => void
 */
export function ShotBuilderDialog({
  open, onClose, timeline, onTimelineChange, prompt = '', durationSeconds = 0,
  references = {}, firstFrame = '', lastFrame = '', onApply,
}) {
  const images = references.images || [];
  const videos = references.videos || [];
  const audios = references.audios || [];
  const mode = h3Mode({ firstFrame, lastFrame, images, videos, audios });

  // Opening the builder onto a prompt that already has shots and sound: the
  // timeline starts from what is there. It used to open on one blank shot over
  // a starter's three written ones and offer to replace them with it — the
  // chip read 0 while the prompt held three. Only a BLANK timeline is seeded;
  // a timeline someone already built is theirs, and the footer warns instead.
  const [seeded, setSeeded] = useState(false);
  const [seededShots, setSeededShots] = useState(0);
  const promptShotCount = useMemo(() => (open ? parseShotBlocks(prompt).length : 0), [open, prompt]);
  useEffect(() => {
    if (!open) { setSeeded(false); setSeededShots(0); return; }
    if (seeded) return;
    setSeeded(true);
    const soundscape = sectionBodyIn(prompt, 'overall_soundscape');
    const music = sectionBodyIn(prompt, 'non_diegetic_music');
    const next = { ...timeline };
    let changed = false;
    if (!timeline.soundscape && soundscape) { next.soundscape = soundscape; next.music = timeline.music || music || ''; changed = true; }
    else if (!timeline.music && music) { next.music = music; changed = true; }
    if (timeline.shots.every(shotIsBlank)) {
      const shots = timelineShotsFromPrompt(prompt);
      if (shots.length) { next.shots = shots; setSeededShots(shots.length); changed = true; }
    }
    if (changed) onTimelineChange(next);
  }, [open, seeded, prompt, timeline, onTimelineChange]);
  // The prompt's own shots will be REPLACED by what is written here — said in
  // the footer when they are not the ones this timeline came from.
  const replaces = promptShotCount > 0 && !seededShots;

  const set = (patch) => onTimelineChange({ ...timeline, ...patch });
  const setShot = (id, next) => set({ shots: timeline.shots.map((shot) => (shot.id === id ? next : shot)) });
  const moveShot = (index, delta) => {
    const to = index + delta;
    if (to < 0 || to >= timeline.shots.length) return;
    const next = [...timeline.shots];
    [next[index], next[to]] = [next[to], next[index]];
    set({ shots: next });
  };
  const addShot = () => {
    const end = timelineEndSec(timeline.shots, 0);
    const start = Math.max(end, num(timeline.shots[timeline.shots.length - 1]?.cutSec) + 1);
    const shot = newShot();
    shot.cutSec = Math.min(start, Math.max(0, durationSeconds - 0.5)) || start;
    set({ shots: [...timeline.shots, shot] });
  };

  const composed = useMemo(
    () => timelinePrompt(timeline, { prompt, mode, durationSeconds }),
    [timeline, prompt, mode, durationSeconds],
  );
  const check = useMemo(
    () => checkH3Prompt({ prompt: composed, durationSeconds, images, videos, audios }),
    [composed, durationSeconds, images, videos, audios],
  );
  const ids = speakerIds(timeline.shots);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Shot builder"
      footer={(
        <>
          <span className="mr-auto flex min-w-0 flex-col text-[11px] text-ink3">
            <span>
              {`${MODE_TEXT[mode]()} · ${timeline.shots.length} shot${timeline.shots.length === 1 ? '' : 's'} · ${composed.length.toLocaleString()} chars`}
            </span>
            {seededShots ? (
              <span className="text-honey">
                {`Seeded from the ${seededShots} shot${seededShots === 1 ? '' : 's'} already in the prompt`}
              </span>
            ) : replaces ? (
              <span className="text-honey">
                {`This prompt already has ${promptShotCount} shot${promptShotCount === 1 ? '' : 's'} — writing replaces them`}
              </span>
            ) : null}
          </span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => { onApply?.(composed); onClose?.(); }}
            title="Writes the description, the soundscape and the music. subject_definitions and retention_analysis are left exactly as the cast wrote them."
          >
            Write into the prompt
          </Button>
        </>
      )}
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-2.5">
          <div className="grid grid-cols-2 gap-2">
            <Field
              label="This scene is about"
              hint="The camera sentences point at this name"
            >
              <TextInput value={timeline.subject} onChange={(e) => set({ subject: e.target.value })} placeholder="<Subject 1>" />
            </Field>
            <Field label="Second subject (optional)">
              <TextInput value={timeline.secondary} onChange={(e) => set({ secondary: e.target.value })} placeholder="<Subject 2>" />
            </Field>
          </div>
          <Field
            label="Look"
            hint="Stated once, before the shots, and governs all of them"
          >
            <TextInput value={timeline.style} onChange={(e) => set({ style: e.target.value })} placeholder="Handheld documentary footage, natural light" />
          </Field>

          {timeline.shots.map((shot, index) => (
            <ShotCard
              key={shot.id}
              shot={shot}
              index={index}
              total={timeline.shots.length}
              durationSeconds={durationSeconds}
              onChange={(next) => setShot(shot.id, next)}
              onRemove={(id) => set({ shots: timeline.shots.filter((item) => item.id !== id) })}
              onMove={moveShot}
            />
          ))}

          <button
            type="button"
            onClick={addShot}
            className="rounded-md border border-dashed border-line2 py-2 text-[11px] font-semibold text-ink2 transition-colors hover:border-honey hover:text-ink1"
          >
            + Add shot
          </button>

          <Field label="Summary (optional)" hint="Left blank, whatever the prompt already says stays">
            <TextArea rows={2} value={timeline.summary} onChange={(e) => set({ summary: e.target.value })} />
          </Field>
          <Field
            label="Overall soundscape"
            hint="H3 renders the audio too — unsaid means invented"
          >
            <TextArea rows={2} value={timeline.soundscape} onChange={(e) => set({ soundscape: e.target.value })} placeholder="A quiet interior — rain on the window, paper, nothing else." />
          </Field>
          <Field label="Non-diegetic music" hint="Blank means N/A — no score">
            <TextInput value={timeline.music} onChange={(e) => set({ music: e.target.value })} />
          </Field>
        </div>

        <div className="flex min-w-0 flex-col gap-2 lg:sticky lg:top-0 lg:self-start">
          <div>
            <SectionLabel>What gets written</SectionLabel>
            <pre className="mt-1 max-h-[26rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line1 bg-bg0 p-2 font-mono text-[10px] leading-relaxed text-ink2">
              {composed}
            </pre>
          </div>

          {ids.size ? (
            <div className="rounded-md border border-line1 bg-bg0 p-2">
              <SectionLabel>Speaker ids</SectionLabel>
              <ul className="mt-1 flex flex-col gap-0.5">
                {[...ids.entries()].map(([who, sid]) => (
                  <li key={sid} className="flex items-center gap-1.5 text-[10px] text-ink2">
                    <span className="font-mono text-honey">{sid}</span>
                    <span className="min-w-0 truncate">{who}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[10px] leading-snug text-ink3">
                Numbered in the order they are first heard.
              </p>
            </div>
          ) : null}

          <div>
            <SectionLabel>Check</SectionLabel>
            <p className="mt-1 text-[10px] text-ink3">{checkSummaryText(check)}</p>
            {check.findings.length ? (
              <ul className="mt-1 flex flex-col gap-1">
                {[...check.findings]
                  .sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))
                  .map((finding, index) => (
                    <li
                      key={`${finding.code}-${index}`}
                      className={cx(
                        'rounded-md border p-1.5 text-[10px] leading-snug',
                        finding.level === 'error'
                          ? 'border-danger bg-danger-tint text-ink1'
                          : 'border-honey bg-honey-tint text-ink1',
                      )}
                    >
                      {describeCheckFinding(finding)}
                    </li>
                  ))}
              </ul>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The chip that opens the builder, showing what the timeline already holds —
 * or, while the builder holds nothing, how many shots the PROMPT already has
 * (a loaded starter's three read as 0 before).
 */
export function ShotBuilderChip({ timeline, prompt = '', onOpen }) {
  const shots = timeline?.shots || [];
  const written = shots.filter((shot) => !shotIsBlank(shot)).length;
  const inPrompt = written ? 0 : parseShotBlocks(prompt).length;
  const count = written || inPrompt;
  return (
    <ChipButton
      icon="clapper"
      label="Shots"
      value={count ? String(count) : ''}
      active={count > 0}
      chevron={false}
      onClick={onOpen}
      title={inPrompt
        ? `The prompt already has ${inPrompt} shot${inPrompt === 1 ? '' : 's'} — the builder opens on them`
        : "Lay out several shots inside one generation — cuts, camera, timed beats and dialogue, written in H3's own grammar"}
    />
  );
}
