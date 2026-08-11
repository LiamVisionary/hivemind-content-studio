// MiniMax H3 Reference mode: what the model will CALL each attached reference.
//
// The numbering is not one counter per argument list. MiniMaxH3ReferenceToVideo
// presents references in a fixed order — pictures, then each video, then the
// standalone audio — and a reference video whose own soundtrack is switched on
// emits an <Audio N> label immediately BEFORE its <Video N>. So a video with
// sound plus one voice clip numbers <Audio 1> (the soundtrack), <Video 1>,
// <Audio 2> (the voice clip). A prompt written from a naive count addresses the
// wrong reference, which is why the composer shows these labels on each row.
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
