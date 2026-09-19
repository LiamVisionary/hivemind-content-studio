// The Music route: the lane logic, and what is on screen in each of its states.
//
// Music is the first studio whose output is not a picture, and that is where
// almost every one of these tests comes from:
//
//  1. ACE-Step renders in TWO counted passes and each ComfyUI node counts from
//     zero. That is weighted at the GATEWAY, not in the browser:
//     workflow-registry.json declares `progress_phases` (node 2 "writing the
//     music", share 0.81; node 6 "rendering the audio", share 0.15) and
//     graphs.poll_local_comfy_progress maps each node into its own span, clamps
//     the result monotonic and reports the phase's name. So the record carries
//     an already-whole-job percent — 0->81 then 81->96 — and the browser's job
//     is to carry it through unchanged rather than weight it a second time.
//  2. The composer is built from the ROW — `accepts`, `limits`, `defaults`,
//     `samplers` — because an audio graph has no skeleton to infer it from. A
//     control the row does not take must not render, and a key the row does not
//     accept must not be sent.
//  3. Every track is E2E-sealed on disk and resolveMediaSrc is FAIL-OPEN, so a
//     tab with no key gets the envelope URL back. An <audio> pointed at that
//     sits at readyState 0 looking exactly like a render that made nothing.
//  4. The sealed envelope declares `audio/mpeg`, and the decrypt path has to
//     carry that through rather than assuming a picture anywhere along it.
//  5. A first run with no checkpoint must say what is missing AND offer the
//     download in the same surface.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderComponent, renderElement, importComponent, textOf } = require('./helpers/render.js');

const ROOT = path.resolve(__dirname, '../../..');
const PY = path.join(ROOT, '.venv/bin/python');
const SEAL = path.join(ROOT, 'packages/media-gateway/media_seal.py');

// The live row, trimmed to what the studio reads. Copied from
// GET /local-ai/audio-models on 2026-09-13 rather than invented, so a change to
// the registry's shape shows up here as a failure instead of as a passing test
// against a fiction.
const ROW = {
  id: 'ace-step-1.5-turbo',
  name: 'ACE-Step 1.5 Turbo',
  description: 'Local text-to-music with real sung vocals.',
  type: 'audio',
  family: 'ace-step',
  provider: 'hosted-media-studio',
  backend: 'comfy-api-audio',
  workflowFile: '/abs/path/ace-step-1.5-turbo.api.json',
  requires: { prompt: true, image: false },
  accepts: [
    'prompt', 'lyrics', 'seconds', 'bpm', 'timesignature', 'language', 'keyscale',
    'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'generate_audio_codes',
  ],
  supportsLyrics: true,
  defaults: {
    seconds: 60, bpm: 92, timesignature: '4', language: 'en', keyscale: 'C major',
    steps: 8, cfg: 1, seed: -1, samplerName: 'euler', scheduler: 'simple', generateAudioCodes: true,
  },
  limits: { seconds: { min: 10, max: 600 } },
  samplers: ['euler', 'dpmpp_2m', 'ddim', 'uni_pc', 'heun'],
  schedulers: ['simple', 'normal', 'sgm_uniform', 'beta', 'karras'],
  license: { code: 'MIT', weights: 'MIT', commercial: true, note: 'ACE-Step 1.5 ships MIT code and MIT weights; generated audio is yours.' },
  benchmarkSeconds: 13,
  tags: ['text-to-music'],
  featured: true,
  isDefault: true,
  ready: true,
  readyReason: 'ok',
};

const lane = () => import('../src/lib/musicLane.js');

/* ---------------- the request is built from the row ---------------- */

test('only a key the row accepts is sent, and the length is bounded by its limits', async () => {
  const { musicRequest, defaultMusicSetup, clampSeconds } = await lane();
  const setup = defaultMusicSetup(ROW);
  const body = musicRequest(ROW, setup, { prompt: '  warm lofi piano  ', lyrics: 'one line' });

  assert.equal(body.backend, 'comfy-api-audio');
  assert.equal(body.workflow_file, ROW.workflowFile);
  // The host resolves the ROW BY ID before forwarding — its audio branch looks
  // `model` up in the music catalogue the same way the image branch does, so a
  // body without it is refused with "Unknown music model" and nothing renders.
  assert.equal(body.model, ROW.id);
  // The style line is the PROMPT — the lyrics are a separate field, and sending
  // the words as the prompt is the one mistake this lane invites.
  assert.equal(body.prompt, 'warm lofi piano');
  assert.equal(body.lyrics, 'one line');
  assert.equal(body.seconds, 60);
  assert.equal(body.bpm, 92);
  assert.equal(body.sampler_name, 'euler');
  assert.equal(body.generate_audio_codes, true);
  // -1 is a request ("pick one for me"), not an absent value, so it travels.
  assert.equal(body.seed, -1);

  // A row that takes fewer controls sends fewer keys — nothing is assumed.
  const spare = { ...ROW, accepts: ['prompt', 'seconds'], supportsLyrics: false };
  const thin = musicRequest(spare, setup, { prompt: 'a drone', lyrics: 'ignored' });
  assert.deepEqual(Object.keys(thin).sort(), ['backend', 'model', 'prompt', 'seconds', 'workflow_file']);

  assert.equal(clampSeconds(ROW, 4), 10, 'under the floor');
  assert.equal(clampSeconds(ROW, 9000), 600, 'over the ceiling');
  assert.equal(musicRequest(ROW, { ...setup, seconds: 9000 }, { prompt: 'x' }).seconds, 600);
});

