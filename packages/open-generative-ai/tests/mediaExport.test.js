// The two doors behind the stage's Download arrow.
//
// What is actually worth pinning here is the RULE each one follows, because
// both of them move a person's prompt somewhere it cannot be recalled from:
//
//   * the stamped save must never send an envelope to the stamper, must report
//     honestly when the stamp did not take, and must treat a cancelled save
//     sheet as an answer rather than a failure;
//   * the share sheet must send the plain file — no settings — whatever the
//     unencrypted-download switch says, and must not report a dismissed sheet
//     as an error;
//   * the switch itself is per studio, and an unknown studio cannot open one.
const test = require('node:test');
const assert = require('node:assert/strict');

// The module reaches for `window` (the blocked-download event) and File/Blob.
global.window = { __HIVEMIND_STUDIO__: 1, location: { search: '' }, dispatchEvent() {} };
// saveBytes()'s browser branch, stubbed so these tests exercise the REAL save
// path rather than its last-resort fallback: an anchor, clicked, with the name
// the stamped copy is supposed to land under.
let lastSaved = null;
global.document = {
  createElement: (tag) => {
    // measureMedia probes a detached <video> and waits for `loadedmetadata`.
    // Answering it keeps the suite off the 4s cap AND proves the measured size
    // actually reaches the stamper.
    if (tag === 'video') {
      const probe = { preload: '', videoWidth: 1280, videoHeight: 720, duration: 4 };
      Object.defineProperty(probe, 'src', {
        set() { setImmediate(() => probe.onloadedmetadata?.()); },
      });
      return probe;
    }
    return { click() {} };
  },
  body: { appendChild(node) { lastSaved = { download: node.download }; node.click?.(); }, removeChild() {} },
};
let objectUrls = 0;
global.URL.createObjectURL = () => `blob:test/${++objectUrls}`;
global.URL.revokeObjectURL = () => {};

// Node ships its own read-only `navigator`, so a plain assignment is silently
// ignored and every share test would test the real (fileless) one instead.
function withNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}
function clearNavigator() {
  Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true });
}

/** A fetch that serves `body` for the media URL and records the stamp request. */
function serve({ mediaHeaders, mediaBody, stamp }) {
  const calls = { stamp: null, media: 0 };
  global.fetch = async (url, init) => {
    if (String(url) === '/api/media/stamp-settings') {
      calls.stamp = { init, meta: JSON.parse(init.body.get('meta')), file: init.body.get('file') };
      return stamp;
    }
    calls.media += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => mediaHeaders[name] ?? null },
      blob: async () => mediaBody,
      body: null,
    };
  };
  return calls;
}

const PLAIN_PNG = { 'Content-Type': 'image/png' };
const SEALED = { 'X-E2E-Media': '1', 'Content-Type': 'application/vnd.hivemind.e2e+json' };

/** A stamper response: `embedded` says whether the settings actually travelled. */
function stampResponse(embedded, bytes = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'X-Settings-Embedded' ? (embedded ? '1' : '0') : null) },
    blob: async () => bytes,
  };
}

async function loadExport() {
  return import('../src/lib/mediaExport.js');
}

test('a sealed output is never handed to the stamper', async () => {
  const { downloadMediaWithSettings } = await loadExport();
  // An envelope must not leave the vault's guard, and it certainly must not be
  // posted to a route that would save it under a name claiming it is a picture.
  const calls = serve({ mediaHeaders: SEALED, mediaBody: new Blob(['{}']), stamp: stampResponse(true) });
  const result = await downloadMediaWithSettings('/api/media-studio/generated/sealed.png', 'x.png', { prompt: 'a cat' });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(calls.stamp, null, 'ciphertext must never reach the stamping route');
});

