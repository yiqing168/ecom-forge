import crypto from 'node:crypto';

import {
  AuthControlPlaneUnavailableError,
  AuthExclusiveLockBusyError,
  type RateLimitResult,
  type RateLimitRule,
  type VerificationRateLimiter,
} from './verification-rate-limiter.js';

const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {count, ttl}
`;

const ACQUIRE_LOCK_SCRIPT = `
local acquired = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if acquired then return 1 end
return 0
`;

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export interface EvalClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

function parseResult(value: unknown): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'number' ||
    typeof value[1] !== 'number'
  ) {
    throw new AuthControlPlaneUnavailableError();
  }
  return [value[0], value[1]];
}

export class RedisVerificationRateLimiter implements VerificationRateLimiter {
  constructor(private readonly client: EvalClient) {}

  async consume(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    if (rule.max < 1 || rule.windowSeconds < 1) {
      throw new RangeError('Rate limit values must be positive');
    }
    try {
      const [count, ttl] = parseResult(
        await this.client.eval(CONSUME_SCRIPT, {
          keys: [key],
          arguments: [String(rule.windowSeconds)],
        }),
      );
      return {
        allowed: count <= rule.max,
        remaining: Math.max(0, rule.max - count),
        retryAfterSeconds: Math.max(0, ttl),
      };
    } catch (error) {
      if (error instanceof RangeError) {
        throw error;
      }
      throw new AuthControlPlaneUnavailableError();
    }
  }

  async withExclusiveLock<T>(
    key: string,
    ttlSeconds: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (ttlSeconds < 1) throw new RangeError('Lock TTL must be positive');
    const owner = crypto.randomUUID();
    let acquired = false;
    try {
      let result: unknown;
      try {
        result = await this.client.eval(ACQUIRE_LOCK_SCRIPT, {
          keys: [key],
          arguments: [owner, String(ttlSeconds)],
        });
      } catch {
        throw new AuthControlPlaneUnavailableError();
      }
      if (result === 0) throw new AuthExclusiveLockBusyError();
      if (result !== 1) throw new AuthControlPlaneUnavailableError();
      acquired = true;
      return await operation();
    } finally {
      if (acquired) {
        try {
          await this.client.eval(RELEASE_LOCK_SCRIPT, {
            keys: [key],
            arguments: [owner],
          });
        } catch {
          // A lease expiry bounds the lock when Redis cannot release it.
        }
      }
    }
  }
}
