import {
  and,
  artifacts,
  assets,
  desc,
  eq,
  inArray,
  runQuotes,
  sql,
  taskAttempts,
  tasks,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import { CreditError, submitRunQuote } from '@ecom-forge/credit';
import { createQueueIntentInTransaction } from '@ecom-forge/queue';
import {
  canonicalSha256,
  normalizeMoney,
  scopedAdvisoryLockKey,
  type EventWakePublisher,
} from '@ecom-forge/shared';

import { appendOutboxEventInTransaction } from '../../shared/database/outbox.repository.js';

type ImageBinding = {
  kind: 'asset' | 'artifact';
  object_id: string;
  content_hash: string;
  publication_revision?: number | null;
};

export class WorkflowRetryService {
  constructor(
    private readonly database: Database,
    private readonly eventWakePublisher: EventWakePublisher,
  ) {}

  async retryFailedImage(input: {
    userId: string;
    workflowRunId: string;
    taskId: string;
    idempotencyKey: string;
  }) {
    const prepared = await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('image_retry', input.taskId)})`,
      );
      const [owned] = await transaction
        .select({ task: tasks, workflow: workflowRuns })
        .from(tasks)
        .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.workflowRunId, input.workflowRunId),
            eq(workflowRuns.userId, input.userId),
          ),
        )
        .for('update')
        .limit(1);
      if (!owned) throw new CreditError('Image task was not found', 'RESOURCE_NOT_FOUND');

      const [existingRetry] = await transaction
        .select({ id: tasks.id, workflowRunId: tasks.workflowRunId, status: tasks.status })
        .from(tasks)
        .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
        .where(
          and(
            eq(tasks.parentTaskId, owned.task.id),
            inArray(tasks.type, ['image.generate', 'image.edit']),
            sql`${tasks.workflowRunId} <> ${owned.workflow.id}`,
            eq(workflowRuns.userId, input.userId),
          ),
        )
        .orderBy(desc(tasks.createdAt), desc(tasks.id))
        .limit(1);
      if (existingRetry) {
        return {
          kind: 'existing' as const,
          taskId: existingRetry.id,
          workflowRunId: existingRetry.workflowRunId,
          status: existingRetry.status,
        };
      }

      const attempt = await transaction.query.taskAttempts.findFirst({
        where: eq(taskAttempts.taskId, owned.task.id),
        orderBy: [desc(taskAttempts.attemptNo)],
      });
      if (!isRetryableFailure(owned.task, attempt)) {
        throw new CreditError('Image task is not retryable', 'SETTLEMENT_PROTECTED');
      }
      const params = imageParams(owned.task.paramsSnapshot);
      await assertBindingsStillAuthorized(transaction, input.userId, params.input_bindings);

      const inputSignature = canonicalSha256({
        kind: 'image_retry@v1',
        source_workflow_run_id: owned.workflow.id,
        source_task_id: owned.task.id,
      });
      const quoteIdempotencyKey = `image-retry:${input.userId}:${input.idempotencyKey}`;
      const existingQuote = await transaction.query.runQuotes.findFirst({
        where: eq(runQuotes.idempotencyKey, quoteIdempotencyKey),
      });
      if (existingQuote) {
        if (
          existingQuote.userId !== input.userId ||
          existingQuote.inputSignature !== inputSignature
        ) {
          throw new CreditError('Retry idempotency conflict', 'IDEMPOTENCY_CONFLICT');
        }
        return { kind: 'quote' as const, quoteId: existingQuote.id, replayed: true };
      }
      const now = new Date();
      const activeQuote = await transaction.query.runQuotes.findFirst({
        where: and(
          eq(runQuotes.userId, input.userId),
          eq(runQuotes.source, 'chat'),
          eq(runQuotes.inputSignature, inputSignature),
          eq(runQuotes.status, 'quoted'),
        ),
      });
      if (activeQuote) {
        if (activeQuote.expiresAt > now) {
          return { kind: 'quote' as const, quoteId: activeQuote.id, replayed: true };
        }
        await transaction
          .update(runQuotes)
          .set({ status: 'expired' })
          .where(and(eq(runQuotes.id, activeQuote.id), eq(runQuotes.status, 'quoted')));
      }

      const estimatedCredits = normalizeMoney(owned.task.costEstimate);
      const taskKey = 'retry-image-1';
      const frozenParams = retryExecutionParams(params, owned.task.id);
      const [quote] = await transaction
        .insert(runQuotes)
        .values({
          userId: input.userId,
          source: 'chat',
          productId: owned.workflow.productId,
          status: 'quoted',
          promptPreview: {
            kind: 'image_retry',
            source_task_id: owned.task.id,
            target_count: 1,
          },
          itemsSnapshot: [
            {
              task_key: taskKey,
              task_type: owned.task.type,
              estimated_credits: estimatedCredits,
            },
          ],
          estimatedCallCount: 1,
          estimatedTotalCredits: estimatedCredits,
          hasUnknownPrice: false,
          idempotencyKey: quoteIdempotencyKey,
          inputSignature,
          confirmationSnapshot: {},
          planSnapshot: {
            schema_version: 1,
            kind: 'image_retry',
            retry: {
              source_workflow_run_id: owned.workflow.id,
              source_task_id: owned.task.id,
            },
            items: [
              {
                taskKey,
                taskType: owned.task.type,
                estimatedCredits,
                parentTaskId: owned.task.id,
                paramsSnapshot: frozenParams,
              },
            ],
          },
          skillSnapshot: owned.workflow.skillSnapshot,
          pricingSnapshot: owned.workflow.pricingSnapshot,
          expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
        })
        .returning({ id: runQuotes.id });
      if (!quote) throw new Error('Image retry quote insert returned no row');
      return { kind: 'quote' as const, quoteId: quote.id, replayed: false };
    });

    if (prepared.kind === 'existing') {
      return {
        workflow_run_id: prepared.workflowRunId,
        task_id: prepared.taskId,
        status: prepared.status,
        replayed: true,
      };
    }

    const submitted = await submitRunQuote({
      database: this.database,
      ports: {
        createQueueIntent: createQueueIntentInTransaction,
        appendOutboxEvent: appendOutboxEventInTransaction,
      },
      userId: input.userId,
      quoteId: prepared.quoteId,
      idempotencyKey: `image-retry-submit:${prepared.quoteId}`,
      evidence: {
        kind: 'retry_action@v1',
        source_workflow_run_id: input.workflowRunId,
        source_task_id: input.taskId,
      },
    });
    await Promise.all(
      submitted.wakes.map((wake) => this.eventWakePublisher.publish(wake).catch(() => undefined)),
    );
    const generationTask = await this.database.query.tasks.findFirst({
      where: and(
        eq(tasks.workflowRunId, submitted.response.workflow_run_id),
        eq(tasks.parentTaskId, input.taskId),
      ),
      columns: { id: true },
    });
    if (!generationTask) throw new Error('Image retry task was not created');
    return {
      workflow_run_id: submitted.response.workflow_run_id,
      task_id: generationTask.id,
      status: submitted.response.status,
      replayed: prepared.replayed,
    };
  }
}

export function retryExecutionParams(
  params: Record<string, unknown> & { input_bindings: ImageBinding[] },
  sourceTaskId: string,
): Record<string, unknown> & { input_bindings: ImageBinding[] } {
  return {
    ...params,
    source: 'chat',
    output_count: 1,
    depends_on: [],
    operation_key: canonicalSha256({
      kind: 'image_retry_execution@v1',
      source_operation_key: params.operation_key,
      source_task_id: sourceTaskId,
    }),
  };
}

function isRetryableFailure(
  task: typeof tasks.$inferSelect,
  attempt: typeof taskAttempts.$inferSelect | undefined,
): boolean {
  if (
    !['image.generate', 'image.edit'].includes(task.type) ||
    !['failed', 'waiting_manual_review'].includes(task.status) ||
    !attempt ||
    imageOutputCount(task.paramsSnapshot) !== 1
  ) {
    return false;
  }
  return (
    (attempt.status === 'failed' && attempt.dispatchState !== 'outcome_unknown') ||
    (attempt.status === 'outcome_unknown' && attempt.dispatchState === 'outcome_unknown')
  );
}

function imageOutputCount(paramsSnapshot: unknown): number | null {
  if (!paramsSnapshot || typeof paramsSnapshot !== 'object' || Array.isArray(paramsSnapshot)) {
    return null;
  }
  const value = (paramsSnapshot as Record<string, unknown>).output_count;
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 16
    ? Number(value)
    : null;
}

function imageParams(value: unknown): Record<string, unknown> & { input_bindings: ImageBinding[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CreditError('Image retry snapshot is invalid', 'RESERVATION_STATE_INVALID');
  }
  const params = value as Record<string, unknown>;
  if (!Array.isArray(params.input_bindings)) {
    throw new CreditError('Image retry bindings are invalid', 'RESERVATION_STATE_INVALID');
  }
  const bindings = params.input_bindings as ImageBinding[];
  if (
    bindings.some(
      (binding) =>
        !binding ||
        !['asset', 'artifact'].includes(binding.kind) ||
        typeof binding.object_id !== 'string' ||
        typeof binding.content_hash !== 'string',
    )
  ) {
    throw new CreditError('Image retry bindings are invalid', 'RESERVATION_STATE_INVALID');
  }
  return { ...params, input_bindings: bindings };
}

async function assertBindingsStillAuthorized(
  transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
  userId: string,
  bindings: ImageBinding[],
): Promise<void> {
  for (const binding of bindings) {
    if (binding.kind === 'asset') {
      const asset = await transaction.query.assets.findFirst({
        where: and(eq(assets.id, binding.object_id), eq(assets.userId, userId)),
        columns: { status: true, contentHash: true },
      });
      if (!asset || asset.status !== 'ready' || asset.contentHash !== binding.content_hash) {
        throw new CreditError('Retry source asset is unavailable', 'RESERVATION_STATE_INVALID');
      }
      continue;
    }
    const artifact = await transaction.query.artifacts.findFirst({
      where: and(eq(artifacts.id, binding.object_id), eq(artifacts.userId, userId)),
      columns: { visibility: true, publishedContentHash: true, publicationRevision: true },
    });
    if (
      !artifact ||
      !['private', 'shared', 'public'].includes(artifact.visibility) ||
      artifact.publishedContentHash !== binding.content_hash ||
      (binding.publication_revision !== null &&
        binding.publication_revision !== undefined &&
        artifact.publicationRevision !== binding.publication_revision)
    ) {
      throw new CreditError('Retry source artifact is unavailable', 'RESERVATION_STATE_INVALID');
    }
  }
}
