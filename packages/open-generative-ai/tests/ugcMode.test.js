import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UGC_BEATS,
  UGC_BODY_PLACEHOLDER,
  UGC_HOOK_PLACEHOLDER,
  UGC_PEOPLE,
  UGC_ROOMS,
  applyUgcFirstFrame,
  applyUgcVideoBrief,
  hasUgcFirstFrame,
  hasUgcVideoBrief,
  readUgcScript,
  ugcClock,
  ugcFirstFramePrompt,
  ugcTimeline,
  ugcVariantAt,
  ugcVideoBrief,
} from '../src/lib/ugcMode.js';

test('a deal names a person, a room with a named light, and two or three beats', () => {
  const cast = ugcVariantAt(0);
  assert.ok(UGC_PEOPLE.includes(cast.person));
  assert.ok(UGC_ROOMS.includes(cast.room));
  assert.ok(cast.room.light && cast.room.detail && cast.room.sound);
  assert.ok(cast.beats.length >= 2 && cast.beats.length <= 3);
  cast.beats.forEach((beat) => assert.ok(UGC_BEATS.includes(beat)));
});

test('consecutive deals never repeat the person, the room, or the whole beat set', () => {
  // Repetition across a batch is the tell the whole feature exists to avoid, so
  // this is the load-bearing property — checked across a full pairing cycle.
  for (let i = 0; i < 90; i += 1) {
    const a = ugcVariantAt(i);
    const b = ugcVariantAt(i + 1);
    assert.notEqual(a.person, b.person, `person repeated between deal ${i} and ${i + 1}`);
    assert.notEqual(a.room, b.room, `room repeated between deal ${i} and ${i + 1}`);
    assert.notDeepEqual(a.beats, b.beats, `beats repeated between deal ${i} and ${i + 1}`);
  }
});

test('a person and a room pair up 90 different ways before repeating', () => {
  const seen = new Set();
  for (let i = 0; i < 90; i += 1) {
    const cast = ugcVariantAt(i);
    seen.add(`${UGC_PEOPLE.indexOf(cast.person)}/${UGC_ROOMS.indexOf(cast.room)}`);
  }
  assert.equal(seen.size, 90);
  assert.equal(ugcVariantAt(90).person, ugcVariantAt(0).person);
});

test('the 15s timeline is the guide shape: hook 0-3, body 3-12, CTA 12-15', () => {
  assert.deepEqual(ugcTimeline(15), { seconds: 15, hookEnd: 3, ctaStart: 12, hasBody: true });
});

test('a short clip keeps the shape rather than running off the end', () => {
  const five = ugcTimeline(5);
  assert.equal(five.hookEnd, 1);
  assert.equal(five.ctaStart, 4);
  assert.ok(five.ctaStart < five.seconds);
  // Ten seconds still holds a body beat; the guide's proportions scale.
  assert.deepEqual(ugcTimeline(10), { seconds: 10, hookEnd: 2, ctaStart: 8, hasBody: true });
});

test('clip lengths with no room for a body beat say so', () => {
  const tiny = ugcTimeline(2);
  assert.equal(tiny.hasBody, false);
  assert.ok(!ugcVideoBrief(ugcVariantAt(0), { durationSeconds: 2 }).includes('BODY'));
});

test('the brief carries the clip length into its beat timings', () => {
  const brief = ugcVideoBrief(ugcVariantAt(3), { durationSeconds: 15 });
  assert.ok(brief.includes('HOOK 0:00–0:03'));
  assert.ok(brief.includes('BODY 0:03–0:12'));
  assert.ok(brief.includes('CTA 0:12–0:15'));
  assert.ok(brief.includes('No music.'));
  assert.ok(brief.includes(UGC_HOOK_PLACEHOLDER));
});

test('clock formats past a minute without breaking', () => {
  assert.equal(ugcClock(0), '0:00');
  assert.equal(ugcClock(9), '0:09');
  assert.equal(ugcClock(75), '1:15');
});

test('arming appends the block and keeps what the composer already held', () => {
  const armed = applyUgcVideoBrief('selling a sleep tracker', ugcVariantAt(0), { durationSeconds: 15 });
  assert.ok(armed.startsWith('selling a sleep tracker'));
  assert.ok(hasUgcVideoBrief(armed));
});

