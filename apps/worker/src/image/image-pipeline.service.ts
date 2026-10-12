import { setTimeout as wait } from 'node:timers/promises';

import {
  and,
  artifacts,
  eq,
  inArray,
  taskAttempts,
  tasks,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import type { ProviderImageExecutionOutcome } from '@ecom-forge/provider';
import type { QueuePayload } from '@ecom-forge/queue';

import { WORKER_RUNTIME_DEFAULTS } from '../config/runtime-defaults.js';
import { TaskAttemptRepository } from '../database/attempt.repository.js';
import {
  advanceTaskInTransaction,
  WorkflowStateRepository,
} from '../database/workflow-state.repository.js';
import type { WorkerWriteFence } from '../lifecycle/processing-fence.js';
import {
  NOOP_PROVIDER_TELEMETRY,
  safeValidationIssues,
  stableErrorCode,
  telemetryId,
  type ProviderTelemetryLogger,
} from '../provider/provider-telemetry.js';
import type { ImageDispatcher } from './approved-image.dispatcher.js';
import type { ImageOutputIngestService } from './image-output-ingest.service.js';

type TaskPayload = Extract<QueuePayload, { job_type: 'task.execute' }>;

export class ImagePipelineService {
  private readonly attempts: TaskAttemptRepository;
  private readonly workflowStates: WorkflowStateRepository;

  constructor(
    private readonly database: Database,
    private readonly dispatcher: ImageDispatcher,
    private readonly ingestService: ImageOutputIngestService,
    private readonly writeFence: WorkerWriteFence,
    private readonly telemetry: ProviderTelemetryLogger = NOOP_PROVIDER_TELEMETRY,
  ) {
    this.attempts = new TaskAttemptRepository(database);
    this.workflowStates = new WorkflowStateRepository(database);
  }

  async execute(payload: TaskPayload): Promise<'handled' | 'not_image_task'> {
    const owned = await this.readOwned(payload);
    if (!owned) return 'handled';
    if (!['image.generate', 'image.edit'].includes(owned.task.type)) return 'not_image_task';
    if (
      ['succeeded', 'failed', 'cancelled', 'blocked', 'waiting_manual_review'].includes(
        owned.task.status,
      )
    ) {
      return 'handled';
    }

    if (owned.workflow.status === 'queued') {
      await this.workflowStates.advanceWorkflow({
        workflowRunId: owned.workflow.id,
        userId: owned.workflow.userId,
        from: 'queued',
        to: 'running',
        now: new Date(),
      });
    } else if (owned.workflow.status !== 'running') {
      throw new Error('IMAGE_WORKFLOW_STATE_INVALID');
    }
    if (owned.task.status === 'queued') {
      await this.workflowStates.advanceTask({
        taskId: owned.task.id,
        workflowRunId: owned.workflow.id,
        userId: owned.workflow.userId,
        from: 'queued',
        to: 'running',
        now: new Date(),
      });
    } else if (owned.task.status !== 'running') {
      throw new Error('IMAGE_TASK_STATE_INVALID');
    }

    const latestAttempt = await this.database.query.taskAttempts.findFirst({
      where: eq(taskAttempts.taskId, owned.task.id),
      orderBy: (attempt, { desc }) => [desc(attempt.attemptNo)],
    });
    if (latestAttempt?.status === 'failed') {
      await this.recoverFailedTask(owned, latestAttempt.id, attemptErrorCode(latestAttempt));
      return 'handled';
    }

    const allocation = await this.attempts.allocate({
      taskId: owned.task.id,
      provider: owned.modelProvider,
      maxAttempts: 1,
    });
    if (payload.task_attempt_id && payload.task_attempt_id !== allocation.attempt.id) {
      throw new Error('IMAGE_TASK_ATTEMPT_OWNERSHIP_INVALID');
    }
    if (allocation.attempt.status === 'succeeded') return 'handled';
    if (allocation.attempt.status === 'outcome_unknown') {
      await this.markUnknown(
        owned,
        allocation.attempt.id,
        attemptErrorCode(allocation.attempt, 'IMAGE_OUTCOME_UNKNOWN_RECOVERY'),
      );
      return 'handled';
    }
    if (allocation.attempt.status === 'accepted') {
      const existing = await this.database.query.artifacts.findFirst({
        where: eq(artifacts.taskId, owned.task.id),
        columns: { id: true },
      });
      if (existing) return 'handled';
      await this.markUnknown(owned, allocation.attempt.id, 'IMAGE_OUTPUT_RECOVERY_UNKNOWN');
      return 'handled';
    }
    if (allocation.attempt.status === 'dispatching') return 'handled';
    if (allocation.attempt.status !== 'created') {
      throw new Error('IMAGE_ATTEMPT_STATE_INVALID');
    }

    this.writeFence.assertWritesAllowed();
    await this.attempts.advance({
      attemptId: allocation.attempt.id,
      expectedStatus: 'created',
      expectedDispatchState: 'not_dispatched',
      status: 'dispatching',
      dispatchState: 'not_dispatched',
      now: new Date(),
    });

    let outcome: ProviderImageExecutionOutcome;
    for (let retryNo = 0; ; retryNo += 1) {
      if (!this.writeFence.isWriteAllowed()) return 'handled';
      if (retryNo > 0 && !(await this.canDispatchAgain(owned, allocation.attempt.id))) {
        return 'handled';
      }
      const dispatchStartedAt = Date.now();
      try {
        outcome = await this.dispatcher({
          taskId: owned.task.id,
          workflowRunId: owned.workflow.id,
          userId: owned.workflow.userId,
          attemptId: allocation.attempt.id,
          traceId: payload.trace_id,
          paramsSnapshot: owned.task.paramsSnapshot,
          markPotentiallyDispatched: () => this.markPotentiallyDispatched(allocation.attempt.id),
        });
      } catch (error) {
        this.logStageFailure(payload, owned.task.id, allocation.attempt.id, 'dispatch', error);
        const persistedAttempt = await this.database.query.taskAttempts.findFirst({
          where: eq(taskAttempts.id, allocation.attempt.id),
          columns: { status: true, dispatchState: true },
        });
        if (
          persistedAttempt?.status === 'dispatching' &&
          persistedAttempt.dispatchState === 'not_dispatched'
        ) {
          await this.failNotDispatched(
            owned,
            allocation.attempt.id,
            'IMAGE_PROVIDER_PREPARATION_FAILED',
          );
        } else {
          await this.markUnknown(owned, allocation.attempt.id, 'IMAGE_PROVIDER_DISPATCH_UNKNOWN');
        }
        return 'handled';
      }
      this.telemetry.info({
        event: 'image_provider_dispatch_completed',
        metric: 'image_provider_dispatch_total',
        trace_id: payload.trace_id,
        task_id_hash: telemetryId(owned.task.id),
        attempt_id: allocation.attempt.id,
        outcome: outcome.kind,
        duration_ms: Date.now() - dispatchStartedAt,
        retry_no: retryNo,
      });

      if (outcome.kind !== 'not_dispatched') break;
      const persistedAttempt = await this.database.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, allocation.attempt.id),
        columns: { status: true, dispatchState: true },
      });
      // The persisted transport fence wins over an inconsistent adapter receipt.
      if (
        persistedAttempt?.dispatchState !== 'not_dispatched' &&
        persistedAttempt &&
        ['accepted', 'outcome_unknown'].includes(persistedAttempt.status)
      ) {
        await this.markUnknown(owned, allocation.attempt.id, 'IMAGE_PROVIDER_DISPATCH_UNKNOWN');
        return 'handled';
      }
      if (!(await this.canDispatchAgain(owned, allocation.attempt.id))) return 'handled';
      if (
        !outcome.retryable ||
        !TRANSIENT_NOT_DISPATCHED_ERRORS.has(outcome.error_code) ||
        retryNo >= WORKER_RUNTIME_DEFAULTS.imageNotDispatchedMaxRetries
      )
        break;
      this.telemetry.info({
        event: 'image_provider_pre_dispatch_retry',
        metric: 'image_provider_pre_dispatch_retry_total',
        trace_id: payload.trace_id,
        task_id_hash: telemetryId(owned.task.id),
        attempt_id: allocation.attempt.id,
        retry_no: retryNo + 1,
        error_code: outcome.error_code,
      });
      try {
        await wait(
          WORKER_RUNTIME_DEFAULTS.imageNotDispatchedRetryBaseMs * 2 ** retryNo,
          undefined,
          {
            signal: this.writeFence.signal,
          },
        );
      } catch {
        if (!this.writeFence.isWriteAllowed()) return 'handled';
        throw new Error('IMAGE_PRE_DISPATCH_RETRY_WAIT_FAILED');
      }
    }

    if (outcome.kind === 'not_dispatched') {
      await this.failNotDispatched(owned, allocation.attempt.id, outcome.error_code);
      return 'handled';
    }
    if (outcome.kind === 'outcome_unknown' || outcome.kind === 'accepted') {
      await this.markUnknown(
        owned,
        allocation.attempt.id,
        outcome.kind === 'accepted' ? 'IMAGE_ASYNC_OUTCOME_UNSUPPORTED' : outcome.error_code,
        outcome.provider_request_id,
        outcome.kind === 'outcome_unknown' ? outcome : undefined,
      );
      return 'handled';
    }
    if (outcome.kind === 'failed') {
      await this.failAccepted(owned, allocation.attempt.id, outcome);
      return 'handled';
    }

    await this.persistAcceptedReceipt(allocation.attempt.id, outcome);
    try {
      await this.ingestService.ingest({
        taskId: owned.task.id,
        workflowRunId: owned.workflow.id,
        userId: owned.workflow.userId,
        attemptId: allocation.attempt.id,
        traceId: payload.trace_id,
        outcome,
      });
    } catch (error) {
      this.logStageFailure(payload, owned.task.id, allocation.attempt.id, 'ingest', error);
      await this.markUnknown(
        owned,
        allocation.attempt.id,
        'IMAGE_OUTPUT_INGEST_UNKNOWN',
        outcome.provider_request_id,
      );
    }
    return 'handled';
  }

  private logStageFailure(
    payload: TaskPayload,
    taskId: string,
    attemptId: string,
    stage: 'dispatch' | 'ingest',
    error: unknown,
  ): void {
    const validationIssues = safeValidationIssues(error);
    this.telemetry.error({
      event: 'image_pipeline_stage_failed',
      metric: 'image_pipeline_failure_total',
      trace_id: payload.trace_id,
      task_id_hash: telemetryId(taskId),
      attempt_id: attemptId,
      stage,
      error_code: stableErrorCode(error),
      ...(validationIssues ? { validation_issues: validationIssues } : {}),
    });
  }

  private async canDispatchAgain(
    owned: NonNullable<Awaited<ReturnType<ImagePipelineService['readOwned']>>>,
    attemptId: string,
  ): Promise<boolean> {
    const [attempt, task, workflow] = await Promise.all([
      this.database.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, attemptId),
        columns: { status: true, dispatchState: true },
      }),
      this.database.query.tasks.findFirst({
        where: and(eq(tasks.id, owned.task.id), eq(tasks.workflowRunId, owned.workflow.id)),
        columns: { status: true },
      }),
      this.database.query.workflowRuns.findFirst({
        where: and(
          eq(workflowRuns.id, owned.workflow.id),
          eq(workflowRuns.userId, owned.workflow.userId),
        ),
        columns: { status: true },
      }),
    ]);
    return (
      this.writeFence.isWriteAllowed() &&
      attempt?.status === 'dispatching' &&
      attempt.dispatchState === 'not_dispatched' &&
      task?.status === 'running' &&
      workflow?.status === 'running'
    );
  }

  private async readOwned(payload: TaskPayload) {
    const [owned] = await this.database
      .select({
        task: tasks,
        workflow: workflowRuns,
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
    if (!owned) return null;
    const model = owned.task.modelId
      ? await this.database.query.models.findFirst({
          where: (table, { eq }) => eq(table.id, owned.task.modelId!),
          columns: { provider: true },
        })
      : undefined;
    if (['image.generate', 'image.edit'].includes(owned.task.type) && !model) {
      throw new Error('IMAGE_TASK_MODEL_MISSING');
    }
    return { ...owned, modelProvider: model?.provider ?? 'unknown' };
  }

  private async markPotentiallyDispatched(attemptId: string): Promise<boolean> {
    this.writeFence.assertWritesAllowed();
    const [updated] = await this.database
      .update(taskAttempts)
      .set({ status: 'accepted', dispatchState: 'accepted', acceptedAt: new Date() })
      .where(
        and(
          eq(taskAttempts.id, attemptId),
          eq(taskAttempts.status, 'dispatching'),
          eq(taskAttempts.dispatchState, 'not_dispatched'),
        ),
      )
      .returning({ id: taskAttempts.id });
    return updated !== undefined;
  }

  private async persistAcceptedReceipt(
    attemptId: string,
    outcome: Extract<ProviderImageExecutionOutcome, { kind: 'succeeded' }>,
  ): Promise<void> {
    this.writeFence.assertWritesAllowed();
    const [updated] = await this.database
      .update(taskAttempts)
      .set({
        providerRequestId: outcome.provider_request_id,
        providerReceipt: outcome.receipt_summary,
        acceptedAt: outcome.accepted_at,
      })
      .where(
        and(
          eq(taskAttempts.id, attemptId),
          eq(taskAttempts.status, 'accepted'),
          eq(taskAttempts.dispatchState, 'accepted'),
        ),
      )
      .returning({ id: taskAttempts.id });
    if (!updated) throw new Error('IMAGE_ACCEPTED_RECEIPT_CAS_FAILED');
  }

  private async failNotDispatched(
    owned: NonNullable<Awaited<ReturnType<ImagePipelineService['readOwned']>>>,
    attemptId: string,
    errorCode: string,
  ): Promise<void> {
    this.writeFence.assertWritesAllowed();
    await this.database.transaction(async (transaction) => {
      await this.attempts.advanceInTransaction(transaction, {
        attemptId,
        expectedStatus: 'dispatching',
        expectedDispatchState: 'not_dispatched',
        status: 'failed',
        dispatchState: 'not_dispatched',
        now: new Date(),
        errorCode,
      });
      await this.failTaskInTransaction(transaction, owned, attemptId, errorCode);
    });
  }

  private async failAccepted(
    owned: NonNullable<Awaited<ReturnType<ImagePipelineService['readOwned']>>>,
    attemptId: string,
    outcome: Extract<ProviderImageExecutionOutcome, { kind: 'failed' }>,
  ): Promise<void> {
    this.writeFence.assertWritesAllowed();
    await this.database.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(taskAttempts)
        .set({
          status: 'failed',
          providerRequestId: outcome.provider_request_id,
          providerReceipt: outcome.receipt_summary,
          rawErrorSummary: { error_code: outcome.error_code },
          endedAt: outcome.failed_at,
        })
        .where(
          and(
            eq(taskAttempts.id, attemptId),
            eq(taskAttempts.status, 'accepted'),
            eq(taskAttempts.dispatchState, 'accepted'),
          ),
        )
        .returning({ id: taskAttempts.id });
      if (!updated) throw new Error('IMAGE_FAILED_RECEIPT_CAS_FAILED');
      await this.failTaskInTransaction(transaction, owned, attemptId, outcome.error_code);
    });
  }

  private async recoverFailedTask(
    owned: NonNullable<Awaited<ReturnType<ImagePipelineService['readOwned']>>>,
    attemptId: string,
    errorCode: string,
  ): Promise<void> {
    this.writeFence.assertWritesAllowed();
    await this.database.transaction((transaction) =>
      this.failTaskInTransaction(transaction, owned, attemptId, errorCode),
    );
  }

  private async failTaskInTransaction(
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
    owned: NonNullable<Awaited<ReturnType<ImagePipelineService['readOwned']>>>,
    attemptId: string,
    errorCode: string,
  ): Promise<void> {
    if (!owned.workflow.reservationId) throw new Error('IMAGE_RESERVATION_MISSING');
    await advanceTaskInTransaction(transaction, {
      taskId: owned.task.id,
      workflowRunId: owned.workflow.id,
      userId: owned.workflow.userId,
      from: 'running',
      to: 'failed',
      now: new Date(),
      errorCode,
      settlement: {
        taskAttemptId: attemptId,
        reservationId: owned.workflow.reservationId,
        artifactIds: [],
      },
    });
    const pendingChildren = await transaction.query.tasks.findMany({
      where: and(
        eq(tasks.parentTaskId, owned.task.id),
        inArray(tasks.status, ['pending', 'queued']),
      ),
      columns: { id: true, status: true },
    });
    for (const child of pendingChildren) {
      await advanceTaskInTransaction(transaction, {
        taskId: child.id,
        workflowRunId: owned.workflow.id,
        userId: owned.workflow.userId,
        from: child.status,
        to: 'cancelled',
        now: new Date(),
        errorCode: 'UPSTREAM_TASK_FAILED',
      });
    }
  }

  private async markUnknown(
    owned: NonNullable<Awaited<ReturnType<ImagePipelineService['readOwned']>>>,
    attemptId: string,
    errorCode: string,
    providerRequestId?: string,
    diagnostics?: Extract<ProviderImageExecutionOutcome, { kind: 'outcome_unknown' }>,
  ): Promise<void> {
    this.writeFence.assertWritesAllowed();
    await this.database.transaction(async (transaction) => {
      const [attempt] = await transaction
        .select()
        .from(taskAttempts)
        .where(eq(taskAttempts.id, attemptId))
        .for('update')
        .limit(1);
      if (!attempt) throw new Error('IMAGE_UNKNOWN_ATTEMPT_MISSING');
      if (attempt.status !== 'outcome_unknown') {
        const eligible = ['dispatching', 'accepted'].includes(attempt.status);
        if (!eligible) throw new Error('IMAGE_UNKNOWN_TRANSITION_INVALID');
        const [updated] = await transaction
          .update(taskAttempts)
          .set({
            status: 'outcome_unknown',
            dispatchState: 'outcome_unknown',
            ...(providerRequestId ? { providerRequestId } : {}),
            rawErrorSummary: {
              error_code: errorCode,
              ...(diagnostics?.diagnostic_code
                ? { diagnostic_code: diagnostics.diagnostic_code }
                : {}),
              ...(diagnostics?.diagnostic_details
                ? { diagnostic_details: diagnostics.diagnostic_details }
                : {}),
            },
            endedAt: new Date(),
          })
          .where(and(eq(taskAttempts.id, attemptId), eq(taskAttempts.status, attempt.status)))
          .returning({ id: taskAttempts.id });
        if (!updated) throw new Error('IMAGE_UNKNOWN_CAS_FAILED');
      }
      const currentTask = await transaction.query.tasks.findFirst({
        where: eq(tasks.id, owned.task.id),
      });
      if (currentTask?.status === 'waiting_manual_review') return;
      if (currentTask?.status !== 'running') throw new Error('IMAGE_UNKNOWN_TASK_STATE_INVALID');
      await advanceTaskInTransaction(transaction, {
        taskId: owned.task.id,
        workflowRunId: owned.workflow.id,
        userId: owned.workflow.userId,
        from: 'running',
        to: 'waiting_manual_review',
        now: new Date(),
        errorCode,
      });
    });
  }
}

const TRANSIENT_NOT_DISPATCHED_ERRORS = new Set([
  'provider_unavailable',
  'provider_rate_limited',
  'provider_timeout',
  'provider_internal_error',
]);

function attemptErrorCode(
  attempt: typeof taskAttempts.$inferSelect,
  fallback = 'IMAGE_PROVIDER_FAILED_RECOVERY',
): string {
  const summary = attempt.rawErrorSummary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return fallback;
  const code = (summary as Record<string, unknown>).error_code;
  return typeof code === 'string' && code.length > 0 ? code : fallback;
}
