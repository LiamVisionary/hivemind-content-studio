// Emotion / performance direction — 25 acting studies applied to a video prompt
// as one idempotent "Performance: …" phrase, the same replace-not-stack
// contract as camera motions and restyle presets.
//
// Ported from Liam's Seedance 2.5 performance field guide
// (seedance-emotion-direction.vercel.app). The guide's own rule is what makes
// these portable and is kept exactly: a performance study contains ONLY visible
// acting behaviour — room, camera, wardrobe, story, audio and duration are
// deliberately absent — so it appends after whatever scene you already wrote
// instead of competing with it. `prompt` is the guide's text VERBATIM; every
// edit below lives in `h3`.
//
// WHY H3 NEEDS ITS OWN TEXT. Two reasons, and neither is a style preference:
//
//   1. H3 renders the AUDIO as well as the picture, so a performance whose
//      sound is left implicit comes back mimed — a laugh with no laugh, a sob
//      with no breath. Each `h3` text therefore names the sound the body is
//      already making. It goes in the DESCRIPTION and never in
//      overall_soundscape: a non-verbal human sound written into the soundscape
//      has no speaker id to carry it and comes back as a generic voice over
//      whoever is on screen (the same failure the fight starter was rewritten
//      for). Where the performance is genuinely wordless and the mouth opens,
//      the h3 text says so — an open mouth with nothing named is an invitation
//      for H3 to invent a line.
//   2. An H3 prompt ENDS in `non_diegetic_music:`, so appending to it puts the
//      direction inside the music field. `applyEmotionPrompt` inserts into the
//      description instead, in BOTH of H3's native formats (three-field and
//      six-section) — never gate on one of them, see h3References.parseFieldPrompt
//      and castPrompt.parseSixSections.
//
// The acting text stays IMPERSONAL in both dialects ("the eyes squeeze", not
// "<Subject 1>'s eyes squeeze"). That is what lets one phrase drop into a
// three-field prompt with no subjects, a six-section prompt with four of them,
// and a Seedance paragraph alike: which subject is performing is a fact only
// the prompt knows, and a picker that guessed a number would address the wrong
// person in every multi-subject scene.
import { parseFieldPrompt } from './h3References.js';
import { formatSixSections, isSixSectionPrompt, parseSixSections } from './castPrompt.js';

/** Menu groupings, in the guide's own order. */
export const EMOTION_FAMILIES = Object.freeze(['Joy', 'Sadness', 'Anger', 'Fear', 'Surprise', 'Disgust', 'Social', 'Drive', 'Physical']);
export const EMOTION_INTENSITIES = Object.freeze(['subtle', 'medium', 'explosive']);

