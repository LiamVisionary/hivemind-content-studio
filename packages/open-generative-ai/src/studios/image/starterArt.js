// The example pictures for the image studio's shipped prompts.
//
// Every one of them was rendered FROM the prompt it sits beside, on this lane
// (Krea 2 Turbo, 8 steps, CFG 1, euler/simple) — a row in the Starters menu shows
// what it draws rather than only saying so.
//
// `new URL(…, import.meta.url)` rather than `import x from './x.webp'`: Vite
// fingerprints and bundles both the same way, but the composer is also rendered
// under node:test, and node cannot import a .webp — it resolves a URL happily.
// Each path has to stay a string LITERAL for Vite to see it, which is why this
// is a list and not a loop. tests/objectToCharacter.test.js checks that every
// shipped image prompt has a picture here and every picture is a real file.
//
// One model for the quick starters: they are style tags with no model of their
// own, and the look they ask for reads the same across the local lanes.
const objectLamp = new URL('../../assets/starters/object-lamp.webp', import.meta.url).href;
const objectTeapot = new URL('../../assets/starters/object-teapot.webp', import.meta.url).href;
const objectPhone = new URL('../../assets/starters/object-phone.webp', import.meta.url).href;
const objectLantern = new URL('../../assets/starters/object-lantern.webp', import.meta.url).href;
const characterLamp = new URL('../../assets/starters/character-lamp.webp', import.meta.url).href;
const characterTeapot = new URL('../../assets/starters/character-teapot.webp', import.meta.url).href;
const characterPhone = new URL('../../assets/starters/character-phone.webp', import.meta.url).href;
const characterLantern = new URL('../../assets/starters/character-lantern.webp', import.meta.url).href;
const starterObjectToCharacter = new URL('../../assets/starters/starter-object-to-character.webp', import.meta.url).href;
const starterAnimeCastPhotoreal = new URL('../../assets/starters/starter-anime-cast-photoreal.webp', import.meta.url).href;
const starterFittingRoomSelfie = new URL('../../assets/starters/starter-fitting-room-selfie.webp', import.meta.url).href;
const quickPortrait = new URL('../../assets/starters/quick-portrait.webp', import.meta.url).href;
const quickLandscape = new URL('../../assets/starters/quick-landscape.webp', import.meta.url).href;
const quickProduct = new URL('../../assets/starters/quick-product.webp', import.meta.url).href;
const quickFantasy = new URL('../../assets/starters/quick-fantasy.webp', import.meta.url).href;
const quickSciFi = new URL('../../assets/starters/quick-sci-fi.webp', import.meta.url).href;
const quickFood = new URL('../../assets/starters/quick-food.webp', import.meta.url).href;
const quickArchitecture = new URL('../../assets/starters/quick-architecture.webp', import.meta.url).href;
const quickFashion = new URL('../../assets/starters/quick-fashion.webp', import.meta.url).href;

// By IMAGE_STARTERS id.
export const STARTER_ART = Object.freeze({
  'object-to-character-krea2': starterObjectToCharacter,
  'anime-cast-photoreal-krea2': starterAnimeCastPhotoreal,
  'fitting-room-selfie-krea2': starterFittingRoomSelfie,
});

// By QUICK_PROMPTS label.
export const QUICK_PROMPT_ART = Object.freeze({
  Portrait: quickPortrait,
  Landscape: quickLandscape,
  Product: quickProduct,
  Fantasy: quickFantasy,
  'Sci-Fi': quickSciFi,
  Food: quickFood,
  Architecture: quickArchitecture,
  Fashion: quickFashion,
});

// By OBJECT_TO_CHARACTER_EXAMPLES key: the object that went in, the character
// that came out. `before` doubles as the dialog's input when a card is pressed.
export const OBJECT_TO_CHARACTER_ART = Object.freeze({
  lamp: Object.freeze({ before: objectLamp, after: characterLamp }),
  teapot: Object.freeze({ before: objectTeapot, after: characterTeapot }),
  phone: Object.freeze({ before: objectPhone, after: characterPhone }),
  lantern: Object.freeze({ before: objectLantern, after: characterLantern }),
});

export function starterArtFor(entry) {
  return STARTER_ART[entry?.id] || '';
}
