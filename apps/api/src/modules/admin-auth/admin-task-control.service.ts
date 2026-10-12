import { randomUUID } from 'node:crypto';

import {
  adminAuditLogs,
  desc,
  eq,
  queueDispatchIntents,
  taskAttempts,
  tasks,
  type Database,
} from '@ecom-forge/db';
import {
  parseQueuePayload,
  queueRecoverySentinelKey,
  recoverQueueIntentInTransaction,
} from '@ecom-forge/queue';
import { Injectable } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import type { RedisControlClient } from '../../shared/redis/redis.module.js';
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
    : `admin-task-control:${randomUUID()}`;
}

@Injectable()
export class AdminTaskControlService {
  private readonly idempotency: AdminIdempotencyRepository;
  private readonly idempotencyHash: HmacKeyring;
  private readonly referenceHash: HmacKeyring;

  constructor(
    private readonly database: Database,
    private readonly redis: RedisControlClient,
    private readonly config: AppConfig,
  ) {
    this.idempotency = new AdminIdempotencyRepository(database, config.admin.idempotencyHashKeys);
    this.idempotencyHash = new HmacKeyring(config.admin.idempotencyHashKeys);
    this.referenceHash = new HmacKeyring(config.admin.sourceHashKeys);
  }

  async recoverLocalDispatch(
    context: AdminSessionContext,
    request: AdminRequest,
    taskId: string,
    input: {
      queueDispatchIntentId: string;
      expectedIntentRevision: number;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    await this.assertQueueRecoveryReady();
    return this.idempotency.execute({
      context,
      operation: `admin-task/${taskId}.recover-local-dispatch`,
      idempotencyKey: input.idempotencyKey,
      request: {
        task_id: taskId,
        queue_dispatch_intent_id: input.queueDispatchIntentId,
        expected_intent_revision: input.expectedIntentRevision,
        reason: input.reason,
      },
      responseStatus: 200,
      write: async (transaction) => {
        const now = new Date();
        const [task] = await transaction
          .select()
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .for('update');
        if (!task) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        const [intent] = await transaction
          .select()
          .from(queueDispatchIntents)
          .where(eq(queueDispatchIntents.id, input.queueDispatchIntentId))
          .for('update');
        if (!intent || intent.aggregateType !== 'task' || intent.aggregateId !== task.id) {
          adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        }
        if (intent.revision !== input.expectedIntentRevision) {
          adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        }
        const expiredDispatch =
          intent.status === 'dispatching' &&
          intent.leaseExpiresAt !== null &&
          intent.leaseExpiresAt.getTime() <= now.getTime();
        if (intent.status !== 'pending' && !expiredDispatch) {
          adminAuthError('ADMIN_QUEUE_RECOVERY_NOT_ALLOWED', 409);
        }

        let payload: ReturnType<typeof parseQueuePayload>;
        try {
          payload = parseQueuePayload(intent.payload);
        } catch {
          adminAuthError('ADMIN_QUEUE_RECOVERY_NOT_ALLOWED', 409);
        }
        if (payload.schema_version !== intent.payloadVersion) {
          adminAuthError('ADMIN_QUEUE_RECOVERY_NOT_ALLOWED', 409);
        }
        if (payload.job_type === 'task.execute' || payload.job_type === 'moderation.execute') {
          if (payload.task_id !== task.id || payload.workflow_run_id !== task.workflowRunId) {
            adminAuthError('ADMIN_QUEUE_RECOVERY_NOT_ALLOWED', 409);
          }
          const expectedQueueName =
            payload.job_type === 'moderation.execute' ? 'moderation' : 'task';
          if (
            intent.queueName !== expectedQueueName ||
            (payload.job_type === 'moderation.execute' && task.type !== 'moderation.image')
          ) {
            adminAuthError('ADMIN_QUEUE_RECOVERY_NOT_ALLOWED', 409);
          }
          if (['succeeded', 'failed', 'cancelled', 'blocked'].includes(task.status)) {
            adminAuthError('ADMIN_QUEUE_RECOVERY_NOT_ALLOWED', 409);
          }
          const [latestAttempt] = await transaction
            .select()
            .from(taskAttempts)
            .where(eq(taskAttempts.taskId, task.id))
            .orderBy(desc(taskAttempts.attemptNo))
            .limit(1);
          if (
            latestAttempt &&
            (latestAttempt.dispatchState === 'accepted' ||
              latestAttempt.dispatchState === 'outcome_unknown' ||
              ['accepted', 'polling', 'timeout', 'outcome_unknown'].includes(latestAttempt.status))
          ) {
            adminAuthError('ADMIN_QUEUE_RECOVERY_NOT_ALLOWED', 409);
          }
        } else if (payload.job_type === 'settlement.execute') {
          if (payload.task_id !== task.id || payload.workflow_run_id !== task.workflowRunId) {
            adminAuthError('ADMIN_QUEUE_RECOVERY_NOT_ALLOWED', 409);
          }
        } else {
          adminAuthError('ADMIN_QUEUE_RECOVERY_NOT_ALLOWED', 409);
        }

        const recovered = await recoverQueueIntentInTransaction(transaction, {
          id: intent.id,
          expectedRevision: input.expectedIntentRevision,
          now,
          errorCode: 'ADMIN_LOCAL_DISPATCH_RECOVERY',
        });
        if (!recovered) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        const jobRef = this.referenceHash.digest(intent.jobId).digest;
        await this.audit(transaction, context, request, {
          targetId: task.id,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          before: {
            queue_dispatch_intent_id: intent.id,
            status: intent.status,
            revision: intent.revision,
            job_ref: jobRef,
          },
          after: {
            queue_dispatch_intent_id: recovered.id,
            status: recovered.status,
            revision: recovered.revision,
            job_ref: jobRef,
          },
        });
        return {
          task_id: task.id,
          queue_dispatch_intent_id: recovered.id,
          status: recovered.status,
          revision: recovered.revision,
          job_ref: jobRef,
        };
      },
    });
  }

  private async assertQueueRecoveryReady(): Promise<void> {
    try {
      const state = await this.redis.get(queueRecoverySentinelKey(this.config.redisPrefix));
      if (state !== 'ready') adminAuthError('ADMIN_QUEUE_RECOVERY_UNAVAILABLE', 503);
    } catch {
      adminAuthError('ADMIN_QUEUE_RECOVERY_UNAVAILABLE', 503);
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
      action: 'admin.task.local_dispatch_recovered',
      targetType: 'task',
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
