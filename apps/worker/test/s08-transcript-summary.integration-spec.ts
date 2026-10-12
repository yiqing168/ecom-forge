import { randomUUID } from 'node:crypto';

import {
  deterministicFakeAgentModelSnapshot,
  persistedAgentTranscriptSummarySchema,
  prepareAgentTranscriptItem,
  type AgentBrainModelSnapshot,
  type AgentSessionSummaryContent,
  type AgentTranscriptSummarySourceItem,
  type PersistedAgentTranscriptSummary,
} from '@ecom-forge/agent';
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
  type Database,
  isIsolatedTranscriptDatabasePath,
} from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  AgentLlmCostRepository,
  type ReservedLlmStep,
} from '../src/agent/agent-llm-cost.repository.js';
import { AgentTurnLeaseRepository } from '../src/agent/agent-turn-lease.repository.js';
import { buildTranscriptSummaryCheckpoint } from '../src/agent/agent-transcript-summary.js';
import {
  setTranscriptMetricsSink,
  type TranscriptMetricEvent,
} from '../src/agent/agent-transcript-metrics.js';
import type { ClaimedAgentTurn, Transaction } from '../src/agent/agent-turn.types.js';
import type { AuthorizedAgentTranscriptItem } from '../src/agent/agent-transcript.repository.js';
import { nativeTranscriptContracts } from '../src/agent/agent-transcript-native.js';
import { transcriptItemValues } from '../src/agent/agent-transcript-storage-mapping.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || process.env.NODE_ENV === 'production') {
  throw new Error('Transcript summary tests require an explicit isolated TEST_DATABASE_URL');
}
const target = new URL(databaseUrl);
if (!isIsolatedTranscriptDatabasePath(target.pathname)) {
  throw new Error('Transcript summary tests refuse a non-test database');
}
const resource = createDatabaseClient({
  databaseUrl,
  maxConnections: 4,
  statementTimeoutMs: 5_000,
  applicationName: 'ecom-forge-s08-summary',
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
afterEach(() => setTranscriptMetricsSink(undefined));

const modelSnapshot: AgentBrainModelSnapshot = deterministicFakeAgentModelSnapshot({
  maxInputTokens: 96_000,
  maxOutputTokens: 8_192,
});
const fixtureModelSelectionSnapshot = {
  schema_version: 1 as const,
  catalog_revision: 1,
  catalog_release_id: '00000000-0000-4000-8000-000000000021',
  catalog_release_digest: 'c'.repeat(64),
  brain: {
    catalog_entry_id: '00000000-0000-4000-8000-000000000022',
    catalog_entry_revision: 1,
    version_no: 1,
    public_slug: 'fixture-brain',
    display_name: 'Fixture Brain',
    model_snapshot_id: '00000000-0000-4000-8000-000000000023',
  },
  image: {
    catalog_entry_id: '00000000-0000-4000-8000-000000000024',
    catalog_entry_revision: 1,
    version_no: 1,
    public_slug: 'fixture-image',
    display_name: 'Fixture Image',
    model_snapshot_id: '00000000-0000-4000-8000-000000000025',
    selected_spec_key: 'default',
    selected_operation: 'image.generate' as const,
    supported_aspect_ratios: ['1:1'],
  },
};
const fixtureGenerationPreferences = {
  schema_version: 2 as const,
  output_kind: 'image' as const,
  aspect_ratio: '1:1',
  resolution_tier: '1k' as const,
};
const content: AgentSessionSummaryContent = {
  goals: ['keep the subject'],
  confirmed_preferences: [],
  constraints: [],
  key_decisions: [],
  open_questions: [],
};
const usage = { input_tokens: 5, output_tokens: 2 };
const exposureCost = '0.01';
const hex = (seed: string) => canonicalSha256(seed);

const rollback = new Error('ROLLBACK_TRANSCRIPT_SUMMARY_FIXTURE');

/** Run a fixture inside one rolled-back transaction so nothing is committed. */
async function inRollback<T>(check: (tx: Transaction) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await resource.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '1s'`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      result = await check(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return result as T;
}

/** Each repository transaction gets a real savepoint, including rollback on rejection. */
function scoped(tx: Transaction): Database {
  return {
    transaction: (build: (transaction: Transaction) => Promise<unknown>) => tx.transaction(build),
  } as unknown as Database;
}

function syntheticItem(input: {
  sequence_no: string;
  item_type: string;
  turn_id: string;
  payload_digest: string;
}): AuthorizedAgentTranscriptItem {
  return {
    item: {
      id: randomUUID(),
      sequence_no: input.sequence_no,
      item_type: input.item_type,
      turn_id: input.turn_id,
      payload_digest: input.payload_digest,
      resource_dependencies_json: [],
    },
    history_generation: '1',
    private_payloads: [],
  } as unknown as AuthorizedAgentTranscriptItem;
}

/** A minimal, schema-valid v2 checkpoint for claim-boundary tests (coverage is not re-verified). */
function minimalCheckpoint(
  historyGeneration: string,
  summaryVersion = 1,
  turnId: string = randomUUID(),
) {
  const payloadDigest = hex('covered');
  return buildTranscriptSummaryCheckpoint({
    summaryVersion,
    historyGeneration,
    content,
    coveredItems: [
      syntheticItem({
        sequence_no: '1',
        item_type: 'user_message',
        turn_id: turnId,
        payload_digest: payloadDigest,
      }),
    ],
    sourceItems: [
      {
        item_id: randomUUID(),
        sequence_no: '1',
        item_type: 'user_message',
        payload_digest: payloadDigest,
      },
    ],
    coveredFromSequence: '1',
    coveredThroughSequence: '1',
    modelSnapshot,
    usage,
  });
}

interface NativeFixture {
  tx: Transaction;
  userId: string;
  sessionId: string;
  turnId: string;
  traceId: string;
  stepId: string;
  /** A second, still-`started` compaction step so a repeated publish can reach the session CAS. */
  retryStepId: string;
  owner: string;
  revision: number;
  continuationNo: number;
  itemIds: string[];
  coveredTurnId: string;
  sourceItems: AgentTranscriptSummarySourceItem[];
}

/** A native session with a closed, contiguous covered window of 3 items in one turn. */
async function nativeFixture(
  tx: Transaction,
  summaryVersion = 0,
  generation = 1n,
): Promise<NativeFixture> {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const coveredTurnId = randomUUID();
  const traceId = randomUUID();
  const stepId = randomUUID();
  const retryStepId = randomUUID();
  const owner = randomUUID();
  await tx.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    displayName: 'summary fixture',
  });
  await tx.insert(chatSessions).values({
    id: sessionId,
    userId,
    title: 'transcript summary fixture',
    summaryJson: {},
    summaryVersion,
    transcriptNextSequence: 4n,
    transcriptGeneration: generation,
    messageHistoryRevision: 1n,
    transcriptStateJson: {
      schema_version: 1,
      mode: 'active',
      integrity_version: 1,
      verified_through_sequence: '3',
      verified_digest: 'b'.repeat(64),
    },
  });
  await tx.insert(agentTurns).values({
    id: coveredTurnId,
    sessionId,
    userId,
    status: 'done',
    endedAt: new Date(),
    executionFormat: 'transcript_v1',
    transcriptCaptureVersion: 1,
  });
  await tx.insert(agentTurns).values({
    id: turnId,
    sessionId,
    userId,
    status: 'planning',
    executionFormat: 'transcript_v1',
    transcriptCaptureVersion: 1,
    processingOwner: owner,
    processingLeaseExpiresAt: new Date(Date.now() + 60_000),
    revision: 5,
    continuationNo: 1,
  });
  await tx.insert(agentTraces).values({
    id: traceId,
    turnId,
    sessionId,
    userId,
    brainModelId: 'fixture',
    reservedCost: exposureCost,
    estimatedCost: '0.00',
  });
  await tx.insert(agentTraceSteps).values({
    id: stepId,
    traceId,
    stepNo: 1,
    stepType: 'llm_call',
    actor: 'agent',
    status: 'started',
    inputSummary: {
      purpose: 'session_compaction',
      continuation_no: 1,
      reserved_exposure_cost_cny: exposureCost,
    },
    modelSnapshotJson: modelSnapshot,
    outputSummary: {},
    estimatedCost: exposureCost,
  });
  await tx.insert(agentTraceSteps).values({
    id: retryStepId,
    traceId,
    stepNo: 2,
    stepType: 'llm_call',
    actor: 'agent',
    status: 'started',
    inputSummary: {
      purpose: 'session_compaction',
      continuation_no: 1,
      reserved_exposure_cost_cny: exposureCost,
    },
    modelSnapshotJson: modelSnapshot,
    outputSummary: {},
    estimatedCost: exposureCost,
  });
  const assistantId = randomUUID();
  const sourceMessageId = randomUUID();
  const resultMessageId = randomUUID();
  await tx.insert(chatMessages).values([
    { id: sourceMessageId, sessionId, turnId: coveredTurnId, role: 'user', content: 'hello' },
    {
      id: resultMessageId,
      sessionId,
      turnId: coveredTurnId,
      role: 'assistant',
      content: 'Hello back',
    },
  ]);
  const args = { text: 'Hello back' };
  const payloads = [
    {
      schema_version: 1,
      type: 'user_message',
      content: { type: 'inline', value: { text: 'hello', attachments: [] } },
    },
    {
      schema_version: 1,
      type: 'assistant_output',
      mode: 'terminal',
      calls: [
        {
          name: 'agent_respond@1',
          arguments: { type: 'inline', value: args },
          arguments_digest: canonicalSha256(args),
          provider_call_id: null,
        },
      ],
    },
    {
      schema_version: 1,
      type: 'tool_result',
      name: 'agent_respond@1',
      arguments_digest: canonicalSha256(args),
      status: 'succeeded',
      result: {
        type: 'inline',
        value: {
          type: 'message_published',
          message_id: resultMessageId,
          content_digest: canonicalSha256({ text: 'Hello back' }),
        },
      },
    },
  ];
  const itemIds = [randomUUID(), assistantId, randomUUID()];
  const rows = [
    {
      id: itemIds[0]!,
      sequenceNo: 1n,
      itemType: 'user_message',
      replyToItemId: null as string | null,
      callOrdinal: null as number | null,
    },
    {
      id: itemIds[1]!,
      sequenceNo: 2n,
      itemType: 'assistant_output',
      replyToItemId: null as string | null,
      callOrdinal: null as number | null,
    },
    {
      id: itemIds[2]!,
      sequenceNo: 3n,
      itemType: 'tool_result',
      replyToItemId: assistantId as string | null,
      callOrdinal: 0 as number | null,
    },
  ];
  const sourceItems: AgentTranscriptSummarySourceItem[] = [];
  for (const [index, row] of rows.entries()) {
    const prepared = prepareAgentTranscriptItem(
      {
        id: row.id,
        user_id: userId,
        session_id: sessionId,
        turn_id: coveredTurnId,
        continuation_no: 1,
        sequence_no: row.sequenceNo.toString(),
        schema_version: 1,
        item_type: row.itemType,
        source_key: `fixture:${row.sequenceNo}`,
        source_message_id: row.itemType === 'user_message' ? sourceMessageId : null,
        source_trace_step_id: null,
        import_attempt_id: null,
        reply_to_item_id: row.replyToItemId,
        call_ordinal: row.callOrdinal,
        payload_json: payloads[index],
        resource_dependencies_json: [],
        created_at: new Date().toISOString(),
      },
      nativeTranscriptContracts,
    ).item;
    sourceItems.push({
      item_id: prepared.id,
      sequence_no: prepared.sequence_no,
      item_type: prepared.item_type as AgentTranscriptSummarySourceItem['item_type'],
      payload_digest: prepared.payload_digest,
    });
    await tx.insert(agentTranscriptItems).values({
      ...transcriptItemValues(prepared),
      id: row.id,
      userId,
      sessionId,
      turnId: coveredTurnId,
      continuationNo: 1,
      sequenceNo: row.sequenceNo,
      itemType: row.itemType,
      sourceKey: `fixture:${row.sequenceNo}`,
      sourceMessageId: prepared.source_message_id,
      sourceTraceStepId: null,
      importAttemptId: null,
      replyToItemId: row.replyToItemId,
      callOrdinal: row.callOrdinal,
      payloadJson: prepared.payload_json,
      payloadDigest: prepared.payload_digest,
      resourceDependenciesJson: [],
    });
  }
  return {
    tx,
    userId,
    sessionId,
    turnId,
    traceId,
    stepId,
    retryStepId,
    owner,
    revision: 5,
    continuationNo: 1,
    itemIds,
    coveredTurnId,
    sourceItems,
  };
}

function claimedOf(fixture: NativeFixture): ClaimedAgentTurn {
  return {
    turnId: fixture.turnId,
    sessionId: fixture.sessionId,
    traceId: fixture.traceId,
    userId: fixture.userId,
    owner: fixture.owner,
    continuationNo: fixture.continuationNo,
  } as ClaimedAgentTurn;
}

const stepOf = (fixture: NativeFixture, stepId: string = fixture.stepId): ReservedLlmStep => ({
  stepId,
  stepNo: stepId === fixture.stepId ? 1 : 2,
  exposureCost,
});

/** Build the strict v2 checkpoint the settlement should accept for a native fixture. */
function checkpointFor(
  fixture: NativeFixture,
  overrides: {
    summaryVersion?: number;
    historyGeneration?: string;
    coveredFrom?: string;
    coveredThrough?: string;
    sourceTurnId?: string;
    sourceContentDigest?: string;
  } = {},
): PersistedAgentTranscriptSummary {
  const sourceItems = fixture.sourceItems;
  const checkpoint = buildTranscriptSummaryCheckpoint({
    summaryVersion: overrides.summaryVersion ?? 1,
    historyGeneration: overrides.historyGeneration ?? '2',
    content,
    coveredItems: sourceItems.map((entry) =>
      syntheticItem({
        sequence_no: entry.sequence_no,
        item_type: entry.item_type,
        turn_id: overrides.sourceTurnId ?? fixture.coveredTurnId,
        payload_digest: entry.payload_digest,
      }),
    ),
    sourceItems,
    coveredFromSequence: overrides.coveredFrom ?? '1',
    coveredThroughSequence: overrides.coveredThrough ?? '3',
    modelSnapshot,
    usage,
  });
  return overrides.sourceContentDigest
    ? { ...checkpoint, source_content_digest: overrides.sourceContentDigest }
    : checkpoint;
}

function settle(
  repo: AgentLlmCostRepository,
  fixture: NativeFixture,
  summary: PersistedAgentTranscriptSummary,
  stepId: string = fixture.stepId,
) {
  return repo.settleTranscriptSummary({
    claimed: claimedOf(fixture),
    revision: fixture.revision,
    step: stepOf(fixture, stepId),
    outcome: { summary: content, usage },
    summary,
    expectedSummaryVersion: 0,
    expectedGeneration: '1',
    modelSnapshot,
    turnBudgetCost: '1.00',
  });
}

describe('native summary v2 settlement (PostgreSQL)', () => {
  it('rejects a changed checkpoint on a settled step without counting usage twice', () =>
    inRollback(async (tx) => {
      const f = await nativeFixture(tx);
      const repo = new AgentLlmCostRepository(scoped(tx));
      const summary = checkpointFor(f);
      await settle(repo, f, summary);
      await expect(settle(repo, f, summary)).resolves.toBeNull();
      await expect(
        settle(repo, f, { ...summary, source_content_digest: hex('changed') }),
      ).rejects.toThrow('AGENT_SESSION_SUMMARY_SETTLEMENT_INVALID');
      expect(
        await tx.query.agentTraces.findFirst({ where: eq(agentTraces.id, f.traceId) }),
      ).toMatchObject({ inputTokenTotal: 5, outputTokenTotal: 2, reservedCost: '0.00' });
    }));

  it('refuses publication by an owner whose processing lease has expired', () =>
    inRollback(async (tx) => {
      const f = await nativeFixture(tx);
      await tx
        .update(agentTurns)
        .set({ processingLeaseExpiresAt: new Date(0) })
        .where(eq(agentTurns.id, f.turnId));
      await expect(
        settle(new AgentLlmCostRepository(scoped(tx)), f, checkpointFor(f)),
      ).rejects.toThrow('AGENT_SESSION_SUMMARY_TURN_STALE');
      expect(
        await tx.query.chatSessions.findFirst({ where: eq(chatSessions.id, f.sessionId) }),
      ).toMatchObject({ summaryVersion: 0, transcriptGeneration: 1n });
      expect(
        await tx.query.agentTraceSteps.findFirst({ where: eq(agentTraceSteps.id, f.stepId) }),
      ).toMatchObject({ status: 'started' });
    }));

  it('rejects a still-active source and rolls back the model settlement', () =>
    inRollback(async (tx) => {
      const f = await nativeFixture(tx);
      await tx
        .update(agentTranscriptItems)
        .set({ turnId: f.turnId })
        .where(eq(agentTranscriptItems.sessionId, f.sessionId));
      await expect(
        settle(
          new AgentLlmCostRepository(scoped(tx)),
          f,
          checkpointFor(f, { sourceTurnId: f.turnId }),
        ),
      ).rejects.toThrow('AGENT_SESSION_SUMMARY_SOURCE_INVALID');
      const step = await tx.query.agentTraceSteps.findFirst({
        where: eq(agentTraceSteps.id, f.stepId),
      });
      expect(step?.status).toBe('started');
      const session = await tx.query.chatSessions.findFirst({
        where: eq(chatSessions.id, f.sessionId),
      });
      expect(session?.summaryVersion).toBe(0);
    }));

  it('rejects incomplete protocol coverage and a forged dependency set', () =>
    inRollback(async (tx) => {
      const f = await nativeFixture(tx);
      const repo = new AgentLlmCostRepository(scoped(tx));
      await expect(
        settle(repo, f, { ...checkpointFor(f), resource_dependencies: [{ unexpected: true }] }),
      ).rejects.toThrow('AGENT_SESSION_SUMMARY_SOURCE_INVALID');
      await tx.delete(agentTranscriptItems).where(eq(agentTranscriptItems.id, f.itemIds[2]!));
      await expect(settle(repo, f, checkpointFor(f, { coveredThrough: '2' }))).rejects.toThrow();
      expect(
        (await tx.query.agentTraceSteps.findFirst({ where: eq(agentTraceSteps.id, f.stepId) }))
          ?.status,
      ).toBe('started');
    }));

  it('settles known usage once without publishing after dependency revocation', () =>
    inRollback(async (tx) => {
      const f = await nativeFixture(tx);
      const repo = new AgentLlmCostRepository(scoped(tx));
      const checkpoint = checkpointFor(f);
      await tx.update(users).set({ riskStatus: 'frozen' }).where(eq(users.id, f.userId));
      await expect(settle(repo, f, checkpoint)).resolves.toMatchObject({
        published: false,
        transcriptGeneration: '1',
        currentSummary: null,
      });
      await expect(settle(repo, f, checkpoint)).resolves.toBeNull();
      expect(
        await tx.query.agentTraces.findFirst({ where: eq(agentTraces.id, f.traceId) }),
      ).toMatchObject({ reservedCost: '0.00', inputTokenTotal: 5, outputTokenTotal: 2 });
      expect(
        await tx.query.agentTraceSteps.findFirst({ where: eq(agentTraceSteps.id, f.stepId) }),
      ).toMatchObject({
        status: 'succeeded',
        tokenUsageJson: usage,
        outputSummary: { published: false },
      });
      expect(
        await tx.query.chatSessions.findFirst({ where: eq(chatSessions.id, f.sessionId) }),
      ).toMatchObject({ summaryVersion: 0, transcriptGeneration: 1n, summaryJson: {} });
    }));

  it('binds settlement to the reserved purpose, model, continuation and exposure', () =>
    inRollback(async (tx) => {
      const f = await nativeFixture(tx);
      await tx
        .update(agentTraceSteps)
        .set({ inputSummary: { purpose: 'agent_step' } })
        .where(eq(agentTraceSteps.id, f.stepId));
      await expect(
        settle(new AgentLlmCostRepository(scoped(tx)), f, checkpointFor(f)),
      ).rejects.toThrow('AGENT_SESSION_SUMMARY_SETTLEMENT_INVALID');
    }));
  it('publishes a strict v2 checkpoint and advances summary version and generation once', () =>
    inRollback(async (tx) => {
      const fixture = await nativeFixture(tx);
      const repo = new AgentLlmCostRepository(scoped(tx));
      const settled = await settle(repo, fixture, checkpointFor(fixture));
      expect(settled?.transcriptGeneration).toBe('2');
      const session = await tx.query.chatSessions.findFirst({
        where: eq(chatSessions.id, fixture.sessionId),
      });
      expect(session).toMatchObject({
        summaryVersion: 1,
        summaryThroughTurnId: fixture.coveredTurnId,
        transcriptGeneration: 2n,
      });
      const parsed = persistedAgentTranscriptSummarySchema.safeParse(session?.summaryJson);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).toMatchObject({
          schema_version: 2,
          summary_version: 1,
          history_generation: '2',
          covered_from_sequence: '1',
          covered_through_sequence: '3',
          source_turn_ids: [fixture.coveredTurnId],
          usage,
        });
      }
      const step = await tx.query.agentTraceSteps.findFirst({
        where: eq(agentTraceSteps.id, fixture.stepId),
      });
      expect(step).toMatchObject({ status: 'succeeded', tokenUsageJson: usage });
      const trace = await tx.query.agentTraces.findFirst({
        where: eq(agentTraces.id, fixture.traceId),
      });
      expect(trace).toMatchObject({ reservedCost: '0.00' });
    }));

  it('writes once under a repeated publish and reports a CAS conflict', () =>
    inRollback(async (tx) => {
      const fixture = await nativeFixture(tx);
      const repo = new AgentLlmCostRepository(scoped(tx));
      const events: TranscriptMetricEvent[] = [];
      setTranscriptMetricsSink({ info: (event) => events.push(event as TranscriptMetricEvent) });
      await expect(settle(repo, fixture, checkpointFor(fixture))).resolves.toMatchObject({
        transcriptGeneration: '2',
      });
      // The session has already advanced, so a second publish on a fresh step CAS-misses.
      await tx
        .update(agentTraces)
        .set({ reservedCost: exposureCost })
        .where(eq(agentTraces.id, fixture.traceId));
      await expect(
        settle(repo, fixture, checkpointFor(fixture), fixture.retryStepId),
      ).resolves.toMatchObject({ published: false, transcriptGeneration: '2' });
      const trace = await tx.query.agentTraces.findFirst({
        where: eq(agentTraces.id, fixture.traceId),
      });
      expect(trace).toMatchObject({
        reservedCost: '0.00',
        inputTokenTotal: 10,
        outputTokenTotal: 4,
      });
      await expect(
        settle(repo, fixture, checkpointFor(fixture), fixture.retryStepId),
      ).resolves.toBeNull();
      const session = await tx.query.chatSessions.findFirst({
        where: eq(chatSessions.id, fixture.sessionId),
      });
      // Published exactly once: version and generation never double-increment.
      expect(session).toMatchObject({ summaryVersion: 1, transcriptGeneration: 2n });
      expect(
        events.filter((event) => event.metric === 'transcript_summary_cas_conflict'),
      ).toHaveLength(1);
    }));

  it('CAS-guards on an advanced transcript generation', () =>
    inRollback(async (tx) => {
      const fixture = await nativeFixture(tx, 0, 2n);
      const repo = new AgentLlmCostRepository(scoped(tx));
      // expectedGeneration is '1' but the session has already moved to generation 2.
      await expect(settle(repo, fixture, checkpointFor(fixture))).resolves.toMatchObject({
        published: false,
        transcriptGeneration: '2',
        currentSummary: null,
      });
    }));

  it('rejects a checkpoint whose identity does not match its expected version', () =>
    inRollback(async (tx) => {
      const fixture = await nativeFixture(tx);
      const repo = new AgentLlmCostRepository(scoped(tx));
      await expect(
        settle(repo, fixture, checkpointFor(fixture, { summaryVersion: 5 })),
      ).rejects.toThrow('AGENT_SESSION_SUMMARY_SETTLEMENT_INVALID');
    }));

  it('rejects an ID-only source digest instead of trusting a list of IDs', () =>
    inRollback(async (tx) => {
      const fixture = await nativeFixture(tx);
      const repo = new AgentLlmCostRepository(scoped(tx));
      await expect(
        settle(
          repo,
          fixture,
          checkpointFor(fixture, { sourceContentDigest: canonicalSha256(fixture.itemIds) }),
        ),
      ).rejects.toThrow('AGENT_SESSION_COMPACTION_SOURCE_DIGEST_INVALID');
    }));

  it('rejects a coverage range that skips an item', () =>
    inRollback(async (tx) => {
      const fixture = await nativeFixture(tx);
      const repo = new AgentLlmCostRepository(scoped(tx));
      await expect(
        settle(repo, fixture, checkpointFor(fixture, { coveredThrough: '4' })),
      ).rejects.toThrow('AGENT_SESSION_SUMMARY_SOURCE_INVALID');
    }));

  it('rejects a checkpoint whose source turns do not cover the real window', () =>
    inRollback(async (tx) => {
      const fixture = await nativeFixture(tx);
      const repo = new AgentLlmCostRepository(scoped(tx));
      await expect(
        settle(repo, fixture, checkpointFor(fixture, { sourceTurnId: randomUUID() })),
      ).rejects.toThrow('AGENT_SESSION_SUMMARY_SOURCE_INVALID');
    }));

  it('rejects a legacy v1 summary stored for a native turn', () => {
    const v1 = {
      schema_version: 1,
      summary_version: 1,
      content,
      source_message_ids: [randomUUID()],
      source_message_digest: hex('ids'),
      through_turn_id: randomUUID(),
      model_snapshot_hash: hex('snapshot'),
      usage,
    };
    // A v1 shape can never validate as a v2 checkpoint (mutually exclusive contracts).
    expect(persistedAgentTranscriptSummarySchema.safeParse(v1).success).toBe(false);
  });
});

interface ClaimFixture {
  userId: string;
  sessionId: string;
  turnId: string;
  messageId: string;
  traceId: string;
  coveredTurnId: string;
}

async function claimFixture(
  tx: Transaction,
  options: {
    native: boolean;
    summaryJson: unknown;
    summaryVersion: number;
    summaryThroughTurnId: string | null;
    generation: bigint;
    coveredTurnId: string;
  },
): Promise<ClaimFixture> {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const messageId = randomUUID();
  const traceId = randomUUID();
  const executionAuthorization = {
    schema_version: 2 as const,
    kind: 'generate_action' as const,
    create_request_hash: canonicalSha256({ turn_id: turnId, message_id: messageId }),
    policy_version: 'agent-execution-policy-v1',
  };
  const selection = {
    primary_skill_id: 'summary-fixture@1.0.0',
    primary_name: 'Summary fixture',
    required_capabilities: [] as string[],
  };
  await tx.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    displayName: 'claim fixture',
  });
  // Insert the session without the summary boundary first: `summary_through_turn_id` and
  // `agent_turns.session_id` form a cycle, so the boundary is attached after the covered turn.
  await tx.insert(chatSessions).values({
    id: sessionId,
    userId,
    title: 'claim fixture',
    summaryJson: options.summaryJson,
    summaryVersion: options.summaryVersion,
    summaryThroughTurnId: null,
    transcriptGeneration: options.generation,
    transcriptNextSequence: 2n,
    messageHistoryRevision: 0n,
    transcriptStateJson: {
      schema_version: 1,
      mode: 'active',
      integrity_version: 1,
      verified_through_sequence: '1',
      verified_digest: 'b'.repeat(64),
    },
  });
  // A `transcript_v1` turn must carry `transcript_capture_version = 1` (schema check constraint).
  await tx.insert(agentTurns).values({
    id: options.coveredTurnId,
    sessionId,
    userId,
    status: 'done',
    endedAt: new Date(),
    createdAt: new Date(Date.now() - 60_000),
    executionFormat: options.native ? 'transcript_v1' : 'legacy_v1',
    transcriptCaptureVersion: options.native ? 1 : null,
  });
  if (options.summaryThroughTurnId !== null) {
    await tx
      .update(chatSessions)
      .set({ summaryThroughTurnId: options.summaryThroughTurnId })
      .where(eq(chatSessions.id, sessionId));
  }
  await tx.insert(agentTurns).values({
    id: turnId,
    sessionId,
    userId,
    status: 'received_user_input',
    executionFormat: options.native ? 'transcript_v1' : 'legacy_v1',
    transcriptCaptureVersion: options.native ? 1 : null,
    primarySkillId: selection.primary_skill_id,
    skillSelectionSnapshotJson: selection,
    skillSelectionSnapshotHash: canonicalSha256(selection),
    modelSelectionSnapshotJson: fixtureModelSelectionSnapshot,
    modelSelectionSnapshotHash: canonicalSha256(fixtureModelSelectionSnapshot),
    generationPreferencesJson: fixtureGenerationPreferences,
    generationPreferencesHash: canonicalSha256(fixtureGenerationPreferences),
    executionAuthorizationJson: executionAuthorization,
    executionAuthorizationHash: canonicalSha256(executionAuthorization),
  });
  await tx.insert(chatMessages).values({
    id: messageId,
    sessionId,
    turnId,
    role: 'user',
    content: 'hello world',
    attachments: [],
    skillSnapshots: [{ skill_id: selection.primary_skill_id }],
  });
  await tx.insert(agentTraces).values({
    id: traceId,
    turnId,
    sessionId,
    userId,
    brainModelId: 'fixture',
    brainModelSnapshotJson: modelSnapshot,
    skillIds: [selection.primary_skill_id],
  });
  return { userId, sessionId, turnId, messageId, traceId, coveredTurnId: options.coveredTurnId };
}

function claimRequest(fixture: ClaimFixture) {
  return {
    turnId: fixture.turnId,
    sessionId: fixture.sessionId,
    traceId: fixture.traceId,
    userMessageId: fixture.messageId,
    continuationNo: 1,
    payloadRevision: 0,
    leaseMs: 60_000,
    now: new Date(),
  };
}

describe('native summary v2 claim boundary (PostgreSQL)', () => {
  it('refuses a legacy v1 summary masquerading as a native v2 checkpoint', () =>
    inRollback(async (tx) => {
      const coveredTurnId = randomUUID();
      const fixture = await claimFixture(tx, {
        native: true,
        summaryVersion: 1,
        summaryThroughTurnId: coveredTurnId,
        generation: 1n,
        coveredTurnId,
        summaryJson: {
          schema_version: 1,
          summary_version: 1,
          content,
          source_message_ids: [randomUUID()],
          source_message_digest: hex('ids'),
          through_turn_id: coveredTurnId,
          model_snapshot_hash: hex('snapshot'),
          usage,
        },
      });
      const repository = new AgentTurnLeaseRepository(scoped(tx));
      await expect(repository.claim(claimRequest(fixture))).rejects.toThrow(
        'AGENT_SESSION_SUMMARY_INVALID',
      );
    }));

  it('refuses a v2 checkpoint whose recorded generation is stale', () =>
    inRollback(async (tx) => {
      const coveredTurnId = randomUUID();
      const fixture = await claimFixture(tx, {
        native: true,
        summaryVersion: 1,
        summaryThroughTurnId: coveredTurnId,
        generation: 3n,
        coveredTurnId,
        summaryJson: minimalCheckpoint('1', 1, coveredTurnId),
      });
      const repository = new AgentTurnLeaseRepository(scoped(tx));
      await expect(repository.claim(claimRequest(fixture))).rejects.toThrow(
        'AGENT_SESSION_SUMMARY_INVALID',
      );
    }));

  it.each([false, true])('validates the v2 checkpoint boundary (mismatch=%s)', (mismatch) =>
    inRollback(async (tx) => {
      const coveredTurnId = randomUUID();
      const fixture = await claimFixture(tx, {
        native: true,
        summaryVersion: 1,
        summaryThroughTurnId: coveredTurnId,
        generation: 1n,
        coveredTurnId,
        summaryJson: minimalCheckpoint('1', 1, mismatch ? randomUUID() : coveredTurnId),
      });
      const repository = new AgentTurnLeaseRepository(scoped(tx));
      if (mismatch) {
        await expect(repository.claim(claimRequest(fixture))).rejects.toThrow(
          'AGENT_SESSION_SUMMARY_INVALID',
        );
        return;
      }
      const claimed = await repository.claim(claimRequest(fixture));
      expect(claimed?.transcriptSummary).toMatchObject({
        schema_version: 2,
        summary_version: 1,
        history_generation: '1',
      });
      expect(claimed?.sessionSummaryVersion).toBe(1);
    }),
  );
});

/** `05` unified lock order: summary settlement must take the session lock before the turn lock. */
describe('summary settlement lock order (PostgreSQL)', () => {
  const lockApplicationName = 'ecom-forge-s08-summary';

  function gate() {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ready, release };
  }

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** The statement a settlement connection is currently blocked on. */
  async function waitingStatements(): Promise<string> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const rows = await resource.db.execute(sql`
        select query
        from pg_stat_activity
        where application_name = ${lockApplicationName}
          and wait_event_type = 'Lock'
        limit 1
      `);
      const query = rows[0]?.query;
      if (typeof query === 'string' && query.length > 0) return query;
      await delay(10);
    }
    throw new Error('Summary settlement did not enter a PostgreSQL lock wait');
  }

  it('waits on the session row instead of locking the turn first', async () => {
    const [user] = await resource.db
      .insert(users)
      .values({
        email: `s08-summary-lock-${randomUUID()}@example.test`,
        displayName: 'Summary lock order',
        emailVerifiedAt: new Date(),
      })
      .returning({ id: users.id });
    if (!user) throw new Error('Expected a fixture user');
    const [session] = await resource.db
      .insert(chatSessions)
      .values({
        userId: user.id,
        title: 'Summary settlement lock order',
        transcriptStateJson: {
          schema_version: 1,
          mode: 'active',
          integrity_version: 1,
          verified_through_sequence: '0',
          verified_digest: canonicalSha256([]),
        },
      })
      .returning({ id: chatSessions.id });
    if (!session) throw new Error('Expected a fixture session');
    const owner = `summary-lock-${randomUUID()}`;
    const [turn] = await resource.db
      .insert(agentTurns)
      .values({
        sessionId: session.id,
        userId: user.id,
        status: 'loading_context',
        executionFormat: 'transcript_v1',
        transcriptCaptureVersion: 1,
        processingOwner: owner,
        processingLeaseExpiresAt: new Date(Date.now() + 300_000),
        revision: 2,
        continuationNo: 1,
      })
      .returning({ id: agentTurns.id });
    if (!turn) throw new Error('Expected a fixture turn');

    const sessionHeld = gate();
    const sessionRelease = gate();
    const turnHeld = gate();
    const turnRelease = gate();
    // `FOR UPDATE` is the strength the API turn-create path uses; it excludes the settlement's
    // `FOR NO KEY UPDATE` request so the wait is observable.
    const sessionHolder = resource.db.transaction(async (tx) => {
      await tx.select().from(chatSessions).where(eq(chatSessions.id, session.id)).for('update');
      sessionHeld.release();
      await sessionRelease.ready;
    });
    const turnHolder = resource.db.transaction(async (tx) => {
      await tx.select().from(agentTurns).where(eq(agentTurns.id, turn.id)).for('update');
      turnHeld.release();
      await turnRelease.ready;
    });
    const repo = new AgentLlmCostRepository(resource.db);
    let settling: Promise<unknown> = Promise.resolve();
    try {
      await sessionHeld.ready;
      await turnHeld.ready;
      // Both rows are locked, so whichever lock the settlement requests first is the statement
      // that shows up as waiting. A turn-first order waits on `agent_turns`.
      settling = repo
        .settleTranscriptSummary({
          claimed: {
            turnId: turn.id,
            sessionId: session.id,
            userId: user.id,
            traceId: randomUUID(),
            continuationNo: 1,
            owner,
            revision: 2,
          } as ClaimedAgentTurn,
          revision: 2,
          step: { stepId: randomUUID(), stepNo: 1, exposureCost: '0.01' },
          outcome: { summary: content, usage },
          summary: {
            schema_version: 2,
            summary_version: 1,
          } as unknown as PersistedAgentTranscriptSummary,
          expectedSummaryVersion: 0,
          expectedGeneration: '1',
          modelSnapshot,
          turnBudgetCost: '1.00',
        })
        .catch((error: unknown) => error);
      const waiting = await waitingStatements();
      expect(waiting).toContain('chat_sessions');
      expect(waiting).not.toContain('agent_turns');
    } finally {
      sessionRelease.release();
      turnRelease.release();
      await Promise.allSettled([sessionHolder, turnHolder]);
      await settling;
      await resource.db.delete(agentTurns).where(eq(agentTurns.id, turn.id));
      await resource.db.delete(chatSessions).where(eq(chatSessions.id, session.id));
      await resource.db.delete(users).where(eq(users.id, user.id));
    }
  });
});
