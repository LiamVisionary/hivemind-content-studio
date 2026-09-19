// Object → character: the image studio's vision workflow.
//
// A vision model reads ONE picture of an inanimate object and writes an original
// character whose design is that object's colours, shapes and textures carried
// into a person; the paragraph is appended to a short framing prompt and
// rendered. The effect is a showcase of how long and specific a prompt the image
// model will follow (Krea 2 is the one it was found on), so the workflow is two
// plain steps and no graph: a call to the local prompt helper
// (`/api/prompt-helper/design-character`) and a string join.
//
// This file is the pure half — what the dialog asks, which model it asks, and
// how the two prompts meet — so it runs under node:test without a browser.
import { canSelect } from './promptHelperRuntime.js';

// The community recipe, verbatim (2026-09-18). The server's instruction is built
// around the same sentence; this copy is what the dialog hands over when there
// is no vision model on this machine — it works pasted into ANY vision model,
// online or off, which is the recipe's own point.
export const OBJECT_TO_CHARACTER_INSTRUCTION = "Analyze this image's colors, shapes, textures, and distinctive features, then design an original character with face, hair, clothing, accessories, colors, patterns, pose, and personality all creatively translated into a cohesive design without turning them into a costume or copying the subject literally.";

// The "other prompt" the character is appended to: everything the character
// paragraph is told NOT to write — the staging, the light, the art style. Kept
// apart from the character so either half can be rewritten without the other.
// Flat ink-and-cel fashion illustration on purpose: the first version asked for
// "polished painterly concept art on a grey studio backdrop" and got exactly
// that — pleasant, Pixar-ish and nothing like the recipe's results. The design
// reads as a DESIGN when the drawing is graphic.
export const OBJECT_TO_CHARACTER_FRAME = "A striking anime fashion illustration of one original character, drawn with crisp confident ink linework and flat cel colour with only subtle gradients, in elongated elegant proportions like a couture sketch. The figure is shown from the knees up in a poised three-quarter pose and fills the frame. Behind them, a loose abstract wash of painterly brushstrokes in the character's own palette fades to pale paper at the edges. No text, no logos, no other figures.";

/**
 * The framing prompt with the character appended. A blank frame is an ordinary
 * answer (the character alone is a usable prompt); a blank character returns the
 * frame untouched rather than a frame with a dangling space.
 */
export function composeCharacterPrompt(frame, character) {
  const head = String(frame || '').trim();
  const tail = String(character || '').trim();
  if (!head) return tail;
  if (!tail) return head;
  // One paragraph, like every other Krea prompt: a sentence end, then a space.
  return `${/[.!?]$/.test(head) ? head : `${head}.`} ${tail}`;
}

/**
 * Which local model the workflow should ask, read off the prompt helper's
 * runtime snapshot. A model that is already loaded AND can see wins — asking it
 * costs nothing. Otherwise the one to load: the remembered helper when it can
 * see and fits, else the smallest that does (the look is a short read of one
 * picture; nothing about it needs the biggest model on the machine).
 *
 * Returns `{ loaded, candidate, blocked }` — `blocked` is a vision model that is
 * on disk but does not fit, so the dialog can say THAT instead of "no model".
 */
export function pickVisionModel(snapshot, { lastUsedId = '' } = {}) {
  const seeing = (Array.isArray(snapshot?.models) ? snapshot.models : []).filter((model) => model?.vision);
  const loaded = seeing.find((model) => model.fit === 'loaded') || null;
  const loadable = seeing
    .filter((model) => model.fit !== 'loaded' && canSelect(model, { unloadOthers: true }))
    .sort((a, b) => (Number(a.estimatedLoadBytes) || 0) - (Number(b.estimatedLoadBytes) || 0));
  const candidate = loadable.find((model) => model.id === lastUsedId) || loadable[0] || null;
  const blocked = !loaded && !candidate ? (seeing[0] || null) : null;
  return { loaded, candidate, blocked };
}

// The shipped before → after pairs. Every one of them was made by this workflow
// end to end on this lane — the object rendered by Krea 2 Turbo, read by Swarm
// Scout 12B (a Gemma 4 12B) through the shipped instruction, and the character
// rendered by Krea 2 Turbo at the starter's recipe — so the cards are evidence
// of what the button does, not illustrations of what it might.
// The pictures live in studios/image/starterArt.js (Vite imports, which node
// cannot load); `key` is the join.
export const OBJECT_TO_CHARACTER_EXAMPLES = Object.freeze([
  Object.freeze({ key: 'lamp', object: 'A lava lamp', character: 'a bronze-pleated figure under a cone cap' }),
  Object.freeze({ key: 'teapot', object: 'A Delft teapot', character: 'a porcelain coat scrolled in cobalt and gilt' }),
  Object.freeze({ key: 'phone', object: 'A rotary telephone', character: 'lacquered cherry red with a coiled-cord necklace' }),
  Object.freeze({ key: 'lantern', object: 'A stone garden lantern', character: 'tiered stone capes, mossed and glowing amber' }),
]);
