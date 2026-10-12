'use client';

import { useEffect, useRef, useState } from 'react';

import type { RealtimeConnectionStatus } from './realtime.client';
import { TurnRealtimeClient } from './turn-realtime.client';
import { applyTurnEvent } from './turn-realtime.reducer';
import type { TurnSnapshot } from './turn-realtime.types';

export interface UseTurnRealtimeOptions {
  onAuthenticationRequired?: () => void;
  onUnavailable?: () => void;
}

export function useTurnRealtime(turnId: string | null, options: UseTurnRealtimeOptions = {}) {
  const [status, setStatus] = useState<RealtimeConnectionStatus>('idle');
  const [snapshot, setSnapshot] = useState<TurnSnapshot | null>(null);
  const snapshotRef = useRef<TurnSnapshot | null>(null);
  const authCallbackRef = useRef(options.onAuthenticationRequired);
  const unavailableCallbackRef = useRef(options.onUnavailable);
  authCallbackRef.current = options.onAuthenticationRequired;
  unavailableCallbackRef.current = options.onUnavailable;

  useEffect(() => {
    snapshotRef.current = null;
    setSnapshot(null);
    if (!turnId) {
      setStatus('idle');
      return;
    }
    const client = new TurnRealtimeClient(turnId, {
      onStatus: setStatus,
      onSnapshot(next) {
        snapshotRef.current = next;
        setSnapshot(next);
      },
      onEvent(event) {
        const current = snapshotRef.current;
        if (!current) throw new Error('Turn event arrived before its snapshot');
        const next = applyTurnEvent(current, event);
        snapshotRef.current = next;
        setSnapshot(next);
      },
      onAuthenticationRequired() {
        authCallbackRef.current?.();
      },
      onUnavailable() {
        unavailableCallbackRef.current?.();
      },
    });
    void client.start();
    return () => client.stop();
  }, [turnId]);

  return { snapshot, status };
}
