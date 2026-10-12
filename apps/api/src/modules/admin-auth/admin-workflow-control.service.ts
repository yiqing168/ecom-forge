import { randomUUID } from 'node:crypto';

import {
  CreditError,
  CreditProjectionDriftError,
  lockCreditAccount,
  releaseWorkflowCancellationInTransaction,
} from '@ecom-forge/credit';
import {
  adminAuditLogs,
  and,
  creditReservations,
  eq,
  inArray,
  queueDispatchIntents,
  sql,
  taskAttempts,
  tasks,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import { Injectable } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import { appendOutboxEventInTransaction } from '../../shared/database/outbox.repository.js';
import { HmacKeyring } from '../auth/security/hmac-keyring.js';
import { adminAuthError } from './admin-errors.js';
import type { AdminRequest, AdminSessionContext } from './admin-http.js';
import { AdminIdempotencyRepository } from './admin-idempotency.repository.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function requestId(request: AdminRequest): string {
  const value = request.headers['x-request-id'];
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : `admin-workflow-control:${randomUUID()}`;
}

@Injectable()
export class AdminWorkflowControlService {
  private readonly idempotency: AdminIdempotencyRepository;
  private readonly idempotencyHash: HmacKeyring;

  constructor(
    private readonly database: Database,
    config: AppConfig,
  ) {
    this.idempotency = new AdminIdempotencyRepository(database, config.admin.idempotencyHashKeys);
    this.idempotencyHash = new HmacKeyring(config.admin.idempotencyHashKeys);
  }

