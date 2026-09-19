// The image studio's shipped starter shelf.
//
// The video side of defaultPrompts.js has had one of these since the beginning;
// the image side has only ever had QUICK_PROMPTS — eight one-line style tags
// ("Professional portrait photograph, shallow depth of field…"), which are tag
// soup, not prompts. A finished image prompt is the same kind of object a
// finished video prompt is: written FOR one model, and worth nothing without
// the settings it was written at.
//
// That last part is the difference from the video shelf. A video starter mostly
// only needs a duration; an image starter is a RECIPE — the step count, the CFG,
// the sampler pair and the output size are as load-bearing as the words. Krea 2
// Turbo at 8 steps and CFG 1 is a different model from Krea 2 Turbo at 30 steps
// and CFG 7, and the same prompt run at the second one comes back burnt. So an
// image starter carries a `setup` block and the studio applies it on load
// (applyImageStarterSetup in ImageStudio.jsx), rather than writing the numbers
// into a note and hoping they get typed in.
//
// What a setup may name is deliberately narrow: the tuning the selected model
// already exposes. It never switches the model — starters are filtered to the
// selected one before the menu draws them, so the model is the reason the row is
// visible in the first place — and it never touches references, seed or negative
// prompt, which belong to the person at the keyboard.

import { OBJECT_TO_CHARACTER_FRAME } from './objectToCharacter.js';

// Liam's Krea 2 Turbo recipe (2026-09-07), verbatim as it arrived. The point of
// it is the collision: the two girls are drawn cel-anime and everything they are
// standing in — sheep, fences, barn, light — is photographic, and the prompt
// gets that by describing the two halves in two different vocabularies in one
// paragraph. Rewriting the subject keeps the aesthetic as long as that split
// survives; flattening it into one register is what loses the effect.
//
// `greedice_style` is the trigger word of the LoRA the setup selects, which is
// why it is the first token of the prompt and not a stylistic flourish.
const ANIME_CAST_PHOTOREAL_FARM = `greedice_style, a polished anime-style illustration of two young girls in the foreground. The girl on the left has short orange hair with a dark headband featuring a cross motif, brown eyes, and a focused expression. She wears a white off-shoulder blouse, a brown leather-style bodice with straps and a red gem, short skirt, dark gloves, and brown boots. She is gently petting the head of a sheep. The girl on the right has long golden-blonde hair, amber eyes, and an excited open-mouthed expression. She wears a simple white blouse with puffy sleeves and leans forward with one hand extended. Both characters are rendered with clean anime line work, soft shading, and vibrant colors., They stand in a highly realistic photographic farmyard scene on a bright sunny day. Several fluffy white sheep in the foreground and midground are photorealistic, with natural wool texture, soft shadows, and accurate animal anatomy. The background shows a real countryside farm with wooden fences, a dirt path, green grass, wooden barns and outbuildings, a few distant people, dogs, and white geese, all captured with the authentic lighting, depth, and detail of a real outdoor photograph. Soft natural sunlight filters through the scene, creating a clear mixed-media contrast between the drawn anime characters and the photographic farm environment with realistic sheep.`;

// Liam's fitting-room selfie prompt (2026-09-18), verbatim as it arrived —
// "great colors" at the end and all. It is already a finished image prompt: a
// subject, a place, a garment described down to the loose threads, a pose, a
// light, and a list of the qualities the picture is being judged on.
//
// Two things about it are worth keeping if you rewrite the subject. The FRAMING
// is stated as the subject itself ("a tall slender woman's lower body"), which
// is what keeps the crop below the shoulders; delete that and Krea 2 draws a
// whole person and the denim stops being the point. And the last sentence names
// what the detail budget goes on ("sharp focus on the frayed denim texture and
// fabric details") — on a distilled turbo model that sentence is the difference
// between frayed hem threads and a smooth painted edge.
//
// What the prompt does NOT say is what she wears above the waist, and the model
// fills that in differently on every seed. The shipped example is one draw of
// it; the row's note says so, because a starter that surprises a person with
// its framing is a starter they have to undo by hand.
const FITTING_ROOM_SELFIE = `A realistic amateurish mirror selfie of a tall slender woman’s lower body around 25yo, taken in a modern dressing room or fitting room with neutral white walls and dark curtains. She is wearing very short, pink-wash distressed denim shorts with heavily frayed, ripped hems and loose hanging threads. The shorts are extremely short, showing a lot of upper thigh. She is posing playfully with one leg bent and lifted, not wearing socks on her raised foot. Her skin is smooth and lightly tanned. In her right hand she holds a new iPhone Duo without a case. The phone is pointed at the mirror. Soft natural lighting, subtle shadows, casual and confident vibe, high detail, photorealistic, sharp focus on the frayed denim texture and fabric details. great colors`;

