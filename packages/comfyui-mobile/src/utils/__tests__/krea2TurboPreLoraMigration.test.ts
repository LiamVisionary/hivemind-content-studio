import { describe, expect, it } from 'vitest';
import type { Workflow, WorkflowLink, WorkflowNode } from '@/api/types';
import {
  isLegacyKrea2TurboRuntimeLoraWorkflow,
  repairKrea2TurboPreLoraWorkflow,
} from '../krea2TurboPreLoraMigration';

function makeNode(
  id: number,
  type: string,
  inputs: WorkflowNode['inputs'] = [],
  outputs: WorkflowNode['outputs'] = [],
): WorkflowNode {
  return {
    id,
    title: type,
    type,
    pos: [id * 20, id * 20],
    size: [320, 160],
    flags: {},
    order: id,
    mode: 0,
    inputs,
    outputs,
    properties: { 'Node name for S&R': type },
    widgets_values: [],
  };
}

function makeWorkflow(nodes: WorkflowNode[], links: WorkflowLink[]): Workflow {
  return {
    last_node_id: Math.max(0, ...nodes.map((node) => node.id)),
    last_link_id: Math.max(0, ...links.map((link) => link[0])),
    nodes,
    links,
    groups: [],
    config: {},
    version: 0.4,
  };
}

function legacyWorkflow(): Workflow {
  const unet = makeNode(
    1,
    'UNETLoader',
    [],
    [{ name: 'MODEL', type: 'MODEL', links: [1], slot_index: 0 }],
  );
  unet.widgets_values = ['Krea2_Turbo_convrot_int8mixed.safetensors', 'default'];

  const clip = makeNode(
    2,
    'CLIPLoader',
    [],
    [{ name: 'CLIP', type: 'CLIP', links: [2], slot_index: 0 }],
  );
  clip.widgets_values = ['qwen3vl_4b_bf16.safetensors', 'krea2', 'default'];

  const stack = makeNode(
    3,
    'MultiLoRAStack',
    [
      { name: 'model', type: 'MODEL', link: 1 },
      { name: 'clip', type: 'CLIP', link: 2 },
    ],
    [
      { name: 'MODEL', type: 'MODEL', links: [3], slot_index: 0 },
      { name: 'CLIP', type: 'CLIP', links: [4, 5], slot_index: 1 },
    ],
  );
  stack.widgets_values = ['[{"on":true,"lora":"realism_engine_krea2_v2.safetensors","strength":1},{"on":true,"lora":"krea2_mary.safetensors","strength":1.5}]'];

  const text = makeNode(
    4,
    'TextEncodeKrea2',
    [
      { name: 'clip', type: 'CLIP', link: 4 },
      { name: 'prompt', type: 'STRING', link: 17 },
      { name: 'system_prompt', type: 'STRING', link: null },
    ],
    [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [6], slot_index: 0 }],
  );
  text.widgets_values = ['direct prompt fixture', 1, 1, 0, 'before prompt', true, 'json_structured', 'json_structured'];

  const negative = makeNode(
    5,
    'CLIPTextEncode',
    [
      { name: 'clip', type: 'CLIP', link: 5 },
      { name: 'text', type: 'STRING', link: null },
    ],
    [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [7], slot_index: 0 }],
  );
  negative.widgets_values = [''];

  const sampler = makeNode(
    7,
    'KSampler',
    [
      { name: 'model', type: 'MODEL', link: 3 },
      { name: 'positive', type: 'CONDITIONING', link: 6 },
      { name: 'negative', type: 'CONDITIONING', link: 7 },
    ],
    [{ name: 'LATENT', type: 'LATENT', links: [], slot_index: 0 }],
  );
  sampler.title = 'KSampler - Turbo INT8 er_sde';
  sampler.widgets_values = [794015397137290, 'fixed', 8, 1.0, 'er_sde', 'simple', 1.0];

  const compact = makeNode(
    14,
    'Krea2PromptCompact',
    [{ name: 'prompt_json', type: 'STRING', link: 16 }],
    [{ name: 'prompt', type: 'STRING', links: [17], slot_index: 0 }],
  );
  compact.widgets_values = [2600, 8000, 'json_structured'];

  return makeWorkflow(
    [unet, clip, stack, text, negative, sampler, compact],
    [
      [1, 1, 0, 3, 0, 'MODEL'],
      [2, 2, 0, 3, 1, 'CLIP'],
      [3, 3, 0, 7, 0, 'MODEL'],
      [4, 3, 1, 4, 0, 'CLIP'],
      [5, 3, 1, 5, 0, 'CLIP'],
      [6, 4, 0, 7, 1, 'CONDITIONING'],
      [7, 5, 0, 7, 2, 'CONDITIONING'],
      [16, 11, 0, 14, 0, 'STRING'],
      [17, 14, 0, 4, 1, 'STRING'],
    ],
  );
}

