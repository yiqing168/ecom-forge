import { describe, expect, it } from 'vitest';

import { applyTurnEvent } from './turn-realtime.reducer';
import type { TurnRealtimeEvent, TurnSnapshot } from './turn-realtime.types';
import { turnSnapshot } from './turn-realtime.validation.spec';

const turnId = '11111111-1111-4111-8111-111111111111';
const traceId = '22222222-2222-4222-8222-222222222222';

describe('turn realtime reducer', () => {
  it.each(['completed', 'failed', 'stopped', 'waiting_for_you'] as const)(
    'ignores late drafts after leaving thinking for %s',
    (status) => {
      const next = applyTurnEvent(
        { ...snapshot(), user_status: status, response_draft: null },
        event(2, 'turn.response_draft_delta', {
          step_id: '44444444-4444-4444-8444-444444444444',
          draft_seq: 1,
          text_delta: 'late reply',
        }),
      );
      expect(next.response_draft).toBeNull();
      expect(next.last_event_seq).toBe(2);
    },
  );

  it('continues a recovered draft exactly once and enforces its cumulative length', () => {
    const stepId = '44444444-4444-4444-8444-444444444444';
    const restored = {
      ...snapshot(),
      last_event_seq: 5,
      response_draft: { step_id: stepId, draft_seq: 2, text: '已有回复' },
    };
    const delta = event(6, 'turn.response_draft_delta', {
      step_id: stepId,
      draft_seq: 3,
      text_delta: '继续',
    });
    const next = applyTurnEvent(restored, delta);
    expect(next.response_draft?.text).toBe('已有回复继续');
    expect(applyTurnEvent(next, delta)).toBe(next);
    expect(() =>
      applyTurnEvent(
        { ...restored, response_draft: { step_id: stepId, draft_seq: 2, text: 'x'.repeat(8000) } },
        delta,
      ),
    ).toThrow(/text limit/);
  });
  it('applies ordered message deltas and ignores a duplicate event', () => {
    const first = event(2, 'turn.message_delta', {
      message_id: '33333333-3333-4333-8333-333333333333',
      delta_seq: 1,
      text_delta: '你好',
      is_final: false,
    });
    const second = event(3, 'turn.message_delta', {
      message_id: '33333333-3333-4333-8333-333333333333',
      delta_seq: 2,
      text_delta: '，世界',
      is_final: true,
    });
    const afterFirst = applyTurnEvent(snapshot(), first);
    const afterSecond = applyTurnEvent(afterFirst, second);

    expect(afterSecond.messages.at(-1)?.content).toBe('你好，世界');
    expect(applyTurnEvent(afterSecond, second)).toBe(afterSecond);
  });

  it('streams a provisional response and replaces it with the committed message', () => {
    // The public message cursor is independent of the provisional draft cursor.
    const stepId = '44444444-4444-4444-8444-444444444444';
    const first = applyTurnEvent(
      snapshot(),
      event(2, 'turn.response_draft_delta', {
        step_id: stepId,
        draft_seq: 1,
        text_delta: '正在构思',
      }),
    );
    const second = applyTurnEvent(
      first,
      event(3, 'turn.response_draft_delta', {
        step_id: stepId,
        draft_seq: 2,
        text_delta: '画面。',
      }),
    );
    expect(second.response_draft?.text).toBe('正在构思画面。');
    expect(second.messages).toHaveLength(snapshot().messages.length);
    expect(() =>
      applyTurnEvent(
        first,
        event(3, 'turn.response_draft_delta', {
          step_id: stepId,
          draft_seq: 3,
          text_delta: '乱序',
        }),
      ),
    ).toThrow(/draft sequence gap/);
    const committed = applyTurnEvent(
      second,
      event(4, 'turn.message_delta', {
        message_id: '33333333-3333-4333-8333-333333333333',
        delta_seq: 1,
        text_delta: '正式回复。',
        is_final: true,
      }),
    );
    expect(committed.response_draft).toBeNull();
    expect(committed.messages.at(-1)?.content).toBe('正式回复。');
  });

  it('recovers rather than appending gapped or final message deltas', () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const delta = (seq: number, final = false) => ({
      message_id: id,
      delta_seq: seq,
      text_delta: 'text',
      is_final: final,
    });
    expect(() => applyTurnEvent(snapshot(), event(2, 'turn.message_delta', delta(2)))).toThrow(
      /sequence one/,
    );
    const started = applyTurnEvent(snapshot(), event(2, 'turn.message_delta', delta(1)));
    for (const seq of [1, 3]) {
      expect(() => applyTurnEvent(started, event(3, 'turn.message_delta', delta(seq)))).toThrow(
        /message sequence gap/,
      );
    }
    const ended = applyTurnEvent(started, event(3, 'turn.message_delta', delta(2, true)));
    expect(() => applyTurnEvent(ended, event(4, 'turn.message_delta', delta(3)))).toThrow(
      /message sequence gap/,
    );
    const complete = {
      ...started,
      messages: started.messages.map(
        ({ delta_seq: _seq, delta_final: _final, ...message }) => message,
      ),
    };
    expect(() => applyTurnEvent(complete, event(3, 'turn.message_delta', delta(2)))).toThrow(
      /message sequence gap/,
    );
  });

  it('clears a draft on rejection and terminal status', () => {
    const stepId = '44444444-4444-4444-8444-444444444444';
    const first = applyTurnEvent(
      snapshot(),
      event(2, 'turn.response_draft_delta', {
        step_id: stepId,
        draft_seq: 1,
        text_delta: '预览',
      }),
    );
    const cleared = applyTurnEvent(
      first,
      event(3, 'turn.response_draft_cleared', {
        step_id: stepId,
      }),
    );
    expect(cleared.response_draft).toBeNull();
    const failed = applyTurnEvent(
      first,
      event(3, 'turn.status_changed', {
        previous_user_status: 'thinking',
        user_status: 'failed',
      }),
    );
    expect(failed.response_draft).toBeNull();
  });

  it('updates one activity by id and rejects sequence gaps', () => {
    const started = event(2, 'turn.activity_started', {
      activity_id: '33333333-3333-4333-8333-333333333333',
      activity_type: 'knowledge_loading',
      display_summary: '正在加载专业知识',
      status: 'started',
    });
    const finished = event(3, 'turn.activity_finished', {
      activity_id: '33333333-3333-4333-8333-333333333333',
      activity_type: 'knowledge_loading',
      display_summary: '正在加载专业知识',
      status: 'succeeded',
    });
    const result = applyTurnEvent(applyTurnEvent(snapshot(), started), finished);
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]?.status).toBe('succeeded');
    expect(() => applyTurnEvent(snapshot(), { ...started, event_seq: 3 })).toThrow(/gap/);
  });

  it('captures the workflow run id from the submit status change', () => {
    const result = applyTurnEvent(
      snapshot(),
      event(2, 'turn.status_changed', {
        previous_user_status: 'thinking',
        user_status: 'thinking',
        workflow_run_id: '99999999-9999-4999-8999-999999999999',
      }),
    );
    expect(result.workflow_run_id).toBe('99999999-9999-4999-8999-999999999999');
  });

  it('clears a pending confirmation once the turn resumes to thinking', () => {
    const waiting = {
      ...snapshot(),
      user_status: 'waiting_for_you' as const,
      pending_confirmation: {
        id: 'confirmation-a',
        type: 'clarification' as const,
        version: 1,
        public_payload: { question: '更偏产品还是氛围？', options: [] },
        expires_at: '2026-08-13T00:30:00.000Z',
      },
    };
    const result = applyTurnEvent(
      waiting,
      event(2, 'turn.status_changed', {
        previous_user_status: 'waiting_for_you',
        user_status: 'thinking',
      }),
    );
    expect(result.user_status).toBe('thinking');
    expect(result.pending_confirmation).toBeNull();
  });

  it('records activity timestamps so durations can be displayed', () => {
    const started = event(2, 'turn.activity_started', {
      activity_id: '44444444-4444-4444-8444-444444444444',
      activity_type: 'knowledge_loading',
      display_summary: '正在加载专业知识',
      status: 'started',
    });
    const finished = {
      ...event(3, 'turn.activity_finished', {
        activity_id: '44444444-4444-4444-8444-444444444444',
        activity_type: 'knowledge_loading',
        display_summary: '正在加载专业知识',
        status: 'succeeded',
      }),
      occurred_at: '2026-08-13T00:00:05.000Z',
    };
    const result = applyTurnEvent(applyTurnEvent(snapshot(), started), finished);
    expect(result.activities[0]?.started_at).toBe('2026-08-13T00:00:01.000Z');
    expect(result.activities[0]?.finished_at).toBe('2026-08-13T00:00:05.000Z');
  });
});

function snapshot(): TurnSnapshot {
  return { ...turnSnapshot(1), user_status: 'thinking', activities: [] };
}

function event(
  eventSeq: number,
  eventType: TurnRealtimeEvent['event_type'],
  payload: Record<string, unknown>,
): TurnRealtimeEvent {
  return {
    schema_version: 1,
    scope: `turn:${turnId}`,
    event_seq: eventSeq,
    event_type: eventType,
    occurred_at: '2026-08-13T00:00:01.000Z',
    payload: { turn_id: turnId, agent_trace_id: traceId, ...payload },
  };
}