/* ---------------- the bar reads the gateway, and reads it once ---------------- */

test('the gateway\'s whole-job percent is carried through, not weighted again', async () => {
  const { newMusicProgress, foldMusicProgress, musicCountedFraction, musicPhaseLabel } = await lane();

  // What the gateway really writes for this workflow: node 2 spans 0->81 under
  // its own label, node 6 spans 81->96 under its. Both counters restart from
  // zero inside ComfyUI; neither restart reaches the record.
  const polls = [
    { status: 'running', progress: 16.2, current_step: 60, total_steps: 300, progress_phase: 'writing the music' },
    { status: 'running', progress: 64.8, current_step: 240, total_steps: 300, progress_phase: 'writing the music' },
    { status: 'running', progress: 81, current_step: 300, total_steps: 300, progress_phase: 'writing the music' },
    { status: 'running', progress: 82.9, current_step: 1, total_steps: 8, progress_phase: 'rendering the audio' },
    { status: 'running', progress: 96, current_step: 8, total_steps: 8, progress_phase: 'rendering the audio' },
  ];
  let state = newMusicProgress();
  const fractions = [];
  const phases = [];
  for (const poll of polls) {
    state = foldMusicProgress(state, poll);
    fractions.push(musicCountedFraction(state));
    phases.push(musicPhaseLabel(state));
  }

  // The percent is the whole job already. Halving it across a pass count (or
  // adding a phase index) would say 40% at the end of a pass that really is
  // four fifths of the render, then jump ~50 points in one poll.
  assert.deepEqual(fractions.map((value) => Math.round(value * 1000) / 1000), [0.162, 0.648, 0.81, 0.829, 0.96]);
  assert.deepEqual(phases, [
    'Writing the music', 'Writing the music', 'Writing the music',
    'Rendering the audio', 'Rendering the audio',
  ], 'the pass is named by the gateway, never inferred from a change in the step count');

  // Ordered spans, but polls are not guaranteed to be ordered.
  const late = foldMusicProgress(state, { status: 'running', progress: 40, current_step: 3, total_steps: 8 });
  assert.equal(late.percent, 96, 'a stale poll must not walk the bar back');

  // A record with no progress at all leaves the counters alone — a queued poll
  // arriving mid-render must not reset one that had already started counting.
  const held = foldMusicProgress(state, { status: 'running' });
  assert.equal(held.percent, 96);
  assert.equal(held.steps, 8);
  assert.equal(held.phase, 'rendering the audio');
});

test('the pass the user switched off is never the pass the readout names', async () => {
  const { newMusicProgress, foldMusicProgress, musicPhaseLabel } = await lane();
  // With "write audio codes first" off there is no LM pass and no step-count
  // change, so a label inferred client-side stays on the first pass forever and
  // names the exact thing the user just disabled.
  const state = foldMusicProgress(newMusicProgress(), {
    status: 'running', progress: 50, current_step: 4, total_steps: 8, progress_phase: 'rendering the audio',
  });
  assert.equal(musicPhaseLabel(state), 'Rendering the audio');
});

test('a job waiting for the GPU says so, and says what it is waiting behind', async () => {
  const { newMusicProgress, foldMusicProgress, musicCountedFraction, musicPhaseLabel, musicQueueNote } = await lane();
  // gateway/jobs._set_job_queue_state stamps exactly these three fields while a
  // render waits for the accelerator, and a music job goes through that queue.
  let state = foldMusicProgress(newMusicProgress(), {
    status: 'queued', queue_position: 1, progress_phase: 'waiting for the GPU',
  });
  assert.equal(musicPhaseLabel(state), 'Waiting for the GPU');
  assert.equal(musicCountedFraction(state), 0, 'nothing has been rendered yet');
  assert.match(musicQueueNote(state), /Waiting behind one render/);

  state = foldMusicProgress(state, { status: 'queued', queue_position: 3, progress_phase: 'waiting for the GPU' });
  assert.match(musicQueueNote(state), /Waiting behind 3 renders/);

  // Once it starts, it is not behind anything any more.
  state = foldMusicProgress(state, {
    status: 'running', progress: 5, current_step: 18, total_steps: 300, progress_phase: 'writing the music',
  });
  assert.equal(musicQueueNote(state), '');
  assert.equal(state.queuePosition, 0);

  // A record with no phase at all still has one honest thing to say.
  const bare = foldMusicProgress(newMusicProgress(), { status: 'queued' });
  assert.equal(musicPhaseLabel(bare), 'Waiting for the GPU');
  assert.equal(musicPhaseLabel(newMusicProgress()), 'Rendering');
});

/* ---------------- the numbers the studio is allowed to say ---------------- */

