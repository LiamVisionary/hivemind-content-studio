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
// The markers are the model's own vocabulary, not ours: video references take
// fully_preserved | partially_preserved | attribute_transfer | weak_reference,
// audio references take fully_copy | partially_copy | reference |
// weak_reference. The defaults written here are the common intent — borrow the
// manner, not the content — and each line names the alternative, so the other
// choice is one edit away rather than a documentation hunt.
//
// Idempotent: a label already spoken for is left exactly as the user wrote it.

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

function insertIntoSection(prompt, sectionName, block) {
  const section = prompt.match(new RegExp(`^${sectionName}:[ \\t]*$`, 'm'));
  if (!section) return null;
  const at = prompt.indexOf(section[0]) + section[0].length;
  return `${prompt.slice(0, at)}\n${block}${prompt.slice(at)}`;
}

export function withReferenceTags(prompt, { videos = [], audios = [] } = {}) {
  let out = String(prompt || '');
  const labels = referenceLabels({ videos, audios });

  // retention_analysis, in the order the model presents the references: each
  // clip's soundtrack immediately before the clip itself, then the voice clips.
  const retention = [];
  labels.videos.forEach((label) => {
    if (label.audio && !out.includes(`${label.audio}:`)) {
      retention.push(SOUNDTRACK_RETENTION(label.audio, label.video));
    }
    if (!out.includes(`${label.video}:`)) retention.push(VIDEO_RETENTION(label.video));
  });
  labels.audios.forEach((label) => {
    if (!out.includes(`${label}:`)) retention.push(VOICE_RETENTION(label));
  });

  const hasAudio = labels.audios.length > 0 || labels.videos.some((label) => label.audio);

  if (retention.length) {
    const block = retention.join('\n');
    out = insertIntoSection(out, 'retention_analysis', block)
      ?? (out.trim() ? `${out.replace(/\s+$/, '')}\n\n${block}` : block);
  }

  // A cloned voice with nothing to say is the other half of the problem.
  if (hasAudio && !out.includes('<d>')) {
    out = insertIntoSection(out, 'detailed_description', DIALOGUE_STUB)
      ?? `${out.replace(/\s+$/, '')}\n\n${DIALOGUE_STUB}`;
  }

  // The audio contract has to be declared somewhere the model will read it.
  // In the six-section format that is the summary; in a freeform prompt there
  // is no summary to put it in, and dropping it silently left the clip with a
  // cloned voice and no statement of whether its own words should come back.
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
