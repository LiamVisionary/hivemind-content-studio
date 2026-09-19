import { useEffect, useState } from 'react';
import { peekResolvedMediaSrc, resolveMediaSrc } from '@/utils/e2eMedia';

// Resolve a media URL through the E2E vault before handing it to <img>/<video>.
// Sealed outputs resolve to a decrypted blob URL; everything else resolves to
// the original URL (fail-open). Returns undefined while an uncached URL is
// resolving so the element never fetches the raw envelope JSON as its src.
export function useResolvedMediaSrc(url: string | null | undefined): string | undefined {
  const [resolved, setResolved] = useState<string | undefined>(() => (url ? peekResolvedMediaSrc(url) ?? undefined : undefined));
  useEffect(() => {
    if (!url) {
      setResolved(undefined);
      return undefined;
    }
    const cached = peekResolvedMediaSrc(url);
    setResolved(cached ?? undefined);
    if (cached) return undefined;
    let cancelled = false;
    void resolveMediaSrc(url).then((value) => {
      if (!cancelled) setResolved(value);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return resolved;
}
