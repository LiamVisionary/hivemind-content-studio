// UGC mode — the two-prompt "accidental content" workflow, as composer scaffold.
//
// A UGC ad is two prompts, not one: a first frame that looks like a phone photo,
// then a clip that behaves like someone talking to their own camera. The studio
// already has exactly those two composers, so UGC lives in both rather than in a
// studio of its own.
//
// The thing this can do that a chat prompt cannot is REMEMBER. Repetition across
// a batch — same face, same room, same light, same little gestures — is the
// single loudest tell that a set of clips came off a production line, so arming
// UGC deals a cast (person, room, named light source, one imperfect detail, one
// ambient sound, two or three behavioural beats) and every re-arm deals a
// different one. The banks are different lengths on purpose: person and room
// pair up 90 different ways before either combination comes round again.
//
// Same transparency contract as camera motions and the chain scaffold: the text
// lands in the prompt where it can be read and edited, and re-arming replaces it
// instead of stacking. Re-arming carries the SCRIPT across — swapping the cast
// while keeping the words is the whole point of a batch — so the block is found
// by its opening and closing lines rather than by exact match, and survives the
// user writing their lines into the middle of it.

import { referenceLabels, referenceSubjectLine, referenceVoiceLabel, withReferenceTags } from './h3References.js';
import { normalizePersonaGender, personaGenderWords } from './personaId.js';

export const UGC_PEOPLE = Object.freeze([
  'a woman in her mid-20s with a messy bun, an oversized grey hoodie, no makeup',
  'a man in his early 30s with two-day stubble, a stretched-out band t-shirt, hair still wet',
  'a woman in her late 30s in a work blouse with the top button undone, reading glasses pushed up into her hair',
  'a man in his mid-20s in a hoodie with uneven drawstrings, a work lanyard still round his neck',
  'a woman in her early 20s with box braids, a cropped college sweatshirt, one earbud in',
  'a man in his 40s in a paint-flecked work shirt, forearms tanned to the sleeve line',
  'a woman in her early 30s in scrubs with her ID badge flipped backwards, hair flattened where a cap sat',
  'a man in his late 20s in a puffer jacket zipped to the chin, beanie pushed back off his forehead',
  'a woman in her mid-40s in a cardigan over a pyjama top, glasses on a chain',
  'a man in his early 20s with a buzz cut growing out, a thrifted flannel over a plain tee',
]);

// Each room carries what the realism stack actually needs: a NAMED light source
// (never "good lighting"), one imperfect detail, and one thing the microphone
// can hear. Nine of them against ten people is what makes the pairing cycle long.
export const UGC_ROOMS = Object.freeze([
  {
    place: 'in the driver\'s seat of a parked car',
    light: 'late-afternoon sun coming through the windshield from the left',
    detail: 'A parking receipt has curled up on the dashboard.',
    sound: 'a car door shutting somewhere across the lot',
  },
  {
    place: 'leaning against a kitchen counter',
    light: 'the range hood light overhead, the window behind going blue',
    detail: 'The dish rack is still full from last night.',
    sound: 'the fridge compressor kicking on',
  },
  {
    place: 'sitting on the bedroom floor with their back against the bed',
    light: 'a warm bedside lamp behind and to the right',
    detail: 'A pile of folded laundry has clearly been there for days.',
    sound: 'a phone buzzing face-down on the floor',
  },
  {
    place: 'sitting on the edge of the bath',
    light: 'the overhead vanity strip, hard and slightly green',
    detail: 'A towel is hooked over the door and never made it to the rail.',
    sound: 'the extractor fan running',
  },
  {
    place: 'at an office desk after everyone has gone',
    light: 'one desk lamp low and warm, the ceiling lights already off',
    detail: 'A monitor behind them still shows a half-written message.',
    sound: 'an air-conditioning unit cycling',
  },
  {
    place: 'half-sitting on the stairs in a hallway',
    light: 'a landing window above throwing light down the stairwell',
    detail: 'One shoe lies on its side against the skirting board.',
    sound: 'a television playing two rooms away',
  },
  {
    place: 'hunched into a jacket on a balcony',
    light: 'flat grey overcast daylight, the street below out of focus',
    detail: 'Two dead plants sit beside a full ashtray.',
    sound: 'a bus pulling away below',
  },
  {
    place: 'on a couch with the phone propped on one knee',
    light: 'a television off-camera to the left throwing changing light',
    detail: 'A blanket is still bunched where somebody else was sitting.',
    sound: 'a neighbour\'s door closing',
  },
  {
    place: 'in the back seat of a rideshare',
    light: 'streetlights sliding across their face through the window',
    detail: 'A charger cable swings from the front seat.',
    sound: 'the indicator ticking',
  },
]);

