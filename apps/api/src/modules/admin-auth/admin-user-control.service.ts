import { randomUUID } from 'node:crypto';

import { adminAuditLogs, and, authSessions, eq, users, type Database } from '@ecom-forge/db';
import type { UserRiskStatus } from '@ecom-forge/types';
import { Injectable } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
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
    : `admin-user-control:${randomUUID()}`;
}

@Injectable()
export class AdminUserControlService {
  private readonly idempotency: AdminIdempotencyRepository;
  private readonly idempotencyHash: HmacKeyring;

  constructor(
    private readonly database: Database,
    config: AppConfig,
  ) {
    this.idempotency = new AdminIdempotencyRepository(database, config.admin.idempotencyHashKeys);
    this.idempotencyHash = new HmacKeyring(config.admin.idempotencyHashKeys);
  }

  async updateRiskStatus(
    context: AdminSessionContext,
    request: AdminRequest,
    userId: string,
    input: {
      expectedRevision: number;
      targetStatus: UserRiskStatus;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    return this.idempotency.execute({
      context,
      operation: `admin-user/${userId}.risk-status`,
      idempotencyKey: input.idempotencyKey,
      request: {
        user_id: userId,
        expected_revision: input.expectedRevision,
        target_status: input.targetStatus,
        reason: input.reason,
      },
      responseStatus: 200,
      write: async (transaction) => {
        const [user] = await transaction
          .select()
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (!user) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        if (user.riskRevision !== input.expectedRevision) {
          adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        }

        const [updated] = await transaction
          .update(users)
          .set({
            riskStatus: input.targetStatus,
            riskRevision: input.expectedRevision + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(users.id, userId), eq(users.riskRevision, input.expectedRevision)))
          .returning({
            id: users.id,
            riskStatus: users.riskStatus,
            riskRevision: users.riskRevision,
          });
        if (!updated) adminAuthError('ADMIN_REVISION_CONFLICT', 409);

        const revokedCount =
          input.targetStatus === 'frozen'
            ? (
                await transaction
                  .delete(authSessions)
                  .where(eq(authSessions.userId, userId))
                  .returning({ id: authSessions.id })
              ).length
            : 0;
        await this.audit(transaction, context, request, {
          action: 'admin.user.risk_status_changed',
          targetId: userId,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          before: {
            risk_status: user.riskStatus,
            risk_revision: user.riskRevision,
          },
          after: {
            risk_status: updated.riskStatus,
            risk_revision: updated.riskRevision,
            revoked_session_count: revokedCount,
          },
        });
        return {
          user_id: userId,
          risk_status: updated.riskStatus,
          revision: updated.riskRevision,
          revoked_session_count: revokedCount,
        };
      },
    });
  }

  async revokeAllSessions(
    context: AdminSessionContext,
    request: AdminRequest,
    userId: string,
    input: { reason: string; idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    return this.idempotency.execute({
      context,
      operation: `admin-user/${userId}.sessions-revoke-all`,
      idempotencyKey: input.idempotencyKey,
      request: { user_id: userId, reason: input.reason },
      responseStatus: 200,
      write: async (transaction) => {
        const [user] = await transaction
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (!user) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        const revokedCount = (
          await transaction
            .delete(authSessions)
            .where(eq(authSessions.userId, userId))
            .returning({ id: authSessions.id })
        ).length;
        await this.audit(transaction, context, request, {
          action: 'admin.user.sessions_revoked_all',
          targetId: userId,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          after: { revoked_session_count: revokedCount },
        });
        return { user_id: userId, revoked_session_count: revokedCount };
      },
    });
  }

  private async audit(
    transaction: Transaction,
    context: AdminSessionContext,
    request: AdminRequest,
    input: {
      action: string;
      targetId: string;
      reason: string;
      idempotencyKey: string;
      before?: Record<string, unknown>;
      after: Record<string, unknown>;
    },
  ): Promise<void> {
    await transaction.insert(adminAuditLogs).values({
      actorAdminId: context.principalId,
      actorType: 'admin_session',
      adminSessionId: context.id,
      permissionSnapshot: { permissions: context.permissions },
      action: input.action,
      targetType: 'user',
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
