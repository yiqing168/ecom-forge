import { describe, expect, it, vi } from 'vitest';

import { builtinSkillCatalogKey, queueRecoverySentinelKey } from '@ecom-forge/queue';
import { getBuiltinSkillCatalog } from '@ecom-forge/skills';

import { HealthReadinessService } from './health-readiness.service.js';

function fixture(sentinel: string | null = 'ready') {
  const database = { execute: vi.fn().mockResolvedValue([]) };
  const redis = {
    ping: vi.fn().mockResolvedValue('PONG'),
    get: vi.fn(async (key: string) =>
      key === queueRecoverySentinelKey('ecom-forge-test')
        ? sentinel
        : (await getBuiltinSkillCatalog()).catalogVersion,
    ),
  };
  const service = new HealthReadinessService(database as never, redis, {
    redisPrefix: 'ecom-forge-test',
  } as never);
  return { service, database, redis };
}

describe('HealthReadinessService', () => {
  it('is ready only when database, Redis, and recovery sentinel are ready', async () => {
    await expect(fixture().service.isReady()).resolves.toBe(true);
  });

  it('fails closed when the recovery sentinel is missing', async () => {
    await expect(fixture(null).service.isReady()).resolves.toBe(false);
  });

  it('fails closed without leaking dependency failures', async () => {
    const state = fixture();
    state.database.execute.mockRejectedValue(new Error('postgresql://secret-host'));

    await expect(state.service.isReady()).resolves.toBe(false);
  });

  it('fails closed when the Worker has a different builtin Skill catalog', async () => {
    const state = fixture();
    state.redis.get.mockImplementation((key: string) =>
      Promise.resolve(
        key === queueRecoverySentinelKey('ecom-forge-test') ? 'ready' : 'different-catalog-version',
      ),
    );

    await expect(state.service.isReady()).resolves.toBe(false);
    expect(state.redis.get).toHaveBeenCalledWith(builtinSkillCatalogKey('ecom-forge-test'));
  });
});
