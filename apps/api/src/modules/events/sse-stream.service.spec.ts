import { EventEmitter } from 'node:events';

import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { SseStreamService } from './sse-stream.service.js';

class FakeRequest extends EventEmitter {
  override once(event: 'aborted', listener: () => void): this {
    return super.once(event, listener);
  }

  override off(event: 'aborted', listener: () => void): this {
    return super.off(event, listener);
  }
}

class FakeResponse extends EventEmitter {
  statusCode = 0;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  readonly headers = new Map<string, string>();
  readonly frames: string[] = [];
  writeResult = true;

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  flushHeaders(): void {
    this.headersSent = true;
  }

  write(frame: string): boolean {
    this.frames.push(frame);
    return this.writeResult;
  }

  end(): void {
    this.writableEnded = true;
  }

  override once(event: 'close' | 'drain', listener: () => void): this {
    return super.once(event, listener);
  }

  override off(event: 'close' | 'drain', listener: () => void): this {
    return super.off(event, listener);
  }
}

const query = {
  scope: 'workflow_run:11111111-1111-4111-8111-111111111111' as const,
  scopeType: 'workflow_run' as const,
  scopeId: '11111111-1111-4111-8111-111111111111',
  lastEventSeq: 0,
};

function service(input: {
  rows?: Array<{ eventSeq: number; eventType: string; payload: unknown; createdAt: Date }>;
  maxConnectionsPerUser?: number;
  backpressureTimeoutMs?: number;
}) {
  let served = false;
  const outbox = {
    isOwnedScope: vi.fn().mockResolvedValue(true),
    highWatermark: vi.fn().mockResolvedValue(input.rows?.at(-1)?.eventSeq ?? 0),
    listAfter: vi.fn().mockImplementation(() => {
      if (served) return Promise.resolve([]);
      served = true;
      return Promise.resolve(input.rows ?? []);
    }),
  };
  const wakeHub = {
    listen: vi.fn().mockResolvedValue(vi.fn()),
  };
  return new SseStreamService(outbox as never, wakeHub as never, {
    heartbeatIntervalMs: 60_000,
    watchdogTimeoutMs: 180_000,
    replayBatchSize: 100,
    backpressureTimeoutMs: input.backpressureTimeoutMs ?? 50,
    maxConnections: 2,
    maxConnectionsPerUser: input.maxConnectionsPerUser ?? 2,
  });
}

