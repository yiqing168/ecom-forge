import { and, creditAccounts, creditLedger, eq } from '@ecom-forge/db';
import { addMoney, compareMoney, normalizeMoney, type MoneyString } from '@ecom-forge/shared';

import { lockCreditAccount, type CreditWriteContext } from './credit-account.js';
import { CreditError } from './credit-errors.js';

export interface AdminManualCorrectionInput {
  userId: string;
  amount: MoneyString;
  ledgerIdempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface AdminManualCorrectionResult {
  alreadyApplied: boolean;
  amount: MoneyString;
  balanceAfter: MoneyString;
  balanceBefore: MoneyString;
  ledgerId: string;
  version: number;
  versionBefore: number;
}

export async function applyAdminManualCorrectionInTransaction(
  transaction: CreditWriteContext,
  input: AdminManualCorrectionInput,
): Promise<AdminManualCorrectionResult> {
  const amount = normalizeMoney(input.amount);
  if (compareMoney(amount, '0.00') === 0) {
    throw new CreditError('Correction amount must be non-zero', 'RESERVATION_STATE_INVALID');
  }

  const prior = await transaction.query.creditLedger.findFirst({
    where: eq(creditLedger.idempotencyKey, input.ledgerIdempotencyKey),
  });
  if (prior) {
    if (
      prior.userId !== input.userId ||
      prior.type !== 'manual_correction' ||
      normalizeMoney(prior.amount) !== amount
    ) {
      throw new CreditError('Correction idempotency conflict', 'IDEMPOTENCY_CONFLICT');
    }
    return {
      alreadyApplied: true,
      amount,
      balanceAfter: normalizeMoney(prior.balanceAfter),
      balanceBefore: normalizeMoney(prior.balanceAfter),
      ledgerId: prior.id,
      version: prior.accountVersion ?? 0,
      versionBefore: Math.max(0, (prior.accountVersion ?? 1) - 1),
    };
  }

  const account = await lockCreditAccount(transaction, input.userId);
  const balanceAfter = addMoney(account.balance, amount);
  if (compareMoney(balanceAfter, '0.00') < 0) {
    throw new CreditError('Correction would make balance negative', 'INSUFFICIENT_CREDITS');
  }
  const version = account.version + 1;
  const [ledger] = await transaction
    .insert(creditLedger)
    .values({
      userId: input.userId,
      type: 'manual_correction',
      amount,
      idempotencyKey: input.ledgerIdempotencyKey,
      accountVersion: version,
      balanceAfter,
      frozenAfter: account.frozen,
      metadata: input.metadata ?? {},
    })
    .returning({ id: creditLedger.id });
  if (!ledger) throw new Error('Admin correction ledger insert returned no row');

  const [updated] = await transaction
    .update(creditAccounts)
    .set({ balance: balanceAfter, frozen: account.frozen, version, updatedAt: new Date() })
    .where(
      and(eq(creditAccounts.userId, input.userId), eq(creditAccounts.version, account.version)),
    )
    .returning({ userId: creditAccounts.userId });
  if (!updated) {
    throw new CreditError('Correction account version conflict', 'RESERVATION_STATE_INVALID');
  }

  return {
    alreadyApplied: false,
    amount,
    balanceAfter,
    balanceBefore: account.balance,
    ledgerId: ledger.id,
    version,
    versionBefore: account.version,
  };
}
