import { stdin } from 'node:process';

import {
  adminAuditLogs,
  adminAuthChallenges,
  adminCredentials,
  adminIdempotencyRecords,
  adminMfaRecoveryCodes,
  adminPrincipals,
  adminRoleBindings,
  adminSessions,
  and,
  authAccounts,
  authSessions,
  billableSkus,
  createDatabaseClient,
  eq,
  inArray,
  inviteCodeBatches,
  inviteCodes,
  inviteCampaigns,
  modelConfigurations,
  modelCatalogEntries,
  modelPocRuns,
  models,
  pricingCatalogReleases,
  pricingCatalogState,
  providerChannels,
  providerCredentialValidationRuns,
  providerCredentialVersions,
  queueDispatchIntents,
  storageChannels,
  storageCredentialVersions,
  storageRuntimeState,
  storageValidationRuns,
  users,
  workerHeartbeats,
} from '@ecom-forge/db';
import * as OTPAuth from 'otpauth';

import { loadAppConfig } from '../src/config/app-config.js';
import { AdminAuthService } from '../src/modules/admin-auth/admin-auth.service.js';
import { createBetterAuth } from '../src/modules/auth/better-auth.factory.js';
import { HmacKeyring } from '../src/modules/auth/security/hmac-keyring.js';

const IDENTIFIER = 's14-live-admin@example.test';
const LOCAL_IDENTIFIER = 'local-admin@ecom-forge.test';
const USER_EMAIL = 's14-live-catalog-user@example.test';
const USER_PASSWORD = 'S14-live-catalog-user-password-123!';

