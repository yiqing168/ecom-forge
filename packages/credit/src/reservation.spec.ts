import { describe, expect, it, vi } from 'vitest';

import type { CreditError } from './credit-errors.js';
import { consumeReservationInTransaction } from './reservation.js';

function settlementTransaction(attempt: { status: string; dispatchState: string } | null) {
  return {
    query: {
      creditLedger: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn() },
      taskAttempts: { findFirst: vi.fn().mockResolvedValue(attempt) },
    },
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };
}

const input = {
  userId: '00000000-0000-4000-8000-000000000001',
  reservationId: '00000000-0000-4000-8000-000000000002',
  taskAttemptId: '00000000-0000-4000-8000-000000000003',
  amount: '1.00',
  idempotencyKey: 'settle:task_attempt:00000000-0000-4000-8000-000000000003',
};

describe('reservation settlement guards', () => {
  it.each([
    ['accepted', 'accepted'],
    ['polling', 'accepted'],
    ['outcome_unknown', 'outcome_unknown'],
    ['failed', 'not_dispatched'],
  ])('protects %s/%s attempts from consumption', async (status, dispatchState) => {
    const transaction = settlementTransaction({ status, dispatchState });

    await expect(
      consumeReservationInTransaction(transaction as never, input),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_PROTECTED' } satisfies Partial<CreditError>);
    expect(transaction.select).not.toHaveBeenCalled();
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('rejects a replayed key when the financial meaning differs', async () => {
    const transaction = settlementTransaction(null);
    transaction.query.creditLedger.findFirst.mockResolvedValue({
      id: 'ledger-1',
      userId: input.userId,
      reservationId: input.reservationId,
      amount: '-2.00',
      balanceAfter: '8.00',
      frozenAfter: '0.00',
    });

    await expect(
      consumeReservationInTransaction(transaction as never, input),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' } satisfies Partial<CreditError>);
    expect(transaction.query.taskAttempts.findFirst).not.toHaveBeenCalled();
  });
});
