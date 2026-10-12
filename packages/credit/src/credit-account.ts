import {
  creditAccounts,
  creditLedger,
  eq,
  replayLedgerProjection,
  type Database,
} from '@ecom-forge/db';
import {
  addMoney,
  compareMoney,
  normalizeMoney,
  subtractMoney,
  type MoneyString,
} from '@ecom-forge/shared';

import { CreditProjectionDriftError } from './credit-errors.js';
import { replayCreditLedger } from './credit-ledger-replay.js';

export type CreditWriteContext = Pick<Database, 'query' | 'select' | 'insert' | 'update'>;

export interface LockedCreditAccount {
  userId: string;
  balance: MoneyString;
  frozen: MoneyString;
  version: number;
}

export async function lockCreditAccount(
  transaction: CreditWriteContext,
  userId: string,
): Promise<LockedCreditAccount> {
  const [account] = await transaction
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.userId, userId))
    .for('update')
    .limit(1);

  if (!account) {
    await transaction
      .insert(creditAccounts)
      .values({ userId, balance: '0.00', frozen: '0.00', version: 0 })
      .onConflictDoNothing({ target: creditAccounts.userId });
    const [created] = await transaction
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.userId, userId))
      .for('update')
      .limit(1);
    if (!created) throw new CreditProjectionDriftError();
    return validateProjection(transaction, created);
  }
  return validateProjection(transaction, account);
}

async function validateProjection(
  transaction: CreditWriteContext,
  account: typeof creditAccounts.$inferSelect,
): Promise<LockedCreditAccount> {
  const entries = await transaction.query.creditLedger.findMany({
    where: eq(creditLedger.userId, account.userId),
    columns: {
      id: true,
      accountVersion: true,
      type: true,
      amount: true,
      balanceAfter: true,
      frozenAfter: true,
      createdAt: true,
    },
  });
  if (entries.length !== account.version) throw new CreditProjectionDriftError();

  const legacyEntries = entries
    .filter((entry) => entry.accountVersion == null)
    .sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
    );
  const versionedEntries = entries
    .filter(
      (entry): entry is typeof entry & { accountVersion: number } =>
        entry.accountVersion !== null && entry.accountVersion !== undefined,
    )
    .sort((left, right) => left.accountVersion - right.accountVersion);
  for (const [index, entry] of versionedEntries.entries()) {
    if (entry.accountVersion !== legacyEntries.length + index + 1) {
      throw new CreditProjectionDriftError();
    }
  }
  const replayed = replayCreditLedger(versionedEntries, replayLedgerProjection(legacyEntries));
  if (
    compareMoney(normalizeMoney(account.balance), replayed.balance) !== 0 ||
    compareMoney(normalizeMoney(account.frozen), replayed.frozen) !== 0
  ) {
    throw new CreditProjectionDriftError();
  }
  return {
    userId: account.userId,
    balance: normalizeMoney(account.balance),
    frozen: normalizeMoney(account.frozen),
    version: account.version,
  };
}

export function applyFreeze(account: LockedCreditAccount, amount: MoneyString) {
  const normalized = normalizeMoney(amount);
  if (compareMoney(normalized, '0.00') <= 0) throw new RangeError('Freeze amount must be positive');
  if (compareMoney(account.balance, normalized) < 0) return undefined;
  return {
    balance: subtractMoney(account.balance, normalized),
    frozen: addMoney(account.frozen, normalized),
  };
}

export function applyConsume(account: LockedCreditAccount, amount: MoneyString) {
  const normalized = normalizeMoney(amount);
  if (compareMoney(normalized, '0.00') <= 0)
    throw new RangeError('Consume amount must be positive');
  if (compareMoney(account.frozen, normalized) < 0) return undefined;
  return { balance: account.balance, frozen: subtractMoney(account.frozen, normalized) };
}

export function applyRelease(account: LockedCreditAccount, amount: MoneyString) {
  const normalized = normalizeMoney(amount);
  if (compareMoney(normalized, '0.00') <= 0)
    throw new RangeError('Release amount must be positive');
  if (compareMoney(account.frozen, normalized) < 0) return undefined;
  return {
    balance: addMoney(account.balance, normalized),
    frozen: subtractMoney(account.frozen, normalized),
  };
}

export function applyRefund(account: LockedCreditAccount, amount: MoneyString) {
  const normalized = normalizeMoney(amount);
  if (compareMoney(normalized, '0.00') <= 0) throw new RangeError('Refund amount must be positive');
  return { balance: addMoney(account.balance, normalized), frozen: account.frozen };
}