function totpCode(secret: string, timestamp: number): string {
  return new OTPAuth.TOTP({
    issuer: 'Ecom Forge Admin',
    label: IDENTIFIER,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).generate({ timestamp });
}

function cookieHeader(headers: Headers): string {
  const values =
    (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
  const cookie = values.map((value) => value.split(';', 1)[0]).join('; ');
  if (!cookie) throw new Error('S14 live fixture did not receive a user session cookie');
  return cookie;
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) {
    if (typeof chunk !== 'string') throw new Error('Expected UTF-8 fixture input');
    chunks.push(chunk);
  }
  return chunks.join('');
}

function assertEnvironment(databaseUrl: string): void {
  if (process.env.S14_LIVE_E2E !== '1') {
    throw new Error('This fixture is restricted to the S14 live E2E harness');
  }
  const url = new URL(databaseUrl);
  if (!['127.0.0.1', '::1', 'localhost'].includes(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error('S14 live E2E requires a loopback database');
  }
  if (!/_test_s14(?:_|$)/.test(url.pathname.replace(/^\//, '').toLowerCase())) {
    throw new Error('S14 live E2E database name must contain _test_s14');
  }
}

async function fixturePrincipalId(
  database: ReturnType<typeof createDatabaseClient>['db'],
  config: ReturnType<typeof loadAppConfig>,
  identifier: string,
): Promise<string | undefined> {
  const keyring = new HmacKeyring(config.admin.identifierHashKeys);
  for (const candidate of keyring.candidates(identifier)) {
    const row = await database.query.adminPrincipals.findFirst({
      where: and(
        eq(adminPrincipals.identifierKeyId, candidate.keyId),
        eq(adminPrincipals.identifierHash, candidate.digest),
      ),
    });
    if (row) return row.id;
  }
  return undefined;
}

async function cleanup(
  database: ReturnType<typeof createDatabaseClient>['db'],
  config: ReturnType<typeof loadAppConfig>,
  workerId?: string,
): Promise<void> {
  if (workerId) await database.delete(workerHeartbeats).where(eq(workerHeartbeats.id, workerId));
  const user = await database.query.users.findFirst({ where: eq(users.email, USER_EMAIL) });
  if (user) {
    await database.delete(authSessions).where(eq(authSessions.userId, user.id));
    await database.delete(authAccounts).where(eq(authAccounts.userId, user.id));
    await database.delete(users).where(eq(users.id, user.id));
  }
  for (const identifier of [IDENTIFIER, LOCAL_IDENTIFIER]) {
    await cleanupPrincipal(database, config, identifier);
  }
}

async function cleanupPrincipal(
  database: ReturnType<typeof createDatabaseClient>['db'],
  config: ReturnType<typeof loadAppConfig>,
  identifier: string,
): Promise<void> {
  const principalId = await fixturePrincipalId(database, config, identifier);
  if (!principalId) return;

  const [providerRows, storageRows, releaseRows, campaignRows] = await Promise.all([
    database
      .select({ id: providerChannels.id })
      .from(providerChannels)
      .where(eq(providerChannels.createdByAdminId, principalId)),
    database
      .select({ id: storageChannels.id })
      .from(storageChannels)
      .where(eq(storageChannels.createdByAdminId, principalId)),
    database
      .select({ id: pricingCatalogReleases.id })
      .from(pricingCatalogReleases)
      .where(eq(pricingCatalogReleases.createdByAdminId, principalId)),
    database
      .select({ id: inviteCampaigns.id })
      .from(inviteCampaigns)
      .where(eq(inviteCampaigns.createdByAdminId, principalId)),
  ]);
  const providerIds = providerRows.map((row) => row.id);
  const storageIds = storageRows.map((row) => row.id);
  const releaseIds = releaseRows.map((row) => row.id);
  const campaignIds = campaignRows.map((row) => row.id);

  const modelRows =
    providerIds.length > 0
      ? await database
          .select({ id: models.id })
          .from(models)
          .where(inArray(models.providerChannelId, providerIds))
      : [];
  const modelIds = modelRows.map((row) => row.id);
  const catalogRows =
    modelIds.length > 0
      ? await database
          .select({ id: modelCatalogEntries.id })
          .from(modelCatalogEntries)
          .where(inArray(modelCatalogEntries.modelSnapshotId, modelIds))
      : [];
  const catalogIds = catalogRows.map((row) => row.id);
  const aggregateIds = [...providerIds, ...storageIds, ...modelIds, ...catalogIds, ...releaseIds];

  if (releaseIds.length > 0) {
    await database
      .update(pricingCatalogState)
      .set({ activeReleaseId: null })
      .where(inArray(pricingCatalogState.activeReleaseId, releaseIds));
    await database
      .update(pricingCatalogReleases)
      .set({ baseReleaseId: null })
      .where(inArray(pricingCatalogReleases.id, releaseIds));
    await database
      .delete(pricingCatalogReleases)
      .where(inArray(pricingCatalogReleases.id, releaseIds));
  }
  if (catalogIds.length > 0) {
    await database
      .delete(billableSkus)
      .where(inArray(billableSkus.modelCatalogEntryId, catalogIds));
    await database.delete(modelCatalogEntries).where(inArray(modelCatalogEntries.id, catalogIds));
  }
  if (modelIds.length > 0) {
    await database
      .delete(modelConfigurations)
      .where(inArray(modelConfigurations.modelSnapshotId, modelIds));
    await database.delete(modelPocRuns).where(inArray(modelPocRuns.modelSnapshotId, modelIds));
    await database.delete(models).where(inArray(models.id, modelIds));
  }
  if (providerIds.length > 0) {
    await database
      .update(providerChannels)
      .set({ activeCredentialVersionId: null })
      .where(inArray(providerChannels.id, providerIds));
    await database
      .delete(providerCredentialValidationRuns)
      .where(inArray(providerCredentialValidationRuns.providerChannelId, providerIds));
    await database
      .delete(providerCredentialVersions)
      .where(inArray(providerCredentialVersions.providerChannelId, providerIds));
    await database.delete(providerChannels).where(inArray(providerChannels.id, providerIds));
  }
  if (storageIds.length > 0) {
    await database
      .update(storageRuntimeState)
      .set({ activeChannelId: null })
      .where(inArray(storageRuntimeState.activeChannelId, storageIds));
    await database
      .update(storageChannels)
      .set({ activeCredentialVersionId: null })
      .where(inArray(storageChannels.id, storageIds));
    await database
      .delete(storageValidationRuns)
      .where(inArray(storageValidationRuns.storageChannelId, storageIds));
    await database
      .delete(storageCredentialVersions)
      .where(inArray(storageCredentialVersions.storageChannelId, storageIds));
    await database.delete(storageChannels).where(inArray(storageChannels.id, storageIds));
  }
  if (campaignIds.length > 0) {
    const batchRows = await database
      .select({ id: inviteCodeBatches.id })
      .from(inviteCodeBatches)
      .where(inArray(inviteCodeBatches.campaignId, campaignIds));
    await database.delete(inviteCodes).where(inArray(inviteCodes.campaignId, campaignIds));
    if (batchRows.length > 0) {
      await database.delete(inviteCodeBatches).where(
        inArray(
          inviteCodeBatches.id,
          batchRows.map((row) => row.id),
        ),
      );
    }
    await database.delete(inviteCampaigns).where(inArray(inviteCampaigns.id, campaignIds));
  }
  if (aggregateIds.length > 0) {
    await database
      .delete(queueDispatchIntents)
      .where(inArray(queueDispatchIntents.aggregateId, aggregateIds));
  }

  await database.delete(adminAuditLogs).where(eq(adminAuditLogs.actorAdminId, principalId));
  await database
    .delete(adminIdempotencyRecords)
    .where(eq(adminIdempotencyRecords.actorAdminId, principalId));
  await database
    .delete(adminMfaRecoveryCodes)
    .where(eq(adminMfaRecoveryCodes.adminPrincipalId, principalId));
  await database
    .delete(adminAuthChallenges)
    .where(eq(adminAuthChallenges.adminPrincipalId, principalId));
  await database.delete(adminSessions).where(eq(adminSessions.adminPrincipalId, principalId));
  await database.delete(adminCredentials).where(eq(adminCredentials.adminPrincipalId, principalId));
  await database
    .delete(adminRoleBindings)
    .where(eq(adminRoleBindings.adminPrincipalId, principalId));
  await database.delete(adminPrincipals).where(eq(adminPrincipals.id, principalId));
}

async function run(): Promise<void> {
  const action = process.argv[2];
  if (!action || !['setup', 'cleanup'].includes(action) || process.argv.length > 3) {
    throw new Error('Expected exactly one action: setup or cleanup');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  assertEnvironment(databaseUrl);
  const input = JSON.parse((await readStdin()) || '{}') as {
    password?: unknown;
    totpSecret?: unknown;
    workerId?: unknown;
  };
  const config = loadAppConfig();
  const resource = createDatabaseClient({ databaseUrl });
  try {
    if (action === 'cleanup') {
      await cleanup(
        resource.db,
        config,
        typeof input.workerId === 'string' ? input.workerId : undefined,
      );
      process.stdout.write(`${JSON.stringify({ status: 'cleaned' })}\n`);
      return;
    }
    if (typeof input.password !== 'string' || typeof input.totpSecret !== 'string') {
      throw new Error('setup requires password and totpSecret');
    }
    await cleanup(resource.db, config);
    const auth = new AdminAuthService(resource.db, config);
    const bootstrapTimestamp = Date.now();
    const result = await auth.bootstrap({
      identifier: IDENTIFIER,
      displayName: 'S14 Live Admin',
      password: input.password,
      totpSecret: input.totpSecret,
      totpCode: totpCode(input.totpSecret, bootstrapTimestamp),
    });
    const userAuth = createBetterAuth(resource.db, config);
    await userAuth.api.signUpEmail({
      body: { email: USER_EMAIL, password: USER_PASSWORD, name: 'S14 Live Catalog User' },
      returnHeaders: true,
    });
    await resource.db
      .update(users)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.email, USER_EMAIL));
    const userLogin = await userAuth.api.signInEmail({
      body: { email: USER_EMAIL, password: USER_PASSWORD },
      returnHeaders: true,
    });
    process.stdout.write(
      `${JSON.stringify({
        identifier: IDENTIFIER,
        principal_id: result.principalId,
        recovery_code: result.recoveryCodes[0],
        totp_step: Math.floor(bootstrapTimestamp / 30_000),
        user_cookie: cookieHeader(userLogin.headers),
      })}\n`,
    );
  } finally {
    await resource.client.end();
  }
}

await run();
