import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { RealtimeCallbacks, WorkflowSnapshot } from './workflow-realtime.types';
import { useWorkflowRealtimeCollection } from './use-workflow-realtime';

const realtime = vi.hoisted(() => ({
  clients: [] as Array<{
    callbacks: RealtimeCallbacks;
    start: Mock<() => Promise<void>>;
    stop: Mock<() => void>;
    workflowRunId: string;
  }>,
}));

vi.mock('./workflow-realtime.client', () => ({
  WorkflowRealtimeClient: class {
    readonly client: (typeof realtime.clients)[number];

    constructor(workflowRunId: string, callbacks: RealtimeCallbacks) {
      this.client = {
        callbacks,
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        workflowRunId,
      };
      realtime.clients.push(this.client);
    }

    start() {
      return this.client.start();
    }

    stop() {
      this.client.stop();
    }
  },
}));

describe('useWorkflowRealtimeCollection', () => {
  beforeEach(() => {
    realtime.clients.length = 0;
  });

  it('keeps earlier workflow snapshots while a newer workflow is added', async () => {
    const { result, rerender } = renderHook(
      ({ workflowRunIds }) => useWorkflowRealtimeCollection(workflowRunIds),
      { initialProps: { workflowRunIds: ['workflow-a'] } },
    );
    await waitFor(() => expect(realtime.clients).toHaveLength(1));
    act(() => realtime.clients[0]!.callbacks.onSnapshot(workflowSnapshot('workflow-a')));

    rerender({ workflowRunIds: ['workflow-a', 'workflow-b'] });
    await waitFor(() => expect(realtime.clients).toHaveLength(2));
    act(() => realtime.clients[1]!.callbacks.onSnapshot(workflowSnapshot('workflow-b')));

    expect(Object.keys(result.current.snapshots).sort()).toEqual(['workflow-a', 'workflow-b']);
    expect(realtime.clients[0]!.stop).not.toHaveBeenCalled();

    rerender({ workflowRunIds: ['workflow-b'] });
    await waitFor(() => expect(result.current.snapshots['workflow-a']).toBeUndefined());
    expect(realtime.clients[0]!.stop).toHaveBeenCalledOnce();
    expect(result.current.snapshots['workflow-b']?.workflow_run.id).toBe('workflow-b');
  });

  it('keeps a terminal snapshot but closes its realtime connection', async () => {
    const { result } = renderHook(() => useWorkflowRealtimeCollection(['workflow-terminal']));
    await waitFor(() => expect(realtime.clients).toHaveLength(1));

    act(() =>
      realtime.clients[0]!.callbacks.onSnapshot(
        workflowSnapshot('workflow-terminal', { status: 'failed' }),
      ),
    );

    expect(result.current.snapshots['workflow-terminal']?.workflow_run.status).toBe('failed');
    expect(realtime.clients[0]!.stop).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'succeeded', 'cancelled', 'refunded'])(
    'waits for the authoritative snapshot after a %s workflow event',
    async (status) => {
      const { result } = renderHook(() => useWorkflowRealtimeCollection(['workflow-terminal']));
      await waitFor(() => expect(realtime.clients).toHaveLength(1));
      const client = realtime.clients[0]!;
      act(() => client.callbacks.onSnapshot(workflowSnapshot('workflow-terminal')));
      act(() =>
        client.callbacks.onEvent({
          schema_version: 1,
          scope: 'workflow_run:workflow-terminal',
          event_seq: 2,
          event_type: 'workflow.status_changed',
          occurred_at: '2026-08-17T08:00:01.000Z',
          payload: { from: 'running', to: status },
        }),
      );

      expect(result.current.snapshots['workflow-terminal']?.workflow_run.status).toBe(status);
      expect(client.stop).not.toHaveBeenCalled();

      const finalSnapshot = workflowSnapshot('workflow-terminal', { status });
      finalSnapshot.last_event_seq = 2;
      finalSnapshot.tasks = [
        {
          id: 'failed-image',
          type: 'image.edit',
          status: 'failed',
          error_code: 'provider_timeout',
          output_count: 1,
          retryable: true,
          latest_retry: null,
          created_at: '2026-08-17T08:00:00.000Z',
          started_at: '2026-08-17T08:00:00.000Z',
          ended_at: '2026-08-17T08:00:01.000Z',
          latest_attempt: { id: 'attempt', attempt_no: 1, status: 'failed' },
        },
      ];
      act(() => client.callbacks.onSnapshot(finalSnapshot));

      expect(result.current.snapshots['workflow-terminal']?.tasks[0]?.retryable).toBe(true);
      expect(client.stop).toHaveBeenCalledOnce();
    },
  );
});

function workflowSnapshot(
  workflowRunId: string,
  overrides: { status?: WorkflowSnapshot['workflow_run']['status'] } = {},
): WorkflowSnapshot {
  return {
    workflow_run: {
      id: workflowRunId,
      status: overrides.status ?? 'running',
      trigger_mode: 'agent',
      created_at: '2026-08-17T08:00:00.000Z',
      finished_at: null,
    },
    tasks: [],
    last_event_seq: 1,
    credit_summary: null,
    artifacts: [],
  };
}
