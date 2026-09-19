// Recast — the panel for putting your cast into somebody else's clip.
//
// The grammar is in lib/h3Recast.js; this is the surface, and its one job is to
// make the hard part possible rather than merely required.
//
// The hard part is shot description. A recast needs every shot of the source
// written out, and nobody can write out a shot list from memory of a clip they
// watched once — so the clip is IN here, scrubbing, with a cut list built
// against it: park the playhead where a cut lands, press Mark a cut, describe
// what you are looking at. Each row keeps a frame of the source at its own
// timestamp, so the list reads back as a storyboard of the thing being recast.
//
// Everything else on the panel is one of the three clauses that hold a recast
// together, shown as a switch that says what it does rather than hidden inside
// the compiled prompt.
//
// Nothing here talks to the gateway. The source clip is a sealed reference, so
// it is decrypted in this browser (resolveMediaSrc) and decoded locally by
// mediabunny — the same constraint as Clip Prep.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  RECAST_SECONDS,
  newRecastShot,
  recastFromPrompt,
  recastShotsWritten,
  recastTemplate,
  recastTimecode,
  recastWarnings,
} from '../../lib/h3Recast.js';
import { referenceLabels, referenceUrl, motionReferenceRows } from '../../lib/h3References.js';
import { resolveMediaSrc } from '../../lib/e2eMedia.js';
import { Modal } from '../../ui/Modal.jsx';
import { Icon } from '../../ui/icons.jsx';
import {
  Button, Field, SectionLabel, Spinner, TextArea, TextInput, Toggle, cx,
} from '../../ui/kit.jsx';

const seconds1 = (value) => `${(Math.max(0, Number(value) || 0)).toFixed(1)}s`;

/* ---------------- the source clip, decrypted and scrubbing ---------------- */

/**
 * The clip being recast, as a player with a cut list built against it.
 *
 * `onMark` is handed the playhead, which is the whole interaction: a cut is
 * marked where you are looking, not typed as a number you had to read off
 * somewhere else.
 */
function SourceClip({ url, name, onMark, seekTo, onDuration, onBlob }) {
  const videoRef = useRef(null);
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  const [at, setAt] = useState(0);
  const [length, setLength] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';
    setSrc(''); setFailed(false);
    if (!url) return undefined;
    (async () => {
      try {
        const resolved = await resolveMediaSrc(url);
        if (cancelled) return;
        setSrc(resolved);
        // The same bytes feed the per-row thumbnails. Fetched once here rather
        // than per row: six decodes of one clip is six fetches otherwise.
        const blob = await (await fetch(resolved)).blob();
        if (!cancelled) onBlob?.(blob);
      } catch (err) {
        console.error('[RecastDialog] could not open the source clip:', err);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, onBlob]);

  // Seeking from a shot row: park the playhead on the shot being edited.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || seekTo == null) return;
    try { video.currentTime = Math.max(0, Number(seekTo) || 0); } catch { /* not seekable yet */ }
  }, [seekTo]);

  if (failed) {
    return (
      <div className="rounded-md border border-line1 bg-bg2 px-3 py-4 text-center text-[11px] text-ink3">
        The clip could not be opened here. You can still write the shot list — the timestamps are
        just numbers — but you will be describing it from memory.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative overflow-hidden rounded-md border border-line1 bg-black">
        {src ? (
          <video
            ref={videoRef}
            src={src}
            controls
            // One download path in this studio, and it is not the browser's:
            // Chrome names a blob: save from the URL's UUID, so a native
            // download can never agree with ours (downloadNameSingleSource).
            controlsList="nodownload"
            playsInline
            className="max-h-[240px] w-full bg-black"
            onTimeUpdate={(e) => setAt(e.currentTarget.currentTime || 0)}
            onLoadedMetadata={(e) => {
              const found = Number(e.currentTarget.duration) || 0;
              setLength(found);
              onDuration?.(found);
            }}
          />
        ) : (
          <div className="grid h-[180px] place-items-center"><Spinner size={18} /></div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          icon="scissors"
          onClick={() => onMark?.(videoRef.current?.currentTime || 0)}
        >
          Mark a cut here
        </Button>
        <span className="font-mono text-[10px] text-ink3">
          {recastTimecode(at)}{length ? ` / ${seconds1(length)}` : ''}
        </span>
        <span className="ml-auto truncate text-[10px] text-ink3" title={name}>{name}</span>
      </div>
    </div>
  );
}

/** A frame of the source at one moment, so a shot row shows what it is about. */
function ShotThumb({ blob, at }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let cancelled = false;
    let made = '';
    if (!blob) { setUrl(''); return undefined; }
    // Debounced: dragging a timestamp should not queue a decode per keystroke.
    const timer = setTimeout(async () => {
      try {
        const { grabFrame } = await import('../../lib/clipPrep.js');
        const frame = await grabFrame(blob, at, { width: 160, type: 'image/jpeg', quality: 0.7 });
        if (cancelled) return;
        made = URL.createObjectURL(frame.blob);
        setUrl(made);
      } catch { /* a clip we cannot decode still gets a written shot list */ }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (made) { try { URL.revokeObjectURL(made); } catch { /* already gone */ } }
    };
  }, [blob, at]);

  return (
    <div className="h-12 w-20 shrink-0 overflow-hidden rounded border border-line1 bg-bg3">
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : null}
    </div>
  );
}

