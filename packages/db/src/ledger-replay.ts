import { normalizeMoney, type MoneyString } from '@ecom-forge/shared';

export interface LedgerProjectionSnapshot {
  balanceAfter: MoneyString;
  frozenAfter: MoneyString;
}

export interface LedgerProjection {
  balance: MoneyString;
  frozen: MoneyString;
}

/**
 * Rebuilds the account projection from the immutable snapshots on ordered ledger rows.
 * S04 owns validation of each event's type-specific amount transition.
 */
export function replayLedgerProjection(
  orderedEntries: readonly LedgerProjectionSnapshot[],
): LedgerProjection {
  return orderedEntries.reduce<LedgerProjection>(
    (_, entry) => ({
      balance: normalizeMoney(entry.balanceAfter),
      frozen: normalizeMoney(entry.frozenAfter),
    }),
    { balance: '0.00', frozen: '0.00' },
  );
}
