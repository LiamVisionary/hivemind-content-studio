// Taking a clip's sound out of the studio: sound only, video without sound, and
// the split into dialogue / effects / music / a track per voice.
//
// What is pinned here is the RULE each door follows, not its wiring:
//
//   * none of them may send an envelope anywhere — a sealed clip this tab
//     cannot open stops at the vault's guard, before either route is called;
//   * a piece of a clip is saved under the CLIP's name with the piece said
//     after it, so five files from one generation sort together and none of
//     them can be mistaken for the clip;
//   * a refusal about the file ("this clip has no sound") reaches the person as
//     the sentence it is, and a cancelled save sheet is an answer, not an error;
//   * the rows exist for video only, and the two remuxes never pass through the
//     settings stamper whatever the unencrypted-download switch says.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = { __HIVEMIND_STUDIO__: 1, location: { search: '' }, dispatchEvent() {} };
let saved = [];
global.document = {
  createElement: () => ({ click() {} }),
  body: { appendChild(node) { saved.push(node.download); }, removeChild() {} },
};
global.URL.createObjectURL = () => 'blob:test/1';
global.URL.revokeObjectURL = () => {};
// blobToDataUrl() reads through FileReader, which Node does not have.
global.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
      this.onload?.();
    });
  }
};

const PLAIN_MP4 = { 'Content-Type': 'video/mp4' };
const SEALED = { 'X-E2E-Media': '1', 'Content-Type': 'application/vnd.hivemind.e2e+json' };
const CLIP = new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: 'video/mp4' });

function mediaResponse(headers, body) {
  return { ok: true, status: 200, headers: { get: (name) => headers[name] ?? null }, blob: async () => body, body: null };
}

function jsonResponse(status, payload) {
  return { ok: status < 400, status, headers: { get: () => null }, json: async () => payload };
}

async function load() {
  return import('../src/lib/soundExport.js');
}

test('a piece of a clip is named after the clip, with the piece said after it', async () => {
  const { trackFilename, stemFilename } = await load();
  assert.equal(trackFilename('h3-7f3a.mp4', 'audio'), 'h3-7f3a-audio.wav');
  assert.equal(trackFilename('h3-7f3a.mp4', 'silent'), 'h3-7f3a-no-sound.mp4');
  // The container the route actually wrote wins over the name it was sent.
  assert.equal(trackFilename('ltx-91.mp4', 'silent', '.webm'), 'ltx-91-no-sound.webm');
  assert.equal(stemFilename('h3-7f3a.mp4', 'voice_2'), 'h3-7f3a-voice-2.wav');
  assert.equal(stemFilename('', 'dialogue'), 'creation-dialogue.wav');
});

test('a sealed clip never reaches the track route or the splitter', async () => {
  const { downloadTrack, splitSound } = await load();
  const posted = [];
  global.fetch = async (url, init) => {
    if (init?.method === 'POST') { posted.push(String(url)); return jsonResponse(200, {}); }
    return mediaResponse(SEALED, new Blob(['{}']));
  };
  const track = await downloadTrack('/image/sealed.mp4', 'x.mp4', 'audio');
  const split = await splitSound('/image/sealed.mp4');
  assert.equal(track.blocked, true);
  assert.equal(split.blocked, true);
  assert.deepEqual(posted, [], 'ciphertext must never be posted anywhere');
});

test('sound only: the clip goes to the track route and comes back as a WAV under its own name', async () => {
  const { downloadTrack } = await load();
  saved = [];
  let form = null;
  global.fetch = async (url, init) => {
    if (String(url) === '/api/media/track') {
      form = init.body;
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'X-Track-Extension' ? '.wav' : null) },
        blob: async () => new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' }),
      };
    }
    return mediaResponse(PLAIN_MP4, CLIP);
  };
  const result = await downloadTrack('/image/out.mp4', 'h3-7f3a.mp4', 'audio');
  assert.equal(result.ok, true);
  assert.equal(result.filename, 'h3-7f3a-audio.wav');
  assert.equal(form.get('mode'), 'audio');
  assert.equal(form.get('file').name, 'h3-7f3a.mp4');
  assert.deepEqual(saved, ['h3-7f3a-audio.wav']);
});

test('"this clip has no sound" reaches the person as that sentence, and nothing is saved', async () => {
  const { downloadTrack } = await load();
  saved = [];
  global.fetch = async (url) => (String(url) === '/api/media/track'
    ? jsonResponse(422, { detail: 'This clip has no sound.' })
    : mediaResponse(PLAIN_MP4, CLIP));
  const result = await downloadTrack('/image/out.mp4', 'x.mp4', 'audio');
  assert.equal(result.ok, false);
  assert.equal(result.message, 'This clip has no sound.');
  assert.deepEqual(saved, []);

  // A 500's words are a traceback's, not a person's: reported as unreachable.
  global.fetch = async (url) => (String(url) === '/api/media/track'
    ? jsonResponse(500, { detail: 'Traceback (most recent call last)…' })
    : mediaResponse(PLAIN_MP4, CLIP));
  const broken = await downloadTrack('/image/out.mp4', 'x.mp4', 'audio');
  assert.equal(broken.unreachable, true);
  assert.equal(broken.message, undefined);
});

