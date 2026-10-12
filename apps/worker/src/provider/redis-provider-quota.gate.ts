import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import type { ProviderCallContext, QuotaGate, QuotaPermit } from '@ecom-forge/provider';

export interface RuntimeQuotaModel {
  id: string;
  provider: string;
  version: string;
  quota: {
    rpm: number;
    concurrency: number;
  };
}

export interface ProviderQuotaTelemetry {
  info(event: Record<string, unknown>): void;
}

const NOOP_QUOTA_TELEMETRY: ProviderQuotaTelemetry = { info: () => undefined };

const RESERVE_SCRIPT = `
local rpm = redis.call('INCR', KEYS[1])
if rpm == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
if rpm > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[4])
local active = redis.call('ZCARD', KEYS[2])
if active >= tonumber(ARGV[2]) then
  redis.call('DECR', KEYS[1])
  return -1
end
redis.call('ZADD', KEYS[2], ARGV[5], ARGV[6])
local longest = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')
local latestExpiry = tonumber(longest[2]) or tonumber(ARGV[5])
redis.call('PEXPIREAT', KEYS[2], latestExpiry + 60000)
return 1
`;

const RELEASE_SCRIPT = `
return redis.call('ZREM', KEYS[1], ARGV[1])
`;

export class ProviderQuotaUnavailableError extends Error {
  constructor(readonly code: 'PROVIDER_QUOTA_UNAVAILABLE' | 'PROVIDER_QUOTA_EXCEEDED') {
    super(code);
    this.name = 'ProviderQuotaUnavailableError';
  }
}

export class RedisProviderQuotaGate implements QuotaGate {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly now: () => Date = () => new Date(),
    private readonly telemetry: ProviderQuotaTelemetry = NOOP_QUOTA_TELEMETRY,
  ) {}

  async reserve(
    model: RuntimeQuotaModel,
    context: Pick<ProviderCallContext, 'deadlineAt'>,
  ): Promise<QuotaPermit> {
    const minute = Math.floor(this.now().getTime() / 60_000);
    const rpmKey = `${this.prefix}:provider-quota:${model.id}:rpm:${minute}`;
    const concurrencyKey = `${this.prefix}:provider-quota:${model.id}:concurrency`;
    const concurrencyToken = randomUUID();
    const nowMs = this.now().getTime();
    const deadlineMs = context.deadlineAt.getTime();
    if (!Number.isFinite(deadlineMs)) {
      throw new ProviderQuotaUnavailableError('PROVIDER_QUOTA_UNAVAILABLE');
    }
    const leaseExpiresAtMs = Math.max(nowMs, deadlineMs) + 60_000;
    try {
      const result = await this.redis.eval(
        RESERVE_SCRIPT,
        2,
        rpmKey,
        concurrencyKey,
        model.quota.rpm,
        model.quota.concurrency,
        65_000,
        nowMs,
        leaseExpiresAtMs,
        concurrencyToken,
      );
      if (result !== 1) {
        this.telemetry.info({
          event: 'provider_quota_rejected',
          metric: 'provider_quota_reject_total',
          provider: model.provider,
          model_version: model.version,
          reason_code: result === 0 ? 'rpm' : 'concurrency',
        });
        throw new ProviderQuotaUnavailableError('PROVIDER_QUOTA_EXCEEDED');
      }
      return { concurrencyKey, concurrencyToken };
    } catch (error) {
      if (error instanceof ProviderQuotaUnavailableError) throw error;
      this.telemetry.info({
        event: 'provider_quota_unavailable',
        metric: 'provider_quota_reject_total',
        provider: model.provider,
        model_version: model.version,
        reason_code: 'control_plane_unavailable',
      });
      throw new ProviderQuotaUnavailableError('PROVIDER_QUOTA_UNAVAILABLE');
    }
  }

  async release(_model: RuntimeQuotaModel, permit: QuotaPermit | void): Promise<void> {
    if (!permit?.concurrencyKey || !permit.concurrencyToken) return;
    try {
      await this.redis.eval(RELEASE_SCRIPT, 1, permit.concurrencyKey, permit.concurrencyToken);
    } catch {
      throw new ProviderQuotaUnavailableError('PROVIDER_QUOTA_UNAVAILABLE');
    }
  }
}
