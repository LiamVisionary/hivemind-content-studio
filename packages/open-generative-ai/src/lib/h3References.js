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

// The source behind an attached reference. Pictures are stored as a bare url;
// clips carry a name (and, for video, its soundtrack switch) alongside it.
export function referenceUrl(item) {
  return (typeof item === 'string' ? item : item?.url) || '';
}

// Two rows of the SAME source are never what someone means. Nothing about a
// reference varies per slot: the item holds only its url, its filename and (for
// video) whether its soundtrack is on — and that switch belongs to the one row,
// which is why a clip with sound already claims an <Audio N> of its own without
// being attached twice. The retention marker does vary per label, but it lives
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
  const unclaimed = (label) => !existing.includes(`${label}:`);
  const lines = [];
  labels.images.forEach((label) => { if (unclaimed(label)) lines.push(PICTURE_RETENTION(label)); });
  labels.videos.forEach((label) => {
    if (label.audio && unclaimed(label.audio)) lines.push(SOUNDTRACK_RETENTION(label.audio, label.video));
    if (unclaimed(label.video)) lines.push(VIDEO_RETENTION(label.video));
  });
  labels.audios.forEach((label) => { if (unclaimed(label)) lines.push(VOICE_RETENTION(label)); });
  return lines;
}

// The whole frame, for a composer that has none. Everything only the author can
// know is left as a [bracketed] blank rather than invented — but the structure,
// the labels and the two instructions that are easy to omit and expensive to
// miss (who <Subject 1> is, and that nothing else is spoken in the clip) are
// written out.
function referenceFrame(written, labels) {
  const voices = [
    ...labels.videos.filter((label) => label.audio).map((label) => label.audio),
    ...labels.audios,
  ];
  const voice = voices[0] || '';
  const motion = labels.videos.map((label) => label.video);
  const pictures = labels.images;
  const lines = written ? written.split('\n') : [];
  const spoken = lines.filter((line) => line.includes('<d>'));
  const prose = lines.filter((line) => !line.includes('<d>')).join(' ').trim();

  const subject = [pictures.length
    ? `<Subject 1> is the person shown in ${pictures.length > 1 ? `${pictures[0]} through ${pictures[pictures.length - 1]}` : pictures[0]}: [hair, face, build, wardrobe — write it out. Identity holds from these words as much as from the pictures].`
    : '<Subject 1> is [hair, face, build, wardrobe — write it out].'];
  // Binding the voice to the subject AND to the speaker id is what keeps a
  // cloned voice attached to the person on screen.
  if (voice) subject.push(`${voice} is the voice-timbre reference for <Subject 1> (S1).`);

  const clauses = [`A medium shot of <Subject 1>${voice ? ' speaking one line straight to camera' : ''}`];
  if (voice) clauses.push(`in the voice of ${voice}`);
  if (motion.length) clauses.push(`gesturing in the manner of ${motion.join(' and ')}`);

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
    `[Shot 1] ${prose || 'Medium shot of <Subject 1> against [setting], in [lighting]. <Subject 1> looks into the lens to speak, then holds a beat of stillness.'}`,
    ...(spoken.length ? spoken : (voice ? [DIALOGUE_STUB] : [])),
    '',
    'overall_soundscape:',
    voice
      // The sentence that would have prevented four seconds of invented speech.
      ? "A quiet interior. Only <Subject 1>'s voice, close and dry, over faint room tone. No other speakers, no music, and no speech before or after the line above."
      : 'A quiet interior with faint room tone. No speech and no music.',
    '',
    'non_diegetic_music:',
    'none',
  ].join('\n');
}

export function withReferenceTags(prompt, { images = [], videos = [], audios = [] } = {}) {
  let out = String(prompt || '');
  const labels = referenceLabels({ images, videos, audios });

  if (!SIX_SECTION_FORMAT.test(out)) return referenceFrame(out.trim(), labels);

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
const EXCLUSION_HINT = /\b(do not carry|does not carry|don'?t carry|not carry|must not|do NOT|never carry|no[t]? .{0,24}(appearance|clothing|wardrobe|setting|background))\b/i;

export function motionReferenceWarning({ prompt = '', videos = [] } = {}) {
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

export function referenceLabels({ images = [], videos = [], audios = [] } = {}) {
  const labels = { images: [], videos: [], audios: [] };
  images.forEach((_, index) => labels.images.push(`<Picture ${index + 1}>`));
  let audioOrdinal = 0;
  videos.forEach((item, index) => {
    labels.videos.push({
      video: `<Video ${index + 1}>`,
      audio: item?.useAudio ? `<Audio ${(audioOrdinal += 1)}>` : '',
    });
  });
  audios.forEach(() => labels.audios.push(`<Audio ${(audioOrdinal += 1)}>`));
  return labels;
}
