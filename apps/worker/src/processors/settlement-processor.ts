import { Worker, type Job } from 'bullmq';

import {
  consumeReservationInTransaction,
  CreditError,
  lockCreditAccount,
  releaseReservationInTransaction,
} from '@ecom-forge/credit';
import {
  and,
  artifactEvaluations,
  artifacts,
  contentReviewCases,
  creditLedger,
  creditReservations,
  desc,
  eq,
  sql,
  taskAttempts,
  tasks,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import { createBullMqConnection, parseQueuePayload, type QueuePayload } from '@ecom-forge/queue';
import {
  compareMoney,
  NOOP_EVENT_WAKE_PUBLISHER,
  normalizeMoney,
  subtractMoney,
  type EventWakePublisher,
  type MoneyString,
} from '@ecom-forge/shared';

import type { WorkerConfig } from '../config/worker-config.js';
import { AgentTurnTerminalRepository } from '../agent/agent-turn-terminal.repository.js';
import { appendOutboxEventInTransaction } from '../database/outbox.repository.js';
import type { ActiveWorkTracker, WorkerWriteFence } from '../lifecycle/processing-fence.js';

type SettlementPayload = Extract<QueuePayload, { job_type: 'settlement.execute' }>;

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);

export interface SettlementExecutionResult {
  action: 'consumed' | 'released';
  ledgerId: string | null;
  finalReleaseLedgerId: string | null;
  alreadyApplied: boolean;
}

export class SettlementService {
  private readonly turnTerminal: AgentTurnTerminalRepository;

  constructor(
    private readonly database: Database,
    private readonly eventWakePublisher: EventWakePublisher = NOOP_EVENT_WAKE_PUBLISHER,
  ) {
    this.turnTerminal = new AgentTurnTerminalRepository(database);
  }

