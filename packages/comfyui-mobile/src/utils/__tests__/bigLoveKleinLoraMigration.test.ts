import { describe, expect, it } from 'vitest';
import type { Workflow, WorkflowLink, WorkflowNode } from '@/api/types';
import {
  BIGLOVE_KLEIN3_MLX_TEST_FILENAME,
  repairBigLoveKlein3MlxComfyLoraStack,
  repairBigLoveKlein3MlxLoraStack,
} from '../bigLoveKleinLoraMigration';

const PIPELINE_TYPE = 'MfluxLorasPipeline';

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
    pos: [id * 10, id * 10],
    size: [320, 190],
    flags: {},
    order: id,
    mode: 0,
    inputs,
    outputs,
    properties: {},
    widgets_values: [],
  };
}

function makeMfluxStack(id: number, inputLink: number | null, outputLinks: number[]): WorkflowNode {
  return makeNode(
    id,
    'MfluxLorasLoader',
    [{ name: 'Loras', type: PIPELINE_TYPE, link: inputLink }],
    [{ name: 'Loras', type: PIPELINE_TYPE, links: outputLinks, slot_index: 0 }],
  );
}

function makeQuickNode(id: number, lorasLink: number | null): WorkflowNode {
  return makeNode(
    id,
    'QuickMfluxNode',
    [{ name: 'Loras', type: PIPELINE_TYPE, link: lorasLink }],
    [],
  );
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

describe('BigLoveKlein3MLXTest MFlux LoRA migration', () => {
  it('rewires one existing MFlux LoRA stack into a two-stack chain', () => {
    const firstStack = makeMfluxStack(10, null, [3]);
    firstStack.widgets_values = ['anima-turbo-lora-v0.2.safetensors', 0.85, 'None', 1, 'None', 1];
    const quick = makeQuickNode(20, 3);
    const workflow = makeWorkflow([
      firstStack,
      quick,
    ], [
      [3, 10, 0, 20, 0, PIPELINE_TYPE],
    ]);

    const result = repairBigLoveKlein3MlxLoraStack(workflow, BIGLOVE_KLEIN3_MLX_TEST_FILENAME);

    expect(result.changed).toBe(true);
    const migrated = result.workflow;
    const stacks = migrated.nodes.filter((node) => node.type === 'MfluxLorasLoader');
    expect(stacks).toHaveLength(2);
    expect(stacks.map((node) => node.title)).toEqual([
      'MFlux LoRA Stack 1-3',
      'MFlux LoRA Stack 4-6',
    ]);

    const stackOne = migrated.nodes.find((node) => node.title === 'MFlux LoRA Stack 1-3');
    const stackTwo = migrated.nodes.find((node) => node.title === 'MFlux LoRA Stack 4-6');
    const migratedQuick = migrated.nodes.find((node) => node.type === 'QuickMfluxNode');
    expect(stackOne).toBeDefined();
    expect(stackTwo).toBeDefined();
    expect(migratedQuick).toBeDefined();

    const stackOneToTwo = migrated.links.find((link) => link[1] === stackOne?.id && link[3] === stackTwo?.id);
    const stackTwoToQuick = migrated.links.find((link) => link[1] === stackTwo?.id && link[3] === migratedQuick?.id);
    expect(stackOneToTwo?.[5]).toBe(PIPELINE_TYPE);
    expect(stackTwoToQuick?.[5]).toBe(PIPELINE_TYPE);
    expect(migratedQuick?.inputs[0].link).toBe(stackTwoToQuick?.[0]);
    expect(migrated.links.find((link) => link[0] === 3)).toBeUndefined();
    expect(stackOne?.outputs[0].links).toEqual([stackOneToTwo?.[0]]);
  });

  it('creates a two-stack chain when the Quick MFlux node has no LoRA loader yet', () => {
    const quick = makeQuickNode(20, null);
    const workflow = makeWorkflow([quick], []);

    const result = repairBigLoveKlein3MlxLoraStack(workflow, BIGLOVE_KLEIN3_MLX_TEST_FILENAME);

    expect(result.changed).toBe(true);
    const migrated = result.workflow;
    const stackOne = migrated.nodes.find((node) => node.title === 'MFlux LoRA Stack 1-3');
    const stackTwo = migrated.nodes.find((node) => node.title === 'MFlux LoRA Stack 4-6');
    const migratedQuick = migrated.nodes.find((node) => node.type === 'QuickMfluxNode');

    expect(stackOne).toBeDefined();
    expect(stackTwo).toBeDefined();
    expect(migrated.links).toEqual([
      expect.arrayContaining([expect.any(Number), stackOne?.id, 0, stackTwo?.id, 0, PIPELINE_TYPE]),
      expect.arrayContaining([expect.any(Number), stackTwo?.id, 0, migratedQuick?.id, 0, PIPELINE_TYPE]),
    ]);
    expect(migratedQuick?.inputs[0].link).toBe(migrated.links[1][0]);
  });

  it('leaves an already-correct two-stack chain alone', () => {
    const stackOne = makeMfluxStack(10, null, [4]);
    stackOne.title = 'MFlux LoRA Stack 1-3';
    stackOne.widgets_values = ['None', 1, 'None', 1, 'None', 1];
    const stackTwo = makeMfluxStack(11, 4, [5]);
    stackTwo.title = 'MFlux LoRA Stack 4-6';
    stackTwo.widgets_values = ['None', 1, 'None', 1, 'None', 1];
    const quick = makeQuickNode(20, 5);
    const workflow = makeWorkflow([
      stackOne,
      stackTwo,
      quick,
    ], [
      [4, 10, 0, 11, 0, PIPELINE_TYPE],
      [5, 11, 0, 20, 0, PIPELINE_TYPE],
    ]);

    const result = repairBigLoveKlein3MlxLoraStack(workflow, BIGLOVE_KLEIN3_MLX_TEST_FILENAME);

    expect(result.changed).toBe(false);
    expect(result.workflow).toBe(workflow);
  });

  it('does not alter other workflows', () => {
    const quick = makeQuickNode(20, null);
    const workflow = makeWorkflow([quick], []);

    const result = repairBigLoveKlein3MlxLoraStack(workflow, 'AnotherWorkflow.json');

    expect(result.changed).toBe(false);
    expect(result.workflow).toBe(workflow);
  });
});

describe('BigLoveKlein3MLXTest Comfy LoRA migration', () => {
  it('repairs a persisted standard LoraLoader into the MultiLoRAStackModelOnly fast-path node', () => {
    const unet = makeNode(
      105,
      'UNETLoader',
      [],
      [{ name: 'MODEL', type: 'MODEL', links: [254], slot_index: 0 }],
    );
    unet.widgets_values = ['BigLoveKlein3_mxfp8_mlx_native.safetensors', 'default'];

    const clip = makeNode(
      106,
      'CLIPLoader',
      [],
      [{ name: 'CLIP', type: 'CLIP', links: [255], slot_index: 0 }],
    );
    const prompt = makeNode(
      107,
      'CLIPTextEncode',
      [{ name: 'clip', type: 'CLIP', link: 186 }],
      [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [], slot_index: 0 }],
    );
    const guider = makeNode(
      101,
      'CFGGuider',
      [{ name: 'model', type: 'MODEL', link: 253 }],
      [],
    );
    const loader = makeNode(
      146,
      'LoraLoader',
      [
        { name: 'model', type: 'MODEL', link: 254 },
        { name: 'clip', type: 'CLIP', link: 255 },
      ],
      [
        { name: 'MODEL', type: 'MODEL', links: [253], slot_index: 0 },
        { name: 'CLIP', type: 'CLIP', links: [186], slot_index: 1 },
      ],
    );
    loader.mode = 4;
    loader.widgets_values = ['style.safetensors', 0.8, 1];

    const workflow = makeWorkflow(
      [unet, clip, prompt, guider, loader],
      [
        [186, 146, 1, 107, 0, 'CLIP'],
        [253, 146, 0, 101, 0, 'MODEL'],
        [254, 105, 0, 146, 0, 'MODEL'],
        [255, 106, 0, 146, 1, 'CLIP'],
      ],
    );

    const result = repairBigLoveKlein3MlxComfyLoraStack(
      workflow,
      BIGLOVE_KLEIN3_MLX_TEST_FILENAME,
    );

    expect(result.changed).toBe(true);
    const migrated = result.workflow;
    const stack = migrated.nodes.find((node) => node.id === 146);
    expect(stack?.type).toBe('MultiLoRAStackModelOnly');
    expect(stack?.mode).toBe(0);
    expect(stack?.inputs).toEqual([{ name: 'model', type: 'MODEL', link: 254 }]);
    expect(stack?.outputs).toEqual([
      { name: 'MODEL', type: 'MODEL', links: [253], slot_index: 0 },
    ]);
    expect(stack?.widgets_values).toEqual([
      JSON.stringify([{ on: true, lora: 'style.safetensors', strength: 0.8 }]),
    ]);
    expect(migrated.nodes.some((node) => node.type === 'LoraLoader')).toBe(false);
    expect(migrated.links.find((link) => link[0] === 186)).toBeUndefined();
    expect(migrated.links.find((link) => link[0] === 255)).toEqual([255, 106, 0, 107, 0, 'CLIP']);
    expect(migrated.nodes.find((node) => node.id === 107)?.inputs[0].link).toBe(255);
    expect(migrated.nodes.find((node) => node.id === 101)?.inputs[0].link).toBe(253);
  });

  it('does not alter a non-BigLove workflow with a standard LoraLoader', () => {
    const loader = makeNode(1, 'LoraLoader');
    loader.widgets_values = ['style.safetensors', 1, 1];
    const workflow = makeWorkflow([loader], []);

    const result = repairBigLoveKlein3MlxComfyLoraStack(workflow, 'Other.json');

    expect(result.changed).toBe(false);
    expect(result.workflow).toBe(workflow);
  });
});