describe('Krea2 Turbo ConvRot Pre-LoRA migration', () => {
  it('detects the legacy runtime LoRA route', () => {
    expect(isLegacyKrea2TurboRuntimeLoraWorkflow(legacyWorkflow())).toBe(true);
  });

  it('rewires legacy runtime LoRA to Pre-LoRA before ConvRot quantization', () => {
    const result = repairKrea2TurboPreLoraWorkflow(legacyWorkflow());

    expect(result.changed).toBe(true);
    const migrated = result.workflow;
    const unet = migrated.nodes.find((node) => node.id === 1);
    const stack = migrated.nodes.find((node) => node.id === 3);
    const clip = migrated.nodes.find((node) => node.id === 2);
    const text = migrated.nodes.find((node) => node.id === 4);
    const negative = migrated.nodes.find((node) => node.id === 5);
    const sampler = migrated.nodes.find((node) => node.id === 7);
    const compact = migrated.nodes.find((node) => node.id === 14);

    expect(unet?.type).toBe('OTUNetLoaderW8A8');
    expect(unet?.inputs[0]).toMatchObject({ name: 'pre_lora', type: 'PRE_LORA', link: 1 });
    expect(unet?.widgets_values).toEqual([
      'krea2_turbo_bf16.safetensors',
      'default',
      'krea2',
      true,
      true,
      'None',
    ]);
    expect(unet?.outputs[0].links).toEqual([3]);

    expect(stack?.type).toBe('MultiLoRAStackToPreLora');
    expect(stack?.inputs).toEqual([]);
    expect(stack?.outputs).toEqual([{ name: 'PRE_LORA', type: 'PRE_LORA', links: [1], slot_index: 0 }]);
    expect(stack?.widgets_values).toEqual(['[{"on":true,"lora":"realism_engine_krea2_v2.safetensors","strength":1},{"on":true,"lora":"krea2_mary.safetensors","strength":1.5}]']);

    expect(clip?.outputs[0].links).toEqual([4, 5]);
    expect(text?.inputs[0].link).toBe(4);
    expect(negative?.inputs[0].link).toBe(5);
    expect(sampler?.inputs[0].link).toBe(3);
    expect(sampler?.widgets_values).toEqual([794015397137290, 'fixed', 8, 1.0, 'euler_ancestral', 'beta', 1.0]);
    expect(sampler?.title).toBe('KSampler - Turbo INT8 euler ancestral beta');
    expect(text?.widgets_values).toEqual(['direct prompt fixture', 1.0, 0.0, 'before prompt', false, true, 'json_structured']);
    expect(compact?.widgets_values).toEqual([2600, 'json_structured']);

    expect(migrated.links).toContainEqual([1, 3, 0, 1, 0, 'PRE_LORA']);
    expect(migrated.links).toContainEqual([3, 1, 0, 7, 0, 'MODEL']);
    expect(migrated.links).toContainEqual([4, 2, 0, 4, 0, 'CLIP']);
    expect(migrated.links).toContainEqual([5, 2, 0, 5, 0, 'CLIP']);
    expect(migrated.links.find((link) => link[0] === 2)).toBeUndefined();
  });

  it('leaves the repaired route alone', () => {
    const once = repairKrea2TurboPreLoraWorkflow(legacyWorkflow()).workflow;
    const twice = repairKrea2TurboPreLoraWorkflow(once);

    expect(twice.changed).toBe(false);
    expect(twice.workflow).toBe(once);
  });

  it('repairs stale sampler widgets on an already migrated route', () => {
    const migrated = repairKrea2TurboPreLoraWorkflow(legacyWorkflow()).workflow;
    const staleSampler = migrated.nodes.find((node) => node.id === 7);
    if (staleSampler) {
      staleSampler.widgets_values = [1, 'randomize', 8, 1.0, 'er_sde', 'simple', 1.0];
      staleSampler.title = 'KSampler - Turbo INT8 er_sde';
    }

    const repaired = repairKrea2TurboPreLoraWorkflow(migrated);
    const sampler = repaired.workflow.nodes.find((node) => node.id === 7);

    expect(repaired.changed).toBe(true);
    expect(sampler?.widgets_values).toEqual([1, 'randomize', 8, 1.0, 'euler_ancestral', 'beta', 1.0]);
    expect(sampler?.title).toBe('KSampler - Turbo INT8 euler ancestral beta');
  });
});
