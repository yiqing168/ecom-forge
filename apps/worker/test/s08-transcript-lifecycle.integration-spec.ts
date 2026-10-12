import { randomUUID } from 'node:crypto';

import { prepareAgentTranscriptItem } from '@ecom-forge/agent';
import { attachmentSnapshotSchema, type AttachmentSnapshot } from '@ecom-forge/compiler';
import {
  agentTranscriptItems,
  agentTurns,
  assets,
  chatMessages,
  chatSessions,
  createDatabaseClient,
  eq,
  sql,
  users,
  isIsolatedTranscriptDatabasePath,
} from '@ecom-forge/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AgentTranscriptReadError } from '../src/agent/agent-transcript.repository.js';
import {
  advanceTranscriptGenerationForCleanup,
  invalidateTranscriptForLifecycle,
} from '../src/agent/agent-transcript-lifecycle.js';
import { AgentTranscriptLifecycleSweeper } from '../src/agent/agent-transcript-lifecycle.sweeper.js';
import { nativeTranscriptContracts } from '../src/agent/agent-transcript-native.js';
import { createNativeTranscriptReader } from '../src/agent/agent-transcript-native-reader.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (
  !databaseUrl ||
  process.env.NODE_ENV === 'production' ||
  !isIsolatedTranscriptDatabasePath(new URL(databaseUrl).pathname)
) {
  throw new Error('Transcript lifecycle tests require an explicit isolated TEST_DATABASE_URL');
}
const resource = createDatabaseClient({
  databaseUrl,
  maxConnections: 4,
  statementTimeoutMs: 5_000,
});

beforeAll(async () => {
  const [row] = await resource.db.execute(
    sql`select to_regclass('public.agent_transcript_items')::text as items`,
  );
  if (!(row as { items: string | null } | undefined)?.items)
    throw new Error('Migration 0038 must already be installed; this suite never migrates');
});

afterEach(async () => {
  for (const f of trackedFixtures) {
    await resource.db.delete(agentTranscriptItems).where(eq(agentTranscriptItems.id, f.itemId));
    await resource.db.delete(chatMessages).where(eq(chatMessages.id, f.messageId));
    await resource.db.delete(agentTurns).where(eq(agentTurns.id, f.turnId));
    await resource.db.delete(chatSessions).where(eq(chatSessions.id, f.sessionId));
    await resource.db.delete(assets).where(eq(assets.id, f.assetId));
    await resource.db.delete(users).where(eq(users.id, f.userId));
  }
  trackedFixtures.clear();
});
afterAll(() => resource.client.end());

const attachment = (userId: string, assetId: string) =>
  attachmentSnapshotSchema.parse({
    binding_key: randomUUID(),
    kind: 'asset',
    object_id: assetId,
    object_version: 'a'.repeat(64),
    content_hash: 'a'.repeat(64),
    owner_user_id: userId,
    readable: true,
    mutable: false,
    producer_mode: null,
    producer_session_id: null,
    mutation_owner: null,
    source_action: null,
    media_type: 'image',
    lifecycle: 'active',
    visibility: 'private',
    role: 'semantic_reference',
    position: 7,
    publication_revision: null,
  });

interface Fixture {
  userId: string;
  sessionId: string;
  turnId: string;
  messageId: string;
  itemId: string;
  assetId: string;
  dependencies: AttachmentSnapshot[];
}

const trackedFixtures = new Set<Fixture>();

