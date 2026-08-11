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

/** The cast for arm number `index`, cycling without repeating a pairing soon. */
export function ugcVariantAt(index) {
  const n = Math.max(0, Math.floor(Number(index) || 0));
  const person = UGC_PEOPLE[n % UGC_PEOPLE.length];
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
const SCRIPT_LINE = /^(HOOK|BODY|CTA)\b[^\n]*?\):[ \t]*(.*)$/;
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
    const text = match[2].trim();
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

export function stripUgcVideoBrief(prompt) {
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

/**
 * Arm (or re-arm, or clear) UGC on a video prompt.
 *
 * Passing a null variant strips. Re-arming keeps whatever script the old block
 * held, so dealing a new cast never costs the words.
 */
export function applyUgcVideoBrief(prompt, variant, { durationSeconds } = {}) {
  const script = readUgcScript(prompt);
  const base = stripUgcVideoBrief(prompt);
  if (!variant) return base;
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
