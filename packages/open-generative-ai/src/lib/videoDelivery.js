// What a video target ACCEPTS from another studio, and which grammar its prompt
// is written in.
//
// A sibling of videoTasks.js, and the same doctrine: one place answers "what
// does this model imply", so adding a family means editing this file rather
// than every studio that hands work to the composer. videoTasks.js answers it
// for a run that is ALREADY set up ("a video is attached, so this is an
// extend"); this answers it one step earlier — "I have character sheets, a
// location plate, a storyboard and a timed script; what can THIS target take,
// and how does its prompt want to be written?"
//
// Three facts decide a plan, and they come from three different places on
// purpose:
//
//   family      promptFamilyOf() — already the studio's answer to "which
//               prompt grammar", already handling H3 and LTX by registry family
//               and Seedance by id prefix, already excluding 10Eros from LTX
//               2.3's paragraph style. A second family table would be a second
//               truth.
//   capability  the CALLER passes what the catalog declares (a reference lane,
//               an ingredients lane, an end frame). This module never fetches
//               and never guesses from an id: the registry's `accepts` is the
//               only thing that knows what a workflow can be sent, and it
//               reaches the browser through the catalog mapper.
//   ceiling     how long the family holds a scene, which is a measured property
//               of the model and lives beside the prompt families it belongs to.
//
// Pure: no React, no storage, no network.
import { promptFamilyOf } from './defaultPrompts.js';

/**
 * How a prompt is written for each target.
 *
 * `id` is what a writer switches on. `label` is what the UI says. `pictures`
 * names the vocabulary the grammar uses for attached pictures, so the writer
 * and the attachment can never disagree about what they are called.
 */
export const GRAMMARS = Object.freeze({
  'h3-reference': {
    id: 'h3-reference',
    label: 'MiniMax H3 reference (six sections)',
    // subject_definitions / summary / retention_analysis / detailed_description
    // / overall_soundscape / non_diegetic_music, subjects as <Subject N>.
    sections: true,
    audio: true,
  },
  'h3-text': {
    id: 'h3-text',
    label: 'MiniMax H3 text (three fields)',
    sections: true,
    audio: true,
  },
  'ltx-ingredients': {
    id: 'ltx-ingredients',
    label: 'LTX 2.3 ingredients',
    // The reference sheet is described in its own field and the shot in the
    // prompt; the MCP writes the two headings the graph wants.
    sections: false,
    audio: false,
  },
  'ltx-paragraph': {
    id: 'ltx-paragraph',
    label: 'LTX 2.3 paragraph',
    sections: false,
    audio: false,
  },
  'ltx-scene-script': {
    id: 'ltx-scene-script',
    label: 'LTX scene script',
    sections: false,
    audio: false,
  },
  'seedance-blocks': {
    id: 'seedance-blocks',
    label: 'Seedance labelled blocks',
    sections: false,
    audio: false,
  },
  prose: {
    id: 'prose',
    label: 'Plain prose',
    sections: false,
    audio: false,
  },
});

/**
 * The matrix, by prompt family.
 *
 * `pictures` is what the family can be given as CONDITIONING PICTURES and what
 * that changes about the grammar; `frames` are the timeline slots it accepts.
 * `framesExcludePictures` records the one rule that is easy to get wrong and
 * expensive to discover late: MiniMax H3's reference lane has no frame inputs
 * at all — the registry says the nine pictures come "instead of a start/end
 * frame" and minimax-h3-reference.accepts carries no image_path — so the two
 * are alternatives, never a pair.
 */
const FAMILIES = Object.freeze({
  minimax: {
    label: 'MiniMax H3',
    pictures: { kind: 'reference', max: 9, grammar: 'h3-reference', needsLane: 'reference' },
    textGrammar: 'h3-text',
    frames: ['start', 'end'],
    framesExcludePictures: true,
    negatives: false,
    // H3 denoises its own stereo audio in the same pass, so the script has to
    // say what is heard; every other family here is silent.
    audio: true,
    maxSeconds: 15,
  },
  ltx: {
    label: 'LTX 2.3',
    pictures: { kind: 'ingredients', max: 12, grammar: 'ltx-ingredients', needsLane: 'ingredients' },
    textGrammar: 'ltx-paragraph',
    frames: ['start', 'middle', 'end'],
    framesExcludePictures: false,
    negatives: true,
    audio: false,
    maxSeconds: 10,
  },
  seedance: {
    label: 'Seedance 2.0 / 1.5 / Lite',
    pictures: null,
    textGrammar: 'seedance-blocks',
    frames: ['start', 'end'],
    framesExcludePictures: false,
    negatives: false,
    audio: false,
    maxSeconds: 10,
  },
  'seedance-2.5': {
    label: 'Seedance 2.5',
    pictures: null,
    textGrammar: 'seedance-blocks',
    frames: ['start', 'end'],
    framesExcludePictures: false,
    negatives: false,
    audio: false,
    // The only one that renders the whole half-minute in one generation.
    maxSeconds: 30,
  },
});

