// Stage 6 — the gate: what has to be true before a clip is worth finishing.
//
// The checks are ordered by what they cost to fix. Identity is first because a
// drifting character invalidates every frame; finishing is last because
// upscaling, stitching and captioning all multiply whatever is underneath them.
// An upscaler sharpens pixels. It does not repair weak acting, an unreadable
// action, a broken identity or a dead world.
//
// The repair matrix is the useful half. When a check fails the instinct is to
// regenerate everything, which changes every variable at once and teaches you
// nothing about which one was wrong. Each entry names the layer to change and
// leaves the rest alone.

/** The approval order. `blocks` marks the ones that make a clip unpublishable
 *  rather than merely worse. */
export const QA_CHECKS = Object.freeze([
  { id: 'identity', label: 'Identity holds', blocks: true, asks: 'Same face, silhouette, markings and signature detail from first frame to last?' },
  { id: 'action', label: 'The action reads', blocks: true, asks: 'Can someone who has heard no explanation say what happened?' },
  { id: 'turn', label: 'The turn lands', blocks: true, asks: 'Does the feeling actually change, and can you point at when?' },
  { id: 'world', label: 'The world responds', blocks: false, asks: 'Do weather, cloth, props and depth move because of something?' },
  { id: 'camera', label: 'The camera is motivated', blocks: false, asks: 'Does every move reveal information or emotion?' },
  { id: 'audio', label: 'Audio matches what is visible', blocks: false, asks: 'Does every sound have a source on screen or in the place?' },
  { id: 'defects', label: 'No trust-breaking defect', blocks: true, asks: 'Morphing, extra limbs, duplicated props, a hand that becomes a paw?' },
  { id: 'boundary', label: 'The boundary is inheritable', blocks: false, asks: 'Can the next generation open on this final pose, gaze, prop state and framing?' },
  { id: 'first', label: 'The first frame works muted', blocks: true, asks: 'At phone size, with no sound, does frame one earn the second second?' },
]);

/**
 * Failure to repair, one layer at a time.
 *
 * `stage` is which stage of the production to go back to — the point being that
 * most of these do NOT send you back to the beginning.
 */
export const REPAIRS = Object.freeze([
  {
    id: 'drift', label: 'The character drifts', stage: 'characters',
    cause: 'The sheet is inconsistent, or appearance text in the prompt is arguing with it.',
    fix: 'Regenerate the sheet until the three views agree, attach that one version alone, and delete every appearance sentence from the prompt.',
  },
  {
    id: 'poster', label: 'It looks like an animated poster', stage: 'motion',
    cause: 'No motion inventory — the camera was asked to do all the work.',
    fix: 'Name one force and give the subject, a contact object, the foreground and the background each a response to it. Cut the zoom.',
  },
  {
    id: 'camera', label: 'The camera wanders', stage: 'motion',
    cause: 'Freedom without motivation.',
    fix: 'State what each angle must reveal, and hold it to two to four changes for a fifteen-second shot.',
  },
  {
    id: 'ignored', label: 'The storyboard was ignored', stage: 'board',
    cause: 'Too many beats, or expecting the panels to be traced.',
    fix: 'Cut beats, add time codes, and isolate the one beat that has to be exact as its own precision generation.',
  },
  {
    id: 'dead', label: 'The world is dead', stage: 'motion',
    cause: 'Only the characters were given anything to do.',
    fix: 'Add the world-breathes sentence: one force, and what each depth does about it.',
  },
  {
    id: 'mushy', label: 'The action is mushy', stage: 'motion',
    cause: 'Several actions inside one short beat.',
    fix: 'One dominant verb and one emotional result per beat. Move the rest into the next beat or the next generation.',
  },
  {
    id: 'seam', label: 'Continuity breaks between clips', stage: 'motion',
    cause: 'The boundary had no stated handoff state.',
    fix: 'End and open on the same pose, gaze, prop state and framing, and repeat only those facts at the seam.',
  },
  {
    id: 'forgettable', label: 'Beautiful but forgettable', stage: 'concept',
    cause: 'No behaviour only this character would perform.',
    fix: 'Go back to the contract and replace generic charm with the signature behaviour. This is a concept problem, not a render problem.',
  },
]);

/** Which repairs to offer for a failed check, most likely first. */
const CHECK_REPAIRS = Object.freeze({
  identity: ['drift'],
  action: ['mushy', 'ignored'],
  turn: ['forgettable', 'mushy'],
  world: ['dead', 'poster'],
  camera: ['camera', 'poster'],
  audio: ['dead'],
  defects: ['drift'],
  boundary: ['seam'],
  first: ['ignored', 'forgettable'],
});

export function repairsFor(checkId) {
  return (CHECK_REPAIRS[checkId] || []).map((id) => REPAIRS.find((entry) => entry.id === id)).filter(Boolean);
}

