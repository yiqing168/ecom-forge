import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WorkflowRealtimeClient } from './workflow-realtime.client';
import type { RealtimeCallbacks, WorkflowSnapshot } from './workflow-realtime.types';

const runId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const snapshot: WorkflowSnapshot = {
  workflow_run: {
    id: runId,
    status: 'queued',
    trigger_mode: 'chat',
    created_at: '2026-08-11T00:00:00.000Z',
    finished_at: null,
  },
  tasks: [
    {
      id: taskId,
      type: 'image.generate',
      status: 'queued',
      error_code: null,
      output_count: 1,
      created_at: '2026-08-11T00:00:00.000Z',
      started_at: null,
      ended_at: null,
      latest_attempt: null,
    },
  ],
  last_event_seq: 1,
  credit_summary: null,
  artifacts: [],
};

function callbacks() {
  return {
    onStatus: vi.fn<RealtimeCallbacks['onStatus']>(),
    onSnapshot: vi.fn<RealtimeCallbacks['onSnapshot']>(),
    onEvent: vi.fn<RealtimeCallbacks['onEvent']>(),
    onAuthenticationRequired: vi.fn<RealtimeCallbacks['onAuthenticationRequired']>(),
    onUnavailable: vi.fn<RealtimeCallbacks['onUnavailable']>(),
  };
}

