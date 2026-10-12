import { randomUUID } from 'node:crypto';

import {
  AGENT_BRAIN_FAILURE_SUMMARIES,
  AGENT_GUARDRAIL_TYPES,
  AGENT_PUBLIC_ERROR_CODES,
  AGENT_PUBLIC_SUMMARIES,
} from '@ecom-forge/shared';
import { describe, expect, it } from 'vitest';

import { projectPublicEvent } from '../../../api/src/modules/events/event-contract.js';
import { parseTurnEvent, parseTurnSnapshot } from './turn-realtime.validation';
import { agentBrainPublicFailure } from '../../../worker/src/agent/agent-brain-public-failure.js';
import { compilerPublicSummary } from '../../../worker/src/agent/agent-compiler.repository.js';

const turnId = randomUUID();
const scope = `turn:${turnId}`;
const base = { turn_id: turnId, agent_trace_id: randomUUID(), user_status: 'failed' };

function roundTrip(eventType: string, payload: Record<string, unknown>) {
  const envelope = projectPublicEvent(scope, {
    eventSeq: 1,
    eventType,
    payload: { ...base, ...payload },
    createdAt: new Date(),
  });
  return parseTurnEvent(JSON.stringify(envelope), scope);
}

describe('Worker -> API -> Web public failure contract', () => {
  it.each(AGENT_PUBLIC_SUMMARIES)('accepts the fixed summary: %s', (summary) => {
    expect(
      roundTrip('turn.failed', { summary, public_error_code: 'AGENT_MODEL_UNAVAILABLE' }).payload
        .summary,
    ).toBe(summary);
    const snapshot = {
      id: turnId,
      session_id: randomUUID(),
      user_status: 'failed',
      revision: 1,
      continuation_no: 1,
      agent_trace_id: base.agent_trace_id,
      skill_selection: {
        primary_skill_id: 'test@1.0.0',
        primary_name: 'Test',
        preset_selections: [],
      },
      model_selection: null,
      generation_preferences: null,
      execution_authorization: null,
      loaded_auxiliary_skills: [],
      run_quote_id: null,
      workflow_run_id: null,
      pending_confirmation: null,
      messages: [],
      activities: [],
      last_event_seq: 1,
      created_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      failure_summary: summary,
    };
    expect(parseTurnSnapshot({ ok: true, data: snapshot }, turnId).failure_summary).toBe(summary);
    expect(() =>
      parseTurnSnapshot({ ...snapshot, failure_summary: `${summary} private` }, turnId),
    ).toThrow();
  });

  it.each(AGENT_PUBLIC_ERROR_CODES)('accepts public code %s', (public_error_code) => {
    expect(() =>
      roundTrip('turn.failed', {
        summary: AGENT_BRAIN_FAILURE_SUMMARIES.unknown,
        public_error_code,
      }),
    ).not.toThrow();
  });

  it.each(AGENT_GUARDRAIL_TYPES)('accepts guardrail %s', (guardrail_type) => {
    expect(
      roundTrip('turn.guardrail_triggered', {
        guardrail_type,
        action: 'stopped',
        summary: '本次处理未能恢复，已停止，请重新发送需求',
      }).payload.guardrail_type,
    ).toBe(guardrail_type);
  });

  const diagnoses: Array<Parameters<typeof agentBrainPublicFailure>[1]> = [
    { code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED', statusCode: 429 },
    { code: 'AGENT_BRAIN_PROVIDER_TIMEOUT' },
    { code: 'AGENT_BRAIN_PROVIDER_NETWORK_FAILED' },
    { code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED', providerErrorCode: 'context_length_exceeded' },
    { code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED', statusCode: 401 },
    { code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED', providerErrorCode: 'insufficient_quota' },
    { code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED', statusCode: 400 },
    { code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED', statusCode: 503 },
    { code: 'AGENT_BRAIN_PROVIDER_RESPONSE_INVALID' },
    { code: 'AGENT_BRAIN_PROVIDER_STREAM_FAILED' },
    { code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED', providerErrorCode: 'content_filter' },
    undefined,
  ];
  it('projects every actual Brain classifier outcome, not only the shared list', () => {
    const produced = diagnoses.map((diagnostic) =>
      agentBrainPublicFailure('AGENT_BRAIN_UNAVAILABLE', diagnostic),
    );
    expect(new Set(produced)).toEqual(new Set(Object.values(AGENT_BRAIN_FAILURE_SUMMARIES)));
    for (const summary of produced) {
      expect(
        roundTrip('turn.failed', { summary, public_error_code: 'AGENT_MODEL_UNAVAILABLE' }),
      ).toMatchObject({ payload: { summary } });
    }
  });

  it('projects the actual compiler image-model failure', () => {
    const summary = compilerPublicSummary({
      status: 'rejected',
      code: 'model_not_approved',
      category: 'unavailable',
      retryable: false,
      safe_action: 'explain_unavailable',
      details: [{ rule_id: 'R1' }],
    });
    expect(
      roundTrip('turn.failed', { summary, public_error_code: 'AGENT_COMPILER_UNAVAILABLE' }),
    ).toMatchObject({ payload: { summary } });
  });

  it.each([
    { summary: 'private provider diagnostic sk-secret' },
    { public_error_code: 'AGENT_CALL_OUTCOME_UNKNOWN' },
    { provider_diagnostic: 'private' },
  ])('rejects private or unknown failure fields: %j', (extra) => {
    const payload = {
      ...base,
      summary: AGENT_BRAIN_FAILURE_SUMMARIES.unknown,
      public_error_code: 'AGENT_MODEL_UNAVAILABLE',
      ...extra,
    };
    expect(() =>
      projectPublicEvent(scope, {
        eventSeq: 1,
        eventType: 'turn.failed',
        payload,
        createdAt: new Date(),
      }),
    ).toThrow();
    expect(() =>
      parseTurnEvent(
        JSON.stringify({
          schema_version: 1,
          scope,
          event_seq: 1,
          event_type: 'turn.failed',
          occurred_at: new Date().toISOString(),
          payload,
        }),
        scope,
      ),
    ).toThrow();
  });
});