  async execute(payload: SettlementPayload): Promise<SettlementExecutionResult> {
    const transactionResult = await this.database.transaction(async (transaction) => {
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
            eq(taskAttempts.id, payload.task_attempt_id),
            eq(tasks.id, payload.task_id),
            eq(workflowRuns.id, payload.workflow_run_id),
            eq(creditReservations.id, payload.reservation_id),
          ),
        )
        .limit(1);
      if (!owned) {
        throw new CreditError(
          'Settlement ownership could not be verified',
          'RESERVATION_STATE_INVALID',
        );
      }
      // All money mutations lock account first. Re-read and lock the owned rows
      // after the account lock so submit and settlement cannot invert locks.
      await lockCreditAccount(transaction, owned.workflow.userId);
      const [lockedOwned] = await transaction
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
            eq(taskAttempts.id, payload.task_attempt_id),
            eq(tasks.id, payload.task_id),
            eq(workflowRuns.id, payload.workflow_run_id),
            eq(creditReservations.id, payload.reservation_id),
          ),
        )
        .for('update')
        .limit(1);
      if (!lockedOwned) {
        throw new CreditError(
          'Settlement ownership changed while locking',
          'RESERVATION_STATE_INVALID',
        );
      }
      const settledOwned = lockedOwned;
      this.assertPayloadCost(payload, settledOwned.attempt.providerReportedCost);

      const common = {
        userId: settledOwned.workflow.userId,
        reservationId: settledOwned.reservation.id,
        taskAttemptId: settledOwned.attempt.id,
        idempotencyKey: payload.idempotency_key,
        metadata: { task_attempt_id: settledOwned.attempt.id },
      };

      let action: SettlementExecutionResult['action'];
      let settlementAmount: MoneyString;
      let mutation: Awaited<ReturnType<typeof consumeReservationInTransaction>> | undefined;
      let zeroAlreadyApplied = false;
      if (settledOwned.attempt.status === 'succeeded' && settledOwned.task.status === 'succeeded') {
        await this.assertArtifactsApproved(
          transaction,
          payload,
          settledOwned.task.id,
          settledOwned.workflow.userId,
        );
        const amount = normalizeMoney(settledOwned.task.costEstimate);
        if (compareMoney(amount, '0.00') === 0) {
          zeroAlreadyApplied = settledOwned.task.costActual !== null;
          settlementAmount = amount;
          action = 'consumed';
          await transaction
            .update(tasks)
            .set({ costActual: amount })
            .where(eq(tasks.id, settledOwned.task.id));
        } else {
          settlementAmount = amount;
          mutation = await consumeReservationInTransaction(transaction, { ...common, amount });
          action = 'consumed';
          await transaction
            .update(tasks)
            .set({ costActual: amount })
            .where(eq(tasks.id, settledOwned.task.id));
        }
      } else if (
        ((settledOwned.attempt.status === 'failed' ||
          settledOwned.attempt.status === 'succeeded') &&
          ['failed', 'cancelled', 'blocked'].includes(settledOwned.task.status)) ||
        (settledOwned.attempt.status === 'timeout' &&
          settledOwned.attempt.dispatchState === 'not_dispatched' &&
          ['failed', 'cancelled', 'blocked'].includes(settledOwned.task.status))
      ) {
        settlementAmount = normalizeMoney(settledOwned.task.costEstimate);
        action = 'released';
        if (compareMoney(settlementAmount, '0.00') === 0) {
          zeroAlreadyApplied = settledOwned.task.costActual !== null;
          await transaction
            .update(tasks)
            .set({ costActual: settlementAmount })
            .where(eq(tasks.id, settledOwned.task.id));
        } else {
          mutation = await releaseReservationInTransaction(transaction, {
            ...common,
            amount: settlementAmount,
          });
        }
      } else {
        throw new CreditError('Settlement result is not final', 'SETTLEMENT_PROTECTED');
      }

      let finalReleaseLedgerId: string | null = null;
      let finalReleaseAmount: MoneyString | null = null;
      let turnWake: {
        schema_version: 1;
        scope_type: 'turn';
        scope_id: string;
        event_seq: number;
      } | null = null;
      const workflowTasks = await transaction.query.tasks.findMany({
        where: eq(tasks.workflowRunId, settledOwned.workflow.id),
        columns: { id: true, status: true, costEstimate: true },
      });
      const allTerminal = workflowTasks.every((task) => TERMINAL_TASK_STATUSES.has(task.status));
      if (allTerminal) {
        const financialEntries = await transaction.query.creditLedger.findMany({
          where: and(
            eq(creditLedger.reservationId, settledOwned.reservation.id),
            eq(creditLedger.type, 'consume'),
          ),
          columns: { taskId: true },
        });
        const releaseEntries = await transaction.query.creditLedger.findMany({
          where: and(
            eq(creditLedger.reservationId, settledOwned.reservation.id),
            eq(creditLedger.type, 'release'),
          ),
          columns: { taskId: true },
        });
        const accountedTaskIds = new Set(
          [...financialEntries, ...releaseEntries]
            .map((entry) => entry.taskId)
            .filter((taskId): taskId is string => taskId !== null),
        );
        const allSettlementsApplied = workflowTasks.every(
          (task) =>
            compareMoney(normalizeMoney(task.costEstimate), '0.00') === 0 ||
            accountedTaskIds.has(task.id),
        );
        if (allSettlementsApplied) {
          const finalReleaseKey = `release:reservation:${settledOwned.reservation.id}:terminal`;
          const priorFinalRelease = await transaction.query.creditLedger.findFirst({
            where: eq(creditLedger.idempotencyKey, finalReleaseKey),
          });
          if (priorFinalRelease) {
            if (
              priorFinalRelease.userId !== settledOwned.workflow.userId ||
              priorFinalRelease.reservationId !== settledOwned.reservation.id ||
              priorFinalRelease.type !== 'release'
            ) {
              throw new CreditError(
                'Terminal release idempotency conflict',
                'IDEMPOTENCY_CONFLICT',
              );
            }
            finalReleaseLedgerId = priorFinalRelease.id;
          }
          const current = await transaction.query.creditReservations.findFirst({
            where: eq(creditReservations.id, settledOwned.reservation.id),
          });
          if (!current)
            throw new CreditError('Reservation disappeared', 'RESERVATION_STATE_INVALID');
          const outstanding = subtractMoney(
            subtractMoney(
              normalizeMoney(current.estimatedAmount),
              normalizeMoney(current.settledAmount),
            ),
            normalizeMoney(current.releasedAmount),
          );
          if (priorFinalRelease && compareMoney(outstanding, '0.00') > 0) {
            throw new CreditError(
              'Terminal release projection is inconsistent',
              'RESERVATION_STATE_INVALID',
            );
          }
          if (compareMoney(outstanding, '0.00') > 0) {
            const finalRelease = await releaseReservationInTransaction(transaction, {
              ...common,
              amount: outstanding,
              idempotencyKey: finalReleaseKey,
              metadata: { reason: 'terminal_remainder', task_attempt_id: settledOwned.attempt.id },
            });
            finalReleaseLedgerId = finalRelease.ledgerId;
            finalReleaseAmount = outstanding;
          }
          const workflowOutcome = await this.finishWorkflow(
            transaction,
            settledOwned.workflow,
            workflowTasks.map((task) => task.status),
          );
          if (workflowOutcome) {
            const turnOutcome = await this.turnTerminal.completeForWorkflowOutcome(transaction, {
              workflowRunId: settledOwned.workflow.id,
              outcome: workflowOutcome,
            });
            if (turnOutcome) {
              turnWake = {
                schema_version: 1 as const,
                scope_type: 'turn' as const,
                scope_id: turnOutcome.turnId,
                event_seq: turnOutcome.eventSeq,
              };
            }
          }
        }
      }

      let wake = null;
      const shouldPublishSettlement =
        (mutation && !mutation.alreadyApplied) ||
        (!mutation && !zeroAlreadyApplied && finalReleaseLedgerId && finalReleaseAmount);
      if (shouldPublishSettlement) {
        const eventAction = mutation ? action : 'released';
        const eventAmount = mutation ? settlementAmount : finalReleaseAmount!;
        const eventLedgerId = mutation ? mutation.ledgerId : finalReleaseLedgerId!;
        const event = await appendOutboxEventInTransaction(transaction, {
          scopeType: 'workflow_run',
          scopeId: settledOwned.workflow.id,
          eventType: eventAction === 'consumed' ? 'credit.settled' : 'credit.released',
          payload: {
            amount: eventAmount,
            reservation_id: settledOwned.reservation.id,
            task_id: settledOwned.task.id,
            task_attempt_id: settledOwned.attempt.id,
            ledger_id: eventLedgerId,
            action: eventAction,
            ...(finalReleaseLedgerId && finalReleaseAmount
              ? {
                  final_release_ledger_id: finalReleaseLedgerId,
                  final_release_amount: finalReleaseAmount,
                }
              : {}),
          },
          retentionTier: 'critical',
        });
        wake = {
          schema_version: 1 as const,
          scope_type: 'workflow_run' as const,
          scope_id: settledOwned.workflow.id,
          event_seq: event.eventSeq,
        };
      }
      return {
        result: {
          action,
          ledgerId: mutation?.ledgerId ?? null,
          finalReleaseLedgerId,
          alreadyApplied: mutation?.alreadyApplied ?? zeroAlreadyApplied,
        },
        wake,
        turnWake,
      };
    });
    for (const wake of [transactionResult.wake, transactionResult.turnWake]) {
      if (wake) {
        await this.eventWakePublisher.publish(wake).catch(() => undefined);
      }
    }
    return transactionResult.result;
  }

  private assertPayloadCost(payload: SettlementPayload, persistedCost: string | null): void {
    if (
      payload.provider_reported_cost !== undefined &&
      (persistedCost === null ||
        compareMoney(
          normalizeMoney(payload.provider_reported_cost),
          normalizeMoney(persistedCost),
        ) !== 0)
    ) {
      throw new CreditError(
        'Provider cost does not match persisted receipt',
        'IDEMPOTENCY_CONFLICT',
      );
    }
  }

  private async assertArtifactsApproved(
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
    payload: SettlementPayload,
    taskId: string,
    userId: string,
  ): Promise<void> {
    const uniqueIds = [...new Set(payload.artifact_ids)];
    if (uniqueIds.length !== payload.artifact_ids.length) {
      throw new CreditError('Settlement artifact list contains duplicates', 'IDEMPOTENCY_CONFLICT');
    }
    const taskArtifacts = await transaction
      .select({
        id: artifacts.id,
        taskId: artifacts.taskId,
        userId: artifacts.userId,
        visibility: artifacts.visibility,
      })
      .from(artifacts)
      .where(and(eq(artifacts.taskId, taskId), eq(artifacts.userId, userId)))
      .for('update');
    const taskArtifactIds = new Set(taskArtifacts.map((artifact) => artifact.id));
    if (
      taskArtifacts.length !== uniqueIds.length ||
      uniqueIds.some((artifactId) => !taskArtifactIds.has(artifactId))
    ) {
      throw new CreditError(
        'Settlement artifact set does not match the task output',
        'RESERVATION_STATE_INVALID',
      );
    }
    const ownedArtifacts = taskArtifacts;
    if (
      ownedArtifacts.some((artifact) => artifact.taskId !== taskId || artifact.userId !== userId)
    ) {
      throw new CreditError(
        'Settlement artifact ownership could not be verified',
        'RESERVATION_STATE_INVALID',
      );
    }
    for (const artifact of ownedArtifacts) {
      if (!['private', 'shared', 'public'].includes(artifact.visibility)) {
        throw new CreditError('Settlement artifact is not visible', 'SETTLEMENT_PROTECTED');
      }
      const [latestSafetyEvaluation] = await transaction
        .select({ id: artifactEvaluations.id, status: artifactEvaluations.status })
        .from(artifactEvaluations)
        .where(
          and(
            eq(artifactEvaluations.artifactId, artifact.id),
            eq(artifactEvaluations.evaluatorType, 'content_safety'),
          ),
        )
        .orderBy(desc(artifactEvaluations.createdAt), desc(artifactEvaluations.id))
        .limit(1);
      const manuallyReleased =
        latestSafetyEvaluation?.status === 'unknown'
          ? await transaction.query.contentReviewCases.findFirst({
              where: and(
                eq(contentReviewCases.artifactId, artifact.id),
                eq(contentReviewCases.evaluationId, latestSafetyEvaluation.id),
                eq(contentReviewCases.status, 'released'),
              ),
            })
          : undefined;
      if (
        latestSafetyEvaluation?.status !== 'pass' &&
        !(manuallyReleased?.decision === 'release' && manuallyReleased.decidedByAdminId)
      ) {
        throw new CreditError(
          'Settlement artifact has not passed content safety',
          'SETTLEMENT_PROTECTED',
        );
      }
    }
  }

  private async finishWorkflow(
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
    workflow: typeof workflowRuns.$inferSelect,
    taskStatuses: Array<typeof tasks.$inferSelect.status>,
  ): Promise<'succeeded' | 'failed' | null> {
    const target = taskStatuses.every((status) => status === 'succeeded')
      ? ('succeeded' as const)
      : ('failed' as const);
    if (workflow.status === target) return null;
    if (workflow.status !== 'running') {
      throw new CreditError(
        'Workflow cannot enter its settlement terminal state',
        'RESERVATION_STATE_INVALID',
      );
    }
    const now = new Date();
    const [updated] = await transaction
      .update(workflowRuns)
      .set({
        status: target,
        revision: sql`${workflowRuns.revision} + 1`,
        finishedAt: now,
      })
      .where(and(eq(workflowRuns.id, workflow.id), eq(workflowRuns.status, 'running')))
      .returning({ id: workflowRuns.id });
    if (!updated) {
      const current = await transaction.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, workflow.id),
        columns: { status: true },
      });
      if (current?.status === target) return null;
      throw new CreditError(
        'Workflow terminal transition was rejected',
        'RESERVATION_STATE_INVALID',
      );
    }
    await appendOutboxEventInTransaction(transaction, {
      scopeType: 'workflow_run',
      scopeId: workflow.id,
      eventType: 'workflow.status_changed',
      payload: { from: 'running', to: target },
      retentionTier: 'critical',
    });
    return target;
  }
}

export class SettlementProcessorWorker {
  private readonly worker: Worker<SettlementPayload>;
  private readonly settlements: SettlementService;

  constructor(
    database: Database,
    config: WorkerConfig,
    private readonly activeWork: ActiveWorkTracker,
    private readonly writeFence: WorkerWriteFence,
    eventWakePublisher: EventWakePublisher = NOOP_EVENT_WAKE_PUBLISHER,
  ) {
    this.settlements = new SettlementService(database, eventWakePublisher);
    this.worker = new Worker<SettlementPayload>('settlement', (job) => this.process(job), {
      connection: createBullMqConnection(config.redisUrl),
      prefix: config.redisPrefix,
      concurrency: 1,
      autorun: true,
    });
  }

  pauseNewWork(): Promise<void> {
    return this.worker.pause(true);
  }

  close(force: boolean): Promise<void> {
    return this.worker.close(force);
  }

  private process(job: Job<SettlementPayload>): Promise<void> {
    return this.activeWork.run(async () => {
      const payload = parseQueuePayload(job.data);
      if (payload.job_type !== 'settlement.execute') {
        throw new Error('Settlement queue received a non-settlement payload');
      }
      this.writeFence.assertWritesAllowed();
      await this.settlements.execute(payload);
    });
  }
}
