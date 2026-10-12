import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  models,
  or,
  providerCallbackEvents,
  sql,
  taskAttempts,
  tasks,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import {
  modelSnapshotSchema,
  type ModelSnapshot,
  type ProviderCallContext,
  type ProviderCapability,
  type ProviderErrorCode,
  type ProviderGateway,
  ProviderGatewayError,
  ProviderOutcomeRecordingError,
  type ProviderPollOutcome,
  type ProviderSubmitOutcome,
} from '@ecom-forge/provider';
import {
  compositeJobId,
  createQueueIntentInTransaction,
  type QueuePayload,
} from '@ecom-forge/queue';
import {
  NOOP_EVENT_WAKE_PUBLISHER,
  type EventWake,
  type EventWakePublisher,
} from '@ecom-forge/shared';

import { TaskAttemptRepository } from '../database/attempt.repository.js';
import { advanceTaskInTransaction } from '../database/workflow-state.repository.js';
import type { WorkerWriteFence } from '../lifecycle/processing-fence.js';
import {
  ProviderCircuitOpenError,
  ProviderCircuitRepository,
} from './provider-circuit.repository.js';
import { ProviderQuotaUnavailableError } from './redis-provider-quota.gate.js';

type PollPayload = Extract<QueuePayload, { job_type: 'provider.poll' }>;

export type ProviderSubmitResult =
  | { action: 'already_in_progress' | 'already_terminal'; attemptId: string }
  | { action: 'recorded'; attemptId: string; outcome: ProviderSubmitOutcome };

export type ProviderPollResult =
  | { action: 'no_op' }
  | { action: 'retry_scheduled'; retryAt: Date }
  | { action: 'recorded'; outcome: ProviderPollOutcome };

function preDispatchErrorCode(error: unknown): ProviderErrorCode {
  if (error instanceof ProviderGatewayError) {
    return error.code === 'PROVIDER_INPUT_INVALID'
      ? 'provider_request_invalid'
      : 'provider_unavailable';
  }
  if (typeof error === 'object' && error !== null) {
    const code = 'code' in error ? error.code : undefined;
    if (code === 'PROVIDER_QUOTA_EXCEEDED') return 'provider_rate_limited';
  }
  return 'provider_unavailable';
}

function modelSnapshot(row: typeof models.$inferSelect): ModelSnapshot {
  return modelSnapshotSchema.parse({
    id: row.id,
    provider: row.provider,
    model_id: row.modelId,
    version: row.version,
    status: row.status,
    capability_contract: row.capabilityContractJson,
    pricing: row.pricingJson,
    quota: row.quotaJson,
  });
}

function receiptSummary(
  outcome: ProviderSubmitOutcome | ProviderPollOutcome,
): Record<string, unknown> {
  if ('receipt_summary' in outcome) return outcome.receipt_summary;
  return {};
}

export class ProviderAttemptService {
  private readonly attempts: TaskAttemptRepository;

  constructor(
    private readonly database: Database,
    private readonly gateway: ProviderGateway,
    private readonly now: () => Date = () => new Date(),
    private readonly writeFence?: WorkerWriteFence,
    private readonly circuits: ProviderCircuitRepository = new ProviderCircuitRepository(
      database,
      now,
    ),
    private readonly eventWakePublisher: EventWakePublisher = NOOP_EVENT_WAKE_PUBLISHER,
  ) {
    this.attempts = new TaskAttemptRepository(database);
  }

