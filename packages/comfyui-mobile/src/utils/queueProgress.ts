type QueueProgressItem = {
  prompt_id?: string;
  extra?: Record<string, unknown>;
};

export function isNativeQueueItem(item: QueueProgressItem): boolean {
  const backend = String(item.extra?.backend || '').toLowerCase();
  return backend.includes('native') || backend.includes('mlx');
}

export function isComfyProgressQueueItem(item: QueueProgressItem): boolean {
  return Boolean(item.prompt_id) && !isNativeQueueItem(item);
}

export function selectSingleComfyProgressPromptId(
  items: QueueProgressItem[],
): string | null {
  const eligible = items.filter(isComfyProgressQueueItem);
  return eligible.length === 1 ? eligible[0].prompt_id ?? null : null;
}
