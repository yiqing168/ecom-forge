import { randomUUID } from 'node:crypto';

import { Queue } from 'bullmq';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { eq, queueDispatchIntents, sql, taskAttempts, tasks } from '@ecom-forge/db';
import {
  createBullMqConnection,
  QueueIntentRepository,
  queueRecoverySentinelKey,
  type QueuePayload,
} from '@ecom-forge/queue';

import type { WorkerConfig } from '../src/config/worker-config.js';
import { OutboxRepository } from '../src/database/outbox.repository.js';
import { TaskAttemptRepository } from '../src/database/attempt.repository.js';
import { ActiveWorkTracker, WorkerWriteFence } from '../src/lifecycle/processing-fence.js';
import { TestProcessorWorkers } from '../src/processors/test-processors.js';
import { QueueDispatcher } from '../src/queue/dispatcher.js';
import { BullMqQueuePublisher } from '../src/queue/queue-publisher.js';
import { QueueReconciler } from '../src/queue/reconciler.js';
import {
  cleanupRedisPrefix,
  cleanupTrackedResources,
  closeIntegrationInfrastructure,
  createWorkflowFixture,
  databaseResource,
  integrationWorkerConfig,
  redis,
  testRedisPrefix,
  testRedisUrl,
  track,
} from './s05-integration.fixture.js';

const config: WorkerConfig = integrationWorkerConfig;

function workflowPayload(userId: string, workflowRunId: string): QueuePayload {
  return {
    schema_version: 1,
    trace_id: randomUUID(),
    job_type: 'workflow.advance',
    workflow_run_id: workflowRunId,
    user_id: userId,
  };
}

function taskPayload(userId: string, workflowRunId: string, taskId: string): QueuePayload {
  return {
    schema_version: 1,
    trace_id: randomUUID(),
    job_type: 'task.execute',
    workflow_run_id: workflowRunId,
    task_id: taskId,
    user_id: userId,
  };
}

async function createIntent(payload: QueuePayload, aggregateId: string) {
  const repository = new QueueIntentRepository(databaseResource.db);
  const queueName = payload.job_type === 'task.execute' ? 'task' : 'workflow';
  const intent = await repository.create({
    queueName,
    jobId: aggregateId,
    aggregateType: payload.job_type === 'task.execute' ? 'task' : 'workflow_run',
    aggregateId,
    payloadVersion: 1,
    payload,
  });
  track('intents', intent.id);
  return { intent, repository };
}

async function markIntentDispatched(intentId: string, repository: QueueIntentRepository) {
  const owner = randomUUID();
  const now = new Date();
  const claimed = await repository.claimPending({ owner, now, leaseMs: 10_000, limit: 1 });
  expect(claimed.map((item) => item.id)).toContain(intentId);
  await expect(
    repository.markDispatched({ id: intentId, owner, now: new Date(now.getTime() + 1) }),
  ).resolves.toBe(true);
}

function queueFor(name: 'workflow' | 'task') {
  return new Queue(name, {
    connection: createBullMqConnection(testRedisUrl),
    prefix: testRedisPrefix,
  });
}

afterEach(async () => {
  await cleanupTrackedResources();
});

beforeAll(async () => {
  // Files run sequentially against one disposable _test database, and an interrupted run can
  // leave queue intents stuck in pending/dispatching. QueueDispatcher.dispatchOnce legitimately
  // sweeps every claimable intent it sees, so the ownership and poison assertions below would
  // count those leftovers. Move non-terminal intents to a terminal state once before the suite
  // starts; updating instead of deleting avoids tripping foreign keys from validation runs.
  await databaseResource.db
    .update(queueDispatchIntents)
    .set({ status: 'cancelled' })
    .where(sql`${queueDispatchIntents.status} in ('pending', 'dispatching')`);
});

afterAll(async () => {
  await closeIntegrationInfrastructure();
});

