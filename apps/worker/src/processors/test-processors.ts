import { Worker, type Job } from 'bullmq';

import { createBullMqConnection, parseQueuePayload, type QueuePayload } from '@ecom-forge/queue';
import { and, eq, tasks, workflowRuns, type Database } from '@ecom-forge/db';
import { NOOP_EVENT_WAKE_PUBLISHER, type EventWakePublisher } from '@ecom-forge/shared';

import type { WorkerConfig } from '../config/worker-config.js';
import { TaskAttemptRepository } from '../database/attempt.repository.js';
import { WorkflowStateRepository } from '../database/workflow-state.repository.js';
import type { ActiveWorkTracker, WorkerWriteFence } from '../lifecycle/processing-fence.js';

type TestQueuePayload = Extract<QueuePayload, { job_type: 'workflow.advance' | 'task.execute' }>;

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);

export class TestProcessorWorkers {
  private readonly workers: Worker<TestQueuePayload>[];
  private readonly states: WorkflowStateRepository;
  private readonly attempts: TaskAttemptRepository;

  constructor(
    private readonly database: Database,
    config: WorkerConfig,
    private readonly activeWork: ActiveWorkTracker,
    private readonly writeFence: WorkerWriteFence,
    eventWakePublisher: EventWakePublisher = NOOP_EVENT_WAKE_PUBLISHER,
  ) {
    if (config.appEnv !== 'test' || !config.testProcessorEnabled) {
      throw new Error('S05 test processors require APP_ENV=test and explicit enablement');
    }
    this.states = new WorkflowStateRepository(database, eventWakePublisher);
    this.attempts = new TaskAttemptRepository(database);
    const options = {
      connection: createBullMqConnection(config.redisUrl),
      prefix: config.redisPrefix,
      concurrency: 1,
      autorun: true,
    };
    this.workers = [
      new Worker<TestQueuePayload>('workflow', (job) => this.process(job), options),
      new Worker<TestQueuePayload>('task', (job) => this.process(job), options),
    ];
  }

  pauseNewWork(): Promise<void> {
    return Promise.all(this.workers.map((worker) => worker.pause(true))).then(() => undefined);
  }

  close(force: boolean): Promise<void> {
    return Promise.all(this.workers.map((worker) => worker.close(force))).then(() => undefined);
  }

  private process(job: Job<TestQueuePayload>): Promise<void> {
    return this.activeWork.run(async () => {
      const payload = parseQueuePayload(job.data);
      if (payload.job_type === 'workflow.advance') {
        await this.processWorkflow(payload);
        return;
      }
      if (payload.job_type === 'task.execute') {
        await this.processTask(payload);
        return;
      }
      throw new Error('Only workflow and task test jobs are active in S05');
    });
  }

  private async processWorkflow(
    payload: Extract<QueuePayload, { job_type: 'workflow.advance' }>,
  ): Promise<void> {
    const workflow = await this.database.query.workflowRuns.findFirst({
      where: and(
        eq(workflowRuns.id, payload.workflow_run_id),
        eq(workflowRuns.userId, payload.user_id),
      ),
    });
    if (!workflow || workflow.status !== 'queued') return;
    this.writeFence.assertWritesAllowed();
    await this.states.advanceWorkflow({
      workflowRunId: workflow.id,
      userId: workflow.userId,
      from: 'queued',
      to: 'running',
      now: new Date(),
    });
  }

  private async processTask(
    payload: Extract<QueuePayload, { job_type: 'task.execute' }>,
  ): Promise<void> {
    const owned = await this.database
      .select({
        task: tasks,
        userId: workflowRuns.userId,
        reservationId: workflowRuns.reservationId,
      })
      .from(tasks)
      .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
      .where(
        and(
          eq(tasks.id, payload.task_id),
          eq(tasks.workflowRunId, payload.workflow_run_id),
          eq(workflowRuns.userId, payload.user_id),
        ),
      )
      .limit(1);
    const row = owned[0];
    if (!row || TERMINAL_TASK_STATUSES.has(row.task.status)) return;
    if (!['queued', 'running'].includes(row.task.status)) {
      throw new Error(`Task status ${row.task.status} cannot be processed by the S05 test worker`);
    }

    this.writeFence.assertWritesAllowed();
    if (row.task.status === 'queued') {
      await this.states.advanceTask({
        taskId: row.task.id,
        workflowRunId: row.task.workflowRunId,
        userId: row.userId,
        from: 'queued',
        to: 'running',
        now: new Date(),
      });
    }

    const allocation = await this.attempts.allocate({
      taskId: row.task.id,
      provider: 's05-test-local',
    });
    this.writeFence.assertWritesAllowed();
    await this.attempts.advance({
      attemptId: allocation.attempt.id,
      expectedStatus: 'created',
      expectedDispatchState: 'not_dispatched',
      status: 'succeeded',
      dispatchState: 'not_dispatched',
      now: new Date(),
    });
    this.writeFence.assertWritesAllowed();
    await this.states.advanceTask({
      taskId: row.task.id,
      workflowRunId: row.task.workflowRunId,
      userId: row.userId,
      from: 'running',
      to: 'succeeded',
      now: new Date(),
      ...(row.reservationId
        ? {
            settlement: {
              taskAttemptId: allocation.attempt.id,
              reservationId: row.reservationId,
              artifactIds: [],
            },
          }
        : {}),
    });
  }
}
