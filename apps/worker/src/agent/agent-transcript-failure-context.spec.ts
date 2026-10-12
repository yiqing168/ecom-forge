import { prepareAgentTranscriptItem, type AgentTranscriptItem } from '@ecom-forge/agent';
import type { Database } from '@ecom-forge/db';
import { describe, expect, it } from 'vitest';

import {
  AgentTranscriptPreviousAttemptFailureBinding,
  derivePreviousAttemptFailure,
  PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME,
  preparePreviousAttemptFailure,
  previousAttemptFailureSourceKey,
} from './agent-transcript-failure-context.js';
import { nativeTranscriptContracts } from './agent-transcript-native.js';
import {
  NATIVE_HOST_CONTEXT_VERIFIER_NAMES,
  requireHostContextVerifiers,
} from './agent-transcript-native-reader.js';

const USER_ID = 'dddddddd-dddd-4ddd-8ddd-000000000001';
const SESSION_ID = 'eeeeeeee-eeee-4eee-8eee-000000000001';
const CURRENT_TURN_ID = 'ffffffff-ffff-4fff-8fff-000000000002';
const PREVIOUS_TURN_ID = 'ffffffff-ffff-4fff-8fff-000000000001';

/**
 * Regression lock for the host-context verifier dispatch.
 *
 * `createNativeTranscriptReader` asks a verifier keyed by the host-context name. It used to fall
 * back to the `runtime_policy@1` verifier for any unrecognised name, so registering a new host
 * context without wiring its verifier silently rejected the item and failed the *entire* read —
 * `source_invalid` → integrity failure → the session could never be read again. The two lists must
 * therefore stay equal, in both directions.
 */
describe('host context verifier coverage', () => {
  it('verifies every registered host context and no phantom names', () => {
    const registered = nativeTranscriptContracts.hostContexts.map((contract) => contract.name);

    expect(new Set(NATIVE_HOST_CONTEXT_VERIFIER_NAMES)).toEqual(new Set(registered));
  });

  it('fails loudly rather than falling back to another verifier', () => {
    expect(() => requireHostContextVerifiers()).not.toThrow();
  });
});

describe('previous attempt failure context', () => {
  it('keeps only controlled fields and drops prose', () => {
    const prepared = preparePreviousAttemptFailure({
      turnId: PREVIOUS_TURN_ID,
      status: 'failed',
      stopReason: '本轮请求处理超时，请稍后重试', // never persisted: not a controlled code
    });

    expect(prepared).toEqual({
      turn_id: PREVIOUS_TURN_ID,
      user_status: 'failed',
      stop_reason: null,
    });
  });

  it('accepts the lowercase codes the guardrail column actually stores', () => {
    expect(
      preparePreviousAttemptFailure({
        turnId: PREVIOUS_TURN_ID,
        status: 'blocked',
        stopReason: 'charge_blocked',
      })?.stop_reason,
    ).toBe('charge_blocked');
  });

  it('writes nothing when the previous attempt did not fail', () => {
    for (const status of ['done', 'planning', 'waiting_user_confirmation']) {
      expect(
        preparePreviousAttemptFailure({ turnId: PREVIOUS_TURN_ID, status, stopReason: null }),
      ).toBeNull();
    }
  });
});

function stubDatabase(input: {
  previous: { id: string; status: string } | null;
  loopGuardrailHit?: string | null;
  failedErrorCodes?: readonly (string | null)[];
  throws?: boolean;
}): Pick<Database, 'query'> {
  let calls = 0;
  return {
    query: {
      agentTurns: {
        findFirst: () => {
          if (input.throws) return Promise.reject(new Error('database unavailable'));
          calls += 1;
          if (calls === 1) return Promise.resolve({ id: CURRENT_TURN_ID, createdAt: new Date(0) });
          return Promise.resolve(
            input.previous
              ? { id: input.previous.id, status: input.previous.status, createdAt: new Date(0) }
              : null,
          );
        },
      },
      agentTraces: {
        findFirst: () =>
          Promise.resolve(
            typeof input.loopGuardrailHit === 'undefined'
              ? null
              : { id: 'trace-1', loopGuardrailHit: input.loopGuardrailHit },
          ),
      },
      agentTraceSteps: {
        findMany: () =>
          Promise.resolve((input.failedErrorCodes ?? []).map((errorCode) => ({ errorCode }))),
      },
    },
  } as unknown as Pick<Database, 'query'>;
}

/** Built through the real contract so a missing registration fails the test, not production. */
function buildItem(content: unknown): AgentTranscriptItem {
  return prepareAgentTranscriptItem(
    {
      id: 'cccccccc-cccc-4ccc-8ccc-000000000001',
      user_id: USER_ID,
      session_id: SESSION_ID,
      turn_id: CURRENT_TURN_ID,
      continuation_no: 1,
      sequence_no: '2',
      schema_version: 1,
      item_type: 'host_context',
      source_key: previousAttemptFailureSourceKey(CURRENT_TURN_ID),
      source_message_id: null,
      source_trace_step_id: null,
      import_attempt_id: null,
      reply_to_item_id: null,
      call_ordinal: null,
      payload_json: {
        schema_version: 1,
        type: 'host_context',
        name: PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME,
        content: { type: 'inline', value: content },
      },
      resource_dependencies_json: [],
      created_at: '2026-09-15T06:00:00.000Z',
    },
    nativeTranscriptContracts,
  ).item;
}