export const UGC_BEATS = Object.freeze([
  'glances away mid-thought and comes back',
  'leans back and lets their shoulders drop',
  'shrugs once, small, without finishing the thought',
  'moves the phone to the other hand and re-frames',
  'reacts to a sound off-camera before carrying on',
  'half-laughs at their own sentence',
]);

export const UGC_HOOK_PLACEHOLDER = '⟨your opening line⟩';
export const UGC_BODY_PLACEHOLDER = '⟨the rest of what they say⟩';
export const UGC_CTA_PLACEHOLDER = '⟨your closing line⟩';

const VIDEO_OPENING = 'UGC — a real person filming themselves on their own phone, not an ad.';
const VIDEO_CLOSING = 'End unresolved — no payoff, no lesson, no slogan.';
const IMAGE_OPENING = 'Ultra realistic iPhone front camera selfie.';
const IMAGE_CLOSING = 'no text, no captions, 9:16.';

// The bank alternates women and men, so a loaded persona's gender picks every
// other entry and the cycle still never repeats a person on consecutive deals.
// Non-binary has no bank of its own: the whole bank is dealt with its gendered
// words neutralised, since "a woman in her mid-20s" would be a lie about the
// person in the pictures just as much as the wrong pronoun in a prompt is.
const PERSON_GENDER = /^a (woman|man) in (her|his) /;

export function ugcPeopleFor(gender) {
  const which = normalizePersonaGender(gender);
  if (which === 'female') return UGC_PEOPLE.filter((person) => /^a woman /.test(person));
  if (which === 'male') return UGC_PEOPLE.filter((person) => /^a man /.test(person));
  if (which === 'nonbinary') {
    return UGC_PEOPLE.map((person) => person
      .replace(PERSON_GENDER, 'a person in their ')
      // The bank's later possessives ("reading glasses pushed up into her
      // hair", "beanie pushed back off his forehead") are all determiners.
      .replace(/\b(her|his)\b/g, 'their'));
  }
  return UGC_PEOPLE;
}

/**
 * The cast for arm number `index`, cycling without repeating a pairing soon.
 * `gender` (a saved persona's) narrows who can be dealt — see ugcPeopleFor.
 */
export function ugcVariantAt(index, { gender = '' } = {}) {
  const n = Math.max(0, Math.floor(Number(index) || 0));
  const people = ugcPeopleFor(gender);
  const person = people[n % people.length];
  const room = UGC_ROOMS[n % UGC_ROOMS.length];
  // Two beats or three, alternating, taken from a window that walks the bank —
  // so consecutive arms share at most one gesture.
  const count = 2 + (n % 2);
  const beats = [];
  for (let step = 0; step < count; step += 1) {
    beats.push(UGC_BEATS[(n * 2 + step) % UGC_BEATS.length]);
  }
  return { index: n, person, room, beats: Object.freeze(beats) };
}

/** 3 -> "0:03". Whole seconds only; every boundary below lands on one. */
export function ugcClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * Hook / body / CTA boundaries for a clip of this length.
 *
 * The guide's 15-second shape is hook 0-3, body 3-12, CTA 12-15 — the first and
 * last fifth. Held as a ratio so a 5s clip gets the same shape rather than a
 * timeline that runs off the end of it, and capped at three seconds because a
 * hook longer than that is no longer a hook.
 */
export function ugcTimeline(durationSeconds) {
  const seconds = Math.max(1, Math.round(Number(durationSeconds) || 15));
  const hookEnd = clamp(Math.round(seconds * 0.2), 1, 3);
  const ctaStart = seconds - clamp(Math.round(seconds * 0.2), 1, 3);
  return {
    seconds,
    hookEnd,
    ctaStart,
    // Under about six seconds the hook and the CTA meet and there is nowhere to
    // put a script. Worth saying out loud rather than rendering a body beat of
    // zero length.
    hasBody: ctaStart > hookEnd,
  };
}