async function fixture(): Promise<Fixture> {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const messageId = randomUUID();
  const itemId = randomUUID();
  const assetId = randomUUID();
  const binding = attachment(userId, assetId);
  const dependencies = [binding];
  await resource.db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      email: `lifecycle-${userId}@example.test`,
      displayName: 'Transcript lifecycle fixture',
    });
    await tx.insert(chatSessions).values({
      id: sessionId,
      userId,
      title: 'Transcript lifecycle fixture',
      transcriptNextSequence: 2n,
      transcriptGeneration: 1n,
      messageHistoryRevision: 1n,
      transcriptStateJson: {
        schema_version: 1,
        mode: 'active',
        integrity_version: 1,
        verified_through_sequence: '1',
        verified_digest: 'b'.repeat(64),
      },
    });
    await tx
      .insert(agentTurns)
      .values({ id: turnId, sessionId, userId, status: 'done', transcriptCaptureVersion: 1 });
    await tx.insert(assets).values({
      id: assetId,
      userId,
      storageKey: `fixture/${assetId}`,
      thumbnailKey: `fixture/${assetId}/thumb`,
      contentHash: 'a'.repeat(64),
      fileSizeBytes: 128n,
      mimeType: 'image/png',
      kind: 'upload',
      origin: 'upload',
      status: 'ready',
    });
    await tx.insert(chatMessages).values({
      id: messageId,
      sessionId,
      turnId,
      role: 'user',
      content: 'hello',
      attachments: dependencies,
    });
    const { item } = prepareAgentTranscriptItem(
      {
        id: itemId,
        user_id: userId,
        session_id: sessionId,
        turn_id: turnId,
        continuation_no: 1,
        sequence_no: '1',
        schema_version: 1,
        item_type: 'user_message',
        source_key: `message:${messageId}`,
        source_message_id: messageId,
        source_trace_step_id: null,
        import_attempt_id: null,
        reply_to_item_id: null,
        call_ordinal: null,
        payload_json: {
          schema_version: 1,
          type: 'user_message',
          content: { type: 'inline', value: { text: 'hello', attachments: dependencies } },
        },
        resource_dependencies_json: dependencies,
        created_at: '2026-09-08T00:00:00.000Z',
      },
      nativeTranscriptContracts,
    );
    await tx.insert(agentTranscriptItems).values({
      id: item.id,
      userId,
      sessionId,
      turnId,
      continuationNo: item.continuation_no,
      sequenceNo: BigInt(item.sequence_no),
      itemType: item.item_type,
      sourceKey: item.source_key,
      sourceMessageId: item.source_message_id,
      payloadJson: item.payload_json,
      payloadDigest: item.payload_digest,
      resourceDependenciesJson: item.resource_dependencies_json,
    });
  });
  const result = { userId, sessionId, turnId, messageId, itemId, assetId, dependencies };
  trackedFixtures.add(result);
  return result;
}

function readItem(itemId: string, sessionId: string, userId: string) {
  return createNativeTranscriptReader(resource.db).readItem({ userId, sessionId, itemId });
}

