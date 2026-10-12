import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type {
  AgentTranscriptItemContracts,
  AgentTranscriptPayloadReference,
} from '@ecom-forge/agent';
import type { agentTranscriptItems, agentTranscriptPayloads, Database } from '@ecom-forge/db';
import { createDatabaseClient } from '@ecom-forge/db';
import { canonicalJson, canonicalSha256 } from '@ecom-forge/shared';
import { verifyAgentTranscriptItem } from '@ecom-forge/agent';
import { WORKER_RUNTIME_DEFAULTS } from '../config/runtime-defaults.js';

import {
  AgentTranscriptReadError,
  AgentTranscriptRepository,
  type AgentTranscriptRepositoryOptions,
} from './agent-transcript.repository.js';

const uuid = (value: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${value.toString(16).padStart(12, '0')}`;
const userId = uuid(1);
const sessionId = uuid(2);
const turnId = uuid(3);
const messageId = uuid(4);
const itemId = uuid(5);
const traceStepId = uuid(6);
const payloadIdA = uuid(7);
const payloadIdB = uuid(8);
// SQL compilation is lazy: no connection or acceptance database is used here.
const sqlResource = createDatabaseClient({
  databaseUrl: 'postgresql://fixture:fixture@127.0.0.1:1/transcript_sql_test',
});
afterAll(() => sqlResource.client.end());

const textSchema = z.strictObject({ text: z.string() });
const countSchema = z.strictObject({ count: z.int() });
const inlineContract = { schema: textSchema } as const;
const toolTextContract = { schema: textSchema, privatePayloadKind: 'tool' } as const;
const toolCountContract = { schema: countSchema, privatePayloadKind: 'tool' } as const;
const resultContracts = {
  succeeded: inlineContract,
  rejected: { schema: z.strictObject({ code: z.literal('REJECTED') }) },
  not_executed: { schema: z.strictObject({ code: z.literal('NOT_EXECUTED') }) },
  unknown: { schema: z.strictObject({ code: z.literal('UNKNOWN') }) },
};
const contracts: AgentTranscriptItemContracts = {
  userMessage: inlineContract,
  legacyMessage: { schema: textSchema, privatePayloadKind: 'legacy_message' },
  calls: [
    {
      name: 'inspect_image@1',
      mode: 'tools',
      arguments: toolTextContract,
      results: resultContracts,
    },
    { name: 'load_skill@1', mode: 'tools', arguments: toolCountContract, results: resultContracts },
    { name: 'respond@1', mode: 'terminal', arguments: inlineContract, results: resultContracts },
  ],
  hostContexts: [{ name: 'phase_changed@1', content: inlineContract }],
  resourceDependencySchema: z.strictObject({
    binding_id: z.uuid(),
    resource_version: z.string(),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
};

const session = (overrides: Record<string, unknown> = {}) => ({
  id: sessionId,
  userId,
  archivedAt: null,
  transcriptStateJson: {
    schema_version: 1,
    mode: 'active',
    integrity_version: 1,
    verified_through_sequence: '20',
    verified_digest: 'b'.repeat(64),
  },
  transcriptGeneration: 1n,
  transcriptNextSequence: 21n,
  messageHistoryRevision: 4n,
  ...overrides,
});

const turn = (overrides: Record<string, unknown> = {}) => ({
  id: turnId,
  userId,
  sessionId,
  continuationNo: 1,
  transcriptCaptureVersion: 1,
  ...overrides,
});

const userMessage = (overrides: Record<string, unknown> = {}) => ({
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
    content: { type: 'inline', value: { text: 'hello' } },
  },
  resource_dependencies_json: [],
  created_at: '2026-09-08T00:00:00.000Z',
  ...overrides,
});

function dbFixture(input: {
  session?: unknown;
  item?: unknown;
  turn?: unknown;
  message?: unknown;
  payloads?: Map<string, unknown>;
  traceStep?: unknown;
  trace?: unknown;
  sessionReads?: unknown[];
}) {
  let sessionRead = 0;
  const raw = input.item as ReturnType<typeof assistantWithPrivateArguments> | undefined;
  const modelItem = raw?.item_type === 'assistant_output' ? raw : assistantWithPrivateArguments();
  // This fixture has an explicitly empty synthetic model input, not a production collector.
  const modelStep = {
    id: traceStepId,
    traceId: uuid(10),
    stepType: 'llm_call',
    actor: 'agent',
    status: 'succeeded',
    errorCode: null,
    inputSummary: {
      purpose: 'agent_step',
      continuation_no: 1,
      transcript_input: {
        schema_version: 1,
        step_id: traceStepId,
        continuation_no: 1,
        resource_dependencies_digest: canonicalSha256([]),
      },
    },
    outputSummary: {
      transcript_output: {
        schema_version: 1,
        step_id: traceStepId,
        assistant_item_id: modelItem.id,
        sequence_no: modelItem.sequence_no,
        payload_digest: canonicalSha256(modelItem.payload_json),
      },
    },
  };
  const database = {
    query: {
      chatSessions: {
        findFirst: vi.fn((_options: unknown) => {
          const value = input.sessionReads?.[sessionRead] ?? input.session;
          sessionRead += 1;
          return Promise.resolve(value);
        }),
      },
      agentTranscriptItems: {
        findMany: vi.fn((_options: unknown) =>
          Promise.resolve([] as Array<{ id: string; sequenceNo: bigint }>),
        ),
        findFirst: vi.fn((_options: unknown) =>
          Promise.resolve(
            input.item ? dbItemRow(input.item as Record<string, unknown>) : undefined,
          ),
        ),
      },
      agentTranscriptPayloads: {
        findFirst: vi.fn((_options: unknown) => {
          const payloads = input.payloads;
          if (!payloads) return Promise.resolve(undefined);
          const payloadId = [...payloads.keys()][0];
          return Promise.resolve(payloadId ? payloads.get(payloadId) : undefined);
        }),
      },
      agentTurns: { findFirst: vi.fn((_options: unknown) => Promise.resolve(input.turn)) },
      chatMessages: { findFirst: vi.fn((_options: unknown) => Promise.resolve(input.message)) },
      agentTraceSteps: {
        findFirst: vi.fn((_options: unknown) =>
          Promise.resolve('traceStep' in input ? input.traceStep : modelStep),
        ),
      },
      agentTraces: {
        findFirst: vi.fn((_options: unknown) =>
          Promise.resolve(
            'trace' in input ? input.trace : { id: uuid(10), turnId, sessionId, userId },
          ),
        ),
      },
    },
    select: sqlResource.db.select.bind(sqlResource.db),
  };
  return database;
}

function repository(
  database: ReturnType<typeof dbFixture>,
  overrides: {
    verifyMessageSource?: NonNullable<AgentTranscriptRepositoryOptions['verifyMessageSource']>;
    authorizeDependencies?: NonNullable<AgentTranscriptRepositoryOptions['authorizeDependencies']>;
    verifyHostContextSource?: NonNullable<
      AgentTranscriptRepositoryOptions['verifyHostContextSource']
    >;
    verifyToolResultSource?: NonNullable<
      AgentTranscriptRepositoryOptions['verifyToolResultSource']
    >;
  } = {},
) {
  const options: AgentTranscriptRepositoryOptions = {
    itemContracts: contracts,
    // Synthetic phase event source; real host bindings have their own integration tests.
    verifyHostContextSource: overrides.verifyHostContextSource ?? (() => true),
    // Synthetic tool schemas only; production call/result binding has its own tests.
    verifyToolResultSource: overrides.verifyToolResultSource ?? (() => true),
  };
  if (overrides.verifyMessageSource) {
    options.verifyMessageSource = overrides.verifyMessageSource;
  }
  if (overrides.authorizeDependencies)
    options.authorizeDependencies = overrides.authorizeDependencies;
  return new AgentTranscriptRepository(database as unknown as Database, options);
}

describe('native transcript window boundaries', () => {
  const emptySession = () =>
    session({
      transcriptNextSequence: 1n,
      transcriptStateJson: {
        schema_version: 1,
        mode: 'active',
        integrity_version: 1,
        verified_through_sequence: '0',
        verified_digest: 'b'.repeat(64),
      },
    });
  const request = { userId, sessionId, expectedGeneration: '1' };

  it('returns an empty window only at a valid closed boundary', async () => {
    const database = dbFixture({ session: emptySession() });
    expect(await repository(database).readCurrentWindow(request)).toMatchObject({
      items: [],
      history_generation: '1',
      protocol: { protocol_closed: true },
    });
    expect(database.query.chatSessions.findFirst).toHaveBeenCalledTimes(2);
  });

  it.each(['0', '-1', '01', 'NaN', '2'])(
    'rejects an invalid or future empty-window start %s',
    async (firstSequence) => {
      const reader = repository(dbFixture({ session: emptySession() }));
      await expect(reader.readCurrentWindow({ ...request, firstSequence })).rejects.toMatchObject({
        reason: 'input_invalid',
      });
    },
  );

  it('checks generation even when there are no items', async () => {
    const reader = repository(dbFixture({ session: emptySession() }));
    await expect(
      reader.readCurrentWindow({ ...request, expectedGeneration: '2' }),
    ).rejects.toMatchObject({ reason: 'history_changed' });
  });

  it('rejects an empty result if the tail changes during the read', async () => {
    const reader = repository(
      dbFixture({
        sessionReads: [emptySession(), { ...emptySession(), transcriptNextSequence: 2n }],
      }),
    );
    await expect(reader.readCurrentWindow(request)).rejects.toMatchObject({
      reason: 'history_changed',
    });
  });

  function pagedFixture() {
    const count = WORKER_RUNTIME_DEFAULTS.agentTranscriptReadPageItems + 1;
    const database = dbFixture({ session: session({ transcriptNextSequence: BigInt(count + 1) }) });
    const items = Array.from(
      { length: count },
      (_, index) =>
        verifyAgentTranscriptItem(
          {
            scope: { user_id: userId, session_id: sessionId },
            record: {
              ...userMessage({
                id: uuid(100 + index),
                source_key: `message:${uuid(1000 + index)}`,
                source_message_id: uuid(1000 + index),
                sequence_no: String(index + 1),
              }),
              payload_digest: canonicalSha256(userMessage().payload_json),
            },
          },
          contracts,
        ).item,
    );
    const rows = items.map((item) => ({ id: item.id, sequenceNo: BigInt(item.sequence_no) }));
    database.query.agentTranscriptItems.findMany
      .mockResolvedValueOnce(rows.slice(0, -1))
      .mockResolvedValueOnce(rows.slice(-1));
    const authorizer = vi.fn(() => true);
    const reader = repository(database, { authorizeDependencies: authorizer });
    const read = vi.spyOn(reader, 'readItem').mockImplementation(({ itemId: requestedId }) =>
      Promise.resolve({
        item: items.find((item) => item.id === requestedId)!,
        history_generation: '1',
        private_payloads: [],
      }),
    );
    return { database, reader, items, rows, read, authorizer };
  }

  it('advances keyset pages without reading an item twice and reauthorizes the entire window', async () => {
    const { database, reader, items, read, authorizer } = pagedFixture();
    const window = await reader.readCurrentWindow(request);
    expect(window.items.map((item) => item.item.id)).toEqual(items.map((item) => item.id));
    expect(read).toHaveBeenCalledTimes(items.length);
    expect(authorizer).toHaveBeenCalledTimes(items.length);
    expect(database.query.agentTranscriptItems.findMany).toHaveBeenCalledTimes(2);
    for (const [index, call] of database.query.agentTranscriptItems.findMany.mock.calls.entries()) {
      const options = call[0] as NonNullable<
        Parameters<typeof sqlResource.db.query.agentTranscriptItems.findMany>[0]
      >;
      expect(options.limit).toBe(WORKER_RUNTIME_DEFAULTS.agentTranscriptReadPageItems);
      const query = sqlResource.db.query.agentTranscriptItems
        .findMany({ where: options.where })
        .toSQL();
      expect(query.sql).toContain('>=');
      expect(query.params.map(String)).toContain(String(index === 0 ? 1 : items.length));
    }
  });

  it.each(['repeated', 'missing'] as const)(
    'fails closed on a %s page instead of looping or skipping',
    async (mode) => {
      const { database, reader, rows } = pagedFixture();
      database.query.agentTranscriptItems.findMany
        .mockReset()
        .mockResolvedValueOnce(rows.slice(0, -1))
        .mockResolvedValueOnce(mode === 'repeated' ? rows.slice(0, -1) : []);
      await expect(reader.readCurrentWindow(request)).rejects.toMatchObject({
        reason: mode === 'repeated' ? 'item_invalid' : 'item_unavailable',
      });
      expect(database.query.agentTranscriptItems.findMany).toHaveBeenCalledTimes(2);
    },
  );
});

function dbItemRow(record: Record<string, unknown>): typeof agentTranscriptItems.$inferSelect {
  const payload = record.payload_json;
  return {
    id: record.id as string,
    userId: record.user_id as string,
    sessionId: record.session_id as string,
    turnId: (record.turn_id as string | null) ?? null,
    continuationNo: (record.continuation_no as number | null) ?? null,
    sequenceNo: BigInt(record.sequence_no as string),
    schemaVersion: record.schema_version as number,
    itemType: record.item_type as string,
    sourceKey: record.source_key as string,
    sourceMessageId: (record.source_message_id as string | null) ?? null,
    sourceTraceStepId: (record.source_trace_step_id as string | null) ?? null,
    importAttemptId: (record.import_attempt_id as string | null) ?? null,
    replyToItemId: (record.reply_to_item_id as string | null) ?? null,
    callOrdinal: (record.call_ordinal as number | null) ?? null,
    payloadJson: payload,
    payloadDigest: (record.payload_digest as string | undefined) ?? canonicalSha256(payload),
    resourceDependenciesJson: record.resource_dependencies_json ?? [],
    createdAt: new Date(record.created_at as string),
  };
}

function payloadRow(id: string, content: Record<string, unknown>) {
  return {
    id,
    userId,
    sessionId,
    turnId,
    importAttemptId: null,
    kind: 'tool',
    schemaVersion: 1,
    contentJson: content,
    contentDigest: canonicalSha256(content),
    byteSize: Buffer.byteLength(canonicalJson(content), 'utf8'),
    createdAt: new Date('2026-09-08T00:00:00.000Z'),
  } satisfies typeof agentTranscriptPayloads.$inferSelect;
}

function privateReference(
  id: string,
  content: Record<string, unknown>,
): AgentTranscriptPayloadReference {
  return {
    schema_version: 1,
    type: 'private_payload',
    payload_id: id,
    kind: 'tool',
    content_digest: canonicalSha256(content),
    byte_size: Buffer.byteLength(canonicalJson(content), 'utf8'),
  };
}

function assistantWithPrivateArguments() {
  const text = { text: 'inspect' };
  const count = { count: 2 };
  return userMessage({
    id: uuid(9),
    sequence_no: '2',
    item_type: 'assistant_output',
    source_key: `model:${traceStepId}:output`,
    source_message_id: null,
    source_trace_step_id: traceStepId,
    payload_json: {
      schema_version: 1,
      type: 'assistant_output',
      mode: 'tools',
      calls: [
        {
          name: 'inspect_image@1',
          arguments: privateReference(payloadIdA, text),
          arguments_digest: canonicalSha256(text),
          provider_call_id: null,
        },
        {
          name: 'load_skill@1',
          arguments: privateReference(payloadIdB, count),
          arguments_digest: canonicalSha256(count),
          provider_call_id: null,
        },
      ],
    },
    resource_dependencies_json: [],
  });
}

function hostContext(overrides: Record<string, unknown> = {}) {
  return userMessage({
    item_type: 'host_context',
    source_message_id: null,
    source_key: 'context:read',
    payload_json: {
      schema_version: 1,
      type: 'host_context',
      name: 'phase_changed@1',
      content: { type: 'inline', value: { text: 'planning' } },
    },
    ...overrides,
  });
}

describe('AgentTranscriptRepository.readItem', () => {
  it.each(['missing_step', 'unbound_step'])(
    'rejects an assistant with %s before authorizing or materializing its private arguments',
    async (scenario) => {
      const item = {
        ...assistantWithPrivateArguments(),
        source_trace_step_id: scenario === 'missing_step' ? null : traceStepId,
        source_key: `model:${traceStepId}:output`,
      };
      const database = dbFixture({
        session: session(),
        item,
        turn: turn(),
        trace: { id: uuid(10), userId, sessionId, turnId },
        traceStep: {
          id: traceStepId,
          traceId: uuid(10),
          stepType: 'llm_call',
          actor: 'agent',
          status: 'succeeded',
          errorCode: null,
          inputSummary: { purpose: 'agent_step', continuation_no: 1 },
          outputSummary: { outcome: 'tool_calls' },
        },
      });
      const authorizeDependencies = vi.fn(() => true);
      await expect(
        repository(database, { authorizeDependencies }).readItem({
          userId,
          sessionId,
          itemId: item.id,
        }),
      ).rejects.toMatchObject({ reason: 'source_invalid' });
      expect(authorizeDependencies).not.toHaveBeenCalled();
      expect(database.query.agentTranscriptPayloads.findFirst).not.toHaveBeenCalled();
    },
  );

  it('materializes once between exactly two authorization passes', async () => {
    const database = dbFixture({ session: session(), item: hostContext(), turn: turn() });
    const phases: string[] = [];
    const repo = repository(database, {
      authorizeDependencies: () => {
        phases.push('authorize');
        return true;
      },
    });
    const value = await repo.readMaterializedItem({ userId, sessionId, itemId }, (entry) => {
      phases.push('materialize');
      expect(Object.isFrozen(entry)).toBe(true);
      return { itemId: entry.item.id, content: 'Authorized text' };
    });
    expect(value).toEqual({ itemId, content: 'Authorized text' });
    expect(phases).toEqual(['authorize', 'materialize', 'authorize']);
    expect(database.query.agentTranscriptItems.findFirst).toHaveBeenCalledTimes(1);
  });

  it('never invokes host materialization before authorization succeeds', async () => {
    const database = dbFixture({ session: session(), item: hostContext(), turn: turn() });
    const materialize = vi.fn(() => 'private');
    await expect(
      repository(database, { authorizeDependencies: () => false }).readMaterializedItem(
        { userId, sessionId, itemId },
        materialize,
      ),
    ).rejects.toMatchObject({ reason: 'dependencies_unauthorized' });
    expect(materialize).not.toHaveBeenCalled();
  });

  it('does not return materialized text when dependencies were revoked while reading', async () => {
    const database = dbFixture({ session: session(), item: hostContext(), turn: turn() });
    let authorized = true;
    await expect(
      repository(database, { authorizeDependencies: () => authorized }).readMaterializedItem(
        { userId, sessionId, itemId },
        () => {
          authorized = false;
          return 'private';
        },
      ),
    ).rejects.toMatchObject({ reason: 'dependencies_unauthorized' });
  });

  it('sanitizes unexpected host materialization failures', async () => {
    const database = dbFixture({ session: session(), item: hostContext(), turn: turn() });
    await expect(
      repository(database, { authorizeDependencies: () => true }).readMaterializedItem(
        { userId, sessionId, itemId },
        () => {
          throw new Error('private body must not escape in an error');
        },
      ),
    ).rejects.toMatchObject({
      message: 'AGENT_TRANSCRIPT_READ_FAILED',
      reason: 'storage_unavailable',
    });
  });

  it('requires a host source verifier even when dependencies are empty', async () => {
    const database = dbFixture({ session: session(), item: hostContext(), turn: turn() });
    const authorizer = vi.fn(() => true);
    const repo = new AgentTranscriptRepository(database as unknown as Database, {
      itemContracts: contracts,
      authorizeDependencies: authorizer,
    });
    await expect(repo.readItem({ userId, sessionId, itemId })).rejects.toMatchObject({
      reason: 'source_verifier_missing',
    });
    expect(authorizer).not.toHaveBeenCalled();
  });

  it.each([
    () => false,
    () => {
      throw new Error('private source details');
    },
  ])(
    'denies a rejected host source before dependency and payload reads',
    async (verifyHostContextSource) => {
      const database = dbFixture({ session: session(), item: hostContext(), turn: turn() });
      const authorizer = vi.fn(() => true);
      await expect(
        repository(database, {
          verifyHostContextSource,
          authorizeDependencies: authorizer,
        }).readItem({ userId, sessionId, itemId }),
      ).rejects.toMatchObject({ reason: 'source_invalid' });
      expect(authorizer).not.toHaveBeenCalled();
      expect(database.query.agentTranscriptPayloads.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each(['off', 'backfill', 'invalid'])('rejects %s state before item lookup', async (mode) => {
    const database = dbFixture({
      session: session({ transcriptStateJson: { schema_version: 1, mode } }),
    });
    await expect(
      repository(database).readItem({ userId, sessionId, itemId }),
    ).rejects.toMatchObject({ reason: 'session_state_invalid' });
    expect(database.query.agentTranscriptItems.findFirst).not.toHaveBeenCalled();
  });

  it.each([{ userId: uuid(99) }, { id: uuid(99) }])(
    'rejects a returned session outside the requested owner scope %j',
    async (overrides) => {
      const database = dbFixture({ session: session(overrides) });
      await expect(
        repository(database).readItem({ userId, sessionId, itemId }),
      ).rejects.toMatchObject({ reason: 'session_unavailable' });
      expect(database.query.agentTranscriptItems.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each([{ user_id: uuid(99) }, { session_id: uuid(99) }, { id: uuid(99) }])(
    'rejects an item outside the requested identity %j',
    async (overrides) => {
      const database = dbFixture({
        session: session(),
        item: hostContext(overrides),
        turn: turn(),
      });
      await expect(
        repository(database).readItem({ userId, sessionId, itemId }),
      ).rejects.toMatchObject({ reason: 'item_invalid' });
      expect(database.query.agentTurns.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each([
    { continuationNo: 0 },
    { transcriptCaptureVersion: null },
    { userId: uuid(99) },
    { sessionId: uuid(99) },
  ])('rejects incompatible turn provenance %j', async (overrides) => {
    const database = dbFixture({ session: session(), item: hostContext(), turn: turn(overrides) });
    await expect(
      repository(database, { authorizeDependencies: () => true }).readItem({
        userId,
        sessionId,
        itemId,
      }),
    ).rejects.toMatchObject({ reason: 'source_invalid' });
  });

  it('normalizes identity UUIDs without changing message semantics', async () => {
    const database = dbFixture({ session: session(), item: hostContext(), turn: turn() });
    const result = await repository(database, { authorizeDependencies: () => true }).readItem({
      userId: userId.toUpperCase(),
      sessionId: sessionId.toUpperCase(),
      itemId: itemId.toUpperCase(),
    });
    expect(result.item.user_id).toBe(userId);
  });

  it('rejects malformed input before any SQL', async () => {
    const database = dbFixture({});
    await expect(
      repository(database).readItem({ userId: 'invalid', sessionId, itemId }),
    ).rejects.toMatchObject({ reason: 'input_invalid' });
    expect(database.query.chatSessions.findFirst).not.toHaveBeenCalled();
  });

  it('rejects an item outside the allocated sequence range', async () => {
    const database = dbFixture({
      session: session(),
      item: hostContext({ sequence_no: '21' }),
      turn: turn(),
    });
    await expect(
      repository(database, { authorizeDependencies: () => true }).readItem({
        userId,
        sessionId,
        itemId,
      }),
    ).rejects.toMatchObject({ reason: 'session_state_invalid' });
    expect(database.query.agentTurns.findFirst).not.toHaveBeenCalled();
  });

  it('allows a validated appended tail beyond the older integrity checkpoint', async () => {
    const database = dbFixture({
      session: session({ transcriptNextSequence: 22n }),
      item: hostContext({ sequence_no: '21' }),
      turn: turn(),
    });
    const authorizeDependencies = vi.fn(() => true);
    const result = await repository(database, { authorizeDependencies }).readItem({
      userId,
      sessionId,
      itemId,
    });
    expect(result.item.sequence_no).toBe('21');
    expect(authorizeDependencies).toHaveBeenCalledTimes(2);
  });

  it('rejects tombstones without looking up their original source', async () => {
    const database = dbFixture({
      session: session(),
      item: hostContext({
        payload_json: {
          schema_version: 1,
          type: 'redacted',
          reason: 'privacy_erased',
          original_payload_digest: 'a'.repeat(64),
          redacted_at: '2026-09-08T00:00:00.000Z',
        },
      }),
    });
    await expect(
      repository(database).readItem({ userId, sessionId, itemId }),
    ).rejects.toMatchObject({ reason: 'redacted_unavailable' });
    expect(database.query.agentTurns.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a resource revoked during materialization before generation cleanup', async () => {
    const item = assistantWithPrivateArguments();
    const database = dbFixture({ session: session(), item, turn: turn() });
    database.query.agentTranscriptPayloads.findFirst
      .mockResolvedValueOnce(payloadRow(payloadIdA, { text: 'inspect' }))
      .mockResolvedValueOnce(payloadRow(payloadIdB, { count: 2 }));
    const authorizeDependencies = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      repository(database, { authorizeDependencies }).readItem({
        userId,
        sessionId,
        itemId: item.id,
      }),
    ).rejects.toMatchObject({ reason: 'dependencies_unauthorized' });
    expect(database.query.agentTranscriptPayloads.findFirst).toHaveBeenCalledTimes(2);
  });

  it('does not allow a void authorizer or its exception to grant access', async () => {
    const database = dbFixture({ session: session(), item: hostContext(), turn: turn() });
    const authorizeDependencies = vi.fn().mockResolvedValue(undefined);
    await expect(
      repository(database, { authorizeDependencies }).readItem({ userId, sessionId, itemId }),
    ).rejects.toMatchObject({ reason: 'dependencies_unauthorized' });
    authorizeDependencies.mockRejectedValue(new Error('private upstream details'));
    const error = await repository(database, { authorizeDependencies })
      .readItem({ userId, sessionId, itemId })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ reason: 'dependencies_unauthorized' });
    expect(String(error)).not.toContain('private upstream');
    expect(error).not.toHaveProperty('cause');
  });

  it('sanitizes driver exceptions instead of propagating SQL or private values', async () => {
    const database = dbFixture({});
    database.query.chatSessions.findFirst.mockRejectedValue(
      new Error('SQL user_id private-credential'),
    );
    const error = await repository(database)
      .readItem({ userId, sessionId, itemId })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      reason: 'storage_unavailable',
      message: 'AGENT_TRANSCRIPT_READ_FAILED',
    });
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('private-credential');
  });

  it('validates a reused payload ID against every call schema', async () => {
    const content = { text: 'inspect' };
    const item = userMessage({
      ...assistantWithPrivateArguments(),
      payload_json: {
        schema_version: 1,
        type: 'assistant_output',
        mode: 'tools',
        calls: ['inspect_image@1', 'load_skill@1'].map((name) => ({
          name,
          arguments: privateReference(payloadIdA, content),
          arguments_digest: canonicalSha256(content),
          provider_call_id: null,
        })),
      },
    });
    const database = dbFixture({
      session: session(),
      item,
      turn: turn(),
      payloads: new Map([[payloadIdA, payloadRow(payloadIdA, content)]]),
    });
    await expect(
      repository(database, { authorizeDependencies: () => true }).readItem({
        userId,
        sessionId,
        itemId: item.id,
      }),
    ).rejects.toMatchObject({ reason: 'payload_invalid' });
    expect(database.query.agentTranscriptPayloads.findFirst).toHaveBeenCalledOnce();
  });

  it('reads an owned user item and rechecks its source semantics', async () => {
    const verifyMessageSource = vi.fn(() => true);
    const database = dbFixture({
      session: session(),
      item: userMessage(),
      turn: turn(),
      message: {
        id: messageId,
        sessionId,
        turnId,
        role: 'user',
        content: 'hello',
        attachments: [],
        toolCalls: [],
        skillSnapshots: [],
        pendingApproval: {},
      },
    });
    const result = await repository(database, {
      verifyMessageSource,
      authorizeDependencies: () => true,
    }).readItem({
      userId,
      sessionId,
      itemId,
    });
    expect(result.item.payload_json.type).toBe('user_message');
    expect(result.history_generation).toBe('1');
    expect(verifyMessageSource).toHaveBeenCalledOnce();
    const sessionSql = sqlResource.db.query.chatSessions
      .findFirst(
        database.query.chatSessions.findFirst.mock.calls[0]![0] as Parameters<
          typeof sqlResource.db.query.chatSessions.findFirst
        >[0],
      )
      .toSQL();
    const itemSql = sqlResource.db.query.agentTranscriptItems
      .findFirst(
        database.query.agentTranscriptItems.findFirst.mock.calls[0]![0] as Parameters<
          typeof sqlResource.db.query.agentTranscriptItems.findFirst
        >[0],
      )
      .toSQL();
    expect(sessionSql.sql).toMatch(/"user_id" = \$/);
    expect(sessionSql.sql).toMatch(/"archived_at" is null/);
    expect(sessionSql.params).toEqual(expect.arrayContaining([userId, sessionId]));
    expect(itemSql.sql).toMatch(/"user_id" = \$/);
    expect(itemSql.sql).toMatch(/"session_id" = \$/);
    expect(itemSql.params).toEqual(expect.arrayContaining([userId, sessionId, itemId]));
  });

  it.each([
    ['archived session', { archivedAt: new Date() }, 'session_unavailable'],
    [
      'shadow session',
      {
        transcriptStateJson: {
          schema_version: 1,
          mode: 'shadow',
          verified_through_sequence: '20',
          verified_digest: 'b'.repeat(64),
        },
      },
      'session_state_invalid',
    ],
  ])('rejects a %s before reading the item', async (_name, overrides, reason) => {
    const database = dbFixture({ session: session(overrides), item: userMessage() });
    await expect(
      repository(database, {
        verifyMessageSource: () => true,
        authorizeDependencies: () => true,
      }).readItem({
        userId,
        sessionId,
        itemId,
      }),
    ).rejects.toMatchObject({ reason });
    expect(database.query.agentTranscriptItems.findFirst).not.toHaveBeenCalled();
  });

  it('does not turn a missing source or missing host verifier into a readable item', async () => {
    const database = dbFixture({ session: session(), item: userMessage(), turn: turn() });
    await expect(
      repository(database, { authorizeDependencies: () => true }).readItem({
        userId,
        sessionId,
        itemId,
      }),
    ).rejects.toMatchObject({ reason: 'source_unavailable' });

    const withSource = dbFixture({
      session: session(),
      item: userMessage(),
      turn: turn(),
      message: {
        id: messageId,
        sessionId,
        turnId,
        role: 'user',
        content: 'hello',
        attachments: [],
        toolCalls: [],
        skillSnapshots: [],
        pendingApproval: {},
      },
    });
    await expect(
      repository(withSource, { authorizeDependencies: () => true }).readItem({
        userId,
        sessionId,
        itemId,
      }),
    ).rejects.toMatchObject({ reason: 'source_verifier_missing' });
  });

  it('requires the dependency authorizer before private payload lookup', async () => {
    const content = { text: 'inspect' };
    const item = assistantWithPrivateArguments();
    const payloads = new Map([[payloadIdA, payloadRow(payloadIdA, content)]]);
    const database = dbFixture({ session: session(), item, turn: turn(), payloads });
    const payloadLookup = database.query.agentTranscriptPayloads.findFirst;
    const authorizeDependencies = vi.fn(() => false);
    await expect(
      repository(database, { authorizeDependencies }).readItem({
        userId,
        sessionId,
        itemId: item.id,
      }),
    ).rejects.toMatchObject({ reason: 'dependencies_unauthorized' });
    expect(authorizeDependencies).toHaveBeenCalledOnce();
    expect(payloadLookup).not.toHaveBeenCalled();
  });

  it('fails closed when the dependency authorizer is not installed', async () => {
    const item = userMessage({
      item_type: 'host_context',
      source_key: 'context:missing-authorizer',
      source_message_id: null,
      payload_json: {
        schema_version: 1,
        type: 'host_context',
        name: 'phase_changed@1',
        content: { type: 'inline', value: { text: 'planning' } },
      },
    });
    const database = dbFixture({ session: session(), item, turn: turn() });
    await expect(
      repository(database).readItem({ userId, sessionId, itemId: item.id }),
    ).rejects.toMatchObject({ reason: 'dependency_authorizer_missing' });
  });

  it('uses each exact call schema when materializing same-kind private payloads', async () => {
    const item = assistantWithPrivateArguments();
    const payloads = new Map([
      [payloadIdA, payloadRow(payloadIdA, { text: 'inspect' })],
      [payloadIdB, payloadRow(payloadIdB, { count: 2 })],
    ]);
    const database = dbFixture({ session: session(), item, turn: turn(), payloads });
    const lookup = database.query.agentTranscriptPayloads.findFirst;
    lookup.mockImplementation((_options: unknown) => {
      const nextId = lookup.mock.calls.length === 1 ? payloadIdA : payloadIdB;
      return Promise.resolve(payloads.get(nextId));
    });
    const result = await repository(database, { authorizeDependencies: () => true }).readItem({
      userId,
      sessionId,
      itemId: item.id,
    });
    expect(result.private_payloads.map((payload) => payload.value)).toEqual([
      { text: 'inspect' },
      { count: 2 },
    ]);
    const payloadSql = sqlResource.db.query.agentTranscriptPayloads
      .findFirst(
        lookup.mock.calls[0]![0] as Parameters<
          typeof sqlResource.db.query.agentTranscriptPayloads.findFirst
        >[0],
      )
      .toSQL();
    expect(payloadSql.sql).toMatch(/"user_id" = \$/);
    expect(payloadSql.sql).toMatch(/"turn_id" = \$/);
    expect(payloadSql.sql).toMatch(/"import_attempt_id" is null/);
    expect(payloadSql.sql).toContain('"chat_sessions"."transcript_generation"');
    expect(payloadSql.sql).toContain('"chat_sessions"."message_history_revision"');
    expect(payloadSql.sql).toContain("->>'mode' = 'active'");
    expect(payloadSql.params).toEqual(
      expect.arrayContaining([payloadIdA, userId, sessionId, turnId, 1n, 4n]),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.item.payload_json)).toBe(true);
    expect(Object.isFrozen(result.private_payloads[0]?.value)).toBe(true);
  });

  it('verifies the actual parent call without materializing parent arguments', async () => {
    const parent = assistantWithPrivateArguments();
    const item = userMessage({
      id: uuid(20),
      item_type: 'tool_result',
      sequence_no: '3',
      continuation_no: 2,
      source_key: 'result:3',
      source_message_id: null,
      reply_to_item_id: parent.id,
      call_ordinal: 0,
      payload_json: {
        schema_version: 1,
        type: 'tool_result',
        name: 'inspect_image@1',
        arguments_digest: canonicalSha256({ text: 'inspect' }),
        status: 'succeeded',
        result: { type: 'inline', value: { text: 'observed' } },
      },
    });
    const database = dbFixture({ session: session(), turn: turn({ continuationNo: 2 }) });
    database.query.agentTranscriptItems.findFirst
      .mockResolvedValueOnce(dbItemRow(item))
      .mockResolvedValueOnce(dbItemRow(parent));
    const authorizeDependencies = vi.fn(() => true);
    const result = await repository(database, { authorizeDependencies }).readItem({
      userId,
      sessionId,
      itemId: item.id,
    });
    expect(result.item.payload_json.type).toBe('tool_result');
    expect(authorizeDependencies).toHaveBeenCalledTimes(4);
    expect(database.query.agentTranscriptPayloads.findFirst).not.toHaveBeenCalled();
  });

  it.each(['missing', 'rejected', 'throwing'] as const)(
    'rejects a %s tool-result verifier before dependency or body access',
    async (mode) => {
      const parent = assistantWithPrivateArguments();
      const item = userMessage({
        id: uuid(20),
        item_type: 'tool_result',
        sequence_no: '3',
        source_key: 'result:3',
        source_message_id: null,
        reply_to_item_id: parent.id,
        call_ordinal: 0,
        payload_json: {
          schema_version: 1,
          type: 'tool_result',
          name: 'inspect_image@1',
          arguments_digest: canonicalSha256({ text: 'inspect' }),
          status: 'succeeded',
          result: privateReference(payloadIdA, { text: 'observed' }),
        },
      });
      const database = dbFixture({ session: session(), turn: turn() });
      database.query.agentTranscriptItems.findFirst
        .mockResolvedValueOnce(dbItemRow(item))
        .mockResolvedValueOnce(dbItemRow(parent));
      const authorizeDependencies = vi.fn(() => true);
      const verifyToolResultSource = vi.fn(() => {
        if (mode === 'throwing') throw new Error('private source diagnostic');
        return false;
      });
      const materialize = vi.fn(() => 'unreachable');
      const repo = new AgentTranscriptRepository(database as unknown as Database, {
        itemContracts: {
          ...contracts,
          calls: contracts.calls.map((call) => ({
            ...call,
            results: { ...call.results, succeeded: toolTextContract },
          })),
        },
        authorizeDependencies,
        ...(mode === 'missing' ? {} : { verifyToolResultSource }),
      });
      await expect(
        repo.readMaterializedItem({ userId, sessionId, itemId: item.id }, materialize),
      ).rejects.toMatchObject({
        reason: mode === 'missing' ? 'source_verifier_missing' : 'source_invalid',
        message: 'AGENT_TRANSCRIPT_READ_FAILED',
      });
      expect(verifyToolResultSource).toHaveBeenCalledTimes(mode === 'missing' ? 0 : 1);
      expect(authorizeDependencies).not.toHaveBeenCalled();
      expect(database.query.agentTranscriptPayloads.findFirst).not.toHaveBeenCalled();
      expect(materialize).not.toHaveBeenCalled();
    },
  );

  it.each([{ call_ordinal: 3 }, { reply_to_item_id: uuid(99) }, { turn_id: uuid(99) }])(
    'rejects a mismatched result parent: %j',
    async (overrides) => {
      const parent = assistantWithPrivateArguments();
      const item = userMessage({
        id: uuid(20),
        item_type: 'tool_result',
        sequence_no: '3',
        source_key: 'result:3',
        source_message_id: null,
        reply_to_item_id: parent.id,
        call_ordinal: 0,
        payload_json: {
          schema_version: 1,
          type: 'tool_result',
          name: 'inspect_image@1',
          arguments_digest: canonicalSha256({ text: 'inspect' }),
          status: 'succeeded',
          result: { type: 'inline', value: { text: 'observed' } },
        },
        ...overrides,
      });
      const database = dbFixture({ session: session(), turn: turn({ id: item.turn_id }) });
      database.query.agentTranscriptItems.findFirst
        .mockResolvedValueOnce(dbItemRow(item))
        .mockResolvedValueOnce(dbItemRow(parent));
      await expect(
        repository(database, { authorizeDependencies: () => true }).readItem({
          userId,
          sessionId,
          itemId: item.id,
        }),
      ).rejects.toMatchObject({ reason: 'item_invalid' });
    },
  );

  it('rejects a payload from another turn even when its content hash is valid', async () => {
    const item = assistantWithPrivateArguments();
    const invalidPayload = payloadRow(payloadIdA, { text: 'inspect' });
    invalidPayload.turnId = uuid(99);
    const payloads = new Map([[payloadIdA, invalidPayload]]);
    const database = dbFixture({ session: session(), item, turn: turn(), payloads });
    await expect(
      repository(database, { authorizeDependencies: () => true }).readItem({
        userId,
        sessionId,
        itemId: item.id,
      }),
    ).rejects.toMatchObject({ reason: 'payload_invalid' });
  });

  it('checks trace ownership and rejects a trace belonging to another session', async () => {
    const item = userMessage({
      source_message_id: null,
      source_trace_step_id: traceStepId,
      item_type: 'host_context',
      payload_json: {
        schema_version: 1,
        type: 'host_context',
        name: 'phase_changed@1',
        content: { type: 'inline', value: { text: 'planning' } },
      },
      source_key: 'context:1',
    });
    const database = dbFixture({
      session: session(),
      item,
      turn: turn(),
      traceStep: { id: traceStepId, traceId: uuid(10) },
      trace: { id: uuid(10), turnId, sessionId: uuid(88), userId },
    });
    await expect(
      repository(database, { authorizeDependencies: () => true }).readItem({
        userId,
        sessionId,
        itemId: item.id,
      }),
    ).rejects.toMatchObject({ reason: 'source_invalid' });
  });

  it('rejects a source whose semantic verifier returns false', async () => {
    const database = dbFixture({
      session: session(),
      item: userMessage(),
      turn: turn(),
      message: {
        id: messageId,
        sessionId,
        turnId,
        role: 'user',
        content: 'tampered',
        attachments: [],
        toolCalls: [],
        skillSnapshots: [],
        pendingApproval: {},
      },
    });
    await expect(
      repository(database, {
        verifyMessageSource: () => false,
        authorizeDependencies: () => true,
      }).readItem({ userId, sessionId, itemId }),
    ).rejects.toMatchObject({ reason: 'source_invalid' });
  });

  it('does not return a view when generation changes during authorization or payload read', async () => {
    const database = dbFixture({
      sessionReads: [session(), session({ transcriptGeneration: 2n })],
      item: userMessage(),
      turn: turn(),
      message: {
        id: messageId,
        sessionId,
        turnId,
        role: 'user',
        content: 'hello',
        attachments: [],
        toolCalls: [],
        skillSnapshots: [],
        pendingApproval: {},
      },
    });
    await expect(
      repository(database, {
        verifyMessageSource: () => true,
        authorizeDependencies: () => true,
      }).readItem({
        userId,
        sessionId,
        itemId,
      }),
    ).rejects.toMatchObject({ reason: 'history_changed' });
  });

  it('uses fixed error text and does not expose database or schema details', async () => {
    const database = dbFixture({
      session: session(),
      item: userMessage({ payload_digest: '0'.repeat(64) }),
      turn: turn(),
    });
    const error = await repository(database, {
      verifyMessageSource: () => true,
      authorizeDependencies: () => true,
    })
      .readItem({ userId, sessionId, itemId })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentTranscriptReadError);
    expect(error).toMatchObject({
      reason: 'item_invalid',
      message: 'AGENT_TRANSCRIPT_READ_FAILED',
    });
    expect(String(error)).not.toContain('payload_digest');
  });
});
