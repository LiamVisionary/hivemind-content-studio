import { describe, expect, it } from 'vitest';
import type { Workflow, WorkflowNode } from '@/api/types';
import { summarizeOwnerHistoryWorkflow } from '@/utils/ownerHistoryProvenance';

function node(id: number, type: string, title: string, widgets: unknown[]): WorkflowNode {
  return {
    id,
    type,
    title,
    widgets_values: widgets,
    pos: [0, 0],
    size: [200, 120],
    flags: {},
    order: id,
    mode: 0,
    inputs: [],
    outputs: [],
    properties: {},
  };
}

function workflow(): Workflow {
  return {
    last_node_id: 4,
    last_link_id: 0,
    nodes: [
      node(1, 'CLIPTextEncode', 'Final positive prompt', ['a private cinematic prompt']),
      node(2, 'CLIPTextEncode', 'Negative prompt', ['blurry, low quality']),
      node(3, 'CheckpointLoaderSimple', 'Checkpoint', ['models/exact-model.safetensors']),
      node(4, 'KSampler', 'Sampler', [8675309, 'randomize', 28, 6.5, 'dpmpp_2m', 'karras', 0.9]),
    ],
    links: [],
    groups: [],
    config: {},
    version: 0.4,
    widget_idx_map: {
      '1': { text: 0 },
      '2': { text: 0 },
      '3': { ckpt_name: 0 },
      '4': { seed: 0, control_after_generate: 1, steps: 2, cfg: 3, sampler_name: 4, scheduler: 5, denoise: 6 },
    },
  };
}

describe('summarizeOwnerHistoryWorkflow', () => {
  it('extracts the owner prompt, exact model, seed value, seed mode, and sampler settings', () => {
    const summary = summarizeOwnerHistoryWorkflow(workflow(), null);

    expect(summary.primaryPrompt).toBe('a private cinematic prompt');
    expect(summary.negativePrompt).toBe('blurry, low quality');
    expect(summary.models).toEqual(['models/exact-model.safetensors']);
    expect(summary.seeds).toEqual([
      expect.objectContaining({ value: 8675309, mode: 'randomize', label: 'Sampler' }),
    ]);
    expect(summary.settings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'steps', value: 28 }),
      expect.objectContaining({ name: 'cfg', value: 6.5 }),
      expect.objectContaining({ name: 'sampler_name', value: 'dpmpp_2m' }),
    ]));
  });

  it('recognizes special random seed values when a control widget is absent', () => {
    const value = workflow();
    value.nodes[3].widgets_values = [-1, 28];
    value.widget_idx_map!['4'] = { seed: 0, steps: 1 };

    expect(summarizeOwnerHistoryWorkflow(value, null).seeds[0]).toEqual(
      expect.objectContaining({ value: -1, mode: 'randomize' }),
    );
  });
});
