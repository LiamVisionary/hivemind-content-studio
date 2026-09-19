// Taking a finished clip's SOUND out of the studio, in the pieces an editor
// asks for.
//
// A generated video is one file with one soundtrack, and that is almost never
// the shape it is used in: the line goes under a different shot, the shot goes
// over a different score, and two people who talk across each other want a
// fader each. Three doors, in order of how much work they are:
//
//   * downloadTrack(url, name, 'audio')   the soundtrack alone, as WAV
//   * downloadTrack(url, name, 'silent')  the picture alone, not re-encoded
//   * splitSound(url)                     dialogue / effects / music, and a
//                                         track per voice
//
// The first two are a remux (api/bridge.py: POST /api/media/track) and work on
// any machine with ffmpeg. The third runs two separation models on this
// machine's GPU lane (media-gateway: gateway/stems.py) and takes a few times
// the clip's length, so it reports progress and hands back stems to LISTEN to
// before anything is saved — which voice is "Voice 1" is the model's coin toss,
// and nobody should have to download both to find out.
//
// Like mediaExport.js, nothing here invents a save path or a way around the
// vault: every door starts at resolvePlaintextMedia(), the one guard that
// refuses to hand out an envelope, and every save ends in saveBytes().

import { resolvePlaintextMedia, saveBytes } from './downloadMedia.js';

const TRACK_ENDPOINT = '/api/media/track';
const SPLIT_ENDPOINT = '/local-ai/audio-split';
const JOB_ENDPOINT = '/local-ai/job/';

/** Stem keys in the order the gateway returns them and the dialog lists them. */
export const STEM_KEYS = ['dialogue', 'effects', 'music', 'voice_1', 'voice_2'];

const STEM_SUFFIX = {
  dialogue: 'dialogue',
  effects: 'effects',
  music: 'music',
  voice_1: 'voice-1',
  voice_2: 'voice-2',
};

/** `h3-abc123.mp4` → `h3-abc123`; an empty name still yields something saveable. */
function baseName(filename) {
  const name = String(filename || '').trim().replace(/\.[a-z0-9]{2,5}$/i, '');
  return name || 'creation';
}

/**
 * The name a piece of a clip is saved under: the clip's own model-derived name
 * (downloadNames.js) with the piece said after it, so five files from one clip
 * sort together and none of them can be mistaken for the clip.
 */
export function trackFilename(filename, mode, extension = '') {
  if (mode === 'audio') return `${baseName(filename)}-audio.wav`;
  const ext = extension || (String(filename || '').match(/\.[a-z0-9]{2,5}$/i) || ['.mp4'])[0];
  return `${baseName(filename)}-no-sound${ext.toLowerCase()}`;
}

export function stemFilename(filename, key) {
  return `${baseName(filename)}-${STEM_SUFFIX[key] || key}.wav`;
}

function namedFile(blob, filename) {
  return new File([blob], filename || 'creation', { type: blob.type });
}

/**
 * Save one half of `url`: its soundtrack ('audio') or its picture ('silent').
 *
 * Returns downloadMedia()'s shape. A refusal that is about the FILE — "this
 * clip has no sound" — comes back as `{ ok: false, message }` so the caller can
 * say it as it is; one about the connection comes back as `unreachable`.
 */
export async function downloadTrack(url, filename, mode, fetchImpl = fetch) {
  const resolved = await resolvePlaintextMedia(url);
  if (!resolved.ok) return resolved;

  const form = new FormData();
  form.append('file', namedFile(resolved.blob, filename || 'creation.mp4'));
  form.append('mode', mode);

  let response;
  try {
    response = await fetchImpl(TRACK_ENDPOINT, { method: 'POST', body: form });
  } catch {
    return { ok: false, blocked: false, unreachable: true };
  }
  if (!response.ok) {
    let message = '';
    try { message = String((await response.json())?.detail || ''); } catch { /* not JSON */ }
    // 422 is the route answering about the file. Anything else is the route
    // not answering, and its words are not for a person.
    return response.status === 422 && message
      ? { ok: false, blocked: false, message }
      : { ok: false, blocked: false, unreachable: true };
  }

  let bytes;
  try {
    bytes = await response.blob();
  } catch {
    return { ok: false, blocked: false, unreachable: true };
  }
  const name = trackFilename(filename, mode, response.headers?.get?.('X-Track-Extension') || '');
  const saved = await saveBytes(namedFile(bytes, name), name);
  if (saved.cancelled) return { ok: false, blocked: false, cancelled: true };
  return { ok: Boolean(saved.ok), blocked: false, filename: name };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('could not read the clip'));
    reader.readAsDataURL(blob);
  });
}

