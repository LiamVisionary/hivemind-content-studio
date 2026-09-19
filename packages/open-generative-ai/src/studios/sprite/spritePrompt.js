// The two prompts a sprite needs, and why they are shaped the way they are.
//
// Sprite work asks for the opposite of everything the rest of this studio is
// tuned for. The video starters describe filmed footage — handheld shake,
// autofocus hunting, exposure pumping — because that is what sells a person as
// real. A sprite wants none of it: no camera, no perspective drift, no
// cinematic light. The character sits still in frame and only the character
// moves, because every frame of the clip is about to be cut out and stacked on
// top of the last one, and a camera that drifts a single pixel turns a clean
// cycle into a wobble.
//
// The H3 scaffold below is the three-field native format, laid out the way
// Liam's dragon test actually ran on 2026-08-24: the style declaration and the
// character description sit in [Shot 1], and the beat gets a [0s] heading and
// its own paragraph. That layout is reproduced rather than improved on —
// it is the one with a working generation behind it.

export const SPRITE_STYLES = Object.freeze([
  Object.freeze({
    id: '16bit',
    label: '16-bit retro',
    // Kept verbatim from the working run.
    declaration: '16bit retro 2D Game Sprite Animation',
    imageStyle: '16-bit retro 2D game sprite, pixel art, crisp pixel edges, limited palette, flat colours, no anti-aliased gradients',
  }),
  Object.freeze({
    id: 'pixel-8bit',
    label: '8-bit pixel',
    declaration: '8bit retro 2D Game Sprite Animation',
    imageStyle: '8-bit pixel art game sprite, chunky pixels, very limited palette, hard black outline, flat colours',
  }),
  Object.freeze({
    id: 'cel',
    label: 'Hand-drawn cel',
    declaration: 'hand-drawn 2D cel-animated Game Sprite Animation',
    imageStyle: 'hand-drawn 2D cel-animated game sprite, clean bold outline, flat cel shading, two-tone shadows, no gradients',
  }),
  Object.freeze({
    id: 'chibi',
    label: 'Chibi vector',
    declaration: 'clean vector 2D chibi Game Sprite Animation',
    imageStyle: 'clean vector chibi game sprite, thick even outline, flat fills, simple rounded shapes, no texture',
  }),
]);

// What the sprite is doing. Each carries the SECONDARY motion that sells a
// cycle as alive — the tail swing and the blink in Liam's dragon run. Without
// them the model holds a still pose for the whole clip and every extracted
// frame comes back identical, which reads as the frame picker being broken.
export const SPRITE_ACTIONS = Object.freeze([
  Object.freeze({
    id: 'idle',
    label: 'Idle',
    beat: 'Sitting idle animation',
    action: 'He sits and looks around calmly, shifting his weight a little.',
    secondary: 'his tail swings, eyes blinking, eyes looking in different directions.',
  }),
  Object.freeze({
    id: 'walk',
    label: 'Walk cycle',
    beat: 'Walk cycle animation',
    action: 'He walks on the spot from left to right in a steady repeating cycle, legs alternating evenly, body bobbing gently with each step.',
    secondary: 'his tail sways with each step, head bobs slightly, eyes blinking.',
  }),
  Object.freeze({
    id: 'reaction',
    label: 'Reaction',
    beat: 'Reaction animation',
    action: 'He notices something off to the right, his eyes go wide and his pupils get big and cute, he leans back in surprise, then settles again.',
    secondary: 'his tail flicks, eyes blinking, ears and head turning to follow it.',
  }),
  Object.freeze({
    id: 'attack',
    label: 'Attack',
    beat: 'Attack animation',
    action: 'He crouches down, winds up, lunges forward once with a short sharp strike, then returns to his standing pose.',
    secondary: 'his tail whips behind him on the wind-up, eyes narrow during the strike.',
  }),
  Object.freeze({
    id: 'custom',
    label: 'Describe it myself',
    beat: '',
    action: '',
    secondary: '',
  }),
]);

// What the sprite stands on while it is filmed. Flat and plain is not a style
// choice — it is what makes a silhouette findable. "Keep as generated" exists
// because a sprite drawn against its own scene is sometimes the point, and the
// matte step can still name the character out of it.
export const SPRITE_BACKGROUNDS = Object.freeze([
  Object.freeze({
    id: 'chroma',
    label: 'Flat chroma green',
    clause: 'The character is centred on a completely flat, plain, uniform chroma-green background with nothing else in the frame — no ground, no shadow, no scenery, no gradient.',
  }),
  Object.freeze({
    id: 'white',
    label: 'Plain white',
    clause: 'The character is centred on a completely flat, plain, uniform white background with nothing else in the frame — no ground, no shadow, no scenery, no gradient.',
  }),
  Object.freeze({
    id: 'scene',
    label: 'Keep as generated',
    clause: '',
  }),
]);

