import {
  RedisVerificationRateLimiter,
  type EvalClient,
} from './redis-verification-rate-limiter.js';
import {
  AuthControlPlaneUnavailableError,
  AuthExclusiveLockBusyError,
} from './verification-rate-limiter.js';

describe('RedisVerificationRateLimiter', () => {
  it('maps the atomic counter result to an allow decision', async () => {
    const limiter = new RedisVerificationRateLimiter({
      eval: vi.fn().mockResolvedValue([2, 42]),
    });

    await expect(limiter.consume('auth:hash', { max: 3, windowSeconds: 60 })).resolves.toEqual({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 42,
    });
  });

  it('runs an operation only while the Redis owner token holds the lock', async () => {
    const evalMock = vi.fn<EvalClient['eval']>().mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    const limiter = new RedisVerificationRateLimiter({ eval: evalMock });

    await expect(
      limiter.withExclusiveLock('auth:verify:lock', 30, () => Promise.resolve('done')),
    ).resolves.toBe('done');
    expect(evalMock).toHaveBeenCalledTimes(2);
    expect(evalMock.mock.calls[0]?.[1].arguments[0]).toBe(evalMock.mock.calls[1]?.[1].arguments[0]);
  });

  it('distinguishes normal lock contention from a Redis control-plane failure', async () => {
    const evalMock = vi.fn().mockResolvedValue(0);
    const limiter = new RedisVerificationRateLimiter({ eval: evalMock });

    await expect(
      limiter.withExclusiveLock('auth:verify:lock', 30, () => Promise.resolve('not-run')),
    ).rejects.toBeInstanceOf(AuthExclusiveLockBusyError);
    expect(evalMock).toHaveBeenCalledOnce();
  });

  it('fails closed when lock acquisition returns malformed data or Redis is unavailable', async () => {
    const malformed = new RedisVerificationRateLimiter({
      eval: vi.fn().mockResolvedValue('unexpected'),
    });
    const unavailable = new RedisVerificationRateLimiter({
      eval: vi.fn().mockRejectedValue(new Error('connection lost')),
    });

    await expect(
      malformed.withExclusiveLock('auth:verify:lock', 30, () => Promise.resolve('not-run')),
    ).rejects.toBeInstanceOf(AuthControlPlaneUnavailableError);
    await expect(
      unavailable.withExclusiveLock('auth:verify:lock', 30, () => Promise.resolve('not-run')),
    ).rejects.toBeInstanceOf(AuthControlPlaneUnavailableError);
  });

  it('preserves domain errors thrown by the locked operation', async () => {
    const domainError = new Error('invalid OTP');
    const limiter = new RedisVerificationRateLimiter({
      eval: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1),
    });

    await expect(
      limiter.withExclusiveLock('auth:verify:lock', 30, () => Promise.reject(domainError)),
    ).rejects.toBe(domainError);
  });

  it('rejects requests after the configured maximum', async () => {
    const limiter = new RedisVerificationRateLimiter({
      eval: vi.fn().mockResolvedValue([4, 39]),
    });

    await expect(
      limiter.consume('auth:hash', { max: 3, windowSeconds: 60 }),
    ).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  it('fails closed when Redis is unavailable or returns an invalid response', async () => {
    const unavailable = new RedisVerificationRateLimiter({
      eval: vi.fn().mockRejectedValue(new Error('connection lost')),
    });
    const malformed = new RedisVerificationRateLimiter({
      eval: vi.fn().mockResolvedValue('unexpected'),
    });

    await expect(
      unavailable.consume('auth:hash', { max: 3, windowSeconds: 60 }),
    ).rejects.toBeInstanceOf(AuthControlPlaneUnavailableError);
    await expect(
      malformed.consume('auth:hash', { max: 3, windowSeconds: 60 }),
    ).rejects.toBeInstanceOf(AuthControlPlaneUnavailableError);
  });
});