/** A switch that says what it does. Toggle draws the control only. */
function ClauseRow({ label, hint, checked, onChange }) {
  return (
    <div className="flex items-start gap-2.5 py-1">
      <Toggle checked={checked} onChange={onChange} label={label} />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium text-ink1">{label}</div>
        {hint ? <div className="text-[10px] leading-snug text-ink3">{hint}</div> : null}
      </div>
    </div>
  );
}

/* ---------------- one shot of the source ---------------- */

function ShotRow({
  shot, index, blob, duration, onChange, onRemove, onSeek, canRemove,
}) {
  const first = index === 0;
  return (
    <div className="flex gap-2 rounded-md border border-line1 bg-bg1 p-2">
      <button
        type="button"
        onClick={() => onSeek(shot.at)}
        title="Show this moment in the clip"
        className="shrink-0 rounded transition-opacity hover:opacity-80"
      >
        <ShotThumb blob={blob} at={Number(shot.at) || 0} />
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-ink1">Shot {index + 1}</span>
          {first ? (
            <span className="text-[10px] text-ink3">opens the clip</span>
          ) : (
            <label className="flex items-center gap-1 text-[10px] text-ink3">
              cuts at
              <input
                type="number"
                min={0}
                max={duration || undefined}
                step={0.1}
                value={Number(shot.at) || 0}
                onChange={(e) => onChange({ ...shot, at: Math.max(0, Number(e.target.value) || 0) })}
                className="h-6 w-16 rounded border border-line1 bg-bg2 px-1 text-right font-mono text-[10px] text-ink1"
              />
              s
            </label>
          )}
          {canRemove ? (
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove shot ${index + 1}`}
              title="Remove this shot"
              className="ml-auto text-ink3 transition-colors hover:text-danger"
            >
              <Icon name="x" size={13} />
            </button>
          ) : null}
        </div>

        {!first ? (
          <TextInput
            value={shot.framing || ''}
            onChange={(e) => onChange({ ...shot, framing: e.target.value })}
            placeholder="the cut lands on… (a close-up of their hands, the back of her head)"
            className="h-7 text-[11px]"
          />
        ) : null}

        <TextArea
          rows={2}
          value={shot.action || ''}
          onChange={(e) => onChange({ ...shot, action: e.target.value })}
          placeholder={first
            ? 'What happens, and how it is framed. "Medium close-up, eye-level. The two face each other; she looks at her with a longing expression."'
            : 'What happens in this shot.'}
          className="text-[11px]"
        />
      </div>
    </div>
  );
}

/* ---------------- the panel ---------------- */

export function RecastDialog({
  open = true,
  onClose,
  plan,
  onPlanChange,
  // The composer's current prompt — read only to seed a plan from shots that
  // are already written, so reopening is not a blank slate beside a full box.
  prompt = '',
  durationSeconds = 0,
  // Every attached reference, as the studio holds them.
  references = {},
  // The cast, already numbered: [{ subject, name, look }]. Derived by the
  // studio from the same weave the prompt is compiled through, so the panel and
  // the prompt cannot disagree about who <Subject 2> is.
  subjects = [],
  // Offered rather than done: nothing here shortens a run behind your back.
  onSetDuration,
  // Handed the compiled { summary, detailed_description } — the studio weaves
  // it onto the cast rather than re-deriving it, so what was previewed is what
  // is written.
  onApply,
}) {
  const images = references.images || [];
  const videos = references.videos || [];
  const audios = references.audios || [];

  const labels = useMemo(() => referenceLabels({ images, videos, audios }), [images, videos, audios]);
  const pictureLabels = labels.images;
  const videoLabels = labels.videos.map((entry) => entry.video).filter(Boolean);

  // The clip being recast is the first MOTION row: a sound-only row carries no
  // <Video N> and has no shots to describe.
  const sourceRow = motionReferenceRows(videos)[0] || null;
  const sourceUrl = sourceRow ? referenceUrl(sourceRow) : '';
  const sourceName = (sourceRow && sourceRow.name) || 'the reference clip';

  const [blob, setBlob] = useState(null);
  const [clipSeconds, setClipSeconds] = useState(0);
  const [seekTo, setSeekTo] = useState(null);
  const takeBlob = useCallback((next) => setBlob(next), []);

  // Seed once per opening, and only over a plan nobody has touched — a plan
  // already built is the author's, exactly as the Shot Builder treats one.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!open) { setSeeded(false); return; }
    if (seeded) return;
    setSeeded(true);
    const untouched = (plan?.shots || []).length <= 1 && !recastShotsWritten(plan || {});
    if (!untouched) return;
    const fromPrompt = recastFromPrompt(prompt);
    if (fromPrompt) onPlanChange({ ...plan, ...fromPrompt });
  }, [open, seeded, plan, prompt, onPlanChange]);

  const set = (patch) => onPlanChange({ ...plan, ...patch });
  const setShot = (id, next) => set({ shots: plan.shots.map((shot) => (shot.id === id ? next : shot)) });
  const markCut = (at) => {
    const rounded = Math.round((Number(at) || 0) * 10) / 10;
    const next = [...plan.shots, newRecastShot(rounded)]
      .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    // Whatever order they were added in, shot 1 opens the clip.
    if (next.length) next[0] = { ...next[0], at: 0 };
    set({ shots: next });
  };

  const warnings = useMemo(() => recastWarnings({
    plan, durationSeconds, pictures: pictureLabels, videos: videoLabels, subjects,
  }), [plan, durationSeconds, pictureLabels, videoLabels, subjects]);

  // The preview is rendered FROM the template that gets applied — the same
  // object, not a second computation of the same idea. Two of those drift.
  const template = useMemo(
    () => recastTemplate({ plan, subjects, pictures: pictureLabels, videos: videoLabels }),
    [plan, subjects, pictureLabels, videoLabels],
  );
  const preview = `summary:\n${template.summary}\n\ndetailed_description:\n${template.detailed_description}`;

  const written = recastShotsWritten(plan);
  const blocking = warnings.find((entry) => entry.code === 'no-clip');

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      title="Recast this clip"
      footer={(
        <div className="flex w-full items-center gap-2">
          <span className="text-[10px] text-ink3">
            {written
              ? `${written} of ${plan.shots.length} shot${plan.shots.length === 1 ? '' : 's'} described`
              : 'Describe at least the first shot'}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={Boolean(blocking) || !written}
              onClick={() => { onApply(template); onClose(); }}
            >
              Write the prompt
            </Button>
          </div>
        </div>
      )}
    >
      <div className="flex flex-col gap-3">
        <p className="text-[11px] leading-relaxed text-ink2">
          Re-performs the clip below with your cast in it — its cuts, staging and the performers’
          expressions and actions carry; its art style and its performers do not. That only holds if
          every shot is described, so the clip is here to describe it against.
        </p>

        {blocking ? (
          <div className="rounded-md border border-danger bg-bg2 px-3 py-2 text-[11px] leading-snug text-ink2">
            No motion clip is attached. Add one under <span className="font-semibold">References → Motion</span> —
            the clip is the thing being recast, so there is nothing to describe without it.
          </div>
        ) : (
          <SourceClip
            url={sourceUrl}
            name={sourceName}
            onMark={markCut}
            seekTo={seekTo}
            onDuration={setClipSeconds}
            onBlob={takeBlob}
          />
        )}

        {/* WHO. Numbered exactly as the prompt will number them, so the shot
            text can name <Subject 2> and mean the person shown here. */}
        <div className="flex flex-col gap-1.5">
          <SectionLabel>Who is in it</SectionLabel>
          {subjects.length ? subjects.map((entry) => (
            <div key={entry.subject} className="flex items-baseline gap-2 rounded-md border border-line1 bg-bg1 px-2 py-1.5">
              <span className="shrink-0 font-mono text-[10px] text-honey">{entry.subject}</span>
              <span className="shrink-0 text-[11px] font-semibold text-ink1">{entry.name || 'Your references'}</span>
              <span className={cx('min-w-0 flex-1 truncate text-[10px]', entry.look ? 'text-ink3' : 'text-honey')}>
                {entry.look || 'no look written — the closing "keep them recognizable" line needs one (Cast → this member)'}
              </span>
            </div>
          )) : (
            <p className="rounded-md border border-line1 px-2 py-1.5 text-[10px] text-ink3">
              Nobody is attached yet. Add the character pictures under References — they are who the
              clip gets re-performed by, and they decide the art style.
            </p>
          )}
        </div>

        {/* WHERE. Its own field because the blend sentence is built from it. */}
        <Field label="Where it happens" hint="The room, its light and its colour — the cast has to sit in it rather than arrive lit by their reference sheets.">
          <TextInput
            value={plan.setting || ''}
            onChange={(e) => set({ setting: e.target.value })}
            placeholder="A dimly lit room with cool blue lighting and bookshelves"
          />
        </Field>

        {/* THE SHOTS. */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <SectionLabel>The shots in the clip</SectionLabel>
            <button
              type="button"
              onClick={() => markCut(clipSeconds ? Math.min(clipSeconds, (Number(plan.shots[plan.shots.length - 1]?.at) || 0) + 1) : 0)}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-line1 bg-bg2 px-2 py-1 text-[10px] font-semibold text-ink2 transition-colors hover:border-line2 hover:text-ink1"
            >
              <Icon name="plus" size={11} /> Add a shot
            </button>
          </div>
          {plan.shots.map((shot, index) => (
            <ShotRow
              key={shot.id}
              shot={shot}
              index={index}
              blob={blob}
              duration={clipSeconds}
              canRemove={plan.shots.length > 1}
              onSeek={(at) => setSeekTo(at)}
              onChange={(next) => setShot(shot.id, next)}
              onRemove={() => set({ shots: plan.shots.filter((entry) => entry.id !== shot.id) })}
            />
          ))}
        </div>

        {/* WHAT CARRIES — the three clauses, each saying what it does. */}
        <div className="flex flex-col gap-1.5 rounded-md border border-line1 bg-bg0 px-2.5 py-2">
          <SectionLabel>What carries</SectionLabel>
          <ClauseRow
            label="Art style from the pictures, not from the clip"
            hint="The one clause a recast fails without: left unsaid, the source’s rendering wins over your character sheets."
            checked={plan.styleLock !== false}
            onChange={(next) => set({ styleLock: next })}
          />
          <ClauseRow
            label="Blend the cast into the scene’s own light"
            hint="Without it they arrive lit by whatever lit their reference pictures, and read as pasted in."
            checked={plan.blend !== false}
            onChange={(next) => set({ blend: next })}
          />
          <ClauseRow
            label="Hold height, scale and proportions steady"
            hint="Turn off for a deliberate size difference — a giant, a child — that this would flatten."
            checked={plan.proportions !== false}
            onChange={(next) => set({ proportions: next })}
          />
        </div>

        {/* What is not right yet. Every one of these names its fix. */}
        {warnings.filter((entry) => entry.code !== 'no-clip').length ? (
          <div className="flex flex-col gap-1">
            {warnings.map((entry) => {
              if (entry.code === 'no-clip') return null;
              const text = {
                'no-pictures': 'No character pictures are attached, so the only faces available are the clip’s own performers — which is the thing a recast is for avoiding. Add pictures under References.',
                'blank-shot': `Shot ${entry.shots?.join(', ')} ${entry.shots?.length === 1 ? 'has' : 'have'} no description. An undescribed shot is re-performed from the model’s guess at it, and the guess is where the source’s cast comes back.`,
                'no-setting': 'No setting written. Without it the cast keeps the light they were photographed in.',
                'style-clash': `${entry.subjects?.join(', ')} ${entry.subjects?.length === 1 ? 'carries a render style of its own' : 'carry render styles of their own'} — “rendered as …” in the prompt — which argues with taking the art style from the pictures. Drawn character sheets usually lose that argument. Change it on the cast member (the chip above the prompt), or switch the style lock off.`,
                'no-look': `${entry.subjects?.join(', ')} ${entry.subjects?.length === 1 ? 'has' : 'have'} no look written, so the closing “keep them recognizable” line cannot name them. Write one on the cast member.`,
                long: `${seconds1(entry.seconds)} is past the ${RECAST_SECONDS.best}s a recast holds best. Identity drifts back toward the clip’s own performers in the later shots.`,
                'too-long': `${seconds1(entry.seconds)} is past the ${RECAST_SECONDS.max}s a recast survives. Split it into two runs, or shorten this one.`,
                'cut-past-end': `Shot ${entry.shots?.join(', ')} cuts at or after the ${seconds1(entry.seconds)} end of the run, so it never plays.`,
              }[entry.code];
              if (!text) return null;
              const bad = entry.code === 'too-long' || entry.code === 'no-pictures' || entry.code === 'cut-past-end';
              return (
                <p
                  key={entry.code}
                  className={cx(
                    'rounded-md border px-2 py-1.5 text-[10px] leading-snug',
                    bad ? 'border-danger bg-bg2 text-ink2' : 'border-honey/40 bg-honey-tint text-honey',
                  )}
                >
                  {text}
                  {(entry.code === 'long' || entry.code === 'too-long') && onSetDuration ? (
                    <button
                      type="button"
                      onClick={() => onSetDuration(RECAST_SECONDS.best)}
                      className="ml-1 font-semibold underline underline-offset-2"
                    >
                      Set the run to {RECAST_SECONDS.best}s
                    </button>
                  ) : null}
                </p>
              );
            })}
          </div>
        ) : null}

        {/* The prompt half this writes. Who everyone is is added by the cast on
            the way out, which is why the preview shows two sections and not six. */}
        <details className="rounded-md border border-line1 bg-bg0">
          <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink3">
            What this writes
          </summary>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap px-2.5 pb-2 font-mono text-[10px] leading-relaxed text-ink2">
            {preview}
          </pre>
        </details>
      </div>
    </Modal>
  );
}

/** The composer chip. Armed from the PROMPT, so Start fresh turns it off with it. */
export function RecastChip({ armed, shots, onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Recast — re-perform an attached clip with your own cast in it"
      className={cx(
        'inline-flex h-ctl-md shrink-0 items-center gap-2 rounded-md border px-3 text-[13px] transition-colors',
        armed
          ? 'border-honey/50 bg-honey-tint text-ink1'
          : 'border-line1 bg-bg2 text-ink1 hover:border-line2 hover:bg-bg3',
      )}
    >
      <Icon name="clapper" size={15} className={cx('shrink-0', armed ? 'text-honey' : 'text-ink3')} />
      <span className="shrink-0 text-xs font-medium text-ink3">Recast</span>
      {armed && shots ? <span className="font-medium">{shots} shot{shots === 1 ? '' : 's'}</span> : null}
    </button>
  );
}
