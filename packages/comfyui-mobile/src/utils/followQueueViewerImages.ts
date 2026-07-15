import type { HistoryOutputImage } from '@/api/types';
import type { QueuePromptMetadata } from '@/api/client';
import {
  buildOutputPreferredViewerImages,
  getHistoryImageFileId,
  type HistoryImageItem,
  type ViewerImage,
} from '@/utils/viewerImages';

type FollowQueueHistoryItem = HistoryImageItem & {
  prompt_id?: string;
  timestamp?: number;
};

interface BuildFollowQueueViewerImagesOptions {
  history: FollowQueueHistoryItem[];
  livePromptOutputs: Record<string, HistoryOutputImage[]>;
  localPromptOrder: Record<string, number>;
  promptToSession: Record<string, string>;
  queueMetadata?: Record<string, QueuePromptMetadata>;
  activeSessionId: string | null;
  alt?: string;
}

function sortHistoryNewestFirst(history: FollowQueueHistoryItem[]): FollowQueueHistoryItem[] {
  return [...history].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

function historyOutputKeys(history: FollowQueueHistoryItem[]): Set<string> {
  const keys = new Set<string>();
  for (const item of history) {
    for (const image of item.outputs?.images ?? []) {
      keys.add(getHistoryImageFileId(image));
    }
  }
  return keys;
}

export function buildFollowQueueViewerImages({
  history,
  livePromptOutputs,
  localPromptOrder,
  promptToSession,
  queueMetadata = {},
  activeSessionId,
  alt = 'Generation',
}: BuildFollowQueueViewerImagesOptions): ViewerImage[] {
  const sortedHistory = sortHistoryNewestFirst(history);
  const knownHistoryOutputs = historyOutputKeys(sortedHistory);
  const sessionForPrompt = (promptId: string): string | undefined =>
    promptToSession[promptId] ?? queueMetadata[promptId]?.sessionId;
  const liveItems = Object.entries(livePromptOutputs)
    .filter(([promptId]) => {
      const sessionId = sessionForPrompt(promptId);
      return sessionId == null || sessionId === activeSessionId;
    })
    .map(([promptId, outputs]) => [
      promptId,
      outputs.filter((image) => (
        image.type === 'output' && !knownHistoryOutputs.has(getHistoryImageFileId(image))
      )),
    ] as [string, HistoryOutputImage[]])
    .filter(([, outputs]) => outputs.length > 0)
    .sort(([a], [b]) => (localPromptOrder[b] ?? 0) - (localPromptOrder[a] ?? 0))
    .map(([promptId, outputs]) => ({
      prompt_id: promptId,
      outputs: { images: outputs },
      prompt: {},
    }));

  const livePromptIds = new Set(liveItems.map((item) => item.prompt_id));
  const activeHistoryItems = activeSessionId
    ? sortedHistory.filter((item) => (
      item.prompt_id &&
      sessionForPrompt(item.prompt_id) === activeSessionId &&
      !livePromptIds.has(item.prompt_id)
    ))
    : [];
  const activeHistoryPromptIds = new Set(activeHistoryItems.map((item) => item.prompt_id));
  return buildOutputPreferredViewerImages([
    ...liveItems,
    ...activeHistoryItems,
    ...sortedHistory.filter((item) => (
      !item.prompt_id ||
      (!livePromptIds.has(item.prompt_id) && !activeHistoryPromptIds.has(item.prompt_id))
    )),
  ], { alt });
}
