import { randomUUID } from 'node:crypto';

import {
  agentSessionMutations,
  agentTraces,
  agentTurns,
  chatMessages,
  chatSessions,
  createDatabaseClient,
  eq,
  eventOutbox,
  inArray,
  runQuotes,
  skills,
  users,
} from '@ecom-forge/db';

import { AgentSessionService } from '../src/modules/agent/agent-session.service.js';
import { AgentTurnService } from '../src/modules/agent/agent-turn.service.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '').toLowerCase();
if (!/_test(?:_|$)/.test(databaseName)) {
  throw new Error('S11 session integration tests require a database name containing _test');
}

const resource = createDatabaseClient({ databaseUrl, maxConnections: 10 });
const sessions = new AgentSessionService(
  resource.db,
  Buffer.alloc(32, 41).toString('base64url'),
  Buffer.alloc(32, 42).toString('base64url'),
);
const turns = new AgentTurnService(resource.db);
const trackedUsers = new Set<string>();
const trackedSkills = new Set<string>();

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  trackedUsers.add(id);
  await resource.db.insert(users).values({
    id,
    email: `s11-${label}-${id}@example.test`,
    emailVerifiedAt: new Date(),
    displayName: `S11 ${label}`,
  });
  return id;
}

async function createSession(userId: string, title: string, updatedAt = new Date()) {
  const [created] = await resource.db
    .insert(chatSessions)
    .values({ userId, title, updatedAt })
    .returning();
  if (!created) throw new Error('Session fixture insert failed');
  return created;
}

async function cleanup(): Promise<void> {
  if (trackedUsers.size === 0) return;
  const userIds = [...trackedUsers];
  const sessionRows = await resource.db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(inArray(chatSessions.userId, userIds));
  const sessionIds = sessionRows.map((row) => row.id);
  const turnRows =
    sessionIds.length === 0
      ? []
      : await resource.db
          .select({ id: agentTurns.id })
          .from(agentTurns)
          .where(inArray(agentTurns.sessionId, sessionIds));
  const turnIds = turnRows.map((row) => row.id);
  if (turnIds.length > 0) {
    await resource.db.delete(eventOutbox).where(inArray(eventOutbox.scopeId, turnIds));
    await resource.db.delete(agentTraces).where(inArray(agentTraces.turnId, turnIds));
  }
  if (sessionIds.length > 0) {
    await resource.db
      .delete(agentSessionMutations)
      .where(inArray(agentSessionMutations.sessionId, sessionIds));
    await resource.db.delete(chatMessages).where(inArray(chatMessages.sessionId, sessionIds));
    await resource.db.delete(agentTurns).where(inArray(agentTurns.sessionId, sessionIds));
    await resource.db.delete(runQuotes).where(inArray(runQuotes.userId, userIds));
    await resource.db.delete(chatSessions).where(inArray(chatSessions.id, sessionIds));
  }
  if (trackedSkills.size > 0) {
    await resource.db.delete(skills).where(inArray(skills.id, [...trackedSkills]));
    trackedSkills.clear();
  }
  await resource.db.delete(users).where(inArray(users.id, userIds));
  trackedUsers.clear();
}

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await resource.client.end();
});

