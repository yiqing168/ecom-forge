'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import {
  confirmAgentTurn,
  createAgentTurn,
  interruptAgentTurn,
  type CreateTurnInput,
  type CreateTurnResponse,
  type SessionDetail,
} from '@/lib/agent-api';
import type { TurnSnapshot } from '@/features/realtime/turn-realtime.types';

export type SessionScope = { enabled: boolean; sessionId: string | null };

type PendingRequest = { key: string; scope: SessionScope; serialized: string };

export function useAgentConversationActions({
  enabled,
  loadSession,
  onError,
  onTurnId,
  sessionId,
  sessionScope,
  snapshot,
}: {
  enabled: boolean;
  loadSession: () => Promise<SessionDetail | null>;
  onError: (message: string) => void;
  onTurnId: (turnId: string) => void;
  sessionId: string | null;
  sessionScope: RefObject<SessionScope>;
  snapshot: TurnSnapshot | null;
}) {
  const [actionPending, setActionPending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const pendingCreate = useRef<PendingRequest | null>(null);
  const createInFlight = useRef<{
    promise: Promise<CreateTurnResponse>;
    scope: SessionScope;
    serialized: string;
  } | null>(null);
  const pendingConfirm = useRef<PendingRequest | null>(null);
  const confirmInFlight = useRef<SessionScope | null>(null);
  const pendingInterrupt = useRef<PendingRequest | null>(null);
  const interruptInFlight = useRef<SessionScope | null>(null);

  useEffect(() => {
    pendingCreate.current = null;
    createInFlight.current = null;
    pendingConfirm.current = null;
    confirmInFlight.current = null;
    pendingInterrupt.current = null;
    interruptInFlight.current = null;
    setSubmitting(false);
    setActionPending(false);
  }, [enabled, sessionId]);

  const submit = useCallback(
    (payload: CreateTurnInput): Promise<CreateTurnResponse> => {
      const serialized = JSON.stringify(payload);
      const submittedScope = sessionScope.current;
      if (
        createInFlight.current?.scope === submittedScope &&
        createInFlight.current.serialized === serialized
      ) {
        return createInFlight.current.promise;
      }
      if (createInFlight.current?.scope === submittedScope) {
        return Promise.reject(new Error('上一条消息仍在发送，请稍候'));
      }
      if (
        pendingCreate.current?.scope !== submittedScope ||
        pendingCreate.current.serialized !== serialized
      ) {
        pendingCreate.current = {
          key: `agent-turn-${crypto.randomUUID()}`,
          scope: submittedScope,
          serialized,
        };
      }
      const request = pendingCreate.current;
      const promise = (async () => {
        setSubmitting(true);
        onError('');
        try {
          const response = await createAgentTurn(payload, request.key);
          if (sessionScope.current === submittedScope) {
            pendingCreate.current = null;
            const submittedIntoCurrentSession = payload.session_id
              ? response.session_id === submittedScope.sessionId
              : submittedScope.sessionId === null;
            if (submittedIntoCurrentSession) {
              onTurnId(response.turn_id);
              if (payload.session_id) await loadSession();
            }
          }
          return response;
        } catch (cause) {
          if (sessionScope.current === submittedScope)
            onError(cause instanceof Error ? cause.message : '发送失败，请重试');
          throw cause;
        } finally {
          if (
            createInFlight.current?.scope === submittedScope &&
            createInFlight.current.serialized === serialized
          ) {
            createInFlight.current = null;
          }
          if (sessionScope.current === submittedScope) setSubmitting(false);
        }
      })();
      createInFlight.current = { promise, scope: submittedScope, serialized };
      return promise;
    },
    [loadSession, onError, onTurnId, sessionScope],
  );

  const confirm = useCallback(
    async (answers: Record<string, unknown>) => {
      const confirmedScope = sessionScope.current;
      if (!snapshot?.pending_confirmation || snapshot.session_id !== confirmedScope.sessionId)
        return;
      if (confirmInFlight.current === confirmedScope) return;
      const confirmation = snapshot.pending_confirmation;
      const requestBody = {
        confirmation_id: confirmation.id,
        confirmation_type: confirmation.type,
        confirmation_version: confirmation.version,
        answers,
      };
      const serialized = JSON.stringify({ turn_id: snapshot.id, ...requestBody });
      if (
        pendingConfirm.current?.scope !== confirmedScope ||
        pendingConfirm.current.serialized !== serialized
      ) {
        pendingConfirm.current = {
          key: `agent-confirm-${crypto.randomUUID()}`,
          scope: confirmedScope,
          serialized,
        };
      }
      const request = pendingConfirm.current;
      confirmInFlight.current = confirmedScope;
      setActionPending(true);
      onError('');
      try {
        await confirmAgentTurn(snapshot.id, requestBody, request.key);
        if (sessionScope.current === confirmedScope) {
          pendingConfirm.current = null;
          await loadSession();
        }
      } catch (cause) {
        if (sessionScope.current === confirmedScope)
          onError(cause instanceof Error ? cause.message : '确认失败，请重试');
        throw cause;
      } finally {
        if (confirmInFlight.current === confirmedScope) {
          confirmInFlight.current = null;
          if (
            sessionScope.current === confirmedScope &&
            interruptInFlight.current !== confirmedScope
          ) {
            setActionPending(false);
          }
        }
      }
    },
    [loadSession, onError, sessionScope, snapshot],
  );

  const interrupt = useCallback(async () => {
    const interruptedScope = sessionScope.current;
    if (
      !snapshot ||
      snapshot.session_id !== interruptedScope.sessionId ||
      isTerminal(snapshot.user_status)
    )
      return;
    if (interruptInFlight.current === interruptedScope) return;
    const serialized = JSON.stringify({ turn_id: snapshot.id, reason: 'user_requested' });
    if (
      pendingInterrupt.current?.scope !== interruptedScope ||
      pendingInterrupt.current.serialized !== serialized
    ) {
      pendingInterrupt.current = {
        key: `agent-interrupt-${crypto.randomUUID()}`,
        scope: interruptedScope,
        serialized,
      };
    }
    const request = pendingInterrupt.current;
    interruptInFlight.current = interruptedScope;
    setActionPending(true);
    onError('');
    try {
      await interruptAgentTurn(snapshot.id, request.key);
      if (sessionScope.current === interruptedScope) {
        pendingInterrupt.current = null;
        await loadSession();
      }
    } catch (cause) {
      if (sessionScope.current === interruptedScope)
        onError(cause instanceof Error ? cause.message : '停止失败，请重试');
      throw cause;
    } finally {
      if (interruptInFlight.current === interruptedScope) {
        interruptInFlight.current = null;
        if (
          sessionScope.current === interruptedScope &&
          confirmInFlight.current !== interruptedScope
        ) {
          setActionPending(false);
        }
      }
    }
  }, [loadSession, onError, sessionScope, snapshot]);

  return { actionPending, confirm, interrupt, submit, submitting };
}

function isTerminal(status: TurnSnapshot['user_status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}
