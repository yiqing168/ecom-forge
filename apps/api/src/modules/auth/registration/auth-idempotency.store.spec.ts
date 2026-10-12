import { RedisAuthIdempotencyStore } from './auth-idempotency.store.js';
import { AuthControlPlaneUnavailableError } from '../rate-limit/verification-rate-limiter.js';

const replay = {
  claimId: '48dc4bd0-c8cc-40e2-917a-f8dd5c6a33ad',
  ticketHash: 'ticket-hash',
  ticketNonce: 'ticket-nonce',
  ticketVersion: 2,
};

describe('RedisAuthIdempotencyStore', () => {
  it('acquires a new lease and transitions it to a completed result', async () => {
    const evalMock = vi
      .fn()
      .mockImplementationOnce((_script: string, options: { arguments: string[] }) =>
        Promise.resolve(options.arguments[0]),
      )
      .mockResolvedValueOnce(1);
    const store = new RedisAuthIdempotencyStore({ eval: evalMock });

    const lease = await store.begin('auth:idempotency:key', 'request-hash', 600);
    expect(lease.kind).toBe('acquired');
    if (lease.kind !== 'acquired') throw new Error('expected lease');
    await expect(
      store.complete('auth:idempotency:key', 'request-hash', lease.owner, replay, 600),
    ).resolves.toBeUndefined();
    expect(evalMock).toHaveBeenCalledTimes(2);
  });

  it('returns conflict for the same key with a different request payload', async () => {
    const store = new RedisAuthIdempotencyStore({
      eval: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify({ status: 'completed', requestHash: 'other-request', result: replay }),
        ),
    });

    await expect(store.begin('auth:idempotency:key', 'request-hash', 600)).resolves.toEqual({
      kind: 'conflict',
    });
  });

  it('replays a completed result without executing mail work', async () => {
    const store = new RedisAuthIdempotencyStore({
      eval: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify({ status: 'completed', requestHash: 'request-hash', result: replay }),
        ),
    });

    await expect(store.begin('auth:idempotency:key', 'request-hash', 600)).resolves.toEqual({
      kind: 'completed',
      result: replay,
    });
  });

  it('fails closed when Redis contains a malformed completed result', async () => {
    const store = new RedisAuthIdempotencyStore({
      eval: vi.fn().mockResolvedValue(
        JSON.stringify({
          status: 'completed',
          requestHash: 'request-hash',
          result: { claimId: 'claim-only' },
        }),
      ),
    });

    await expect(store.begin('auth:idempotency:key', 'request-hash', 600)).rejects.toBeInstanceOf(
      AuthControlPlaneUnavailableError,
    );
  });
});
