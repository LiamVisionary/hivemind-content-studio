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

// ---------------------------------------------------------------------------
// Formats.
//
// Everything above deals a CAST. A format decides what the cast is doing: the
// phone-selfie confessional this module started as, plus four app-ad formats
// from Alex Olim's teardown of the study-app creator market (@alexolim_,
// 2026-09-05) — street interview, mad professor, brainrot overlay, and the AI
// that forgets it is not human.
//
// The view counts in that thread (9.5M, 15M, 9.8M, 4.7M) are creator-claimed
// and are deliberately NOT in this file: nothing here ranks or defaults on
// them, the same rule the creator-rewards bank follows for vendor numbers.
// What IS worth keeping is the structure, because it is the part that repeats.
//
// Three things the formats share, and one they do not:
//
//   SHARED — the cast deal, the hook/body/CTA spine, and the slot labels
//   themselves. Keeping the literal HOOK / BODY / CTA labels is what lets you
//   switch format and keep the words: "build one strong script, then make ten
//   versions of it" is the whole point, and readUgcScript round-trips across a
//   format change because the labels never move.
//
//   NOT SHARED — the SETTING. A street interview cannot borrow "sitting on the
//   edge of the bath" from the selfie bank, so each format deals from its own
//   places. Same index, same variety, different world.
//
// Two formats have a second voice (the interviewer; the app's AI). The person
// the references define is always S1 and always the one on camera — so a voice
// clone binds to the creator, never to the other speaker.
// One beat in the bank only makes sense when the subject is the one holding the
// phone. In every format below except the selfie somebody else is filming (or
// the phone is propped, or the frame is a screen recording), so re-framing with
// the other hand is a gesture the subject cannot make.
const HANDS_FREE_BEATS = Object.freeze(UGC_BEATS.filter((beat) => !/\bphone\b/.test(beat)));

const SELFIE_SLOTS = Object.freeze({
  hook: { speaker: 1, note: 'already mid-sentence, as if we joined late' },
  body: { speaker: 1, note: 'natural blinks, one gaze break, one filler word, one micro pause; the body shifts once' },
  cta: { speaker: 1, note: 'an afterthought, trailing off — never a slogan' },
});

