// Persistent embedded tool surface (the ComfyUI canvas).
// The iframe mounts exactly once and is NEVER unmounted — hidden views stay in
// the tree so ComfyUI canvas state, the owner-unlock handshake, and the history
// bridge all survive tab switches. src is set once by loadToolSurface (guarded
// by dataset.loaded); the ref registers the frame with the data layer so the
// module-singleton owner/lock/bridge plumbing can reach it. Reload re-arms only
// the iframe, never the React tree.
import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, IconButton, Spinner } from '../../ui/kit.jsx';
import { registerToolSurfaceFrame, reloadToolSurface, toolSurfaceUrl } from '../hubData.js';
import { HubToolbar } from './HubToolbar.jsx';

// The iframe's load event also fires for the browser's own connection-error
// page, and never fires at all for a gateway that hangs; past this the overlay
// says so instead of spinning forever.
const START_TIMEOUT_MS = 20000;

export function ToolSurface({ name, title, kicker, active }) {
  const [loaded, setLoaded] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Stable ref callback (identity keyed to name) so React never re-registers on
  // re-render — registering happens once when the frame first mounts.
  const setRef = useCallback((el) => {
    if (el) registerToolSurfaceFrame(name, el);
  }, [name]);

  useEffect(() => {
    if (!active || loaded) return undefined;
    setTimedOut(false);
    const timer = setTimeout(() => setTimedOut(true), START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [active, loaded, attempt]);

  const openExternal = () => {
    const url = toolSurfaceUrl(name);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };
  const reload = () => {
    setLoaded(false);
    setTimedOut(false);
    setAttempt((n) => n + 1);
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
          timedOut ? (
            <div className="absolute inset-0 grid place-items-center bg-bg0">
              <EmptyState
                icon="warning"
                title={`${title} did not start`}
                hint="The media gateway did not answer. Reload, or open it in a new tab to see what the browser says."
                action={(
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button variant="primary" icon="refresh" onClick={reload}>Reload</Button>
                    <Button icon="external" onClick={openExternal}>Open in a new tab</Button>
                  </div>
                )}
              />
            </div>
          ) : (
            <div className="pointer-events-none absolute inset-0 grid place-items-center bg-bg0">
              <div className="flex flex-col items-center gap-3 text-ink3">
                <Spinner size={20} className="text-honey" />
                <span className="text-xs">{`Starting ${title}…`}</span>
              </div>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
