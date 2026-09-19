import { describe, it, expect } from 'vitest';
import { apiGraphToWorkflow } from '../apiGraphToWorkflow';
import type { NodeTypes } from '@/api/types';
import apiGraph from './fixtures/anima_api_graph.json';
import nodeTypes from './fixtures/anima_nodetypes.json';

// Converts the real WAI-Anima studio API graph using the real /object_info node
// definitions. Validates the structure the node editor needs; the visual render
// is confirmed separately in-app.
describe('apiGraphToWorkflow (real studio workflow)', () => {
  const wf = apiGraphToWorkflow(apiGraph as any, nodeTypes as unknown as NodeTypes);
  const byId = (id: number) => wf.nodes.find((n) => n.id === id)!;

  it('rebuilds every node', () => {
    expect(wf.nodes).toHaveLength(Object.keys(apiGraph).length); // 9
    expect(byId(7).type).toBe('KSampler');
    expect(byId(9).type).toBe('SaveImage');
  });

  it('splits KSampler inputs into connection slots vs widgets like addNode', () => {
    const ks = byId(7);
    const slotNames = ks.inputs.map((i) => i.name);
    // connection inputs become slots
    expect(slotNames).toEqual(expect.arrayContaining(['model', 'positive', 'negative', 'latent_image']));
    // widget inputs never become slots
    expect(slotNames).not.toContain('seed');
    expect(slotNames).not.toContain('cfg');
    // widget VALUES came from the API graph (steps 8, cfg 1, euler, normal)
    expect(ks.widgets_values).toEqual(expect.arrayContaining([8, 1, 'euler', 'normal']));
  });

  it('carries the prompt text into the positive CLIPTextEncode widget', () => {
    const pos = byId(4); // node 4 = positive prompt in this workflow
    expect(pos.type).toBe('CLIPTextEncode');
    expect(String((pos.widgets_values as unknown[])[0])).toContain('1girl');
  });

  it('reconstructs links from API references with correct endpoints', () => {
    // KSampler.model <- LoraLoaderModelOnly(11), KSampler.positive <- node 4,
    // KSampler.latent_image <- node 6, SaveImage.images <- VAEDecode(8).
    const linkTo = (dst: number, slotName: string) => {
      const node = byId(dst);
      const slot = node.inputs.findIndex((i) => i.name === slotName);
      const linkId = node.inputs[slot]?.link;
      return wf.links.find((l) => l[0] === linkId);
    };
    expect(linkTo(7, 'model')?.[1]).toBe(11);
    expect(linkTo(7, 'positive')?.[1]).toBe(4);
    expect(linkTo(7, 'latent_image')?.[1]).toBe(6);
    expect(linkTo(9, 'images')?.[1]).toBe(8);
    // Every connected input resolves to a real link, and every link is well-formed.
    for (const l of wf.links) {
      expect(l).toHaveLength(6);
      expect(byId(l[1])).toBeTruthy(); // source node exists
      expect(byId(l[3])).toBeTruthy(); // target node exists
    }
  });

  it('marks the source output slot as linked', () => {
    const lora = byId(11); // its MODEL output feeds KSampler.model
    expect(lora.outputs[0].links?.length).toBeGreaterThan(0);
  });
});
