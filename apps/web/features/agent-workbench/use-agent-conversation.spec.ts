import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type {
  TurnRealtimeCallbacks,
  TurnRealtimeEvent,
  TurnSnapshot,
} from '@/features/realtime/turn-realtime.types';
import {
  confirmAgentTurn,
  createAgentTurn,
  getAgentSession,
  interruptAgentTurn,
  type CreateTurnInput,
  type CreateTurnResponse,
  type SessionDetail,
} from '@/lib/agent-api';

import { useAgentConversation } from './use-agent-conversation';

const realtime = vi.hoisted(() => ({
  clients: [] as Array<{
    callbacks: TurnRealtimeCallbacks;
    start: Mock<() => Promise<void>>;
    stop: Mock<() => void>;
    turnId: string;
  }>,
}));

vi.mock('@/features/realtime/turn-realtime.client', () => ({
  TurnRealtimeClient: class {
    readonly client: (typeof realtime.clients)[number];

    constructor(turnId: string, callbacks: TurnRealtimeCallbacks) {
      this.client = {
        callbacks,
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
        turnId,
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

vi.mock('@/lib/agent-api', () => ({
  confirmAgentTurn: vi.fn(),
  createAgentTurn: vi.fn(),
  getAgentSession: vi.fn(),
  interruptAgentTurn: vi.fn(),
}));

describe('useAgentConversation', () => {
  beforeEach(() => {
    realtime.clients.length = 0;
    vi.mocked(confirmAgentTurn).mockReset();
    vi.mocked(createAgentTurn).mockReset();
    vi.mocked(getAgentSession).mockReset().mockResolvedValue(sessionDetail('session-a', 'turn-a'));
    vi.mocked(interruptAgentTurn).mockReset();
  });

  it('reuses the create idempotency key after an ambiguous failure', async () => {
    vi.mocked(createAgentTurn).mockRejectedValueOnce(new Error('连接中断')).mockResolvedValueOnce({
      session_id: 'session-a',
      turn_id: 'turn-next',
      user_message_id: 'message-next',
      agent_trace_id: 'trace-next',
      user_status: 'thinking',
      revision: 2,
      continuation_no: 1,
      event_scope: 'turn:turn-next',
      last_event_seq: 1,
    });
    const { result } = renderConversation();
    await waitFor(() => expect(result.current.session).not.toBeNull());

    await act(async () => {
      await expect(result.current.submit(turnInput())).rejects.toThrow('连接中断');
    });
    await act(async () => {
      await result.current.submit(turnInput());
    });

    expect(vi.mocked(createAgentTurn).mock.calls[0]?.[1]).toBe(
      vi.mocked(createAgentTurn).mock.calls[1]?.[1],
    );
  });

  it('refreshes the session immediately after submitting another turn', async () => {
    vi.mocked(getAgentSession)
      .mockResolvedValueOnce(
        sessionDetail('session-a', 'turn-a', {
          messages: [message('message-first-user', '2026-08-17T08:00:01.000Z')],
        }),
      )
      .mockResolvedValueOnce(
        sessionDetail('session-a', 'turn-next', {
          messages: [
            message('message-first-user', '2026-08-17T08:00:01.000Z'),
            message('message-first-assistant', '2026-08-17T08:00:02.000Z', 'assistant'),
            message('message-next-user', '2026-08-17T08:00:03.000Z', 'user', 'turn-next'),
          ],
        }),
      );
    vi.mocked(createAgentTurn).mockResolvedValueOnce({
      session_id: 'session-a',
      turn_id: 'turn-next',
      user_message_id: 'message-next-user',
      agent_trace_id: 'trace-next',
      user_status: 'thinking',
      revision: 1,
      continuation_no: 1,
      event_scope: 'turn:turn-next',
      last_event_seq: 1,
    });
    const { result } = renderConversation();
    await waitFor(() => expect(result.current.session).not.toBeNull());

    await act(async () => result.current.submit(turnInput()));

    expect(getAgentSession).toHaveBeenCalledTimes(2);
    expect(result.current.session?.messages.map((item) => item.id)).toEqual([
      'message-first-user',
      'message-first-assistant',
      'message-next-user',
    ]);
  });

  it('reuses the clarification idempotency key after an ambiguous failure', async () => {
    vi.mocked(confirmAgentTurn)
      .mockRejectedValueOnce(new Error('连接中断'))
      .mockResolvedValueOnce({ status: 'accepted' });
    const { result } = renderConversation();
    await publishSnapshot(result, snapshot('session-a', 'turn-a', 'clarification'));

    await act(async () => {
      await expect(result.current.confirm({ selected_option_id: 'product' })).rejects.toThrow(
        '连接中断',
      );
    });
    await act(async () => {
      await result.current.confirm({ selected_option_id: 'product' });
    });

    expect(vi.mocked(confirmAgentTurn).mock.calls[0]?.[2]).toBe(
      vi.mocked(confirmAgentTurn).mock.calls[1]?.[2],
    );
  });

  it('reuses the interrupt idempotency key after an ambiguous failure', async () => {
    vi.mocked(interruptAgentTurn)
      .mockRejectedValueOnce(new Error('连接中断'))
      .mockResolvedValueOnce({ status: 'accepted' });
    const { result } = renderConversation();
    await publishSnapshot(result, snapshot('session-a', 'turn-a'));

    await act(async () => {
      await expect(result.current.interrupt()).rejects.toThrow('连接中断');
    });
    await act(async () => {
      await result.current.interrupt();
    });

    expect(vi.mocked(interruptAgentTurn).mock.calls[0]?.[1]).toBe(
      vi.mocked(interruptAgentTurn).mock.calls[1]?.[1],
    );
  });

  it('deduplicates an in-flight create and rejects another payload in the same session', async () => {
    const pending = Promise.withResolvers<CreateTurnResponse>();
    vi.mocked(createAgentTurn).mockReturnValueOnce(pending.promise);
    const { result } = renderConversation();
    await waitFor(() => expect(result.current.session).not.toBeNull());

    let request!: Promise<CreateTurnResponse>;
    act(() => {
      request = result.current.submit(turnInput());
    });
    expect(result.current.submit(turnInput())).toBe(request);
    await expect(
      result.current.submit({ ...turnInput(), message: '生成另一张海报' }),
    ).rejects.toThrow('上一条消息仍在发送');
    expect(createAgentTurn).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(createTurnResponse('session-a', 'turn-next'));
      await request;
    });
    expect(result.current.submitting).toBe(false);
  });

  it('ignores a realtime snapshot from the previous session', async () => {
    vi.mocked(getAgentSession).mockImplementation((sessionId) =>
      Promise.resolve(sessionDetail(sessionId, `turn-${sessionId}`)),
    );
    const onAuthenticationRequired = vi.fn();
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useAgentConversation({ enabled: true, onAuthenticationRequired, sessionId }),
      { initialProps: { sessionId: 'session-a' } },
    );
    await waitFor(() => expect(realtime.clients).toHaveLength(1));
    const oldClient = realtime.clients[0]!;

    rerender({ sessionId: 'session-b' });
    await waitFor(() => expect(realtime.clients).toHaveLength(2));
    const currentClient = realtime.clients[1]!;
    act(() => currentClient.callbacks.onSnapshot(snapshot('session-b', 'turn-session-b')));
    act(() => oldClient.callbacks.onSnapshot(snapshot('session-a', 'turn-session-a')));

    expect(result.current.snapshot?.session_id).toBe('session-b');
    expect(oldClient.stop).toHaveBeenCalled();
  });

  it('applies events synchronously and throws sequence gaps inside the SSE callback', async () => {
    const { result } = renderConversation();
    await publishSnapshot(result, snapshot('session-a', 'turn-a'));
    const callbacks = realtime.clients[0]!.callbacks;

    act(() =>
      callbacks.onEvent(
        turnEvent('turn-a', 2, 'turn.response_draft_delta', {
          step_id: 'step-a',
          draft_seq: 1,
          text_delta: '正在构图',
        }),
      ),
    );
    expect(result.current.snapshot?.response_draft?.text).toBe('正在构图');
    expect(() =>
      callbacks.onEvent(
        turnEvent('turn-a', 4, 'turn.status_changed', {
          user_status: 'thinking',
        }),
      ),
    ).toThrow('Turn event sequence gap requires snapshot recovery');
    expect(result.current.snapshot?.last_event_seq).toBe(2);

    act(() => callbacks.onSnapshot({ ...snapshot('session-a', 'turn-a'), last_event_seq: 3 }));
    act(() =>
      callbacks.onEvent(
        turnEvent('turn-a', 4, 'turn.message_delta', {
          message_id: 'answer-a',
          delta_seq: 1,
          is_final: true,
          text_delta: '正式回复',
          role: 'assistant',
          created_at: '2026-08-17T08:00:02.000Z',
        }),
      ),
    );
    expect(result.current.snapshot?.messages[0]?.content).toBe('正式回复');
    expect(result.current.snapshot?.response_draft).toBeNull();
  });

  it('ignores late events from a previous session after switching', async () => {
    vi.mocked(getAgentSession).mockImplementation((sessionId) =>
      Promise.resolve(sessionDetail(sessionId, `turn-${sessionId}`)),
    );
    const onAuthenticationRequired = vi.fn();
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useAgentConversation({
          enabled: true,
          onAuthenticationRequired,
          sessionId,
        }),
      { initialProps: { sessionId: 'session-a' } },
    );
    await waitFor(() => expect(realtime.clients).toHaveLength(1));
    const oldClient = realtime.clients[0]!;
    rerender({ sessionId: 'session-b' });
    await waitFor(() => expect(result.current.session?.session.id).toBe('session-b'));
    await waitFor(() => expect(realtime.clients).toHaveLength(2));
    const currentClient = realtime.clients[1]!;
    act(() => currentClient.callbacks.onSnapshot(snapshot('session-b', 'turn-session-b')));
    act(() =>
      oldClient.callbacks.onEvent(
        turnEvent('turn-session-a', 2, 'turn.message_delta', {
          message_id: 'stale',
          text_delta: '旧会话内容',
          role: 'assistant',
          created_at: '2026-08-17T08:00:02.000Z',
        }),
      ),
    );
    expect(result.current.snapshot?.session_id).toBe('session-b');
    expect(result.current.snapshot?.messages).toEqual([]);
  });

  it.each(['submit', 'confirm', 'interrupt'] as const)(
    'does not show a late %s failure in another session',
    async (action) => {
      const pending = Promise.withResolvers<never>();
      vi.mocked(getAgentSession).mockImplementation((id) =>
        Promise.resolve(sessionDetail(id, `turn-${id}`)),
      );
      vi.mocked(createAgentTurn).mockReturnValue(pending.promise);
      vi.mocked(confirmAgentTurn).mockReturnValue(pending.promise);
      vi.mocked(interruptAgentTurn).mockReturnValue(pending.promise);
      const onAuthenticationRequired = vi.fn();
      const { result, rerender } = renderHook(
        ({ sessionId }) =>
          useAgentConversation({ enabled: true, onAuthenticationRequired, sessionId }),
        { initialProps: { sessionId: 'session-a' } },
      );
      await waitFor(() => expect(realtime.clients).toHaveLength(1));
      act(() =>
        realtime.clients[0]!.callbacks.onSnapshot(
          snapshot('session-a', 'turn-session-a', 'clarification'),
        ),
      );
      let request!: Promise<unknown>;
      act(() => {
        request =
          action === 'submit'
            ? result.current.submit(turnInput())
            : action === 'confirm'
              ? result.current.confirm({ selected_option_id: 'product' })
              : result.current.interrupt();
      });
      const rejection = expect(request).rejects.toThrow('旧会话请求失败');
      rerender({ sessionId: 'session-b' });
      await waitFor(() => expect(result.current.session?.session.id).toBe('session-b'));
      await act(async () => {
        pending.reject(new Error('旧会话请求失败'));
        await rejection;
      });
      expect(result.current.error).toBe('');
      expect(result.current.session?.session.id).toBe('session-b');
    },
  );

  it.each(['success', 'failure'] as const)(
    'isolates a late create %s from a pending request in another session',
    async (outcome) => {
      const previous = Promise.withResolvers<CreateTurnResponse>();
      const current = Promise.withResolvers<CreateTurnResponse>();
      vi.mocked(getAgentSession).mockImplementation((id) =>
        Promise.resolve(sessionDetail(id, `turn-${id}`)),
      );
      vi.mocked(createAgentTurn)
        .mockReturnValueOnce(previous.promise)
        .mockReturnValueOnce(current.promise)
        .mockResolvedValueOnce(createTurnResponse('session-b', 'turn-next'));
      const onAuthenticationRequired = vi.fn();
      const { result, rerender } = renderHook(
        ({ sessionId }) =>
          useAgentConversation({ enabled: true, onAuthenticationRequired, sessionId }),
        { initialProps: { sessionId: 'session-a' } },
      );
      await waitFor(() => expect(result.current.session?.session.id).toBe('session-a'));

      let previousRequest!: Promise<CreateTurnResponse>;
      act(() => {
        previousRequest = result.current.submit(turnInput('session-a'));
      });
      await waitFor(() => expect(result.current.submitting).toBe(true));
      const previousCompletion =
        outcome === 'failure'
          ? expect(previousRequest).rejects.toThrow('旧会话请求失败')
          : previousRequest;

      rerender({ sessionId: 'session-b' });
      await waitFor(() => expect(result.current.session?.session.id).toBe('session-b'));
      expect(result.current.submitting).toBe(false);

      let currentRequest!: Promise<CreateTurnResponse>;
      act(() => {
        currentRequest = result.current.submit(turnInput('session-b'));
      });
      const currentFailure = expect(currentRequest).rejects.toThrow('新会话连接中断');
      await waitFor(() => expect(result.current.submitting).toBe(true));
      await act(async () => {
        if (outcome === 'failure') previous.reject(new Error('旧会话请求失败'));
        else previous.resolve(createTurnResponse('session-a', 'turn-old-next'));
        await previousCompletion;
      });
      expect(result.current.submitting).toBe(true);
      expect(result.current.error).toBe('');
      expect(result.current.session?.session.id).toBe('session-b');
      expect(getAgentSession).toHaveBeenCalledTimes(2);
      expect(result.current.submit(turnInput('session-b'))).toBe(currentRequest);

      await act(async () => {
        current.reject(new Error('新会话连接中断'));
        await currentFailure;
      });
      expect(result.current.submitting).toBe(false);
      await act(async () => result.current.submit(turnInput('session-b')));
      expect(createAgentTurn).toHaveBeenCalledTimes(3);
      expect(vi.mocked(createAgentTurn).mock.calls[1]?.[1]).toBe(
        vi.mocked(createAgentTurn).mock.calls[2]?.[1],
      );
    },
  );

  it.each([
    ['confirm', 'success'],
    ['confirm', 'failure'],
    ['interrupt', 'success'],
    ['interrupt', 'failure'],
  ] as const)(
    'isolates a late %s %s from a pending action in another session',
    async (action, outcome) => {
      const previous = Promise.withResolvers<Record<string, unknown>>();
      const current = Promise.withResolvers<Record<string, unknown>>();
      vi.mocked(getAgentSession).mockImplementation((id) =>
        Promise.resolve(sessionDetail(id, `turn-${id}`)),
      );
      if (action === 'confirm') {
        vi.mocked(confirmAgentTurn)
          .mockReturnValueOnce(previous.promise)
          .mockReturnValueOnce(current.promise)
          .mockResolvedValueOnce({ status: 'accepted' });
      } else {
        vi.mocked(interruptAgentTurn)
          .mockReturnValueOnce(previous.promise)
          .mockReturnValueOnce(current.promise)
          .mockResolvedValueOnce({ status: 'accepted' });
      }
      const onAuthenticationRequired = vi.fn();
      const { result, rerender } = renderHook(
        ({ sessionId }) =>
          useAgentConversation({ enabled: true, onAuthenticationRequired, sessionId }),
        { initialProps: { sessionId: 'session-a' } },
      );
      await waitFor(() => expect(realtime.clients).toHaveLength(1));
      act(() =>
        realtime.clients[0]!.callbacks.onSnapshot(
          snapshot(
            'session-a',
            'turn-session-a',
            action === 'confirm' ? 'clarification' : undefined,
          ),
        ),
      );

      let previousRequest!: Promise<void>;
      act(() => {
        previousRequest =
          action === 'confirm'
            ? result.current.confirm({ selected_option_id: 'product' })
            : result.current.interrupt();
      });
      await waitFor(() => expect(result.current.actionPending).toBe(true));
      const previousCompletion =
        outcome === 'failure'
          ? expect(previousRequest).rejects.toThrow('旧会话请求失败')
          : previousRequest;

      rerender({ sessionId: 'session-b' });
      await waitFor(() => expect(result.current.session?.session.id).toBe('session-b'));
      await waitFor(() => expect(realtime.clients).toHaveLength(2));
      expect(result.current.actionPending).toBe(false);
      act(() =>
        realtime.clients[1]!.callbacks.onSnapshot(
          snapshot(
            'session-b',
            'turn-session-b',
            action === 'confirm' ? 'clarification' : undefined,
          ),
        ),
      );

      let currentRequest!: Promise<void>;
      act(() => {
        currentRequest =
          action === 'confirm'
            ? result.current.confirm({ selected_option_id: 'product' })
            : result.current.interrupt();
      });
      const currentFailure = expect(currentRequest).rejects.toThrow('新会话连接中断');
      await waitFor(() => expect(result.current.actionPending).toBe(true));
      await act(async () => {
        if (outcome === 'failure') previous.reject(new Error('旧会话请求失败'));
        else previous.resolve({ status: 'accepted' });
        await previousCompletion;
      });
      expect(result.current.actionPending).toBe(true);
      expect(result.current.error).toBe('');
      expect(result.current.session?.session.id).toBe('session-b');
      expect(getAgentSession).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (action === 'confirm') await result.current.confirm({ selected_option_id: 'product' });
        else await result.current.interrupt();
      });
      expect(action === 'confirm' ? confirmAgentTurn : interruptAgentTurn).toHaveBeenCalledTimes(2);

      await act(async () => {
        current.reject(new Error('新会话连接中断'));
        await currentFailure;
      });
      expect(result.current.actionPending).toBe(false);
      await act(async () => {
        if (action === 'confirm') await result.current.confirm({ selected_option_id: 'product' });
        else await result.current.interrupt();
      });
      if (action === 'confirm') {
        expect(confirmAgentTurn).toHaveBeenCalledTimes(3);
        expect(vi.mocked(confirmAgentTurn).mock.calls[1]?.[2]).toBe(
          vi.mocked(confirmAgentTurn).mock.calls[2]?.[2],
        );
      } else {
        expect(interruptAgentTurn).toHaveBeenCalledTimes(3);
        expect(vi.mocked(interruptAgentTurn).mock.calls[1]?.[1]).toBe(
          vi.mocked(interruptAgentTurn).mock.calls[2]?.[1],
        );
      }
    },
  );

  it.each(['confirm', 'interrupt'] as const)(
    'keeps actions pending until both requests finish when %s returns first',
    async (first) => {
      const confirmation = Promise.withResolvers<Record<string, unknown>>();
      const interruption = Promise.withResolvers<Record<string, unknown>>();
      vi.mocked(confirmAgentTurn).mockReturnValueOnce(confirmation.promise);
      vi.mocked(interruptAgentTurn).mockReturnValueOnce(interruption.promise);
      const { result } = renderConversation();
      await publishSnapshot(result, snapshot('session-a', 'turn-a', 'clarification'));
      let confirmed!: Promise<void>;
      let interrupted!: Promise<void>;
      act(() => {
        confirmed = result.current.confirm({ selected_option_id: 'product' });
        interrupted = result.current.interrupt();
      });
      expect(result.current.actionPending).toBe(true);
      await act(async () => {
        (first === 'confirm' ? confirmation : interruption).resolve({ status: 'accepted' });
        await (first === 'confirm' ? confirmed : interrupted);
      });
      expect(result.current.actionPending).toBe(true);
      await act(async () => {
        (first === 'confirm' ? interruption : confirmation).resolve({ status: 'accepted' });
        await (first === 'confirm' ? interrupted : confirmed);
      });
      expect(result.current.actionPending).toBe(false);
    },
  );

  it('ignores old connection callbacks even after returning to the same session', async () => {
    vi.mocked(getAgentSession).mockImplementation((id) =>
      Promise.resolve(sessionDetail(id, `turn-${id}`)),
    );
    const onAuthenticationRequired = vi.fn();
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useAgentConversation({ enabled: true, onAuthenticationRequired, sessionId }),
      { initialProps: { sessionId: 'session-a' } },
    );
    await waitFor(() => expect(realtime.clients).toHaveLength(1));
    const oldClient = realtime.clients[0]!;
    rerender({ sessionId: 'session-b' });
    await waitFor(() => expect(realtime.clients).toHaveLength(2));
    rerender({ sessionId: 'session-a' });
    await waitFor(() => expect(realtime.clients).toHaveLength(3));
    const currentClient = realtime.clients[2]!;
    act(() => currentClient.callbacks.onSnapshot(snapshot('session-a', 'turn-session-a')));
    act(() => {
      oldClient.callbacks.onStatus('reconnecting');
      oldClient.callbacks.onUnavailable();
      oldClient.callbacks.onAuthenticationRequired();
      oldClient.callbacks.onSnapshot({
        ...snapshot('session-a', 'turn-session-a'),
        last_event_seq: 9,
      });
    });
    expect(result.current.snapshot?.last_event_seq).toBe(1);
    expect(result.current.realtimeStatus).not.toBe('reconnecting');
    expect(result.current.error).toBe('');
    expect(onAuthenticationRequired).not.toHaveBeenCalled();
  });

  it('loads older messages with keyset pagination and removes duplicates', async () => {
    vi.mocked(getAgentSession)
      .mockResolvedValueOnce(
        sessionDetail('session-a', 'turn-a', {
          messages: [message('message-2', '2026-08-17T08:00:02.000Z')],
          olderCursor: 'older-1',
        }),
      )
      .mockResolvedValueOnce(
        sessionDetail('session-a', 'turn-a', {
          messages: [
            message('message-1', '2026-08-17T08:00:01.000Z'),
            message('message-2', '2026-08-17T08:00:02.000Z'),
          ],
          olderCursor: null,
        }),
      );
    const { result } = renderConversation();
    await waitFor(() => expect(result.current.session?.older_cursor).toBe('older-1'));

    await act(async () => result.current.loadOlder());

    expect(getAgentSession).toHaveBeenLastCalledWith('session-a', { cursor: 'older-1' });
    expect(result.current.session?.messages.map((item) => item.id)).toEqual([
      'message-1',
      'message-2',
    ]);
    expect(result.current.session?.older_cursor).toBeNull();
  });

  it('keeps the user before an assistant at the same timestamp across page merging', async () => {
    const date = '2026-08-17T08:00:02.000Z';
    vi.mocked(getAgentSession)
      .mockResolvedValueOnce(
        sessionDetail('session-a', 'turn-a', {
          messages: [message('a-assistant', date, 'assistant')],
          olderCursor: 'older-1',
        }),
      )
      .mockResolvedValueOnce(
        sessionDetail('session-a', 'turn-a', {
          messages: [message('z-user', date)],
          olderCursor: null,
        }),
      );
    const { result } = renderConversation();
    await waitFor(() => expect(result.current.session?.older_cursor).toBe('older-1'));
    await act(async () => result.current.loadOlder());
    expect(result.current.session?.messages.map((item) => item.role)).toEqual([
      'user',
      'assistant',
    ]);
  });
});