  async submit(input: {
    attemptId: string;
    capability: ProviderCapability;
    providerInput: unknown;
    context: ProviderCallContext;
  }): Promise<ProviderSubmitResult> {
    const owned = await this.readOwnedAttempt(input.attemptId);
    if (['succeeded', 'failed', 'timeout', 'outcome_unknown'].includes(owned.attempt.status)) {
      return { action: 'already_terminal', attemptId: owned.attempt.id };
    }
    if (owned.attempt.status === 'dispatching') {
      return { action: 'already_in_progress', attemptId: owned.attempt.id };
    }
    if (owned.attempt.status !== 'created' || owned.attempt.dispatchState !== 'not_dispatched') {
      throw new Error('Task attempt is not eligible for Provider submit');
    }

    const claimed = await this.attempts.advance({
      attemptId: owned.attempt.id,
      expectedStatus: 'created',
      expectedDispatchState: 'not_dispatched',
      status: 'dispatching',
      dispatchState: 'not_dispatched',
      now: this.now(),
    });
    if (claimed === 'already_applied') {
      return { action: 'already_in_progress', attemptId: owned.attempt.id };
    }
    let outcome: ProviderSubmitOutcome;
    try {
      outcome = await this.gateway.submit(
        owned.model,
        { capability: input.capability, input: input.providerInput },
        input.context,
      );
    } catch (error) {
      if (error instanceof ProviderOutcomeRecordingError) {
        this.assertWritesAllowed();
        await this.persistSubmitOutcome(
          owned.attempt.id,
          owned.model,
          error.outcome,
          input.context.traceId,
        );
        throw error;
      }
      this.assertWritesAllowed();
      await this.persistNotDispatched(
        owned.attempt.id,
        {
          kind: 'not_dispatched',
          error_code: preDispatchErrorCode(error),
          retryable: false,
          request_digest: input.context.requestDigest,
        },
        input.context.traceId,
        error instanceof ProviderCircuitOpenError ? 'blocked' : 'failed',
      );
      throw error;
    }
    this.assertWritesAllowed();
    await this.persistSubmitOutcome(owned.attempt.id, owned.model, outcome, input.context.traceId);
    return { action: 'recorded', attemptId: owned.attempt.id, outcome };
  }

  async poll(payload: PollPayload, context: ProviderCallContext): Promise<ProviderPollResult> {
    const owned = await this.readOwnedAttempt(payload.task_attempt_id);
    if (owned.attempt.status !== 'accepted' && owned.attempt.status !== 'polling') {
      return { action: 'no_op' };
    }
    if (owned.attempt.dispatchState !== 'accepted' || !owned.attempt.providerRequestId) {
      throw new Error('Provider poll requires an accepted request ID');
    }
    if (payload.poll_no !== owned.attempt.pollCount + 1) {
      if (payload.poll_no <= owned.attempt.pollCount) return { action: 'no_op' };
      throw new Error('Provider poll sequence is ahead of database state');
    }
    if (!owned.attempt.acceptedAt) throw new Error('Accepted attempt is missing accepted_at');
    const terminalDeadline = new Date(
      owned.attempt.acceptedAt.getTime() + owned.model.quota.terminal_timeout_ms,
    );
    if (this.now().getTime() >= terminalDeadline.getTime()) {
      await this.markPollUnknown(owned.attempt.id, owned.attempt.status, 'provider_timeout');
      return {
        action: 'recorded',
        outcome: {
          kind: 'outcome_unknown',
          provider_request_id: owned.attempt.providerRequestId,
          error_code: 'provider_timeout',
          request_digest: context.requestDigest,
          unknown_at: this.now(),
        },
      };
    }

    const reserved = await this.database
      .update(taskAttempts)
      .set({
        status: 'polling',
        pollCount: payload.poll_no,
        lastPolledAt: this.now(),
        nextPollAt: null,
      })
      .where(
        and(
          eq(taskAttempts.id, owned.attempt.id),
          eq(taskAttempts.status, owned.attempt.status),
          eq(taskAttempts.dispatchState, 'accepted'),
          eq(taskAttempts.pollCount, payload.poll_no - 1),
        ),
      )
      .returning({ id: taskAttempts.id });
    if (!reserved[0]) return { action: 'no_op' };

    const pollDeadline = new Date(
      Math.min(context.deadlineAt.getTime(), terminalDeadline.getTime()),
    );
    let outcome: ProviderPollOutcome;
    try {
      outcome = await this.gateway.poll(
        owned.model,
        { providerRequestId: owned.attempt.providerRequestId },
        { ...context, deadlineAt: pollDeadline },
      );
    } catch (error) {
      if (error instanceof ProviderQuotaUnavailableError) {
        const retryAt = new Date(
          Math.min(
            this.now().getTime() + owned.model.quota.poll_interval_ms,
            terminalDeadline.getTime(),
          ),
        );
        this.assertWritesAllowed();
        const restored = await this.database
          .update(taskAttempts)
          .set({
            status: owned.attempt.status,
            pollCount: payload.poll_no - 1,
            nextPollAt: retryAt,
          })
          .where(
            and(
              eq(taskAttempts.id, owned.attempt.id),
              eq(taskAttempts.status, 'polling'),
              eq(taskAttempts.dispatchState, 'accepted'),
              eq(taskAttempts.pollCount, payload.poll_no),
              isNull(taskAttempts.nextPollAt),
            ),
          )
          .returning({ id: taskAttempts.id });
        if (!restored[0]) return { action: 'no_op' };
        return { action: 'retry_scheduled', retryAt };
      }
      throw error;
    }
    this.assertWritesAllowed();
    await this.persistPollOutcome(owned.attempt.id, owned.model, payload, outcome, context.traceId);
    return { action: 'recorded', outcome };
  }

