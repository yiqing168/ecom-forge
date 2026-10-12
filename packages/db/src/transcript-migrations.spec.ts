import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { and, eq, sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle, PostgresJsSession, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canonicalJson, canonicalSha256 } from '@ecom-forge/shared';

import { requireTestDatabaseUrl } from './test-database-env.js';
import { agentTranscriptItems, agentTranscriptPayloads } from './schema/agent-transcript.js';
import { agentTurns, chatMessages, chatSessions, users } from './schema/tables.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
const legacyUserId = randomUUID();
const legacySessionId = randomUUID();
const legacyTurnId = randomUUID();
const legacyMessageId = randomUUID();
const legacySummary = { schema_version: 1, summary: 'Existing summary fixture' };
const databaseName = `ecom_forge_test_transcript_${randomUUID().replaceAll('-', '')}`;

let client: ReturnType<typeof postgres> | undefined;
let database: PostgresJsDatabase;

interface Scope {
  userId: string;
  sessionId: string;
  turnId: string;
}

async function createScope(userId?: string): Promise<Scope> {
  const ownerId = userId ?? randomUUID();
  if (!userId) {
    await database.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.test`,
      displayName: 'Transcript storage fixture',
    });
  }
  const scope = { userId: ownerId, sessionId: randomUUID(), turnId: randomUUID() };
  await database.insert(chatSessions).values({
    id: scope.sessionId,
    userId: scope.userId,
    title: 'Transcript storage fixture',
  });
  await database.insert(agentTurns).values({
    id: scope.turnId,
    userId: scope.userId,
    sessionId: scope.sessionId,
    status: 'done',
  });
  return scope;
}

// These fixtures exercise relational constraints, not the future strict semantic parser.
function itemValues(
  scope: Scope,
  overrides: Partial<typeof agentTranscriptItems.$inferInsert> = {},
): typeof agentTranscriptItems.$inferInsert {
  const payload = { fixture: true };
  return {
    id: randomUUID(),
    ...scope,
    continuationNo: 1,
    sequenceNo: 1n,
    itemType: 'host_context',
    sourceKey: `fixture:${randomUUID()}`,
    payloadJson: payload,
    payloadDigest: canonicalSha256(payload),
    ...overrides,
  };
}

function payloadValues(
  scope: Scope,
  overrides: Partial<typeof agentTranscriptPayloads.$inferInsert> = {},
): typeof agentTranscriptPayloads.$inferInsert {
  const content = { fixture: true };
  return {
    id: randomUUID(),
    ...scope,
    kind: 'planning',
    contentJson: content,
    contentDigest: canonicalSha256(content),
    byteSize: Buffer.byteLength(canonicalJson(content), 'utf8'),
    ...overrides,
  };
}

function sessionScope(scope: Scope) {
  return and(eq(chatSessions.id, scope.sessionId), eq(chatSessions.userId, scope.userId));
}

function itemScope(scope: Scope) {
  return and(
    eq(agentTranscriptItems.sessionId, scope.sessionId),
    eq(agentTranscriptItems.userId, scope.userId),
  );
}

// A database-only transaction fixture, not the production append/fencing implementation.
async function appendFixture(scope: Scope, sourceKey: string, rollback = false) {
  return database.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '1s'`);
    await tx.execute(sql`set local statement_timeout = '5s'`);
    const [session] = await tx
      .select()
      .from(chatSessions)
      .where(sessionScope(scope))
      .for('no key update');
    if (!session) throw new Error('Missing session fixture');
    const sequenceNo = session.transcriptNextSequence;
    await tx
      .update(chatSessions)
      .set({
        transcriptNextSequence: sequenceNo + 1n,
        messageHistoryRevision: session.messageHistoryRevision + 1n,
      })
      .where(sessionScope(scope));
    await tx.insert(agentTranscriptItems).values(itemValues(scope, { sourceKey, sequenceNo }));
    await tx.insert(chatMessages).values({
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      role: 'assistant',
      content: 'Fixture',
    });
    if (rollback) throw new Error('Intentional fixture rollback');
    return sequenceNo;
  });
}

