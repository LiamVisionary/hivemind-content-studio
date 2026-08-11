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

// One click writes the retention line the shot actually needs. It names the
// label AND states the exclusion, because a motion clip that is merely tagged
// still hands its performer's face and setting to the shot. Idempotent, and it
// lands inside retention_analysis when the six-section format is in use.
export function withMotionRetentionTags(prompt, videos = []) {
  const existing = String(prompt || '');
  const lines = videos
    .map((_, index) => index + 1)
    .filter((ordinal) => !existing.includes(`<Video ${ordinal}>:`))
    .map((ordinal) => (
      `<Video ${ordinal}>: attribute_transfer — only its manner of movement carries: the same gesture style, `
      + `posture and facial expressiveness, performed by <Subject 1>. Its performer's appearance, clothing, `
      + `setting and framing do NOT carry.`
    ));
  if (!lines.length) return existing;
  const block = lines.join('\n');
  const section = existing.match(/^retention_analysis:[ \t]*$/m);
  if (section) {
    const at = existing.indexOf(section[0]) + section[0].length;
    return `${existing.slice(0, at)}\n${block}${existing.slice(at)}`;
  }
  return existing.trim() ? `${existing.replace(/\s+$/, '')}\n\n${block}` : block;
}

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