// Anchored on the "):" that closes each label's parenthetical rather than on
// the first colon — the timings ("HOOK 0:00–0:03") carry colons of their own,
// and the script itself may too. Lazy, so a colon in the script cannot capture.
// In the reference brief the same three lines sit inside H3 shots —
// "[Shot 2] At 00:03.000, BODY …" — so the shot header is an optional prefix.
const SCRIPT_LINE = /^(?:\[Shot \d+\] (?:At \d{2}:\d{2}\.\d{3}, )?)?(HOOK|BODY|CTA)\b[^\n]*?\):[ \t]*(.*)$/;
// The reference brief writes each line as (S1) dialogue; reading it back
// unwraps the speaker and the <d>[language] …</d> so the words round-trip.
const SPOKEN_LINE = /^\(S\d\) says: <d>(?:\[[^\]]*\]\s*)?([\s\S]*?)<\/d>\s*$/;
const PLACEHOLDERS = new Set([UGC_HOOK_PLACEHOLDER, UGC_BODY_PLACEHOLDER, UGC_CTA_PLACEHOLDER]);

/**
 * The three script lines already written into a prompt, if any.
 *
 * This is what makes re-arming useful instead of destructive: swapping the cast
 * is a batch action, and the script is the thing that stays the same across a
 * batch. A line still holding its placeholder counts as unwritten.
 */
export function readUgcScript(prompt) {
  const script = { hook: '', body: '', cta: '' };
  for (const line of String(prompt || '').split('\n')) {
    const match = SCRIPT_LINE.exec(line);
    if (!match) continue;
    let text = match[2].trim();
    const spoken = SPOKEN_LINE.exec(text);
    if (spoken) text = spoken[1].trim();
    if (text && !PLACEHOLDERS.has(text)) script[match[1].toLowerCase()] = text;
  }
  return script;
}

/** The UGC block for a video prompt: cast, framing, timeline, beats. */
export function ugcVideoBrief(variant, { durationSeconds, script } = {}) {
  const cast = variant || ugcVariantAt(0);
  const { room } = cast;
  const { hookEnd, ctaStart, seconds, hasBody } = ugcTimeline(durationSeconds);
  const lines = [
    VIDEO_OPENING,
    `Subject: ${cast.person}, ${room.place}. Match the reference frame exactly.`,
    `Place: ${room.light}. ${room.detail}`,
    'Camera: handheld front-camera selfie, chest-up, natural micro shakes, 9:16.',
    `Audio: phone-mic voice with room tone and one ambient sound event — ${room.sound}. No music.`,
    `HOOK ${ugcClock(0)}–${ugcClock(hookEnd)} (already mid-sentence, as if we joined late): `
      + `${script?.hook || UGC_HOOK_PLACEHOLDER}`,
  ];
  if (hasBody) {
    lines.push(
      `BODY ${ugcClock(hookEnd)}–${ugcClock(ctaStart)} (natural blinks, one gaze break, one filler word, `
      + `one micro pause; the body shifts once): ${script?.body || UGC_BODY_PLACEHOLDER}`,
    );
  }
  lines.push(
    `CTA ${ugcClock(ctaStart)}–${ugcClock(seconds)} (an afterthought, trailing off — never a slogan): `
    + `${script?.cta || UGC_CTA_PLACEHOLDER}`,
    `Behavioural beats: ${cast.beats.join('; ')}.`,
    'Keep the skin texture, no beauty filter, lips synced.',
    VIDEO_CLOSING,
  );
  return lines.join('\n');
}

/** The UGC block for a first-frame image prompt: the realism stack. */
export function ugcFirstFramePrompt(variant) {
  const cast = variant || ugcVariantAt(0);
  const { room } = cast;
  return [
    `${IMAGE_OPENING} ${cast.person}, ${room.place}, ${room.light}. ${room.detail}`,
    'Candid mid-sentence expression, eyes off the lens, one hand raised while talking.',
    'Real skin texture with visible pores and light under-eye shadows, no beauty filter.',
    `Shallow depth of field, authentic phone-vlog aesthetic, ${IMAGE_CLOSING}`,
  ].join(' ');
}

/**
 * Cut a previously applied block out, from its opening line through its closing
 * one. Anchored rather than matched whole so an edited block — which is the
 * normal case, the user writes their script into it — still comes out cleanly.
 */
function stripBlock(prompt, opening, closing) {
  const source = String(prompt || '');
  const start = source.indexOf(opening);
  if (start < 0) return source.trim();
  const closeAt = source.indexOf(closing, start);
  const end = closeAt < 0 ? source.length : closeAt + closing.length;
  return `${source.slice(0, start)}${source.slice(end)}`.replace(/\n{3,}/g, '\n\n').trim();
}

