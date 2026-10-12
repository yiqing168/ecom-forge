/**
 * End-to-end write-path verification for `previous_attempt_failure@1`.
 *
 * This suite exercises the REAL production write entry point
 * (`appendNativeTranscriptPrelude`) against a fresh, migrated, empty Postgres
 * database, then reads the turn back through the REAL repository
 * (`createNativeTranscriptReader`). It is deliberately separate from
 * `s08-previous-attempt-failure.integration-spec.ts`, which only proves the
 * derivation + the read-path verifier in isolation (no actual prelude write, no
 * reader round trip).
 *
 * Four properties are checked:
 *   1. Write  — the prelude persists an `agent_transcript_items` row with
 *              item_type='host_context', name='previous_attempt_failure@1', and
 *              content === derivePreviousAttemptFailure(...).
 *   2. Read   — that turn reads back through the real reader with no
 *              AGENT_TRANSCRIPT_READ_FAILED / transcript_integrity_failure, and
 *              the item is model-visible under that name.
 *   3. Sequence integrity — when BOTH `core_skill_knowledge@1` (hard-coded +1n)
 *              and `previous_attempt_failure@1` (+BigInt(items.length)) are
 *              appended in the same turn, the persisted sequence_no values are
 *              1,2,3 with no gap and no duplicate.
 *   4. No failure => no row — a session whose previous turn is `done` produces
 *              no `previous_attempt_failure@1` row and still reads cleanly.
 *
 * Every entity id is random UUID, so residual rows from other runs cannot
 * collide. The database is dropped by hand after the run (see the task script).
 */

import { randomUUID } from 'node:crypto';

import {
  agentTraceSteps,
  agentTraces,
  agentTranscriptItems,
  agentTurns,
  chatMessages,
  chatSessions,
  createDatabaseClient,
  eq,
  sql,
  users,
} from '@ecom-forge/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appendNativeTranscriptPrelude } from '../src/agent/agent-transcript-native.js';
import { createNativeTranscriptReader } from '../src/agent/agent-transcript-native-reader.js';
import {
  derivePreviousAttemptFailure,
  PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME,
  type PreviousAttemptFailureContext,
} from '../src/agent/agent-transcript-failure-context.js';
import type { ClaimedAgentTurn } from '../src/agent/agent-turn.types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || process.env.NODE_ENV === 'production') {
  throw new Error('Write-path tests require an explicit isolated TEST_DATABASE_URL');
}
const target = new URL(databaseUrl);
if (!/^\/ecom_forge_test(?:_[a-z0-9_]+)?$/.test(target.pathname)) {
  throw new Error('Write-path tests refuse a non-test database');
}
const resource = createDatabaseClient({
  databaseUrl,
  maxConnections: 2,
  statementTimeoutMs: 5_000,
});

const OWNER = 'write-path-verifier';
const MESSAGE = '继续生成产品落地页';
const HASH = 'a'.repeat(64);

// A synthetic but schema-valid skill selection. It is ONLY consumed by
// `prepareTranscriptCoreSkillContext` (pure projection) when isFirstSessionTurn
// is true; we do not DB-back the skill packages, so the resulting
// core_skill_knowledge@1 item is written but NOT reader-verifiable. That is
// acceptable for property 3, which is purely about sequence numbering.
const SYNTHETIC_SELECTION = {
  primary_skill_id: `skill-${'a'.repeat(20)}`,
  primary_name: 'Write Path Verifier Skill',
  primary_definition_hash: HASH,
  primary_package_record_id: randomUUID(),
  primary_planning_resource: {
    resource_snapshot_id: randomUUID(),
    package_resource_id: randomUUID(),
    resource_path: 'SKILL.md',
    resource_hash: HASH,
  },
  catalog_release_id: randomUUID(),
  catalog_version: HASH,
  preset_selections: [],
  required_auxiliary: [],
} as const;

const T0 = new Date('2026-09-01T00:00:00.000Z');
const CURRENT_AT = new Date(T0.getTime() + 3_600_000);

interface Scenario {
  previousStatus: 'blocked' | 'failed' | 'done';
  loopGuardrailHit: string | null;
  failedStepCode: string | null;
}

interface SeededIds {
  userId: string;
  sessionId: string;
  previousTurnId: string;
  currentTurnId: string;
  userMessageId: string;
}

