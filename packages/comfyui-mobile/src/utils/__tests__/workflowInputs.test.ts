import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  applyBypassedRegionalPromptFallbacks,
  applyPromptAssistantForgeCoupleAutomation,
  applyPromptAssistantForgeCoupleQueueAutomation,
  buildWorkflowPromptInputs,
  FORGE_COUPLE_HORIZONTAL_ADVANCED_MAPPING,
  FORGE_COUPLE_VERTICAL_ADVANCED_MAPPING,
  getComboComparableValue,
  getDynamicComboOptionKeys,
  getWidgetValue,
  getWorkflowWidgetIndexMap,
  inferPromptAssistantForgeCoupleDirection,
  isWidgetInputType,
  normalizeDynamicComboInputValue,
  normalizeWidgetValue,
  normalizeComboValue,
  normalizePromptAssistantHelperMode,
  normalizePromptAssistantProfileJsonOverride,
  optionsAreFileLike,
  isValueCompatible,
  resolveComboOption,
  resolveSource,
} from '../workflowInputs';
import type { NodeTypes, Workflow, WorkflowNode } from '@/api/types';

// ComfyUI seed inputs declare max = 2^64; computed (not a literal) because a
// 0xffffffffffffffff literal silently rounds to 2^64 in a float anyway.
const SEED_MAX = 2 ** 64;

afterEach(() => {
  vi.useRealTimers();
});

function makeNode(id: number, type: string, overrides?: Partial<WorkflowNode>): WorkflowNode {
  return {
    id,
    type,
    pos: [0, 0],
    size: [200, 100],
    flags: {},
    order: 0,
    mode: 0,
    inputs: [],
    outputs: [],
    properties: {},
    widgets_values: [],
    ...overrides,
  };
}

describe('getWidgetValue', () => {
  it('returns value by index from array widgets_values', () => {
    const node = makeNode(1, 'KSampler', { widgets_values: [42, 'euler', 20] });
    expect(getWidgetValue(node, 'seed', 0)).toBe(42);
    expect(getWidgetValue(node, 'sampler_name', 1)).toBe('euler');
    expect(getWidgetValue(node, 'steps', 2)).toBe(20);
  });

  it('returns undefined for out-of-bounds index', () => {
    const node = makeNode(1, 'KSampler', { widgets_values: [42] });
    expect(getWidgetValue(node, 'x', 5)).toBeUndefined();
    expect(getWidgetValue(node, 'x', -1)).toBeUndefined();
  });

  it('returns undefined when index is undefined', () => {
    const node = makeNode(1, 'KSampler', { widgets_values: [42] });
    expect(getWidgetValue(node, 'x', undefined)).toBeUndefined();
  });

  it('returns value by name from record widgets_values', () => {
    const node = makeNode(1, 'Custom', {
      widgets_values: { seed: 42, sampler: 'euler' } as unknown as Record<string, unknown>,
    });
    expect(getWidgetValue(node, 'seed', 0)).toBe(42);
    expect(getWidgetValue(node, 'sampler', 1)).toBe('euler');
  });

  it('handles VHS_VideoCombine save_image/save_output alias', () => {
    const node = makeNode(1, 'VHS_VideoCombine', {
      widgets_values: { save_output: true } as unknown as Record<string, unknown>,
    });
    expect(getWidgetValue(node, 'save_image', 0)).toBe(true);
  });
});

describe('getWorkflowWidgetIndexMap', () => {
  it('returns map from widget_idx_map', () => {
    const wf: Workflow = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [],
      links: [],
      groups: [],
      config: {},
      version: 1,
      widget_idx_map: { '1': { seed: 0, steps: 1 } },
    };
    expect(getWorkflowWidgetIndexMap(wf, 1)).toEqual({ seed: 0, steps: 1 });
  });

  it('falls back to extra.widget_idx_map', () => {
    const wf: Workflow = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [],
      links: [],
      groups: [],
      config: {},
      version: 1,
      extra: { widget_idx_map: { '1': { cfg: 2 } } },
    };
    expect(getWorkflowWidgetIndexMap(wf, 1)).toEqual({ cfg: 2 });
  });

  it('returns null when no map exists', () => {
    const wf: Workflow = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };
    expect(getWorkflowWidgetIndexMap(wf, 1)).toBeNull();
  });
});

describe('isWidgetInputType', () => {
  it('returns true for standard widget types', () => {
    expect(isWidgetInputType('INT')).toBe(true);
    expect(isWidgetInputType('FLOAT')).toBe(true);
    expect(isWidgetInputType('BOOLEAN')).toBe(true);
    expect(isWidgetInputType('STRING')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isWidgetInputType('int')).toBe(true);
    expect(isWidgetInputType('Float')).toBe(true);
  });

  it('returns true for combo arrays', () => {
    expect(isWidgetInputType(['euler', 'ddim', 'dpm'])).toBe(true);
  });

  it('returns false for non-widget types', () => {
    expect(isWidgetInputType('MODEL')).toBe(false);
    expect(isWidgetInputType('LATENT')).toBe(false);
    expect(isWidgetInputType('CONDITIONING')).toBe(false);
  });
});

describe('normalizeWidgetValue', () => {
  it('converts string to int for INT type', () => {
    expect(normalizeWidgetValue('42', 'INT')).toBe(42);
    expect(normalizeWidgetValue('3.7', 'INT')).toBe(3); // truncates
  });

  it('converts string to float for FLOAT type', () => {
    expect(normalizeWidgetValue('3.14', 'FLOAT')).toBe(3.14);
  });

  it('converts string booleans for BOOLEAN type', () => {
    expect(normalizeWidgetValue('true', 'BOOLEAN')).toBe(true);
    expect(normalizeWidgetValue('false', 'BOOLEAN')).toBe(false);
    expect(normalizeWidgetValue('TRUE', 'BOOLEAN')).toBe(true);
  });

  it('passes through non-string values unchanged', () => {
    expect(normalizeWidgetValue(42, 'INT')).toBe(42);
    expect(normalizeWidgetValue(true, 'BOOLEAN')).toBe(true);
  });

  it('does not convert empty or non-numeric strings for INT/FLOAT', () => {
    expect(normalizeWidgetValue('', 'INT')).toBe('');
    expect(normalizeWidgetValue('abc', 'FLOAT')).toBe('abc');
  });

  it('resolves combo index to value when comboIndexToValue is true', () => {
    const options = ['euler', 'ddim', 'dpm'];
    expect(normalizeWidgetValue(1, options, { comboIndexToValue: true })).toBe('ddim');
  });

  it('returns original value if combo index is out of range', () => {
    const options = ['euler', 'ddim'];
    expect(normalizeWidgetValue(99, options, { comboIndexToValue: true })).toBe(99);
  });

  it('passes through combo value without comboIndexToValue', () => {
    expect(normalizeWidgetValue('euler', ['euler', 'ddim'])).toBe('euler');
  });
});

describe('dynamic combo helpers', () => {
  it('extracts keys from COMFY_DYNAMICCOMBO_V3 object options', () => {
    expect(getDynamicComboOptionKeys({
      options: [
        { key: 'per_frame', inputs: { required: {} } },
        { key: 'uniform', inputs: { required: {} } },
      ],
    })).toEqual(['per_frame', 'uniform']);
  });

  it('compares and serializes dynamic combo widget values by selected key', () => {
    const value = { source_stats: 'per_frame' };
    expect(getComboComparableValue(value, 'source_stats')).toBe('per_frame');
    expect(resolveComboOption(value, ['per_frame', 'uniform'], 'source_stats')).toBe('per_frame');
    expect(normalizeDynamicComboInputValue('uniform', 'source_stats')).toEqual({
      source_stats: 'uniform',
    });
  });

  it('preserves extra dynamic combo fields when normalizing object values', () => {
    expect(normalizeDynamicComboInputValue(
      { source_stats: 'target_frame', target_index: 3 },
      'source_stats',
    )).toEqual({ source_stats: 'target_frame', target_index: 3 });
  });
});