describe('S11 Agent session integration', () => {
  it('lists and searches only owned sessions with signed keyset pagination', async () => {
    const userId = await createUser('owner');
    const otherUserId = await createUser('other');
    const oldest = await createSession(userId, '夏日商品白底', new Date('2026-08-17T01:00:00Z'));
    const newest = await createSession(userId, '夏日人像创作', new Date('2026-08-17T03:00:00Z'));
    const hidden = await createSession(
      otherUserId,
      '夏日越权会话',
      new Date('2026-08-17T04:00:00Z'),
    );
    await resource.db.insert(chatMessages).values([
      { sessionId: oldest.id, role: 'user', content: '  生成白底图\n保留商品细节  ' },
      { sessionId: newest.id, role: 'assistant', content: '已整理人像创作方向' },
      { sessionId: hidden.id, role: 'assistant', content: '不应返回' },
    ]);

    const first = await sessions.list(userId, { query: '夏日', limit: 1 });
    expect(first.items).toEqual([
      expect.objectContaining({
        id: newest.id,
        last_message_preview: '已整理人像创作方向',
      }),
    ]);
    expect(first.next_cursor).toEqual(expect.any(String));

    const second = await sessions.list(userId, {
      query: '夏日',
      cursor: first.next_cursor!,
      limit: 1,
    });
    expect(second.items.map((item) => item.id)).toEqual([oldest.id]);
    expect(second.items[0]?.last_message_preview).toBe('生成白底图 保留商品细节');
    expect(second.next_cursor).toBeNull();
    await expect(
      sessions.list(otherUserId, { query: '夏日', cursor: first.next_cursor!, limit: 1 }),
    ).rejects.toMatchObject({ code: 'SESSION_CURSOR_INVALID' });
  });

  it('returns message history newest-first by page and oldest-first for display', async () => {
    const userId = await createUser('history');
    const session = await createSession(userId, '分页会话');
    const turnId = randomUUID();
    await resource.db.insert(agentTurns).values({
      id: turnId,
      sessionId: session.id,
      userId,
      status: 'done',
    });
    await resource.db.insert(chatMessages).values([
      {
        sessionId: session.id,
        turnId,
        role: 'user',
        content: '第一条',
        createdAt: new Date('2026-08-17T01:00:00Z'),
      },
      {
        sessionId: session.id,
        turnId,
        role: 'assistant',
        content: '第二条',
        createdAt: new Date('2026-08-17T02:00:00Z'),
      },
      {
        sessionId: session.id,
        turnId,
        role: 'user',
        content: '第三条',
        createdAt: new Date('2026-08-17T03:00:00Z'),
      },
    ]);

    const latest = await sessions.get(userId, session.id, { limit: 2 });
    expect(latest.messages.map((message) => message.content)).toEqual(['第二条', '第三条']);
    expect(latest.older_cursor).toEqual(expect.any(String));
    expect(latest.turns).toEqual([
      expect.objectContaining({ id: turnId, user_status: 'completed' }),
    ]);

    const older = await sessions.get(userId, session.id, {
      cursor: latest.older_cursor!,
      limit: 2,
    });
    expect(older.messages.map((message) => message.content)).toEqual(['第一条']);
    expect(older.older_cursor).toBeNull();
  });

  it('projects model snapshots without exposing provider runtime bindings', async () => {
    const userId = await createUser('model-projection');
    const session = await createSession(userId, '模型快照脱敏');
    const modelSelectionSnapshot = {
      catalog_revision: 12,
      brain: {
        catalog_entry_id: randomUUID(),
        version_no: 3,
        display_name: '通用推理模型',
        provider: 'internal-provider',
        adapter_key: 'private-adapter-v1',
        provider_channel_id: randomUUID(),
        credential_version_id: randomUUID(),
        capability_contract: { private_operation: true },
      },
      image: {
        catalog_entry_id: randomUUID(),
        version_no: 5,
        display_name: '创意生图模型',
        provider: 'internal-image-provider',
        runtime_binding: { endpoint_profile_key: 'private-endpoint' },
      },
    };
    const [turn] = await resource.db
      .insert(agentTurns)
      .values({
        sessionId: session.id,
        userId,
        status: 'done',
        modelSelectionSnapshotJson: modelSelectionSnapshot,
        modelSelectionSnapshotHash: 'fixture-model-selection-hash',
      })
      .returning({ id: agentTurns.id });
    if (!turn) throw new Error('Turn fixture insert failed');
    await resource.db.insert(chatMessages).values({
      sessionId: session.id,
      turnId: turn.id,
      role: 'user',
      content: '检查模型快照公开字段',
    });

    const detail = await sessions.get(userId, session.id, { limit: 50 });
    expect(detail.turns[0]?.model_selection).toEqual({
      catalog_revision: 12,
      brain: {
        catalog_entry_id: modelSelectionSnapshot.brain.catalog_entry_id,
        version_no: 3,
        display_name: '通用推理模型',
      },
      image: {
        catalog_entry_id: modelSelectionSnapshot.image.catalog_entry_id,
        version_no: 5,
        display_name: '创意生图模型',
      },
    });
    const publicResponse = JSON.stringify(detail);
    for (const forbidden of [
      'provider',
      'adapter_key',
      'provider_channel_id',
      'credential_version_id',
      'capability_contract',
      'runtime_binding',
      'endpoint_profile_key',
    ]) {
      expect(publicResponse).not.toContain(forbidden);
    }
  });

  it('projects attachment snapshots without exposing authorization evidence', async () => {
    const userId = await createUser('attachment-projection');
    const session = await createSession(userId, 'Attachment projection');
    const resourceId = randomUUID();
    const skillSlug = `s11-attachment-projection-${randomUUID()}`;
    const primarySkillId = `${skillSlug}@1.0.0`;
    trackedSkills.add(primarySkillId);
    await resource.db.insert(skills).values({
      id: primarySkillId,
      slug: skillSlug,
      name: 'Attachment projection',
      category: 'test',
      domain: 'creative',
      kind: 'primary',
      visibility: 'internal',
      stage: 'test',
      version: '1.0.0',
      definitionJson: {},
      price: {},
    });
    const attachment = {
      binding_key: randomUUID(),
      kind: 'asset',
      object_id: resourceId,
      object_version: 'private-resource-version',
      content_hash: 'a'.repeat(64),
      owner_user_id: userId,
      readable: true,
      mutable: false,
      producer_mode: 'chat',
      producer_session_id: session.id,
      mutation_owner: 'chat_session',
      source_action: 'generate',
      media_type: 'image',
      lifecycle: 'active',
      visibility: 'private',
      role: 'product',
      position: 0,
    };
    const [turn] = await resource.db
      .insert(agentTurns)
      .values({
        sessionId: session.id,
        userId,
        status: 'done',
        primarySkillId,
        skillSelectionSnapshotJson: {
          primary_skill_id: primarySkillId,
          primary_name: 'Attachment projection',
          preset_selections: [],
          required_auxiliary: [],
          optional_auxiliary: [],
        },
        skillSelectionSnapshotHash: 'fixture-skill-selection-hash',
        modelSelectionSnapshotJson: {
          catalog_revision: 1,
          brain: {
            catalog_entry_id: randomUUID(),
            version_no: 1,
            display_name: 'Test brain',
          },
          image: {
            catalog_entry_id: randomUUID(),
            version_no: 1,
            display_name: 'Test image',
          },
        },
        modelSelectionSnapshotHash: 'fixture-model-selection-hash',
      })
      .returning({ id: agentTurns.id });
    if (!turn) throw new Error('Turn fixture insert failed');
    await resource.db.insert(agentTraces).values({
      turnId: turn.id,
      sessionId: session.id,
      userId,
      brainModelId: 's11-test-brain',
      status: 'succeeded',
    });
    await resource.db.insert(chatMessages).values({
      sessionId: session.id,
      turnId: turn.id,
      role: 'user',
      content: 'Project this attachment safely',
      attachments: [attachment],
    });

    const expected = [
      { resource_type: 'asset', resource_id: resourceId, role: 'product', position: 0 },
    ];
    const sessionDetail = await sessions.get(userId, session.id, { limit: 50 });
    const turnDetail = await turns.get(userId, turn.id);
    expect(sessionDetail.messages[0]?.attachments).toEqual(expected);
    expect(turnDetail.messages[0]?.attachments).toEqual(expected);

    const publicResponse = JSON.stringify({ sessionDetail, turnDetail });
    for (const forbidden of [
      'binding_key',
      'object_version',
      'content_hash',
      'owner_user_id',
      'readable',
      'mutable',
      'producer_mode',
      'producer_session_id',
      'mutation_owner',
      'source_action',
      'media_type',
      'lifecycle',
      'visibility',
    ]) {
      expect(publicResponse).not.toContain(forbidden);
    }

    await resource.db
      .update(agentTurns)
      .set({ modelSelectionSnapshotJson: null, modelSelectionSnapshotHash: null })
      .where(eq(agentTurns.id, turn.id));
    const legacyDetail = await turns.get(userId, turn.id);
    expect(legacyDetail.model_selection).toBeNull();
    expect(legacyDetail.generation_preferences).toBeNull();
    expect(legacyDetail.execution_authorization).toBeNull();
  });

  it('does not project a legacy cost confirmation from the linked quote', async () => {
    const userId = await createUser('cost-recovery');
    const session = await createSession(userId, 'Cost recovery');
    const turnId = randomUUID();
    const quoteId = randomUUID();
    const expiresAt = new Date('2026-08-18T08:00:00.000Z');
    const publicPayload = {
      schema_version: 1,
      quote_id: quoteId,
      estimated_total_credits: '12.00',
      items: [
        {
          label: '图片生成',
          quantity: 1,
          estimated_credits: '12.00',
        },
      ],
      submission_block_reason: 'concurrency_limit',
    };
    const skillSlug = `s11-cost-recovery-${randomUUID()}`;
    const primarySkillId = `${skillSlug}@1.0.0`;
    trackedSkills.add(primarySkillId);
    await resource.db.insert(skills).values({
      id: primarySkillId,
      slug: skillSlug,
      name: 'Cost recovery',
      category: 'test',
      domain: 'creative',
      kind: 'primary',
      visibility: 'internal',
      stage: 'test',
      version: '1.0.0',
      definitionJson: {},
      price: {},
    });
    await resource.db.insert(runQuotes).values({
      id: quoteId,
      userId,
      source: 'chat',
      sourceId: turnId,
      status: 'quoted',
      promptPreview: {},
      itemsSnapshot: publicPayload.items,
      estimatedCallCount: 1,
      estimatedTotalCredits: '12.00',
      hasUnknownPrice: false,
      idempotencyKey: `s11-cost-recovery:${turnId}`,
      inputSignature: `s11-cost-recovery:${turnId}`,
      submissionMode: 'confirmation_required',
      planDigest: 'fixture-plan-digest',
      authorizationDigest: 'fixture-authorization-digest',
      confirmationSnapshot: {
        kind: 'cost_confirmation@v1',
        public_payload: publicPayload,
        expires_at: expiresAt.toISOString(),
      },
      expiresAt,
    });
    await resource.db.insert(agentTurns).values({
      id: turnId,
      sessionId: session.id,
      userId,
      status: 'waiting_user_confirmation',
      runQuoteId: quoteId,
      primarySkillId,
      skillSelectionSnapshotJson: {
        primary_skill_id: primarySkillId,
        primary_name: 'Cost recovery',
        preset_selections: [],
        required_auxiliary: [],
        optional_auxiliary: [],
      },
      skillSelectionSnapshotHash: 'fixture-skill-selection-hash',
    });
    await resource.db.insert(agentTraces).values({
      turnId,
      sessionId: session.id,
      userId,
      brainModelId: 's11-test-brain',
      status: 'running',
    });

    const [sessionDetail, turnDetail] = await Promise.all([
      sessions.get(userId, session.id, { limit: 50 }),
      turns.get(userId, turnId),
    ]);
    expect(sessionDetail.turns[0]?.pending_confirmation).toBeNull();
    expect(turnDetail.pending_confirmation).toBeNull();
  });

  it('replays rename idempotently and allows only one concurrent revision winner', async () => {
    const userId = await createUser('rename');
    const session = await createSession(userId, '旧标题');
    const key = `s11-rename-${randomUUID()}`;
    const replayed = await Promise.all([
      sessions.rename(userId, session.id, { revision: 1, title: '新标题' }, key),
      sessions.rename(userId, session.id, { revision: 1, title: '新标题' }, key),
    ]);
    expect(replayed[0]).toEqual(replayed[1]);
    expect(replayed[0]).toMatchObject({ title: '新标题', revision: 2 });
    const mutationRows = await resource.db
      .select()
      .from(agentSessionMutations)
      .where(eq(agentSessionMutations.sessionId, session.id));
    expect(mutationRows).toHaveLength(1);

    const concurrent = await Promise.allSettled([
      sessions.rename(
        userId,
        session.id,
        { revision: 2, title: '并发标题甲' },
        `s11-rename-a-${randomUUID()}`,
      ),
      sessions.rename(
        userId,
        session.id,
        { revision: 2, title: '并发标题乙' },
        `s11-rename-b-${randomUUID()}`,
      ),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = concurrent.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'SESSION_REVISION_CONFLICT' } });
  });

  it('blocks active-session archive and preserves ownership and replay invariants', async () => {
    const userId = await createUser('archive');
    const otherUserId = await createUser('archive-other');
    const session = await createSession(userId, '待归档会话');
    const [turn] = await resource.db
      .insert(agentTurns)
      .values({ sessionId: session.id, userId, status: 'planning' })
      .returning();
    if (!turn) throw new Error('Turn fixture insert failed');

    await resource.db
      .update(chatSessions)
      .set({
        transcriptGeneration: 7n,
        summaryJson: { private_summary: 'must not be reused after archival' },
        summaryVersion: 2,
        summaryThroughTurnId: turn.id,
      })
      .where(eq(chatSessions.id, session.id));
    await expect(
      sessions.archive(userId, session.id, { revision: 1 }, `s11-active-${randomUUID()}`),
    ).rejects.toMatchObject({ code: 'SESSION_ACTIVE' });
    await expect(
      sessions.archive(otherUserId, session.id, { revision: 1 }, `s11-owner-${randomUUID()}`),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(
      await resource.db.query.chatSessions.findFirst({ where: eq(chatSessions.id, session.id) }),
    ).toMatchObject({ transcriptGeneration: 7n, summaryVersion: 2, archivedAt: null });

    await resource.db.update(agentTurns).set({ status: 'done' }).where(eq(agentTurns.id, turn.id));
    const key = `s11-archive-${randomUUID()}`;
    const [first, replay] = await Promise.all([
      sessions.archive(userId, session.id, { revision: 1 }, key),
      sessions.archive(userId, session.id, { revision: 1 }, key),
    ]);
    expect(replay).toEqual(first);
    expect(
      await resource.db.query.chatSessions.findFirst({ where: eq(chatSessions.id, session.id) }),
    ).toMatchObject({
      transcriptGeneration: 8n,
      summaryJson: {},
      summaryVersion: 0,
      summaryThroughTurnId: null,
      revision: 2,
    });
    expect(
      await resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, turn.id) }),
    ).toBeDefined();
    await expect(sessions.get(userId, session.id, { limit: 50 })).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });
});