async function seedScenario(tx: typeof resource.db, s: Scenario): Promise<SeededIds> {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const previousTurnId = randomUUID();
  const currentTurnId = randomUUID();
  const userMessageId = randomUUID();

  await tx.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    displayName: 'write-path fixture',
  });
  await tx.insert(chatSessions).values({
    id: sessionId,
    userId,
    title: 'write-path fixture',
    transcriptNextSequence: 1n,
    transcriptGeneration: 1n,
    messageHistoryRevision: 0n,
    transcriptStateJson: {
      schema_version: 1,
      mode: 'active',
      integrity_version: 1,
      verified_through_sequence: '0',
      verified_digest: '0'.repeat(64),
    },
  });
  await tx.insert(agentTurns).values({
    id: previousTurnId,
    sessionId,
    userId,
    status: s.previousStatus,
    createdAt: T0,
    executionFormat: 'transcript_v1',
    transcriptCaptureVersion: 1,
    revision: 1,
    continuationNo: 1,
  });
  await tx.insert(agentTurns).values({
    id: currentTurnId,
    sessionId,
    userId,
    status: 'received_user_input',
    createdAt: CURRENT_AT,
    executionFormat: 'transcript_v1',
    transcriptCaptureVersion: 1,
    revision: 1,
    continuationNo: 1,
    processingOwner: OWNER,
    processingLeaseExpiresAt: new Date(Date.now() + 3_600_000),
  });
  await tx.insert(chatMessages).values({
    id: userMessageId,
    sessionId,
    turnId: currentTurnId,
    role: 'user',
    content: MESSAGE,
  });

  if (s.previousStatus !== 'done') {
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
  }

  return { userId, sessionId, previousTurnId, currentTurnId, userMessageId };
}

function buildClaimed(input: {
  userId: string;
  sessionId: string;
  currentTurnId: string;
  userMessageId: string;
  /**
   * Only the sequence test needs the first-session-turn branch (which also appends the
   * core-skill context). Every other case appends the user message plus the failure context only,
   * which is what the prelude does for a session whose first turn already existed.
   */
  isFirstSessionTurn?: boolean;
}): ClaimedAgentTurn {
  // Only the fields the prelude actually reads are supplied; the rest of the
  // (large) ClaimedAgentTurn shape is irrelevant on the prelude's critical path.
  return {
    turnId: input.currentTurnId,
    sessionId: input.sessionId,
    traceId: randomUUID(),
    userMessageId: input.userMessageId,
    userId: input.userId,
    continuationNo: 1,
    revision: 1,
    owner: OWNER,
    message: MESSAGE,
    attachments: [],
    transcriptCaptureVersion: 1,
    transcriptGeneration: '1',
    isFirstSessionTurn: input.isFirstSessionTurn ?? false,
    selection: SYNTHETIC_SELECTION,
  } as unknown as ClaimedAgentTurn;
}

interface StoredItem {
  id: string;
  itemType: string;
  /** Raw `agent_transcript_items.sequence_no`, which Drizzle returns as a bigint. */
  sequenceNo: bigint;
  payloadJson: {
    type: string;
    name?: string;
    content?: { type: string; value: unknown };
  };
}

async function readTurnItems(turnId: string): Promise<StoredItem[]> {
  const rows = await resource.db.query.agentTranscriptItems.findMany({
    where: eq(agentTranscriptItems.turnId, turnId),
    orderBy: [sql`${agentTranscriptItems.sequenceNo} asc`],
  });
  return rows.map((row) => ({
    id: row.id,
    itemType: row.itemType,
    sequenceNo: row.sequenceNo,
    payloadJson: row.payloadJson as StoredItem['payloadJson'],
  }));
}

/** Only host contexts carry `content`; the other payload variants do not. */
function hostContextContent(item: {
  payload_json: unknown;
}): { type: string; value: unknown } | undefined {
  const payload = item.payload_json as {
    type?: string;
    content?: { type: string; value: unknown };
  } | null;
  return payload?.type === 'host_context' ? payload.content : undefined;
}

/** Only host contexts and tool results carry a `name`; the other payload variants do not. */
function payloadNameOf(item: { payload_json: unknown }): string | undefined {
  const payload = item.payload_json as { type?: string; name?: string } | null;
  return payload?.type === 'host_context' || payload?.type === 'tool_result'
    ? payload.name
    : undefined;
}

beforeAll(async () => {
  const rows = await resource.db.execute(sql`select
    to_regclass('public.agent_transcript_items')::text as items,
    to_regclass('public.agent_transcript_payloads')::text as payloads`);
  if (!rows[0]?.items || !rows[0]?.payloads) {
    throw new Error('Isolated database must already be migrated to head');
  }
});

afterAll(() => resource.client.end());

