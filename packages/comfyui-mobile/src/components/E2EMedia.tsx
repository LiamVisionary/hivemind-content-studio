import type { ComponentProps } from 'react';
import { useResolvedMediaSrc } from '@/hooks/useResolvedMediaSrc';

// Drop-in <img>/<video> that route their src through the E2E vault first.
// Sealed outputs render from a decrypted blob URL; plaintext URLs pass through
// unchanged (fail-open). While an uncached URL resolves, src stays unset so the
// element never loads the raw envelope JSON.

export function E2EImage({ src, ...rest }: ComponentProps<'img'>) {
  const resolved = useResolvedMediaSrc(src);
  return <img {...rest} src={resolved} />;
}

export function E2EVideo({ src, ...rest }: ComponentProps<'video'>) {
  const resolved = useResolvedMediaSrc(src);
  return <video {...rest} src={resolved} />;
}
