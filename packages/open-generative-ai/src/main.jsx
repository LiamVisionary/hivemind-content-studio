// Entry — ORDER MATTERS:
// 1. browserLocalAI installs the ?hivemindBridge=1 postMessage shim before any
//    isLocalAIAvailable() probe (same contract as the old main.js line 2).
// 2. recoveryKeyBuffer registers the one-shot vault recovery-key listener before
//    anything can trigger ensureVaultReady().
import './lib/browserLocalAI.js';
import './bridges/recoveryKeyBuffer.js';
import '@fontsource-variable/inter';
import './style.css';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.jsx';
import { hasStoredDrafts, hydrateDrafts } from './lib/draftVault.js';
import { applyDocumentLang } from './lib/i18n.js';
import { installChunkRecovery } from './lib/lazyChunk.js';

applyDocumentLang();
// A rebuilt dist renames every hashed chunk; this reloads a session that booted
// from the old one instead of letting the next dynamic import fail in place.
installChunkRecovery();

// Drafts are decrypted BEFORE the first render, because the studios read their
// boot state synchronously while rendering (loadTabState → the tab's seed), and
// a prompt that arrived a frame later would have to be pushed into a tab that
// had already booted without it. Only a browser that HAS a draft waits: a first
// run finds nothing in localStorage and renders on the same tick it always did.
const ready = hasStoredDrafts() ? hydrateDrafts().catch(() => null) : null;
const mount = () => createRoot(document.querySelector('#app')).render(<App />);
if (ready) void ready.then(mount); else mount();
