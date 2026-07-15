import { beforeEach, describe, it, expect, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  getFileWorkflow: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  getFileWorkflow: apiMocks.getFileWorkflow,
}));

import {
  isNativeBigLoveKlein3OutputPath,
  loadWorkflowFromFile,
  resolveFileSource,
  resolveFilePath,
  resolveViewerItemWorkflowLoad,
} from '../workflowOperations';
import type { FileItem } from '@/api/client';
import type { Workflow } from '@/api/types';
import type { ViewerImage } from '../viewerImages';

function makeFile(id: string): FileItem {
  return { id, name: id.split('/').pop() ?? id, type: 'image' };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveFileSource', () => {
  it('returns "input" for files starting with input/', () => {
    expect(resolveFileSource(makeFile('input/photo.png'))).toBe('input');
  });

  it('returns "temp" for files starting with temp/', () => {
    expect(resolveFileSource(makeFile('temp/preview.png'))).toBe('temp');
  });

  it('returns "output" for files without input/ prefix', () => {
    expect(resolveFileSource(makeFile('output/result.png'))).toBe('output');
    expect(resolveFileSource(makeFile('result.png'))).toBe('output');
  });
});

describe('resolveFilePath', () => {
  it('strips the source prefix from the id', () => {
    expect(resolveFilePath(makeFile('output/img.png'))).toBe('img.png');
    expect(resolveFilePath(makeFile('input/photo.jpg'))).toBe('photo.jpg');
    expect(resolveFilePath(makeFile('temp/preview.png'))).toBe('preview.png');
  });

  it('returns id unchanged when no matching prefix', () => {
    expect(resolveFilePath(makeFile('other/file.png'))).toBe('other/file.png');
  });

  it('respects explicit source parameter', () => {
    expect(resolveFilePath(makeFile('input/img.png'), 'output')).toBe('input/img.png');
    expect(resolveFilePath(makeFile('output/img.png'), 'input')).toBe('output/img.png');
  });
});

describe('isNativeBigLoveKlein3OutputPath', () => {
  it('matches native BigLove Klein 3 MLX output filenames', () => {
    expect(isNativeBigLoveKlein3OutputPath('biglove_klein3_mlx_705ac168d49a.png')).toBe(true);
    expect(isNativeBigLoveKlein3OutputPath('subdir/biglove_klein3_mlx_ABCDEF123456.png')).toBe(true);
  });

  it('rejects unrelated output filenames', () => {
    expect(isNativeBigLoveKlein3OutputPath('biglove_klein3_mlx_preview.png')).toBe(false);
    expect(isNativeBigLoveKlein3OutputPath('anima_705ac168d49a.png')).toBe(false);
    expect(isNativeBigLoveKlein3OutputPath('biglove_klein3_mlx_705ac168d49a.jpg')).toBe(false);
  });
});

describe('loadWorkflowFromFile', () => {
  it('loads the exact workflow returned by file metadata', async () => {
    const workflow = { nodes: [{ id: 1 }], links: [] } as unknown as Workflow;
    const loadWorkflow = vi.fn();
    apiMocks.getFileWorkflow.mockResolvedValue(workflow);

    await loadWorkflowFromFile({
      file: makeFile('output/biglove_klein3_mlx_705ac168d49a.png'),
      loadWorkflow,
    });

    expect(apiMocks.getFileWorkflow).toHaveBeenCalledWith(
      'biglove_klein3_mlx_705ac168d49a.png',
      'output',
    );
    expect(loadWorkflow).toHaveBeenCalledWith(
      workflow,
      'biglove_klein3_mlx_705ac168d49a.png',
      {
        source: {
          type: 'file',
          filePath: 'biglove_klein3_mlx_705ac168d49a.png',
          assetSource: 'output',
        },
      },
    );
  });

  it('propagates metadata errors instead of falling back to the current workflow', async () => {
    const originalError = new Error('Encrypted workflow metadata could not be decrypted');
    const loadWorkflow = vi.fn();
    apiMocks.getFileWorkflow.mockRejectedValue(originalError);

    await expect(loadWorkflowFromFile({
      file: makeFile('output/biglove_klein3_mlx_705ac168d49a.png'),
      loadWorkflow,
    })).rejects.toBe(originalError);
    expect(loadWorkflow).not.toHaveBeenCalled();
  });
});

