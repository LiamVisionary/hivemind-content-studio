// Lossless client-side clip join — packet-copy concat of same-codec MP4s (the
// browser-side equivalent of ffmpeg's concat demuxer with `-c copy`). Runs
// entirely in the browser via mediabunny, which matters here: chained shots are
// E2E-sealed at rest and the server cannot read them by design, so the ONLY
// place a chain can be joined is the client, where the vault key lives. No
// re-encode: video and audio packets are copied with offset timestamps, so the
// join is bit-identical to the source frames.
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';

async function openClip(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error('a clip has no video track');
  const audio = await input.getPrimaryAudioTrack();
  return {
    input,
    video,
    audio,
    // The VIDEO track defines each segment's length — that is where the cut
    // is. AAC always runs slightly longer (encoder padding); it gets trimmed.
    duration: await input.computeDuration([video]),
    videoConfig: await video.getDecoderConfig(),
    audioConfig: audio ? await audio.getDecoderConfig() : null,
  };
}

async function copyPacketsWithOffset(track, source, offsetSeconds, isFirstClip, decoderConfig, maxDuration = Infinity) {
  const sink = new EncodedPacketSink(track);
  let first = isFirstClip;
  let base = null;
  for await (const packet of sink.packets()) {
    // Rebase each track so its first packet lands exactly at the segment
    // offset. AAC encoder-delay tracks start slightly NEGATIVE (edit-list
    // semantics a flat concat cannot carry); rebasing shifts that track
    // uniformly by one ~23ms frame — far below lip-sync perception — and
    // keeps every timestamp non-negative and monotonic.
    if (base === null) base = packet.timestamp;
    const local = packet.timestamp - base;
    // Trim trailing encoder padding past the segment's video duration —
    // the same cut an edit list would encode; without it the padding of
    // clip N collides with the first packet of clip N+1.
    if (local >= maxDuration) continue;
    await source.add(
      packet.clone({ timestamp: local + offsetSeconds }),
      first ? { decoderConfig } : undefined,
    );
    first = false;
  }
}

// blobs: ordered decrypted clips. Returns a Blob of the joined MP4.
// Throws with a human message when the clips cannot be joined losslessly
// (different codec or resolution — chained shots from one workflow never are).
export async function joinClips(blobs, { onProgress } = {}) {
  if (!Array.isArray(blobs) || blobs.length < 2) throw new Error('joining needs at least two clips');
  const clips = [];
  for (const blob of blobs) clips.push(await openClip(blob));

  const head = clips[0];
  for (const [index, clip] of clips.entries()) {
    if (clip.video.codec !== head.video.codec) {
      throw new Error(`clip ${index + 1} uses a different video codec (${clip.video.codec} vs ${head.video.codec}) — cannot join losslessly`);
    }
    if (clip.videoConfig?.codedWidth !== head.videoConfig?.codedWidth
      || clip.videoConfig?.codedHeight !== head.videoConfig?.codedHeight) {
      throw new Error(`clip ${index + 1} has a different resolution — cannot join losslessly`);
    }
  }
  // Audio joins only when EVERY clip has a matching audio track; a silent clip
  // anywhere means a video-only join rather than drifting audio.
  const joinAudio = clips.every((clip) => clip.audio && clip.audio.codec === head.audio?.codec);

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const videoSource = new EncodedVideoPacketSource(head.video.codec);
  output.addVideoTrack(videoSource);
  const audioSource = joinAudio ? new EncodedAudioPacketSource(head.audio.codec) : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();

  let offset = 0;
  for (const [index, clip] of clips.entries()) {
    onProgress?.(index, clips.length);
    await copyPacketsWithOffset(clip.video, videoSource, offset, index === 0, head.videoConfig);
    if (audioSource) {
      await copyPacketsWithOffset(clip.audio, audioSource, offset, index === 0, head.audioConfig, clip.duration);
    }
    offset += clip.duration;
  }
  await output.finalize();
  return {
    blob: new Blob([target.buffer], { type: 'video/mp4' }),
    seconds: offset,
    audioJoined: joinAudio,
  };
}
