import { and, appeals, creditAccounts, creditLedger, eq, type Database } from '@ecom-forge/db';
import {
  addMoney,
  compareMoney,
  normalizeMoney,
  subtractMoney,
  type MoneyString,
} from '@ecom-forge/shared';

import { applyRefund, lockCreditAccount, type CreditWriteContext } from './credit-account.js';
import { CreditError } from './credit-errors.js';

export interface AppealRefundInput {
  userId: string;
  appealId: string;
  reviewerId: string;
  amount: MoneyString;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface AppealRefundResult {
  ledgerId: string;
  balanceAfter: MoneyString;
  alreadyApplied: boolean;
}

export async function refundAppealInTransaction(
  transaction: CreditWriteContext,
  input: AppealRefundInput,
): Promise<AppealRefundResult> {
  const amount = normalizeMoney(input.amount);
  if (compareMoney(amount, '0.00') <= 0) {
    throw new CreditError('Refund amount must be positive', 'RESERVATION_STATE_INVALID');
  }
  const prior = await transaction.query.creditLedger.findFirst({
    where: eq(creditLedger.idempotencyKey, input.idempotencyKey),
  });
  if (prior) {
    if (
      prior.userId !== input.userId ||
      prior.appealId !== input.appealId ||
      prior.type !== 'appeal_refund' ||
      normalizeMoney(prior.amount) !== amount
    ) {
      throw new CreditError('Refund idempotency conflict', 'IDEMPOTENCY_CONFLICT');
    }
    return {
      ledgerId: prior.id,
      balanceAfter: normalizeMoney(prior.balanceAfter),
      alreadyApplied: true,
    };
  }

  const account = await lockCreditAccount(transaction, input.userId);
  const [owned] = await transaction
    .select({ appeal: appeals, originalLedger: creditLedger })
    .from(appeals)
    .innerJoin(creditLedger, eq(creditLedger.id, appeals.ledgerId))
    .where(and(eq(appeals.id, input.appealId), eq(appeals.userId, input.userId)))
    .for('update')
    .limit(1);
  if (
    !owned ||
    owned.appeal.status !== 'pending' ||
    owned.originalLedger.userId !== input.userId ||
    owned.originalLedger.type !== 'consume'
  ) {
    throw new CreditError('Appeal is not refundable', 'RESERVATION_STATE_INVALID');
  }

  const priorRefunds = await transaction
    .select({ amount: creditLedger.amount })
    .from(creditLedger)
    .innerJoin(appeals, eq(appeals.id, creditLedger.appealId))
    .where(
      and(eq(appeals.ledgerId, owned.originalLedger.id), eq(creditLedger.type, 'appeal_refund')),
    );
  const refunded = priorRefunds.reduce(
    (total, entry) => addMoney(total, normalizeMoney(entry.amount)),
    '0.00' as MoneyString,
  );
  const consumed = subtractMoney('0.00', normalizeMoney(owned.originalLedger.amount));
  const refundable = subtractMoney(consumed, refunded);
  if (compareMoney(amount, refundable) > 0) {
    throw new CreditError('Refund exceeds the refundable amount', 'RESERVATION_STATE_INVALID');
  }

  const next = applyRefund(account, amount);
  const [ledger] = await transaction
    .insert(creditLedger)
    .values({
      userId: input.userId,
      type: 'appeal_refund',
      amount,
      reservationId: owned.originalLedger.reservationId,
      workflowRunId: owned.originalLedger.workflowRunId,
      taskId: owned.originalLedger.taskId,
      appealId: owned.appeal.id,
      idempotencyKey: input.idempotencyKey,
      accountVersion: account.version + 1,
      balanceAfter: next.balance,
      frozenAfter: next.frozen,
      metadata: {
        ...input.metadata,
        original_ledger_id: owned.originalLedger.id,
      },
    })
    .returning({ id: creditLedger.id });
  if (!ledger) throw new Error('Appeal refund ledger insert returned no row');
  const [updatedAppeal] = await transaction
    .update(appeals)
    .set({
      status: 'refunded',
      refundAmount: amount,
      reviewerId: input.reviewerId,
      reviewedAt: new Date(),
    })
    .where(and(eq(appeals.id, input.appealId), eq(appeals.status, 'pending')))
    .returning({ id: appeals.id });
  if (!updatedAppeal) {
    throw new CreditError('Appeal refund transition was rejected', 'RESERVATION_STATE_INVALID');
  }
  await transaction
    .update(creditAccounts)
    .set({ ...next, version: account.version + 1, updatedAt: new Date() })
    .where(eq(creditAccounts.userId, input.userId));
  return { ledgerId: ledger.id, balanceAfter: next.balance, alreadyApplied: false };
}

export function refundAppeal(database: Database, input: AppealRefundInput) {
  return database.transaction((transaction) => refundAppealInTransaction(transaction, input));
}
