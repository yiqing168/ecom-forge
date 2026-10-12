import {
  lockCreditAccount,
  releaseOutcomeUnknownReservationInTransaction,
} from '@ecom-forge/credit';
import {
  and,
  asc,
  creditReservations,
  desc,
  eq,
  inArray,
  lte,
  sql,
  taskAttempts,
  tasks,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import {
  addMoney,
  compareMoney,
  NOOP_EVENT_WAKE_PUBLISHER,
  normalizeMoney,
  type EventWake,
  type EventWakePublisher,
} from '@ecom-forge/shared';

import { AgentTurnTerminalRepository } from '../agent/agent-turn-terminal.repository.js';
import type { WorkerConfig } from '../config/worker-config.js';
import { appendOutboxEventInTransaction } from '../database/outbox.repository.js';
import { advanceTaskInTransaction } from '../database/workflow-state.repository.js';
import type { WorkerWriteFence } from '../lifecycle/processing-fence.js';

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);

export class OutcomeUnknownReleaseSweeper {
  private readonly turnTerminal: AgentTurnTerminalRepository;

  constructor(
    private readonly database: Database,
    private readonly config: WorkerConfig,
    private readonly writeFence: WorkerWriteFence,
    private readonly eventWakePublisher: EventWakePublisher = NOOP_EVENT_WAKE_PUBLISHER,
  ) {
    this.turnTerminal = new AgentTurnTerminalRepository(database);
  }

  async sweep(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.config.outcomeUnknownReleaseDeadlineMs);
    const candidates = await this.database
      .select({ attemptId: taskAttempts.id, userId: workflowRuns.userId })
      .from(taskAttempts)
      .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
      .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
      .where(
        and(
          eq(taskAttempts.status, 'outcome_unknown'),
          eq(taskAttempts.dispatchState, 'outcome_unknown'),
          lte(taskAttempts.endedAt, cutoff),
          eq(tasks.status, 'waiting_manual_review'),
          inArray(tasks.type, ['image.generate', 'image.edit']),
          eq(workflowRuns.status, 'running'),
        ),
      )
      .orderBy(asc(taskAttempts.endedAt), asc(taskAttempts.id))
      .limit(this.config.outcomeUnknownReleaseSweepBatchSize);