/**
 * The verdict on a set of answers. `verdicts` maps check id to 'pass' | 'fail';
 * anything else is untested, which is not the same as a pass and is reported
 * separately rather than counted either way.
 */
export function shipVerdict(verdicts = {}) {
  const failed = QA_CHECKS.filter((check) => verdicts?.[check.id] === 'fail');
  const untested = QA_CHECKS.filter((check) => !verdicts?.[check.id]);
  const blocking = failed.filter((check) => check.blocks);
  if (blocking.length) {
    return {
      state: 'blocked',
      headline: `${blocking.length} check${blocking.length === 1 ? '' : 's'} block${blocking.length === 1 ? 's' : ''} publishing.`,
      detail: 'Repair the weakest layer only — changing everything at once tells you nothing about which change worked.',
      failed, untested,
    };
  }
  if (failed.length) {
    return {
      state: 'repair',
      headline: `${failed.length} soft failure${failed.length === 1 ? '' : 's'}.`,
      detail: 'None of these breaks trust. Ship it, or spend one targeted repair — not a full regeneration.',
      failed, untested,
    };
  }
  if (untested.length) {
    return {
      state: 'untested',
      headline: `${untested.length} check${untested.length === 1 ? '' : 's'} not run yet.`,
      detail: 'An unrun check is not a pass.',
      failed, untested,
    };
  }
  return {
    state: 'ship',
    headline: 'Everything passes.',
    detail: 'Now stitch, sound, caption and upscale — in that order, and only now.',
    failed, untested,
  };
}

/** What finishing means, in the order it is safe to do it. */
export const FINISH_ORDER = Object.freeze([
  'Join the approved takes',
  'Balance the sound',
  'Write the caption',
  'Upscale the final cut',
]);

/** The caption, built as beats rather than as a paragraph. */
export const CAPTION_BEATS = Object.freeze([
  { id: 'hook', label: 'Micro-hook', asks: 'What small truth or question opens the feeling?' },
  { id: 'scene', label: 'Scene', asks: 'Where are we, and what ordinary thing is happening?' },
  { id: 'friction', label: 'Friction', asks: 'What refuses to cooperate?' },
  { id: 'signature', label: 'Signature', asks: 'What behaviour makes this character unmistakable?' },
  { id: 'turn', label: 'Turn', asks: 'What did the moment become?' },
  { id: 'invite', label: 'Invitation', asks: 'What memory or feeling can a viewer answer with?' },
  { id: 'cta', label: 'One CTA', asks: 'Save, share, follow, or look — pick exactly one.' },
]);

const text = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');

/** The caption as written text, plus the reason it is not ready when it isn't. */
export function buildCaption(values = {}) {
  const lines = CAPTION_BEATS.map((beat) => text(values?.[beat.id])).filter(Boolean);
  const problems = [];
  if (!text(values?.hook)) problems.push('No micro-hook — the first line is the whole caption for most viewers.');
  if (!text(values?.cta)) problems.push('No call to action.');
  const ctas = text(values?.cta).split(/[,.;]|\band\b/i).map(text).filter(Boolean);
  if (ctas.length > 1) problems.push(`${ctas.length} calls to action. Splitting attention costs you all of them.`);
  return { caption: lines.join(' '), problems };
}

/**
 * What a performance signal actually means, and the single change to make next.
 *
 * Deliberately one change each. Changing the hook, the pacing and the caption
 * together and then reading the numbers is not an experiment.
 */
export const SIGNAL_READS = Object.freeze([
  { id: 'early-drop', signal: 'Strong start, weak finish', means: 'The hook works; the payoff or the pacing does not.', next: 'Shorten the setup, or split the story into two generations so the reward has room.' },
  { id: 'likes-no-saves', signal: 'Plenty of likes, few saves or shares', means: 'Pleasant, but not meaningful or useful.', next: 'Add a sharper relationship insight or a final image worth keeping.' },
  { id: 'shares-no-follows', signal: 'Shares, but no follows', means: 'The story travels; the world has no identity.', next: 'Strengthen the signature detail and name the series.' },
  { id: 'comments-low-watch', signal: 'Comments, but low watch time', means: 'The premise invites discussion; the video drags.', next: 'Move the character’s response earlier.' },
  { id: 'reach-no-sales', signal: 'Reach, but nothing sold', means: 'The attention and the offer are about different things.', next: 'Align the CTA with the desire the comments and saves are actually expressing.' },
]);

/** One variable at a time, so a result means something. */
export const ITERATION_LAYERS = Object.freeze([
  'hook', 'board density', 'beat timing', 'motion inventory', 'camera plan', 'audio', 'caption', 'CTA',
]);