test('the split posts the clip inline, follows the job, and hands back playable stems', async () => {
  const { splitSound } = await load();
  const wav = Buffer.from([82, 73, 70, 70, 1, 2, 3, 4]).toString('base64');
  const stages = [];
  let submittedBody = null;
  let polls = 0;
  global.fetch = async (url, init) => {
    if (String(url) === '/local-ai/audio-split') {
      submittedBody = JSON.parse(init.body);
      return jsonResponse(202, { id: 'job123', status: 'queued' });
    }
    if (String(url) === '/local-ai/job/job123') {
      polls += 1;
      if (polls === 1) return jsonResponse(200, { status: 'running', stage: 'installing', progress: 0.4 });
      if (polls === 2) return jsonResponse(200, { status: 'running', stage: 'splitting', progress: 0 });
      return jsonResponse(200, {
        status: 'success',
        stems: [
          { key: 'dialogue', seconds: 9, level_db: -18.8, silent: false, wav_base64: wav },
          { key: 'voice_2', seconds: 9, level_db: -70.4, silent: true, wav_base64: wav },
        ],
      });
    }
    return mediaResponse(PLAIN_MP4, CLIP);
  };
  const result = await splitSound('/image/out.mp4', { pollMs: 1, onProgress: (event) => stages.push(event.stage) });
  assert.equal(result.ok, true);
  assert.match(submittedBody.media_base64, /^data:video\/mp4;base64,/, 'the clip rides inline, already decrypted');
  assert.deepEqual(stages, ['preparing', 'installing', 'splitting', 'done']);
  assert.deepEqual(result.stems.map((stem) => [stem.key, stem.silent]), [['dialogue', false], ['voice_2', true]]);
  assert.equal(result.stems[0].blob.type, 'audio/wav');
  assert.equal(result.stems[0].blob.size, 8);
});

test("the gateway's refusal is passed up as the sentence it is", async () => {
  const { splitSound } = await load();
  const sentence = 'Something is rendering right now, so it was left alone — split the clip again when it finishes.';
  global.fetch = async (url) => {
    if (String(url) === '/local-ai/audio-split') return jsonResponse(202, { id: 'j' });
    if (String(url) === '/local-ai/job/j') return jsonResponse(200, { status: 'error', error: sentence });
    return mediaResponse(PLAIN_MP4, CLIP);
  };
  const result = await splitSound('/image/out.mp4', { pollMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.message, sentence);
});

test('closing the dialog stops the polling and is not reported as a failure', async () => {
  const { splitSound } = await load();
  const controller = new AbortController();
  global.fetch = async (url) => {
    if (String(url) === '/local-ai/audio-split') return jsonResponse(202, { id: 'j' });
    if (String(url) === '/local-ai/job/j') { controller.abort(); return jsonResponse(200, { status: 'running', stage: 'splitting' }); }
    return mediaResponse(PLAIN_MP4, CLIP);
  };
  const result = await splitSound('/image/out.mp4', { pollMs: 1, signal: controller.signal });
  assert.equal(result.cancelled, true);
});

// Deliberately textual: what is pinned is an ABSENCE — that the sound rows are
// not reachable from a still's menu and that no code path in soundExport.js
// names the stamping route. A render proves the rows a given mount shows; it
// cannot prove a module never calls something.
test('the download menu offers the pieces for video only, and never through the stamper', () => {
  const menu = fs.readFileSync(path.join(__dirname, '../src/studios/frame/DownloadAction.jsx'), 'utf8');
  const lib = fs.readFileSync(path.join(__dirname, '../src/lib/soundExport.js'), 'utf8');
  const rows = menu.slice(menu.indexOf("{studio === 'video' ? ("));
  assert.ok(rows.length > 0 && rows.length < menu.length, 'the sound rows sit behind a video-only guard');
  for (const key of ['sound.audioOnly', 'sound.silentVideo', 'sound.split']) {
    assert.ok(rows.includes(`t('${key}')`), `${key} is a row`);
    assert.ok(!menu.slice(0, menu.indexOf("{studio === 'video' ? (")).includes(`t('${key}')`), `${key} is not offered for a still`);
  }
  // This menu is part of the LANDING studio's stage, so the dialog only a
  // video can open must not ride along in the first paint's download.
  assert.doesNotMatch(menu, /^import \{ SoundSplitDialog \}/m, 'the split dialog is imported eagerly');
  assert.match(menu, /const SoundSplitDialogLazy = lazyChunk\(/);
  // A WAV has nowhere to carry an A1111 block and a muted clip was not asked to
  // publish a prompt, so neither door may ever reach the stamping route.
  assert.doesNotMatch(lib, /stamp-settings|downloadMediaWithSettings/);
  // Every door starts at the one guard that refuses to hand out an envelope.
  assert.equal((lib.match(/await resolvePlaintextMedia\(url\)/g) || []).length, 2);
});
