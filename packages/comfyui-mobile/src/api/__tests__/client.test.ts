import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectNativeMlxBigLoveKlein3, getHistory, queuePrompt, searchUserImagesByPrompt } from '@/api/client';

describe('searchUserImagesByPrompt', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unions name/path and prompt searches without trusting directory entries', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const params = new URL(`http://localhost${url}`).searchParams;
      const files = params.has('search')
        ? [
            { name: 'video', path: 'video', type: 'dir', date: 1 },
            {
              name: 'ComfyUI_04555_.png',
              path: '.hidden/batch/sample scene/ComfyUI_04555_.png',
              folder: '.hidden/batch/sample scene',
              type: 'image',
              date: 2,
              size: 100,
            },
          ]
        : [
            {
              name: 'ComfyUI_04555_.png',
              path: '.hidden/batch/sample scene/ComfyUI_04555_.png',
              folder: '.hidden/batch/sample scene',
              type: 'image',
              date: 2,
              size: 100,
            },
            {
              name: 'ComfyUI_04556_.png',
              path: '.hidden/batch/sample scene/ComfyUI_04556_.png',
              folder: '.hidden/batch/sample scene',
              type: 'image',
              date: 3,
              size: 101,
            },
          ];

      return {
        ok: true,
        json: async () => ({ files, total: files.length, offset: 0, limit: 0 }),
      } as Response;
    });

    vi.stubGlobal('fetch', fetchMock);

    const results = await searchUserImagesByPrompt('output', 'sample scene', null, true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes('search=sample+scene'))).toBe(true);
    expect(urls.some((url) => url.includes('prompt=sample+scene'))).toBe(true);
    expect(urls.some((url) => url.includes('q=sample+scene'))).toBe(false);
    expect(results.map((item) => item.id)).toEqual([
      'output/.hidden/batch/sample scene/ComfyUI_04555_.png',
      'output/.hidden/batch/sample scene/ComfyUI_04556_.png',
    ]);
  });
});

describe('detectNativeMlxBigLoveKlein3', () => {
  const bigLovePrompt = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'BigLoveKlein3_mxfp8.safetensors' } },
    '2': { class_type: 'LoadImage', inputs: { image: 'old-stale-image.png' } },
    '3': { class_type: 'LoadImage', inputs: { image: 'Screenshot 2026-06-21 at 8.52.09 PM.png' } },
    '4': { class_type: 'VAEEncode', inputs: { pixels: ['3', 0] } },
    '5': { class_type: 'KSampler', inputs: { latent_image: ['4', 0], positive: ['6', 0], steps: 4, seed: 123, cfg: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'add a red santa hat' } },
    '7': { class_type: 'EmptyLatentImage', inputs: { width: 768, height: 512 } },
  };

  it('uses the LoadImage wired into the sampler, not the first stale LoadImage', () => {
    expect(detectNativeMlxBigLoveKlein3(bigLovePrompt)?.imagePath).toBe('Screenshot 2026-06-21 at 8.52.09 PM.png');
  });

  it('does not route the ConvRot INT8 BigLove model to the MLX sidecar', () => {
    const convrotPrompt = {
      ...bigLovePrompt,
      '1': {
        class_type: 'UNETLoader',
        inputs: { unet_name: 'BigLoveKlein3_convrot_int8mixed.safetensors' },
      },
    };

    expect(detectNativeMlxBigLoveKlein3(convrotPrompt)).toBeNull();
  });

  it('keeps BigLove queueing on the normal prompt endpoint so the wrapper owns native routing', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ prompt_id: 'native-job-1', number: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await queuePrompt({ prompt: bigLovePrompt });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined];
    const [url, init] = call;
    expect(String(url)).toBe('/comfy/api/prompt');
    const payload = JSON.parse(String(init?.body));
    expect(payload.prompt).toStrictEqual(bigLovePrompt);
  });

  it('rejects partial-success prompt responses with node validation errors', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      prompt_id: 'partial-prompt',
      number: 0,
      node_errors: {
        '9': {
          errors: [{
            type: 'required_input_missing',
            message: 'Required input is missing',
            details: 'images',
            extra_info: { input_name: 'images' },
          }],
        },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(queuePrompt({ prompt: bigLovePrompt })).rejects.toThrow(
      'Prompt validation failed for 1 node',
    );
  });
});

describe('getHistory', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps active native jobs out of history so running jobs do not become prompt errors', async () => {
    const activeRecord = {
      id: 'native-running',
      status: 'running',
      created_at: '2026-06-23T19:00:00Z',
      image_urls: [],
    };
    const completedRecord = {
      id: 'native-success',
      status: 'success',
      created_at: '2026-06-23T19:01:00Z',
      finished_at: '2026-06-23T19:01:04Z',
      image_urls: ['/image/native-success.png'],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/history')) {
        return new Response(JSON.stringify({ history: [activeRecord, completedRecord] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const history = await getHistory();

    expect(history['native-running']).toBeUndefined();
    expect(history['native-success']).toMatchObject({
      outputs: {
        native_mlx: {
          images: [
            {
              filename: 'native-success.png',
              fullUrl: '/image/native-success.png',
            },
          ],
        },
      },
      status: {
        status_str: 'success',
        completed: true,
      },
    });
  });
});
