import { randomUUID } from 'node:crypto';

import {
  adminAuditLogs,
  adminIdempotencyRecords,
  adminPrincipals,
  adminSessions,
  billableSkus,
  createDatabaseClient,
  eq,
  inArray,
  modelCatalogEntries,
  modelConfigurations,
  modelPocRuns,
  models,
  moderationRuntimeStates,
  pricingCatalogReleases,
  pricingCatalogState,
  providerChannels,
  providerCircuitStates,
  providerCredentialValidationRuns,
  providerCredentialVersions,
  storageChannels,
  storageCredentialVersions,
  storageRuntimeState,
  storageValidationRuns,
  type Database,
} from '@ecom-forge/db';
import type {
  discoverRelayModels,
  ImagePocInput,
  ImagePocResult,
  RelayModelDiscoveryResult,
} from '@ecom-forge/provider';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAppConfig, type AppConfig } from '../src/config/app-config.js';
import type { AdminRequest, AdminSessionContext } from '../src/modules/admin-auth/admin-http.js';
import { AdminModelConfigurationService } from '../src/modules/admin-auth/admin-model-configuration.service.js';
import { ModelCatalogService } from '../src/modules/model-catalog/model-catalog.service.js';

const ALL_PERMISSIONS = [
  'models.read',
  'models.write',
  'models.publish',
  'provider_keys.rotate',
  'pricing.write',
] as const;

const request = {
  headers: { 'x-request-id': 's14-model-configuration-e2e' },
  socket: { remoteAddress: '127.0.0.1' },
} as unknown as AdminRequest;

type ImageProbe = (input: ImagePocInput) => Promise<ImagePocResult>;

