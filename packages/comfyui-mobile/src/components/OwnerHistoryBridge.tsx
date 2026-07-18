import { useEffect } from 'react';
import { useImageViewerStore } from '@/hooks/useImageViewer';
import { useNavigationStore } from '@/hooks/useNavigation';
import { useWorkflowStore } from '@/hooks/useWorkflow';
import { isWorkflow } from '@/utils/imageWorkflowMetadata';
import { summarizeOwnerHistoryWorkflow } from '@/utils/ownerHistoryProvenance';
import { isTrustedOwnerParentEvent } from '@/utils/trustedOwnerParent';
import {
  decryptWorkflowFromStorage,
  isWorkflowEncryptionUnlocked,
  subscribeWorkflowEncryptionStatus,
} from '@/utils/workflowEncryption';

function trustedParent(event: MessageEvent): boolean {
  return isTrustedOwnerParentEvent(event);
}

export function OwnerHistoryBridge() {
  useEffect(() => {
    const announceReady = () => {
      if (!isWorkflowEncryptionUnlocked()) return;
      try {
        const origin = document.referrer ? new URL(document.referrer).origin : '*';
        window.parent.postMessage({ type: 'hivemind-owner-history-bridge-ready' }, origin);
      } catch {
        window.parent.postMessage({ type: 'hivemind-owner-history-bridge-ready' }, '*');
      }
    };
    const reply = (event: MessageEvent, payload: Record<string, unknown>) => {
      (event.source as WindowProxy | null)?.postMessage(payload, { targetOrigin: event.origin });
    };
    const onRequest = async (event: MessageEvent) => {
      if (!trustedParent(event) || event.data?.type !== 'hivemind-owner-history-request') return;
      const requestId = typeof event.data.requestId === 'string' ? event.data.requestId : '';
      if (!requestId) return;
      try {
        const workflow = await decryptWorkflowFromStorage(event.data.workflow);
        if (!isWorkflow(workflow)) throw new Error('This output has no loadable exact workflow');
        const workflowState = useWorkflowStore.getState();
        const setup = summarizeOwnerHistoryWorkflow(workflow, workflowState.nodeTypes);
        if (event.data.action === 'load-canvas') {
          workflowState.loadWorkflow(workflow, `canvas-history-${String(event.data.historyId || 'output')}.json`, {
            fresh: true,
            source: { type: 'other' },
            navigate: true,
          });
          useNavigationStore.getState().setCurrentPanel('workflow');
          const mediaUrl = new URL(String(event.data.mediaUrl || ''), event.origin).toString();
          const mediaType = String(event.data.mediaType || '').startsWith('video/') ? 'video' : 'image';
          useImageViewerStore.getState().setViewerState({
            viewerOpen: true,
            viewerImages: [{
              src: mediaUrl,
              alt: 'Private Canvas output',
              mediaType,
              workflow,
            }],
            viewerIndex: 0,
            viewerScale: 1,
            viewerTranslate: { x: 0, y: 0 },
          });
        }
        reply(event, {
          type: 'hivemind-owner-history-response',
          requestId,
          ok: true,
          setup,
        });
      } catch (error) {
        reply(event, {
          type: 'hivemind-owner-history-response',
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : 'Unable to read the exact workflow',
        });
      }
    };
    window.addEventListener('message', onRequest);
    const unsubscribe = subscribeWorkflowEncryptionStatus(announceReady);
    announceReady();
    return () => {
      unsubscribe();
      window.removeEventListener('message', onRequest);
    };
  }, []);

  return null;
}
