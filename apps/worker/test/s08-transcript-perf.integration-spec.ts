import { randomUUID } from 'node:crypto';

import { prepareAgentTranscriptItem } from '@ecom-forge/agent';
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
  isIsolatedTranscriptDatabasePath,
} from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appendNativeTranscriptBatch } from '../src/agent/agent-transcript-append.js';
import { nativeTranscriptContracts } from '../src/agent/agent-transcript-native.js';
import { appendOutboxEventInTransaction } from '../src/database/outbox.repository.js';
import { AgentTranscriptWriteTransactions } from '../src/agent/agent-transcript-write-transaction.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (
  !databaseUrl ||
  process.env.NODE_ENV === 'production' ||
  !isIsolatedTranscriptDatabasePath(new URL(databaseUrl).pathname)
) {
  throw new Error('Transcript perf tests require an explicit isolated TEST_DATABASE_URL');
}
const resource = createDatabaseClient({
  databaseUrl,
  maxConnections: 12,
  statementTimeoutMs: 30_000,
});
const writer = new AgentTranscriptWriteTransactions(resource.db);

// docs/09 adjudicates the latency comparison at "same machine/data, >=1000 warmed samples per
// path, concurrency 1/4/8". The default here is a screening run; set PERF_SAMPLES=1000 for the
// adjudicated measurement.
const SAMPLES_PER_LEVEL = Number(process.env.PERF_SAMPLES ?? 200);
const WARMUP_PER_LEVEL = Number(process.env.PERF_WARMUP ?? 40);
const CONCURRENCY_LEVELS = [1, 4, 8] as const;
const BUDGET_DELTA_P95_MS = 20;

// Sampling advances in waves of `concurrency`, so a non-multiple sample count would collect fewer
// samples than requested and fail the per-level assertion for the wrong reason.
if (
  !Number.isInteger(SAMPLES_PER_LEVEL) ||
  SAMPLES_PER_LEVEL <= 0 ||
  CONCURRENCY_LEVELS.some((level) => SAMPLES_PER_LEVEL % level !== 0)
) {
  throw new Error('PERF_SAMPLES must be a positive multiple of every concurrency level (1/4/8)');
}

beforeAll(async () => {
  const [row] = await resource.db.execute(
    sql`select to_regclass('public.agent_transcript_items')::text as items`,
  );
  if (!row?.items)
    throw new Error('Migration 0038 must already be installed; this suite never migrates');
});
afterAll(() => resource.client.end());

const hash = (seed: string) => canonicalSha256(seed);
const uuid = () => randomUUID();

/** The host context payload the production prelude writes, so validation matches production. */
function planningBatch(input: {
  userId: string;
  sessionId: string;
  turnId: string;
  continuationNo: number;
  index: number;
}) {
  const metadata = {
    id: uuid(),
    user_id: input.userId,
    session_id: input.sessionId,
    turn_id: input.turnId,
    continuation_no: input.continuationNo,
    sequence_no: '1',
    schema_version: 1 as const,
    source_message_id: null,
    source_trace_step_id: uuid(),
    import_attempt_id: null,
    reply_to_item_id: null,
    call_ordinal: null,
    resource_dependencies_json: [] as unknown[],
    created_at: new Date().toISOString(),
  };
  const prepared = prepareAgentTranscriptItem(
    {
      ...metadata,
      item_type: 'host_context',
      source_key: `perf:${input.index}:${metadata.id}`,
      payload_json: {
        schema_version: 1,
        type: 'host_context',
        name: 'core_skill_knowledge@1',
        content: {
          type: 'inline',
          value: {
            schema_version: 1,
            selection_digest: hash(`selection:${input.index}`),
            catalog_release_id: uuid(),
            catalog_version: hash('catalog'),
            resources: [
              {
                resource_snapshot_id: uuid(),
                package_resource_id: uuid(),
                resource_path: 'SKILL.md',
                resource_hash: hash('primary:SKILL.md'),
                skill_id: 'creative-free@1.0.0',
                name: 'creative free',
                definition_hash: hash('primary'),
                package_record_id: uuid(),
              },
            ],
          },
        },
      },
    },
    nativeTranscriptContracts,
  );
  return { items: [prepared.item], privatePayloads: [] };
}