test('the estimate knows that switching the language model off removes four fifths of it', async () => {
  const { musicFallbackRate, musicTimingProfile, formatTrackLength, MUSIC_LM_SHARE } = await lane();
  const { estimateGenerationSeconds } = await import('../src/lib/genProgress.js');

  // The row measures 13s against a 60-second track, so the rate is per second
  // of finished audio and the estimate is that rate times the length.
  const codesOn = musicTimingProfile(ROW, { seconds: 60, generateAudioCodes: true, steps: 8, samplerName: 'euler' });
  assert.equal(codesOn.work, 60);
  assert.equal(Math.round(codesOn.fallbackRate * codesOn.work), 13);
  const longer = musicTimingProfile(ROW, { seconds: 120, generateAudioCodes: true });
  assert.equal(Math.round(longer.fallbackRate * longer.work), 26, 'twice the track, twice the wait');

  // The registry records the LM pass at 0.81 of the render and the same 60
  // seconds at ~2.7s without it. An estimate that ignores the switch advertises
  // 13s for a render that finishes in under three.
  const codesOff = musicTimingProfile(ROW, { seconds: 60, generateAudioCodes: false });
  assert.equal(MUSIC_LM_SHARE, 0.81);
  const withoutLm = codesOff.fallbackRate * codesOff.work;
  assert.ok(withoutLm > 2 && withoutLm < 3.5, `expected about 2.5s, got ${withoutLm}`);
  assert.notEqual(codesOff.key, codesOn.key, 'the two are timed separately, so neither learns the other\'s duration');

  // No benchmark, no estimate. An invented one is worse than none.
  assert.equal(musicFallbackRate({ ...ROW, benchmarkSeconds: 0 }), 0);

  // …and the studio asks the SAME store the Image lane learns in, so the
  // registry number is only ever the first-run fallback.
  assert.equal(estimateGenerationSeconds(codesOn.key, codesOn.work, codesOn.fallbackRate), 13);

  assert.equal(formatTrackLength(60), '1:00');
  assert.equal(formatTrackLength(605), '10:05');
});

test('the licence is read off the row, never asserted by the studio', async () => {
  const { musicLicenceLine } = await lane();
  assert.match(musicLicenceLine(ROW), /MIT code and MIT weights/);
  assert.equal(musicLicenceLine({ ...ROW, license: null }), '');
  const restrictive = { license: { code: 'Apache-2.0', weights: 'non-commercial', commercial: false } };
  assert.equal(musicLicenceLine(restrictive), 'Apache-2.0 code and non-commercial weights');
});

