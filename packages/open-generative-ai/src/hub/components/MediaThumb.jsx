// E2E-sealed thumbnail with the decrypt-and-reveal choreography ported from
// hubApp.js revealHistoryMedia (1079-1096): while the envelope downloads and
// decrypts in-page a padlock breathes over the frame; once the pixels land the
// lock springs open for a beat, then the image fades in. Media already decrypted
// this session (blob cache) skips the theater entirely — that cache-skip is the
// whole point of peeking first. resolveMediaSrc is fail-open for legacy media.
import { useEffect, useRef, useState } from 'react';
import { peekResolvedMediaSrc, resolveMediaSrc } from '../../lib/e2eMedia.js';
import { Icon } from '../../ui/icons.jsx';
import { cx } from '../../ui/kit.jsx';

export function MediaThumb({ url, alt = 'Private output', className = '', imgClassName = '' }) {
  // Cached at first render → straight to unlocked, no lock flash (same as the
  // old peekResolvedMediaSrc cache-hit branch).
  const [state, setState] = useState(() => (url && peekResolvedMediaSrc(url) ? 'unlocked' : 'locked'));
  const [src, setSrc] = useState(() => (url ? peekResolvedMediaSrc(url) : null));
  const revealTimer = useRef(null);

  useEffect(() => {
    if (!url) return undefined;
    let alive = true;
    const cached = peekResolvedMediaSrc(url);
    if (cached) {
      setSrc(cached);
      setState('unlocked');
      return undefined;
    }
    setState('locked');
    setSrc(null);
    resolveMediaSrc(url).then((resolved) => {
      if (!alive || !resolved) return;
      setSrc(resolved);
      setState('unlocking');
      revealTimer.current = setTimeout(() => { if (alive) setState('unlocked'); }, 1000);
    }).catch(() => { if (alive) setState('failed'); });
    return () => {
      alive = false;
      if (revealTimer.current) clearTimeout(revealTimer.current);
    };
  }, [url]);

  const revealed = state === 'unlocked' || state === 'unlocking';

  return (
    <div className={cx('relative overflow-hidden bg-bg3', className)}>
      {src && state !== 'failed' ? (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onError={() => setState('failed')}
          className={cx(
            'h-full w-full object-cover transition-opacity duration-500',
            revealed ? 'opacity-100' : 'opacity-0',
            imgClassName,
          )}
        />
      ) : null}
      {state === 'failed' ? (
        <div className="absolute inset-0 grid place-items-center text-ink3">
          <Icon name="warning" size={20} />
        </div>
      ) : state !== 'unlocked' ? (
        <div className="absolute inset-0 grid place-items-center text-ink3">
          <span
            className={cx(
              'grid h-9 w-9 place-items-center rounded-full bg-bg1/70 text-honey transition-all duration-300',
              state === 'locked' && 'animate-pulse',
            )}
          >
            <Icon name={state === 'unlocking' ? 'unlock' : 'lock'} size={16} />
          </span>
        </div>
      ) : null}
    </div>
  );
}