beforeAll(async () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Migration tests must not run against a production environment');
  }
  const targetUrl = new URL(requireTestDatabaseUrl());
  const adminUrl = new URL(targetUrl);
  adminUrl.pathname = '/postgres';
  targetUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 5 });
  try {
    await admin.unsafe(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }
  client = postgres(targetUrl.toString(), {
    max: 4,
    connect_timeout: 5,
    connection: { client_min_messages: 'warning' },
  });
  const config = { migrationsFolder };
  const migrations = readMigrationFiles(config);
  const transcriptIndex = migrations.findIndex((migration) =>
    migration.sql.some((statement) => statement.includes('CREATE TABLE "agent_transcript_items"')),
  );
  expect(transcriptIndex).toBeGreaterThan(0);
  const dialect = new PgDialect();
  await dialect.migrate(
    migrations.slice(0, transcriptIndex),
    new PostgresJsSession(client, dialect, undefined),
    config,
  );

  // Insert pre-extension rows through the old SQL surface, then apply the new migration normally.
  await client`insert into users (id, email, display_name)
    values (${legacyUserId}, ${`${legacyUserId}@example.test`}, 'Legacy fixture')`;
  await client`insert into chat_sessions (id, user_id, title, revision, summary_json, summary_version)
    values (${legacySessionId}, ${legacyUserId}, 'Existing session', 3, ${client.json(legacySummary)}, 2)`;
  await client`insert into agent_turns (id, user_id, session_id, status, revision, continuation_no)
    values (${legacyTurnId}, ${legacyUserId}, ${legacySessionId}, 'done', 4, 2)`;
  await client`insert into chat_messages (id, session_id, turn_id, role, content)
    values (${legacyMessageId}, ${legacySessionId}, ${legacyTurnId}, 'user', 'Existing message')`;
  database = drizzle(client);
  await migrate(database, config);
  // Same reason as the catalog hook: a full forward migration can exceed 30s under parallel load.
}, 180_000);

afterAll(async () => {
  await client?.end();
  // Retain the uniquely created database; no acceptance data or migration history is removed.
  console.info(`Transcript migration test database retained: ${databaseName}`);
});