describe('normalizeComboValue', () => {
  it('returns direct match from options', () => {
    expect(normalizeComboValue('euler', ['euler', 'ddim'])).toBe('euler');
  });

  it('matches by basename (strips path)', () => {
    expect(normalizeComboValue('models/v1-5.safetensors', ['v1-5.safetensors', 'xl.safetensors'])).toBe('v1-5.safetensors');
  });

  it('keeps an unmatched FILE-PICKER value as-is (incomplete option list)', () => {
    // A picked file that isn't in the (stale/incomplete) option list must be
    // sent as-is so the server errors clearly, not swapped for another file.
    expect(normalizeComboValue('my_new_input.png', ['other_a.png', 'other_b.png'])).toBe('my_new_input.png');
    expect(
      normalizeComboValue('subdir/new.safetensors', ['a.safetensors', 'b.safetensors']),
    ).toBe('subdir/new.safetensors');
  });

  it('falls back to the first option for a CLOSED ENUM when nothing matches', () => {
    // Closed enums list every valid value, so an unmatched value is stale.
    // ComfyUI silently drops a node with an out-of-range combo value (and its
    // whole downstream branch), producing "no output". Falling back to the
    // default keeps the prompt executable. Regression: a dynamic
    // ImpactWildcardProcessor "Select to add Wildcard" placeholder captured in
    // widgets_values ("Select Wildcard 🟢 Full Cache") used to be sent verbatim
    // and excluded the entire prompt-processing branch from the run.
    expect(normalizeComboValue('nonexistent', ['euler', 'ddim'])).toBe('euler');
    expect(
      normalizeComboValue(
        'Select Wildcard 🟢 Full Cache',
        ['Select the Wildcard to add to the text'],
      ),
    ).toBe('Select the Wildcard to add to the text');
  });

  it('treats combos with path-like options as file pickers (keeps value)', () => {
    // Format combos such as VHS "video/h264-mp4" contain a path separator and
    // must not be coerced to a different option.
    expect(
      normalizeComboValue('video/unknown-codec', ['video/h264-mp4', 'image/gif']),
    ).toBe('video/unknown-codec');
  });

  it('keeps a file-like value even when the options list looks enum-like', () => {
    // A picker whose current options happen to lack a recognizable extension
    // must not clobber a genuine file selection; the file-like value is kept.
    expect(
      normalizeComboValue('my_model.safetensors', ['baseline', 'turbo']),
    ).toBe('my_model.safetensors');
    expect(
      normalizeComboValue('subdir/clip', ['baseline', 'turbo']),
    ).toBe('subdir/clip');
  });

  it('returns value as-is for empty options', () => {
    expect(normalizeComboValue('anything', [])).toBe('anything');
  });
});

describe('optionsAreFileLike', () => {
  it('detects file-picker option lists (extensions or path separators)', () => {
    expect(optionsAreFileLike(['a.safetensors', 'b.safetensors'])).toBe(true);
    expect(optionsAreFileLike(['subdir/model.ckpt'])).toBe(true);
    expect(optionsAreFileLike(['photo.png', 'clip.mp4'])).toBe(true);
  });

  it('treats human-readable enums as closed (not file-like)', () => {
    expect(optionsAreFileLike(['euler', 'dpmpp_2m'])).toBe(false);
    expect(optionsAreFileLike(['Select the Wildcard to add to the text'])).toBe(false);
    expect(optionsAreFileLike(['enable', 'disable'])).toBe(false);
  });
});

describe('isValueCompatible', () => {
  it('checks combo membership', () => {
    expect(isValueCompatible('euler', ['euler', 'ddim'])).toBe(true);
    expect(isValueCompatible('unknown', ['euler', 'ddim'])).toBe(false);
  });

  it('checks numeric compatibility for INT and FLOAT', () => {
    expect(isValueCompatible(42, 'INT')).toBe(true);
    expect(isValueCompatible('42', 'INT')).toBe(true);
    expect(isValueCompatible('abc', 'INT')).toBe(false);
    expect(isValueCompatible('', 'FLOAT')).toBe(false);
    expect(isValueCompatible(3.14, 'FLOAT')).toBe(true);
  });

  it('checks boolean compatibility', () => {
    expect(isValueCompatible(true, 'BOOLEAN')).toBe(true);
    expect(isValueCompatible('true', 'BOOLEAN')).toBe(true);
    expect(isValueCompatible('false', 'BOOLEAN')).toBe(true);
    expect(isValueCompatible('yes', 'BOOLEAN')).toBe(false);
    expect(isValueCompatible(42, 'BOOLEAN')).toBe(false);
  });

  it('checks string compatibility', () => {
    expect(isValueCompatible('hello', 'STRING')).toBe(true);
    expect(isValueCompatible(42, 'STRING')).toBe(false);
  });

  it('returns true for unknown types', () => {
    expect(isValueCompatible('anything', 'CUSTOM_TYPE')).toBe(true);
  });
});

describe('resolveSource', () => {
  it('resolves a direct link to source node', () => {
    const wf: Workflow = {
      last_node_id: 2,
      last_link_id: 1,
      nodes: [
        makeNode(1, 'Loader'),
        makeNode(2, 'KSampler', { inputs: [{ name: 'model', type: 'MODEL', link: 1 }] }),
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
      groups: [],
      config: {},
      version: 1,
    };

    const result = resolveSource(wf, 1);
    expect(result).toEqual({ nodeId: 1, slotIndex: 0 });
  });

  it('follows Reroute nodes recursively', () => {
    const wf: Workflow = {
      last_node_id: 3,
      last_link_id: 2,
      nodes: [
        makeNode(1, 'Loader', {
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }],
        }),
        makeNode(2, 'Reroute', {
          inputs: [{ name: 'in', type: 'MODEL', link: 1 }],
          outputs: [{ name: 'out', type: 'MODEL', links: [2] }],
        }),
        makeNode(3, 'KSampler', {
          inputs: [{ name: 'model', type: 'MODEL', link: 2 }],
        }),
      ],
      links: [
        [1, 1, 0, 2, 0, 'MODEL'],
        [2, 2, 0, 3, 0, 'MODEL'],
      ],
      groups: [],
      config: {},
      version: 1,
    };

    // Resolve link 2 (Reroute -> KSampler), should trace back to Loader
    const result = resolveSource(wf, 2);
    expect(result).toEqual({ nodeId: 1, slotIndex: 0 });
  });

  it('follows muted nodes (mode 4) like reroutes', () => {
    const wf: Workflow = {
      last_node_id: 3,
      last_link_id: 2,
      nodes: [
        makeNode(1, 'Loader', {
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }],
        }),
        makeNode(2, 'SomeNode', {
          mode: 4, // muted
          inputs: [{ name: 'in', type: 'MODEL', link: 1 }],
          outputs: [{ name: 'out', type: 'MODEL', links: [2] }],
        }),
        makeNode(3, 'KSampler', {
          inputs: [{ name: 'model', type: 'MODEL', link: 2 }],
        }),
      ],
      links: [
        [1, 1, 0, 2, 0, 'MODEL'],
        [2, 2, 0, 3, 0, 'MODEL'],
      ],
      groups: [],
      config: {},
      version: 1,
    };

    const result = resolveSource(wf, 2);
    expect(result).toEqual({ nodeId: 1, slotIndex: 0 });
  });

  it('returns null for non-existent link', () => {
    const wf: Workflow = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [makeNode(1, 'Loader')],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };
    expect(resolveSource(wf, 999)).toBeNull();
  });

  it('returns null for reroute with no input connection', () => {
    const wf: Workflow = {
      last_node_id: 2,
      last_link_id: 1,
      nodes: [
        makeNode(1, 'Reroute', {
          inputs: [{ name: 'in', type: 'MODEL', link: null }],
          outputs: [{ name: 'out', type: 'MODEL', links: [1] }],
        }),
        makeNode(2, 'KSampler', {
          inputs: [{ name: 'model', type: 'MODEL', link: 1 }],
        }),
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
      groups: [],
      config: {},
      version: 1,
    };

    const result = resolveSource(wf, 1);
    expect(result).toBeNull();
  });

  it('follows KJNodes GetNode/SetNode virtual links', () => {
    const wf: Workflow = {
      last_node_id: 4,
      last_link_id: 2,
      nodes: [
        makeNode(1, 'Loader', {
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }],
        }),
        makeNode(2, 'SetNode', {
          inputs: [{ name: 'MODEL', type: 'MODEL', link: 1 }],
          widgets_values: ['shared_model'],
        }),
        makeNode(3, 'GetNode', {
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [2] }],
          widgets_values: ['shared_model'],
        }),
        makeNode(4, 'KSampler', {
          inputs: [{ name: 'model', type: 'MODEL', link: 2 }],
        }),
      ],
      links: [
        [1, 1, 0, 2, 0, 'MODEL'],
        [2, 3, 0, 4, 0, 'MODEL'],
      ],
      groups: [],
      config: {},
      version: 1,
    };

    expect(resolveSource(wf, 2)).toEqual({ nodeId: 1, slotIndex: 0 });
  });

  it('scopes KJNodes GetNode/SetNode resolution to the expanded subgraph instance', () => {
    const wf: Workflow = {
      last_node_id: 104,
      last_link_id: 3,
      nodes: [
        makeNode(1, 'FirstLoader', {
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }],
        }),
        makeNode(2, 'SetNode', {
          inputs: [{ name: 'MODEL', type: 'MODEL', link: 1 }],
          widgets_values: ['shared_model'],
        }),
        makeNode(101, 'SecondLoader', {
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [2] }],
        }),
        makeNode(102, 'SetNode', {
          inputs: [{ name: 'MODEL', type: 'MODEL', link: 2 }],
          widgets_values: ['shared_model'],
        }),
        makeNode(103, 'GetNode', {
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [3] }],
          widgets_values: ['shared_model'],
        }),
        makeNode(104, 'KSampler', {
          inputs: [{ name: 'model', type: 'MODEL', link: 3 }],
        }),
      ],
      links: [
        [1, 1, 0, 2, 0, 'MODEL'],
        [2, 101, 0, 102, 0, 'MODEL'],
        [3, 103, 0, 104, 0, 'MODEL'],
      ],
      groups: [],
      config: {},
      version: 1,
    };
    const promptKeyMap = new Map<number, string>([
      [2, '10:2'],
      [102, '20:2'],
      [103, '20:3'],
    ]);

    expect(resolveSource(wf, 3, new Set(), promptKeyMap)).toEqual({
      nodeId: 101,
      slotIndex: 0,
    });
  });

  it('does not resolve scoped KJNodes GetNode to a SetNode from another scope', () => {
    const wf: Workflow = {
      last_node_id: 4,
      last_link_id: 2,
      nodes: [
        makeNode(1, 'Loader', {
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }],
        }),
        makeNode(2, 'SetNode', {
          inputs: [{ name: 'MODEL', type: 'MODEL', link: 1 }],
          widgets_values: ['shared_model'],
        }),
        makeNode(3, 'GetNode', {
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [2] }],
          widgets_values: ['shared_model'],
        }),
        makeNode(4, 'KSampler', {
          inputs: [{ name: 'model', type: 'MODEL', link: 2 }],
        }),
      ],
      links: [
        [1, 1, 0, 2, 0, 'MODEL'],
        [2, 3, 0, 4, 0, 'MODEL'],
      ],
      groups: [],
      config: {},
      version: 1,
    };
    const promptKeyMap = new Map<number, string>([
      [2, '10:2'],
      [3, '20:3'],
    ]);

    expect(resolveSource(wf, 2, new Set(), promptKeyMap)).toBeNull();
  });

  it('serializes scoped KJNodes sources with prompt keys through buildWorkflowPromptInputs', () => {
    const target = makeNode(104, 'KSampler', {
      inputs: [{ name: 'model', type: 'MODEL', link: 3 }],
    });
    const wf: Workflow = {
      last_node_id: 104,
      last_link_id: 3,
      nodes: [
        makeNode(1, 'FirstLoader', {
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }],
        }),
        makeNode(2, 'SetNode', {
          inputs: [{ name: 'MODEL', type: 'MODEL', link: 1 }],
          widgets_values: ['shared_model'],
        }),
        makeNode(101, 'SecondLoader', {
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [2] }],
        }),
        makeNode(102, 'SetNode', {
          inputs: [{ name: 'MODEL', type: 'MODEL', link: 2 }],
          widgets_values: ['shared_model'],
        }),
        makeNode(103, 'GetNode', {
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [3] }],
          widgets_values: ['shared_model'],
        }),
        target,
      ],
      links: [
        [1, 1, 0, 2, 0, 'MODEL'],
        [2, 101, 0, 102, 0, 'MODEL'],
        [3, 103, 0, 104, 0, 'MODEL'],
      ],
      groups: [],
      config: {},
      version: 1,
    };
    const promptKeyMap = new Map<number, string>([
      [1, '10:1'],
      [2, '10:2'],
      [101, '20:1'],
      [102, '20:2'],
      [103, '20:3'],
      [104, '20:4'],
    ]);
    const nodeTypes: NodeTypes = {
      KSampler: {
        input: {
          required: {
            model: ['MODEL', {}],
          },
        },
        input_order: {
          required: ['model'],
          optional: [],
        },
        output: [],
        output_name: [],
        name: 'KSampler',
        display_name: 'KSampler',
        description: '',
        python_module: '',
        category: '',
      },
    };

    const inputs = buildWorkflowPromptInputs(
      wf,
      nodeTypes,
      target,
      'KSampler',
      new Set([1, 101, 104]),
      null,
      undefined,
      promptKeyMap,
    );

    expect(inputs.model).toEqual(['20:1', 0]);
  });

  it('returns null for GetNode without a matching SetNode', () => {
    const wf: Workflow = {
      last_node_id: 2,
      last_link_id: 1,
      nodes: [
        makeNode(1, 'GetNode', {
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }],
          widgets_values: ['missing_model'],
        }),
        makeNode(2, 'KSampler', {
          inputs: [{ name: 'model', type: 'MODEL', link: 1 }],
        }),
      ],
      links: [[1, 1, 0, 2, 0, 'MODEL']],
      groups: [],
      config: {},
      version: 1,
    };

    expect(resolveSource(wf, 1)).toBeNull();
  });
});

