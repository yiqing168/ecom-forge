import {
  and,
  creditAccounts,
  creditLedger,
  creditReservations,
  eq,
  taskAttempts,
  type Database,
} from '@ecom-forge/db';
import {
  addMoney,
  compareMoney,
  normalizeMoney,
  subtractMoney,
  type MoneyString,
} from '@ecom-forge/shared';

import {
  applyConsume,
  applyFreeze,
  applyRelease,
  lockCreditAccount,
  type CreditWriteContext,
} from './credit-account.js';
import { CreditError } from './credit-errors.js';

export interface FreezeInput {
  userId: string;
  reservationId: string;
  amount: MoneyString;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface CreditMutationResult {
  ledgerId: string;
  balanceAfter: MoneyString;
  frozenAfter: MoneyString;
  alreadyApplied: boolean;
}

async function existingLedger(transaction: CreditWriteContext, key: string) {
  return transaction.query.creditLedger.findFirst({ where: eq(creditLedger.idempotencyKey, key) });
}

function assertIdempotent(
  existing: typeof creditLedger.$inferSelect,
  input: {
    userId: string;
    ledgerAmount: string;
    reservationId: string;
    taskId?: string;
    type: typeof creditLedger.$inferSelect.type;
  },
): CreditMutationResult {
  if (
    existing.userId !== input.userId ||
    existing.reservationId !== input.reservationId ||
    (input.taskId !== undefined && existing.taskId !== input.taskId) ||
    existing.type !== input.type ||
    normalizeMoney(existing.amount) !== normalizeMoney(input.ledgerAmount)
  ) {
    throw new CreditError('Credit mutation idempotency conflict', 'IDEMPOTENCY_CONFLICT');
  }
  return {
    ledgerId: existing.id,
    balanceAfter: normalizeMoney(existing.balanceAfter),
    frozenAfter: normalizeMoney(existing.frozenAfter),
    alreadyApplied: true,
  };
}

export async function freezeReservationInTransaction(
  transaction: CreditWriteContext,
  input: FreezeInput,
): Promise<CreditMutationResult> {
  const amount = normalizeMoney(input.amount);
  const prior = await existingLedger(transaction, input.idempotencyKey);
  if (prior) {
    return assertIdempotent(prior, {
      userId: input.userId,
      reservationId: input.reservationId,
      type: 'reservation_freeze',
      ledgerAmount: `-${amount}`,
    });
  }

  const account = await lockCreditAccount(transaction, input.userId);
  const [reservation] = await transaction
    .select()
    .from(creditReservations)
    .where(
      and(
        eq(creditReservations.id, input.reservationId),
        eq(creditReservations.userId, input.userId),
      ),
    )
    .for('update')
    .limit(1);
  if (!reservation || reservation.status !== 'created') {
    throw new CreditError('Reservation is not available for freezing', 'RESERVATION_STATE_INVALID');
  }
  if (compareMoney(normalizeMoney(reservation.estimatedAmount), amount) !== 0) {
    throw new CreditError('Reservation amount does not match quote', 'RESERVATION_STATE_INVALID');
  }
  const next = applyFreeze(account, amount);
  if (!next) throw new CreditError('Insufficient credits', 'INSUFFICIENT_CREDITS');

  const [ledger] = await transaction
    .insert(creditLedger)
    .values({
      userId: input.userId,
      type: 'reservation_freeze',
      amount: `-${amount}`,
      reservationId: input.reservationId,
      idempotencyKey: input.idempotencyKey,
      accountVersion: account.version + 1,
      balanceAfter: next.balance,
      frozenAfter: next.frozen,
      metadata: input.metadata ?? {},
    })
    .returning({ id: creditLedger.id });
  if (!ledger) throw new Error('Freeze ledger insert returned no row');
  await transaction
    .update(creditAccounts)
    .set({ ...next, version: account.version + 1, updatedAt: new Date() })
    .where(eq(creditAccounts.userId, input.userId));
  await transaction
    .update(creditReservations)
    .set({ status: 'frozen' })
    .where(eq(creditReservations.id, input.reservationId));
  return {
    ledgerId: ledger.id,
    balanceAfter: next.balance,
    frozenAfter: next.frozen,
    alreadyApplied: false,
  };
}

export interface SettlementInput {
  userId: string;
  reservationId: string;
  taskAttemptId: string;
  amount: MoneyString;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface OutcomeUnknownReleaseInput extends SettlementInput {
  unknownEndedAtOrBefore: Date;
}

async function existingSettlementReplay(
  transaction: CreditWriteContext,
  input: SettlementInput,
  type: 'consume' | 'release',
  ledgerAmount: string,
): Promise<CreditMutationResult | undefined> {
  const prior = await existingLedger(transaction, input.idempotencyKey);
  if (!prior) return undefined;
  const result = assertIdempotent(prior, {
    userId: input.userId,
    reservationId: input.reservationId,
    type,
    ledgerAmount,
  });
  const attempt = await transaction.query.taskAttempts.findFirst({
    where: eq(taskAttempts.id, input.taskAttemptId),
    columns: { taskId: true },
  });
  if (!attempt || prior.taskId !== attempt.taskId) {
    throw new CreditError('Settlement idempotency conflict', 'IDEMPOTENCY_CONFLICT');
  }
  return result;
}

export async function consumeReservationInTransaction(
  transaction: CreditWriteContext,
  input: SettlementInput,
): Promise<CreditMutationResult> {
  const amount = normalizeMoney(input.amount);
  const replay = await existingSettlementReplay(transaction, input, 'consume', `-${amount}`);
  if (replay) return replay;
  const attempt = await transaction.query.taskAttempts.findFirst({
    where: eq(taskAttempts.id, input.taskAttemptId),
  });
  if (!attempt || attempt.status !== 'succeeded' || attempt.dispatchState === 'outcome_unknown') {
    throw new CreditError('Settlement result is protected', 'SETTLEMENT_PROTECTED');
  }
  const account = await lockCreditAccount(transaction, input.userId);
  const [reservation] = await transaction
    .select()
    .from(creditReservations)
    .where(
      and(
        eq(creditReservations.id, input.reservationId),
        eq(creditReservations.userId, input.userId),
      ),
    )
    .for('update')
    .limit(1);
  if (!reservation || !['frozen', 'partially_settled', 'releasing'].includes(reservation.status)) {
    throw new CreditError('Reservation is not settleable', 'RESERVATION_STATE_INVALID');
  }
  const next = applyConsume(account, amount);
  if (!next) throw new CreditError('Frozen credits are insufficient', 'RESERVATION_STATE_INVALID');
  const [ledger] = await transaction
    .insert(creditLedger)
    .values({
      userId: input.userId,
      type: 'consume',
      amount: `-${amount}`,
      reservationId: input.reservationId,
      workflowRunId: reservation.workflowRunId,
      taskId: attempt.taskId,
      idempotencyKey: input.idempotencyKey,
      accountVersion: account.version + 1,
      balanceAfter: next.balance,
      frozenAfter: next.frozen,
      metadata: input.metadata ?? {},
    })
    .returning({ id: creditLedger.id });
  if (!ledger) throw new Error('Consume ledger insert returned no row');
  const settled = normalizeMoney(reservation.settledAmount);
  const estimated = normalizeMoney(reservation.estimatedAmount);
  const released = normalizeMoney(reservation.releasedAmount);
  const nextSettled = requireAtMost(addMoney(settled, amount), estimated);
  const nextAccounted = requireAtMost(addMoney(nextSettled, released), estimated);
  const fullyAccounted = compareMoney(nextAccounted, estimated) === 0;
  const nextStatus = fullyAccounted
    ? 'settled'
    : compareMoney(released, '0.00') > 0
      ? 'releasing'
      : 'partially_settled';
  await transaction
    .update(creditAccounts)
    .set({ ...next, version: account.version + 1, updatedAt: new Date() })
    .where(eq(creditAccounts.userId, input.userId));
  await transaction
    .update(creditReservations)
    .set({ settledAmount: nextSettled, status: nextStatus })
    .where(eq(creditReservations.id, input.reservationId));
  return {
    ledgerId: ledger.id,
    balanceAfter: next.balance,
    frozenAfter: next.frozen,
    alreadyApplied: false,
  };
}

function requireAtMost(value: string, max: string): string {
  if (compareMoney(value, max) > 0)
    throw new CreditError('Settlement exceeds reservation', 'RESERVATION_STATE_INVALID');
  return value;
}

export async function releaseReservationInTransaction(
  transaction: CreditWriteContext,
  input: SettlementInput,
): Promise<CreditMutationResult> {
  return releaseReservationForAttemptInTransaction(transaction, input, { kind: 'terminal' });
}

/**
 * Releases one task's reservation only after an outcome-unknown deadline. The immutable
 * attempt remains unknown; this is a financial timeout, never evidence that dispatch failed.
 */
export async function releaseOutcomeUnknownReservationInTransaction(
  transaction: CreditWriteContext,
  input: OutcomeUnknownReleaseInput,
): Promise<CreditMutationResult> {
  return releaseReservationForAttemptInTransaction(transaction, input, {
    kind: 'outcome_unknown_timeout',
    cutoff: input.unknownEndedAtOrBefore,
  });
}

async function releaseReservationForAttemptInTransaction(
  transaction: CreditWriteContext,
  input: SettlementInput,
  authority: { kind: 'terminal' } | { kind: 'outcome_unknown_timeout'; cutoff: Date },
): Promise<CreditMutationResult> {
  const amount = normalizeMoney(input.amount);
  const replay = await existingSettlementReplay(transaction, input, 'release', amount);
  if (replay) return replay;
  const attempt = await transaction.query.taskAttempts.findFirst({
    where: eq(taskAttempts.id, input.taskAttemptId),
  });
  const terminalReleaseAllowed =
    attempt !== undefined &&
    attempt !== null &&
    attempt.dispatchState !== 'outcome_unknown' &&
    (attempt.status === 'succeeded' ||
      attempt.status === 'failed' ||
      (attempt.status === 'timeout' && attempt.dispatchState === 'not_dispatched'));
  const unknownTimeoutReleaseAllowed =
    attempt !== undefined &&
    attempt !== null &&
    authority.kind === 'outcome_unknown_timeout' &&
    attempt.status === 'outcome_unknown' &&
    attempt.dispatchState === 'outcome_unknown' &&
    attempt.endedAt !== null &&
    attempt.endedAt.getTime() <= authority.cutoff.getTime();
  const releaseAllowed =
    authority.kind === 'terminal' ? terminalReleaseAllowed : unknownTimeoutReleaseAllowed;
  if (!releaseAllowed || !attempt) {
    throw new CreditError('Settlement result is protected', 'SETTLEMENT_PROTECTED');
  }
  const account = await lockCreditAccount(transaction, input.userId);
  const [reservation] = await transaction
    .select()
    .from(creditReservations)
    .where(
      and(
        eq(creditReservations.id, input.reservationId),
        eq(creditReservations.userId, input.userId),
      ),
    )
    .for('update')
    .limit(1);
  if (!reservation || !['frozen', 'partially_settled', 'releasing'].includes(reservation.status)) {
    throw new CreditError('Reservation is not releasable', 'RESERVATION_STATE_INVALID');
  }
  const outstanding = subtractMoney(
    subtractMoney(
      normalizeMoney(reservation.estimatedAmount),
      normalizeMoney(reservation.settledAmount),
    ),
    normalizeMoney(reservation.releasedAmount),
  );
  if (compareMoney(amount, outstanding) > 0)
    throw new CreditError('Release exceeds outstanding reservation', 'RESERVATION_STATE_INVALID');
  const next = applyRelease(account, amount);
  if (!next) throw new CreditError('Frozen credits are insufficient', 'RESERVATION_STATE_INVALID');
  const [ledger] = await transaction
    .insert(creditLedger)
    .values({
      userId: input.userId,
      type: 'release',
      amount,
      reservationId: input.reservationId,
      workflowRunId: reservation.workflowRunId,
      taskId: attempt.taskId,
      idempotencyKey: input.idempotencyKey,
      accountVersion: account.version + 1,
      balanceAfter: next.balance,
      frozenAfter: next.frozen,
      metadata: input.metadata ?? {},
    })
    .returning({ id: creditLedger.id });
  if (!ledger) throw new Error('Release ledger insert returned no row');
  const released = addMoney(normalizeMoney(reservation.releasedAmount), amount);
  const settled = normalizeMoney(reservation.settledAmount);
  const fullyAccounted =
    compareMoney(addMoney(settled, released), normalizeMoney(reservation.estimatedAmount)) === 0;
  const nextStatus = fullyAccounted
    ? compareMoney(settled, '0.00') > 0
      ? 'settled'
      : 'released'
    : 'releasing';
  await transaction
    .update(creditAccounts)
    .set({ ...next, version: account.version + 1, updatedAt: new Date() })
    .where(eq(creditAccounts.userId, input.userId));
  await transaction
    .update(creditReservations)
    .set({ releasedAmount: released, status: nextStatus })
    .where(eq(creditReservations.id, input.reservationId));
  return {
    ledgerId: ledger.id,
    balanceAfter: next.balance,
    frozenAfter: next.frozen,
    alreadyApplied: false,
  };
}

export function freezeReservation(database: Database, input: FreezeInput) {
  return database.transaction((transaction) => freezeReservationInTransaction(transaction, input));
}
