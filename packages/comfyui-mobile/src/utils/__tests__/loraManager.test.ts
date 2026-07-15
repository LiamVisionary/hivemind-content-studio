import { describe, expect, it } from 'vitest';
import type { Workflow, WorkflowNode } from '@/api/types';
import {
  applyLoraValuesToText,
  createDefaultLoraEntry,
  createDefaultLoraStackEntry,
  extractActiveLoraReferencesFromWorkflow,
  extractMultiLoraStackList,
  extractLoraList,
  findLoraListIndex,
  isLoraChainProviderNodeType,
  isLoraCyclerNodeType,
  isLoraDirectProviderNodeType,
  isLoraList,
  isLoraLoaderNodeType,
  isLoraManagerNodeType,
  isMfluxLorasLoaderNodeType,
  isMultiLoraStackNodeType,
  mergeLoras,
  normalizeLoraManagerName,
  normalizeLoraEntry,
  serializeMultiLoraStackList,
} from '../loraManager';

function makeNode(id: number, type: string, widgetsValues: unknown[]): WorkflowNode {
  return {
    id,
    itemKey: `sk-${id}`,
    type,
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

describe('loraManager utilities', () => {
  it('detects supported lora manager node types', () => {
    expect(isLoraLoaderNodeType('Lora Loader (LoraManager)')).toBe(true);
    expect(isLoraManagerNodeType('LoRA Text Loader (LoraManager)')).toBe(true);
    expect(isLoraChainProviderNodeType('Lora Cycler (LoraManager)')).toBe(true);
    expect(isLoraDirectProviderNodeType('WanVideo Lora Select (LoraManager)')).toBe(true);
    expect(isLoraCyclerNodeType('Custom Lora Cycler (LoraManager)')).toBe(true);
    expect(isLoraManagerNodeType('Lora Stacker (LoraManager)')).toBe(true);
    expect(isMultiLoraStackNodeType('MultiLoRAStackModelOnly')).toBe(true);
    expect(isMfluxLorasLoaderNodeType('MfluxLorasLoader')).toBe(true);
    expect(isLoraManagerNodeType('CheckpointLoaderSimple')).toBe(false);
  });

  it('extracts lora lists directly and through __value__ wrappers', () => {
    const list = [{ name: 'foo.safetensors', strength: 0.8 }];
    expect(isLoraList(list)).toBe(true);
    expect(extractLoraList(list)).toEqual(list);
    expect(extractLoraList({ __value__: list })).toEqual(list);
    expect(extractLoraList({ __value__: [{ name: 1 }] })).toBeNull();
  });

  it('finds lora list index from populated arrays and text-index fallback', () => {
    const withList = makeNode(1, 'Lora Loader (LoraManager)', [
      'prompt',
      [{ name: 'bar.safetensors', strength: 1 }],
      'other',
    ]);
    expect(findLoraListIndex(withList, 0)).toBe(1);

    const emptyListAfterText = makeNode(2, 'Lora Loader (LoraManager)', ['prompt', []]);
    expect(findLoraListIndex(emptyListAfterText, 0)).toBe(1);

    const noWidgets = makeNode(3, 'Lora Loader (LoraManager)', []);
    expect(findLoraListIndex(noWidgets, 0)).toBeNull();
  });

  it('normalizes lora entries and creates default entry from choices', () => {
    expect(normalizeLoraManagerName('styles\\foo.safetensors')).toBe('foo');

    expect(normalizeLoraEntry({ name: 'foo', strength: '0.5' })).toMatchObject({
      name: 'foo',
      strength: 0.5,
      clipStrength: 0.5,
      active: true,
      expanded: false,
    });

    expect(normalizeLoraEntry({ name: 'foo', strength: 1, clipStrength: 0.6 })).toMatchObject({
      expanded: true,
    });

    expect(createDefaultLoraEntry(['a.safetensors'])).toMatchObject({
      name: 'a',
      active: true,
      strength: 1,
      clipStrength: 1,
    });
  });

  it('merges lora syntax text with existing list entries', () => {
    const merged = mergeLoras('<lora:folder/a.safetensors:0.8> <lora:b:1.2:0.9>', [
      { name: 'a.safetensors', strength: 0.7, active: false },
    ]);

    expect(merged).toEqual([
      { name: 'a', strength: 0.7, active: false, clipStrength: 0.8, expanded: false },
      { name: 'b', strength: 1.2, clipStrength: 0.9, active: true },
    ]);
  });

  it('applies lora values back into text and appends missing entries', () => {
    const result = applyLoraValuesToText('portrait, <lora:a:1.00>, <lora:b:0.40:0.40>', [
      { name: 'a', strength: 0.55, clipStrength: 0.45, expanded: true },
      { name: 'c', strength: 1.1, active: true },
    ]);

    expect(result).toContain('<lora:a:0.55:0.45>');
    expect(result).toContain('<lora:c:1.10>');
    expect(result).not.toContain('<lora:b:');
  });

  it('parses and serializes Multi LoRA Stack values without stripping extensions', () => {
    const raw = '[{"on":true,"lora":"anima-turbo-lora-v0.2.safetensors","strength":0.85}]';
    const parsed = extractMultiLoraStackList(raw);

    expect(parsed).toEqual([
      {
        name: 'anima-turbo-lora-v0.2.safetensors',
        strength: 0.85,
        clipStrength: 0.85,
        active: true,
        expanded: false,
      },
    ]);
    expect(createDefaultLoraStackEntry(['foo.safetensors'])).toMatchObject({
      name: 'foo.safetensors',
      active: true,
    });
    expect(serializeMultiLoraStackList(parsed ?? [])).toBe(raw);
  });

  it('treats string false-like MultiLoRAStack flags as disabled', () => {
    const raw = JSON.stringify([
      { on: 'false', lora: 'disabled-string.safetensors', strength: 1 },
      { on: '0', lora: 'disabled-zero.safetensors', strength: 1 },
      { on: 'off', lora: 'disabled-off.safetensors', strength: 1 },
      { on: 'true', lora: 'enabled-string.safetensors', strength: 0.5 },
    ]);
    const parsed = extractMultiLoraStackList(raw);

    expect(parsed?.map((entry) => entry.active)).toEqual([false, false, false, true]);
    expect(serializeMultiLoraStackList(parsed ?? [])).toBe(JSON.stringify([
      { on: false, lora: 'disabled-string.safetensors', strength: 1 },
      { on: false, lora: 'disabled-zero.safetensors', strength: 1 },
      { on: false, lora: 'disabled-off.safetensors', strength: 1 },
      { on: true, lora: 'enabled-string.safetensors', strength: 0.5 },
    ]));
  });

  it('extracts active loras from MultiLoRAStack, Power Lora, and standard loader nodes', () => {
    const workflow = makeWorkflow([
      makeNode(11, 'MultiLoRAStackModelOnly', [
        JSON.stringify([
          { on: true, lora: 'anima-turbo-lora-v0.2.safetensors', strength: 0.85 },
          { on: false, lora: 'disabled.safetensors', strength: 1 },
          { on: 'false', lora: 'disabled-string.safetensors', strength: 1 },
        ]),
      ]),
      makeNode(22, 'Power Lora Loader (rgthree)', [
        { on: true, lora: 'characters/himawari_v25-000007.safetensors', strength: 0.7 },
        { on: true, lora: 'zero.safetensors', strength: 0 },
      ]),
      makeNode(33, 'LoraLoaderModelOnly', ['style.safetensors', 0.5]),
      makeNode(44, 'MfluxLorasLoader', [
        'characters/naruto.safetensors',
        0.6,
        'None',
        1,
        'styles/anime.safetensors',
        0.35,
      ]),
    ]);

    expect(extractActiveLoraReferencesFromWorkflow(workflow)).toEqual([
      expect.objectContaining({
        name: 'anima-turbo-lora-v0.2.safetensors',
        strength: 0.85,
        node_id: 11,
      }),
      expect.objectContaining({
        name: 'characters/himawari_v25-000007.safetensors',
        strength: 0.7,
        node_id: 22,
      }),
      expect.objectContaining({
        name: 'style.safetensors',
        node_id: 33,
      }),
      expect.objectContaining({
        name: 'characters/naruto.safetensors',
        strength: 0.6,
        node_id: 44,
      }),
      expect.objectContaining({
        name: 'styles/anime.safetensors',
        strength: 0.35,
        node_id: 44,
      }),
    ]);
  });
});
