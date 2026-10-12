import { Queue } from 'bullmq';

import { WORKER_RUNTIME_DEFAULTS } from '../config/runtime-defaults.js';

import {
  createBullMqConnection,
  parseQueuePayload,
  type QueueConnectionConfig,
  type QueueName,
  type QueuePayload,
} from '@ecom-forge/queue';

export interface QueuePublisher {
  add(queueName: QueueName, jobId: string, payload: QueuePayload, notBefore?: Date): Promise<void>;
  close(): Promise<void>;
}

export interface AgentQueueRetryConfig {
  agentProcessingRetryAttempts?: number;
  agentProcessingRetryBaseMs?: number;
}

export function queueJobOptions(
  payload: QueuePayload,
  config: AgentQueueRetryConfig = {},
): { attempts: number; backoff?: { type: 'exponential'; delay: number } } {
  if (payload.job_type !== 'agent.continue') return { attempts: 1 };
  const attempts =
    config.agentProcessingRetryAttempts ?? WORKER_RUNTIME_DEFAULTS.agentProcessingRetryAttempts;
  const delay =
    config.agentProcessingRetryBaseMs ?? WORKER_RUNTIME_DEFAULTS.agentProcessingRetryBaseMs;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 8) {
    throw new Error('AGENT_PROCESSING_RETRY_ATTEMPTS_INVALID');
  }
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 300_000) {
    throw new Error('AGENT_PROCESSING_RETRY_DELAY_INVALID');
  }
  return { attempts, backoff: { type: 'exponential', delay } };
}

const PUBLISHABLE_QUEUES = [
  'workflow',
  'task',
  'moderation',
  'agent',
  'asset',
  'evaluation',
  'provider-callback',
  'settlement',
] as const satisfies readonly QueueName[];

export class BullMqQueuePublisher implements QueuePublisher {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly agentRetryConfig: AgentQueueRetryConfig;

  constructor(config: QueueConnectionConfig & AgentQueueRetryConfig) {
    this.agentRetryConfig = config;
    for (const queueName of PUBLISHABLE_QUEUES) {
      this.queues.set(
        queueName,
        new Queue(queueName, {
          connection: createBullMqConnection(config.redisUrl),
          prefix: config.redisPrefix,
          defaultJobOptions: {
            attempts: 1,
            removeOnComplete: false,
            removeOnFail: false,
          },
        }),
      );
    }
  }

  async add(
    queueName: QueueName,
    jobId: string,
    input: QueuePayload,
    notBefore?: Date,
  ): Promise<void> {
    const queue = this.queues.get(queueName);
    if (!queue) throw new Error(`Queue ${queueName} is not active in S05`);
    const payload = parseQueuePayload(input);
    const retryOptions = queueJobOptions(payload, this.agentRetryConfig);
    await queue.add(payload.job_type, payload, {
      jobId,
      ...retryOptions,
      ...(notBefore ? { delay: Math.max(0, notBefore.getTime() - Date.now()) } : {}),
    });
  }

  async recoverAgentJob(
    jobId: string,
    payload: Extract<QueuePayload, { job_type: 'agent.continue' }>,
  ): Promise<'requeued' | 'pending' | 'exhausted'> {
    const queue = this.queues.get('agent');
    if (!queue) throw new Error('Agent queue is not active');
    const job = await queue.getJob(jobId);
    if (!job) {
      await this.add('agent', jobId, payload);
      return 'requeued';
    }
    const state = await job.getState();
    if (state === 'failed') return 'exhausted';
    if (state !== 'completed') return 'pending';
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) return 'exhausted';
    await job.retry('completed');
    return 'requeued';
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }
}
