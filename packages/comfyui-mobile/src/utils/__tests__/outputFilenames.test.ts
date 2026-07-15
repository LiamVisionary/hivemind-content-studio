import { describe, expect, it } from 'vitest';
import {
  applyGenerationFilenamePrefixes,
  buildGenerationFilenamePrefix,
  formatFilenameTimestamp,
  modelNameFromPrompt,
  nextFilenameTimestamp,
} from '@/utils/outputFilenames';

describe('output filename helpers', () => {
  const timestamp = new Date(2026, 6, 6, 15, 30, 26, 123);

  it('formats local timestamps with millisecond precision', () => {
    expect(formatFilenameTimestamp(timestamp)).toBe('20260706_153026_123');
  });

  it('keeps generated timestamps monotonic for rapid submits', () => {
    expect(nextFilenameTimestamp(10_000)).toBe(10_000);
    expect(nextFilenameTimestamp(10_000)).toBe(10_001);
  });

  it('extracts a safe model name from loader nodes', () => {
    const prompt = {
      '1': {
        class_type: 'UNETLoader',
        inputs: { unet_name: 'models/diffusion/Krea 2 Turbo.safetensors' },
      },
      '2': {
        class_type: 'SaveImage',
        inputs: { images: ['3', 0], filename_prefix: 'view' },
      },
    };

    expect(modelNameFromPrompt(prompt)).toBe('Krea_2_Turbo');
  });

  it('rewrites SaveImage filename_prefix to model plus timestamp', () => {
    const prompt = {
      '1': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'checkpoints/RealVisXL.ckpt' },
      },
      '9': {
        class_type: 'SaveImage',
        inputs: { images: ['8', 0], filename_prefix: 'view' },
      },
    };

    const updated = applyGenerationFilenamePrefixes(prompt, timestamp);

    expect(updated).not.toBe(prompt);
    expect((updated['9'] as { inputs: Record<string, unknown> }).inputs.filename_prefix)
      .toBe('RealVisXL_20260706_153026_123');
  });

  it('preserves an output subfolder from the existing prefix', () => {
    const prompt = {
      '1': {
        class_type: 'UNETLoader',
        inputs: { unet_name: 'Krea2.safetensors' },
      },
    };

    expect(buildGenerationFilenamePrefix(prompt, timestamp, 'renders/view'))
      .toBe('renders/Krea2_20260706_153026_123');
  });

  it('returns the original prompt when no filename_prefix input exists', () => {
    const prompt = {
      '1': {
        class_type: 'UNETLoader',
        inputs: { unet_name: 'Krea2.safetensors' },
      },
    };

    expect(applyGenerationFilenamePrefixes(prompt, timestamp)).toBe(prompt);
  });
});