// The reference brief (below) is not a block inside a prompt — it IS the
// prompt, six sections of it. Turning UGC off therefore leaves nothing behind,
// exactly as nothing was there before it was armed over an empty composer; a
// topic line the composer held is carried inside the brief and comes back out
// only by arming again.
const SIX_SECTION = /^subject_definitions:/m;

export function isUgcReferenceBrief(prompt) {
  const source = String(prompt || '');
  return SIX_SECTION.test(source) && source.includes(VIDEO_OPENING) && source.includes(VIDEO_CLOSING)
    && /^non_diegetic_music:/m.test(source);
}

export function stripUgcVideoBrief(prompt) {
  if (isUgcReferenceBrief(prompt)) return '';
  return stripBlock(prompt, VIDEO_OPENING, VIDEO_CLOSING);
}

export function stripUgcFirstFrame(prompt) {
  return stripBlock(prompt, IMAGE_OPENING, IMAGE_CLOSING);
}

// Whether UGC is on is a property of the PROMPT, not of a flag beside it.
// "Start fresh", loading a saved prompt, or restoring a generation's settings
// all replace the prompt without knowing about UGC — reading the block back is
// what keeps the chip from claiming a cast the composer no longer holds.
export function hasUgcVideoBrief(prompt) {
  return String(prompt || '').includes(VIDEO_OPENING);
}

export function hasUgcFirstFrame(prompt) {
  return String(prompt || '').includes(IMAGE_OPENING);
}

// ---------------------------------------------------------------------------
// UGC with reference pictures attached.
//
// A dealt person is for a batch with NO identity source. When pictures are
// attached — a loaded Hive Persona, or references by hand — the person in the
// clip is the person in the pictures, and the only way pictures reach the model
// is H3's reference mode, whose trained format is the six-section frame. So the
// brief is written IN that frame: <Subject 1> bound to <Picture N> (the same
// sentence the reference scaffold writes), the hook / body / CTA as (S1)
// dialogue in <d> lines, the voice clip bound as the timbre reference, and
// "nobody else speaks" in the soundscape. A flat block with a decorated Subject
// line would have gone to the model as prose — and a voice reference with
// unscripted seconds is exactly how a clip fills itself with invented speech
// (measured 2026-08-12).
//
// The room, its light, the ambient sound and the behavioural beats still deal
// per arm. That is the batch's variety; only the person is pinned.