  async recoverStaleDispatching(input: {
    before: Date;
    imageBefore?: Date;
    limit: number;
  }): Promise<number> {
    const imageBefore = input.imageBefore ?? input.before;
    const stale = await this.database
      .select({ attempt: taskAttempts, taskType: tasks.type })
      .from(taskAttempts)
      .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
      .where(
        and(
          eq(taskAttempts.status, 'dispatching'),
          eq(taskAttempts.dispatchState, 'not_dispatched'),
          or(
            and(
              inArray(tasks.type, ['image.generate', 'image.edit']),
              lte(taskAttempts.startedAt, imageBefore),
            ),
            and(
              sql`${tasks.type} not in ('image.generate', 'image.edit')`,
              lte(taskAttempts.startedAt, input.before),
            ),
          ),
        ),
      )
      .orderBy(asc(taskAttempts.startedAt), asc(taskAttempts.id))
      .limit(input.limit);
    let recovered = 0;
    for (const row of stale) {
      const attempt = row.attempt;
      const staleBefore =
        row.taskType === 'image.generate' || row.taskType === 'image.edit'
          ? imageBefore
          : input.before;
      const owned = await this.readOwnedAttempt(attempt.id);
      const result = await this.database.transaction(async (transaction) => {
        this.assertWritesAllowed();
        const [stillStale] = await transaction
          .select({ id: taskAttempts.id })
          .from(taskAttempts)
          .where(
            and(
              eq(taskAttempts.id, attempt.id),
              eq(taskAttempts.status, 'dispatching'),
              eq(taskAttempts.dispatchState, 'not_dispatched'),
              lte(taskAttempts.startedAt, staleBefore),
            ),
          )
          .for('update')
          .limit(1);
        if (!stillStale) {
          return { advanced: 'already_applied' as const, wake: null };
        }
        const advanced = await this.attempts.advanceInTransaction(transaction, {
          attemptId: attempt.id,
          expectedStatus: 'dispatching',
          expectedDispatchState: 'not_dispatched',
          status: 'outcome_unknown',
          dispatchState: 'outcome_unknown',
          now: this.now(),
          errorCode: 'provider_timeout',
        });
        let wake: EventWake | null = null;
        if (advanced === 'advanced') {
          wake = await this.finalizeOwnedTaskInTransaction(transaction, {
            taskId: owned.task.id,
            attemptId: attempt.id,
            target: 'waiting_manual_review',
            errorCode: 'provider_timeout',
          });
          await this.circuits.recordTerminalEvidenceInTransaction(transaction, owned.model, {
            kind: 'outcome_unknown',
            errorCode: 'provider_timeout',
          });
        }
        return { advanced, wake };
      });
      await this.publishWake(result.wake);
      if (result.advanced === 'advanced') recovered += 1;
    }
    return recovered;
  }