export const EMOTION_DIRECTIONS = Object.freeze([
  {
    id: 'laughter',
    label: 'Laughter',
    family: 'Joy',
    intensity: 'explosive',
    hint: 'Laughter breaks loose',
    prompt: 'The eyes squeeze into crinkled slits, the mouth opens wide showing teeth, the head drops forward and tips back, and the shoulders bounce with each breath. The laugh settles into a wide lingering grin.',
    h3: 'The eyes squeeze into crinkled slits, the mouth opens wide showing teeth, the head drops forward and tips back, and the shoulders bounce with each breath. The laugh is out loud and open-throated, audible gasps breaking between breaths, and it settles into a wide lingering grin.',
  },
  {
    id: 'shock',
    label: 'Shock',
    family: 'Surprise',
    intensity: 'explosive',
    hint: 'Sudden disbelief',
    prompt: 'The eyes snap wide with white visible above the iris, the eyebrows shoot up, the jaw drops fully open, and the head jerks back. The face freezes in that expression before a single blink.',
    h3: 'The eyes snap wide with white visible above the iris, the eyebrows shoot up, the jaw drops fully open on a sharp audible gasp, and the head jerks back. The face freezes in that expression with the breath held and no word spoken, before a single blink.',
  },
  {
    id: 'terror',
    label: 'Terror',
    family: 'Fear',
    intensity: 'explosive',
    hint: 'Fear refuses to release',
    prompt: 'The eyebrows pull up and together, the eyes lock wide open without blinking, the mouth stretches open, the chin tucks back, and the chest rises and falls with fast, shallow breaths.',
    h3: 'The eyebrows pull up and together, the eyes lock wide open without blinking, the mouth stretches open, the chin tucks back, and the chest rises and falls with fast shallow breaths that are audible and ragged in the throat. No words come out.',
  },
  {
    id: 'rage',
    label: 'Rage',
    family: 'Anger',
    intensity: 'explosive',
    hint: 'Control breaks open',
    prompt: 'The eyebrows slam down and inward, the upper lip peels back from the teeth, the nostrils flare, the neck tendons tighten, and the head pushes forward. The snarl holds as hard breaths move through the nose.',
    h3: 'The eyebrows slam down and inward, the upper lip peels back from the teeth, the nostrils flare, the neck tendons tighten, and the head pushes forward. The snarl holds as hard audible breaths force through the nose.',
  },
  {
    id: 'disgust',
    label: 'Disgust',
    family: 'Disgust',
    intensity: 'medium',
    hint: 'Full recoil',
    prompt: 'The nose wrinkles hard and pulls the upper lip upward, the eyes squint nearly shut, the chin draws in, and the head recoils and turns away. The revolted expression holds.',
    h3: 'The nose wrinkles hard and pulls the upper lip upward, the eyes squint nearly shut, the chin draws in, and the head recoils and turns away on a short revolted exhale. The revolted expression holds.',
  },
  {
    id: 'crying',
    label: 'Crying',
    family: 'Sadness',
    intensity: 'explosive',
    hint: 'Composure collapses',
    prompt: 'The eyes and nose flush red, tears spill over the lower lid, the breath catches in visible stutters, the mouth pulls into a square shape, and the chin crumples and trembles. The shoulders begin to shake.',
    h3: 'The eyes and nose flush red, tears spill over the lower lid, the breath catches in audible stuttering hitches, the mouth pulls into a square shape, and the chin crumples and trembles. The shoulders begin to shake as the sobs break through.',
  },
  {
    id: 'pain-wince',
    label: 'Pain / Wince',
    family: 'Physical',
    intensity: 'explosive',
    hint: 'Sharp jolt',
    prompt: 'The eyes clamp shut, the teeth bare in a hard grimace, the head snaps to one side, and one shoulder rises toward the ear. The face stays contracted before easing only slightly.',
    h3: 'The eyes clamp shut, the teeth bare in a hard grimace on a sharp hiss drawn in through them, the head snaps to one side, and one shoulder rises toward the ear. The face stays contracted before easing only slightly.',
  },
  {
    id: 'eye-roll',
    label: 'Eye Roll',
    family: 'Social',
    intensity: 'medium',
    hint: 'Patience is gone',
    prompt: 'The eyes roll in a full, slow arc while the head tilts with the movement. Air pushes out through the nose, the eyes return with lowered lids, and a flat stare holds before the gaze turns away.',
    h3: 'The eyes roll in a full slow arc while the head tilts with the movement. Air pushes out through the nose in one audible flat sigh, the eyes return with lowered lids, and a flat stare holds before the gaze turns away.',
  },
  {
    id: 'suspicion',
    label: 'Suspicion',
    family: 'Fear',
    intensity: 'subtle',
    hint: 'Something does not add up',
    prompt: 'The chin drops while the eyes stay lifted. One eyebrow rises higher, the head turns slightly so the gaze lands sideways, and the mouth tightens at one corner. The stare holds without blinking.',
    h3: 'The chin drops while the eyes stay lifted. One eyebrow rises higher, the head turns slightly so the gaze lands sideways, and the mouth tightens at one corner. The stare holds without blinking and without a word, the breathing slow and quiet.',
  },
  {
    id: 'flirtation',
    label: 'Flirtation',
    family: 'Social',
    intensity: 'subtle',
    hint: 'Playful restraint',
    prompt: 'The chin lowers, the gaze returns with a slow, deliberate blink, and a warm, playful half-smile grows at one corner of the mouth. The expression holds without rushing or breaking eye contact.',
    h3: 'The chin lowers, the gaze returns with a slow deliberate blink, and a warm playful half-smile grows at one corner of the mouth. The expression holds without rushing and without breaking eye contact, the breathing soft and unhurried.',
  },
  {
    id: 'smug',
    label: 'Smug / Gloating',
    family: 'Social',
    intensity: 'medium',
    hint: 'Quiet superiority',
    prompt: 'The eyelids lower, one corner of the mouth pulls into a slow smirk, the eyebrows rise once and settle, and the chin lifts slightly. The smirk holds through unbroken eye contact.',
    h3: 'The eyelids lower, one corner of the mouth pulls into a slow smirk, the eyebrows rise once and settle, and the chin lifts slightly on one short amused breath through the nose. The smirk holds through unbroken eye contact.',
  },
  {
    id: 'boredom',
    label: 'Boredom',
    family: 'Physical',
    intensity: 'subtle',
    hint: 'Attention drains away',
    prompt: 'The eyelids grow heavy, the gaze drifts and loses focus, a slow blink lasts too long, the jaw slackens, and a long sigh lowers the chest. The head sinks and the body settles into stillness.',
    h3: 'The eyelids grow heavy, the gaze drifts and loses focus, a slow blink lasts too long, the jaw slackens, and one long audible sigh empties the chest. The head sinks and the body settles into stillness.',
  },
  {
    id: 'confusion',
    label: 'Confusion',
    family: 'Surprise',
    intensity: 'medium',
    hint: 'Meaning will not settle',
    prompt: 'The eyebrows become asymmetric, one raised and one lowered. The eyes search rapidly, the head tilts sharply, and the mouth hangs slightly open. The puzzled expression deepens instead of resolving.',
    h3: 'The eyebrows become asymmetric, one raised and one lowered. The eyes search rapidly, the head tilts sharply, and the mouth hangs slightly open on a small questioning breath. The puzzled expression deepens instead of resolving, and no words are spoken.',
  },
  {
    id: 'realization',
    label: 'Realization',
    family: 'Surprise',
    intensity: 'medium',
    hint: 'The answer lands',
    prompt: 'A blank thinking expression breaks as the eyes widen, the eyebrows jump, the lips part on a silent breath, and focus snaps back. A slow nod follows while the knowing, slightly stunned look holds.',
    h3: 'A blank thinking expression breaks as the eyes widen, the eyebrows jump, the lips part on a soft audible intake of breath, and focus snaps back. A slow nod follows, with no words spoken, while the knowing slightly stunned look holds.',
  },
  {
    id: 'awe',
    label: 'Awe / Wonder',
    family: 'Joy',
    intensity: 'medium',
    hint: 'Drawn toward wonder',
    prompt: 'The eyes widen gradually without tension in the brow, the mouth opens little by little, the head tilts upward, and the body leans forward. The open, reverent expression never drops.',
    h3: 'The eyes widen gradually without tension in the brow, the mouth opens little by little on one slow drawn breath, the head tilts upward, and the body leans forward. The open reverent expression never drops, and nothing is said.',
  },
  {
    id: 'determination',
    label: 'Determination',
    family: 'Drive',
    intensity: 'medium',
    hint: 'Resolve locks in',
    prompt: 'The eyes lift and lock forward, a deep breath expands the chest, the jaw sets visibly at the hinge, the eyes narrow, and the shoulders roll back. One sharp nod completes the change.',
    h3: 'The eyes lift and lock forward, one deep audible breath expands the chest, the jaw sets visibly at the hinge, the eyes narrow, and the shoulders roll back. One sharp nod completes the change.',
  },
  {
    id: 'frustration',
    label: 'Frustration',
    family: 'Anger',
    intensity: 'medium',
    hint: 'Effort turns to defeat',
    prompt: 'The eyes clamp shut, the jaw slides from side to side, a sharp breath pushes through the nose, and the head shakes once. The head tips back as one long defeated breath leaves the tension in the face.',
    h3: 'The eyes clamp shut, the jaw slides from side to side, a sharp breath pushes audibly through the nose, and the head shakes once. The head tips back as one long defeated exhale takes the tension out of the face.',
  },
  {
    id: 'anxiety',
    label: 'Anxiety',
    family: 'Fear',
    intensity: 'medium',
    hint: 'Restlessness will not stop',
    prompt: 'The eyebrows stay knitted, the eyes flick rapidly from side to side, the lower lip pulls between the teeth, and breathing remains shallow and quick. The hands grip together as the weight keeps shifting.',
    h3: 'The eyebrows stay knitted, the eyes flick rapidly from side to side, the lower lip pulls between the teeth, and the breathing stays shallow, quick and audible. The hands grip together as the weight keeps shifting.',
  },
  {
    id: 'sadness',
    label: 'Sadness',
    family: 'Sadness',
    intensity: 'subtle',
    hint: 'Quiet hurt',
    prompt: 'The inner corners of the eyebrows pull up and together, the mouth corners drag down, the chin trembles once, and the gaze sinks as the head lowers. A slow blink and hard swallow fail to change the expression.',
    h3: 'The inner corners of the eyebrows pull up and together, the mouth corners drag down, the chin trembles once, and the gaze sinks as the head lowers. A slow blink and one audible hard swallow fail to change the expression.',
  },
  {
    id: 'guilt',
    label: 'Guilt',
    family: 'Sadness',
    intensity: 'subtle',
    hint: 'The truth weighs down',
    prompt: 'The mouth opens but no words come. The eyes slide down and away, the head lowers, a hard swallow moves through the throat, and one hand reaches to the back of the neck. The gaze stays on the floor.',
    h3: 'The mouth opens but no words come. The eyes slide down and away, the head lowers, an audible hard swallow moves through the throat, and one hand reaches to the back of the neck. The gaze stays on the floor and the silence holds.',
  },
  {
    id: 'embarrassment',
    label: 'Embarrassment',
    family: 'Social',
    intensity: 'medium',
    hint: 'Confidence folds inward',
    prompt: 'Color rises in the cheeks, the eyes dart down and to the side, and an awkward pressed-lip half-smile appears. The head ducks and turns away while one hand rises near the mouth. The eyes stay lowered.',
    h3: 'Colour rises in the cheeks, the eyes dart down and to the side, and an awkward pressed-lip half-smile appears on one small breathy laugh. The head ducks and turns away while one hand rises near the mouth. The eyes stay lowered.',
  },
  {
    id: 'exhaustion',
    label: 'Exhaustion',
    family: 'Physical',
    intensity: 'subtle',
    hint: 'Nothing left to give',
    prompt: 'The eyelids drag downward, a long blink stays closed too long, the head drifts down and lifts again slowly, the jaw hangs slack, and one long breath empties out. The eyes reopen only halfway.',
    h3: 'The eyelids drag downward, a long blink stays closed too long, the head drifts down and lifts again slowly, the jaw hangs slack, and one long audible breath empties out. The eyes reopen only halfway.',
  },
  {
    id: 'relief',
    label: 'Relief',
    family: 'Joy',
    intensity: 'medium',
    hint: 'Pressure finally releases',
    prompt: 'A large visible exhale empties the chest, the eyes close, the raised eyebrows drop to neutral, and the shoulders collapse downward. One hand rises to the forehead. A small, shaky smile appears only after the breath finishes.',
    h3: 'A large audible exhale empties the chest, the eyes close, the raised eyebrows drop to neutral, and the shoulders collapse downward. One hand rises to the forehead. A small shaky smile appears only after the breath finishes.',
  },
  {
    id: 'pride',
    label: 'Pride',
    family: 'Drive',
    intensity: 'subtle',
    hint: 'Satisfaction held quietly',
    prompt: 'The chin lifts, the chest expands, and a closed-lip smile spreads slowly and evenly. The shoulders roll back, followed by one slow, satisfied blink. The smile remains as the arms fold.',
    h3: 'The chin lifts, the chest expands on one slow satisfied breath, and a closed-lip smile spreads slowly and evenly. The shoulders roll back, followed by one slow blink. The smile remains as the arms fold, and nothing is said.',
  },
  {
    id: 'nervous-fake-smile',
    label: 'Nervous Fake Smile',
    family: 'Social',
    intensity: 'subtle',
    hint: 'Smile without warmth',
    prompt: 'The mouth stretches into a smile while the eyes stay flat, with no crinkling at the corners. Blinking speeds up, the throat makes a hard swallow, and the gaze drops before the strained smile snaps back into place.',
    h3: 'The mouth stretches into a smile while the eyes stay flat, with no crinkling at the corners. Blinking speeds up, the throat makes an audible hard swallow, and the gaze drops before the strained smile snaps back into place.',
  },
].map((entry) => Object.freeze(entry)));

