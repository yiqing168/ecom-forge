import { describe, expect, it, vi } from 'vitest';

import { applyAdminManualCorrectionInTransaction } from './admin-manual-correction.js';

const input = {
  userId: 'user-1',
  amount: '1.50',
  ledgerIdempotencyKey: 'manual-correction:admin:key',
  metadata: { source: 'test' },
} as const;

function transaction(existingLedger: unknown = null) {
  const insertValues = vi.fn(() => ({
    returning: vi.fn().mockResolvedValue([{ id: 'ledger-2' }]),
  }));
  const updateValues = vi.fn(() => ({
    where: vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ userId: input.userId }]),
    })),
  }));
  const database = {
    query: {
      creditLedger: {
        findFirst: vi.fn().mockResolvedValue(existingLedger),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'ledger-1',
            accountVersion: 1,
            type: 'grant',
            amount: '2.50',
            balanceAfter: '2.50',
            frozenAfter: '0.00',
            createdAt: new Date(1),
          },
          {
            id: 'ledger-freeze',
            accountVersion: 2,
            type: 'reservation_freeze',
            amount: '-0.50',
            balanceAfter: '2.00',
            frozenAfter: '0.50',
            createdAt: new Date(1),
          },
        ]),
      },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          for: vi.fn(() => ({
            limit: vi
              .fn()
              .mockResolvedValue([
                { userId: input.userId, balance: '2.00', frozen: '0.50', version: 2 },
              ]),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateValues })),
  };
  return { database, insertValues, updateValues };
}

describe('admin manual credit correction', () => {
  it('appends a signed correction and advances the account projection', async () => {
    const { database, insertValues, updateValues } = transaction();

    const result = await applyAdminManualCorrectionInTransaction(database as never, input);

    expect(result).toEqual({
      alreadyApplied: false,
      amount: '1.50',
      balanceAfter: '3.50',
      balanceBefore: '2.00',
      ledgerId: 'ledger-2',
      version: 3,
      versionBefore: 2,
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'manual_correction',
        amount: '1.50',
        balanceAfter: '3.50',
        frozenAfter: '0.50',
        accountVersion: 3,
      }),
    );
    expect(updateValues).toHaveBeenCalledWith(
      expect.objectContaining({ balance: '3.50', frozen: '0.50', version: 3 }),
    );
  });

  it('allows a debit that does not make the balance negative', async () => {
    const { database } = transaction();
    const result = await applyAdminManualCorrectionInTransaction(database as never, {
      ...input,
      amount: '-1.25',
    });
    expect(result.balanceAfter).toBe('0.75');
  });

  it('rejects zero and a debit beyond the available balance', async () => {
    const { database } = transaction();
    await expect(
      applyAdminManualCorrectionInTransaction(database as never, { ...input, amount: '0.00' }),
    ).rejects.toThrow('Correction amount must be non-zero');
    await expect(
      applyAdminManualCorrectionInTransaction(database as never, { ...input, amount: '-2.01' }),
    ).rejects.toThrow('Correction would make balance negative');
  });

  it('replays the same ledger and rejects payload drift', async () => {
    const prior = {
      id: 'ledger-prior',
      userId: input.userId,
      type: 'manual_correction',
      amount: '1.50',
      balanceAfter: '3.50',
      accountVersion: 2,
    };
    const replay = transaction(prior);
    await expect(
      applyAdminManualCorrectionInTransaction(replay.database as never, input),
    ).resolves.toMatchObject({ alreadyApplied: true, ledgerId: 'ledger-prior' });
    expect(replay.database.select).not.toHaveBeenCalled();

    const conflict = transaction({ ...prior, amount: '2.00' });
    await expect(
      applyAdminManualCorrectionInTransaction(conflict.database as never, input),
    ).rejects.toThrow('Correction idempotency conflict');
  });
});