  async recoverStalePolling(input: { before: Date; limit: number }): Promise<number> {
    const stale = await this.database.query.taskAttempts.findMany({
      where: and(
        eq(taskAttempts.status, 'polling'),
        eq(taskAttempts.dispatchState, 'accepted'),
        isNull(taskAttempts.nextPollAt),
        lte(taskAttempts.lastPolledAt, input.before),
      ),
      orderBy: (attempt, { asc }) => [asc(attempt.lastPolledAt), asc(attempt.id)],
      limit: input.limit,
    });
    let recovered = 0;
    for (const attempt of stale) {
      const owned = await this.readOwnedAttempt(attempt.id);
      const result = await this.database.transaction(async (transaction) => {
        this.assertWritesAllowed();
        const [stillStale] = await transaction
          .select({ id: taskAttempts.id })
          .from(taskAttempts)
          .where(
            and(
              eq(taskAttempts.id, attempt.id),
              eq(taskAttempts.status, 'polling'),
              eq(taskAttempts.dispatchState, 'accepted'),
              isNull(taskAttempts.nextPollAt),
              lte(taskAttempts.lastPolledAt, input.before),
            ),
          )
          .for('update')
          .limit(1);
        if (!stillStale) {
          return { advanced: 'already_applied' as const, wake: null };
        }
        const advanced = await this.attempts.advanceInTransaction(transaction, {
          attemptId: attempt.id,
          expectedStatus: 'polling',
          expectedDispatchState: 'accepted',
          status: 'outcome_unknown',
          dispatchState: 'outcome_unknown',
          now: this.now(),
          errorCode: 'provider_timeout',
        });
        let wake: EventWake | null = null;
        if (advanced === 'advanced') {
          wake = await this.finalizeOwnedTaskInTransaction(transaction, {
            taskId: owned.task.id,
            attemptId: attempt.id,
            target: 'waiting_manual_review',
            errorCode: 'provider_timeout',
          });
          await this.circuits.recordTerminalEvidenceInTransaction(transaction, owned.model, {
            kind: 'outcome_unknown',
            errorCode: 'provider_timeout',
          });
        }
        return { advanced, wake };
      });
      await this.publishWake(result.wake);
      if (result.advanced === 'advanced') recovered += 1;
    }
    return recovered;
  }

  private async readOwnedAttempt(attemptId: string) {
    const [row] = await this.database
      .select({ attempt: taskAttempts, task: tasks, model: models })
      .from(taskAttempts)
      .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
      .innerJoin(models, eq(models.id, tasks.modelId))
      .where(eq(taskAttempts.id, attemptId))
      .limit(1);
    if (!row) throw new Error('Provider attempt ownership could not be resolved');
    if (
      row.task.modelVersion !== row.model.version ||
      row.attempt.provider !== row.model.provider
    ) {
      throw new Error('Provider attempt model snapshot does not match the task');
    }
    return { ...row, model: modelSnapshot(row.model) };
  }

  private assertWritesAllowed(): void {
    this.writeFence?.assertWritesAllowed();
  }

  private async persistSubmitOutcome(
    attemptId: string,
    model: ModelSnapshot,
    outcome: ProviderSubmitOutcome,
    traceId: string,
  ): Promise<void> {
    if (outcome.kind === 'not_dispatched') {
      await this.persistNotDispatched(attemptId, outcome, traceId);
      return;
    }
    if (outcome.kind === 'outcome_unknown') {
      await this.persistDispatchingUnknown(attemptId, outcome);
      return;
    }

    await this.persistAccepted(attemptId, outcome, model, traceId, outcome.kind === 'accepted');
  }