test('ACE-Step leads the music list, and it is enforced rather than incidental', () => {
  // The order rows sit in workflow-registry.json must not decide which music
  // model a person meets first. ACE-Step 1.5 leads because it is the default,
  // it is faster, and its code AND weights are MIT so a track can be sold;
  // YuE2 follows because its weights are CC BY-NC. Feeding the loader a
  // registry with the rows REVERSED is the only way to tell an enforced order
  // from a lucky one.
  const { loadHostedAudioModels } = require('../hosted-local-models.js');
  const registryPath = path.join(__dirname, '..', '..', 'media-gateway', 'workflow-registry.json');

  const shipped = loadHostedAudioModels(registryPath).map((row) => row.id);
  assert.equal(shipped[0], 'ace-step-1.5-turbo');
  assert.ok(shipped.includes('yue2-3b'), 'YuE2 is still offered, just not first');

  const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  data.workflows = [...data.workflows].reverse();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-order-'));
  try {
    // The loader resolves graphs relative to the registry, so keep the layout.
    fs.mkdirSync(path.join(dir, 'workflows'), { recursive: true });
    const shuffled = path.join(dir, 'workflow-registry.json');
    fs.writeFileSync(shuffled, JSON.stringify(data));
    const reordered = loadHostedAudioModels(shuffled).map((row) => row.id);
    assert.deepEqual(reordered, shipped, 'the order must survive a reshuffled registry');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-commercial model says what that MEANS, and says it on the finished track', async () => {
  // "CC BY-NC 4.0" is not a sentence anybody can act on, and the moment the
  // restriction matters is the moment somebody downloads the song — which is
  // long after the empty state that carries musicLicenceLine has gone.
  const { musicUsageRestriction } = await lane();
  assert.equal(musicUsageRestriction(ROW), '', 'an MIT row must not be labelled');
  assert.equal(musicUsageRestriction({ license: null }), '');
  assert.equal(
    musicUsageRestriction({ license: { weights: 'MIT' } }), '',
    'an unstated commercial flag must not be asserted either way',
  );
  const nc = musicUsageRestriction({ license: { weights: 'CC-BY-NC-4.0', commercial: false } });
  assert.match(nc, /non-commercial/i);
  assert.match(nc, /cannot be sold/i);
});

test('the stage prints the restriction beside a finished track', async () => {
  const withNote = await renderComponent('src/studios/music/MusicStage.jsx', 'MusicStage', {
    title: 'Rain on the pane',
    src: 'blob:fake',
    lengthText: '0:20',
    restriction: 'Personal and non-commercial use only — CC-BY-NC-4.0 weights. This track cannot be sold or used to promote a business.',
  });
  assert.match(textOf(withNote), /non-commercial use only/i);

  // ...and stays out of the way entirely for a model that allows selling.
  const clean = await renderComponent('src/studios/music/MusicStage.jsx', 'MusicStage', {
    title: 'Rain on the pane', src: 'blob:fake', lengthText: '0:20',
  });
  assert.ok(!/non-commercial/i.test(textOf(clean)));
});

test('a row that is not ready says which of its two reasons it is', async () => {
  const { musicReadiness } = await lane();
  assert.equal(musicReadiness(ROW), null);
  const short = musicReadiness({
    ...ROW, ready: false, readyReason: 'missing-weights', missingWeights: ['ace_step_1.5_turbo_aio.safetensors'],
  });
  assert.equal(short.reason, 'missing-weights');
  assert.match(short.title, /needs its checkpoint/);
  assert.match(short.detail, /ace_step_1\.5_turbo_aio/);
  assert.equal(musicReadiness({ ...ROW, ready: false, readyReason: 'engine-offline' }).reason, 'engine-offline');
});

test('the finished record is read through the field name every backend shares', async () => {
  const { musicOutputUrl } = await lane();
  // `image_urls` is the gateway's field for EVERY backend's outputs, audio
  // included; the host's inlined copy wins when it is there.
  assert.equal(musicOutputUrl({ url: 'data:audio/mpeg;base64,AA', image_urls: ['/image/x.mp3'] }), 'data:audio/mpeg;base64,AA');
  assert.equal(musicOutputUrl({ image_urls: ['/image/hivemind-music_00003.mp3'] }), '/image/hivemind-music_00003.mp3');
  assert.equal(musicOutputUrl({ status: 'success' }), '');
});

/* ---------------- a sealed track is audio all the way down ---------------- */

test('a sealed track decrypts to an audio blob, not to something assumed to be a picture', async (t) => {
  if (!fs.existsSync(PY)) return t.skip('no .venv python to seal with');
  // The same harness e2eMedia.test.js uses, with an AUDIO media_type: the
  // gateway stamps `audio/mpeg` into the envelope and the browser has to carry
  // it onto the Blob, or the <audio> element is handed bytes it will not play.
  const session = new Map([['hivemind.ownerPassphrase.once', JSON.stringify({ password: 'music-pass', expiresAt: Date.now() + 1e6 })]]);
  const realWindow = global.window;
  const realSession = global.sessionStorage;
  const realUrl = global.URL;
  const realFetch = global.fetch;
  global.window = { location: { search: '?hivemindStudio=1' }, dispatchEvent: () => {} };
  global.sessionStorage = { getItem: (key) => (session.has(key) ? session.get(key) : null), setItem() {}, removeItem() {} };
  const blobs = [];
  global.URL = { createObjectURL: (blob) => { blobs.push(blob); return `blob:music/${blobs.length - 1}`; }, revokeObjectURL: () => {} };

  try {
    const vault = { identity: null };
    global.fetch = async (url, options = {}) => {
      const method = options.method || 'GET';
      if (url === '/api/vault/identity' && method === 'GET') return { ok: true, json: async () => ({ ok: true, exists: !!vault.identity, identity: vault.identity }) };
      if (url === '/api/vault/identity' && method === 'PUT') { vault.identity = JSON.parse(options.body).identity; return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
      throw new Error(`unexpected ${url}`);
    };
    const vaultSession = await import(`../src/lib/vaultSession.js?music=${Date.now()}`);
    assert.equal(await vaultSession.ensureVaultReady(), true);
    const pub = (await (await fetch('/api/vault/identity')).json()).identity.public_key;

    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2048, 7)]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-seal-'));
    fs.writeFileSync(path.join(dir, 'pub.txt'), pub);
    fs.writeFileSync(path.join(dir, 'in.bin'), mp3);
    execFileSync(PY, [SEAL, '--pub', `@${path.join(dir, 'pub.txt')}`, '--in', path.join(dir, 'in.bin'), '--out', path.join(dir, 'out.json')]);
    const envelope = { ...JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')), v: 1, media_type: 'audio/mpeg' };
    fs.rmSync(dir, { recursive: true, force: true });

    global.fetch = async (url) => {
      if (url === '/image/hivemind-music_00003.mp3') {
        return {
          ok: true,
          headers: { get: (name) => (name === 'X-E2E-Media' ? '1' : name === 'Content-Type' ? 'application/vnd.hivemind.e2e+json' : null) },
          json: async () => envelope,
          body: { cancel() {} },
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    const media = await import(`../src/lib/e2eMedia.js?music=${Date.now()}`);
    const src = await media.resolveMediaSrc('/image/hivemind-music_00003.mp3');
    assert.match(src, /^blob:music\//, 'the sealed track resolves to a playable blob URL');
    assert.equal(blobs[0].type, 'audio/mpeg', 'the envelope media type reaches the Blob the player is handed');
    assert.deepEqual(Buffer.from(await blobs[0].arrayBuffer()), mp3);
  } finally {
    global.window = realWindow;
    global.sessionStorage = realSession;
    global.URL = realUrl;
    global.fetch = realFetch;
  }
});

/* ---------------- what a person sees ---------------- */

const stage = (props) => renderComponent('src/studios/music/MusicStage.jsx', 'MusicStage', props);

test('a finished track is a real player, with its length and what it cost to make', async () => {
  const markup = await stage({
    title: 'warm lofi piano, brushed drums',
    src: 'blob:music/0',
    lengthText: '1:00',
    metaText: 'ACE-Step 1.5 Turbo · rendered in 0:17',
    instrumental: true,
  });
  // <audio controls> and nothing hand-rolled: the browser's own transport is
  // what makes the track playable by keyboard and readable by a screen reader.
  assert.match(markup, /<audio[^>]*controls/);
  const text = textOf(markup);
  assert.match(text, /warm lofi piano, brushed drums/);
  assert.match(text, /1:00/);
  assert.match(text, /instrumental/);
  assert.match(text, /rendered in 0:17/);
});

test('a track this tab has no key for says so instead of offering a dead player', async () => {
  const markup = await stage({ title: 'a song', src: 'blob:music/0', lengthText: '1:00', sealed: 'locked' });
  assert.doesNotMatch(markup, /<audio/, 'an <audio> pointed at ciphertext looks exactly like a failed render');
  const text = textOf(markup);
  assert.match(text, /Vault locked/);
  assert.match(text, /unlock your vault/, 'and the way out is in the same component');
});

test('a render in flight names its pass, its step and its estimate, and can be stopped', async () => {
  const markup = await stage({
    busy: true,
    title: 'a song',
    lengthText: '1:00',
    phase: 'Writing the audio codes',
    percent: 30,
    subject: 'step 105 of 300',
    timing: '0:03 of about 0:13',
    note: 'About 0:13 is an estimate, scaled from this model’s one measured run.',
    onCancel() {},
  });
  const text = textOf(markup);
  assert.match(text, /Writing the audio codes/);
  assert.match(text, /30%/);
  assert.match(text, /step 105 of 300/);
  assert.match(text, /is an estimate/, 'the only number we have is labelled as one');
  assert.match(text, /Stop/);
  assert.doesNotMatch(markup, /<audio/, 'nothing to play yet');
});

test('a first run with no checkpoint states the size AND offers the download', async () => {
  const markup = await renderComponent('src/studios/music/MusicStage.jsx', 'MusicStageEmpty', {
    title: 'ACE-Step 1.5 Turbo needs its checkpoint downloaded before it can play anything.',
    hint: 'Press below and it downloads here, in this page, with a progress bar you can cancel. It is a 10.0 GB download, once.',
    install: { label: 'Download it now', onClick() {} },
    licence: 'ACE-Step 1.5 ships MIT code and MIT weights; generated audio is yours.',
  });
  const text = textOf(markup);
  assert.match(text, /needs its checkpoint/);
  assert.match(text, /10\.0 GB/);
  assert.match(text, /Download it now/, 'the problem and its fix are the same surface');
  assert.match(markup, /<button/);
  assert.match(text, /MIT code and MIT weights/);
});

/* ---------------- the composer renders the row, not a fixed list ---------------- */

test('the composer offers exactly the controls the row accepts', async () => {
  const MusicComposer = await importComponent('src/studios/music/MusicComposer.jsx', 'MusicComposer');
  const { defaultMusicSetup } = await lane();
  const props = {
    model: ROW,
    setup: defaultMusicSetup(ROW),
    onSetup() {},
    prompt: '',
    onPrompt() {},
    lyrics: '',
    onLyrics() {},
    lyricsOpen: false,
    onToggleLyrics() {},
    onGenerate() {},
    metaLabel: '~0:13 · free',
  };
  const full = renderElement(MusicComposer, props);
  assert.deepEqual(full.logged, []);
  const text = textOf(full.markup);
  assert.match(text, /Make a 1:00 track 92 BPM in C major in 4\/4 , sung in English/, 'the settings read as a sentence');
  assert.doesNotMatch(text, /Advanced/, "the door to Advanced is the frame's edge tab, not a word in the composer");
  assert.match(text, /Make the track/);
  assert.match(text, /~0:13 · free/);
  // The lyrics door exists because this row sings.
  assert.match(full.markup, /aria-label="Write lyrics"/);

  // A row with no tempo and no voice renders neither.
  const thin = renderElement(MusicComposer, {
    ...props,
    model: { ...ROW, accepts: ['prompt', 'seconds'], supportsLyrics: false },
  });
  assert.deepEqual(thin.logged, []);
  const thinText = textOf(thin.markup);
  assert.doesNotMatch(thinText, /BPM/);
  assert.doesNotMatch(thinText, /sung in/);
  assert.doesNotMatch(thin.markup, /aria-label="Write lyrics"/, 'a model that does not sing offers no lyrics box');
});

test('the session\'s tracks have a door that survives a window too narrow for the rail', async () => {
  // MusicRail is `hidden sm:flex`, so below 640px a track this tab already made
  // has nothing on screen that reaches it. The composer's door lists them at
  // every width, for the reason Restore's Projects door does.
  const MusicComposer = await importComponent('src/studios/music/MusicComposer.jsx', 'MusicComposer');
  const { defaultMusicSetup } = await lane();
  const props = {
    model: ROW,
    setup: defaultMusicSetup(ROW),
    onSetup() {}, prompt: '', onPrompt() {},
    lyrics: '', onLyrics() {}, lyricsOpen: false, onToggleLyrics() {},
    onGenerate() {},
  };
  const none = renderElement(MusicComposer, props);
  assert.doesNotMatch(none.markup, /aria-label="Tracks"/, 'nothing rendered yet is nothing to list');

  const some = renderElement(MusicComposer, {
    ...props,
    tracks: [{ id: 't1', title: 'Warm lofi', seconds: 60 }],
    activeTrackId: 't1',
    onOpenTrack() {},
  });
  assert.deepEqual(some.logged, []);
  assert.match(some.markup, /aria-label="Tracks"/);
  // …and the studio really hands it the rail's own list and handler.
  const studio = fs.readFileSync(path.join(__dirname, '../src/studios/MusicStudio.jsx'), 'utf8');
  assert.match(studio, /onOpenTrack=\{\(track\) => setActiveId\(track\.id\)\}/);
});

test('the lyrics box opens over the prompt and says what an empty one means', async () => {
  const MusicComposer = await importComponent('src/studios/music/MusicComposer.jsx', 'MusicComposer');
  const { defaultMusicSetup } = await lane();
  const { markup, logged } = renderElement(MusicComposer, {
    model: ROW,
    setup: defaultMusicSetup(ROW),
    onSetup() {}, prompt: 'warm lofi piano', onPrompt() {},
    lyrics: '[verse]\nhello', onLyrics() {},
    lyricsOpen: true, onToggleLyrics() {},
    onGenerate() {},
  });
  assert.deepEqual(logged, []);
  const text = textOf(markup);
  assert.match(text, /Lyrics/);
  assert.match(text, /Leave it empty for an instrumental/);
  assert.match(markup, /<textarea[^>]*rows="5"/);
});

/* ---------------- the drawer ---------------- */

test('Advanced holds the secondary dials and the licence, and the composer does not', async () => {
  const { defaultMusicSetup, musicLicenceLine } = await lane();
  const markup = await renderComponent('src/studios/music/MusicSettings.jsx', 'MusicSettings', {
    model: ROW,
    setup: defaultMusicSetup(ROW),
    onSetup() {},
    licence: musicLicenceLine(ROW),
    runsOn: 'This Mac',
  });
  const text = textOf(markup);
  for (const dial of ['Steps', 'Guidance', 'Sampler', 'Scheduler', 'Seed']) {
    assert.match(text, new RegExp(dial), `${dial} belongs behind the disclosure`);
  }
  assert.match(text, /This Mac/);
  assert.match(text, /Nothing about the song leaves this machine/);
  assert.match(text, /MIT code and MIT weights/);
  // The sampler list is the row's, not a list typed here.
  for (const sampler of ROW.samplers) assert.match(markup, new RegExp(`value="${sampler}"`));
});

/* ---------------- the seed box is a box, not a number ---------------- */

// MusicSettings and MusicComposer are pure functions of their props — no hooks,
// no effects — so a test can CALL one and walk the element tree it returns to
// reach a handler. renderToStaticMarkup cannot: there is no DOM and no event
// system in this suite, and asserting on markup alone would only pin what the
// control looks like, never what it does when somebody types in it.
function walk(node, visit, seen = new Set()) {
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit, seen)); return; }
  if (!node || typeof node !== 'object' || !node.props || seen.has(node)) return;
  seen.add(node);
  visit(node);
  // Every prop, not only `children`: the frame hands its composer, recipe, rail
  // and stage to StudioFrame as props, so a children-only walk never sees them.
  Object.values(node.props).forEach((value) => walk(value, visit, seen));
}

function findOne(tree, predicate, what) {
  const hits = [];
  walk(tree, (node) => { if (predicate(node)) hits.push(node); });
  assert.equal(hits.length, 1, `expected exactly one ${what}, found ${hits.length}`);
  return hits[0];
}

test('clearing the seed box asks for a random seed, and never silently pins zero', async () => {
  const MusicSettings = await importComponent('src/studios/music/MusicSettings.jsx', 'MusicSettings');
  const { defaultMusicSetup } = await lane();
  const setup = defaultMusicSetup(ROW);
  // The row's own default is "pick one for me", and the box is empty for it.
  assert.equal(setup.seed, -1);
  assert.equal(setup.seedText, '');

  let next = null;
  const seedField = (current) => findOne(
    MusicSettings({ model: ROW, setup: current, onSetup: (value) => { next = value; } }),
    (node) => node.props.type === 'number' && 'value' in node.props,
    'seed input',
  );

  // Typing a seed pins it.
  seedField(setup).props.onChange({ target: { value: '1234' } });
  assert.equal(next.seed, 1234);
  assert.equal(next.seedText, '1234');

  // Selecting the box and deleting it — what anybody does before typing a new
  // number — asked for seed 0 before, which is a pinned seed: the same take
  // from the same prompt for every render after it, with the control beside it
  // flipped to "pin" without the user touching it.
  seedField(next).props.onChange({ target: { value: '' } });
  assert.equal(next.seed, -1, 'an empty box means "pick one for me", not seed 0');
  assert.equal(next.seedText, '', 'and the box stays empty rather than fighting the typing');

  // The box shows what was typed, and the auto/pin control reads the number.
  const pinned = { ...setup, seed: 1234, seedText: '1234' };
  const markup = await renderComponent('src/studios/music/MusicSettings.jsx', 'MusicSettings', {
    model: ROW, setup: pinned, onSetup() {},
  });
  assert.match(markup, /value="1234"/);
  assert.match(textOf(markup), /pinned/);
  const random = await renderComponent('src/studios/music/MusicSettings.jsx', 'MusicSettings', {
    model: ROW, setup, onSetup() {},
  });
  assert.match(random, /value=""/, 'the -1 default is an empty box, not a literal "-1"');
  assert.match(textOf(random), /random/);
});

/* ---------------- a render in flight owns its own settings ---------------- */

test('the sentence is frozen while a track renders, because the request already left', async () => {
  const MusicComposer = await importComponent('src/studios/music/MusicComposer.jsx', 'MusicComposer');
  const { defaultMusicSetup } = await lane();
  const props = {
    model: ROW,
    setup: defaultMusicSetup(ROW),
    onSetup() {}, prompt: 'warm lofi piano', onPrompt() {},
    lyrics: '', onLyrics() {}, lyricsOpen: false, onToggleLyrics() {},
    onGenerate() {},
  };
  const tokensOf = (generating) => {
    const found = [];
    walk(MusicComposer({ ...props, generating }), (node) => {
      if (Array.isArray(node.props.parts)) found.push(...node.props.parts.filter((part) => part && part.key));
    });
    assert.ok(found.length >= 4, 'the recipe line should carry the length, tempo, key and time signature');
    return found;
  };
  // Advanced is already disabled during a render. The tokens in the sentence
  // are the same settings, and a length changed now belongs to the NEXT track —
  // the one on the bar was snapshotted when the button was pressed.
  assert.ok(tokensOf(true).every((part) => part.disabled === true), 'every token is frozen mid-render');
  assert.ok(tokensOf(false).every((part) => !part.disabled), 'and live again once it is finished');
});

/* ---------------- a track in the Library is a track ---------------- */

test('a sealed track in the Library is audio, not a broken picture', async () => {
  const { outputMediaKind } = await import('../src/hub/views/HistoryView.jsx');
  // canvas_history stamps media_type from the filename (mimetypes), and the
  // gateway seals .mp3 through the same output pipeline as .png — so a track
  // really does arrive on this surface, and a single startsWith('video/') test
  // sent it down the image branch: an <img> pointed at an MP3.
  assert.equal(outputMediaKind({ media_type: 'audio/mpeg' }), 'audio');
  assert.equal(outputMediaKind({ media_type: 'audio/x-wav' }), 'audio');
  assert.equal(outputMediaKind({ media_type: 'video/mp4' }), 'video');
  assert.equal(outputMediaKind({ media_type: 'image/png' }), 'image');
  assert.equal(outputMediaKind({}), 'image', 'an unknown type is still shown, as the picture it probably is');

  // And the preview it opens carries a transport rather than an <img>. The
  // Lightbox portals through Modal, which needs a real container, so this walks
  // the tree it builds instead of rendering it.
  const Lightbox = await importComponent('src/hub/components/Lightbox.jsx', 'Lightbox');
  const tree = Lightbox({ src: 'blob:music/0', kind: 'audio', title: 'Audio · ACE-Step 1.5 Turbo', onClose() {} });
  const player = findOne(tree, (node) => node.type === 'audio', 'audio player');
  assert.equal(player.props.src, 'blob:music/0');
  assert.equal(player.props.controls, true);
  let images = 0;
  walk(tree, (node) => { if (node.type === 'img') images += 1; });
  assert.equal(images, 0, 'an <img> pointed at an MP3 is the defect this replaces');
});

/* ---------------- the route ---------------- */

test('the Music route mounts on the frame with a composer, a rail and no scrolling column', async () => {
  const markup = await renderComponent('src/studios/MusicStudio.jsx', 'MusicStudio', { active: true });
  const text = textOf(markup);
  // The offline first paint: the catalogue has not answered yet, and a wait
  // must not look like a page that found nothing.
  assert.match(text, /Looking for the music models on this machine/);
  assert.match(markup, /aria-busy="true"/);
  // The frame, not StudioLayout.
  assert.match(markup, /data-studio-frame/);
  assert.match(text, /TRACKS/i);
  assert.match(text, /Make the track/);
  // …with the tab on the frame's left edge as the one door to Advanced.
  const tab = /<button[^>]*data-drawer-tab[^>]*>/.exec(markup);
  assert.ok(tab, 'the Music studio has no tab to open Advanced with');
  assert.match(tab[0], /aria-expanded="false"/, 'the Advanced tab reports itself shut');
});

// Deliberately textual: this is an absence claim about how the studio is
// REGISTERED, and registration has no rendered form — App.jsx's loader map and
// the tabbed set are module-level data read by the router, not by a component.
test('Music is not a tabbed studio, so nothing writes its lyrics to sessionStorage', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'App.jsx'), 'utf8');
  const tabbed = app.match(/const TABBED_STUDIOS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(tabbed, 'TABBED_STUDIOS not found in App.jsx');
  assert.doesNotMatch(tabbed[1], /music/,
    'a tabbed studio snapshots its composer into sessionStorage, and lyrics are as private as a prompt');
  assert.match(app, /music: \(\) => import\('\.\.\/studios\/MusicStudio\.jsx'\)/);
});

