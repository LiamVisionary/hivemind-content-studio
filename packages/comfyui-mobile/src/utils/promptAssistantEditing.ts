export interface PromptAssistantEditIdeaOptions {
  instruction: string;
  currentPositive: string;
  currentNegative?: string;
  helperMode?: string;
}

export function buildPromptAssistantEditIdea({
  instruction,
  currentPositive,
  currentNegative = '',
  helperMode = 'None',
}: PromptAssistantEditIdeaOptions): string {
  const cleanInstruction = instruction.trim();
  const positive = currentPositive.trim();
  const negative = currentNegative.trim();
  const mode = helperMode.trim() || 'None';

  return [
    'Edit the existing Prompt Assistant final output instead of starting from scratch.',
    `Helper mode: ${mode}`,
    'Treat the current final positive prompt as the base artifact to patch. Preserve every unrelated detail, field, line, list item, subject trait, setting, lighting, camera, pose, outfit, LoRA trigger, and constraint from it.',
    'Change only the smallest prompt spans required by the edit instruction. Do not summarize, simplify, shorten, reorganize, or regenerate the full prompt from scratch.',
    'If the instruction is phrased as a complaint about what is wrong, infer the minimal corrected state from the current prompt and scene context instead of requiring the user to spell out the replacement.',
    'When a complaint identifies a wrong hand, arm, side, seat, chair, posture, contact point, or subject placement, replace that wrong relationship with the anatomically/spatially plausible counterpart and keep the rest of the scene unchanged.',
    'Preserve the existing output format exactly: plain prompt stays plain, region-line output stays line-based, Krea2/photo JSON keeps the same top-level and nested keys, and bounding-box JSON stays valid compact JSON.',
    'Apply only the requested edit unless a small consistency fix is required by the edit.',
    'Return only the updated final positive prompt and final negative prompt through the normal response fields.',
    '',
    'Current final positive prompt:',
    positive || '(empty)',
    '',
    'Current final negative prompt:',
    negative || '(empty)',
    '',
    'Edit instruction:',
    cleanInstruction,
  ].join('\n');
}
