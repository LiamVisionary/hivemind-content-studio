import { create } from 'zustand';
import * as api from '@/api/client';
import type { HistoryOutputImage, Workflow } from '@/api/types';
import type { PromptQueueRequest } from '@/api/client';
import { useWorkflowStore, getWorkflowSignature } from '@/hooks/useWorkflow';
import { useQueueStore } from '@/hooks/useQueue';
import { useWorkflowErrorsStore } from '@/hooks/useWorkflowErrors';
import { HIDDEN_WORKFLOW_EXTRA_DATA_KEY } from '@/utils/workflowHidden';
import { useOutputsStore } from '@/hooks/useOutputs';
import { bustImageCache } from '@/utils/imageCacheBust';
import { isWorkflow } from '@/utils/imageWorkflowMetadata';
import { decryptWorkflowFromStorage, isEncryptedWorkflow } from '@/utils/workflowEncryption';

// Invalidate the browser cache for a deleted entry's output images so a later
// generation that reuses the same filename doesn't show the stale deleted image.
function bustHistoryEntryImages(entry: HistoryEntry | undefined): void {
  if (!entry) return;
  for (const image of entry.outputs.images) {
    bustImageCache(image.filename, image.subfolder, image.type);
  }
}

// Cheap content signature for a history list. Used to skip the `set({history})`
// when a poll rebuilt an identical list — otherwise every ~2s poll during a run
// hands all queue cards new object identities and re-renders the whole list.
function historySignature(entries: HistoryEntry[]): string {
  const parts: string[] = [];
  for (const e of entries) {
    const imgs = e.outputs.images
      .map((i) => `${i.filename}/${i.subfolder}/${i.type}`)
      .join(',');
    parts.push(
      `${e.prompt_id}:${e.timestamp}:${e.success ? 1 : 0}:${e.interrupted ? 1 : 0}:${e.hidden ? 1 : 0}:${e.errorMessage ?? ''}:${imgs}`,
    );
  }
  return parts.join('|');
}

export interface HistoryEntry {
  prompt_id: string;
  timestamp: number;
  clientId?: string;
  durationSeconds?: number;
  success?: boolean;
  interrupted?: boolean;
  errorMessage?: string | null;
  outputs: {
    images: HistoryOutputImage[];
  };
  outputsByNode?: Record<string, HistoryOutputImage[]>;
  prompt: Record<string, unknown>;
  workflow?: Workflow;
  hidden?: boolean;
  queueRequest?: PromptQueueRequest;
  outputsToExecute?: string[];
}

interface HistoryState {
  history: HistoryEntry[];
  isLoading: boolean;
  // Current number of newest history items being loaded. Grows as the user
  // scrolls the queue (the /history endpoint takes max_items, not an offset, so
  // "load more" refetches a larger newest-N window).
  historyLimit: number;
  // False once the server returned fewer items than requested — no older items
  // remain to load.
  hasMoreHistory: boolean;
  // Real total run count from the backend (independent of how many pages are
  // loaded). Null until first resolved / when the count endpoint is unavailable.
  historyTotal: number | null;

