import { randomUUID } from 'node:crypto';

import { prepareAgentTranscriptItem, type AgentTranscriptItem } from '@ecom-forge/agent';
import {
  agentTraces,
  agentTraceSteps,
  agentTurns,
  chatSessions,
  createDatabaseClient,
  eq,
  sql,
  users,
} from '@ecom-forge/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { nativeTranscriptContracts } from '../src/agent/agent-transcript-native.js';
import {
  AgentTranscriptPreviousAttemptFailureBinding,
  derivePreviousAttemptFailure,
  type PreviousAttemptFailureContext,
  PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME,
  previousAttemptFailureSourceKey,
} from '../src/agent/agent-transcript-failure-context.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || process.env.NODE_ENV === 'production') {
  throw new Error('Previous-attempt-failure tests require an explicit isolated TEST_DATABASE_URL');
}
const target = new URL(databaseUrl);
if (!/^\/ecom_forge_test(?:_[a-z0-9_]+)?$/.test(target.pathname)) {
  throw new Error('Previous-attempt-failure tests refuse a non-test database');
}
const resource = createDatabaseClient({
  databaseUrl,
  maxConnections: 2,
  statementTimeoutMs: 5_000,
});

beforeAll(async () => {
  const rows = await resource.db.execute(sql`select
    to_regclass('public.agent_transcript_items')::text as items,
    to_regclass('public.agent_transcript_payloads')::text as payloads`);
  if (!rows[0]?.items || !rows[0]?.payloads) {
    throw new Error(
      'Isolated database must already have migration 0038; this suite never migrates',
    );
  }
});
afterAll(() => resource.client.end());

interface Scenario {
  previousStatus: 'blocked' | 'failed' | 'done';
  loopGuardrailHit: string | null;
  failedStepCode: string | null;
  laterTurn?: { status: 'blocked' | 'failed' | 'done'; loopGuardrailHit: string | null };
}

interface SeededIds {
  userId: string;
  sessionId: string;
  previousTurnId: string;
  currentTurnId: string;
  laterTurnId: string | null;
}

const T0 = new Date('2026-09-01T00:00:00.000Z');
const CURRENT_AT = new Date(T0.getTime() + 3_600_000);
const LATER_AT = new Date(T0.getTime() + 7_200_000);

async function seedScenario(
  tx: Parameters<Parameters<typeof resource.db.transaction>[0]>[0],
  s: Scenario,
): Promise<SeededIds> {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const previousTurnId = randomUUID();
  const currentTurnId = randomUUID();
  const laterTurnId = s.laterTurn ? randomUUID() : null;

  await tx.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    displayName: 'PAF fixture',
  });
  await tx.insert(chatSessions).values({
    id: sessionId,
    userId,
    title: 'PAF fixture',
    transcriptNextSequence: 3n,
    transcriptGeneration: 1n,
    messageHistoryRevision: 1n,
    transcriptStateJson: {
      schema_version: 1,
      mode: 'active',
      integrity_version: 1,
      verified_through_sequence: '2',
      verified_digest: 'b'.repeat(64),
    },
  });
  await tx.insert(agentTurns).values({
    id: previousTurnId,
    sessionId,
    userId,
    status: s.previousStatus,
    createdAt: T0,
    transcriptCaptureVersion: 1,
  });
  await tx.insert(agentTurns).values({
    id: currentTurnId,
    sessionId,
    userId,
    status: 'done',
    createdAt: CURRENT_AT,
    transcriptCaptureVersion: 1,
  });
  if (s.laterTurn && laterTurnId) {
    await tx.insert(agentTurns).values({
      id: laterTurnId,
      sessionId,
      userId,
      status: s.laterTurn.status,
      createdAt: LATER_AT,
      transcriptCaptureVersion: 1,
    });
  }
  const prevTraceId = randomUUID();
  await tx.insert(agentTraces).values({
    id: prevTraceId,
    turnId: previousTurnId,
    sessionId,
    userId,
    brainModelId: 'fixture',
    loopGuardrailHit: s.loopGuardrailHit,
  });
  if (s.failedStepCode) {
    await tx.insert(agentTraceSteps).values({
      id: randomUUID(),
      traceId: prevTraceId,
      stepNo: 1,
      stepType: 'llm_call',
      actor: 'agent',
      status: 'succeeded',
      inputSummary: {},
      outputSummary: {},
    });
    await tx.insert(agentTraceSteps).values({
      id: randomUUID(),
      traceId: prevTraceId,
      stepNo: 2,
      stepType: 'llm_call',
      actor: 'agent',
      status: 'failed',
      errorCode: s.failedStepCode,
      inputSummary: {},
      outputSummary: {},
    });
  }
  if (s.laterTurn && laterTurnId) {
    const laterTraceId = randomUUID();
    await tx.insert(agentTraces).values({
      id: laterTraceId,
      turnId: laterTurnId,
      sessionId,
      userId,
      brainModelId: 'fixture',
      loopGuardrailHit: s.laterTurn.loopGuardrailHit,
    });
  }
  return { userId, sessionId, previousTurnId, currentTurnId, laterTurnId };
}