test('the settings the studio recorded are what gets sent, plus a measured size', async () => {
  const { downloadMediaWithSettings } = await loadExport();
  const calls = serve({
    mediaHeaders: PLAIN_PNG,
    mediaBody: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
    stamp: stampResponse(true),
  });
  const result = await downloadMediaWithSettings(
    '/image/out.png', 'krea2-abc.png', { prompt: 'a cat', seed: 7, model: 'krea2' },
  );

  assert.equal(result.ok, true);
  assert.equal(result.embedded, true);
  assert.equal(calls.stamp.meta.prompt, 'a cat');
  assert.equal(calls.stamp.meta.seed, 7);
  // The file must carry the model-derived name: the stamper picks its container
  // from the extension, and the saved copy has to agree with downloadNames.js.
  assert.equal(calls.stamp.file.name, 'krea2-abc.png');
  assert.equal(lastSaved.download, 'krea2-abc.png', 'the stamped copy saves under the same name');
});

test('a size the caller already knows is not overwritten by a measurement', async () => {
  const { downloadMediaWithSettings } = await loadExport();
  const calls = serve({
    mediaHeaders: PLAIN_PNG,
    mediaBody: new Blob([new Uint8Array([1])], { type: 'image/png' }),
    stamp: stampResponse(true),
  });
  await downloadMediaWithSettings('/image/out.png', 'x.png', { prompt: 'p', size: '1024x1536' });
  assert.equal(calls.stamp.meta.size, '1024x1536');
});

test('a stamp that did not take is reported, not implied', async () => {
  const { downloadMediaWithSettings } = await loadExport();
  // No ffmpeg, no Pillow, a container that will not carry tags: the file is
  // still saved, and the studio has to be able to say the recipe did not travel.
  serve({
    mediaHeaders: { 'Content-Type': 'video/mp4' },
    mediaBody: new Blob([new Uint8Array([0, 0, 0, 24])], { type: 'video/mp4' }),
    stamp: stampResponse(false),
  });
  const result = await downloadMediaWithSettings('/video/clip.mp4', 'ltx-1.mp4', { prompt: 'p' });

  assert.equal(result.ok, true);
  assert.equal(result.embedded, false);
});

test('the size written into the file is measured from the pixels, not the record', async () => {
  const { downloadMediaWithSettings } = await loadExport();
  // The recorded aspect is a RATIO, an upscale changes the pixels without
  // changing it, and a lane can snap to its own buckets — so a Size line
  // derived from the record would be a claim, not a measurement.
  const calls = serve({
    mediaHeaders: { 'Content-Type': 'video/mp4' },
    mediaBody: new Blob([new Uint8Array([0, 0, 0, 24])], { type: 'video/mp4' }),
    stamp: stampResponse(true),
  });
  await downloadMediaWithSettings('/video/clip.mp4', 'ltx-1.mp4', { prompt: 'p' });
  assert.equal(calls.stamp.meta.size, '1280x720');
});

test('a stamping route that is not there does not lose the press silently', async () => {
  const { downloadMediaWithSettings } = await loadExport();
  serve({
    mediaHeaders: PLAIN_PNG,
    mediaBody: new Blob([new Uint8Array([1])], { type: 'image/png' }),
    stamp: { ok: false, status: 404, headers: { get: () => null }, blob: async () => new Blob([]) },
  });
  const result = await downloadMediaWithSettings('/image/out.png', 'x.png', { prompt: 'p' });

  assert.equal(result.ok, false);
  assert.equal(result.unreachable, true);
  assert.equal(result.blocked, false, 'a missing route is not an encryption refusal');
});

