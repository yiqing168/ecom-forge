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
  eq,
  inArray,
  isNull,
  or,
  sql,
  type Database,
} from '@ecom-forge/db';
import { scopedAdvisoryLockKey } from '@ecom-forge/shared';
import * as argon2 from 'argon2';
import { Injectable } from '@nestjs/common';

import type { AppConfig, AppEnvironment } from '../../config/app-config.js';
import { TrustedProxyResolver } from '../../shared/http/client-ip.js';
import type { RedisEvalClient } from '../../shared/redis/redis.module.js';
import {
  createRecoveryCodes,
  createTotpSecret,
  hashRecoveryCode,
  maskAdminIdentifier,
  normalizeAdminIdentifier,
  normalizeRecoveryCode,
  SecretEnvelope,
  totpProvisioningUri,
  verifyTotp,
} from './admin-crypto.js';
import { adminAuthError, AdminAuthError } from './admin-errors.js';
import type { AdminRequest, AdminSessionContext } from './admin-http.js';
import { permissionSnapshotHash, rolePermissions } from './admin-roles.js';
import { AdminAuthRateLimiter } from './admin-rate-limiter.js';
import { HmacKeyring } from '../auth/security/hmac-keyring.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

interface SessionResult {
  context: AdminSessionContext;
  csrfToken: string;
  principal: {
    id: string;
    identifierHint: string;
    displayName: string;
    status: 'active';
  };
}

interface TotpSuccess {
  session: SessionResult;
  recoveryCodes?: string[];
}

const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$YVYnrnQ2txYoHtzmya58ug$oC/kk5GJ3EzkmpJcadRToJc2sWDZhWAnkbFD47DY4E8';
const LOCAL_ADMIN_IDENTIFIER = 'local-admin@ecom-forge.test';

function now(): Date {
  return new Date();
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function requestId(request: AdminRequest): string {
  const value = request.headers['x-request-id'];
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : `admin-auth:${randomUUID()}`;
}

function sourceIp(request: AdminRequest, resolver: TrustedProxyResolver): string {
  return resolver.resolve(request.socket.remoteAddress ?? '127.0.0.1', request.headers);
}

function userAgent(request: AdminRequest): string {
  const value: unknown = request.headers['user-agent'];
  return typeof value === 'string' ? value.slice(0, 1_024) || 'unknown' : 'unknown';
}

export function isLoopbackAdminRequest(request: AdminRequest): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '');
}

export function isLocalAdminSessionAvailable(
  appEnv: AppEnvironment,
  request: AdminRequest,
): boolean {
  return appEnv === 'local' && isLoopbackAdminRequest(request);
}