export const UGC_FORMATS = Object.freeze([
  {
    id: 'selfie',
    label: 'Phone selfie',
    hint: 'One person talking to their own front camera',
    opening: VIDEO_OPENING,
    closing: VIDEO_CLOSING,
    places: UGC_ROOMS,
    slots: SELFIE_SLOTS,
    scene: (cast) => [
      `Subject: ${cast.person}, ${cast.room.place}. Match the reference frame exactly.`,
      `Place: ${cast.room.light}. ${cast.room.detail}`,
      'Camera: handheld front-camera selfie, chest-up, natural micro shakes, 9:16.',
      `Audio: phone-mic voice with room tone and one ambient sound event — ${cast.room.sound}. No music.`,
    ],
    summary: (cast) => `<Subject 1> talks to the front camera of a phone held at arm's length, ${cast.room.place}, for the whole clip; nobody else is in the shot.`,
    refScene: (cast) => [
      `Camera: handheld front-camera selfie, chest-up, natural micro shakes, 9:16. Place: ${cast.room.light}. ${cast.room.detail}`,
    ],
    soundscape: (cast) => `Phone-mic voice of <Subject 1> (S1) with room tone and one ambient sound event — ${cast.room.sound}. No other speakers, no speech before the hook or after the CTA. No music.`,
  },
  {
    id: 'street-interview',
    beats: HANDS_FREE_BEATS,
    label: 'Street interview',
    hint: 'Stopped outside class: what is your GPA, and what do you use',
    opening: 'UGC — a street interview filmed on somebody\'s phone, not an ad.',
    closing: 'Cut the moment the answer lands — no outro, no logo, no slogan.',
    places: Object.freeze([
      {
        place: 'on a busy pavement outside a university building',
        light: 'flat midday overcast with the building\'s glass throwing a little fill',
        detail: 'Someone walks through the back of frame and glances at the camera.',
        sound: 'traffic and a bus braking at the kerb',
      },
      {
        place: 'on the steps of a library, backpack still on one shoulder',
        light: 'low afternoon sun raking across the steps from the side',
        detail: 'A coffee cup has been left standing two steps down.',
        sound: 'a skateboard rattling past',
      },
      {
        place: 'in a campus courtyard between lectures',
        light: 'bright hazy daylight with no hard shadows',
        detail: 'A bike is chained to the railing with one wheel missing.',
        sound: 'a heavy door swinging shut on its spring',
      },
      {
        place: 'outside a corner shop at the edge of campus',
        light: 'the shop window spilling warm light into blue dusk',
        detail: 'A handwritten sign is taped up inside the glass.',
        sound: 'a fridge unit humming through the open doorway',
      },
    ]),
    slots: Object.freeze({
      hook: { speaker: 2, note: 'the interviewer off camera, stopping them mid-walk' },
      body: { speaker: 1, note: 'the answer, said plainly and a little caught off guard, one shrug' },
      cta: { speaker: 1, note: 'what they actually use, named once like a fact and never sold' },
    }),
    extraSubjects: Object.freeze([
      '<Subject 2> is the interviewer, who stays off camera for the whole clip — a voice and, at most, a hand and a sleeve at the edge of frame holding the phone out. <Subject 2> speaks as S2 and is never seen.',
    ]),
    scene: (cast) => [
      `Subject: ${cast.person}, ${cast.room.place}, talking to whoever stopped them. Match the reference frame exactly.`,
      'Second voice: an interviewer off camera, heard but never seen — at most a hand and a sleeve at the edge of frame.',
      `Place: ${cast.room.light}. ${cast.room.detail}`,
      'Camera: handheld rear camera held out at the subject, chest-up, natural micro shakes and one small reframe, 9:16.',
      `Audio: phone-mic voices with street tone and one ambient sound event — ${cast.room.sound}. No music.`,
    ],
    summary: (cast) => `<Subject 1> is ${cast.room.place}, stopped mid-walk by <Subject 2>, an interviewer who stays off camera, and answers two questions straight to the lens.`,
    refScene: (cast) => [
      `Camera: handheld rear camera held out at <Subject 1>, chest-up, natural micro shakes and one small reframe, 9:16. Place: ${cast.room.light}. ${cast.room.detail}`,
      '<Subject 2> is never in frame — only the voice, and at most a hand and a sleeve at the edge of the picture.',
    ],
    soundscape: (cast) => `Phone-mic voices of <Subject 2> (S2) off camera and <Subject 1> (S1) on camera, with street tone and one ambient sound event — ${cast.room.sound}. Only those two speak, and nobody speaks before the hook or after the CTA. No music.`,
  },
  {
    id: 'mad-professor',
    beats: HANDS_FREE_BEATS,
    label: 'Mad professor',
    hint: 'A lecturer losing it over how students study now',
    opening: 'UGC — a character piece filmed like a clip somebody took in class on their phone, not an ad.',
    closing: 'Cut on their face mid-word — no outro, no logo, no slogan.',
    places: Object.freeze([
      {
        place: 'at the front of a half-empty lecture theatre',
        light: 'hard overhead fluorescents with the projector throwing a pale rectangle across them',
        detail: 'The whiteboard behind is covered in half-erased working.',
        sound: 'a chair scraping somewhere back in the rows',
      },
      {
        place: 'behind a cluttered office desk with the door left open',
        light: 'a desk lamp against one grey window',
        detail: 'Stacked papers have slid into a fan across the keyboard.',
        sound: 'a printer starting up down the corridor',
      },
      {
        place: 'pacing in front of a chalkboard in a small seminar room',
        light: 'daylight from a high window on one side, the rest of the room dim',
        detail: 'A mug has left three rings on the edge of the desk.',
        sound: 'a radiator ticking as it heats',
      },
      {
        place: 'gripping the sides of a lectern in an empty hall',
        light: 'stage lights on the lectern with the seats in darkness',
        detail: 'A microphone has been switched off and pushed aside.',
        sound: 'the long empty reverb of the room itself',
      },
    ]),
    slots: Object.freeze({
      hook: { speaker: 1, note: 'already shouting, as if we joined mid-outburst' },
      body: { speaker: 1, note: 'the rant — specific, escalating, physically restless, one prop grabbed and put down' },
      cta: { speaker: 1, note: 'the grudging admission, suddenly quiet, almost to themselves' },
    }),
    scene: (cast) => [
      `Subject: ${cast.person}, ${cast.room.place}, in full flow and completely unaware of how loud they are. Match the reference frame exactly.`,
      `Place: ${cast.room.light}. ${cast.room.detail}`,
      'Camera: a phone held low by a student in the room — slightly off-level, partly obscured, natural micro shakes, 9:16.',
      `Audio: phone-mic voice picked up across a room with its own reverb, plus one ambient sound event — ${cast.room.sound}. No music.`,
    ],
    summary: (cast) => `<Subject 1> is a professor ${cast.room.place}, mid-outburst about how students study now, filmed on a phone from among the seats.`,
    refScene: (cast) => [
      `Camera: a phone held low by somebody in the room — slightly off-level, partly obscured by a seat back or a shoulder, natural micro shakes, 9:16. Place: ${cast.room.light}. ${cast.room.detail}`,
    ],
    soundscape: (cast) => `The voice of <Subject 1> (S1) picked up across a room with its own reverb, plus one ambient sound event — ${cast.room.sound}. Nobody else speaks, and nobody speaks before the hook or after the CTA. No music.`,
  },
  {
    id: 'brainrot-overlay',
    beats: HANDS_FREE_BEATS,
    label: 'Brainrot notes',
    hint: 'Notes over gameplay, because the attention span is gone',
    opening: 'UGC — a phone screen recording with the creator talking over it, not an ad.',
    closing: 'Cut while the footage underneath is still running — no outro, no logo, no slogan.',
    places: Object.freeze([
      {
        place: 'a blocky voxel parkour run, jumps and ledges scrolling upward',
        light: 'the flat bright light of the game itself, no room light on the picture',
        detail: 'The player misses one jump, respawns, and does not break rhythm.',
        sound: 'the game\'s own footsteps and block-break clicks, low under the voice',
      },
      {
        place: 'an endless runner sliding down a rail between trains',
        light: 'the game\'s high-saturation daylight palette',
        detail: 'A coin streak breaks and immediately starts again.',
        sound: 'the runner\'s whoosh and coin chimes, low under the voice',
      },
      {
        place: 'a marble pouring down a plastic track through funnels and drops',
        light: 'soft even light on the track with almost no shadow',
        detail: 'One marble jams against a join for a second, then goes.',
        sound: 'plastic clatter and rolling, low under the voice',
      },
      {
        place: 'a blade taking clean curls off a bar of soap in close-up',
        light: 'flat product-shot light with no visible source',
        detail: 'A curl falls out of frame and is never picked up.',
        sound: 'the crisp slice of the blade, low under the voice',
      },
    ]),
    slots: Object.freeze({
      hook: { speaker: 1, note: 'voice over, already complaining, as if we joined late' },
      body: { speaker: 1, note: 'voice over — what the notes on screen actually say, read at speed' },
      cta: { speaker: 1, note: 'voice over, thrown away at the end — never a slogan' },
    }),
    scene: (cast) => [
      `Screen: ${cast.room.place} fills the whole 9:16 frame as a phone screen recording.`,
      'Overlay: the creator\'s study notes sit on top in a clean readable panel — a few large lines at a time, replaced as the voice moves on, never a wall of small print.',
      `Creator: ${cast.person}, in a small camera window in one corner of the screen, talking and occasionally glancing at the notes.`,
      `Look: ${cast.room.light}. ${cast.room.detail}`,
      `Audio: phone-mic voice over the top, with the footage's own sound underneath — ${cast.room.sound}. No music.`,
    ],
    summary: (cast) => `A 9:16 phone screen recording: ${cast.room.place} runs full-frame under the creator's study notes, with <Subject 1> talking over it from a small camera window in the corner.`,
    refScene: (cast) => [
      `Screen: ${cast.room.place} fills the whole 9:16 frame. ${cast.room.light}. ${cast.room.detail}`,
      'Overlay: study notes on top in a clean readable panel — a few large lines at a time, replaced as the voice moves on, never a wall of small print.',
      '<Subject 1> appears only in a small camera window in one corner of the screen, talking and occasionally glancing at the notes.',
    ],
    soundscape: (cast) => `The voice of <Subject 1> (S1) recorded close on a phone mic, over the footage's own sound underneath — ${cast.room.sound}. Nobody else speaks, and nobody speaks before the hook or after the CTA. No music.`,
  },
  {
    id: 'ai-slip',
    beats: HANDS_FREE_BEATS,
    label: 'AI forgot it is not human',
    hint: 'The AI voice coughs mid-lecture and the creator freezes',
    opening: 'UGC — a phone clip of somebody listening to an AI voice that slips, not an ad.',
    closing: 'Cut on the freeze — no outro, no logo, no slogan.',
    places: Object.freeze([
      {
        place: 'at a desk with a laptop open and headphones round their neck',
        light: 'a desk lamp on one side and the laptop\'s own screen light on their face',
        detail: 'A highlighter has rolled to the very edge of the desk.',
        sound: 'the laptop fan spinning up',
      },
      {
        place: 'lying across a bed with the phone propped against a pillow',
        light: 'a bedside lamp behind them, the room dark past it',
        detail: 'A charger cable is stretched taut across the duvet.',
        sound: 'a neighbour\'s music coming through the wall',
      },
      {
        place: 'at a kitchen table with notes spread out and pushed to one side',
        light: 'the overhead kitchen light, the window behind gone dark',
        detail: 'A plate has been shoved aside without being cleared.',
        sound: 'the fridge compressor kicking on',
      },
      {
        place: 'in a library carrel with one earbud in',
        light: 'a small carrel lamp, the aisles behind going dim',
        detail: 'Somebody else\'s pen has been left in the groove of the desk.',
        sound: 'a chair scraping two carrels away',
      },
    ]),
    slots: Object.freeze({
      hook: { speaker: 2, note: 'the AI voice out of the speaker, mid-lecture, perfectly ordinary' },
      body: { speaker: 2, note: 'the AI coughs, clears its throat and apologises like a person, then carries straight on as if nothing happened' },
      cta: { speaker: 1, note: 'the creator, after a long freeze — said to nobody, half to the camera' },
    }),
    extraSubjects: Object.freeze([
      '<Subject 2> is the study app\'s AI voice, heard out of the laptop or phone speaker and never seen. <Subject 2> speaks as S2, in an even synthetic reading voice that is steady until it slips.',
    ]),
    scene: (cast) => [
      `Subject: ${cast.person}, ${cast.room.place}, listening rather than talking for most of the clip. Match the reference frame exactly.`,
      'Second voice: the study app\'s AI, heard out of the speaker and never seen.',
      `Place: ${cast.room.light}. ${cast.room.detail}`,
      'Camera: a phone propped and locked off, chest-up, the smallest natural drift, 9:16.',
      `Audio: the AI voice thin and close out of a small speaker, the room around it live, plus one ambient sound event — ${cast.room.sound}. No music.`,
      'On the slip: the eyes go still, the head turns a few degrees toward the speaker, and the face holds a long puzzled beat before anything is said.',
    ],
    summary: (cast) => `<Subject 1> is ${cast.room.place}, listening to <Subject 2>, a study app's AI voice out of the speaker, when it coughs like a person — and holds a long puzzled freeze before saying anything.`,
    refScene: (cast) => [
      `Camera: a phone propped and locked off on <Subject 1>, chest-up, the smallest natural drift, 9:16. Place: ${cast.room.light}. ${cast.room.detail}`,
      '<Subject 2> is never in frame — only a voice out of a small speaker.',
      'On the slip: <Subject 1>\'s eyes go still, the head turns a few degrees toward the speaker, and the face holds a long puzzled beat before anything is said.',
    ],
    soundscape: (cast) => `The voice of <Subject 2> (S2) thin and close out of a small speaker, the room around it live, and the phone-mic voice of <Subject 1> (S1) at the end, plus one ambient sound event — ${cast.room.sound}. Only those two are heard, and nobody speaks before the hook or after the CTA. No music.`,
  },
].map((format) => Object.freeze({ extraSubjects: Object.freeze([]), beats: UGC_BEATS, ...format })));

