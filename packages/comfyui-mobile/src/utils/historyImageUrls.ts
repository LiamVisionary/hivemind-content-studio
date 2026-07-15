import { getImagePreviewUrl, getImageUrl, withWebpPreview } from '@/api/client';

interface HistoryImageUrlSource {
  filename: string;
  subfolder: string;
  type: string;
  fullUrl?: string;
}

export function getHistoryImageUrl(image: HistoryImageUrlSource): string {
  return image.fullUrl || getImageUrl(image.filename, image.subfolder, image.type);
}

export function getHistoryImagePreviewUrl(image: HistoryImageUrlSource): string {
  if (!image.fullUrl) {
    return getImagePreviewUrl(image.filename, image.subfolder, image.type);
  }
  return image.fullUrl.includes('/view?') ? withWebpPreview(image.fullUrl) : image.fullUrl;
}