  // Actions
  fetchHistory: (maxItems?: number) => Promise<void>;
  // Grow the loaded window by one page and refetch.
  loadMoreHistory: () => Promise<void>;
  // Internal: the actual fetch body, wrapped by fetchHistory's in-flight dedupe.
  _runFetchHistory: (maxItems: number) => Promise<void>;
  deleteItem: (promptId: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  clearEmptyItems: () => Promise<void>;
  addHistoryEntry: (entry: HistoryEntry) => void;
}

// Two-phase history load: paint the newest few items immediately, then backfill
// the rest in the background. The full /history payload carries every embedded
// workflow and is parsed + post-processed on the main thread, which dominated
// the queue's ~16s initial load.
export const INITIAL_HISTORY_PAGE_SIZE = 10;
// How many more items each "load more" (scroll near the bottom) pulls in.
const HISTORY_PAGE_SIZE = 10;

// Dedupe concurrent fetches of the same page size — the queue mount, the
// post-execution refresh, and several websocket handlers can all fire
// fetchHistory at once, otherwise each pulls the full payload in parallel.
const historyFetchInFlight = new Map<number, Promise<void>>();

// Cheap signature of the RAW /history payload (per page size), so the recurring
// ~2s poll during a run can bail out before the expensive part — building ~50
// HistoryEntry objects (each parsing an embedded workflow), the per-entry
// side-effect pass, and the two list signatures — whenever nothing changed.
// Captures exactly the fields that gate that work: which prompts exist, their
// completion status, and their output count. A real change (a run finishing,
// an item cleared) flips the signature and the full rebuild runs as before.
const lastRawHistorySignatures = new Map<number, string>();

function rawHistorySignature(
  data: Record<string, { status?: { status_str?: string; completed?: boolean }; outputs?: Record<string, unknown> }>,
  promptWorkflows: Record<string, unknown> = {},
): string {
  const parts: string[] = [];
  for (const id of Object.keys(data)) {
    const item = data[id];
    const status = item.status;
    const completed = status?.completed === false ? 0 : 1;
    const promptTuple = Array.isArray((item as { prompt?: unknown }).prompt)
      ? (item as { prompt: unknown[] }).prompt
      : [];
    const extraData = promptTuple[3] && typeof promptTuple[3] === 'object' && !Array.isArray(promptTuple[3])
      ? promptTuple[3] as { extra_pnginfo?: { workflow?: unknown } }
      : {};
    const hasWorkflow = Boolean(extraData.extra_pnginfo?.workflow);
    const hasLocalWorkflow = Object.prototype.hasOwnProperty.call(promptWorkflows, id);
    const outputParts: string[] = [];
    for (const [nodeId, rawOutput] of Object.entries(item.outputs ?? {})) {
      const output = rawOutput && typeof rawOutput === 'object'
        ? rawOutput as {
            images?: Array<{ filename?: unknown; subfolder?: unknown; type?: unknown }>;
            gifs?: Array<{ filename?: unknown; subfolder?: unknown; type?: unknown }>;
            videos?: Array<{ filename?: unknown; subfolder?: unknown; type?: unknown }>;
          }
        : {};
      const media = [
        ...(Array.isArray(output.images) ? output.images : []),
        ...(Array.isArray(output.gifs) ? output.gifs : []),
        ...(Array.isArray(output.videos) ? output.videos : []),
      ].map((file) => `${String(file.filename ?? '')}/${String(file.subfolder ?? '')}/${String(file.type ?? '')}`);
      outputParts.push(`${nodeId}=${media.join(',')}`);
    }
    parts.push(`${id}:${status?.status_str ?? ''}:${completed}:${hasWorkflow || hasLocalWorkflow ? 1 : 0}:${outputParts.join(';')}`);
  }
  return parts.join('|');
}

type DeferredDurationStat = { workflow: Workflow; durationMs: number };

function historyOutputImageKey(image: HistoryOutputImage): string {
  return `${image.filename}/${image.subfolder}/${image.type}`;
}

function hydrateWorkflowNodeOutputsFromHistory(
  entry: HistoryEntry,
  claimedNodeOutputs?: Set<string>,
  options?: { protectedExistingOutputKeys?: Set<string> },
): void {
  const outputsByNode = entry.outputsByNode ?? {};
  const nodeOutputs = Object.fromEntries(
    Object.entries(outputsByNode).filter(([, images]) => images.length > 0),
  );
  if (Object.keys(nodeOutputs).length === 0) return;

  const workflowState = useWorkflowStore.getState();
  const queueState = useQueueStore.getState();
  let sessionId: string | null =
    workflowState.promptToSession[entry.prompt_id] ??
    queueState.shadowQueueJobs[entry.prompt_id]?.sessionId ??
    null;
  if (!sessionId && entry.clientId === api.clientId) {
    sessionId = workflowState.activeSessionId;
  }
  if (!sessionId) return;

  useWorkflowStore.setState((state) => {
    const filterNodeOutputs = (
      existingOutputs: Record<string, HistoryOutputImage[]>,
    ): Record<string, HistoryOutputImage[]> => {
      const filtered: Record<string, HistoryOutputImage[]> = {};
      for (const [nodeId, images] of Object.entries(nodeOutputs)) {
        const claimKey = `${sessionId}:${nodeId}`;
        if (claimedNodeOutputs?.has(claimKey)) continue;
        const existing = existingOutputs[nodeId] ?? [];
        const hasProtectedLiveOutput = existing.some((image) =>
          options?.protectedExistingOutputKeys?.has(historyOutputImageKey(image)),
        );
        if (hasProtectedLiveOutput) {
          claimedNodeOutputs?.add(claimKey);
          continue;
        }
        filtered[nodeId] = images;
        claimedNodeOutputs?.add(claimKey);
      }
      return filtered;
    };

    if (sessionId !== state.activeSessionId) {
      const parked = state.parkedSessions[sessionId];
      if (!parked) return {};
      const nextNodeOutputs = filterNodeOutputs(parked.nodeOutputs);
      if (Object.keys(nextNodeOutputs).length === 0) return {};
      return {
        parkedSessions: {
          ...state.parkedSessions,
          [sessionId]: {
            ...parked,
            nodeOutputs: {
              ...parked.nodeOutputs,
              ...nextNodeOutputs,
            },
          },
        },
      };
    }
    const nextNodeOutputs = filterNodeOutputs(state.nodeOutputs);
    if (Object.keys(nextNodeOutputs).length === 0) return {};
    return {
      nodeOutputs: {
        ...state.nodeOutputs,
        ...nextNodeOutputs,
      },
    };
  });
}

const scheduleIdle: (cb: () => void) => void =
  typeof requestIdleCallback === 'function'
    ? (cb) => { requestIdleCallback(() => cb(), { timeout: 1000 }); }
    : (cb) => { setTimeout(cb, 0); };

// Duration stats only feed run-time estimates, never first paint. Each one is a
// full-workflow sort + JSON.stringify (getWorkflowSignature), so doing ~50 of
// them inline during fetchHistory blocked the load. Defer + chunk them off the
// critical path instead.
function scheduleDurationStatUpdates(updates: DeferredDurationStat[]): void {
  if (updates.length === 0) return;
  const queue = updates.slice();
  const process = () => {
    const store = useWorkflowStore.getState();
    const CHUNK = 8;
    for (let i = 0; i < CHUNK && queue.length > 0; i++) {
      const { workflow, durationMs } = queue.shift()!;
      store.updateWorkflowDuration(getWorkflowSignature(workflow), durationMs);
    }
    if (queue.length > 0) scheduleIdle(process);
  };
  scheduleIdle(process);
}

// Bounded so a long-running session with repeated failures can't leak; it only
// needs to dedupe error toasts for recent prompts.
const NOTIFIED_FAILED_CAP = 200;
const notifiedFailedHistoryPromptIds = new Set<string>();
const markedHiddenOutputIds = new Set<string>();
const MARKED_HIDDEN_OUTPUT_CAP = 1000;

function markFailedNotified(promptId: string): void {
  notifiedFailedHistoryPromptIds.add(promptId);
  // Sets preserve insertion order, so the first entry is the oldest to evict.
  while (notifiedFailedHistoryPromptIds.size > NOTIFIED_FAILED_CAP) {
    const oldest = notifiedFailedHistoryPromptIds.values().next().value;
    if (oldest === undefined) break;
    notifiedFailedHistoryPromptIds.delete(oldest);
  }
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  history: [],
  isLoading: false,
  historyLimit: INITIAL_HISTORY_PAGE_SIZE,
  hasMoreHistory: true,
  historyTotal: null,

  addHistoryEntry: (entry) => {
    set((state) => {
      // Check if exists
      if (state.history.some(h => h.prompt_id === entry.prompt_id)) {
        return state;
      }
      // Add to top
      return { history: [entry, ...state.history] };
    });
    const queueStore = useQueueStore.getState();
    if (queueStore.queueItemExpanded[entry.prompt_id] === undefined) {
      queueStore.setQueueItemExpanded(entry.prompt_id, true);
    }
    if (entry.workflow && entry.durationSeconds) {
      const signature = getWorkflowSignature(entry.workflow);
      useWorkflowStore.getState().updateWorkflowDuration(signature, entry.durationSeconds * 1000);
    }
  },

  fetchHistory: async (maxItems) => {
    // No explicit size → refresh the current loaded window (so background polls
    // and post-run refreshes don't shrink what the user already scrolled to).
    const limit = maxItems ?? get().historyLimit;
    const inFlight = historyFetchInFlight.get(limit);
    if (inFlight) return inFlight;
    const run = get()._runFetchHistory(limit);
    historyFetchInFlight.set(limit, run);
    try {
      await run;
    } finally {
      historyFetchInFlight.delete(limit);
    }
  },

  loadMoreHistory: async () => {
    const { historyLimit, hasMoreHistory, isLoading } = get();
    if (!hasMoreHistory || isLoading) return;
    await get().fetchHistory(historyLimit + HISTORY_PAGE_SIZE);
  },

  _runFetchHistory: async (maxItems: number) => {
    set({ isLoading: true });
    try {
      const queueSnapshot = useQueueStore.getState();
      const queuePromptIds = new Set(
        [
          ...queueSnapshot.running,
          ...queueSnapshot.pending,
          ...queueSnapshot.completing,
        ].map((item) => item.prompt_id),
      );
      const data = await api.getHistory(maxItems);

      // Track the loaded window and whether older items remain. The endpoint
      // returns the newest min(total, maxItems); fewer than requested ⇒ no more.
      const rawCount = Object.keys(data).length;
      set({ historyLimit: maxItems, hasMoreHistory: rawCount >= maxItems });

      // Refresh the real total run count (cheap len-only endpoint) so the header
      // can show it rather than just the loaded page count. Fire-and-forget; a
      // missing endpoint resolves to null and the UI falls back to loaded count.
      void Promise.resolve(api.getHistoryCount?.()).then((count) => {
        if (count != null) set({ historyTotal: count });
      });

      // Skip the heavy rebuild when this page's payload is byte-for-byte
      // equivalent to the last one we processed (the common case for the 2s
      // poll between completions). First appearance of any prompt flips the
      // signature, so completion side-effects still fire exactly once.
      const rawSignature = rawHistorySignature(data, queueSnapshot.promptWorkflows);
      if (
        lastRawHistorySignatures.get(maxItems) === rawSignature &&
        get().history.length > 0
      ) {
        return;
      }
      lastRawHistorySignatures.set(maxItems, rawSignature);

      const asText = (value: unknown): string | null => {
        if (typeof value === "string") {
          const trimmed = value.trim();
          return trimmed.length > 0 ? trimmed : null;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
          return value.toString();
        }
        return null;
      };
      const getExecutionErrorMessage = (msgData: Record<string, unknown>): string | null => {
        const direct = asText(msgData.exception_message) ??
          asText(msgData.error) ??
          asText(msgData.message) ??
          asText(msgData.exception_type);
        if (direct) return direct;
        const details = asText((msgData as { details?: unknown }).details);
        if (details) return details;
        const traceback = asText(msgData.traceback);
        const node = asText(msgData.node_id) || asText(msgData.node);
        if (traceback && node) return `${node}: ${traceback}`;
        if (traceback) return traceback;
        if (node) return `${node}: execution error`;
        return null;
      };

      const entries: HistoryEntry[] = await Promise.all(Object.entries(data).map(async ([prompt_id, item]) => {
        // Collect all images from all output nodes
        const images: HistoryOutputImage[] = [];
        const outputsByNode: Record<string, HistoryOutputImage[]> = {};
        for (const [nodeId, output] of Object.entries(item.outputs)) {
          const nodeImages: HistoryOutputImage[] = [];
          if (output.images) {
            nodeImages.push(...output.images);
          }
          if (output.gifs) {
            nodeImages.push(...output.gifs);
          }
          if (output.videos) {
            nodeImages.push(...output.videos);
          }
          if (nodeImages.length > 0) {
            outputsByNode[nodeId] = nodeImages;
            images.push(...nodeImages);
          }
        }

        // Extract timestamp and duration from status messages if available
        let timestamp = 0;
        let startTime: number | null = null;
        let endTime: number | null = null;
        let failed = false;
        let interrupted = false;
        let errorMessage: string | null = null;
        if (item.status?.messages) {
          for (const [msgType, msgData] of item.status.messages) {
            if (msgType === 'execution_start' && msgData.timestamp) {
              timestamp = msgData.timestamp as number;
              startTime = msgData.timestamp as number;
            }
            if ((msgType === 'execution_end' || msgType === 'execution_success') && msgData.timestamp) {
              endTime = msgData.timestamp as number;
            }
            if (msgType === 'execution_error') {
              failed = true;
              if (typeof msgData === 'object' && msgData !== null && !Array.isArray(msgData)) {
                const nextError = getExecutionErrorMessage(msgData as Record<string, unknown>);
                if (nextError) errorMessage = nextError;
              } else {
                const nextError = asText(msgData as unknown);
                if (nextError) errorMessage = nextError;
              }
            }
            if (msgType === 'execution_interrupted') {
              interrupted = true;
            }
          }
        }

        if (startTime === null && timestamp) {
          startTime = timestamp;
        }
        if (timestamp === 0 && endTime !== null) {
          timestamp = endTime;
        }

        const durationSeconds = (startTime !== null && endTime !== null && endTime >= startTime)
          ? (endTime - startTime) / 1000
          : undefined;
        const statusStr = item.status?.status_str?.toLowerCase() || '';
        const success =
          !failed &&
          !interrupted &&
          item.status?.completed !== false &&
          !statusStr.includes('error');
        if (!success && !errorMessage) {
          const displayStatus = interrupted
            ? 'interrupted'
            : item.status?.status_str?.trim();
          errorMessage = displayStatus
            ? `Execution did not complete (${displayStatus}). Some outputs may be missing.`
            : 'Execution did not complete. Some outputs may be missing.';
        }
        const promptTuple = Array.isArray(item.prompt) ? item.prompt : [];
        const promptGraphValue = promptTuple[2];
        const promptGraph =
          promptGraphValue && typeof promptGraphValue === 'object' && !Array.isArray(promptGraphValue)
            ? promptGraphValue as Record<string, unknown>
            : {};
        const extraDataValue = promptTuple[3];
        const extraData =
          extraDataValue && typeof extraDataValue === 'object' && !Array.isArray(extraDataValue)
            ? extraDataValue as Record<string, unknown>
            : {};
        const outputsToExecute = Array.isArray(promptTuple[4])
          ? promptTuple[4].filter((value): value is string => typeof value === 'string')
          : undefined;
        const embeddedWorkflow = (extraData as { extra_pnginfo?: { workflow?: unknown } } | undefined)?.extra_pnginfo?.workflow;
        const localPromptWorkflow = queueSnapshot.promptWorkflows[prompt_id];
        const resolveWorkflowMetadata = async (metadata: unknown): Promise<Workflow | undefined> => {
          if (isWorkflow(metadata)) return metadata;
          if (isEncryptedWorkflow(metadata)) {
            return decryptWorkflowFromStorage<Workflow>(metadata).catch(() => undefined);
          }
          return undefined;
        };
        const workflow = await resolveWorkflowMetadata(embeddedWorkflow)
          ?? await resolveWorkflowMetadata(localPromptWorkflow);
        const hidden = extraData[HIDDEN_WORKFLOW_EXTRA_DATA_KEY] === true;
        const clientIdValue = extraData.client_id ?? extraData.clientId;
        const clientId = typeof clientIdValue === 'string' ? clientIdValue : undefined;
        const queueRequest = Object.keys(promptGraph).length > 0
          ? { prompt: promptGraph, extra_data: extraData }
          : undefined;

        return {
          prompt_id,
          timestamp,
          clientId,
          durationSeconds,
          success,
          interrupted,
          errorMessage,
          outputs: { images },
          outputsByNode,
          prompt: promptGraph,
          workflow,
          hidden,
          queueRequest,
          outputsToExecute,
        };
      }));

      // Sort by timestamp, newest first
      entries.sort((a, b) => b.timestamp - a.timestamp);

      // Only replace the array (new object identities → re-renders every memoized
      // queue card) when the content actually changed. The derived side-effects
      // below still run on `entries`, but they're idempotent first-appearance work
      // so re-running them while history is unchanged is harmless. Completed
      // entries are stable, so a poll mid-run won't churn the list.
      if (historySignature(entries) !== historySignature(get().history)) {
        set({ history: entries });
      }
      const queueStore = useQueueStore.getState();
      const durationUpdates: DeferredDurationStat[] = [];
      const claimedNodeOutputs = new Set<string>();
      const protectedExistingOutputKeys = new Set(
        Object.values(queueStore.livePromptOutputs)
          .flat()
          .map(historyOutputImageKey),
      );
      for (const entry of entries) {
        if (entry.hidden) {
          for (const output of entry.outputs.images) {
            if (output.type !== 'output') continue;
            const path = output.subfolder
              ? `${output.subfolder}/${output.filename}`
              : output.filename;
            const key = `output/${path}`;
            if (markedHiddenOutputIds.has(key)) continue;
            markedHiddenOutputIds.add(key);
            while (markedHiddenOutputIds.size > MARKED_HIDDEN_OUTPUT_CAP) {
              const oldest = markedHiddenOutputIds.values().next().value;
              if (oldest === undefined) break;
              markedHiddenOutputIds.delete(oldest);
            }
            void api.setFileHidden(path, true, 'output')
              .then(() => useOutputsStore.getState().markItemHiddenLocally(key))
              .catch((error) => {
                markedHiddenOutputIds.delete(key);
                console.warn('Failed to hide output from hidden workflow:', error);
              });
          }
        }
        hydrateWorkflowNodeOutputsFromHistory(entry, claimedNodeOutputs, {
          protectedExistingOutputKeys,
        });
        queueStore.markPromptCompleted(entry.prompt_id);
        // Only surface a failure toast for a prompt the user is actively
        // tracking in the queue (running/pending) — never for past history items.
        // Re-fetching history (e.g. the two-phase initial load, or a websocket
        // refresh) must not resurface an old item's error and mislead the user
        // into thinking it relates to their current workflow. Real-time errors
        // for the current run still come through the websocket execution_error
        // handler.
        if (
          entry.success === false &&
          !entry.interrupted &&
          !notifiedFailedHistoryPromptIds.has(entry.prompt_id) &&
          queuePromptIds.has(entry.prompt_id)
        ) {
          markFailedNotified(entry.prompt_id);
          useWorkflowErrorsStore
            .getState()
            .setError(entry.errorMessage || 'Execution did not complete. Some outputs may be missing.');
        }
        if (queueStore.queueItemExpanded[entry.prompt_id] === undefined) {
          queueStore.setQueueItemExpanded(entry.prompt_id, true);
        }
        if (entry.workflow && entry.durationSeconds) {
          durationUpdates.push({ workflow: entry.workflow, durationMs: entry.durationSeconds * 1000 });
        }
      }
      scheduleDurationStatUpdates(durationUpdates);
    } catch (err) {
      console.error('Failed to fetch history:', err);
    } finally {
      set({ isLoading: false });
    }
  },

  deleteItem: async (promptId) => {
    try {
      await api.deleteHistoryItem(promptId);
      const removed = get().history.find((item) => item.prompt_id === promptId);
      bustHistoryEntryImages(removed);
      set((state) => ({
        history: state.history.filter((item) => item.prompt_id !== promptId),
        historyTotal: state.historyTotal != null ? Math.max(0, state.historyTotal - 1) : null,
      }));
    } catch (err) {
      console.error('Failed to delete history item:', err);
    }
  },

  clearHistory: async () => {
    get().history.forEach(bustHistoryEntryImages);
    try {
      await api.clearHistory();
    } catch (err) {
      console.error('Failed to clear history:', err);
      try {
        const promptIds = get().history.map((item) => item.prompt_id);
        await api.deleteHistoryItems(promptIds);
      } catch (deleteErr) {
        console.error('Failed to delete history items:', deleteErr);
      }
    } finally {
      set({ history: [], historyTotal: 0 });
    }
  },
  clearEmptyItems: async () => {
    const promptIds = get().history
      .filter((item) => item.outputs.images.length === 0)
      .map((item) => item.prompt_id);
    if (promptIds.length === 0) return;
    try {
      await api.deleteHistoryItems(promptIds);
      set((state) => ({
        history: state.history.filter((item) => !promptIds.includes(item.prompt_id)),
        historyTotal: state.historyTotal != null
          ? Math.max(0, state.historyTotal - promptIds.length)
          : null,
      }));
    } catch (err) {
      console.error('Failed to delete empty history items:', err);
    }
  }
}));
