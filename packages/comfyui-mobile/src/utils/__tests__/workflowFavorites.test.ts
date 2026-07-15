import { describe, expect, it } from 'vitest';
import { buildWorkflowFavoriteRecord } from '@/utils/workflowFavorites';
import type { Workflow } from '@/api/types';

function makeWorkflow(seed: number, imageName = 'input-a.png'): Workflow {
  return {
    last_node_id: 2,
    last_link_id: 0,
    nodes: [
      {
        id: 1,
        type: 'LoadImage',
        pos: [0, 0],
        size: [1, 1],
        flags: {},
        order: 0,
        mode: 0,
        inputs: [],
        outputs: [],
        properties: {},
        widgets_values: [imageName],
      },
      {
        id: 2,
        type: 'KSampler',
        pos: [0, 0],
        size: [1, 1],
        flags: {},
        order: 1,
        mode: 0,
        inputs: [],
        outputs: [],
        properties: {},
        widgets_values: { seed, image: imageName },
      },
    ],
    links: [],
    groups: [],
    config: {},
    version: 0.4,
  };
}

describe('workflow favorite grouping', () => {
  it('groups same workflow and input image while ignoring seed changes', async () => {
    const first = await buildWorkflowFavoriteRecord({
      workflow: makeWorkflow(1),
      prompt: { 2: { inputs: { seed: 1, image: 'input-a.png' } } },
      file: { id: 'output/out-a.png', name: 'out-a.png', type: 'image' },
      src: '/view?filename=out-a.png',
    });
    const second = await buildWorkflowFavoriteRecord({
      workflow: makeWorkflow(999),
      prompt: { 2: { inputs: { seed: 999, image: 'input-a.png' } } },
      file: { id: 'output/out-b.png', name: 'out-b.png', type: 'image' },
      src: '/view?filename=out-b.png',
    });

    expect(second.groupKey).toBe(first.groupKey);
  });

  it('separates same workflow with a different input image', async () => {
    const first = await buildWorkflowFavoriteRecord({
      workflow: makeWorkflow(1, 'input-a.png'),
      prompt: { 2: { inputs: { seed: 1, image: 'input-a.png' } } },
      file: { id: 'output/out-a.png', name: 'out-a.png', type: 'image' },
    });
    const second = await buildWorkflowFavoriteRecord({
      workflow: makeWorkflow(1, 'input-b.png'),
      prompt: { 2: { inputs: { seed: 1, image: 'input-b.png' } } },
      file: { id: 'output/out-b.png', name: 'out-b.png', type: 'image' },
    });

    expect(second.groupKey).not.toBe(first.groupKey);
  });

  it('groups editor workflows with unnamed RandomNoise widget seed changes', async () => {
    const first = await buildWorkflowFavoriteRecord({
      workflow: {
        ...makeWorkflow(1),
        nodes: [
          ...makeWorkflow(1).nodes,
          {
            id: 3,
            type: 'RandomNoise',
            pos: [0, 0],
            size: [1, 1],
            flags: {},
            order: 2,
            mode: 0,
            inputs: [],
            outputs: [],
            properties: {},
            widgets_values: [111111111111, 'fixed-noise-mode'],
          },
        ],
      },
      file: { id: 'output/out-a.png', name: 'out-a.png', type: 'image' },
    });
    const second = await buildWorkflowFavoriteRecord({
      workflow: {
        ...makeWorkflow(1),
        nodes: [
          ...makeWorkflow(1).nodes,
          {
            id: 3,
            type: 'RandomNoise',
            pos: [0, 0],
            size: [1, 1],
            flags: {},
            order: 2,
            mode: 0,
            inputs: [],
            outputs: [],
            properties: {},
            widgets_values: [999999999999, 'fixed-noise-mode'],
          },
        ],
      },
      file: { id: 'output/out-b.png', name: 'out-b.png', type: 'image' },
    });

    expect(second.groupKey).toBe(first.groupKey);
  });
});
