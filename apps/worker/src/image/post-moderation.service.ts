import {
  and,
  artifactEvaluations,
  artifacts,
  contentReviewCases,
  desc,
  eq,
  taskAttempts,
  tasks,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import type { QueuePayload } from '@ecom-forge/queue';
import {
  canonicalSha256,
  NOOP_EVENT_WAKE_PUBLISHER,
  type EventWake,
  type EventWakePublisher,
} from '@ecom-forge/shared';
import { z } from 'zod';

import type { WorkerConfig } from '../config/worker-config.js';
import { TaskAttemptRepository } from '../database/attempt.repository.js';
import { advanceTaskInTransaction } from '../database/workflow-state.repository.js';
import type { PostModerationDispatcher } from '../agent/approved-moderation.dispatcher.js';
import type { WorkerWriteFence } from '../lifecycle/processing-fence.js';
import { ImagePublicationService } from './image-publication.service.js';

type TaskPayload = Extract<QueuePayload, { job_type: 'task.execute' | 'moderation.execute' }>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const moderationTaskParamsSchema = z.strictObject({
  schema_version: z.literal(1),
  source: z.literal('chat'),
  generation_task_key: z.string().min(1).max(128),
  generation_operation_key: sha256,
  output_index: z.int().min(0).max(15),
  moderation_route: z.strictObject({
    capability: z.literal('moderation.image'),
    runtime_revision: z.int().positive(),
    model_snapshot_id: z.uuid(),
    credential_version_id: z.uuid(),
    policy_version: z.string().min(1).max(128),
    evidence_digest: sha256,
    pricing_digest: sha256,
    risk_adjusted_cost_cny: z
      .string()
      .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
      .nullable(),
  }),
  storage_snapshot: z.record(z.string(), z.unknown()),
});

export class PostModerationService {
  private readonly attempts: TaskAttemptRepository;
  private readonly publication: ImagePublicationService;

  constructor(
    private readonly database: Database,
    private readonly dispatch: PostModerationDispatcher,
    private readonly config: WorkerConfig,
    private readonly writeFence: WorkerWriteFence,
    private readonly eventWakePublisher: EventWakePublisher = NOOP_EVENT_WAKE_PUBLISHER,
  ) {
    this.attempts = new TaskAttemptRepository(database);
    this.publication = new ImagePublicationService(
      database,
      config,
      writeFence,
      eventWakePublisher,
    );
  }

  async execute(payload: TaskPayload): Promise<'handled' | 'not_moderation_task'> {
    const owned = await this.readOwned(payload);
    if (!owned) return 'handled';
    if (owned.kind === 'not_moderation') return 'not_moderation_task';

    const existing = await this.database.query.artifactEvaluations.findFirst({
      where: eq(artifactEvaluations.taskId, owned.task.id),
    });
    if (existing) {
      if (existing.status === 'pass' && owned.task.status === 'running') {
        await this.publication.publish({
          artifactId: owned.artifact.id,
          evaluationId: existing.id,
          moderationTaskId: owned.task.id,
          moderationAttemptId: existing.taskAttemptId!,
          workflowRunId: owned.workflow.id,
          userId: owned.workflow.userId,
        });
      } else if (existing.status === 'unknown' && owned.task.status === 'waiting_manual_review') {
        const review = await this.database.query.contentReviewCases.findFirst({
          where: eq(contentReviewCases.evaluationId, existing.id),
        });
        if (review?.status === 'released') {
          await this.publication.publish({
            artifactId: owned.artifact.id,
            evaluationId: existing.id,
            moderationTaskId: owned.task.id,
            moderationAttemptId: existing.taskAttemptId!,
            workflowRunId: owned.workflow.id,
            userId: owned.workflow.userId,
            manualReviewCaseId: review.id,
          });
        }
      }
      return 'handled';
    }
    if (
      ['succeeded', 'failed', 'cancelled', 'blocked', 'waiting_manual_review'].includes(
        owned.task.status,
      )
    ) {
      return 'handled';
    }
    if (owned.workflow.status !== 'running') throw new Error('POST_MODERATION_WORKFLOW_INVALID');
    if (owned.task.status === 'queued') {
      await this.database.transaction((transaction) =>
        advanceTaskInTransaction(transaction, {
          taskId: owned.task.id,
          workflowRunId: owned.workflow.id,
          userId: owned.workflow.userId,
          from: 'queued',
          to: 'running',
          now: new Date(),
        }),
      );
    } else if (owned.task.status !== 'running') {
      throw new Error('POST_MODERATION_TASK_INVALID');
    }

    const latestAttempt = await this.database.query.taskAttempts.findFirst({
      where: eq(taskAttempts.taskId, owned.task.id),
      orderBy: [desc(taskAttempts.attemptNo)],
    });
    if (latestAttempt?.status === 'failed') {
      await this.failClosed(owned, attemptErrorCode(latestAttempt, 'CONTENT_SAFETY_UNAVAILABLE'));
      return 'handled';
    }

    const allocation = await this.attempts.allocate({
      taskId: owned.task.id,
      provider: owned.modelProvider,
      maxAttempts: 1,
    });
    const requestedAttemptId =
      payload.job_type === 'task.execute' ? payload.task_attempt_id : undefined;
    if (requestedAttemptId && requestedAttemptId !== allocation.attempt.id) {
      throw new Error('POST_MODERATION_ATTEMPT_OWNERSHIP_INVALID');
    }
    if (allocation.attempt.status !== 'created') {
      if (allocation.attempt.status === 'accepted') {
        await this.completeUnknown(owned, allocation.attempt.id, 'MODERATION_RECOVERY_UNKNOWN');
      }
      return 'handled';
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

    const operationKey = canonicalSha256({
      generation_operation_key: owned.params.generation_operation_key,
      output_index: owned.params.output_index,
      artifact_id: owned.artifact.id,
      artifact_content_hash: owned.artifact.contentHash,
      model_snapshot_id: owned.params.moderation_route.model_snapshot_id,
      credential_version_id: owned.params.moderation_route.credential_version_id,
      runtime_revision: owned.params.moderation_route.runtime_revision,
      policy_version: owned.params.moderation_route.policy_version,
    });
    let outcome: Awaited<ReturnType<PostModerationDispatcher>>;
    try {
      outcome = await this.dispatch({
        artifactId: owned.artifact.id,
        userId: owned.workflow.userId,
        traceId: payload.trace_id,
        inputDigest: owned.artifact.contentHash!,
        operationKey,
        modelSnapshotId: owned.params.moderation_route.model_snapshot_id,
        credentialVersionId: owned.params.moderation_route.credential_version_id,
        runtimeRevision: owned.params.moderation_route.runtime_revision,
        policyVersion: owned.params.moderation_route.policy_version,
        markPotentiallyDispatched: () => this.markPotentiallyDispatched(allocation.attempt.id),
      });
    } catch {
      outcome = { decision: 'not_dispatched' };
    }

    if (outcome.decision === 'not_dispatched') {
      await this.attempts.advance({
        attemptId: allocation.attempt.id,
        expectedStatus: 'dispatching',
        expectedDispatchState: 'not_dispatched',
        status: 'failed',
        dispatchState: 'not_dispatched',
        now: new Date(),
        errorCode: 'CONTENT_SAFETY_UNAVAILABLE',
      });
      await this.failClosed(owned, 'CONTENT_SAFETY_UNAVAILABLE');
      return 'handled';
    }
    if (outcome.policy_version !== owned.params.moderation_route.policy_version) {
      await this.completeUnknown(owned, allocation.attempt.id, 'MODERATION_POLICY_DRIFT');
      return 'handled';
    }

    if (outcome.decision === 'pass') {
      const evaluationId = await this.recordEvaluation(
        owned,
        allocation.attempt.id,
        operationKey,
        outcome,
      );
      await this.publication.publish({
        artifactId: owned.artifact.id,
        evaluationId,
        moderationTaskId: owned.task.id,
        moderationAttemptId: allocation.attempt.id,
        workflowRunId: owned.workflow.id,
        userId: owned.workflow.userId,
      });
      return 'handled';
    }
    if (outcome.decision === 'blocked') {
      await this.recordBlocked(owned, allocation.attempt.id, operationKey, outcome);
      return 'handled';
    }
    await this.recordUnknown(owned, allocation.attempt.id, operationKey, outcome);
    return 'handled';
  }

  private async readOwned(payload: TaskPayload) {
    const [row] = await this.database
      .select({ task: tasks, workflow: workflowRuns })
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
    if (!row) return null;
    if (row.task.type !== 'moderation.image') return { kind: 'not_moderation' as const };
    if (!row.task.parentTaskId || !row.task.modelId)
      throw new Error('POST_MODERATION_CLOSURE_MISSING');
    const params = moderationTaskParamsSchema.parse(row.task.paramsSnapshot);
    const outputArtifacts = await this.database.query.artifacts.findMany({
      where: and(
        eq(artifacts.taskId, row.task.parentTaskId),
        eq(artifacts.userId, row.workflow.userId),
      ),
    });
    const artifact = outputArtifacts.find(
      (candidate) => outputIndex(candidate.metaJson) === params.output_index,
    );
    if (!artifact || !artifact.contentHash) throw new Error('POST_MODERATION_ARTIFACT_MISSING');
    const model = await this.database.query.models.findFirst({
      where: (table, { eq }) => eq(table.id, row.task.modelId!),
      columns: { provider: true },
    });
    if (!model) throw new Error('POST_MODERATION_MODEL_MISSING');
    return { kind: 'owned' as const, ...row, artifact, params, modelProvider: model.provider };
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
    return Boolean(updated);
  }

  private async recordEvaluation(
    owned: OwnedModeration,
    attemptId: string,
    operationKey: string,
    outcome: Extract<ModerationResult, { decision: 'pass' }>,
  ): Promise<string> {
    this.writeFence.assertWritesAllowed();
    return this.database.transaction(async (transaction) => {
      const [evaluation] = await transaction
        .insert(artifactEvaluations)
        .values({
          artifactId: owned.artifact.id,
          taskId: owned.task.id,
          taskAttemptId: attemptId,
          modelSnapshotId: owned.params.moderation_route.model_snapshot_id,
          evaluatorType: 'content_safety',
          evaluatorVersion: outcome.policy_version,
          operationKey,
          evidenceSnapshot: evidenceSnapshot(owned),
          findingsJson: { decision: 'pass' },
          confidence: outcome.confidence,
          status: 'pass',
        })
        .onConflictDoNothing()
        .returning({ id: artifactEvaluations.id });
      if (evaluation) return evaluation.id;
      const existing = await transaction.query.artifactEvaluations.findFirst({
        where: eq(artifactEvaluations.operationKey, operationKey),
      });
      if (!existing || existing.artifactId !== owned.artifact.id || existing.status !== 'pass') {
        throw new Error('POST_MODERATION_EVALUATION_CONFLICT');
      }
      return existing.id;
    });
  }

  private async recordBlocked(
    owned: OwnedModeration,
    attemptId: string,
    operationKey: string,
    outcome: Extract<ModerationResult, { decision: 'blocked' }>,
  ): Promise<void> {
    const wakes = await this.database.transaction(async (transaction) => {
      await transaction.insert(artifactEvaluations).values({
        artifactId: owned.artifact.id,
        taskId: owned.task.id,
        taskAttemptId: attemptId,
        modelSnapshotId: owned.params.moderation_route.model_snapshot_id,
        evaluatorType: 'content_safety',
        evaluatorVersion: outcome.policy_version,
        operationKey,
        evidenceSnapshot: evidenceSnapshot(owned),
        findingsJson: { decision: 'blocked', reason_codes: [...outcome.reason_codes].sort() },
        confidence: outcome.confidence,
        status: 'blocked',
      });
      await finishAcceptedAttempt(transaction, attemptId, 'succeeded', null);
      return this.terminateGeneration(transaction, owned, 'CONTENT_SAFETY_BLOCKED', 'blocked');
    });
    await this.publishWakes(wakes);
  }

  private async recordUnknown(
    owned: OwnedModeration,
    attemptId: string,
    operationKey: string,
    outcome: Extract<ModerationResult, { decision: 'unknown' }>,
    recoveryCode?: string,
  ): Promise<void> {
    const wakes = await this.database.transaction(async (transaction) => {
      const [evaluation] = await transaction
        .insert(artifactEvaluations)
        .values({
          artifactId: owned.artifact.id,
          taskId: owned.task.id,
          taskAttemptId: attemptId,
          modelSnapshotId: owned.params.moderation_route.model_snapshot_id,
          evaluatorType: 'content_safety',
          evaluatorVersion: outcome.policy_version,
          operationKey,
          evidenceSnapshot: evidenceSnapshot(owned),
          findingsJson: {
            decision: 'unknown',
            error_code: outcome.error_code,
            ...(recoveryCode ? { recovery_code: recoveryCode } : {}),
          },
          confidence: null,
          status: 'unknown',
        })
        .returning({ id: artifactEvaluations.id });
      if (!evaluation) throw new Error('POST_MODERATION_EVALUATION_INSERT_FAILED');
      await finishAcceptedAttempt(transaction, attemptId, 'outcome_unknown', outcome.error_code);
      await transaction.insert(contentReviewCases).values({
        artifactId: owned.artifact.id,
        evaluationId: evaluation.id,
        deadlineAt: new Date(Date.now() + this.config.contentReviewDeadlineMs),
      });
      const transition = await advanceTaskInTransaction(transaction, {
        taskId: owned.task.id,
        workflowRunId: owned.workflow.id,
        userId: owned.workflow.userId,
        from: 'running',
        to: 'waiting_manual_review',
        now: new Date(),
        errorCode: 'CONTENT_SAFETY_REVIEW_REQUIRED',
      });
      return transition.wake ? [transition.wake] : [];
    });
    await this.publishWakes(wakes);
  }

  private async completeUnknown(
    owned: OwnedModeration,
    attemptId: string,
    errorCode: string,
  ): Promise<void> {
    const operationKey = canonicalSha256({
      recovery: true,
      task_id: owned.task.id,
      attempt_id: attemptId,
      artifact_hash: owned.artifact.contentHash,
      policy_version: owned.params.moderation_route.policy_version,
    });
    await this.recordUnknown(
      owned,
      attemptId,
      operationKey,
      {
        decision: 'unknown',
        policy_version: owned.params.moderation_route.policy_version,
        error_code: 'provider_internal_error',
      },
      errorCode,
    );
  }

  private async failClosed(owned: OwnedModeration, errorCode: string): Promise<void> {
    const wakes = await this.database.transaction((transaction) =>
      this.terminateGeneration(transaction, owned, errorCode, 'failed'),
    );
    await this.publishWakes(wakes);
  }

  private async terminateGeneration(
    transaction: Transaction,
    owned: OwnedModeration,
    errorCode: string,
    currentTarget: 'blocked' | 'failed',
  ): Promise<EventWake[]> {
    const parentTaskId = owned.task.parentTaskId;
    if (!parentTaskId) throw new Error('POST_MODERATION_PARENT_TASK_MISSING');
    const wakes: EventWake[] = [];
    const current = await transaction.query.tasks.findFirst({ where: eq(tasks.id, owned.task.id) });
    if (current && ['queued', 'running'].includes(current.status)) {
      const transition = await advanceTaskInTransaction(transaction, {
        taskId: current.id,
        workflowRunId: owned.workflow.id,
        userId: owned.workflow.userId,
        from: current.status,
        to: currentTarget,
        now: new Date(),
        errorCode,
      });
      if (transition.wake) wakes.push(transition.wake);
    }
    const siblings = await transaction.query.tasks.findMany({
      where: and(eq(tasks.parentTaskId, parentTaskId), eq(tasks.type, 'moderation.image')),
    });
    for (const sibling of siblings) {
      if (
        sibling.id === owned.task.id ||
        !['pending', 'queued', 'running'].includes(sibling.status)
      )
        continue;
      const transition = await advanceTaskInTransaction(transaction, {
        taskId: sibling.id,
        workflowRunId: owned.workflow.id,
        userId: owned.workflow.userId,
        from: sibling.status,
        to: 'blocked',
        now: new Date(),
        errorCode: 'CONTENT_SAFETY_SIBLING_BLOCKED',
      });
      if (transition.wake) wakes.push(transition.wake);
    }
    const generationTask = await transaction.query.tasks.findFirst({
      where: eq(tasks.id, parentTaskId),
    });
    const generationAttempt = generationTask
      ? await transaction.query.taskAttempts.findFirst({
          where: and(
            eq(taskAttempts.taskId, generationTask.id),
            eq(taskAttempts.status, 'succeeded'),
          ),
        })
      : undefined;
    if (
      !generationTask ||
      generationTask.status !== 'running' ||
      !generationAttempt ||
      !owned.workflow.reservationId
    ) {
      throw new Error('POST_MODERATION_SETTLEMENT_CLOSURE_INVALID');
    }
    const generation = await advanceTaskInTransaction(transaction, {
      taskId: generationTask.id,
      workflowRunId: owned.workflow.id,
      userId: owned.workflow.userId,
      from: 'running',
      to: 'blocked',
      now: new Date(),
      errorCode,
      settlement: {
        taskAttemptId: generationAttempt.id,
        reservationId: owned.workflow.reservationId,
        artifactIds: [],
      },
    });
    if (generation.wake) wakes.push(generation.wake);
    return wakes;
  }

  private publishWakes(wakes: EventWake[]): Promise<void[]> {
    return Promise.all(
      wakes.map((wake) => this.eventWakePublisher.publish(wake).catch(() => undefined)),
    );
  }
}

type OwnedModeration = Extract<
  NonNullable<Awaited<ReturnType<PostModerationService['readOwned']>>>,
  { kind: 'owned' }
>;
type ModerationResult = Exclude<
  Awaited<ReturnType<PostModerationDispatcher>>,
  { decision: 'not_dispatched' }
>;

function outputIndex(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const index = (value as Record<string, unknown>).output_index;
  return Number.isInteger(index) ? (index as number) : null;
}

function attemptErrorCode(attempt: typeof taskAttempts.$inferSelect, fallback: string): string {
  const summary = attempt.rawErrorSummary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return fallback;
  const code = (summary as Record<string, unknown>).error_code;
  return typeof code === 'string' && code.length > 0 ? code : fallback;
}

function evidenceSnapshot(owned: OwnedModeration): Record<string, unknown> {
  return {
    schema_version: 1,
    artifact_content_hash: owned.artifact.contentHash,
    output_index: owned.params.output_index,
    model_snapshot_id: owned.params.moderation_route.model_snapshot_id,
    credential_version_id: owned.params.moderation_route.credential_version_id,
    runtime_revision: owned.params.moderation_route.runtime_revision,
    policy_version: owned.params.moderation_route.policy_version,
    model_evidence_digest: owned.params.moderation_route.evidence_digest,
    pricing_digest: owned.params.moderation_route.pricing_digest,
  };
}

async function finishAcceptedAttempt(
  transaction: Transaction,
  attemptId: string,
  status: 'succeeded' | 'outcome_unknown',
  errorCode: string | null,
): Promise<void> {
  const [updated] = await transaction
    .update(taskAttempts)
    .set({
      status,
      ...(status === 'outcome_unknown' ? { dispatchState: 'outcome_unknown' as const } : {}),
      ...(errorCode ? { rawErrorSummary: { error_code: errorCode } } : {}),
      endedAt: new Date(),
    })
    .where(
      and(
        eq(taskAttempts.id, attemptId),
        eq(taskAttempts.status, 'accepted'),
        eq(taskAttempts.dispatchState, 'accepted'),
      ),
    )
    .returning({ id: taskAttempts.id });
  if (!updated) throw new Error('POST_MODERATION_ATTEMPT_CAS_FAILED');
}
