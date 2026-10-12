import type { creditLedger, LedgerProjection } from '@ecom-forge/db';
import { addMoney, compareMoney, normalizeMoney, subtractMoney } from '@ecom-forge/shared';

import { CreditProjectionDriftError } from './credit-errors.js';

type LedgerEntry = Pick<
  typeof creditLedger.$inferSelect,
  'type' | 'amount' | 'balanceAfter' | 'frozenAfter'
>;

/** Version ordering and the legacy prefix are checked by the account lock owner. */
export function replayCreditLedger(
  orderedEntries: readonly LedgerEntry[],
  initial: LedgerProjection = { balance: '0.00', frozen: '0.00' },
): LedgerProjection {
  try {
    let balance = normalizeMoney(initial.balance);
    let frozen = normalizeMoney(initial.frozen);
    if (compareMoney(balance, '0.00') < 0 || compareMoney(frozen, '0.00') < 0)
      throw new CreditProjectionDriftError();
    for (const entry of orderedEntries) {
      const amount = normalizeMoney(entry.amount);
      const direction = compareMoney(amount, '0.00');
      if (
        direction === 0 ||
        (['grant', 'release', 'appeal_refund'].includes(entry.type) && direction !== 1) ||
        (['reservation_freeze', 'consume', 'expiry'].includes(entry.type) && direction !== -1)
      )
        throw new CreditProjectionDriftError();
      switch (entry.type) {
        case 'reservation_freeze':
          balance = addMoney(balance, amount);
          frozen = subtractMoney(frozen, amount);
          break;
        case 'consume':
          frozen = addMoney(frozen, amount);
          break;
        case 'release':
          balance = addMoney(balance, amount);
          frozen = subtractMoney(frozen, amount);
          break;
        case 'grant':
        case 'appeal_refund':
        case 'manual_correction':
        case 'expiry':
          balance = addMoney(balance, amount);
          break;
        default:
          throw new CreditProjectionDriftError();
      }
      if (
        compareMoney(balance, '0.00') < 0 ||
        compareMoney(frozen, '0.00') < 0 ||
        compareMoney(balance, entry.balanceAfter) !== 0 ||
        compareMoney(frozen, entry.frozenAfter) !== 0
      )
        throw new CreditProjectionDriftError();
    }
    return { balance, frozen };
  } catch (error) {
    if (error instanceof CreditProjectionDriftError) throw error;
    if (error instanceof TypeError || error instanceof RangeError)
      throw new CreditProjectionDriftError();
    throw error;
  }
}
