import { prepareAgentTranscriptItem, type AgentTranscriptItemContracts } from '@ecom-forge/agent';
import { attachmentSnapshotSchema, type AttachmentSnapshot } from '@ecom-forge/compiler';
import { createDatabaseClient, type Database } from '@ecom-forge/db';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  AgentTranscriptUserMessageAuthorizer,
  transcriptUserMessageContract,
  transcriptUserMessageSchema,
  verifyTranscriptUserMessageSource,
} from './agent-transcript-message-binding.js';

const uuid = (id: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${id.toString(16).padStart(12, '0')}`;
const userId = uuid(1);
const sessionId = uuid(2);
const turnId = uuid(3);
const messageId = uuid(4);
const hash = 'a'.repeat(64);
const contracts: AgentTranscriptItemContracts = {
  userMessage: transcriptUserMessageContract,
  legacyMessage: { schema: z.never() },
  calls: [],
  hostContexts: [],
  resourceDependencySchema: attachmentSnapshotSchema,
};
const sqlResource = createDatabaseClient({
  databaseUrl: 'postgresql://fixture:fixture@127.0.0.1:1/transcript_sql_test',
});
afterAll(() => sqlResource.client.end());

function attachment(overrides: Partial<AttachmentSnapshot> = {}): AttachmentSnapshot {
  return {
    binding_key: uuid(10),
    kind: 'asset',
    object_id: uuid(11),
    object_version: hash,
    content_hash: hash,
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
    position: 0,
    publication_revision: null,
    ...overrides,
  };
}

function nativeItem(
  attachments: AttachmentSnapshot[] = [],
  text = 'Original input',
  dependencies = attachments,
) {
  return prepareAgentTranscriptItem(
    {
      id: uuid(5),
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
        content: { type: 'inline', value: { text, attachments } },
      },
      resource_dependencies_json: dependencies,
      created_at: '2026-09-08T00:00:00.000Z',
    },
    contracts,
  ).item;
}

function source(attachments: AttachmentSnapshot[] = [], content = 'Original input') {
  return {
    id: messageId,
    sessionId,
    turnId,
    role: 'user' as const,
    content,
    attachments,
    toolCalls: [],
    skillSnapshots: [],
    pendingApproval: {},
  };
}

function fixture() {
  const assetRow = {
    id: uuid(11),
    userId,
    status: 'ready',
    contentHash: hash,
    deletedAt: null,
    mimeType: 'image/png',
  };
  const artifactRow = {
    id: uuid(12),
    userId,
    type: 'image',
    visibility: 'private',
    contentHash: hash,
    publishedContentHash: 'b'.repeat(64),
    publicationRevision: 2,
  };
  const userRow = { id: userId, riskStatus: 'normal' };
  const database = {
    query: {
      users: { findFirst: vi.fn().mockResolvedValue(userRow) },
      assets: { findMany: vi.fn().mockResolvedValue([assetRow]) },
      artifacts: { findMany: vi.fn().mockResolvedValue([artifactRow]) },
    },
  };
  return {
    database,
    assetRow,
    artifactRow,
    userRow,
    authorizer: new AgentTranscriptUserMessageAuthorizer(
      database as unknown as Pick<Database, 'query'>,
    ),
  };
}

describe('native transcript user message binding', () => {
  it('preserves whitespace, Unicode, attachment order and sparse mention positions', () => {
    const text = '  \u8bb0\u5fc6\u4e0e\u5149\n\nThe mountain kept its shape.\nWe did not.  ';
    const bindings = [
      attachment({ position: 7 }),
      attachment({ binding_key: uuid(13), position: 2, role: 'style_reference' }),
    ];
    const item = nativeItem(bindings, text);
    expect(verifyTranscriptUserMessageSource({ item, source: source(bindings, text) })).toBe(true);
    expect(transcriptUserMessageSchema.parse({ text, attachments: bindings })).toEqual({
      text,
      attachments: bindings,
    });
  });

  it('accepts actual stored confirmation labels plus 2000-character answers without truncation', () => {
    const text = `${'x'.repeat(80)}\n${'y'.repeat(2000)}`;
    expect(
      verifyTranscriptUserMessageSource({ item: nativeItem([], text), source: source([], text) }),
    ).toBe(true);
  });

  it('accepts attachment-only input and does not turn Skill selection pointers into user text', () => {
    const binding = attachment();
    const original = {
      ...source([binding], ''),
      skillSnapshots: [{ skill_id: 'fixture@1.0.0', snapshot_hash: hash }],
    };
    expect(
      verifyTranscriptUserMessageSource({ item: nativeItem([binding], ''), source: original }),
    ).toBe(true);
  });

  it.each([
    { id: uuid(90) },
    { sessionId: uuid(90) },
    { turnId: uuid(90) },
    { role: 'assistant' as const },
    { content: 'Changed input' },
    { content: 'Original input ' },
    { toolCalls: [{ tool: 'forged' }] },
    { pendingApproval: { confirmation_id: uuid(90) } },
  ])('rejects a changed or unrelated source: %j', (change) => {
    expect(
      verifyTranscriptUserMessageSource({ item: nativeItem(), source: { ...source(), ...change } }),
    ).toBe(false);
  });

  it('rejects changing an attachment role, removing an attachment, or injecting unknown fields', () => {
    const binding = attachment();
    const item = nativeItem([binding]);
    expect(verifyTranscriptUserMessageSource({ item, source: source([]) })).toBe(false);
    expect(
      verifyTranscriptUserMessageSource({
        item,
        source: source([{ ...binding, role: 'edit_source' }]),
      }),
    ).toBe(false);
    expect(
      verifyTranscriptUserMessageSource({
        item,
        source: { ...source(), attachments: [{ ...binding, url: 'private' }] },
      }),
    ).toBe(false);
  });

  it.each(['binding_key', 'position'] as const)(
    'rejects duplicate %s without repairing the message',
    (key) => {
      const first = attachment();
      const second = attachment({ binding_key: uuid(13), position: 1, [key]: first[key] });
      expect(
        transcriptUserMessageSchema.safeParse({ text: '', attachments: [first, second] }).success,
      ).toBe(false);
    },
  );

  it('rejects more than nine attachments, but allows the same resource with distinct binding roles', () => {
    const bindings = Array.from({ length: 10 }, (_, index) =>
      attachment({ binding_key: uuid(index + 20), position: index }),
    );
    expect(transcriptUserMessageSchema.safeParse({ text: '', attachments: bindings }).success).toBe(
      false,
    );
    expect(
      transcriptUserMessageSchema.safeParse({ text: '', attachments: bindings.slice(0, 9) })
        .success,
    ).toBe(true);
  });
});

describe('native transcript user message live authorization', () => {
  it('accepts owned current assets and queries by both user and object IDs', async () => {
    const { database, authorizer } = fixture();
    expect(await authorizer.authorize(nativeItem([attachment()]))).toBe(true);
    const options = database.query.assets.findMany.mock.calls[0]![0] as Parameters<
      typeof sqlResource.db.query.assets.findMany
    >[0];
    const query = sqlResource.db.query.assets.findMany(options).toSQL();
    expect(query.sql).toContain('"user_id"');
    expect(query.sql).toContain('"id"');
    expect(query.params).toEqual(expect.arrayContaining([userId, uuid(11)]));
    expect(database.query.artifacts.findMany).not.toHaveBeenCalled();
  });

  it('checks current user access even for text-only messages', async () => {
    const { database, authorizer } = fixture();
    expect(await authorizer.authorize(nativeItem())).toBe(true);
    database.query.users.findFirst.mockResolvedValueOnce({ id: userId, riskStatus: 'frozen' });
    expect(await authorizer.authorize(nativeItem())).toBe(false);
    expect(database.query.users.findFirst).toHaveBeenCalledTimes(2);
    expect(database.query.assets.findMany).not.toHaveBeenCalled();
  });

  it.each(['frozen', 'limited'])(
    'rejects a %s user without reading resources',
    async (riskStatus) => {
      const { database, authorizer } = fixture();
      database.query.users.findFirst.mockResolvedValueOnce({ id: userId, riskStatus });
      expect(await authorizer.authorize(nativeItem([attachment()]))).toBe(false);
      expect(database.query.assets.findMany).not.toHaveBeenCalled();
    },
  );

  it('rejects omitted, added or duplicate dependency entries before storage access', async () => {
    const { database, authorizer } = fixture();
    const binding = attachment();
    expect(await authorizer.authorize(nativeItem([binding], '', []))).toBe(false);
    expect(await authorizer.authorize(nativeItem([], '', [binding]))).toBe(false);
    const item = nativeItem([binding]);
    expect(
      await authorizer.authorize({ ...item, resource_dependencies_json: [binding, binding] }),
    ).toBe(false);
    expect(database.query.users.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    { owner_user_id: uuid(90) },
    { readable: false },
    { lifecycle: 'deleted' as const },
    { visibility: 'quarantined' as const },
    { object_version: 'drift' },
  ])('rejects an unusable snapshot: %j', async (change) => {
    const { database, authorizer } = fixture();
    expect(await authorizer.authorize(nativeItem([attachment(change)]))).toBe(false);
    expect(database.query.users.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    { userId: uuid(90) },
    { status: 'deleted' },
    { status: 'quarantined' },
    { deletedAt: new Date() },
    { contentHash: 'b'.repeat(64) },
    { mimeType: 'text/plain' },
    { mimeType: null },
  ])('rejects changed live assets: %j', async (change) => {
    const { database, authorizer, assetRow } = fixture();
    database.query.assets.findMany.mockResolvedValueOnce([{ ...assetRow, ...change }]);
    expect(await authorizer.authorize(nativeItem([attachment()]))).toBe(false);
  });

  it('does not cache successful authorization across reads', async () => {
    const { database, authorizer } = fixture();
    const item = nativeItem([attachment()]);
    expect(await authorizer.authorize(item)).toBe(true);
    database.query.assets.findMany.mockResolvedValueOnce([]);
    expect(await authorizer.authorize(item)).toBe(false);
    expect(database.query.assets.findMany).toHaveBeenCalledTimes(2);
  });

  it('accepts same-owner cross-session read-only artifacts without granting mutation', async () => {
    const { authorizer } = fixture();
    const binding = attachment({
      kind: 'artifact',
      object_id: uuid(12),
      producer_mode: 'chat',
      producer_session_id: uuid(90),
      mutation_owner: 'chat_session',
    });
    expect(await authorizer.authorize(nativeItem([binding]))).toBe(true);
    expect(binding.mutable).toBe(false);
  });

  it('checks published hash and revision, not just an equal original content hash', async () => {
    const { database, authorizer, artifactRow } = fixture();
    const binding = attachment({
      kind: 'artifact',
      object_id: uuid(12),
      content_hash: 'b'.repeat(64),
      object_version: 'b'.repeat(64),
      publication_revision: 2,
    });
    const item = nativeItem([binding]);
    expect(await authorizer.authorize(item)).toBe(true);
    database.query.artifacts.findMany.mockResolvedValueOnce([
      { ...artifactRow, publicationRevision: 3 },
    ]);
    expect(await authorizer.authorize(item)).toBe(false);
    database.query.artifacts.findMany.mockResolvedValueOnce([
      { ...artifactRow, contentHash: binding.content_hash, publishedContentHash: 'c'.repeat(64) },
    ]);
    expect(await authorizer.authorize(item)).toBe(false);
  });

  it.each([
    { visibility: 'deleted' },
    { visibility: 'quarantined' },
    { userId: uuid(90) },
    { type: 'text' },
  ])('rejects unavailable artifact metadata: %j', async (change) => {
    const { database, authorizer, artifactRow } = fixture();
    database.query.artifacts.findMany.mockResolvedValueOnce([{ ...artifactRow, ...change }]);
    expect(
      await authorizer.authorize(
        nativeItem([attachment({ kind: 'artifact', object_id: uuid(12) })]),
      ),
    ).toBe(false);
  });

  it('denies unsupported item kinds instead of treating empty dependencies as authorization', async () => {
    const { database, authorizer } = fixture();
    const item = { ...nativeItem(), item_type: 'legacy_message' as const };
    expect(await authorizer.authorize(item)).toBe(false);
    expect(verifyTranscriptUserMessageSource({ item, source: source() })).toBe(false);
    expect(database.query.users.findFirst).not.toHaveBeenCalled();
  });

  it('fails closed on database exceptions without exposing the cause', async () => {
    const { database, authorizer } = fixture();
    database.query.assets.findMany.mockRejectedValueOnce(
      new Error('secret storage connection details'),
    );
    expect(await authorizer.authorize(nativeItem([attachment()]))).toBe(false);
  });
});