function buildPreviousAttemptFailureItem(input: {
  userId: string;
  sessionId: string;
  currentTurnId: string;
  content: PreviousAttemptFailureContext;
}): AgentTranscriptItem {
  const { item } = prepareAgentTranscriptItem(
    {
      id: randomUUID(),
      user_id: input.userId,
      session_id: input.sessionId,
      turn_id: input.currentTurnId,
      continuation_no: 1,
      sequence_no: '1',
      schema_version: 1,
      item_type: 'host_context',
      source_key: previousAttemptFailureSourceKey(input.currentTurnId),
      source_message_id: null,
      source_trace_step_id: null,
      import_attempt_id: null,
      reply_to_item_id: null,
      call_ordinal: null,
      payload_json: {
        schema_version: 1,
        type: 'host_context',
        name: PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME,
        content: { type: 'inline', value: input.content },
      },
      resource_dependencies_json: [],
      created_at: '2026-09-01T00:00:00.000Z',
    },
    nativeTranscriptContracts,
  );
  return item;
}

const rollbackMarker = new Error('ROLLBACK_PAF_FIXTURE');

async function withFixture(
  scenario: Scenario,
  check: (
    tx: Parameters<Parameters<typeof resource.db.transaction>[0]>[0],
    ids: SeededIds,
  ) => Promise<void>,
): Promise<void> {
  let sessionId: string | undefined;
  try {
    await resource.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '1s'`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const ids = await seedScenario(tx, scenario);
      sessionId = ids.sessionId;
      await check(tx, ids);
      throw rollbackMarker;
    });
  } catch (error) {
    if (error !== rollbackMarker) throw error;
  }
  if (sessionId) {
    expect(
      await resource.db.query.chatSessions.findFirst({ where: eq(chatSessions.id, sessionId) }),
    ).toBeUndefined();
  }
}

const blockedScenario: Scenario = {
  previousStatus: 'blocked',
  loopGuardrailHit: 'LOOP_GUARDRAIL_HIT',
  failedStepCode: null,
};
const failedScenario: Scenario = {
  previousStatus: 'failed',
  loopGuardrailHit: null,
  failedStepCode: 'AGENT_MODEL_UNAVAILABLE',
};

describe('previous_attempt_failure@1 continuity context (integration)', () => {
  it('derives the failure context from real Postgres for both terminal stops', async () => {
    await withFixture(blockedScenario, async (tx, ids) => {
      const blocked = await derivePreviousAttemptFailure(tx, {
        userId: ids.userId,
        sessionId: ids.sessionId,
        turnId: ids.currentTurnId,
      });
      expect(blocked).toEqual({
        turn_id: ids.previousTurnId,
        user_status: 'blocked',
        stop_reason: 'LOOP_GUARDRAIL_HIT',
      });
    });
    await withFixture(failedScenario, async (tx, ids) => {
      const failed = await derivePreviousAttemptFailure(tx, {
        userId: ids.userId,
        sessionId: ids.sessionId,
        turnId: ids.currentTurnId,
      });
      expect(failed).toEqual({
        turn_id: ids.previousTurnId,
        user_status: 'failed',
        stop_reason: 'AGENT_MODEL_UNAVAILABLE',
      });
    });
  });

  it('read-path acceptance: a prepared item verifies true against the derived DB state', () =>
    withFixture(blockedScenario, async (tx, ids) => {
      const derived = await derivePreviousAttemptFailure(tx, {
        userId: ids.userId,
        sessionId: ids.sessionId,
        turnId: ids.currentTurnId,
      });
      expect(derived).not.toBeNull();
      const item = buildPreviousAttemptFailureItem({
        userId: ids.userId,
        sessionId: ids.sessionId,
        currentTurnId: ids.currentTurnId,
        content: derived!,
      });
      const ok = await new AgentTranscriptPreviousAttemptFailureBinding(tx).verifySource(item);
      expect(ok).toBe(true);
    }));

  it('negatives: the same item verifies false when the DB diverges from the stored content', async () => {
    await withFixture(blockedScenario, async (tx, ids) => {
      const derived = await derivePreviousAttemptFailure(tx, {
        userId: ids.userId,
        sessionId: ids.sessionId,
        turnId: ids.currentTurnId,
      });
      const item = buildPreviousAttemptFailureItem({
        userId: ids.userId,
        sessionId: ids.sessionId,
        currentTurnId: ids.currentTurnId,
        content: derived!,
      });
      // Baseline: before any mutation the item is genuine.
      expect(await new AgentTranscriptPreviousAttemptFailureBinding(tx).verifySource(item)).toBe(
        true,
      );

      // Divergence A: previous turn is no longer terminal.
      await tx
        .update(agentTurns)
        .set({ status: 'done' })
        .where(eq(agentTurns.id, ids.previousTurnId));
      expect(await new AgentTranscriptPreviousAttemptFailureBinding(tx).verifySource(item)).toBe(
        false,
      );
    });

    await withFixture(blockedScenario, async (tx, ids) => {
      const derived = await derivePreviousAttemptFailure(tx, {
        userId: ids.userId,
        sessionId: ids.sessionId,
        turnId: ids.currentTurnId,
      });
      const item = buildPreviousAttemptFailureItem({
        userId: ids.userId,
        sessionId: ids.sessionId,
        currentTurnId: ids.currentTurnId,
        content: derived!,
      });
      expect(await new AgentTranscriptPreviousAttemptFailureBinding(tx).verifySource(item)).toBe(
        true,
      );

      // Divergence B: the controlled stop reason changed.
      await tx
        .update(agentTraces)
        .set({ loopGuardrailHit: 'DIFFERENT_GUARDRAIL' })
        .where(eq(agentTraces.turnId, ids.previousTurnId));
      expect(await new AgentTranscriptPreviousAttemptFailureBinding(tx).verifySource(item)).toBe(
        false,
      );
    });
  });

  it('stable anchor: a later third turn does not shift the derivation for the current turn', () =>
    withFixture(blockedScenario, async (tx, ids) => {
      // Capture the content exactly as the read path would have stored it for the two-turn session.
      const derived = await derivePreviousAttemptFailure(tx, {
        userId: ids.userId,
        sessionId: ids.sessionId,
        turnId: ids.currentTurnId,
      });
      expect(derived).toEqual({
        turn_id: ids.previousTurnId,
        user_status: 'blocked',
        stop_reason: 'LOOP_GUARDRAIL_HIT',
      });
      const item = buildPreviousAttemptFailureItem({
        userId: ids.userId,
        sessionId: ids.sessionId,
        currentTurnId: ids.currentTurnId,
        content: derived!,
      });

      // Now a THIRD, later turn is appended to the same session. Its content must NOT retroactively
      // change the previously-stored item: the derivation is anchored on the current turn's
      // (created_at, id), not "the latest turn in the session".
      const laterTurnId = randomUUID();
      await tx.insert(agentTurns).values({
        id: laterTurnId,
        sessionId: ids.sessionId,
        userId: ids.userId,
        status: 'blocked',
        createdAt: LATER_AT,
        transcriptCaptureVersion: 1,
      });
      await tx.insert(agentTraces).values({
        id: randomUUID(),
        turnId: laterTurnId,
        sessionId: ids.sessionId,
        userId: ids.userId,
        brainModelId: 'fixture',
        loopGuardrailHit: 'LATER_GUARDRAIL_HIT',
      });

      const ok = await new AgentTranscriptPreviousAttemptFailureBinding(tx).verifySource(item);
      expect(ok).toBe(true);
    }));
});
