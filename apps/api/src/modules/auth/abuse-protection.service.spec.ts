import { describe, expect, it, vi } from 'vitest';

import { AbuseProtectionService, RequestRateLimitedError } from './abuse-protection.service.js';
import { HmacKeyring } from './security/hmac-keyring.js';

const userId = 'f9472da6-7849-4a16-b502-922c451dbdfa';

function createService(limiter: { consume: ReturnType<typeof vi.fn> }) {
  const database = { transaction: vi.fn() };
  const activity = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    service: new AbuseProtectionService(
      database as never,
      limiter as never,
      new HmacKeyring(`abuse-test:${Buffer.alloc(32, 6).toString('base64url')}`),
      activity as never,
    ),
    database,
    activity,
  };
}

describe('AbuseProtectionService', () => {
  it('requires both the user and trusted IP buckets to be allowed', async () => {
    const limiter = { consume: vi.fn() };
    limiter.consume
      .mockResolvedValueOnce({ allowed: true, remaining: 29, retryAfterSeconds: 0 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 17 });
    const { service } = createService(limiter);

    await expect(service.assertAgentRequest(userId, '203.0.113.8')).rejects.toBeInstanceOf(
      RequestRateLimitedError,
    );
    expect(limiter.consume).toHaveBeenCalledTimes(2);
  });

  it('freezes only after the tenth distinct empty-credit attempt', async () => {
    const limiter = { consume: vi.fn() };
    let attempts = 0;
    limiter.consume.mockImplementation(() => {
      attempts += 1;
      return { allowed: true, remaining: Math.max(0, 10 - attempts), retryAfterSeconds: 0 };
    });
    const state = createService(limiter);
    const transaction = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            for: vi.fn().mockResolvedValue([{ id: userId, riskStatus: 'normal', riskRevision: 3 }]),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: userId }]),
          })),
        })),
      })),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
    };
    state.database.transaction.mockImplementation(
      (callback: (value: typeof transaction) => Promise<unknown>) => callback(transaction),
    );

    for (let index = 0; index < 9; index += 1) {
      await state.service.recordZeroCreditAttempt(userId, '203.0.113.8');
    }
    expect(state.database.transaction).not.toHaveBeenCalled();
    await state.service.recordZeroCreditAttempt(userId, '203.0.113.8');
    expect(state.database.transaction).toHaveBeenCalledTimes(1);
    expect(state.activity.record).toHaveBeenCalledTimes(1);
  });
});