function wavBlob(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'audio/wav' });
}

async function readJson(response) {
  try { return await response.json(); } catch { return {}; }
}

function aborted() {
  return new DOMException('aborted', 'AbortError');
}

// An ALREADY-aborted signal fires no further event, so listening alone would
// sleep the full interval and then carry on polling a job nobody is watching.
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(aborted()); return; }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(timer); reject(aborted()); }, { once: true });
});

/**
 * Split `url`'s sound into stems.
 *
 * `onProgress({ stage, progress })` follows the gateway's own stages:
 * 'preparing' → 'installing' (first run only: the 20 MB of models, with a real
 * fraction) → 'restarting' (first run only) → 'splitting' → 'done'. There is no
 * fraction while splitting because the lane does not report one; the dialog
 * shows that as work in flight rather than inventing a bar.
 *
 * Resolves `{ ok: true, stems: [{ key, blob, seconds, silent, levelDb }] }`, a
 * resolver refusal for a sealed output, `{ ok: false, cancelled: true }` when
 * `signal` aborts, or `{ ok: false, message }` with the gateway's sentence.
 */
export async function splitSound(url, { onProgress, signal, fetchImpl = fetch, pollMs = 1500 } = {}) {
  const resolved = await resolvePlaintextMedia(url);
  if (!resolved.ok) return resolved;

  const say = (event) => { try { onProgress?.(event); } catch { /* a listener's problem */ } };
  try {
    say({ stage: 'preparing', progress: 0 });
    const submit = await fetchImpl(SPLIT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_base64: await blobToDataUrl(resolved.blob), voices: true }),
      signal,
    });
    const submitted = await readJson(submit);
    if (!submit.ok || !submitted.id) {
      return { ok: false, blocked: false, message: submitted.message || submitted.error || '', remedy: submitted.remedy || '' };
    }

    for (;;) {
      await wait(pollMs, signal);
      const poll = await fetchImpl(`${JOB_ENDPOINT}${encodeURIComponent(submitted.id)}`, { signal });
      const job = await readJson(poll);
      if (signal?.aborted) throw aborted();
      if (!poll.ok) return { ok: false, blocked: false, message: job.message || job.error || '' };
      if (job.status === 'error') return { ok: false, blocked: false, message: job.error || '' };
      if (job.status === 'success') {
        const stems = (job.stems || [])
          .filter((stem) => stem && stem.wav_base64)
          .map((stem) => ({
            key: stem.key,
            blob: wavBlob(stem.wav_base64),
            seconds: Number(stem.seconds) || 0,
            silent: Boolean(stem.silent),
            levelDb: Number(stem.level_db),
          }));
        if (!stems.length) return { ok: false, blocked: false, message: '' };
        say({ stage: 'done', progress: 1 });
        return { ok: true, blocked: false, stems };
      }
      say({ stage: job.stage || 'splitting', progress: Number(job.progress) || 0 });
    }
  } catch (error) {
    if (String(error?.name || '') === 'AbortError') return { ok: false, blocked: false, cancelled: true };
    return { ok: false, blocked: false, unreachable: true };
  }
}

/** Save one stem under the clip's name. Same result shape as downloadTrack. */
export async function saveStem(stem, filename) {
  const name = stemFilename(filename, stem.key);
  const saved = await saveBytes(namedFile(stem.blob, name), name);
  if (saved.cancelled) return { ok: false, cancelled: true };
  return { ok: Boolean(saved.ok), filename: name };
}
