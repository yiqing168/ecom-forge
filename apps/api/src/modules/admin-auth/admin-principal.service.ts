import { randomBytes, randomUUID } from 'node:crypto';

import {
  adminAuditLogs,
  adminAuthChallenges,
  adminCredentials,
  adminEnrollmentTokens,
  adminMfaRecoveryCodes,
  adminPrincipals,
  adminRoleBindings,
  adminSessions,
  and,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  type Database,
} from '@ecom-forge/db';
import { scopedAdvisoryLockKey } from '@ecom-forge/shared';
import { Injectable } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import { HmacKeyring } from '../auth/security/hmac-keyring.js';
import { normalizeAdminIdentifier } from './admin-crypto.js';
import { adminAuthError } from './admin-errors.js';
import type { AdminRequest, AdminSessionContext } from './admin-http.js';
import { AdminIdempotencyRepository } from './admin-idempotency.repository.js';
import { isAdminRoleKey, permissionSnapshotHash, type AdminRoleKey } from './admin-roles.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

interface RoleBindingInput {
  roleKey: AdminRoleKey;
  scopeType: string;
  scopeKey: string;
}

function now(): Date {
  return new Date();
}

function enrollmentToken(): string {
  return randomBytes(32).toString('base64url');
}

function requestId(request: AdminRequest): string {
  const value = request.headers['x-request-id'];
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : `admin-principal:${randomUUID()}`;
}