describe('transcript forward migration', () => {
  it('records the exact migration hashes and timestamps through the transcript extension', async () => {
    const expected = readMigrationFiles({ migrationsFolder }).map((migration) => ({
      hash: migration.hash,
      createdAt: String(migration.folderMillis),
    }));
    const applied = await database.execute<{ hash: string; createdAt: string }>(sql`
      select hash, created_at::text as "createdAt"
      from drizzle.__drizzle_migrations order by created_at, id
    `);
    expect([...applied]).toEqual(expected);
  });

  it('leaves stored history and counters unchanged when migrations run again', async () => {
    const scope = await createScope();
    await appendFixture(scope, `fixture:${randomUUID()}`);
    await database.insert(agentTranscriptPayloads).values(payloadValues(scope));
    const snapshot = async () => ({
      sessions: await database.select().from(chatSessions).where(sessionScope(scope)),
      turns: await database
        .select()
        .from(agentTurns)
        .where(and(eq(agentTurns.id, scope.turnId), eq(agentTurns.userId, scope.userId))),
      items: await database.select().from(agentTranscriptItems).where(itemScope(scope)),
      messages: await database
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, scope.sessionId)),
      payloads: await database
        .select()
        .from(agentTranscriptPayloads)
        .where(
          and(
            eq(agentTranscriptPayloads.sessionId, scope.sessionId),
            eq(agentTranscriptPayloads.userId, scope.userId),
          ),
        ),
      migrations: [
        ...(await database.execute(sql`
          select id, hash, created_at from drizzle.__drizzle_migrations order by created_at, id
        `)),
      ],
    });
    const before = await snapshot();
    await migrate(database, { migrationsFolder });
    expect(await snapshot()).toEqual(before);
  });

  it('preserves legacy history and leaves capture and native reads disabled', async () => {
    const [session] = await database
      .select()
      .from(chatSessions)
      .where(and(eq(chatSessions.id, legacySessionId), eq(chatSessions.userId, legacyUserId)));
    expect(session).toMatchObject({
      title: 'Existing session',
      revision: 3,
      summaryJson: legacySummary,
      summaryVersion: 2,
      messageHistoryRevision: 0n,
      transcriptNextSequence: 1n,
      transcriptGeneration: 1n,
      transcriptStateJson: { schema_version: 1, mode: 'off' },
    });
    const [turn] = await database
      .select()
      .from(agentTurns)
      .where(and(eq(agentTurns.id, legacyTurnId), eq(agentTurns.userId, legacyUserId)));
    expect(turn).toMatchObject({
      status: 'done',
      revision: 4,
      continuationNo: 2,
      executionFormat: 'legacy_v1',
      transcriptCaptureVersion: null,
    });
    const [message] = await database
      .select()
      .from(chatMessages)
      .where(
        and(eq(chatMessages.id, legacyMessageId), eq(chatMessages.sessionId, legacySessionId)),
      );
    expect(message).toMatchObject({
      role: 'user',
      content: 'Existing message',
      turnId: legacyTurnId,
    });
    expect(
      await database
        .select()
        .from(agentTranscriptItems)
        .where(
          itemScope({
            userId: legacyUserId,
            sessionId: legacySessionId,
            turnId: legacyTurnId,
          }),
        ),
    ).toEqual([]);
  });

  it('keeps legacy callers valid when inserts omit all new fields', async () => {
    const scope = await createScope();
    const [session] = await database.select().from(chatSessions).where(sessionScope(scope));
    expect(session).toMatchObject({
      transcriptStateJson: { schema_version: 1, mode: 'off' },
      transcriptNextSequence: 1n,
      messageHistoryRevision: 0n,
      transcriptGeneration: 1n,
    });
    const [turn] = await database
      .select()
      .from(agentTurns)
      .where(and(eq(agentTurns.id, scope.turnId), eq(agentTurns.userId, scope.userId)));
    expect(turn).toMatchObject({ executionFormat: 'legacy_v1', transcriptCaptureVersion: null });
  });

  it.each([
    ['legacy_v1', null],
    ['legacy_v1', 1],
    ['transcript_v1', 1],
  ] as const)(
    'accepts execution/capture format %s/%s',
    async (executionFormat, transcriptCaptureVersion) => {
      const scope = await createScope();
      await database.insert(agentTurns).values({
        userId: scope.userId,
        sessionId: scope.sessionId,
        status: 'done',
        executionFormat,
        transcriptCaptureVersion,
      });
    },
  );

  it.each([
    ['transcript_v1', null],
    ['transcript_v1', 2],
    ['legacy_v1', 0],
    ['legacy_v1', 2],
    ['future', 1],
  ] as const)(
    'rejects incompatible execution/capture format %s/%s',
    async (executionFormat, transcriptCaptureVersion) => {
      const scope = await createScope();
      await expect(
        database.insert(agentTurns).values({
          userId: scope.userId,
          sessionId: scope.sessionId,
          status: 'done',
          executionFormat,
          transcriptCaptureVersion,
        }),
      ).rejects.toMatchObject({
        cause: { code: '23514', constraint_name: 'agent_turns_execution_format_valid' },
      });
    },
  );

  it.each([
    {},
    [],
    { schema_version: 1 },
    { mode: 'off' },
    { schema_version: '1', mode: 'off' },
    { schema_version: null, mode: 'off' },
    { schema_version: 2, mode: 'off' },
    { schema_version: 1, mode: null },
    { schema_version: 1, mode: 'unknown' },
    { schema_version: 1, mode: ['off'] },
    sql`'null'::jsonb`,
  ])('rejects missing or malformed state discriminators (%#)', async (transcriptStateJson) => {
    const scope = await createScope();
    await expect(
      database.update(chatSessions).set({ transcriptStateJson }).where(sessionScope(scope)),
    ).rejects.toMatchObject({
      cause: { code: '23514', constraint_name: 'chat_sessions_transcript_state_valid' },
    });
  });

  it.each([
    { messageHistoryRevision: -1n },
    { transcriptNextSequence: 0n },
    { transcriptGeneration: 0n },
    { transcriptNextSequence: -1n },
  ])('rejects invalid history counters (%#)', async (counters) => {
    const scope = await createScope();
    await expect(
      database.update(chatSessions).set(counters).where(sessionScope(scope)),
    ).rejects.toMatchObject({
      cause: { code: '23514', constraint_name: 'chat_sessions_transcript_counters_valid' },
    });
  });

  it('round-trips counters and sequence values beyond the JS safe integer boundary', async () => {
    const scope = await createScope();
    const value = 9007199254740993n;
    await database
      .update(chatSessions)
      .set({
        transcriptNextSequence: value + 1n,
        messageHistoryRevision: value,
        transcriptGeneration: value,
      })
      .where(sessionScope(scope));
    await database.insert(agentTranscriptItems).values(itemValues(scope, { sequenceNo: value }));
    const [session] = await database.select().from(chatSessions).where(sessionScope(scope));
    const [item] = await database.select().from(agentTranscriptItems).where(itemScope(scope));
    expect(session).toMatchObject({
      transcriptNextSequence: value + 1n,
      messageHistoryRevision: value,
      transcriptGeneration: value,
    });
    expect(item?.sequenceNo).toBe(value);
  });
});