const BY_ID = new Map(EMOTION_DIRECTIONS.map((entry) => [entry.id, entry]));

export function emotionDirectionById(id) {
  return BY_ID.get(String(id || '')) || null;
}

/**
 * The "Performance: …" sentence for a selection, in the dialect the model
 * reads. `h3` picks the rewrite that names the sound; everything else gets the
 * guide's own text.
 */
/**
 * Remove `phrase` and the whitespace that joined it, and touch nothing else.
 *
 * Deliberately NOT cameraMotion's stripCameraMotionPhrase, which tidies
 * whitespace across the WHOLE string: H3's formats are whitespace-significant
 * — the fields are separated by blank lines — so that tidy flattens a
 * three-field prompt onto one line, parseFieldPrompt stops recognising it, and
 * the next selection lands past the end in the music field again. Punctuation
 * is left alone so a base that ended in a full stop comes back byte for byte.
 */
function stripEmotionPhrase(prompt, phrase) {
  const target = String(phrase || '').trim();
  if (!target) return String(prompt || '');
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(prompt || '').replace(new RegExp(`[ \\t]*\\n?[ \\t]*${escaped}`, 'g'), '');
}

export function emotionPhrase(id, { h3 = false } = {}) {
  const entry = emotionDirectionById(id);
  if (!entry) return '';
  return `Performance: ${h3 ? entry.h3 : entry.prompt}`;
}

