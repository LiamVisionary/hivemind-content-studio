import { describe, expect, it } from 'vitest';
import type { HistoryOutputImage } from '@/api/types';
import { buildFollowQueueViewerImages } from '@/utils/followQueueViewerImages';
import type { HistoryImageItem } from '@/utils/viewerImages';

type TestHistoryItem = HistoryImageItem & {
  prompt_id: string;
  timestamp: number;
};

const output = (filename: string): HistoryOutputImage => ({
  filename,
  subfolder: '',
  type: 'output',
});

const historyItem = (promptId: string, timestamp: number, filename: string): TestHistoryItem => ({
  prompt_id: promptId,
  timestamp,
  outputs: { images: [output(filename)] },
  prompt: {},
});

describe('buildFollowQueueViewerImages', () => {
  it('sorts history newest first before opening the queue viewer', () => {
    const images = buildFollowQueueViewerImages({
      history: [
        historyItem('old', 100, 'first-generation.png'),
        historyItem('new', 300, 'latest-generation.png'),
        historyItem('middle', 200, 'middle-generation.png'),
      ],
      livePromptOutputs: {},
      localPromptOrder: {},
      promptToSession: {},
      activeSessionId: null,
    });

    expect(images.map((image) => image.filename)).toEqual([
      'latest-generation.png',
      'middle-generation.png',
      'first-generation.png',
    ]);
  });

  it('prefers a fresh live final output before history has caught up', () => {
    const images = buildFollowQueueViewerImages({
      history: [
        historyItem('old', 100, 'old-history.png'),
      ],
      livePromptOutputs: {
        latest: [output('latest-live.png')],
      },
      localPromptOrder: {
        old: 1,
        latest: 2,
      },
      promptToSession: {},
      activeSessionId: null,
    });

    expect(images[0]).toMatchObject({
      filename: 'latest-live.png',
      promptId: 'latest',
    });
  });

  it('does not duplicate a live output that already exists in history', () => {
    const images = buildFollowQueueViewerImages({
      history: [
        historyItem('latest', 300, 'already-in-history.png'),
        historyItem('old', 100, 'old-history.png'),
      ],
      livePromptOutputs: {
        latest: [output('already-in-history.png')],
      },
      localPromptOrder: {
        latest: 2,
      },
      promptToSession: {},
      activeSessionId: null,
    });

    expect(images.map((image) => image.filename)).toEqual([
      'already-in-history.png',
      'old-history.png',
    ]);
  });

  it('puts the active workflow session history before newer global history', () => {
    const images = buildFollowQueueViewerImages({
      history: [
        historyItem('other-session', 500, 'newer-other-workflow.png'),
        historyItem('active-session-prompt', 200, 'active-workflow.png'),
      ],
      livePromptOutputs: {},
      localPromptOrder: {},
      promptToSession: {
        'other-session': 'session-B',
        'active-session-prompt': 'session-A',
      },
      activeSessionId: 'session-A',
    });

    expect(images.map((image) => image.filename)).toEqual([
      'active-workflow.png',
      'newer-other-workflow.png',
    ]);
  });

  it('uses durable queue metadata session ids when volatile prompt mapping is missing', () => {
    const images = buildFollowQueueViewerImages({
      history: [
        historyItem('newer-other-workflow', 500, 'newer-other-workflow.png'),
        historyItem('active-from-metadata', 200, 'active-from-metadata.png'),
      ],
      livePromptOutputs: {},
      localPromptOrder: {},
      promptToSession: {},
      queueMetadata: {
        'newer-other-workflow': {
          promptId: 'newer-other-workflow',
          sessionId: 'session-B',
        },
        'active-from-metadata': {
          promptId: 'active-from-metadata',
          sessionId: 'session-A',
        },
      },
      activeSessionId: 'session-A',
    });

    expect(images.map((image) => image.filename)).toEqual([
      'active-from-metadata.png',
      'newer-other-workflow.png',
    ]);
  });
});