  private async persistAccepted(
    attemptId: string,
    outcome: Extract<ProviderSubmitOutcome, { kind: 'accepted' | 'succeeded' | 'failed' }>,
    model: ModelSnapshot,
    traceId: string,
    schedulePoll: boolean,
  ): Promise<void> {
    const wake = await this.database.transaction(async (transaction) => {
      const acceptedAt = outcome.kind === 'failed' ? outcome.failed_at : outcome.accepted_at;
      const nextPollAt = schedulePoll
        ? new Date(acceptedAt.getTime() + model.quota.poll_initial_delay_ms)
        : null;
      const [updated] = await transaction
        .update(taskAttempts)
        .set({
          status: 'accepted',
          dispatchState: 'accepted',
          ...(outcome.provider_request_id
            ? { providerRequestId: outcome.provider_request_id }
            : {}),
          providerReceipt: receiptSummary(outcome),
          acceptedAt,
          nextPollAt,
        })
        .where(
          and(
            eq(taskAttempts.id, attemptId),
            eq(taskAttempts.status, 'dispatching'),
            eq(taskAttempts.dispatchState, 'not_dispatched'),
          ),
        )
        .returning({ id: taskAttempts.id });
      if (!updated) throw new Error('Provider accepted transition was rejected');
      if (schedulePoll && nextPollAt) {
        await this.createPollIntent(transaction, attemptId, 1, traceId, nextPollAt);
      }
      const retryableCallbacks = outcome.provider_request_id
        ? await transaction.query.providerCallbackEvents.findMany({
            where: and(
              eq(providerCallbackEvents.provider, model.provider),
              eq(providerCallbackEvents.providerRequestId, outcome.provider_request_id),
              eq(providerCallbackEvents.status, 'dead_letter'),
              eq(providerCallbackEvents.errorCode, 'PROVIDER_CALLBACK_UNMATCHED_RETRYABLE'),
              gte(providerCallbackEvents.receivedAt, new Date(this.now().getTime() - 86_400_000)),
            ),
          })
        : [];
      for (const callback of retryableCallbacks) {
        const processingNo = callback.processingCount + 1;
        await createQueueIntentInTransaction(transaction, {
          queueName: 'provider-callback',
          jobId: compositeJobId({
            provider_callback_event_id: callback.id,
            processing_no: processingNo,
          }),
          aggregateType: 'provider_callback_event',
          aggregateId: callback.id,
          payloadVersion: 1,
          payload: {
            schema_version: 1,
            job_type: 'provider.callback.process',
            trace_id: traceId,
            provider_callback_event_id: callback.id,
            processing_no: processingNo,
          },
        });
      }
      if (outcome.kind !== 'accepted') {
        const [terminal] = await transaction
          .update(taskAttempts)
          .set({
            status: outcome.kind === 'succeeded' ? 'succeeded' : 'failed',
            providerReceipt: receiptSummary(outcome),
            ...(outcome.kind === 'succeeded'
              ? outcome.cost_summary
                ? { providerReportedCost: outcome.cost_summary.amount }
                : {}
              : { rawErrorSummary: { error_code: outcome.error_code } }),
            endedAt: this.now(),
            nextPollAt: null,
          })
          .where(
            and(
              eq(taskAttempts.id, attemptId),
              eq(taskAttempts.status, 'accepted'),
              eq(taskAttempts.dispatchState, 'accepted'),
            ),
          )
          .returning({ id: taskAttempts.id });
        if (!terminal) throw new Error('Provider terminal transition was rejected');
        return this.finalizeOwnedTaskInTransaction(transaction, {
          taskId: await this.taskIdForAttempt(transaction, attemptId),
          attemptId,
          target: outcome.kind === 'succeeded' ? 'succeeded' : 'failed',
          ...(outcome.kind === 'failed' ? { errorCode: outcome.error_code } : {}),
          ...(outcome.kind === 'succeeded' && outcome.cost_summary
            ? { providerReportedCost: outcome.cost_summary.amount }
            : {}),
        });
      }
      return null;
    });
    await this.publishWake(wake);
  }

