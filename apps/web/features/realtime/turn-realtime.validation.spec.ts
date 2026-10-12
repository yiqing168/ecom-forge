import { describe, expect, it } from 'vitest';

import { parseTurnEvent, parseTurnSnapshot } from './turn-realtime.validation';
import type { TurnSnapshot } from './turn-realtime.types';

const turnId = '11111111-1111-4111-8111-111111111111';
const traceId = '22222222-2222-4222-8222-222222222222';

describe('turn realtime validation', () => {
  it.each([
    '所选生图模型暂时不可用，请稍后重试或选择其他生图模型',
    '创作助手暂时不可用，请稍后重试',
    '推理模型请求过于频繁，本轮已停止；请稍后重新发送，或更换推理模型',
    '推理模型响应超时，本轮已停止；请稍后重新发送，或更换推理模型',
    '与推理模型的连接异常，未取得完整响应；请稍后重新发送，或更换推理模型',
    '本次内容超过推理模型容量；请减少图片或对话内容后重新发送',
    '推理模型通道配置异常，本轮已停止；请更换推理模型或联系管理员',
    '推理模型通道额度不足，本轮已停止；请更换推理模型或联系管理员',
    '推理模型未接受本次请求，本轮已停止；请更换推理模型，若仍失败请联系管理员',
    '推理模型服务暂时异常，本轮已停止；请稍后重新发送，或更换推理模型',
    '推理模型返回内容不完整或格式异常，本轮已停止；请重新发送，或更换推理模型',
    '推理模型响应中途异常结束，未取得完整结果；请稍后重新发送，或更换推理模型',
    '推理模型未通过本次内容检查，本轮已停止；请调整描述或图片后重新发送',
    '未取得推理模型的完整响应，具体原因尚未确认；请稍后重新发送，或更换推理模型',
  ])('accepts the current and historical model failure summary: %s', (summary) => {
    const event = {
      schema_version: 1,
      scope: `turn:${turnId}`,
      event_seq: 2,
      event_type: 'turn.failed',
      occurred_at: '2026-08-13T00:00:01.000Z',
      payload: {
        turn_id: turnId,
        agent_trace_id: traceId,
        public_error_code: 'AGENT_MODEL_UNAVAILABLE',
        summary,
        user_status: 'failed',
      },
    };
    expect(parseTurnEvent(JSON.stringify(event), `turn:${turnId}`)).toEqual(event);
    const failed = { ...turnSnapshot(2), user_status: 'failed', failure_summary: summary };
    expect(parseTurnSnapshot(failed, turnId)).toEqual(failed);
    for (const unsafe of [
      `${summary} private-provider-message`,
      'TypeError: fetch failed at https://private.invalid?key=private-key',
    ]) {
      expect(() =>
        parseTurnEvent(
          JSON.stringify({ ...event, payload: { ...event.payload, summary: unsafe } }),
          `turn:${turnId}`,
        ),
      ).toThrow();
      expect(() => parseTurnSnapshot({ ...failed, failure_summary: unsafe }, turnId)).toThrow();
    }
  });

  it('accepts a sealed cross-group clarification and rejects tampered scope fields', () => {
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
      schema_version: 1,
      scope: `turn:${turnId}`,
      event_seq: 2,
      event_type: 'turn.confirmation_required',
      occurred_at: '2026-08-13T00:00:00.000Z',
      payload: {
        turn_id: turnId,
        agent_trace_id: traceId,
        confirmation_id: '33333333-3333-4333-8333-333333333333',
        confirmation_type: 'clarification',
        confirmation_version: 1,
        public_payload: publicPayload,
        expires_at: '2026-08-13T00:30:00.000Z',
        user_status: 'waiting_for_you',
      },
    };
    expect(parseTurnEvent(JSON.stringify(event), `turn:${turnId}`)).toEqual(event);
    const declined = {
      ...event,
      event_seq: 3,
      event_type: 'turn.failed',
      payload: {
        turn_id: turnId,
        agent_trace_id: traceId,
        public_error_code: 'AGENT_COMPILER_UNAVAILABLE',
        summary: '已选择只处理最近上传的照片，本次计划仍包含其他上传组；请重新说明要处理的照片',
        user_status: 'failed',
      },
    };
    expect(parseTurnEvent(JSON.stringify(declined), `turn:${turnId}`)).toEqual(declined);
    for (const changed of [
      { scope_digest: 'bad' },
      { allow_free_text: true },
      { options: [publicPayload.options[1], publicPayload.options[0]] },
    ]) {
      expect(() =>
        parseTurnEvent(
          JSON.stringify({
            ...event,
            payload: { ...event.payload, public_payload: { ...publicPayload, ...changed } },
          }),
          `turn:${turnId}`,
        ),
      ).toThrow();
    }
  });
  it('accepts only bounded public response draft events', () => {
    const event = {
      schema_version: 1,
      scope: `turn:${turnId}`,
      event_seq: 2,
      event_type: 'turn.response_draft_delta',
      occurred_at: '2026-08-13T00:00:00.000Z',
      payload: {
        turn_id: turnId,
        agent_trace_id: traceId,
        step_id: '33333333-3333-4333-8333-333333333333',
        draft_seq: 1,
        text_delta: '公开草稿',
      },
    };
    expect(parseTurnEvent(JSON.stringify(event), `turn:${turnId}`)).toEqual(event);
    expect(() =>
      parseTurnEvent(
        JSON.stringify({
          ...event,
          payload: { ...event.payload, reasoning: 'private' },
        }),
        `turn:${turnId}`,
      ),
    ).toThrow();
    expect(() =>
      parseTurnEvent(
        JSON.stringify({
          ...event,
          payload: { ...event.payload, draft_seq: 65 },
        }),
        `turn:${turnId}`,
      ),
    ).toThrow();
  });

  it('accepts a strict public event and rejects private or cross-turn payloads', () => {
    const event = {
      schema_version: 1,
      scope: `turn:${turnId}`,
      event_seq: 2,
      event_type: 'turn.activity_started',
      occurred_at: '2026-08-13T00:00:00.000Z',
      payload: {
        turn_id: turnId,
        agent_trace_id: traceId,
        activity_id: '33333333-3333-4333-8333-333333333333',
        activity_type: 'knowledge_loading',
        display_summary: '正在加载专业知识',
        status: 'started',
      },
    };
    expect(parseTurnEvent(JSON.stringify(event), `turn:${turnId}`)).toEqual(event);
    expect(() =>
      parseTurnEvent(
        JSON.stringify({ ...event, payload: { ...event.payload, tool_name: 'load_skill@1' } }),
        `turn:${turnId}`,
      ),
    ).toThrow();
    expect(() =>
      parseTurnEvent(
        JSON.stringify({
          ...event,
          payload: { ...event.payload, turn_id: '44444444-4444-4444-8444-444444444444' },
        }),
        `turn:${turnId}`,
      ),
    ).toThrow();

    const compilerFailure = {
      ...event,
      event_seq: 3,
      event_type: 'turn.failed',
      payload: {
        turn_id: turnId,
        agent_trace_id: traceId,
        public_error_code: 'AGENT_COMPILER_UNAVAILABLE',
        summary: '当前选择的技能不支持这类生成操作，请在底部切换主技能后重试',
        user_status: 'failed',
      },
    };
    expect(parseTurnEvent(JSON.stringify(compilerFailure), `turn:${turnId}`)).toEqual(
      compilerFailure,
    );

    const persistedCompilerFailure = {
      ...compilerFailure,
      event_seq: 4,
      payload: {
        ...compilerFailure.payload,
        summary: '生成要求还不够明确，请补充描述后重试',
      },
    };
    expect(parseTurnEvent(JSON.stringify(persistedCompilerFailure), `turn:${turnId}`)).toEqual(
      persistedCompilerFailure,
    );

    const persistedReferenceFailure = {
      ...compilerFailure,
      event_seq: 5,
      payload: {
        ...compilerFailure.payload,
        public_error_code: 'REFERENCE_NOT_AVAILABLE',
        summary: '引用内容当前不可用，请移除后重试',
      },
    };
    expect(parseTurnEvent(JSON.stringify(persistedReferenceFailure), `turn:${turnId}`)).toEqual(
      persistedReferenceFailure,
    );

    const invalidModelOutput = {
      ...event,
      event_seq: 6,
      event_type: 'turn.guardrail_triggered',
      payload: {
        turn_id: turnId,
        agent_trace_id: traceId,
        guardrail_type: 'invalid_model_output',
        action: 'stopped',
        summary: '创作方案未能形成完整结构，本轮已停止，请重新发送要求',
        user_status: 'failed',
      },
    };
    expect(parseTurnEvent(JSON.stringify(invalidModelOutput), `turn:${turnId}`)).toEqual(
      invalidModelOutput,
    );
  });

  it('unwraps and validates a complete turn snapshot', () => {
    const snapshot = turnSnapshot(1);
    expect(parseTurnSnapshot({ ok: true, data: snapshot, error: null }, turnId)).toEqual(snapshot);
    const runningDraft = {
      ...snapshot,
      response_draft: {
        step_id: '33333333-3333-4333-8333-333333333333',
        draft_seq: 1,
        text: '公开草稿',
      },
    };
    expect(parseTurnSnapshot(runningDraft, turnId).response_draft).toEqual(
      runningDraft.response_draft,
    );
    expect(() =>
      parseTurnSnapshot({ ...runningDraft, user_status: 'completed' }, turnId),
    ).toThrow();
    expect(() => parseTurnSnapshot({ ...snapshot, internal_status: 'done' }, turnId)).toThrow();
    expect(() => parseTurnSnapshot({ ...snapshot, failure_summary: {} }, turnId)).toThrow();
    expect(() =>
      parseTurnSnapshot(
        {
          ...snapshot,
          model_selection: {
            ...snapshot.model_selection,
            provider: 'private-provider',
          },
        },
        turnId,
      ),
    ).toThrow();
    expect(
      parseTurnSnapshot(
        {
          ...snapshot,
          model_selection: null,
          generation_preferences: null,
          execution_authorization: null,
        },
        turnId,
      ),
    ).toEqual({
      ...snapshot,
      model_selection: null,
      generation_preferences: null,
      execution_authorization: null,
    });
    const attachmentSnapshot = turnSnapshot(1);
    attachmentSnapshot.messages[0]!.attachments = [
      {
        resource_type: 'asset',
        resource_id: '99999999-9999-4999-8999-999999999999',
        role: 'product',
        position: 0,
      },
    ];
    expect(parseTurnSnapshot(attachmentSnapshot, turnId).messages[0]?.attachments).toEqual(
      attachmentSnapshot.messages[0]?.attachments,
    );
    expect(() =>
      parseTurnSnapshot(
        {
          ...attachmentSnapshot,
          messages: [
            {
              ...attachmentSnapshot.messages[0],
              attachments: [
                {
                  ...attachmentSnapshot.messages[0]!.attachments[0],
                  content_hash: 'private-evidence',
                },
              ],
            },
          ],
        },
        turnId,
      ),
    ).toThrow();
  });

  it.each(['正在理解你的需求', '正在分析参考图片', '正在继续思考', '正在读取已授权的上下文'])(
    'accepts the controlled context summary %s in snapshots',
    (displaySummary) => {
      const snapshot = turnSnapshot(1);
      snapshot.activities = [
        {
          activity_id: '33333333-3333-4333-8333-333333333333',
          activity_type: 'context_reading',
          display_summary: displaySummary,
          status: 'succeeded',
        },
      ];
      expect(parseTurnSnapshot(snapshot, turnId).activities[0]?.display_summary).toBe(
        displaySummary,
      );
    },
  );

  it('rejects an activity summary that does not match its activity type', () => {
    const snapshot = turnSnapshot(1);
    snapshot.activities = [
      {
        activity_id: '33333333-3333-4333-8333-333333333333',
        activity_type: 'safety_checking',
        display_summary: '正在分析参考图片',
        status: 'succeeded',
      },
    ];
    expect(() => parseTurnSnapshot(snapshot, turnId)).toThrow('Turn snapshot activity is invalid');
  });

  it('restores designer selections while preserving legacy realtime snapshots', () => {
    const snapshot = turnSnapshot(1);
    expect(parseTurnSnapshot(snapshot, turnId)).toEqual(snapshot);
    for (const direction of [
      { mode: 'native' },
      { mode: 'auto', version: 1 },
      { mode: 'auto', version: 2 },
      { mode: 'auto', version: 3 },
      { mode: 'profile', profile_id: 'visual-metaphor', version: 1 },
      { mode: 'profile', profile_id: 'visual-metaphor', version: 2 },
    ]) {
      const next = {
        ...snapshot,
        generation_preferences: {
          ...snapshot.generation_preferences!,
          creative_direction: direction,
        },
      };
      expect(parseTurnSnapshot({ ok: true, data: next }, turnId)).toEqual(next);
    }
    for (const direction of [
      null,
      { mode: 'auto', version: 4 },
      { mode: 'profile', profile_id: 'unknown', version: 1 },
      { mode: 'native', instructions: 'custom prose' },
    ]) {
      expect(() =>
        parseTurnSnapshot(
          {
            ...snapshot,
            generation_preferences: {
              ...snapshot.generation_preferences!,
              creative_direction: direction,
            },
          },
          turnId,
        ),
      ).toThrow('Turn generation preferences are invalid');
    }
  });

  it('accepts intelligent ratio and rejects unknown ratio modes', () => {
    const snapshot = turnSnapshot(1);
    expect(
      parseTurnSnapshot(
        {
          ...snapshot,
          generation_preferences: {
            ...snapshot.generation_preferences!,
            aspect_ratio: 'auto',
          },
        },
        turnId,
      ).generation_preferences?.aspect_ratio,
    ).toBe('auto');
    expect(() =>
      parseTurnSnapshot(
        {
          ...snapshot,
          generation_preferences: {
            ...snapshot.generation_preferences!,
            aspect_ratio: 'smart',
          },
        },
        turnId,
      ),
    ).toThrow('Turn generation preferences are invalid');
  });
});