describe('transcript relational constraints', () => {
  it('rejects cross-tenant, cross-session and nonexistent turn ownership', async () => {
    const scope = await createScope();
    const otherUser = await createScope();
    const otherSession = await createScope(scope.userId);
    const attempts = [
      { userId: otherUser.userId },
      { sessionId: otherSession.sessionId },
      { turnId: otherUser.turnId },
      { turnId: otherSession.turnId },
      { turnId: randomUUID() },
    ];
    for (const overrides of attempts) {
      await expect(
        database.insert(agentTranscriptItems).values(itemValues(scope, overrides)),
      ).rejects.toMatchObject({ cause: { code: '23503' } });
      await expect(
        database.insert(agentTranscriptPayloads).values(payloadValues(scope, overrides)),
      ).rejects.toMatchObject({ cause: { code: '23503' } });
    }
  });

  it('requires a result parent in the same tenant, session and turn', async () => {
    const scope = await createScope();
    const otherUser = await createScope();
    const otherSession = await createScope(scope.userId);
    const otherTurn = { ...scope, turnId: randomUUID() };
    await database.insert(agentTurns).values({
      id: otherTurn.turnId,
      userId: scope.userId,
      sessionId: scope.sessionId,
      status: 'done',
    });
    for (const parentScope of [otherUser, otherSession, otherTurn]) {
      const parent = itemValues(parentScope, { itemType: 'assistant_output' });
      await database.insert(agentTranscriptItems).values(parent);
      await expect(
        database.insert(agentTranscriptItems).values(
          itemValues(scope, {
            sequenceNo: 2n,
            itemType: 'tool_result',
            replyToItemId: parent.id,
            callOrdinal: 0,
          }),
        ),
      ).rejects.toMatchObject({
        cause: { code: '23503', constraint_name: 'agent_transcript_items_reply_owner_fk' },
      });
    }
    await expect(
      database.insert(agentTranscriptItems).values(
        itemValues(scope, {
          sequenceNo: 2n,
          itemType: 'tool_result',
          replyToItemId: randomUUID(),
          callOrdinal: 0,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('allows each batch ordinal once and allows that ordinal in a later batch', async () => {
    const scope = await createScope();
    const parent = itemValues(scope, { itemType: 'assistant_output' });
    await database.insert(agentTranscriptItems).values(parent);
    for (const callOrdinal of [0, 1, 2, 3]) {
      await database.insert(agentTranscriptItems).values(
        itemValues(scope, {
          sequenceNo: BigInt(callOrdinal + 2),
          itemType: 'tool_result',
          replyToItemId: parent.id,
          callOrdinal,
        }),
      );
    }
    await expect(
      database.insert(agentTranscriptItems).values(
        itemValues(scope, {
          sequenceNo: 6n,
          itemType: 'tool_result',
          replyToItemId: parent.id,
          callOrdinal: 0,
        }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'agent_transcript_items_reply_ordinal_unique' },
    });
    const nextParent = itemValues(scope, { itemType: 'assistant_output', sequenceNo: 6n });
    await database.insert(agentTranscriptItems).values(nextParent);
    await database.insert(agentTranscriptItems).values(
      itemValues(scope, {
        sequenceNo: 7n,
        itemType: 'tool_result',
        replyToItemId: nextParent.id,
        callOrdinal: 0,
      }),
    );
  });

  it.each([
    { itemType: 'tool_result' },
    { itemType: 'tool_result', replyToItemId: randomUUID() },
    { itemType: 'tool_result', callOrdinal: 0 },
    { itemType: 'tool_result', replyToItemId: randomUUID(), callOrdinal: -1 },
    { itemType: 'tool_result', replyToItemId: randomUUID(), callOrdinal: 4 },
    { itemType: 'host_context', replyToItemId: randomUUID(), callOrdinal: 0 },
    { itemType: 'user_message', callOrdinal: 0 },
    { itemType: 'assistant_output', replyToItemId: randomUUID() },
  ])('rejects incomplete or misplaced result links (%#)', async (overrides) => {
    const scope = await createScope();
    await expect(
      database.insert(agentTranscriptItems).values(itemValues(scope, overrides)),
    ).rejects.toMatchObject({
      cause: { code: '23514', constraint_name: 'agent_transcript_items_reply_pair_valid' },
    });
  });

  it('enforces source and sequence uniqueness per session, not globally', async () => {
    const scope = await createScope();
    const sourceKey = `fixture:${randomUUID()}`;
    await database.insert(agentTranscriptItems).values(itemValues(scope, { sourceKey }));
    await expect(
      database
        .insert(agentTranscriptItems)
        .values(itemValues(scope, { sourceKey, sequenceNo: 2n })),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'agent_transcript_items_session_source_unique' },
    });
    await expect(
      database.insert(agentTranscriptItems).values(itemValues(scope)),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'agent_transcript_items_session_sequence_unique' },
    });
    await database
      .insert(agentTranscriptItems)
      .values(itemValues(await createScope(), { sourceKey }));
  });

  it.each([
    { sequenceNo: 0n },
    { schemaVersion: 2 },
    { itemType: 'future' },
    { turnId: null },
    { continuationNo: null },
    { continuationNo: 0 },
    { payloadJson: [] },
    { payloadJson: sql`'null'::jsonb` },
    { resourceDependenciesJson: {} },
    { payloadDigest: 'not-a-digest' },
    { sourceKey: '' },
    { importAttemptId: randomUUID() },
    { itemType: 'legacy_message' },
    { itemType: 'legacy_message', importAttemptId: randomUUID(), turnId: null, continuationNo: 1 },
  ])('rejects invalid item structure (%#)', async (overrides) => {
    const scope = await createScope();
    await expect(
      database.insert(agentTranscriptItems).values(itemValues(scope, overrides)),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('preserves legacy provenance without inventing a turn or continuation', async () => {
    const scope = await createScope();
    const importAttemptId = randomUUID();
    const rows = [
      itemValues(scope, {
        itemType: 'legacy_message',
        importAttemptId,
        turnId: null,
        continuationNo: null,
      }),
      itemValues(scope, {
        itemType: 'legacy_message',
        importAttemptId,
        continuationNo: null,
        sequenceNo: 2n,
      }),
    ];
    await database.insert(agentTranscriptItems).values(rows);
    expect(
      await database
        .select({
          turnId: agentTranscriptItems.turnId,
          continuationNo: agentTranscriptItems.continuationNo,
        })
        .from(agentTranscriptItems)
        .where(itemScope(scope))
        .orderBy(agentTranscriptItems.sequenceNo),
    ).toEqual([
      { turnId: null, continuationNo: null },
      { turnId: scope.turnId, continuationNo: null },
    ]);
  });
});

describe('private transcript payload constraints', () => {
  it('deduplicates native content only within its turn and kind', async () => {
    const scope = await createScope();
    await database.insert(agentTranscriptPayloads).values(payloadValues(scope));
    await expect(
      database.insert(agentTranscriptPayloads).values(payloadValues(scope)),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'agent_transcript_payloads_native_digest_unique' },
    });
    await database
      .insert(agentTranscriptPayloads)
      .values(payloadValues(scope, { kind: 'authoring' }));
    const otherTurn = { ...scope, turnId: randomUUID() };
    await database.insert(agentTurns).values({
      id: otherTurn.turnId,
      userId: scope.userId,
      sessionId: scope.sessionId,
      status: 'done',
    });
    await database.insert(agentTranscriptPayloads).values(payloadValues(otherTurn));
    await database.insert(agentTranscriptPayloads).values(payloadValues(await createScope()));
  });

  it('isolates imported content from native data and other import attempts', async () => {
    const scope = await createScope();
    const importAttemptId = randomUUID();
    const imported = { kind: 'legacy_message', importAttemptId, turnId: null };
    await database.insert(agentTranscriptPayloads).values(payloadValues(scope));
    await database.insert(agentTranscriptPayloads).values(payloadValues(scope, imported));
    await expect(
      database.insert(agentTranscriptPayloads).values(payloadValues(scope, imported)),
    ).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'agent_transcript_payloads_import_digest_unique' },
    });
    await database.insert(agentTranscriptPayloads).values(
      payloadValues(scope, {
        ...imported,
        importAttemptId: randomUUID(),
      }),
    );
    await database
      .insert(agentTranscriptPayloads)
      .values(payloadValues(await createScope(scope.userId), imported));
  });

  it.each([
    { schemaVersion: 2 },
    { kind: 'future' },
    { kind: 'legacy_message' },
    { importAttemptId: randomUUID() },
    { turnId: null },
    { contentJson: [] },
    { contentJson: sql`'null'::jsonb` },
    { contentDigest: 'not-a-digest' },
    { byteSize: 0 },
    { byteSize: -1 },
    { byteSize: 8388609 },
  ])('rejects invalid payload structure (%#)', async (overrides) => {
    const scope = await createScope();
    await expect(
      database.insert(agentTranscriptPayloads).values(payloadValues(scope, overrides)),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('stores an actual 8 MiB canonical payload without truncation', async () => {
    const scope = await createScope();
    const overhead = Buffer.byteLength(canonicalJson({ text: '' }), 'utf8');
    const content = { text: 'x'.repeat(8388608 - overhead) };
    const digest = canonicalSha256(content);
    const byteSize = Buffer.byteLength(canonicalJson(content), 'utf8');
    expect(byteSize).toBe(8388608);
    await database.insert(agentTranscriptPayloads).values(
      payloadValues(scope, {
        contentJson: content,
        contentDigest: digest,
        byteSize,
      }),
    );
    const [stored] = await database
      .select()
      .from(agentTranscriptPayloads)
      .where(
        and(
          eq(agentTranscriptPayloads.userId, scope.userId),
          eq(agentTranscriptPayloads.sessionId, scope.sessionId),
        ),
      );
    expect(stored?.byteSize).toBe(byteSize);
    expect(canonicalSha256(stored?.contentJson)).toBe(digest);
    expect(Buffer.byteLength(canonicalJson(stored?.contentJson), 'utf8')).toBe(byteSize);
  }, 15_000);

  it('installs the dependency GIN index and native/import partial unique indexes', async () => {
    const indexes = await database.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes where schemaname = 'public'
        and tablename in ('agent_transcript_items', 'agent_transcript_payloads')
    `);
    const definitions = new Map(indexes.map((row) => [row.indexname, row.indexdef]));
    expect(definitions.get('agent_transcript_items_resource_dependencies_idx')).toContain(
      'USING gin (resource_dependencies_json jsonb_path_ops)',
    );
    expect(definitions.get('agent_transcript_payloads_native_digest_unique')).toContain(
      'WHERE (import_attempt_id IS NULL)',
    );
    expect(definitions.get('agent_transcript_payloads_import_digest_unique')).toContain(
      'WHERE (import_attempt_id IS NOT NULL)',
    );
  });
});

describe('transcript database transaction failure and concurrency', () => {
  it('rolls back counters, items and message projections together', async () => {
    const scope = await createScope();
    const sourceKey = `fixture:${randomUUID()}`;
    await expect(appendFixture(scope, sourceKey, true)).rejects.toThrow(
      'Intentional fixture rollback',
    );
    expect(await database.select().from(agentTranscriptItems).where(itemScope(scope))).toEqual([]);
    expect(
      await database.select().from(chatMessages).where(eq(chatMessages.sessionId, scope.sessionId)),
    ).toEqual([]);
    const [session] = await database.select().from(chatSessions).where(sessionScope(scope));
    expect(session).toMatchObject({ transcriptNextSequence: 1n, messageHistoryRevision: 0n });
    expect(await appendFixture(scope, sourceKey)).toBe(1n);
  });

  it('serializes concurrent sequence allocation under the session row lock', async () => {
    const scope = await createScope();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => appendFixture(scope, `fixture:${randomUUID()}`)),
    );
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const rows = await database
      .select({ sequenceNo: agentTranscriptItems.sequenceNo })
      .from(agentTranscriptItems)
      .where(itemScope(scope))
      .orderBy(agentTranscriptItems.sequenceNo);
    expect(rows.map((row) => row.sequenceNo)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
    const [session] = await database.select().from(chatSessions).where(sessionScope(scope));
    expect(session).toMatchObject({
      transcriptNextSequence: 9n,
      messageHistoryRevision: 8n,
      transcriptGeneration: 1n,
    });
  });

  it('rolls back losing concurrent source collisions without consuming a sequence', async () => {
    const scope = await createScope();
    const sourceKey = `fixture:${randomUUID()}`;
    const outcomes = await Promise.allSettled([
      appendFixture(scope, sourceKey),
      appendFixture(scope, sourceKey),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(failure).toMatchObject({
      status: 'rejected',
      reason: {
        cause: { code: '23505', constraint_name: 'agent_transcript_items_session_source_unique' },
      },
    });
    const [session] = await database.select().from(chatSessions).where(sessionScope(scope));
    expect(session).toMatchObject({ transcriptNextSequence: 2n, messageHistoryRevision: 1n });
    expect(await database.select().from(agentTranscriptItems).where(itemScope(scope))).toHaveLength(
      1,
    );
    expect(
      await database.select().from(chatMessages).where(eq(chatMessages.sessionId, scope.sessionId)),
    ).toHaveLength(1);
  });

  it('bounds lock waits and leaves the losing transaction unchanged', async () => {
    const scope = await createScope();
    let markHeld!: () => void;
    let releaseLock!: () => void;
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = database.transaction(async (tx) => {
      await tx.select().from(chatSessions).where(sessionScope(scope)).for('no key update');
      markHeld();
      await release;
    });
    try {
      await Promise.race([held, holder]);
      await expect(
        database.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '100ms'`);
          await tx
            .update(chatSessions)
            .set({ transcriptNextSequence: 2n })
            .where(sessionScope(scope));
        }),
      ).rejects.toMatchObject({ cause: { code: '55P03' } });
    } finally {
      releaseLock();
      await holder;
    }
    const [session] = await database.select().from(chatSessions).where(sessionScope(scope));
    expect(session?.transcriptNextSequence).toBe(1n);
  });
});
