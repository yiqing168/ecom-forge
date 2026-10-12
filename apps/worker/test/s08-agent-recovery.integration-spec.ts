import { randomUUID } from 'node:crypto';

import { Job, Queue, Worker } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { createBullMqConnection } from '@ecom-forge/queue';

import { BullMqQueuePublisher } from '../src/queue/queue-publisher.js';
import { testRedisPrefix, testRedisUrl } from './s05-integration.fixture.js';

function agentPayload() {
  return {
    schema_version: 1 as const,
    trace_id: randomUUID(),
    job_type: 'agent.continue' as const,
    session_id: randomUUID(),
    turn_id: randomUUID(),
    user_message_id: randomUUID(),
    continuation_no: 1,
    turn_revision: 1,
  };
}

describe('agent continuation recovery', () => {
  it('atomically requeues once when two publishers observe the same completed job', async () => {
    const prefix = `${testRedisPrefix}:agent-recovery:${randomUUID()}`;
    const config = { redisUrl: testRedisUrl, redisPrefix: prefix };
    const publishers = [new BullMqQueuePublisher(config), new BullMqQueuePublisher(config)];
    const queue = new Queue('agent', {
      connection: createBullMqConnection(testRedisUrl),
      prefix,
    });
    let runs = 0;
    const worker = new Worker(
      'agent',
      () => {
        runs += 1;
        return Promise.resolve();
      },
      { connection: createBullMqConnection(testRedisUrl), prefix },
    );
    const id = randomUUID();
    const payload = agentPayload();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The real instance is supplied via .call below.
    const originalGetState = Job.prototype.getState;
    let restoreState: (() => void) | undefined;
    try {
      await publishers[0]!.add('agent', id, payload);
      await vi.waitFor(async () => expect(await queue.getJobState(id)).toBe('completed'), {
        timeout: 10_000,
      });
      await worker.pause();
      let observations = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Synchronize only the reads; retry still executes the real Redis Lua transition.
      const stateSpy = vi.spyOn(Job.prototype, 'getState');
      restoreState = () => stateSpy.mockRestore();
      stateSpy.mockImplementation(async function (this: Job) {
        const state = await originalGetState.call(this);
        if (this.id === id && state === 'completed') {
          observations += 1;
          if (observations === 2) release();
          await barrier;
        }
        return state;
      });
      const results = await Promise.allSettled(
        publishers.map((publisher) => publisher.recoverAgentJob(id, payload)),
      );
      stateSpy.mockRestore();
      expect(observations).toBe(2);
      expect(results.filter((result) => result.status === 'fulfilled')).toEqual([
        { status: 'fulfilled', value: 'requeued' },
      ]);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await queue.getJobState(id)).toBe('waiting');
      expect((await queue.getJob(id))?.attemptsMade).toBe(1);
      worker.resume();
      await vi.waitFor(async () => expect(await queue.getJobState(id)).toBe('completed'), {
        timeout: 10_000,
      });
      expect((await queue.getJob(id))?.attemptsMade).toBe(2);
      expect(runs).toBe(2);
    } finally {
      restoreState?.();
      await worker.close(true);
      await queue.obliterate({ force: true });
      await queue.close();
      for (const publisher of publishers) await publisher.close();
    }
  });

  it('redrives a completed job once and leaves live jobs alone', async () => {
    const prefix = `${testRedisPrefix}:agent-recovery:${randomUUID()}`;
    const config = { redisUrl: testRedisUrl, redisPrefix: prefix };
    const publisher = new BullMqQueuePublisher(config);
    const queue = new Queue('agent', {
      connection: createBullMqConnection(testRedisUrl),
      prefix,
    });
    let runs = 0;
    const worker = new Worker(
      'agent',
      () => {
        runs += 1;
        return Promise.resolve();
      },
      { connection: createBullMqConnection(testRedisUrl), prefix },
    );
    const id = randomUUID();
    const payload = agentPayload();
    try {
      await publisher.add('agent', id, payload);
      await vi.waitFor(async () => expect(await queue.getJobState(id)).toBe('completed'), {
        timeout: 10_000,
      });
      expect(runs).toBe(1);
      expect(await publisher.recoverAgentJob(id, payload)).toBe('requeued');
      await vi.waitFor(() => expect(runs).toBe(2), { timeout: 10_000 });
      await vi.waitFor(async () => expect(await queue.getJobState(id)).toBe('completed'), {
        timeout: 10_000,
      });
      await worker.pause();
      expect(await publisher.recoverAgentJob(id, payload)).toBe('requeued');
      expect(await publisher.recoverAgentJob(id, payload)).toBe('pending');
      expect(runs).toBe(2);
      expect((await queue.getJob(id))?.attemptsMade).toBe(2);
      worker.resume();
      await vi.waitFor(async () => expect(await queue.getJobState(id)).toBe('completed'), {
        timeout: 10_000,
      });
      expect(await publisher.recoverAgentJob(id, payload)).toBe('requeued');
      await vi.waitFor(async () => expect((await queue.getJob(id))?.attemptsMade).toBe(4), {
        timeout: 10_000,
      });
      expect(await publisher.recoverAgentJob(id, payload)).toBe('exhausted');
      expect(runs).toBe(4);
      await worker.pause();
      await (await queue.getJob(id))?.remove();
      expect(await publisher.recoverAgentJob(id, payload)).toBe('requeued');
      expect(await queue.getJobState(id)).toBe('waiting');
    } finally {
      await worker.close(true);
      await queue.obliterate({ force: true });
      await queue.close();
      await publisher.close();
    }
  });

  it('does not reset the bounded retry budget for a failed job', async () => {
    const prefix = `${testRedisPrefix}:agent-recovery:${randomUUID()}`;
    const config = { redisUrl: testRedisUrl, redisPrefix: prefix };
    const publisher = new BullMqQueuePublisher({ ...config, agentProcessingRetryAttempts: 1 });
    const queue = new Queue('agent', {
      connection: createBullMqConnection(testRedisUrl),
      prefix,
    });
    let runs = 0;
    const worker = new Worker(
      'agent',
      () => {
        runs += 1;
        return Promise.reject(new Error('test processing failure'));
      },
      { connection: createBullMqConnection(testRedisUrl), prefix },
    );
    worker.on('error', () => {});
    const id = randomUUID();
    const payload = agentPayload();
    try {
      await publisher.add('agent', id, payload);
      await vi.waitFor(async () => expect(await queue.getJobState(id)).toBe('failed'), {
        timeout: 10_000,
      });
      expect(await publisher.recoverAgentJob(id, payload)).toBe('exhausted');
      expect(await queue.getJobState(id)).toBe('failed');
      expect(runs).toBe(1);
    } finally {
      await worker.close(true);
      await queue.obliterate({ force: true });
      await queue.close();
      await publisher.close();
    }
  });
});
