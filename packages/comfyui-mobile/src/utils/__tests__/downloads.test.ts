import { describe, expect, it } from 'vitest';
import { filenameFromSrc } from '@/utils/downloads';

describe('download filename helpers', () => {
  it('uses the Comfy view filename query param instead of the route name', () => {
    expect(filenameFromSrc('/comfy/view?filename=Krea2_20260706_153026_123.png&type=output'))
      .toBe('Krea2_20260706_153026_123.png');
  });

  it('falls back to the final path segment for non-view URLs', () => {
    expect(filenameFromSrc('/image/native-output.png?token=secretless'))
      .toBe('native-output.png');
  });
});
