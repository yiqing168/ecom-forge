import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';

export const REDIS_EVAL_CLIENT = Symbol('REDIS_EVAL_CLIENT');
export const REDIS_CONTROL_CLIENT = Symbol('REDIS_CONTROL_CLIENT');
export const REDIS_PUBSUB_CLIENT = Symbol('REDIS_PUBSUB_CLIENT');

export interface RedisEvalClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface RedisControlClient {
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
}

export interface RedisPubSubClient {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
}

@Injectable()
class RedisResource
  implements RedisEvalClient, RedisControlClient, RedisPubSubClient, OnApplicationShutdown
{
  private readonly client: RedisClientType;
  private readonly subscriber: RedisClientType;
  private connectPromise: Promise<unknown> | undefined;
  private subscriberConnectPromise: Promise<unknown> | undefined;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = createClient({ url: config.redisUrl });
    this.subscriber = this.client.duplicate();
    this.client.on('error', () => {
      // Authentication services convert Redis failures to fail-closed domain errors.
    });
    this.subscriber.on('error', () => {
      // SSE falls back to bounded database polling when pub/sub is unavailable.
    });
  }

  async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    await this.ensureConnected();
    return this.client.eval(script, options);
  }

  async ping(): Promise<string> {
    await this.ensureConnected();
    return this.client.ping();
  }

  async get(key: string): Promise<string | null> {
    await this.ensureConnected();
    return this.client.get(key);
  }

  async publish(channel: string, message: string): Promise<number> {
    await this.ensureConnected();
    return this.client.publish(channel, message);
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<void> {
    await this.ensureSubscriberConnected();
    await this.subscriber.subscribe(channel, listener);
  }

  async unsubscribe(channel: string): Promise<void> {
    if (!this.subscriber.isOpen) return;
    await this.subscriber.unsubscribe(channel);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.subscriber.isOpen) {
      await this.subscriber.close();
    }
    if (this.client.isOpen) {
      await this.client.close();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isReady) return;
    this.connectPromise ??= this.client.connect().finally(() => {
      this.connectPromise = undefined;
    });
    await this.connectPromise;
  }

  private async ensureSubscriberConnected(): Promise<void> {
    if (this.subscriber.isReady) return;
    this.subscriberConnectPromise ??= this.subscriber.connect().finally(() => {
      this.subscriberConnectPromise = undefined;
    });
    await this.subscriberConnectPromise;
  }
}

@Global()
@Module({
  providers: [
    RedisResource,
    {
      provide: REDIS_EVAL_CLIENT,
      inject: [RedisResource],
      useFactory: (resource: RedisResource): RedisEvalClient => resource,
    },
    {
      provide: REDIS_CONTROL_CLIENT,
      inject: [RedisResource],
      useFactory: (resource: RedisResource): RedisControlClient => resource,
    },
    {
      provide: REDIS_PUBSUB_CLIENT,
      inject: [RedisResource],
      useFactory: (resource: RedisResource): RedisPubSubClient => resource,
    },
  ],
  exports: [REDIS_EVAL_CLIENT, REDIS_CONTROL_CLIENT, REDIS_PUBSUB_CLIENT],
})
export class RedisModule {}
