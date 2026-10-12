import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { QUEUE_NAMES, type QueueName } from './constants.js';

export interface QueueConnectionConfig {
  redisUrl: string;
  redisPrefix: string;
}

function assertQueueName(queueName: string): asserts queueName is QueueName {
  if (!QUEUE_NAMES.includes(queueName as QueueName)) {
    throw new Error(`Unsupported queue name: ${queueName}`);
  }
}

export function createBullMqConnection(redisUrl: string): Redis {
  const parsed = new URL(redisUrl);
  if (!['redis:', 'rediss:'].includes(parsed.protocol)) {
    throw new Error('Redis URL must use redis:// or rediss://');
  }
  return new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export function createQueue(queueName: QueueName, config: QueueConnectionConfig): Queue {
  assertQueueName(queueName);
  return new Queue(queueName, {
    connection: createBullMqConnection(config.redisUrl),
    prefix: config.redisPrefix,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
}