@Injectable()
export class AdminAuthService {
  private readonly identifierHash: HmacKeyring;
  private readonly sessionHash: HmacKeyring;
  private readonly csrfDerivation: HmacKeyring;
  private readonly challengeHash: HmacKeyring;
  private readonly enrollmentHash: HmacKeyring;
  private readonly recoveryHash: HmacKeyring;
  private readonly sourceHash: HmacKeyring;
  private readonly totpEnvelope: SecretEnvelope;
  private readonly adminProxyResolver: TrustedProxyResolver;
  private readonly rateLimiter: AdminAuthRateLimiter | undefined;

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    redis?: RedisEvalClient,
  ) {
    this.identifierHash = new HmacKeyring(config.admin.identifierHashKeys);
    this.sessionHash = new HmacKeyring(config.admin.sessionHashKeys);
    this.csrfDerivation = new HmacKeyring(config.admin.csrfDerivationKeys);
    this.challengeHash = new HmacKeyring(config.admin.challengeHashKeys);
    this.enrollmentHash = new HmacKeyring(config.admin.enrollmentHashKeys);
    this.recoveryHash = new HmacKeyring(config.admin.recoveryHashKeys);
    this.sourceHash = new HmacKeyring(config.admin.sourceHashKeys);
    this.totpEnvelope = new SecretEnvelope(config.admin.totpEncryptionKeys);
    this.adminProxyResolver = new TrustedProxyResolver(config.admin.trustedProxyCidrs);
    this.rateLimiter = redis ? new AdminAuthRateLimiter(redis, config.redisPrefix) : undefined;
  }

  localSessionAvailable(request: AdminRequest): boolean {
    return isLocalAdminSessionAvailable(this.config.appEnv, request);
  }

  async createLocalSession(request: AdminRequest): Promise<SessionResult> {
    if (!this.localSessionAvailable(request)) {
      adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    }
    const normalizedIdentifier = normalizeAdminIdentifier(LOCAL_ADMIN_IDENTIFIER);
    const identifierCandidates = this.identifierHash.candidates(normalizedIdentifier);
    const activeIdentifier = this.identifierHash.digest(normalizedIdentifier);
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('admin-local-session', 'fixed')})`,
      );
      const principals = await transaction
        .select()
        .from(adminPrincipals)
        .where(
          or(
            ...identifierCandidates.map((candidate) =>
              and(
                eq(adminPrincipals.identifierKeyId, candidate.keyId),
                eq(adminPrincipals.identifierHash, candidate.digest),
              ),
            ),
          ),
        );
      if (principals.length > 1 || principals[0]?.status === 'disabled') {
        adminAuthError('ADMIN_AUTH_UNAVAILABLE', 503);
      }
      let principal = principals[0];
      if (!principal) {
        [principal] = await transaction
          .insert(adminPrincipals)
          .values({
            identifierHash: activeIdentifier.digest,
            identifierKeyId: activeIdentifier.keyId,
            identifierHint: maskAdminIdentifier(LOCAL_ADMIN_IDENTIFIER),
            displayName: 'Local Admin',
            status: 'active',
          })
          .returning();
      }
      if (!principal) adminAuthError('ADMIN_AUTH_UNAVAILABLE', 503);

      const existingCredentials = await transaction
        .select({ credentialType: adminCredentials.credentialType })
        .from(adminCredentials)
        .where(
          and(
            eq(adminCredentials.adminPrincipalId, principal.id),
            eq(adminCredentials.status, 'active'),
          ),
        );
      const credentialTypes = new Set(existingCredentials.map((item) => item.credentialType));
      if (!credentialTypes.has('password')) {
        await transaction.insert(adminCredentials).values({
          adminPrincipalId: principal.id,
          credentialType: 'password',
          passwordHash: await argon2.hash(randomToken(), {
            type: argon2.argon2id,
            memoryCost: this.config.admin.argon2.memoryKiB,
            timeCost: this.config.admin.argon2.timeCost,
            parallelism: this.config.admin.argon2.parallelism,
          }),
          passwordHashMetadata: {
            algorithm: 'argon2id',
            memory_kib: this.config.admin.argon2.memoryKiB,
            time_cost: this.config.admin.argon2.timeCost,
            parallelism: this.config.admin.argon2.parallelism,
          },
          status: 'active',
        });
      }
      if (!credentialTypes.has('totp')) {
        const envelope = this.totpEnvelope.encrypt(createTotpSecret());
        await transaction.insert(adminCredentials).values({
          adminPrincipalId: principal.id,
          credentialType: 'totp',
          secretCiphertext: envelope.ciphertext,
          secretNonce: envelope.nonce,
          secretAuthTag: envelope.authTag,
          secretKeyId: envelope.keyId,
          status: 'active',
        });
      }

      const existingBinding = await transaction.query.adminRoleBindings.findFirst({
        where: and(
          eq(adminRoleBindings.adminPrincipalId, principal.id),
          eq(adminRoleBindings.roleKey, 'super_admin'),
          eq(adminRoleBindings.scopeType, 'global'),
          eq(adminRoleBindings.scopeKey, 'global'),
        ),
      });
      if (!existingBinding) {
        const bindings = [{ roleKey: 'super_admin', scopeKey: 'global' }];
        await transaction.insert(adminRoleBindings).values({
          adminPrincipalId: principal.id,
          roleKey: 'super_admin',
          scopeType: 'global',
          scopeKey: 'global',
          permissionSnapshotHash: permissionSnapshotHash(bindings),
        });
      }

      const session = await this.createSessionInTransaction(transaction, principal.id, request, {
        mfaLevel: 'totp',
        recoveryRestricted: false,
        stepUpAt: now(),
      });
      await transaction.insert(adminAuditLogs).values({
        actorAdminId: principal.id,
        actorType: 'admin_session',
        adminSessionId: session.context.id,
        permissionSnapshot: { permissions: session.context.permissions },
        action: 'admin.auth.local_session',
        targetType: 'admin_session',
        targetId: session.context.id,
        reason: 'local_development_access',
        requestId: requestId(request),
        sourceIpHash: session.context.sourceIpHash,
        userAgentHash: session.context.userAgentHash,
        mfaLevel: session.context.mfaLevel,
        stepUpAt: session.context.stepUpAt,
        result: 'succeeded',
      });
      return session;
    });
  }

  async login(
    identifier: string,
    password: string,
    request: AdminRequest,
  ): Promise<{
    challengeId: string;
    challengeToken: string;
    expiresInSeconds: number;
  }> {
    const normalized = normalizeAdminIdentifier(identifier);
    await this.assertRateLimit(
      'login-identifier',
      this.identifierHash.digest(normalized).digest,
      this.config.admin.authLimits.loginTenMinutes,
    );
    await this.assertRateLimit(
      'login-source',
      this.sourceHash.digest(sourceIp(request, this.adminProxyResolver)).digest,
      this.config.admin.authLimits.loginTenMinutes,
    );
    const candidates = this.identifierHash.candidates(normalized);
    const principals = await this.database
      .select()
      .from(adminPrincipals)
      .where(
        or(
          ...candidates.map((candidate) =>
            and(
              eq(adminPrincipals.identifierKeyId, candidate.keyId),
              eq(adminPrincipals.identifierHash, candidate.digest),
            ),
          ),
        ),
      );
    const principal = principals.length === 1 ? principals[0] : undefined;
    const passwordCredential = principal
      ? await this.database.query.adminCredentials.findFirst({
          where: and(
            eq(adminCredentials.adminPrincipalId, principal.id),
            eq(adminCredentials.credentialType, 'password'),
            eq(adminCredentials.status, 'active'),
          ),
        })
      : undefined;
    const passwordMatches = await argon2.verify(
      passwordCredential?.passwordHash ?? DUMMY_PASSWORD_HASH,
      password,
    );
    if (!principal || !passwordMatches || principal.status !== 'active') {
      await this.auditAuthAttempt(this.database, request, {
        action: 'admin.auth.password_check',
        ...(principal ? { principalId: principal.id } : {}),
        result: 'failed',
        errorCode: 'ADMIN_AUTH_INVALID',
      });
      adminAuthError('ADMIN_AUTH_INVALID');
    }

    const challengeToken = randomToken();
    const challenge = {
      id: randomUUID(),
      principalId: principal.id,
      token: this.challengeHash.digest(challengeToken),
      activeIdentifier: this.identifierHash.digest(normalized),
    };
    const expiresAt = new Date(Date.now() + this.config.admin.challengeTtlSeconds * 1_000);
    await this.database.transaction(async (transaction) => {
      await transaction.insert(adminAuthChallenges).values({
        id: challenge.id,
        adminPrincipalId: challenge.principalId,
        purpose: 'login_mfa',
        challengeTokenHash: challenge.token.digest,
        challengeKeyId: challenge.token.keyId,
        identifierRekeyHash: challenge.activeIdentifier.digest,
        identifierRekeyKeyId: challenge.activeIdentifier.keyId,
        expiresAt,
      });
      await this.auditAuthAttempt(transaction, request, {
        action: 'admin.auth.password_check',
        principalId: principal.id,
        result: 'succeeded',
      });
    });
    return {
      challengeId: challenge.id,
      challengeToken,
      expiresInSeconds: this.config.admin.challengeTtlSeconds,
    };
  }

  async verifyLoginMfa(
    challengeId: string,
    challengeToken: string,
    code: string,
    request: AdminRequest,
  ): Promise<TotpSuccess> {
    await this.assertRateLimit(
      'mfa-challenge',
      this.challengeHash.digest(challengeId).digest,
      this.config.admin.authLimits.mfaTenMinutes,
    );
    await this.assertRateLimit(
      'mfa-source',
      this.sourceHash.digest(sourceIp(request, this.adminProxyResolver)).digest,
      this.config.admin.authLimits.mfaTenMinutes,
    );
    const result = await this.database.transaction(async (transaction) => {
      const [challenge] = await transaction
        .select()
        .from(adminAuthChallenges)
        .where(eq(adminAuthChallenges.id, challengeId))
        .for('update');
      if (!challenge || challenge.purpose !== 'login_mfa') return { ok: false as const };
      if (
        challenge.status !== 'pending' ||
        challenge.expiresAt.getTime() <= Date.now() ||
        !this.challengeHash.verify(challengeToken, {
          keyId: challenge.challengeKeyId,
          digest: challenge.challengeTokenHash,
        })
      ) {
        return { ok: false as const };
      }
      const [principal] = await transaction
        .select()
        .from(adminPrincipals)
        .where(eq(adminPrincipals.id, challenge.adminPrincipalId))
        .for('update');
      const [credential] = await transaction
        .select()
        .from(adminCredentials)
        .where(
          and(
            eq(adminCredentials.adminPrincipalId, challenge.adminPrincipalId),
            eq(adminCredentials.credentialType, 'totp'),
            eq(adminCredentials.status, 'active'),
          ),
        )
        .for('update');
      if (!principal || principal.status !== 'active' || !credential) return { ok: false as const };
      let secret: string;
      try {
        secret = this.totpEnvelope.decrypt({
          keyId: credential.secretKeyId!,
          ciphertext: credential.secretCiphertext!,
          nonce: credential.secretNonce!,
          authTag: credential.secretAuthTag!,
        });
      } catch {
        throw new AdminAuthError('ADMIN_AUTH_UNAVAILABLE', 503);
      }
      const step = verifyTotp(secret, code);
      if (step === undefined || (credential.totpLastUsedStep ?? -1) >= step) {
        const attemptCount = challenge.attemptCount + 1;
        await transaction
          .update(adminAuthChallenges)
          .set({
            attemptCount,
            status: attemptCount >= challenge.maxAttempts ? 'failed' : 'pending',
          })
          .where(eq(adminAuthChallenges.id, challenge.id));
        return { ok: false as const };
      }
      await transaction
        .update(adminAuthChallenges)
        .set({ status: 'consumed', usedAt: now() })
        .where(eq(adminAuthChallenges.id, challenge.id));
      await transaction
        .update(adminCredentials)
        .set({ totpLastUsedStep: step })
        .where(eq(adminCredentials.id, credential.id));
      await this.rekeyIdentifierInTransaction(transaction, challenge, principal);
      const session = await this.createSessionInTransaction(transaction, principal.id, request);
      await this.auditAuthAttempt(transaction, request, {
        action: 'admin.auth.login',
        principalId: principal.id,
        sessionId: session.context.id,
        mfaLevel: 'totp',
        result: 'succeeded',
      });
      return { ok: true as const, session };
    });
    if (!result.ok) {
      await this.auditAuthAttempt(this.database, request, {
        action: 'admin.auth.login',
        result: 'failed',
        errorCode: 'ADMIN_AUTH_INVALID',
      });
      adminAuthError('ADMIN_AUTH_INVALID');
    }
    return { session: result.session };
  }

  async verifyLoginRecoveryCode(
    challengeId: string,
    challengeToken: string,
    recoveryCode: string,
    request: AdminRequest,
  ): Promise<TotpSuccess> {
    await this.assertRateLimit(
      'mfa-challenge',
      this.challengeHash.digest(challengeId).digest,
      this.config.admin.authLimits.mfaTenMinutes,
    );
    await this.assertRateLimit(
      'mfa-source',
      this.sourceHash.digest(sourceIp(request, this.adminProxyResolver)).digest,
      this.config.admin.authLimits.mfaTenMinutes,
    );
    let normalizedCode: string | undefined;
    try {
      normalizedCode = normalizeRecoveryCode(recoveryCode);
    } catch {
      normalizedCode = undefined;
    }
    const result = await this.database.transaction(async (transaction) => {
      const [challenge] = await transaction
        .select()
        .from(adminAuthChallenges)
        .where(eq(adminAuthChallenges.id, challengeId))
        .for('update');
      if (!challenge || challenge.purpose !== 'login_mfa') return { ok: false as const };
      if (
        challenge.status !== 'pending' ||
        challenge.expiresAt.getTime() <= Date.now() ||
        !this.challengeHash.verify(challengeToken, {
          keyId: challenge.challengeKeyId,
          digest: challenge.challengeTokenHash,
        })
      ) {
        if (challenge.status === 'pending' && challenge.expiresAt.getTime() <= Date.now()) {
          await transaction
            .update(adminAuthChallenges)
            .set({ status: 'expired' })
            .where(eq(adminAuthChallenges.id, challenge.id));
        }
        return { ok: false as const };
      }
      const [principal] = await transaction
        .select()
        .from(adminPrincipals)
        .where(eq(adminPrincipals.id, challenge.adminPrincipalId))
        .for('update');
      if (!principal || principal.status !== 'active') return { ok: false as const };
      const candidates = normalizedCode ? this.recoveryHash.candidates(normalizedCode) : [];
      const codes =
        candidates.length > 0
          ? await transaction
              .select()
              .from(adminMfaRecoveryCodes)
              .where(
                and(
                  eq(adminMfaRecoveryCodes.adminPrincipalId, principal.id),
                  inArray(
                    adminMfaRecoveryCodes.codeHash,
                    candidates.map((candidate) => candidate.digest),
                  ),
                  isNull(adminMfaRecoveryCodes.usedAt),
                ),
              )
              .for('update')
          : [];
      const matched = codes.find((candidate) =>
        this.recoveryHash.verify(normalizedCode!, {
          keyId: candidate.keyId,
          digest: candidate.codeHash,
        }),
      );
      if (!matched) {
        await this.recordChallengeFailure(transaction, challenge);
        return { ok: false as const };
      }
      const consumedAt = now();
      await transaction
        .update(adminMfaRecoveryCodes)
        .set({ usedAt: consumedAt })
        .where(and(eq(adminMfaRecoveryCodes.id, matched.id), isNull(adminMfaRecoveryCodes.usedAt)));
      await transaction
        .update(adminAuthChallenges)
        .set({ status: 'consumed', usedAt: consumedAt })
        .where(eq(adminAuthChallenges.id, challenge.id));
      await this.rekeyIdentifierInTransaction(transaction, challenge, principal);
      const session = await this.createSessionInTransaction(transaction, principal.id, request, {
        mfaLevel: 'recovery',
        recoveryRestricted: true,
      });
      await this.auditAuthAttempt(transaction, request, {
        action: 'admin.auth.login',
        principalId: principal.id,
        sessionId: session.context.id,
        mfaLevel: 'recovery',
        result: 'succeeded',
      });
      return { ok: true as const, session };
    });
    if (!result.ok) {
      await this.auditAuthAttempt(this.database, request, {
        action: 'admin.auth.login',
        result: 'failed',
        errorCode: 'ADMIN_AUTH_INVALID',
      });
      adminAuthError('ADMIN_AUTH_INVALID');
    }
    return { session: result.session };
  }

  async resolveSession(request: AdminRequest, requireCsrf = false): Promise<AdminSessionContext> {
    const rawToken = this.readSessionToken(request);
    if (!rawToken) adminAuthError('ADMIN_SESSION_REQUIRED');
    const candidates = this.sessionHash.candidates(rawToken);
    const [session] = await this.database
      .select()
      .from(adminSessions)
      .where(
        and(
          inArray(
            adminSessions.sessionTokenHash,
            candidates.map((candidate) => candidate.digest),
          ),
          eq(adminSessions.status, 'active'),
        ),
      );
    if (!session) adminAuthError('ADMIN_SESSION_REQUIRED');
    if (
      !this.sessionHash.verify(rawToken, {
        keyId: session.sessionKeyId,
        digest: session.sessionTokenHash,
      })
    ) {
      adminAuthError('ADMIN_SESSION_REQUIRED');
    }
    const [principal] = await this.database
      .select()
      .from(adminPrincipals)
      .where(eq(adminPrincipals.id, session.adminPrincipalId));
    if (
      !principal ||
      principal.status !== 'active' ||
      principal.authzVersion !== session.authzVersionSnapshot ||
      session.sessionExpiresAt.getTime() <= Date.now() ||
      session.idleExpiresAt.getTime() <= Date.now()
    ) {
      adminAuthError('ADMIN_SESSION_REQUIRED');
    }
    const bindings = await this.database.query.adminRoleBindings.findMany({
      where: eq(adminRoleBindings.adminPrincipalId, principal.id),
    });
    const permissions = session.recoveryRestricted
      ? []
      : [...new Set(bindings.flatMap((binding) => rolePermissions(binding.roleKey)))].sort();
    const context: AdminSessionContext = {
      id: session.id,
      principalId: principal.id,
      rawToken,
      authzVersion: principal.authzVersion,
      mfaLevel: session.mfaLevel,
      recoveryRestricted: session.recoveryRestricted,
      stepUpAt: session.stepUpAt,
      permissions,
      scopes: bindings.map((binding) => ({
        roleKey: binding.roleKey,
        scopeType: binding.scopeType,
        scopeKey: binding.scopeKey,
      })),
      sessionExpiresAt: session.sessionExpiresAt,
      idleExpiresAt: session.idleExpiresAt,
      sourceIpHash: session.sourceIpHash,
      userAgentHash: session.userAgentHash,
    };
    if (
      requireCsrf &&
      !this.verifyCsrf(request, session.id, rawToken, session.csrfTokenHash, session.csrfKeyId)
    ) {
      adminAuthError('ADMIN_CSRF_INVALID', 403);
    }
    await this.database
      .update(adminSessions)
      .set({
        lastSeenAt: now(),
        idleExpiresAt: new Date(Date.now() + this.config.admin.sessionIdleTtlSeconds * 1_000),
      })
      .where(eq(adminSessions.id, session.id));
    return context;
  }

  async sessionInfo(request: AdminRequest): Promise<SessionResult> {
    const context = await this.resolveSession(request);
    const [principal] = await this.database
      .select()
      .from(adminPrincipals)
      .where(eq(adminPrincipals.id, context.principalId));
    if (!principal) adminAuthError('ADMIN_SESSION_REQUIRED');
    const [session] = await this.database
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.id, context.id));
    if (!session) adminAuthError('ADMIN_SESSION_REQUIRED');
    const csrfToken = this.csrfDerivation
      .candidates(`${context.rawToken}:${context.id}`)
      .find((candidate) => candidate.keyId === session.csrfKeyId);
    if (!csrfToken || csrfToken.digest !== session.csrfTokenHash) {
      adminAuthError('ADMIN_SESSION_REQUIRED');
    }
    return {
      context,
      csrfToken: csrfToken.digest,
      principal: {
        id: principal.id,
        identifierHint: principal.identifierHint,
        displayName: principal.displayName,
        status: 'active',
      },
    };
  }

  async logout(request: AdminRequest): Promise<void> {
    const context = await this.resolveSession(request, true);
    await this.database.transaction(async (transaction) => {
      const revoked = await transaction
        .update(adminSessions)
        .set({ status: 'revoked', revokedAt: now() })
        .where(and(eq(adminSessions.id, context.id), eq(adminSessions.status, 'active')))
        .returning({ id: adminSessions.id });
      if (revoked.length !== 1) adminAuthError('ADMIN_SESSION_REQUIRED');
      await transaction.insert(adminAuditLogs).values({
        actorAdminId: context.principalId,
        actorType: 'admin_session',
        adminSessionId: context.id,
        permissionSnapshot: { permissions: context.permissions },
        action: 'admin.auth.logout',
        targetType: 'admin_session',
        targetId: context.id,
        requestId: requestId(request),
        sourceIpHash: context.sourceIpHash,
        userAgentHash: context.userAgentHash,
        mfaLevel: context.mfaLevel,
        stepUpAt: context.stepUpAt,
        result: 'succeeded',
      });
    });
  }

  async revokeOtherSessions(request: AdminRequest): Promise<{ revokedCount: number }> {
    const context = await this.resolveSession(request, true);
    this.requireStepUp(context);
    return this.database.transaction(async (transaction) => {
      const [session] = await transaction
        .select()
        .from(adminSessions)
        .where(eq(adminSessions.id, context.id))
        .for('update');
      if (
        !session ||
        session.status !== 'active' ||
        session.authzVersionSnapshot !== context.authzVersion
      ) {
        adminAuthError('ADMIN_SESSION_REQUIRED');
      }
      const revoked = await transaction
        .update(adminSessions)
        .set({ status: 'revoked', revokedAt: now() })
        .where(
          and(
            eq(adminSessions.adminPrincipalId, context.principalId),
            eq(adminSessions.status, 'active'),
            sql`${adminSessions.id} <> ${context.id}`,
          ),
        )
        .returning({ id: adminSessions.id });
      await transaction.insert(adminAuditLogs).values({
        actorAdminId: context.principalId,
        actorType: 'admin_session',
        adminSessionId: context.id,
        permissionSnapshot: { permissions: context.permissions },
        action: 'admin.auth.other_sessions_revoked',
        targetType: 'admin_principal',
        targetId: context.principalId,
        afterJson: { revoked_count: revoked.length },
        requestId: requestId(request),
        sourceIpHash: context.sourceIpHash,
        userAgentHash: context.userAgentHash,
        mfaLevel: context.mfaLevel,
        stepUpAt: context.stepUpAt,
        result: 'succeeded',
      });
      return { revokedCount: revoked.length };
    });
  }

  async stepUp(request: AdminRequest, password: string, code: string): Promise<SessionResult> {
    const context = await this.resolveSession(request, true);
    await this.assertRateLimit(
      'step-up-principal',
      this.sourceHash.digest(context.principalId).digest,
      this.config.admin.authLimits.stepUpTenMinutes,
    );
    if (context.recoveryRestricted) adminAuthError('ADMIN_STEP_UP_REQUIRED', 403);
    const [credential] = await this.database
      .select()
      .from(adminCredentials)
      .where(
        and(
          eq(adminCredentials.adminPrincipalId, context.principalId),
          eq(adminCredentials.credentialType, 'password'),
          eq(adminCredentials.status, 'active'),
        ),
      );
    const [totpCredential] = await this.database
      .select()
      .from(adminCredentials)
      .where(
        and(
          eq(adminCredentials.adminPrincipalId, context.principalId),
          eq(adminCredentials.credentialType, 'totp'),
          eq(adminCredentials.status, 'active'),
        ),
      );
    if (!credential?.passwordHash || !(await argon2.verify(credential.passwordHash, password))) {
      adminAuthError('ADMIN_AUTH_INVALID');
    }
    if (!totpCredential) adminAuthError('ADMIN_AUTH_UNAVAILABLE', 503);
    let secret: string;
    try {
      secret = this.totpEnvelope.decrypt({
        keyId: totpCredential.secretKeyId!,
        ciphertext: totpCredential.secretCiphertext!,
        nonce: totpCredential.secretNonce!,
        authTag: totpCredential.secretAuthTag!,
      });
    } catch {
      throw new AdminAuthError('ADMIN_AUTH_UNAVAILABLE', 503);
    }
    const step = verifyTotp(secret, code);
    if (step === undefined || (totpCredential.totpLastUsedStep ?? -1) >= step) {
      adminAuthError('ADMIN_AUTH_INVALID');
    }
    await this.database.transaction(async (transaction) => {
      const [locked] = await transaction
        .select()
        .from(adminSessions)
        .where(eq(adminSessions.id, context.id))
        .for('update');
      if (
        !locked ||
        locked.status !== 'active' ||
        locked.authzVersionSnapshot !== context.authzVersion
      ) {
        adminAuthError('ADMIN_SESSION_REQUIRED');
      }
      const [lockedPassword] = await transaction
        .select()
        .from(adminCredentials)
        .where(eq(adminCredentials.id, credential.id))
        .for('update');
      const [lockedTotp] = await transaction
        .select()
        .from(adminCredentials)
        .where(eq(adminCredentials.id, totpCredential.id))
        .for('update');
      if (
        !lockedPassword ||
        lockedPassword.status !== 'active' ||
        lockedPassword.passwordHash !== credential.passwordHash ||
        !lockedTotp ||
        lockedTotp.status !== 'active' ||
        (lockedTotp.totpLastUsedStep ?? -1) >= step
      ) {
        adminAuthError('ADMIN_AUTH_INVALID');
      }
      await transaction
        .update(adminCredentials)
        .set({ totpLastUsedStep: step })
        .where(eq(adminCredentials.id, totpCredential.id));
      await transaction
        .update(adminSessions)
        .set({ stepUpAt: now() })
        .where(eq(adminSessions.id, context.id));
      await transaction.insert(adminAuditLogs).values({
        actorAdminId: context.principalId,
        actorType: 'admin_session',
        adminSessionId: context.id,
        permissionSnapshot: { permissions: context.permissions },
        action: 'admin.auth.step_up',
        targetType: 'admin_session',
        targetId: context.id,
        requestId: requestId(request),
        sourceIpHash: context.sourceIpHash,
        userAgentHash: context.userAgentHash,
        mfaLevel: 'totp',
        stepUpAt: now(),
        result: 'succeeded',
      });
    });
    return this.sessionInfo(request);
  }

  async startEnrollment(
    request: AdminRequest,
    enrollmentToken: string,
    newPassword: string,
  ): Promise<{
    challengeId: string;
    challengeToken: string;
    totpSecret: string;
    provisioningUri: string;
    expiresInSeconds: number;
  }> {
    await this.assertRateLimit(
      'enrollment-token',
      this.enrollmentHash.digest(enrollmentToken).digest,
      this.config.admin.authLimits.loginTenMinutes,
    );
    await this.assertRateLimit(
      'enrollment-source',
      this.sourceHash.digest(sourceIp(request, this.adminProxyResolver)).digest,
      this.config.admin.authLimits.loginTenMinutes,
    );
    const passwordHash = await argon2.hash(newPassword, {
      type: argon2.argon2id,
      memoryCost: this.config.admin.argon2.memoryKiB,
      timeCost: this.config.admin.argon2.timeCost,
      parallelism: this.config.admin.argon2.parallelism,
    });
    const tokenCandidates = this.enrollmentHash.candidates(enrollmentToken);
    const result = await this.database.transaction(async (transaction) => {
      const [token] = await transaction
        .select()
        .from(adminEnrollmentTokens)
        .where(
          inArray(
            adminEnrollmentTokens.tokenHash,
            tokenCandidates.map((candidate) => candidate.digest),
          ),
        )
        .for('update');
      if (!token || token.status !== 'issued' || token.expiresAt.getTime() <= Date.now()) {
        if (token?.status === 'issued' && token.expiresAt.getTime() <= Date.now()) {
          await transaction
            .update(adminEnrollmentTokens)
            .set({ status: 'expired', revision: token.revision + 1 })
            .where(eq(adminEnrollmentTokens.id, token.id));
        }
        return { ok: false as const };
      }
      if (
        !this.enrollmentHash.verify(enrollmentToken, {
          keyId: token.keyId,
          digest: token.tokenHash,
        })
      ) {
        return { ok: false as const };
      }
      const [principal] = await transaction
        .select()
        .from(adminPrincipals)
        .where(eq(adminPrincipals.id, token.adminPrincipalId))
        .for('update');
      if (!principal || principal.status !== 'pending_enrollment') return { ok: false as const };
      const totpSecret = createTotpSecret();
      const encrypted = this.totpEnvelope.encrypt(totpSecret);
      const challengeToken = randomToken();
      const challengeDigest = this.challengeHash.digest(challengeToken);
      const challengeId = randomUUID();
      await transaction
        .update(adminEnrollmentTokens)
        .set({ status: 'claimed', claimedAt: now(), revision: token.revision + 1 })
        .where(eq(adminEnrollmentTokens.id, token.id));
      await transaction.insert(adminCredentials).values([
        {
          adminPrincipalId: principal.id,
          credentialType: 'password',
          passwordHash,
          passwordHashMetadata: {
            algorithm: 'argon2id',
            memory_kib: this.config.admin.argon2.memoryKiB,
            time_cost: this.config.admin.argon2.timeCost,
            parallelism: this.config.admin.argon2.parallelism,
          },
          status: 'pending',
        },
        {
          adminPrincipalId: principal.id,
          credentialType: 'totp',
          secretCiphertext: encrypted.ciphertext,
          secretNonce: encrypted.nonce,
          secretAuthTag: encrypted.authTag,
          secretKeyId: encrypted.keyId,
          status: 'pending',
        },
      ]);
      await transaction.insert(adminAuthChallenges).values({
        id: challengeId,
        adminPrincipalId: principal.id,
        purpose: 'enrollment_mfa',
        challengeTokenHash: challengeDigest.digest,
        challengeKeyId: challengeDigest.keyId,
        expiresAt: new Date(Date.now() + this.config.admin.challengeTtlSeconds * 1_000),
      });
      return {
        ok: true as const,
        challengeId,
        challengeToken,
        totpSecret,
        provisioningUri: totpProvisioningUri(totpSecret, principal.identifierHint),
      };
    });
    if (!result.ok) adminAuthError('ADMIN_ENROLLMENT_INVALID');
    return {
      challengeId: result.challengeId,
      challengeToken: result.challengeToken,
      totpSecret: result.totpSecret,
      provisioningUri: result.provisioningUri,
      expiresInSeconds: this.config.admin.challengeTtlSeconds,
    };
  }

  async activateEnrollment(
    challengeId: string,
    challengeToken: string,
    code: string,
    request: AdminRequest,
  ): Promise<TotpSuccess> {
    await this.assertRateLimit(
      'enrollment-challenge',
      this.challengeHash.digest(challengeId).digest,
      this.config.admin.authLimits.mfaTenMinutes,
    );
    await this.assertRateLimit(
      'enrollment-source',
      this.sourceHash.digest(sourceIp(request, this.adminProxyResolver)).digest,
      this.config.admin.authLimits.mfaTenMinutes,
    );
    const recoveryCodes = createRecoveryCodes();
    const result = await this.database.transaction(async (transaction) => {
      const [challenge] = await transaction
        .select()
        .from(adminAuthChallenges)
        .where(eq(adminAuthChallenges.id, challengeId))
        .for('update');
      if (
        !challenge ||
        challenge.purpose !== 'enrollment_mfa' ||
        challenge.status !== 'pending' ||
        challenge.expiresAt.getTime() <= Date.now() ||
        !this.challengeHash.verify(challengeToken, {
          keyId: challenge.challengeKeyId,
          digest: challenge.challengeTokenHash,
        })
      ) {
        return { ok: false as const };
      }
      const [principal] = await transaction
        .select()
        .from(adminPrincipals)
        .where(eq(adminPrincipals.id, challenge.adminPrincipalId))
        .for('update');
      const [totpCredential] = await transaction
        .select()
        .from(adminCredentials)
        .where(
          and(
            eq(adminCredentials.adminPrincipalId, challenge.adminPrincipalId),
            eq(adminCredentials.credentialType, 'totp'),
            eq(adminCredentials.status, 'pending'),
          ),
        )
        .for('update');
      const [passwordCredential] = await transaction
        .select()
        .from(adminCredentials)
        .where(
          and(
            eq(adminCredentials.adminPrincipalId, challenge.adminPrincipalId),
            eq(adminCredentials.credentialType, 'password'),
            eq(adminCredentials.status, 'pending'),
          ),
        )
        .for('update');
      if (!principal || !totpCredential || !passwordCredential) return { ok: false as const };
      const secret = this.totpEnvelope.decrypt({
        keyId: totpCredential.secretKeyId!,
        ciphertext: totpCredential.secretCiphertext!,
        nonce: totpCredential.secretNonce!,
        authTag: totpCredential.secretAuthTag!,
      });
      const step = verifyTotp(secret, code);
      if (step === undefined) {
        await this.recordChallengeFailure(transaction, challenge);
        return { ok: false as const };
      }
      await transaction
        .update(adminAuthChallenges)
        .set({ status: 'consumed', usedAt: now() })
        .where(eq(adminAuthChallenges.id, challenge.id));
      await transaction
        .update(adminCredentials)
        .set({ status: 'active', totpLastUsedStep: step })
        .where(eq(adminCredentials.id, totpCredential.id));
      await transaction
        .update(adminCredentials)
        .set({ status: 'active' })
        .where(eq(adminCredentials.id, passwordCredential.id));
      await transaction
        .update(adminPrincipals)
        .set({
          status: 'active',
          authzVersion: principal.authzVersion + 1,
          revision: principal.revision + 1,
        })
        .where(eq(adminPrincipals.id, principal.id));
      const [token] = await transaction
        .select()
        .from(adminEnrollmentTokens)
        .where(
          and(
            eq(adminEnrollmentTokens.adminPrincipalId, principal.id),
            eq(adminEnrollmentTokens.status, 'claimed'),
          ),
        )
        .for('update');
      if (token) {
        await transaction
          .update(adminEnrollmentTokens)
          .set({ status: 'used', usedAt: now(), revision: token.revision + 1 })
          .where(eq(adminEnrollmentTokens.id, token.id));
      }
      await transaction.insert(adminMfaRecoveryCodes).values(
        recoveryCodes.map((codeValue) => {
          const digest = hashRecoveryCode(this.recoveryHash, codeValue);
          return {
            adminPrincipalId: principal.id,
            codeHash: digest.digest,
            keyId: digest.keyId,
          };
        }),
      );
      const session = await this.createSessionInTransaction(transaction, principal.id, request);
      return { ok: true as const, session };
    });
    if (!result.ok) adminAuthError('ADMIN_ENROLLMENT_INVALID');
    return { session: result.session, recoveryCodes };
  }

  requirePermission(context: AdminSessionContext, permission: string): void {
    if (context.recoveryRestricted || !context.permissions.includes(permission)) {
      adminAuthError('ADMIN_PERMISSION_DENIED', 403);
    }
  }

  requireStepUp(context: AdminSessionContext): void {
    if (
      context.recoveryRestricted ||
      !context.stepUpAt ||
      context.stepUpAt.getTime() + this.config.admin.stepUpTtlSeconds * 1_000 <= Date.now()
    ) {
      adminAuthError('ADMIN_STEP_UP_REQUIRED', 403);
    }
  }

  async bootstrap(input: {
    identifier: string;
    displayName: string;
    password: string;
    totpSecret: string;
    totpCode: string;
  }): Promise<{ principalId: string; recoveryCodes: string[] }> {
    const identifier = normalizeAdminIdentifier(input.identifier);
    const step = verifyTotp(input.totpSecret, input.totpCode);
    if (step === undefined) adminAuthError('ADMIN_TOTP_INVALID', 400);
    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
      memoryCost: this.config.admin.argon2.memoryKiB,
      timeCost: this.config.admin.argon2.timeCost,
      parallelism: this.config.admin.argon2.parallelism,
    });
    const recoveryCodes = createRecoveryCodes();
    const identifierDigest = this.identifierHash.digest(identifier);
    const envelope = this.totpEnvelope.encrypt(input.totpSecret);
    const result = await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('admin-super-admin-set', 'global')})`,
      );
      const existing = await transaction
        .select({ id: adminPrincipals.id })
        .from(adminPrincipals)
        .innerJoin(adminRoleBindings, eq(adminRoleBindings.adminPrincipalId, adminPrincipals.id))
        .where(
          and(eq(adminPrincipals.status, 'active'), eq(adminRoleBindings.roleKey, 'super_admin')),
        );
      if (existing.length > 0) adminAuthError('ADMIN_BOOTSTRAP_ALREADY_COMPLETE', 409);
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
        identifierHint: maskAdminIdentifier(identifier),
        displayName: input.displayName.trim(),
        status: 'active',
        authzVersion: 1,
        revision: 1,
      });
      await transaction.insert(adminCredentials).values([
        {
          adminPrincipalId: principalId,
          credentialType: 'password',
          passwordHash,
          passwordHashMetadata: {
            algorithm: 'argon2id',
            memory_kib: this.config.admin.argon2.memoryKiB,
            time_cost: this.config.admin.argon2.timeCost,
            parallelism: this.config.admin.argon2.parallelism,
          },
          status: 'active',
        },
        {
          adminPrincipalId: principalId,
          credentialType: 'totp',
          secretCiphertext: envelope.ciphertext,
          secretNonce: envelope.nonce,
          secretAuthTag: envelope.authTag,
          secretKeyId: envelope.keyId,
          totpLastUsedStep: step,
          status: 'active',
        },
      ]);
      const bindings = [{ roleKey: 'super_admin', scopeKey: 'global' }];
      await transaction.insert(adminRoleBindings).values({
        adminPrincipalId: principalId,
        roleKey: 'super_admin',
        scopeType: 'global',
        scopeKey: 'global',
        permissionSnapshotHash: permissionSnapshotHash(bindings),
      });
      await transaction.insert(adminMfaRecoveryCodes).values(
        recoveryCodes.map((codeValue) => {
          const digest = hashRecoveryCode(this.recoveryHash, codeValue);
          return { adminPrincipalId: principalId, codeHash: digest.digest, keyId: digest.keyId };
        }),
      );
      await transaction.insert(adminAuditLogs).values({
        actorType: 'bootstrap_cli',
        action: 'admin.bootstrap.create_super_admin',
        targetType: 'admin_principal',
        targetId: principalId,
        permissionSnapshot: { role: 'super_admin', version: 1 },
        requestId: `bootstrap:${principalId}`,
        mfaLevel: 'totp',
        result: 'succeeded',
      });
      return { principalId };
    });
    return { ...result, recoveryCodes };
  }

  private readSessionToken(request: AdminRequest): string | undefined {
    const header = request.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const separator = part.indexOf('=');
      if (separator > 0 && part.slice(0, separator).trim() === this.config.admin.cookieName) {
        return decodeURIComponent(part.slice(separator + 1).trim());
      }
    }
    return undefined;
  }

  private verifyCsrf(
    request: AdminRequest,
    sessionId: string,
    rawToken: string,
    expectedHash: string,
    expectedKeyId: string,
  ): boolean {
    const value = request.headers['x-admin-csrf'];
    const token = Array.isArray(value) ? value[0] : value;
    if (!token) return false;
    const derived = this.csrfDerivation.candidates(`${rawToken}:${sessionId}`);
    const candidate = derived.find((item) => item.keyId === expectedKeyId);
    return Boolean(candidate?.digest === expectedHash && token === candidate.digest);
  }

  private async createSessionInTransaction(
    transaction: Transaction,
    principalId: string,
    request: AdminRequest,
    options: {
      mfaLevel: 'totp' | 'recovery';
      recoveryRestricted: boolean;
      stepUpAt?: Date | null;
    } = {
      mfaLevel: 'totp',
      recoveryRestricted: false,
    },
  ): Promise<SessionResult> {
    const [principal] = await transaction
      .select()
      .from(adminPrincipals)
      .where(eq(adminPrincipals.id, principalId));
    if (!principal || principal.status !== 'active') adminAuthError('ADMIN_SESSION_REQUIRED');
    const bindings = await transaction
      .select()
      .from(adminRoleBindings)
      .where(eq(adminRoleBindings.adminPrincipalId, principalId));
    const permissions = options.recoveryRestricted
      ? []
      : [...new Set(bindings.flatMap((binding) => rolePermissions(binding.roleKey)))].sort();
    const rawToken = randomToken();
    const sessionId = randomUUID();
    const tokenDigest = this.sessionHash.digest(rawToken);
    const csrfDigest = this.csrfDerivation.digest(`${rawToken}:${sessionId}`);
    const createdAt = now();
    const sourceIpHash = this.sourceHash.digest(sourceIp(request, this.adminProxyResolver)).digest;
    const userAgentHash = this.sourceHash.digest(`user-agent:${userAgent(request)}`).digest;
    const sessionExpiresAt = new Date(
      createdAt.getTime() + this.config.admin.sessionTtlSeconds * 1_000,
    );
    const idleExpiresAt = new Date(
      createdAt.getTime() + this.config.admin.sessionIdleTtlSeconds * 1_000,
    );
    await transaction.insert(adminSessions).values({
      id: sessionId,
      adminPrincipalId: principalId,
      sessionTokenHash: tokenDigest.digest,
      sessionKeyId: tokenDigest.keyId,
      csrfTokenHash: csrfDigest.digest,
      csrfKeyId: csrfDigest.keyId,
      authzVersionSnapshot: principal.authzVersion,
      mfaLevel: options.mfaLevel,
      mfaVerifiedAt: createdAt,
      stepUpAt: options.stepUpAt ?? null,
      recoveryRestricted: options.recoveryRestricted,
      sessionExpiresAt,
      idleExpiresAt,
      sourceIpHash,
      userAgentHash,
    });
    return {
      context: {
        id: sessionId,
        principalId,
        rawToken,
        authzVersion: principal.authzVersion,
        mfaLevel: options.mfaLevel,
        recoveryRestricted: options.recoveryRestricted,
        stepUpAt: options.stepUpAt ?? null,
        permissions,
        scopes: bindings.map((binding) => ({
          roleKey: binding.roleKey,
          scopeType: binding.scopeType,
          scopeKey: binding.scopeKey,
        })),
        sessionExpiresAt,
        idleExpiresAt,
        sourceIpHash,
        userAgentHash,
      },
      csrfToken: csrfDigest.digest,
      principal: {
        id: principal.id,
        identifierHint: principal.identifierHint,
        displayName: principal.displayName,
        status: 'active',
      },
    };
  }

  private async assertRateLimit(scope: string, digest: string, limit: number): Promise<void> {
    if (!this.rateLimiter) adminAuthError('ADMIN_AUTH_UNAVAILABLE', 503);
    await this.rateLimiter.assertAllowed(scope, digest, limit);
  }

  private async auditAuthAttempt(
    database: Database | Transaction,
    request: AdminRequest,
    input: {
      action: string;
      principalId?: string;
      sessionId?: string;
      mfaLevel?: string;
      result: 'succeeded' | 'failed' | 'blocked';
      errorCode?: string;
    },
  ): Promise<void> {
    await database.insert(adminAuditLogs).values({
      actorAdminId: input.principalId,
      actorType: input.sessionId ? 'admin_session' : 'system',
      adminSessionId: input.sessionId,
      action: input.action,
      targetType: input.sessionId ? 'admin_session' : 'admin_principal',
      targetId: input.sessionId ?? input.principalId,
      requestId: requestId(request),
      sourceIpHash: this.sourceHash.digest(sourceIp(request, this.adminProxyResolver)).digest,
      userAgentHash: this.sourceHash.digest(`user-agent:${userAgent(request)}`).digest,
      mfaLevel: input.mfaLevel,
      result: input.result,
      errorCode: input.errorCode,
    });
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

  private async rekeyIdentifierInTransaction(
    transaction: Transaction,
    challenge: Pick<
      typeof adminAuthChallenges.$inferSelect,
      'identifierRekeyHash' | 'identifierRekeyKeyId'
    >,
    principal: Pick<
      typeof adminPrincipals.$inferSelect,
      'id' | 'identifierHash' | 'identifierKeyId' | 'revision'
    >,
  ): Promise<void> {
    if (!challenge.identifierRekeyHash || !challenge.identifierRekeyKeyId) return;
    const conflict = await transaction.query.adminPrincipals.findFirst({
      where: and(
        eq(adminPrincipals.identifierHash, challenge.identifierRekeyHash),
        eq(adminPrincipals.identifierKeyId, challenge.identifierRekeyKeyId),
        sql`${adminPrincipals.id} <> ${principal.id}`,
      ),
    });
    if (conflict) throw new AdminAuthError('ADMIN_AUTH_UNAVAILABLE', 503);
    if (
      principal.identifierHash === challenge.identifierRekeyHash &&
      principal.identifierKeyId === challenge.identifierRekeyKeyId
    ) {
      return;
    }
    const updated = await transaction
      .update(adminPrincipals)
      .set({
        identifierHash: challenge.identifierRekeyHash,
        identifierKeyId: challenge.identifierRekeyKeyId,
        revision: principal.revision + 1,
      })
      .where(
        and(eq(adminPrincipals.id, principal.id), eq(adminPrincipals.revision, principal.revision)),
      )
      .returning({ id: adminPrincipals.id });
    if (updated.length !== 1) throw new AdminAuthError('ADMIN_AUTH_UNAVAILABLE', 503);
  }
}
