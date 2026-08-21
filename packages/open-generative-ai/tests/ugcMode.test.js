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
  isUgcReferenceBrief,
  readUgcScript,
  ugcClock,
  ugcFirstFramePrompt,
  ugcPeopleFor,
  ugcReferenceBrief,
  ugcSubjectLabel,
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

// A loaded persona's gender narrows the deal: the person dealt has to be the
// kind of person the attached pictures show, or the brief contradicts them.
test('a persona\'s gender picks the cast pool, and the cycle still never repeats a person', () => {
  assert.ok(ugcPeopleFor('female').every((person) => person.startsWith('a woman ')));
  assert.ok(ugcPeopleFor('male').every((person) => person.startsWith('a man ')));
  assert.equal(ugcPeopleFor('female').length + ugcPeopleFor('male').length, UGC_PEOPLE.length, 'the bank is split, not sampled');
  // Unset deals from the whole bank, exactly as before.
  assert.deepEqual(ugcPeopleFor(''), UGC_PEOPLE);
  for (let i = 0; i < 45; i += 1) {
    assert.ok(ugcVariantAt(i, { gender: 'male' }).person.startsWith('a man '), `deal ${i} is a man`);
    assert.notEqual(ugcVariantAt(i, { gender: 'male' }).person, ugcVariantAt(i + 1, { gender: 'male' }).person);
  }
  // The room and beat banks are untouched by the narrowing.
  assert.equal(ugcVariantAt(3, { gender: 'female' }).room, ugcVariantAt(3).room);
  assert.deepEqual(ugcVariantAt(3, { gender: 'female' }).beats, ugcVariantAt(3).beats);
  // The brief carries the narrowed person.
  assert.match(ugcVideoBrief(ugcVariantAt(0, { gender: 'male' })), /^Subject: a man /m);
});

test('a non-binary persona is dealt the whole bank with its gendered words neutralised', () => {
  const people = ugcPeopleFor('nonbinary');
  assert.equal(people.length, UGC_PEOPLE.length);
  assert.ok(people.every((person) => person.startsWith('a person in their ')), people.join(' | '));
  assert.ok(people.every((person) => !/\b(woman|man|her|his)\b/.test(person)), 'no gendered word survives');
});

// ---------------------------------------------------------------------------
// UGC about the person in the attached pictures.