// A family nothing is known about. Prose and a start frame is the smallest
// claim that is true of essentially every video model, and claiming less would
// send a target nothing at all.
const UNKNOWN = Object.freeze({
  label: '',
  pictures: null,
  textGrammar: 'prose',
  frames: ['start'],
  framesExcludePictures: false,
  negatives: false,
  audio: false,
  maxSeconds: null,
});

/**
 * 10Eros shares LTX's registry family but wants the scene-script style rather
 * than LTX 2.3's paragraph, and its graph takes neither frames nor ingredients
 * — promptFamilyOf() already returns '' for it, so it is matched here by the
 * same id test rather than by inventing a family for it.
 */
const isEros = (source) => /eros/i.test(String(source?.modelId ?? source?.id ?? ''));

/**
 * What this target can be handed, and how to write for it.
 *
 * `capabilities` is what the catalog DECLARES about the selected model, passed
 * in rather than looked up: the registry's `accepts` is the only authority on
 * what a workflow can be sent, and it reaches the browser through the catalog
 * mapper. Everything omitted is treated as absent, so a caller that knows
 * nothing gets a plan that promises nothing it cannot keep.
 *
 *   referenceLane   the family's reference-picture workflow exists here
 *   ingredientsLane the family's ingredients workflow exists here
 *   endFrame        this model declares an end-frame input
 *   maxSeconds      a per-model ceiling that overrides the family's
 */
export function deliveryPlan(source, capabilities = {}) {
  const family = promptFamilyOf(source);
  const base = FAMILIES[family]
    || (isEros(source) ? { ...UNKNOWN, label: '10Eros', textGrammar: 'ltx-scene-script', frames: [], negatives: true } : UNKNOWN);
  const lane = base.pictures?.needsLane;
  const laneOpen = lane === 'reference'
    ? Boolean(capabilities.referenceLane)
    : lane === 'ingredients' ? Boolean(capabilities.ingredientsLane) : false;
  const frames = base.frames.filter((slot) => (slot === 'end' ? Boolean(capabilities.endFrame) : true));
  const ceiling = Number(capabilities.maxSeconds) > 0 ? Number(capabilities.maxSeconds) : base.maxSeconds;
  return {
    family: family || (isEros(source) ? 'eros' : ''),
    label: base.label,
    // Null when this target cannot take conditioning pictures at all, OR when
    // it could but the lane is not available here — a plan must never promise
    // an attachment the run cannot carry.
    pictures: base.pictures && laneOpen
      ? { kind: base.pictures.kind, max: base.pictures.max, grammar: base.pictures.grammar }
      : null,
    textGrammar: base.textGrammar,
    frames,
    framesExcludePictures: base.framesExcludePictures,
    negatives: base.negatives,
    audio: base.audio,
    maxSeconds: ceiling,
  };
}

/** The grammar a prompt should be written in, given what will be attached. */
export function grammarFor(plan, { pictures = 0 } = {}) {
  const id = plan?.pictures && pictures > 0 ? plan.pictures.grammar : (plan?.textGrammar || 'prose');
  return GRAMMARS[id] || GRAMMARS.prose;
}

/** One line saying what will and will not travel — for a Send-to picker. */
export function describePlan(plan, { pictures = 0, zh = false } = {}) {
  if (!plan) return '';
  if (plan.pictures) {
    const taking = Math.min(pictures, plan.pictures.max);
    const kind = plan.pictures.kind === 'ingredients'
      ? (zh ? '配料参考' : 'ingredient references')
      : (zh ? '参考图' : 'reference pictures');
    if (!pictures) return zh ? `可接收${kind}` : `takes ${kind}`;
    return zh ? `${taking} 张作为${kind}` : `${taking} as ${kind}`;
  }
  if (!pictures) {
    return plan.frames.length
      ? (zh ? '只接收首/尾帧' : `takes ${plan.frames.join('/')} frames only`)
      : (zh ? '只接收文字' : 'takes text only');
  }
  return zh
    ? `不接收图片 — ${pictures} 张不会随行`
    : `no picture lane — ${pictures} would not travel`;
}