test('sharing sends the plain file — never the stamped one', async () => {
  const { shareMedia } = await loadExport();
  serve({
    mediaHeaders: PLAIN_PNG,
    mediaBody: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
    stamp: stampResponse(true),
  });
  let shared = null;
  withNavigator({
    canShare: () => true,
    share: async (payload) => { shared = payload; },
  });
  const result = await shareMedia('/image/out.png', 'krea2-abc.png');

  assert.equal(result.ok, true);
  assert.equal(shared.files.length, 1);
  assert.equal(shared.files[0].name, 'krea2-abc.png');
  // Deliberately textual: this is an ABSENCE claim over a whole function — that
  // shareMedia never reaches the stamper — and an absence cannot be rendered.
  // The behavioural half is above (what actually reached navigator.share); this
  // half is what stops a future edit from quietly adding the stamp back, which
  // no passing test would notice because a stamped share still shares.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src/lib/mediaExport.js'), 'utf8',
  );
  const share = source.slice(source.indexOf('export async function shareMedia'));
  assert.doesNotMatch(share, /STAMP_ENDPOINT|downloadMediaWithSettings/);
  clearNavigator();
});

test('a dismissed share sheet is an answer, not an error', async () => {
  const { shareMedia } = await loadExport();
  serve({
    mediaHeaders: PLAIN_PNG,
    mediaBody: new Blob([new Uint8Array([1])], { type: 'image/png' }),
    stamp: stampResponse(true),
  });
  withNavigator({
    canShare: () => true,
    share: async () => { const error = new Error('cancelled'); error.name = 'AbortError'; throw error; },
  });
  const result = await shareMedia('/image/out.png', 'x.png');

  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.failed, undefined, 'closing the sheet must not raise a red toast');
  clearNavigator();
});

test('a browser that can share links but not files reports unsupported', async () => {
  const { canShareMedia, shareMedia } = await loadExport();
  // Web Share level 1 without level 2: navigator.share exists and throws on files.
  withNavigator({ share: async () => {}, canShare: () => false });
  assert.equal(canShareMedia(), false);
  const result = await shareMedia('/image/out.png', 'x.png');
  assert.equal(result.unsupported, true);
  clearNavigator();
});

test('a sealed output is never handed to the share sheet either', async () => {
  const { shareMedia } = await loadExport();
  serve({ mediaHeaders: SEALED, mediaBody: new Blob(['{}']), stamp: stampResponse(true) });
  let shared = false;
  withNavigator({ canShare: () => true, share: async () => { shared = true; } });
  const result = await shareMedia('/api/media-studio/generated/sealed.mp4', 'x.mp4');

  assert.equal(result.blocked, true);
  assert.equal(shared, false, 'an envelope must not be handed to another app as a video');
  clearNavigator();
});

test('the unencrypted switch is per studio, and only for studios that have one', async () => {
  const prefs = await import('../src/lib/prefs.js');
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  prefs.forgetPrefsCache();

  assert.equal(prefs.allowsUnencryptedDownload('image'), false, 'off is the default');
  assert.equal(prefs.allowsUnencryptedDownload('video'), false);

  prefs.setAllowUnencryptedDownload('image', true);
  assert.equal(prefs.allowsUnencryptedDownload('image'), true);
  // Turning it on for reference sheets must not turn it on for the clips you
  // send to a group chat.
  assert.equal(prefs.allowsUnencryptedDownload('video'), false);

  // A typo must not quietly become a second setting nobody can find.
  assert.equal(prefs.setAllowUnencryptedDownload('imgae', true), false);
  assert.equal(prefs.allowsUnencryptedDownload('imgae'), false);

  prefs.setAllowUnencryptedDownload('image', false);
  assert.equal(prefs.allowsUnencryptedDownload('image'), false);
  delete global.localStorage;
});

test('the switch survives a reload, and a hand-edited document cannot invent studios', async () => {
  const prefs = await import('../src/lib/prefs.js');
  const store = new Map([[
    prefs.PREFS_KEY,
    JSON.stringify({ v: 1, unencryptedDownload: { video: true, cinema: true, image: 0 } }),
  ]]);
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  prefs.forgetPrefsCache();

  assert.equal(prefs.allowsUnencryptedDownload('video'), true);
  assert.equal(prefs.allowsUnencryptedDownload('image'), false, 'a falsy value is off');
  assert.equal(prefs.allowsUnencryptedDownload('cinema'), false, 'an unknown studio is dropped on read');
  delete global.localStorage;
});
