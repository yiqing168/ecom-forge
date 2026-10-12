import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as OTPAuth from 'otpauth';
import { createClient } from 'redis';
import request from 'supertest';
import { z } from 'zod';

import {
  adminAuditLogs,
  adminAuthChallenges,
  adminCredentials,
  adminEnrollmentTokens,
  adminIdempotencyRecords,
  adminMfaRecoveryCodes,
  adminPrincipals,
  adminRoleBindings,
  adminSessions,
  and,
  appeals,
  authSessions,
  billableSkus,
  creditAccounts,
  creditLedger,
  creditReservations,
  eq,
  eventOutbox,
  inArray,
  inviteCodeBatches,
  inviteCodes,
  inviteCampaigns,
  modelCatalogEntries,
  modelConfigurations,
  modelPocRuns,
  models,
  moderationRuntimeStates,
  or,
  providerChannels,
  providerCredentialValidationRuns,
  providerCredentialVersions,
  pricingCatalogReleases,
  pricingCatalogState,
  queueDispatchIntents,
  registrationRewardClaims,
  rewardCampaigns,
  runQuotes,
  storageChannels,
  storageCredentialVersions,
  storageRuntimeState,
  storageValidationRuns,
  taskAttempts,
  tasks,
  users,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import { QueueIntentRepository, queueRecoverySentinelKey } from '@ecom-forge/queue';

import { AppModule } from '../src/app.module.js';
import type { AppConfig } from '../src/config/app-config.js';
import { APP_CONFIG } from '../src/config/config.module.js';
import { AdminAuthService } from '../src/modules/admin-auth/admin-auth.service.js';
import { createTotpSecret } from '../src/modules/admin-auth/admin-crypto.js';
import type { AdminRequest } from '../src/modules/admin-auth/admin-http.js';
import { permissionSnapshotHash } from '../src/modules/admin-auth/admin-roles.js';
import { HmacKeyring } from '../src/modules/auth/security/hmac-keyring.js';
import { DATABASE } from '../src/shared/database/database.module.js';

const ADMIN_ORIGIN = 'http://localhost:3200';
const ADMIN_HOST = 'localhost:3001';
const FIRST_IDENTIFIER = 's14-admin-primary@example.test';
const SECOND_IDENTIFIER = 's14-admin-secondary@example.test';
const FIRST_PASSWORD = 'S14-primary-password-123!';
const SECOND_PASSWORD = 'S14-secondary-password-123!';
const USER_CONTROL_EMAIL = 's14-admin-user-control@example.test';
type Agent = ReturnType<typeof request.agent>;

const loginResponseSchema = z.object({
  challenge_id: z.string().uuid(),
  challenge_token: z.string(),
});
const sessionResponseSchema = z.object({
  principal: z.object({ id: z.string().uuid() }),
  permissions: z.array(z.string()),
  csrf_token: z.string(),
});
const mfaResponseSchema = z.object({
  csrf_token: z.string(),
  recovery_restricted: z.boolean().optional(),
});
const createPrincipalResponseSchema = z.object({
  principal_id: z.string().uuid(),
  enrollment_token: z.string().optional(),
});
const enrollmentResponseSchema = z.object({
  challenge_id: z.string().uuid(),
  challenge_token: z.string(),
  totp_secret: z.string(),
});
const activationResponseSchema = z.object({
  csrf_token: z.string(),
  recovery_codes: z.array(z.string()),
});
const errorResponseSchema = z.object({ error: z.object({ code: z.string() }) });
const idResponseSchema = z.object({ id: z.string().uuid() });
const credentialResponseSchema = z.object({ id: z.string().uuid() });
const validationResponseSchema = z.object({ validation_run_id: z.string().uuid() });
const adminPageResponseSchema = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
  next_cursor: z.string().nullable().optional(),
});
const adminDashboardResponseSchema = z.object({
  workflow_runs: z.record(z.string(), z.number()),
  tasks: z.record(z.string(), z.unknown()),
  users_by_risk: z.record(z.string(), z.number()),
  queue_backlog: z.record(z.string(), z.number()),
  credits: z.object({ balance: z.string(), frozen: z.string() }),
  releases: z.record(z.string(), z.unknown()),
});
const adminHealthResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  dependencies: z.record(z.string(), z.string()),
  workers: z.array(z.record(z.string(), z.unknown())),
  provider_summary: z.record(z.string(), z.number()),
});
function totpCode(secret: string, stepOffset = 0): string {
  const generator = new OTPAuth.TOTP({
    issuer: 'Ecom Forge Admin',
    label: 's14-integration',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  return generator.generate({ timestamp: Date.now() + stepOffset * 30_000 });
}

async function avoidTotpBoundary(): Promise<void> {
  const remainingMs = 30_000 - (Date.now() % 30_000);
  if (remainingMs < 4_000) await delay(remainingMs + 250);
}

function post(agent: Agent, path: string, body: object | string) {
  return agent
    .post(path)
    .set('Host', ADMIN_HOST)
    .set('Origin', ADMIN_ORIGIN)
    .set('Content-Type', 'application/json')
    .send(body);
}

function put(agent: Agent, path: string, body: object | string) {
  return agent
    .put(path)
    .set('Host', ADMIN_HOST)
    .set('Origin', ADMIN_ORIGIN)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('S14 Admin authentication and principal control', () => {
  let app: INestApplication;
  let database: Database;
  let config: AppConfig;
  let auth: AdminAuthService;
  let originalRedisPrefix: string | undefined;
  let originalDatabaseUrl: string | undefined;
  let originalTestDatabaseUrl: string | undefined;
  let authTestRedis: ReturnType<typeof createClient> | undefined;
  let recoveryRedis: ReturnType<typeof createClient> | undefined;
  const controlPlaneIds = {
    providerChannel: [] as string[],
    providerCredential: [] as string[],
    providerRun: [] as string[],
    storageChannel: [] as string[],
    storageCredential: [] as string[],
    storageRun: [] as string[],
    model: [] as string[],
    modelRun: [] as string[],
    catalog: [] as string[],
    sku: [] as string[],
    pricingRelease: [] as string[],
    rewardCampaign: [] as string[],
    inviteCampaign: [] as string[],
    inviteBatch: [] as string[],
    inviteCode: [] as string[],
  };

  async function fixturePrincipalIds(): Promise<string[]> {
    const keyring = new HmacKeyring(config.admin.identifierHashKeys);
    const candidates = [FIRST_IDENTIFIER, SECOND_IDENTIFIER].flatMap((identifier) =>
      keyring.candidates(identifier),
    );
    const rows = await database
      .select({ id: adminPrincipals.id })
      .from(adminPrincipals)
      .where(
        or(
          inArray(adminPrincipals.displayName, ['S14 Primary Admin', 'S14 Secondary Admin']),
          ...candidates.map((candidate) =>
            and(
              eq(adminPrincipals.identifierKeyId, candidate.keyId),
              eq(adminPrincipals.identifierHash, candidate.digest),
            ),
          ),
        ),
      );
    return rows.map((row) => row.id);
  }

  function resetControlPlaneIds(): void {
    for (const ids of Object.values(controlPlaneIds)) ids.length = 0;
  }

  async function resetAuthRateLimits(): Promise<void> {
    if (!authTestRedis?.isOpen) return;
    const keys = await authTestRedis.keys(`${config.redisPrefix}:admin-auth:*`);
    if (keys.length > 0) await authTestRedis.unlink(keys);
  }

  async function cleanupControlledUserFixture(): Promise<void> {
    const controlledUsers = await database
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.email, [USER_CONTROL_EMAIL]));
    const userIds = controlledUsers.map((row) => row.id);
    if (userIds.length === 0) return;
    const workflowRows = await database
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(inArray(workflowRuns.userId, userIds));
    const workflowIds = workflowRows.map((row) => row.id);
    const taskRows =
      workflowIds.length > 0
        ? await database
            .select({ id: tasks.id })
            .from(tasks)
            .where(inArray(tasks.workflowRunId, workflowIds))
        : [];
    const taskIds = taskRows.map((row) => row.id);
    const appealRows = await database
      .select({ id: appeals.id })
      .from(appeals)
      .where(inArray(appeals.userId, userIds));
    const appealIds = appealRows.map((row) => row.id);
    await database
      .delete(registrationRewardClaims)
      .where(inArray(registrationRewardClaims.userId, userIds));
    if (workflowIds.length > 0) {
      await database.delete(eventOutbox).where(inArray(eventOutbox.scopeId, workflowIds));
    }
    if (appealIds.length > 0) {
      await database
        .update(appeals)
        .set({ decisionLedgerId: null })
        .where(inArray(appeals.id, appealIds));
      await database.delete(creditLedger).where(inArray(creditLedger.appealId, appealIds));
      await database.delete(appeals).where(inArray(appeals.id, appealIds));
    }
    await database.delete(creditLedger).where(inArray(creditLedger.userId, userIds));
    if (taskIds.length > 0) {
      await database.delete(taskAttempts).where(inArray(taskAttempts.taskId, taskIds));
      await database
        .delete(queueDispatchIntents)
        .where(
          and(
            eq(queueDispatchIntents.aggregateType, 'task'),
            inArray(queueDispatchIntents.aggregateId, taskIds),
          ),
        );
      await database.delete(tasks).where(inArray(tasks.id, taskIds));
    }
    if (workflowIds.length > 0) {
      await database
        .delete(queueDispatchIntents)
        .where(inArray(queueDispatchIntents.aggregateId, workflowIds));
      await database
        .update(runQuotes)
        .set({ workflowRunId: null })
        .where(inArray(runQuotes.userId, userIds));
      await database
        .update(creditReservations)
        .set({ workflowRunId: null })
        .where(inArray(creditReservations.userId, userIds));
      await database.delete(workflowRuns).where(inArray(workflowRuns.id, workflowIds));
    }
    await database.delete(creditReservations).where(inArray(creditReservations.userId, userIds));
    await database.delete(runQuotes).where(inArray(runQuotes.userId, userIds));
    await database.delete(creditAccounts).where(inArray(creditAccounts.userId, userIds));
    await database.delete(users).where(inArray(users.id, userIds));
  }

  async function cleanupFixture(): Promise<void> {
    await cleanupControlledUserFixture();
    const principalIds = await fixturePrincipalIds();
    if (principalIds.length > 0) {
      const [providerRows, storageRows] = await Promise.all([
        database
          .select({ id: providerChannels.id })
          .from(providerChannels)
          .where(inArray(providerChannels.createdByAdminId, principalIds)),
        database
          .select({ id: storageChannels.id })
          .from(storageChannels)
          .where(inArray(storageChannels.createdByAdminId, principalIds)),
      ]);
      controlPlaneIds.providerChannel.push(...providerRows.map((row) => row.id));
      controlPlaneIds.storageChannel.push(...storageRows.map((row) => row.id));
      if (controlPlaneIds.providerChannel.length > 0) {
        const [credentialRows, runRows, modelRows] = await Promise.all([
          database
            .select({ id: providerCredentialVersions.id })
            .from(providerCredentialVersions)
            .where(
              inArray(
                providerCredentialVersions.providerChannelId,
                controlPlaneIds.providerChannel,
              ),
            ),
          database
            .select({ id: providerCredentialValidationRuns.id })
            .from(providerCredentialValidationRuns)
            .where(
              inArray(
                providerCredentialValidationRuns.providerChannelId,
                controlPlaneIds.providerChannel,
              ),
            ),
          database
            .select({ id: models.id })
            .from(models)
            .where(inArray(models.providerChannelId, controlPlaneIds.providerChannel)),
        ]);
        controlPlaneIds.providerCredential.push(...credentialRows.map((row) => row.id));
        controlPlaneIds.providerRun.push(...runRows.map((row) => row.id));
        controlPlaneIds.model.push(...modelRows.map((row) => row.id));
      }
      if (controlPlaneIds.storageChannel.length > 0) {
        const [credentialRows, runRows] = await Promise.all([
          database
            .select({ id: storageCredentialVersions.id })
            .from(storageCredentialVersions)
            .where(
              inArray(storageCredentialVersions.storageChannelId, controlPlaneIds.storageChannel),
            ),
          database
            .select({ id: storageValidationRuns.id })
            .from(storageValidationRuns)
            .where(inArray(storageValidationRuns.storageChannelId, controlPlaneIds.storageChannel)),
        ]);
        controlPlaneIds.storageCredential.push(...credentialRows.map((row) => row.id));
        controlPlaneIds.storageRun.push(...runRows.map((row) => row.id));
      }
      if (controlPlaneIds.model.length > 0) {
        const [pocRows, catalogRows] = await Promise.all([
          database
            .select({ id: modelPocRuns.id })
            .from(modelPocRuns)
            .where(inArray(modelPocRuns.modelSnapshotId, controlPlaneIds.model)),
          database
            .select({ id: modelCatalogEntries.id })
            .from(modelCatalogEntries)
            .where(inArray(modelCatalogEntries.modelSnapshotId, controlPlaneIds.model)),
        ]);
        controlPlaneIds.modelRun.push(...pocRows.map((row) => row.id));
        controlPlaneIds.catalog.push(...catalogRows.map((row) => row.id));
      }
      const releaseRows = await database
        .select({ id: pricingCatalogReleases.id })
        .from(pricingCatalogReleases)
        .where(inArray(pricingCatalogReleases.createdByAdminId, principalIds));
      controlPlaneIds.pricingRelease.push(...releaseRows.map((row) => row.id));
      const campaignRows = await database
        .select({ id: inviteCampaigns.id })
        .from(inviteCampaigns)
        .where(inArray(inviteCampaigns.createdByAdminId, principalIds));
      controlPlaneIds.inviteCampaign.push(...campaignRows.map((row) => row.id));
      const rewardRows = await database
        .select({ id: rewardCampaigns.id })
        .from(rewardCampaigns)
        .where(inArray(rewardCampaigns.createdByAdminId, principalIds));
      controlPlaneIds.rewardCampaign.push(...rewardRows.map((row) => row.id));
    }
    if (controlPlaneIds.rewardCampaign.length > 0) {
      await database
        .delete(registrationRewardClaims)
        .where(inArray(registrationRewardClaims.rewardCampaignId, controlPlaneIds.rewardCampaign));
      await database
        .delete(rewardCampaigns)
        .where(inArray(rewardCampaigns.id, controlPlaneIds.rewardCampaign));
    }
    if (controlPlaneIds.inviteCampaign.length > 0) {
      const [batchRows, codeRows] = await Promise.all([
        database
          .select({ id: inviteCodeBatches.id })
          .from(inviteCodeBatches)
          .where(inArray(inviteCodeBatches.campaignId, controlPlaneIds.inviteCampaign)),
        database
          .select({ id: inviteCodes.id })
          .from(inviteCodes)
          .where(inArray(inviteCodes.campaignId, controlPlaneIds.inviteCampaign)),
      ]);
      controlPlaneIds.inviteBatch.push(...batchRows.map((row) => row.id));
      controlPlaneIds.inviteCode.push(...codeRows.map((row) => row.id));
    }
    if (controlPlaneIds.inviteCode.length > 0) {
      await database.delete(inviteCodes).where(inArray(inviteCodes.id, controlPlaneIds.inviteCode));
    }
    if (controlPlaneIds.inviteBatch.length > 0) {
      await database
        .delete(inviteCodeBatches)
        .where(inArray(inviteCodeBatches.id, controlPlaneIds.inviteBatch));
    }
    if (controlPlaneIds.inviteCampaign.length > 0) {
      await database
        .delete(inviteCampaigns)
        .where(inArray(inviteCampaigns.id, controlPlaneIds.inviteCampaign));
    }
    if (controlPlaneIds.pricingRelease.length > 0) {
      await database
        .delete(pricingCatalogState)
        .where(inArray(pricingCatalogState.activeReleaseId, controlPlaneIds.pricingRelease));
      await database
        .delete(pricingCatalogReleases)
        .where(inArray(pricingCatalogReleases.id, controlPlaneIds.pricingRelease));
    }
    if (controlPlaneIds.catalog.length > 0) {
      const skuRows = await database
        .select({ id: billableSkus.id })
        .from(billableSkus)
        .where(inArray(billableSkus.modelCatalogEntryId, controlPlaneIds.catalog));
      controlPlaneIds.sku.push(...skuRows.map((row) => row.id));
    }
    if (controlPlaneIds.sku.length > 0) {
      await database.delete(billableSkus).where(inArray(billableSkus.id, controlPlaneIds.sku));
    }
    if (controlPlaneIds.catalog.length > 0) {
      await database
        .delete(modelCatalogEntries)
        .where(inArray(modelCatalogEntries.id, controlPlaneIds.catalog));
    }
    if (controlPlaneIds.modelRun.length > 0) {
      await database.delete(modelPocRuns).where(inArray(modelPocRuns.id, controlPlaneIds.modelRun));
    }
    if (controlPlaneIds.model.length > 0) {
      await database
        .delete(modelConfigurations)
        .where(inArray(modelConfigurations.modelSnapshotId, controlPlaneIds.model));
      await database
        .update(moderationRuntimeStates)
        .set({ activeModelSnapshotId: null, runtimeRevision: 1, updatedByAdminId: null })
        .where(inArray(moderationRuntimeStates.activeModelSnapshotId, controlPlaneIds.model));
      await database.delete(models).where(inArray(models.id, controlPlaneIds.model));
    }
    if (controlPlaneIds.storageRun.length > 0) {
      await database
        .delete(storageValidationRuns)
        .where(inArray(storageValidationRuns.id, controlPlaneIds.storageRun));
    }
    if (controlPlaneIds.storageChannel.length > 0) {
      await database
        .delete(storageValidationRuns)
        .where(inArray(storageValidationRuns.storageChannelId, controlPlaneIds.storageChannel));
    }
    if (controlPlaneIds.storageCredential.length > 0) {
      await database
        .update(storageChannels)
        .set({ activeCredentialVersionId: null })
        .where(inArray(storageChannels.id, controlPlaneIds.storageChannel));
      await database
        .delete(storageCredentialVersions)
        .where(inArray(storageCredentialVersions.id, controlPlaneIds.storageCredential));
    }
    if (controlPlaneIds.storageChannel.length > 0) {
      await database
        .delete(storageRuntimeState)
        .where(eq(storageRuntimeState.purpose, 'private_assets'));
      await database
        .delete(storageChannels)
        .where(inArray(storageChannels.id, controlPlaneIds.storageChannel));
    }
    if (controlPlaneIds.providerRun.length > 0) {
      await database
        .delete(providerCredentialValidationRuns)
        .where(inArray(providerCredentialValidationRuns.id, controlPlaneIds.providerRun));
    }
    if (controlPlaneIds.providerChannel.length > 0) {
      await database
        .delete(providerCredentialValidationRuns)
        .where(
          inArray(
            providerCredentialValidationRuns.providerChannelId,
            controlPlaneIds.providerChannel,
          ),
        );
    }
    if (controlPlaneIds.providerCredential.length > 0) {
      await database
        .update(providerChannels)
        .set({ activeCredentialVersionId: null })
        .where(inArray(providerChannels.id, controlPlaneIds.providerChannel));
      await database
        .delete(providerCredentialVersions)
        .where(inArray(providerCredentialVersions.id, controlPlaneIds.providerCredential));
    }
    if (controlPlaneIds.providerChannel.length > 0) {
      await database
        .delete(providerChannels)
        .where(inArray(providerChannels.id, controlPlaneIds.providerChannel));
    }
    const aggregateIds = Object.values(controlPlaneIds).flat();
    if (aggregateIds.length > 0) {
      await database
        .delete(queueDispatchIntents)
        .where(inArray(queueDispatchIntents.aggregateId, aggregateIds));
    }
    if (principalIds.length === 0) {
      resetControlPlaneIds();
      return;
    }
    const sessionRows = await database
      .select({ id: adminSessions.id })
      .from(adminSessions)
      .where(inArray(adminSessions.adminPrincipalId, principalIds));
    const sessionIds = sessionRows.map((row) => row.id);
    const auditPredicates = [
      inArray(adminAuditLogs.actorAdminId, principalIds),
      inArray(adminAuditLogs.targetId, [...principalIds, ...sessionIds]),
      ...(sessionIds.length > 0 ? [inArray(adminAuditLogs.adminSessionId, sessionIds)] : []),
    ];
    await database.delete(adminAuditLogs).where(or(...auditPredicates));
    await database
      .delete(adminIdempotencyRecords)
      .where(inArray(adminIdempotencyRecords.actorAdminId, principalIds));
    await database
      .delete(adminMfaRecoveryCodes)
      .where(inArray(adminMfaRecoveryCodes.adminPrincipalId, principalIds));
    await database
      .delete(adminAuthChallenges)
      .where(inArray(adminAuthChallenges.adminPrincipalId, principalIds));
    await database
      .delete(adminEnrollmentTokens)
      .where(
        or(
          inArray(adminEnrollmentTokens.adminPrincipalId, principalIds),
          inArray(adminEnrollmentTokens.createdByAdminId, principalIds),
        ),
      );
    await database
      .delete(adminSessions)
      .where(inArray(adminSessions.adminPrincipalId, principalIds));
    await database
      .delete(adminCredentials)
      .where(inArray(adminCredentials.adminPrincipalId, principalIds));
    await database
      .delete(adminRoleBindings)
      .where(inArray(adminRoleBindings.adminPrincipalId, principalIds));
    await database.delete(adminPrincipals).where(inArray(adminPrincipals.id, principalIds));
    resetControlPlaneIds();
  }

  async function bootstrapPrimary(): Promise<{
    principalId: string;
    recoveryCodes: string[];
    totpSecret: string;
  }> {
    await avoidTotpBoundary();
    const totpSecret = createTotpSecret();
    const result = await auth.bootstrap({
      identifier: FIRST_IDENTIFIER,
      displayName: 'S14 Primary Admin',
      password: FIRST_PASSWORD,
      totpSecret,
      totpCode: totpCode(totpSecret, -1),
    });
    return { ...result, totpSecret };
  }

  async function loginPrimary(totpSecret: string): Promise<{
    agent: Agent;
    csrfToken: string;
  }> {
    const agent = request.agent(app.getHttpServer() as Server);
    const loginResponse = await post(agent, '/api/v1/admin/auth/login', {
      identifier: FIRST_IDENTIFIER,
      password: FIRST_PASSWORD,
    }).expect(200);
    const login = loginResponseSchema.parse(loginResponse.body);
    const verifiedResponse = await post(agent, '/api/v1/admin/auth/mfa/totp/verify', {
      challenge_id: login.challenge_id,
      challenge_token: login.challenge_token,
      code: totpCode(totpSecret),
    }).expect(200);
    return { agent, csrfToken: mfaResponseSchema.parse(verifiedResponse.body).csrf_token };
  }

  beforeAll(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;
    originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;
    originalRedisPrefix = process.env.REDIS_PREFIX;
    const s14TestDatabaseUrl = process.env.S14_TEST_DATABASE_URL;
    if (!s14TestDatabaseUrl || !/_test_s14(?:_|$)/.test(new URL(s14TestDatabaseUrl).pathname)) {
      throw new Error('S14 Admin integration tests require an isolated _test_s14 database');
    }
    process.env.DATABASE_URL = s14TestDatabaseUrl;
    process.env.TEST_DATABASE_URL = s14TestDatabaseUrl;
    process.env.REDIS_PREFIX = `s14-test-${process.pid}`;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    database = moduleRef.get<Database>(DATABASE);
    config = moduleRef.get<AppConfig>(APP_CONFIG);
    auth = moduleRef.get(AdminAuthService);
    await app.init();
    authTestRedis = createClient({ url: config.redisUrl });
    authTestRedis.on('error', () => undefined);
    await authTestRedis.connect();
    await resetAuthRateLimits();
    await cleanupFixture();
  });

  beforeEach(async () => {
    await resetAuthRateLimits();
    await cleanupFixture();
  });

  afterEach(async () => {
    if (recoveryRedis?.isOpen) {
      await recoveryRedis.del(queueRecoverySentinelKey(config.redisPrefix));
      await recoveryRedis.close();
    }
    recoveryRedis = undefined;
    await resetAuthRateLimits();
    await cleanupFixture();
  });

  afterAll(async () => {
    if (recoveryRedis?.isOpen) {
      await recoveryRedis.del(queueRecoverySentinelKey(config.redisPrefix));
      await recoveryRedis.close();
    }
    if (database) await cleanupFixture();
    if (app) await app.close();
    if (authTestRedis?.isOpen) await authTestRedis.close();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = originalTestDatabaseUrl;
    if (originalRedisPrefix === undefined) delete process.env.REDIS_PREFIX;
    else process.env.REDIS_PREFIX = originalRedisPrefix;
  });

  it('logs in with password and TOTP and creates an authenticated session', async () => {
    const fixture = await bootstrapPrimary();
    const { agent } = await loginPrimary(fixture.totpSecret);
    await agent
      .get('/api/v1/admin/auth/session')
      .set('Host', ADMIN_HOST)
      .expect(200)
      .expect(({ body }) =>
        expect(sessionResponseSchema.parse(body)).toMatchObject({
          principal: { id: fixture.principalId },
        }),
      );
  });

  it('keeps retired model administration routes unavailable', async () => {
    const server = app.getHttpServer() as Server;
    for (const retiredRoute of [
      '/api/v1/admin/providers',
      '/api/v1/admin/provider-channels',
      '/api/v1/admin/provider-credentials',
      '/api/v1/admin/models',
      '/api/v1/admin/model-poc-runs',
      '/api/v1/admin/model-catalog',
      '/api/v1/admin/billing-skus',
      '/api/v1/admin/pricing-releases',
      '/api/v1/admin/moderation-runtime',
    ]) {
      await request(server).get(retiredRoute).set('Host', ADMIN_HOST).expect(404);
    }
  });

  it('rejects an incorrect password without suppressing the failure audit', async () => {
    const fixture = await bootstrapPrimary();
    const agent = request.agent(app.getHttpServer() as Server);
    await post(agent, '/api/v1/admin/auth/login', {
      identifier: FIRST_IDENTIFIER,
      password: 'incorrect-password',
    }).expect(401);
    const audits = await database
      .select()
      .from(adminAuditLogs)
      .where(
        and(
          eq(adminAuditLogs.actorAdminId, fixture.principalId),
          eq(adminAuditLogs.action, 'admin.auth.password_check'),
        ),
      );
    expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({ result: 'failed' })]));
  });

  it('rejects an incorrect MFA code', async () => {
    const fixture = await bootstrapPrimary();
    const agent = request.agent(app.getHttpServer() as Server);
    const loginResponse = await post(agent, '/api/v1/admin/auth/login', {
      identifier: FIRST_IDENTIFIER,
      password: FIRST_PASSWORD,
    }).expect(200);
    const login = loginResponseSchema.parse(loginResponse.body);
    const correctCode = totpCode(fixture.totpSecret);
    const incorrectCode = String((Number(correctCode) + 1) % 1_000_000).padStart(6, '0');
    await post(agent, '/api/v1/admin/auth/mfa/totp/verify', {
      challenge_id: login.challenge_id,
      challenge_token: login.challenge_token,
      code: incorrectCode,
    }).expect(401);
  });

  it('rejects a consumed login challenge replay', async () => {
    const fixture = await bootstrapPrimary();
    const agent = request.agent(app.getHttpServer() as Server);
    const loginResponse = await post(agent, '/api/v1/admin/auth/login', {
      identifier: FIRST_IDENTIFIER,
      password: FIRST_PASSWORD,
    }).expect(200);
    const login = loginResponseSchema.parse(loginResponse.body);
    const body = {
      challenge_id: login.challenge_id,
      challenge_token: login.challenge_token,
      code: totpCode(fixture.totpSecret),
    };
    await post(agent, '/api/v1/admin/auth/mfa/totp/verify', body).expect(200);
    await post(agent, '/api/v1/admin/auth/mfa/totp/verify', body).expect(401);
  });

  it('rejects reuse of the same TOTP step across login challenges', async () => {
    const fixture = await bootstrapPrimary();
    const server = app.getHttpServer() as Server;
    const firstAgent = request.agent(server);
    const firstLoginResponse = await post(firstAgent, '/api/v1/admin/auth/login', {
      identifier: FIRST_IDENTIFIER,
      password: FIRST_PASSWORD,
    }).expect(200);
    const firstLogin = loginResponseSchema.parse(firstLoginResponse.body);
    const code = totpCode(fixture.totpSecret);
    await post(firstAgent, '/api/v1/admin/auth/mfa/totp/verify', {
      challenge_id: firstLogin.challenge_id,
      challenge_token: firstLogin.challenge_token,
      code,
    }).expect(200);

    const secondAgent = request.agent(server);
    const secondLoginResponse = await post(secondAgent, '/api/v1/admin/auth/login', {
      identifier: FIRST_IDENTIFIER,
      password: FIRST_PASSWORD,
    }).expect(200);
    const secondLogin = loginResponseSchema.parse(secondLoginResponse.body);
    await post(secondAgent, '/api/v1/admin/auth/mfa/totp/verify', {
      challenge_id: secondLogin.challenge_id,
      challenge_token: secondLogin.challenge_token,
      code,
    }).expect(401);
  });

  it('consumes a recovery code exactly once under concurrent verification', async () => {
    const fixture = await bootstrapPrimary();
    const server = app.getHttpServer() as Server;
    const candidates = await Promise.all(
      [request.agent(server), request.agent(server)].map(async (agent) => {
        const loginResponse = await post(agent, '/api/v1/admin/auth/login', {
          identifier: FIRST_IDENTIFIER,
          password: FIRST_PASSWORD,
        }).expect(200);
        return { agent, login: loginResponseSchema.parse(loginResponse.body) };
      }),
    );
    const responses = await Promise.all(
      candidates.map(({ agent, login }) =>
        post(agent, '/api/v1/admin/auth/mfa/recovery/verify', {
          challenge_id: login.challenge_id,
          challenge_token: login.challenge_token,
          recovery_code: fixture.recoveryCodes[0],
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
  });

  it('rejects missing and mismatched CSRF tokens on step-up', async () => {
    const fixture = await bootstrapPrimary();
    const { agent, csrfToken } = await loginPrimary(fixture.totpSecret);
    const body = { password: FIRST_PASSWORD, code: totpCode(fixture.totpSecret, 1) };
    await post(agent, '/api/v1/admin/auth/step-up', body).expect(403);
    await post(agent, '/api/v1/admin/auth/step-up', body)
      .set('X-Admin-CSRF', `${csrfToken}-invalid`)
      .expect(403);
    await post(agent, '/api/v1/admin/auth/step-up', body)
      .set('X-Admin-CSRF', csrfToken)
      .expect(201);
  });

  it('rejects a high-risk action after step-up expires', async () => {
    const fixture = await bootstrapPrimary();
    const { agent, csrfToken } = await loginPrimary(fixture.totpSecret);
    const stepUpResponse = await post(agent, '/api/v1/admin/auth/step-up', {
      password: FIRST_PASSWORD,
      code: totpCode(fixture.totpSecret, 1),
    })
      .set('X-Admin-CSRF', csrfToken)
      .expect(201);
    const steppedUpCsrf = mfaResponseSchema.parse(stepUpResponse.body).csrf_token;
    await database
      .update(adminSessions)
      .set({
        stepUpAt: new Date(Date.now() - (config.admin.stepUpTtlSeconds + 1) * 1_000),
      })
      .where(eq(adminSessions.adminPrincipalId, fixture.principalId));
    await put(agent, `/api/v1/admin/admin-principals/${fixture.principalId}/role-bindings`, {
      expected_revision: 1,
      roles: [{ role_key: 'operations' }],
      reason: 'Expired step-up must not authorize role changes',
    })
      .set('X-Admin-CSRF', steppedUpCsrf)
      .set('Idempotency-Key', `s14-expired-step-up-${randomUUID()}`)
      .expect(403)
      .expect(({ body }) =>
        expect(errorResponseSchema.parse(body).error.code).toBe('ADMIN_STEP_UP_REQUIRED'),
      );
  });

  it('rekeys an identifier only after successful MFA', async () => {
    await avoidTotpBoundary();
    const oldKey = Buffer.alloc(32, 41).toString('base64url');
    const newKey = Buffer.alloc(32, 42).toString('base64url');
    const legacyAuth = new AdminAuthService(
      database,
      {
        ...config,
        admin: { ...config.admin, identifierHashKeys: `admin-identifier-old:${oldKey}` },
      },
      authTestRedis,
    );
    const totpSecret = createTotpSecret();
    const bootstrap = await legacyAuth.bootstrap({
      identifier: FIRST_IDENTIFIER,
      displayName: 'S14 Primary Admin',
      password: FIRST_PASSWORD,
      totpSecret,
      totpCode: totpCode(totpSecret, -1),
    });
    const rotatedAuth = new AdminAuthService(
      database,
      {
        ...config,
        admin: {
          ...config.admin,
          identifierHashKeys: `admin-identifier-new:${newKey},admin-identifier-old:${oldKey}`,
        },
      },
      authTestRedis,
    );
    const requestFixture = {
      headers: { 'user-agent': 'S14-Rekey-Test/1.0' },
      socket: { remoteAddress: '127.0.0.1' },
    } as AdminRequest;
    const challenge = await rotatedAuth.login(FIRST_IDENTIFIER, FIRST_PASSWORD, requestFixture);
    const beforeMfa = await database.query.adminPrincipals.findFirst({
      where: eq(adminPrincipals.id, bootstrap.principalId),
    });
    expect(beforeMfa?.identifierKeyId).toBe('admin-identifier-old');
    await rotatedAuth.verifyLoginMfa(
      challenge.challengeId,
      challenge.challengeToken,
      totpCode(totpSecret),
      requestFixture,
    );
    const afterMfa = await database.query.adminPrincipals.findFirst({
      where: eq(adminPrincipals.id, bootstrap.principalId),
    });
    expect(afterMfa).toMatchObject({ identifierKeyId: 'admin-identifier-new', revision: 2 });
  });

  it('protects the last active super_admin from demotion', async () => {
    const fixture = await bootstrapPrimary();
    const { agent, csrfToken } = await loginPrimary(fixture.totpSecret);
    const stepUpResponse = await post(agent, '/api/v1/admin/auth/step-up', {
      password: FIRST_PASSWORD,
      code: totpCode(fixture.totpSecret, 1),
    })
      .set('X-Admin-CSRF', csrfToken)
      .expect(201);
    await put(agent, `/api/v1/admin/admin-principals/${fixture.principalId}/role-bindings`, {
      expected_revision: 1,
      roles: [{ role_key: 'operations' }],
      reason: 'Attempt to remove the final super administrator',
    })
      .set('X-Admin-CSRF', mfaResponseSchema.parse(stepUpResponse.body).csrf_token)
      .set('Idempotency-Key', `s14-last-super-admin-${randomUUID()}`)
      .expect(409);
  });

  it('returns 403 when the principal lacks the required permission', async () => {
    const fixture = await bootstrapPrimary();
    await database
      .update(adminRoleBindings)
      .set({
        roleKey: 'support',
        permissionSnapshotHash: permissionSnapshotHash([
          { roleKey: 'support', scopeKey: 'global' },
        ]),
      })
      .where(eq(adminRoleBindings.adminPrincipalId, fixture.principalId));
    const { agent } = await loginPrimary(fixture.totpSecret);
    await agent.get('/api/v1/admin/model-configurations').set('Host', ADMIN_HOST).expect(403);
  });

  it('runs the integrated S14A control-plane journey', async () => {
    await avoidTotpBoundary();
    const firstSecret = createTotpSecret();
    const bootstrap = await auth.bootstrap({
      identifier: FIRST_IDENTIFIER,
      displayName: 'S14 Primary Admin',
      password: FIRST_PASSWORD,
      totpSecret: firstSecret,
      totpCode: totpCode(firstSecret, -1),
    });
    expect(bootstrap.recoveryCodes).toHaveLength(10);

    const server = app.getHttpServer() as Server;
    await request(server).get('/api/v1/model-catalog?category=image').expect(403);
    await request(server)
      .post('/api/v1/admin/auth/login')
      .set('Host', 'localhost:3000')
      .set('Origin', ADMIN_ORIGIN)
      .send({ identifier: FIRST_IDENTIFIER, password: FIRST_PASSWORD })
      .expect(404);
    await request(server)
      .post('/api/v1/admin/auth/login')
      .set('Host', ADMIN_HOST)
      .set('Origin', 'http://localhost:3000')
      .send({ identifier: FIRST_IDENTIFIER, password: FIRST_PASSWORD })
      .expect(403);
    await request(server)
      .get('/api/v1/admin/admin-principals')
      .set('Host', ADMIN_HOST)
      .set('Cookie', 'better-auth.session_token=ordinary-user-cookie')
      .expect(401);

    const firstAgent = request.agent(server);
    await post(firstAgent, '/api/v1/admin/auth/login', {
      identifier: FIRST_IDENTIFIER,
      password: 'definitely-wrong-password',
    })
      .set('User-Agent', 'S14-Audit-Test/1.0')
      .expect(401);
    const loginResponse = await post(firstAgent, '/api/v1/admin/auth/login', {
      identifier: FIRST_IDENTIFIER,
      password: FIRST_PASSWORD,
    })
      .set('User-Agent', 'S14-Audit-Test/1.0')
      .expect(200);
    const login = loginResponseSchema.parse(loginResponse.body);
    const verifiedResponse = await post(firstAgent, '/api/v1/admin/auth/mfa/totp/verify', {
      challenge_id: login.challenge_id,
      challenge_token: login.challenge_token,
      code: totpCode(firstSecret),
    })
      .set('User-Agent', 'S14-Audit-Test/1.0')
      .expect(200);
    expect(verifiedResponse.headers['set-cookie']?.[0]).toContain('HttpOnly');
    expect(verifiedResponse.headers['set-cookie']?.[0]).toContain('SameSite=Strict');
    const verified = mfaResponseSchema.parse(verifiedResponse.body);
    let firstCsrf = verified.csrf_token;
    const sessionResponse = await firstAgent
      .get('/api/v1/admin/auth/session')
      .set('Host', ADMIN_HOST)
      .expect(200);
    const session = sessionResponseSchema.parse(sessionResponse.body);
    expect(session.principal.id).toBe(bootstrap.principalId);
    expect(session.permissions).toContain('admin_accounts.manage');
    const authAudits = await database
      .select()
      .from(adminAuditLogs)
      .where(
        and(
          eq(adminAuditLogs.actorAdminId, bootstrap.principalId),
          inArray(adminAuditLogs.action, ['admin.auth.password_check', 'admin.auth.login']),
        ),
      );
    expect(authAudits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'admin.auth.password_check', result: 'failed' }),
        expect.objectContaining({ action: 'admin.auth.password_check', result: 'succeeded' }),
        expect.objectContaining({
          action: 'admin.auth.login',
          result: 'succeeded',
          mfaLevel: 'totp',
        }),
      ]),
    );
    expect(authAudits.every((row) => Boolean(row.sourceIpHash && row.userAgentHash))).toBe(true);
    expect(JSON.stringify(authAudits)).not.toContain(FIRST_IDENTIFIER);
    expect(JSON.stringify(authAudits)).not.toContain('S14-Audit-Test/1.0');

    await request(server).get('/api/v1/admin/dashboard').set('Host', 'localhost:3000').expect(404);
    const dashboardResponse = await firstAgent
      .get('/api/v1/admin/dashboard')
      .set('Host', ADMIN_HOST)
      .expect('Cache-Control', 'no-store')
      .expect(200);
    adminDashboardResponseSchema.parse(dashboardResponse.body);
    const usersResponse = await firstAgent
      .get('/api/v1/admin/users?limit=1&risk_status=normal')
      .set('Host', ADMIN_HOST)
      .expect('Cache-Control', 'no-store')
      .expect(200);
    adminPageResponseSchema.parse(usersResponse.body);
    await firstAgent
      .get('/api/v1/admin/users?unknown_filter=1')
      .set('Host', ADMIN_HOST)
      .expect(400);
    await firstAgent
      .get('/api/v1/admin/users?cursor=not-a-signed-cursor')
      .set('Host', ADMIN_HOST)
      .expect(400)
      .expect(({ body }) =>
        expect(errorResponseSchema.parse(body).error.code).toBe('ADMIN_CURSOR_INVALID'),
      );
    await firstAgent.get(`/api/v1/admin/users/${randomUUID()}`).set('Host', ADMIN_HOST).expect(404);
    await firstAgent
      .get('/api/v1/admin/workflow-runs?limit=1&status=queued')
      .set('Host', ADMIN_HOST)
      .expect('Cache-Control', 'no-store')
      .expect(200)
      .expect(({ body }) => adminPageResponseSchema.parse(body));
    await firstAgent
      .get('/api/v1/admin/tasks?limit=1&status=queued')
      .set('Host', ADMIN_HOST)
      .expect('Cache-Control', 'no-store')
      .expect(200)
      .expect(({ body }) => adminPageResponseSchema.parse(body));
    const auditResponse = await firstAgent
      .get('/api/v1/admin/audit-logs?limit=1&action=admin.auth.login')
      .set('Host', ADMIN_HOST)
      .expect('Cache-Control', 'no-store')
      .expect(200);
    const auditPage = z
      .object({
        items: z
          .array(
            z.object({
              id: z.string().uuid(),
              actor_display_name: z.literal('S14 Primary Admin'),
              actor_identifier_hint: z.literal('s***@example.test'),
              source_ref: z.string().min(1),
              user_agent_ref: z.string().min(1),
              created_at: z.iso.datetime(),
            }),
          )
          .min(1),
      })
      .parse(auditResponse.body);
    const auditDetailResponse = await firstAgent
      .get(`/api/v1/admin/audit-logs/${auditPage.items[0]?.id}`)
      .set('Host', ADMIN_HOST)
      .expect('Cache-Control', 'no-store')
      .expect(200);
    const auditDetail = z.record(z.string(), z.unknown()).parse(auditDetailResponse.body);
    expect(JSON.stringify(auditDetail)).not.toContain(FIRST_IDENTIFIER);
    const healthResponse = await firstAgent
      .get('/api/v1/admin/health')
      .set('Host', ADMIN_HOST)
      .expect('Cache-Control', 'no-store')
      .expect(200);
    const health = adminHealthResponseSchema.parse(healthResponse.body);
    expect(JSON.stringify(health)).not.toContain(config.databaseUrl);
    expect(JSON.stringify(health)).not.toContain(config.redisUrl);

    await post(firstAgent, '/api/v1/admin/auth/step-up', {
      password: FIRST_PASSWORD,
      code: totpCode(firstSecret, 1),
    }).expect(403);
    const steppedUpResponse = await post(firstAgent, '/api/v1/admin/auth/step-up', {
      password: FIRST_PASSWORD,
      code: totpCode(firstSecret, 1),
    })
      .set('X-Admin-CSRF', firstCsrf)
      .expect(201);
    firstCsrf = mfaResponseSchema.parse(steppedUpResponse.body).csrf_token;

    const controlledUserId = randomUUID();
    await database.insert(users).values({
      id: controlledUserId,
      email: USER_CONTROL_EMAIL,
      displayName: 'S14 Controlled User',
    });
    await database.insert(authSessions).values([
      {
        id: `s14-session-a-${randomUUID()}`,
        userId: controlledUserId,
        token: `s14-token-a-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      },
      {
        id: `s14-session-b-${randomUUID()}`,
        userId: controlledUserId,
        token: `s14-token-b-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      },
    ]);
    const riskRequests = [
      {
        key: `s14-risk-freeze-a-${randomUUID()}`,
        reason: 'Concurrent risk freeze fixture A',
      },
      {
        key: `s14-risk-freeze-b-${randomUUID()}`,
        reason: 'Concurrent risk freeze fixture B',
      },
    ];
    const riskResponses = await Promise.all(
      riskRequests.map((riskRequest) =>
        post(firstAgent, `/api/v1/admin/users/${controlledUserId}/risk-status`, {
          expected_revision: 1,
          target_status: 'frozen',
          reason: riskRequest.reason,
        })
          .set('X-Admin-CSRF', firstCsrf)
          .set('Idempotency-Key', riskRequest.key),
      ),
    );
    expect(riskResponses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(riskResponses.filter((response) => response.status === 409)).toHaveLength(1);
    const winningRiskIndex = riskResponses.findIndex((response) => response.status === 200);
    const winningRiskRequest = riskRequests[winningRiskIndex];
    if (!winningRiskRequest) throw new Error('Concurrent risk update did not produce a winner');
    const winningRisk = z
      .object({
        user_id: z.string().uuid(),
        risk_status: z.literal('frozen'),
        revision: z.literal(2),
        revoked_session_count: z.literal(2),
      })
      .parse(riskResponses[winningRiskIndex]?.body);
    const riskReplay = await post(
      firstAgent,
      `/api/v1/admin/users/${controlledUserId}/risk-status`,
      {
        expected_revision: 1,
        target_status: 'frozen',
        reason: winningRiskRequest.reason,
      },
    )
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', winningRiskRequest.key)
      .expect(200);
    expect(riskReplay.body).toEqual(winningRisk);
    const remainingSessions = await database
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(eq(authSessions.userId, controlledUserId));
    expect(remainingSessions).toHaveLength(0);

    await database.insert(authSessions).values({
      id: `s14-session-revoke-${randomUUID()}`,
      userId: controlledUserId,
      token: `s14-token-revoke-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
    });
    const revokeKey = `s14-user-session-revoke-${randomUUID()}`;
    const revokeBody = { reason: 'Revoke compromised user sessions' };
    const revoked = await post(
      firstAgent,
      `/api/v1/admin/users/${controlledUserId}/sessions/revoke-all`,
      revokeBody,
    )
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', revokeKey)
      .expect(200);
    const revokedResult = z
      .object({ user_id: z.string().uuid(), revoked_session_count: z.literal(1) })
      .parse(revoked.body);
    const revokedReplay = await post(
      firstAgent,
      `/api/v1/admin/users/${controlledUserId}/sessions/revoke-all`,
      revokeBody,
    )
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', revokeKey)
      .expect(200);
    expect(revokedReplay.body).toEqual(revokedResult);

    const [controlledWorkflow] = await database
      .insert(workflowRuns)
      .values({
        userId: controlledUserId,
        triggerMode: 'chat',
        status: 'queued',
        planSnapshot: {},
        skillSnapshot: {},
        pricingSnapshot: {},
      })
      .returning();
    if (!controlledWorkflow) throw new Error('Failed to create Admin task-control workflow');
    const [controlledTask] = await database
      .insert(tasks)
      .values({
        workflowRunId: controlledWorkflow.id,
        type: 's14.local-dispatch-fixture',
        status: 'queued',
        costEstimate: '0.00',
        idempotencyKey: `s14-task-${randomUUID()}`,
        dagNodeId: 's14-local-dispatch',
        dagJson: {},
        paramsSnapshot: {},
      })
      .returning();
    if (!controlledTask) throw new Error('Failed to create Admin task-control task');
    const queueIntents = new QueueIntentRepository(database);
    const controlledIntent = await queueIntents.create({
      queueName: 'task',
      jobId: controlledTask.id,
      aggregateType: 'task',
      aggregateId: controlledTask.id,
      payloadVersion: 1,
      payload: {
        schema_version: 1,
        trace_id: randomUUID(),
        job_type: 'task.execute',
        task_id: controlledTask.id,
        workflow_run_id: controlledWorkflow.id,
        user_id: controlledUserId,
      },
    });
    recoveryRedis = createClient({ url: config.redisUrl });
    recoveryRedis.on('error', () => undefined);
    await recoveryRedis.connect();
    await recoveryRedis.set(queueRecoverySentinelKey(config.redisPrefix), 'ready');

    const recoveryRequests = [
      {
        key: `s14-local-recovery-a-${randomUUID()}`,
        reason: 'Concurrent local dispatch recovery A',
      },
      {
        key: `s14-local-recovery-b-${randomUUID()}`,
        reason: 'Concurrent local dispatch recovery B',
      },
    ];
    const recoveryResponses = await Promise.all(
      recoveryRequests.map((recoveryRequest) =>
        post(firstAgent, `/api/v1/admin/tasks/${controlledTask.id}/recover-local-dispatch`, {
          queue_dispatch_intent_id: controlledIntent.id,
          expected_intent_revision: controlledIntent.revision,
          reason: recoveryRequest.reason,
        })
          .set('X-Admin-CSRF', firstCsrf)
          .set('Idempotency-Key', recoveryRequest.key),
      ),
    );
    expect(recoveryResponses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(recoveryResponses.filter((response) => response.status === 409)).toHaveLength(1);
    const winningRecoveryIndex = recoveryResponses.findIndex((response) => response.status === 200);
    const winningRecoveryRequest = recoveryRequests[winningRecoveryIndex];
    if (!winningRecoveryRequest) {
      throw new Error('Concurrent local dispatch recovery did not produce a winner');
    }
    const winningRecovery = z
      .object({
        task_id: z.string().uuid(),
        queue_dispatch_intent_id: z.string().uuid(),
        status: z.literal('pending'),
        revision: z.literal(2),
        job_ref: z.string().min(32),
      })
      .parse(recoveryResponses[winningRecoveryIndex]?.body);
    const persistedIntents = await database
      .select()
      .from(queueDispatchIntents)
      .where(
        and(
          eq(queueDispatchIntents.aggregateType, 'task'),
          eq(queueDispatchIntents.aggregateId, controlledTask.id),
        ),
      );
    expect(persistedIntents).toHaveLength(1);
    expect(persistedIntents[0]).toMatchObject({
      id: controlledIntent.id,
      jobId: controlledIntent.jobId,
      status: 'pending',
      revision: 2,
    });
    const recoveryReplay = await post(
      firstAgent,
      `/api/v1/admin/tasks/${controlledTask.id}/recover-local-dispatch`,
      {
        queue_dispatch_intent_id: controlledIntent.id,
        expected_intent_revision: controlledIntent.revision,
        reason: winningRecoveryRequest.reason,
      },
    )
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', winningRecoveryRequest.key)
      .expect(200);
    expect(recoveryReplay.body).toEqual(winningRecovery);

    const [moderationTask] = await database
      .insert(tasks)
      .values({
        workflowRunId: controlledWorkflow.id,
        type: 'moderation.image',
        status: 'queued',
        costEstimate: '0.00',
        idempotencyKey: `s14-moderation-task-${randomUUID()}`,
        dagNodeId: 's14-moderation-local-dispatch',
        dagJson: {},
        paramsSnapshot: {},
      })
      .returning();
    if (!moderationTask) throw new Error('Failed to create Admin moderation task fixture');
    const moderationIntent = await queueIntents.create({
      queueName: 'moderation',
      jobId: moderationTask.id,
      aggregateType: 'task',
      aggregateId: moderationTask.id,
      payloadVersion: 4,
      payload: {
        schema_version: 4,
        trace_id: randomUUID(),
        job_type: 'moderation.execute',
        task_id: moderationTask.id,
        workflow_run_id: controlledWorkflow.id,
        user_id: controlledUserId,
      },
    });
    await post(firstAgent, `/api/v1/admin/tasks/${moderationTask.id}/recover-local-dispatch`, {
      queue_dispatch_intent_id: moderationIntent.id,
      expected_intent_revision: moderationIntent.revision,
      reason: 'Recover a moderation job on its dedicated queue',
    })
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-moderation-recovery-${randomUUID()}`)
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          task_id: moderationTask.id,
          queue_dispatch_intent_id: moderationIntent.id,
          status: 'pending',
          revision: 2,
        }),
      );

    const [protectedTask] = await database
      .insert(tasks)
      .values({
        workflowRunId: controlledWorkflow.id,
        type: 's14.protected-provider-fixture',
        status: 'running',
        costEstimate: '1.00',
        idempotencyKey: `s14-protected-task-${randomUUID()}`,
        dagNodeId: 's14-protected-provider',
        dagJson: {},
        paramsSnapshot: {},
      })
      .returning();
    if (!protectedTask) throw new Error('Failed to create protected Admin task fixture');
    await database.insert(taskAttempts).values({
      taskId: protectedTask.id,
      attemptNo: 1,
      status: 'accepted',
      dispatchState: 'accepted',
      provider: 'fake',
      providerRequestId: `s14-provider-request-${randomUUID()}`,
      acceptedAt: new Date(),
    });
    const protectedIntent = await queueIntents.create({
      queueName: 'task',
      jobId: protectedTask.id,
      aggregateType: 'task',
      aggregateId: protectedTask.id,
      payloadVersion: 1,
      payload: {
        schema_version: 1,
        trace_id: randomUUID(),
        job_type: 'task.execute',
        task_id: protectedTask.id,
        workflow_run_id: controlledWorkflow.id,
        user_id: controlledUserId,
      },
    });
    await post(firstAgent, `/api/v1/admin/tasks/${protectedTask.id}/recover-local-dispatch`, {
      queue_dispatch_intent_id: protectedIntent.id,
      expected_intent_revision: protectedIntent.revision,
      reason: 'Provider accepted work must never be resubmitted',
    })
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-protected-recovery-${randomUUID()}`)
      .expect(409)
      .expect(({ body }) =>
        expect(errorResponseSchema.parse(body).error.code).toBe('ADMIN_QUEUE_RECOVERY_NOT_ALLOWED'),
      );

    const createFundedWorkflow = async (suffix: string, status: 'queued' | 'running') => {
      const [quote] = await database
        .insert(runQuotes)
        .values({
          userId: controlledUserId,
          source: 'chat',
          status: 'submitted',
          promptPreview: {},
          itemsSnapshot: [],
          estimatedCallCount: 1,
          estimatedTotalCredits: '1.00',
          idempotencyKey: `s14-cancel-quote-${suffix}`,
          inputSignature: `s14-cancel-input-${suffix}`,
          confirmationSnapshot: {},
          planSnapshot: {},
          skillSnapshot: {},
          pricingSnapshot: {},
          expiresAt: new Date(Date.now() + 10 * 60 * 1_000),
        })
        .returning();
      const [reservation] = await database
        .insert(creditReservations)
        .values({
          userId: controlledUserId,
          estimatedAmount: '1.00',
          status: 'frozen',
          idempotencyKey: `s14-cancel-reservation-${suffix}`,
        })
        .returning();
      if (!quote || !reservation) throw new Error('Failed to create cancellation quote fixture');
      const [workflow] = await database
        .insert(workflowRuns)
        .values({
          userId: controlledUserId,
          triggerMode: 'chat',
          runQuoteId: quote.id,
          reservationId: reservation.id,
          status,
          revision: 2,
          planSnapshot: {},
          skillSnapshot: {},
          pricingSnapshot: {},
        })
        .returning();
      if (!workflow) throw new Error('Failed to create cancellation workflow fixture');
      await database
        .update(runQuotes)
        .set({ workflowRunId: workflow.id })
        .where(eq(runQuotes.id, quote.id));
      await database
        .update(creditReservations)
        .set({ workflowRunId: workflow.id })
        .where(eq(creditReservations.id, reservation.id));
      const [task] = await database
        .insert(tasks)
        .values({
          workflowRunId: workflow.id,
          type: 's14.workflow-cancel-fixture',
          status,
          costEstimate: '1.00',
          idempotencyKey: `s14-cancel-task-${suffix}`,
          dagNodeId: `s14-cancel-${suffix}`,
          dagJson: {},
          paramsSnapshot: {},
        })
        .returning();
      if (!task) throw new Error('Failed to create cancellation task fixture');
      const intent = await queueIntents.create({
        queueName: 'task',
        jobId: task.id,
        aggregateType: 'task',
        aggregateId: task.id,
        payloadVersion: 1,
        payload: {
          schema_version: 1,
          trace_id: randomUUID(),
          job_type: 'task.execute',
          task_id: task.id,
          workflow_run_id: workflow.id,
          user_id: controlledUserId,
        },
      });
      return { quote, reservation, workflow, task, intent };
    };

    await database.insert(creditAccounts).values({
      userId: controlledUserId,
      balance: '9.00',
      frozen: '1.00',
      version: 2,
    });
    const cancellation = await createFundedWorkflow(randomUUID(), 'queued');
    await database.insert(creditLedger).values([
      {
        userId: controlledUserId,
        type: 'grant',
        amount: '10.00',
        idempotencyKey: `s14-cancel-grant-${controlledUserId}`,
        accountVersion: 1,
        balanceAfter: '10.00',
        frozenAfter: '0.00',
        metadata: { test_run_id: controlledUserId },
      },
      {
        userId: controlledUserId,
        type: 'reservation_freeze',
        amount: '-1.00',
        reservationId: cancellation.reservation.id,
        workflowRunId: cancellation.workflow.id,
        idempotencyKey: `s14-cancel-freeze-${cancellation.reservation.id}`,
        accountVersion: 2,
        balanceAfter: '9.00',
        frozenAfter: '1.00',
        metadata: { test_run_id: controlledUserId },
      },
    ]);
    const cancelRequests = [
      { key: `s14-workflow-cancel-a-${randomUUID()}`, reason: 'Concurrent safe cancel A' },
      { key: `s14-workflow-cancel-b-${randomUUID()}`, reason: 'Concurrent safe cancel B' },
    ];
    const cancelResponses = await Promise.all(
      cancelRequests.map((cancelRequest) =>
        post(firstAgent, `/api/v1/admin/workflow-runs/${cancellation.workflow.id}/cancel`, {
          expected_run_revision: cancellation.workflow.revision,
          reason: cancelRequest.reason,
        })
          .set('X-Admin-CSRF', firstCsrf)
          .set('Idempotency-Key', cancelRequest.key),
      ),
    );
    expect(cancelResponses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(cancelResponses.filter((response) => response.status === 409)).toHaveLength(1);
    const winningCancelIndex = cancelResponses.findIndex((response) => response.status === 200);
    const winningCancelRequest = cancelRequests[winningCancelIndex];
    if (!winningCancelRequest)
      throw new Error('Concurrent workflow cancel did not produce a winner');
    const winningCancel = z
      .object({
        workflow_run_id: z.string().uuid(),
        status: z.literal('cancelled'),
        revision: z.literal(3),
        cancelled_task_count: z.literal(1),
        released_amount: z.literal('1.00'),
        release_ledger_id: z.string().uuid(),
      })
      .parse(cancelResponses[winningCancelIndex]?.body);
    const [
      cancelledAccount,
      cancelledReservation,
      cancelledWorkflow,
      cancelledTask,
      cancelledIntent,
    ] = await Promise.all([
      database.query.creditAccounts.findFirst({
        where: eq(creditAccounts.userId, controlledUserId),
      }),
      database.query.creditReservations.findFirst({
        where: eq(creditReservations.id, cancellation.reservation.id),
      }),
      database.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, cancellation.workflow.id),
      }),
      database.query.tasks.findFirst({ where: eq(tasks.id, cancellation.task.id) }),
      database.query.queueDispatchIntents.findFirst({
        where: eq(queueDispatchIntents.id, cancellation.intent.id),
      }),
    ]);
    expect(cancelledAccount).toMatchObject({ balance: '10.00', frozen: '0.00', version: 3 });
    expect(cancelledReservation).toMatchObject({
      status: 'released',
      releasedAmount: '1.00',
    });
    expect(cancelledWorkflow).toMatchObject({ status: 'cancelled', revision: 3 });
    expect(cancelledTask).toMatchObject({ status: 'cancelled' });
    expect(cancelledIntent).toMatchObject({ status: 'cancelled', revision: 2 });
    const cancelReplay = await post(
      firstAgent,
      `/api/v1/admin/workflow-runs/${cancellation.workflow.id}/cancel`,
      {
        expected_run_revision: cancellation.workflow.revision,
        reason: winningCancelRequest.reason,
      },
    )
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', winningCancelRequest.key)
      .expect(200);
    expect(cancelReplay.body).toEqual(winningCancel);

    const protectedCancellation = await createFundedWorkflow(randomUUID(), 'running');
    await database.insert(creditLedger).values({
      userId: controlledUserId,
      type: 'reservation_freeze',
      amount: '-1.00',
      reservationId: protectedCancellation.reservation.id,
      workflowRunId: protectedCancellation.workflow.id,
      idempotencyKey: `s14-cancel-freeze-${protectedCancellation.reservation.id}`,
      accountVersion: 4,
      balanceAfter: '9.00',
      frozenAfter: '1.00',
      metadata: { test_run_id: controlledUserId },
    });
    await database
      .update(creditAccounts)
      .set({ balance: '9.00', frozen: '1.00', version: 4 })
      .where(eq(creditAccounts.userId, controlledUserId));
    await database.insert(taskAttempts).values({
      taskId: protectedCancellation.task.id,
      attemptNo: 1,
      status: 'accepted',
      dispatchState: 'accepted',
      provider: 'fake',
      providerRequestId: `s14-cancel-accepted-${randomUUID()}`,
      acceptedAt: new Date(),
    });
    await post(
      firstAgent,
      `/api/v1/admin/workflow-runs/${protectedCancellation.workflow.id}/cancel`,
      {
        expected_run_revision: protectedCancellation.workflow.revision,
        reason: 'Accepted Provider work must keep its reservation frozen',
      },
    )
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-protected-cancel-${randomUUID()}`)
      .expect(409)
      .expect(({ body }) =>
        expect(errorResponseSchema.parse(body).error.code).toBe(
          'ADMIN_WORKFLOW_CANCEL_NOT_ALLOWED',
        ),
      );
    const protectedAccount = await database.query.creditAccounts.findFirst({
      where: eq(creditAccounts.userId, controlledUserId),
    });
    const protectedReleases = await database
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.reservationId, protectedCancellation.reservation.id),
          eq(creditLedger.type, 'release'),
        ),
      );
    expect(protectedAccount).toMatchObject({ balance: '9.00', frozen: '1.00', version: 4 });
    expect(protectedReleases).toHaveLength(0);

    const [consumeLedger] = await database
      .insert(creditLedger)
      .values({
        userId: controlledUserId,
        type: 'consume',
        amount: '-1.00',
        reservationId: protectedCancellation.reservation.id,
        workflowRunId: protectedCancellation.workflow.id,
        taskId: protectedCancellation.task.id,
        idempotencyKey: `s14-appeal-consume-${protectedCancellation.task.id}`,
        accountVersion: 5,
        balanceAfter: '9.00',
        frozenAfter: '0.00',
        metadata: { test_run_id: controlledUserId },
      })
      .returning();
    if (!consumeLedger) throw new Error('Failed to create appeal consume fixture');
    await database
      .update(creditAccounts)
      .set({ balance: '9.00', frozen: '0.00', version: 5 })
      .where(eq(creditAccounts.userId, controlledUserId));
    const [appeal] = await database
      .insert(appeals)
      .values({
        ledgerId: consumeLedger.id,
        userId: controlledUserId,
        reason: 'Provider result did not match the confirmed request',
        screenshots: [randomUUID()],
      })
      .returning();
    if (!appeal) throw new Error('Failed to create Admin appeal fixture');

    const appealPageResponse = await firstAgent
      .get('/api/v1/admin/appeals?status=pending&limit=20')
      .set('Host', ADMIN_HOST)
      .expect('Cache-Control', 'no-store')
      .expect(200);
    const appealPage = adminPageResponseSchema.parse(appealPageResponse.body);
    expect(appealPage.items.some((item) => item.id === appeal.id)).toBe(true);
    await firstAgent
      .get(`/api/v1/admin/appeals/${appeal.id}`)
      .set('Host', ADMIN_HOST)
      .expect('Cache-Control', 'no-store')
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          id: appeal.id,
          status: 'pending',
          revision: 1,
          original_ledger: { id: consumeLedger.id, type: 'consume', amount: '-1.00' },
        }),
      );

    const appealDecisions = [
      {
        key: `s14-appeal-refund-a-${randomUUID()}`,
        reason: 'Concurrent appeal refund decision A',
      },
      {
        key: `s14-appeal-refund-b-${randomUUID()}`,
        reason: 'Concurrent appeal refund decision B',
      },
    ];
    const appealResponses = await Promise.all(
      appealDecisions.map((decision) =>
        post(firstAgent, `/api/v1/admin/appeals/${appeal.id}/decide`, {
          expected_revision: 1,
          decision: 'refund',
          refund_amount: '1.00',
          reason: decision.reason,
        })
          .set('X-Admin-CSRF', firstCsrf)
          .set('Idempotency-Key', decision.key),
      ),
    );
    expect(appealResponses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(appealResponses.filter((response) => response.status === 409)).toHaveLength(1);
    const winningAppealIndex = appealResponses.findIndex((response) => response.status === 200);
    const winningAppealDecision = appealDecisions[winningAppealIndex];
    if (!winningAppealDecision) throw new Error('Concurrent appeal decision had no winner');
    const winningAppeal = z
      .object({
        appeal_id: z.literal(appeal.id),
        status: z.literal('refunded'),
        revision: z.literal(2),
        refund_amount: z.literal('1.00'),
        decision_ledger_id: z.string().uuid(),
        balance_after: z.literal('10.00'),
      })
      .parse(appealResponses[winningAppealIndex]?.body);
    const [decidedAppeal, refundedAccount, refundLedgers, appealAudits] = await Promise.all([
      database.query.appeals.findFirst({ where: eq(appeals.id, appeal.id) }),
      database.query.creditAccounts.findFirst({
        where: eq(creditAccounts.userId, controlledUserId),
      }),
      database
        .select()
        .from(creditLedger)
        .where(and(eq(creditLedger.appealId, appeal.id), eq(creditLedger.type, 'appeal_refund'))),
      database
        .select()
        .from(adminAuditLogs)
        .where(
          and(
            eq(adminAuditLogs.targetType, 'appeal'),
            eq(adminAuditLogs.targetId, appeal.id),
            eq(adminAuditLogs.action, 'admin.appeal.decided'),
            eq(adminAuditLogs.result, 'succeeded'),
          ),
        ),
    ]);
    expect(decidedAppeal).toMatchObject({
      status: 'refunded',
      revision: 2,
      refundAmount: '1.00',
      reviewerId: null,
      reviewerAdminId: bootstrap.principalId,
      decisionLedgerId: winningAppeal.decision_ledger_id,
    });
    expect(refundedAccount).toMatchObject({ balance: '10.00', frozen: '0.00', version: 6 });
    expect(refundLedgers).toHaveLength(1);
    expect(appealAudits).toHaveLength(1);
    const replayedAppeal = await post(firstAgent, `/api/v1/admin/appeals/${appeal.id}/decide`, {
      expected_revision: 1,
      decision: 'refund',
      refund_amount: '1.00',
      reason: winningAppealDecision.reason,
    })
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', winningAppealDecision.key)
      .expect(200);
    expect(replayedAppeal.body).toEqual(winningAppeal);

    const positiveCorrectionKey = `s14-credit-correction-positive-${randomUUID()}`;
    const positiveCorrectionBody = {
      user_id: controlledUserId,
      amount: '2.00',
      reason: 'Restore credits after verified support review',
    };
    const positiveCorrection = await post(
      firstAgent,
      '/api/v1/admin/credits/corrections',
      positiveCorrectionBody,
    )
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', positiveCorrectionKey)
      .expect(201);
    expect(positiveCorrection.body).toMatchObject({
      amount: '2.00',
      balance_after: '12.00',
      account_version: 7,
    });
    const positiveReplay = await post(
      firstAgent,
      '/api/v1/admin/credits/corrections',
      positiveCorrectionBody,
    )
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', positiveCorrectionKey)
      .expect(201);
    expect(positiveReplay.body).toEqual(positiveCorrection.body);
    await post(firstAgent, '/api/v1/admin/credits/corrections', {
      ...positiveCorrectionBody,
      amount: '3.00',
    })
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', positiveCorrectionKey)
      .expect(409)
      .expect(({ body }) =>
        expect(errorResponseSchema.parse(body).error.code).toBe('ADMIN_IDEMPOTENCY_CONFLICT'),
      );

    await post(firstAgent, '/api/v1/admin/credits/corrections', {
      user_id: controlledUserId,
      amount: '-1.00',
      reason: 'Reverse an incorrectly granted support credit',
    })
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-credit-correction-negative-${randomUUID()}`)
      .expect(201)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          amount: '-1.00',
          balance_after: '11.00',
          account_version: 8,
        }),
      );

    const concurrentCorrectionKey = `s14-credit-correction-concurrent-${randomUUID()}`;
    const concurrentCorrectionBody = {
      user_id: controlledUserId,
      amount: '0.50',
      reason: 'Apply one concurrent support adjustment',
    };
    const concurrentCorrections = await Promise.all(
      ['A', 'B'].map(() =>
        post(firstAgent, '/api/v1/admin/credits/corrections', concurrentCorrectionBody)
          .set('X-Admin-CSRF', firstCsrf)
          .set('Idempotency-Key', concurrentCorrectionKey),
      ),
    );
    expect(concurrentCorrections.every((response) => response.status === 201)).toBe(true);
    expect(concurrentCorrections[0]?.body).toEqual(concurrentCorrections[1]?.body);
    expect(concurrentCorrections[0]?.body).toMatchObject({
      amount: '0.50',
      balance_after: '11.50',
      account_version: 9,
    });
    const [correctedAccount, correctionLedgers, correctionAudits] = await Promise.all([
      database.query.creditAccounts.findFirst({
        where: eq(creditAccounts.userId, controlledUserId),
      }),
      database
        .select()
        .from(creditLedger)
        .where(
          and(
            eq(creditLedger.userId, controlledUserId),
            eq(creditLedger.type, 'manual_correction'),
          ),
        ),
      database
        .select()
        .from(adminAuditLogs)
        .where(
          and(
            eq(adminAuditLogs.action, 'admin.credit.corrected'),
            eq(adminAuditLogs.targetId, controlledUserId),
            eq(adminAuditLogs.result, 'succeeded'),
          ),
        ),
    ]);
    expect(correctedAccount).toMatchObject({ balance: '11.50', frozen: '0.00', version: 9 });
    expect(correctionLedgers).toHaveLength(3);
    expect(correctionLedgers.map((ledger) => ledger.amount).sort()).toEqual([
      '-1.00',
      '0.50',
      '2.00',
    ]);
    expect(correctionAudits).toHaveLength(3);
    expect(JSON.stringify(correctionLedgers)).not.toContain(positiveCorrectionBody.reason);

    const rewardSettingKey = `s14-registration-reward-${randomUUID()}`;
    const rewardSettingBody = { enabled: true, credits: '3.00' };
    await firstAgent
      .put('/api/v1/admin/registration-reward')
      .set('Host', ADMIN_HOST)
      .set('Origin', ADMIN_ORIGIN)
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-registration-reward-fraction-${randomUUID()}`)
      .send({ enabled: true, credits: '3.50' })
      .expect(400)
      .expect(({ body }) =>
        expect(body).toMatchObject({ error: { code: 'ADMIN_REQUEST_INVALID' } }),
      );
    await firstAgent
      .put('/api/v1/admin/registration-reward')
      .set('Host', ADMIN_HOST)
      .set('Origin', ADMIN_ORIGIN)
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-registration-reward-overflow-${randomUUID()}`)
      .send({ enabled: true, credits: '1000000000.00' })
      .expect(400)
      .expect(({ body }) =>
        expect(body).toMatchObject({ error: { code: 'ADMIN_REQUEST_INVALID' } }),
      );
    const concurrentRewardUpdates = await Promise.all(
      ['A', 'B'].map(() =>
        firstAgent
          .put('/api/v1/admin/registration-reward')
          .set('Host', ADMIN_HOST)
          .set('Origin', ADMIN_ORIGIN)
          .set('X-Admin-CSRF', firstCsrf)
          .set('Idempotency-Key', rewardSettingKey)
          .send(rewardSettingBody),
      ),
    );
    expect(concurrentRewardUpdates.every((response) => response.status === 200)).toBe(true);
    expect(concurrentRewardUpdates[0]?.body).toEqual(concurrentRewardUpdates[1]?.body);
    expect(concurrentRewardUpdates[0]?.body).toMatchObject({
      enabled: true,
      credits: '3.00',
    });
    await firstAgent
      .get('/api/v1/admin/registration-reward')
      .set('Host', ADMIN_HOST)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ enabled: true, credits: '3.00' }));
    const activeRegistrationRewards = await database
      .select()
      .from(rewardCampaigns)
      .where(
        and(
          eq(rewardCampaigns.campaignKey, 'registration-default'),
          eq(rewardCampaigns.status, 'active'),
        ),
      );
    expect(activeRegistrationRewards).toHaveLength(1);

    await firstAgent
      .put('/api/v1/admin/registration-reward')
      .set('Host', ADMIN_HOST)
      .set('Origin', ADMIN_ORIGIN)
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-registration-reward-disable-${randomUUID()}`)
      .send({ enabled: false, credits: '3.00' })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ enabled: false, credits: '3.00' }));
    await post(firstAgent, '/api/v1/admin/reward-campaigns', {}).expect(404);

    const inviteKey = `s14-invite-generate-${randomUUID()}`;
    const inviteRequest = {
      count: 3,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    };
    const generatedResponse = await post(firstAgent, '/api/v1/admin/invites', inviteRequest)
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', inviteKey)
      .expect(201);
    const generated = z
      .object({
        count: z.literal(3),
        plaintext_available: z.literal(true),
        codes: z.array(
          z.object({
            id: z.string().uuid(),
            prefix: z.string().min(1),
            plaintext_code: z.string().min(16),
          }),
        ),
      })
      .parse(generatedResponse.body);
    expect(generated.codes).toHaveLength(3);
    controlPlaneIds.inviteCode.push(...generated.codes.map((code) => code.id));

    const persistedInvites = await database
      .select()
      .from(inviteCodes)
      .where(
        inArray(
          inviteCodes.id,
          generated.codes.map((code) => code.id),
        ),
      );
    expect(persistedInvites).toHaveLength(3);
    expect(
      persistedInvites.every(
        (invite) =>
          invite.campaignId === null &&
          invite.batchId === null &&
          typeof invite.codeCiphertext === 'string' &&
          typeof invite.codeNonce === 'string' &&
          typeof invite.codeAuthTag === 'string' &&
          typeof invite.codeEncryptionKeyId === 'string',
      ),
    ).toBe(true);
    for (const code of generated.codes) {
      expect(JSON.stringify(persistedInvites)).not.toContain(code.plaintext_code);
    }

    const inviteReplay = await post(firstAgent, '/api/v1/admin/invites', inviteRequest)
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', inviteKey)
      .expect(201);
    expect(inviteReplay.body).toMatchObject({ count: 3, plaintext_available: false });
    expect(JSON.stringify(inviteReplay.body)).not.toContain('plaintext_code');
    for (const code of generated.codes) {
      expect(JSON.stringify(inviteReplay.body)).not.toContain(code.plaintext_code);
    }

    const [generationAudit] = await database
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.action, 'invite_code.generated'));
    expect(generationAudit).toBeDefined();
    for (const code of generated.codes) {
      expect(JSON.stringify(generationAudit)).not.toContain(code.plaintext_code);
    }

    await firstAgent
      .get('/api/v1/admin/invites?limit=100')
      .set('Host', ADMIN_HOST)
      .expect(200)
      .expect(({ body }) => {
        expect(JSON.stringify(body)).not.toContain('plaintext_code');
        const page = z
          .object({
            items: z.array(
              z.object({ id: z.string().uuid(), can_copy: z.boolean() }).passthrough(),
            ),
          })
          .parse(body);
        expect(page.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: generated.codes[0]!.id, can_copy: true }),
          ]),
        );
      });
    const revealResponse = await post(
      firstAgent,
      `/api/v1/admin/invites/${generated.codes[0]!.id}/reveal`,
      {},
    )
      .set('X-Admin-CSRF', firstCsrf)
      .expect(200);
    expect(revealResponse.body).toEqual({
      id: generated.codes[0]!.id,
      prefix: generated.codes[0]!.prefix,
      plaintext_code: generated.codes[0]!.plaintext_code,
    });
    expect(revealResponse.headers['cache-control']).toContain('no-store');
    const [revealAudit] = await database
      .select()
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.action, 'invite_code.revealed'));
    expect(revealAudit).toBeDefined();
    expect(JSON.stringify(revealAudit)).not.toContain(generated.codes[0]!.plaintext_code);

    const firstPersisted = persistedInvites.find((row) => row.id === generated.codes[0]!.id)!;
    const secondPersisted = persistedInvites.find((row) => row.id === generated.codes[1]!.id)!;
    await database
      .update(inviteCodes)
      .set({
        codeCiphertext: secondPersisted.codeCiphertext,
        codeNonce: secondPersisted.codeNonce,
        codeAuthTag: secondPersisted.codeAuthTag,
        codeEncryptionKeyId: secondPersisted.codeEncryptionKeyId,
      })
      .where(eq(inviteCodes.id, generated.codes[0]!.id));
    await post(firstAgent, `/api/v1/admin/invites/${generated.codes[0]!.id}/reveal`, {})
      .set('X-Admin-CSRF', firstCsrf)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ error: { code: 'INVITE_PLAINTEXT_UNAVAILABLE' } }),
      );
    await database
      .update(inviteCodes)
      .set({
        codeCiphertext: firstPersisted.codeCiphertext,
        codeNonce: firstPersisted.codeNonce,
        codeAuthTag: firstPersisted.codeAuthTag,
        codeEncryptionKeyId: firstPersisted.codeEncryptionKeyId,
      })
      .where(eq(inviteCodes.id, generated.codes[0]!.id));

    await database
      .update(inviteCodes)
      .set({
        codeCiphertext: null,
        codeNonce: null,
        codeAuthTag: null,
        codeEncryptionKeyId: null,
      })
      .where(eq(inviteCodes.id, generated.codes[2]!.id));
    await post(firstAgent, `/api/v1/admin/invites/${generated.codes[2]!.id}/reveal`, {})
      .set('X-Admin-CSRF', firstCsrf)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ error: { code: 'INVITE_PLAINTEXT_UNAVAILABLE' } }),
      );
    await firstAgent
      .get('/api/v1/admin/invites?limit=100')
      .set('Host', ADMIN_HOST)
      .expect(200)
      .expect(({ body }) => {
        const page = z
          .object({
            items: z.array(
              z.object({ id: z.string().uuid(), can_copy: z.boolean() }).passthrough(),
            ),
          })
          .parse(body);
        expect(page.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: generated.codes[2]!.id, can_copy: false }),
          ]),
        );
      });

    await post(firstAgent, `/api/v1/admin/invites/${generated.codes[0]!.id}/disable`, {})
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-invite-disable-${randomUUID()}`)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ disabled_count: 1 }));

    await database
      .update(inviteCodes)
      .set({ usedCount: 1 })
      .where(eq(inviteCodes.id, generated.codes[1]!.id));
    await post(firstAgent, '/api/v1/admin/invites/disable-batch', {
      invite_ids: [generated.codes[1]!.id, generated.codes[2]!.id],
    })
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-invite-disable-batch-${randomUUID()}`)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ error: { code: 'INVITE_DISABLE_INVALID' } }),
      );
    expect(
      await database.query.inviteCodes.findFirst({
        where: eq(inviteCodes.id, generated.codes[2]!.id),
      }),
    ).toMatchObject({ disabledAt: null });

    await post(firstAgent, '/api/v1/admin/invites/disable-batch', {
      invite_ids: [generated.codes[2]!.id],
    })
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-invite-disable-batch-${randomUUID()}`)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ disabled_count: 1 }));

    await firstAgent
      .get('/api/v1/admin/invites?limit=100')
      .set('Host', ADMIN_HOST)
      .expect(200)
      .expect(({ body }) => {
        const { items } = z
          .object({ items: z.array(z.object({ id: z.string(), status: z.string() })) })
          .parse(body);
        expect(items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: generated.codes[0]!.id, status: 'disabled' }),
            expect.objectContaining({ id: generated.codes[1]!.id, status: 'used' }),
            expect.objectContaining({ id: generated.codes[2]!.id, status: 'disabled' }),
          ]),
        );
      });

    await post(firstAgent, '/api/v1/admin/invite-campaigns', {}).expect(404);
    await post(firstAgent, `/api/v1/admin/invites/${generated.codes[0]!.id}/reveal`, {})
      .set('X-Admin-CSRF', firstCsrf)
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({ error: { code: 'INVITE_PLAINTEXT_UNAVAILABLE' } }),
      );
    await post(firstAgent, `/api/v1/admin/invites/${generated.codes[0]!.id}/adjust`, {}).expect(
      404,
    );

    const storageChannelResponse = await post(firstAgent, '/api/v1/admin/storage-channels', {
      purpose: 'private_assets',
      adapter_key: 'local-private-v1',
      endpoint_profile_key: 'local',
      region: 'local',
      bucket: `s14-e2e-${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      root_prefix: 'private-assets',
      reason: 'Create isolated storage channel',
    })
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-storage-channel-${randomUUID()}`)
      .expect(201);
    const storageChannel = idResponseSchema.parse(storageChannelResponse.body);
    controlPlaneIds.storageChannel.push(storageChannel.id);
    await firstAgent
      .get(
        '/api/v1/admin/storage-channels?adapter_key=local-private-v1&bucket=s14-e2e&status=draft',
      )
      .set('Host', ADMIN_HOST)
      .expect(200)
      .expect(({ body }) => {
        const page = adminPageResponseSchema.parse(body);
        expect(page.items).toEqual([
          expect.objectContaining({ id: storageChannel.id, adapter_key: 'local-private-v1' }),
        ]);
      });
    const storageCredentialResponse = await post(
      firstAgent,
      `/api/v1/admin/storage-channels/${storageChannel.id}/credentials`,
      { secret: { token: 's14-e2e-storage-secret' }, reason: 'Create storage secret bundle' },
    )
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-storage-credential-${randomUUID()}`)
      .expect(201);
    const storageCredential = credentialResponseSchema.parse(storageCredentialResponse.body);
    controlPlaneIds.storageCredential.push(storageCredential.id);
    const storageValidationResponse = await post(
      firstAgent,
      `/api/v1/admin/storage-credentials/${storageCredential.id}/validate`,
      { reason: 'Run fixed private storage probe' },
    )
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-storage-validation-${randomUUID()}`)
      .expect(202);
    const storageValidation = validationResponseSchema.parse(storageValidationResponse.body);
    controlPlaneIds.storageRun.push(storageValidation.validation_run_id);
    await firstAgent
      .get(`/api/v1/admin/storage-validation-runs/${storageValidation.validation_run_id}`)
      .set('Host', ADMIN_HOST)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'queued', attempt_no: 1 }));
    await post(firstAgent, `/api/v1/admin/storage-credentials/${storageCredential.id}/validate`, {
      reason: 'Reject a concurrent storage credential probe',
    })
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-storage-validation-concurrent-${randomUUID()}`)
      .expect(409)
      .expect(({ body }) =>
        expect(errorResponseSchema.parse(body).error.code).toBe('ADMIN_VALIDATION_ALREADY_RUNNING'),
      );
    const storageUnknownEvidence = 'd'.repeat(64);
    await database
      .update(storageValidationRuns)
      .set({
        status: 'outcome_unknown',
        evidenceDigest: storageUnknownEvidence,
        revision: 2,
        completedAt: new Date(),
      })
      .where(eq(storageValidationRuns.id, storageValidation.validation_run_id));
    await database
      .update(storageCredentialVersions)
      .set({
        status: 'validation_unknown',
        validationEvidenceDigest: storageUnknownEvidence,
        revision: 2,
      })
      .where(eq(storageCredentialVersions.id, storageCredential.id));
    const storageRetryResponse = await post(
      firstAgent,
      `/api/v1/admin/storage-credentials/${storageCredential.id}/validate`,
      { reason: 'Explicitly retry the unknown storage credential probe' },
    )
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-storage-validation-retry-${randomUUID()}`)
      .expect(202);
    const storagePassedValidation = validationResponseSchema.parse(storageRetryResponse.body);
    controlPlaneIds.storageRun.push(storagePassedValidation.validation_run_id);
    await firstAgent
      .get(`/api/v1/admin/storage-validation-runs/${storagePassedValidation.validation_run_id}`)
      .set('Host', ADMIN_HOST)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ status: 'queued', attempt_no: 2 }));
    const storageEvidence = 'c'.repeat(64);
    await database
      .update(storageValidationRuns)
      .set({
        status: 'passed',
        evidenceDigest: storageEvidence,
        resultSummaryJson: {
          code: 'STORAGE_LOCAL_PROBE_PASSED',
          smoke_contract_version: 's10-private-assets@1',
        },
        revision: 2,
        completedAt: new Date(),
      })
      .where(eq(storageValidationRuns.id, storagePassedValidation.validation_run_id));
    await database
      .update(storageCredentialVersions)
      .set({
        status: 'valid',
        validationEvidenceDigest: storageEvidence,
        revision: 4,
        verifiedAt: new Date(),
      })
      .where(eq(storageCredentialVersions.id, storageCredential.id));
    const activatedCredentialResponse = await post(
      firstAgent,
      `/api/v1/admin/storage-credentials/${storageCredential.id}/activate`,
      {
        expected_credential_revision: 4,
        expected_channel_revision: 1,
        validation_run_id: storagePassedValidation.validation_run_id,
        evidence_digest: storageEvidence,
        reason: 'Activate only the credential with passed fixed probe evidence',
      },
    )
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-storage-credential-activate-${randomUUID()}`)
      .expect(200);
    expect(activatedCredentialResponse.body).toMatchObject({
      status: 'active',
      revision: 5,
      channel_revision: 2,
    });
    await database
      .update(storageValidationRuns)
      .set({ resultSummaryJson: null })
      .where(eq(storageValidationRuns.id, storagePassedValidation.validation_run_id));
    await post(firstAgent, `/api/v1/admin/storage-channels/${storageChannel.id}/activate`, {
      expected_runtime_revision: 0,
      expected_channel_revision: 2,
      validation_run_id: storagePassedValidation.validation_run_id,
      evidence_digest: storageEvidence,
      reason: 'Reject registry capability declarations without S10 smoke evidence',
    })
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-storage-channel-missing-smoke-${randomUUID()}`)
      .expect(409);
    await database
      .update(storageValidationRuns)
      .set({
        resultSummaryJson: {
          code: 'STORAGE_LOCAL_PROBE_PASSED',
          smoke_contract_version: 's10-private-assets@1',
        },
      })
      .where(eq(storageValidationRuns.id, storagePassedValidation.validation_run_id));
    const activatedChannelResponse = await post(
      firstAgent,
      `/api/v1/admin/storage-channels/${storageChannel.id}/activate`,
      {
        expected_runtime_revision: 0,
        expected_channel_revision: 2,
        validation_run_id: storagePassedValidation.validation_run_id,
        evidence_digest: storageEvidence,
        reason: 'Atomically activate the validated private storage runtime',
      },
    )
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', `s14-storage-channel-activate-${randomUUID()}`)
      .expect(200);
    expect(activatedChannelResponse.body).toMatchObject({
      status: 'active',
      revision: 3,
      runtime_revision: 1,
      runtime_active: true,
    });
    await firstAgent
      .get(`/api/v1/admin/storage-channels/${storageChannel.id}`)
      .set('Host', ADMIN_HOST)
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          runtime: { is_active: true, runtime_revision: 1 },
          active_credential_version_id: storageCredential.id,
        }),
      );
    const storageControlRace = await Promise.all([
      post(firstAgent, `/api/v1/admin/storage-channels/${storageChannel.id}/disable`, {
        expected_channel_revision: 3,
        expected_runtime_revision: 1,
        reason: 'Compete with active storage credential revocation',
      })
        .set('X-Admin-CSRF', firstCsrf)
        .set('Idempotency-Key', `s14-storage-channel-disable-race-${randomUUID()}`),
      post(firstAgent, `/api/v1/admin/storage-credentials/${storageCredential.id}/revoke`, {
        expected_credential_revision: 5,
        expected_channel_revision: 3,
        expected_runtime_revision: 1,
        reason: 'Compete with active storage channel disable',
      })
        .set('X-Admin-CSRF', firstCsrf)
        .set('Idempotency-Key', `s14-storage-credential-revoke-race-${randomUUID()}`),
    ]);
    expect(storageControlRace.filter((response) => response.status === 200)).toHaveLength(1);
    expect(storageControlRace.filter((response) => response.status === 409)).toHaveLength(1);
    expect(
      await database.query.storageRuntimeState.findFirst({
        where: eq(storageRuntimeState.purpose, 'private_assets'),
      }),
    ).toMatchObject({ activeChannelId: null, runtimeRevision: 2 });

    const createKey = `s14-create-admin-${randomUUID()}`;
    const createBody = {
      identifier: SECOND_IDENTIFIER,
      display_name: 'S14 Secondary Admin',
      role_key: 'super_admin',
      reason: 'S14 integration fixture enrollment',
    };
    const createdResponse = await post(firstAgent, '/api/v1/admin/admin-principals', createBody)
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', createKey)
      .expect(201);
    const created = createPrincipalResponseSchema.parse(createdResponse.body);
    expect(created.enrollment_token).toEqual(expect.any(String));
    const enrollmentToken = created.enrollment_token;
    if (!enrollmentToken) throw new Error('Initial principal response omitted enrollment token');
    const replayResponse = await post(firstAgent, '/api/v1/admin/admin-principals', createBody)
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', createKey)
      .expect(201);
    const replay = createPrincipalResponseSchema.parse(replayResponse.body);
    expect(replay.principal_id).toBe(created.principal_id);
    expect(replay.enrollment_token).toBeUndefined();
    const conflictResponse = await post(firstAgent, '/api/v1/admin/admin-principals', {
      ...createBody,
      display_name: 'Conflicting replay',
    })
      .set('X-Admin-CSRF', firstCsrf)
      .set('Idempotency-Key', createKey)
      .expect(409);
    expect(errorResponseSchema.parse(conflictResponse.body).error.code).toBe(
      'ADMIN_IDEMPOTENCY_CONFLICT',
    );

    const secondAgent = request.agent(server);
    const enrollmentResponse = await post(secondAgent, '/api/v1/admin/enrollment/start', {
      enrollment_token: enrollmentToken,
      new_password: SECOND_PASSWORD,
    }).expect(201);
    const enrollment = enrollmentResponseSchema.parse(enrollmentResponse.body);
    const activatedResponse = await post(secondAgent, '/api/v1/admin/enrollment/activate', {
      challenge_id: enrollment.challenge_id,
      challenge_token: enrollment.challenge_token,
      code: totpCode(enrollment.totp_secret),
    }).expect(201);
    const activated = activationResponseSchema.parse(activatedResponse.body);
    expect(activated.recovery_codes).toHaveLength(10);
    let secondCsrf = activated.csrf_token;
    const secondStepUpResponse = await post(secondAgent, '/api/v1/admin/auth/step-up', {
      password: SECOND_PASSWORD,
      code: totpCode(enrollment.totp_secret, 1),
    })
      .set('X-Admin-CSRF', secondCsrf)
      .expect(201);
    secondCsrf = mfaResponseSchema.parse(secondStepUpResponse.body).csrf_token;

    const recoveryAgent = request.agent(server);
    const recoveryLoginResponse = await post(recoveryAgent, '/api/v1/admin/auth/login', {
      identifier: FIRST_IDENTIFIER,
      password: FIRST_PASSWORD,
    }).expect(200);
    const recoveryLogin = loginResponseSchema.parse(recoveryLoginResponse.body);
    const recoveryResponse = await post(recoveryAgent, '/api/v1/admin/auth/mfa/recovery/verify', {
      challenge_id: recoveryLogin.challenge_id,
      challenge_token: recoveryLogin.challenge_token,
      recovery_code: bootstrap.recoveryCodes[0],
    }).expect(200);
    expect(mfaResponseSchema.parse(recoveryResponse.body).recovery_restricted).toBe(true);
    await recoveryAgent.get('/api/v1/admin/admin-principals').set('Host', ADMIN_HOST).expect(403);
    const replayRecoveryAgent = request.agent(server);
    const replayRecoveryLoginResponse = await post(
      replayRecoveryAgent,
      '/api/v1/admin/auth/login',
      {
        identifier: FIRST_IDENTIFIER,
        password: FIRST_PASSWORD,
      },
    ).expect(200);
    const replayRecoveryLogin = loginResponseSchema.parse(replayRecoveryLoginResponse.body);
    await post(replayRecoveryAgent, '/api/v1/admin/auth/mfa/recovery/verify', {
      challenge_id: replayRecoveryLogin.challenge_id,
      challenge_token: replayRecoveryLogin.challenge_token,
      recovery_code: bootstrap.recoveryCodes[0],
    }).expect(401);

    const firstRevision = 1;
    const secondRevision = 2;
    const demotions = await Promise.all([
      put(firstAgent, `/api/v1/admin/admin-principals/${created.principal_id}/role-bindings`, {
        expected_revision: secondRevision,
        roles: [{ role_key: 'operations' }],
        reason: 'Concurrent demotion fixture A',
      })
        .set('X-Admin-CSRF', firstCsrf)
        .set('Idempotency-Key', `s14-demote-secondary-${randomUUID()}`),
      put(secondAgent, `/api/v1/admin/admin-principals/${bootstrap.principalId}/role-bindings`, {
        expected_revision: firstRevision,
        roles: [{ role_key: 'operations' }],
        reason: 'Concurrent demotion fixture B',
      })
        .set('X-Admin-CSRF', secondCsrf)
        .set('Idempotency-Key', `s14-demote-primary-${randomUUID()}`),
    ]);
    expect(demotions.filter((response) => response.status === 200)).toHaveLength(1);
    expect(demotions.filter((response) => response.status !== 200)).toHaveLength(1);

    const activeSuperAdmins = await database
      .select({ id: adminPrincipals.id })
      .from(adminPrincipals)
      .innerJoin(adminRoleBindings, eq(adminRoleBindings.adminPrincipalId, adminPrincipals.id))
      .where(
        and(
          inArray(adminPrincipals.id, [bootstrap.principalId, created.principal_id]),
          eq(adminPrincipals.status, 'active'),
          eq(adminRoleBindings.roleKey, 'super_admin'),
        ),
      );
    expect(activeSuperAdmins).toHaveLength(1);
  }, 60_000);
});
