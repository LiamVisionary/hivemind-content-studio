// Clip prep — the mediabunny half: probe, transform, grab a frame.
//
// Everything here decodes real pixels, so it carries mediabunny and must only
// ever be imported DYNAMICALLY from UI code (see clipPrepPlan.js for why). The
// numbers it acts on come from planClip() in that module, so the readout a user
// sees and the encode that runs can never disagree.
//
// Why this runs in the browser at all: source clips are owner-sealed at rest
// and the server holds no key, so the only place a clip can be decoded is where
// the vault key lives. Same constraint that put the chained-shot join in
// clipJoiner.js rather than in the gateway.
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';

// Imported, not re-exported: a caller that only needs the planner should reach
// for clipPrepPlan.js directly rather than pulling mediabunny in behind it.
// (`export ... from` would not bind these locally here in any case.)
import { clampCrop, even, planClip } from './clipPrepPlan.js';

async function openSource(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error('that file has no video track');
  return { input, video };
}

// Everything the planner needs to know about a source clip. Every Input holds
// an open handle on the blob, so each one is disposed on the way out — probing
// runs on every file the picker touches, and leaking one per probe is how a
// long session ends up pinning every clip the user browsed past.
export async function probeClip(blob) {
  const { input, video } = await openSource(blob);
  try {
    const audio = await input.getPrimaryAudioTrack();
    // Sampling 100 packets is enough to separate 24 from 60; measuring the
    // whole file would read every packet of a clip we may not even use.
    const stats = await video.computePacketStats(100).catch(() => null);
    return {
      duration: await input.computeDuration(),
      width: video.displayWidth || video.codedWidth,
      height: video.displayHeight || video.codedHeight,
      codec: video.codec,
      frameRate: stats?.averagePacketRate || 0,
      hasAudio: Boolean(audio),
      audioCodec: audio?.codec || null,
    };
  } finally {
    input.dispose();
  }
}

// Execute a plan. Returns the prepared MP4 plus the numbers it actually landed
// on — the caller shows those, rather than the requested ones, because a source
// smaller than the preset is left alone.
export async function prepareClip(blob, spec = {}, { onProgress } = {}) {
  const source = await probeClip(blob);
  const plan = planClip(source, spec);

  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });

  const video = {};
  if (plan.cropped) video.crop = plan.crop;
  if (plan.scaled) { video.width = plan.width; video.height = plan.height; video.fit = 'fill'; }
  if (plan.frameRate) video.frameRate = plan.frameRate;

  try {
    const conversion = await Conversion.init({
      input,
      output,
      video,
      audio: plan.dropAudio ? { discard: true } : undefined,
      trim: { start: plan.trim.start, end: plan.trim.end },
    });
    // Must be assigned BEFORE execute() or no progress is computed at all.
    if (onProgress) conversion.onProgress = (progress) => onProgress(progress);
    await conversion.execute();
  } finally {
    input.dispose();
  }

  return {
    blob: new Blob([target.buffer], { type: 'video/mp4' }),
    plan,
    source,
    seconds: plan.trim.seconds,
    width: plan.width,
    height: plan.height,
  };
}

// A single frame, for the start-image slot or a storyboard tile. Decoded through
// CanvasSink so the frame is the DISPLAYED image — rotation metadata applied,
// which a raw packet copy would leave for the consumer to guess at.
export async function grabFrame(blob, timeSeconds, { width = null, height = null, crop = null } = {}) {
  const { input, video } = await openSource(blob);
  const source = {
    width: video.displayWidth || video.codedWidth,
    height: video.displayHeight || video.codedHeight,
  };
  const box = clampCrop(crop, source);

  // When the caller pins BOTH edges it is handing us a plan's raster, and the
  // frame must land on exactly that. Deriving the height from the width instead
  // re-runs the ratio through a second even-rounding and lands up to 2px off —
  // which is how a start frame ends up not matching the reference clip it was
  // cut from, for no reason a user could ever see or fix.
  const scale = width && !height ? Math.min(1, width / box.width) : 1;
  const outWidth = width ? even(width) : even(box.width * scale);
  const outHeight = height ? even(height) : even(box.height * scale);

  try {
    const sink = new CanvasSink(video, {
      width: outWidth,
      height: outHeight,
      fit: 'fill',
      crop: crop ? box : undefined,
    });
    const frame = await sink.getCanvas(Math.max(0, Number(timeSeconds) || 0));
    if (!frame) throw new Error('no frame at that timestamp');

    const canvas = frame.canvas;
    // OffscreenCanvas exposes convertToBlob; a DOM canvas only has toBlob.
    const png = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return { blob: png, timestamp: frame.timestamp, width: canvas.width, height: canvas.height };
  } finally {
    input.dispose();
  }
}