interface PerfFixture {
  userId: string;
  sessionId: string;
  turnId: string;
  traceId: string;
  continuationNo: number;
  owner: string;
  revision: number;
  expectedGeneration: string;
}

async function createFixture(): Promise<PerfFixture> {
  const userId = uuid();
  const sessionId = uuid();
  const turnId = uuid();
  const traceId = uuid();
  const owner = uuid();
  await resource.db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      email: `perf-${userId}@example.test`,
      displayName: 'Transcript perf fixture',
    });
    await tx.insert(chatSessions).values({
      id: sessionId,
      userId,
      title: 'Transcript perf fixture',
      transcriptGeneration: 1n,
      transcriptNextSequence: 1n,
      messageHistoryRevision: 1n,
      transcriptStateJson: {
        schema_version: 1,
        mode: 'active',
        integrity_version: 1,
        verified_through_sequence: '0',
        verified_digest: 'a'.repeat(64),
      },
    });
    await tx.insert(agentTurns).values({
      id: turnId,
      sessionId,
      userId,
      status: 'planning',
      executionFormat: 'transcript_v1',
      transcriptCaptureVersion: 1,
      processingOwner: owner,
      processingLeaseExpiresAt: new Date(Date.now() + 600_000),
      revision: 1,
      continuationNo: 1,
    });
    await tx.insert(agentTraces).values({
      id: traceId,
      turnId,
      sessionId,
      userId,
      brainModelId: 'perf-fixture',
      estimatedCost: '0.00',
    });
  });
  return {
    userId,
    sessionId,
    turnId,
    traceId,
    continuationNo: 1,
    owner,
    revision: 1,
    expectedGeneration: '1',
  };
}

/**
 * The pre-transcript step write: lock the turn, bump its revision (the legacy owner/revision CAS),
 * then write the public message, one trace step and one outbox event. Same locking regime and row
 * profile as a legacy Brain step, minus the semantic capture.
 */