export function turnSnapshot(lastEventSeq: number): TurnSnapshot {
  return {
    id: turnId,
    session_id: '55555555-5555-4555-8555-555555555555',
    user_status: 'thinking',
    revision: 1,
    continuation_no: 1,
    agent_trace_id: traceId,
    skill_selection: {
      primary_skill_id: 'commerce-main@1.0.0',
      primary_name: '电商创作',
      preset_selections: [],
    },
    model_selection: {
      catalog_revision: 4,
      brain: {
        catalog_entry_id: '77777777-7777-4777-8777-777777777777',
        version_no: 1,
        display_name: '创作助手',
      },
      image: {
        catalog_entry_id: '88888888-8888-4888-8888-888888888888',
        version_no: 2,
        display_name: '高清图片',
      },
    },
    generation_preferences: {
      schema_version: 2,
      output_kind: 'image',
      aspect_ratio: '1:1',
      resolution_tier: '1k',
    },
    execution_authorization: {
      kind: 'generate_action',
    },
    loaded_auxiliary_skills: [],
    run_quote_id: null,
    workflow_run_id: null,
    pending_confirmation: null,
    messages: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        role: 'user',
        content: '生成一张商品图',
        attachments: [],
        created_at: '2026-08-13T00:00:00.000Z',
      },
    ],
    activities: [
      {
        activity_id: '33333333-3333-4333-8333-333333333333',
        activity_type: 'knowledge_loading',
        display_summary: '正在加载专业知识',
        status: 'succeeded',
      },
    ],
    last_event_seq: lastEventSeq,
    failure_summary: null,
    created_at: '2026-08-13T00:00:00.000Z',
    ended_at: null,
  };
}
