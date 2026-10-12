import {
  and,
  creditAccounts,
  creditLedger,
  creditReservations,
  eq,
  type Database,
} from '@ecom-forge/db';
import {
  addMoney,
  compareMoney,
  normalizeMoney,
  subtractMoney,
  type MoneyString,
} from '@ecom-forge/shared';

import { applyRelease, lockCreditAccount, type CreditWriteContext } from './credit-account.js';
import { CreditError } from './credit-errors.js';

export interface WorkflowCancellationReleaseInput {
  userId: string;
  workflowRunId: string;
  reservationId: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowCancellationReleaseResult {
  ledgerId: string | null;
  releasedAmount: MoneyString;
  balanceAfter: MoneyString;
  frozenAfter: MoneyString;
  alreadyApplied: boolean;
}

export async function releaseWorkflowCancellationInTransaction(
  transaction: CreditWriteContext,
  input: WorkflowCancellationReleaseInput,
): Promise<WorkflowCancellationReleaseResult> {
  const prior = await transaction.query.creditLedger.findFirst({
    where: eq(creditLedger.idempotencyKey, input.idempotencyKey),
  });
  if (prior) {
    if (
      prior.userId !== input.userId ||
      prior.workflowRunId !== input.workflowRunId ||
      prior.reservationId !== input.reservationId ||
      prior.taskId !== null ||
      prior.type !== 'release'
    ) {
      throw new CreditError('Workflow cancellation release conflict', 'IDEMPOTENCY_CONFLICT');
    }
    return {
      ledgerId: prior.id,
      releasedAmount: normalizeMoney(prior.amount),
      balanceAfter: normalizeMoney(prior.balanceAfter),
      frozenAfter: normalizeMoney(prior.frozenAfter),
      alreadyApplied: true,
    };
  }

  const account = await lockCreditAccount(transaction, input.userId);
  const [reservation] = await transaction
    .select()
    .from(creditReservations)
    .where(
      and(
        eq(creditReservations.id, input.reservationId),
        eq(creditReservations.userId, input.userId),
        eq(creditReservations.workflowRunId, input.workflowRunId),
      ),
    )
    .for('update')
    .limit(1);
  if (!reservation) {
    throw new CreditError(
      'Workflow cancellation reservation is invalid',
      'RESERVATION_STATE_INVALID',
    );
  }
  const outstanding = subtractMoney(
    subtractMoney(
      normalizeMoney(reservation.estimatedAmount),
      normalizeMoney(reservation.settledAmount),
    ),
    normalizeMoney(reservation.releasedAmount),
  );
  if (compareMoney(outstanding, '0.00') === 0) {
    return {
      ledgerId: null,
      releasedAmount: normalizeMoney('0.00'),
      balanceAfter: account.balance,
      frozenAfter: account.frozen,
      alreadyApplied: false,
    };
  }
  if (!['frozen', 'partially_settled', 'releasing'].includes(reservation.status)) {
    throw new CreditError(
      'Workflow cancellation reservation is not releasable',
      'RESERVATION_STATE_INVALID',
    );
  }
  const next = applyRelease(account, outstanding);
  if (!next) {
    throw new CreditError('Frozen credit projection is invalid', 'RESERVATION_STATE_INVALID');
  }
  const [ledger] = await transaction
    .insert(creditLedger)
    .values({
      userId: input.userId,
      type: 'release',
      amount: outstanding,
      reservationId: input.reservationId,
      workflowRunId: input.workflowRunId,
      idempotencyKey: input.idempotencyKey,
      accountVersion: account.version + 1,
      balanceAfter: next.balance,
      frozenAfter: next.frozen,
      metadata: input.metadata ?? {},
    })
    .returning({ id: creditLedger.id });
  if (!ledger) throw new Error('Workflow cancellation release ledger insert returned no row');
  const releasedAmount = addMoney(normalizeMoney(reservation.releasedAmount), outstanding);
  const nextStatus =
    compareMoney(normalizeMoney(reservation.settledAmount), '0.00') > 0 ? 'settled' : 'released';
  await transaction
    .update(creditAccounts)
    .set({ ...next, version: account.version + 1, updatedAt: new Date() })
    .where(eq(creditAccounts.userId, input.userId));
  await transaction
    .update(creditReservations)
    .set({ releasedAmount, status: nextStatus })
    .where(eq(creditReservations.id, input.reservationId));
  return {
    ledgerId: ledger.id,
    releasedAmount: outstanding,
    balanceAfter: next.balance,
    frozenAfter: next.frozen,
    alreadyApplied: false,
  };
}

export function releaseWorkflowCancellation(
  database: Database,
  input: WorkflowCancellationReleaseInput,
): Promise<WorkflowCancellationReleaseResult> {
  return database.transaction((transaction) =>
    releaseWorkflowCancellationInTransaction(transaction, input),
  );
}