/**
 * Put `phrase` at the end of an H3 prompt's DESCRIPTION, in either native
 * format, or null when the text is not an H3 prompt at all.
 *
 * An H3 prompt ends in `non_diegetic_music:`, so a plain append writes acting
 * direction into the music field — the failure the composer weave was built
 * for. Both formats are handled because both ship: the starters and the helper
 * write three-field, reference mode writes six-section.
 */
function withPhraseInH3Description(prompt, phrase) {
  const fields = parseFieldPrompt(prompt);
  if (fields) {
    const body = [fields.integrated_multimodal_description, phrase].filter(Boolean).join('\n');
    return [
      fields.lead,
      `integrated_multimodal_description: ${body}`,
      `overall_soundscape: ${fields.overall_soundscape || ''}`.trim(),
      `non_diegetic_music: ${fields.non_diegetic_music || ''}`.trim(),
    ].filter(Boolean).join('\n\n');
  }
  if (isSixSectionPrompt(prompt)) {
    const sections = parseSixSections(prompt);
    return formatSixSections({
      ...sections,
      detailed_description: [sections.detailed_description, phrase].filter(Boolean).join('\n'),
    });
  }
  return null;
}

/**
 * Replace whatever performance phrase is in `prompt` with `nextId`'s, and
 * return `{ prompt, id }`. A falsy `nextId` just strips — that is how
 * "no direction" works, same as the restyle picker.
 *
 * Both dialects of the previous selection are stripped, because the model can
 * change under an applied phrase: arm an emotion on Seedance, switch to H3, and
 * the phrase already in the prompt is the prose one.
 */
