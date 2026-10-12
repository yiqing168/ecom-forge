import type { RedisEvalClient } from '../../shared/redis/redis.module.js';
import { AdminAuthError } from './admin-errors.js';

const LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
if count > tonumber(ARGV[2]) then
  return 0
end
return 1
`;

export class AdminAuthRateLimiter {
  constructor(
    private readonly redis: RedisEvalClient,
    private readonly prefix: string,
  ) {}

  async assertAllowed(
    scope: string,
    digest: string,
    limit: number,
    windowSeconds = 600,
  ): Promise<void> {
    try {
      const result = await this.redis.eval(LIMIT_SCRIPT, {
        keys: [`${this.prefix}:admin-auth:${scope}:${digest}`],
        arguments: [String(windowSeconds), String(limit)],
      });
      if (Number(result) !== 1) throw new AdminAuthError('ADMIN_AUTH_RATE_LIMITED', 429);
    } catch (error) {
      if (error instanceof AdminAuthError) throw error;
      throw new AdminAuthError('ADMIN_AUTH_UNAVAILABLE', 503);
    }
  }
}