/* ---------------- the instrumental lane reads a plan, not words ---------------- */

// The instrumental YuE2 lane takes the lyrics FIELD but not lyrics: its LoRA was
// trained on three caption shapes over six tag names (Mothersuperior/
// YuE2-instrumental-cot-full-loras), and its card says anything else in that
// field pulls the output away from what it learned. So these rows come through
// the real host loader, off the real registry — the contract under test is the
// one the browser is actually served.
const { loadHostedAudioModels } = require('../hosted-local-models.js');
const HOSTED = () => loadHostedAudioModels(path.join(ROOT, 'packages/media-gateway/workflow-registry.json'));
const hostedRow = (id) => HOSTED().find((row) => row.id === id);

test('the instrumental lane is offered as a plan, and the singing one still as lyrics', () => {
  const instrumental = hostedRow('yue2-3b-instrumental');
  assert.equal(instrumental.lyricsFormat, 'section-plan');
  assert.equal(instrumental.supportsLyrics, false, 'no lyrics box over a model that was never shown words');
  assert.deepEqual(instrumental.sectionTags, ['intro', 'verse', 'pre-chorus', 'chorus', 'bridge', 'outro']);
  assert.ok(instrumental.accepts.includes('lyrics'), 'the plan still travels in the lyrics field');
  assert.ok(!instrumental.accepts.includes('mode'), 'the LoRA runs score-first; the graph pins it');
  assert.equal(instrumental.license.commercial, false);

  const singing = hostedRow('yue2-3b');
  assert.equal(singing.lyricsFormat, 'lyrics');
  assert.equal(singing.supportsLyrics, true);
  // YuE2 shipped with a `mode` token whose menu opened empty: the row accepted
  // the control and the host never forwarded the choices behind it.
  assert.deepEqual(singing.modes.map((row) => row.id), ['full', 'melody']);
  assert.equal(singing.defaults.mode, 'full');
});

