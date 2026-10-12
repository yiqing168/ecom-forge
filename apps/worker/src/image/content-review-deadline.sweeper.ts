import { lockCreditAccount, releaseWorkflowCancellationInTransaction } from '@ecom-forge/credit';
import {
  adminAuditLogs,
  and,
  artifactEvaluations,
  contentReviewCases,
  eq,
  inArray,
  lte,
  taskAttempts,
  tasks,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';

import type { WorkerConfig } from '../config/worker-config.js';
import { appendOutboxEventInTransaction } from '../database/outbox.repository.js';
import type { WorkerWriteFence } from '../lifecycle/processing-fence.js';

export class ContentReviewDeadlineSweeper {
  constructor(
    private readonly database: Database,
    private readonly config: WorkerConfig,
    private readonly writeFence: WorkerWriteFence,
  ) {}

  async sweep(now = new Date()): Promise<number> {
    const candidates = await this.database
      .select({ id: contentReviewCases.id, userId: workflowRuns.userId })
      .from(contentReviewCases)
      .innerJoin(artifactEvaluations, eq(artifactEvaluations.id, contentReviewCases.evaluationId))
      .innerJoin(tasks, eq(tasks.id, artifactEvaluations.taskId))
      .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
      .where(and(eq(contentReviewCases.status, 'pending'), lte(contentReviewCases.deadlineAt, now)))
      .orderBy(contentReviewCases.deadlineAt, contentReviewCases.id)
      .limit(this.config.contentReviewSweepBatchSize);
    let expired = 0;
    for (const candidate of candidates) {
      if (await this.expireOne(candidate.id, candidate.userId, now)) expired += 1;
    }
    return expired;
  }

  private async expireOne(reviewId: string, userId: string, now: Date): Promise<boolean> {
    this.writeFence.assertWritesAllowed();
    return this.database.transaction(async (transaction) => {
      await lockCreditAccount(transaction, userId);
      const [review] = await transaction
        .select()
        .from(contentReviewCases)
        .where(
          and(
            eq(contentReviewCases.id, reviewId),
            eq(contentReviewCases.status, 'pending'),
            lte(contentReviewCases.deadlineAt, now),
          ),
        )
        .for('update', { skipLocked: true })
        .limit(1);
      if (!review) return false;
      const evaluation = await transaction.query.artifactEvaluations.findFirst({
        where: eq(artifactEvaluations.id, review.evaluationId),
      });
      const moderationTask = evaluation?.taskId
        ? await transaction.query.tasks.findFirst({ where: eq(tasks.id, evaluation.taskId) })
        : undefined;
      const workflow = moderationTask
        ? await transaction.query.workflowRuns.findFirst({
            where: eq(workflowRuns.id, moderationTask.workflowRunId),
          })
        : undefined;
      const generationTask = moderationTask?.parentTaskId
        ? await transaction.query.tasks.findFirst({
            where: eq(tasks.id, moderationTask.parentTaskId),
          })
        : undefined;
      const generationAttempt = generationTask
        ? await transaction.query.taskAttempts.findFirst({
            where: and(
              eq(taskAttempts.taskId, generationTask.id),
              eq(taskAttempts.status, 'succeeded'),
            ),
          })
        : undefined;
      if (
        evaluation?.status !== 'unknown' ||
        !moderationTask ||
        moderationTask.status !== 'waiting_manual_review' ||
        !workflow ||
        workflow.userId !== userId ||
        workflow.status !== 'running' ||
        !workflow.reservationId ||
        !generationTask ||
        generationTask.status !== 'running' ||
        !generationAttempt
      ) {
        throw new Error('CONTENT_REVIEW_EXPIRY_CLOSURE_INVALID');
      }
      const [updated] = await transaction
        .update(contentReviewCases)
        .set({
          status: 'expired',
          decidedAt: now,
          revision: review.revision + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(contentReviewCases.id, review.id),
            eq(contentReviewCases.status, 'pending'),
            eq(contentReviewCases.revision, review.revision),
          ),
        )
        .returning({ id: contentReviewCases.id });
      if (!updated) return false;
      const [moderationFailed] = await transaction
        .update(tasks)
        .set({ status: 'failed', errorCode: 'CONTENT_REVIEW_EXPIRED', endedAt: now })
        .where(and(eq(tasks.id, moderationTask.id), eq(tasks.status, 'waiting_manual_review')))
        .returning({ id: tasks.id });
      if (!moderationFailed) throw new Error('CONTENT_REVIEW_EXPIRY_CLOSURE_INVALID');
      const siblings = await transaction.query.tasks.findMany({
        where: and(eq(tasks.parentTaskId, generationTask.id), eq(tasks.type, 'moderation.image')),
      });
      const cancellable = siblings
        .filter((task) => ['pending', 'queued', 'running'].includes(task.status))
        .map((task) => task.id);
      if (cancellable.length > 0) {
        await transaction
          .update(tasks)
          .set({ status: 'blocked', errorCode: 'CONTENT_REVIEW_SIBLING_BLOCKED', endedAt: now })
          .where(inArray(tasks.id, cancellable));
      }
      const [generationBlocked] = await transaction
        .update(tasks)
        .set({ status: 'blocked', errorCode: 'CONTENT_REVIEW_EXPIRED', endedAt: now })
        .where(and(eq(tasks.id, generationTask.id), eq(tasks.status, 'running')))
        .returning({ id: tasks.id });
      if (!generationBlocked) throw new Error('CONTENT_REVIEW_EXPIRY_CLOSURE_INVALID');
      const [workflowFailed] = await transaction
        .update(workflowRuns)
        .set({ status: 'failed', finishedAt: now, revision: workflow.revision + 1 })
        .where(and(eq(workflowRuns.id, workflow.id), eq(workflowRuns.status, 'running')))
        .returning({ id: workflowRuns.id });
      if (!workflowFailed) throw new Error('CONTENT_REVIEW_EXPIRY_CLOSURE_INVALID');
      const release = await releaseWorkflowCancellationInTransaction(transaction, {
        userId,
        workflowRunId: workflow.id,
        reservationId: workflow.reservationId,
        idempotencyKey: `release:reservation:${workflow.reservationId}:content-review:${review.id}:expired`,
        metadata: { reason: 'content_review_expired', content_review_case_id: review.id },
      });
      await appendOutboxEventInTransaction(transaction, {
        scopeType: 'workflow_run',
        scopeId: workflow.id,
        eventType: 'content_review.resolved',
        payload: {
          content_review_case_id: review.id,
          decision: 'expired',
          artifact_id: review.artifactId,
        },
        retentionTier: 'critical',
      });
      await appendOutboxEventInTransaction(transaction, {
        scopeType: 'workflow_run',
        scopeId: workflow.id,
        eventType: 'workflow.status_changed',
        payload: { from: 'running', to: 'failed' },
        retentionTier: 'critical',
      });
      await transaction.insert(adminAuditLogs).values({
        actorType: 'system',
        action: 'system.content_review.expired',
        targetType: 'content_review_case',
        targetId: review.id,
        beforeJson: { status: 'pending', revision: review.revision },
        afterJson: {
          status: 'expired',
          revision: review.revision + 1,
          released_amount: release.releasedAmount,
          release_ledger_id: release.ledgerId,
        },
        reason: 'manual review deadline elapsed',
        traceId: workflow.id,
        result: 'succeeded',
      });
      return true;
    });
  }
}