// Object → character (2026-09-18). A WORKFLOW rather than a finished prompt: what
// loads into the box is only the framing half, and `workflow` tells the studio
// to open the dialog that writes the other half from a picture
// (dialogs/ObjectToCharacterDialog.jsx, lib/objectToCharacter.js). Shipped on the
// Krea 2 shelf because the effect is that model following a 200-word paragraph
// to the letter; the dialog itself is reachable on any model from the Starters
// menu, where it appends to whatever is in the box.
export const IMAGE_STARTERS = Object.freeze([
  Object.freeze({
    id: 'object-to-character-krea2',
    idea: 'object-to-character',
    section: 'image',
    family: 'krea-2',
    format: 'prose',
    workflow: 'object-to-character',
    name: 'Object → character',
    summary: 'Drop a picture of a thing; a vision model designs a character from it',
    requires: 'a picture of an object, and a vision-capable helper model (Swarm Scout 12B works)',
    setup: Object.freeze({
      // The same Turbo window as every Krea 2 starter — see the note below.
      steps: 8,
      guidanceScale: 1,
      sampler: 'euler',
      scheduler: 'simple',
      // A tall figure from the knees up: 3:4 on a 1024 short side, 1024×1344.
      aspectRatio: '3:4',
      baseSize: 1024,
    }),
    note: 'Loaded the framing prompt at 8 steps, CFG 1, euler/simple, 3:4. Drop the object\'s picture in the dialog — the character it writes is appended to this prompt. Rewrite the framing freely (a different art style, a different backdrop); the character paragraph is told to leave those to it.',
    parts: Object.freeze([Object.freeze({
      label: 'Framing prompt',
      prompt: OBJECT_TO_CHARACTER_FRAME,
    })]),
    variants: Object.freeze([]),
  }),
  Object.freeze({
    id: 'anime-cast-photoreal-krea2',
    idea: 'anime-cast-photoreal',
    section: 'image',
    family: 'krea-2',
    format: 'prose',
    name: 'Anime cast on a photoreal background',
    summary: 'Drawn anime girls standing in a real photographic farmyard',
    // Named rather than installed: a shipped starter cannot put a file on this
    // machine, and the trigger word at the head of the prompt does nothing
    // without it — the picture comes back in Krea's own base style and the
    // mixed-media contrast, which is the whole idea, is gone.
    requires: 'the greedice LoRA (Civitai) — it is the anime half of the picture, and greedice_style is its trigger',
    setup: Object.freeze({
      // Turbo's window, and it is narrow in one direction only: 8 is the recipe,
      // 12 buys detail, past 12 the turbo schedule stops resolving. CFG is 1
      // because the model is distilled — raising it burns the image rather than
      // tightening adherence.
      steps: 8,
      guidanceScale: 1,
      // The recipe offers euler/simple or er_sde/sgm_uniform. euler/simple is the
      // pair shipped here because the other one is not on this lane: er_sde is
      // absent from the Krea 2 graph's sampler list, and the gateway additionally
      // rewrites a stale er_sde/simple pair on Apple Silicon (gateway/graphs.py),
      // so a starter that asked for it would silently run as something else.
      sampler: 'euler',
      scheduler: 'simple',
      // "3:4 (1536p)": the short side is the base, so 1152 gives 1152×1536.
      aspectRatio: '3:4',
      baseSize: 1152,
      // Matched against the installed catalog by substring, not by id: a LoRA's
      // id here is its filename on this machine, which the shelf cannot know.
      loras: Object.freeze([Object.freeze({ match: 'greedice', strength: 1 })]),
    }),
    note: 'Loaded at the recipe\'s settings: 8 steps, CFG 1, euler/simple, 3:4 at 1152×1536. 12 steps is the ceiling — more than that and Turbo stops resolving. The recipe\'s face detailer and its "no upscaler" line are MooshieUI stages this lane does not have, so there is nothing to switch off. Rewrite the subject freely, but keep the two halves in two vocabularies — drawn characters, photographic everything else — or the contrast goes.',
    parts: Object.freeze([Object.freeze({
      label: 'Whole image',
      prompt: ANIME_CAST_PHOTOREAL_FARM,
    })]),
    variants: Object.freeze([]),
  }),
  Object.freeze({
    id: 'fitting-room-selfie-krea2',
    idea: 'fitting-room-selfie',
    section: 'image',
    family: 'krea-2',
    format: 'prose',
    name: 'Fitting-room mirror selfie',
    summary: 'Amateur lower-body phone selfie, frayed pink denim',
    setup: Object.freeze({
      // The same Turbo window every Krea 2 starter runs in: 8 steps, CFG 1 on a
      // distilled model, euler/simple because er_sde is not on this lane.
      steps: 8,
      guidanceScale: 1,
      sampler: 'euler',
      scheduler: 'simple',
      // Portrait for a phone mirror shot, and the size the example was rendered
      // at: the short side is the base, so 1024 gives 1024x1344.
      aspectRatio: '3:4',
      baseSize: 1024,
    }),
    note: 'Loaded at 8 steps, CFG 1, euler/simple, 3:4 at 1024x1344 — the settings the example beside it was rendered at. Nothing to attach. The prompt says nothing about what she wears above the waist, so the model decides that per seed; add the top you want if it matters. Keep the two working parts if you rewrite it: "lower body" is what holds the crop below the shoulders, and the closing "sharp focus on the frayed denim texture" is what spends the detail budget on the hems rather than on a face.',
    parts: Object.freeze([Object.freeze({
      label: 'Whole image',
      prompt: FITTING_ROOM_SELFIE,
    })]),
    variants: Object.freeze([]),
  }),
]);