const styleOf = (id) => SPRITE_STYLES.find((style) => style.id === id) || SPRITE_STYLES[0];
const actionOf = (id) => SPRITE_ACTIONS.find((action) => action.id === id) || SPRITE_ACTIONS[0];
const backgroundOf = (id) => SPRITE_BACKGROUNDS.find((background) => background.id === id) || SPRITE_BACKGROUNDS[0];

/**
 * The prompt that draws the sprite still.
 *
 * Explicitly full-body, side-on and centred: a portrait crop cannot be walked
 * across a screen, and a three-quarter hero angle re-projects the moment the
 * character turns, which shows up as a silhouette that changes size between
 * frames.
 */
export function spriteImagePrompt({ subject = '', style = '16bit', background = 'chroma' } = {}) {
  const description = String(subject || '').trim();
  if (!description) return '';
  const backdrop = backgroundOf(background).clause;
  return [
    styleOf(style).imageStyle,
    'a single character, full body, entirely inside the frame, centred, side-on view, standing in a neutral idle pose, even flat lighting with no cast shadow and no depth of field',
    description,
    backdrop,
  ].filter(Boolean).map(endWithStop).join(' ');
}

/** One trailing full stop, never two: the sprite description a user types
 *  usually already ends in one, and `${part}.` produced "…black horns..". */
function endWithStop(part) {
  const text = String(part).trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * The H3 prompt that animates it — the three-field native format.
 *
 * One beat, headed [0s], exactly as the working dragon run was written. H3
 * takes the clip's real length from the request, so a second heading naming a
 * time the clip never reaches is how an animation ends up rushing.
 */
export function spriteAnimationPrompt({
  subject = '',
  style = '16bit',
  action = 'idle',
  customBeat = '',
  customAction = '',
  background = 'chroma',
  soundscape = '',
} = {}) {
  const description = String(subject || '').trim();
  const chosen = actionOf(action);
  const beat = (String(customBeat || '').trim() || chosen.beat || 'Idle animation');
  const movement = (String(customAction || '').trim() || chosen.action || '');
  const backdrop = backgroundOf(background).clause;

  const scene = [
    `[Shot 1] ${styleOf(style).declaration},`,
    '',
    description,
    backdrop ? `\n${backdrop}` : '',
    '\nThe camera never moves, never zooms and never changes angle; the character stays centred at the same size for the whole clip and only the character moves.',
    '',
    `[0s] - ${beat}:`,
    '',
    movement,
    chosen.secondary ? `\n${chosen.secondary}` : '',
  ].filter((line) => line !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const sound = String(soundscape || '').trim() || 'Character movement sounds.';
  return `integrated_multimodal_description: ${scene}\n\noverall_soundscape: ${sound}\n\nnon_diegetic_music: N/A`;
}

/** The subject line to hand SAM3 when cutting frames out. A silhouette is
 *  found by naming the THING, so the whole paragraph of style notes and
 *  wardrobe detail is worse than a short noun phrase. */
export function matteSubjectFrom(subject) {
  const text = String(subject || '').trim();
  if (!text) return '';
  // First clause of the first sentence: "A cute round spherical dragon,
  // dragon's head and body is one round piece, ..." -> "A cute round spherical
  // dragon".
  const firstSentence = text.split(/[.\n]/)[0] || text;
  const head = firstSentence.split(',')[0].trim();
  return (head.length >= 3 ? head : firstSentence.trim()).slice(0, 120);
}

// Liam's own dragon run, kept as the example the studio can load. It is here
// because it is the prompt this feature is known to work with — reading it
// teaches the shape faster than the field labels do.
export const SPRITE_EXAMPLE = Object.freeze({
  label: 'Angry round dragon (idle)',
  style: '16bit',
  action: 'custom',
  background: 'scene',
  subject: "A cute round spherical dragon, dragon's head and body is one round piece, small little 4 legs, thick short tail, angry expression, he is standing on all his 4 legs, big cute eyes, big cute mouth, dragon is pink, cute little black wings, dragon have no arms, only 4 legs, dragon have cute little black horns.",
  customBeat: 'Sitting idle animation',
  customAction: 'He sits on his butt and looks around, then a small blue butterfly fly from the right, dragon look at butterfly and track it with his eyes his eyes pupils become big and cute while he look at the butterfly with cute face expression until it fly away.\n\nhis tail swing, eyes blinking, eyes looking in different directions.',
  soundscape: 'Dragon movements sounds.',
});