test("with reference pictures attached the brief is the person in them, in H3's reference frame", () => {
  const persona = { name: 'Cheryl', gender: 'female', images: ['/a.jpg', '/b.jpg', '/c.jpg'], videos: [], audios: [{ url: '/v.m4a' }] };
  const out = applyUgcVideoBrief('selling a sleep tracker', ugcVariantAt(0), { durationSeconds: 15, persona });
  assert.deepEqual(
    out.split('\n').filter((line) => /^[a-z_]+:$/.test(line)),
    ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:'],
  );
  // The subject is the pictures — the same sentence the reference scaffold
  // writes — and no dealt person survives.
  assert.match(out, /<Subject 1> is the woman shown in <Picture 1> through <Picture 3>: \[hair, face/);
  assert.doesNotMatch(out, /a woman in her|a man in his|messy bun/);
  // The voice clip is bound, the audio contract is declared, every reference
  // has its retention line.
  assert.match(out, /<Subject 1> speaks as S1\.\n<Audio 1> is the voice-timbre reference for <Subject 1> \(S1\)/);
  assert.match(out, /^\[audio reference\] UGC — a real person filming themselves/m);
  assert.match(out, /<Subject 1>: fully_preserved/);
  assert.match(out, /<Picture 1>: fully_preserved/);
  assert.match(out, /<Picture 3>: fully_preserved/);
  assert.match(out, /<Audio 1>: reference/);
  // The script is (S1) dialogue inside timed shots, sized to the clip.
  assert.match(out, /\[Shot 1\] HOOK 0:00–0:03 \(already mid-sentence, as if we joined late\): \(S1\) says: <d>\[English\] ⟨your opening line⟩<\/d>/);
  assert.match(out, /\[Shot 2\] At 00:03\.000, BODY 0:03–0:12 .*: \(S1\) says: <d>\[English\] ⟨the rest of what they say⟩<\/d>/);
  assert.match(out, /\[Shot 3\] At 00:12\.000, CTA 0:12–0:15 .*: \(S1\) says: <d>\[English\] ⟨your closing line⟩<\/d>/);
  // What the composer held is the topic, not a paragraph stranded above the frame.
  assert.match(out, /^Topic: selling a sleep tracker$/m);
  assert.doesNotMatch(out, /^selling a sleep tracker/);
  // Nobody else talks, and the frame ends the way H3 wants.
  assert.match(out, /No other speakers, no speech before the hook or after the CTA\. No music\./);
  assert.match(out, /non_diegetic_music:\nN\/A$/);
  assert.ok(hasUgcVideoBrief(out) && isUgcReferenceBrief(out));
  // The dealt room still varies per arm — that is the batch.
  assert.ok(out.includes(ugcVariantAt(0).room.light) && out.includes(ugcVariantAt(0).room.sound));
  assert.ok(!out.includes(ugcVariantAt(1).room.light));
});

// A persona holding only a clip is still a real person to make the brief about:
// the clip is the character reference (MiniMax binds subjects to videos), so it
// gets the reference brief rather than a dealt stranger, and the Who row names it.
test('a persona with only a clip gets the reference brief, about the person in the clip', () => {
  const persona = { name: 'Liam', gender: 'male', images: [], videos: [{ url: '/liam.mov', useAudio: false }], audios: [] };
  const out = applyUgcVideoBrief('selling a sleep tracker', ugcVariantAt(0), { durationSeconds: 15, persona });
  assert.match(out, /^subject_definitions:/m);
  assert.match(out, /<Subject 1> is the man shown in <Video 1>: \[hair, face/);
  assert.match(out, /<Video 1>: fully_preserved — <Subject 1> IS the person in this clip/);
  assert.doesNotMatch(out, /a woman in her|a man in his|messy bun/);
  assert.equal(ugcSubjectLabel(persona), 'Liam — the man in your reference clip');
  assert.equal(ugcSubjectLabel({ images: [], videos: [], audios: [] }), '');
});

test('the reference brief keeps a written script across re-deals and reads back clean', () => {
  const persona = { gender: 'male', images: ['/a.jpg'], videos: [], audios: [] };
  const armed = applyUgcVideoBrief('', ugcVariantAt(0), { durationSeconds: 15, persona })
    .replace(UGC_HOOK_PLACEHOLDER, 'no but the WEIRD part is');
  assert.deepEqual(readUgcScript(armed), { hook: 'no but the WEIRD part is', body: '', cta: '' });
  const redealt = applyUgcVideoBrief(armed, ugcVariantAt(1), { durationSeconds: 15, persona });
  assert.match(redealt, /<d>\[English\] no but the WEIRD part is<\/d>/);
  assert.ok(redealt.includes(ugcVariantAt(1).room.light) && !redealt.includes(ugcVariantAt(0).room.light));
  assert.equal(redealt.match(/^subject_definitions:/gm).length, 1, 'not stacked');
  assert.equal(redealt.match(/^Topic:/gm), null, 'an empty composer adds no topic line');
  // One picture, no voice clip: the noun and the kind of voice come from the gender.
  assert.match(redealt, /<Subject 1> is the man shown in <Picture 1>/);
  assert.match(redealt, /<Subject 1> speaks as S1, in a man's voice\./);
  assert.doesNotMatch(redealt, /<Audio 1>/);
  // Off: the brief was the whole prompt, so nothing is left, and it is not a brief any more.
  assert.equal(applyUgcVideoBrief(redealt, null), '');
  assert.equal(hasUgcVideoBrief(applyUgcVideoBrief(redealt, null)), false);
  // A shorter clip re-times the shots and keeps the words.
  const shorter = applyUgcVideoBrief(redealt, ugcVariantAt(1), { durationSeconds: 10, persona });
  assert.match(shorter, /\[Shot 3\] At 00:08\.000, CTA 0:08–0:10/);
  assert.ok(shorter.includes('no but the WEIRD part is'));
});

test('a persona without pictures is no identity source — the flat block is dealt, from the gender', () => {
  const flat = applyUgcVideoBrief('idea', ugcVariantAt(0, { gender: 'male' }), {
    durationSeconds: 15, persona: { name: 'Marco', gender: 'male', images: [], videos: [], audios: [] },
  });
  assert.ok(flat.startsWith('idea'));
  assert.match(flat, /^Subject: a man /m);
  assert.equal(isUgcReferenceBrief(flat), false);
  // And a brief already in the composer is recognised and replaced, never
  // appended to, when the pictures are there.
  const persona = { gender: 'female', images: ['/a.jpg'], videos: [], audios: [] };
  const over = applyUgcVideoBrief(flat, ugcVariantAt(2), { durationSeconds: 15, persona });
  assert.equal(over.match(/UGC — a real person/g).length, 1);
  assert.match(over, /^Topic: idea$/m);
  // A six-section prompt already there (a cast) is not carried as a topic.
  const castLike = 'subject_definitions:\n<Subject 1> is x.\n\nsummary:\ny\n\ndetailed_description:\nz';
  assert.doesNotMatch(applyUgcVideoBrief(castLike, ugcVariantAt(2), { durationSeconds: 15, persona }), /^Topic:/m);
});

test('ugcSubjectLabel names the person the brief will be about', () => {
  assert.equal(ugcSubjectLabel({ name: 'Cheryl', gender: 'female', images: ['/a', '/b', '/c'] }), 'Cheryl — the woman in your 3 reference pictures');
  assert.equal(ugcSubjectLabel({ gender: '', images: ['/a'] }), 'the person in your reference picture');
  assert.equal(ugcSubjectLabel({ name: 'Sam', gender: 'nonbinary', images: ['/a', '/b'] }), 'Sam — the person in your 2 reference pictures');
  assert.equal(ugcSubjectLabel({ name: 'Marco', gender: 'male', images: [] }), '');
  assert.equal(ugcSubjectLabel(null), '');
  // The brief builder itself is reachable for callers that hold the pieces.
  assert.match(ugcReferenceBrief(ugcVariantAt(0), { durationSeconds: 8, persona: { images: ['/a'] } }), /^subject_definitions:/);
});
