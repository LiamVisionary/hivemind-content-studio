// MiniMax H3 Reference mode: what the model will CALL each attached reference.
//
// The numbering is not one counter per argument list. MiniMaxH3ReferenceToVideo
// presents references in a fixed order — pictures, then each video, then the
// standalone audio — and a reference video whose own soundtrack is switched on
// emits an <Audio N> label immediately BEFORE its <Video N>. So a video with
// sound plus one voice clip numbers <Audio 1> (the soundtrack), <Video 1>,
// <Audio 2> (the voice clip). A prompt written from a naive count addresses the
// wrong reference, which is why the composer shows these labels on each row.
const EXTENSIONS = {
  images: ['.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif', '.gif', '.avif'],
  videos: ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'],
  audios: ['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac'],
};

import { normalizePersonaGender, personaGenderWords } from './personaId.js';

// The source behind an attached reference. Pictures are stored as a bare url;
// clips carry a name (and, for video, its soundtrack switch) alongside it.
export function referenceUrl(item) {
  return (typeof item === 'string' ? item : item?.url) || '';
}

// ── Compact staging ──────────────────────────────────────────────────────────
//
// How a reference clip is STAGED for the node — the `canvas` the MCP takes on
// each reference_videos entry. "full" keeps MiniMax H3's own 768-short-edge
// reference canvas; "compact" fits the clip inside 384x1152 (never upscaled):
// about 3.3x fewer sequence rows and roughly half the step time. Measured
// 2026-08-21 on a rented 5090, same seed, 5s clip @1216x704 with three identity
// pictures: a MOTION reference staged 384 px wide transfers the movement as
// well as the full canvas (PSNR 23.7 dB / SSIM 0.88 between the two renders,
// against ~17.4 dB / 0.80 to a no-video control) while the real step time fell
// from 42 s to 22 s and torch's peak from 23.0 to 16.7 GiB.
//
// It is a per-clip choice and OFF by default, because the measurement is for
// motion only. With no picture attached the clip IS the character reference
// (the panel says so on its info line), and identity needs pixels — so while
// that is the case the switch is held off however the row is set. Holding it
// rather than clearing it means a picture removed and re-attached does not
// silently lose the choice, and a picture removed after the fact cannot quietly
// shrink the face the run is built on.
export function referenceVideoCompactLocked({ images = [] } = {}) {
  return !(Array.isArray(images) ? images : []).filter(Boolean).length;
}

export function referenceVideoCanvas(item, { images = [] } = {}) {
  if (referenceVideoCompactLocked({ images })) return 'full';
  const compact = typeof item === 'object' && item !== null && Boolean(item.compact);
  return compact ? 'compact' : 'full';
}

// Two rows of the SAME source are never what someone means. Nothing about a
// reference varies per slot: the item holds only its url, its filename and (for
// video) its soundtrack and compact-staging switches — and those belong to the
// one row, which is why a clip with sound already claims an <Audio N> of its
// own without being attached twice. The retention marker does vary per label, but it lives
// in the prompt, and the two markers a duplicate could carry contradict each
// other over one source: fully_copy reperforms its words, reference forbids
// them. So a repeat only burns one of the nine picture (or three clip) slots.
export function referenceAttachIndex(items = [], url = '') {
  if (!url) return -1;
  return items.findIndex((item) => referenceUrl(item) === url);
}

// React keys for the attached rows. The url identifies a reference, so removing
// one leaves every other row mounted with its decrypted preview intact — but the
// same url can still arrive twice from outside (a generation restored from
// before attach() deduped), and duplicate keys are a React error, not a cosmetic
// one. A repeat gets an occurrence suffix; the first of each stays bare.
export function referenceRowKeys(items = []) {
  const seen = new Map();
  return items.map((item, index) => {
    const url = referenceUrl(item) || `row-${index}`;
    const seenBefore = seen.get(url) || 0;
    seen.set(url, seenBefore + 1);
    return seenBefore ? `${url}#${seenBefore}` : url;
  });
}