test('the three plan shapes are the ones on the LoRA\'s card, to the character', async () => {
  const { sectionPlanLyrics, defaultSectionPlan, sectionTimings } = await lane();
  const row = hostedRow('yue2-3b-instrumental');
  const plan = defaultSectionPlan();
  assert.equal(sectionPlanLyrics(row, { ...plan, mode: 'bare' }, 150), '[instrumental]');
  assert.equal(sectionPlanLyrics(row, plan, 150), '[intro]\n[verse]\n[chorus]\n[bridge]\n[chorus]\n[outro]');
  // At 2:30 the shared-out times reproduce the card's own worked example.
  assert.equal(
    sectionPlanLyrics(row, { ...plan, mode: 'timed' }, 150),
    '[intro 0:00-0:15]\n[verse 0:15-0:45]\n[chorus 0:45-1:10]\n[bridge 1:10-1:40]\n[chorus 1:40-2:05]\n[outro 2:05-2:30]',
  );
  // At an awkward length the ranges still tile the track: no gap, no overlap,
  // and the last one ends where the track does.
  const tiled = sectionTimings(plan.sections, 97);
  tiled.forEach((slot, index) => assert.equal(slot.start, index ? tiled[index - 1].end : 0));
  assert.equal(tiled.at(-1).end, 97);
  // An order with nothing in it, or a tag the row never named, is never sent.
  assert.equal(sectionPlanLyrics(row, { mode: 'untimed', sections: [] }, 150), '[instrumental]');
  assert.equal(sectionPlanLyrics(row, { mode: 'untimed', sections: ['intro', 'guitar solo', 'outro'] }, 150), '[intro]\n[outro]');
});

