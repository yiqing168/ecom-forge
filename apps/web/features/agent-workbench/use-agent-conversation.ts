'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { applyTurnEvent } from '@/features/realtime/turn-realtime.reducer';
import { TurnRealtimeClient } from '@/features/realtime/turn-realtime.client';
import type { RealtimeConnectionStatus } from '@/features/realtime/realtime.client';
import type { TurnSnapshot } from '@/features/realtime/turn-realtime.types';
import { getAgentSession, type SessionDetail } from '@/lib/agent-api';

import { useAgentConversationActions } from './use-agent-conversation-actions';

export function useAgentConversation(input: {
  enabled: boolean;
  onAuthenticationRequired: () => void;
  sessionId: string | null;
}) {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeConnectionStatus>('idle');
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [snapshot, setSnapshot] = useState<TurnSnapshot | null>(null);
  const snapshotRef = useRef<TurnSnapshot | null>(null);
  const [turnId, setTurnId] = useState<string | null>(null);
  const activeClient = useRef<TurnRealtimeClient | null>(null);
  const loadGeneration = useRef(0);
  const pendingOlderCursor = useRef<string | null>(null);
  const currentSessionId = useRef(input.sessionId);
  const sessionScope = useRef({ enabled: input.enabled, sessionId: input.sessionId });
  if (
    sessionScope.current.enabled !== input.enabled ||
    sessionScope.current.sessionId !== input.sessionId
  ) {
    sessionScope.current = { enabled: input.enabled, sessionId: input.sessionId };
  }
  const pendingDesigner = useRef(false);
  const directionSnapshot = session?.session.creative_direction_snapshot;
  pendingDesigner.current =
    directionSnapshot?.selection.mode === 'auto' &&
    directionSnapshot.selection.version === 3 &&
    !directionSnapshot.resolved_profile;
  currentSessionId.current = input.sessionId;

  const loadSession = useCallback(async () => {
    if (!input.enabled || !input.sessionId) return null;
    const requestedSessionId = input.sessionId;
    if (requestedSessionId !== currentSessionId.current) return null;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError('');
    try {
      const detail = await getAgentSession(requestedSessionId);
      if (
        generation !== loadGeneration.current ||
        requestedSessionId !== currentSessionId.current
      ) {
        return null;
      }
      setSession((current) =>
        current?.session.id === detail.session.id
          ? mergeSessionDetail(current, detail, current.older_cursor)
          : detail,
      );
      setTurnId(detail.active_turn_id ?? detail.turns.at(-1)?.id ?? null);
      return detail;
    } catch (cause) {
      if (
        generation !== loadGeneration.current ||
        requestedSessionId !== currentSessionId.current
      ) {
        return null;
      }
      setError(cause instanceof Error ? cause.message : '会话加载失败，请重试');
      return null;
    } finally {
      if (
        generation === loadGeneration.current &&
        requestedSessionId === currentSessionId.current
      ) {
        setLoading(false);
      }
    }
  }, [input.enabled, input.sessionId]);

  const actions = useAgentConversationActions({
    enabled: input.enabled,
    loadSession,
    onError: setError,
    onTurnId: setTurnId,
    sessionId: input.sessionId,
    sessionScope,
    snapshot: snapshot?.session_id === input.sessionId ? snapshot : null,
  });

  useEffect(() => {
    loadGeneration.current += 1;
    activeClient.current?.stop();
    activeClient.current = null;
    setSession(null);
    snapshotRef.current = null;
    setSnapshot(null);
    setTurnId(null);
    setRealtimeStatus('idle');
    setError('');
    setLoading(false);
    setLoadingOlder(false);
    pendingOlderCursor.current = null;
    if (!input.enabled || !input.sessionId) return;
    void loadSession();
  }, [input.enabled, input.sessionId, loadSession]);

  useEffect(() => {
    activeClient.current?.stop();
    activeClient.current = null;
    snapshotRef.current = null;
    setSnapshot(null);
    setRealtimeStatus('idle');
    if (!input.enabled || !turnId || session?.session.id !== input.sessionId) return;
    const realtimeSessionId = input.sessionId;
    const realtimeTurnId = turnId;
    const realtimeScope = sessionScope.current;
    let client: TurnRealtimeClient | null = null;
    client = new TurnRealtimeClient(turnId, {
      onAuthenticationRequired: () => {
        if (sessionScope.current === realtimeScope) input.onAuthenticationRequired();
      },
      onEvent: (event) => {
        if (
          sessionScope.current !== realtimeScope ||
          currentSessionId.current !== realtimeSessionId ||
          event.payload.turn_id !== realtimeTurnId
        ) {
          return;
        }
        const current = snapshotRef.current;
        if (!current) throw new Error('Turn event arrived before its snapshot');
        const next = applyTurnEvent(current, event);
        snapshotRef.current = next;
        setSnapshot(next);
        if (
          new Set([
            'turn.confirmation_required',
            'turn.superseded',
            'turn.cancelled',
            'turn.completed',
            'turn.failed',
          ]).has(event.event_type) ||
          (pendingDesigner.current && event.event_type === 'turn.status_changed')
        ) {
          void loadSession();
        }
      },
      onSnapshot: (nextSnapshot) => {
        if (
          sessionScope.current !== realtimeScope ||
          currentSessionId.current !== realtimeSessionId ||
          nextSnapshot.id !== realtimeTurnId ||
          nextSnapshot.session_id !== realtimeSessionId
        ) {
          return;
        }
        snapshotRef.current = nextSnapshot;
        setSnapshot(nextSnapshot);
        if (
          pendingDesigner.current &&
          (isTerminal(nextSnapshot.user_status) || nextSnapshot.workflow_run_id)
        )
          void loadSession();
        if (isTerminal(nextSnapshot.user_status)) {
          window.setTimeout(() => client?.stop(), 0);
        }
      },
      onStatus: (status) => {
        if (sessionScope.current === realtimeScope) setRealtimeStatus(status);
      },
      onUnavailable: () => {
        if (sessionScope.current === realtimeScope) setError('实时连接暂时不可用，正在尝试恢复');
      },
    });
    activeClient.current = client;
    void client.start();
    return () => {
      client?.stop();
      if (activeClient.current === client) activeClient.current = null;
    };
  }, [
    input.enabled,
    input.onAuthenticationRequired,
    input.sessionId,
    loadSession,
    session?.session.id,
    turnId,
  ]);

  const loadOlder = useCallback(async () => {
    const requestedSessionId = input.sessionId;
    const cursor = session?.older_cursor ?? null;
    if (!input.enabled || !requestedSessionId || !cursor || pendingOlderCursor.current === cursor) {
      return;
    }
    const generation = loadGeneration.current;
    pendingOlderCursor.current = cursor;
    setLoadingOlder(true);
    setError('');
    try {
      const detail = await getAgentSession(requestedSessionId, { cursor });
      if (
        generation !== loadGeneration.current ||
        requestedSessionId !== currentSessionId.current
      ) {
        return;
      }
      setSession((current) =>
        current?.session.id === requestedSessionId
          ? mergeSessionDetail(current, detail, detail.older_cursor)
          : current,
      );
    } catch (cause) {
      if (
        generation === loadGeneration.current &&
        requestedSessionId === currentSessionId.current
      ) {
        setError(cause instanceof Error ? cause.message : '更早消息加载失败，请重试');
      }
    } finally {
      if (pendingOlderCursor.current === cursor) pendingOlderCursor.current = null;
      if (
        generation === loadGeneration.current &&
        requestedSessionId === currentSessionId.current
      ) {
        setLoadingOlder(false);
      }
    }
  }, [input.enabled, input.sessionId, session?.older_cursor]);

  return {
    ...actions,
    error,
    loadOlder,
    loadSession,
    loading,
    loadingOlder,
    realtimeStatus,
    session: session?.session.id === input.sessionId ? session : null,
    snapshot: snapshot?.session_id === input.sessionId ? snapshot : null,
  };
}

function mergeSessionDetail(
  current: SessionDetail,
  incoming: SessionDetail,
  olderCursor: string | null,
): SessionDetail {
  const messages = new Map(current.messages.map((message) => [message.id, message]));
  for (const message of incoming.messages) messages.set(message.id, message);
  const turns = new Map(current.turns.map((turn) => [turn.id, turn]));
  for (const turn of incoming.turns) turns.set(turn.id, turn);
  return {
    ...incoming,
    messages: [...messages.values()].sort(
      (left, right) =>
        Date.parse(left.created_at) - Date.parse(right.created_at) ||
        (left.turn_id ?? '').localeCompare(right.turn_id ?? '') ||
        (left.role === right.role ? 0 : left.role === 'user' ? -1 : 1) ||
        left.id.localeCompare(right.id),
    ),
    turns: [...turns.values()].sort(
      (left, right) =>
        Date.parse(left.created_at) - Date.parse(right.created_at) ||
        left.id.localeCompare(right.id),
    ),
    older_cursor: olderCursor,
  };
}

function isTerminal(status: TurnSnapshot['user_status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}
