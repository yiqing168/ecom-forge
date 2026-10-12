import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TurnRealtimeClient } from './turn-realtime.client';
import type { TurnRealtimeCallbacks } from './turn-realtime.types';
import { turnSnapshot } from './turn-realtime.validation.spec';

const turnId = '11111111-1111-4111-8111-111111111111';
const traceId = '22222222-2222-4222-8222-222222222222';

function callbacks() {
  return {
    onStatus: vi.fn<TurnRealtimeCallbacks['onStatus']>(),
    onSnapshot: vi.fn<TurnRealtimeCallbacks['onSnapshot']>(),
    onEvent: vi.fn<TurnRealtimeCallbacks['onEvent']>(),
    onAuthenticationRequired: vi.fn<TurnRealtimeCallbacks['onAuthenticationRequired']>(),
    onUnavailable: vi.fn<TurnRealtimeCallbacks['onUnavailable']>(),
  };
}

describe('TurnRealtimeClient', () => {
  it('loads the turn snapshot before applying an ordered event', async () => {
    const handlers = callbacks();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, data: turnSnapshot(1), error: null }))
      .mockResolvedValueOnce(
        new Response(
          streamOf(2, 'turn.status_changed', {
            previous_user_status: 'thinking',
            user_status: 'waiting_for_you',
          }),
          { status: 200 },
        ),
      );
    const client = new TurnRealtimeClient(turnId, handlers, { fetcher });

    await client.start();
    await waitFor(() => expect(handlers.onEvent).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0]?.[0]).toContain(`/agent/turns/${turnId}`);
    expect(fetcher.mock.calls[1]?.[0]).toContain('last_event_seq=1');
    client.stop();
  });

  it('recovers the authoritative snapshot when applying an event throws', async () => {
    const handlers = callbacks();
    handlers.onEvent.mockImplementationOnce(() => {
      throw new Error('Projection rejected the event');
    });
    const recovered = { ...turnSnapshot(2), user_status: 'waiting_for_you' };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, data: turnSnapshot(1), error: null }))
      .mockResolvedValueOnce(
        new Response(
          streamOf(2, 'turn.status_changed', {
            previous_user_status: 'thinking',
            user_status: 'waiting_for_you',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, data: recovered, error: null }));
    const client = new TurnRealtimeClient(turnId, handlers, { fetcher, random: () => 0 });

    await client.start();
    await waitFor(() => expect(handlers.onSnapshot).toHaveBeenCalledTimes(2));
    expect(handlers.onEvent).toHaveBeenCalledTimes(1);
    expect(handlers.onSnapshot).toHaveBeenLastCalledWith(recovered);
    expect(fetcher.mock.calls[2]?.[0]).toContain('/agent/turns/' + turnId);
    client.stop();
  });

  it('refreshes the authoritative snapshot after a terminal event', async () => {
    const handlers = callbacks();
    const completed = {
      ...turnSnapshot(2),
      user_status: 'completed',
      ended_at: '2026-08-13T00:00:02.000Z',
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, data: turnSnapshot(1), error: null }))
      .mockResolvedValueOnce(
        new Response(
          streamOf(2, 'turn.completed', {
            message_id: '33333333-3333-4333-8333-333333333333',
            user_status: 'completed',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, data: completed, error: null }));
    const client = new TurnRealtimeClient(turnId, handlers, { fetcher, random: () => 0 });

    await client.start();
    await waitFor(() => expect(handlers.onSnapshot).toHaveBeenCalledTimes(2));
    expect(handlers.onSnapshot).toHaveBeenLastCalledWith(completed);
    client.stop();
  });

  it('recovers from a gap with a fresh snapshot instead of applying the event', async () => {
    const handlers = callbacks();
    const recovered = { ...turnSnapshot(3), user_status: 'waiting_for_you' };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, data: turnSnapshot(1), error: null }))
      .mockResolvedValueOnce(
        new Response(
          streamOf(3, 'turn.status_changed', {
            previous_user_status: 'thinking',
            user_status: 'waiting_for_you',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, data: recovered, error: null }));
    const client = new TurnRealtimeClient(turnId, handlers, { fetcher, random: () => 0 });

    await client.start();
    await waitFor(() => expect(handlers.onSnapshot).toHaveBeenCalledTimes(2));
    expect(handlers.onEvent).not.toHaveBeenCalled();
    client.stop();
  });

  it('does not publish a snapshot that arrives after the client is stopped', async () => {
    const handlers = callbacks();
    let resolveSnapshot: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const client = new TurnRealtimeClient(turnId, handlers, { fetcher });

    const started = client.start();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    client.stop();
    resolveSnapshot?.(Response.json({ ok: true, data: turnSnapshot(1), error: null }));
    await started;

    expect(handlers.onSnapshot).not.toHaveBeenCalled();
  });
});

function streamOf(
  eventSeq: number,
  eventType: string,
  payload: Record<string, unknown>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const event = {
        schema_version: 1,
        scope: `turn:${turnId}`,
        event_seq: eventSeq,
        event_type: eventType,
        occurred_at: '2026-08-13T00:00:01.000Z',
        payload: { turn_id: turnId, agent_trace_id: traceId, ...payload },
      };
      controller.enqueue(
        new TextEncoder().encode(
          `id: ${eventSeq}\nevent: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`,
        ),
      );
      controller.close();
    },
  });
}