describe('applyBypassedRegionalPromptFallbacks', () => {
  it('synthesizes missing sampler conditioning when a Forge Couple regional prompt is bypassed', () => {
    const nodeTypes = {
      UNETLoader: {
        input: { required: {} },
        output: ['MODEL'],
        name: 'UNETLoader',
        display_name: 'UNETLoader',
        description: '',
        python_module: '',
        category: '',
      },
      LoadQwen35AnimaCLIP: {
        input: { required: {} },
        output: ['CLIP'],
        name: 'LoadQwen35AnimaCLIP',
        display_name: 'LoadQwen35AnimaCLIP',
        description: '',
        python_module: '',
        category: '',
      },
      ForgeCoupleRegionalPrompt: {
        input: {
          required: {
            model: ['MODEL', {}],
            clip: ['CLIP', {}],
            positive_text: ['STRING', {}],
          },
        },
        input_order: { required: ['model', 'clip', 'positive_text'] },
        output: ['MODEL', 'CONDITIONING', 'STRING'],
        name: 'ForgeCoupleRegionalPrompt',
        display_name: 'Forge Couple Regional Prompt',
        description: '',
        python_module: '',
        category: '',
      },
      CLIPTextEncode: {
        input: {
          required: {
            text: ['STRING', {}],
            clip: ['CLIP', {}],
          },
        },
        input_order: { required: ['text', 'clip'] },
        output: ['CONDITIONING'],
        name: 'CLIPTextEncode',
        display_name: 'CLIP Text Encode',
        description: '',
        python_module: '',
        category: '',
      },
      KSampler: {
        input: {
          required: {
            model: ['MODEL', {}],
            positive: ['CONDITIONING', {}],
            negative: ['CONDITIONING', {}],
          },
        },
        output: ['LATENT'],
        name: 'KSampler',
        display_name: 'KSampler',
        description: '',
        python_module: '',
        category: '',
      },
    } as NodeTypes;
    const workflow: Workflow = {
      last_node_id: 7,
      last_link_id: 5,
      nodes: [
        makeNode(1, 'UNETLoader', {
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }],
        }),
        makeNode(2, 'LoadQwen35AnimaCLIP', {
          outputs: [{ name: 'CLIP', type: 'CLIP', links: [2, 5] }],
        }),
        makeNode(4, 'ForgeCoupleRegionalPrompt', {
          mode: 4,
          inputs: [
            { name: 'model', type: 'MODEL', link: 1 },
            { name: 'clip', type: 'CLIP', link: 2 },
          ],
          outputs: [
            { name: 'model', type: 'MODEL', links: [3] },
            { name: 'positive', type: 'CONDITIONING', links: [4] },
          ],
          widgets_values: ['solo portrait'],
        }),
        makeNode(5, 'CLIPTextEncode', {
          inputs: [
            { name: 'clip', type: 'CLIP', link: 5 },
          ],
          outputs: [
            { name: 'CONDITIONING', type: 'CONDITIONING', links: [6] },
          ],
          widgets_values: ['low quality'],
        }),
        makeNode(7, 'KSampler', {
          inputs: [
            { name: 'model', type: 'MODEL', link: 3 },
            { name: 'positive', type: 'CONDITIONING', link: 4 },
            { name: 'negative', type: 'CONDITIONING', link: 6 },
          ],
        }),
      ],
      links: [
        [1, 1, 0, 4, 0, 'MODEL'],
        [2, 2, 0, 4, 1, 'CLIP'],
        [3, 4, 0, 7, 0, 'MODEL'],
        [4, 4, 1, 7, 1, 'CONDITIONING'],
        [5, 2, 0, 5, 0, 'CLIP'],
        [6, 5, 0, 7, 2, 'CONDITIONING'],
      ],
      groups: [],
      config: {},
      version: 1,
    };
    const prompt = {
      '1': { class_type: 'UNETLoader', inputs: {} },
      '2': { class_type: 'LoadQwen35AnimaCLIP', inputs: {} },
      '7': { class_type: 'KSampler', inputs: { model: ['1', 0] } },
    } as Record<string, unknown>;

    applyBypassedRegionalPromptFallbacks(
      workflow,
      nodeTypes,
      prompt,
      new Set([1, 2, 7]),
    );

    expect(prompt.__mobile_fallback_positive_4).toEqual({
      class_type: 'CLIPTextEncode',
      inputs: {
        clip: ['2', 0],
        text: 'solo portrait',
      },
    });
    expect((prompt['7'] as { inputs: Record<string, unknown> }).inputs.positive)
      .toEqual(['__mobile_fallback_positive_4', 0]);
    expect(prompt['5']).toEqual({
      class_type: 'CLIPTextEncode',
      inputs: {
        clip: ['2', 0],
        text: 'low quality',
      },
    });
    expect((prompt['7'] as { inputs: Record<string, unknown> }).inputs.negative)
      .toEqual(['5', 0]);
  });

  it('collapses structured bbox prompt JSON when synthesizing a bypass fallback', () => {
    const nodeTypes = {
      UNETLoader: {
        input: { required: {} },
        output: ['MODEL'],
        name: 'UNETLoader',
        display_name: 'UNETLoader',
        description: '',
        python_module: '',
        category: '',
      },
      LoadQwen35AnimaCLIP: {
        input: { required: {} },
        output: ['CLIP'],
        name: 'LoadQwen35AnimaCLIP',
        display_name: 'LoadQwen35AnimaCLIP',
        description: '',
        python_module: '',
        category: '',
      },
      ForgeCoupleRegionalPrompt: {
        input: {
          required: {
            model: ['MODEL', {}],
            clip: ['CLIP', {}],
            positive_text: ['STRING', {}],
          },
        },
        input_order: { required: ['model', 'clip', 'positive_text'] },
        output: ['MODEL', 'CONDITIONING', 'STRING'],
        name: 'ForgeCoupleRegionalPrompt',
        display_name: 'Forge Couple Regional Prompt',
        description: '',
        python_module: '',
        category: '',
      },
      CLIPTextEncode: {
        input: {
          required: {
            text: ['STRING', {}],
            clip: ['CLIP', {}],
          },
        },
        input_order: { required: ['text', 'clip'] },
        output: ['CONDITIONING'],
        name: 'CLIPTextEncode',
        display_name: 'CLIP Text Encode',
        description: '',
        python_module: '',
        category: '',
      },
      KSampler: {
        input: {
          required: {
            model: ['MODEL', {}],
            positive: ['CONDITIONING', {}],
          },
        },
        output: ['LATENT'],
        name: 'KSampler',
        display_name: 'KSampler',
        description: '',
        python_module: '',
        category: '',
      },
    } as NodeTypes;
    const structuredPrompt = JSON.stringify({
      high_level_description: 'two adult women in a neon cafe',
      compositional_deconstruction: {
        background: 'indoors',
        elements: [
          { type: 'obj', bbox: [80, 120, 480, 920], desc: 'adult woman with silver hair' },
          { type: 'obj', bbox: [520, 130, 930, 920], desc: 'adult woman with red hair' },
        ],
      },
    });
    const workflow: Workflow = {
      last_node_id: 7,
      last_link_id: 4,
      nodes: [
        makeNode(1, 'UNETLoader', {
          outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }],
        }),
        makeNode(2, 'LoadQwen35AnimaCLIP', {
          outputs: [{ name: 'CLIP', type: 'CLIP', links: [2] }],
        }),
        makeNode(4, 'ForgeCoupleRegionalPrompt', {
          mode: 4,
          inputs: [
            { name: 'model', type: 'MODEL', link: 1 },
            { name: 'clip', type: 'CLIP', link: 2 },
          ],
          outputs: [
            { name: 'model', type: 'MODEL', links: [3] },
            { name: 'positive', type: 'CONDITIONING', links: [4] },
          ],
          widgets_values: [structuredPrompt],
        }),
        makeNode(7, 'KSampler', {
          inputs: [
            { name: 'model', type: 'MODEL', link: 3 },
            { name: 'positive', type: 'CONDITIONING', link: 4 },
          ],
        }),
      ],
      links: [
        [1, 1, 0, 4, 0, 'MODEL'],
        [2, 2, 0, 4, 1, 'CLIP'],
        [3, 4, 0, 7, 0, 'MODEL'],
        [4, 4, 1, 7, 1, 'CONDITIONING'],
      ],
      groups: [],
      config: {},
      version: 1,
    };
    const prompt = {
      '1': { class_type: 'UNETLoader', inputs: {} },
      '2': { class_type: 'LoadQwen35AnimaCLIP', inputs: {} },
      '7': { class_type: 'KSampler', inputs: { model: ['1', 0] } },
    } as Record<string, unknown>;

    applyBypassedRegionalPromptFallbacks(
      workflow,
      nodeTypes,
      prompt,
      new Set([1, 2, 7]),
    );

    expect(prompt.__mobile_fallback_positive_4).toEqual({
      class_type: 'CLIPTextEncode',
      inputs: {
        clip: ['2', 0],
        text: 'two adult women in a neon cafe, indoors, adult woman with silver hair, adult woman with red hair',
      },
    });
  });
});

