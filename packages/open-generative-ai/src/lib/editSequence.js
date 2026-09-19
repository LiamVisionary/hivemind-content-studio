// Sequential edit chains (Mix-Studio port, GPL-3.0 lib/edit-sequence.js):
// prompts run in order, each step editing the PREVIOUS step's output, with the
// seed advancing by one per step. Normalization mirrors the donor's caps.

export const MAX_SEQUENCE_STEPS = 12;
export const MAX_STEP_LENGTH = 800;

export function normalizeSequentialPrompts(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || '').split('\n');
  return list
    .map((step) => String(step || '').trim().slice(0, MAX_STEP_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_SEQUENCE_STEPS);
}

export function normalizeEditSequence(value) {
  if (!value || typeof value !== 'object') return null;
  const prompts = normalizeSequentialPrompts(value.prompts);
  if (prompts.length < 2) return null;
  const requestedIndex = Math.floor(Number(value.index));
  const index = Number.isFinite(requestedIndex)
    ? Math.max(0, Math.min(prompts.length - 1, requestedIndex))
    : 0;
  return { prompts, index, total: prompts.length };
}
