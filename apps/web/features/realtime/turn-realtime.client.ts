import { ScopedRealtimeClient } from './realtime.client';
import type { TurnRealtimeCallbacks, TurnRealtimeEvent } from './turn-realtime.types';
import { parseTurnEvent, parseTurnSnapshot } from './turn-realtime.validation';

export interface TurnRealtimeClientOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  random?: () => number;
}

export class TurnRealtimeClient {
  private readonly client: ScopedRealtimeClient<
    ReturnType<typeof parseTurnSnapshot>,
    TurnRealtimeEvent
  >;

  constructor(
    turnId: string,
    callbacks: TurnRealtimeCallbacks,
    options: TurnRealtimeClientOptions = {},
  ) {
    this.client = new ScopedRealtimeClient({
      scope: `turn:${turnId}`,
      snapshotUrl: `/api/v1/agent/turns/${encodeURIComponent(turnId)}`,
      parseSnapshot: (value) => parseTurnSnapshot(value, turnId),
      snapshotCursor: (snapshot) => snapshot.last_event_seq,
      parseEvent: parseTurnEvent,
      callbacks,
      refreshSnapshotAfterEvent: (event) =>
        new Set([
          'turn.confirmation_required',
          'turn.superseded',
          'turn.cancelled',
          'turn.completed',
          'turn.failed',
        ]).has(event.event_type),
      ...options,
    });
  }

  start(): Promise<void> {
    return this.client.start();
  }

  stop(): void {
    this.client.stop();
  }
}
