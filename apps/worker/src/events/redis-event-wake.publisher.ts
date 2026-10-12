import type { Redis } from 'ioredis';

import {
  encodeEventWake,
  eventWakeChannel,
  type EventWake,
  type EventWakePublisher,
} from '@ecom-forge/shared';

export class RedisEventWakePublisher implements EventWakePublisher {
  private readonly channel: string;

  constructor(
    private readonly redis: Redis,
    redisPrefix: string,
  ) {
    this.channel = eventWakeChannel(redisPrefix);
  }

  async publish(wake: EventWake): Promise<void> {
    try {
      await this.redis.publish(this.channel, encodeEventWake(wake));
      console.log(
        JSON.stringify({
          event: 'sse_wake_published',
          metric: 'sse_wake_publish_total',
          scope_type: wake.scope_type,
          event_seq: wake.event_seq,
        }),
      );
    } catch {
      console.warn(
        JSON.stringify({
          event: 'sse_wake_publish_failed',
          error_code: 'REDIS_UNAVAILABLE',
          metric: 'sse_wake_publish_failure_total',
        }),
      );
    }
  }
}
