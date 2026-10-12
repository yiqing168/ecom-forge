import { describe, expect, it, vi } from 'vitest';

import { refundAppealByAdminInTransaction } from './admin-appeal-refund.js';

const input = {
  userId: '00000000-0000-4000-8000-000000000001',
  appealId: '00000000-0000-4000-8000-000000000002',
  reviewerAdminId: '00000000-0000-4000-8000-000000000003',
  expectedRevision: 1,
  decisionReason: 'Confirmed refund after evidence review',
  amount: '1.00',
  ledgerIdempotencyKey: 'appeal-refund:test-key',
  decisionIdempotencyKeyHash: 'a'.repeat(64),
} as const;

function transaction() {
  const account = {
    userId: input.userId,
    balance: '9.00',
    frozen: '0.00',
    version: 3,
  };
  const appeal = {
    id: input.appealId,
    ledgerId: '00000000-0000-4000-8000-000000000004',
    userId: input.userId,
    status: 'pending',
    revision: 1,
  };
  const originalLedger = {
    id: appeal.ledgerId,
    userId: input.userId,
    type: 'consume',
    amount: '-1.00',
    reservationId: null,
    workflowRunId: null,
    taskId: null,
  };
  let selectCall = 0;
  let updateCall = 0;
  const insertedValues = vi.fn(() => ({
    returning: vi.fn().mockResolvedValue([{ id: '00000000-0000-4000-8000-000000000005' }]),
  }));
  const database = {
    query: {
      creditLedger: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'ledger-grant',
            accountVersion: 1,
            type: 'grant',
            amount: '10.00',
            balanceAfter: '10.00',
            frozenAfter: '0.00',
            createdAt: new Date(1),
          },
          {
            id: 'ledger-freeze',
            accountVersion: 2,
            type: 'reservation_freeze',
            amount: '-1.00',
            balanceAfter: '9.00',
            frozenAfter: '1.00',
            createdAt: new Date(2),
          },
          {
            id: originalLedger.id,
            accountVersion: 3,
            type: 'consume',
            amount: '-1.00',
            balanceAfter: '9.00',
            frozenAfter: '0.00',
            createdAt: new Date(1),
          },
        ]),
      },
      appeals: { findFirst: vi.fn() },
    },
    select: vi.fn(() => {
      selectCall += 1;
      if (selectCall === 1) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              for: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([account]) })),
            })),
          })),
        };
      }
      if (selectCall === 2) {
        return {
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                for: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue([{ appeal, originalLedger }]),
                })),
              })),
            })),
          })),
        };
      }
      return {
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
        })),
      };
    }),
    insert: vi.fn(() => ({ values: insertedValues })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => {
          updateCall += 1;
          return updateCall === 1
            ? { returning: vi.fn().mockResolvedValue([{ id: input.appealId }]) }
            : Promise.resolve([]);
        }),
      })),
    })),
  };
  return { database, insertedValues };
}

describe('admin appeal refund', () => {
  it('atomically appends a refund ledger and advances the appeal/account projections', async () => {
    const { database, insertedValues } = transaction();

    await expect(refundAppealByAdminInTransaction(database as never, input)).resolves.toEqual({
      ledgerId: '00000000-0000-4000-8000-000000000005',
      balanceAfter: '10.00',
      appealRevision: 2,
      alreadyApplied: false,
    });
    expect(insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'appeal_refund',
        amount: '1.00',
        accountVersion: 4,
        balanceAfter: '10.00',
        frozenAfter: '0.00',
        appealId: input.appealId,
      }),
    );
    expect(database.update).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-positive refund before touching the account', async () => {
    const { database } = transaction();

    await expect(
      refundAppealByAdminInTransaction(database as never, { ...input, amount: '0.00' }),
    ).rejects.toThrow('Refund amount must be positive');
    expect(database.select).not.toHaveBeenCalled();
  });
});