    let released = 0;
    for (const candidate of candidates) {
      const wakes = await this.expireOne(candidate.attemptId, candidate.userId, cutoff, now);
      if (!wakes) continue;
      released += 1;
      await Promise.all(
        wakes.map((wake) => this.eventWakePublisher.publish(wake).catch(() => undefined)),
      );
    }
    return released;
  }

  private async expireOne(
    attemptId: string,
    userId: string,
    cutoff: Date,
    now: Date,
  ): Promise<EventWake[] | null> {
    this.writeFence.assertWritesAllowed();
    return this.database.transaction(async (transaction) => {
      // Credit account is always the first hot row lock in money-changing transactions.
      await lockCreditAccount(transaction, userId);
      const [owned] = await transaction
        .select({
          attempt: taskAttempts,
          task: tasks,
          workflow: workflowRuns,
          reservation: creditReservations,
        })
        .from(taskAttempts)
        .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
        .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
        .innerJoin(creditReservations, eq(creditReservations.id, workflowRuns.reservationId))
        .where(
          and(
            eq(taskAttempts.id, attemptId),
            eq(taskAttempts.status, 'outcome_unknown'),
            eq(taskAttempts.dispatchState, 'outcome_unknown'),
            lte(taskAttempts.endedAt, cutoff),
            eq(tasks.status, 'waiting_manual_review'),
            inArray(tasks.type, ['image.generate', 'image.edit']),
            eq(workflowRuns.userId, userId),
            eq(workflowRuns.status, 'running'),
          ),
        )
        .for('update')
        .limit(1);
      if (!owned) return null;

      const latestAttempt = await transaction.query.taskAttempts.findFirst({
        where: eq(taskAttempts.taskId, owned.task.id),
        orderBy: [desc(taskAttempts.attemptNo)],
        columns: { id: true },
      });
      if (latestAttempt?.id !== owned.attempt.id) return null;

      const amount = normalizeMoney(owned.task.costEstimate);
      const release =
        compareMoney(amount, '0.00') > 0
          ? await releaseOutcomeUnknownReservationInTransaction(transaction, {
              userId,
              reservationId: owned.reservation.id,
              taskAttemptId: owned.attempt.id,
              amount,
              unknownEndedAtOrBefore: cutoff,
              idempotencyKey: `release:reservation:${owned.reservation.id}:outcome-unknown:${owned.attempt.id}:timeout`,
              metadata: {
                reason: 'provider_outcome_unknown_timeout',
                task_attempt_id: owned.attempt.id,
              },
            })
          : null;

      const [taskFailed] = await transaction
        .update(tasks)
        .set({
          status: 'failed',
          errorCode: 'PROVIDER_OUTCOME_UNKNOWN_EXPIRED',
          costActual: '0.00',
          endedAt: now,
        })
        .where(and(eq(tasks.id, owned.task.id), eq(tasks.status, 'waiting_manual_review')))
        .returning({ id: tasks.id });
      if (!taskFailed) return null;

      const wakes: EventWake[] = [];
      const taskEvent = await appendOutboxEventInTransaction(transaction, {
        scopeType: 'workflow_run',
        scopeId: owned.workflow.id,
        eventType: 'task.status_changed',
        payload: {
          task_id: owned.task.id,
          from: 'waiting_manual_review',
          to: 'failed',
          reason: 'provider_outcome_unknown_timeout',
        },
        retentionTier: 'critical',
      });
      wakes.push(workflowWake(owned.workflow.id, taskEvent.eventSeq));

      const pendingChildren = await transaction.query.tasks.findMany({
        where: and(
          eq(tasks.parentTaskId, owned.task.id),
          eq(tasks.workflowRunId, owned.workflow.id),
          inArray(tasks.status, ['pending', 'queued']),
        ),
        columns: { id: true, status: true },
      });
      for (const child of pendingChildren) {
        const transition = await advanceTaskInTransaction(transaction, {
          taskId: child.id,
          workflowRunId: owned.workflow.id,
          userId,
          from: child.status,
          to: 'blocked',
          now,
          errorCode: 'UPSTREAM_OUTCOME_UNKNOWN_EXPIRED',
        });
        if (transition.wake) wakes.push(transition.wake);
      }

      if (release && !release.alreadyApplied) {
        const creditEvent = await appendOutboxEventInTransaction(transaction, {
          scopeType: 'workflow_run',
          scopeId: owned.workflow.id,
          eventType: 'credit.released',
          payload: {
            amount,
            reservation_id: owned.reservation.id,
            task_id: owned.task.id,
            task_attempt_id: owned.attempt.id,
            ledger_id: release.ledgerId,
            action: 'released',
            reason: 'provider_outcome_unknown_timeout',
          },
          retentionTier: 'critical',
        });
        wakes.push(workflowWake(owned.workflow.id, creditEvent.eventSeq));
      }

      const workflowTasks = await transaction.query.tasks.findMany({
        where: eq(tasks.workflowRunId, owned.workflow.id),
        columns: { status: true },
      });
      const currentReservation = await transaction.query.creditReservations.findFirst({
        where: eq(creditReservations.id, owned.reservation.id),
        columns: { estimatedAmount: true, releasedAmount: true, settledAmount: true },
      });
      if (!currentReservation) throw new Error('OUTCOME_UNKNOWN_RESERVATION_MISSING');
      const fullyAccounted =
        compareMoney(
          addMoney(
            normalizeMoney(currentReservation.settledAmount),
            normalizeMoney(currentReservation.releasedAmount),
          ),
          normalizeMoney(currentReservation.estimatedAmount),
        ) === 0;
      if (
        fullyAccounted &&
        workflowTasks.every((task) => TERMINAL_TASK_STATUSES.has(task.status))
      ) {
        const [workflowFailed] = await transaction
          .update(workflowRuns)
          .set({ status: 'failed', revision: sql`${workflowRuns.revision} + 1`, finishedAt: now })
          .where(and(eq(workflowRuns.id, owned.workflow.id), eq(workflowRuns.status, 'running')))
          .returning({ id: workflowRuns.id });
        if (!workflowFailed) throw new Error('OUTCOME_UNKNOWN_WORKFLOW_CAS_FAILED');
        const workflowEvent = await appendOutboxEventInTransaction(transaction, {
          scopeType: 'workflow_run',
          scopeId: owned.workflow.id,
          eventType: 'workflow.status_changed',
          payload: { from: 'running', to: 'failed' },
          retentionTier: 'critical',
        });
        wakes.push(workflowWake(owned.workflow.id, workflowEvent.eventSeq));
        const turn = await this.turnTerminal.completeForWorkflowOutcome(transaction, {
          workflowRunId: owned.workflow.id,
          outcome: 'failed',
        });
        if (turn) {
          wakes.push({
            schema_version: 1,
            scope_type: 'turn',
            scope_id: turn.turnId,
            event_seq: turn.eventSeq,
          });
        }
      }
      return wakes;
    });
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
