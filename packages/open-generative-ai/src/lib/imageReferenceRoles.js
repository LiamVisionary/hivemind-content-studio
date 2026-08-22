// What each reference image is FOR.
//
// An edit with four references attached and nothing said about them is a
// guess: the model decides on its own which picture supplies the face, which
// supplies the jacket, and which was only ever meant to be the room. Naming the
// job of each one is the whole difference between a composite and a collage —
// and the roles below are the vocabulary the model actually responds to, worded
// as ownership ("supplies X only; it does not supply Y") rather than as a hint.
//
// Two labelling styles, because two families read references differently:
//
//   h3       MiniMax H3's still-image lane takes nine ORDERED slots and knows
//            them as <Picture N>, the same tags its video prompts use.
//   ordinal  FLUX.2 Klein and the cloud edit models have no tag grammar; they
//            are addressed by position, "the first reference image".
//
// Applying is idempotent the way cameraMotion.js is: the previously written
// block is stripped before the new one is appended, so tweaking a role five
// times leaves one block rather than five.
//
// Role vocabulary surveyed from the community H3 Prompt Composer
// (BMB12d3/minimax-h3-prompt-composer) image mode; the clauses are ours.

export const IMAGE_REFERENCE_ROLES = Object.freeze([
  ['base_image', 'Base image', 'Everything is preserved except the requested edit'],
  ['identity', 'Identity only', 'Who the subject is — not their pose, setting or lighting'],
  ['head_identity', 'Head / face only', 'Face, hairline and hairstyle — the body stays from the base image'],
  ['wardrobe', 'Wardrobe only', 'Clothing, accessories, materials and fit'],
  ['environment', 'Environment only', 'Location and background, not the subject'],
  ['pose_depth', 'Pose / geometry only', 'Body pose, orientation and depth — not identity or wardrobe'],
  ['composition', 'Composition only', 'Viewpoint, framing and camera angle'],
  ['lighting', 'Lighting only', 'Key/fill/rim balance, exposure and reflected colour'],
  ['style', 'Style only', 'The stylisation treatment, nothing else'],
  ['object_prop', 'Object / prop', 'A specific object to include'],
  ['placement', 'Placement map', 'Coordinates, not pixels — where things sit, not how they look'],
  ['custom', 'Custom', 'Say it in your own words'],
].map((row) => Object.freeze(row)));

const ROLE_IDS = new Set(IMAGE_REFERENCE_ROLES.map(([id]) => id));

export const DEFAULT_IMAGE_REFERENCE_ROLE = 'identity';

/** The heading the block is written under, and the anchor for stripping it. */
export const OWNERSHIP_HEADING = 'Reference ownership:';

/** How a reference is addressed, given the family and its position. */
export function referenceLabelFor(index, style = 'ordinal') {
  if (style === 'h3') return `<Picture ${index + 1}>`;
  const words = ['the first', 'the second', 'the third', 'the fourth', 'the fifth', 'the sixth', 'the seventh', 'the eighth', 'the ninth'];
  return `${words[index] || `reference ${index + 1}`} reference image`;
}

