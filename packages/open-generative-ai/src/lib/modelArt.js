// Card art for a runnable model: fetching it once, and what to draw until it
// arrives.
//
// The bridge does the finding (see model-artwork.js) and keeps the answer for a
// week, so the cost here is one request per distinct model the first time the
// page is opened and nothing afterwards. Two things still matter on this side:
//
//   * ONE request per model, not one per render. React re-renders a grid
//     constantly; an effect that fetches on every pass would hammer the bridge
//     and, through it, Civitai.
//   * A card that has no picture must still look like a card. Every model gets
//     a stable colour derived from its own id, so an unmatched model reads as a
//     deliberate tile rather than a hole in the grid.

import { localAI } from './localInferenceClient.js';

/** The identity a card lookup is cached under. Mirrors what the bridge searches
 *  with — base models, family, name — so two lanes of the same model share one
 *  answer, and two different models never do. */
export function modelArtKey(model) {
  const bases = Array.isArray(model?.compatibleBaseModels) ? model.compatibleBaseModels : [];
  return [
    bases.join(','),
    model?.workflowFamily || model?.family || '',
    model?.name || '',
  ].join('|').toLowerCase();
}

const cards = new Map();
const waiting = [];
let running = 0;
// The bridge resolves a card by talking to two or three services in sequence,
// which takes seconds on a cold cache. Four at a time keeps a grid filling in
// steadily without opening seventeen sockets and a matching burst of outbound
// requests the moment the page is opened.
const MAX_PARALLEL = 4;

function pump() {
  while (running < MAX_PARALLEL && waiting.length) {
    const job = waiting.shift();
    running += 1;
    job().finally(() => {
      running -= 1;
      pump();
    });
  }
}

/** The card for one model, fetched at most once per session per model.
 *  Resolves null when this build's bridge cannot answer, or nothing matched. */
export function loadModelCard(model) {
  const key = modelArtKey(model);
  if (!key.replace(/\|/g, '')) return Promise.resolve(null);
  if (cards.has(key)) return cards.get(key);
  const promise = new Promise((resolve) => {
    waiting.push(async () => {
      const card = await localAI.modelCard(model);
      resolve(card);
    });
    pump();
  });
  cards.set(key, promise);
  return promise;
}

/** Test seam, and what a Rescan press clears: the next read asks again. */
export function forgetModelCards() {
  cards.clear();
}

/* ---------------- what a card looks like without a picture ---------------- */

// A hue per model, stable across sessions because it is derived from the id
// rather than from where the model happens to sit in a list.
function hashOf(value) {
  let hash = 0;
  for (const character of String(value || '')) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

/** A tile background for a model with no artwork — two angles of one hue, so a
 *  grid of unmatched models still reads as a set rather than as grey boxes. */
export function modelTint(model) {
  const hue = hashOf(model?.id || model?.name) % 360;
  return `linear-gradient(140deg, hsl(${hue} 42% 26%), hsl(${(hue + 38) % 360} 38% 14%))`;
}

/** One or two letters for that tile: "Z-Image Turbo" → "ZI", "MiniMax H3" → "MH". */
export function modelInitials(model) {
  const words = String(model?.name || model?.id || '')
    .split(/[\s\-_.]+/)
    .filter((word) => /[a-z0-9]/i.test(word));
  if (!words.length) return '?';
  const letters = words.slice(0, 2).map((word) => word[0].toUpperCase());
  return letters.join('');
}

/* ---------------- reading a resolved card ---------------- */

/** The sentence under a model's name: what the source says about it, and the
 *  registry's own line only when no source had anything. The registry describes
 *  a LANE ("Regular LTX 2.3 image-to-video and source-video extension
 *  workflow"), which is the right thing to fall back to and the wrong thing to
 *  lead with. */
export function modelBlurb(model, card) {
  return String(card?.about || model?.description || '').trim();
}

/** Which catalogue a card's facts came from: 'civitai', 'huggingface', or ''
 *  when nothing matched. The open mirror and civitai.com are one catalogue as
 *  far as a reader is concerned — the same pages, reached two ways. */
export function cardSourceKind(card) {
  if (card?.source === 'huggingface') return 'huggingface';
  if (card?.source === 'civitai' || card?.source === 'civitai-mirror') return 'civitai';
  return '';
}

/** Which catalogue the PICTURE came from, which is not always the one that
 *  wrote the description. */
export function cardArtKind(card) {
  return cardSourceKind({ source: card?.artSource });
}

// Under this the bridge matched something, but not something it is sure about,
// and the page says so rather than presenting a guess as a fact. Mirrors
// MATCH_CONFIDENT in model-artwork.js.
const MATCH_CONFIDENT = 0.7;

export function cardIsGuess(card) {
  return Boolean(card?.source) && Number(card.matched || 0) < MATCH_CONFIDENT;
}