describe('seed override application in buildWorkflowPromptInputs', () => {
  it('does not count Krea2PromptCompact forceInput prompt_json as a widget slot', () => {
    const source = makeNode(1, 'PrimitiveNode', {
      outputs: [{ name: 'STRING', type: 'STRING', links: [1] }],
      widgets_values: ['{}'],
    });
    const node = makeNode(14, 'Krea2PromptCompact', {
      inputs: [{ name: 'prompt_json', type: 'STRING', link: 1 }],
      widgets_values: [2600, 'json_structured'],
    });
    const wf: Workflow = {
      last_node_id: 14,
      last_link_id: 1,
      nodes: [source, node],
      links: [[1, 1, 0, 14, 0, 'STRING']],
      groups: [],
      config: {},
      version: 1,
    };
    const nodeTypes: NodeTypes = {
      Krea2PromptCompact: {
        input: {
          required: {
            prompt_json: ['STRING', { forceInput: true }],
            max_chars: ['INT', { default: 2600, min: 300, max: 8000 }],
            mode: [['json_structured', 'json_minify', 'prose_compact'], { default: 'json_structured' }],
          },
        },
        input_order: { required: ['prompt_json', 'max_chars', 'mode'], optional: [] },
        output: [],
        output_name: [],
        name: 'Krea2PromptCompact',
        display_name: 'Krea2 JSON Optimize for Conditioning',
        description: '',
        python_module: '',
        category: '',
      },
    };

    const inputs = buildWorkflowPromptInputs(
      wf, nodeTypes, node, 'Krea2PromptCompact', new Set([1, 14]), null,
    );

    expect(inputs).toMatchObject({
      prompt_json: ['1', 0],
      max_chars: 2600,
      mode: 'json_structured',
    });
  });

  it('does not shift TextEncodeKrea2 widgets after system_prompt forceInput', () => {
    const clip = makeNode(2, 'CLIPLoader', {
      outputs: [{ name: 'CLIP', type: 'CLIP', links: [1] }],
    });
    const source = makeNode(14, 'Krea2PromptCompact', {
      outputs: [{ name: 'prompt', type: 'STRING', links: [2] }],
      widgets_values: [2600, 'json_structured'],
    });
    const image = makeNode(12, 'HermesOptionalLoadImage', {
      outputs: [
        { name: 'image', type: 'IMAGE', links: [3] },
        { name: 'mask', type: 'MASK', links: [4] },
      ],
    });
    const node = makeNode(4, 'TextEncodeKrea2', {
      inputs: [
        { name: 'clip', type: 'CLIP', link: 1 },
        { name: 'prompt', type: 'STRING', link: 2, widget: { name: 'prompt' } },
        { name: 'system_prompt', type: 'STRING', link: null },
        { name: 'image1', type: 'IMAGE', link: 3 },
        { name: 'mask1', type: 'MASK', link: 4 },
      ],
      widgets_values: ['', 1.0, 0.0, 'before prompt', false, true, 'json_structured'],
    });
    const wf: Workflow = {
      last_node_id: 14,
      last_link_id: 4,
      nodes: [clip, source, image, node],
      links: [
        [1, 2, 0, 4, 0, 'CLIP'],
        [2, 14, 0, 4, 1, 'STRING'],
        [3, 12, 0, 4, 3, 'IMAGE'],
        [4, 12, 1, 4, 4, 'MASK'],
      ],
      groups: [],
      config: {},
      version: 1,
    };
    const nodeTypes: NodeTypes = {
      TextEncodeKrea2: {
        input: {
          required: {
            clip: ['CLIP'],
            prompt: ['STRING', { multiline: true, dynamicPrompts: true }],
          },
          optional: {
            system_prompt: ['STRING', { forceInput: true }],
            image1: ['IMAGE'],
            mask1: ['MASK'],
            vision_megapixels: ['FLOAT', { default: 1.0 }],
            mask_padding: ['FLOAT', { default: 0.0 }],
            vision_position: [['before prompt', 'after prompt'], { default: 'before prompt' }],
            print_prompt: ['BOOLEAN', { default: false }],
            auto_compact_json: ['BOOLEAN', { default: true }],
            json_prompt_mode: [['json_structured', 'json_minify', 'prose_compact'], { default: 'json_structured' }],
          },
        },
        input_order: {
          required: ['clip', 'prompt'],
          optional: [
            'system_prompt',
            'image1',
            'mask1',
            'vision_megapixels',
            'mask_padding',
            'vision_position',
            'print_prompt',
            'auto_compact_json',
            'json_prompt_mode',
          ],
        },
        output: [],
        output_name: [],
        name: 'TextEncodeKrea2',
        display_name: 'Positive Prompt - Text Encode (Krea2)',
        description: '',
        python_module: '',
        category: '',
      },
    };

    const inputs = buildWorkflowPromptInputs(
      wf, nodeTypes, node, 'TextEncodeKrea2', new Set([2, 4, 12, 14]), null,
    );

    expect(inputs).toMatchObject({
      clip: ['2', 0],
      prompt: ['14', 0],
      image1: ['12', 0],
      mask1: ['12', 1],
      vision_megapixels: 1.0,
      mask_padding: 0.0,
      vision_position: 'before prompt',
      print_prompt: false,
      auto_compact_json: true,
      json_prompt_mode: 'json_structured',
    });
    expect(inputs).not.toHaveProperty('system_prompt');
  });

  it("replaces a 'seed' INT widget value with the override (stock KSampler)", () => {
    const node = makeNode(1, 'KSampler', {
      widgets_values: [-1],
    });
    const wf: Workflow = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [node],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };
    const nodeTypes: NodeTypes = {
      KSampler: {
        input: {
          required: {
            seed: ['INT', { default: 0, min: 0, max: SEED_MAX }],
          },
        },
        input_order: { required: ['seed'], optional: [] },
        output: [],
        output_name: [],
        name: 'KSampler',
        display_name: 'KSampler',
        description: '',
        python_module: '',
        category: '',
      },
    };

    const inputs = buildWorkflowPromptInputs(
      wf, nodeTypes, node, 'KSampler', new Set([1]), null, { 1: 12345 },
    );

    expect(inputs.seed).toBe(12345);
  });

  it("replaces a 'noise_seed' INT widget value with the override (Efficient KSampler Adv)", () => {
    // Regression for issue #57: Efficient KSampler Adv names its seed input
    // 'noise_seed' with min=0. When the user picks a special seed mode the
    // widget holds -1, and the override path must rewrite inputs.noise_seed
    // rather than passing -1 through to the server.
    const node = makeNode(1, 'KSampler Adv (Efficient)', {
      widgets_values: ['enable', -1],
    });
    const wf: Workflow = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [node],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };
    const nodeTypes: NodeTypes = {
      'KSampler Adv (Efficient)': {
        input: {
          required: {
            add_noise: [['enable', 'disable'], {}],
            noise_seed: ['INT', { default: 0, min: 0, max: SEED_MAX }],
          },
        },
        input_order: { required: ['add_noise', 'noise_seed'], optional: [] },
        output: [],
        output_name: [],
        name: 'KSampler Adv (Efficient)',
        display_name: 'KSampler Adv (Efficient)',
        description: '',
        python_module: '',
        category: '',
      },
    };

    const inputs = buildWorkflowPromptInputs(
      wf, nodeTypes, node, 'KSampler Adv (Efficient)', new Set([1]), null, { 1: 67890 },
    );

    expect(inputs.noise_seed).toBe(67890);
    expect(inputs.add_noise).toBe('enable');
  });

  it("reads later widgets at the correct index when control_after_generate is stripped (Efficient KSampler Adv)", () => {
    // Regression for the off-by-one bug: Efficient Nodes removes the auto
    // control_after_generate widget on the JS side, so widgets_values is one
    // slot shorter than the declared widget order. Inputs after noise_seed
    // (sampler_name, scheduler, preview_method, etc.) should still read from
    // the right positions instead of being shifted by one.
    const node = makeNode(1, 'KSampler Adv (Efficient)', {
      widgets_values: [
        'enable',     // add_noise
        42,           // noise_seed
        // (no control_after_generate slot — stripped by Efficient Nodes)
        20,           // steps
        'euler',      // sampler_name
        'karras',     // scheduler
        'auto',       // preview_method
      ],
    });
    const wf: Workflow = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [node],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };
    const nodeTypes: NodeTypes = {
      'KSampler Adv (Efficient)': {
        input: {
          required: {
            add_noise: [['enable', 'disable'], {}],
            noise_seed: ['INT', { default: 0, min: 0, max: SEED_MAX }],
            steps: ['INT', { default: 20, min: 1, max: 10000 }],
            sampler_name: [['euler', 'dpmpp_2m'], {}],
            scheduler: [['karras', 'normal'], {}],
            preview_method: [['auto', 'latent2rgb', 'taesd', 'none'], {}],
          },
        },
        input_order: {
          required: ['add_noise', 'noise_seed', 'steps', 'sampler_name', 'scheduler', 'preview_method'],
          optional: [],
        },
        output: [],
        output_name: [],
        name: 'KSampler Adv (Efficient)',
        display_name: 'KSampler Adv (Efficient)',
        description: '',
        python_module: '',
        category: '',
      },
    };

    const inputs = buildWorkflowPromptInputs(
      wf, nodeTypes, node, 'KSampler Adv (Efficient)', new Set([1]), null,
    );

    expect(inputs.noise_seed).toBe(42);
    expect(inputs.steps).toBe(20);
    expect(inputs.sampler_name).toBe('euler');
    expect(inputs.scheduler).toBe('karras');
    expect(inputs.preview_method).toBe('auto');
  });

  it("skips a control_after_generate slot that is present but null (KSampler SDXL Eff. real-world workflow)", () => {
    // Regression for the KSampler SDXL (Eff.) shape observed in user
    // workflows: the control_after_generate slot is retained at index 1
    // but its value is null. The walker must still treat it as the control
    // slot (skip past it) so the following inputs read from the right
    // positions and the seed override applies to noise_seed.
    const node = makeNode(1, 'KSampler SDXL (Eff.)', {
      widgets_values: [
        -1,                  // noise_seed
        null,                // control_after_generate (present but blank)
        35,                  // steps
        6.5,                 // cfg
        'euler_ancestral',   // sampler_name
        'karras',            // scheduler
        0,                   // start_at_step
        -1,                  // refine_at_step
        'latent2rgb',        // preview_method
        'true',              // vae_decode
      ],
    });
    const wf: Workflow = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [node],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };
    const nodeTypes: NodeTypes = {
      'KSampler SDXL (Eff.)': {
        input: {
          required: {
            noise_seed: ['INT', { default: 0, min: 0, max: SEED_MAX }],
            steps: ['INT', { default: 20, min: 1, max: 10000 }],
            cfg: ['FLOAT', { default: 7.0, min: 0.0, max: 100.0 }],
            sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m'], {}],
            scheduler: [['karras', 'normal'], {}],
            start_at_step: ['INT', { default: 0, min: 0, max: 10000 }],
            refine_at_step: ['INT', { default: -1, min: -1, max: 10000 }],
            preview_method: [['auto', 'latent2rgb', 'taesd', 'none'], {}],
            vae_decode: [['true', 'true (tiled)', 'false'], {}],
          },
        },
        input_order: {
          required: [
            'noise_seed', 'steps', 'cfg', 'sampler_name', 'scheduler',
            'start_at_step', 'refine_at_step', 'preview_method', 'vae_decode',
          ],
          optional: [],
        },
        output: [],
        output_name: [],
        name: 'KSampler SDXL (Eff.)',
        display_name: 'KSampler SDXL (Eff.)',
        description: '',
        python_module: '',
        category: '',
      },
    };

    const inputs = buildWorkflowPromptInputs(
      wf, nodeTypes, node, 'KSampler SDXL (Eff.)', new Set([1]), null, { 1: 999 },
    );

    expect(inputs.noise_seed).toBe(999); // override applied
    expect(inputs.steps).toBe(35);
    expect(inputs.cfg).toBe(6.5);
    expect(inputs.sampler_name).toBe('euler_ancestral');
    expect(inputs.scheduler).toBe('karras');
    expect(inputs.start_at_step).toBe(0);
    expect(inputs.refine_at_step).toBe(-1);
    expect(inputs.preview_method).toBe('latent2rgb');
    expect(inputs.vae_decode).toBe('true');
  });

  it("still skips the control_after_generate slot when it is present (stock KSampler)", () => {
    const node = makeNode(1, 'KSampler', {
      widgets_values: [
        42,           // seed
        'fixed',      // control_after_generate (stock ComfyUI auto-widget)
        20,           // steps
        'euler',      // sampler_name
      ],
    });
    const wf: Workflow = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [node],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };
    const nodeTypes: NodeTypes = {
      KSampler: {
        input: {
          required: {
            seed: ['INT', { default: 0, min: 0, max: SEED_MAX }],
            steps: ['INT', { default: 20, min: 1, max: 10000 }],
            sampler_name: [['euler', 'dpmpp_2m'], {}],
          },
        },
        input_order: { required: ['seed', 'steps', 'sampler_name'], optional: [] },
        output: [],
        output_name: [],
        name: 'KSampler',
        display_name: 'KSampler',
        description: '',
        python_module: '',
        category: '',
      },
    };

    const inputs = buildWorkflowPromptInputs(
      wf, nodeTypes, node, 'KSampler', new Set([1]), null,
    );

    expect(inputs.seed).toBe(42);
    expect(inputs.steps).toBe(20);
    expect(inputs.sampler_name).toBe('euler');
  });

  it("leaves the seed alone when no override is present", () => {
    const node = makeNode(1, 'KSampler Adv (Efficient)', {
      widgets_values: ['enable', 42],
    });
    const wf: Workflow = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [node],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };
    const nodeTypes: NodeTypes = {
      'KSampler Adv (Efficient)': {
        input: {
          required: {
            add_noise: [['enable', 'disable'], {}],
            noise_seed: ['INT', { default: 0, min: 0, max: SEED_MAX }],
          },
        },
        input_order: { required: ['add_noise', 'noise_seed'], optional: [] },
        output: [],
        output_name: [],
        name: 'KSampler Adv (Efficient)',
        display_name: 'KSampler Adv (Efficient)',
        description: '',
        python_module: '',
        category: '',
      },
    };

    const inputs = buildWorkflowPromptInputs(
      wf, nodeTypes, node, 'KSampler Adv (Efficient)', new Set([1]), null, undefined,
    );

    expect(inputs.noise_seed).toBe(42);
  });
});

