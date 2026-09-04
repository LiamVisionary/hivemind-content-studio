// E2E-sealed thumbnail with the decrypt-and-reveal choreography ported from
// hubApp.js revealHistoryMedia (1079-1096): while the envelope downloads and
// decrypts in-page a padlock breathes over the frame; once the pixels land the
// lock springs open for a beat, then the image fades in. Media already decrypted
// this session (blob cache) skips the theater entirely — that cache-skip is the
// whole point of peeking first. resolveMediaSrc is fail-open for legacy media.
import { useEffect, useRef, useState } from 'react';
import { useVaultUnlockNonce } from '../../hooks/hooks.js';
import {
  mediaSealFailure, peekResolvedMediaSrc, releaseResolvedMedia, resolveMediaSrc, retainResolvedMedia,
} from '../../lib/e2eMedia.js';
import { requestVaultUnlock } from '../../lib/vaultSession.js';
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
  const detail = locked ? 'Click to unlock your vault' : 'Sealed for a different key';
  const body = (
    <>
      <span className="grid h-9 w-9 place-items-center rounded-full bg-bg1/70 text-honey">
        <Icon name={locked ? 'lock' : 'warning'} size={16} />
      </span>
      <b className="text-[11px] font-semibold">{title}</b>
      <small className="text-[10px] leading-tight">{detail}</small>
    </>
  );
  const classes = cx(
    'flex h-full w-full flex-col items-center justify-center gap-1.5 bg-bg3 px-3 text-center text-ink3',
    className,
  );
  // A locked tile is the moment the user wants to unlock; the button opens the
  // in-app unlock flow (VaultUnlockModal) instead of pointing at a control that
  // may not be on screen.
  if (locked) {
    return (
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); requestVaultUnlock(); }}
        title={`${title} — ${detail}`}
        className={cx(classes, 'cursor-pointer transition-colors hover:bg-bg2')}
      >
        {body}
      </button>
    );
  }
  return (
    <div title={`${title} — ${detail}`} className={classes}>
      {body}
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
  // Bumped by the failed tile's click so the resolve effect runs again.
  const [retry, setRetry] = useState(0);
  // …and by an in-app unlock, which is the same "try again" for a tile that was
  // drawn locked. It is why unlocking a second tab no longer reloads the page.
  const unlocked = useVaultUnlockNonce();
  const revealTimer = useRef(null);

  useEffect(() => {
    if (!url) return undefined;
    let alive = true;
    // Same contract as useMediaSrc: a mounted tile holds its decrypted bytes, so
    // the byte-budgeted cache never revokes an object URL this <img> is showing.
    retainResolvedMedia(url);
    const release = () => releaseResolvedMedia(url);
    const cached = peekResolvedMediaSrc(url);
    if (cached) {
      setSrc(cached);
      setState('unlocked');
      return release;
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
      release();
      if (revealTimer.current) clearTimeout(revealTimer.current);
    };
  }, [url, retry, unlocked]);

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
        // Same shape as the vault tile: a glyph alone read as "broken app", not
        // "this file did not load". Click retries the fetch.
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); setSrc(null); setState('locked'); setRetry((n) => n + 1); }}
          title="Could not load this output — click to retry"
          className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-bg3 px-3 text-center text-ink3 transition-colors hover:bg-bg2"
        >
          <span className="grid h-9 w-9 place-items-center rounded-full bg-bg1/70 text-warn">
            <Icon name="warning" size={16} />
          </span>
          <b className="text-[11px] font-semibold">Could not load</b>
          <small className="text-[10px] leading-tight">Click to retry</small>
        </button>
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
