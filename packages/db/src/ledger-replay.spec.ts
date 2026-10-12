import { describe, expect, it } from 'vitest';

import { replayLedgerProjection } from './ledger-replay.js';

describe('ledger projection replay foundation', () => {
  it('returns a zero projection for a new account', () => {
    expect(replayLedgerProjection([])).toEqual({ balance: '0.00', frozen: '0.00' });
  });

  it('rebuilds the projection from ordered immutable ledger snapshots', () => {
    expect(
      replayLedgerProjection([
        { balanceAfter: '100', frozenAfter: '0' },
        { balanceAfter: '80.00', frozenAfter: '20.00' },
        { balanceAfter: '80.0', frozenAfter: '0.0' },
      ]),
    ).toEqual({ balance: '80.00', frozen: '0.00' });
  });

  it('rejects invalid persisted monetary snapshots', () => {
    expect(() => replayLedgerProjection([{ balanceAfter: 'NaN', frozenAfter: '0.00' }])).toThrow(
      'Money values must be plain decimal strings',
    );
  });
});
