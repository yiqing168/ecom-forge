import { describe, expect, it } from 'vitest';

import { applyConsume, applyFreeze, applyRefund, applyRelease } from './credit-account.js';

const account = { userId: 'user-1', balance: '10.00', frozen: '4.00', version: 1 };

describe('credit account transitions', () => {
  it('freezes available balance without changing total owned credits', () => {
    expect(applyFreeze(account, '3')).toEqual({ balance: '7.00', frozen: '7.00' });
  });

  it('consumes only frozen credits', () => {
    expect(applyConsume(account, '1.25')).toEqual({ balance: '10.00', frozen: '2.75' });
  });

  it('releases frozen credits back to available balance', () => {
    expect(applyRelease(account, '2.50')).toEqual({ balance: '12.50', frozen: '1.50' });
  });

  it('refunds consumed credits without changing the frozen projection', () => {
    expect(applyRefund(account, '1.25')).toEqual({ balance: '11.25', frozen: '4.00' });
  });

  it('rejects transitions that exceed the corresponding projection', () => {
    expect(applyFreeze(account, '10.01')).toBeUndefined();
    expect(applyConsume(account, '4.01')).toBeUndefined();
    expect(applyRelease(account, '4.01')).toBeUndefined();
  });

  it('uses decimal rounding rather than binary floating-point arithmetic', () => {
    expect(applyFreeze(account, '0.105')).toEqual({ balance: '9.89', frozen: '4.11' });
  });
});
