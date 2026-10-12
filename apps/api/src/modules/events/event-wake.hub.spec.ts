import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../config/app-config.js';
import { EventWakeHub } from './event-wake.hub.js';

const wake = {
  schema_version: 1 as const,
  scope_type: 'workflow_run' as const,
  scope_id: '11111111-1111-4111-8111-111111111111',
  event_seq: 1,
};

describe('EventWakeHub', () => {
  it('does not block database fallback while the Redis subscription is connecting', async () => {
    const redis = {
      publish: vi.fn().mockResolvedValue(0),
      subscribe: vi.fn().mockReturnValue(new Promise<void>(() => undefined)),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    };
    const hub = new EventWakeHub(redis, { redisPrefix: 's06-test' } as AppConfig);
    const listener = vi.fn();

    const remove = await hub.listen(wake.scope_id, listener);
    await hub.publish(wake);

    expect(listener).toHaveBeenCalledWith(wake);
    remove();
    await hub.onApplicationShutdown();
  });
});
