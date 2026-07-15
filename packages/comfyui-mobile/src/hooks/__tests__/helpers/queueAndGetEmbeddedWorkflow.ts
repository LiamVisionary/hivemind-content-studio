import { expect, vi } from 'vitest';
import type { Workflow } from '@/api/types';
import type { PromptQueueRequest } from '@/api/client';
import { useWorkflowStore } from '@/hooks/useWorkflow';
import { decryptWorkflowFromStorage, setWorkflowEncryptionKey } from '@/utils/workflowEncryption';

export async function queueAndGetPromptRequest(): Promise<PromptQueueRequest> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/queue')) {
      return {
        ok: true,
        json: async () => ({ queue_running: [], queue_pending: [] })
      };
    }
    return {
      ok: true,
      json: async () => ({ prompt_id: 'p-test', number: 1 })
    };
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  setWorkflowEncryptionKey('vitest-workflow-unlock');

  await useWorkflowStore.getState().queueWorkflow(1);
  const promptCall = fetchMock.mock.calls.find(([input]) =>
    String(input).includes('/api/prompt')
  );
  expect(promptCall).toBeDefined();
  const requestInit = (promptCall as unknown as [RequestInfo | URL, RequestInit | undefined] | undefined)?.[1];
  return JSON.parse(String(requestInit?.body ?? '{}')) as PromptQueueRequest;
}

export async function queueAndGetEmbeddedWorkflow(): Promise<Workflow> {
  const body = await queueAndGetPromptRequest() as PromptQueueRequest & {
    extra_data?: { extra_pnginfo?: { workflow?: unknown } };
  };
  const embedded = body.extra_data?.extra_pnginfo?.workflow;
  expect(embedded).toBeDefined();
  return decryptWorkflowFromStorage<Workflow>(embedded);
}
