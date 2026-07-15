import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { History, HistoryItem, Workflow } from '@/api/types';
import { useHistoryStore } from '@/hooks/useHistory';
import { useQueueStore } from '@/hooks/useQueue';
import { useWorkflowStore } from '@/hooks/useWorkflow';
import { useWorkflowErrorsStore } from '@/hooks/useWorkflowErrors';
import { getHistory, setFileHidden } from '@/api/client';
import { HIDDEN_WORKFLOW_EXTRA_DATA_KEY } from '@/utils/workflowHidden';

vi.mock('@/api/client', () => ({
  clientId: 'test-client',
  getHistory: vi.fn(),
  getHistoryCount: vi.fn().mockResolvedValue(null),
  deleteHistoryItem: vi.fn(),
  clearHistory: vi.fn(),
  deleteHistoryItems: vi.fn(),
  setFileHidden: vi.fn().mockResolvedValue(undefined),
}));

const mockGetHistory = vi.mocked(getHistory);
const mockSetFileHidden = vi.mocked(setFileHidden);

function makeHistoryItem(
  promptId: string,
  status: HistoryItem['status'],
): HistoryItem {
  return {
    prompt: [1, promptId, {}, {}, []],
    outputs: {
      '9': {
        videos: [
          {
            filename: `${promptId}.mp4`,
            subfolder: '',
            type: 'output',
          },
        ],
      },
    },
    status,
  };
}

function makeWorkflow(label: string): Workflow {
  return {
    last_node_id: 1,
    last_link_id: 0,
    nodes: [
      {
        id: 1,
        title: label,
        type: 'SaveImage',
        pos: [0, 0],
        size: [100, 60],
        flags: {},
        order: 0,
        mode: 0,
        inputs: [],
        outputs: [],
        properties: {},
        widgets_values: [label],
      },
    ],
    links: [],
    groups: [],
    config: {},
    version: 0.4,
  };
}

beforeEach(() => {
  mockGetHistory.mockReset();
  mockSetFileHidden.mockClear();
  useHistoryStore.setState({
    history: [],
    isLoading: false,
  });
  useQueueStore.setState({
    running: [],
    pending: [],
    completing: [],
    isLoading: false,
    lastExecutedId: null,
    localPromptOrder: {},
    nextLocalPromptOrder: 1,
    livePromptOutputs: {},
    queueItemExpanded: {},
    queueItemUserToggled: {},
    queueItemHideImages: {},
    showQueueMetadata: false,
    previewVisibility: {},
    previewVisibilityDefault: false,
    promptWorkflows: {},
    shadowQueueJobs: {},
  });
  useWorkflowStore.setState({
    activeSessionId: 'active-session',
    promptToSession: {},
    nodeOutputs: {},
    parkedSessions: {},
  });
  useWorkflowErrorsStore.setState({
    error: null,
    nodeErrors: {},
    errorCycleIndex: 0,
    errorsDismissed: false,
  });
});

