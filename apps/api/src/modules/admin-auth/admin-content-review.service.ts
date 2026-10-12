import { randomUUID } from 'node:crypto';

import { lockCreditAccount, releaseWorkflowCancellationInTransaction } from '@ecom-forge/credit';
import {
  adminAuditLogs,
  and,
  artifactEvaluations,
  artifacts,
  contentReviewCases,
  creditReservations,
  desc,
  eq,
  inArray,
  lt,
  or,
  taskAttempts,
  tasks,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import { createQueueIntentInTransaction } from '@ecom-forge/queue';
import type { ContentReviewStatus } from '@ecom-forge/types';
import { Injectable } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import { appendOutboxEventInTransaction } from '../../shared/database/outbox.repository.js';
import {
  SignedCursorCodec,
  SignedCursorError,
  type CursorPosition,
} from '../../shared/http/signed-cursor.js';
import { HmacKeyring } from '../auth/security/hmac-keyring.js';
import { adminAuthError } from './admin-errors.js';
import type { AdminRequest, AdminSessionContext } from './admin-http.js';
import { AdminIdempotencyRepository } from './admin-idempotency.repository.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type PageInput = { cursor?: string; limit: number; status?: ContentReviewStatus };

function requestId(request: AdminRequest): string {
  const value = request.headers['x-request-id'];
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : `admin-content-review:${randomUUID()}`;
}

@Injectable()
export class AdminContentReviewService {
  private readonly cursor: SignedCursorCodec;
  private readonly referenceHash: HmacKeyring;
  private readonly idempotency: AdminIdempotencyRepository;
  private readonly idempotencyHash: HmacKeyring;

  constructor(
    private readonly database: Database,
    config: AppConfig,
  ) {
    this.cursor = new SignedCursorCodec(config.resourceCursorSecret);
    this.referenceHash = new HmacKeyring(config.admin.sourceHashKeys);
    this.idempotency = new AdminIdempotencyRepository(database, config.admin.idempotencyHashKeys);
    this.idempotencyHash = new HmacKeyring(config.admin.idempotencyHashKeys);
  }

  async list(context: AdminSessionContext, input: PageInput): Promise<Record<string, unknown>> {
    const filters = { status: input.status ?? 'pending' };
    const position = this.decodeCursor(context, input.cursor, filters);
    const status = input.status ?? 'pending';
    const rows = await this.database
      .select({ review: contentReviewCases, evaluation: artifactEvaluations })
      .from(contentReviewCases)
      .innerJoin(artifactEvaluations, eq(artifactEvaluations.id, contentReviewCases.evaluationId))
      .where(
        and(
          eq(contentReviewCases.status, status),
          position
            ? or(
                lt(contentReviewCases.createdAt, position.createdAt),
                and(
                  eq(contentReviewCases.createdAt, position.createdAt),
                  lt(contentReviewCases.id, position.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(contentReviewCases.createdAt), desc(contentReviewCases.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map(({ review, evaluation }) => ({
        id: review.id,
        artifact_ref: this.referenceHash.digest(review.artifactId).digest,
        status: review.status,
        policy_version: evaluation.evaluatorVersion,
        deadline_at: review.deadlineAt,
        revision: review.revision,
        created_at: review.createdAt,
        decided_at: review.decidedAt,
      })),
      next_cursor:
        rows.length > input.limit && last
          ? this.cursor.encode({
              userId: context.principalId,
              endpoint: 'admin-content-reviews',
              filters,
              position: { id: last.review.id, createdAt: last.review.createdAt },
            })
          : null,
    };
  }

  async detail(_context: AdminSessionContext, reviewId: string): Promise<Record<string, unknown>> {
    const closure = await this.readClosure(this.database, reviewId, false);
    if (!closure) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    return {
      id: closure.review.id,
      status: closure.review.status,
      revision: closure.review.revision,
      deadline_at: closure.review.deadlineAt,
      decision: closure.review.decision,
      decision_summary: closure.review.decisionSummaryJson,
      decision_reason: closure.review.decisionReason,
      decided_at: closure.review.decidedAt,
      artifact: {
        id: closure.artifact.id,
        type: closure.artifact.type,
        visibility: closure.artifact.visibility,
        content_hash: closure.artifact.contentHash,
        meta: safeArtifactMeta(closure.artifact.metaJson),
      },
      evaluation: {
        id: closure.evaluation.id,
        status: closure.evaluation.status,
        policy_version: closure.evaluation.evaluatorVersion,
        findings: closure.evaluation.findingsJson,
        confidence: closure.evaluation.confidence,
        created_at: closure.evaluation.createdAt,
      },
      workflow: {
        id: closure.workflow.id,
        user_ref: this.referenceHash.digest(closure.workflow.userId).digest,
        status: closure.workflow.status,
        reservation: closure.reservation
          ? {
              status: closure.reservation.status,
              estimated_amount: closure.reservation.estimatedAmount,
              settled_amount: closure.reservation.settledAmount,
              released_amount: closure.reservation.releasedAmount,
            }
          : null,
      },
    };
  }

  async decide(
    context: AdminSessionContext,
    request: AdminRequest,
    reviewId: string,
    input: {
      expectedRevision: number;
      decision: 'release' | 'reject';
      confirmationSummary: {
        artifact_reviewed: true;
        assessment: 'safe' | 'unsafe';
        policy_version: string;
      };
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    const preliminary = await this.readClosure(this.database, reviewId, false);
    if (!preliminary) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    return this.idempotency.execute({
      context,
      operation: `admin-content-review/${reviewId}.decide`,
      idempotencyKey: input.idempotencyKey,
      request: {
        review_id: reviewId,
        expected_revision: input.expectedRevision,
        decision: input.decision,
        confirmation_summary: input.confirmationSummary,
        reason: input.reason,
      },
      responseStatus: 200,
      write: async (transaction) => {
        await lockCreditAccount(transaction, preliminary.workflow.userId);
        const closure = await this.readClosure(transaction, reviewId, true);
        if (!closure) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        if (
          closure.review.status !== 'pending' ||
          closure.review.revision !== input.expectedRevision
        ) {
          adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        }
        if (
          closure.evaluation.status !== 'unknown' ||
          closure.evaluation.evaluatorVersion !== input.confirmationSummary.policy_version ||
          closure.moderationTask.status !== 'waiting_manual_review' ||
          !closure.generationTask ||
          !closure.generationAttempt ||
          !closure.reservation
        ) {
          adminAuthError('ADMIN_CONTENT_REVIEW_CLOSURE_INVALID', 409);
        }
        const now = new Date();
        const targetStatus = input.decision === 'release' ? 'released' : 'rejected';
        const [decided] = await transaction
          .update(contentReviewCases)
          .set({
            status: targetStatus,
            decision: input.decision,
            decisionSummaryJson: input.confirmationSummary,
            decidedByAdminId: context.principalId,
            decisionReason: input.reason,
            decidedAt: now,
            revision: input.expectedRevision + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(contentReviewCases.id, reviewId),
              eq(contentReviewCases.status, 'pending'),
              eq(contentReviewCases.revision, input.expectedRevision),
            ),
          )
          .returning({ revision: contentReviewCases.revision });
        if (!decided) adminAuthError('ADMIN_REVISION_CONFLICT', 409);

        let releasedAmount = '0.00';
        let releaseLedgerId: string | null = null;
        if (input.decision === 'release') {
          await createQueueIntentInTransaction(transaction, {
            queueName: 'moderation',
            jobId: `content_review_${reviewId}`,
            aggregateType: 'task',
            aggregateId: closure.moderationTask.id,
            payloadVersion: 4,
            payload: {
              schema_version: 4,
              job_type: 'moderation.execute',
              trace_id: closure.workflow.id,
              task_id: closure.moderationTask.id,
              workflow_run_id: closure.workflow.id,
              user_id: closure.workflow.userId,
            },
          });
        } else {
          await this.rejectClosure(transaction, closure, now);
          const release = await releaseWorkflowCancellationInTransaction(transaction, {
            userId: closure.workflow.userId,
            workflowRunId: closure.workflow.id,
            reservationId: closure.reservation.id,
            idempotencyKey: `release:reservation:${closure.reservation.id}:content-review:${reviewId}`,
            metadata: { reason: 'content_review_rejected', content_review_case_id: reviewId },
          });
          releasedAmount = release.releasedAmount;
          releaseLedgerId = release.ledgerId;
        }
        await appendOutboxEventInTransaction(transaction, {
          scopeType: 'workflow_run',
          scopeId: closure.workflow.id,
          eventType: 'content_review.resolved',
          payload: {
            content_review_case_id: reviewId,
            decision: input.decision,
            artifact_id: closure.artifact.id,
          },
          retentionTier: 'critical',
        });
        await this.audit(transaction, context, request, {
          reviewId,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          before: { status: closure.review.status, revision: closure.review.revision },
          after: {
            status: targetStatus,
            revision: decided.revision,
            decision: input.decision,
            released_amount: releasedAmount,
            release_ledger_id: releaseLedgerId,
          },
        });
        return {
          content_review_id: reviewId,
          status: targetStatus,
          revision: decided.revision,
          decision: input.decision,
          released_amount: releasedAmount,
          release_ledger_id: releaseLedgerId,
        };
      },
    });
  }

  private async rejectClosure(
    transaction: Transaction,
    closure: ReviewClosure,
    now: Date,
  ): Promise<void> {
    const [moderationFailed] = await transaction
      .update(tasks)
      .set({ status: 'failed', errorCode: 'CONTENT_REVIEW_REJECTED', endedAt: now })
      .where(
        and(eq(tasks.id, closure.moderationTask.id), eq(tasks.status, 'waiting_manual_review')),
      )
      .returning({ id: tasks.id });
    if (!moderationFailed) adminAuthError('ADMIN_CONTENT_REVIEW_CLOSURE_INVALID', 409);
    const siblings = await transaction.query.tasks.findMany({
      where: and(
        eq(tasks.parentTaskId, closure.generationTask!.id),
        eq(tasks.type, 'moderation.image'),
      ),
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
    const [generation] = await transaction
      .update(tasks)
      .set({ status: 'blocked', errorCode: 'CONTENT_REVIEW_REJECTED', endedAt: now })
      .where(and(eq(tasks.id, closure.generationTask!.id), eq(tasks.status, 'running')))
      .returning({ id: tasks.id });
    if (!generation) adminAuthError('ADMIN_CONTENT_REVIEW_CLOSURE_INVALID', 409);
    const [workflow] = await transaction
      .update(workflowRuns)
      .set({ status: 'failed', finishedAt: now, revision: closure.workflow.revision + 1 })
      .where(and(eq(workflowRuns.id, closure.workflow.id), eq(workflowRuns.status, 'running')))
      .returning({ id: workflowRuns.id });
    if (!workflow) adminAuthError('ADMIN_CONTENT_REVIEW_CLOSURE_INVALID', 409);
    await appendOutboxEventInTransaction(transaction, {
      scopeType: 'workflow_run',
      scopeId: closure.workflow.id,
      eventType: 'workflow.status_changed',
      payload: { from: 'running', to: 'failed' },
      retentionTier: 'critical',
    });
  }

  private async readClosure(
    database: Database | Transaction,
    reviewId: string,
    lock: boolean,
  ): Promise<ReviewClosure | null> {
    let query = database
      .select({ review: contentReviewCases, evaluation: artifactEvaluations, artifact: artifacts })
      .from(contentReviewCases)
      .innerJoin(artifactEvaluations, eq(artifactEvaluations.id, contentReviewCases.evaluationId))
      .innerJoin(artifacts, eq(artifacts.id, contentReviewCases.artifactId))
      .where(eq(contentReviewCases.id, reviewId))
      .$dynamic();
    if (lock) query = query.for('update');
    const [base] = await query.limit(1);
    if (!base || !base.evaluation.taskId) return null;
    const moderationTask = await database.query.tasks.findFirst({
      where: eq(tasks.id, base.evaluation.taskId),
    });
    const workflow = moderationTask
      ? await database.query.workflowRuns.findFirst({
          where: eq(workflowRuns.id, moderationTask.workflowRunId),
        })
      : undefined;
    const generationTask = moderationTask?.parentTaskId
      ? await database.query.tasks.findFirst({ where: eq(tasks.id, moderationTask.parentTaskId) })
      : undefined;
    const generationAttempt = generationTask
      ? await database.query.taskAttempts.findFirst({
          where: and(
            eq(taskAttempts.taskId, generationTask.id),
            eq(taskAttempts.status, 'succeeded'),
          ),
        })
      : undefined;
    const reservation = workflow?.reservationId
      ? await database.query.creditReservations.findFirst({
          where: eq(creditReservations.id, workflow.reservationId),
        })
      : undefined;
    if (!moderationTask || !workflow) return null;
    return { ...base, moderationTask, workflow, generationTask, generationAttempt, reservation };
  }

  private decodeCursor(
    context: AdminSessionContext,
    cursor: string | undefined,
    filters: unknown,
  ): CursorPosition | undefined {
    if (!cursor) return undefined;
    try {
      return this.cursor.decode({
        cursor,
        userId: context.principalId,
        endpoint: 'admin-content-reviews',
        filters,
      });
    } catch (error) {
      if (error instanceof SignedCursorError) adminAuthError('ADMIN_CURSOR_INVALID', 400);
      throw error;
    }
  }

  private async audit(
    transaction: Transaction,
    context: AdminSessionContext,
    request: AdminRequest,
    input: {
      reviewId: string;
      reason: string;
      idempotencyKey: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    },
  ): Promise<void> {
    await transaction.insert(adminAuditLogs).values({
      actorAdminId: context.principalId,
      actorType: 'admin_session',
      adminSessionId: context.id,
      permissionSnapshot: { permissions: context.permissions },
      action: 'admin.content_review.decided',
      targetType: 'content_review_case',
      targetId: input.reviewId,
      beforeJson: input.before,
      afterJson: input.after,
      reason: input.reason,
      requestId: requestId(request),
      idempotencyKeyHash: this.idempotencyHash.digest(input.idempotencyKey).digest,
      sourceIpHash: context.sourceIpHash,
      userAgentHash: context.userAgentHash,
      mfaLevel: context.mfaLevel,
      stepUpAt: context.stepUpAt,
      result: 'succeeded',
    });
  }
}

type ReviewClosure = {
  review: typeof contentReviewCases.$inferSelect;
  evaluation: typeof artifactEvaluations.$inferSelect;
  artifact: typeof artifacts.$inferSelect;
  moderationTask: typeof tasks.$inferSelect;
  workflow: typeof workflowRuns.$inferSelect;
  generationTask: typeof tasks.$inferSelect | undefined;
  generationAttempt: typeof taskAttempts.$inferSelect | undefined;
  reservation: typeof creditReservations.$inferSelect | undefined;
};

function safeArtifactMeta(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return {
    output_index: source.output_index,
    media_type: source.media_type,
    width: source.width,
    height: source.height,
    byte_length: source.byte_length,
  };
}