describe('previous attempt failure source verification', () => {
  it('derives the previous attempt from durable terminal state', async () => {
    const database = stubDatabase({
      previous: { id: PREVIOUS_TURN_ID, status: 'blocked' },
      loopGuardrailHit: 'AGENT_MODEL_UNAVAILABLE',
    });

    await expect(
      derivePreviousAttemptFailure(database, {
        userId: USER_ID,
        sessionId: SESSION_ID,
        turnId: CURRENT_TURN_ID,
      }),
    ).resolves.toEqual({
      turn_id: PREVIOUS_TURN_ID,
      user_status: 'blocked',
      stop_reason: 'AGENT_MODEL_UNAVAILABLE',
    });
  });

  it('falls back to the last failed step when the guardrail column is empty', async () => {
    const database = stubDatabase({
      previous: { id: PREVIOUS_TURN_ID, status: 'failed' },
      loopGuardrailHit: null,
      failedErrorCodes: [null, 'AGENT_BRAIN_TOOL_INPUT_INVALID'],
    });

    await expect(
      derivePreviousAttemptFailure(database, {
        userId: USER_ID,
        sessionId: SESSION_ID,
        turnId: CURRENT_TURN_ID,
      }),
    ).resolves.toEqual({
      turn_id: PREVIOUS_TURN_ID,
      user_status: 'failed',
      stop_reason: 'AGENT_BRAIN_TOOL_INPUT_INVALID',
    });
  });

  // The read path must accept exactly what the write path produced.
  it('verifies an item that matches the durable source', async () => {
    const binding = new AgentTranscriptPreviousAttemptFailureBinding(
      stubDatabase({
        previous: { id: PREVIOUS_TURN_ID, status: 'blocked' },
        loopGuardrailHit: 'AGENT_MODEL_UNAVAILABLE',
      }),
    );

    const item = buildItem({
      turn_id: PREVIOUS_TURN_ID,
      user_status: 'blocked',
      stop_reason: 'AGENT_MODEL_UNAVAILABLE',
    });

    await expect(binding.verifySource(item)).resolves.toBe(true);
  });

  it('rejects a stored item whose source no longer matches', async () => {
    // Same item, but the previous turn actually succeeded — the fast path must not trust the row.
    const binding = new AgentTranscriptPreviousAttemptFailureBinding(
      stubDatabase({ previous: { id: PREVIOUS_TURN_ID, status: 'done' } }),
    );

    await expect(
      binding.verifySource(
        buildItem({
          turn_id: PREVIOUS_TURN_ID,
          user_status: 'blocked',
          stop_reason: 'AGENT_MODEL_UNAVAILABLE',
        }),
      ),
    ).resolves.toBe(false);
  });

  it('refuses to persist an uncontrolled reason at all', () => {
    // The contract rejects it before it can reach the transcript (docs/08: no prose, no URLs).
    expect(() =>
      buildItem({
        turn_id: PREVIOUS_TURN_ID,
        user_status: 'blocked',
        stop_reason: 'relay rejected: see https://relay.example/token?signature=private',
      }),
    ).toThrow();
  });

  it('rejects a legacy row that carries an uncontrolled reason', async () => {
    const binding = new AgentTranscriptPreviousAttemptFailureBinding(
      stubDatabase({
        previous: { id: PREVIOUS_TURN_ID, status: 'blocked' },
        loopGuardrailHit: 'AGENT_MODEL_UNAVAILABLE',
      }),
    );
    const tampered = {
      ...buildItem({
        turn_id: PREVIOUS_TURN_ID,
        user_status: 'blocked',
        stop_reason: 'AGENT_MODEL_UNAVAILABLE',
      }),
      payload_json: {
        schema_version: 1,
        type: 'host_context',
        name: PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME,
        content: {
          type: 'inline',
          value: {
            turn_id: PREVIOUS_TURN_ID,
            user_status: 'blocked',
            stop_reason: 'relay rejected: signature=private',
          },
        },
      },
    } as unknown as AgentTranscriptItem;

    await expect(binding.verifySource(tampered)).resolves.toBe(false);
  });

  it('fails closed on a storage error instead of failing the read', async () => {
    const binding = new AgentTranscriptPreviousAttemptFailureBinding(
      stubDatabase({ previous: null, throws: true }),
    );

    await expect(
      binding.verifySource(
        buildItem({ turn_id: PREVIOUS_TURN_ID, user_status: 'failed', stop_reason: null }),
      ),
    ).resolves.toBe(false);
  });
});
