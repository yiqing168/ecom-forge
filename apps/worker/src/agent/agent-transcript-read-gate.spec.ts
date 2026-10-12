import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { AgentTranscriptItemContracts } from '@ecom-forge/agent';
import { createDatabaseClient, type Database } from '@ecom-forge/db';

import {
  AgentTranscriptRepository,
  type AgentTranscriptRepositoryOptions,
} from './agent-transcript.repository.js';

// SQL compilation is lazy; no connection or acceptance database is used here.
const sqlResource = createDatabaseClient({
  databaseUrl: 'postgresql://fixture:fixture@127.0.0.1:1/transcript_read_gate_test',
});
afterAll(() => sqlResource.client.end());

const uuid = (value: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${value.toString(16).padStart(12, '0')}`;
const userId = uuid(1);
const sessionId = uuid(2);
const itemId = uuid(5);

const contracts: AgentTranscriptItemContracts = {
  userMessage: { schema: z.strictObject({ text: z.string() }) },
  legacyMessage: { schema: z.never() },
  calls: [],
  hostContexts: [],
  resourceDependencySchema: z.never(),
};

const activeState = {
  schema_version: 1,
  mode: 'active',
  integrity_version: 1,
  verified_through_sequence: '3',
  verified_digest: 'b'.repeat(64),
};

function sessionRow(transcriptStateJson: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    userId,
    archivedAt: null,
    transcriptStateJson,
    transcriptGeneration: 1n,
    transcriptNextSequence: 9n,
    messageHistoryRevision: 4n,
    ...overrides,
  };
}

function repository(session: unknown) {
  const database = {
    query: {
      chatSessions: { findFirst: vi.fn(() => Promise.resolve(session)) },
      agentTranscriptItems: {
        findFirst: vi.fn(() => Promise.resolve(undefined)),
        findMany: vi.fn(() => Promise.resolve([])),
      },
      agentTranscriptPayloads: { findFirst: vi.fn(() => Promise.resolve(undefined)) },
      agentTurns: { findFirst: vi.fn(() => Promise.resolve(undefined)) },
      chatMessages: { findFirst: vi.fn(() => Promise.resolve(undefined)) },
      agentTraceSteps: { findFirst: vi.fn(() => Promise.resolve(undefined)) },
      agentTraces: { findFirst: vi.fn(() => Promise.resolve(undefined)) },
    },
    select: sqlResource.db.select.bind(sqlResource.db),
  };
  const options: AgentTranscriptRepositoryOptions = { itemContracts: contracts };
  return new AgentTranscriptRepository(database as unknown as Database, options);
}

const read = () => ({ userId, sessionId, itemId });

describe('transcript strict active read gate (Q1)', () => {
  it.each(['off', 'backfill', 'shadow', 'invalid'] as const)(
    'refuses to read a session in %s mode',
    async (mode) => {
      const repo = repository(
        sessionRow({
          schema_version: 1,
          mode,
          integrity_version: 1,
          verified_through_sequence: '0',
          verified_digest: 'a'.repeat(64),
        }),
      );
      await expect(repo.readItem(read())).rejects.toMatchObject({
        reason: 'session_state_invalid',
      });
    },
  );

  it.each([
    { ...activeState, integrity_version: 2 },
    { ...activeState, mode: 'shadow' },
    {
      schema_version: 1,
      mode: 'active',
      verified_through_sequence: '3',
      verified_digest: 'b'.repeat(64),
    },
    { ...activeState, verified_digest: 'not-a-digest' },
    { ...activeState, extra: true },
    { ...activeState, verified_through_sequence: '-1' },
  ])('refuses a malformed active checkpoint (%#)', async (state) => {
    const repo = repository(sessionRow(state));
    await expect(repo.readItem(read())).rejects.toMatchObject({ reason: 'session_state_invalid' });
  });

  it('admits a strict active checkpoint and then reports the missing item', async () => {
    const repo = repository(sessionRow(activeState));
    await expect(repo.readItem(read())).rejects.toMatchObject({ reason: 'item_unavailable' });
  });

  it('refuses an archived session even when its checkpoint is active', async () => {
    const repo = repository(sessionRow(activeState, { archivedAt: new Date() }));
    await expect(repo.readItem(read())).rejects.toMatchObject({ reason: 'session_unavailable' });
  });

  it('refuses a session whose generation/next-sequence/counters are inconsistent', async () => {
    await expect(
      repository(sessionRow(activeState, { transcriptGeneration: 0n })).readItem(read()),
    ).rejects.toMatchObject({ reason: 'session_state_invalid' });
    await expect(
      repository(sessionRow(activeState, { transcriptNextSequence: 3n })).readItem(read()),
    ).rejects.toMatchObject({ reason: 'session_state_invalid' });
    await expect(
      repository(sessionRow(activeState, { messageHistoryRevision: -1n })).readItem(read()),
    ).rejects.toMatchObject({ reason: 'session_state_invalid' });
  });
});