describe('S05 worker integration', () => {
  it('allocates contiguous event_seq values under concurrent writers', async () => {
    const scopeId = randomUUID();
    const repository = new OutboxRepository(databaseResource.db);

    const events = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        repository.append({
          scopeType: 'workflow_run',
          scopeId,
          eventType: 'test.concurrent',
          payload: { index },
        }),
      ),
    );
    for (const event of events) track('events', event.id);

    expect(events.map((event) => event.eventSeq).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('allocates one attempt per task state under concurrent workers', async () => {
    const fixture = await createWorkflowFixture();
    if (!fixture.task) throw new Error('Task fixture is required');
    const repository = new TaskAttemptRepository(databaseResource.db);

    const firstWave = await Promise.all(
      Array.from({ length: 10 }, () =>
        repository.allocate({ taskId: fixture.task.id, provider: 'fake' }),
      ),
    );
    const firstIds = new Set(firstWave.map((item) => item.attempt.id));
    expect(firstIds.size).toBe(1);
    const firstAttempt = firstWave[0]?.attempt;
    if (!firstAttempt) throw new Error('First attempt was not allocated');
    track('attempts', firstAttempt.id);
    await repository.advance({
      attemptId: firstAttempt.id,
      expectedStatus: 'created',
      expectedDispatchState: 'not_dispatched',
      status: 'failed',
      dispatchState: 'not_dispatched',
      now: new Date(),
    });

    const secondWave = await Promise.all(
      Array.from({ length: 10 }, () =>
        repository.allocate({ taskId: fixture.task.id, provider: 'fake' }),
      ),
    );
    const secondIds = new Set(secondWave.map((item) => item.attempt.id));
    expect(secondIds.size).toBe(1);
    const secondAttempt = secondWave[0]?.attempt;
    if (!secondAttempt) throw new Error('Second attempt was not allocated');
    track('attempts', secondAttempt.id);
    expect(secondAttempt.attemptNo).toBe(2);
  });

  it('recovers a dispatching attempt as outcome_unknown without allocating a replacement', async () => {
    const fixture = await createWorkflowFixture({ taskStatus: 'running' });
    if (!fixture.task) throw new Error('Task fixture is required');
    const repository = new TaskAttemptRepository(databaseResource.db);
    const allocation = await repository.allocate({ taskId: fixture.task.id, provider: 'fake' });
    track('attempts', allocation.attempt.id);

    await repository.advance({
      attemptId: allocation.attempt.id,
      expectedStatus: 'created',
      expectedDispatchState: 'not_dispatched',
      status: 'dispatching',
      dispatchState: 'not_dispatched',
      now: new Date(),
    });
    await repository.advance({
      attemptId: allocation.attempt.id,
      expectedStatus: 'dispatching',
      expectedDispatchState: 'not_dispatched',
      status: 'outcome_unknown',
      dispatchState: 'outcome_unknown',
      now: new Date(),
    });

    const replay = await repository.allocate({ taskId: fixture.task.id, provider: 'fake' });
    expect(replay).toMatchObject({ reused: true, attempt: { id: allocation.attempt.id } });
    const attempts = await databaseResource.db.query.taskAttempts.findMany({
      where: eq(taskAttempts.taskId, fixture.task.id),
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: 'outcome_unknown',
      dispatchState: 'outcome_unknown',
    });
  });

  it('keeps dispatcher ownership single and rejects stale owner writes', async () => {
    const fixture = await createWorkflowFixture({ withTask: false });
    const { intent, repository } = await createIntent(
      workflowPayload(fixture.user.id, fixture.workflow.id),
      fixture.workflow.id,
    );
    const firstPublisher = { add: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
    const secondPublisher = { add: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
    const summaries = await Promise.all([
      new QueueDispatcher(repository, firstPublisher, config).dispatchOnce(),
      new QueueDispatcher(repository, secondPublisher, config).dispatchOnce(),
    ]);

    expect(summaries.reduce((total, summary) => total + summary.dispatched, 0)).toBe(1);
    expect(firstPublisher.add.mock.calls.length + secondPublisher.add.mock.calls.length).toBe(1);

    const secondFixture = await createWorkflowFixture({ withTask: false });
    const second = await createIntent(
      workflowPayload(secondFixture.user.id, secondFixture.workflow.id),
      secondFixture.workflow.id,
    );
    const owner = randomUUID();
    const now = new Date();
    await second.repository.claimPending({ owner, now, leaseMs: 10_000, limit: 1 });
    await expect(
      second.repository.markDispatched({
        id: second.intent.id,
        owner: randomUUID(),
        now: new Date(now.getTime() + 1),
      }),
    ).resolves.toBe(false);
    await expect(
      second.repository.markDispatched({
        id: second.intent.id,
        owner,
        now: new Date(now.getTime() + 1),
      }),
    ).resolves.toBe(true);

    const stored = await databaseResource.db.query.queueDispatchIntents.findFirst({
      where: eq(queueDispatchIntents.id, intent.id),
    });
    expect(stored?.status).toBe('dispatched');
  });

  it('cancels poison intents without publishing them', async () => {
    const fixture = await createWorkflowFixture({ withTask: false });
    const [intent] = await databaseResource.db
      .insert(queueDispatchIntents)
      .values({
        queueName: 'workflow',
        jobId: fixture.workflow.id,
        aggregateType: 'workflow_run',
        aggregateId: fixture.workflow.id,
        payloadVersion: 1,
        payload: { schema_version: 999, job_type: 'workflow.advance' },
        nextAttemptAt: new Date(),
      })
      .returning();
    if (!intent) throw new Error('Poison intent was not created');
    track('intents', intent.id);
    const publisher = { add: vi.fn().mockResolvedValue(undefined), close: vi.fn() };

    const summary = await new QueueDispatcher(
      new QueueIntentRepository(databaseResource.db),
      publisher,
      config,
    ).dispatchOnce();

    expect(summary.poisonCancelled).toBe(1);
    expect(publisher.add).not.toHaveBeenCalled();
    const stored = await databaseResource.db.query.queueDispatchIntents.findFirst({
      where: eq(queueDispatchIntents.id, intent.id),
    });
    expect(stored).toMatchObject({
      status: 'cancelled',
      lastErrorCode: 'QUEUE_SCHEMA_VERSION_UNSUPPORTED',
    });
  });

  it('keeps one BullMQ job for repeated adds with the same stable jobId', async () => {
    const fixture = await createWorkflowFixture({ withTask: false });
    const payload = workflowPayload(fixture.user.id, fixture.workflow.id);
    const publisher = new BullMqQueuePublisher(config);
    const queue = queueFor('workflow');
    try {
      await publisher.add('workflow', fixture.workflow.id, payload);
      await publisher.add('workflow', fixture.workflow.id, payload);

      const jobs = await queue.getJobs(['waiting']);
      expect(jobs.filter((job) => job.id === fixture.workflow.id)).toHaveLength(1);
    } finally {
      await queue.close();
      await publisher.close();
    }
  });

  it('resumes a task that was already running when the previous worker crashed', async () => {
    const fixture = await createWorkflowFixture({
      workflowStatus: 'running',
      taskStatus: 'running',
    });
    if (!fixture.task) throw new Error('Task fixture is required');

    const processors = new TestProcessorWorkers(
      databaseResource.db,
      config,
      new ActiveWorkTracker(),
      new WorkerWriteFence(),
    );
    const queue = queueFor('task');
    const taskId = fixture.task.id;
    try {
      await queue.add('task.execute', taskPayload(fixture.user.id, fixture.workflow.id, taskId), {
        jobId: taskId,
      });

      await vi.waitFor(
        async () => {
          const task = await databaseResource.db.query.tasks.findFirst({
            where: eq(tasks.id, taskId),
          });
          expect(task?.status).toBe('succeeded');
        },
        { timeout: 10_000, interval: 100 },
      );

      const attempt = await databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.taskId, taskId),
      });
      if (!attempt) throw new Error('Recovered task did not allocate an attempt');
      track('attempts', attempt.id);
      expect(attempt.status).toBe('succeeded');
    } finally {
      await processors.close(true);
      await queue.close();
    }
  });

  it('worker-recovery rebuilds Redis loss and survives a crash before the sentinel', async () => {
    const active = await createWorkflowFixture({ withTask: false });
    const terminal = await createWorkflowFixture({ workflowStatus: 'succeeded', withTask: false });
    const activeIntent = await createIntent(
      workflowPayload(active.user.id, active.workflow.id),
      active.workflow.id,
    );
    await markIntentDispatched(activeIntent.intent.id, activeIntent.repository);
    const terminalIntent = await createIntent(
      workflowPayload(terminal.user.id, terminal.workflow.id),
      terminal.workflow.id,
    );
    await markIntentDispatched(terminalIntent.intent.id, terminalIntent.repository);
    await cleanupRedisPrefix();

    const publisher = new BullMqQueuePublisher(config);
    const reconciler = new QueueReconciler(
      databaseResource.db,
      databaseResource.client,
      redis,
      new QueueIntentRepository(databaseResource.db),
      publisher,
      config,
    );
    const queue = queueFor('workflow');
    try {
      await expect(
        reconciler.reconcile({
          beforeSentinel: () => Promise.reject(new Error('simulated crash')),
        }),
      ).rejects.toThrow('simulated crash');
      expect(await redis.get(queueRecoverySentinelKey(testRedisPrefix))).toBeNull();

      const summary = await reconciler.reconcile();
      expect(summary.rebuilt).toBeGreaterThanOrEqual(1);
      expect(summary.skippedTerminal).toBeGreaterThanOrEqual(1);
      expect(await redis.get(queueRecoverySentinelKey(testRedisPrefix))).toBe('ready');
      const jobs = await queue.getJobs(['waiting']);
      expect(jobs.filter((job) => job.id === active.workflow.id)).toHaveLength(1);
      expect(jobs.some((job) => job.id === terminal.workflow.id)).toBe(false);
    } finally {
      await queue.close();
      await publisher.close();
    }
  });

  it('webhook-lost protects accepted and outcome_unknown attempts from redispatch', async () => {
    const accepted = await createWorkflowFixture({
      workflowStatus: 'running',
      taskStatus: 'running',
    });
    const unknown = await createWorkflowFixture({
      workflowStatus: 'running',
      taskStatus: 'running',
    });
    if (!accepted.task || !unknown.task) throw new Error('Task fixtures are required');
    const [acceptedAttempt, unknownAttempt] = await databaseResource.db
      .insert(taskAttempts)
      .values([
        {
          taskId: accepted.task.id,
          attemptNo: 1,
          provider: 'fake',
          status: 'accepted',
          dispatchState: 'accepted',
        },
        {
          taskId: unknown.task.id,
          attemptNo: 1,
          provider: 'fake',
          status: 'outcome_unknown',
          dispatchState: 'outcome_unknown',
        },
      ])
      .returning();
    if (!acceptedAttempt || !unknownAttempt) throw new Error('Attempts were not created');
    track('attempts', acceptedAttempt.id);
    track('attempts', unknownAttempt.id);

    const acceptedIntent = await createIntent(
      taskPayload(accepted.user.id, accepted.workflow.id, accepted.task.id),
      accepted.task.id,
    );
    await markIntentDispatched(acceptedIntent.intent.id, acceptedIntent.repository);
    const unknownIntent = await createIntent(
      taskPayload(unknown.user.id, unknown.workflow.id, unknown.task.id),
      unknown.task.id,
    );
    await markIntentDispatched(unknownIntent.intent.id, unknownIntent.repository);
    await cleanupRedisPrefix();

    const publisher = new BullMqQueuePublisher(config);
    const reconciler = new QueueReconciler(
      databaseResource.db,
      databaseResource.client,
      redis,
      new QueueIntentRepository(databaseResource.db),
      publisher,
      config,
    );
    const queue = queueFor('task');
    try {
      const summary = await reconciler.reconcile();
      expect(summary.skippedProtected).toBeGreaterThanOrEqual(2);
      expect(await queue.getJob(accepted.task.id)).toBeUndefined();
      expect(await queue.getJob(unknown.task.id)).toBeUndefined();
    } finally {
      await queue.close();
      await publisher.close();
    }
  });
});