describe('SseStreamService', () => {
  it('rejects a future turn cursor before sending SSE headers', async () => {
    const turnQuery = {
      scope: 'turn:11111111-1111-4111-8111-111111111111' as const,
      scopeType: 'turn' as const,
      scopeId: '11111111-1111-4111-8111-111111111111',
      lastEventSeq: 2,
    };
    const streams = service({
      rows: [
        {
          eventSeq: 1,
          eventType: 'turn.created',
          payload: {
            turn_id: turnQuery.scopeId,
            agent_trace_id: '22222222-2222-4222-8222-222222222222',
            user_status: 'thinking',
          },
          createdAt: new Date(),
        },
      ],
    });
    const response = new FakeResponse();

    await expect(
      streams.stream('user-1', turnQuery, new FakeRequest(), response),
    ).rejects.toMatchObject({ status: 400 });
    expect(response.headersSent).toBe(false);
  });

  it('closes and logs only a redacted code for an invalid public event', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const streams = service({
      rows: [
        {
          eventSeq: 1,
          eventType: 'internal.secret',
          payload: { secret: 'must-not-appear' },
          createdAt: new Date(),
        },
      ],
    });
    const response = new FakeResponse();

    try {
      await streams.stream('user-1', query, new FakeRequest(), response);

      expect(response.frames).toHaveLength(0);
      expect(response.writableEnded).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'sse_event_contract_invalid',
          error_code: 'EVENT_CONTRACT_INVALID',
          metric: 'sse_replay_failure_total',
        }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('must-not-appear');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('user-1');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(query.scopeId);
    } finally {
      warn.mockRestore();
    }
  });

  it('sends recovery_required and closes instead of skipping a sequence gap', async () => {
    const streams = service({
      rows: [
        {
          eventSeq: 2,
          eventType: 'workflow.status_changed',
          payload: { from: 'queued', to: 'running' },
          createdAt: new Date(),
        },
      ],
    });
    const response = new FakeResponse();

    await streams.stream('user-1', query, new FakeRequest(), response);

    expect(response.frames).toHaveLength(1);
    expect(response.frames[0]).toContain('event: recovery_required');
    expect(response.writableEnded).toBe(true);
  });

  it('closes a slow client after bounded backpressure without hanging', async () => {
    const streams = service({
      rows: [
        {
          eventSeq: 1,
          eventType: 'workflow.status_changed',
          payload: { from: 'queued', to: 'running' },
          createdAt: new Date(),
        },
      ],
      backpressureTimeoutMs: 5,
    });
    const response = new FakeResponse();
    response.writeResult = false;

    await streams.stream('user-1', query, new FakeRequest(), response);

    expect(response.writableEnded).toBe(true);
  });

  it('rejects excess user connections before sending SSE headers and releases on close', async () => {
    const streams = service({ maxConnectionsPerUser: 1 });
    const firstResponse = new FakeResponse();
    const first = streams.stream('user-1', query, new FakeRequest(), firstResponse);
    await vi.waitFor(() => expect(firstResponse.headersSent).toBe(true));

    const rejectedResponse = new FakeResponse();
    await expect(
      streams.stream('user-1', query, new FakeRequest(), rejectedResponse),
    ).rejects.toMatchObject({ status: 429 });
    expect(rejectedResponse.headersSent).toBe(false);

    firstResponse.emit('close');
    await first;
    const replacementResponse = new FakeResponse();
    const replacement = streams.stream('user-1', query, new FakeRequest(), replacementResponse);
    await vi.waitFor(() => expect(replacementResponse.headersSent).toBe(true));
    replacementResponse.emit('close');
    await replacement;
  });

  it('serializes a heartbeat behind an in-flight database drain', async () => {
    let wakeListener: ((wake: { scope_type: 'workflow_run' | 'turn' }) => void) | undefined;
    let resolveRows:
      | ((
          rows: Array<{ eventSeq: number; eventType: string; payload: unknown; createdAt: Date }>,
        ) => void)
      | undefined;
    let calls = 0;
    const pendingRows = new Promise<
      Array<{ eventSeq: number; eventType: string; payload: unknown; createdAt: Date }>
    >((resolve) => {
      resolveRows = resolve;
    });
    const outbox = {
      isOwnedScope: vi.fn().mockResolvedValue(true),
      highWatermark: vi.fn().mockResolvedValue(0),
      listAfter: vi.fn().mockImplementation(() => {
        calls += 1;
        if (calls === 1) return Promise.resolve([]);
        if (calls === 2) return pendingRows;
        return Promise.resolve([]);
      }),
    };
    const wakeHub = {
      listen: vi
        .fn()
        .mockImplementation(
          (_scopeId: string, listener: (wake: { scope_type: 'workflow_run' | 'turn' }) => void) => {
            wakeListener = listener;
            return Promise.resolve(vi.fn());
          },
        ),
    };
    const streams = new SseStreamService(outbox as never, wakeHub as never, {
      heartbeatIntervalMs: 5,
      watchdogTimeoutMs: 15,
      replayBatchSize: 100,
      backpressureTimeoutMs: 50,
      maxConnections: 2,
      maxConnectionsPerUser: 2,
    });
    const response = new FakeResponse();
    const streaming = streams.stream('user-1', query, new FakeRequest(), response);
    await vi.waitFor(() => expect(response.frames).toHaveLength(1));

    wakeListener?.({ scope_type: 'workflow_run' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(response.frames).toHaveLength(1);

    resolveRows?.([
      {
        eventSeq: 1,
        eventType: 'workflow.status_changed',
        payload: { from: 'queued', to: 'running' },
        createdAt: new Date(),
      },
    ]);
    await vi.waitFor(() => expect(response.frames[1]).toContain('id: 1'));
    response.emit('close');
    await streaming;
  });
});
