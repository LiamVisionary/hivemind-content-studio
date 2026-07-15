import type { QueueWorkflowDiff } from '@/utils/workflowDiff';
import type { QueueItem, ShadowQueueJob } from '../useQueue';

// Bound the in-memory diff map so it can't grow without limit. Prompt ids are
// UUIDs (non-integer keys), so Object.keys preserves insertion order.
const WORKFLOW_DIFF_CAP = 300;
const PROMPT_WORKFLOW_CAP = 300;

export function capWorkflowDiffs(
  diffs: Record<string, QueueWorkflowDiff>,
): Record<string, QueueWorkflowDiff> {
  const keys = Object.keys(diffs);
  if (keys.length <= WORKFLOW_DIFF_CAP) return diffs;
  const trimmed: Record<string, QueueWorkflowDiff> = {};
  for (const key of keys.slice(keys.length - WORKFLOW_DIFF_CAP)) trimmed[key] = diffs[key];
  return trimmed;
}

export function capPromptWorkflows(
  workflows: Record<string, unknown>,
): Record<string, unknown> {
  const keys = Object.keys(workflows);
  if (keys.length <= PROMPT_WORKFLOW_CAP) return workflows;
  const trimmed: Record<string, unknown> = {};
  for (const key of keys.slice(keys.length - PROMPT_WORKFLOW_CAP)) trimmed[key] = workflows[key];
  return trimmed;
}

export function extractPromptWorkflowMetadata(
  extraData: Record<string, unknown> | undefined,
): unknown {
  const extraPngInfo = extraData?.extra_pnginfo;
  if (!extraPngInfo || typeof extraPngInfo !== 'object' || Array.isArray(extraPngInfo)) {
    return undefined;
  }
  return (extraPngInfo as { workflow?: unknown }).workflow;
}

export function withPromptWorkflowMetadata(
  workflows: Record<string, unknown>,
  promptId: string,
  workflow: unknown,
): Record<string, unknown> {
  if (!promptId || workflow === undefined) return workflows;
  if (Object.prototype.hasOwnProperty.call(workflows, promptId)) return workflows;
  return capPromptWorkflows({
    ...workflows,
    [promptId]: workflow,
  });
}

export function makeShadowJobFromQueueItem(
  item: QueueItem,
  status: ShadowQueueJob['status'],
): ShadowQueueJob {
  return {
    originalPromptId: item.prompt_id,
    prompt: item.prompt,
    extraData: item.extra,
    outputsToExecute: item.outputs_to_execute,
    number: item.number,
    status,
    queuedAt: Date.now(),
  };
}
