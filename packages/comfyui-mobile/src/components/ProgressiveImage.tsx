import { useEffect, useState } from 'react';

interface ProgressiveImageProps {
  fullSrc: string;
  previewSrc?: string;
  alt: string;
  className?: string;
  loading?: 'eager' | 'lazy';
  decoding?: 'async' | 'auto' | 'sync';
  fetchPriority?: 'high' | 'low' | 'auto';
  draggable?: boolean;
  onClick?: () => void;
  loadFull?: boolean;
}

export function ProgressiveImage({
  fullSrc,
  previewSrc,
  alt,
  className,
  loading = 'eager',
  decoding = 'async',
  fetchPriority = 'high',
  draggable,
  onClick,
  loadFull = true,
}: ProgressiveImageProps) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const displaySrc = loadedSrc === fullSrc ? fullSrc : (previewSrc || fullSrc);

  useEffect(() => {
    if (!fullSrc || !loadFull) {
      setLoadedSrc(null);
      return;
    }

    const existing = new Image();
    existing.decoding = decoding;
    existing.fetchPriority = fetchPriority;
    existing.onload = () => setLoadedSrc(fullSrc);
    existing.onerror = () => setLoadedSrc(null);
    existing.src = fullSrc;

    if (existing.complete && existing.naturalWidth > 0) {
      setLoadedSrc(fullSrc);
    } else {
      setLoadedSrc(null);
    }
  }, [fullSrc, decoding, fetchPriority, loadFull]);

  return (
    <img
      src={displaySrc}
      alt={alt}
      className={className}
      loading={loading}
      decoding={decoding}
      fetchPriority={fetchPriority}
      draggable={draggable}
      onClick={onClick}
      data-full-src={fullSrc}
      data-preview-src={previewSrc || ''}
      data-full-loaded={loadedSrc === fullSrc ? 'true' : 'false'}
    />
  );
}