describe('previous_attempt_failure@1 write path (real prelude + real reader)', () => {
  it('1. WRITE: prelude persists previous_attempt_failure@1 with content === derivation', async () => {
    const ids = await seedScenario(resource.db, {
      previousStatus: 'failed',
      loopGuardrailHit: null,
      failedStepCode: 'AGENT_MODEL_UNAVAILABLE',
    });

    const derived = await derivePreviousAttemptFailure(resource.db, {
      userId: ids.userId,
      sessionId: ids.sessionId,
      turnId: ids.currentTurnId,
    });
    expect(derived).toEqual<PreviousAttemptFailureContext>({
      turn_id: ids.previousTurnId,
      user_status: 'failed',
      stop_reason: 'AGENT_MODEL_UNAVAILABLE',
    });

    // The real production entry point — no fakes.
    await appendNativeTranscriptPrelude(resource.db, buildClaimed(ids));

    const items = await readTurnItems(ids.currentTurnId);
    const paf = items.find(
      (item) =>
        item.itemType === 'host_context' &&
        item.payloadJson.name === PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME,
    );
    expect(paf, 'previous_attempt_failure@1 row must be persisted').toBeDefined();
    expect(paf!.payloadJson.type).toBe('host_context');
    expect(paf!.payloadJson.content?.type).toBe('inline');
    expect(paf!.payloadJson.content?.value).toEqual(derived);
    // The user message must also have been written.
    expect(items.some((i) => i.itemType === 'user_message')).toBe(true);
  });

  it('2. READ: the turn reads back cleanly through the real reader and the item is visible', async () => {
    const ids = await seedScenario(resource.db, {
      previousStatus: 'blocked',
      loopGuardrailHit: 'LOOP_GUARDRAIL_HIT',
      failedStepCode: null,
    });

    await appendNativeTranscriptPrelude(resource.db, buildClaimed(ids));

    // No AGENT_TRANSCRIPT_READ_FAILED / transcript_integrity_failure must be thrown.
    expect(() =>
      createNativeTranscriptReader(resource.db).readCurrentWindow({
        userId: ids.userId,
        sessionId: ids.sessionId,
        expectedGeneration: '1',
      }),
    ).not.toThrow();
    const window = await createNativeTranscriptReader(resource.db).readCurrentWindow({
      userId: ids.userId,
      sessionId: ids.sessionId,
      expectedGeneration: '1',
    });

    const names = window.items.map((entry) => payloadNameOf(entry.item) ?? entry.item.item_type);
    expect(names).toContain(PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME);

    const pafEntry = window.items.find(
      (entry) => payloadNameOf(entry.item) === PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME,
    );
    expect(pafEntry).toBeDefined();
    expect(pafEntry!.item.payload_json.type).toBe('host_context');
    expect(hostContextContent(pafEntry!.item)?.value).toEqual<PreviousAttemptFailureContext>({
      turn_id: ids.previousTurnId,
      user_status: 'blocked',
      stop_reason: 'LOOP_GUARDRAIL_HIT',
    });
  });

  it('3. SEQUENCE INTEGRITY: core_skill_knowledge@1 (+1n) and previous_attempt_failure@1 (+items.length) both append without gap/dup', async () => {
    // Session whose very first turn failed (previousTurn), then a second turn
    // (currentTurn) flagged as the first session turn so BOTH host contexts are
    // appended by the prelude in the same write.
    const ids = await seedScenario(resource.db, {
      previousStatus: 'failed',
      loopGuardrailHit: null,
      failedStepCode: 'AGENT_MODEL_UNAVAILABLE',
    });

    await appendNativeTranscriptPrelude(
      resource.db,
      buildClaimed({ ...ids, isFirstSessionTurn: true }),
    );

    const items = await readTurnItems(ids.currentTurnId);
    const sequences = items.map((i) => BigInt(i.sequenceNo));
    // No gaps and no duplicates starting at the turn's first sequence (1).
    expect(sequences).toEqual([1n, 2n, 3n]);
    expect(new Set(sequences).size).toBe(sequences.length);

    // Ordering must be: user_message(1) -> core_skill_knowledge@1(2) ->
    // previous_attempt_failure@1(3). A +1n/+1n bug would collide at 2.
    expect(items[0]!.itemType).toBe('user_message');
    expect(items[1]!.payloadJson.name).toBe('core_skill_knowledge@1');
    expect(items[1]!.sequenceNo).toBe(2n);
    expect(items[2]!.payloadJson.name).toBe(PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME);
    expect(items[2]!.sequenceNo).toBe(3n);
  });

  it('4. NO FAILURE => NO ROW: a done previous turn writes no previous_attempt_failure@1 and still reads cleanly', async () => {
    const ids = await seedScenario(resource.db, {
      previousStatus: 'done',
      loopGuardrailHit: null,
      failedStepCode: null,
    });

    await appendNativeTranscriptPrelude(resource.db, buildClaimed(ids));

    const items = await readTurnItems(ids.currentTurnId);
    expect(
      items.some(
        (item) =>
          item.itemType === 'host_context' &&
          item.payloadJson.name === PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME,
      ),
      'no previous_attempt_failure@1 row when the previous turn did not fail',
    ).toBe(false);
    // The user message is still written and the turn is readable.
    expect(items.some((i) => i.itemType === 'user_message')).toBe(true);

    const window = await createNativeTranscriptReader(resource.db).readCurrentWindow({
      userId: ids.userId,
      sessionId: ids.sessionId,
      expectedGeneration: '1',
    });
    const names = window.items.map((entry) => payloadNameOf(entry.item) ?? entry.item.item_type);
    expect(names).not.toContain(PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME);
  });
});