function validSummary(f: Fixture) {
  return {
    schema_version: 1,
    summary_version: 1,
    content: {
      goals: ['g'],
      confirmed_preferences: [],
      constraints: [],
      key_decisions: [],
      open_questions: [],
    },
    source_message_ids: [f.messageId],
    source_message_digest: 'c'.repeat(64),
    through_turn_id: f.turnId,
    model_snapshot_hash: 'd'.repeat(64),
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe('transcript lifecycle PostgreSQL revocation', () => {
  it('can fence archived history for cleanup without making it readable again', async () => {
    const f = await fixture();
    const archivedAt = new Date();
    await resource.db
      .update(chatSessions)
      .set({ archivedAt, summaryJson: validSummary(f), summaryVersion: 1 })
      .where(eq(chatSessions.id, f.sessionId));
    await expect(
      resource.db.transaction((tx) =>
        advanceTranscriptGenerationForCleanup(tx, { userId: f.userId, sessionId: f.sessionId }),
      ),
    ).resolves.toMatchObject({ generation: '2', reason: 'cleanup' });
    expect(
      await resource.db.query.chatSessions.findFirst({ where: eq(chatSessions.id, f.sessionId) }),
    ).toMatchObject({ archivedAt, transcriptGeneration: 2n, summaryJson: {}, summaryVersion: 0 });
    await expect(readItem(f.itemId, f.sessionId, f.userId)).rejects.toBeInstanceOf(
      AgentTranscriptReadError,
    );
  });

  it('runs archived transcript cleanup from the Worker lifecycle boundary', async () => {
    const f = await fixture();
    const archivedAt = new Date('1900-01-01T00:00:00.000Z');
    await resource.db
      .update(chatSessions)
      .set({ archivedAt })
      .where(eq(chatSessions.id, f.sessionId));

    const summary = await new AgentTranscriptLifecycleSweeper(resource.db, 1).sweep(
      new Date('2026-01-01T00:00:00.000Z'),
    );

    expect(summary).toMatchObject({ sessions: 1, items: 1, payloads: 0, failed: 0 });
    expect(
      await resource.db.query.agentTranscriptItems.findMany({
        where: eq(agentTranscriptItems.sessionId, f.sessionId),
      }),
    ).toEqual([]);
    expect(
      await resource.db.query.chatSessions.findFirst({ where: eq(chatSessions.id, f.sessionId) }),
    ).toMatchObject({ transcriptGeneration: 2n, summaryJson: {}, summaryVersion: 0 });
  });

  it('advances batches and does not invalidate an already cleaned session again', async () => {
    const first = await fixture();
    const second = await fixture();
    for (const [index, f] of [first, second].entries()) {
      await resource.db
        .update(chatSessions)
        .set({
          archivedAt: new Date(index === 0 ? '1800-01-01T00:00:00Z' : '1800-01-02T00:00:00Z'),
        })
        .where(eq(chatSessions.id, f.sessionId));
    }
    const sweeper = new AgentTranscriptLifecycleSweeper(resource.db, 1);
    for (const f of [first, second]) {
      expect(await sweeper.sweep(new Date('2026-01-01T00:00:00Z'))).toMatchObject({
        sessions: 1,
        items: 1,
        failed: 0,
      });
      expect(
        await resource.db.query.agentTranscriptItems.findMany({
          where: eq(agentTranscriptItems.sessionId, f.sessionId),
        }),
      ).toEqual([]);
    }
    expect(await sweeper.sweep(new Date('2026-01-01T00:00:00Z'))).toMatchObject({
      sessions: 0,
      failed: 0,
    });
    for (const f of [first, second]) {
      expect(
        await resource.db.query.chatSessions.findFirst({ where: eq(chatSessions.id, f.sessionId) }),
      ).toMatchObject({ transcriptGeneration: 2n });
    }
  });

  it('cleans once under concurrent sweepers and skips a session locked by another writer', async () => {
    const f = await fixture();
    await resource.db
      .update(chatSessions)
      .set({ archivedAt: new Date('1800-01-01T00:00:00Z') })
      .where(eq(chatSessions.id, f.sessionId));
    const sweeper = new AgentTranscriptLifecycleSweeper(resource.db, 1);
    const now = new Date('2026-01-01T00:00:00Z');
    await resource.db.transaction(async (tx) => {
      await tx.select().from(chatSessions).where(eq(chatSessions.id, f.sessionId)).for('update');
      expect(await sweeper.sweep(now)).toMatchObject({ sessions: 0, failed: 0 });
    });
    const results = await Promise.all([sweeper.sweep(now), sweeper.sweep(now)]);
    expect(results.reduce((total, result) => total + result.sessions, 0)).toBe(1);
    expect(results.every((result) => result.failed === 0)).toBe(true);
    expect(
      await resource.db.query.chatSessions.findFirst({ where: eq(chatSessions.id, f.sessionId) }),
    ).toMatchObject({ transcriptGeneration: 2n });
  });

  it('rolls back invalidation with its failed cleanup transaction', async () => {
    const f = await fixture();
    await expect(
      resource.db.transaction(async (tx) => {
        await advanceTranscriptGenerationForCleanup(tx, {
          userId: f.userId,
          sessionId: f.sessionId,
        });
        throw new Error('CLEANUP_FAILED');
      }),
    ).rejects.toThrow('CLEANUP_FAILED');
    expect(
      await resource.db.query.chatSessions.findFirst({ where: eq(chatSessions.id, f.sessionId) }),
    ).toMatchObject({ transcriptGeneration: 1n });
    await expect(readItem(f.itemId, f.sessionId, f.userId)).resolves.toBeDefined();
  });

  it('rejects cleanup by a different owner without changing generation', async () => {
    const f = await fixture();
    await expect(
      resource.db.transaction((tx) =>
        advanceTranscriptGenerationForCleanup(tx, { userId: randomUUID(), sessionId: f.sessionId }),
      ),
    ).rejects.toThrow('AGENT_SESSION_MISSING');
    expect(
      await resource.db.query.chatSessions.findFirst({ where: eq(chatSessions.id, f.sessionId) }),
    ).toMatchObject({ transcriptGeneration: 1n });
  });

  it('rejects a revoked dependency immediately, before any cleanup generation bump', async () => {
    const f = await fixture();
    await expect(readItem(f.itemId, f.sessionId, f.userId)).resolves.toBeDefined();
    await resource.db
      .update(assets)
      .set({ status: 'deleted', deletedAt: new Date() })
      .where(eq(assets.id, f.assetId));
    await expect(readItem(f.itemId, f.sessionId, f.userId)).rejects.toMatchObject({
      reason: 'dependencies_unauthorized',
    });
    const [session] = await resource.db
      .select({ generation: chatSessions.transcriptGeneration })
      .from(chatSessions)
      .where(eq(chatSessions.id, f.sessionId));
    expect(session?.generation).toBe(1n);
  });

  it('advances generation in the cleanup transaction and invalidates the reusable summary', async () => {
    const f = await fixture();
    await resource.db
      .update(chatSessions)
      .set({ summaryJson: validSummary(f), summaryVersion: 1, summaryThroughTurnId: f.turnId })
      .where(eq(chatSessions.id, f.sessionId));

    const advance = await resource.db.transaction((tx) =>
      invalidateTranscriptForLifecycle(tx, {
        userId: f.userId,
        sessionId: f.sessionId,
        reason: 'resource_revoked',
      }),
    );
    expect(advance).toMatchObject({
      generation: '2',
      invalidated: true,
      reason: 'resource_revoked',
    });

    const session = await resource.db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, f.sessionId),
    });
    expect(session).toMatchObject({
      transcriptGeneration: 2n,
      summaryJson: {},
      summaryVersion: 0,
      summaryThroughTurnId: null,
    });

    // The stale checkpoint is unusable: a reader still pinned to generation 1 must be refused.
    await expect(
      createNativeTranscriptReader(resource.db).readCurrentWindow({
        userId: f.userId,
        sessionId: f.sessionId,
        expectedGeneration: '1',
        requireClosed: false,
      }),
    ).rejects.toMatchObject({ reason: 'history_changed' });
  });

  it('serializes concurrent cleanups without losing a generation increment', async () => {
    const f = await fixture();
    await Promise.all([
      resource.db.transaction((tx) =>
        invalidateTranscriptForLifecycle(tx, {
          userId: f.userId,
          sessionId: f.sessionId,
          reason: 'resource_isolated',
        }),
      ),
      resource.db.transaction((tx) =>
        advanceTranscriptGenerationForCleanup(tx, { userId: f.userId, sessionId: f.sessionId }),
      ),
    ]);
    const session = await resource.db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, f.sessionId),
    });
    expect(session?.transcriptGeneration).toBe(3n);
    expect(session?.summaryJson).toEqual({});
  });

  it('refuses to read a session whose mode is no longer active', async () => {
    const f = await fixture();
    for (const mode of ['off', 'backfill', 'shadow', 'invalid'] as const) {
      await resource.db
        .update(chatSessions)
        .set({ transcriptStateJson: { schema_version: 1, mode } })
        .where(eq(chatSessions.id, f.sessionId));
      await expect(readItem(f.itemId, f.sessionId, f.userId)).rejects.toMatchObject({
        reason: 'session_state_invalid',
      });
    }
  });

  it('surfaces a typed read error rather than an unclassified failure', async () => {
    const f = await fixture();
    await resource.db
      .update(assets)
      .set({ status: 'processing_failed' })
      .where(eq(assets.id, f.assetId));
    await expect(readItem(f.itemId, f.sessionId, f.userId)).rejects.toBeInstanceOf(
      AgentTranscriptReadError,
    );
  });
});