describe('useHistoryStore', () => {
  it('warns when an observed prompt lands in history as incomplete without an execution error', async () => {
    const promptId = 'observed-incomplete-prompt';
    useQueueStore.setState({
      running: [
        {
          number: 1,
          prompt_id: promptId,
          prompt: {},
          extra: {},
          outputs_to_execute: [],
        },
      ],
    });
    mockGetHistory.mockResolvedValue({
      [promptId]: makeHistoryItem(promptId, {
        status_str: 'interrupted',
        completed: false,
        messages: [
          ['execution_start', { timestamp: 1000 }],
          ['execution_end', { timestamp: 2500 }],
        ],
      }),
    } satisfies History);

    await useHistoryStore.getState().fetchHistory();

    const [entry] = useHistoryStore.getState().history;
    expect(entry).toMatchObject({
      prompt_id: promptId,
      success: false,
      errorMessage: 'Execution did not complete (interrupted). Some outputs may be missing.',
      durationSeconds: 1.5,
    });
    expect(entry.outputs.images).toEqual([
      {
        filename: `${promptId}.mp4`,
        subfolder: '',
        type: 'output',
      },
    ]);
    expect(useWorkflowErrorsStore.getState().error).toBe(
      'Execution did not complete (interrupted). Some outputs may be missing.',
    );
  });

  it('skips the heavy rebuild when a repeat poll returns an unchanged payload', async () => {
    const item = makeHistoryItem('p1', { status_str: 'success', completed: true, messages: [] });
    mockGetHistory.mockResolvedValue({ p1: item } satisfies History);
    const markSpy = vi.spyOn(useQueueStore.getState(), 'markPromptCompleted');

    await useHistoryStore.getState().fetchHistory();
    expect(useHistoryStore.getState().history).toHaveLength(1);
    const callsAfterFirst = markSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Identical payload on the next ~2s poll → no per-entry reprocessing.
    await useHistoryStore.getState().fetchHistory();
    expect(markSpy.mock.calls.length).toBe(callsAfterFirst);

    // A genuinely changed payload (another run finished) is processed again.
    mockGetHistory.mockResolvedValue({
      p1: item,
      p2: makeHistoryItem('p2', { status_str: 'success', completed: true, messages: [] }),
    } satisfies History);
    await useHistoryStore.getState().fetchHistory();
    expect(useHistoryStore.getState().history).toHaveLength(2);
    expect(markSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);

    markSpy.mockRestore();
  });

  it('rebuilds when a history output node gains its image filename after an early poll', async () => {
    const empty = makeHistoryItem('late-image', {
      status_str: 'success',
      completed: true,
      messages: [],
    });
    empty.outputs = { '9': {} };
    const filled = makeHistoryItem('late-image', {
      status_str: 'success',
      completed: true,
      messages: [],
    });
    filled.outputs = {
      '9': {
        images: [{ filename: 'late-image.png', subfolder: '', type: 'output' }],
      },
    };
    mockGetHistory
      .mockResolvedValueOnce({ 'late-image': empty })
      .mockResolvedValueOnce({ 'late-image': filled });

    await useHistoryStore.getState().fetchHistory();
    expect(useHistoryStore.getState().history[0].outputs.images).toEqual([]);

    await useHistoryStore.getState().fetchHistory();
    expect(useHistoryStore.getState().history[0].outputs.images).toEqual([
      { filename: 'late-image.png', subfolder: '', type: 'output' },
    ]);
  });

  it('retains the backend prompt payload for exact re-enqueue', async () => {
    const promptId = 'stopped-prompt';
    const prompt = { '1': { class_type: 'Sampler', inputs: { seed: 42 } } };
    const extraData = { custom: 'preserved' };
    const item = makeHistoryItem(promptId, {
      status_str: 'interrupted',
      completed: false,
      messages: [],
    });
    item.prompt = [7, promptId, prompt, extraData, ['9']];
    mockGetHistory.mockResolvedValue({ [promptId]: item });

    await useHistoryStore.getState().fetchHistory();

    expect(useHistoryStore.getState().history[0]).toMatchObject({
      queueRequest: {
        prompt,
        extra_data: extraData,
      },
      outputsToExecute: ['9'],
    });
  });

  it('recovers workflow metadata from the queued prompt cache when history omits it', async () => {
    const promptId = 'native-history-without-workflow';
    const cachedWorkflow = makeWorkflow('cached-native-submit-workflow');
    const item = makeHistoryItem(promptId, {
      status_str: 'success',
      completed: true,
      messages: [],
    });
    item.prompt = [7, promptId, {}, {}, ['9']];
    useQueueStore.setState({
      promptWorkflows: {
        [promptId]: cachedWorkflow,
      },
    });
    mockGetHistory.mockResolvedValue({ [promptId]: item });

    await useHistoryStore.getState().fetchHistory();

    expect(useHistoryStore.getState().history[0].workflow).toEqual(cachedWorkflow);
  });

  it('hydrates workflow node outputs from completed history when websocket output events are absent', async () => {
    const promptId = 'anima-history-prompt';
    const output = {
      filename: 'anima_wai_couple_turbo_fast_00006_.png',
      subfolder: '',
      type: 'output',
    };
    const item = makeHistoryItem(promptId, {
      status_str: 'success',
      completed: true,
      messages: [],
    });
    item.outputs = {
      '9': {
        images: [output],
      },
    };
    useWorkflowStore.setState({
      activeSessionId: 'active-session',
      promptToSession: { [promptId]: 'active-session' },
      nodeOutputs: {},
    });
    mockGetHistory.mockResolvedValue({ [promptId]: item });

    await useHistoryStore.getState().fetchHistory();

    expect(useWorkflowStore.getState().nodeOutputs['9']).toEqual([output]);
  });

  it('hydrates current-client history outputs into the active session when prompt routing was lost', async () => {
    const promptId = 'same-client-history-prompt';
    const output = {
      filename: 'same_client_output.png',
      subfolder: '',
      type: 'output',
    };
    const item = makeHistoryItem(promptId, {
      status_str: 'success',
      completed: true,
      messages: [],
    });
    item.prompt = [1, promptId, {}, { client_id: 'test-client' }, ['9']];
    item.outputs = {
      '9': {
        images: [output],
      },
    };
    useWorkflowStore.setState({
      activeSessionId: 'active-session',
      promptToSession: {},
      nodeOutputs: {},
    });
    mockGetHistory.mockResolvedValue({ [promptId]: item });

    await useHistoryStore.getState().fetchHistory();

    expect(useWorkflowStore.getState().nodeOutputs['9']).toEqual([output]);
  });

  it('keeps the newest history output for a node when older entries share the same output node id', async () => {
    const oldOutput = {
      filename: 'old_save_image.png',
      subfolder: '',
      type: 'output',
    };
    const newOutput = {
      filename: 'new_save_image.png',
      subfolder: '',
      type: 'output',
    };
    const oldItem = makeHistoryItem('old-node-output-prompt', {
      status_str: 'success',
      completed: true,
      messages: [
        ['execution_start', { timestamp: 1_000 }],
        ['execution_success', { timestamp: 1_100 }],
      ],
    });
    oldItem.outputs = { '9': { images: [oldOutput] } };
    const newItem = makeHistoryItem('new-node-output-prompt', {
      status_str: 'success',
      completed: true,
      messages: [
        ['execution_start', { timestamp: 2_000 }],
        ['execution_success', { timestamp: 2_100 }],
      ],
    });
    newItem.outputs = { '9': { images: [newOutput] } };
    useWorkflowStore.setState({
      activeSessionId: 'active-session',
      promptToSession: {
        'old-node-output-prompt': 'active-session',
        'new-node-output-prompt': 'active-session',
      },
      nodeOutputs: {},
    });
    mockGetHistory.mockResolvedValue({
      'old-node-output-prompt': oldItem,
      'new-node-output-prompt': newItem,
    });

    await useHistoryStore.getState().fetchHistory();

    expect(useWorkflowStore.getState().nodeOutputs['9']).toEqual([newOutput]);
  });

  it('does not let an older history poll replace a live websocket node output', async () => {
    const liveOutput = {
      filename: 'fresh_live_save_image.png',
      subfolder: '',
      type: 'output',
    };
    const oldOutput = {
      filename: 'old_history_save_image.png',
      subfolder: '',
      type: 'output',
    };
    const oldItem = makeHistoryItem('old-history-while-live-prompt', {
      status_str: 'success',
      completed: true,
      messages: [
        ['execution_start', { timestamp: 1_000 }],
        ['execution_success', { timestamp: 1_100 }],
      ],
    });
    oldItem.outputs = { '9': { images: [oldOutput] } };
    useWorkflowStore.setState({
      activeSessionId: 'active-session',
      promptToSession: {
        'old-history-while-live-prompt': 'active-session',
      },
      nodeOutputs: { '9': [liveOutput] },
    });
    useQueueStore.setState({
      livePromptOutputs: {
        'fresh-live-prompt': [liveOutput],
      },
    });
    mockGetHistory.mockResolvedValue({
      'old-history-while-live-prompt': oldItem,
    });

    await useHistoryStore.getState().fetchHistory();

    expect(useWorkflowStore.getState().nodeOutputs['9']).toEqual([liveOutput]);
  });

  it('keeps the history array identity when a refetch returns identical content', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const item = makeHistoryItem('stable-1', { status_str: 'success', completed: true, messages: [] });
      mockGetHistory.mockResolvedValue({ 'stable-1': item });

      await useHistoryStore.getState().fetchHistory();
      const first = useHistoryStore.getState().history;
      expect(first).toHaveLength(1);

      // Same backend payload → unchanged content → the array identity is preserved,
      // so memoized queue cards don't re-render on every ~2s poll during a run.
      await useHistoryStore.getState().fetchHistory();
      expect(useHistoryStore.getState().history).toBe(first);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not let untimestamped file fallback rows outrank real executions', async () => {
    const realItem = makeHistoryItem('real-execution', {
      status_str: 'success',
      completed: true,
      messages: [
        ['execution_start', { timestamp: 2_000 }],
        ['execution_success', { timestamp: 2_500 }],
      ],
    });
    const fileFallback = makeHistoryItem('file-fallback', {
      status_str: 'success',
      completed: true,
      messages: [],
    });
    mockGetHistory.mockResolvedValue({
      'file-fallback': fileFallback,
      'real-execution': realItem,
    });

    await useHistoryStore.getState().fetchHistory();

    expect(useHistoryStore.getState().history.map((entry) => entry.prompt_id)).toEqual([
      'real-execution',
      'file-fallback',
    ]);
    expect(useHistoryStore.getState().history[1].timestamp).toBe(0);
  });

  it('replaces the history array when content actually changes', async () => {
    const item1 = makeHistoryItem('p1', { status_str: 'success', completed: true, messages: [] });
    mockGetHistory.mockResolvedValue({ p1: item1 });
    await useHistoryStore.getState().fetchHistory();
    const first = useHistoryStore.getState().history;

    const item2 = makeHistoryItem('p2', { status_str: 'success', completed: true, messages: [] });
    mockGetHistory.mockResolvedValue({ p1: item1, p2: item2 });
    await useHistoryStore.getState().fetchHistory();
    const second = useHistoryStore.getState().history;

    expect(second).not.toBe(first);
    expect(second).toHaveLength(2);
  });

  it('marks outputs from hidden workflows as hidden', async () => {
    const promptId = 'hidden-workflow-prompt';
    const item = makeHistoryItem(promptId, {
      status_str: 'success',
      completed: true,
      messages: [],
    });
    item.prompt[3] = { [HIDDEN_WORKFLOW_EXTRA_DATA_KEY]: true } as unknown as Record<string, string>;
    item.outputs['9'].videos![0].subfolder = 'private';
    mockGetHistory.mockResolvedValue({ [promptId]: item });

    await useHistoryStore.getState().fetchHistory();

    expect(useHistoryStore.getState().history[0].hidden).toBe(true);
    expect(mockSetFileHidden).toHaveBeenCalledWith(
      `private/${promptId}.mp4`,
      true,
      'output',
    );
  });

  it('does not toast old incomplete history entries found on initial load', async () => {
    const promptId = 'old-incomplete-prompt';
    mockGetHistory.mockResolvedValue({
      [promptId]: makeHistoryItem(promptId, {
        status_str: 'interrupted',
        completed: false,
        messages: [
          ['execution_start', { timestamp: 1000 }],
          ['execution_end', { timestamp: 2500 }],
        ],
      }),
    } satisfies History);

    await useHistoryStore.getState().fetchHistory();

    expect(useHistoryStore.getState().history[0]).toMatchObject({
      prompt_id: promptId,
      success: false,
      errorMessage: 'Execution did not complete (interrupted). Some outputs may be missing.',
    });
    expect(useWorkflowErrorsStore.getState().error).toBeNull();
  });

  it('labels explicit interruptions without raising a prompt error toast', async () => {
    const promptId = 'interrupted-prompt';
    useQueueStore.setState({
      running: [
        {
          number: 1,
          prompt_id: promptId,
          prompt: {},
          extra: {},
          outputs_to_execute: [],
        },
      ],
    });
    mockGetHistory.mockResolvedValue({
      [promptId]: makeHistoryItem(promptId, {
        status_str: 'error',
        completed: false,
        messages: [
          ['execution_start', { timestamp: 1000 }],
          ['execution_interrupted', {
            prompt_id: promptId,
            node_id: '9',
            timestamp: 2500,
          }],
        ],
      }),
    } satisfies History);

    await useHistoryStore.getState().fetchHistory();

    expect(useHistoryStore.getState().history[0]).toMatchObject({
      prompt_id: promptId,
      success: false,
      interrupted: true,
      errorMessage: 'Execution did not complete (interrupted). Some outputs may be missing.',
    });
    expect(useWorkflowErrorsStore.getState().error).toBeNull();
  });

  it('keeps explicit execution error messages when ComfyUI provides them', async () => {
    const promptId = 'execution-error-prompt';
    useQueueStore.setState({
      pending: [
        {
          number: 2,
          prompt_id: promptId,
          prompt: {},
          extra: {},
          outputs_to_execute: [],
        },
      ],
    });
    mockGetHistory.mockResolvedValue({
      [promptId]: makeHistoryItem(promptId, {
        status_str: 'error',
        completed: false,
        messages: [
          ['execution_start', { timestamp: 1000 }],
          ['execution_error', { exception_message: 'Video combine failed' }],
        ],
      }),
    } satisfies History);

    await useHistoryStore.getState().fetchHistory();

    expect(useHistoryStore.getState().history[0]).toMatchObject({
      prompt_id: promptId,
      success: false,
      errorMessage: 'Video combine failed',
    });
    expect(useWorkflowErrorsStore.getState().error).toBe('Video combine failed');
  });

  it('surfaces explicit execution errors for prompts already moved to completing', async () => {
    const promptId = 'completing-error-prompt';
    useQueueStore.setState({
      completing: [
        {
          number: 3,
          prompt_id: promptId,
          prompt: {},
          extra: {},
          outputs_to_execute: ['94'],
        },
      ],
    });
    mockGetHistory.mockResolvedValue({
      [promptId]: makeHistoryItem(promptId, {
        status_str: 'error',
        completed: false,
        messages: [
          ['execution_start', { timestamp: 1000 }],
          ['execution_error', { exception_message: 'Missing MXFP8 block scales' }],
        ],
      }),
    } satisfies History);

    await useHistoryStore.getState().fetchHistory();

    expect(useWorkflowErrorsStore.getState().error).toBe('Missing MXFP8 block scales');
  });

  it('does not resurface an old failed item across a two-phase / repeated fetch', async () => {
    // Regression: the two-phase initial load (small page then full backfill)
    // re-runs fetchHistory, so the second fetch sees the first page as prior
    // history. An old failed item NOT in the queue must stay silent on every
    // fetch, otherwise its error is misattributed to the current workflow.
    const promptId = 'old-errored-prompt';
    mockGetHistory.mockResolvedValue({
      [promptId]: makeHistoryItem(promptId, {
        status_str: 'error',
        completed: false,
        messages: [
          ['execution_start', { timestamp: 1000 }],
          ['execution_error', { exception_message: 'clip input is invalid: None' }],
        ],
      }),
    } satisfies History);

    // Phase 1 (small page) then phase 2 (backfill) — both see no queue entry.
    await useHistoryStore.getState().fetchHistory(5);
    await useHistoryStore.getState().fetchHistory();

    expect(useHistoryStore.getState().history[0]).toMatchObject({
      prompt_id: promptId,
      success: false,
      errorMessage: 'clip input is invalid: None',
    });
    expect(useWorkflowErrorsStore.getState().error).toBeNull();
  });
});
