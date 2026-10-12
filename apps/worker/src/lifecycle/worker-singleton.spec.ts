import { describe, expect, it, vi } from 'vitest';

import { WorkerSingleton, WorkerSingletonLeaseLostError } from './worker-singleton.js';

function fixture(setResult: 'OK' | null = 'OK', evalResult = 1) {
  const redis = {
    set: vi.fn(() => Promise.resolve(setResult)),
    eval: vi.fn(() => Promise.resolve(evalResult)),
  };
  return { redis, singleton: new WorkerSingleton(redis as never, 'ecom-forge', 'worker-1', 45) };
}

describe('WorkerSingleton', () => {
  it('acquires the namespace lock with an expiry', async () => {
    const state = fixture();

    await expect(state.singleton.acquire()).resolves.toBe(true);
    expect(state.redis.set).toHaveBeenCalledWith(
      'ecom-forge:worker:singleton:v1',
      'worker-1',
      'EX',
      45,
      'NX',
    );
  });

  it('reports contention without replacing the existing owner', async () => {
    const state = fixture(null);

    await expect(state.singleton.acquire()).resolves.toBe(false);
  });

  it('renews and releases through owner-checked scripts', async () => {
    const state = fixture();

    await expect(state.singleton.renew()).resolves.toBe(true);
    await expect(state.singleton.release()).resolves.toBe(true);
    expect(state.redis.eval).toHaveBeenCalledTimes(2);
  });

  it('treats an owner mismatch as a lost lock', async () => {
    const state = fixture('OK', 0);

    await expect(state.singleton.renew()).resolves.toBe(false);
    await expect(state.singleton.release()).resolves.toBe(false);
  });

  it('fails closed when renewal loses ownership or Redis cannot confirm ownership', async () => {
    const lost = fixture('OK', 0);
    await expect(lost.singleton.assertRenewed()).rejects.toBeInstanceOf(
      WorkerSingletonLeaseLostError,
    );

    const unavailable = fixture();
    unavailable.redis.eval.mockRejectedValueOnce(new Error('redis unavailable'));
    try {
      await unavailable.singleton.assertRenewed();
      throw new Error('Expected singleton renewal to fail closed');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(WorkerSingletonLeaseLostError);
      if (!(error instanceof WorkerSingletonLeaseLostError)) throw error;
      expect(error.cause).toBeInstanceOf(Error);
    }
  });
});