// Which reference row a dragged file belongs in. MIME first — it is the only
// thing a dragover event exposes, so it is what the highlight can use — with an
// extension fallback for the drags that arrive as application/octet-stream.
export function referenceKindForFile({ type = '', name = '' } = {}) {
  const mime = String(type || '').toLowerCase();
  if (mime.startsWith('image/')) return 'images';
  if (mime.startsWith('video/')) return 'videos';
  if (mime.startsWith('audio/')) return 'audios';
  const extension = (String(name || '').match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();
  if (!extension) return null;
  return Object.keys(EXTENSIONS).find((kind) => EXTENSIONS[kind].includes(extension)) || null;
}

// Why a dropped file cannot be attached, as a CODE — the wording (and its
// translation) belongs to the panel. null means it can be.
//
// These are three unrelated failures and they used to be reported as one
// sentence, "Not usable as a reference: <name>", which told you nothing about
// which had happened. A full row and an unsupported file need opposite fixes,
// and a server refusal (too large, unsupported codec) already carries its own
// explanation that the drop handler was discarding.
export function referenceDropBlock({ kind, taken = 0, limit = 0 } = {}) {
  if (!kind) return 'unsupported';
  if (taken >= limit) return 'full';
  return null;
}

// The kinds a drag is carrying, for highlighting the row it will land in.
// During dragover the browser exposes each item's TYPE but not its name, so an
// extension-only drag reads as unknown — the drop still routes it correctly.
export function referenceKindsInDrag(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  const kinds = items
    .filter((item) => item.kind === 'file')
    .map((item) => referenceKindForFile({ type: item.type }))
    .filter(Boolean);
  return [...new Set(kinds)];
}

// One click writes the whole reference scaffold the shot needs: a
// retention_analysis line per attached reference, the summary's audio tag, and
// a dialogue stub in the format the model reads speech from.
//
// It used to write the <Video N> line alone, which left the two hardest parts
// undiscoverable — that a clip's soundtrack takes an <Audio N> label of its
// own, and that spoken lines go in <d>…</d> inside detailed_description with a
// (S1) speaker id. Nobody guesses that from an empty box.
//
// Then it wrote those pieces and nothing else, which was its own trap: pressed
// on an empty composer, the result READ finished — a tidy block of retention
// lines and a dialogue line — while missing every section the model actually
// reads a shot from. A run made that way (2026-08-11) spent the first four of
// eight seconds on invented speech before reaching the written line, because
// nothing said what the shot was, who <Subject 1> is, or that no other speech
// belongs in the clip. So: with a six-section prompt in the box each piece is
// filed into its section, and WITHOUT one the whole frame gets written, blanks
// marked in [brackets] for the things only the author knows.
//
// The markers are the model's own vocabulary, not ours: video references take
// fully_preserved | partially_preserved | attribute_transfer | weak_reference,
// audio references take fully_copy | partially_copy | reference |
// weak_reference. The defaults written here are the common intent — borrow the
// manner, not the content — and each line names the alternative, so the other
// choice is one edit away rather than a documentation hunt.
//
// Idempotent: a label already spoken for is left exactly as the user wrote it.

const PICTURE_RETENTION = (label) => (
  `${label}: fully_preserved — the same face, hair and wardrobe carry into the clip. `
  + `(weak_reference for a loose likeness instead.)`
);

const VIDEO_RETENTION = (label) => (
  `${label}: attribute_transfer — only its manner of movement carries: the same gesture style, `
  + `posture and facial expressiveness, performed by <Subject 1>. Its performer's appearance, clothing, `
  + `setting and framing do NOT carry. (fully_preserved to reproduce the movement itself.)`
);

// With no picture attached the clip is the only visual reference there is, so
// it carries the PERSON as well as the manner. MiniMax's own reference guide
// binds subjects to clips outright ("<Subject N> is the young man in <Video 2>,
// with short wavy brown hair …"), and the rental A/B that showed a clip taking
// over the shot is the same behaviour — wanted, this time.
const VIDEO_IDENTITY_RETENTION = (label) => (
  `${label}: fully_preserved — <Subject 1> IS the person in this clip: their face, hair, build and wardrobe `
  + `carry, and so does their manner of movement. Only the clip's setting and framing do NOT carry. `
  + `(attribute_transfer to borrow the movement alone.)`
);

const SOUNDTRACK_RETENTION = (label, videoLabel) => (
  `${label}: reference — the voice from ${videoLabel}'s own soundtrack: its timbre, accent and delivery. `
  + `The words spoken in it do NOT carry; <Subject 1> speaks the lines written below. `
  + `(fully_copy instead to reperform that clip's own words verbatim.)`
);

const VOICE_RETENTION = (label) => (
  `${label}: reference — only the voice carries: timbre, accent, pacing and emotion. Its original words do `
  + `NOT carry; <Subject 1> speaks the lines written below. (fully_copy instead to reperform its own words verbatim.)`
);

// Speech reaches the model only inside <d>…</d>, attributed to a speaker id.
const DIALOGUE_STUB = '(S1) <d>[English] Write the line you want spoken here — this is what the cloned voice says.</d>';

// The summary declares which of the two audio contracts is in force:
// [audio reference] means the source's own words must NOT appear;
// [audio reuse] means they are reperformed verbatim and kept in their language.
const AUDIO_SUMMARY_TAG = '[audio reference]';

// Any one of these means the author (or the prompt helper) is already working
// in the six-section format, so each piece is filed rather than the frame
// rewritten around them.
const SIX_SECTION_FORMAT = /^(summary|retention_analysis|detailed_description):[ \t]*$/m;

// H3's OTHER native format, and the one nearly everything in the studio writes
// when no reference is attached: three fields, each opened on its own line with
// its body running on after the colon. Every non-reference starter is in it,
// composeH3Prompt() emits it for the text and frame-anchored modes, and the
// prompt helper returns it.
//
// It was invisible here until 2026-08-23, and the cost was severe. Arming
// references over a three-field prompt sent it down the "no format at all"
// path, which files whatever is in the box as the SHOT — so the entire prompt,
// its own field headers included, was flattened onto one line inside
// detailed_description, its soundscape thrown away for the boilerplate one, and
// <Subject 1> left as an unfilled [write it out] blank. Liam armed his Hive
// Persona ID over the Korean home-video starter and got a stranger: the only
// description of a person in the prompt was the starter's "A Korean man in his
// early twenties", so that is who the model drew, while the voice — bound
// properly through <Audio 1> — was his.
//
// The two formats hold the same material, so this is a conversion and not a
// rewrite: the description, the soundscape and the music are the author's and
// carry across untouched; only the three sections a reference prompt adds
// (who the subjects are, what the shot is, what each reference may carry) are
// written here.
const FIELD_FORMAT_FIELDS = ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music'];

/**
 * Split a three-field prompt into `{ lead, integrated_multimodal_description,
 * overall_soundscape, non_diegetic_music }`, or null when it is not one.
 *
 * `lead` is anything written above the first field — composeH3Prompt() puts the
 * frame-alignment sentence there — so that converting can carry it rather than
 * drop text the author wrote.
 */
export function parseFieldPrompt(text) {
  const source = String(text || '');
  const pattern = new RegExp(`(?:^|\\n)[ \\t]*(${FIELD_FORMAT_FIELDS.join('|')})[ \\t]*:[ \\t]*`, 'g');
  const marks = [];
  let match = pattern.exec(source);
  while (match) {
    marks.push({ name: match[1], start: match.index, bodyAt: match.index + match[0].length });
    match = pattern.exec(source);
  }
  // The description field is the one that makes it this format; a bare
  // "overall_soundscape:" under a six-section prompt is not.
  if (!marks.some((mark) => mark.name === 'integrated_multimodal_description')) return null;
  const fields = { lead: source.slice(0, marks[0].start).trim() };
  marks.forEach((mark, index) => {
    const end = index + 1 < marks.length ? marks[index + 1].start : source.length;
    fields[mark.name] = source.slice(mark.bodyAt, end).trim();
  });
  return fields;
}

function insertIntoSection(prompt, sectionName, block) {
  const section = prompt.match(new RegExp(`^${sectionName}:[ \\t]*$`, 'm'));
  if (!section) return null;
  const at = prompt.indexOf(section[0]) + section[0].length;
  return `${prompt.slice(0, at)}\n${block}${prompt.slice(at)}`;
}

// retention_analysis, in the order the model presents the references: pictures,
// then each clip's soundtrack immediately before the clip itself, then the
// voice clips. A label the author has already spoken for is left alone.
function retentionLines(labels, existing) {
  // "Spoken for" means a retention line of its own — the label at the start of
  // a line, followed by its colon. Anywhere-in-text was too loose: the subject
  // sentence "…shown in <Picture 1> through <Picture 3>: [hair…" reads as a
  // claim on <Picture 3> and left the last picture with no contract at all.
  const unclaimed = (label) => !new RegExp(`^${label.replace(/[<>]/g, '\\$&')}:`, 'm').test(existing);
  const lines = [];
  labels.images.forEach((label) => { if (unclaimed(label)) lines.push(PICTURE_RETENTION(label)); });
  // No picture → the first MOTION clip is the character reference; any further
  // clip stays a motion reference. A sound-only row is a voice clip: it gets
  // the voice contract and no video line at all.
  const identityVideo = labels.images.length ? null : (labels.videos.find((label) => label.video)?.video || null);
  labels.videos.forEach((label) => {
    if (label.soundOnly) {
      if (label.audio && unclaimed(label.audio)) lines.push(VOICE_RETENTION(label.audio));
      return;
    }
    if (label.audio && unclaimed(label.audio)) lines.push(SOUNDTRACK_RETENTION(label.audio, label.video));
    if (unclaimed(label.video)) {
      lines.push(label.video === identityVideo ? VIDEO_IDENTITY_RETENTION(label.video) : VIDEO_RETENTION(label.video));
    }
  });
  labels.audios.forEach((label) => { if (unclaimed(label)) lines.push(VOICE_RETENTION(label)); });
  return lines;
}

// The whole frame, for a composer that has none. Everything only the author can
// know is left as a [bracketed] blank rather than invented — but the structure,
// the labels and the two instructions that are easy to omit and expensive to
// miss (who <Subject 1> is, and that nothing else is spoken in the clip) are
// written out.
/**
 * Who <Subject 1> is, from the pictures attached and the persona's gender:
 * "<Subject 1> is the woman shown in <Picture 1> through <Picture 3>: [hair,
 * face, build, wardrobe — write it out …]". The frame below and the UGC brief
 * both open with it, so the model hears the same introduction either way.
 * "the woman" / "the man" when the loaded persona says so; "the person"
 * otherwise — a noun here is what stops the model inventing one.
 * With no picture but a clip, the clip IS the character reference: "<Subject 1>
 * is the man shown in <Video 1>: [hair, face …]" — the form MiniMax's own guide
 * uses for a subject that comes from a video.
 */
export function referenceSubjectLine({ pictures = [], videos = [], gender = '' } = {}) {
  const which = normalizePersonaGender(gender);
  const noun = which && which !== 'nonbinary' ? personaGenderWords(which).noun : 'person';
  if (pictures.length) {
    const range = pictures.length > 1 ? `${pictures[0]} through ${pictures[pictures.length - 1]}` : pictures[0];
    return `<Subject 1> is the ${noun} shown in ${range}: [hair, face, build, wardrobe — write it out. Identity holds from these words as much as from the pictures].`;
  }
  if (videos.length) {
    return `<Subject 1> is the ${noun} shown in ${videos[0]}: [hair, face, build, wardrobe — write it out. Identity holds from these words as much as from the clip].`;
  }
  return `<Subject 1> is ${which && which !== 'nonbinary' ? `a ${noun}: ` : ''}[hair, face, build, wardrobe — write it out].`;
}

/** The first voice the model will hear for <Subject 1>: a clip's soundtrack, else a voice clip. */
export function referenceVoiceLabel(labels) {
  // In the order the model numbers them: clip soundtracks, then the explicit
  // voice clips, then sound-only rows (which ride after the explicit clips).
  const voices = [
    ...(labels?.videos || []).filter((label) => label.audio && !label.soundOnly).map((label) => label.audio),
    ...(labels?.audios || []),
    ...(labels?.videos || []).filter((label) => label.soundOnly && label.audio).map((label) => label.audio),
  ];
  return voices[0] || '';
}

const DESCRIPTION_PLACEHOLDER = 'Medium shot of <Subject 1> against [setting], in [lighting]. '
  + '<Subject 1> looks into the lens to speak, then holds a beat of stillness.';

function describedShot(prose) {
  if (!prose) return `[Shot 1] ${DESCRIPTION_PLACEHOLDER}`;
  return /\[Shot\s+\d+\]/.test(prose) ? prose : `[Shot 1] ${prose}`;
}

function referenceFrame(written, labels, gender = '') {
  const voice = referenceVoiceLabel(labels);
  const motion = labels.videos.map((label) => label.video).filter(Boolean);
  const pictures = labels.images;
  // A three-field prompt is CONVERTED field by field. Anything else is loose
  // text, and loose text is the shot.
  const fields = parseFieldPrompt(written);
  const source = fields
    ? [fields.lead, fields.integrated_multimodal_description].filter(Boolean).join('\n\n')
    : String(written || '');
  const lines = source ? source.split('\n') : [];
  const spoken = lines.filter((line) => line.includes('<d>'));
  // Joined on newlines, not spaces: a description written as several shots is
  // several lines, and folding it into one paragraph loses the shape H3 reads
  // the timeline from.
  const prose = lines.filter((line) => !line.includes('<d>')).join('\n').trim();

  const subject = [referenceSubjectLine({ pictures, videos: motion, gender })];
  // Binding the voice to the subject AND to the speaker id is what keeps a
  // cloned voice attached to the person on screen.
  if (voice) subject.push(`${voice} is the voice-timbre reference for <Subject 1> (S1).`);

  // No picture → the first clip is who <Subject 1> is, not just how they move.
  const identityVideo = pictures.length ? null : (motion[0] || null);
  const manner = identityVideo ? motion.slice(1) : motion;
  const clauses = [`A medium shot of <Subject 1>${voice ? ' speaking one line straight to camera' : ''}`];
  if (voice) clauses.push(`in the voice of ${voice}`);
  if (identityVideo) clauses.push(`carrying the look and manner of ${identityVideo}`);
  if (manner.length) clauses.push(`gesturing in the manner of ${manner.join(' and ')}`);

  return [
    'subject_definitions:',
    ...subject,
    '',
    'summary:',
    `${voice ? `${AUDIO_SUMMARY_TAG} ` : ''}${clauses.join(', ')}.`,
    '',
    'retention_analysis:',
    ...retentionLines(labels, ''),
    '',
    'detailed_description:',
    // Whatever was already in the box is the shot — it is what the author was
    // describing — rather than being discarded or left dangling above the frame.
    // Except a line they had already written: speech belongs on its own line
    // under the shot, and folding it into the shot text would both bury it and
    // earn them a second, placeholder line underneath.
    //
    // "[Shot 1]" only when the description does not already carry its own shot
    // headers. Adding one in front of a timeline that opens with [Shot 1] gave
    // the prompt two of them and made the first cut unreadable.
    describedShot(prose),
    ...(spoken.length ? spoken : (voice ? [DIALOGUE_STUB] : [])),
    '',
    'overall_soundscape:',
    // The author's own soundscape is the more specific instruction, so it
    // carries. The boilerplate below is for a composer that had none — and the
    // voice sentence in it is the one that prevented four seconds of invented
    // speech, so it is kept for exactly that case.
    fields?.overall_soundscape || (voice
      ? "A quiet interior. Only <Subject 1>'s voice, close and dry, over faint room tone. No other speakers, no music, and no speech before or after the line above."
      : 'A quiet interior with faint room tone. No speech and no music.'),
    '',
    'non_diegetic_music:',
    fields?.non_diegetic_music || 'none',
  ].join('\n');
}

export function withReferenceTags(prompt, { images = [], videos = [], audios = [], gender = '' } = {}) {
  let out = String(prompt || '');
  const labels = referenceLabels({ images, videos, audios });

  if (!SIX_SECTION_FORMAT.test(out)) return referenceFrame(out.trim(), labels, normalizePersonaGender(gender));

  const retention = retentionLines(labels, out);
  const hasAudio = labels.audios.length > 0 || labels.videos.some((label) => label.audio);

  // The ?? branches below cover a PARTLY sectioned prompt — one that has, say,
  // a detailed_description but no retention_analysis. A prompt with no sections
  // at all never reaches here; it gets the whole frame instead.
  if (retention.length) {
    const block = retention.join('\n');
    out = insertIntoSection(out, 'retention_analysis', block)
      ?? `${out.replace(/\s+$/, '')}\n\n${block}`;
  }

  // A cloned voice with nothing to say is the other half of the problem.
  if (hasAudio && !out.includes('<d>')) {
    out = insertIntoSection(out, 'detailed_description', DIALOGUE_STUB)
      ?? `${out.replace(/\s+$/, '')}\n\n${DIALOGUE_STUB}`;
  }

  // The audio contract has to be declared somewhere the model will read it —
  // whether the source clip's own words should come back or not.
  if (hasAudio && !/\[audio (reuse|reference)\]/.test(out)) {
    out = insertIntoSection(out, 'summary', AUDIO_SUMMARY_TAG)
      ?? `${out.replace(/\s+$/, '')}\n${AUDIO_SUMMARY_TAG} — the cloned voice speaks the line above, not the words from the source clip.`;
  }

  return out;
}

// Kept for callers that only ever had motion clips.
export const withMotionRetentionTags = (prompt, videos = []) => withReferenceTags(prompt, { videos });

// A reference video will TAKE OVER the shot if the prompt lets it. Measured on
// the rental: the same clip under the same attribute_transfer tag kept our
// character when the prompt described her AND said what must not carry from the
// video — and replaced her with the reference performer (her headwrap, her wall)
// when it did neither. The retention tag biases; only words bind. So the panel
// says so before the run, not after.
//
// With NO picture attached the take-over is the point: the clip is the only
// visual reference, so its performer IS the subject and nothing need be
// excluded — the exclusion nag is for the picture+clip case only.
const EXCLUSION_HINT = /\b(do not carry|does not carry|don'?t carry|not carry|must not|do NOT|never carry|no[t]? .{0,24}(appearance|clothing|wardrobe|setting|background))\b/i;

export function motionReferenceWarning({ prompt = '', videos: rows = [], images = [] } = {}) {
  // Sound-only rows carry no <Video N>: only the motion rows are named.
  const videos = motionReferenceRows(rows);
  if (!videos.length) return null;
  const text = String(prompt || '');
  const unnamed = videos
    .map((_, index) => index + 1)
    .filter((ordinal) => !text.includes(`<Video ${ordinal}>`));
  if (unnamed.length) {
    return {
      kind: 'unnamed',
      labels: unnamed.map((ordinal) => `<Video ${ordinal}>`),
    };
  }
  if (!images.length) return null;
  if (!EXCLUSION_HINT.test(text)) return { kind: 'no-exclusion', labels: [] };
  return null;
}

// Roughly how long the written dialogue takes to say. Short punchy lines run
// near 3 words a second; this is an ESTIMATE and the warning below says so
// rather than printing it as a measurement.
export const WORDS_PER_SECOND = 3;

export function spokenSecondsIn(prompt) {
  const spoken = String(prompt || '').match(/<d>[\s\S]*?<\/d>/g) || [];
  const words = spoken
    .map((line) => line.replace(/<\/?d>/g, '').replace(/^\s*\[[^\]]*\]\s*/, ''))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return words / WORDS_PER_SECOND;
}

// Time the clip has to fill that the prompt does not account for.
//
// Measured the hard way (2026-08-11): eight seconds, one ~11-word line and no
// shot or soundscape around it, and the model spent the first four seconds on
// invented speech before reaching the written words. A voice reference makes
// the model want to talk; silence has to be asked for, or the span shortened.
//
// Only fires when something is expected to SPEAK — a clip with no voice
// reference is free to be as wordless as it likes — and only while the prompt
// has not already handled it. Saying nobody else speaks IS the fix, so a prompt
// that says it (the scaffold writes exactly that) is not warned about again.
const SILENCE_HINT = /\bno(?:body| one)? (?:other )?(?:else )?(?:speech|speaks|speakers|dialogue|talking|voices|words)\b|\bin silence\b|\bsilent\b/i;

// A gap this big is what the failure looked like: eight seconds, four spoken
// for. Half that is an ordinary pause, so it is not worth a line of chrome.
const UNSCRIPTED_SECONDS = 3;

export function unscriptedTimeWarning({ prompt = '', durationSeconds = 0, videos = [], audios = [] } = {}) {
  const hasVoice = audios.length > 0 || videos.some((item) => item?.useAudio);
  const text = String(prompt || '');
  if (!hasVoice || !text.trim()) return null;
  const duration = Number(durationSeconds) || 0;
  if (!/<d>/.test(text)) return { kind: 'no-line', spoken: 0, duration };
  if (!duration || SILENCE_HINT.test(text)) return null;
  const spoken = spokenSecondsIn(text);
  const gap = duration - spoken;
  if (gap < UNSCRIPTED_SECONDS) return null;
  const round = (value) => Math.round(value * 10) / 10;
  return { kind: 'unscripted', spoken: round(spoken), duration, gap: round(gap) };
}

// ── Sound-only motion rows ───────────────────────────────────────────────────
// A clip attached as a motion reference can be switched to SOUND ONLY: its
// soundtrack is then a voice reference and its pixels are never sent — the
// request carries it in reference_audios (after the explicit voice clips), the
// MCP extracts the audio track, and the model sees a plain <Audio N>. It is
// not a motion clip any more: no <Video N>, no video slot, no duration cap.
// `motion: false` marks the row; an older row without the flag is motion.
export function isSoundOnlyReference(item) {
  return Boolean(item && typeof item === 'object' && item.motion === false);
}

export function motionReferenceRows(videos = []) {
  return (videos || []).filter((item) => item && !isSoundOnlyReference(item));
}

export function soundOnlyReferenceRows(videos = []) {
  return (videos || []).filter((item) => isSoundOnlyReference(item));
}

// The references exactly as the request (and so the model) sees them: motion
// rows as videos, sound-only rows as voice clips after the explicit ones.
export function referencesAsSent({ images = [], videos = [], audios = [] } = {}) {
  return {
    images,
    videos: motionReferenceRows(videos),
    audios: [...audios, ...soundOnlyReferenceRows(videos).map((item) => ({ ...item, fromVideo: true }))],
  };
}

// Labels aligned with the rows as ATTACHED (labels.videos[i] is the i-th row
// of the motion section, sound-only rows included), numbered the way the node
// presents them: pictures; each motion clip's soundtrack <Audio k> just before
// its <Video m>; then the standalone clips — the explicit voice clips first,
// then the sound-only rows — all sharing one <Audio> counter. A sound-only row
// labels as { video: '', audio: '<Audio k>', soundOnly: true }.
export function referenceLabels({ images = [], videos = [], audios = [] } = {}) {
  const labels = { images: [], videos: [], audios: [] };
  images.forEach((_, index) => labels.images.push(`<Picture ${index + 1}>`));
  let audioOrdinal = 0;
  let videoOrdinal = 0;
  videos.forEach((item) => {
    if (isSoundOnlyReference(item)) {
      labels.videos.push({ video: '', audio: '', soundOnly: true });
      return;
    }
    labels.videos.push({
      video: `<Video ${(videoOrdinal += 1)}>`,
      audio: item?.useAudio ? `<Audio ${(audioOrdinal += 1)}>` : '',
    });
  });
  audios.forEach(() => labels.audios.push(`<Audio ${(audioOrdinal += 1)}>`));
  labels.videos.forEach((label) => {
    if (label.soundOnly) label.audio = `<Audio ${(audioOrdinal += 1)}>`;
  });
  return labels;
}

// ── The reference budget ─────────────────────────────────────────────────────
//
// H3 rations references four different ways at once, and only one of them
// (how many of each kind) was ever visible here. The other three are the ones
// that actually bite, because nothing in the UI counted them:
//
//   1. TWELVE references total, across every kind. Nine pictures and three
//      clips is exactly twelve; switch a clip's soundtrack on and you are at
//      thirteen, because a split soundtrack is its own reference.
//   2. THREE audio clips — and a split soundtrack is one of them. Three videos
//      with sound on therefore spend the entire audio allowance before a single
//      voice clip is attached.
//   3. Each clip runs 2–15 seconds.
//   4. Fifteen seconds is the TOTAL for a kind, not a per-clip allowance. This
//      is the one people miss: three 15-second clips is 45 seconds and three
//      times over, so three clips only fit at about five seconds each.
//
// And a split soundtrack spends from BOTH duration totals at once — a
// 12-second video with its audio on uses 12 of the 15 video seconds AND 12 of
// the 15 audio seconds, leaving 3 seconds of audio for everything else.
//
// Sourced from the Fantastic MiniMax H3 Prompt Builder's documented limits
// (MIT, Adudeguyman) — the rules are the donation; the implementation is ours.
//
// Advisory ONLY, deliberately. Nothing here removes a reference for you:
// dropping one renumbers every label after it, which would silently invalidate
// <Picture N>/<Video N>/<Audio N> tags already written into the prompt. The
// fix is a trim, which Clip Prep does without spending a slot.
export const H3_REFERENCE_LIMITS = {
  totalReferences: 12,
  audioClips: 3,
  clipSecondsMin: 2,
  clipSecondsMax: 15,
  typeSecondsTotal: 15,
};

const round1 = (value) => Math.round((Number(value) || 0) * 10) / 10;

// `durations` maps a reference url to its measured length in seconds. Anything
// missing is simply not counted — a budget that guessed would be worse than one
// that admits it has not measured yet, so `measured` reports the coverage.
export function referenceBudgetReport({
  images = [], videos = [], audios = [], durations = {},
} = {}) {
  const lengthOf = (item) => {
    const value = Number(durations[referenceUrl(item)]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  // A sound-only row is a voice clip, not a motion clip: it spends an audio
  // slot and audio seconds, and nothing on the video side.
  const motionRows = motionReferenceRows(videos);
  const soundOnlyRows = soundOnlyReferenceRows(videos);
  const soundtracks = motionRows.filter((item) => item?.useAudio).length + soundOnlyRows.length;
  // A soundtrack is its own reference and its own audio clip, which is the
  // whole reason a "9 pictures + 3 videos" row can be over budget.
  const total = images.length + motionRows.length + audios.length + soundtracks;
  const audioClips = audios.length + soundtracks;

  let videoSeconds = 0;
  let audioSeconds = 0;
  let measured = 0;
  let unmeasured = 0;
  const clips = [];

  for (const item of motionRows) {
    const seconds = lengthOf(item);
    if (seconds == null) { unmeasured += 1; } else {
      measured += 1;
      videoSeconds += seconds;
      // Double-spend: the same seconds are billed to the audio total too.
      if (item?.useAudio) audioSeconds += seconds;
      clips.push({ kind: 'videos', url: referenceUrl(item), seconds: round1(seconds) });
    }
  }
  for (const item of soundOnlyRows) {
    const seconds = lengthOf(item);
    if (seconds == null) { unmeasured += 1; } else {
      measured += 1;
      audioSeconds += seconds;
      clips.push({ kind: 'audios', url: referenceUrl(item), seconds: round1(seconds) });
    }
  }
  for (const item of audios) {
    const seconds = lengthOf(item);
    if (seconds == null) { unmeasured += 1; } else {
      measured += 1;
      audioSeconds += seconds;
      clips.push({ kind: 'audios', url: referenceUrl(item), seconds: round1(seconds) });
    }
  }

  const problems = [];
  if (total > H3_REFERENCE_LIMITS.totalReferences) {
    problems.push({ code: 'over-total', count: total, limit: H3_REFERENCE_LIMITS.totalReferences, soundtracks });
  }
  if (audioClips > H3_REFERENCE_LIMITS.audioClips) {
    problems.push({ code: 'over-audio-clips', count: audioClips, limit: H3_REFERENCE_LIMITS.audioClips, soundtracks });
  }
  // Audio is never the only thing attached — it has nothing to attach TO.
  if (audioClips > 0 && images.length === 0 && motionRows.length === 0) {
    problems.push({ code: 'audio-without-visual', count: audioClips });
  }
  for (const clip of clips) {
    if (clip.seconds < H3_REFERENCE_LIMITS.clipSecondsMin) {
      problems.push({ code: 'clip-too-short', ...clip, limit: H3_REFERENCE_LIMITS.clipSecondsMin });
    } else if (clip.seconds > H3_REFERENCE_LIMITS.clipSecondsMax) {
      problems.push({ code: 'clip-too-long', ...clip, limit: H3_REFERENCE_LIMITS.clipSecondsMax });
    }
  }
  if (round1(videoSeconds) > H3_REFERENCE_LIMITS.typeSecondsTotal) {
    problems.push({ code: 'over-video-seconds', seconds: round1(videoSeconds), limit: H3_REFERENCE_LIMITS.typeSecondsTotal });
  }
  if (round1(audioSeconds) > H3_REFERENCE_LIMITS.typeSecondsTotal) {
    problems.push({
      code: 'over-audio-seconds',
      seconds: round1(audioSeconds),
      limit: H3_REFERENCE_LIMITS.typeSecondsTotal,
      // Naming the double-spend is the difference between "trim the voice clip"
      // and the actual fix, which is often "switch a soundtrack off".
      soundtracks,
    });
  }

  return {
    counts: {
      total,
      limit: H3_REFERENCE_LIMITS.totalReferences,
      pictures: images.length,
      videos: motionRows.length,
      audioClips,
      soundtracks,
    },
    seconds: {
      video: round1(videoSeconds),
      audio: round1(audioSeconds),
      limit: H3_REFERENCE_LIMITS.typeSecondsTotal,
    },
    measured,
    unmeasured,
    problems,
    ok: problems.length === 0,
  };
}