function renderConversation() {
  const onAuthenticationRequired = vi.fn();
  return renderHook(() =>
    useAgentConversation({
      enabled: true,
      onAuthenticationRequired,
      sessionId: 'session-a',
    }),
  );
}

async function publishSnapshot(
  result: ReturnType<typeof renderConversation>['result'],
  value: TurnSnapshot,
) {
  await waitFor(() => expect(realtime.clients).toHaveLength(1));
  act(() => realtime.clients[0]!.callbacks.onSnapshot(value));
  await waitFor(() => expect(result.current.snapshot).toBe(value));
}

function turnInput(sessionId = 'session-a'): CreateTurnInput {
  return {
    session_id: sessionId,
    message: '生成一张海报',
    attachments: [],
    mention_bindings: [],
    skill_selection: { primary_skill_id: 'skill-a', preset_selections: [] },
    model_selection: {
      catalog_revision: 1,
      brain: { catalog_entry_id: 'brain-a', version_no: 1 },
      image: { catalog_entry_id: 'image-a', version_no: 1 },
    },
    generation_preferences: {
      schema_version: 2,
      output_kind: 'image',
      aspect_ratio: '1:1',
      resolution_tier: '1k',
    },
  };
}

function createTurnResponse(sessionId: string, turnId: string): CreateTurnResponse {
  return {
    session_id: sessionId,
    turn_id: turnId,
    user_message_id: `message-${turnId}`,
    agent_trace_id: `trace-${turnId}`,
    user_status: 'thinking',
    revision: 1,
    continuation_no: 1,
    event_scope: `turn:${turnId}`,
    last_event_seq: 1,
  };
}