async function legacyEquivalentWrite(input: PerfFixture, index: number) {
  await resource.db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '1s'`);
    const [turn] = await tx
      .select({ id: agentTurns.id, revision: agentTurns.revision })
      .from(agentTurns)
      .where(eq(agentTurns.id, input.turnId))
      .for('update');
    await tx
      .update(agentTurns)
      .set({ revision: turn!.revision + 1 })
      .where(eq(agentTurns.id, input.turnId));
    await tx.insert(chatMessages).values({
      id: uuid(),
      sessionId: input.sessionId,
      turnId: input.turnId,
      role: 'assistant',
      content: `legacy baseline write ${index}`,
      attachments: [],
      skillSnapshots: [],
    });
    await tx.insert(agentTraceSteps).values({
      id: uuid(),
      traceId: input.traceId,
      stepNo: index + 1,
      stepType: 'tool_call',
      actor: 'tool',
      toolName: 'load_skill',
      status: 'succeeded',
      inputSummary: { action: 'load_skill', index },
      outputSummary: { outcome: 'succeeded', index },
    });
    await appendOutboxEventInTransaction(tx, {
      scopeType: 'turn',
      scopeId: input.turnId,
      eventType: 'turn.activity_finished',
      payload: { turn_id: input.turnId, status: 'succeeded', index },
    });
  });
}

/** The P1 capture write: same owned transaction shape the production prelude uses. */
async function nativeCaptureWrite(input: PerfFixture, index: number) {
  const batch = planningBatch({ ...input, index });
  await writer.run(
    {
      userId: input.userId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      owner: input.owner,
      revision: input.revision,
      continuationNo: input.continuationNo,
      expectedGeneration: input.expectedGeneration,
    },
    (scope) => appendNativeTranscriptBatch(scope, batch, nativeTranscriptContracts),
  );
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

describe('native transcript capture latency (PostgreSQL, measured)', () => {
  it(
    'compares the capture write against the pre-transcript step write at concurrency 1/4/8',
    { timeout: 1_800_000 },
    async () => {
      const report: Array<{
        concurrency: number;
        samples: number;
        native_p50: number;
        native_p95: number;
        legacy_p50: number;
        legacy_p95: number;
        delta_p95: number;
      }> = [];
      const format = (entry: (typeof report)[number]) =>
        `concurrency=${entry.concurrency} samples=${entry.samples} ` +
        `native_p50=${entry.native_p50.toFixed(2)}ms native_p95=${entry.native_p95.toFixed(2)}ms ` +
        `legacy_p50=${entry.legacy_p50.toFixed(2)}ms legacy_p95=${entry.legacy_p95.toFixed(2)}ms ` +
        `delta_p95=${entry.delta_p95.toFixed(2)}ms`;

      const nativeInputs: PerfFixture[] = [];
      for (const concurrency of CONCURRENCY_LEVELS) {
        const nativeInput = await createFixture();
        nativeInputs.push(nativeInput);
        const legacyInput = await createFixture();
        const nativeSamples: number[] = [];
        const legacySamples: number[] = [];
        let index = 0;

        const runNative = () => {
          const started = performance.now();
          return nativeCaptureWrite(nativeInput, index++).then(() => performance.now() - started);
        };
        const runLegacy = () => {
          const started = performance.now();
          return legacyEquivalentWrite(legacyInput, index++).then(
            () => performance.now() - started,
          );
        };

        // Warm both paths before measuring, per the adjudicated measurement method.
        for (let warm = 0; warm < WARMUP_PER_LEVEL; warm += 1) {
          await runNative();
          await runLegacy();
        }

        for (let wave = 0; wave < SAMPLES_PER_LEVEL / concurrency; wave += 1) {
          const nativeWave = Array.from({ length: concurrency }, runNative);
          const legacyWave = Array.from({ length: concurrency }, runLegacy);
          nativeSamples.push(...(await Promise.all(nativeWave)));
          legacySamples.push(...(await Promise.all(legacyWave)));
        }

        const nativeP95 = percentile(nativeSamples, 0.95);
        const legacyP95 = percentile(legacySamples, 0.95);
        report.push({
          concurrency,
          samples: nativeSamples.length,
          native_p50: percentile(nativeSamples, 0.5),
          native_p95: nativeP95,
          legacy_p50: percentile(legacySamples, 0.5),
          legacy_p95: legacyP95,
          delta_p95: nativeP95 - legacyP95,
        });
      }

      const adjudicated = SAMPLES_PER_LEVEL >= 1000;
      console.info(
        `[transcript-perf] ${adjudicated ? 'ADJUDICATED' : 'screening'} report:`,
        report.map(format).join(' | '),
      );
      for (const entry of report) {
        expect(entry.samples).toBe(SAMPLES_PER_LEVEL);
        if (entry.delta_p95 > BUDGET_DELTA_P95_MS) {
          console.warn(
            `[transcript-perf] P1_LATENCY_BUDGET_NOT_MET concurrency=${entry.concurrency} ` +
              `delta_p95=${entry.delta_p95.toFixed(2)}ms (budget ${BUDGET_DELTA_P95_MS}ms, ` +
              `${adjudicated ? 'adjudicated' : 'screening'} sample)`,
          );
        }
      }

      // The docs/09 concurrency gate also requires zero lost/duplicated semantic rows: every
      // concurrent append must land on its own contiguous sequence with no gap or overlap, for
      // every fixture across all concurrency levels, not just the first one.
      for (const input of nativeInputs) {
        const session = await resource.db.query.chatSessions.findFirst({
          where: eq(chatSessions.id, input.sessionId),
        });
        const sequences = await resource.db
          .select({ sequenceNo: agentTranscriptItems.sequenceNo })
          .from(agentTranscriptItems)
          .where(eq(agentTranscriptItems.sessionId, input.sessionId));
        const values = sequences
          .map((item) => BigInt(item.sequenceNo))
          .sort((left, right) => {
            return left < right ? -1 : left > right ? 1 : 0;
          });
        const unique = new Set(values.map((value) => value.toString()));
        expect(unique.size).toBe(values.length);
        expect(values[0]).toBe(1n);
        expect(values.at(-1)).toBe(BigInt(session!.transcriptNextSequence) - 1n);
        expect(values.length).toBe(Number(session!.transcriptNextSequence) - 1);
      }
    },
  );
});