const CLAUSES = {
  base_image: (label) => `${label} is the base image. Preserve its subject, pose, wardrobe, environment, lighting and composition except where the requested edit explicitly changes them.`,
  identity: (label) => `${label} supplies subject identity and recognisable appearance only; it does not supply pose, environment, lighting or framing.`,
  head_identity: (label) => `${label} supplies face, head identity, hairline and hairstyle only; the body, pose, wardrobe and environment stay as the base image has them.`,
  wardrobe: (label) => `${label} supplies wardrobe, accessories, materials, colours and fit only; no identity, pose, environment or camera carries from it.`,
  environment: (label) => `${label} supplies the environment only — background, setting and spatial context — and does not replace the subject.`,
  pose_depth: (label) => `${label} supplies pose, body orientation and depth relationships only; no identity, wardrobe, environment or style carries from it.`,
  composition: (label) => `${label} supplies viewpoint, framing and camera angle only; it does not define who is in the frame.`,
  lighting: (label) => `${label} supplies lighting only — key, fill and rim balance, exposure, reflected colour and atmospheric integration.`,
  style: (label) => `${label} supplies the visual style only.`,
  object_prop: (label) => `${label} supplies only the object to include.`,
  // The one role that has to argue with itself: a placement map looks like a
  // picture, and a model handed one will happily copy its pixels unless told
  // in as many words that it is coordinates.
  placement: (label) => `${label} is a spatial placement map, not an appearance reference. Read it as coordinates rather than pixels: position, scale, depth, orientation, ground contact and occlusion only. Render the subject from its own identity reference, and take lighting, shadows, reflections, focus and texture from the base image.`,
  custom: (label) => `${label} supplies only what is described below.`,
};

/** One reference's ownership line, or '' when there is nothing to say. */
export function referenceRoleClause(role, label, note = '') {
  const id = ROLE_IDS.has(role) ? role : DEFAULT_IMAGE_REFERENCE_ROLE;
  const text = String(note || '').trim();
  if (id === 'custom') return text ? `${label} ${text.replace(/^[.\s]+/, '')}` : CLAUSES.custom(label);
  const clause = CLAUSES[id](label);
  return text ? `${clause} ${text}` : clause;
}

/** Roles for a set of references, filled in and trimmed to what is attached. */
export function normalizeReferenceRoles(roles, count) {
  const out = [];
  for (let index = 0; index < Math.max(0, Number(count) || 0); index += 1) {
    const row = Array.isArray(roles) ? roles[index] : null;
    const id = ROLE_IDS.has(row?.role) ? row.role : DEFAULT_IMAGE_REFERENCE_ROLE;
    out.push({ role: id, note: String(row?.note || '') });
  }
  return out;
}

/** True when the roles say anything the model would not have assumed. */
export function referenceRolesAreSet(roles, count) {
  return normalizeReferenceRoles(roles, count).some(
    (row) => row.role !== DEFAULT_IMAGE_REFERENCE_ROLE || row.note.trim(),
  );
}

/** The block as it will be written, or '' when there is nothing to write. */
export function referenceOwnershipBlock(roles, count, { labelStyle = 'ordinal' } = {}) {
  const rows = normalizeReferenceRoles(roles, count);
  if (!rows.length) return '';
  const lines = rows
    .map((row, index) => referenceRoleClause(row.role, referenceLabelFor(index, labelStyle), row.note))
    .filter(Boolean)
    .map((line) => `- ${line}`);
  return lines.length ? `${OWNERSHIP_HEADING}\n${lines.join('\n')}` : '';
}

// Anchored on the heading and running to the end of the bullet list, so a
// re-apply replaces the previous block instead of stacking a second one under
// it. Bullets only — prose the author wrote after the block survives.
const BLOCK = new RegExp(
  `\\n*${OWNERSHIP_HEADING.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\n(?:-[^\\n]*\\n?)*`,
  'g',
);

export function stripReferenceOwnership(prompt) {
  return String(prompt || '').replace(BLOCK, '\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Prompt + roles -> prompt. The block goes at the END, after the description of
 * what the picture should be, because it is an instruction about the inputs
 * rather than about the result.
 */
export function applyReferenceRoles(prompt, roles, count, { labelStyle = 'ordinal' } = {}) {
  const base = stripReferenceOwnership(prompt);
  const block = referenceRolesAreSet(roles, count)
    ? referenceOwnershipBlock(roles, count, { labelStyle })
    : '';
  if (!block) return base;
  return base ? `${base}\n\n${block}` : block;
}

/** Which labelling style a model reads. H3 is the only one with tags. */
export function referenceLabelStyleFor(modelId) {
  return /minimax-h3/.test(String(modelId || '')) ? 'h3' : 'ordinal';
}