export const UGC_DEFAULT_FORMAT = 'selfie';

const FORMAT_BY_ID = new Map(UGC_FORMATS.map((format) => [format.id, format]));

/** A format by id, falling back to the phone-selfie one this module began as. */
export function ugcFormat(id) {
  return FORMAT_BY_ID.get(String(id || '')) || FORMAT_BY_ID.get(UGC_DEFAULT_FORMAT);
}

/**
 * Which format's brief is written in `prompt`, or ''. Each format opens on a
 * line of its own, which is what the strip below anchors on — so a format
 * switch removes the old brief instead of leaving two in the box.
 */
export function ugcFormatInPrompt(prompt) {
  const source = String(prompt || '');
  const hit = UGC_FORMATS.find((format) => source.includes(format.opening));
  return hit ? hit.id : '';
}

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
export function ugcVariantAt(index, { gender = '', format = UGC_DEFAULT_FORMAT } = {}) {
  const n = Math.max(0, Math.floor(Number(index) || 0));
  const people = ugcPeopleFor(gender);
  const person = people[n % people.length];
  // The setting comes from the FORMAT's bank: a street interview borrowing
  // "sitting on the edge of the bath" from the selfie rooms is not a variation,
  // it is a broken clip.
  const places = ugcFormat(format).places;
  const room = places[n % places.length];
  // Two beats or three, alternating, taken from a window that walks the bank —
  // so consecutive arms share at most one gesture.
  const count = 2 + (n % 2);
  const bank = ugcFormat(format).beats;
  const beats = [];
  for (let step = 0; step < count; step += 1) {
    beats.push(bank[(n * 2 + step) % bank.length]);
  }
  return { index: n, person, room, beats: Object.freeze(beats), format: ugcFormat(format).id };
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

const PLACEHOLDER_FOR = { hook: UGC_HOOK_PLACEHOLDER, body: UGC_BODY_PLACEHOLDER, cta: UGC_CTA_PLACEHOLDER };

/**
 * The three script lines, labelled and timed. The LABELS are deliberately the
 * same three words in every format — readUgcScript finds them, and that is what
 * lets you switch format and keep the words you already wrote. What each slot
 * MEANS, and who says it, is the format's business and lives in the
 * parenthetical.
 */
function scriptLines(format, { hookEnd, ctaStart, seconds, hasBody }, script, wrap) {
  const line = (key, label, from, to) => {
    const slot = format.slots[key];
    const text = script?.[key] || PLACEHOLDER_FOR[key];
    return `${label} ${ugcClock(from)}–${ugcClock(to)} (${slot.note}): ${wrap ? wrap(text, slot.speaker) : text}`;
  };
  const lines = [{ from: 0, line: line('hook', 'HOOK', 0, hookEnd) }];
  if (hasBody) lines.push({ from: hookEnd, line: line('body', 'BODY', hookEnd, ctaStart) });
  lines.push({ from: ctaStart, line: line('cta', 'CTA', ctaStart, seconds) });
  return lines;
}

/** The UGC block for a video prompt: cast, framing, timeline, beats. */
export function ugcVideoBrief(variant, { durationSeconds, script, format = UGC_DEFAULT_FORMAT } = {}) {
  const cast = variant || ugcVariantAt(0, { format });
  const shape = ugcFormat(cast.format || format);
  const timeline = ugcTimeline(durationSeconds);
  return [
    shape.opening,
    ...shape.scene(cast),
    ...scriptLines(shape, timeline, script, null).map((slot) => slot.line),
    `Behavioural beats: ${cast.beats.join('; ')}.`,
    'Keep the skin texture, no beauty filter, lips synced.',
    shape.closing,
  ].join('\n');
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
  const shape = FORMAT_BY_ID.get(ugcFormatInPrompt(source));
  if (!shape) return false;
  return SIX_SECTION.test(source) && source.includes(shape.closing) && /^non_diegetic_music:/m.test(source);
}

export function stripUgcVideoBrief(prompt) {
  if (isUgcReferenceBrief(prompt)) return '';
  // Anchored on the armed format's OWN opening and closing, so switching format
  // takes the previous brief out with it instead of leaving two in the box.
  const shape = FORMAT_BY_ID.get(ugcFormatInPrompt(prompt));
  if (!shape) return String(prompt || '').trim();
  return stripBlock(prompt, shape.opening, shape.closing);
}

export function stripUgcFirstFrame(prompt) {
  return stripBlock(prompt, IMAGE_OPENING, IMAGE_CLOSING);
}

// Whether UGC is on is a property of the PROMPT, not of a flag beside it.
// "Start fresh", loading a saved prompt, or restoring a generation's settings
// all replace the prompt without knowing about UGC — reading the block back is
// what keeps the chip from claiming a cast the composer no longer holds.
export function hasUgcVideoBrief(prompt) {
  return Boolean(ugcFormatInPrompt(prompt));
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
const spoken = (text, speaker = 1) => `(S${speaker}) says: <d>[English] ${text}</d>`;

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
export function ugcReferenceBrief(variant, { durationSeconds, script, persona, context = '', format = UGC_DEFAULT_FORMAT } = {}) {
  const cast = variant || ugcVariantAt(0, { format });
  const shape = ugcFormat(cast.format || format);
  const timeline = ugcTimeline(durationSeconds);
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
    '<Subject 1> is rendered as photoreal live-action, real human skin texture and hair, shot on a phone camera — not illustrated, not stylised, no beauty filter.',
  ];
  // A second voice — the interviewer, the app's AI — is a subject with a
  // speaker id of its own. It is never <Subject 1>: the references define the
  // person ON CAMERA, so a voice clone binds to the creator and not to whoever
  // is talking at them.
  subject.push(...shape.extraSubjects);
  if (voice) {
    subject.push('<Subject 1> speaks as S1.');
    subject.push(`${voice} is the voice-timbre reference for <Subject 1> (S1). It is not the voice of anyone else in this clip.`);
  } else {
    // No clone to bind: at least say what kind of voice, or H3 gives an
    // unvoiced subject its generic adult male.
    subject.push(`<Subject 1> speaks as S1${noun ? `, in a ${noun}'s voice` : ''}.`);
  }

  // Same three labelled lines as the plain block, wrapped as (S…) dialogue and
  // opened as H3 shots — one writer, so the two briefs can never drift.
  const shots = scriptLines(shape, timeline, script, spoken).map((slot, index) => (
    index === 0
      ? `[Shot 1] ${slot.line}`
      : `[Shot ${index + 1}] At ${shotStamp(slot.from)}, ${slot.line}`
  ));

  const topic = String(context || '').trim();
  const brief = [
    'subject_definitions:',
    ...subject,
    '',
    'summary:',
    // The audio contract up front when a voice is attached — the same tag the
    // Cast control writes, on the summary's own line rather than above it.
    `${voice ? '[audio reference] ' : ''}${shape.opening} ${shape.summary(cast)}`,
    '',
    'retention_analysis:',
    '<Subject 1>: fully_preserved — the same face, hair, build and wardrobe in every shot and at every distance.',
    '',
    'detailed_description:',
    ...(topic ? [`Topic: ${topic}`] : []),
    ...shape.refScene(cast),
    ...shots,
    `Behavioural beats: ${cast.beats.join('; ')}. Keep the skin texture, no beauty filter, lips synced.`,
    shape.closing,
    '',
    'overall_soundscape:',
    shape.soundscape(cast),
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
export function applyUgcVideoBrief(prompt, variant, { durationSeconds, persona = null, format = UGC_DEFAULT_FORMAT } = {}) {
  const script = readUgcScript(prompt);
  const base = stripUgcVideoBrief(prompt);
  if (!variant) return base;
  // A clip with no picture is still a character reference (the clip carries
  // the person), so it gets the reference brief too — not a dealt stranger.
  if ((persona?.images || []).length || (persona?.videos || []).length) {
    return ugcReferenceBrief(variant, {
      durationSeconds, script, persona, format, context: SIX_SECTION.test(base) ? '' : base,
    });
  }
  const block = ugcVideoBrief(variant, { durationSeconds, script, format });
  return base ? `${base}\n\n${block}` : block;
}

/** Arm (or clear) the realism stack on an image prompt. */
export function applyUgcFirstFrame(prompt, variant) {
  const base = stripUgcFirstFrame(prompt);
  if (!variant) return base;
  const block = ugcFirstFramePrompt(variant);
  return base ? `${base}\n\n${block}` : block;
}
