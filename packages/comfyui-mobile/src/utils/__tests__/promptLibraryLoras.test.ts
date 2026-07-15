import { describe, expect, it } from 'vitest';
import type { Workflow, WorkflowNode } from '@/api/types';
import { applyPromptLibraryLorasToWorkflow } from '../promptLibraryLoras';
import { extractMultiLoraStackList } from '../loraManager';

function makeNode(id: number, type: string, widgetsValues: unknown[], title = type): WorkflowNode {
  return {
    id,
    itemKey: `node-${id}`,
    type,
    title,
    pos: [0, 0],
    size: [200, 100],
    flags: {},
    order: 0,
    mode: 0,
    inputs: [],
    outputs: [],
    properties: {},
    widgets_values: widgetsValues,
  };
}

function makeWorkflow(nodes: WorkflowNode[]): Workflow {
  return {
    last_node_id: nodes.length,
    last_link_id: 0,
    nodes,
    links: [],
    groups: [],
    config: {},
    version: 0.4,
  };
}

describe('promptLibraryLoras', () => {
  it('reenables and appends LoRAs in a MultiLoRAStack node without stripping filenames', () => {
    const workflow = makeWorkflow([
      makeNode(10, 'MultiLoRAStackModelOnly', [
        JSON.stringify([
          { on: false, lora: 'characters/Himawari.safetensors', strength: 0.6 },
        ]),
      ]),
    ]);

    const result = applyPromptLibraryLorasToWorkflow(workflow, [
      { name: 'characters/Himawari.safetensors', strength: 1 },
      { name: 'styles/anime.safetensors', strength: 0.8 },
    ]);

    const node = result.workflow.nodes[0];
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    const stack = extractMultiLoraStackList(values[0]);

    expect(result.summary.applied).toEqual([
      'characters/Himawari.safetensors',
      'styles/anime.safetensors',
    ]);
    expect(stack).toEqual([
      expect.objectContaining({
        name: 'characters/Himawari.safetensors',
        strength: 1,
        active: true,
      }),
      expect.objectContaining({
        name: 'styles/anime.safetensors',
        strength: 0.8,
        active: true,
      }),
    ]);
  });

  it('adds LoRAs to Power Lora Loader rows', () => {
    const workflow = makeWorkflow([
      makeNode(11, 'Power Lora Loader (rgthree)', [
        { on: false, lora: 'old.safetensors', strength: 0.5 },
      ]),
    ]);

    const result = applyPromptLibraryLorasToWorkflow(workflow, [
      { name: 'new.safetensors', strength: 1 },
    ]);

    expect(result.workflow.nodes[0].widgets_values).toEqual([
      expect.objectContaining({ on: false, lora: 'old.safetensors', strength: 0.5 }),
      expect.objectContaining({ on: true, lora: 'new.safetensors', strength: 1 }),
    ]);
  });

  it('falls back to single-loader workflows and reports skipped extras', () => {
    const workflow = makeWorkflow([
      makeNode(12, 'LoraLoaderModelOnly', ['None', 1]),
    ]);

    const result = applyPromptLibraryLorasToWorkflow(workflow, [
      { name: 'one.safetensors', strength: 0.7 },
      { name: 'two.safetensors', strength: 1 },
    ]);

    expect(result.workflow.nodes[0].widgets_values).toEqual(['one.safetensors', 0.7]);
    expect(result.summary.applied).toEqual(['one.safetensors']);
    expect(result.summary.skipped).toEqual(['two.safetensors']);
    expect(result.summary.reason).toContain('single LoRA loader');
  });

  it('reports when no compatible LoRA node exists', () => {
    const workflow = makeWorkflow([
      makeNode(13, 'KSampler', []),
    ]);

    const result = applyPromptLibraryLorasToWorkflow(workflow, [
      { name: 'one.safetensors', strength: 1 },
    ]);

    expect(result.workflow).toBe(workflow);
    expect(result.summary.changed).toBe(false);
    expect(result.summary.skipped).toEqual(['one.safetensors']);
    expect(result.summary.reason).toContain('No compatible LoRA node');
  });

  it('inserts a MultiLoRAStackModelOnly node into a MODEL link when no LoRA node exists', () => {
    const modelLoader = makeNode(1, 'CheckpointLoaderSimple', []);
    modelLoader.outputs = [{ name: 'MODEL', type: 'MODEL', links: [7], slot_index: 0 }];
    const sampler = makeNode(2, 'KSampler', []);
    sampler.inputs = [{ name: 'model', type: 'MODEL', link: 7 }];
    const workflow = {
      ...makeWorkflow([modelLoader, sampler]),
      last_node_id: 2,
      last_link_id: 7,
      links: [[7, 1, 0, 2, 0, 'MODEL']] as [number, number, number, number, number, string][],
    };

    const result = applyPromptLibraryLorasToWorkflow(
      workflow,
      [{ name: 'inserted.safetensors', strength: 1 }],
      {
        nodeTypes: {
          MultiLoRAStackModelOnly: {
            input: { required: {} },
            output: ['MODEL'],
            name: 'MultiLoRAStackModelOnly',
            display_name: 'MultiLoRAStackModelOnly',
            description: '',
            python_module: '',
            category: '',
          },
        },
      },
    );

    const stack = result.workflow.nodes.find((node) => node.type === 'MultiLoRAStackModelOnly');
    const rewiredOldLink = result.workflow.links.find((link) => link[0] === 7);
    const newLink = result.workflow.links.find((link) => link[0] === 8);

    expect(stack).toBeTruthy();
    expect(stack?.widgets_values).toEqual([
      '[{"on":true,"lora":"inserted.safetensors","strength":1}]',
    ]);
    expect(rewiredOldLink).toEqual([7, 1, 0, stack?.id, 0, 'MODEL']);
    expect(newLink).toEqual([8, stack?.id, 0, 2, 0, 'MODEL']);
    expect(result.workflow.nodes.find((node) => node.id === 2)?.inputs[0].link).toBe(8);
    expect(result.summary.reason).toContain('Inserted MultiLoRAStackModelOnly');
  });
});
