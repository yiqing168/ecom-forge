import { randomUUID } from 'node:crypto';

import {
  adminAuditLogs,
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  inviteCodes,
  lt,
  or,
  registrationClaims,
  sql,
  type Database,
} from '@ecom-forge/db';
import { Injectable } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import { SignedCursorCodec, SignedCursorError } from '../../shared/http/signed-cursor.js';
import { InviteCodeService } from '../auth/invite/invite-code.service.js';
import { HmacKeyring } from '../auth/security/hmac-keyring.js';
import { adminAuthError } from './admin-errors.js';
import { SecretEnvelope } from './admin-crypto.js';
import type { AdminRequest, AdminSessionContext } from './admin-http.js';
import { AdminIdempotencyRepository } from './admin-idempotency.repository.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type InviteRow = typeof inviteCodes.$inferSelect;
type InviteStatus = 'unused' | 'used' | 'disabled' | 'expired';

function requestId(request: AdminRequest): string {
  const value = request.headers['x-request-id'];
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : `admin-invite:${randomUUID()}`;
}

@Injectable()
export class AdminInviteCodeService {
  private readonly idempotency: AdminIdempotencyRepository;
  private readonly idempotencyHash: HmacKeyring;
  private readonly inviteHash: HmacKeyring;
  private readonly inviteEnvelope: SecretEnvelope;
  private readonly cursor: SignedCursorCodec;

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
  ) {
    this.idempotency = new AdminIdempotencyRepository(database, config.admin.idempotencyHashKeys);
    this.idempotencyHash = new HmacKeyring(config.admin.idempotencyHashKeys);
    this.inviteHash = new HmacKeyring(config.auth.inviteHashKeys);
    this.inviteEnvelope = new SecretEnvelope(config.auth.inviteCodeEncryptionKeys);
    this.cursor = new SignedCursorCodec(config.resourceCursorSecret);
  }

  async list(
    context: AdminSessionContext,
    input: { status?: InviteStatus; cursor?: string; limit: number },
  ): Promise<Record<string, unknown>> {
    const filters = { status: input.status ?? null };
    let position;
    try {
      position = input.cursor
        ? this.cursor.decode({
            cursor: input.cursor,
            userId: context.principalId,
            endpoint: 'admin-invites',
            filters,
          })
        : undefined;
    } catch (error) {
      if (error instanceof SignedCursorError) adminAuthError('ADMIN_CURSOR_INVALID', 400);
      throw error;
    }

    const now = new Date();
    const rows = await this.database
      .select()
      .from(inviteCodes)
      .where(
        and(
          this.statusFilter(input.status, now),
          position
            ? or(
                lt(inviteCodes.createdAt, position.createdAt),
                and(eq(inviteCodes.createdAt, position.createdAt), lt(inviteCodes.id, position.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(inviteCodes.createdAt), desc(inviteCodes.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const activeClaims = await this.activeClaims(
      this.database,
      page.map((row) => row.id),
      now,
    );
    const last = page.at(-1);

    return {
      items: page.map((row) => this.response(row, activeClaims.get(row.id) ?? 0, now)),
      next_cursor:
        rows.length > input.limit && last
          ? this.cursor.encode({
              userId: context.principalId,
              endpoint: 'admin-invites',
              filters,
              position: { createdAt: last.createdAt, id: last.id },
            })
          : null,
    };
  }

  async generate(
    context: AdminSessionContext,
    request: AdminRequest,
    input: { count: number; expiresAt: Date | null; idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    if (input.count > this.config.admin.inviteLimits.batchMax) {
      adminAuthError('INVITE_BATCH_LIMIT_EXCEEDED', 422);
    }
    if (input.expiresAt && input.expiresAt <= new Date()) {
      adminAuthError('INVITE_EXPIRY_INVALID', 422);
    }

    return this.idempotency.execute({
      context,
      operation: 'invite_code.generate',
      idempotencyKey: input.idempotencyKey,
      request: {
        count: input.count,
        expires_at: input.expiresAt?.toISOString() ?? null,
      },
      responseStatus: 201,
      persistResponse: (response) => ({
        count: response.count,
        plaintext_available: false,
        codes: Array.isArray(response.codes)
          ? response.codes.map((code) => {
              const value = code as { id?: unknown; prefix?: unknown };
              return { id: value.id, prefix: value.prefix };
            })
          : [],
      }),
      write: async (transaction) => {
        const now = new Date();
        const inviteService = new InviteCodeService(
          {
            create: async (persist) => {
              const [created] = await transaction
                .insert(inviteCodes)
                .values({
                  legacyCode: null,
                  codeDigest: persist.codeDigest,
                  keyId: persist.keyId,
                  codePrefix: persist.codePrefix,
                  emailAllowlist: [],
                  maxUses: 1,
                  expiresAt: persist.expiresAt,
                  issuedBy: null,
                  issuedByAdminId: context.principalId,
                  createdAt: now,
                })
                .returning({ id: inviteCodes.id });
              if (!created) adminAuthError('ADMIN_WRITE_FAILED', 503);
              return created;
            },
          },
          this.inviteHash,
        );
        const codes: Array<{ id: string; prefix: string; plaintext_code: string }> = [];
        for (let index = 0; index < input.count; index += 1) {
          const created = await inviteService.createInvite({
            maxUses: 1,
            emailAllowlist: [],
            expiresAt: input.expiresAt,
            issuedBy: null,
            issuedByAdminId: context.principalId,
          });
          const encrypted = this.inviteEnvelope.encrypt(created.plaintextCode);
          const [encryptedInvite] = await transaction
            .update(inviteCodes)
            .set({
              codeCiphertext: encrypted.ciphertext,
              codeNonce: encrypted.nonce,
              codeAuthTag: encrypted.authTag,
              codeEncryptionKeyId: encrypted.keyId,
            })
            .where(eq(inviteCodes.id, created.id))
            .returning({ id: inviteCodes.id });
          if (!encryptedInvite) adminAuthError('ADMIN_WRITE_FAILED', 503);
          codes.push({
            id: created.id,
            prefix: created.codePrefix,
            plaintext_code: created.plaintextCode,
          });
        }
        await this.audit(transaction, context, request, {
          action: 'invite_code.generated',
          targetType: 'invite_code_set',
          targetId: null,
          reason: 'admin_invite_management',
          idempotencyKey: input.idempotencyKey,
          after: {
            count: codes.length,
            expires_at: input.expiresAt?.toISOString() ?? null,
            code_ids: codes.map((code) => code.id),
            code_prefixes: codes.map((code) => code.prefix),
          },
        });
        return { count: codes.length, plaintext_available: true, codes };
      },
    });
  }

  async reveal(
    context: AdminSessionContext,
    request: AdminRequest,
    inviteId: string,
  ): Promise<Record<string, unknown>> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(inviteCodes)
        .where(eq(inviteCodes.id, inviteId))
        .for('update')
        .limit(1);
      if (!row) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);

      const now = new Date();
      const activeClaims = await this.activeClaims(transaction, [inviteId], now);
      if (!this.canCopy(row, activeClaims.get(inviteId) ?? 0, now)) {
        adminAuthError('INVITE_PLAINTEXT_UNAVAILABLE', 409);
      }

      let plaintextCode: string;
      try {
        plaintextCode = this.inviteEnvelope.decrypt({
          keyId: row.codeEncryptionKeyId!,
          ciphertext: row.codeCiphertext!,
          nonce: row.codeNonce!,
          authTag: row.codeAuthTag!,
        });
        if (
          !row.keyId ||
          !row.codeDigest ||
          !this.inviteHash.verify(plaintextCode, { keyId: row.keyId, digest: row.codeDigest })
        ) {
          adminAuthError('INVITE_PLAINTEXT_UNAVAILABLE', 409);
        }
      } catch {
        adminAuthError('INVITE_PLAINTEXT_UNAVAILABLE', 409);
      }

      await this.audit(transaction, context, request, {
        action: 'invite_code.revealed',
        targetType: 'invite_code',
        targetId: inviteId,
        reason: 'admin_invite_copy',
        after: { prefix: row.codePrefix, revealed_at: now.toISOString() },
      });
      return { id: row.id, prefix: row.codePrefix, plaintext_code: plaintextCode! };
    });
  }

  async disable(
    context: AdminSessionContext,
    request: AdminRequest,
    inviteId: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    return this.disableMany(context, request, [inviteId], idempotencyKey, 'invite_code.disable');
  }

  async disableBatch(
    context: AdminSessionContext,
    request: AdminRequest,
    inviteIds: readonly string[],
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    return this.disableMany(
      context,
      request,
      inviteIds,
      idempotencyKey,
      'invite_code.disable_batch',
    );
  }

  private async disableMany(
    context: AdminSessionContext,
    request: AdminRequest,
    requestedIds: readonly string[],
    idempotencyKey: string,
    operation: string,
  ): Promise<Record<string, unknown>> {
    const inviteIds = [...new Set(requestedIds)].sort();
    return this.idempotency.execute({
      context,
      operation,
      idempotencyKey,
      request: { invite_ids: inviteIds },
      responseStatus: 200,
      write: async (transaction) => {
        const rows = await transaction
          .select()
          .from(inviteCodes)
          .where(inArray(inviteCodes.id, inviteIds))
          .orderBy(asc(inviteCodes.id))
          .for('update');
        if (rows.length !== inviteIds.length) {
          adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        }

        const now = new Date();
        const activeClaims = await this.activeClaims(transaction, inviteIds, now);
        if (rows.some((row) => !this.canDisable(row, activeClaims.get(row.id) ?? 0, now))) {
          adminAuthError('INVITE_DISABLE_INVALID', 409);
        }

        const updated = await transaction
          .update(inviteCodes)
          .set({ disabledAt: now, revision: sql`${inviteCodes.revision} + 1` })
          .where(
            and(
              inArray(inviteCodes.id, inviteIds),
              sql`${inviteCodes.disabledAt} is null`,
              eq(inviteCodes.usedCount, 0),
              or(sql`${inviteCodes.expiresAt} is null`, gt(inviteCodes.expiresAt, now)),
            ),
          )
          .returning();
        if (updated.length !== inviteIds.length) {
          adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        }

        await this.audit(transaction, context, request, {
          action: inviteIds.length === 1 ? 'invite_code.disabled' : 'invite_code.batch_disabled',
          targetType: inviteIds.length === 1 ? 'invite_code' : 'invite_code_set',
          targetId: inviteIds.length === 1 ? inviteIds[0]! : null,
          reason: 'admin_invite_management',
          idempotencyKey,
          after: { invite_ids: inviteIds, disabled_at: now.toISOString() },
        });
        return {
          disabled_count: updated.length,
          items: updated.map((row) => this.response(row, 0, now)),
        };
      },
    });
  }

  private statusFilter(status: InviteStatus | undefined, now: Date) {
    if (status === 'disabled') return sql`${inviteCodes.disabledAt} is not null`;
    if (status === 'used') {
      return and(sql`${inviteCodes.disabledAt} is null`, gt(inviteCodes.usedCount, 0));
    }
    if (status === 'expired') {
      return and(
        sql`${inviteCodes.disabledAt} is null`,
        eq(inviteCodes.usedCount, 0),
        sql`${inviteCodes.expiresAt} is not null`,
        sql`${inviteCodes.expiresAt} <= ${now}`,
      );
    }
    if (status === 'unused') {
      return and(
        sql`${inviteCodes.disabledAt} is null`,
        eq(inviteCodes.usedCount, 0),
        or(sql`${inviteCodes.expiresAt} is null`, gt(inviteCodes.expiresAt, now)),
      );
    }
    return undefined;
  }

  private async activeClaims(
    executor: Pick<Database, 'select'>,
    inviteIds: readonly string[],
    now: Date,
  ): Promise<Map<string, number>> {
    if (inviteIds.length === 0) return new Map();
    const rows = await executor
      .select({ inviteId: registrationClaims.inviteCodeId, value: count() })
      .from(registrationClaims)
      .where(
        and(
          inArray(registrationClaims.inviteCodeId, inviteIds),
          or(
            and(eq(registrationClaims.status, 'pending'), gt(registrationClaims.expiresAt, now)),
            eq(registrationClaims.status, 'verified'),
          ),
        ),
      )
      .groupBy(registrationClaims.inviteCodeId);
    return new Map(rows.map((row) => [row.inviteId, Number(row.value)]));
  }

  private canDisable(row: InviteRow, activeClaimCount: number, now: Date): boolean {
    return (
      row.disabledAt === null &&
      row.usedCount === 0 &&
      activeClaimCount === 0 &&
      (row.expiresAt === null || row.expiresAt > now)
    );
  }

  private canCopy(row: InviteRow, activeClaimCount: number, now: Date): boolean {
    return (
      this.canDisable(row, activeClaimCount, now) &&
      row.codeCiphertext !== null &&
      row.codeNonce !== null &&
      row.codeAuthTag !== null &&
      row.codeEncryptionKeyId !== null &&
      row.keyId !== null &&
      row.codeDigest !== null
    );
  }

  private response(row: InviteRow, activeClaimCount: number, now: Date): Record<string, unknown> {
    const status: InviteStatus = row.disabledAt
      ? 'disabled'
      : row.usedCount > 0
        ? 'used'
        : row.expiresAt && row.expiresAt <= now
          ? 'expired'
          : 'unused';
    return {
      id: row.id,
      prefix: row.codePrefix,
      status,
      used_count: row.usedCount,
      expires_at: row.expiresAt,
      created_at: row.createdAt,
      can_disable: this.canDisable(row, activeClaimCount, now),
      can_copy: this.canCopy(row, activeClaimCount, now),
    };
  }

  private async audit(
    transaction: Transaction,
    context: AdminSessionContext,
    request: AdminRequest,
    input: {
      action: string;
      targetType: string;
      targetId: string | null;
      reason: string;
      idempotencyKey?: string;
      after: Record<string, unknown>;
    },
  ): Promise<void> {
    await transaction.insert(adminAuditLogs).values({
      actorAdminId: context.principalId,
      actorType: 'admin_session',
      adminSessionId: context.id,
      permissionSnapshot: { permissions: context.permissions },
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      afterJson: input.after,
      reason: input.reason,
      requestId: requestId(request),
      idempotencyKeyHash: input.idempotencyKey
        ? this.idempotencyHash.digest(input.idempotencyKey).digest
        : null,
      sourceIpHash: context.sourceIpHash,
      userAgentHash: context.userAgentHash,
      mfaLevel: context.mfaLevel,
      stepUpAt: context.stepUpAt,
      result: 'succeeded',
    });
  }
}
