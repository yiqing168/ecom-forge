import { describe, expect, it } from 'vitest';

import { CreditProjectionDriftError } from './credit-errors.js';
import { replayCreditLedger } from './credit-ledger-replay.js';

const entries: Parameters<typeof replayCreditLedger>[0] = [
  { type: 'grant', amount: '10.00', balanceAfter: '10.00', frozenAfter: '0.00' },
  { type: 'reservation_freeze', amount: '-4.00', balanceAfter: '6.00', frozenAfter: '4.00' },
  { type: 'consume', amount: '-1.25', balanceAfter: '6.00', frozenAfter: '2.75' },
  { type: 'release', amount: '2.75', balanceAfter: '8.75', frozenAfter: '0.00' },
  { type: 'appeal_refund', amount: '1.25', balanceAfter: '10.00', frozenAfter: '0.00' },
  { type: 'manual_correction', amount: '-2.00', balanceAfter: '8.00', frozenAfter: '0.00' },
  { type: 'expiry', amount: '-1.00', balanceAfter: '7.00', frozenAfter: '0.00' },
  { type: 'manual_correction', amount: '0.10', balanceAfter: '7.10', frozenAfter: '0.00' },
];

describe('versioned credit ledger replay', () => {
  it('calculates every typed transition with decimal arithmetic', () => {
    expect(replayCreditLedger(entries)).toEqual({ balance: '7.10', frozen: '0.00' });
    expect(replayCreditLedger([])).toEqual({ balance: '0.00', frozen: '0.00' });
  });

  it('continues from the compatible legacy snapshot without claiming to validate its deltas', () => {
    expect(
      replayCreditLedger(
        [{ type: 'consume', amount: '-1.00', balanceAfter: '5.00', frozenAfter: '1.00' }],
        { balance: '5.00', frozen: '2.00' },
      ),
    ).toEqual({ balance: '5.00', frozen: '1.00' });
  });

  it('rejects intermediate drift even when later snapshots inherit the wrong projection', () => {
    expect(() =>
      replayCreditLedger([
        entries[0]!,
        { ...entries[1]!, balanceAfter: '7.00' },
        { type: 'grant', amount: '1.00', balanceAfter: '8.00', frozenAfter: '4.00' },
      ]),
    ).toThrow(CreditProjectionDriftError);
  });

  it.each(['grant', 'release', 'appeal_refund'] as const)(
    'rejects a negative %s amount',
    (type) => {
      expect(() =>
        replayCreditLedger([{ type, amount: '-1.00', balanceAfter: '0.00', frozenAfter: '0.00' }]),
      ).toThrow(CreditProjectionDriftError);
    },
  );

  it.each(['reservation_freeze', 'consume', 'expiry'] as const)(
    'rejects a positive %s amount',
    (type) => {
      expect(() =>
        replayCreditLedger([{ type, amount: '1.00', balanceAfter: '1.00', frozenAfter: '0.00' }]),
      ).toThrow(CreditProjectionDriftError);
    },
  );

  it.each(['0.00', 'NaN', '1e3'])(
    'rejects zero or malformed money without echoing the input: %s',
    (amount) => {
      expect(() =>
        replayCreditLedger([
          { type: 'manual_correction', amount, balanceAfter: '0.00', frozenAfter: '0.00' },
        ]),
      ).toThrow(CreditProjectionDriftError);
    },
  );

  it.each(['consume', 'release'] as const)('rejects %s beyond frozen credits', (type) => {
    expect(() =>
      replayCreditLedger([
        {
          type,
          amount: type === 'consume' ? '-1.00' : '1.00',
          balanceAfter: '0.00',
          frozenAfter: '-1.00',
        },
      ]),
    ).toThrow(CreditProjectionDriftError);
  });
});
