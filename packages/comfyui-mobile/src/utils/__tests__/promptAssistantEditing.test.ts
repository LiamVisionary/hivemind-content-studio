import { describe, expect, it } from 'vitest';
import { buildPromptAssistantEditIdea } from '../promptAssistantEditing';

describe('promptAssistantEditing', () => {
  it('wraps the current final prompt as edit context while preserving helper mode format', () => {
    const idea = buildPromptAssistantEditIdea({
      instruction: 'make the shot wider and keep both subjects visible',
      currentPositive: '{"high_level_description":"two subjects","compositional_deconstruction":{"elements":[]}}',
      currentNegative: 'cropped, close-up',
      helperMode: 'Bounding boxes',
    });

    expect(idea).toContain('Edit the existing Prompt Assistant final output');
    expect(idea).toContain('Helper mode: Bounding boxes');
    expect(idea).toContain('base artifact to patch');
    expect(idea).toContain('Preserve every unrelated detail');
    expect(idea).toContain('bounding-box JSON stays valid compact JSON');
    expect(idea).toContain('"high_level_description":"two subjects"');
    expect(idea).toContain('cropped, close-up');
    expect(idea).toContain('make the shot wider and keep both subjects visible');
  });

  it('tells the model to infer minimal fixes from complaint-only edits', () => {
    const idea = buildPromptAssistantEditIdea({
      instruction:
        "she's using the far hand across her body and they're sitting in the same seat",
      currentPositive:
        'adult woman in left chair, adult man in right chair, warm room lighting, detailed furniture',
      helperMode: 'None',
    });

    expect(idea).toContain('infer the minimal corrected state');
    expect(idea).toContain('wrong hand, arm, side, seat, chair');
    expect(idea).toContain('adult woman in left chair');
    expect(idea).toContain('warm room lighting');
  });
});