const shotStamp = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.000`;
const spoken = (text) => `(S1) says: <d>[English] ${text}</d>`;

/** "Cheryl — the woman in your 3 reference pictures", for the menu's Who row. */
export function ugcSubjectLabel(persona) {
  const count = (persona?.images || []).length;
  const clips = (persona?.videos || []).length;
  if (!count && !clips) return '';
  const gender = normalizePersonaGender(persona?.gender);
  const noun = gender && gender !== 'nonbinary' ? personaGenderWords(gender).noun : 'person';
  // No picture: the clip is the character reference, so it is who the brief is about.
  const pictures = !count
    ? 'your reference clip'
    : (count === 1 ? 'your reference picture' : `your ${count} reference pictures`);
  const name = String(persona?.name || '').trim();
  return `${name ? `${name} — ` : ''}the ${noun} in ${pictures}`;
}

/**
 * The UGC brief for a clip about the person in the attached pictures, in H3's
 * six-section reference format. `persona` is { name?, gender?, images, videos,
 * audios } — the reference rows as the studio holds them. `context` is what
 * the composer held before arming (the topic), carried into the shot.
 */
export function ugcReferenceBrief(variant, { durationSeconds, script, persona, context = '' } = {}) {
  const cast = variant || ugcVariantAt(0);
  const { room } = cast;
  const { hookEnd, ctaStart, seconds, hasBody } = ugcTimeline(durationSeconds);
  const images = persona?.images || [];
  const videos = persona?.videos || [];
  const audios = persona?.audios || [];
  const gender = normalizePersonaGender(persona?.gender);
  const labels = referenceLabels({ images, videos, audios });
  const voice = referenceVoiceLabel(labels);
  const noun = gender && gender !== 'nonbinary' ? personaGenderWords(gender).noun : '';

  const subject = [
    referenceSubjectLine({
      pictures: labels.images, videos: labels.videos.map((label) => label.video).filter(Boolean), gender, look: persona?.look || '',
    }),
    '<Subject 1> is rendered as photoreal live-action, real human skin texture and hair, shot on a phone front camera — not illustrated, not stylised, no beauty filter.',
  ];
  if (voice) {
    subject.push('<Subject 1> speaks as S1.');
    subject.push(`${voice} is the voice-timbre reference for <Subject 1> (S1). It is not the voice of anyone else in this clip.`);
  } else {
    // No clone to bind: at least say what kind of voice, or H3 gives an
    // unvoiced subject its generic adult male.
    subject.push(`<Subject 1> speaks as S1${noun ? `, in a ${noun}'s voice` : ''}.`);
  }

  const shots = [
    `[Shot 1] HOOK ${ugcClock(0)}–${ugcClock(hookEnd)} (already mid-sentence, as if we joined late): ${spoken(script?.hook || UGC_HOOK_PLACEHOLDER)}`,
  ];
  if (hasBody) {
    shots.push(
      `[Shot 2] At ${shotStamp(hookEnd)}, BODY ${ugcClock(hookEnd)}–${ugcClock(ctaStart)} (natural blinks, one gaze break, one filler word, `
      + `one micro pause; the body shifts once): ${spoken(script?.body || UGC_BODY_PLACEHOLDER)}`,
    );
  }
  shots.push(
    `[Shot ${hasBody ? 3 : 2}] At ${shotStamp(ctaStart)}, CTA ${ugcClock(ctaStart)}–${ugcClock(seconds)} (an afterthought, trailing off — never a slogan): `
    + spoken(script?.cta || UGC_CTA_PLACEHOLDER),
  );

  const topic = String(context || '').trim();
  const brief = [
    'subject_definitions:',
    ...subject,
    '',
    'summary:',
    // The audio contract up front when a voice is attached — the same tag the
    // Cast control writes, on the summary's own line rather than above it.
    `${voice ? '[audio reference] ' : ''}${VIDEO_OPENING} <Subject 1> talks to the front camera of a phone held at arm's length, ${room.place}, for the whole clip; nobody else is in the shot.`,
    '',
    'retention_analysis:',
    '<Subject 1>: fully_preserved — the same face, hair, build and wardrobe in every shot and at every distance.',
    '',
    'detailed_description:',
    ...(topic ? [`Topic: ${topic}`] : []),
    `Camera: handheld front-camera selfie, chest-up, natural micro shakes, 9:16. Place: ${room.light}. ${room.detail}`,
    ...shots,
    `Behavioural beats: ${cast.beats.join('; ')}. Keep the skin texture, no beauty filter, lips synced.`,
    VIDEO_CLOSING,
    '',
    'overall_soundscape:',
    `Phone-mic voice of <Subject 1> (S1) with room tone and one ambient sound event — ${room.sound}. No other speakers, no speech before the hook or after the CTA. No music.`,
    '',
    'non_diegetic_music:',
    'N/A',
  ].join('\n');
  // The retention contract for every attached reference, and the [audio
  // reference] summary tag when a voice is attached — written by the same code
  // that writes them for a hand-scaffolded prompt, so the two never drift.
  return withReferenceTags(brief, { images, videos, audios, gender });
}

/**
 * Arm (or re-arm, or clear) UGC on a video prompt.
 *
 * Passing a null variant strips. Re-arming keeps whatever script the old block
 * held, so dealing a new cast never costs the words. With reference pictures
 * or clips attached (`persona.images` / `persona.videos`), the brief is the six-section reference brief
 * above and becomes the whole prompt; what the composer held is carried in as
 * the topic — unless it was itself six-section (a cast, an earlier scaffold),
 * which the brief re-derives from the same references.
 */
export function applyUgcVideoBrief(prompt, variant, { durationSeconds, persona = null } = {}) {
  const script = readUgcScript(prompt);
  const base = stripUgcVideoBrief(prompt);
  if (!variant) return base;
  // A clip with no picture is still a character reference (the clip carries
  // the person), so it gets the reference brief too — not a dealt stranger.
  if ((persona?.images || []).length || (persona?.videos || []).length) {
    return ugcReferenceBrief(variant, {
      durationSeconds, script, persona, context: SIX_SECTION.test(base) ? '' : base,
    });
  }
  const block = ugcVideoBrief(variant, { durationSeconds, script });
  return base ? `${base}\n\n${block}` : block;
}

/** Arm (or clear) the realism stack on an image prompt. */
export function applyUgcFirstFrame(prompt, variant) {
  const base = stripUgcFirstFrame(prompt);
  if (!variant) return base;
  const block = ugcFirstFramePrompt(variant);
  return base ? `${base}\n\n${block}` : block;
}
