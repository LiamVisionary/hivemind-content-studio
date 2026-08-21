// E2E-sealed thumbnail with the decrypt-and-reveal choreography ported from
// hubApp.js revealHistoryMedia (1079-1096): while the envelope downloads and
// decrypts in-page a padlock breathes over the frame; once the pixels land the
// lock springs open for a beat, then the image fades in. Media already decrypted
// this session (blob cache) skips the theater entirely — that cache-skip is the
// whole point of peeking first. resolveMediaSrc is fail-open for legacy media.
import { useEffect, useRef, useState } from 'react';
import { isMediaVaultLocked, peekResolvedMediaSrc, resolveMediaSrc } from '../../lib/e2eMedia.js';
import { requestVaultUnlock } from '../../lib/vaultSession.js';
import { Icon } from '../../ui/icons.jsx';
import { cx } from '../../ui/kit.jsx';

// Sealed media whose vault has no key in this tab. Fills its container; clicking
// opens the in-app unlock flow (VaultUnlockModal). Shared by image thumbs here
// and the video cards in HistoryView so the locked state reads the same.
export function VaultLockedTile({ className = '' }) {
  return (
    <button
      type="button"
      onClick={requestVaultUnlock}
      aria-label="Vault locked — unlock to view"
      className={cx(
        'flex h-full w-full flex-col items-center justify-center gap-1.5 bg-bg3 px-3 text-center text-ink3 transition-colors hover:text-ink1',
        className,
      )}
    >
      <span className="grid h-9 w-9 place-items-center rounded-full bg-bg1/70 text-honey">
        <Icon name="lock" size={16} />
      </span>
      <b className="text-[11px] font-semibold">Vault locked</b>
      <small className="text-[10px]">Unlock to view</small>
    </button>
  );
}

export function MediaThumb({ url, alt = 'Private output', className = '', imgClassName = '' }) {
  // Cached at first render → straight to unlocked, no lock flash (same as the
  // old peekResolvedMediaSrc cache-hit branch). A URL already known to be sealed
  // with no key in this tab starts (and stays) vault-locked, no re-probe flash.
  const [state, setState] = useState(() => {
    if (url && peekResolvedMediaSrc(url)) return 'unlocked';
    return url && isMediaVaultLocked(url) ? 'vault-locked' : 'locked';
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
    setState(isMediaVaultLocked(url) ? 'vault-locked' : 'locked');
    setSrc(null);
    resolveMediaSrc(url).then((resolved) => {
      if (!alive || !resolved) return;
      if (isMediaVaultLocked(url)) {
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
          <VaultLockedTile />
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