test('the instrumental composer opens a structure builder where the lyrics box would be', async () => {
  const MusicComposer = await importComponent('src/studios/music/MusicComposer.jsx', 'MusicComposer');
  const { defaultMusicSetup, defaultSectionPlan } = await lane();
  const row = { ...hostedRow('yue2-3b-instrumental'), ready: true, readyReason: 'ok' };
  const props = {
    model: row,
    setup: defaultMusicSetup(row),
    onSetup() {}, prompt: 'dark ambient, theremin', onPrompt() {},
    lyrics: 'words left over from a singing model', onLyrics() {},
    plan: { ...defaultSectionPlan(), mode: 'timed' }, onPlan() {},
    lyricsOpen: true, onToggleLyrics() {},
    onGenerate() {},
  };
  const open = renderElement(MusicComposer, props);
  assert.deepEqual(open.logged, []);
  const text = textOf(open.markup);
  assert.match(text, /Structure/);
  assert.match(text, /This model plays, it does not sing/);
  assert.match(text, /\[intro 0:00-0:15\]/, 'the card shows exactly what the model is handed');
  assert.match(text, /Make a 2:30 track/, 'the lane opens on a length its plan can breathe in');
  assert.doesNotMatch(open.markup, /<textarea[^>]*rows="5"/, 'there is nowhere to type a lyric');
  assert.doesNotMatch(text, /words left over/);
  assert.doesNotMatch(text, /Melody and chords/, 'the score mode is pinned, not offered');

  const closed = renderElement(MusicComposer, { ...props, lyricsOpen: false });
  assert.match(closed.markup, /aria-label="Structure"/);
  assert.doesNotMatch(closed.markup, /aria-label="Write lyrics"/);
});

test('an instrumental lane is sent its plan, never the lyrics box', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/studios/MusicStudio.jsx'), 'utf8');
  assert.match(source, /const words = planned \? sectionPlanLyrics\(model, plan, setup\.seconds\) : lyrics;/);
  assert.match(source, /musicRequest\(model, setup, \{ prompt: style, lyrics: words \}\)/);
});
