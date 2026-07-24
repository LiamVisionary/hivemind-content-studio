// Persistent embedded tool surface (ComfyUI canvas / local model manager).
// The iframe mounts exactly once and is NEVER unmounted — hidden views stay in
// the tree so ComfyUI canvas state, the owner-unlock handshake, and the history
// bridge all survive tab switches. src is set once by loadToolSurface (guarded
// by dataset.loaded); the ref registers the frame with the data layer so the
// module-singleton owner/lock/bridge plumbing can reach it. Reload re-arms only
// the iframe, never the React tree.
import { useCallback, useState } from 'react';
import { IconButton, Spinner } from '../../ui/kit.jsx';
import { registerToolSurfaceFrame, reloadToolSurface, toolSurfaceUrl } from '../hubData.js';
import { HubToolbar } from './HubToolbar.jsx';

export function ToolSurface({ name, title, kicker, active }) {
  const [loaded, setLoaded] = useState(false);

  // Stable ref callback (identity keyed to name) so React never re-registers on
  // re-render — registering happens once when the frame first mounts.
  const setRef = useCallback((el) => {
    if (el) registerToolSurfaceFrame(name, el);
  }, [name]);

  const openExternal = () => {
    const url = toolSurfaceUrl(name);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };
  const reload = () => {
    setLoaded(false);
    reloadToolSurface(name);
  };

  return (
    <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <HubToolbar
        kicker={kicker}
        title={title}
        right={
          <>
            <IconButton icon="external" label="Open in a new tab" onClick={openExternal} />
            <IconButton icon="refresh" label={`Reload ${title}`} onClick={reload} />
          </>
        }
      />
      <div className="relative min-h-0 flex-1 bg-bg0">
        <iframe
          ref={setRef}
          title={title}
          data-tool-surface={name}
          allow="clipboard-read; clipboard-write; fullscreen"
          onLoad={(e) => { if (e.currentTarget.src) setLoaded(true); }}
          className="h-full w-full border-0"
        />
        {!loaded ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-bg0">
            <div className="flex flex-col items-center gap-3 text-ink3">
              <Spinner size={20} className="text-honey" />
              <span className="text-xs">Starting {title}…</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
