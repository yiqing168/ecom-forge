import { describe, expect, it } from 'vitest';

import { encodeBusinessEvent, EventContractError, projectPublicEvent } from './event-contract.js';

describe('SSE event contract', () => {
  it('projects an allowlisted outbox event into a stable frame', () => {
    const event = projectPublicEvent('workflow_run:11111111-1111-4111-8111-111111111111', {
      eventSeq: 2,
      eventType: 'task.status_changed',
      payload: {
        task_id: '22222222-2222-4222-8222-222222222222',
        from: 'queued',
        to: 'running',
      },
      createdAt: new Date('2026-08-11T00:00:00.000Z'),
    });

    expect(encodeBusinessEvent(event)).toContain(
      'event: task.status_changed\ndata: {"schema_version":1',
    );
  });

  it('projects a published artifact event without private storage details', () => {
    const projected = projectPublicEvent('workflow_run:11111111-1111-4111-8111-111111111111', {
      eventSeq: 3,
      eventType: 'artifact.created',
      payload: {
        artifact_id: '22222222-2222-4222-8222-222222222222',
        task_id: '33333333-3333-4333-8333-333333333333',
        visibility: 'private',
      },
      createdAt: new Date('2026-08-11T00:00:01.000Z'),
    });

    expect(projected).toMatchObject({
      event_type: 'artifact.created',
      payload: {
        artifact_id: '22222222-2222-4222-8222-222222222222',
        visibility: 'private',
      },
    });
  });

  it('projects content review decisions for workflow replay', () => {
    const projected = projectPublicEvent('workflow_run:11111111-1111-4111-8111-111111111111', {
      eventSeq: 4,
      eventType: 'content_review.resolved',
      payload: {
        content_review_case_id: '22222222-2222-4222-8222-222222222222',
        decision: 'expired',
        artifact_id: '33333333-3333-4333-8333-333333333333',
      },
      createdAt: new Date('2026-08-11T00:00:02.000Z'),
    });

    expect(projected).toMatchObject({
      event_type: 'content_review.resolved',
      payload: { decision: 'expired' },
    });
  });

  it('fails closed for unknown or malformed public events', () => {
    expect(() =>
      projectPublicEvent('workflow_run:11111111-1111-4111-8111-111111111111', {
        eventSeq: 1,
        eventType: 'internal.secret',
        payload: { secret: 'nope' },
        createdAt: new Date(),
      }),
    ).toThrow(EventContractError);
    expect(() =>
      projectPublicEvent('workflow_run:11111111-1111-4111-8111-111111111111', {
        eventSeq: 1,
        eventType: 'workflow.status_changed',
        payload: { from: 'queued', to: 'running', extra: '\n' },
        createdAt: new Date(),
      }),
    ).toThrow(EventContractError);
  });

  it('projects strict turn events and rejects cross-scope or private fields', () => {
    const scope = 'turn:11111111-1111-4111-8111-111111111111';
    const turnCreated = {
      eventSeq: 1,
      eventType: 'turn.created',
      payload: {
        turn_id: '11111111-1111-4111-8111-111111111111',
        agent_trace_id: '22222222-2222-4222-8222-222222222222',
        user_status: 'thinking',
      },
      createdAt: new Date('2026-08-13T00:00:00.000Z'),
    };

    expect(projectPublicEvent(scope, turnCreated)).toMatchObject({
      event_type: 'turn.created',
      payload: turnCreated.payload,
    });
    expect(() =>
      projectPublicEvent('workflow_run:11111111-1111-4111-8111-111111111111', turnCreated),
    ).toThrow(EventContractError);
    expect(() =>
      projectPublicEvent(scope, {
        ...turnCreated,
        payload: { ...turnCreated.payload, tool_name: 'private-tool' },
      }),
    ).toThrow(EventContractError);
  });

  it.each(['正在理解你的需求', '正在分析参考图片', '正在继续思考', '正在读取已授权的上下文'])(
    'projects the controlled context activity summary %s',
    (displaySummary) => {
      const payload = {
        turn_id: '11111111-1111-4111-8111-111111111111',
        agent_trace_id: '22222222-2222-4222-8222-222222222222',
        activity_id: '33333333-3333-4333-8333-333333333333',
        activity_type: 'context_reading',
        display_summary: displaySummary,
        status: 'started',
      };
      expect(
        projectPublicEvent('turn:11111111-1111-4111-8111-111111111111', {
          eventSeq: 2,
          eventType: 'turn.activity_started',
          payload,
          createdAt: new Date('2026-08-13T00:00:00.000Z'),
        }),
      ).toMatchObject({ payload });
    },
  );

  it('rejects an activity summary that does not match its activity type', () => {
    expect(() =>
      projectPublicEvent('turn:11111111-1111-4111-8111-111111111111', {
        eventSeq: 2,
        eventType: 'turn.activity_started',
        payload: {
          turn_id: '11111111-1111-4111-8111-111111111111',
          agent_trace_id: '22222222-2222-4222-8222-222222222222',
          activity_id: '33333333-3333-4333-8333-333333333333',
          activity_type: 'safety_checking',
          display_summary: '正在分析参考图片',
          status: 'started',
        },
        createdAt: new Date('2026-08-13T00:00:00.000Z'),
      }),
    ).toThrow(EventContractError);
  });

  it('projects the bounded invalid model output guardrail as a terminal event', () => {
    const scope = 'turn:11111111-1111-4111-8111-111111111111';
    const payload = {
      turn_id: '11111111-1111-4111-8111-111111111111',
      agent_trace_id: '22222222-2222-4222-8222-222222222222',
      guardrail_type: 'invalid_model_output',
      action: 'stopped',
      summary: '创作方案未能形成完整结构，本轮已停止，请重新发送要求',
      user_status: 'failed',
    };

    expect(
      projectPublicEvent(scope, {
        eventSeq: 6,
        eventType: 'turn.guardrail_triggered',
        payload,
        createdAt: new Date('2026-08-13T00:00:00.000Z'),
      }),
    ).toMatchObject({ event_type: 'turn.guardrail_triggered', payload });
  });

  it('validates turn message and confirmation payload limits', () => {
    const scope = 'turn:11111111-1111-4111-8111-111111111111';
    const base = {
      turn_id: '11111111-1111-4111-8111-111111111111',
      agent_trace_id: '22222222-2222-4222-8222-222222222222',
    };
    expect(
      projectPublicEvent(scope, {
        eventSeq: 1,
        eventType: 'turn.response_draft_delta',
        payload: {
          ...base,
          step_id: '33333333-3333-4333-8333-333333333333',
          draft_seq: 1,
          text_delta: '公开草稿',
        },
        createdAt: new Date(),
      }).event_type,
    ).toBe('turn.response_draft_delta');
    expect(() =>
      projectPublicEvent(scope, {
        eventSeq: 1,
        eventType: 'turn.response_draft_delta',
        payload: {
          ...base,
          step_id: '33333333-3333-4333-8333-333333333333',
          draft_seq: 1,
          text_delta: '公开草稿',
          reasoning: 'private',
        },
        createdAt: new Date(),
      }),
    ).toThrow(EventContractError);
    expect(() =>
      projectPublicEvent(scope, {
        eventSeq: 1,
        eventType: 'turn.message_delta',
        payload: {
          ...base,
          message_id: '33333333-3333-4333-8333-333333333333',
          delta_seq: 65,
          text_delta: 'private overflow',
          is_final: true,
        },
        createdAt: new Date(),
      }),
    ).toThrow(EventContractError);
    expect(() =>
      projectPublicEvent(scope, {
        eventSeq: 2,
        eventType: 'turn.confirmation_required',
        payload: {
          ...base,
          confirmation_id: '33333333-3333-4333-8333-333333333333',
          confirmation_type: 'clarification',
          confirmation_version: 1,
          public_payload: {
            schema_version: 1,
            question: '请选择',
            options: [
              { id: 'same', label: '一' },
              { id: 'same', label: '二' },
            ],
            allow_free_text: true,
            max_response_chars: 2000,
          },
          expires_at: '2026-08-13T00:30:00.000Z',
          user_status: 'waiting_for_you',
        },
        createdAt: new Date(),
      }),
    ).toThrow(EventContractError);
  });

  it('accepts only a sealed cross-group clarification payload', () => {
    const scope = 'turn:11111111-1111-4111-8111-111111111111';
    const publicPayload = {
      schema_version: 1,
      question: 'Use both upload groups?',
      options: [
        { id: 'option-1', label: 'Latest only' },
        { id: 'option-2', label: 'Both groups' },
      ],
      allow_free_text: false,
      max_response_chars: 2000,
      scope_digest: 'a'.repeat(64),
    };
    const event = {
      eventSeq: 5,
      eventType: 'turn.confirmation_required',
      payload: {
        turn_id: '11111111-1111-4111-8111-111111111111',
        agent_trace_id: '22222222-2222-4222-8222-222222222222',
        confirmation_id: '33333333-3333-4333-8333-333333333333',
        confirmation_type: 'clarification',
        confirmation_version: 1,
        public_payload: publicPayload,
        expires_at: '2026-08-13T00:30:00.000Z',
        user_status: 'waiting_for_you',
      },
      createdAt: new Date('2026-08-13T00:00:00.000Z'),
    };
    expect(projectPublicEvent(scope, event)).toBeDefined();
    expect(() =>
      projectPublicEvent(scope, {
        ...event,
        payload: { ...event.payload, public_payload: { ...publicPayload, scope_digest: 'bad' } },
      }),
    ).toThrow(EventContractError);
    expect(() =>
      projectPublicEvent(scope, {
        ...event,
        payload: { ...event.payload, public_payload: { ...publicPayload, allow_free_text: true } },
      }),
    ).toThrow(EventContractError);
    expect(
      projectPublicEvent(scope, {
        eventSeq: 6,
        eventType: 'turn.failed',
        payload: {
          turn_id: event.payload.turn_id,
          agent_trace_id: event.payload.agent_trace_id,
          public_error_code: 'AGENT_COMPILER_UNAVAILABLE',
          summary: '已选择只处理最近上传的照片，本次计划仍包含其他上传组；请重新说明要处理的照片',
          user_status: 'failed',
        },
        createdAt: event.createdAt,
      }),
    ).toBeDefined();
  });

  it('rejects legacy cost action cards from the public event stream', () => {
    expect(() =>
      projectPublicEvent('turn:11111111-1111-4111-8111-111111111111', {
        eventSeq: 4,
        eventType: 'turn.confirmation_required',
        payload: {
          turn_id: '11111111-1111-4111-8111-111111111111',
          agent_trace_id: '22222222-2222-4222-8222-222222222222',
          confirmation_type: 'cost',
          confirmation_version: 1,
          public_payload: {
            schema_version: 1,
            quote_id: '33333333-3333-4333-8333-333333333333',
            estimated_total_credits: '2.00',
            items: [{ label: '图片生成', quantity: 1, estimated_credits: '2.00' }],
            submission_block_reason: null,
          },
          expires_at: '2026-08-13T00:10:00.000Z',
          user_status: 'waiting_for_you',
        },
        createdAt: new Date('2026-08-13T00:00:00.000Z'),
      }),
    ).toThrow(EventContractError);
  });

  it('projects the existing safe capability error for a restricted Agent submit', () => {
    const projected = projectPublicEvent('turn:11111111-1111-4111-8111-111111111111', {
      eventSeq: 5,
      eventType: 'turn.failed',
      payload: {
        turn_id: '11111111-1111-4111-8111-111111111111',
        agent_trace_id: '22222222-2222-4222-8222-222222222222',
        public_error_code: 'AGENT_TOOL_NOT_ALLOWED',
        summary: '当前状态不允许使用该能力',
        user_status: 'failed',
      },
      createdAt: new Date('2026-08-13T00:00:00.000Z'),
    });

    expect(projected.payload).toMatchObject({
      public_error_code: 'AGENT_TOOL_NOT_ALLOWED',
      user_status: 'failed',
    });
  });

  it('projects a compiler capability rejection without breaking SSE replay', () => {
    const projected = projectPublicEvent('turn:11111111-1111-4111-8111-111111111111', {
      eventSeq: 6,
      eventType: 'turn.failed',
      payload: {
        turn_id: '11111111-1111-4111-8111-111111111111',
        agent_trace_id: '22222222-2222-4222-8222-222222222222',
        public_error_code: 'AGENT_COMPILER_UNAVAILABLE',
        summary: '当前选择的技能不支持这类生成操作，请在底部切换主技能后重试',
        user_status: 'failed',
      },
      createdAt: new Date('2026-08-13T00:00:00.000Z'),
    });

    expect(projected.payload).toMatchObject({
      public_error_code: 'AGENT_COMPILER_UNAVAILABLE',
      user_status: 'failed',
    });
  });

  it.each([
    ['AGENT_COMPILER_UNAVAILABLE', '生成要求还不够明确，请补充描述后重试'],
    ['REFERENCE_NOT_AVAILABLE', '引用内容当前不可用，请移除后重试'],
  ])('replays persisted compiler failure %s', (publicErrorCode, summary) => {
    const projected = projectPublicEvent('turn:11111111-1111-4111-8111-111111111111', {
      eventSeq: 7,
      eventType: 'turn.failed',
      payload: {
        turn_id: '11111111-1111-4111-8111-111111111111',
        agent_trace_id: '22222222-2222-4222-8222-222222222222',
        public_error_code: publicErrorCode,
        summary,
        user_status: 'failed',
      },
      createdAt: new Date('2026-08-13T00:00:00.000Z'),
    });

    expect(projected.payload).toMatchObject({ public_error_code: publicErrorCode, summary });
  });
});