  private async persistPollOutcome(
    attemptId: string,
    model: ModelSnapshot,
    payload: PollPayload,
    outcome: ProviderPollOutcome,
    traceId: string,
  ): Promise<void> {
    if (outcome.kind === 'pending') {
      const nextPollAt = new Date(this.now().getTime() + model.quota.poll_interval_ms);
      const acceptedAt = await this.database.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, attemptId),
        columns: { acceptedAt: true },
      });
      if (!acceptedAt?.acceptedAt) throw new Error('Polling attempt lost accepted_at');
      const deadline = acceptedAt.acceptedAt.getTime() + model.quota.terminal_timeout_ms;
      if (payload.poll_no >= model.quota.max_poll_count || nextPollAt.getTime() >= deadline) {
        await this.markPollUnknown(attemptId, 'polling', 'provider_timeout');
        return;
      }
      await this.database.transaction(async (transaction) => {
        const [updated] = await transaction
          .update(taskAttempts)
          .set({ nextPollAt })
          .where(
            and(
              eq(taskAttempts.id, attemptId),
              eq(taskAttempts.status, 'polling'),
              eq(taskAttempts.pollCount, payload.poll_no),
            ),
          )
          .returning({ id: taskAttempts.id });
        if (!updated) return;
        await this.createPollIntent(
          transaction,
          attemptId,
          payload.poll_no + 1,
          traceId,
          nextPollAt,
        );
      });
      return;
    }
    const wake = await this.database.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(taskAttempts)
        .set({
          status:
            outcome.kind === 'succeeded'
              ? 'succeeded'
              : outcome.kind === 'failed'
                ? 'failed'
                : 'outcome_unknown',
          dispatchState: outcome.kind === 'outcome_unknown' ? 'outcome_unknown' : 'accepted',
          providerReceipt: receiptSummary(outcome),
          ...(outcome.kind === 'succeeded'
            ? outcome.cost_summary
              ? { providerReportedCost: outcome.cost_summary.amount }
              : {}
            : { rawErrorSummary: { error_code: outcome.error_code } }),
          endedAt: this.now(),
          nextPollAt: null,
        })
        .where(
          and(
            eq(taskAttempts.id, attemptId),
            eq(taskAttempts.status, 'polling'),
            eq(taskAttempts.pollCount, payload.poll_no),
          ),
        )
        .returning({ id: taskAttempts.id });
      if (!updated) return null;
      const transitionWake = await this.finalizeOwnedTaskInTransaction(transaction, {
        taskId: await this.taskIdForAttempt(transaction, attemptId),
        attemptId,
        target:
          outcome.kind === 'succeeded'
            ? 'succeeded'
            : outcome.kind === 'failed'
              ? 'failed'
              : 'waiting_manual_review',
        ...(outcome.kind === 'succeeded' ? {} : { errorCode: outcome.error_code }),
        ...(outcome.kind === 'succeeded' && outcome.cost_summary
          ? { providerReportedCost: outcome.cost_summary.amount }
          : {}),
      });
      await this.circuits.recordTerminalEvidenceInTransaction(
        transaction,
        model,
        outcome.kind === 'succeeded'
          ? { kind: 'succeeded' }
          : outcome.kind === 'failed'
            ? { kind: 'failed', errorCode: outcome.error_code }
            : { kind: 'outcome_unknown', errorCode: outcome.error_code },
      );
      return transitionWake;
    });
    await this.publishWake(wake);
  }

  private async markPollUnknown(
    attemptId: string,
    expectedStatus: 'accepted' | 'polling',
    errorCode: ProviderErrorCode,
  ): Promise<void> {
    const owned = await this.readOwnedAttempt(attemptId);
    const wake = await this.database.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(taskAttempts)
        .set({
          status: 'outcome_unknown',
          dispatchState: 'outcome_unknown',
          rawErrorSummary: { error_code: errorCode },
          endedAt: this.now(),
          nextPollAt: null,
        })
        .where(
          and(
            eq(taskAttempts.id, attemptId),
            eq(taskAttempts.status, expectedStatus),
            eq(taskAttempts.dispatchState, 'accepted'),
          ),
        )
        .returning({ id: taskAttempts.id });
      if (!updated) return null;
      const transitionWake = await this.finalizeOwnedTaskInTransaction(transaction, {
        taskId: owned.task.id,
        attemptId,
        target: 'waiting_manual_review',
        errorCode,
      });
      await this.circuits.recordTerminalEvidenceInTransaction(transaction, owned.model, {
        kind: 'outcome_unknown',
        errorCode,
      });
      return transitionWake;
    });
    await this.publishWake(wake);
  }

  private async persistNotDispatched(
    attemptId: string,
    outcome: Extract<ProviderSubmitOutcome, { kind: 'not_dispatched' }>,
    traceId: string,
    terminalTaskTarget: 'failed' | 'blocked' = 'failed',
  ): Promise<void> {
    const wake = await this.database.transaction(async (transaction) => {
      const [owned] = await transaction
        .select({ attempt: taskAttempts, task: tasks, workflow: workflowRuns })
        .from(taskAttempts)
        .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
        .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
        .where(eq(taskAttempts.id, attemptId))
        .for('update')
        .limit(1);
      if (!owned) throw new Error('Provider attempt ownership could not be resolved');
      const [updated] = await transaction
        .update(taskAttempts)
        .set({
          status: 'failed',
          dispatchState: 'not_dispatched',
          rawErrorSummary: { error_code: outcome.error_code, retryable: outcome.retryable },
          endedAt: this.now(),
        })
        .where(
          and(
            eq(taskAttempts.id, attemptId),
            eq(taskAttempts.status, 'dispatching'),
            eq(taskAttempts.dispatchState, 'not_dispatched'),
          ),
        )
        .returning({ id: taskAttempts.id });
      if (!updated) throw new Error('Provider dispatching transition was rejected');
      if (!outcome.retryable || owned.attempt.attemptNo >= 3) {
        return this.finalizeOwnedTaskInTransaction(transaction, {
          taskId: owned.task.id,
          attemptId,
          target: terminalTaskTarget,
          errorCode: outcome.error_code,
        });
      }

      const [retry] = await transaction
        .insert(taskAttempts)
        .values({
          taskId: owned.task.id,
          attemptNo: owned.attempt.attemptNo + 1,
          provider: owned.attempt.provider,
        })
        .returning({ id: taskAttempts.id });
      if (!retry) throw new Error('Provider retry attempt was not created');
      await createQueueIntentInTransaction(transaction, {
        queueName: 'task',
        jobId: retry.id,
        aggregateType: 'task_attempt',
        aggregateId: retry.id,
        payloadVersion: 1,
        payload: {
          schema_version: 1,
          job_type: 'task.execute',
          trace_id: traceId,
          task_id: owned.task.id,
          workflow_run_id: owned.workflow.id,
          task_attempt_id: retry.id,
          user_id: owned.workflow.userId,
        },
      });
      return null;
    });
    await this.publishWake(wake);
  }

  private createPollIntent(
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
    attemptId: string,
    pollNo: number,
    traceId: string,
    nextAttemptAt: Date,
  ) {
    return createQueueIntentInTransaction(transaction, {
      queueName: 'provider-callback',
      jobId: compositeJobId({ task_attempt_id: attemptId, poll_no: pollNo }),
      aggregateType: 'task_attempt',
      aggregateId: attemptId,
      payloadVersion: 1,
      payload: {
        schema_version: 1,
        job_type: 'provider.poll',
        trace_id: traceId,
        task_attempt_id: attemptId,
        poll_no: pollNo,
      },
      nextAttemptAt,
    });
  }

  private async persistDispatchingUnknown(
    attemptId: string,
    outcome: Extract<ProviderSubmitOutcome, { kind: 'outcome_unknown' }>,
  ): Promise<void> {
    const owned = await this.readOwnedAttempt(attemptId);
    const wake = await this.database.transaction(async (transaction) => {
      const advanced = await this.attempts.advanceInTransaction(transaction, {
        attemptId,
        expectedStatus: 'dispatching',
        expectedDispatchState: 'not_dispatched',
        status: 'outcome_unknown',
        dispatchState: 'outcome_unknown',
        now: this.now(),
        errorCode: outcome.error_code,
      });
      if (advanced !== 'advanced') return null;
      if (outcome.provider_request_id) {
        await transaction
          .update(taskAttempts)
          .set({ providerRequestId: outcome.provider_request_id })
          .where(eq(taskAttempts.id, attemptId));
      }
      return this.finalizeOwnedTaskInTransaction(transaction, {
        taskId: owned.task.id,
        attemptId,
        target: 'waiting_manual_review',
        errorCode: outcome.error_code,
      });
    });
    await this.publishWake(wake);
  }

  private async taskIdForAttempt(
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
    attemptId: string,
  ): Promise<string> {
    const attempt = await transaction.query.taskAttempts.findFirst({
      where: eq(taskAttempts.id, attemptId),
      columns: { taskId: true },
    });
    if (!attempt) throw new Error('Task attempt does not exist');
    return attempt.taskId;
  }

  private async finalizeOwnedTaskInTransaction(
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
    input: {
      taskId: string;
      attemptId: string;
      target: 'succeeded' | 'failed' | 'blocked' | 'waiting_manual_review';
      errorCode?: string;
      providerReportedCost?: string;
    },
  ): Promise<EventWake | null> {
    const [owned] = await transaction
      .select({ task: tasks, workflow: workflowRuns })
      .from(tasks)
      .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
      .where(eq(tasks.id, input.taskId))
      .limit(1);
    if (!owned) throw new Error('Provider task ownership could not be resolved');
    if (owned.task.status !== 'running') {
      if (owned.task.status === input.target) return null;
      throw new Error(`Provider task transition rejected from ${owned.task.status}`);
    }
    const result = await advanceTaskInTransaction(transaction, {
      taskId: owned.task.id,
      workflowRunId: owned.workflow.id,
      userId: owned.workflow.userId,
      from: 'running',
      to: input.target,
      now: this.now(),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(owned.workflow.reservationId && input.target !== 'waiting_manual_review'
        ? {
            settlement: {
              taskAttemptId: input.attemptId,
              reservationId: owned.workflow.reservationId,
              ...(input.providerReportedCost
                ? { providerReportedCost: input.providerReportedCost }
                : {}),
              artifactIds: [],
            },
          }
        : {}),
    });
    return result.wake;
  }

  private async publishWake(wake: EventWake | null): Promise<void> {
    if (wake) await this.eventWakePublisher.publish(wake).catch(() => undefined);
  }
}
