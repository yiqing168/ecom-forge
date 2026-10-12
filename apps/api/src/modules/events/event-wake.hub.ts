import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import {
  encodeEventWake,
  eventWakeChannel,
  parseEventWake,
  type EventWake,
  type EventWakePublisher,
} from '@ecom-forge/shared';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { REDIS_PUBSUB_CLIENT, type RedisPubSubClient } from '../../shared/redis/redis.module.js';

type WakeListener = (wake: EventWake) => void;

@Injectable()
export class EventWakeHub implements EventWakePublisher, OnApplicationShutdown {
  private readonly logger = new Logger(EventWakeHub.name);
  private readonly channel: string;
  private readonly listeners = new Map<string, Set<WakeListener>>();
  private subscribePromise: Promise<void> | undefined;
  private subscribed = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    @Inject(REDIS_PUBSUB_CLIENT) private readonly redis: RedisPubSubClient,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.channel = eventWakeChannel(config.redisPrefix);
  }

  async publish(wake: EventWake): Promise<void> {
    this.notify(wake);
    try {
      await this.redis.publish(this.channel, encodeEventWake(wake));
      this.logger.debug({
        event: 'sse_wake_published',
        metric: 'sse_wake_publish_total',
        scope_type: wake.scope_type,
        event_seq: wake.event_seq,
      });
    } catch {
      this.logger.warn({
        event: 'sse_wake_publish_failed',
        error_code: 'REDIS_UNAVAILABLE',
        metric: 'sse_wake_publish_failure_total',
      });
    }
  }

  listen(scopeId: string, listener: WakeListener): Promise<() => void> {
    const scopeListeners = this.listeners.get(scopeId) ?? new Set<WakeListener>();
    scopeListeners.add(listener);
    this.listeners.set(scopeId, scopeListeners);
    void this.ensureSubscribed();
    let removed = false;
    return Promise.resolve(() => {
      if (removed) return;
      removed = true;
      const current = this.listeners.get(scopeId);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(scopeId);
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.subscribed) await this.redis.unsubscribe(this.channel).catch(() => undefined);
    this.listeners.clear();
  }

  private async ensureSubscribed(): Promise<void> {
    if (this.subscribed || this.stopped) return;
    this.subscribePromise ??= this.redis
      .subscribe(this.channel, (message) => this.receive(message))
      .then(() => {
        this.subscribed = true;
      })
      .catch(() => {
        this.logger.warn({
          event: 'sse_wake_subscribe_failed',
          error_code: 'REDIS_UNAVAILABLE',
          metric: 'sse_wake_subscribe_failure_total',
        });
        this.scheduleRetry();
      })
      .finally(() => {
        this.subscribePromise = undefined;
      });
    await this.subscribePromise;
  }

  private receive(message: string): void {
    try {
      const wake = parseEventWake(message);
      this.logger.debug({
        event: 'sse_wake_received',
        metric: 'sse_wake_receive_total',
        scope_type: wake.scope_type,
        event_seq: wake.event_seq,
      });
      this.notify(wake);
    } catch {
      this.logger.warn({
        event: 'sse_wake_invalid',
        error_code: 'WAKE_PAYLOAD_INVALID',
        metric: 'sse_wake_invalid_total',
      });
    }
  }

  private notify(wake: EventWake): void {
    for (const listener of this.listeners.get(wake.scope_id) ?? []) listener(wake);
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped || this.listeners.size === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.ensureSubscribed();
    }, 5_000);
    this.retryTimer.unref();
  }
}
