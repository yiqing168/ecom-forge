import { describe, expect, it, vi } from 'vitest';

import { AdminOperationsQueryService } from './admin-operations-query.service.js';

describe('AdminOperationsQueryService health', () => {
  it('returns a structured not-ready response when PostgreSQL is unavailable', async () => {
    const database = {
      execute: vi.fn().mockRejectedValue(new Error('database unavailable')),
      select: vi.fn(),
      query: { storageRuntimeState: { findFirst: vi.fn() } },
    };
    const redis = {
      ping: vi.fn().mockResolvedValue('PONG'),
      get: vi.fn().mockResolvedValue('ready'),
    };
    const config = {
      resourceCursorSecret: 's14-health-cursor-secret-at-least-32-bytes',
      redisPrefix: 's14-health-test',
      admin: { sourceHashKeys: 'v1:s14-health-source-hash-secret-at-least-32-bytes' },
    };
    const service = new AdminOperationsQueryService(database as never, redis, config as never);

    await expect(service.health()).resolves.toMatchObject({
      status: 'not_ready',
      dependencies: {
        database: 'unavailable',
        redis: 'ok',
        queue_recovery: 'ready',
        storage_runtime: 'unknown',
      },
      workers: [],
      provider_summary: { active_channels: 0, poc_passed_models: 0 },
    });
    expect(database.select).not.toHaveBeenCalled();
    expect(database.query.storageRuntimeState.findFirst).not.toHaveBeenCalled();
  });
});