@Injectable()
export class AdminPrincipalService {
  private readonly identifierHash: HmacKeyring;
  private readonly enrollmentHash: HmacKeyring;
  private readonly idempotencyHash: HmacKeyring;
  private readonly idempotency: AdminIdempotencyRepository;

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
  ) {
    this.identifierHash = new HmacKeyring(config.admin.identifierHashKeys);
    this.enrollmentHash = new HmacKeyring(config.admin.enrollmentHashKeys);
    this.idempotencyHash = new HmacKeyring(config.admin.idempotencyHashKeys);
    this.idempotency = new AdminIdempotencyRepository(database, config.admin.idempotencyHashKeys);
  }

  async create(
    context: AdminSessionContext,
    request: AdminRequest,
    input: {
      identifier: string;
      displayName: string;
      roleKey: string;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    const identifier = normalizeAdminIdentifier(input.identifier);
    const displayName = input.displayName.normalize('NFKC').trim();
    const role = this.parseRole(input.roleKey);
    const identifierDigest = this.identifierHash.digest(identifier);
    const token = enrollmentToken();
    const tokenDigest = this.enrollmentHash.digest(token);
    const expiresAt = new Date(Date.now() + this.config.admin.enrollmentTtlSeconds * 1_000);
    return this.idempotency.execute({
      context,
      operation: 'admin-principals.create',
      idempotencyKey: input.idempotencyKey,
      request: {
        identifier: identifierDigest.digest,
        identifier_key_id: identifierDigest.keyId,
        display_name: displayName,
        role_key: role,
        reason: input.reason,
      },
      responseStatus: 201,
      persistResponse: (response) => ({
        principal_id: response.principal_id,
        display_name: response.display_name,
        identifier_hint: response.identifier_hint,
        role_key: response.role_key,
        enrollment_expires_at: response.enrollment_expires_at,
      }),
      write: async (transaction) => {
        await this.lockSuperAdminSet(transaction);
        const collision = await transaction.query.adminPrincipals.findFirst({
          where: and(
            eq(adminPrincipals.identifierHash, identifierDigest.digest),
            eq(adminPrincipals.identifierKeyId, identifierDigest.keyId),
          ),
        });
        if (collision) adminAuthError('ADMIN_IDENTIFIER_CONFLICT', 409);
        const principalId = randomUUID();
        await transaction.insert(adminPrincipals).values({
          id: principalId,
          identifierHash: identifierDigest.digest,
          identifierKeyId: identifierDigest.keyId,
          identifierHint: this.maskIdentifier(identifier),
          displayName,
          status: 'pending_enrollment',
        });
        await transaction.insert(adminRoleBindings).values({
          adminPrincipalId: principalId,
          roleKey: role,
          scopeType: 'global',
          scopeKey: 'global',
          permissionSnapshotHash: permissionSnapshotHash([{ roleKey: role, scopeKey: 'global' }]),
        });
        await transaction.insert(adminEnrollmentTokens).values({
          adminPrincipalId: principalId,
          tokenHash: tokenDigest.digest,
          keyId: tokenDigest.keyId,
          expiresAt,
          createdByAdminId: context.principalId,
        });
        await this.audit(
          transaction,
          context,
          request,
          input.reason,
          'admin.principal.created',
          {
            status: 'pending_enrollment',
            role_key: role,
          },
          principalId,
          input.idempotencyKey,
        );
        return {
          principal_id: principalId,
          display_name: displayName,
          identifier_hint: this.maskIdentifier(identifier),
          role_key: role,
          enrollment_token: token,
          enrollment_expires_at: expiresAt.toISOString(),
        };
      },
    });
  }

  async list(limit: number): Promise<Record<string, unknown>> {
    const principals = await this.database
      .select()
      .from(adminPrincipals)
      .orderBy(desc(adminPrincipals.createdAt), desc(adminPrincipals.id))
      .limit(Math.min(limit, 100));
    const items = await Promise.all(principals.map((principal) => this.summary(principal)));
    return { items };
  }

  async detail(principalId: string): Promise<Record<string, unknown>> {
    const principal = await this.database.query.adminPrincipals.findFirst({
      where: eq(adminPrincipals.id, principalId),
    });
    if (!principal) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    const [summary, sessions] = await Promise.all([
      this.summary(principal),
      this.sessionItems(principal.id),
    ]);
    return { principal: summary, sessions };
  }

  async sessions(principalId: string): Promise<Record<string, unknown>> {
    const principal = await this.database.query.adminPrincipals.findFirst({
      where: eq(adminPrincipals.id, principalId),
    });
    if (!principal) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    return { items: await this.sessionItems(principal.id) };
  }

  async replaceRoles(
    context: AdminSessionContext,
    request: AdminRequest,
    principalId: string,
    input: {
      expectedRevision: number;
      roles: readonly { roleKey: string; scopeType?: string; scopeKey?: string }[];
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    if (principalId === context.principalId) adminAuthError('ADMIN_SELF_MODIFICATION', 409);
    const bindings = this.parseBindings(input.roles);
    return this.idempotency.execute({
      context,
      operation: `admin-principals/${principalId}/role-bindings.replace`,
      idempotencyKey: input.idempotencyKey,
      request: {
        principal_id: principalId,
        expected_revision: input.expectedRevision,
        bindings,
        reason: input.reason,
      },
      responseStatus: 200,
      write: async (transaction) => {
        await this.lockSuperAdminSet(transaction);
        const principal = await this.lockPrincipal(transaction, principalId);
        this.assertRevision(principal.revision, input.expectedRevision);
        const wasSuperAdmin = await this.hasRole(transaction, principal.id, 'super_admin');
        const becomesSuperAdmin = bindings.some((binding) => binding.roleKey === 'super_admin');
        if (wasSuperAdmin && !becomesSuperAdmin)
          await this.assertAnotherSuperAdmin(transaction, principal.id);
        await transaction
          .delete(adminRoleBindings)
          .where(eq(adminRoleBindings.adminPrincipalId, principal.id));
        await transaction.insert(adminRoleBindings).values(
          bindings.map((binding) => ({
            adminPrincipalId: principal.id,
            roleKey: binding.roleKey,
            scopeType: binding.scopeType,
            scopeKey: binding.scopeKey,
            permissionSnapshotHash: permissionSnapshotHash([
              { roleKey: binding.roleKey, scopeKey: binding.scopeKey },
            ]),
          })),
        );
        const nextRevision = principal.revision + 1;
        const nextAuthzVersion = principal.authzVersion + 1;
        await transaction
          .update(adminPrincipals)
          .set({ revision: nextRevision, authzVersion: nextAuthzVersion })
          .where(
            and(
              eq(adminPrincipals.id, principal.id),
              eq(adminPrincipals.revision, principal.revision),
            ),
          );
        await transaction
          .update(adminSessions)
          .set({ status: 'revoked', revokedAt: now() })
          .where(
            and(
              eq(adminSessions.adminPrincipalId, principal.id),
              eq(adminSessions.status, 'active'),
            ),
          );
        await this.audit(
          transaction,
          context,
          request,
          input.reason,
          'admin.principal.roles_replaced',
          {
            expected_revision: input.expectedRevision,
            next_revision: nextRevision,
            roles: bindings.map((binding) => binding.roleKey),
          },
          principal.id,
          input.idempotencyKey,
        );
        return { principal_id: principal.id, revision: nextRevision, status: principal.status };
      },
    });
  }

  async reissueEnrollment(
    context: AdminSessionContext,
    request: AdminRequest,
    principalId: string,
    input: { expectedRevision: number; reason: string; idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    return this.idempotency.execute({
      context,
      operation: `admin-principals/${principalId}/enrollment-token.reissue`,
      idempotencyKey: input.idempotencyKey,
      request: {
        principal_id: principalId,
        expected_revision: input.expectedRevision,
        reason: input.reason,
      },
      responseStatus: 200,
      persistResponse: (response) => ({
        principal_id: response.principal_id,
        revision: response.revision,
        enrollment_expires_at: response.enrollment_expires_at,
      }),
      write: async (transaction) => {
        await this.lockSuperAdminSet(transaction);
        const principal = await this.lockPrincipal(transaction, principalId);
        this.assertRevision(principal.revision, input.expectedRevision);
        if (principal.status !== 'pending_enrollment')
          adminAuthError('ADMIN_ENROLLMENT_STATE_INVALID', 409);
        await transaction
          .update(adminEnrollmentTokens)
          .set({
            status: 'revoked',
            revokedAt: now(),
            revision: sql`${adminEnrollmentTokens.revision} + 1`,
          })
          .where(
            and(
              eq(adminEnrollmentTokens.adminPrincipalId, principal.id),
              inArray(adminEnrollmentTokens.status, ['issued', 'claimed']),
            ),
          );
        const token = enrollmentToken();
        const digest = this.enrollmentHash.digest(token);
        const expiresAt = new Date(Date.now() + this.config.admin.enrollmentTtlSeconds * 1_000);
        await transaction.insert(adminEnrollmentTokens).values({
          adminPrincipalId: principal.id,
          tokenHash: digest.digest,
          keyId: digest.keyId,
          expiresAt,
          createdByAdminId: context.principalId,
        });
        const revision = principal.revision + 1;
        await transaction
          .update(adminPrincipals)
          .set({ revision })
          .where(eq(adminPrincipals.id, principal.id));
        await this.audit(
          transaction,
          context,
          request,
          input.reason,
          'admin.principal.enrollment_reissued',
          {
            revision,
            enrollment_expires_at: expiresAt.toISOString(),
          },
          principal.id,
          input.idempotencyKey,
        );
        return {
          principal_id: principal.id,
          revision,
          enrollment_token: token,
          enrollment_expires_at: expiresAt.toISOString(),
        };
      },
    });
  }

  async resetEnrollment(
    context: AdminSessionContext,
    request: AdminRequest,
    principalId: string,
    input: { expectedRevision: number; reason: string; idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    if (principalId === context.principalId) adminAuthError('ADMIN_SELF_MODIFICATION', 409);
    return this.idempotency.execute({
      context,
      operation: `admin-principals/${principalId}/enrollment.reset`,
      idempotencyKey: input.idempotencyKey,
      request: {
        principal_id: principalId,
        expected_revision: input.expectedRevision,
        reason: input.reason,
      },
      responseStatus: 200,
      write: async (transaction) => {
        await this.lockSuperAdminSet(transaction);
        const principal = await this.lockPrincipal(transaction, principalId);
        this.assertRevision(principal.revision, input.expectedRevision);
        if (await this.hasRole(transaction, principal.id, 'super_admin')) {
          await this.assertAnotherSuperAdmin(transaction, principal.id);
        }
        const changedAt = now();
        await this.revokePrincipalSecurity(transaction, principal.id, changedAt);
        const revision = principal.revision + 1;
        await transaction
          .update(adminPrincipals)
          .set({ status: 'pending_enrollment', authzVersion: principal.authzVersion + 1, revision })
          .where(eq(adminPrincipals.id, principal.id));
        await this.audit(
          transaction,
          context,
          request,
          input.reason,
          'admin.principal.enrollment_reset',
          {
            revision,
            status: 'pending_enrollment',
          },
          principal.id,
          input.idempotencyKey,
        );
        return { principal_id: principal.id, revision, status: 'pending_enrollment' };
      },
    });
  }

  async disable(
    context: AdminSessionContext,
    request: AdminRequest,
    principalId: string,
    input: { expectedRevision: number; reason: string; idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    if (principalId === context.principalId) adminAuthError('ADMIN_SELF_MODIFICATION', 409);
    return this.idempotency.execute({
      context,
      operation: `admin-principals/${principalId}.disable`,
      idempotencyKey: input.idempotencyKey,
      request: {
        principal_id: principalId,
        expected_revision: input.expectedRevision,
        reason: input.reason,
      },
      responseStatus: 200,
      write: async (transaction) => {
        await this.lockSuperAdminSet(transaction);
        const principal = await this.lockPrincipal(transaction, principalId);
        this.assertRevision(principal.revision, input.expectedRevision);
        if (await this.hasRole(transaction, principal.id, 'super_admin')) {
          await this.assertAnotherSuperAdmin(transaction, principal.id);
        }
        const changedAt = now();
        await this.revokePrincipalSecurity(transaction, principal.id, changedAt);
        const revision = principal.revision + 1;
        await transaction
          .update(adminPrincipals)
          .set({ status: 'disabled', authzVersion: principal.authzVersion + 1, revision })
          .where(eq(adminPrincipals.id, principal.id));
        await this.audit(
          transaction,
          context,
          request,
          input.reason,
          'admin.principal.disabled',
          {
            revision,
            status: 'disabled',
          },
          principal.id,
          input.idempotencyKey,
        );
        return { principal_id: principal.id, revision, status: 'disabled' };
      },
    });
  }

  async revokeSession(
    context: AdminSessionContext,
    request: AdminRequest,
    sessionId: string,
    input: { reason: string; idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    if (sessionId === context.id) adminAuthError('ADMIN_SELF_MODIFICATION', 409);
    return this.idempotency.execute({
      context,
      operation: `admin-sessions/${sessionId}.revoke`,
      idempotencyKey: input.idempotencyKey,
      request: { session_id: sessionId, reason: input.reason },
      responseStatus: 200,
      write: async (transaction) => {
        const [session] = await transaction
          .select()
          .from(adminSessions)
          .where(eq(adminSessions.id, sessionId))
          .for('update');
        if (!session) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        const [principal] = await transaction
          .select()
          .from(adminPrincipals)
          .where(eq(adminPrincipals.id, session.adminPrincipalId));
        if (!principal) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        await transaction
          .update(adminSessions)
          .set({ status: 'revoked', revokedAt: now() })
          .where(and(eq(adminSessions.id, session.id), eq(adminSessions.status, 'active')));
        await this.audit(
          transaction,
          context,
          request,
          input.reason,
          'admin.session.revoked',
          {
            session_id: session.id,
            principal_id: principal.id,
          },
          principal.id,
          input.idempotencyKey,
        );
        return { session_id: session.id, status: 'revoked' };
      },
    });
  }

  private parseRole(value: string): AdminRoleKey {
    if (!isAdminRoleKey(value)) adminAuthError('ADMIN_ROLE_INVALID', 400);
    return value;
  }

  private parseBindings(
    values: readonly { roleKey: string; scopeType?: string; scopeKey?: string }[],
  ): RoleBindingInput[] {
    if (values.length < 1 || values.length > 5) adminAuthError('ADMIN_ROLE_INVALID', 400);
    const bindings = values.map((value) => {
      const roleKey = this.parseRole(value.roleKey);
      const scopeType = value.scopeType ?? 'global';
      const scopeKey = value.scopeKey ?? 'global';
      if (scopeType !== 'global' || scopeKey !== 'global') {
        adminAuthError('ADMIN_SCOPE_INVALID', 400);
      }
      return { roleKey, scopeType, scopeKey };
    });
    const keys = bindings.map(
      (binding) => `${binding.roleKey}:${binding.scopeType}:${binding.scopeKey}`,
    );
    if (new Set(keys).size !== keys.length) adminAuthError('ADMIN_ROLE_INVALID', 400);
    return bindings;
  }

  private async summary(
    principal: typeof adminPrincipals.$inferSelect,
  ): Promise<Record<string, unknown>> {
    const [bindings, credentials, sessions] = await Promise.all([
      this.database.query.adminRoleBindings.findMany({
        where: eq(adminRoleBindings.adminPrincipalId, principal.id),
      }),
      this.database.query.adminCredentials.findMany({
        where: eq(adminCredentials.adminPrincipalId, principal.id),
      }),
      this.database.query.adminSessions.findMany({
        where: and(
          eq(adminSessions.adminPrincipalId, principal.id),
          eq(adminSessions.status, 'active'),
        ),
        columns: { id: true },
      }),
    ]);
    return {
      id: principal.id,
      identifier_hint: principal.identifierHint,
      display_name: principal.displayName,
      status: principal.status,
      revision: principal.revision,
      authz_version: principal.authzVersion,
      roles: bindings.map((binding) => ({
        role_key: binding.roleKey,
        scope_type: binding.scopeType,
        scope_key: binding.scopeKey,
      })),
      mfa: {
        password_active: credentials.some(
          (credential) =>
            credential.credentialType === 'password' && credential.status === 'active',
        ),
        totp_active: credentials.some(
          (credential) => credential.credentialType === 'totp' && credential.status === 'active',
        ),
        pending_totp: credentials.some(
          (credential) => credential.credentialType === 'totp' && credential.status === 'pending',
        ),
      },
      active_session_count: sessions.length,
      created_at: principal.createdAt.toISOString(),
      updated_at: principal.updatedAt.toISOString(),
    };
  }

  private async sessionItems(principalId: string): Promise<Record<string, unknown>[]> {
    const sessions = await this.database.query.adminSessions.findMany({
      where: eq(adminSessions.adminPrincipalId, principalId),
      orderBy: [desc(adminSessions.createdAt)],
      limit: 100,
    });
    return sessions.map((session) => ({
      id: session.id,
      status: session.status,
      mfa_level: session.mfaLevel,
      recovery_restricted: session.recoveryRestricted,
      source_ip_hash: session.sourceIpHash,
      user_agent_hash: session.userAgentHash,
      created_at: session.createdAt.toISOString(),
      last_seen_at: session.lastSeenAt.toISOString(),
      session_expires_at: session.sessionExpiresAt.toISOString(),
      revoked_at: session.revokedAt?.toISOString() ?? null,
    }));
  }

  private async lockSuperAdminSet(transaction: Transaction): Promise<void> {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('admin-super-admin-set', 'global')})`,
    );
  }

  private async lockPrincipal(
    transaction: Transaction,
    principalId: string,
  ): Promise<typeof adminPrincipals.$inferSelect> {
    const [principal] = await transaction
      .select()
      .from(adminPrincipals)
      .where(eq(adminPrincipals.id, principalId))
      .for('update');
    if (!principal) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    return principal;
  }

  private assertRevision(actual: number, expected: number): void {
    if (actual !== expected) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
  }

  private async hasRole(
    transaction: Transaction,
    principalId: string,
    roleKey: string,
  ): Promise<boolean> {
    const [binding] = await transaction
      .select({ id: adminRoleBindings.id })
      .from(adminRoleBindings)
      .where(
        and(
          eq(adminRoleBindings.adminPrincipalId, principalId),
          eq(adminRoleBindings.roleKey, roleKey),
        ),
      )
      .limit(1);
    return Boolean(binding);
  }

  private async assertAnotherSuperAdmin(
    transaction: Transaction,
    excludedPrincipalId: string,
  ): Promise<void> {
    const active = await transaction
      .select({ id: adminPrincipals.id })
      .from(adminPrincipals)
      .innerJoin(adminRoleBindings, eq(adminRoleBindings.adminPrincipalId, adminPrincipals.id))
      .where(
        and(
          eq(adminPrincipals.status, 'active'),
          eq(adminRoleBindings.roleKey, 'super_admin'),
          sql`${adminPrincipals.id} <> ${excludedPrincipalId}`,
        ),
      )
      .limit(1);
    if (active.length === 0) adminAuthError('ADMIN_LAST_SUPER_ADMIN', 409);
  }

  private async revokePrincipalSecurity(
    transaction: Transaction,
    principalId: string,
    changedAt: Date,
  ): Promise<void> {
    await transaction
      .update(adminCredentials)
      .set({ status: 'revoked', rotatedAt: changedAt })
      .where(
        and(
          eq(adminCredentials.adminPrincipalId, principalId),
          inArray(adminCredentials.status, ['active', 'pending']),
        ),
      );
    await transaction
      .update(adminSessions)
      .set({ status: 'revoked', revokedAt: changedAt })
      .where(
        and(eq(adminSessions.adminPrincipalId, principalId), eq(adminSessions.status, 'active')),
      );
    await transaction
      .update(adminAuthChallenges)
      .set({ status: 'failed' })
      .where(
        and(
          eq(adminAuthChallenges.adminPrincipalId, principalId),
          eq(adminAuthChallenges.status, 'pending'),
        ),
      );
    await transaction
      .update(adminEnrollmentTokens)
      .set({
        status: 'revoked',
        revokedAt: changedAt,
        revision: sql`${adminEnrollmentTokens.revision} + 1`,
      })
      .where(
        and(
          eq(adminEnrollmentTokens.adminPrincipalId, principalId),
          inArray(adminEnrollmentTokens.status, ['issued', 'claimed']),
        ),
      );
    await transaction
      .update(adminMfaRecoveryCodes)
      .set({ usedAt: changedAt })
      .where(
        and(
          eq(adminMfaRecoveryCodes.adminPrincipalId, principalId),
          isNull(adminMfaRecoveryCodes.usedAt),
        ),
      );
  }

  private maskIdentifier(identifier: string): string {
    const at = identifier.indexOf('@');
    if (at <= 0 || at === identifier.length - 1) return `${identifier.slice(0, 1)}***`;
    return `${identifier.slice(0, 1)}***@${identifier.slice(at + 1)}`;
  }

  private async audit(
    transaction: Transaction,
    context: AdminSessionContext,
    request: AdminRequest,
    reason: string,
    action: string,
    afterJson: Record<string, unknown>,
    targetId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await transaction.insert(adminAuditLogs).values({
      actorAdminId: context.principalId,
      actorType: 'admin_session',
      adminSessionId: context.id,
      permissionSnapshot: { permissions: context.permissions },
      action,
      targetType: 'admin_principal',
      targetId,
      afterJson,
      reason,
      requestId: requestId(request),
      idempotencyKeyHash: this.idempotencyHash.digest(idempotencyKey).digest,
      sourceIpHash: context.sourceIpHash,
      userAgentHash: context.userAgentHash,
      mfaLevel: context.mfaLevel,
      stepUpAt: context.stepUpAt,
      result: 'succeeded',
    });
  }
}
