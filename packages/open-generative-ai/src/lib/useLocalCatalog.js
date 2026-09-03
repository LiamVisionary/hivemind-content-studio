// One discovery of "what can this machine run", shared by every studio that
// offers a local model.
//
// Image, Story and Sprite each used to seed their picker from the static
// LOCAL_MODEL_CATALOG — the DESKTOP build's sd.cpp / Wan2GP inventory. A hosted
// studio serves registry workflows instead and refuses those ids with "Unknown
// local image workflow", so a hosted picker seeded from that list offered
// models that could not run anywhere, and Story never discovered at all.
//
// This hook answers with what the bridge actually reports, and with WHY the
// list is empty when it is — the same four statuses `localInferenceClient`
// defines, so `modelRunner.transportFor` refuses a row with one sentence
// wherever it is shown.
import { useCallback, useEffect, useState } from 'react';
import { isHostedLocalAI, isLocalAIAvailable, localAI } from './localInferenceClient.js';
import { LOCAL_MODEL_CATALOG } from './localModels.js';

const bootModels = () => (isHostedLocalAI() ? [] : LOCAL_MODEL_CATALOG.filter((model) => model.type !== 'video'));

/** A model the bridge listed and did not disown. */
export const isRunnableLocalModel = (model) => model?.type !== 'video'
  && model?.state !== 'not-downloaded'
  && model?.ready !== false;

/**
 * @returns {{models: Array, status: 'discovering'|'ready'|'empty'|'unreachable', refresh: () => Promise<string>}}
 */
export function useLocalImageCatalog() {
  const [models, setModels] = useState(bootModels);
  const [status, setStatus] = useState(() => (isLocalAIAvailable() ? 'discovering' : 'unreachable'));

  const refresh = useCallback(async () => {
    if (!isLocalAIAvailable()) {
      setModels([]);
      setStatus('unreachable');
      return 'unreachable';
    }
    setStatus('discovering');
    const { models: discovered, status: answered } = await localAI.listModels();
    const usable = discovered.filter(isRunnableLocalModel);
    if (usable.length) setModels(usable);
    // A hosted bridge that answered with nothing is the truth about this
    // machine; falling back to the desktop catalog there only re-offers ids
    // this bridge rejects. The desktop build keeps its own list.
    else if (isHostedLocalAI()) setModels([]);
    setStatus(answered);
    return answered;
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // The hub broadcasts this after a model download lands or the stack comes
  // back; without it the boot answer stood for the lifetime of the tab.
  useEffect(() => {
    const onHubRefresh = () => { void refresh(); };
    window.addEventListener('hivemind-hub-refresh', onHubRefresh);
    return () => window.removeEventListener('hivemind-hub-refresh', onHubRefresh);
  }, [refresh]);

  return { models, status, refresh };
}
