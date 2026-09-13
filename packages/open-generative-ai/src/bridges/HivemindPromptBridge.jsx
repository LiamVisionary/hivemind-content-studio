// Hivemind prompt bridge (React port of hivemindStudio.js installHivemindExploreDock).
// Rendered once by App (singleton); returns null outside studio mode, and draws
// nothing in it either — the prompt library it used to carry is now a popover in
// the composer that owns the prompt (studios/frame/PromptLibraryMenu.jsx). What
// is left is the part that was never visible: the hub's postMessage contracts.
//
// Contracts preserved verbatim:
// - window 'message' (same-origin only): 'hivemind-owner-lock' -> clear private
//   state + reset vault session + clear resolved media cache;
//   'hivemind-explore-insert-prompt' {text}; 'hivemind-explore-refresh'
// - readiness handshake: postMessage {type:'hivemind-explore-ready'} to parent
// - install-time legacy plaintext scrub (via loadStudioGenerationHistory, which
//   scrubs 'muapi_history'/'video_history'/'muapi_pending_jobs' in studio mode)
//
// The generation-option switches and the local-video-workflow select the dock
// once carried were removed on 2026-09-03 — the switches wrote a sessionStorage
// key nothing read, and the select duplicated the Video studio's own picker.
import { useCallback, useEffect } from 'react';

import { insertIntoActivePrompt } from '../app/promptTarget.js';
import { clearResolvedMediaCache } from '../lib/e2eMedia.js';
import {
  clearHivemindStudioPrivateState,
  isHivemindStudioEnabled,
  loadHivemindStudioContext,
  loadStudioGenerationHistory,
} from '../lib/hivemindStudio.js';
import { resetVaultSession } from '../lib/vaultSession.js';

function HivemindPromptBridgeInner() {
  const refreshContext = useCallback((opts) => loadHivemindStudioContext(opts), []);

  // Install-time behaviors: legacy plaintext-state scrub (studio mode), parent
  // readiness handshake, initial context discovery.
  useEffect(() => {
    loadStudioGenerationHistory('muapi_history');
    window.parent?.postMessage?.({ type: 'hivemind-explore-ready' }, window.location.origin);
    void refreshContext();
  }, [refreshContext]);

  // Hub postMessage bridge — same-origin only, exact message types preserved.
  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      const type = event.data?.type;
      if (type === 'hivemind-owner-lock') {
        clearHivemindStudioPrivateState();
        resetVaultSession();
        clearResolvedMediaCache();
        return;
      }
      if (type === 'hivemind-explore-insert-prompt') insertIntoActivePrompt(event.data.text || '');
      if (type === 'hivemind-explore-refresh') void refreshContext({ refresh: true });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refreshContext]);

  return null;
}

export function HivemindPromptBridge() {
  // Studio-mode gate is URL/global-derived and constant per page load.
  if (!isHivemindStudioEnabled()) return null;
  return <HivemindPromptBridgeInner />;
}
