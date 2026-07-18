'use client';

import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, BarChart3, BookOpen, Boxes, CheckCircle2, Cpu, Download, ExternalLink, Eye, FileCode2, Filter, Heart, ImageIcon, Layers3, Loader2, Menu, Moon, Play, Power, RefreshCw, Search, Server, Settings2, ShieldCheck, Sparkles, Square, Star, Tags, Terminal, X, Zap } from 'lucide-react';

const DEFAULT_API = '';
const TOKEN_STORAGE = 'zimg.token';
const API_STORAGE = 'zimg.apiBase';
const PROMPT_STORAGE = 'zimg.prompt';
const TAB_STORAGE = 'zimg.activeTab';
const CIVITAI_SEARCH_STORAGE = 'zimg.civitaiSearch';
const CIVITAI_PRESETS_STORAGE = 'zimg.civitaiSearchPresets';
const FRONTEND_UNLOCK_STORAGE = 'zimg.frontendUnlockExpires';
const FRONTEND_PASSWORD_HASH = '497fc4936661952e9ed6aec6b3b96030130fbfa716e5edacf118e8e792b46107';
const FRONTEND_UNLOCK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CIVITAI_FILTERS = {
  types: 'LORA',
  baseModels: 'ZImageTurbo',
  sort: 'Newest',
  period: 'AllTime',
  nsfw: 'false',
  checkpointType: '',
  creator: '',
  tag: '',
  primaryFileOnly: true,
  supportsGeneration: false,
  limit: '40',
};

