import { randomUUID } from 'node:crypto';

import {
  CreditError,
  CreditProjectionDriftError,
  refundAppealByAdminInTransaction,
} from '@ecom-forge/credit';
import {
  adminAuditLogs,
  and,
  appeals,
  creditLedger,
  desc,
  eq,
  lt,
  or,
  type Database,
} from '@ecom-forge/db';
import { compareMoney, normalizeMoney, type MoneyString } from '@ecom-forge/shared';
import type { AppealStatus } from '@ecom-forge/types';
import { Injectable } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
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
type PageInput = { cursor?: string; limit: number; status?: AppealStatus };

function requestId(request: AdminRequest): string {
  const value = request.headers['x-request-id'];
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : `admin-appeal:${randomUUID()}`;
}

function screenshotAssetIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(item),
  );
}

@Injectable()
export class AdminAppealService {
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
    const filters = { status: input.status ?? null };
    const position = this.decodeCursor(context, input.cursor, filters);
    const rows = await this.database
      .select()
      .from(appeals)
      .where(
        and(
          input.status ? eq(appeals.status, input.status) : undefined,
          position
            ? or(
                lt(appeals.createdAt, position.createdAt),
                and(eq(appeals.createdAt, position.createdAt), lt(appeals.id, position.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(appeals.createdAt), desc(appeals.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((appeal) => this.summary(appeal)),
      next_cursor:
        rows.length > input.limit && last
          ? this.cursor.encode({
              userId: context.principalId,
              endpoint: 'admin-appeals',
              filters,
              position: { id: last.id, createdAt: last.createdAt },
            })
          : null,
    };
  }

  async detail(appealId: string): Promise<Record<string, unknown>> {
    const [row] = await this.database
      .select({ appeal: appeals, originalLedger: creditLedger })
      .from(appeals)
      .innerJoin(creditLedger, eq(creditLedger.id, appeals.ledgerId))
      .where(eq(appeals.id, appealId))
      .limit(1);
    if (!row) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    const decisionLedger = row.appeal.decisionLedgerId
      ? await this.database.query.creditLedger.findFirst({
          where: eq(creditLedger.id, row.appeal.decisionLedgerId),
        })
      : null;
    return {
      ...this.summary(row.appeal),
      reason: row.appeal.reason,
      screenshot_asset_ids: screenshotAssetIds(row.appeal.screenshots),
      original_ledger: {
        id: row.originalLedger.id,
        type: row.originalLedger.type,
        amount: row.originalLedger.amount,
        workflow_run_id: row.originalLedger.workflowRunId,
        task_id: row.originalLedger.taskId,
        created_at: row.originalLedger.createdAt,
      },
      decision_ledger: decisionLedger
        ? {
            id: decisionLedger.id,
            type: decisionLedger.type,
            amount: decisionLedger.amount,
            created_at: decisionLedger.createdAt,
          }
        : null,
    };
  }

  async decide(
    context: AdminSessionContext,
    request: AdminRequest,
    appealId: string,
    input: {
      expectedRevision: number;
      decision: 'refund' | 'reject';
      refundAmount: string;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    const amount = normalizeMoney(input.refundAmount);
    if (
      (input.decision === 'refund' && compareMoney(amount, '0.00') <= 0) ||
      (input.decision === 'reject' && compareMoney(amount, '0.00') !== 0)
    ) {
      adminAuthError('ADMIN_APPEAL_DECISION_INVALID', 400);
    }
    const idempotencyDigest = this.idempotencyHash.digest(input.idempotencyKey).digest;
    try {
      return await this.idempotency.execute({
        context,
        operation: `admin-appeal/${appealId}.decide`,
        idempotencyKey: input.idempotencyKey,
        request: {
          appeal_id: appealId,
          expected_revision: input.expectedRevision,
          decision: input.decision,
          refund_amount: amount,
          reason: input.reason,
        },
        responseStatus: 200,
        write: async (transaction) => {
          const current = await transaction.query.appeals.findFirst({
            where: eq(appeals.id, appealId),
          });
          if (!current) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);

          let decisionLedgerId: string | null = null;
          let balanceAfter: MoneyString | null = null;
          let nextRevision: number;
          if (input.decision === 'refund') {
            const refund = await refundAppealByAdminInTransaction(transaction, {
              userId: current.userId,
              appealId,
              reviewerAdminId: context.principalId,
              expectedRevision: input.expectedRevision,
              decisionReason: input.reason,
              amount,
              ledgerIdempotencyKey: `appeal-refund:${appealId}:${idempotencyDigest}`,
              decisionIdempotencyKeyHash: idempotencyDigest,
              metadata: { source: 'admin_appeal_decision' },
            });
            decisionLedgerId = refund.ledgerId;
            balanceAfter = refund.balanceAfter;
            nextRevision = refund.appealRevision;
          } else {
            const [rejected] = await transaction
              .update(appeals)
              .set({
                status: 'rejected',
                refundAmount: '0.00',
                reviewerId: null,
                reviewerAdminId: context.principalId,
                decisionReason: input.reason,
                decisionLedgerId: null,
                revision: input.expectedRevision + 1,
                decisionIdempotencyKeyHash: idempotencyDigest,
                reviewedAt: new Date(),
              })
              .where(
                and(
                  eq(appeals.id, appealId),
                  eq(appeals.status, 'pending'),
                  eq(appeals.revision, input.expectedRevision),
                ),
              )
              .returning({ revision: appeals.revision });
            if (!rejected) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
            nextRevision = rejected.revision;
          }

          await this.audit(transaction, context, request, {
            appealId,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
            before: { status: current.status, revision: current.revision },
            after: {
              status: input.decision === 'refund' ? 'refunded' : 'rejected',
              revision: nextRevision,
              refund_amount: amount,
              decision_ledger_id: decisionLedgerId,
            },
          });
          return {
            appeal_id: appealId,
            status: input.decision === 'refund' ? 'refunded' : 'rejected',
            revision: nextRevision,
            refund_amount: amount,
            decision_ledger_id: decisionLedgerId,
            balance_after: balanceAfter,
          };
        },
      });
    } catch (error) {
      if (error instanceof CreditProjectionDriftError) {
        adminAuthError('ADMIN_CREDIT_PROJECTION_DRIFT', 503);
      }
      if (error instanceof CreditError) {
        adminAuthError('ADMIN_APPEAL_DECISION_CONFLICT', 409);
      }
      throw error;
    }
  }

  private summary(appeal: typeof appeals.$inferSelect): Record<string, unknown> {
    return {
      id: appeal.id,
      user_ref: this.referenceHash.digest(appeal.userId).digest,
      ledger_id: appeal.ledgerId,
      status: appeal.status,
      refund_amount: appeal.refundAmount,
      revision: appeal.revision,
      decision_reason: appeal.decisionReason,
      decision_ledger_id: appeal.decisionLedgerId,
      created_at: appeal.createdAt,
      reviewed_at: appeal.reviewedAt,
    };
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
        endpoint: 'admin-appeals',
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
      appealId: string;
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
      action: 'admin.appeal.decided',
      targetType: 'appeal',
      targetId: input.appealId,
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
