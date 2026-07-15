import type { QueuePromptMetadata } from '@/api/client';
import type { HistoryOutputImage, Workflow, WorkflowNode } from '@/api/types';
import type { HistoryEntry } from '@/hooks/useHistory';
import type { QueueItem } from '@/hooks/useQueue';

type GenerationDebugSource = 'queue-menu' | 'media-viewer';

export interface BuildGenerationDebugBundleInput {
  source: GenerationDebugSource;
  promptId?: string | null;
  status?: string | null;
  workflow?: Workflow | null;
  historyEntry?: HistoryEntry | null;
  queueItem?: QueueItem | null;
  queueMetadata?: QueuePromptMetadata | null;
  imageSources?: string[];
  fileId?: string | null;
  filename?: string | null;
}

interface NodeSummary {
  id: string;
  type: string;
  title?: string;
  mode?: number;
  inputs?: Record<string, unknown>;
  widgets?: unknown;
}

const INTERESTING_NODE_PATTERNS = [
  /sampler/i,
  /scheduler/i,
  /latent/i,
  /vae/i,
  /lora/i,
  /clip/i,
  /text.*encode/i,
  /rebalance/i,
  /seed/i,
  /model/i,
  /diffusion/i,
  /unet/i,
  /krea/i,
  /asfp8/i,
  /convrot/i,
  /empty.*latent/i,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isInterestingNodeType(type: string): boolean {
  return INTERESTING_NODE_PATTERNS.some((pattern) => pattern.test(type));
}

function summarizeApiPrompt(prompt: Record<string, unknown> | undefined): NodeSummary[] {
  if (!prompt) return [];
  const summaries: NodeSummary[] = [];
  for (const [nodeId, rawNode] of Object.entries(prompt)) {
    if (!isRecord(rawNode)) continue;
    const classType = typeof rawNode.class_type === 'string' ? rawNode.class_type : '';
    if (!classType || !isInterestingNodeType(classType)) continue;
    summaries.push({
      id: nodeId,
      type: classType,
      title: isRecord(rawNode._meta) && typeof rawNode._meta.title === 'string'
        ? rawNode._meta.title
        : undefined,
      inputs: isRecord(rawNode.inputs) ? rawNode.inputs : undefined,
    });
  }
  return summaries;
}

function summarizeWorkflowNode(node: WorkflowNode): NodeSummary {
  return {
    id: String(node.id),
    type: node.type,
    title: node.title,
    mode: node.mode,
    widgets: node.widgets_values,
  };
}

function summarizeWorkflow(workflow: Workflow | undefined): {
  nodeCount: number;
  linkCount: number;
  groupCount: number;
  interestingNodes: NodeSummary[];
} | null {
  if (!workflow) return null;
  const rootNodes = workflow.nodes ?? [];
  const subgraphNodes = workflow.definitions?.subgraphs?.flatMap((subgraph) => subgraph.nodes ?? []) ?? [];
  const allNodes = [...rootNodes, ...subgraphNodes];
  return {
    nodeCount: allNodes.length,
    linkCount: (workflow.links ?? []).length,
    groupCount: (workflow.groups ?? []).length,
    interestingNodes: allNodes
      .filter((node) => isInterestingNodeType(node.type) || isInterestingNodeType(node.title ?? ''))
      .map(summarizeWorkflowNode),
  };
}

function outputSummary(outputs: HistoryOutputImage[]): Array<Pick<HistoryOutputImage, 'filename' | 'subfolder' | 'type'>> {
  return outputs.map((image) => ({
    filename: image.filename,
    subfolder: image.subfolder,
    type: image.type,
  }));
}

export function buildGenerationDebugBundle({
  source,
  promptId,
  status,
  workflow,
  historyEntry,
  queueItem,
  queueMetadata,
  imageSources = [],
  fileId,
  filename,
}: BuildGenerationDebugBundleInput): Record<string, unknown> {
  const resolvedPromptId = promptId ?? historyEntry?.prompt_id ?? queueItem?.prompt_id ?? null;
  const resolvedWorkflow = workflow ?? historyEntry?.workflow ?? null;
  const apiPrompt = historyEntry?.prompt ?? queueItem?.prompt ?? null;
  const extraData = historyEntry?.queueRequest?.extra_data ?? queueItem?.extra ?? null;
  const outputsToExecute = historyEntry?.outputsToExecute ?? queueItem?.outputs_to_execute ?? null;
  const outputs = historyEntry?.outputs.images ?? [];

  return {
    format: 'comfyui-mobile-last-generation-debug-bundle',
    version: 1,
    createdAt: new Date().toISOString(),
    privacyNotice:
      'Manual export only. This bundle may include prompt text, workflow nodes, model names, LoRA names, image filenames, and generation settings.',
    source,
    promptId: resolvedPromptId,
    status: status ?? null,
    generation: {
      timestamp: historyEntry?.timestamp ?? null,
      durationSeconds: historyEntry?.durationSeconds ?? null,
      success: historyEntry?.success ?? null,
      interrupted: historyEntry?.interrupted ?? null,
      errorMessage: historyEntry?.errorMessage ?? null,
      fileId: fileId ?? null,
      filename: filename ?? null,
      imageSources,
      outputs: outputSummary(outputs),
      outputsByNode: historyEntry?.outputsByNode ?? null,
      outputsToExecute,
    },
    queue: {
      number: queueItem?.number ?? null,
      metadata: queueMetadata ?? null,
      hasHistoryEntry: Boolean(historyEntry),
      hasQueueItem: Boolean(queueItem),
      hasWorkflow: Boolean(resolvedWorkflow),
      hasApiPrompt: Boolean(apiPrompt),
    },
    summary: {
      apiPromptNodeCount: apiPrompt ? Object.keys(apiPrompt).length : 0,
      interestingApiNodes: summarizeApiPrompt(apiPrompt ?? undefined),
      workflow: summarizeWorkflow(resolvedWorkflow ?? undefined),
    },
    submitted: {
      apiPrompt,
      extraData,
      outputsToExecute,
      queueRequest: historyEntry?.queueRequest ?? (
        queueItem
          ? {
              prompt: queueItem.prompt,
              extra_data: queueItem.extra,
            }
          : null
      ),
    },
    workflow: resolvedWorkflow,
  };
}
