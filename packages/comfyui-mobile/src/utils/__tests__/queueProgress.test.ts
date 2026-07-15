import { describe, expect, it } from 'vitest';
import {
  isComfyProgressQueueItem,
  selectSingleComfyProgressPromptId,
} from '@/utils/queueProgress';

describe('queue progress helpers', () => {
  it('accepts Comfy queue items even when their prompt payload is absent', () => {
    expect(isComfyProgressQueueItem({ prompt_id: 'promptA', extra: {} })).toBe(true);
  });

  it('excludes native MLX queue items from Comfy progress estimation', () => {
    expect(isComfyProgressQueueItem({
      prompt_id: 'promptA',
      extra: { backend: 'native-mlx' },
    })).toBe(false);
  });

  it('returns a fallback prompt only when exactly one Comfy item is active', () => {
    expect(selectSingleComfyProgressPromptId([
      { prompt_id: 'promptA', extra: {} },
      { prompt_id: 'nativeA', extra: { backend: 'mlx' } },
    ])).toBe('promptA');

    expect(selectSingleComfyProgressPromptId([
      { prompt_id: 'promptA', extra: {} },
      { prompt_id: 'promptB', extra: {} },
    ])).toBeNull();
  });
});
