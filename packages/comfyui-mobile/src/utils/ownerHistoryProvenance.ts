import type { NodeTypes, Workflow, WorkflowNode } from '@/api/types';
import { getNodeWidgetIndexMap } from '@/utils/workflowInputs';
import { collectAllWorkflowNodes } from '@/utils/workflowNodes';
import {
  findSeedWidgetIndex,
  getSpecialSeedMode,
  getWidgetIndexForInput,
  type SeedMode,
} from '@/utils/seedUtils';

export interface OwnerHistorySeed {
  nodeId: number;
  label: string;
  value: number;
  mode: SeedMode;
}

export interface OwnerHistorySetting {
  nodeId: number;
  label: string;
  name: string;
  value: string | number | boolean;
}

export interface OwnerHistoryWorkflowSummary {
  primaryPrompt: string;
  negativePrompt: string;
  models: string[];
  seeds: OwnerHistorySeed[];
  settings: OwnerHistorySetting[];
  nodeCount: number;
}

const PROMPT_FIELDS = [
  'positive_prompt',
  'prompt',
  'text',
  'positive',
  'wildcard_text',
  'text_g',
  'text_l',
  'negative_prompt',
  'negative',
] as const;
const MODEL_FIELDS = ['ckpt_name', 'unet_name', 'model_name', 'diffusion_model'] as const;
const SETTING_FIELDS = [
  'steps',
  'cfg',
  'cfg_scale',
  'guidance',
  'denoise',
  'sampler_name',
  'scheduler',
  'width',
  'height',
] as const;
const SEED_MODES = new Set<SeedMode>(['fixed', 'randomize', 'increment', 'decrement']);

function nodeLabel(node: WorkflowNode): string {
  return String(node.title || node.type || `Node ${node.id}`).trim();
}

function widgetValue(
  workflow: Workflow,
  nodeTypes: NodeTypes | null,
  node: WorkflowNode,
  name: string,
): unknown {
  const values = node.widgets_values;
  if (values && !Array.isArray(values) && typeof values === 'object') {
    return (values as Record<string, unknown>)[name];
  }
  if (!Array.isArray(values)) return undefined;
  const mapped = getNodeWidgetIndexMap(workflow, node)?.[name];
  const index = mapped ?? getWidgetIndexForInput(workflow, nodeTypes, node, name) ?? undefined;
  return index === undefined ? undefined : values[index];
}

function inferSeedMode(node: WorkflowNode, value: number): SeedMode {
  const explicit = Array.isArray(node.widgets_values)
    ? node.widgets_values.find((candidate) => typeof candidate === 'string' && SEED_MODES.has(candidate.toLowerCase() as SeedMode))
    : undefined;
  if (typeof explicit === 'string') return explicit.toLowerCase() as SeedMode;
  return getSpecialSeedMode(value) ?? 'fixed';
}

interface PromptCandidate {
  text: string;
  negative: boolean;
  score: number;
}

export function summarizeOwnerHistoryWorkflow(
  workflow: Workflow,
  nodeTypes: NodeTypes | null,
): OwnerHistoryWorkflowSummary {
  const nodes = collectAllWorkflowNodes(workflow).filter((node) => node.mode !== 4);
  const promptCandidates: PromptCandidate[] = [];
  const modelValues: string[] = [];
  const seeds: OwnerHistorySeed[] = [];
  const settings: OwnerHistorySetting[] = [];

  for (const node of nodes) {
    const label = nodeLabel(node);
    for (const field of PROMPT_FIELDS) {
      const value = widgetValue(workflow, nodeTypes, node, field);
      if (typeof value !== 'string' || !value.trim()) continue;
      const marker = `${label} ${node.type} ${field}`;
      const negative = /negative/i.test(marker);
      const score = (negative ? 0 : 1000)
        + (/final|positive/i.test(marker) ? 300 : 0)
        + (/prompt|text.*encode/i.test(marker) ? 100 : 0)
        + Math.min(value.length, 100);
      promptCandidates.push({ text: value, negative, score });
    }

    for (const field of MODEL_FIELDS) {
      const value = widgetValue(workflow, nodeTypes, node, field);
      if (typeof value === 'string' && value.trim()) modelValues.push(value.trim());
    }

    const widgetMap = getNodeWidgetIndexMap(workflow, node);
    const seedIndex = widgetMap?.seed
      ?? widgetMap?.noise_seed
      ?? findSeedWidgetIndex(workflow, nodeTypes, node);
    if (seedIndex !== null && Array.isArray(node.widgets_values)) {
      const value = Number(node.widgets_values[seedIndex]);
      if (Number.isFinite(value)) {
        seeds.push({ nodeId: node.id, label, value, mode: inferSeedMode(node, value) });
      }
    }

    for (const field of SETTING_FIELDS) {
      const value = widgetValue(workflow, nodeTypes, node, field);
      if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
      settings.push({
        nodeId: node.id,
        label,
        name: field,
        value: value as string | number | boolean,
      });
    }
  }

  const positive = promptCandidates.filter((candidate) => !candidate.negative).sort((left, right) => right.score - left.score)[0];
  const negative = promptCandidates.filter((candidate) => candidate.negative).sort((left, right) => right.score - left.score)[0];
  return {
    primaryPrompt: positive?.text ?? '',
    negativePrompt: negative?.text ?? '',
    models: [...new Set(modelValues)],
    seeds,
    settings,
    nodeCount: nodes.length,
  };
}