function cx(...parts) { return parts.filter(Boolean).join(' '); }
function safeStorageGet(key, fallback = null) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return fallback;
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}
function safeStorageSet(key, value) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
function safeStorageRemove(key) {
  try {
    if (typeof window !== 'undefined' && window.localStorage) window.localStorage.removeItem(key);
  } catch {}
}
function normalizedLocalHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(normalized) ? 'loopback' : normalized;
}
function isTrustedOwnerParent(event) {
  if (event.source !== window.parent) return false;
  try {
    const parent = new URL(event.origin);
    return normalizedLocalHostname(parent.hostname) === normalizedLocalHostname(location.hostname)
      && ['8765', '8789', location.port].includes(parent.port);
  } catch {
    return false;
  }
}
const unlockScreenStyle = {
  minHeight: '100vh',
  display: 'grid',
  placeItems: 'center',
  padding: 24,
  color: '#f6f7fb',
  background: 'linear-gradient(135deg,#070811,#111421 58%,#070811)',
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
};
const unlockCardStyle = {
  width: 'min(440px,100%)',
  border: '1px solid rgba(255,255,255,.13)',
  borderRadius: 30,
  background: 'rgba(8,10,22,.94)',
  boxShadow: '0 30px 110px rgba(0,0,0,.48)',
  padding: 30,
  display: 'grid',
  gap: 16,
};
async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);

  // WebCrypto is only exposed in secure contexts. Tailscale private-IP access is
  // intentionally plain HTTP, so mobile Safari/Chrome may not provide
  // crypto.subtle there. Fall back to a small SHA-256 implementation so the
  // local unlock still works on tailnet URLs like http://100.x.x.x:8788.
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const rightRotate = (value, amount) => (value >>> amount) | (value << (32 - amount));
  const k = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 4, bitLen, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rightRotate(w[i - 15], 7) ^ rightRotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rightRotate(w[i - 2], 17) ^ rightRotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return h.map(n => n.toString(16).padStart(8, '0')).join('');
}
function fmtBytes(n) {
  n = Number(n || 0);
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
function when(value) {
  if (!value) return '';
  try { return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return value; }
}

function usePersistentState(key, fallback) {
  const [value, setValue] = useState(fallback);
  useEffect(() => {
    const saved = safeStorageGet(key);
    if (saved !== null) {
      const isLocalBrowser = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
      if (key === API_STORAGE && !isLocalBrowser && /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(saved)) {
        safeStorageSet(key, '');
        setValue('');
      } else {
        setValue(saved);
      }
    }
    else if (key === API_STORAGE && location.port === '8788' && ['localhost', '127.0.0.1', '::1'].includes(location.hostname)) setValue('http://127.0.0.1:8787');
  }, [key]);
  const update = useCallback((next) => {
    setValue(next);
    safeStorageSet(key, next);
  }, [key]);
  return [value, update];
}

function readJsonStorage(key, fallback) {
  try {
    const raw = safeStorageGet(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  safeStorageSet(key, JSON.stringify(value));
}

function usePersistentJsonState(key, fallback) {
  const [value, setValue] = useState(fallback);
  useEffect(() => setValue(readJsonStorage(key, fallback)), [key]);
  const update = useCallback((next) => {
    setValue(prev => {
      const value = typeof next === 'function' ? next(prev) : next;
      writeJsonStorage(key, value);
      return value;
    });
  }, [key]);
  return [value, update];
}


function isCivitaiUrl(value = '') {
  try {
    const parsed = new URL(String(value).trim());
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    return host === 'civitai.com' || host === 'civitai.red';
  } catch {
    return false;
  }
}

function isVideoPreview(url = '') {
  return /\.(mp4|webm|mov)(?:[?#].*)?$/i.test(String(url).split('/original=')[0]) || /\.(mp4|webm|mov)(?:[?#].*)?$/i.test(String(url));
}

function PreviewMedia({ src, api, alt = '', className = '', loading = 'lazy' }) {
  if (!src) return null;
  const resolved = api?.imageUrl ? api.imageUrl(src) : src;
  if (isVideoPreview(resolved)) {
    return <video className={className} src={resolved} muted loop playsInline preload="metadata" />;
  }
  return <img className={className} src={resolved} alt={alt} loading={loading} />;
}

function DownloadProgress({ job }) {
  if (!job) return null;
  const pct = Math.max(0, Math.min(100, Number(job.percent || 0)));
  const active = job.status === 'queued' || job.status === 'running';
  const detail = job.total_bytes
    ? `${fmtBytes(job.downloaded_bytes)} / ${fmtBytes(job.total_bytes)}`
    : active ? 'Preparing download…' : '';
  const label = job.status === 'success'
    ? `Downloaded${job.result?.filename ? ` · ${job.result.filename}` : ''}`
    : job.status === 'error'
      ? (job.error || 'Download failed')
      : `${job.status || 'starting'} ${pct}%${detail ? ` · ${detail}` : ''}`;
  return <div className={cx('download-progress', job.status)} role="status" aria-live="polite">
    <span style={{ width: `${pct}%` }}/>
    <small>{label}</small>
  </div>;
}

function useApi() {
  const [apiBase, setApiBase] = usePersistentState(API_STORAGE, DEFAULT_API);
  const [token, setToken] = usePersistentState(TOKEN_STORAGE, '');

  useEffect(() => {
    const qs = new URLSearchParams(location.search);
    const qToken = qs.get('token');
    const qApi = qs.get('api');
    if (qToken) setToken(qToken);
    if (qApi) setApiBase(qApi.replace(/\/$/, ''));
  }, [setApiBase, setToken]);

  const request = useCallback(async (path, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const runFetch = async (base) => {
      const res = await fetch(`${base}${path}`, { ...options, headers, cache: 'no-store' });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
      if (!res.ok) {
        const err = new Error(data.error || data.text || `${res.status} ${res.statusText}`);
        err.status = res.status;
        throw err;
      }
      return data;
    };
    try {
      return await runFetch(apiBase);
    } catch (err) {
      // If a browser has a stale direct backend URL saved but no backend token,
      // fall back to same-origin /api/* where the Next wrapper injects its token.
      // This keeps tunneled/mobile "Open Model Manager" links from rendering
      // empty installed counts after an auth miss.
      if (apiBase && !token && (err.status === 401 || err.status === 403)) {
        return await runFetch('');
      }
      throw err;
    }
  }, [apiBase, token]);

  const imageUrl = useCallback((url) => {
    if (!url) return '';
    if (/^https?:\/\//.test(url)) return url;
    const base = `${apiBase}${url}`;
    if (!token) return base;
    return `${base}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  }, [apiBase, token]);

  return useMemo(() => ({ apiBase, setApiBase, token, setToken, request, imageUrl }), [apiBase, setApiBase, token, setToken, request, imageUrl]);
}

function AuthGate({ children }) {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const expires = Number(safeStorageGet(FRONTEND_UNLOCK_STORAGE, '0') || 0);
    if (expires > Date.now()) setUnlocked(true);
    else safeStorageRemove(FRONTEND_UNLOCK_STORAGE);
    setChecking(false);
  }, []);

  useEffect(() => {
    const onOwnerAccess = async (event) => {
      if (!isTrustedOwnerParent(event)) return;
      if (event.data?.type === 'hivemind-owner-lock') {
        safeStorageRemove(FRONTEND_UNLOCK_STORAGE);
        setUnlocked(false);
        return;
      }
      if (event.data?.type !== 'hivemind-owner-unlock') return;
      if (event.data?.ownerSession !== true) {
        if (typeof event.data.passphrase !== 'string') return;
        if (await sha256Hex(event.data.passphrase) !== FRONTEND_PASSWORD_HASH) return;
      }
      safeStorageSet(FRONTEND_UNLOCK_STORAGE, String(Date.now() + FRONTEND_UNLOCK_MS));
      setUnlocked(true);
    };
    window.addEventListener('message', onOwnerAccess);
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'hivemind-owner-unlock-ready' }, '*');
    }
    return () => window.removeEventListener('message', onOwnerAccess);
  }, []);

  async function unlock(event) {
    event.preventDefault();
    setError('');
    try {
      const hash = await sha256Hex(password);
      if (hash !== FRONTEND_PASSWORD_HASH) {
        setError('Wrong password. Try again.');
        return;
      }
      safeStorageSet(FRONTEND_UNLOCK_STORAGE, String(Date.now() + FRONTEND_UNLOCK_MS));
      setPassword('');
      setUnlocked(true);
    } catch {
      setError('This browser could not verify the password. Try refreshing.');
    }
  }

  if (checking) return <main className="unlock-screen" style={unlockScreenStyle}><div className="unlock-card" style={unlockCardStyle}><Loader2 className="spin"/><p>Checking unlock…</p></div></main>;
  if (unlocked) return children;
  return <main className="unlock-screen" style={unlockScreenStyle}>
    <form className="unlock-card" style={unlockCardStyle} onSubmit={unlock}>
      <div className="brand-mark unlock-mark"><Zap size={24}/></div>
      <p className="eyebrow">Private access</p>
      <h1>Media Studio is locked</h1>
      <p className="unlock-copy">Enter the frontend password to unlock this browser for 24 hours.</p>
      <input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
      {error && <div className="error">{error}</div>}
      <button className="primary" type="submit">Unlock for 24 hours</button>
    </form>
  </main>;
}

function Shell({ active, setActive, children, status, api }) {
  const tabs = [
    ['studio', 'Studio', Sparkles],
    ['models', 'Models', Boxes],
    ['workbench', 'Workbench', Cpu],
    ['runtime', 'Runtime', Activity],
  ];
  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Zap size={22}/></div><div><p>Media</p><h1>Studio</h1></div></div>
      <nav>{tabs.map(([id, label, Icon]) => <button key={id} onClick={() => setActive(id)} className={cx('nav-item', active === id && 'active')}><Icon size={18}/>{label}</button>)}</nav>
      <div className="connection-card">
        <div className="label">Backend</div>
        <input value={api.apiBase} onChange={(e) => api.setApiBase(e.target.value.replace(/\/$/, ''))} placeholder="Same tunnel / origin" />
        <div className={cx('health', status?.ok ? 'ok' : 'bad')}><span />{status?.ok ? 'Connected' : 'Needs token / offline'}</div>
      </div>
    </aside>
    <section className="content">
      <header className="topbar">
        <div><p className="eyebrow">Next.js control surface</p><h2>{tabs.find(t => t[0] === active)?.[1]}</h2></div>
        <div className="token-box"><label>Token</label><input type="password" value={api.token} onChange={(e) => api.setToken(e.target.value)} placeholder="Paste backend token" /></div>
      </header>
      {children}
    </section>
  </main>;
}

function Studio({ api }) {
  const [prompt, setPrompt] = usePersistentState(PROMPT_STORAGE, '');
  const [history, setHistory] = useState([]);
  const [loras, setLoras] = useState([]);
  const [selected, setSelected] = useState([]);
  const [job, setJob] = useState(null);
  const [editImage, setEditImage] = useState(null);
  const [mlxSteps, setMlxSteps] = useState(4);
  const [mlxSize, setMlxSize] = useState(512);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [hist, loraData] = await Promise.all([api.request('/api/history'), api.request('/api/loras')]);
    setHistory(hist.history || []); setLoras(loraData.loras || []); setSelected(loraData.selected || []);
  }, [api]);

  useEffect(() => { load().catch(e => setError(e.message)); }, [load]);

  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await api.request(`/api/job/${job.id}`);
        if (!cancelled) setJob(next);
        if (next.status === 'success' || next.status === 'error') load().catch(() => {});
      } catch (e) { if (!cancelled) setError(e.message); }
    };
    const timer = setInterval(tick, document.hidden ? 2500 : 1100);
    tick();
    return () => { cancelled = true; clearInterval(timer); };
  }, [api, job, load]);

  async function generate() {
    if (!prompt.trim()) return;
    setBusy(true); setError(''); setJob({ status: 'queued' });
    try {
      let data;
      if (editImage) {
        const fd = new FormData();
        fd.append('backend', 'mlx-bigloves-klein3-edit');
        fd.append('prompt', prompt);
        fd.append('image', editImage);
        fd.append('width', String(mlxSize));
        fd.append('height', String(mlxSize));
        fd.append('steps', String(mlxSteps));
        fd.append('guidance', '3.5');
        const headers = {};
        if (api.token) headers.Authorization = `Bearer ${api.token}`;
        const res = await fetch(`${api.apiBase}/api/generate`, { method: 'POST', headers, body: fd, cache: 'no-store' });
        const text = await res.text();
        try { data = text ? JSON.parse(text) : {}; } catch { data = { text }; }
        if (!res.ok) throw new Error(data.error || data.text || `${res.status} ${res.statusText}`);
      } else {
        data = await api.request('/api/generate', { method: 'POST', body: JSON.stringify({ prompt, loras: selected }) });
      }
      setJob(data);
    } catch (e) { setError(e.message); setJob(null); }
    finally { setBusy(false); }
  }

  async function toggleLora(lora) {
    const exists = selected.some(x => x.id === lora.id);
    const next = exists ? selected.filter(x => x.id !== lora.id) : [...selected, { id: lora.id, name: lora.name, strength: 1 }];
    setSelected(next);
    const saved = await api.request('/api/loras/select', { method: 'POST', body: JSON.stringify({ loras: next }) });
    setSelected(saved.selected || next);
  }

  const previewUrl = job?.image_urls?.[0] || history?.[0]?.image_urls?.[0];
  return <div className="grid studio-grid">
    <section className="panel composer">
      <div className="section-head"><div><p className="eyebrow">Prompt</p><h3>Create an image</h3></div><button onClick={generate} disabled={busy} className="primary">{busy ? <Loader2 className="spin"/> : <Play/>}Generate</button></div>
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the image you want…" />
      <div className="native-edit-box">
        <strong>Fast native Apple edit</strong>
        <p>Attach an image to run <code>BigLoveKlein3_bf16</code> through MLX instead of the slower ComfyUI/PyTorch MPS path.</p>
        <div className="native-edit-controls">
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setEditImage(e.target.files?.[0] || null)} />
          <label>Steps <input type="number" min="2" max="12" value={mlxSteps} onChange={(e) => setMlxSteps(e.target.value)} /></label>
          <label>Size <select value={mlxSize} onChange={(e) => setMlxSize(e.target.value)}><option value="512">512</option><option value="768">768</option><option value="1024">1024</option></select></label>
        </div>
        <small>{editImage ? `Native MLX BF16 edit ready: ${editImage.name}` : 'No image attached: Generate uses the normal Media Studio/ComfyUI path.'}</small>
      </div>
      <div className="lora-strip">{selected.length ? selected.map(l => <span key={l.id}>{l.name}</span>) : <em>No LoRAs selected</em>}</div>
      {error && <div className="error">{error}</div>}
    </section>
    <section className="panel preview-panel">
      <div className="section-head"><div><p className="eyebrow">Live result</p><h3>{job?.status || 'Ready'}</h3></div>{job?.status && <span className="status-pill">{job.status}</span>}</div>
      <div className="preview-box">{previewUrl ? <PreviewMedia src={previewUrl} api={api} alt="Generated" loading="eager"/> : <div className="empty"><ImageIcon/>Waiting for an image</div>}</div>
    </section>
    <section className="panel span2">
      <div className="section-head"><h3>Local LoRAs</h3><button className="ghost" onClick={load}><RefreshCw size={16}/>Refresh</button></div>
      <div className="dense-list">{loras.slice(0, 80).map(l => <button key={l.id} onClick={() => toggleLora(l)} className={cx('row', selected.some(x => x.id === l.id) && 'selected')}><span>{l.name}</span><small>{l.baseModel || l.metadata?.baseModel || 'Local'}</small></button>)}</div>
    </section>
    <section className="panel span2"><h3>History</h3><div className="history-grid">{history.slice(0, 18).map(h => <article key={h.id}><PreviewMedia src={h.image_urls?.[0]} api={api} alt=""/><p>{h.prompt}</p><small>{when(h.finished_at || h.created_at)}</small></article>)}</div></section>
  </div>;
}


function LibraryManager({ api, data, equippedIds, equip, onRefresh, resetOnOpen = false }) {
  const [library, setLibrary] = useState(null);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [section, setSection] = usePersistentState('zimg.librarySection', 'loras');
  const [query, setQuery] = usePersistentState('zimg.libraryQuery', '');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sort, setSort] = usePersistentState('zimg.librarySort', 'name');
  const [view, setView] = usePersistentState('zimg.libraryView', 'grid');
  const [filters, setFilters] = usePersistentJsonState('zimg.libraryFilters', { base: '', tag: '', favorite: false, missingPreview: false });
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    setLibraryLoading(true);
    try {
      const res = await api.request('/api/library');
      setLibrary(res || { loras: [], recipes: [], checkpoints: [], embeddings: [], stats: {}, baseModels: [], tags: [] });
    } finally {
      setLibraryLoading(false);
    }
  }, [api]);
  useEffect(() => { load().catch(e => setError(e.message)); }, [load]);
  useEffect(() => {
    if (!resetOnOpen) return;
    setSection('loras');
    setQuery('');
    setFilters({ base: '', tag: '', favorite: false, missingPreview: false });
  }, [resetOnOpen, setSection, setQuery, setFilters]);

  const readyLibrary = library || { loras: [], recipes: [], checkpoints: [], embeddings: [], stats: {}, baseModels: [], tags: [] };
  const tabs = [
    ['loras', 'LoRAs', Layers3, readyLibrary.loras?.length || 0],
    ['recipes', 'Recipes', BookOpen, readyLibrary.recipes?.length || 0],
    ['checkpoints', 'Checkpoints', CheckCircle2, readyLibrary.checkpoints?.length || 0],
    ['embeddings', 'Embeddings', FileCode2, readyLibrary.embeddings?.length || 0],
    ['stats', 'Stats', BarChart3, readyLibrary.stats?.totalModels || 0],
  ];
  const items = section === 'recipes' ? (readyLibrary.recipes || []) : section === 'stats' ? [] : (readyLibrary[section] || []);
  const q = query.toLowerCase().trim();
  const filtered = useMemo(() => {
    let arr = [...items];
    if (q) arr = arr.filter(m => `${m.displayName || m.title || m.name} ${m.name || ''} ${m.creator || ''} ${(m.tags || []).join(' ')} ${(m.triggerWords || []).join(' ')} ${m.baseModel || ''} ${m.prompt || ''}`.toLowerCase().includes(q));
    if (filters.base && section !== 'recipes') arr = arr.filter(m => (m.baseModel || '') === filters.base);
    if (filters.tag) arr = arr.filter(m => (m.tags || []).map(t => t.toLowerCase()).includes(filters.tag.toLowerCase()));
    if (filters.favorite && section !== 'recipes') arr = arr.filter(m => m.favorite);
    if (filters.missingPreview && section !== 'recipes') arr = arr.filter(m => !m.preview);
    arr.sort((a,b) => {
      if (sort === 'size') return (b.size_bytes || 0) - (a.size_bytes || 0);
      if (sort === 'date') return String(b.dateAdded || b.created_at || '').localeCompare(String(a.dateAdded || a.created_at || ''));
      if (sort === 'base') return String(a.baseModel || '').localeCompare(String(b.baseModel || '')) || String(a.displayName || a.title || a.name).localeCompare(String(b.displayName || b.title || b.name));
      return String(a.displayName || a.title || a.name).localeCompare(String(b.displayName || b.title || b.name));
    });
    return arr;
  }, [items, q, filters, sort, section]);

  const setFilter = (k, v) => setFilters(prev => ({ ...prev, [k]: v }));
  const clearFilters = () => setFilters({ base: '', tag: '', favorite: false, missingPreview: false });
  const activeFilterCount = [filters.base, filters.tag, filters.favorite, filters.missingPreview].filter(Boolean).length;

  return <div className="lm-shell">
    <header className="lm-header">
      <div className="lm-brand"><div className="lm-logo"><Layers3 size={17}/></div><strong>LoRA Manager</strong></div>
      <nav className="lm-nav">{tabs.map(([id,label,Icon,count]) => <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}><Icon size={15}/><span>{label}</span><em>{libraryLoading ? '…' : count}</em></button>)}</nav>
      <div className="lm-search"><Search size={15}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder={section === 'stats' ? 'Stats are not searchable' : `Search ${tabs.find(t => t[0] === section)?.[1] || 'library'}…`} disabled={section === 'stats'} /><button onClick={() => setDrawerOpen(true)} title="Filters"><Filter size={15}/>{activeFilterCount ? <b>{activeFilterCount}</b> : null}</button></div>
      <div className="lm-actions"><button onClick={() => { load(); onRefresh?.(); }}><RefreshCw size={15}/></button><button onClick={() => setDrawerOpen(true)}><Menu size={16}/></button></div>
    </header>

    {drawerOpen && <div className="lm-drawer-backdrop" onClick={() => setDrawerOpen(false)} />}
    <aside className={cx('lm-drawer', drawerOpen && 'open')}>
      <div className="lm-drawer-head"><h3>Filters</h3><button onClick={() => setDrawerOpen(false)}><X size={17}/></button></div>
      <label>Base model<select value={filters.base} onChange={e => setFilter('base', e.target.value)}><option value="">Any base model</option>{(readyLibrary.baseModels || []).map(b => <option key={b}>{b}</option>)}</select></label>
      <label>Tag<select value={filters.tag} onChange={e => setFilter('tag', e.target.value)}><option value="">Any tag</option>{(readyLibrary.tags || []).slice(0,80).map(t => <option key={t.name} value={t.name}>{t.name} ({t.count})</option>)}</select></label>
      <label>Sort<select value={sort} onChange={e => setSort(e.target.value)}><option value="name">Name</option><option value="date">Date added</option><option value="size">Size</option><option value="base">Base model</option></select></label>
      <label>Density<select value={view} onChange={e => setView(e.target.value)}><option value="grid">Card grid</option><option value="list">Compact list</option></select></label>
      <label className="lm-check"><input type="checkbox" checked={filters.favorite} onChange={e => setFilter('favorite', e.target.checked)}/> Favorites only</label>
      <label className="lm-check"><input type="checkbox" checked={filters.missingPreview} onChange={e => setFilter('missingPreview', e.target.checked)}/> Missing previews</label>
      <button className="lm-clear" onClick={clearFilters}>Clear all filters</button>
      <div className="lm-side-note"><strong>Side drawer</strong><span>Folder tree, filter presets, base model and tag filtering are folded into this drawer for this control panel.</span></div>
    </aside>

    {error && <div className="error">{error}</div>}
    {libraryLoading ? <div className="lm-empty loading-state"><Loader2 className="spin" size={22}/><strong>Loading installed models…</strong><span>Scanning local model folders and metadata.</span></div> : <>
    {section !== 'stats' && <div className="lm-controls"><div><span>{filtered.length}</span> of <span>{items.length}</span> shown</div><div className="lm-active-filters">{filters.base && <button onClick={() => setFilter('base','')}>{filters.base} ×</button>}{filters.tag && <button onClick={() => setFilter('tag','')}>#{filters.tag} ×</button>}{filters.favorite && <button onClick={() => setFilter('favorite', false)}>favorites ×</button>}{filters.missingPreview && <button onClick={() => setFilter('missingPreview', false)}>missing previews ×</button>}</div></div>}
    {section === 'stats' ? <StatsPanel stats={readyLibrary.stats || {}} /> : section === 'recipes' ? <RecipeGrid items={filtered} api={api} view={view} /> : <ModelLibraryGrid items={filtered} section={section} view={view} api={api} equippedIds={equippedIds} equip={equip} select={setSelected} totalCount={items.length} onClearFilters={() => { setQuery(''); clearFilters(); }} />}
    </>}
    {selected && <ModelDetailModal item={selected} api={api} equippedIds={equippedIds} equip={equip} onClose={() => setSelected(null)} />}
  </div>;
}

function ModelLibraryGrid({ items, section, view, api, equippedIds, equip, select, totalCount = items.length, onClearFilters }) {
  if (!items.length) return <div className="lm-empty">{totalCount ? <><strong>No {section} match the current search and filters.</strong><br/><button className="mini" onClick={onClearFilters}>Clear search and filters</button></> : <>No {section} are installed yet.</>}</div>;
  return <div className={cx('lm-card-grid', view === 'list' && 'list')}>{items.map(m => {
    const on = equippedIds.has(m.id);
    return <article className={cx('lm-card', on && 'equipped')} key={m.id} onDoubleClick={() => select(m)}>
      <div className="lm-thumb">{m.preview ? <PreviewMedia src={m.preview} api={api} alt=""/> : <div><ImageIcon size={24}/><span>No preview</span></div>}{m.favorite && <i><Star size={13}/></i>}</div>
      <div className="lm-card-body"><div className="lm-title-row"><strong title={m.displayName || m.name}>{m.displayName || m.name}</strong><small>{m.size}</small></div><p>{m.baseModel || 'Unknown base'}{m.creator ? ` · ${m.creator}` : ''}</p>
      {!!m.triggerWords?.length && <div className="lm-triggers">{m.triggerWords.slice(0,4).map(w => <code key={w}>{w}</code>)}</div>}
      {!!m.tags?.length && <div className="lm-tags">{m.tags.slice(0,5).map(t => <span key={t}>{t}</span>)}</div>}
      <div className="lm-card-actions"><button onClick={() => select(m)}><Eye size={14}/>Details</button><button onClick={() => equip(m.id, on)} className={on ? 'danger' : 'secondary'}>{on ? 'Unequip' : 'Equip'}</button></div></div>
    </article>;
  })}</div>;
}

function RecipeGrid({ items, api, view }) {
  if (!items.length) return <div className="lm-empty">No recipes yet. Generate with selected LoRAs and they appear here as reusable recipe records.</div>;
  return <div className={cx('lm-card-grid recipe-grid', view === 'list' && 'list')}>{items.map(r => <article className="lm-card recipe" key={r.id}><div className="lm-thumb">{r.preview ? <PreviewMedia src={r.preview} api={api} alt=""/> : <BookOpen size={28}/>}</div><div className="lm-card-body"><strong>{r.title}</strong><p>{(r.loras || []).length} LoRAs · {when(r.created_at)}</p><div className="lm-tags">{(r.tags || []).map(t => <span key={t}>{t}</span>)}</div><pre>{r.prompt}</pre></div></article>)}</div>;
}

function StatsPanel({ stats }) {
  const cards = [['LoRAs', stats.loras || 0], ['Recipes', stats.recipes || 0], ['Checkpoints', stats.checkpoints || 0], ['Embeddings', stats.embeddings || 0], ['Total size', fmtBytes(stats.totalBytes || 0)], ['With previews', stats.withPreviewCount || 0]];
  return <div className="lm-stats"><div className="lm-stat-grid">{cards.map(([k,v]) => <article key={k}><span>{k}</span><strong>{v}</strong></article>)}</div><section><h3>Base models</h3><div className="lm-bars">{(stats.baseModels || []).map(b => <div key={b.name}><span>{b.name}</span><em>{b.count}</em><i style={{width:`${Math.min(100,(b.count/Math.max(1,stats.totalModels||1))*100)}%`}}/></div>)}</div></section><section><h3>Top tags</h3><div className="lm-tags big">{(stats.topTags || []).map(t => <span key={t.name}>{t.name} <b>{t.count}</b></span>)}</div></section></div>;
}

function ModelDetailModal({ item, api, equippedIds, equip, onClose }) {
  const on = equippedIds.has(item.id);
  return <div className="lm-modal-backdrop" onClick={onClose}><article className="lm-modal" onClick={e => e.stopPropagation()}><button className="lm-modal-close" onClick={onClose}><X size={18}/></button><div className="lm-modal-preview">{item.preview ? <PreviewMedia src={item.preview} api={api} alt="" loading="eager"/> : <ImageIcon size={40}/>}</div><div className="lm-modal-body"><p className="eyebrow">{item.folder} · {item.size}</p><h2>{item.displayName || item.name}</h2><p>{item.baseModel || 'Unknown base'}{item.creator ? ` · by ${item.creator}` : ''}</p>{!!item.triggerWords?.length && <><h3>Trigger words</h3><div className="lm-triggers big">{item.triggerWords.map(w => <code key={w}>{w}</code>)}</div></>}{!!item.tags?.length && <><h3>Tags</h3><div className="lm-tags big">{item.tags.map(t => <span key={t}>{t}</span>)}</div></>}{item.notes && <><h3>Notes</h3><p>{item.notes}</p></>}<button onClick={() => equip(item.id, on)} className={on ? 'danger' : 'primary'}>{on ? 'Unequip' : 'Equip'}</button></div></article></div>;
}

function Models({ api }) {
  const [data, setData] = useState({ models: [], equipped: [], ram: {}, bundles: {}, civitaiInstalled: {} });
  const [query, setQuery] = useState('');
  const [civitaiUrl, setCivitaiUrl] = useState('');
  const [localQuery, setLocalQuery] = useState('');
  const [modelView, setModelView] = useState('browse');
  const [civitai, setCivitai] = useState([]);
  const [downloads, setDownloads] = useState({});
  const [urlDownloadIds, setUrlDownloadIds] = useState([]);
  const [error, setError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [filters, setFilters] = useState(DEFAULT_CIVITAI_FILTERS);
  const [presets, setPresets] = usePersistentJsonState(CIVITAI_PRESETS_STORAGE, []);
  const [searchLoaded, setSearchLoaded] = useState(false);
  const [searchState, setSearchState] = useState({ status: 'idle', message: 'Search Civitai to find downloadable models.', startedAt: null, completedAt: null });
  const [baseModelOptions, setBaseModelOptions] = useState(['ZImageTurbo']);
  const pollers = useRef(new Map());

  useEffect(() => {
    const saved = readJsonStorage(CIVITAI_SEARCH_STORAGE, null);
    if (saved) {
      setQuery(saved.query || '');
      setFilters({ ...DEFAULT_CIVITAI_FILTERS, ...(saved.filters || {}) });
    }
    setSearchLoaded(true);
  }, []);

  useEffect(() => {
    if (searchLoaded) writeJsonStorage(CIVITAI_SEARCH_STORAGE, { query, filters });
  }, [query, filters, searchLoaded]);

  const setFilter = (key, value) => setFilters(f => ({ ...f, [key]: value }));
  const loadModels = useCallback(async () => {
    const next = await api.request('/api/models'); setData(next);
  }, [api]);
  useEffect(() => { loadModels().catch(e => setError(e.message)); }, [loadModels]);
  useEffect(() => {
    api.request('/api/civitai/base-models')
      .then(res => setBaseModelOptions((res.baseModels || []).length ? res.baseModels : ['ZImageTurbo']))
      .catch(() => setBaseModelOptions(['ZImageTurbo']));
  }, [api]);
  useEffect(() => () => { pollers.current.forEach(clearTimeout); }, []);

  function buildSearchParams(q = query, f = filters) {
    const qs = new URLSearchParams();
    if ((q || '').trim()) qs.set('query', q.trim());
    if ((f.tag || '').trim()) qs.set('tag', f.tag.trim());
    if ((f.creator || '').trim()) qs.set('username', f.creator.trim());
    for (const key of ['types', 'baseModels', 'sort', 'period', 'checkpointType', 'limit']) {
      if (f[key]) qs.set(key, f[key]);
    }
    if (f.nsfw === 'true' || f.nsfw === 'false') qs.set('nsfw', f.nsfw);
    if (f.primaryFileOnly) qs.set('primaryFileOnly', 'true');
    if (f.supportsGeneration) qs.set('supportsGeneration', 'true');
    return qs;
  }

  async function equip(id, equipped) {
    const next = await api.request(equipped ? '/api/models/unequip' : '/api/models/equip', { method: 'POST', body: JSON.stringify({ id }) });
    setData(d => ({ ...d, equipped: next.equipped || d.equipped, ram: next.ram || d.ram }));
  }
  async function searchCivitai(q = query, f = filters) {
    const cleanQuery = (q || '').trim();
    if (isCivitaiUrl(cleanQuery)) {
      setCivitaiUrl(cleanQuery);
      await downloadFromUrl(cleanQuery);
      return;
    }
    const params = buildSearchParams(q, f);
    const summary = [cleanQuery || 'all models', f.types, f.baseModels].filter(Boolean).join(' · ');
    setError('');
    setModelView('browse');
    setSearchState({ status: 'loading', message: `Searching Civitai for ${summary}…`, startedAt: Date.now(), completedAt: null });
    try {
      const res = await api.request(`/api/civitai/search?${params}`);
      const items = res.items || [];
      setCivitai(items);
      if (res.installed) setData(d => ({ ...d, civitaiInstalled: res.installed }));
      if (res.baseModelOptions?.length) setBaseModelOptions(res.baseModelOptions);
      const meta = res.metadata || {};
      const pageNote = meta.pagesFetched > 1 ? ` across ${meta.pagesFetched} pages` : '';
      const moreNote = meta.nextCursor ? ' More results are available; raise the limit or narrow filters.' : '';
      setSearchState({ status: 'success', message: items.length ? `Found ${items.length} Civitai results${pageNote}.${moreNote}` : `No Civitai results for ${summary}. Try widening filters.`, startedAt: null, completedAt: Date.now() });
    } catch (e) {
      setCivitai([]);
      setSearchState({ status: 'error', message: `Search failed: ${e.message}`, startedAt: null, completedAt: Date.now() });
      throw e;
    }
  }
  async function download(versionId, fileId) {
    const job = await api.request('/api/civitai/download', { method: 'POST', body: JSON.stringify({ versionId, fileId }) });
    setDownloads(d => ({ ...d, [job.id]: job })); poll(job.id);
  }
  async function downloadFromUrl(urlOverride = '') {
    const url = String(urlOverride || civitaiUrl).trim();
    if (!url) {
      setError('Paste a civitai.com or civitai.red URL first.');
      return;
    }
    setError('');
    setSearchState({ status: 'loading', message: 'Starting direct Civitai URL download…', startedAt: Date.now(), completedAt: null });
    setModelView('browse');
    const optimisticId = `url-${Date.now()}`;
    setDownloads(d => ({ ...d, [optimisticId]: { id: optimisticId, status: 'queued', percent: 0, source: 'url', url } }));
    setUrlDownloadIds(ids => [optimisticId, ...ids].slice(0, 5));
    try {
      const job = await api.request('/api/civitai/download', { method: 'POST', body: JSON.stringify({ url }) });
      setDownloads(d => {
        const next = { ...d };
        delete next[optimisticId];
        next[job.id] = { ...job, source: 'url', url };
        return next;
      });
      setUrlDownloadIds(ids => [job.id, ...ids.filter(id => id !== optimisticId && id !== job.id)].slice(0, 5));
      setSearchState({ status: 'success', message: 'Direct URL download is running below.', startedAt: null, completedAt: Date.now() });
      poll(job.id);
    } catch (e) {
      setDownloads(d => ({ ...d, [optimisticId]: { ...d[optimisticId], status: 'error', error: e.message, percent: 0, source: 'url', url } }));
      setSearchState({ status: 'error', message: `Direct URL download failed: ${e.message}`, startedAt: null, completedAt: Date.now() });
      throw e;
    }
  }
  const poll = useCallback(async (id) => {
    try {
      const job = await api.request(`/api/civitai/download/${id}`);
      setDownloads(d => ({ ...d, [id]: { ...(d[id] || {}), ...job } }));
      if (job.status === 'queued' || job.status === 'running') pollers.current.set(id, setTimeout(() => poll(id), document.hidden ? 2400 : 900));
      else loadModels().catch(() => {});
    } catch (e) { setError(e.message); }
  }, [api, loadModels]);

  function savePreset() {
    const name = window.prompt('Name this Civitai search preset');
    if (!name || !name.trim()) return;
    const preset = { id: `${Date.now()}`, name: name.trim(), query, filters: { ...filters } };
    setPresets(prev => [...(prev || []).filter(p => p.name !== preset.name), preset]);
  }
  function loadPreset(preset) {
    const nextFilters = { ...DEFAULT_CIVITAI_FILTERS, ...(preset.filters || {}) };
    const nextQuery = preset.query || '';
    setModelView('browse');
    setQuery(nextQuery);
    setFilters(nextFilters);
    searchCivitai(nextQuery, nextFilters).catch(e => setError(e.message));
  }
  function deletePreset(id) {
    setPresets(prev => (prev || []).filter(p => p.id !== id));
  }

  const equippedIds = new Set((data.equipped || []).map(m => m.id));
  const filtered = (data.models || []).filter(m => `${m.name} ${m.folder} ${m.category}`.toLowerCase().includes(localQuery.toLowerCase()));
  const ram = data.ram || {}; const usedPct = ram.total ? Math.round((ram.used / ram.total) * 100) : 0;
  const baseModelChoices = Array.from(new Set(['', ...(baseModelOptions || []), filters.baseModels].filter(v => v !== undefined && v !== null))).filter(v => v === '' || String(v).trim());
  const typeChoices = ['LORA', 'Checkpoint', 'TextualInversion', 'Controlnet', 'VAE', 'Poses'];
  const installed = data.civitaiInstalled || {};
  const isDownloaded = (version, file, job) => job?.status === 'success' || Boolean(installed.byVersion?.[String(version?.id || '')] || installed.byFile?.[String(file?.id || '')]);
  const isSearching = searchState.status === 'loading';
  const queryIsCivitaiUrl = isCivitaiUrl(query);
  const urlDownloadJobs = urlDownloadIds.map(id => downloads[id]).filter(Boolean);
  const urlDownloading = urlDownloadJobs.some(j => j.status === 'queued' || j.status === 'running');
  const canSearch = !isSearching && !urlDownloading;

  return <div className="models-layout">
    <section className="panel hero-card"><div><p className="eyebrow">Memory aware model control</p><h3>{fmtBytes(ram.free)} free</h3><p>{fmtBytes(ram.reserved_equipped)} reserved by equipped stack</p></div><div className="meter"><span style={{ width: `${usedPct}%` }}/></div></section>
    <section className="panel segmented-panel">
      <div className="segmented-control" role="tablist" aria-label="Model view">
        <button role="tab" aria-selected={modelView === 'browse'} className={modelView === 'browse' ? 'active' : ''} onClick={() => setModelView('browse')}>Browse Civitai</button>
        <button role="tab" aria-selected={modelView === 'installed'} className={modelView === 'installed' ? 'active' : ''} onClick={() => setModelView('installed')}>Installed</button>
      </div>
    </section>
    {modelView === 'browse' && <section className="panel model-search-panel">
      <div className={cx('search-card', (isSearching || urlDownloading) && 'searching')} aria-busy={isSearching || urlDownloading}>
        <Search/>
        <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && canSearch && searchCivitai().catch(err => setError(err.message))} placeholder="Search Civitai models… or paste a Civitai URL" disabled={isSearching || urlDownloading}/>
        <button onClick={() => searchCivitai().catch(err => setError(err.message))} disabled={!canSearch}>{isSearching || urlDownloading ? <Loader2 className="spin" size={18}/> : queryIsCivitaiUrl ? <Download size={18}/> : <Search size={18}/>} {isSearching ? 'Searching…' : urlDownloading ? 'Downloading…' : queryIsCivitaiUrl ? 'Download URL' : 'Search Civitai'}</button>
        <button className="ghost square" onClick={() => setFiltersOpen(v => !v)} title="Civitai filters" disabled={isSearching}><Settings2 size={18}/></button>
      </div>
      <div className={cx('search-feedback', searchState.status)} role="status" aria-live="polite">
        {isSearching ? <Loader2 className="spin" size={18}/> : searchState.status === 'success' ? <CheckCircle2 size={18}/> : searchState.status === 'error' ? <X size={18}/> : <Sparkles size={18}/>}
        <span>{searchState.message}</span>
      </div>
      {!!urlDownloadJobs.length && <div className="url-download-list">
        {urlDownloadJobs.map(job => <div className="url-download-job" key={job.id}>
          <div className="url-download-head"><strong>Civitai URL download</strong><code>{job.id}</code></div>
          <DownloadProgress job={job}/>
        </div>)}
      </div>}
      {filtersOpen && <div className="filter-grid">
        <label>Type<select value={filters.types} onChange={e => setFilter('types', e.target.value)}>{typeChoices.map(x => <option key={x}>{x}</option>)}</select></label>
        <label>Base model<input list="civitai-base-model-options" value={filters.baseModels} onChange={e => setFilter('baseModels', e.target.value)} placeholder="Any Civitai base model"/><datalist id="civitai-base-model-options">{baseModelChoices.map(x => <option key={x || 'any'} value={x}>{x || 'Any / no base filter'}</option>)}</datalist><small>Type any Civitai value; suggestions are refreshed from Civitai plus local aliases.</small></label>
        <label>Sort<select value={filters.sort} onChange={e => setFilter('sort', e.target.value)}>{['Newest','Most Downloaded','Most Liked','Most Discussed','Highest Rated'].map(x => <option key={x}>{x}</option>)}</select></label>
        <label>Period<select value={filters.period} onChange={e => setFilter('period', e.target.value)}>{['AllTime','Year','Month','Week','Day'].map(x => <option key={x}>{x}</option>)}</select></label>
        <label>NSFW<select value={filters.nsfw} onChange={e => setFilter('nsfw', e.target.value)}><option value="false">Safe only</option><option value="true">Include NSFW</option><option value="">Any / Civitai default</option></select></label>
        <label>Checkpoint subtype<select value={filters.checkpointType} onChange={e => setFilter('checkpointType', e.target.value)}><option value="">Any</option>{['Trained','Merge'].map(x => <option key={x}>{x}</option>)}</select></label>
        <label>Tag<input value={filters.tag} onChange={e => setFilter('tag', e.target.value)} placeholder="anime, style, character"/></label>
        <label>Creator<input value={filters.creator} onChange={e => setFilter('creator', e.target.value)} placeholder="username"/></label>
        <label>Limit<select value={filters.limit} onChange={e => setFilter('limit', e.target.value)}>{['20','40','60','100','200','300'].map(x => <option key={x}>{x}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={filters.primaryFileOnly} onChange={e => setFilter('primaryFileOnly', e.target.checked)}/>Primary file only</label>
        <label className="check"><input type="checkbox" checked={filters.supportsGeneration} onChange={e => setFilter('supportsGeneration', e.target.checked)}/>Supports generation</label>
      </div>}
      <div className="preset-bar"><button className="ghost" onClick={savePreset}>Save current search</button>{(presets || []).map(p => <span className="preset-pill" key={p.id}><button onClick={() => loadPreset(p)} title="Load and search this preset">{p.name}</button><button className="preset-delete" onClick={() => deletePreset(p.id)} title={`Delete ${p.name}`}>×</button></span>)}</div>
    </section>}
    {modelView === 'installed' && <LibraryManager api={api} data={data} equippedIds={equippedIds} equip={equip} onRefresh={loadModels} resetOnOpen />}
    {error && <div className="error">{error}</div>}
    {modelView === 'browse' && <section className="panel"><div className="section-head"><div><p className="eyebrow">Civitai</p><h3>Search results</h3></div><span className={cx('result-count', isSearching && 'loading')}>{isSearching ? 'Searching…' : `${civitai.length} results`}</span></div>{isSearching ? <div className="civitai-grid search-skeletons" aria-hidden="true">{Array.from({ length: 6 }).map((_, i) => <article className="civitai-card skeleton-card" key={i}><div className="skeleton-media"/><div className="civitai-body"><span className="skeleton-line wide"/><span className="skeleton-line"/><span className="skeleton-line short"/><span className="skeleton-button"/></div></article>)}</div> : civitai.length ? <div className="civitai-grid">{civitai.map(item => {
      const version = item.modelVersions?.[0] || item.version || item.latestVersion || {};
      const file = version.files?.find(f => f.primary) || version.files?.[0] || version.file || {};
      const image = version.images?.[0]?.url;
      const job = Object.values(downloads).find(j => String(j.versionId) === String(version.id));
      const downloaded = isDownloaded(version, file, job);
      return <article className={cx('civitai-card', downloaded && 'is-downloaded')} key={`${item.id}-${version.id}`}>
        {image && <PreviewMedia src={image} alt=""/>}
        <div className="civitai-body"><strong>{item.name}</strong><p>{item.type} · {version.baseModel || 'Unknown'} · by {item.creator || 'unknown'}</p><p className="clear-meta">downloads: {item.stats?.downloadCount ?? '—'} · likes: {item.stats?.favoriteCount ?? '—'}</p><DownloadProgress job={job}/><button disabled={downloaded || !version.id} className={downloaded ? 'secondary' : ''} onClick={() => download(version.id, file.id)}><Download size={16}/>{downloaded ? 'Downloaded' : 'Download'}</button></div>
      </article>;
    })}</div> : <div className="empty search-empty"><Search size={26}/><strong>No results to show yet</strong><span>{searchState.status === 'success' ? searchState.message : 'Run a Civitai search and results will appear here.'}</span></div>}</section>}
  </div>;
}

function Workbench({ api }) {
  const qs = api.token ? `?token=${encodeURIComponent(api.token)}` : '';
  const isTailscaleIp = /^100\./.test(location.hostname);
  const secureMobileBase = isTailscaleIp ? `https://${location.hostname}:8789/mobile/` : '/mobile/';
  const sameTabMobileUrl = `${secureMobileBase}${qs}`;
  const newTabMobileUrl = `${secureMobileBase}${qs}`;
  return <section className="panel workbench workbench-launcher">
    <div>
      <p className="eyebrow">ComfyUI mobile workbench</p>
      <h3>Open ComfyUI Mobile</h3>
      <p>The mobile frontend is heavy, so this launcher no longer embeds it in a background iframe. Tap once and you should get an immediate loading screen instead of a dead-looking black page.</p>
      <div className="workbench-actions">
        <a className="primary link" href={sameTabMobileUrl}>Open ComfyUI Mobile</a>
        <a className="secondary link" href={newTabMobileUrl} target="_blank" rel="noreferrer">Open in new tab</a>
      </div>
    </div>
  </section>;
}

function Runtime({ api }) {
  const [runtime, setRuntime] = useState(null);
  const [error, setError] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [showRaw, setShowRaw] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/runtime', { cache: 'no-store' });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
    if (!res.ok) throw new Error(data.error || text || `${res.status} ${res.statusText}`);
    setRuntime(data);
    return data;
  }, []);

  useEffect(() => { load().catch(e => setError(e.message)); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) load().catch(() => {});
    }, 7000);
    const onVisible = () => { if (!document.hidden) load().catch(() => {}); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  async function act(action) {
    if (action === 'stop' && !window.confirm('Stop the managed Media Studio stack? This can interrupt running generations.')) return;
    setBusyAction(action);
    setError('');
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (api.token) headers.Authorization = `Bearer ${api.token}`;
      const res = await fetch('/api/runtime', {
        method: 'POST',
        headers,
        body: JSON.stringify({ action }),
        cache: 'no-store',
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
      if (!res.ok) throw new Error(data.error || data.result?.stderr || text || `${res.status} ${res.statusText}`);
      setRuntime(data.runtime);
    } catch (e) {
      setError(e.message);
      load().catch(() => {});
    } finally {
      setBusyAction('');
    }
  }

  const components = runtime?.components || [];
  const online = components.filter(c => c.online).length;
  const total = components.length || 0;
  const appUrl = runtime?.appUrl || '/';

  return <div className="runtime-layout">
    <section className="panel runtime-hero">
      <div>
        <p className="eyebrow">One app launcher</p>
        <h3>{runtime?.name || 'Media Studio'}</h3>
        <p>The Studio shell, private backend, ComfyUI runtime, mobile workbench, model manager, encrypted outputs, and native MLX sidecars are managed as one local app.</p>
      </div>
      <div className="runtime-actions">
        <a className="primary link" href={appUrl} target="_blank" rel="noreferrer"><ExternalLink size={17}/>Open Studio</a>
        <button className="ghost" onClick={load} disabled={Boolean(busyAction)}><RefreshCw size={17}/>Refresh</button>
        <button className="secondary" onClick={() => act('start')} disabled={Boolean(busyAction)}>{busyAction === 'start' ? <Loader2 className="spin" size={17}/> : <Power size={17}/>}Start all</button>
        <button className="secondary" onClick={() => act('restart')} disabled={Boolean(busyAction)}>{busyAction === 'restart' ? <Loader2 className="spin" size={17}/> : <RefreshCw size={17}/>}Restart</button>
        <button className="danger" onClick={() => act('stop')} disabled={Boolean(busyAction)}>{busyAction === 'stop' ? <Loader2 className="spin" size={17}/> : <Square size={17}/>}Stop</button>
      </div>
    </section>

    {error && <div className="error">{error}</div>}

    <section className="runtime-summary">
      <article className="panel runtime-stat"><Server/><span>Services online</span><strong>{online}/{total || '...'}</strong></article>
      <article className="panel runtime-stat"><ShieldCheck/><span>Manager</span><strong>{runtime?.manager || 'Media Studio supervisor'}</strong></article>
      <article className="panel runtime-stat"><Activity/><span>Last checked</span><strong>{runtime?.checkedAt ? when(runtime.checkedAt) : 'Checking...'}</strong></article>
    </section>

    <section className="runtime-components">
      {components.length ? components.map(component => <article className={cx('panel runtime-card', component.online ? 'online' : 'offline')} key={component.id}>
        <div className="runtime-card-top">
          <div>
            <p className="eyebrow">{component.id}</p>
            <h3>{component.name}</h3>
          </div>
          <span className={cx('runtime-dot', component.online ? 'ok' : 'bad')}>{component.state}</span>
        </div>
        <p>{component.role}</p>
        <div className="runtime-meta">
          {component.port && <span>Port {component.port}</span>}
          {component.pidCount ? <span>{component.pidCount} pid{component.pidCount === 1 ? '' : 's'}</span> : null}
          {component.latencyMs !== null && component.latencyMs !== undefined && <span>{component.latencyMs} ms</span>}
          {component.status ? <span>HTTP {component.status}</span> : null}
        </div>
      </article>) : <article className="panel runtime-card"><Loader2 className="spin"/><p>Checking runtime services...</p></article>}
    </section>

    <section className="panel runtime-terminal">
      <button className="ghost" onClick={() => setShowRaw(v => !v)}><Terminal size={16}/>{showRaw ? 'Hide' : 'Show'} supervisor status</button>
      {showRaw && <pre>{runtime?.rawStatus || 'No status yet.'}</pre>}
    </section>
  </div>;
}

function requestedInitialTab() {
  if (typeof window === 'undefined') return '';
  const qs = new URLSearchParams(location.search);
  const raw = qs.get('tab') || (location.pathname === '/models' ? 'models' : '') || location.hash.replace('#', '');
  return ['studio', 'models', 'workbench', 'runtime'].includes(raw) ? raw : '';
}

function AppContent() {
  const api = useApi();
  const [active, setActiveState] = usePersistentState(TAB_STORAGE, requestedInitialTab() || 'studio');
  const [status, setStatus] = useState(null);
  const setActive = (tab) => { setActiveState(tab); history.replaceState(null, '', `?tab=${encodeURIComponent(tab)}#${tab}`); };
  useEffect(() => {
    const tab = requestedInitialTab();
    if (tab) setActiveState(tab);
  }, [setActiveState]);
  useEffect(() => { api.request('/healthz').then(setStatus).catch(() => setStatus({ ok: false })); }, [api]);
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) api.request('/healthz').then(setStatus).catch(() => setStatus({ ok: false })); };
    document.addEventListener('visibilitychange', onVisible); return () => document.removeEventListener('visibilitychange', onVisible);
  }, [api]);

  return <Shell active={active} setActive={setActive} status={status} api={api}>
    {active === 'studio' && <Studio api={api}/>} {active === 'models' && <Models api={api}/>} {active === 'workbench' && <Workbench api={api}/>} {active === 'runtime' && <Runtime api={api}/>}
  </Shell>;
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[Media Studio UI] render error', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="unlock-screen" style={unlockScreenStyle}>
      <div className="unlock-card" style={unlockCardStyle}>
        <div className="brand-mark unlock-mark"><Zap size={24}/></div>
        <p className="eyebrow">Media Studio</p>
        <h1>Something blocked the app from starting</h1>
        <p className="unlock-copy">Refresh the page once. If it still happens, use the HTTP fallback and tell me this message appeared.</p>
        <div className="error">{this.state.error?.message || 'Unknown browser error'}</div>
        <button className="primary" type="button" onClick={() => location.reload()}>Refresh</button>
      </div>
    </main>;
  }
}

export default function Home() {
  return <ErrorBoundary><AuthGate><AppContent /></AuthGate></ErrorBoundary>;
}
