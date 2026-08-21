// E2E-sealed thumbnail with the decrypt-and-reveal choreography ported from
// hubApp.js revealHistoryMedia (1079-1096): while the envelope downloads and
// decrypts in-page a padlock breathes over the frame; once the pixels land the
// lock springs open for a beat, then the image fades in. Media already decrypted
// this session (blob cache) skips the theater entirely — that cache-skip is the
// whole point of peeking first. resolveMediaSrc is fail-open for legacy media.
import { useEffect, useRef, useState } from 'react';
import { mediaSealFailure, peekResolvedMediaSrc, resolveMediaSrc } from '../../lib/e2eMedia.js';
import { Icon } from '../../ui/icons.jsx';
import { cx } from '../../ui/kit.jsx';

// Sealed media this tab cannot open. resolveMediaSrc fails open to the envelope
// URL, so without this the element is simply pointed at ciphertext: a broken
// <img>, or a <video> that sits at readyState 0 looking like a dead generation.
// Shared by the thumbs here and the video cards in HistoryView so the state reads
// the same wherever sealed media lands.
export function VaultLockedTile({ reason = 'locked', className = '' }) {
  const locked = reason !== 'undecryptable';
  const title = locked ? 'Vault locked' : "Can't decrypt";
  const detail = locked ? 'Unlock the studio to view' : 'Sealed for a different key';
  return (
    <div
      title={`${title} — ${detail}`}
      className={cx(
        'flex h-full w-full flex-col items-center justify-center gap-1.5 bg-bg3 px-3 text-center text-ink3',
        className,
      )}
    >
      <span className="grid h-9 w-9 place-items-center rounded-full bg-bg1/70 text-honey">
        <Icon name={locked ? 'lock' : 'warning'} size={16} />
      </span>
      <b className="text-[11px] font-semibold">{title}</b>
      <small className="text-[10px] leading-tight">{detail}</small>
    </div>
  );
}

export function MediaThumb({ url, alt = 'Private output', className = '', imgClassName = '' }) {
  // Cached at first render → straight to unlocked, no lock flash (same as the
  // old peekResolvedMediaSrc cache-hit branch). A URL already known to be sealed
  // and unopenable here starts vault-locked, with no re-probe flash.
  const [state, setState] = useState(() => {
    if (url && peekResolvedMediaSrc(url)) return 'unlocked';
    return url && mediaSealFailure(url) ? 'vault-locked' : 'locked';
  });
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
    setState(mediaSealFailure(url) ? 'vault-locked' : 'locked');
    setSrc(null);
    resolveMediaSrc(url).then((resolved) => {
      if (!alive || !resolved) return;
      if (mediaSealFailure(url)) {
        // Fail-open handed back the raw envelope URL; an <img> would just error.
        setState('vault-locked');
        return;
      }
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
      {state === 'vault-locked' ? (
        <div className="absolute inset-0">
          <VaultLockedTile reason={mediaSealFailure(url)} />
        </div>
      ) : state === 'failed' ? (
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