describe('S14 unified model configuration', () => {
  let client: ReturnType<typeof createDatabaseClient>['client'];
  let database: Database;
  let config: AppConfig;
  let context: AdminSessionContext;
  let service: AdminModelConfigurationService;
  let discovery: ReturnType<typeof vi.fn<typeof discoverRelayModels>>;
  let imageProbe: ReturnType<typeof vi.fn<ImageProbe>>;
  let principalId: string;

  beforeAll(() => {
    const databaseUrl = process.env.S14_TEST_DATABASE_URL;
    if (!databaseUrl || !/_test_s14(?:_|$)/.test(new URL(databaseUrl).pathname)) {
      throw new Error('S14 model configuration tests require an isolated _test_s14 database');
    }
    ({ client, db: database } = createDatabaseClient({
      databaseUrl,
      applicationName: 's14-model-configuration-test',
    }));
    config = loadAppConfig({ ...process.env, DATABASE_URL: databaseUrl, APP_ENV: 'test' });
  });

  beforeEach(async () => {
    principalId = randomUUID();
    const sessionId = randomUUID();
    const now = new Date();
    await database.insert(adminPrincipals).values({
      id: principalId,
      identifierHash: `s14-model-config-${principalId}`,
      identifierKeyId: 'admin-identifier-v1',
      identifierHint: 's***@test',
      displayName: 'S14 Model Configuration Test',
      status: 'active',
    });
    await database.insert(adminSessions).values({
      id: sessionId,
      adminPrincipalId: principalId,
      sessionTokenHash: `session-${sessionId}`,
      sessionKeyId: 'admin-session-v1',
      csrfTokenHash: `csrf-${sessionId}`,
      csrfKeyId: 'admin-csrf-v1',
      authzVersionSnapshot: 1,
      mfaLevel: 'totp',
      mfaVerifiedAt: now,
      stepUpAt: now,
      sessionExpiresAt: new Date(now.getTime() + 60_000),
      idleExpiresAt: new Date(now.getTime() + 60_000),
    });
    context = {
      id: sessionId,
      principalId,
      rawToken: 'test-session-token',
      authzVersion: 1,
      mfaLevel: 'totp',
      recoveryRestricted: false,
      stepUpAt: now,
      permissions: ALL_PERMISSIONS,
      scopes: [{ roleKey: 'super_admin', scopeType: 'global', scopeKey: 'global' }],
      sessionExpiresAt: new Date(now.getTime() + 60_000),
      idleExpiresAt: new Date(now.getTime() + 60_000),
    };
    discovery = vi.fn<typeof discoverRelayModels>();
    discovery.mockImplementation((input) =>
      Promise.resolve({
        status: 'passed',
        baseUrl: input.baseUrl.endsWith('/v1') ? input.baseUrl : `${input.baseUrl}/v1`,
        models: [
          { id: 'model-alpha', label: 'Model Alpha' },
          { id: 'model-beta', label: 'Model Beta' },
        ],
      } satisfies RelayModelDiscoveryResult),
    );
    imageProbe = vi.fn<ImageProbe>().mockResolvedValue({
      status: 'passed',
      evidenceDigest: 'b'.repeat(64),
      summary: { code: 'MODEL_IMAGE_POC_PASSED' },
    });
    service = new AdminModelConfigurationService(database, config, discovery, imageProbe);
  });

  afterEach(async () => {
    await cleanupPrincipal(database, principalId);
  });

  afterAll(async () => {
    await client.end();
  });

  it('binds probe evidence, never returns the key, and replays before another relay call', async () => {
    const probe = await service.probe(context, {
      purpose: 'image',
      protocol_family: 'openai',
      base_url: 'https://relay.example.test',
      api_key: 'secret-image-key',
    });
    const input = {
      probe_token: probe.probe_token,
      selected_model_id: 'model-alpha',
      reason: 'Add image model',
    };
    const first = await service.create(context, request, input, 's14-model-create-0001');
    expect(JSON.stringify(first)).not.toContain('secret-image-key');
    expect(discovery).toHaveBeenCalledTimes(2);
    expect(imageProbe).toHaveBeenCalledTimes(1);
    expect(imageProbe.mock.calls[0]?.[0].requestedSpecKeys).toEqual([
      'image-generate-1k',
      'image-edit-1k',
    ]);
    const firstId = (first as { id: string }).id;
    const configuration = await database.query.modelConfigurations.findFirst({
      where: eq(modelConfigurations.id, firstId),
    });
    const model = await database.query.models.findFirst({
      where: eq(models.id, configuration!.modelSnapshotId),
    });
    const imagePoc = await database.query.modelPocRuns.findFirst({
      where: eq(modelPocRuns.modelSnapshotId, configuration!.modelSnapshotId),
    });
    expect(model).toMatchObject({ status: 'poc_passed', statusEvidenceDigest: 'b'.repeat(64) });
    expect(imagePoc).toMatchObject({
      probeSuiteVersion: 'model-poc@1',
      status: 'passed',
      evidenceDigest: 'b'.repeat(64),
      requestedSpecKeysJson: imageProbe.mock.calls[0]?.[0].requestedSpecKeys,
    });

    discovery.mockRejectedValueOnce(new Error('relay unavailable'));
    const replay = await service.create(context, request, input, 's14-model-create-0001');
    expect(JSON.parse(JSON.stringify(replay))).toEqual(JSON.parse(JSON.stringify(first)));
    expect(discovery).toHaveBeenCalledTimes(2);
    expect(imageProbe).toHaveBeenCalledTimes(1);

    await expect(
      service.create(
        context,
        request,
        { ...input, reason: 'Conflicting replay' },
        's14-model-create-0001',
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_IDEMPOTENCY_CONFLICT', status: 409 });
    expect(discovery).toHaveBeenCalledTimes(2);
    expect(imageProbe).toHaveBeenCalledTimes(1);
  });

  it('does not write an image configuration when the real image probe is unknown', async () => {
    imageProbe.mockResolvedValueOnce({
      status: 'outcome_unknown',
      evidenceDigest: 'c'.repeat(64),
      summary: { code: 'MODEL_IMAGE_POC_OUTCOME_UNKNOWN' },
    });
    const probe = await service.probe(context, {
      purpose: 'image',
      protocol_family: 'openai',
      base_url: 'https://relay.example.test',
      api_key: 'secret-image-key',
    });
    await expect(
      service.create(
        context,
        request,
        {
          probe_token: probe.probe_token,
          selected_model_id: 'model-alpha',
          reason: 'Reject unknown image capability',
        },
        's14-model-create-unknown-image',
      ),
    ).rejects.toMatchObject({ code: 'MODEL_IMAGE_POC_OUTCOME_UNKNOWN', status: 502 });
    expect(
      await database
        .select({ id: modelConfigurations.id })
        .from(modelConfigurations)
        .where(eq(modelConfigurations.createdByAdminId, principalId)),
    ).toEqual([]);
  });

  it('reuses the encrypted credential when an existing configuration is probed without a key', async () => {
    const image = await createConfiguration(
      database,
      service,
      context,
      'image',
      'model-alpha',
      '0010',
    );
    discovery.mockClear();

    await service.probe(context, {
      purpose: 'image',
      protocol_family: 'openai',
      base_url: 'https://relay.example.test/v1',
      configuration_id: image.id,
    });

    expect(discovery).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'secret-model-key-0010' }),
    );
  });

  it('enforces protocol and purpose boundaries before writing data', async () => {
    await expect(
      service.probe(context, {
        purpose: 'image',
        protocol_family: 'anthropic',
        base_url: 'https://relay.example.test',
        api_key: 'secret-image-key',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_PROTOCOL_PROVIDER_MISMATCH', status: 422 });

    const rows = await database
      .select({ id: modelConfigurations.id })
      .from(modelConfigurations)
      .where(eq(modelConfigurations.createdByAdminId, principalId));
    expect(rows).toEqual([]);
    expect(discovery).not.toHaveBeenCalled();
  });

  it('saves a Brain without creating or activating a moderation model', async () => {
    const before = await database.select().from(moderationRuntimeStates);
    const brain = await createConfiguration(
      database,
      service,
      context,
      'brain',
      'model-alpha',
      '0006',
    );
    const configuration = await database.query.modelConfigurations.findFirst({
      where: eq(modelConfigurations.id, brain.id),
    });
    expect(configuration).toMatchObject({
      purpose: 'brain',
      moderationModelSnapshotId: null,
      status: 'active',
    });
    const model = await database.query.models.findFirst({
      where: eq(models.id, brain.modelSnapshotId),
    });
    expect(model?.capabilityContractJson).toMatchObject({ max_context_tokens: 272_000 });
    expect(model?.quotaJson).toMatchObject({
      max_turn_input_tokens: 272_000,
      terminal_timeout_ms: 240000,
    });
    expect(await database.select().from(moderationRuntimeStates)).toEqual(before);
  });

  it('stores a Google Brain with native inference and the relay model discovery flow', async () => {
    const probe = await service.probe(context, {
      purpose: 'brain',
      protocol_family: 'google',
      base_url: 'https://relay.example.test',
      api_key: 'secret-test-google-key',
    });
    const saved = await service.create(
      context,
      request,
      {
        probe_token: probe.probe_token,
        selected_model_id: 'model-alpha',
        reason: 'Add Google Brain',
      },
      's14-google-brain-create-001',
    );
    if (typeof saved.id !== 'string') throw new Error('Created configuration ID is missing');
    const configuration = await database.query.modelConfigurations.findFirst({
      where: eq(modelConfigurations.id, saved.id),
    });
    const model = await database.query.models.findFirst({
      where: eq(models.id, configuration!.modelSnapshotId),
    });
    expect(model).toMatchObject({
      protocolFamily: 'google',
      apiVariant: 'google_generate_content',
    });
    expect(discovery).toHaveBeenCalledTimes(2);
    expect(discovery).toHaveBeenCalledWith(expect.objectContaining({ protocolFamily: 'google' }));
    expect(JSON.stringify(saved)).not.toContain('secret-test-google-key');
    await expect(
      service.probe(context, {
        purpose: 'image',
        protocol_family: 'google',
        base_url: 'https://relay.example.test',
        api_key: 'secret-test-google-key',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_PROTOCOL_PROVIDER_MISMATCH' });
  });

  it('rolls back image credits outside local when moderation is unavailable', async () => {
    const productionService = new AdminModelConfigurationService(
      database,
      { ...config, appEnv: 'production' },
      discovery,
      imageProbe,
    );
    const image = await createConfiguration(
      database,
      productionService,
      context,
      'image',
      'model-alpha',
      '0008',
    );
    // Establish the precondition instead of relying on ambient DB state: with no active
    // text-moderation route the content-safety closure cannot be built. The previous
    // snapshot is restored in `finally` so other suites see the original routes.
    const [textRoute] = await database
      .update(moderationRuntimeStates)
      .set({ activeModelSnapshotId: null })
      .where(eq(moderationRuntimeStates.capability, 'moderation.text'))
      .returning({
        capability: moderationRuntimeStates.capability,
        snapshot: moderationRuntimeStates.activeModelSnapshotId,
      });
    try {
      await expect(
        productionService.putCredits(
          context,
          request,
          image.id,
          {
            prices: { '1k': '3.00', '2k': '4.00', '4k': '6.00' },
            expected_revision: 1,
            reason: 'Reject production image prices without content safety',
          },
          's14-model-production-credits-0008',
        ),
      ).rejects.toMatchObject({ code: 'CONTENT_SAFETY_UNAVAILABLE', status: 409 });
      expect(await productionService.get(image.id)).toMatchObject({ prices: null, revision: 1 });
    } finally {
      if (textRoute) {
        await database
          .update(moderationRuntimeStates)
          .set({ activeModelSnapshotId: textRoute.snapshot })
          .where(eq(moderationRuntimeStates.capability, textRoute.capability));
      }
    }
  });

  it('publishes exactly the three image credit tiers and rejects Brain credits', async () => {
    const image = await createConfiguration(
      database,
      service,
      context,
      'image',
      'model-alpha',
      '0002',
    );
    await expect(
      service.putCredits(
        context,
        request,
        image.id,
        {
          prices: { '1k': '1.00', '2k': '2.00', '4k': '2.99' },
          expected_revision: 1,
          reason: 'Reject fractional credits',
        },
        's14-model-credits-below-margin-0002',
      ),
    ).rejects.toMatchObject({ code: 'MODEL_CREDITS_INVALID', status: 422 });
    await expect(service.get(image.id)).resolves.toMatchObject({ prices: null, revision: 1 });
    const priced = await service.putCredits(
      context,
      request,
      image.id,
      {
        prices: { '1k': '3.00', '2k': '4.00', '4k': '5.00' },
        expected_revision: 1,
        reason: 'Set image credits',
      },
      's14-model-credits-0002',
    );
    expect(priced).toMatchObject({
      id: image.id,
      prices: { '1k': '3.00', '2k': '4.00', '4k': '5.00' },
      revision: 2,
    });
    const entry = await database.query.modelCatalogEntries.findFirst({
      where: eq(modelCatalogEntries.modelSnapshotId, image.modelSnapshotId),
    });
    expect(entry).toBeTruthy();
    const skus = await database
      .select({
        credits: billableSkus.creditsPerUnit,
        operation: billableSkus.operation,
        providerCost: billableSkus.providerCostPerUnitCny,
      })
      .from(billableSkus)
      .where(eq(billableSkus.modelCatalogEntryId, entry!.id));
    expect(skus).toHaveLength(6);
    expect([...new Set(skus.map((row) => row.credits))].sort()).toEqual(['3.00', '4.00', '5.00']);
    expect(skus.every((row) => row.providerCost === null)).toBe(true);

    const brain = await createConfiguration(
      database,
      service,
      context,
      'brain',
      'model-beta',
      '0003',
    );
    await expect(
      service.putCredits(
        context,
        request,
        brain.id,
        {
          prices: { '1k': '1.00', '2k': '2.00', '4k': '3.00' },
          expected_revision: 1,
          reason: 'Brain must not have public image credits',
        },
        's14-brain-credits-0003',
      ),
    ).rejects.toMatchObject({ code: 'MODEL_CREDITS_NOT_SUPPORTED', status: 422 });
  });

  it('refreshes image tiers on explicit pricing save without changing old snapshots or probing', async () => {
    const image = await createConfiguration(
      database,
      service,
      context,
      'image',
      'model-alpha',
      'tier-refresh',
    );
    const model = await database.query.models.findFirst({
      where: eq(models.id, image.modelSnapshotId),
    });
    if (!model) throw new Error('Missing image test model');
    const legacyCapability: unknown = JSON.parse(
      JSON.stringify(model.capabilityContractJson).replace(/4k/g, '3k'),
    );
    const legacyPricing: unknown = JSON.parse(
      JSON.stringify(model.pricingJson).replace(/4k/g, '3k'),
    );
    await database
      .update(models)
      .set({ capabilityContractJson: legacyCapability, pricingJson: legacyPricing })
      .where(eq(models.id, model.id));
    const input = {
      prices: { '1k': '3.00', '2k': '4.00', '4k': '9.00' },
      expected_revision: 1,
      reason: 'Set new standard tiers',
    };
    const priced = await service.putCredits(
      context,
      request,
      image.id,
      input,
      's14-tier-refresh-save',
    );
    const current = await database.query.modelConfigurations.findFirst({
      where: eq(modelConfigurations.id, image.id),
    });
    expect(current?.modelSnapshotId).not.toBe(model.id);
    const oldModel = await database.query.models.findFirst({ where: eq(models.id, model.id) });
    expect(oldModel?.capabilityContractJson).toEqual(legacyCapability);
    expect(oldModel?.pricingJson).toEqual(legacyPricing);
    const updated = await database.query.models.findFirst({
      where: eq(models.id, current!.modelSnapshotId),
    });
    expect(updated?.capabilityContractJson).toEqual(model.capabilityContractJson);
    expect(priced).toMatchObject({ prices: input.prices, revision: 2 });
    const poc = await database.query.modelPocRuns.findFirst({
      where: eq(modelPocRuns.modelSnapshotId, current!.modelSnapshotId),
    });
    expect(poc?.requestedSpecKeysJson).toEqual(['image-edit-1k', 'image-generate-1k']);
    expect(poc?.resultSummaryJson).toMatchObject({
      source_model_snapshot_id: model.id,
      scope: 'unchanged-1k-baseline',
    });
    const calls = imageProbe.mock.calls.length;
    expect(
      await service.putCredits(context, request, image.id, input, 's14-tier-refresh-save'),
    ).toEqual(JSON.parse(JSON.stringify(priced)));
    expect(imageProbe).toHaveBeenCalledTimes(calls);
    expect(calls).toBe(1);
    const release = await new ModelCatalogService(database, 'test').list('image', randomUUID());
    expect(JSON.stringify(release)).toContain('4k');
    expect(JSON.stringify(release)).not.toContain('3k');
  });

  it('rejects a specification refresh when the probed baseline has changed', async () => {
    const image = await createConfiguration(
      database,
      service,
      context,
      'image',
      'model-alpha',
      'tier-baseline-drift',
    );
    const model = await database.query.models.findFirst({
      where: eq(models.id, image.modelSnapshotId),
    });
    if (!model) throw new Error('Missing image test model');
    const changed = JSON.parse(JSON.stringify(model.capabilityContractJson)) as {
      specs: Array<Record<string, unknown>>;
    };
    changed.specs[0]!.max_outputs = 1;
    await database
      .update(models)
      .set({ capabilityContractJson: changed })
      .where(eq(models.id, model.id));
    await expect(
      service.putCredits(
        context,
        request,
        image.id,
        {
          prices: { '1k': '3.00', '2k': '4.00', '4k': '9.00' },
          expected_revision: 1,
          reason: 'Must not reuse changed evidence',
        },
        's14-tier-baseline-drift-save',
      ),
    ).rejects.toMatchObject({ code: 'MODEL_IMAGE_PROBE_REQUIRED', status: 409 });
    expect(await service.get(image.id)).toMatchObject({ revision: 1, prices: null });
  });

  it('allows one CAS winner and removes the model and its current prices together', async () => {
    const image = await createConfiguration(
      database,
      service,
      context,
      'image',
      'model-alpha',
      '0004',
    );
    const candidates = await Promise.allSettled(
      ['A', 'B'].map((suffix, index) =>
        service.putCredits(
          context,
          request,
          image.id,
          {
            prices: { '1k': `${index + 3}.00`, '2k': '4.00', '4k': '5.00' },
            expected_revision: 1,
            reason: `Concurrent credit update ${suffix}`,
          },
          `s14-model-credits-race-${suffix}`,
        ),
      ),
    );
    expect(candidates.filter((candidate) => candidate.status === 'fulfilled')).toHaveLength(1);
    const rejected = candidates.find((candidate) => candidate.status === 'rejected');
    if (!rejected || rejected.status !== 'rejected') {
      throw new Error('Expected one concurrent credit update to lose the revision race');
    }
    expect(rejected.reason).toMatchObject({ code: 'ADMIN_REVISION_CONFLICT', status: 409 });

    const current = await service.get(image.id);
    await service.remove(
      context,
      request,
      image.id,
      { expected_revision: 2, reason: 'Remove image model' },
      's14-model-delete-0004',
    );
    await expect(service.get(image.id)).rejects.toMatchObject({
      code: 'ADMIN_RESOURCE_NOT_FOUND',
      status: 404,
    });
    expect(current).toMatchObject({ revision: 2 });
    expect(
      await database.query.models.findFirst({ where: eq(models.id, image.modelSnapshotId) }),
    ).toMatchObject({ status: 'disabled' });
    expect(
      await database.query.providerCredentialVersions.findFirst({
        where: eq(providerCredentialVersions.id, image.credentialVersionId),
      }),
    ).toMatchObject({ status: 'revoked' });
  });

  it('publishes a new release when deleting a brain model restores an earlier catalog', async () => {
    await createConfiguration(database, service, context, 'brain', 'model-alpha', 'restore-a');
    const first = await database.query.pricingCatalogState.findFirst({
      where: eq(pricingCatalogState.id, 'global'),
    });
    const firstRelease = await database.query.pricingCatalogReleases.findFirst({
      where: eq(pricingCatalogReleases.id, first!.activeReleaseId!),
    });
    const second = await createConfiguration(
      database,
      service,
      context,
      'brain',
      'model-beta',
      'restore-b',
    );
    const added = await database.query.pricingCatalogState.findFirst({
      where: eq(pricingCatalogState.id, 'global'),
    });
    await expect(
      service.remove(
        context,
        request,
        second.id,
        { expected_revision: 1, reason: 'Restore earlier catalog' },
        's14-model-delete-restore',
      ),
    ).resolves.toEqual({ id: second.id, status: 'deleted' });

    const current = await database.query.pricingCatalogState.findFirst({
      where: eq(pricingCatalogState.id, 'global'),
    });
    const restored = await database.query.pricingCatalogReleases.findFirst({
      where: eq(pricingCatalogReleases.id, current!.activeReleaseId!),
    });
    expect(restored).toMatchObject({
      releaseDigest: firstRelease!.releaseDigest,
      baseReleaseId: added!.activeReleaseId,
      releaseNo: firstRelease!.releaseNo + 2,
    });
    expect(restored!.id).not.toBe(firstRelease!.id);
    expect(
      await database.query.pricingCatalogReleases.findFirst({
        where: eq(pricingCatalogReleases.id, firstRelease!.id),
      }),
    ).toMatchObject({ releaseDigest: firstRelease!.releaseDigest });
    expect(
      await database.query.modelConfigurations.findFirst({
        where: eq(modelConfigurations.id, second.id),
      }),
    ).toMatchObject({ status: 'deleted', revision: 2 });
  });

  it('reflects model and provider circuits without changing the published catalog', async () => {
    const image = await createConfiguration(
      database,
      service,
      context,
      'image',
      'model-alpha',
      'catalog-circuit-a',
    );
    const other = await createConfiguration(
      database,
      service,
      context,
      'image',
      'model-beta',
      'catalog-circuit-b',
    );
    for (const configuration of [image, other]) {
      await service.putCredits(
        context,
        request,
        configuration.id,
        {
          prices: { '1k': '3.00', '2k': '4.00', '4k': '5.00' },
          expected_revision: 1,
          reason: 'Publish catalog circuit fixture',
        },
        `s14-model-credits-${configuration.id}`,
      );
    }
    const model = await database.query.models.findFirst({
      where: eq(models.id, image.modelSnapshotId),
    });
    if (!model) throw new Error('CATALOG_CIRCUIT_FIXTURE_MISSING');
    const catalog = new ModelCatalogService(database, 'local');
    const userId = randomUUID();
    const initial = await catalog.list('image', userId);
    const expectAvailability = async (first: string, second: string) => {
      const result = await catalog.list('image', userId);
      expect(result.catalog_revision).toBe(initial.catalog_revision);
      expect(result.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ public_slug: `image-${image.id}`, availability: first }),
          expect.objectContaining({ public_slug: `image-${other.id}`, availability: second }),
        ]),
      );
    };
    await expectAvailability('available', 'available');
    const modelCircuitId = randomUUID();
    const providerCircuitId = randomUUID();
    try {
      await database.insert(providerCircuitStates).values({
        id: modelCircuitId,
        scopeType: 'model',
        scopeKey: `model:${image.modelSnapshotId}`,
        provider: model.provider,
        modelId: image.modelSnapshotId,
        status: 'open',
        reasonCode: 'unknown_rate',
        probeAfter: new Date(0),
      });
      await expectAvailability('unavailable', 'available');
      await database
        .update(providerCircuitStates)
        .set({ status: 'half_open' })
        .where(eq(providerCircuitStates.id, modelCircuitId));
      await expectAvailability('unavailable', 'available');
      await database
        .update(providerCircuitStates)
        .set({ status: 'closed', reasonCode: 'hourly_budget' })
        .where(eq(providerCircuitStates.id, modelCircuitId));
      await expectAvailability('unavailable', 'available');
      await database
        .update(providerCircuitStates)
        .set({ status: 'closed', reasonCode: null })
        .where(eq(providerCircuitStates.id, modelCircuitId));
      await expectAvailability('available', 'available');
      await database.insert(providerCircuitStates).values({
        id: providerCircuitId,
        scopeType: 'provider',
        scopeKey: `provider:${model.provider}`,
        provider: model.provider,
        status: 'open',
        reasonCode: 'failure_rate',
      });
      await expectAvailability('unavailable', 'unavailable');
    } finally {
      await database
        .delete(providerCircuitStates)
        .where(inArray(providerCircuitStates.id, [modelCircuitId, providerCircuitId]));
    }
    await expectAvailability('available', 'available');
  });

  it('keeps historical catalog versions when an image model is changed and repriced', async () => {
    const image = await createConfiguration(
      database,
      service,
      context,
      'image',
      'model-alpha',
      '0009',
    );
    await service.putCredits(
      context,
      request,
      image.id,
      {
        prices: { '1k': '3.00', '2k': '4.00', '4k': '5.00' },
        expected_revision: 1,
        reason: 'Publish initial image prices',
      },
      's14-model-credits-0009-a',
    );
    const probe = await service.probe(context, {
      purpose: 'image',
      protocol_family: 'openai',
      base_url: 'https://relay.example.test',
      api_key: 'secret-image-replacement-key',
    });
    await service.update(
      context,
      request,
      image.id,
      {
        probe_token: probe.probe_token,
        selected_model_id: 'model-beta',
        expected_revision: 2,
        reason: 'Replace image model without rewriting history',
      },
      's14-model-update-0009',
    );
    await service.putCredits(
      context,
      request,
      image.id,
      {
        prices: { '1k': '4.00', '2k': '5.00', '4k': '6.00' },
        expected_revision: 3,
        reason: 'Publish replacement image prices',
      },
      's14-model-credits-0009-b',
    );
    const entries = await database
      .select({ version: modelCatalogEntries.versionNo })
      .from(modelCatalogEntries)
      .where(eq(modelCatalogEntries.publicSlug, `image-${image.id}`));
    expect(entries.map((entry) => entry.version).sort()).toEqual([1, 2]);
  });

  it('rejects a stale update before repeating model discovery or image PoC', async () => {
    const image = await createConfiguration(
      database,
      service,
      context,
      'image',
      'model-alpha',
      '0011',
    );
    const probe = await service.probe(context, {
      purpose: 'image',
      protocol_family: 'openai',
      base_url: 'https://relay.example.test',
      api_key: 'secret-image-stale-key',
    });
    discovery.mockClear();
    imageProbe.mockClear();

    await expect(
      service.update(
        context,
        request,
        image.id,
        {
          probe_token: probe.probe_token,
          selected_model_id: 'model-beta',
          expected_revision: 2,
          reason: 'Reject stale update before provider calls',
        },
        's14-model-update-stale-0011',
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_REVISION_CONFLICT', status: 409 });
    expect(discovery).not.toHaveBeenCalled();
    expect(imageProbe).not.toHaveBeenCalled();
  });

  it('enforces write permissions inside the service boundary', async () => {
    const image = await createConfiguration(
      database,
      service,
      context,
      'image',
      'model-alpha',
      '0005',
    );
    const readOnly = { ...context, permissions: ['models.read'] };
    await expect(
      service.putCredits(
        readOnly,
        request,
        image.id,
        {
          prices: { '1k': '1.00', '2k': '2.00', '4k': '3.00' },
          expected_revision: 1,
          reason: 'Unauthorized credits',
        },
        's14-model-credits-denied',
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_PERMISSION_DENIED', status: 403 });
    await expect(
      service.remove(
        readOnly,
        request,
        image.id,
        { expected_revision: 1, reason: 'Unauthorized delete' },
        's14-model-delete-denied',
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_PERMISSION_DENIED', status: 403 });
  });
});

async function createConfiguration(
  database: Database,
  service: AdminModelConfigurationService,
  context: AdminSessionContext,
  purpose: 'brain' | 'image',
  modelId: string,
  suffix: string,
): Promise<{
  id: string;
  modelSnapshotId: string;
  credentialVersionId: string;
}> {
  const probe = await service.probe(context, {
    purpose,
    protocol_family: 'openai',
    base_url: 'https://relay.example.test',
    api_key: `secret-model-key-${suffix}`,
  });
  const created = await service.create(
    context,
    request,
    { probe_token: probe.probe_token, selected_model_id: modelId, reason: `Create ${purpose}` },
    `s14-model-create-${suffix}`,
  );
  const id = String(created.id);
  const row = await database.query.modelConfigurations.findFirst({
    where: eq(modelConfigurations.id, id),
  });
  if (!row) throw new Error('Created model configuration is missing');
  return {
    id,
    modelSnapshotId: row.modelSnapshotId,
    credentialVersionId: row.credentialVersionId,
  };
}

async function cleanupPrincipal(database: Database, principalId: string): Promise<void> {
  const [providerRows, storageRows, releaseRows] = await Promise.all([
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
  ]);
  const providerIds = providerRows.map((row) => row.id);
  const storageIds = storageRows.map((row) => row.id);
  const releaseIds = releaseRows.map((row) => row.id);
  const modelRows = providerIds.length
    ? await database
        .select({ id: models.id })
        .from(models)
        .where(inArray(models.providerChannelId, providerIds))
    : [];
  const modelIds = modelRows.map((row) => row.id);
  const catalogRows = modelIds.length
    ? await database
        .select({ id: modelCatalogEntries.id })
        .from(modelCatalogEntries)
        .where(inArray(modelCatalogEntries.modelSnapshotId, modelIds))
    : [];
  const catalogIds = catalogRows.map((row) => row.id);

  if (releaseIds.length) {
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
  if (modelIds.length) {
    await database
      .update(moderationRuntimeStates)
      .set({ activeModelSnapshotId: null, updatedByAdminId: null })
      .where(inArray(moderationRuntimeStates.activeModelSnapshotId, modelIds));
    await database
      .delete(modelConfigurations)
      .where(inArray(modelConfigurations.modelSnapshotId, modelIds));
  }
  if (catalogIds.length) {
    await database
      .delete(billableSkus)
      .where(inArray(billableSkus.modelCatalogEntryId, catalogIds));
    await database.delete(modelCatalogEntries).where(inArray(modelCatalogEntries.id, catalogIds));
  }
  if (modelIds.length) {
    await database.delete(modelPocRuns).where(inArray(modelPocRuns.modelSnapshotId, modelIds));
    await database.delete(models).where(inArray(models.id, modelIds));
  }
  await database
    .update(moderationRuntimeStates)
    .set({ updatedByAdminId: null })
    .where(eq(moderationRuntimeStates.updatedByAdminId, principalId));
  if (providerIds.length) {
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
  if (storageIds.length) {
    await database
      .delete(storageRuntimeState)
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
  await database.delete(adminAuditLogs).where(eq(adminAuditLogs.actorAdminId, principalId));
  await database
    .delete(adminIdempotencyRecords)
    .where(eq(adminIdempotencyRecords.actorAdminId, principalId));
  await database.delete(adminSessions).where(eq(adminSessions.adminPrincipalId, principalId));
  await database.delete(adminPrincipals).where(eq(adminPrincipals.id, principalId));
}