test('re-arming replaces the block instead of stacking it', () => {
  const once = applyUgcVideoBrief('idea', ugcVariantAt(0), { durationSeconds: 15 });
  const twice = applyUgcVideoBrief(once, ugcVariantAt(1), { durationSeconds: 15 });
  assert.equal(twice.match(/^UGC — /gm).length, 1);
  assert.ok(twice.includes(ugcVariantAt(1).person));
  assert.ok(!twice.includes(ugcVariantAt(0).person));
  assert.ok(twice.startsWith('idea'));
});

test('re-dealing the cast keeps a script written into the block', () => {
  // The point of a batch: the words stay, the person and room change. Without
  // this, dealing a new cast would cost the user everything they wrote.
  const armed = applyUgcVideoBrief('', ugcVariantAt(0), { durationSeconds: 15 })
    .replace(UGC_HOOK_PLACEHOLDER, 'no but the WEIRD part is')
    .replace(UGC_BODY_PLACEHOLDER, 'like I genuinely thought it was broken');
  const redealt = applyUgcVideoBrief(armed, ugcVariantAt(1), { durationSeconds: 15 });
  assert.ok(redealt.includes('no but the WEIRD part is'));
  assert.ok(redealt.includes('like I genuinely thought it was broken'));
  assert.ok(redealt.includes(ugcVariantAt(1).person));
  // The line they never wrote is still a placeholder, not an empty label.
  assert.ok(redealt.includes('⟨your closing line⟩'));
});

test('changing the clip length re-times a written script without losing it', () => {
  const armed = applyUgcVideoBrief('', ugcVariantAt(2), { durationSeconds: 15 })
    .replace(UGC_HOOK_PLACEHOLDER, 'ok so');
  const shorter = applyUgcVideoBrief(armed, ugcVariantAt(2), { durationSeconds: 10 });
  assert.ok(shorter.includes('CTA 0:08–0:10'));
  assert.ok(shorter.includes('ok so'));
});

test('reading a script ignores the placeholders', () => {
  const armed = ugcVideoBrief(ugcVariantAt(0), { durationSeconds: 15 });
  assert.deepEqual(readUgcScript(armed), { hook: '', body: '', cta: '' });
  assert.equal(readUgcScript(armed.replace(UGC_HOOK_PLACEHOLDER, 'wait what')).hook, 'wait what');
});

test('turning UGC off leaves the rest of the prompt intact', () => {
  const armed = applyUgcVideoBrief('a woman talks about her sleep tracker', ugcVariantAt(4), {
    durationSeconds: 15,
  });
  assert.equal(applyUgcVideoBrief(armed, null), 'a woman talks about her sleep tracker');
  assert.equal(hasUgcVideoBrief(applyUgcVideoBrief(armed, null)), false);
});

test('the first-frame stack names a light source and refuses the polish words', () => {
  const prompt = ugcFirstFramePrompt(ugcVariantAt(5));
  assert.ok(prompt.startsWith('Ultra realistic iPhone front camera selfie.'));
  assert.ok(prompt.includes('visible pores'));
  assert.ok(prompt.includes('9:16'));
  assert.ok(prompt.includes(ugcVariantAt(5).room.light));
  for (const banned of ['cinematic', 'good lighting', 'professional', '8k']) {
    assert.ok(!prompt.toLowerCase().includes(banned), `first frame should not say "${banned}"`);
  }
});

test('the image block is idempotent and reversible too', () => {
  const once = applyUgcFirstFrame('a sleep tracker on a nightstand', ugcVariantAt(0));
  const twice = applyUgcFirstFrame(once, ugcVariantAt(1));
  assert.equal(twice.match(/Ultra realistic iPhone front camera selfie\./g).length, 1);
  assert.equal(applyUgcFirstFrame(twice, null), 'a sleep tracker on a nightstand');
});

test('whether UGC is on is read from the prompt, not a flag beside it', () => {
  // "Start fresh", loading a saved prompt and restoring a generation's settings
  // all replace the prompt without knowing about UGC. Reading the block back is
  // what stops the chip claiming a cast the composer no longer holds.
  const armed = applyUgcVideoBrief('idea', ugcVariantAt(0), { durationSeconds: 15 });
  assert.equal(hasUgcVideoBrief(armed), true);
  assert.equal(hasUgcVideoBrief('a totally different prompt'), false);
  assert.equal(hasUgcVideoBrief(''), false);

  const framed = applyUgcFirstFrame('idea', ugcVariantAt(0));
  assert.equal(hasUgcFirstFrame(framed), true);
  assert.equal(hasUgcFirstFrame(armed), false, 'the video block is not a first frame');
});
