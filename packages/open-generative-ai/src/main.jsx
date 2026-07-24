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

createRoot(document.querySelector('#app')).render(<App />);
