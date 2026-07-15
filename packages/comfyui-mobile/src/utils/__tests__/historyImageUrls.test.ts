import { describe, expect, it } from 'vitest';
import { getHistoryImagePreviewUrl, getHistoryImageUrl } from '@/utils/historyImageUrls';

describe('history image URL helpers', () => {
  it('uses wrapper-native full URLs as the source and preview URL', () => {
    const image = {
      filename: 'native.png',
      subfolder: '',
      type: 'output',
      fullUrl: '/image/native.png?token=secretless',
    };

    expect(getHistoryImageUrl(image)).toBe('/image/native.png?token=secretless');
    expect(getHistoryImagePreviewUrl(image)).toBe('/image/native.png?token=secretless');
  });

  it('falls back to Comfy view URLs when no full URL is present', () => {
    const image = { filename: 'comfy.png', subfolder: '', type: 'output' };

    expect(getHistoryImageUrl(image)).toContain('/comfy/view?filename=comfy.png');
    expect(getHistoryImagePreviewUrl(image)).toContain('preview=webp;90');
  });
});