describe('resolveComboOption', () => {
  it('matches extensionless and base-path values to combo options', () => {
    const options = ['foo.safetensors', 'bar.safetensors'];
    expect(resolveComboOption('models/foo', options)).toBe('foo.safetensors');
    expect(resolveComboOption('nested/path/bar.safetensors', options)).toBe('bar.safetensors');
  });

  it('resolves numeric combo index values to option value', () => {
    const options = ['euler', 'ddim', 'dpmpp'];
    expect(resolveComboOption(1, options)).toBe('ddim');
  });
});

describe('lora manager prompt serialization', () => {
  const nodeTypes: NodeTypes = {
    'Lora Loader (LoraManager)': {
      input: {
        required: {
          text: ['STRING', {}],
        },
      },
      input_order: {
        required: ['text'],
        optional: [],
      },
      output: [],
      output_name: [],
      name: 'Lora Loader (LoraManager)',
      display_name: 'Lora Loader (LoraManager)',
      description: '',
      python_module: '',
      category: '',
    },
  };

  it('includes loras input from widgetIndexMap in workflow prompt', () => {
    const loras = [{ name: 'foo.safetensors', strength: 0.7 }];
    const node = makeNode(1, 'Lora Loader (LoraManager)', {
      widgets_values: ['prompt', loras],
    });
    const workflow: Workflow = {
      last_node_id: 1,
      last_link_id: 0,
      nodes: [node],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };

    const inputs = buildWorkflowPromptInputs(
      workflow,
      nodeTypes,
      node,
      'Lora Loader (LoraManager)',
      new Set([1]),
      { text: 0, loras: 1 },
    );

    expect(inputs).toMatchObject({
      text: 'prompt',
      loras,
    });
  });

});