export function applyEmotionPrompt(prompt, previousId, nextId, { h3 = false } = {}) {
  let base = String(prompt || '');
  if (previousId) {
    base = stripEmotionPhrase(base, emotionPhrase(previousId, { h3: false }));
    base = stripEmotionPhrase(base, emotionPhrase(previousId, { h3: true }));
  }
  base = base.trim();
  const phrase = emotionPhrase(nextId, { h3 });
  if (!phrase) return { prompt: base, id: null };
  if (!base) return { prompt: phrase, id: nextId };
  const inDescription = withPhraseInH3Description(base, phrase);
  if (inDescription) return { prompt: inDescription, id: nextId };
  const separator = /[.!?]$/.test(base) ? ' ' : '. ';
  return { prompt: `${base}${separator}${phrase}`, id: nextId };
}

/**
 * The direction whose phrase is written in `prompt`, or null — the reverse of
 * applyEmotionPrompt, so the chip can be reconciled against a prompt restored
 * from the encrypted composer (see cameraMotionIdsInPrompt). Either dialect
 * counts: the id persists in plaintext settings, the phrase persists with the
 * prompt, and the two must agree or re-applying stacks a second sentence.
 */
export function emotionDirectionIdInPrompt(prompt) {
  const source = String(prompt || '');
  if (!source) return null;
  const hit = EMOTION_DIRECTIONS.find((entry) => source.includes(entry.prompt) || source.includes(entry.h3));
  return hit ? hit.id : null;
}
