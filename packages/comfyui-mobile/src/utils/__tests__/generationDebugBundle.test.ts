import { describe, expect, it } from 'vitest';
import type { Workflow } from '@/api/types';
import type { HistoryEntry } from '@/hooks/useHistory';
import { buildGenerationDebugBundle } from '@/utils/generationDebugBundle';

const workflow = {
  last_node_id: 3,
  last_link_id: 1,
  nodes: [
    {
      id: 1,
      type: 'EmptyLatentImage',
      title: 'Benchmark Latent 528x368',
      pos: [0, 0],
      size: [240, 120],
      flags: {},
      order: 0,
      mode: 0,
      inputs: [],
      outputs: [],
      properties: {},
      widgets_values: [528, 368, 1],
    },
    {
      id: 2,
      type: 'KSampler',
      title: 'Sampler',
      pos: [0, 160],
      size: [240, 180],
      flags: {},
      order: 1,
      mode: 0,
      inputs: [],
      outputs: [],
      properties: {},
      widgets_values: [1234, 'fixed', 12, 1, 'euler', 'beta'],
    },
  ],
  links: [],
  groups: [],
  config: {},
  version: 0.4,
} as Workflow;

const historyEntry: HistoryEntry = {
  prompt_id: 'prompt-1',
  timestamp: 123456,
  durationSeconds: 9.5,
  success: true,
  interrupted: false,
  errorMessage: null,
  outputs: {
    images: [
      { filename: 'test.png', subfolder: '', type: 'output' },
    ],
  },
  outputsByNode: {
    '9': [{ filename: 'test.png', subfolder: '', type: 'output' }],
  },
  prompt: {
    '2': {
      class_type: 'KSampler',
      inputs: {
        seed: 1234,
        steps: 12,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'beta',
      },
    },
    '7': {
      class_type: 'MultiLoRAStack',
      inputs: {
        lora_1_name: 'krea2_turbo_lora_rank_64_bf16.safetensors',
        lora_1_strength: 0.6,
      },
    },
  },
  workflow,
  queueRequest: {
    prompt: {
      '2': {
        class_type: 'KSampler',
        inputs: { seed: 1234, steps: 12 },
      },
    },
    extra_data: { client_id: 'client' },
  },
  outputsToExecute: ['9'],
};

describe('buildGenerationDebugBundle', () => {
  it('exports the selected generation context and useful node summaries', () => {
    const bundle = buildGenerationDebugBundle({
      source: 'queue-menu',
      status: 'done',
      historyEntry,
      imageSources: ['/view?filename=test.png'],
      queueMetadata: {
        promptId: 'prompt-1',
        workflowLabel: 'Krea2 Turbo ConvRot INT8 ASFP8 Bench Apple Silicon',
      },
    });

    expect(bundle.format).toBe('comfyui-mobile-last-generation-debug-bundle');
    expect(bundle.promptId).toBe('prompt-1');
    expect(bundle.generation).toMatchObject({
      durationSeconds: 9.5,
      success: true,
      outputsToExecute: ['9'],
    });
    expect(bundle.queue).toMatchObject({
      hasHistoryEntry: true,
      hasWorkflow: true,
      hasApiPrompt: true,
    });
    expect(bundle.summary).toMatchObject({
      apiPromptNodeCount: 2,
    });
    const summary = bundle.summary as {
      interestingApiNodes: Array<{ type: string }>;
      workflow: { interestingNodes: Array<{ type: string }> };
    };
    expect(summary.interestingApiNodes.map((node) => node.type)).toEqual([
      'KSampler',
      'MultiLoRAStack',
    ]);
    expect(summary.workflow.interestingNodes.map((node) => node.type)).toEqual([
      'EmptyLatentImage',
      'KSampler',
    ]);
    expect(bundle.workflow).toBe(workflow);
  });

  it('can build a bundle from an in-flight queue item without history', () => {
    const bundle = buildGenerationDebugBundle({
      source: 'media-viewer',
      promptId: 'queued-1',
      status: 'running',
      queueItem: {
        number: 4,
        prompt_id: 'queued-1',
        prompt: {
          '5': {
            class_type: 'EmptyLatentImage',
            inputs: { width: 528, height: 368 },
          },
        },
        extra: {},
        outputs_to_execute: ['9'],
      },
      workflow,
    });

    expect(bundle.promptId).toBe('queued-1');
    expect(bundle.queue).toMatchObject({
      number: 4,
      hasHistoryEntry: false,
      hasQueueItem: true,
      hasWorkflow: true,
      hasApiPrompt: true,
    });
  });
});