describe('trigger word prompt serialization', () => {
  const nodeTypes: NodeTypes = {
    'TriggerWord Toggle (LoraManager)': {
      input: {
        required: {
          group_mode: ['BOOLEAN', {}],
          default_active: ['BOOLEAN', {}],
          allow_strength_adjustment: ['BOOLEAN', {}],
        },
      },
      input_order: {
        required: ['group_mode', 'default_active', 'allow_strength_adjustment'],
        optional: [],
      },
      output: [],
      output_name: [],
      name: 'TriggerWord Toggle (LoraManager)',
      display_name: 'TriggerWord Toggle (LoraManager)',
      description: '',
      python_module: '',
      category: '',
    },
  };

  function makeTriggerWorkflow(node: WorkflowNode): Workflow {
    return {
      last_node_id: node.id,
      last_link_id: 0,
      nodes: [node],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };
  }

  it('uses originalMessage key when present in widgetIndexMap', () => {
    const list = [{ text: 'foo', active: true }];
    const node = makeNode(5, 'TriggerWord Toggle (LoraManager)', {
      widgets_values: [true, true, false, list, 'foo'],
    });
    const workflow = makeTriggerWorkflow(node);
    const inputs = buildWorkflowPromptInputs(
      workflow,
      nodeTypes,
      node,
      'TriggerWord Toggle (LoraManager)',
      new Set([5]),
      { group_mode: 0, default_active: 1, allow_strength_adjustment: 2, toggle_trigger_words: 3, originalMessage: 4 },
    );

    expect(inputs.toggle_trigger_words).toEqual(list);
    expect(inputs.originalMessage).toBe('foo');
  });

  it('falls back to orinalMessage key when originalMessage is not mapped', () => {
    const list = [{ text: 'foo', active: true }];
    const node = makeNode(6, 'TriggerWord Toggle (LoraManager)', {
      widgets_values: [true, true, false, list, 'foo'],
    });
    const workflow = makeTriggerWorkflow(node);
    const inputs = buildWorkflowPromptInputs(
      workflow,
      nodeTypes,
      node,
      'TriggerWord Toggle (LoraManager)',
      new Set([6]),
      { group_mode: 0, default_active: 1, allow_strength_adjustment: 2, toggle_trigger_words: 3 },
    );

    expect(inputs.toggle_trigger_words).toEqual(list);
    expect(inputs.orinalMessage).toBe('foo');
  });

  it('prefers mapped trigger-word list index when earlier empty arrays exist', () => {
    const list = [{ text: 'mapped', active: true }];
    const node = makeNode(7, 'TriggerWord Toggle (LoraManager)', {
      widgets_values: [true, [], false, list, 'mapped'],
    });
    const workflow = makeTriggerWorkflow(node);
    const inputs = buildWorkflowPromptInputs(
      workflow,
      nodeTypes,
      node,
      'TriggerWord Toggle (LoraManager)',
      new Set([7]),
      { group_mode: 0, default_active: 2, toggle_trigger_words: 3, originalMessage: 4 },
    );

    expect(inputs.toggle_trigger_words).toEqual(list);
    expect(inputs.originalMessage).toBe('mapped');
  });
});

describe('filename_prefix replacements', () => {
  const nodeTypes: NodeTypes = {
    EmptyLatentImage: {
      input: {
        required: {
          width: ['INT', {}],
          height: ['INT', {}],
        },
      },
      input_order: {
        required: ['width', 'height'],
        optional: [],
      },
      output: [],
      output_name: [],
      name: 'EmptyLatentImage',
      display_name: 'Empty Latent Image',
      description: '',
      python_module: '',
      category: '',
    },
    SaveImage: {
      input: {
        required: {
          images: ['IMAGE', {}],
          filename_prefix: ['STRING', {}],
        },
      },
      input_order: {
        required: ['images', 'filename_prefix'],
        optional: [],
      },
      output: [],
      output_name: [],
      name: 'SaveImage',
      display_name: 'SaveImage',
      description: '',
      python_module: '',
      category: '',
    },
  };

  function createWorkflow(): { workflow: Workflow; saveNode: WorkflowNode } {
    const sourceNode = makeNode(1, 'EmptyLatentImage', {
      properties: {
        'Node name for S&R': 'Empty Latent Image',
      },
      widgets_values: [768, 512],
    });

    const saveNode = makeNode(2, 'SaveImage', {
      inputs: [{ name: 'images', type: 'IMAGE', link: null }],
      widgets_values: ['video/%date:yyyy-MM-dd%/%date:hhmmss%_%Empty Latent Image.width%?bad'],
    });

    const workflow: Workflow = {
      last_node_id: 2,
      last_link_id: 0,
      nodes: [sourceNode, saveNode],
      links: [],
      groups: [],
      config: {},
      version: 1,
      widget_idx_map: {
        '1': { width: 0, height: 1 },
        '2': { filename_prefix: 0 },
      },
    };

    return { workflow, saveNode };
  }

  it('applies %date and %Node.widget replacements in workflow prompt serialization', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-21T14:05:09'));

    const { workflow, saveNode } = createWorkflow();
    const inputs = buildWorkflowPromptInputs(
      workflow,
      nodeTypes,
      saveNode,
      'SaveImage',
      new Set([1, 2]),
      { filename_prefix: 0 },
    );

    expect(inputs.filename_prefix).toBe('video/2026-02-21/140509_768?bad');
  });

});

