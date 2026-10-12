import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@ecom-forge/db';

import {
  AgentTranscriptWriteTransactions,
  withTranscriptQueryBudget,
} from './agent-transcript-write-transaction.js';
import type { Transaction } from './agent-turn.types.js';
import { errorDetailLine } from '../provider/provider-telemetry.js';
import { z } from 'zod';

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const input = {
  userId: uuid,
  sessionId: uuid,
  turnId: uuid,
  owner: uuid,
  revision: 1,
  continuationNo: 1,
  expectedGeneration: '1',
};

describe('transcript write transaction input', () => {
  it('preserves actionable diagnostics through wrapping without copying raw messages or record keys', async () => {
    const secretUrl = 'https://private.example/image?signature=secret-value';
    const result = z.record(z.string(), z.number()).safeParse({ [secretUrl]: 'bad' });
    if (result.success) throw new Error('Expected invalid fixture');
    const failure = new Error('AGENT_TEST_CONFLICT', { cause: result.error });
    const transaction = {
      execute: vi.fn().mockResolvedValue([{ remaining: 5000 }]),
    } as unknown as Transaction;
    const caught = await withTranscriptQueryBudget(transaction, (query) =>
      query(() => Promise.reject(failure)),
    ).catch((error: unknown) => error);
    expect(caught).toMatchObject({
      reason: 'domain_conflict',
      detail: 'AGENT_TEST_CONFLICT',
    });
    const diagnostic = errorDetailLine(caught);
    expect(diagnostic).toContain('AGENT_TEST_CONFLICT');
    expect(diagnostic).toContain('invalid_type');
    expect(diagnostic).not.toContain(secretUrl);
    expect(JSON.stringify(caught)).not.toContain('secret-value');
  });

  it('rejects a caught SQL failure instead of allowing the transaction to commit', async () => {
    const transaction = {
      execute: vi.fn().mockResolvedValue([{ remaining: 5000 }]),
    } as unknown as Transaction;
    await expect(
      withTranscriptQueryBudget(transaction, async (query) => {
        try {
          await query(() => Promise.reject(new Error('AGENT_TEST_CONFLICT')));
        } catch {
          /* The transaction must remain poisoned even when domain code catches the error. */
        }
      }),
    ).rejects.toMatchObject({ reason: 'domain_conflict' });
  });

  it('expires a suspended callback and rejects its late query', async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn().mockResolvedValue([{ remaining: 5000 }]);
      const transaction = { execute } as unknown as Transaction;
      let lateQuery!: () => Promise<unknown>;
      const work = withTranscriptQueryBudget(transaction, async (query) => {
        lateQuery = () => query((tx) => tx.execute('late write'));
        await new Promise(() => {});
      });
      const rejected = expect(work).rejects.toMatchObject({ reason: 'transaction_expired' });
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      await expect(lateQuery()).rejects.toMatchObject({ reason: 'transaction_expired' });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { userId: 'bad' },
    { sessionId: 'bad' },
    { turnId: 'bad' },
    { owner: '' },
    { expectedGeneration: '0' },
    { expectedGeneration: '01' },
    { expectedGeneration: '9223372036854775808' },
    { expectedGeneration: '1'.repeat(1000) },
    { revision: 0 },
    { continuationNo: 0 },
    { revision: 2_147_483_648 },
    { continuationNo: 2_147_483_648 },
    { now: '2026-09-08T00:00:00.000Z' },
  ])('rejects malformed or caller-clock input before starting SQL: %j', async (change) => {
    const transaction = vi.fn();
    const operation = vi.fn();
    const writer = new AgentTranscriptWriteTransactions({ transaction });
    await expect(writer.run({ ...input, ...change }, operation)).rejects.toMatchObject({
      reason: 'input_invalid',
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    { lockTimeoutMs: 0, transactionTimeoutMs: 5000 },
    { lockTimeoutMs: 1001, transactionTimeoutMs: 5000 },
    { lockTimeoutMs: 1000, transactionTimeoutMs: 5001 },
    { lockTimeoutMs: 1000, transactionTimeoutMs: 10 },
    { lockTimeoutMs: 0.5, transactionTimeoutMs: 5000 },
  ])('does not accept unbounded or invalid transaction limits: %j', (limits) => {
    expect(() => new AgentTranscriptWriteTransactions({} as Database, limits)).toThrow(
      'AGENT_TRANSCRIPT_WRITE_FAILED',
    );
  });
});
