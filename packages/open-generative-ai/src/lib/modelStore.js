// The store half of the Models page: what a model is FOR, and whether this
// machine can run it.
//
// A download button next to "3.4 GB" is not a decision anyone can make. The
// question a person actually has is "will this work on MY computer", and until
// /api/doctor there was nothing in the app that knew. Everything here is pure:
// it takes the doctor's hardware block and a catalog entry and returns the one
// line the card prints, plus the way out when the answer is no — a fit line
// that says "needs a rented GPU" and no way to rent one is a dead end.
//
// The capability badges are NOT written here. They come from the server's
// capability matrix through lib/capabilityMatrix.js, which is the one place
// that holds verdicts about what a model is good at.
import { rateModel } from './capabilityMatrix.js';

/** The machine's own report. Owner-gated, cached server-side, and answered to
 *  a deadline — so a card may ask for it while it paints. */
export async function fetchDoctor({ signal = null } = {}) {
  const response = await fetch('/api/doctor', { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error('Could not read what this machine can run.');
  return response.json();
}

/** Weights are not the whole cost of running a model: activations, the text
 *  encoder and the VAE all live alongside them. A fifth over the file size is
 *  the conservative allowance the fit lines are written against. */
const RUNTIME_OVERHEAD = 1.2;

/** Unified memory is shared with everything else the Mac is doing, so three
 *  quarters of it is what a generation may plan on. A dedicated card keeps
 *  almost all of its VRAM, minus the display and driver's own slice. */
const UNIFIED_SHARE = 0.75;
const DEDICATED_SHARE = 0.9;

/** Room to breathe: a model that only just fits will run, slowly, once. */
const COMFORTABLE = 0.6;

/** Downloading needs the file plus somewhere to put the partial. */
const DISK_MARGIN_GB = 2;

export function formatGB(value) {
  const gb = Number(value) || 0;
  if (!gb) return '';
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(gb * 1024)} MB`;
}

/** What to call this machine in a sentence: "your 36 GB Mac", "your 24 GB
 *  RTX 4090", "this machine". Never a spec sheet — it is the middle of a line
 *  someone reads in half a second. */
export function machineLabel(hardware) {
  const accelerator = hardware?.accelerator || {};
  const ram = Number(hardware?.ram_gb) || 0;
  const vram = Number(accelerator.vram_gb) || 0;
  if (accelerator.class === 'apple-silicon') return ram ? `your ${Math.round(ram)} GB Mac` : 'your Mac';
  if (accelerator.class === 'nvidia') {
    const name = String(accelerator.label || 'GPU').replace(/^NVIDIA\s+/i, '');
    return vram ? `your ${Math.round(vram)} GB ${name}` : `your ${name}`;
  }
  return ram ? `this ${Math.round(ram)} GB machine` : 'this machine';
}

/** How much memory a generation may actually plan on, in GB. */
export function usableMemoryGB(hardware) {
  const accelerator = hardware?.accelerator || {};
  const vram = Number(accelerator.vram_gb) || 0;
  const ram = Number(hardware?.ram_gb) || 0;
  if (accelerator.class === 'apple-silicon') return ram * UNIFIED_SHARE;
  if (accelerator.class === 'nvidia') return (vram || ram) * DEDICATED_SHARE;
  return ram * UNIFIED_SHARE;
}

const RENT_A_GPU = { label: 'Rent a GPU', page: 'machines' };
const CHANGE_THE_FOLDER = { label: 'Change the models folder', page: 'settings' };

/**
 * Will this model run here?
 *
 * `tone` is what the card colours by and `text` is the whole sentence:
 *   unknown  the doctor has not answered yet, or the model has no size
 *   ok       it fits with room to spare
 *   warn     it fits, and the machine will feel it
 *   blocked  it does not fit — `action` is where to go instead
 */
export function modelFit(model, hardware) {
  const sizeGB = Number(model?.sizeGB) || 0;
  if (!hardware || hardware.pending || !hardware.accelerator) {
    return { tone: 'unknown', text: 'Checking what this machine can run…' };
  }
  if (!sizeGB) {
    return { tone: 'unknown', text: 'Runs on the server you point it at, not on this machine.' };
  }

  const where = machineLabel(hardware);
  const free = hardware.free_disk_gb;
  // Only for a model that still has to be fetched: telling someone their disk
  // is too full to download the weights already sitting on it is nonsense.
  const installed = model?.state === 'downloaded';
  if (!installed && typeof free === 'number' && free < sizeGB + DISK_MARGIN_GB) {
    return {
      tone: 'blocked',
      text: `Needs ${formatGB(sizeGB)} and the models disk has ${formatGB(free)} left.`,
      action: CHANGE_THE_FOLDER,
      // The one fit verdict that makes the download itself pointless: it would
      // run for twenty minutes and end on "no space left on device".
      blocksInstall: true,
    };
  }

  const budget = usableMemoryGB(hardware);
  const needs = sizeGB * RUNTIME_OVERHEAD;
  if (!budget) {
    return { tone: 'unknown', text: `${formatGB(sizeGB)} download — this machine has not reported its memory.` };
  }
  if (hardware.accelerator.class === 'cpu' && needs > budget * COMFORTABLE) {
    return { tone: 'blocked', text: `Too big for ${where}, which has no GPU — rent one instead.`, action: RENT_A_GPU };
  }
  if (needs <= budget * COMFORTABLE) {
    const slow = hardware.accelerator.class === 'cpu' ? ' — slow without a GPU' : '';
    return { tone: 'ok', text: `Fits ${where}${slow}.` };
  }
  if (needs <= budget) {
    return { tone: 'warn', text: `Tight on ${where} — close other apps before generating.` };
  }
  return { tone: 'blocked', text: `Too big for ${where} — needs a rented GPU.`, action: RENT_A_GPU };
}

/** One line of "what it is for", written from what the catalog already says
 *  about the model rather than from a second table of opinions. */
export function modelPurpose(model) {
  const tags = (model?.tags || []).map((tag) => String(tag).toLowerCase());
  const type = String(model?.type || '').toLowerCase();
  if (type === 'video') return 'Turns a prompt or a still into a short clip.';
  if (tags.includes('typography')) return 'Posters, logos and anything with words in the picture.';
  if (tags.includes('anime')) return 'Anime and illustration.';
  if (tags.includes('photorealistic')) return 'Photographs of people and places.';
  if (tags.includes('turbo') || tags.includes('fast')) return 'Everyday images, fast enough to iterate on.';
  if (tags.includes('high-quality') || tags.includes('detailed')) return 'Detailed images when you can wait for them.';
  return 'General image generation.';
}

/** The badges under the name: every studio feature the server rates this model
 *  GOOD at. A "workable" is not a selling point and is left off the card. */
export function capabilityBadges(matrix, model, { limit = 3 } = {}) {
  if (!matrix || !model) return [];
  const badges = [];
  for (const feature of matrix.features || []) {
    if (rateModel(feature, model).rating === 'good') badges.push(feature.label);
    if (badges.length >= limit) break;
  }
  return badges;
}

/** A first prompt written for the model that is about to run it. Short on
 *  purpose: "Try it" has to produce a picture, not a writing exercise. */
export function starterPromptFor(model) {
  const tags = (model?.tags || []).map((tag) => String(tag).toLowerCase());
  if (tags.includes('typography')) {
    return 'A bold poster on cream paper with the words "HELLO STUDIO" set in heavy condensed type, soft studio lighting.';
  }
  if (tags.includes('anime')) {
    return 'A calm anime portrait of a young woman on a balcony at golden hour, soft cel shading, clean line art.';
  }
  if (tags.includes('photorealistic')) {
    return 'A candid portrait of a woman laughing in a sunlit kitchen, 50mm lens, shallow depth of field, natural window light.';
  }
  return 'A red enamel coffee cup on a wooden table beside a window, morning light, shallow depth of field.';
}

/** The model to put first on a machine with nothing installed.
 *
 * Z-Image Turbo on Apple Silicon: 3.4 GB, eight steps, and it needs no API key
 * — the shortest road from an empty machine to a first picture. Anywhere else,
 * the best-fitting featured model this hardware can actually hold. */
export function recommendedModelId(models, hardware) {
  const installable = (models || []).filter(
    (model) => model?.provider !== 'wan2gp' && model?.state !== 'downloaded' && Number(model?.sizeGB) > 0,
  );
  if (!installable.length) return '';
  if (hardware?.accelerator?.class === 'apple-silicon') {
    const turbo = installable.find((model) => model.id === 'z-image-turbo');
    if (turbo && modelFit(turbo, hardware).tone === 'ok') return turbo.id;
  }
  // Only a model this machine can actually take. "Start here" on something the
  // disk has no room for, or the memory cannot hold, is worse than no
  // recommendation at all — each card still says where to go instead.
  const fitting = installable.filter((model) => modelFit(model, hardware).tone === 'ok');
  const ranked = fitting.slice().sort((a, b) => (
    Number(Boolean(b.featured)) - Number(Boolean(a.featured))
    || Number(a.sizeGB) - Number(b.sizeGB)
  ));
  return ranked[0]?.id || '';
}