describe('PromptAssistantGenerate queue serialization', () => {
  const nodeTypes: NodeTypes = {
    PromptAssistantGenerate: {
      input: {
        required: {
          idea: ['STRING', { default: '' }],
          profile: [['swarm_booru_tags', 'swarm_wai_trio_three_lines'], { default: 'swarm_booru_tags' }],
          context: ['STRING', { default: '' }],
          image_caption: ['STRING', { default: '' }],
          extra_instructions: ['STRING', { default: '' }],
          timeout_seconds: ['FLOAT', { default: 60 }],
          seed: ['INT', { default: -1 }],
        },
        optional: {
          profile_json_override: ['STRING', { default: '' }],
          prompt: ['STRING', { default: '' }],
          negative_prompt: ['STRING', { default: '' }],
          helper_mode: [['None', 'Couple regions', 'Bounding boxes'], { default: 'None' }],
          emit_ui_text: ['BOOLEAN', { default: false }],
          auto_generate_on_queue: ['BOOLEAN', { default: false }],
        },
      },
      input_order: {
        required: ['idea', 'profile', 'context', 'image_caption', 'extra_instructions', 'timeout_seconds', 'seed'],
        optional: ['profile_json_override', 'prompt', 'negative_prompt', 'helper_mode', 'emit_ui_text', 'auto_generate_on_queue'],
      },
      output: [],
      output_name: [],
      name: 'PromptAssistantGenerate',
      display_name: 'Prompt Assistant Generate',
      description: '',
      python_module: '',
      category: '',
    },
  };

  it('preserves the idea while queueing editable final prompt fields and disables stale generation inputs', () => {
    const node = makeNode(12, 'PromptAssistantGenerate', {
      widgets_values: [
        'stale idea: two adult women and one adult man',
        'swarm_wai_trio_three_lines',
        'poisoned context',
        'poisoned image caption',
        'poisoned extra instructions',
        90,
        4321,
        '',
        '1girl, adult woman\n1boy, adult man',
        'bad anatomy',
        'Regional prompt',
        true,
        true,
      ],
    });
    const workflow: Workflow = {
      last_node_id: 12,
      last_link_id: 0,
      nodes: [node],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };

    const inputs = buildWorkflowPromptInputs(
      workflow,
      nodeTypes,
      node,
      'PromptAssistantGenerate',
      new Set([12]),
      null,
    );

    expect(inputs.idea).toBe('stale idea: two adult women and one adult man');
    expect(inputs.prompt).toBe('1girl, adult woman\n1boy, adult man');
    expect(inputs.negative_prompt).toBe('bad anatomy');
    expect(inputs.context).toBe('');
    expect(inputs.image_caption).toBe('');
    expect(inputs.extra_instructions).toBe('');
    expect(inputs.helper_mode).toBe('Couple regions');
    expect(inputs.emit_ui_text).toBe(true);
    expect(inputs.auto_generate_on_queue).toBe(false);
  });

  it('normalizes stale boolean helper mode values before queueing', () => {
    const node = makeNode(12, 'PromptAssistantGenerate', {
      widgets_values: [
        'stale idea',
        'swarm_booru_tags',
        '',
        '',
        '',
        90,
        4321,
        '',
        'smiling dog with fluffy fur',
        '',
        true,
        true,
        false,
      ],
    });
    const workflow: Workflow = {
      last_node_id: 12,
      last_link_id: 0,
      nodes: [node],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };

    const inputs = buildWorkflowPromptInputs(
      workflow,
      nodeTypes,
      node,
      'PromptAssistantGenerate',
      new Set([12]),
      null,
    );

    expect(inputs.prompt).toBe('smiling dog with fluffy fur');
    expect(inputs.helper_mode).toBe('None');
    expect(inputs.emit_ui_text).toBe(true);
    expect(inputs.auto_generate_on_queue).toBe(false);
  });

  it('normalizes helper mode aliases used by older saved workflows', () => {
    expect(normalizePromptAssistantHelperMode('Regional prompt')).toBe('Couple regions');
    expect(normalizePromptAssistantHelperMode('bbox')).toBe('Bounding boxes');
    expect(normalizePromptAssistantHelperMode(true)).toBe('None');
  });

  it('normalizes stale profile JSON override placeholders before queueing', () => {
    expect(normalizePromptAssistantProfileJsonOverride('')).toBe('');
    expect(normalizePromptAssistantProfileJsonOverride('undefined')).toBe('');
    expect(normalizePromptAssistantProfileJsonOverride('null')).toBe('');
    expect(normalizePromptAssistantProfileJsonOverride('not json')).toBe('');
    expect(normalizePromptAssistantProfileJsonOverride('{"temperature":0.2}')).toBe('{"temperature":0.2}');

    const node = makeNode(12, 'PromptAssistantGenerate', {
      widgets_values: [
        'stale idea',
        'swarm_booru_tags',
        '',
        '',
        '',
        90,
        4321,
        'undefined',
        'smiling dog with fluffy fur',
        '',
        'None',
        true,
        false,
      ],
    });
    const workflow: Workflow = {
      last_node_id: 12,
      last_link_id: 0,
      nodes: [node],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };

    const inputs = buildWorkflowPromptInputs(
      workflow,
      nodeTypes,
      node,
      'PromptAssistantGenerate',
      new Set([12]),
      null,
    );

    expect(inputs.profile_json_override).toBe('');
    expect(inputs.prompt).toBe('smiling dog with fluffy fur');
  });

  it('defaults blank helper mode to plain prompting', () => {
    const node = makeNode(12, 'PromptAssistantGenerate', {
      widgets_values: [
        'stale idea',
        'swarm_booru_tags',
        '',
        '',
        '',
        90,
        4321,
        '',
        'smiling dog with fluffy fur',
        '',
        '',
        false,
        true,
      ],
    });
    const workflow: Workflow = {
      last_node_id: 12,
      last_link_id: 0,
      nodes: [node],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };

    const inputs = buildWorkflowPromptInputs(
      workflow,
      nodeTypes,
      node,
      'PromptAssistantGenerate',
      new Set([12]),
      null,
    );

    expect(inputs.prompt).toBe('smiling dog with fluffy fur');
    expect(inputs.helper_mode).toBe('None');
    expect(inputs.auto_generate_on_queue).toBe(false);
  });

  it('recovers a structured final prompt that was accidentally stored in final negative', () => {
    const structuredPrompt = JSON.stringify({
      high_level_description: 'two adult women in a neon cafe',
      compositional_deconstruction: {
        background: 'indoors',
        elements: [
          { type: 'obj', bbox: [100, 100, 400, 900], desc: 'adult woman in a red jacket' },
        ],
      },
    });
    const node = makeNode(12, 'PromptAssistantGenerate', {
      widgets_values: [
        'stale idea',
        'swarm_booru_tags',
        '',
        '',
        '',
        90,
        4321,
        '',
        '',
        structuredPrompt,
        'Bounding boxes',
        false,
        true,
      ],
    });
    const workflow: Workflow = {
      last_node_id: 12,
      last_link_id: 0,
      nodes: [node],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };

    const inputs = buildWorkflowPromptInputs(
      workflow,
      nodeTypes,
      node,
      'PromptAssistantGenerate',
      new Set([12]),
      null,
    );

    expect(inputs.prompt).toBe(structuredPrompt);
    expect(inputs.negative_prompt).toBe('');
    expect(inputs.auto_generate_on_queue).toBe(false);
  });

  it('promotes a regional final prompt that was accidentally stored in final negative over a stale preview prompt', () => {
    const stalePreviewPrompt = [
      '2girls, blonde twintails, cyan eyes, white serafuku, standing, waving, looking at viewer, smile, anime coloring',
      '2girls, black long hair, red eyes, dark school uniform, standing, crossed arms, looking away, anime coloring',
    ].join('\n');
    const regionalPrompt = [
      'top-bottom composition, indoor room, soft natural lighting, warm atmosphere, focus on interaction',
      '1girl, female focus, looking up, kneeling, foreground',
      '1boy, male focus, sitting back on sofa, background',
    ].join('\n');
    const node = makeNode(12, 'PromptAssistantGenerate', {
      widgets_values: [
        'stale idea',
        'swarm_wai_couple_two_lines',
        '',
        '',
        '',
        90,
        4321,
        '',
        stalePreviewPrompt,
        regionalPrompt,
        'Couple regions',
        true,
        true,
      ],
    });
    const workflow: Workflow = {
      last_node_id: 12,
      last_link_id: 0,
      nodes: [node],
      links: [],
      groups: [],
      config: {},
      version: 1,
    };

    const inputs = buildWorkflowPromptInputs(
      workflow,
      nodeTypes,
      node,
      'PromptAssistantGenerate',
      new Set([12]),
      null,
    );

    expect(inputs.prompt).toBe(regionalPrompt);
    expect(inputs.negative_prompt).toBe('');
    expect(inputs.auto_generate_on_queue).toBe(false);
  });

  it('does not resurrect connected Forge positive text when an old helper node has no final prompt widget', () => {
    const forgePrompt = [
      'shared scene, two distinct adult people, left-right composition',
      '1boy, adult man, left half only',
      '1girl, adult woman, right half only',
    ].join('\n');
    const assistantNode = makeNode(12, 'PromptAssistantGenerate', {
      widgets_values: [
        'stale idea',
        'swarm_wai_couple_two_lines',
        '',
        '',
        '',
        90,
        4321,
        '',
      ],
      outputs: [
        { name: 'prompt', type: 'STRING', links: [14], slot_index: 0 },
      ],
    });
    const forgeNode = makeNode(4, 'ForgeCoupleRegionalPrompt', {
      inputs: [
        { name: 'model', type: 'MODEL', link: null },
        { name: 'clip', type: 'CLIP', link: null },
        { name: 'positive_text', type: 'STRING', link: 14 },
      ],
      widgets_values: [
        forgePrompt,
        1024,
        1344,
        'auto',
        'Basic',
        'Auto',
        'First Line',
        0.25,
        '\\n',
        '[[0.0, 1.0, 0.0, 1.0, 0.25], [0.0, 0.5, 0.0, 1.0, 1.25], [0.5, 1.0, 0.0, 1.0, 1.25]]',
        'Off',
        true,
      ],
    });
    const workflow: Workflow = {
      last_node_id: 12,
      last_link_id: 14,
      nodes: [assistantNode, forgeNode],
      links: [[14, 12, 0, 4, 2, 'STRING']],
      groups: [],
      config: {},
      version: 1,
    };

    const inputs = buildWorkflowPromptInputs(
      workflow,
      nodeTypes,
      assistantNode,
      'PromptAssistantGenerate',
      new Set([12]),
      null,
    );

    expect(inputs.idea).toBe('stale idea');
    expect(inputs.prompt).toBe('');
    expect(inputs.auto_generate_on_queue).toBe(false);
  });
});

