'use client';

// The gateway's own browser UI is retired. What used to live here — a second
// "Media Studio" control panel with its own sidebar, password gate, Studio,
// Models, Workbench and Runtime tabs — is all in the unified Hivemind Content
// Studio app now, on one design system and behind one owner gate. Everything the
// gateway still serves (the ComfyUI proxy, /mobile, thumbnails, the media API) is
// untouched; only the duplicate UI is gone.
//
// These paths stay reachable so old bookmarks and the tailnet routes land
// somewhere useful: they send the browser to the same page in the real app.
import { useEffect, useState } from 'react';

const STUDIO_PORT = '8765';
// The tailnet HTTPS proxy serves the studio app at "/" on its own origin and
// routes only /gateway, /models, /mobile, /comfy and /_next here.
const PROXY_PORT = '8789';

function studioUrl(page) {
  const query = page ? `?page=${encodeURIComponent(page)}` : '';
  if (typeof window === 'undefined') return `/${query}`;
  if (window.location.port === PROXY_PORT) return `${window.location.origin}/${query}`;
  return `${window.location.protocol}//${window.location.hostname}:${STUDIO_PORT}/${query}`;
}

const shell = {
  minHeight: '100vh',
  display: 'grid',
  placeItems: 'center',
  padding: 24,
  color: '#f6f7fb',
  background: 'linear-gradient(135deg,#070811,#111421 58%,#070811)',
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
};

const card = {
  width: 'min(420px,100%)',
  border: '1px solid rgba(255,255,255,.13)',
  borderRadius: 24,
  background: 'rgba(8,10,22,.94)',
  padding: 28,
  display: 'grid',
  gap: 12,
  textAlign: 'center',
};

export function StudioRedirect({ page = '' }) {
  const [url, setUrl] = useState('');

  useEffect(() => {
    const target = studioUrl(page);
    setUrl(target);
    window.location.replace(target);
  }, [page]);

  return (
    <main style={shell}>
      <div style={card}>
        <p style={{ margin: 0, fontSize: 12, letterSpacing: '.08em', textTransform: 'uppercase', color: '#8b8fa3' }}>
          Media gateway
        </p>
        <h1 style={{ margin: 0, fontSize: 20 }}>Opening Hivemind Content Studio…</h1>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: '#b6b9c9' }}>
          The studio, model manager and runtime all live in one app now.
        </p>
        {url ? (
          <a href={url} style={{ color: '#f3c53f', fontSize: 13, wordBreak: 'break-all' }}>{url}</a>
        ) : null}
      </div>
    </main>
  );
}