  async cancel(
    context: AdminSessionContext,
    request: AdminRequest,
    workflowRunId: string,
    input: { expectedRunRevision: number; reason: string; idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    try {
      return await this.idempotency.execute({
        context,
        operation: `admin-workflow/${workflowRunId}.cancel`,
        idempotencyKey: input.idempotencyKey,
        request: {
          workflow_run_id: workflowRunId,
          expected_run_revision: input.expectedRunRevision,
          reason: input.reason,
        },
        responseStatus: 200,
        write: async (transaction) => {
          const preliminary = await transaction.query.workflowRuns.findFirst({
            where: eq(workflowRuns.id, workflowRunId),
            columns: { userId: true, reservationId: true },
          });
          if (!preliminary) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);

          if (preliminary.reservationId) {
            await lockCreditAccount(transaction, preliminary.userId);
            const [reservation] = await transaction
              .select({ id: creditReservations.id })
              .from(creditReservations)
              .where(
                and(
                  eq(creditReservations.id, preliminary.reservationId),
                  eq(creditReservations.userId, preliminary.userId),
                  eq(creditReservations.workflowRunId, workflowRunId),
                ),
              )
              .for('update');
            if (!reservation) adminAuthError('ADMIN_WORKFLOW_CANCEL_NOT_ALLOWED', 409);
          }

          const [workflow] = await transaction
            .select()
            .from(workflowRuns)
            .where(eq(workflowRuns.id, workflowRunId))
            .for('update');
          if (!workflow) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
          if (workflow.revision !== input.expectedRunRevision) {
            adminAuthError('ADMIN_REVISION_CONFLICT', 409);
          }
          if (!['queued', 'running'].includes(workflow.status)) {
            adminAuthError('ADMIN_WORKFLOW_CANCEL_NOT_ALLOWED', 409);
          }

          const workflowTasks = await transaction
            .select()
            .from(tasks)
            .where(eq(tasks.workflowRunId, workflow.id))
            .orderBy(tasks.id)
            .for('update');
          if (
            workflowTasks.some((task) =>
              ['succeeded', 'waiting_manual_review'].includes(task.status),
            )
          ) {
            adminAuthError('ADMIN_WORKFLOW_CANCEL_NOT_ALLOWED', 409);
          }
          const taskIds = workflowTasks.map((task) => task.id);
          const attempts =
            taskIds.length > 0
              ? await transaction
                  .select()
                  .from(taskAttempts)
                  .where(inArray(taskAttempts.taskId, taskIds))
                  .orderBy(taskAttempts.taskId, taskAttempts.attemptNo)
                  .for('update')
              : [];
          if (
            attempts.some(
              (attempt) =>
                attempt.dispatchState !== 'not_dispatched' ||
                !['created', 'failed', 'timeout'].includes(attempt.status),
            )
          ) {
            adminAuthError('ADMIN_WORKFLOW_CANCEL_NOT_ALLOWED', 409);
          }

          const now = new Date();
          const cancellableTaskIds = workflowTasks
            .filter((task) => ['pending', 'queued', 'running'].includes(task.status))
            .map((task) => task.id);
          if (cancellableTaskIds.length > 0) {
            await transaction
              .update(tasks)
              .set({ status: 'cancelled', endedAt: now })
              .where(inArray(tasks.id, cancellableTaskIds));
            await transaction
              .update(queueDispatchIntents)
              .set({
                status: 'cancelled',
                revision: sql`${queueDispatchIntents.revision} + 1`,
                leaseOwner: null,
                leaseExpiresAt: null,
                lastErrorCode: 'ADMIN_WORKFLOW_CANCELLED',
                updatedAt: now,
              })
              .where(
                and(
                  eq(queueDispatchIntents.aggregateType, 'task'),
                  inArray(queueDispatchIntents.aggregateId, cancellableTaskIds),
                  sql`${queueDispatchIntents.status} <> 'cancelled'`,
                ),
              );
          }

          const [cancelled] = await transaction
            .update(workflowRuns)
            .set({
              status: 'cancelled',
              revision: input.expectedRunRevision + 1,
              finishedAt: now,
            })
            .where(
              and(
                eq(workflowRuns.id, workflow.id),
                eq(workflowRuns.revision, input.expectedRunRevision),
                eq(workflowRuns.status, workflow.status),
              ),
            )
            .returning({ revision: workflowRuns.revision });
          if (!cancelled) adminAuthError('ADMIN_REVISION_CONFLICT', 409);

          const release = workflow.reservationId
            ? await releaseWorkflowCancellationInTransaction(transaction, {
                userId: workflow.userId,
                workflowRunId: workflow.id,
                reservationId: workflow.reservationId,
                idempotencyKey: `release:reservation:${workflow.reservationId}:admin-cancel`,
                metadata: {
                  reason: 'admin_workflow_cancel',
                  admin_principal_id: context.principalId,
                },
              })
            : null;

          for (const task of workflowTasks) {
            if (!cancellableTaskIds.includes(task.id)) continue;
            await appendOutboxEventInTransaction(transaction, {
              scopeType: 'workflow_run',
              scopeId: workflow.id,
              eventType: 'task.status_changed',
              payload: { task_id: task.id, from: task.status, to: 'cancelled' },
              retentionTier: 'critical',
            });
          }
          await appendOutboxEventInTransaction(transaction, {
            scopeType: 'workflow_run',
            scopeId: workflow.id,
            eventType: 'workflow.status_changed',
            payload: { from: workflow.status, to: 'cancelled' },
            retentionTier: 'critical',
          });
          await this.audit(transaction, context, request, {
            targetId: workflow.id,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
            before: {
              status: workflow.status,
              revision: workflow.revision,
              task_count: workflowTasks.length,
            },
            after: {
              status: 'cancelled',
              revision: cancelled.revision,
              cancelled_task_count: cancellableTaskIds.length,
              released_amount: release?.releasedAmount ?? '0.00',
              release_ledger_id: release?.ledgerId ?? null,
            },
          });
          return {
            workflow_run_id: workflow.id,
            status: 'cancelled',
            revision: cancelled.revision,
            cancelled_task_count: cancellableTaskIds.length,
            released_amount: release?.releasedAmount ?? '0.00',
            release_ledger_id: release?.ledgerId ?? null,
          };
        },
      });
    } catch (error) {
      if (error instanceof CreditProjectionDriftError) {
        adminAuthError('ADMIN_CREDIT_PROJECTION_DRIFT', 503);
      }
      if (error instanceof CreditError) {
        adminAuthError('ADMIN_WORKFLOW_CANCEL_NOT_ALLOWED', 409);
      }
      throw error;
    }
  }

  private async audit(
    transaction: Transaction,
    context: AdminSessionContext,
    request: AdminRequest,
    input: {
      targetId: string;
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
      action: 'admin.workflow.cancelled',
      targetType: 'workflow_run',
      targetId: input.targetId,
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