function sessionDetail(
  sessionId: string,
  turnId: string,
  options: { messages?: SessionDetail['messages']; olderCursor?: string | null } = {},
): SessionDetail {
  return {
    session: {
      id: sessionId,
      title: '测试会话',
      revision: 1,
      primary_skill_slug: 'skill-a',
      preset_selections: [],
      created_at: '2026-08-17T08:00:00.000Z',
      updated_at: '2026-08-17T08:00:00.000Z',
    },
    messages: options.messages ?? [],
    turns: [snapshot(sessionId, turnId)],
    active_turn_id: turnId,
    older_cursor: options.olderCursor ?? null,
  };
}

function message(
  id: string,
  createdAt: string,
  role: SessionDetail['messages'][number]['role'] = 'user',
  turnId = 'turn-a',
): SessionDetail['messages'][number] {
  return {
    id,
    role,
    content: id,
    attachments: [],
    turn_id: turnId,
    created_at: createdAt,
  };
}

function snapshot(sessionId: string, turnId: string, confirmation?: 'clarification'): TurnSnapshot {
  return {
    id: turnId,
    session_id: sessionId,
    user_status: confirmation ? 'waiting_for_you' : 'thinking',
    revision: 1,
    continuation_no: 1,
    agent_trace_id: 'trace-a',
    skill_selection: {
      primary_skill_id: 'skill-a',
      primary_name: '创意海报',
      preset_selections: [],
    },
    model_selection: null,
    generation_preferences: null,
    execution_authorization: null,
    loaded_auxiliary_skills: [],
    run_quote_id: null,
    workflow_run_id: null,
    pending_confirmation:
      confirmation === 'clarification'
        ? {
            id: 'confirmation-a',
            type: 'clarification',
            version: 1,
            public_payload: { question: '更偏产品还是氛围？' },
            expires_at: '2026-08-17T08:30:00.000Z',
          }
        : null,
    messages: [],
    last_event_seq: 1,
    created_at: '2026-08-17T08:00:00.000Z',
    ended_at: null,
    activities: [],
  };
}

function turnEvent(
  turnId: string,
  eventSeq: number,
  eventType: TurnRealtimeEvent['event_type'],
  payload: Record<string, unknown>,
): TurnRealtimeEvent {
  return {
    schema_version: 1,
    scope: `turn:${turnId}`,
    event_seq: eventSeq,
    event_type: eventType,
    occurred_at: '2026-08-17T08:00:02.000Z',
    payload: { turn_id: turnId, agent_trace_id: 'trace-a', ...payload },
  };
}
