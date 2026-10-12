import { randomUUID } from 'node:crypto';

import {
  applyAdminManualCorrectionInTransaction,
  CreditError,
  CreditProjectionDriftError,
} from '@ecom-forge/credit';
import {
  adminAuditLogs,
  and,
  creditAccounts,
  creditLedger,
  desc,
  eq,
  lt,
  or,
  replayLedgerProjection,
  type Database,
  users,
} from '@ecom-forge/db';
import { compareMoney, normalizeMoney } from '@ecom-forge/shared';
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

type ReconcileInput = { cursor?: string; limit: number; userId?: string };
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function requestId(request: AdminRequest): string {
  const value = request.headers['x-request-id'];
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : `admin-credit:${randomUUID()}`;
}

@Injectable()
export class AdminCreditService {
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

  async correct(
    context: AdminSessionContext,
    request: AdminRequest,
    input: { userId: string; amount: string; reason: string; idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    const amount = normalizeMoney(input.amount);
    if (compareMoney(amount, '0.00') === 0) {
      adminAuthError('ADMIN_CREDIT_CORRECTION_INVALID', 400);
    }
    const idempotencyDigest = this.idempotencyHash.digest(input.idempotencyKey).digest;
    try {
      return await this.idempotency.execute({
        context,
        operation: 'admin-credit.correct',
        idempotencyKey: input.idempotencyKey,
        request: {
          user_id: input.userId,
          amount,
          reason: input.reason,
        },
        responseStatus: 201,
        write: async (transaction) => {
          const user = await transaction.query.users.findFirst({
            where: eq(users.id, input.userId),
            columns: { id: true },
          });
          if (!user) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
          const correction = await applyAdminManualCorrectionInTransaction(transaction, {
            userId: input.userId,
            amount,
            ledgerIdempotencyKey: `manual-correction:${context.principalId}:${idempotencyDigest}`,
            metadata: { source: 'admin_manual_correction' },
          });
          const userRef = this.referenceHash.digest(input.userId).digest;
          await this.auditCorrection(transaction, context, request, {
            userId: input.userId,
            userRef,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
            before: {
              balance: correction.balanceBefore,
              version: correction.versionBefore,
            },
            after: {
              amount: correction.amount,
              balance: correction.balanceAfter,
              ledger_id: correction.ledgerId,
              version: correction.version,
            },
          });
          return {
            user_ref: userRef,
            amount: correction.amount,
            balance_after: correction.balanceAfter,
            ledger_id: correction.ledgerId,
            account_version: correction.version,
          };
        },
      });
    } catch (error) {
      if (error instanceof CreditProjectionDriftError) {
        adminAuthError('ADMIN_CREDIT_PROJECTION_DRIFT', 503);
      }
      if (error instanceof CreditError) {
        adminAuthError(
          error.code === 'INSUFFICIENT_CREDITS'
            ? 'ADMIN_CREDIT_CORRECTION_NEGATIVE_BALANCE'
            : 'ADMIN_CREDIT_CORRECTION_CONFLICT',
          409,
        );
      }
      throw error;
    }
  }

  async reconcile(
    context: AdminSessionContext,
    input: ReconcileInput,
  ): Promise<Record<string, unknown>> {
    const filters = { user_id: input.userId ?? null };
    const position = this.decodeCursor(context, input.cursor, filters);
    const rows = await this.database
      .select()
      .from(creditAccounts)
      .where(
        and(
          input.userId ? eq(creditAccounts.userId, input.userId) : undefined,
          position
            ? or(
                lt(creditAccounts.updatedAt, position.createdAt),
                and(
                  eq(creditAccounts.updatedAt, position.createdAt),
                  lt(creditAccounts.userId, position.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(creditAccounts.updatedAt), desc(creditAccounts.userId))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const items = await Promise.all(page.map((account) => this.reconcileAccount(account)));
    const last = page.at(-1);
    return {
      items,
      summary: {
        checked: items.length,
        drifted: items.filter((item) => item.status === 'drift').length,
      },
      next_cursor:
        rows.length > input.limit && last
          ? this.cursor.encode({
              userId: context.principalId,
              endpoint: 'admin-credit-reconcile',
              filters,
              position: { id: last.userId, createdAt: last.updatedAt },
            })
          : null,
    };
  }

  private async reconcileAccount(
    account: typeof creditAccounts.$inferSelect,
  ): Promise<Record<string, unknown>> {
    const entries = await this.database.query.creditLedger.findMany({
      where: eq(creditLedger.userId, account.userId),
      columns: {
        id: true,
        accountVersion: true,
        balanceAfter: true,
        frozenAfter: true,
        createdAt: true,
      },
    });
    const reasons: string[] = [];
    if (entries.length !== account.version) reasons.push('ledger_count_mismatch');
    const legacyEntries = entries
      .filter((entry) => entry.accountVersion == null)
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      );
    const versionedEntries = entries
      .filter(
        (entry): entry is typeof entry & { accountVersion: number } =>
          entry.accountVersion !== null && entry.accountVersion !== undefined,
      )
      .sort((left, right) => left.accountVersion - right.accountVersion);
    for (const [index, entry] of versionedEntries.entries()) {
      if (entry.accountVersion !== legacyEntries.length + index + 1) {
        reasons.push('account_version_gap');
        break;
      }
    }

    let replayedBalance: string | null = null;
    let replayedFrozen: string | null = null;
    try {
      const replayed = replayLedgerProjection([...legacyEntries, ...versionedEntries]);
      replayedBalance = replayed.balance;
      replayedFrozen = replayed.frozen;
      if (compareMoney(normalizeMoney(account.balance), replayed.balance) !== 0) {
        reasons.push('balance_mismatch');
      }
      if (compareMoney(normalizeMoney(account.frozen), replayed.frozen) !== 0) {
        reasons.push('frozen_mismatch');
      }
    } catch {
      reasons.push('invalid_ledger_snapshot');
    }

    return {
      user_ref: this.referenceHash.digest(account.userId).digest,
      status: reasons.length === 0 ? 'healthy' : 'drift',
      reasons: [...new Set(reasons)],
      account: {
        balance: account.balance,
        frozen: account.frozen,
        version: account.version,
        updated_at: account.updatedAt,
      },
      replay: {
        balance: replayedBalance,
        frozen: replayedFrozen,
        ledger_count: entries.length,
      },
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
        endpoint: 'admin-credit-reconcile',
        filters,
      });
    } catch (error) {
      if (error instanceof SignedCursorError) adminAuthError('ADMIN_CURSOR_INVALID', 400);
      throw error;
    }
  }

  private async auditCorrection(
    transaction: Transaction,
    context: AdminSessionContext,
    request: AdminRequest,
    input: {
      userId: string;
      userRef: string;
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
      action: 'admin.credit.corrected',
      targetType: 'credit_account',
      targetId: input.userId,
      beforeJson: { ...input.before, user_ref: input.userRef },
      afterJson: { ...input.after, user_ref: input.userRef },
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