describe('WorkflowRealtimeClient', () => {
  it('loads a snapshot first and applies an ordered streamed event', async () => {
    const handlers = callbacks();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `id: 2\nevent: task.status_changed\ndata: ${JSON.stringify({
              schema_version: 1,
              scope: `workflow_run:${runId}`,
              event_seq: 2,
              event_type: 'task.status_changed',
              occurred_at: '2026-08-11T00:00:01.000Z',
              payload: { task_id: taskId, from: 'queued', to: 'running' },
            })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(new Response(stream, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ ...snapshot, last_event_seq: 2 }));
    const client = new WorkflowRealtimeClient(runId, handlers, { fetcher });

    await client.start();
    await waitFor(() => expect(handlers.onEvent).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0]?.[0]).toContain(`/workflow-runs/${runId}`);
    expect(fetcher.mock.calls[1]?.[0]).toContain('last_event_seq=1');
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher.mock.calls[2]?.[0]).toContain(`/workflow-runs/${runId}`);
    expect(handlers.onStatus).toHaveBeenCalledWith('live');
    client.stop();
  });

  it('stops retrying when the snapshot session is missing', async () => {
    const handlers = callbacks();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const client = new WorkflowRealtimeClient(runId, handlers, { fetcher });

    await client.start();
    expect(handlers.onAuthenticationRequired).toHaveBeenCalledTimes(1);
    expect(handlers.onStatus).toHaveBeenLastCalledWith('closed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('loads retry eligibility after the terminal workflow event even when an older task refresh is delayed', async () => {
    const handlers = callbacks();
    const finalSnapshot: WorkflowSnapshot = {
      ...snapshot,
      workflow_run: { ...snapshot.workflow_run, status: 'failed' },
      tasks: [{ ...snapshot.tasks[0]!, status: 'failed', retryable: true, latest_retry: null }],
      last_event_seq: 3,
    };
    const stream = streamOf(
      {
        id: '2',
        event: 'task.status_changed',
        data: {
          schema_version: 1,
          scope: `workflow_run:${runId}`,
          event_seq: 2,
          event_type: 'task.status_changed',
          occurred_at: '2026-08-11T00:00:01.000Z',
          payload: { task_id: taskId, from: 'queued', to: 'failed' },
        },
      },
      {
        id: '3',
        event: 'workflow.status_changed',
        data: {
          schema_version: 1,
          scope: `workflow_run:${runId}`,
          event_seq: 3,
          event_type: 'workflow.status_changed',
          occurred_at: '2026-08-11T00:00:02.000Z',
          payload: { from: 'queued', to: 'failed' },
        },
      },
    );
    let resolveTaskRefresh!: (response: Response) => void;
    const taskRefresh = new Promise<Response>((resolve) => {
      resolveTaskRefresh = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(new Response(stream, { status: 200 }))
      .mockReturnValueOnce(taskRefresh)
      .mockResolvedValueOnce(Response.json(finalSnapshot));
    const client = new WorkflowRealtimeClient(runId, handlers, { fetcher });
    handlers.onSnapshot.mockImplementation((next) => {
      if (next.workflow_run.status === 'failed') client.stop();
    });

    try {
      await client.start();
      await waitFor(() => expect(handlers.onSnapshot).toHaveBeenLastCalledWith(finalSnapshot));
      expect(handlers.onEvent).toHaveBeenCalledTimes(2);
      expect(handlers.onStatus).toHaveBeenLastCalledWith('closed');
      resolveTaskRefresh(Response.json({ ...snapshot, last_event_seq: 2 }));
      await taskRefresh;
      expect(handlers.onSnapshot).toHaveBeenCalledTimes(2);
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      resolveTaskRefresh(Response.json(snapshot));
      client.stop();
    }
  });

  it('stops permanently when the workflow is unavailable', async () => {
    const handlers = callbacks();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    const client = new WorkflowRealtimeClient(runId, handlers, { fetcher });

    await client.start();

    expect(handlers.onUnavailable).toHaveBeenCalledTimes(1);
    expect(handlers.onAuthenticationRequired).not.toHaveBeenCalled();
    expect(handlers.onStatus).toHaveBeenLastCalledWith('closed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('recovers from an event gap with a fresh snapshot', async () => {
    const handlers = callbacks();
    const gapStream = streamOf({
      id: '3',
      event: 'workflow.status_changed',
      data: {
        schema_version: 1,
        scope: `workflow_run:${runId}`,
        event_seq: 3,
        event_type: 'workflow.status_changed',
        occurred_at: '2026-08-11T00:00:02.000Z',
        payload: { from: 'queued', to: 'running' },
      },
    });
    const recoveredSnapshot = {
      ...snapshot,
      workflow_run: { ...snapshot.workflow_run, status: 'running' },
      last_event_seq: 3,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(new Response(gapStream, { status: 200 }))
      .mockResolvedValueOnce(Response.json(recoveredSnapshot));
    const client = new WorkflowRealtimeClient(runId, handlers, { fetcher, random: () => 0 });

    await client.start();
    await waitFor(() => expect(handlers.onSnapshot).toHaveBeenCalledTimes(2), { timeout: 2_000 });

    expect(handlers.onSnapshot).toHaveBeenLastCalledWith(recoveredSnapshot);
    expect(handlers.onEvent).not.toHaveBeenCalled();
    client.stop();
  });

  it('does not let a stale polling snapshot move the cursor backwards', async () => {
    const handlers = callbacks();
    const liveStream = streamOf({
      id: '2',
      event: 'credit.settled',
      data: {
        schema_version: 1,
        scope: `workflow_run:${runId}`,
        event_seq: 2,
        event_type: 'credit.settled',
        occurred_at: '2026-08-11T00:00:01.000Z',
        payload: {},
      },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(new Response(liveStream, { status: 200 }))
      .mockResolvedValueOnce(Response.json(snapshot));
    const client = new WorkflowRealtimeClient(runId, handlers, { fetcher, random: () => 0 });

    await client.start();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));

    expect(handlers.onSnapshot).toHaveBeenCalledTimes(1);
    expect(handlers.onEvent).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it('does not announce recovery for ordinary healthy heartbeats', async () => {
    const handlers = callbacks();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const heartbeat = `event: heartbeat\ndata: ${JSON.stringify({
          scope: `workflow_run:${runId}`,
          last_event_seq: 1,
        })}\n\n`;
        controller.enqueue(new TextEncoder().encode(heartbeat + heartbeat));
        controller.close();
      },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(new Response(stream, { status: 200 }));
    const client = new WorkflowRealtimeClient(runId, handlers, { fetcher, random: () => 0 });

    await client.start();
    await waitFor(() => expect(handlers.onStatus).toHaveBeenCalledWith('live'));

    expect(handlers.onStatus).not.toHaveBeenCalledWith('recovered');
    client.stop();
  });

  it('refreshes the snapshot when a heartbeat proves the cursor is behind', async () => {
    const handlers = callbacks();
    const heartbeat = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `event: heartbeat\ndata: ${JSON.stringify({
              scope: `workflow_run:${runId}`,
              last_event_seq: 2,
            })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    const recoveredSnapshot = { ...snapshot, last_event_seq: 2 };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(new Response(heartbeat, { status: 200 }))
      .mockResolvedValueOnce(Response.json(recoveredSnapshot));
    const client = new WorkflowRealtimeClient(runId, handlers, { fetcher, random: () => 0 });

    await client.start();
    await waitFor(() => expect(handlers.onSnapshot).toHaveBeenCalledTimes(2), { timeout: 2_000 });

    expect(handlers.onSnapshot).toHaveBeenLastCalledWith(recoveredSnapshot);
    client.stop();
  });
});

function streamOf(
  ...inputs: Array<{
    id: string;
    event: string;
    data: Record<string, unknown>;
  }>
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          inputs
            .map(
              (input) =>
                `id: ${input.id}\nevent: ${input.event}\ndata: ${JSON.stringify(input.data)}\n\n`,
            )
            .join(''),
        ),
      );
      controller.close();
    },
  });
}