describe('resolveViewerItemWorkflowLoad', () => {
  const mockWorkflow = { nodes: [], links: [] } as unknown as Workflow;

  it('uses full file path to build filename for non-history items', () => {
    const item: ViewerImage = {
      src: 'x',
      mediaType: 'image',
      workflow: mockWorkflow,
      file: makeFile('output/sub/dir/img.png')
    };
    const resolved = resolveViewerItemWorkflowLoad(item);
    expect(resolved?.filename).toBe('sub/dir/img.png');
    expect(resolved?.source).toEqual({ type: 'file', filePath: 'sub/dir/img.png', assetSource: 'output' });
  });

  it('uses history filename format when promptId exists', () => {
    const item: ViewerImage = {
      src: 'x',
      mediaType: 'image',
      workflow: mockWorkflow,
      promptId: 'p-123',
      file: makeFile('output/sub/dir/img.png')
    };
    const resolved = resolveViewerItemWorkflowLoad(item);
    expect(resolved?.filename).toBe('history-p-123.json');
    expect(resolved?.source).toEqual({ type: 'history', promptId: 'p-123' });
  });

  it('carries hidden file provenance into loaded workflows', () => {
    const item: ViewerImage = {
      src: 'x',
      mediaType: 'image',
      workflow: mockWorkflow,
      file: { ...makeFile('output/private.png'), hidden: true },
    };

    expect(resolveViewerItemWorkflowLoad(item)?.source).toEqual({
      type: 'file',
      filePath: 'private.png',
      assetSource: 'output',
      hidden: true,
    });
  });

  it('falls back to history map when viewer item has no embedded workflow', () => {
    const historyWorkflow = { nodes: [{ id: 1 }], links: [] } as unknown as Workflow;
    const historyMap = new Map([
      ['output/sub/dir/img.png', { workflow: historyWorkflow, promptId: 'p-from-history' }],
    ]);
    const item: ViewerImage = {
      src: 'x',
      mediaType: 'image',
      file: makeFile('output/sub/dir/img.png'),
    };
    const resolved = resolveViewerItemWorkflowLoad(item, historyMap);
    expect(resolved?.workflow).toBe(historyWorkflow);
    expect(resolved?.filename).toBe('history-p-from-history.json');
    expect(resolved?.source).toEqual({ type: 'history', promptId: 'p-from-history' });
  });

  it('carries hidden history provenance into loaded workflows', () => {
    const historyMap = new Map([
      ['output/private.png', {
        workflow: mockWorkflow,
        promptId: 'hidden-prompt',
        hidden: true,
      }],
    ]);
    const resolved = resolveViewerItemWorkflowLoad({
      src: 'x',
      file: makeFile('output/private.png'),
    }, historyMap);

    expect(resolved?.source).toEqual({
      type: 'history',
      promptId: 'hidden-prompt',
      hidden: true,
    });
  });

  it('prefers item workflow over history map workflow', () => {
    const itemWorkflow = { nodes: [{ id: 11 }], links: [] } as unknown as Workflow;
    const historyWorkflow = { nodes: [{ id: 22 }], links: [] } as unknown as Workflow;
    const historyMap = new Map([
      ['output/sub/dir/img.png', { workflow: historyWorkflow, promptId: 'history-prompt' }],
    ]);
    const item: ViewerImage = {
      src: 'x',
      mediaType: 'image',
      workflow: itemWorkflow,
      file: makeFile('output/sub/dir/img.png'),
    };
    const resolved = resolveViewerItemWorkflowLoad(item, historyMap);
    expect(resolved?.workflow).toBe(itemWorkflow);
  });

  it('uses default workflow filename when item has workflow but no file', () => {
    const item: ViewerImage = {
      src: 'x',
      mediaType: 'image',
      workflow: mockWorkflow,
    };
    const resolved = resolveViewerItemWorkflowLoad(item);
    expect(resolved?.filename).toBe('workflow.json');
    expect(resolved?.source).toEqual({ type: 'other' });
  });
});
