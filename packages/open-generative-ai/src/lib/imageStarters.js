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

export const IMAGE_STARTERS = Object.freeze([
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
]);