describe('PromptAssistant Forge Couple automation', () => {
  function createForgeWorkflow(): { workflow: Workflow; assistantNode: WorkflowNode; forgeNode: WorkflowNode } {
    const assistantNode = makeNode(12, 'PromptAssistantGenerate', {
      outputs: [
        { name: 'prompt', type: 'STRING', links: [14], slot_index: 0 },
        { name: 'negative_prompt', type: 'STRING', links: [16], slot_index: 1 },
      ],
      widgets_values: [
        'idea',
        'swarm_booru_tags',
        '',
        '',
        '',
        90,
        4321,
        '',
        '',
        '',
        'Couple regions',
        true,
        false,
      ],
    });
    const forgeNode = makeNode(4, 'ForgeCoupleRegionalPrompt', {
      inputs: [
        { name: 'model', type: 'MODEL', link: null },
        { name: 'clip', type: 'CLIP', link: null },
        { name: 'positive_text', type: 'STRING', link: 14 },
      ],
      widgets_values: [
        'old prompt',
        1024,
        1024,
        'forge_attention',
        'Advanced',
        'Horizontal',
        'None',
        0.2,
        '\\n',
        'old mapping',
        'Off',
        false,
        '[{"on":true,"lora":"HimawariUzumaki_AnimaPreview3_byKonan.safetensors","strength":1,"targets":["himawari"]}]',
      ],
    });
    return {
      assistantNode,
      forgeNode,
      workflow: {
        last_node_id: 12,
        last_link_id: 16,
        nodes: [assistantNode, forgeNode],
        links: [
          [14, 12, 0, 4, 2, 'STRING'],
          [16, 12, 1, 5, 1, 'STRING'],
        ],
        groups: [],
        config: {},
        version: 1,
      },
    };
  }

  it('infers horizontal regions from left/right prompts', () => {
    const prompt = [
      'shared cozy sofa scene, left-right composition, both faces visible',
      'left: naruto uzumaki, 1boy, male focus, sitting on left side',
      'right: himawari, 1girl, female focus, sitting on right side',
    ].join('\n');

    expect(inferPromptAssistantForgeCoupleDirection(prompt)).toBe('Horizontal');
  });

  it('configures the linked Forge node for horizontal couple regions and preserves LoRA rules', () => {
    const { workflow, assistantNode } = createForgeWorkflow();
    const prompt = [
      'shared cozy sofa scene, left-right composition, both faces visible',
      'left: naruto uzumaki, 1boy, male focus, sitting on left side',
      'right: himawari, 1girl, female focus, sitting on right side',
    ].join('\n');

    const result = applyPromptAssistantForgeCoupleAutomation(
      workflow,
      assistantNode,
      prompt,
      'Couple regions',
    );

    expect(result?.direction).toBe('Horizontal');
    const updatedForgeNode = result?.workflow.nodes.find((node) => node.id === 4);
    expect(updatedForgeNode?.widgets_values).toEqual([
      prompt,
      1024,
      1024,
      'anima_mask',
      'Basic',
      'Horizontal',
      'First Line',
      0.25,
      '\\n',
      FORGE_COUPLE_HORIZONTAL_ADVANCED_MAPPING,
      'Off',
      true,
      '[{"on":true,"lora":"HimawariUzumaki_AnimaPreview3_byKonan.safetensors","strength":1,"targets":["himawari"]}]',
    ]);
  });

  it('configures the linked Forge node for vertical couple regions', () => {
    const { workflow, assistantNode } = createForgeWorkflow();
    const prompt = [
      'shared cozy sofa scene, top-bottom composition, both faces visible',
      'top: naruto uzumaki, 1boy, male focus, reclining on sofa above',
      'bottom: himawari, 1girl, female focus, leaning upward below',
    ].join('\n');

    const result = applyPromptAssistantForgeCoupleAutomation(
      workflow,
      assistantNode,
      prompt,
      'Couple regions',
    );

    expect(result?.direction).toBe('Vertical');
    const updatedForgeNode = result?.workflow.nodes.find((node) => node.id === 4);
    expect(Array.isArray(updatedForgeNode?.widgets_values)).toBe(true);
    const values = updatedForgeNode?.widgets_values as unknown[];
    expect(values[0]).toBe(prompt);
    expect(values[3]).toBe('anima_mask');
    expect(values[4]).toBe('Basic');
    expect(values[5]).toBe('Vertical');
    expect(values[6]).toBe('First Line');
    expect(values[9]).toBe(FORGE_COUPLE_VERTICAL_ADVANCED_MAPPING);
    expect(values[12]).toBe('[{"on":true,"lora":"HimawariUzumaki_AnimaPreview3_byKonan.safetensors","strength":1,"targets":["himawari"]}]');
  });

  it('uses no background line for two-line regional prompts', () => {
    const { workflow, assistantNode } = createForgeWorkflow();
    const prompt = [
      'left: naruto uzumaki, 1boy, male focus, sitting on left side',
      'right: himawari, 1girl, female focus, sitting on right side',
    ].join('\n');

    const result = applyPromptAssistantForgeCoupleAutomation(
      workflow,
      assistantNode,
      prompt,
      'Couple regions',
    );

    const updatedForgeNode = result?.workflow.nodes.find((node) => node.id === 4);
    expect(Array.isArray(updatedForgeNode?.widgets_values)).toBe(true);
    const values = updatedForgeNode?.widgets_values as unknown[];
    expect(values[4]).toBe('Basic');
    expect(values[5]).toBe('Horizontal');
    expect(values[6]).toBe('None');
    expect(values[9]).toBe('[[0,0.5,0,1,1],[0.5,1,0,1,1]]');
  });

  it('does not touch Forge Couple when helper mode is plain prompting', () => {
    const { workflow, assistantNode } = createForgeWorkflow();
    const result = applyPromptAssistantForgeCoupleAutomation(
      workflow,
      assistantNode,
      'plain prompt',
      'None',
    );

    expect(result).toBeNull();
  });

  it('updates stale Forge Couple settings from the assistant final prompt at queue time', () => {
    const { workflow } = createForgeWorkflow();
    const prompt = [
      'shared bedroom scene, top-bottom composition, medium wide shot, both faces visible',
      'top: adult man, 1boy, male focus, upper half, leaning over partner',
      'bottom: adult woman, 1girl, female focus, lower half, lying on bed',
    ].join('\n');
    const assistantNode = workflow.nodes.find((node) => node.id === 12);
    if (assistantNode && Array.isArray(assistantNode.widgets_values)) {
      assistantNode.widgets_values[8] = prompt;
      assistantNode.widgets_values[10] = 'Couple regions';
    }

    const result = applyPromptAssistantForgeCoupleQueueAutomation(workflow);

    expect(result.changed).toBe(true);
    expect(result.direction).toBe('Vertical');
    const updatedForgeNode = result.workflow.nodes.find((node) => node.id === 4);
    expect(Array.isArray(updatedForgeNode?.widgets_values)).toBe(true);
    const values = updatedForgeNode?.widgets_values as unknown[];
    expect(values[0]).toBe(prompt);
    expect(values[3]).toBe('anima_mask');
    expect(values[4]).toBe('Basic');
    expect(values[5]).toBe('Vertical');
    expect(values[6]).toBe('First Line');
    expect(values[9]).toBe(FORGE_COUPLE_VERTICAL_ADVANCED_MAPPING);
  });

  it('uses a regional prompt stored in the assistant negative slot for queue-time Forge automation', () => {
    const { workflow } = createForgeWorkflow();
    const stalePreview = [
      '2girls, blonde twintails, standing',
      '2girls, black hair, standing',
    ].join('\n');
    const prompt = [
      'shared living room scene, top-bottom composition, medium wide shot, both faces visible',
      'top: adult man, 1boy, male focus, reclining on sofa above',
      'bottom: adult woman, 1girl, female focus, sitting on sofa below',
    ].join('\n');
    const assistantNode = workflow.nodes.find((node) => node.id === 12);
    if (assistantNode && Array.isArray(assistantNode.widgets_values)) {
      assistantNode.widgets_values[8] = stalePreview;
      assistantNode.widgets_values[9] = prompt;
      assistantNode.widgets_values[10] = 'Couple regions';
    }

    const result = applyPromptAssistantForgeCoupleQueueAutomation(workflow);

    expect(result.changed).toBe(true);
    const updatedForgeNode = result.workflow.nodes.find((node) => node.id === 4);
    const values = updatedForgeNode?.widgets_values as unknown[];
    expect(values[0]).toBe(prompt);
    expect(values[5]).toBe('Vertical');
    expect(values[9]).toBe(FORGE_COUPLE_VERTICAL_ADVANCED_MAPPING);
  });
});
