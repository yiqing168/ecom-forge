import { and, eq, sql, tasks, workflowRuns, type Database } from '@ecom-forge/db';
import { createQueueIntentInTransaction } from '@ecom-forge/queue';
import {
  NOOP_EVENT_WAKE_PUBLISHER,
  type EventWake,
  type EventWakePublisher,
} from '@ecom-forge/shared';
import type { TaskStatus, WorkflowRunStatus } from '@ecom-forge/types';

import { appendOutboxEventInTransaction } from './outbox.repository.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface AdvanceTaskInput {
  taskId: string;
  workflowRunId: string;
  userId: string;
  from: TaskStatus;
  to: TaskStatus;
  now: Date;
  errorCode?: string | null;
  settlement?: {
    taskAttemptId: string;
    reservationId: string;
    providerReportedCost?: string;
    artifactIds: string[];
  };
}

export interface TaskTransitionResult {
  status: 'advanced' | 'already_applied';
  wake: EventWake | null;
}

const WORKFLOW_TRANSITIONS: Readonly<Record<WorkflowRunStatus, readonly WorkflowRunStatus[]>> = {
  reserved: ['queued'],
  queued: ['running', 'cancelling'],
  running: ['succeeded', 'failed', 'cancelling'],
  succeeded: ['disputed'],
  failed: ['refunding', 'disputed'],
  cancelling: ['cancelled'],
  cancelled: ['refunding'],
  refunding: ['refunded'],
  refunded: [],
  disputed: ['succeeded', 'failed'],
};

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['queued', 'cancelled', 'blocked'],
  queued: ['running', 'failed', 'cancelled', 'blocked'],
  running: ['succeeded', 'failed', 'cancelled', 'blocked', 'waiting_manual_review'],
  succeeded: [],
  failed: [],
  cancelled: [],
  blocked: [],
  waiting_manual_review: ['succeeded', 'failed', 'cancelled'],
};

function assertTransition<T extends string>(
  transitions: Readonly<Record<T, readonly T[]>>,
  from: T,
  to: T,
  entity: string,
): void {
  if (!transitions[from].includes(to)) {
    throw new Error(`${entity} transition ${from} -> ${to} is not allowed`);
  }
}

export async function advanceTaskInTransaction(
  transaction: Transaction,
  input: AdvanceTaskInput,
): Promise<TaskTransitionResult> {
  assertTransition(TASK_TRANSITIONS, input.from, input.to, 'Task');
  const owned = await transaction
    .select({ taskId: tasks.id })
    .from(tasks)
    .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
    .where(
      and(
        eq(tasks.id, input.taskId),
        eq(tasks.workflowRunId, input.workflowRunId),
        eq(workflowRuns.userId, input.userId),
      ),
    )
    .limit(1);
  if (owned.length === 0) throw new Error('Task does not exist');

  const [updated] = await transaction
    .update(tasks)
    .set({
      status: input.to,
      ...(input.to === 'running' ? { startedAt: input.now } : {}),
      ...(['succeeded', 'failed', 'cancelled', 'blocked'].includes(input.to)
        ? { endedAt: input.now }
        : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    })
    .where(
      and(
        eq(tasks.id, input.taskId),
        eq(tasks.workflowRunId, input.workflowRunId),
        eq(tasks.status, input.from),
      ),
    )
    .returning({ id: tasks.id });
  if (!updated) {
    const current = await transaction.query.tasks.findFirst({
      where: and(eq(tasks.id, input.taskId), eq(tasks.workflowRunId, input.workflowRunId)),
    });
    if (!current) throw new Error('Task does not exist');
    if (current.status === input.to) {
      return { status: 'already_applied', wake: null };
    }
    throw new Error(`Task transition rejected from ${current.status}`);
  }
  const event = await appendOutboxEventInTransaction(transaction, {
    scopeType: 'workflow_run',
    scopeId: input.workflowRunId,
    eventType: 'task.status_changed',
    payload: { task_id: input.taskId, from: input.from, to: input.to },
    retentionTier: 'critical',
  });
  if (input.settlement) {
    await createQueueIntentInTransaction(transaction, {
      queueName: 'settlement',
      jobId: input.settlement.taskAttemptId,
      aggregateType: 'task_attempt',
      aggregateId: input.settlement.taskAttemptId,
      payloadVersion: 1,
      payload: {
        schema_version: 1,
        job_type: 'settlement.execute',
        trace_id: input.workflowRunId,
        workflow_run_id: input.workflowRunId,
        task_id: input.taskId,
        task_attempt_id: input.settlement.taskAttemptId,
        reservation_id: input.settlement.reservationId,
        ...(input.settlement.providerReportedCost !== undefined
          ? { provider_reported_cost: input.settlement.providerReportedCost }
          : {}),
        artifact_ids: input.settlement.artifactIds,
        idempotency_key: `settle:task_attempt:${input.settlement.taskAttemptId}`,
      },
    });
  }
  return {
    status: 'advanced',
    wake: workflowWake(input.workflowRunId, event.eventSeq),
  };
}

export class WorkflowStateRepository {
  constructor(
    private readonly database: Database,
    private readonly eventWakePublisher: EventWakePublisher = NOOP_EVENT_WAKE_PUBLISHER,
  ) {}

  async advanceWorkflow(input: {
    workflowRunId: string;
    userId: string;
    from: WorkflowRunStatus;
    to: WorkflowRunStatus;
    now: Date;
  }): Promise<'advanced' | 'already_applied'> {
    assertTransition(WORKFLOW_TRANSITIONS, input.from, input.to, 'Workflow');
    const result = await this.database.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(workflowRuns)
        .set({
          status: input.to,
          revision: sql`${workflowRuns.revision} + 1`,
          ...(['succeeded', 'failed', 'cancelled', 'refunded'].includes(input.to)
            ? { finishedAt: input.now }
            : {}),
        })
        .where(
          and(
            eq(workflowRuns.id, input.workflowRunId),
            eq(workflowRuns.userId, input.userId),
            eq(workflowRuns.status, input.from),
          ),
        )
        .returning({ id: workflowRuns.id });
      if (!updated) {
        const current = await transaction.query.workflowRuns.findFirst({
          where: and(
            eq(workflowRuns.id, input.workflowRunId),
            eq(workflowRuns.userId, input.userId),
          ),
        });
        if (!current) throw new Error('Workflow run does not exist');
        if (current.status === input.to) {
          return { status: 'already_applied' as const, wake: null };
        }
        throw new Error(`Workflow transition rejected from ${current.status}`);
      }
      const event = await appendOutboxEventInTransaction(transaction, {
        scopeType: 'workflow_run',
        scopeId: input.workflowRunId,
        eventType: 'workflow.status_changed',
        payload: { from: input.from, to: input.to },
        retentionTier: 'critical',
      });
      return {
        status: 'advanced' as const,
        wake: workflowWake(input.workflowRunId, event.eventSeq),
      };
    });
    if (result.wake) await this.eventWakePublisher.publish(result.wake).catch(() => undefined);
    return result.status;
  }

  async advanceTask(input: AdvanceTaskInput): Promise<'advanced' | 'already_applied'> {
    const result = await this.database.transaction((transaction) =>
      advanceTaskInTransaction(transaction, input),
    );
    if (result.wake) await this.eventWakePublisher.publish(result.wake).catch(() => undefined);
    return result.status;
  }
}

function workflowWake(workflowRunId: string, eventSeq: number): EventWake {
  return {
    schema_version: 1,
    scope_type: 'workflow_run',
    scope_id: workflowRunId,
    event_seq: eventSeq,
  };
}
