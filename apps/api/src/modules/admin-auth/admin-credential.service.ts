import { randomBytes, randomUUID } from 'node:crypto';

import {
  adminAuditLogs,
  adminAuthChallenges,
  adminCredentials,
  adminMfaRecoveryCodes,
  adminPrincipals,
  adminSessions,
  and,
  eq,
  isNull,
  sql,
  type Database,
} from '@ecom-forge/db';
import { scopedAdvisoryLockKey } from '@ecom-forge/shared';
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

import type { AppConfig } from '../../config/app-config.js';
import { HmacKeyring } from '../auth/security/hmac-keyring.js';
import {
  createRecoveryCodes,
  createTotpSecret,
  hashRecoveryCode,
  SecretEnvelope,
  totpProvisioningUri,
  verifyTotp,
} from './admin-crypto.js';
import { AdminAuthError, adminAuthError } from './admin-errors.js';
import type { AdminRequest, AdminSessionContext } from './admin-http.js';
import { AdminAuthService } from './admin-auth.service.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function now(): Date {
  return new Date();
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

function requestId(request: AdminRequest): string {
  const value = request.headers['x-request-id'];
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : `admin-auth:${randomUUID()}`;
}

@Injectable()
export class AdminCredentialService {
  private readonly challengeHash: HmacKeyring;
  private readonly recoveryHash: HmacKeyring;
  private readonly totpEnvelope: SecretEnvelope;

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly auth: AdminAuthService,
  ) {
    this.challengeHash = new HmacKeyring(config.admin.challengeHashKeys);
    this.recoveryHash = new HmacKeyring(config.admin.recoveryHashKeys);
    this.totpEnvelope = new SecretEnvelope(config.admin.totpEncryptionKeys);
  }

  async changePassword(request: AdminRequest, newPassword: string): Promise<void> {
    const context = await this.auth.resolveSession(request, true);
    this.auth.requireStepUp(context);
    const passwordHash = await argon2.hash(newPassword, {
      type: argon2.argon2id,
      memoryCost: this.config.admin.argon2.memoryKiB,
      timeCost: this.config.admin.argon2.timeCost,
      parallelism: this.config.admin.argon2.parallelism,
    });
    await this.database.transaction(async (transaction) => {
      await this.lockSecurityMutation(transaction);
      const principal = await this.lockCurrentPrincipal(transaction, context);
      const [currentCredential] = await transaction
        .select()
        .from(adminCredentials)
        .where(
          and(
            eq(adminCredentials.adminPrincipalId, principal.id),
            eq(adminCredentials.credentialType, 'password'),
            eq(adminCredentials.status, 'active'),
          ),
        )
        .for('update');
      if (!currentCredential) adminAuthError('ADMIN_AUTH_UNAVAILABLE', 503);
      const changedAt = now();
      await transaction
        .update(adminCredentials)
        .set({
          status: 'revoked',
          rotatedAt: changedAt,
          revision: currentCredential.revision + 1,
        })
        .where(eq(adminCredentials.id, currentCredential.id));
      await transaction.insert(adminCredentials).values({
        adminPrincipalId: principal.id,
        credentialType: 'password',
        passwordHash,
        passwordHashMetadata: {
          algorithm: 'argon2id',
          memory_kib: this.config.admin.argon2.memoryKiB,
          time_cost: this.config.admin.argon2.timeCost,
          parallelism: this.config.admin.argon2.parallelism,
        },
        status: 'active',
        revision: currentCredential.revision + 1,
      });
      const nextAuthzVersion = principal.authzVersion + 1;
      await this.advancePrincipalAndSessions(
        transaction,
        context,
        principal.revision,
        nextAuthzVersion,
        { recoveryRestricted: false, mfaLevel: context.mfaLevel },
      );
      await this.audit(transaction, context, request, 'admin.auth.password_changed', {
        credential_revision: currentCredential.revision + 1,
      });
    });
  }

  async startTotpRotation(request: AdminRequest): Promise<{
    challengeId: string;
    challengeToken: string;
    totpSecret: string;
    provisioningUri: string;
    expiresInSeconds: number;
  }> {
    const context = await this.auth.resolveSession(request, true);
    if (!context.recoveryRestricted) this.auth.requireStepUp(context);
    const totpSecret = createTotpSecret();
    const encrypted = this.totpEnvelope.encrypt(totpSecret);
    const challengeToken = opaqueToken();
    const challengeDigest = this.challengeHash.digest(challengeToken);
    const challengeId = randomUUID();
    const expiresAt = new Date(Date.now() + this.config.admin.challengeTtlSeconds * 1_000);
    const principal = await this.database.transaction(async (transaction) => {
      await this.lockSecurityMutation(transaction);
      const lockedPrincipal = await this.lockCurrentPrincipal(transaction, context);
      const [activeCredential] = await transaction
        .select()
        .from(adminCredentials)
        .where(
          and(
            eq(adminCredentials.adminPrincipalId, lockedPrincipal.id),
            eq(adminCredentials.credentialType, 'totp'),
            eq(adminCredentials.status, 'active'),
          ),
        )
        .for('update');
      if (!activeCredential) adminAuthError('ADMIN_AUTH_UNAVAILABLE', 503);
      await transaction
        .update(adminCredentials)
        .set({ status: 'revoked', rotatedAt: now() })
        .where(
          and(
            eq(adminCredentials.adminPrincipalId, lockedPrincipal.id),
            eq(adminCredentials.credentialType, 'totp'),
            eq(adminCredentials.status, 'pending'),
          ),
        );
      await transaction
        .update(adminAuthChallenges)
        .set({ status: 'failed' })
        .where(
          and(
            eq(adminAuthChallenges.adminPrincipalId, lockedPrincipal.id),
            eq(adminAuthChallenges.purpose, 'mfa_rotation'),
            eq(adminAuthChallenges.status, 'pending'),
          ),
        );
      await transaction.insert(adminCredentials).values({
        adminPrincipalId: lockedPrincipal.id,
        credentialType: 'totp',
        secretCiphertext: encrypted.ciphertext,
        secretNonce: encrypted.nonce,
        secretAuthTag: encrypted.authTag,
        secretKeyId: encrypted.keyId,
        status: 'pending',
        revision: activeCredential.revision + 1,
      });
      await transaction.insert(adminAuthChallenges).values({
        id: challengeId,
        adminPrincipalId: lockedPrincipal.id,
        purpose: 'mfa_rotation',
        challengeTokenHash: challengeDigest.digest,
        challengeKeyId: challengeDigest.keyId,
        expiresAt,
      });
      await this.audit(transaction, context, request, 'admin.auth.totp_rotation_started', {
        challenge_expires_at: expiresAt.toISOString(),
      });
      return lockedPrincipal;
    });
    return {
      challengeId,
      challengeToken,
      totpSecret,
      provisioningUri: totpProvisioningUri(totpSecret, principal.identifierHint),
      expiresInSeconds: this.config.admin.challengeTtlSeconds,
    };
  }

  async confirmTotpRotation(
    request: AdminRequest,
    challengeId: string,
    challengeToken: string,
    code: string,
  ): Promise<void> {
    const context = await this.auth.resolveSession(request, true);
    const completed = await this.database.transaction(async (transaction) => {
      await this.lockSecurityMutation(transaction);
      const principal = await this.lockCurrentPrincipal(transaction, context);
      const [challenge] = await transaction
        .select()
        .from(adminAuthChallenges)
        .where(eq(adminAuthChallenges.id, challengeId))
        .for('update');
      if (
        !challenge ||
        challenge.adminPrincipalId !== principal.id ||
        challenge.purpose !== 'mfa_rotation' ||
        challenge.status !== 'pending' ||
        challenge.expiresAt.getTime() <= Date.now() ||
        !this.challengeHash.verify(challengeToken, {
          keyId: challenge.challengeKeyId,
          digest: challenge.challengeTokenHash,
        })
      ) {
        if (
          challenge?.status === 'pending' &&
          challenge.adminPrincipalId === principal.id &&
          challenge.expiresAt.getTime() <= Date.now()
        ) {
          await this.recordChallengeFailure(transaction, challenge);
        }
        return false;
      }
      const [pendingCredential] = await transaction
        .select()
        .from(adminCredentials)
        .where(
          and(
            eq(adminCredentials.adminPrincipalId, principal.id),
            eq(adminCredentials.credentialType, 'totp'),
            eq(adminCredentials.status, 'pending'),
          ),
        )
        .for('update');
      const [activeCredential] = await transaction
        .select()
        .from(adminCredentials)
        .where(
          and(
            eq(adminCredentials.adminPrincipalId, principal.id),
            eq(adminCredentials.credentialType, 'totp'),
            eq(adminCredentials.status, 'active'),
          ),
        )
        .for('update');
      if (!pendingCredential || !activeCredential) return false;
      let secret: string;
      try {
        secret = this.totpEnvelope.decrypt({
          keyId: pendingCredential.secretKeyId!,
          ciphertext: pendingCredential.secretCiphertext!,
          nonce: pendingCredential.secretNonce!,
          authTag: pendingCredential.secretAuthTag!,
        });
      } catch {
        throw new AdminAuthError('ADMIN_AUTH_UNAVAILABLE', 503);
      }
      const step = verifyTotp(secret, code);
      if (step === undefined) {
        await this.recordChallengeFailure(transaction, challenge);
        return false;
      }
      const changedAt = now();
      await transaction
        .update(adminCredentials)
        .set({
          status: 'revoked',
          rotatedAt: changedAt,
          revision: activeCredential.revision + 1,
        })
        .where(eq(adminCredentials.id, activeCredential.id));
      await transaction
        .update(adminCredentials)
        .set({ status: 'active', totpLastUsedStep: step })
        .where(eq(adminCredentials.id, pendingCredential.id));
      await transaction
        .update(adminAuthChallenges)
        .set({ status: 'consumed', usedAt: changedAt })
        .where(eq(adminAuthChallenges.id, challenge.id));
      await transaction
        .update(adminMfaRecoveryCodes)
        .set({ usedAt: changedAt })
        .where(
          and(
            eq(adminMfaRecoveryCodes.adminPrincipalId, principal.id),
            isNull(adminMfaRecoveryCodes.usedAt),
          ),
        );
      const nextAuthzVersion = principal.authzVersion + 1;
      await this.advancePrincipalAndSessions(
        transaction,
        context,
        principal.revision,
        nextAuthzVersion,
        { recoveryRestricted: false, mfaLevel: 'totp', clearStepUp: true },
      );
      await this.audit(transaction, context, request, 'admin.auth.totp_rotated', {
        credential_revision: pendingCredential.revision,
      });
      return true;
    });
    if (!completed) adminAuthError('ADMIN_TOTP_INVALID');
  }

  async rotateRecoveryCodes(request: AdminRequest): Promise<{ recoveryCodes: string[] }> {
    const context = await this.auth.resolveSession(request, true);
    this.auth.requireStepUp(context);
    const recoveryCodes = createRecoveryCodes();
    await this.database.transaction(async (transaction) => {
      await this.lockSecurityMutation(transaction);
      const principal = await this.lockCurrentPrincipal(transaction, context);
      const changedAt = now();
      await transaction
        .update(adminMfaRecoveryCodes)
        .set({ usedAt: changedAt })
        .where(
          and(
            eq(adminMfaRecoveryCodes.adminPrincipalId, principal.id),
            isNull(adminMfaRecoveryCodes.usedAt),
          ),
        );
      await transaction.insert(adminMfaRecoveryCodes).values(
        recoveryCodes.map((code) => {
          const digest = hashRecoveryCode(this.recoveryHash, code);
          return {
            adminPrincipalId: principal.id,
            codeHash: digest.digest,
            keyId: digest.keyId,
          };
        }),
      );
      const nextAuthzVersion = principal.authzVersion + 1;
      await this.advancePrincipalAndSessions(
        transaction,
        context,
        principal.revision,
        nextAuthzVersion,
        { recoveryRestricted: false, mfaLevel: context.mfaLevel },
      );
      await this.audit(transaction, context, request, 'admin.auth.recovery_codes_rotated', {
        recovery_code_count: recoveryCodes.length,
      });
    });
    return { recoveryCodes };
  }

  private async lockSecurityMutation(transaction: Transaction): Promise<void> {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('admin-super-admin-set', 'global')})`,
    );
  }

  private async lockCurrentPrincipal(
    transaction: Transaction,
    context: AdminSessionContext,
  ): Promise<typeof adminPrincipals.$inferSelect> {
    const [principal] = await transaction
      .select()
      .from(adminPrincipals)
      .where(eq(adminPrincipals.id, context.principalId))
      .for('update');
    const [session] = await transaction
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.id, context.id))
      .for('update');
    if (
      !principal ||
      principal.status !== 'active' ||
      principal.authzVersion !== context.authzVersion ||
      !session ||
      session.status !== 'active' ||
      session.authzVersionSnapshot !== context.authzVersion
    ) {
      adminAuthError('ADMIN_SESSION_REQUIRED');
    }
    return principal;
  }

  private async advancePrincipalAndSessions(
    transaction: Transaction,
    context: AdminSessionContext,
    expectedRevision: number,
    nextAuthzVersion: number,
    current: {
      recoveryRestricted: boolean;
      mfaLevel: string;
      clearStepUp?: boolean;
    },
  ): Promise<void> {
    const principalUpdate = await transaction
      .update(adminPrincipals)
      .set({ authzVersion: nextAuthzVersion, revision: expectedRevision + 1 })
      .where(
        and(
          eq(adminPrincipals.id, context.principalId),
          eq(adminPrincipals.revision, expectedRevision),
        ),
      )
      .returning({ id: adminPrincipals.id });
    if (principalUpdate.length !== 1) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
    const changedAt = now();
    await transaction
      .update(adminSessions)
      .set({ status: 'revoked', revokedAt: changedAt })
      .where(
        and(
          eq(adminSessions.adminPrincipalId, context.principalId),
          eq(adminSessions.status, 'active'),
          sql`${adminSessions.id} <> ${context.id}`,
        ),
      );
    const currentUpdate = await transaction
      .update(adminSessions)
      .set({
        authzVersionSnapshot: nextAuthzVersion,
        recoveryRestricted: current.recoveryRestricted,
        mfaLevel: current.mfaLevel,
        mfaVerifiedAt: changedAt,
        ...(current.clearStepUp ? { stepUpAt: null } : {}),
      })
      .where(and(eq(adminSessions.id, context.id), eq(adminSessions.status, 'active')))
      .returning({ id: adminSessions.id });
    if (currentUpdate.length !== 1) adminAuthError('ADMIN_SESSION_REQUIRED');
  }

  private async recordChallengeFailure(
    transaction: Transaction,
    challenge: typeof adminAuthChallenges.$inferSelect,
  ): Promise<void> {
    if (challenge.status !== 'pending') return;
    if (challenge.expiresAt.getTime() <= Date.now()) {
      await transaction
        .update(adminAuthChallenges)
        .set({ status: 'expired' })
        .where(eq(adminAuthChallenges.id, challenge.id));
      return;
    }
    const attemptCount = Math.min(challenge.maxAttempts, challenge.attemptCount + 1);
    await transaction
      .update(adminAuthChallenges)
      .set({
        attemptCount,
        status: attemptCount >= challenge.maxAttempts ? 'failed' : 'pending',
      })
      .where(eq(adminAuthChallenges.id, challenge.id));
  }

  private async audit(
    transaction: Transaction,
    context: AdminSessionContext,
    request: AdminRequest,
    action: string,
    afterJson: Record<string, unknown>,
  ): Promise<void> {
    await transaction.insert(adminAuditLogs).values({
      actorAdminId: context.principalId,
      actorType: 'admin_session',
      adminSessionId: context.id,
      permissionSnapshot: { permissions: context.permissions },
      action,
      targetType: 'admin_principal',
      targetId: context.principalId,
      afterJson,
      reason: 'self_service',
      requestId: requestId(request),
      sourceIpHash: context.sourceIpHash,
      userAgentHash: context.userAgentHash,
      mfaLevel: context.mfaLevel,
      stepUpAt: context.stepUpAt,
      result: 'succeeded',
    });
  }
}
