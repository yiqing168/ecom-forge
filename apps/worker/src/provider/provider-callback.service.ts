import {
  and,
  asc,
  eq,
  gte,
  inArray,
  lte,
  providerCallbackEvents,
  models,
  taskAttempts,
  tasks,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import { verifiedProviderCallbackSchema } from '@ecom-forge/provider';
import { modelSnapshotSchema } from '@ecom-forge/provider';
import {
  compositeJobId,
  createQueueIntentInTransaction,
  type QueuePayload,
} from '@ecom-forge/queue';
import { NOOP_EVENT_WAKE_PUBLISHER, type EventWakePublisher } from '@ecom-forge/shared';

import { advanceTaskInTransaction } from '../database/workflow-state.repository.js';
import { ProviderCircuitRepository } from './provider-circuit.repository.js';

type CallbackPayload = Extract<QueuePayload, { job_type: 'provider.callback.process' }>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const UNMATCHED_RETRYABLE = 'PROVIDER_CALLBACK_UNMATCHED_RETRYABLE';
const UNMATCHED_EXPIRED = 'PROVIDER_CALLBACK_UNMATCHED_EXPIRED';
const MATCH_WINDOW_MS = 24 * 60 * 60 * 1_000;
const RETRY_DELAY_MS = 30_000;

export class ProviderCallbackSequenceError extends Error {
  constructor() {
    super('Provider callback processing sequence is ahead of database state');
    this.name = 'ProviderCallbackSequenceError';
  }
}

export type ProviderCallbackProcessResult =
  | { action: 'processed'; outcome: 'succeeded' | 'failed'; providerReportedCost?: string }
  | { action: 'unmatched_retryable' | 'dead_letter' | 'no_op' };

export class ProviderCallbackService {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
    private readonly circuits: ProviderCircuitRepository = new ProviderCircuitRepository(
      database,
      now,
    ),
    private readonly eventWakePublisher: EventWakePublisher = NOOP_EVENT_WAKE_PUBLISHER,
  ) {}

  async process(payload: CallbackPayload): Promise<ProviderCallbackProcessResult> {
    const result = await this.database.transaction(async (transaction) => {
      const [event] = await transaction
        .select()
        .from(providerCallbackEvents)
        .where(eq(providerCallbackEvents.id, payload.provider_callback_event_id))
        .for('update')
        .limit(1);
      if (!event || event.status === 'processed') return { action: 'no_op' as const };
      if (event.status === 'dead_letter' && event.nextProcessAt === null) {
        return { action: 'no_op' as const };
      }
      if (payload.processing_no <= event.processingCount) return { action: 'no_op' as const };
      if (payload.processing_no !== event.processingCount + 1) {
        throw new ProviderCallbackSequenceError();
      }

      const callback = verifiedProviderCallbackSchema.safeParse(event.normalizedPayloadJson);
      if (!callback.success || !event.providerRequestId) {
        await this.markDeadLetter(
          transaction,
          event.id,
          payload.processing_no,
          'PROVIDER_CALLBACK_PAYLOAD_INVALID',
        );
        return { action: 'dead_letter' as const };
      }
      const [owned] = await transaction
        .select({ attempt: taskAttempts, task: tasks, model: models })
        .from(taskAttempts)
        .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
        .innerJoin(models, eq(models.id, tasks.modelId))
        .where(
          and(
            eq(taskAttempts.provider, event.provider),
            eq(taskAttempts.providerRequestId, event.providerRequestId),
          ),
        )
        .for('update')
        .limit(1);
      if (!owned) {
        const expired = this.now().getTime() - event.receivedAt.getTime() >= MATCH_WINDOW_MS;
        await transaction
          .update(providerCallbackEvents)
          .set({
            status: 'dead_letter',
            errorCode: expired ? UNMATCHED_EXPIRED : UNMATCHED_RETRYABLE,
            processingCount: payload.processing_no,
            nextProcessAt: expired ? null : new Date(this.now().getTime() + RETRY_DELAY_MS),
          })
          .where(eq(providerCallbackEvents.id, event.id));
        return { action: expired ? ('dead_letter' as const) : ('unmatched_retryable' as const) };
      }
      const { attempt } = owned;
      if (
        attempt.dispatchState !== 'accepted' ||
        !['accepted', 'polling'].includes(attempt.status)
      ) {
        await this.markDeadLetter(
          transaction,
          event.id,
          payload.processing_no,
          attempt.status === 'outcome_unknown'
            ? 'PROVIDER_CALLBACK_LATE_UNKNOWN'
            : 'PROVIDER_CALLBACK_TERMINAL_CONFLICT',
          attempt.id,
        );
        return { action: 'dead_letter' as const };
      }

      const outcome = callback.data;
      const [updated] = await transaction
        .update(taskAttempts)
        .set({
          status: outcome.kind === 'succeeded' ? 'succeeded' : 'failed',
          providerReceipt: outcome.receipt_summary,
          ...(outcome.kind === 'succeeded'
            ? outcome.cost_summary
              ? { providerReportedCost: outcome.cost_summary.amount }
              : {}
            : { rawErrorSummary: { error_code: outcome.error_code } }),
          endedAt: outcome.kind === 'succeeded' ? outcome.completed_at : outcome.failed_at,
          nextPollAt: null,
        })
        .where(
          and(
            eq(taskAttempts.id, attempt.id),
            inArray(taskAttempts.status, ['accepted', 'polling']),
            eq(taskAttempts.dispatchState, 'accepted'),
          ),
        )
        .returning({ id: taskAttempts.id });
      if (!updated) {
        await this.markDeadLetter(
          transaction,
          event.id,
          payload.processing_no,
          'PROVIDER_CALLBACK_STATE_CONFLICT',
          attempt.id,
        );
        return { action: 'dead_letter' as const };
      }
      const model = modelSnapshotSchema.parse({
        id: owned.model.id,
        provider: owned.model.provider,
        model_id: owned.model.modelId,
        version: owned.model.version,
        status: owned.model.status,
        capability_contract: owned.model.capabilityContractJson,
        pricing: owned.model.pricingJson,
        quota: owned.model.quotaJson,
      });
      await this.circuits.recordTerminalEvidenceInTransaction(
        transaction,
        model,
        outcome.kind === 'succeeded'
          ? { kind: 'succeeded' }
          : { kind: 'failed', errorCode: outcome.error_code },
      );
      const workflow = await transaction.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, owned.task.workflowRunId),
      });
      if (!workflow) throw new Error('Provider callback workflow ownership could not be resolved');
      if (owned.task.status !== 'running') {
        throw new Error(`Provider callback task transition rejected from ${owned.task.status}`);
      }
      const transition = await advanceTaskInTransaction(transaction, {
        taskId: owned.task.id,
        workflowRunId: workflow.id,
        userId: workflow.userId,
        from: 'running',
        to: outcome.kind === 'succeeded' ? 'succeeded' : 'failed',
        now: this.now(),
        ...(outcome.kind === 'failed' ? { errorCode: outcome.error_code } : {}),
        ...(workflow.reservationId
          ? {
              settlement: {
                taskAttemptId: attempt.id,
                reservationId: workflow.reservationId,
                ...(outcome.kind === 'succeeded' && outcome.cost_summary
                  ? { providerReportedCost: outcome.cost_summary.amount }
                  : {}),
                artifactIds: [],
              },
            }
          : {}),
      });
      await transaction
        .update(providerCallbackEvents)
        .set({
          status: 'processed',
          taskAttemptId: attempt.id,
          processingCount: payload.processing_no,
          nextProcessAt: null,
          errorCode: null,
          processedAt: this.now(),
        })
        .where(eq(providerCallbackEvents.id, event.id));
      return {
        result: {
          action: 'processed' as const,
          outcome: outcome.kind,
          ...(outcome.kind === 'succeeded' && outcome.cost_summary
            ? { providerReportedCost: outcome.cost_summary.amount }
            : {}),
        },
        wake: transition.wake,
      };
    });
    if ('result' in result) {
      if (result.wake) await this.eventWakePublisher.publish(result.wake).catch(() => undefined);
      return result.result;
    }
    return result;
  }

  scheduleRetryableUnmatched(input: { limit: number; traceId: string }): Promise<{
    scheduled: number;
    expired: number;
  }> {
    return this.database.transaction(async (transaction) => {
      const now = this.now();
      const cutoff = new Date(now.getTime() - MATCH_WINDOW_MS);
      const expiredRows = await transaction
        .select({ id: providerCallbackEvents.id })
        .from(providerCallbackEvents)
        .where(
          and(
            eq(providerCallbackEvents.status, 'dead_letter'),
            eq(providerCallbackEvents.errorCode, UNMATCHED_RETRYABLE),
            lte(providerCallbackEvents.receivedAt, cutoff),
          ),
        )
        .orderBy(asc(providerCallbackEvents.receivedAt))
        .for('update', { skipLocked: true })
        .limit(input.limit);
      if (expiredRows.length > 0) {
        await transaction
          .update(providerCallbackEvents)
          .set({ errorCode: UNMATCHED_EXPIRED, nextProcessAt: null })
          .where(
            inArray(
              providerCallbackEvents.id,
              expiredRows.map((row) => row.id),
            ),
          );
      }

      const retryable = await transaction
        .select()
        .from(providerCallbackEvents)
        .where(
          and(
            eq(providerCallbackEvents.status, 'dead_letter'),
            eq(providerCallbackEvents.errorCode, UNMATCHED_RETRYABLE),
            gte(providerCallbackEvents.receivedAt, cutoff),
            lte(providerCallbackEvents.nextProcessAt, now),
          ),
        )
        .orderBy(asc(providerCallbackEvents.nextProcessAt), asc(providerCallbackEvents.id))
        .for('update', { skipLocked: true })
        .limit(Math.max(0, input.limit - expiredRows.length));
      for (const event of retryable) {
        await this.createCallbackIntent(
          transaction,
          event.id,
          event.processingCount + 1,
          input.traceId,
          now,
        );
        await transaction
          .update(providerCallbackEvents)
          .set({ nextProcessAt: new Date(now.getTime() + RETRY_DELAY_MS) })
          .where(eq(providerCallbackEvents.id, event.id));
      }
      return { scheduled: retryable.length, expired: expiredRows.length };
    });
  }

  private markDeadLetter(
    transaction: Transaction,
    eventId: string,
    processingNo: number,
    errorCode: string,
    attemptId?: string,
  ): Promise<unknown> {
    return transaction
      .update(providerCallbackEvents)
      .set({
        status: 'dead_letter',
        errorCode,
        processingCount: processingNo,
        nextProcessAt: null,
        ...(attemptId ? { taskAttemptId: attemptId } : {}),
      })
      .where(eq(providerCallbackEvents.id, eventId));
  }

  private createCallbackIntent(
    transaction: Transaction,
    eventId: string,
    processingNo: number,
    traceId: string,
    nextAttemptAt: Date,
  ) {
    return createQueueIntentInTransaction(transaction, {
      queueName: 'provider-callback',
      jobId: compositeJobId({ provider_callback_event_id: eventId, processing_no: processingNo }),
      aggregateType: 'provider_callback_event',
      aggregateId: eventId,
      payloadVersion: 1,
      payload: {
        schema_version: 1,
        job_type: 'provider.callback.process',
        trace_id: traceId,
        provider_callback_event_id: eventId,
        processing_no: processingNo,
      },
      nextAttemptAt,
    });
  }
}
