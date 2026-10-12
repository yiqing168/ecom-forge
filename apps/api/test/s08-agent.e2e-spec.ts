import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { deterministicFakeAgentModelSnapshot } from '@ecom-forge/agent';
import {
  agentTraces,
  agentTraceSteps,
  agentTurnConfirmations,
  agentTurns,
  and,
  billableSkus,
  chatMessages,
  chatSessions,
  creditAccounts,
  createDatabaseClient,
  eq,
  eventOutbox,
  inArray,
  queueDispatchIntents,
  modelCatalogEntries,
  models,
  pricingCatalogReleases,
  pricingCatalogState,
  providerChannels,
  providerCredentialVersions,
  skillCatalogReleases,
  skillCatalogState,
  skillPackageResources,
  skillPackages,
  skillPackageValidationReports,
  skillResourceSnapshots,
  skills,
  users,
} from '@ecom-forge/db';
import { canonicalSha256, utf8Sha256 } from '@ecom-forge/shared';
import { parseSkillDefinition } from '@ecom-forge/skills';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AgentConfirmationService } from '../src/modules/agent/agent-confirmation.service.js';
import { AgentController } from '../src/modules/agent/agent.controller.js';
import { AgentTurnService } from '../src/modules/agent/agent-turn.service.js';
import { AgentSessionService } from '../src/modules/agent/agent-session.service.js';
import { SkillCatalogService } from '../src/modules/agent/skill-catalog.service.js';
import { AuthenticationService } from '../src/modules/auth/authentication.service.js';
import { AuthWriteGuard } from '../src/modules/auth/auth-write.guard.js';
import { EventOutboxRepository } from '../src/modules/events/event-outbox.repository.js';
import { EventsController } from '../src/modules/events/events.controller.js';
import { EventWakeHub } from '../src/modules/events/event-wake.hub.js';
import { SseStreamService } from '../src/modules/events/sse-stream.service.js';
import { appendOutboxEventInTransaction } from '../src/shared/database/outbox.repository.js';
import { AGENT_BRAIN_FAILURE_SUMMARIES } from '@ecom-forge/shared';
import { agentBrainPublicFailure } from '../../worker/src/agent/agent-brain-public-failure.js';
import type { AppConfig } from '../src/config/app-config.js';
import { APP_CONFIG } from '../src/config/config.module.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '').toLowerCase();
if (!/_test(?:_|$)/.test(databaseName)) {
  throw new Error('S08 API integration tests require a database name containing _test');
}

const resource = createDatabaseClient({ databaseUrl, maxConnections: 20 });
const catalog = new SkillCatalogService(resource.db);
const turns = new AgentTurnService(resource.db);
const confirmations = new AgentConfirmationService(resource.db);
const sessions = new AgentSessionService(
  resource.db,
  Buffer.alloc(32, 43).toString('base64url'),
  Buffer.alloc(32, 44).toString('base64url'),
);
const hash = (token: string) => canonicalSha256({ s08_test: token });
const trackedUsers = new Set<string>();
let currentUserId: string | null = null;
let currentCanCreate = true;
let app: INestApplication;
let origin: string;
const wakeHub = new EventWakeHub(
  {
    publish: () => Promise.resolve(0),
    subscribe: () => Promise.resolve(),
    unsubscribe: () => Promise.resolve(),
  },
  { redisPrefix: `s08-public-failure-${randomUUID()}` } as AppConfig,
);
const streamService = new SseStreamService(new EventOutboxRepository(resource.db), wakeHub, {
  heartbeatIntervalMs: 50,
  watchdogTimeoutMs: 150,
  replayBatchSize: 100,
  backpressureTimeoutMs: 500,
  maxConnections: 20,
  maxConnectionsPerUser: 3,
});
let packageRecordId: string;
let validationReportId: string;
let releaseId: string;
let primarySkillId: string;
let auxiliarySkillId: string;
let modelCatalogReleaseId: string;
let providerChannelId: string;
let providerCredentialId: string;
let brainModelSnapshotId: string;
let imageModelSnapshotId: string;
let brainCatalogEntryId: string;
let imageCatalogEntryId: string;
let modelCatalogRevision: number;
const agentConfig = { agent: { routeEnabled: true } } as AppConfig;

async function installCatalogFixture(): Promise<void> {
  packageRecordId = randomUUID();
  validationReportId = randomUUID();
  releaseId = randomUUID();
  primarySkillId = `s08-primary-${packageRecordId.slice(0, 8)}@1.0.0`;
  auxiliarySkillId = `s08-auxiliary-${packageRecordId.slice(0, 8)}@1.0.0`;
  const primarySlug = primarySkillId.split('@')[0]!;
  const auxiliarySlug = auxiliarySkillId.split('@')[0]!;
  const resourceContent = (path: string) => `# S08 ${path}`;
  const primaryPlanningHash = utf8Sha256(resourceContent('SKILL.md'));
  const presetHash = utf8Sha256(resourceContent('presets/clean.md'));
  const auxiliaryPlanningHash = utf8Sha256(resourceContent('SKILL.md'));
  const primaryDefinition = parseSkillDefinition({
    schema_version: 1,
    slug: primarySlug,
    version: '1.0.0',
    display_name: 'S08 测试创作',
    description: '用于验证 Agent turn 的隔离 Skill',
    kind: 'primary',
    visibility: 'public',
    domain: 'creative',
    category: 's08-test',
    stage: '1A',
    sort_order: 10,
    planning_view: { path: 'SKILL.md', content_hash: primaryPlanningHash },
    preset_slots: [
      {
        slot: 'style',
        label: '风格',
        required: true,
        max_selections: 1,
        options: [
          {
            preset_id: `s08-clean-${packageRecordId.slice(0, 8)}@1.0.0`,
            name: '干净风格',
            description: '用于隔离测试的风格',
            resource_path: 'presets/clean.md',
            resource_hash: presetHash,
          },
        ],
      },
    ],
    dependencies: [{ skill_id: auxiliarySkillId, mode: 'required', reason: '测试安全依赖' }],
  });
  const auxiliaryDefinition = parseSkillDefinition({
    schema_version: 1,
    slug: auxiliarySlug,
    version: '1.0.0',
    display_name: 'S08 安全辅助',
    description: '用于验证依赖闭包',
    kind: 'auxiliary',
    visibility: 'internal',
    domain: 'creative',
    category: 's08-test',
    stage: '1A',
    planning_view: { path: 'SKILL.md', content_hash: auxiliaryPlanningHash },
  });
  const packageDigest = hash('package');
  await resource.db.insert(skillPackages).values({
    id: packageRecordId,
    packageId: `s08-package-${packageRecordId.slice(0, 8)}`,
    packageVersion: '1.0.0',
    packageDigest,
    archiveSha256: hash('archive'),
    manifestJson: { schema_version: 1, test_run_id: packageRecordId },
    status: 'approved',
    riskStatus: 'clear',
    sourceType: 'first_party',
    quarantineStorageKey: `s08-test/${packageRecordId}`,
    uploadExpiresAt: new Date(Date.now() + 60_000),
    approvedBy: 's08-test',
    approvedAt: new Date(),
  });
  const resourceInputs = [
    {
      skillId: primarySkillId,
      path: 'SKILL.md',
      type: 'planning_view',
      contentHash: primaryPlanningHash,
    },
    { skillId: primarySkillId, path: 'presets/clean.md', type: 'preset', contentHash: presetHash },
    {
      skillId: auxiliarySkillId,
      path: 'SKILL.md',
      type: 'planning_view',
      contentHash: auxiliaryPlanningHash,
    },
  ];
  const packageResources = await resource.db
    .insert(skillPackageResources)
    .values(
      resourceInputs.map((item) => ({
        packageRecordId,
        resourcePath: `${item.skillId}/${item.path}`,
        resourceType: item.type,
        mediaType: 'text/markdown',
        byteSize: 20,
        contentHash: item.contentHash,
        storageKey: `s08-test/${packageRecordId}/${item.skillId}/${item.path}`,
        skillId: item.skillId,
        rightsMetadataJson: { source: 'first_party', test_run_id: packageRecordId },
      })),
    )
    .returning();
  const primaryDefinitionHash = canonicalSha256(primaryDefinition);
  const auxiliaryDefinitionHash = canonicalSha256(auxiliaryDefinition);
  await resource.db.insert(skills).values([
    {
      id: primarySkillId,
      slug: primarySlug,
      name: primaryDefinition.display_name,
      category: primaryDefinition.category,
      domain: primaryDefinition.domain,
      kind: 'primary',
      visibility: 'public',
      stage: '1A',
      version: '1.0.0',
      packageRecordId,
      skillDigest: hash('primary-skill'),
      definitionJson: primaryDefinition,
      definitionHash: primaryDefinitionHash,
      sortOrder: 10,
      price: {},
      status: 'published',
      publishedAt: new Date(),
    },
    {
      id: auxiliarySkillId,
      slug: auxiliarySlug,
      name: auxiliaryDefinition.display_name,
      category: auxiliaryDefinition.category,
      domain: auxiliaryDefinition.domain,
      kind: 'auxiliary',
      visibility: 'internal',
      stage: '1A',
      version: '1.0.0',
      packageRecordId,
      skillDigest: hash('auxiliary-skill'),
      definitionJson: auxiliaryDefinition,
      definitionHash: auxiliaryDefinitionHash,
      sortOrder: 20,
      price: {},
      status: 'published',
      publishedAt: new Date(),
    },
  ]);
  const snapshotInputs = resourceInputs.map((item, index) => ({
    id: randomUUID(),
    skillId: item.skillId,
    resourcePath: item.path,
    resourceType: item.type as 'planning_view' | 'preset',
    contentHash: item.contentHash,
    packageResourceId: packageResources[index]!.id,
    contentText: resourceContent(item.path),
    kvKey: `s08:${packageRecordId}:${index}`,
    summaryJson: { test_run_id: packageRecordId },
  }));
  await resource.db.insert(skillResourceSnapshots).values(snapshotInputs);
  const reportDigest = hash('validation-report');
  await resource.db.insert(skillPackageValidationReports).values({
    id: validationReportId,
    packageRecordId,
    packageRevision: 1,
    packageDigest,
    attemptNo: 1,
    status: 'passed',
    validatorContractVersion: 's08-test-v1',
    platformEvalSuiteDigest: hash('eval-suite'),
    reportJson: { passed: true, test_run_id: packageRecordId },
    reportDigest,
    completedAt: new Date(),
  });
  await resource.db
    .update(skillPackages)
    .set({
      latestValidationReportId: validationReportId,
      approvedValidationReportId: validationReportId,
    })
    .where(eq(skillPackages.id, packageRecordId));
  const resourceManifest = (skillId: string) =>
    snapshotInputs
      .filter((item) => item.skillId === skillId)
      .map((item) => ({
        skill_resource_snapshot_id: item.id,
        package_resource_id: item.packageResourceId,
        resource_path: item.resourcePath,
        content_hash: item.contentHash,
      }));
  const releaseManifest = {
    schema_version: 1 as const,
    packages: [
      {
        package_record_id: packageRecordId,
        validation_report_id: validationReportId,
        package_digest: packageDigest,
        skills: [
          {
            skill_id: primarySkillId,
            definition_hash: primaryDefinitionHash,
            resources: resourceManifest(primarySkillId),
          },
          {
            skill_id: auxiliarySkillId,
            definition_hash: auxiliaryDefinitionHash,
            resources: resourceManifest(auxiliarySkillId),
          },
        ],
      },
    ],
  };
  await resource.db.insert(skillCatalogReleases).values({
    id: releaseId,
    releaseNo: Math.floor(Date.now() / 1000),
    status: 'published',
    releaseDigest: canonicalSha256(releaseManifest),
    manifestJson: releaseManifest,
    reason: 's08 integration test',
    createdBy: 's08-test',
    approvedBy: 's08-test',
    publishedAt: new Date(),
  });
  await resource.db
    .insert(skillCatalogState)
    .values({ id: 'global', activeReleaseId: releaseId })
    .onConflictDoUpdate({
      target: skillCatalogState.id,
      set: { activeReleaseId: releaseId },
    });
}

async function installModelCatalogFixture(): Promise<void> {
  modelCatalogReleaseId = randomUUID();
  providerChannelId = randomUUID();
  providerCredentialId = randomUUID();
  brainModelSnapshotId = randomUUID();
  imageModelSnapshotId = randomUUID();
  brainCatalogEntryId = randomUUID();
  imageCatalogEntryId = randomUUID();
  modelCatalogRevision = Number.parseInt(modelCatalogReleaseId.slice(0, 7), 16) + 1;
  const provider = `s08-fake-${providerChannelId.slice(0, 8)}`;
  await resource.db.insert(providerChannels).values({
    id: providerChannelId,
    provider,
    adapterKey: 'fake-provider-v1',
    baseUrl: 'https://local.invalid',
    displayName: 'S08 fake provider',
    endpointProfileKey: `s08-${providerChannelId}`,
    status: 'active',
  });
  await resource.db.insert(providerCredentialVersions).values({
    id: providerCredentialId,
    providerChannelId,
    versionNo: 1,
    secretCiphertext: 's08-test-ciphertext',
    secretNonce: 's08-test-nonce',
    secretAuthTag: 's08-test-auth-tag',
    secretKeyId: 's08-test-key',
    keyHint: 'test',
    status: 'active',
    validationEvidenceDigest: hash('credential-evidence'),
    verifiedAt: new Date(),
    activatedAt: new Date(),
  });
  await resource.db
    .update(providerChannels)
    .set({ activeCredentialVersionId: providerCredentialId })
    .where(eq(providerChannels.id, providerChannelId));
  const fakeBrain = deterministicFakeAgentModelSnapshot({
    maxInputTokens: 96_000,
    maxOutputTokens: 8_192,
  });
  const imageCapability = {
    schema_version: 2 as const,
    contract_kind: 'media' as const,
    media_kind: 'image' as const,
    capabilities: ['image.generate' as const],
    specs: [
      {
        kind: 'image' as const,
        spec_key: 's08-image-1k-square',
        operation: 'image.generate' as const,
        mode: 'text-to-image',
        resolution_tier: '1k' as const,
        aspect_ratios: ['1:1'],
        max_outputs: 4,
        max_reference_images: 4,
        transparent_background: false,
        output_formats: ['png' as const],
      },
    ],
  };
  await resource.db.insert(models).values([
    {
      id: brainModelSnapshotId,
      provider,
      providerChannelId,
      modelId: 's08-brain',
      version: '1',
      capabilityContractJson: fakeBrain.capability_contract,
      pricingJson: fakeBrain.pricing,
      quotaJson: fakeBrain.quota,
      status: 'poc_passed',
      statusEvidenceDigest: hash('brain-poc'),
    },
    {
      id: imageModelSnapshotId,
      provider,
      providerChannelId,
      modelId: 's08-image',
      version: '1',
      capabilityContractJson: imageCapability,
      pricingJson: {
        schema_version: 2,
        contract_kind: 'media_rate_card',
        currency: 'CNY',
        rate_cards: [
          {
            rate_key: 's08-image-1k-square',
            spec_key: 's08-image-1k-square',
            billing_unit: 'image',
            unit_cost_cny: '0.10',
          },
        ],
        overhead_cny: {
          tool: '0.00',
          storage: '0.00',
          traffic: '0.00',
          agent_brain: '0.01',
        },
        failure_rate: '0.00',
        unknown_rate: '0.00',
        refund_rate: '0.00',
        risk_reserve_rate: '0.10',
        gross_margin_target: '0.30',
        credit_cny_anchor: '0.01',
      },
      quotaJson: {
        schema_version: 1,
        rpm: 100,
        concurrency: 10,
        hourly_budget_cny: '100.00',
        daily_budget_cny: '1000.00',
        poll_initial_delay_ms: 1000,
        poll_interval_ms: 2000,
        max_poll_count: 60,
        terminal_timeout_ms: 120000,
        circuit_sample_size: 20,
        circuit_failure_rate: '0.50',
        circuit_unknown_rate: '0.25',
        circuit_open_ms: 60000,
      },
      status: 'poc_passed',
      statusEvidenceDigest: hash('image-poc'),
    },
  ]);
  const rollout = { stage: 'test' as const, percentage: 100 };
  const manifestEntries = [
    {
      id: brainCatalogEntryId,
      model_snapshot_id: brainModelSnapshotId,
      public_slug: `s08-brain-${brainCatalogEntryId.slice(0, 8)}`,
      version_no: 1,
      category: 'brain' as const,
      display_name: 'S08 Brain',
      description: 'S08 test Brain',
      public_capabilities: { input: ['text'] },
      rollout,
      user_selectable: true,
      is_default: true,
      sort_order: 10,
      revision: 1,
    },
    {
      id: imageCatalogEntryId,
      model_snapshot_id: imageModelSnapshotId,
      public_slug: `s08-image-${imageCatalogEntryId.slice(0, 8)}`,
      version_no: 1,
      category: 'image' as const,
      display_name: 'S08 Image',
      description: 'S08 test image model',
      public_capabilities: { resolutions: ['1k'], aspect_ratios: ['1:1'] },
      rollout,
      user_selectable: true,
      is_default: true,
      sort_order: 20,
      revision: 1,
    },
  ];
  // This suite is the only API e2e that seeds the model catalog (verified across apps/api/test),
  // but interrupted runs of any suite can leave approved-default rows behind and the afterAll can
  // only delete the IDs it created. Clear the categories this suite owns before inserting again,
  // otherwise the approved-default unique index fails on the shared database.
  const staleCatalogEntries = await resource.db
    .select({ id: modelCatalogEntries.id })
    .from(modelCatalogEntries)
    .where(
      and(
        inArray(modelCatalogEntries.category, ['brain', 'image']),
        eq(modelCatalogEntries.isDefault, true),
        eq(modelCatalogEntries.status, 'approved'),
      ),
    );
  const staleEntryIds = staleCatalogEntries.map((entry) => entry.id);
  if (staleEntryIds.length > 0) {
    // `billable_skus` is the only table referencing entries; the pricing state holds no FK here.
    await resource.db
      .delete(billableSkus)
      .where(inArray(billableSkus.modelCatalogEntryId, staleEntryIds));
    await resource.db
      .delete(modelCatalogEntries)
      .where(inArray(modelCatalogEntries.id, staleEntryIds));
  }
  await resource.db.insert(modelCatalogEntries).values(
    manifestEntries.map((entry) => ({
      id: entry.id,
      modelSnapshotId: entry.model_snapshot_id,
      publicSlug: entry.public_slug,
      versionNo: entry.version_no,
      category: entry.category,
      displayName: entry.display_name,
      description: entry.description,
      publicCapabilitiesJson: entry.public_capabilities,
      rolloutJson: entry.rollout,
      userSelectable: entry.user_selectable,
      isDefault: entry.is_default,
      sortOrder: entry.sort_order,
      status: 'approved' as const,
      approvedAt: new Date(),
    })),
  );
  const manifest = {
    schema_version: 1 as const,
    entries: manifestEntries,
    skus: [],
    defaults: { brain: brainCatalogEntryId, image: imageCatalogEntryId },
  };
  await resource.db.insert(pricingCatalogReleases).values({
    id: modelCatalogReleaseId,
    releaseNo: modelCatalogRevision,
    status: 'published',
    manifestJson: manifest,
    releaseDigest: canonicalSha256(manifest),
    reason: 's08 integration test',
    publishedAt: new Date(),
  });
  await resource.db
    .insert(pricingCatalogState)
    .values({
      id: 'global',
      activeReleaseId: modelCatalogReleaseId,
      catalogRevision: modelCatalogRevision,
    })
    .onConflictDoUpdate({
      target: pricingCatalogState.id,
      set: {
        activeReleaseId: modelCatalogReleaseId,
        catalogRevision: modelCatalogRevision,
      },
    });
}

async function createUser(): Promise<string> {
  const id = randomUUID();
  await resource.db.insert(users).values({
    id,
    email: `s08-${id}@example.test`,
    displayName: 'S08 integration user',
    emailVerifiedAt: new Date(),
  });
  await resource.db.insert(creditAccounts).values({ userId: id, balance: '10000.00' });
  trackedUsers.add(id);
  return id;
}

function createPayload() {
  return {
    message: '请帮我构思一张产品创意图',
    attachments: [],
    mention_bindings: [],
    skill_selection: {
      primary_skill_id: primarySkillId,
      preset_selections: [
        { slot: 'style', preset_id: `s08-clean-${packageRecordId.slice(0, 8)}@1.0.0` },
      ],
    },
    model_selection: {
      catalog_revision: modelCatalogRevision,
      brain: { catalog_entry_id: brainCatalogEntryId, version_no: 1 },
      image: { catalog_entry_id: imageCatalogEntryId, version_no: 1 },
    },
    generation_preferences: {
      schema_version: 2 as const,
      output_kind: 'image' as const,
      aspect_ratio: '1:1',
      resolution_tier: '1k' as const,
    },
  };
}

async function cleanupUsers(): Promise<void> {
  for (const userId of trackedUsers) {
    const userTurns = await resource.db.query.agentTurns.findMany({
      where: eq(agentTurns.userId, userId),
      columns: { id: true, sessionId: true },
    });
    const turnIds = userTurns.map((item) => item.id);
    const sessionIds = [...new Set(userTurns.map((item) => item.sessionId))];
    const traces =
      turnIds.length > 0
        ? await resource.db.query.agentTraces.findMany({
            where: inArray(agentTraces.turnId, turnIds),
            columns: { id: true },
          })
        : [];
    if (traces.length > 0) {
      await resource.db.delete(agentTraceSteps).where(
        inArray(
          agentTraceSteps.traceId,
          traces.map((item) => item.id),
        ),
      );
    }
    if (turnIds.length > 0) {
      await resource.db.delete(eventOutbox).where(inArray(eventOutbox.scopeId, turnIds));
      await resource.db
        .delete(queueDispatchIntents)
        .where(inArray(queueDispatchIntents.aggregateId, turnIds));
      await resource.db
        .delete(agentTurnConfirmations)
        .where(inArray(agentTurnConfirmations.turnId, turnIds));
      await resource.db.delete(chatMessages).where(inArray(chatMessages.turnId, turnIds));
      await resource.db.delete(agentTraces).where(inArray(agentTraces.turnId, turnIds));
      await resource.db.delete(agentTurns).where(inArray(agentTurns.id, turnIds));
    }
    if (sessionIds.length > 0)
      await resource.db.delete(chatSessions).where(inArray(chatSessions.id, sessionIds));
    await resource.db.delete(creditAccounts).where(eq(creditAccounts.userId, userId));
    await resource.db.delete(users).where(eq(users.id, userId));
  }
  trackedUsers.clear();
}

beforeAll(async () => {
  await installCatalogFixture();
  await installModelCatalogFixture();
  const moduleRef = await Test.createTestingModule({
    controllers: [AgentController, EventsController],
    providers: [
      { provide: APP_CONFIG, useValue: agentConfig },
      { provide: SkillCatalogService, useValue: catalog },
      { provide: AgentTurnService, useValue: turns },
      { provide: AgentConfirmationService, useValue: confirmations },
      { provide: AgentSessionService, useValue: sessions },
      { provide: SseStreamService, useValue: streamService },
      { provide: EventWakeHub, useValue: wakeHub },
      {
        provide: AuthenticationService,
        useValue: {
          currentSession: () =>
            currentUserId
              ? Promise.resolve({
                  user: { id: currentUserId },
                  headers: new Headers(),
                  access: {
                    canCreate: currentCanCreate,
                    canUpload: true,
                    canCharge: true,
                    restrictionReason: currentCanCreate ? null : 'email_verification_required',
                  },
                })
              : Promise.resolve(null),
        },
      },
    ],
  })
    .overrideGuard(AuthWriteGuard)
    .useValue({ canActivate: () => true })
    .compile();
  app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  const address = (app.getHttpServer() as Server).address();
  if (!address || typeof address === 'string') throw new Error('S08_TEST_ADDRESS_INVALID');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  currentUserId = null;
  currentCanCreate = true;
  await cleanupUsers();
});

afterAll(async () => {
  // A failing run (e.g. a beforeAll fixture clash) must still drain the fixtures below: shared
  // test databases are reused, so leftover catalog rows poison the next run of this suite.
  try {
    await cleanupUsers();
  } catch (error) {
    console.error('s08-agent user cleanup failed', error);
  }
  try {
    await resource.db
      .update(skillCatalogState)
      .set({ activeReleaseId: null })
      .where(eq(skillCatalogState.activeReleaseId, releaseId));
    await resource.db.delete(skillCatalogReleases).where(eq(skillCatalogReleases.id, releaseId));
    await resource.db
      .delete(skillResourceSnapshots)
      .where(inArray(skillResourceSnapshots.skillId, [primarySkillId, auxiliarySkillId]));
    await resource.db.delete(skills).where(inArray(skills.id, [primarySkillId, auxiliarySkillId]));
    await resource.db
      .update(skillPackages)
      .set({ latestValidationReportId: null, approvedValidationReportId: null })
      .where(eq(skillPackages.id, packageRecordId));
    await resource.db
      .delete(skillPackageValidationReports)
      .where(eq(skillPackageValidationReports.id, validationReportId));
    await resource.db
      .delete(skillPackageResources)
      .where(eq(skillPackageResources.packageRecordId, packageRecordId));
    await resource.db.delete(skillPackages).where(eq(skillPackages.id, packageRecordId));
  } catch (error) {
    console.error('s08-agent skill fixture cleanup failed', error);
  }
  try {
    await resource.db
      .update(pricingCatalogState)
      .set({ activeReleaseId: null })
      .where(eq(pricingCatalogState.activeReleaseId, modelCatalogReleaseId));
    await resource.db
      .delete(pricingCatalogReleases)
      .where(eq(pricingCatalogReleases.id, modelCatalogReleaseId));
    await resource.db
      .delete(modelCatalogEntries)
      .where(inArray(modelCatalogEntries.id, [brainCatalogEntryId, imageCatalogEntryId]));
    await resource.db
      .delete(models)
      .where(inArray(models.id, [brainModelSnapshotId, imageModelSnapshotId]));
    await resource.db
      .update(providerChannels)
      .set({ activeCredentialVersionId: null })
      .where(eq(providerChannels.id, providerChannelId));
    await resource.db
      .delete(providerCredentialVersions)
      .where(eq(providerCredentialVersions.id, providerCredentialId));
    await resource.db.delete(providerChannels).where(eq(providerChannels.id, providerChannelId));
  } catch (error) {
    console.error('s08-agent model fixture cleanup failed', error);
  }
  // `app` is undefined when beforeAll already failed; closing must not mask that failure.
  if (app) {
    await app.close();
  }
  await resource.client.end();
});

describe('S08 Agent API integration', () => {
  it.each([
    ...Object.values(AGENT_BRAIN_FAILURE_SUMMARIES).map((summary) => ({
      summary,
      eventType: 'turn.failed',
      public_error_code: 'AGENT_MODEL_UNAVAILABLE',
    })),
    {
      summary: '本次处理未能恢复，已停止，请重新发送需求',
      eventType: 'turn.failed',
      public_error_code: 'AGENT_MODEL_UNAVAILABLE',
    },
    {
      summary: '所选生图模型暂时不可用，请稍后重试或选择其他生图模型',
      eventType: 'turn.failed',
      public_error_code: 'AGENT_COMPILER_UNAVAILABLE',
    },
    {
      summary: '当前对话的模型预算已用尽，请开始新的请求',
      eventType: 'turn.guardrail_triggered',
      guardrail_type: 'pricing_drift',
    },
    {
      summary: '内容安全审核暂时无法完成，请稍后重试。',
      eventType: 'turn.guardrail_triggered',
      guardrail_type: 'content_safety',
    },
  ])('replays $summary through HTTP SSE and the owned snapshot', async (failure) => {
    currentUserId = await createUser();
    const created = await turns.create(currentUserId, createPayload(), randomUUID());
    const [turn] = await resource.db
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.id, created.turn_id));
    if (!turn) throw new Error('S08_TEST_TURN_MISSING');
    // The timeout row uses the actual Worker classifier; the other rows cover its full output set.
    const summary =
      failure.summary === AGENT_BRAIN_FAILURE_SUMMARIES.timeout
        ? agentBrainPublicFailure('AGENT_BRAIN_UNAVAILABLE', {
            code: 'AGENT_BRAIN_PROVIDER_TIMEOUT',
          })
        : failure.summary;
    const event = await resource.db.transaction(async (transaction) => {
      await transaction
        .update(agentTurns)
        .set({ status: 'blocked', endedAt: new Date() })
        .where(eq(agentTurns.id, created.turn_id));
      return appendOutboxEventInTransaction(transaction, {
        scopeType: 'turn',
        scopeId: created.turn_id,
        eventType: failure.eventType,
        payload: {
          turn_id: turn.id,
          agent_trace_id: created.agent_trace_id,
          user_status: 'failed',
          summary,
          ...('guardrail_type' in failure
            ? { guardrail_type: failure.guardrail_type, action: 'stopped' }
            : { public_error_code: failure.public_error_code }),
        },
        retentionTier: 'critical',
      });
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(
        `${origin}/api/v1/events?scope=turn:${turn.id}&last_event_seq=${event.eventSeq - 1}`,
        {
          signal: controller.signal,
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      if (!response.body) throw new Error('S08_TEST_SSE_BODY_MISSING');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      while (!buffered.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('S08_TEST_SSE_CLOSED_BEFORE_FAILURE');
        buffered += decoder.decode(chunk.value, { stream: true });
      }
      const serialized = buffered
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6);
      if (!serialized) throw new Error('S08_TEST_SSE_EVENT_MISSING');
      const received = JSON.parse(serialized) as unknown;
      expect(received).toMatchObject({ event_type: failure.eventType, payload: { summary } });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    const snapshot = await request(app.getHttpServer() as Server).get(
      `/api/v1/agent/turns/${turn.id}`,
    );
    expect(snapshot.status).toBe(200);
    expect(snapshot.body as unknown).toMatchObject({
      ok: true,
      data: { id: turn.id, user_status: 'failed', failure_summary: summary },
      error: null,
    });
    currentUserId = await createUser();
    const unauthorized = await request(app.getHttpServer() as Server).get(
      `/api/v1/agent/turns/${turn.id}`,
    );
    expect(unauthorized.status).toBe(404);
  });
  it('returns 401 without a session and 403 for a restricted session', async () => {
    const anonymous = await request(app.getHttpServer() as Server).get('/api/v1/agent/sessions');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toMatchObject({ error: { code: 'AUTH_SESSION_REQUIRED' } });

    currentUserId = await createUser();
    currentCanCreate = false;
    const restricted = await request(app.getHttpServer() as Server).get('/api/v1/agent/sessions');
    expect(restricted.status).toBe(403);
    expect(restricted.body).toMatchObject({ error: { code: 'AUTH_VERIFICATION_REQUIRED' } });
  });

  it('fails closed before creating a turn when the Agent route is not approved', async () => {
    agentConfig.agent.routeEnabled = false;
    const idempotencyKey = randomUUID();
    try {
      const response = await request(app.getHttpServer() as Server)
        .post('/api/v1/agent/turns')
        .set('Idempotency-Key', idempotencyKey)
        .send({});
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        ok: false,
        data: null,
        error: { code: 'AGENT_MODEL_UNAVAILABLE' },
      });
      const created = await resource.db.query.agentTurns.findFirst({
        where: eq(agentTurns.createIdempotencyKey, idempotencyKey),
      });
      expect(created).toBeUndefined();
    } finally {
      agentConfig.agent.routeEnabled = true;
    }
  });

  it('lists only public primary catalog metadata with a stable ETag', async () => {
    const response = await request(app.getHttpServer() as Server).get(
      '/api/v1/skills?domain=creative',
    );
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('public');
    const body = response.body as {
      data: { catalog_version: string; items: Array<{ primary_skill_id: string }> };
    };
    expect(response.headers.etag).toBe(
      `"${(response.body as { data: { response_version: string } }).data.response_version}"`,
    );
    expect(body.data.items.some((item) => item.primary_skill_id === primarySkillId)).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain(auxiliarySkillId);
    expect(JSON.stringify(response.body)).not.toContain('required_capabilities');
  });

  it('creates a text-only builtin free creation turn without a style or eager auxiliary', async () => {
    currentUserId = await createUser();
    const prompt =
      'A blue ceramic cup in the lower left, overhead view, white background. No text.';
    const response = await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/turns')
      .set('Idempotency-Key', `free-create-${randomUUID()}`)
      .send({
        ...createPayload(),
        message: prompt,
        skill_selection: {
          primary_skill_id: 'creative-free-generation@1.0.1',
          preset_selections: [],
        },
      });
    expect(response.status).toBe(201);
    const { turn_id: turnId } = (response.body as { data: { turn_id: string } }).data;
    const turn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, turnId),
    });
    expect(turn?.skillSelectionSnapshotJson).toMatchObject({
      primary_skill_id: 'creative-free-generation@1.0.1',
      preset_selections: [],
      required_auxiliary: [],
      required_capabilities: ['image.generate'],
    });
    const message = await resource.db.query.chatMessages.findFirst({
      where: eq(chatMessages.turnId, turnId),
    });
    expect(message?.content).toBe(prompt);
    expect(message?.attachments).toEqual([]);
    expect(
      await resource.db.query.queueDispatchIntents.findMany({
        where: eq(queueDispatchIntents.aggregateId, turnId),
      }),
    ).toHaveLength(1);
  });

  it('creates one turn, intent and event under concurrent idempotent requests', async () => {
    currentUserId = await createUser();
    const key = `s08-create-${randomUUID()}`;
    const post = () =>
      request(app.getHttpServer() as Server)
        .post('/api/v1/agent/turns')
        .set('Idempotency-Key', key)
        .send(createPayload());
    const responses = await Promise.all([post(), post()]);
    expect(responses.map((item) => item.status)).toEqual([201, 201]);
    expect(responses[0]?.body).toEqual(responses[1]?.body);
    expect(responses[0]?.headers['cache-control']).toBe('no-store');
    const createdBody = responses[0]?.body as { data: { turn_id: string } };
    const turnId = createdBody.data.turn_id;
    const [turnRows, intentRows, eventRows] = await Promise.all([
      resource.db.query.agentTurns.findMany({ where: eq(agentTurns.userId, currentUserId) }),
      resource.db.query.queueDispatchIntents.findMany({
        where: eq(queueDispatchIntents.aggregateId, turnId),
      }),
      resource.db.query.eventOutbox.findMany({ where: eq(eventOutbox.scopeId, turnId) }),
    ]);
    expect(turnRows).toHaveLength(1);
    expect(intentRows).toHaveLength(1);
    expect(eventRows.map((item) => item.eventType)).toEqual(['turn.created']);
  });

  it('rejects an empty credit account before creating a turn or queue intent', async () => {
    currentUserId = await createUser();
    await resource.db
      .update(creditAccounts)
      .set({ balance: '0.00' })
      .where(eq(creditAccounts.userId, currentUserId));
    const idempotencyKey = `s08-zero-credit-${randomUUID()}`;

    const response = await request(app.getHttpServer() as Server)
      .post('/api/v1/agent/turns')
      .set('Idempotency-Key', idempotencyKey)
      .send(createPayload());

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'CREDIT_BALANCE_EMPTY' } });
    expect(
      await resource.db.query.agentTurns.findFirst({
        where: eq(agentTurns.createIdempotencyKey, idempotencyKey),
      }),
    ).toBeUndefined();
  });

  it('rejects a confirmation after the balance becomes empty before queueing continuation', async () => {
    currentUserId = await createUser();
    const created = await turns.create(
      currentUserId,
      createPayload(),
      `s08-zero-credit-confirm-${randomUUID()}`,
    );
    const confirmationId = randomUUID();
    const publicPayload = {
      schema_version: 1,
      question: '你更偏好哪种氛围？',
      options: [{ id: 'bright', label: '明亮' }],
      allow_free_text: true,
      max_response_chars: 2000,
    };
    await resource.db
      .update(agentTurns)
      .set({ status: 'waiting_user_confirmation' })
      .where(eq(agentTurns.id, created.turn_id));
    await resource.db.insert(agentTurnConfirmations).values({
      id: confirmationId,
      turnId: created.turn_id,
      userId: currentUserId,
      confirmationNo: 1,
      type: 'clarification',
      answerSchemaVersion: 1,
      publicPayloadJson: publicPayload,
      payloadDigest: canonicalSha256(publicPayload),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await resource.db
      .update(creditAccounts)
      .set({ balance: '0.00' })
      .where(eq(creditAccounts.userId, currentUserId));

    await expect(
      confirmations.confirm(
        currentUserId,
        created.turn_id,
        {
          confirmation_id: confirmationId,
          confirmation_type: 'clarification',
          confirmation_version: 1,
          answers: { selected_option_id: 'bright' },
        },
        `s08-zero-credit-confirm-${randomUUID()}`,
      ),
    ).rejects.toMatchObject({ code: 'CREDIT_BALANCE_EMPTY' });
    expect(
      await resource.db.query.chatMessages.findMany({
        where: eq(chatMessages.turnId, created.turn_id),
      }),
    ).toHaveLength(1);
    expect(
      await resource.db.query.queueDispatchIntents.findMany({
        where: eq(queueDispatchIntents.aggregateId, created.turn_id),
      }),
    ).toHaveLength(1);
  });

  it('rejects changed payloads and hides another users turn', async () => {
    currentUserId = await createUser();
    const ownerId = currentUserId;
    const key = `s08-conflict-${randomUUID()}`;
    const created = await turns.create(ownerId, createPayload(), key);
    await expect(
      turns.create(ownerId, { ...createPayload(), message: '不同的请求' }, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    currentUserId = await createUser();
    const hidden = await request(app.getHttpServer() as Server).get(
      `/api/v1/agent/turns/${created.turn_id}`,
    );
    expect(hidden.status).toBe(404);
    const hiddenBody = hidden.body as { error: { code: string } };
    expect(hiddenBody.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('freezes the designer preference and detects idempotent payload changes', async () => {
    currentUserId = await createUser();
    const key = `s08-designer-${randomUUID()}`;
    const base = createPayload();
    const payload = {
      ...base,
      generation_preferences: {
        ...base.generation_preferences,
        creative_direction: {
          mode: 'profile' as const,
          profile_id: 'visual-metaphor' as const,
          version: 1 as const,
        },
      },
    };
    const created = await turns.create(currentUserId, payload, key);
    expect(await turns.create(currentUserId, payload, key)).toEqual(created);
    const stored = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, created.turn_id),
    });
    expect(stored?.generationPreferencesJson).toEqual(payload.generation_preferences);
    expect(stored?.generationPreferencesHash).toBe(canonicalSha256(payload.generation_preferences));
    const fetched = await turns.get(currentUserId, created.turn_id);
    expect(fetched.generation_preferences).toEqual(payload.generation_preferences);
    await expect(
      turns.create(
        currentUserId,
        {
          ...payload,
          generation_preferences: {
            ...payload.generation_preferences,
            creative_direction: { mode: 'native' },
          },
        },
        key,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it.each([
    { mode: 'native' as const },
    { mode: 'auto' as const, version: 3 as const },
    { mode: 'auto' as const, version: 1 as const },
    { mode: 'profile' as const, profile_id: 'visual-metaphor' as const, version: 1 as const },
    { mode: 'profile' as const, profile_id: 'material-experiment' as const, version: 2 as const },
  ])('locks designer %j without side effects on mismatch', async (direction) => {
    currentUserId = await createUser();
    const base = createPayload();
    const payload = {
      ...base,
      generation_preferences: { ...base.generation_preferences, creative_direction: direction },
    };
    const key = randomUUID();
    const created = await turns.create(currentUserId, payload, key);
    const continued = { ...payload, session_id: created.session_id };
    const changed = {
      ...continued,
      generation_preferences: {
        ...payload.generation_preferences,
        creative_direction:
          direction.mode === 'native'
            ? { mode: 'auto' as const, version: 3 as const }
            : { mode: 'native' as const },
      },
    };
    await expect(turns.create(currentUserId, changed, randomUUID())).rejects.toMatchObject({
      code: 'SESSION_CREATIVE_DIRECTION_MISMATCH',
    });
    expect(
      await resource.db.query.agentTurns.findMany({ where: eq(agentTurns.userId, currentUserId) }),
    ).toHaveLength(1);
    expect(
      await resource.db.query.agentTraces.findMany({
        where: eq(agentTraces.userId, currentUserId),
      }),
    ).toHaveLength(1);
    expect(
      await resource.db.query.queueDispatchIntents.findMany({
        where: eq(queueDispatchIntents.aggregateId, created.turn_id),
      }),
    ).toHaveLength(1);
    const detail = await sessions.get(currentUserId, created.session_id, { limit: 1 });
    expect(detail.session.creative_direction_snapshot).toEqual({
      schema_version: 1,
      selection: direction,
    });
    expect(await turns.create(currentUserId, payload, key)).toEqual(created);
    await turns.create(currentUserId, continued, randomUUID());
  });

  it('serializes competing first submissions into an empty session', async () => {
    currentUserId = await createUser();
    const userId = currentUserId;
    const [session] = await resource.db
      .insert(chatSessions)
      .values({ userId: currentUserId, title: 'Designer race' })
      .returning();
    const base = createPayload();
    const results = await Promise.allSettled(
      ['visual-metaphor', 'spatial-drama'].map((profile_id) =>
        turns.create(
          userId,
          {
            ...base,
            session_id: session!.id,
            generation_preferences: {
              ...base.generation_preferences,
              creative_direction: {
                mode: 'profile',
                profile_id: profile_id as 'visual-metaphor' | 'spatial-drama',
                version: 2,
              },
            },
          },
          randomUUID(),
        ),
      ),
    );
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((item) => item.status === 'rejected')).toMatchObject({
      reason: { code: 'SESSION_CREATIVE_DIRECTION_MISMATCH' },
    });
    expect(
      await resource.db.query.agentTurns.findMany({ where: eq(agentTurns.sessionId, session!.id) }),
    ).toHaveLength(1);
  });

  it('pins the globally latest historical selection without changing turn hashes', async () => {
    currentUserId = await createUser();
    const base = createPayload();
    const first = await turns.create(currentUserId, base, randomUUID());
    const historical = { mode: 'auto' as const, version: 2 as const };
    // Simulate an old deployment which allowed mixed selections and had no session snapshot.
    await resource.db
      .update(chatSessions)
      .set({ creativeDirectionSnapshotJson: null, creativeDirectionSnapshotHash: null })
      .where(eq(chatSessions.id, first.session_id));
    const preferences = { ...base.generation_preferences, creative_direction: historical };
    await resource.db
      .update(agentTurns)
      .set({
        generationPreferencesJson: preferences,
        generationPreferencesHash: canonicalSha256(preferences),
      })
      .where(eq(agentTurns.id, first.turn_id));
    const detail = await sessions.get(currentUserId, first.session_id, { limit: 1 });
    expect(detail.session.creative_direction_snapshot).toEqual({
      schema_version: 1,
      selection: historical,
    });
    await turns.create(
      currentUserId,
      { ...base, session_id: first.session_id, generation_preferences: preferences },
      randomUUID(),
    );
    expect(
      (await resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, first.turn_id) }))
        ?.generationPreferencesHash,
    ).toBe(canonicalSha256(preferences));
    expect(
      (
        await resource.db.query.chatSessions.findFirst({
          where: eq(chatSessions.id, first.session_id),
        })
      )?.creativeDirectionSnapshotJson,
    ).toEqual({ schema_version: 1, selection: historical });
  });

  it('locks the primary Skill direction to the session before creating a follow-up turn', async () => {
    currentUserId = await createUser();
    const created = await turns.create(currentUserId, createPayload(), randomUUID());
    await resource.db
      .update(chatSessions)
      .set({ primarySkillSlug: 'another-creative-direction' })
      .where(eq(chatSessions.id, created.session_id));

    await expect(
      turns.create(
        currentUserId,
        { ...createPayload(), session_id: created.session_id },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'SESSION_SKILL_MISMATCH' });

    const userTurns = await resource.db.query.agentTurns.findMany({
      where: eq(agentTurns.userId, currentUserId),
    });
    expect(userTurns).toHaveLength(1);
  });

  it('locks the selected Preset identity to the session', async () => {
    currentUserId = await createUser();
    const created = await turns.create(currentUserId, createPayload(), randomUUID());
    const firstTurn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, created.turn_id),
    });
    const firstSnapshot = firstTurn?.skillSelectionSnapshotJson as {
      preset_selections: Array<Record<string, unknown>>;
    };
    await resource.db
      .update(agentTurns)
      .set({
        skillSelectionSnapshotJson: {
          ...(firstTurn?.skillSelectionSnapshotJson as Record<string, unknown>),
          preset_selections: firstSnapshot.preset_selections.map((preset) => ({
            ...preset,
            preset_id: 'different-direction@1.0.0',
          })),
        },
      })
      .where(eq(agentTurns.id, created.turn_id));

    await expect(
      turns.create(
        currentUserId,
        { ...createPayload(), session_id: created.session_id },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'SESSION_SKILL_MISMATCH' });

    const userTurns = await resource.db.query.agentTurns.findMany({
      where: eq(agentTurns.userId, currentUserId),
    });
    expect(userTurns).toHaveLength(1);
  });

  it('returns 404 instead of 409 when the target session is archived', async () => {
    currentUserId = await createUser();
    const [archived] = await resource.db
      .insert(chatSessions)
      .values({
        userId: currentUserId,
        title: 'Archived session',
        archivedAt: new Date(),
      })
      .returning({ id: chatSessions.id });
    if (!archived) throw new Error('Expected archived session fixture');

    // `06`: an archived session is not a state conflict — it must read as missing.
    await expect(
      turns.create(
        currentUserId,
        { ...createPayload(), session_id: archived.id },
        `s08-archived-${randomUUID()}`,
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    const userTurns = await resource.db.query.agentTurns.findMany({
      where: eq(agentTurns.userId, currentUserId),
    });
    expect(userTurns).toHaveLength(0);
    // The archived session has no turn, so the per-user cleanup would miss it.
    await resource.db.delete(chatSessions).where(eq(chatSessions.id, archived.id));
  });

  it('rejects turn creation on a session that still carries a legacy-format turn', async () => {
    currentUserId = await createUser();
    const [legacySession] = await resource.db
      .insert(chatSessions)
      .values({
        userId: currentUserId,
        title: 'Legacy session',
        transcriptStateJson: {
          schema_version: 1,
          mode: 'off',
          integrity_version: 1,
          verified_through_sequence: '0',
          verified_digest: canonicalSha256([]),
        },
      })
      .returning({ id: chatSessions.id });
    if (!legacySession) throw new Error('Expected legacy session fixture');
    const [legacyTurn] = await resource.db
      .insert(agentTurns)
      .values({
        sessionId: legacySession.id,
        userId: currentUserId,
        status: 'done',
        executionFormat: 'legacy_v1',
      })
      .returning({ id: agentTurns.id });
    if (!legacyTurn) throw new Error('Expected legacy turn fixture');

    // A session whose first turn is legacy must never silently enter the transcript pipeline.
    await expect(
      turns.create(
        currentUserId,
        { ...createPayload(), session_id: legacySession.id },
        `s08-legacy-${randomUUID()}`,
      ),
    ).rejects.toMatchObject({ code: 'TURN_STATE_INVALID' });

    const turnCount = await resource.db.query.agentTurns.findMany({
      where: eq(agentTurns.userId, currentUserId),
    });
    expect(turnCount).toHaveLength(1);
    await resource.db.delete(agentTurns).where(eq(agentTurns.id, legacyTurn.id));
    await resource.db.delete(chatSessions).where(eq(chatSessions.id, legacySession.id));
  });

  it('restores the latest safe activity state from the turn outbox', async () => {
    currentUserId = await createUser();
    const created = await turns.create(
      currentUserId,
      createPayload(),
      `s08-activity-${randomUUID()}`,
    );
    const activityId = randomUUID();
    const commonPayload = {
      turn_id: created.turn_id,
      agent_trace_id: created.agent_trace_id,
      activity_id: activityId,
      activity_type: 'context_reading',
      display_summary: '正在读取已授权的上下文',
    };
    await resource.db.insert(eventOutbox).values([
      {
        scopeType: 'turn',
        scopeId: created.turn_id,
        eventSeq: 2,
        eventType: 'turn.activity_started',
        payload: { ...commonPayload, status: 'started' },
      },
      {
        scopeType: 'turn',
        scopeId: created.turn_id,
        eventSeq: 3,
        eventType: 'turn.activity_finished',
        payload: { ...commonPayload, status: 'succeeded' },
      },
    ]);

    const response = await request(app.getHttpServer() as Server).get(
      `/api/v1/agent/turns/${created.turn_id}`,
    );
    expect(response.status).toBe(200);
    const responseBody = response.body as {
      data: { activities: Array<Record<string, unknown>> };
    };
    expect(responseBody.data.activities).toEqual([
      {
        activity_id: activityId,
        activity_type: 'context_reading',
        display_summary: '正在读取已授权的上下文',
        status: 'succeeded',
      },
    ]);
    expect(JSON.stringify(responseBody.data.activities)).not.toContain('tool_name');
  });

  it('orders same-time turn messages with the user before the assistant regardless of UUID', async () => {
    currentUserId = await createUser();
    const created = await turns.create(currentUserId, createPayload(), `s08-order-${randomUUID()}`);
    const date = new Date('2026-09-01T00:00:00.000Z');
    await resource.db
      .update(chatMessages)
      .set({ createdAt: date })
      .where(eq(chatMessages.turnId, created.turn_id));
    await resource.db.insert(chatMessages).values({
      id: '00000000-0000-4000-8000-000000000010',
      sessionId: created.session_id,
      turnId: created.turn_id,
      role: 'assistant',
      content: 'Safe reply',
      attachments: [],
      createdAt: date,
    });
    expect(
      (await turns.get(currentUserId, created.turn_id)).messages.map((message) => message.role),
    ).toEqual(['user', 'assistant']);
  });

  it('restores only the active model step public draft and clears it by event', async () => {
    currentUserId = await createUser();
    const created = await turns.create(currentUserId, createPayload(), `s08-draft-${randomUUID()}`);
    const [step] = await resource.db
      .insert(agentTraceSteps)
      .values({
        traceId: created.agent_trace_id,
        stepNo: 1,
        stepType: 'llm_call',
        actor: 'agent',
        inputSummary: {},
        outputSummary: {},
        status: 'started',
      })
      .returning({ id: agentTraceSteps.id });
    if (!step) throw new Error('Expected draft step');
    const payload = {
      turn_id: created.turn_id,
      agent_trace_id: created.agent_trace_id,
      step_id: step.id,
    };
    await resource.db.insert(eventOutbox).values({
      scopeType: 'turn',
      scopeId: created.turn_id,
      eventSeq: 2,
      eventType: 'turn.response_draft_delta',
      payload: { ...payload, draft_seq: 1, text_delta: '公开草稿' },
    });
    const first = await request(app.getHttpServer() as Server).get(
      `/api/v1/agent/turns/${created.turn_id}`,
    );
    expect(first.status).toBe(200);
    expect((first.body as { data: { response_draft: unknown } }).data.response_draft).toEqual({
      step_id: step.id,
      draft_seq: 1,
      text: '公开草稿',
    });
    await resource.db.insert(eventOutbox).values({
      scopeType: 'turn',
      scopeId: created.turn_id,
      eventSeq: 3,
      eventType: 'turn.response_draft_cleared',
      payload,
    });
    const cleared = await request(app.getHttpServer() as Server).get(
      `/api/v1/agent/turns/${created.turn_id}`,
    );
    expect(cleared.status).toBe(200);
    expect((cleared.body as { data: { response_draft: unknown } }).data.response_draft).toBeNull();
  });

  it.each(['gap', 'duplicate', 'oversized', 'invalid_payload'] as const)(
    'drops a corrupt %s draft without breaking the owned turn snapshot',
    async (kind) => {
      currentUserId = await createUser();
      const created = await turns.create(
        currentUserId,
        createPayload(),
        `s08-corrupt-draft-${randomUUID()}`,
      );
      const [step] = await resource.db
        .insert(agentTraceSteps)
        .values({
          traceId: created.agent_trace_id,
          stepNo: 1,
          stepType: 'llm_call',
          actor: 'agent',
          inputSummary: {},
          outputSummary: {},
          status: 'started',
        })
        .returning({ id: agentTraceSteps.id });
      if (!step) throw new Error('Expected draft step');
      const sequences =
        kind === 'gap'
          ? [2]
          : kind === 'duplicate'
            ? [1, 1]
            : kind === 'oversized'
              ? Array.from({ length: 17 }, (_, index) => index + 1)
              : [1];
      await resource.db.insert(eventOutbox).values(
        sequences.map((sequence, index) => ({
          scopeType: 'turn' as const,
          scopeId: created.turn_id,
          eventSeq: index + 2,
          eventType: 'turn.response_draft_delta',
          payload: {
            turn_id: created.turn_id,
            agent_trace_id: created.agent_trace_id,
            step_id: step.id,
            draft_seq: sequence,
            text_delta: kind === 'oversized' ? 'a'.repeat(500) : 'controlled draft fixture',
            ...(kind === 'invalid_payload' ? { private_extra: 'must not be returned' } : {}),
          },
        })),
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await request(app.getHttpServer() as Server).get(
          `/api/v1/agent/turns/${created.turn_id}`,
        );
        expect(result.status).toBe(200);
        const data = (
          result.body as {
            data: {
              response_draft: unknown;
              messages: Array<{ role: string }>;
              user_status: string;
            };
          }
        ).data;
        expect(data.response_draft).toBeNull();
        expect(data.messages.map((message) => message.role)).toEqual(['user']);
        expect(data.user_status).toBe('thinking');
        expect(JSON.stringify(result.body)).not.toContain('must not be returned');
      }
      expect(
        await resource.db.query.agentTraceSteps.findFirst({
          where: eq(agentTraceSteps.id, step.id),
        }),
      ).toMatchObject({ status: 'started' });
    },
  );

  it('answers one clarification under concurrency and interrupts with immutable replay', async () => {
    currentUserId = await createUser();
    const created = await turns.create(
      currentUserId,
      createPayload(),
      `s08-confirm-create-${randomUUID()}`,
    );
    const createdSession = await resource.db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, created.session_id),
    });
    // `05` message_history_revision: creating the turn wrote exactly one user message.
    expect(createdSession?.messageHistoryRevision).toBe(1n);
    // Turn freeze: the execution format and capture version are written with the first turn, and
    // the session starts on an active native transcript checkpoint.
    const createdTurnRow = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, created.turn_id),
    });
    expect(createdTurnRow).toMatchObject({
      executionFormat: 'transcript_v1',
      transcriptCaptureVersion: 1,
    });
    expect(createdSession?.transcriptStateJson).toMatchObject({
      schema_version: 1,
      mode: 'active',
    });
    const confirmationId = randomUUID();
    const publicPayload = {
      schema_version: 1,
      question: '你更偏好哪种氛围？',
      options: [{ id: 'bright', label: '明亮' }],
      allow_free_text: true,
      max_response_chars: 2000,
    };
    await resource.db
      .update(agentTurns)
      .set({ status: 'waiting_user_confirmation' })
      .where(eq(agentTurns.id, created.turn_id));
    await resource.db.insert(agentTurnConfirmations).values({
      id: confirmationId,
      turnId: created.turn_id,
      userId: currentUserId,
      confirmationNo: 1,
      type: 'clarification',
      answerSchemaVersion: 1,
      publicPayloadJson: publicPayload,
      payloadDigest: canonicalSha256(publicPayload),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const confirmKey = `s08-confirm-${randomUUID()}`;
    const confirm = () =>
      confirmations.confirm(
        currentUserId!,
        created.turn_id,
        {
          confirmation_id: confirmationId,
          confirmation_type: 'clarification',
          confirmation_version: 1,
          answers: { selected_option_id: 'bright', response_text: '自然一些' },
        },
        confirmKey,
      );
    const confirmed = await Promise.all([confirm(), confirm()]);
    expect(confirmed[0]).toEqual(confirmed[1]);
    const confirmedSession = await resource.db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, created.session_id),
    });
    // The confirmation wrote one more message; the concurrent replay did not write a second one.
    expect(confirmedSession?.messageHistoryRevision).toBe(2n);
    const afterConfirm = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, created.turn_id),
    });
    expect(afterConfirm?.continuationNo).toBe(2);
    const continuationIntents = await resource.db.query.queueDispatchIntents.findMany({
      where: eq(queueDispatchIntents.aggregateId, created.turn_id),
    });
    expect(continuationIntents).toHaveLength(2);
    const trace = await resource.db.query.agentTraces.findFirst({
      where: eq(agentTraces.turnId, created.turn_id),
    });
    if (!trace) throw new Error('Expected Agent trace');
    const existingSteps = await resource.db.query.agentTraceSteps.findMany({
      where: eq(agentTraceSteps.traceId, trace.id),
    });
    await resource.db
      .update(agentTraces)
      .set({ reservedCost: '0.02' })
      .where(eq(agentTraces.id, trace.id));
    const [startedStep] = await resource.db
      .insert(agentTraceSteps)
      .values({
        traceId: trace.id,
        stepNo: existingSteps.length + 1,
        stepType: 'llm_call',
        actor: 'agent',
        inputSummary: { requested_input_tokens: 1, requested_max_output_tokens: 1_024 },
        outputSummary: {},
        status: 'started',
        estimatedCost: '0.02',
        modelSnapshotJson: trace.brainModelSnapshotJson,
      })
      .returning({ id: agentTraceSteps.id });
    if (!startedStep) throw new Error('Expected started LLM step');
    const interruptKey = `s08-interrupt-${randomUUID()}`;
    const stopped = await turns.interrupt(
      currentUserId,
      created.turn_id,
      { reason: 'user_requested' },
      interruptKey,
    );
    const replay = await turns.interrupt(
      currentUserId,
      created.turn_id,
      { reason: 'user_requested' },
      interruptKey,
    );
    expect(replay).toEqual(stopped);
    const events = await resource.db.query.eventOutbox.findMany({
      where: eq(eventOutbox.scopeId, created.turn_id),
    });
    expect(events.filter((item) => item.eventType === 'turn.interrupted')).toHaveLength(1);
    expect(events.filter((item) => item.eventType === 'turn.cancelled')).toHaveLength(1);
    const [interruptedTrace, interruptedStep] = await Promise.all([
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, trace.id) }),
      resource.db.query.agentTraceSteps.findFirst({
        where: eq(agentTraceSteps.id, startedStep.id),
      }),
    ]);
    expect(interruptedTrace?.reservedCost).toBe('0.02');
    expect(interruptedStep).toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_CALL_OUTCOME_UNKNOWN',
      estimatedCost: '0.02',
    });
  });

  it('fails closed when the approved package is disabled', async () => {
    currentUserId = await createUser();
    await resource.db
      .update(skillPackages)
      .set({ status: 'disabled', disabledAt: new Date(), disabledReason: 's08 test' })
      .where(eq(skillPackages.id, packageRecordId));
    try {
      await expect(
        turns.create(currentUserId, createPayload(), `s08-disabled-${randomUUID()}`),
      ).rejects.toMatchObject({ code: 'SKILL_SELECTION_INVALID' });
      const rows = await resource.db.query.agentTurns.findMany({
        where: eq(agentTurns.userId, currentUserId),
      });
      expect(rows).toHaveLength(0);
    } finally {
      await resource.db
        .update(skillPackages)
        .set({ status: 'approved', disabledAt: null, disabledReason: null })
        .where(eq(skillPackages.id, packageRecordId));
    }
  });

  it('authorizes turn event scope only for its owner', async () => {
    currentUserId = await createUser();
    const ownerId = currentUserId;
    const created = await turns.create(ownerId, createPayload(), `s08-event-scope-${randomUUID()}`);
    const outbox = new EventOutboxRepository(resource.db);
    await expect(outbox.isOwnedScope(ownerId, 'turn', created.turn_id)).resolves.toBe(true);
    const otherUserId = await createUser();
    await expect(outbox.isOwnedScope(otherUserId, 'turn', created.turn_id)).resolves.toBe(false);
    await expect(outbox.highWatermark('turn', created.turn_id)).resolves.toBe(1);

    const ownedRows = await outbox.listAfter('turn', created.turn_id, 0, 100);
    expect(ownedRows).toHaveLength(1);
    expect(ownedRows[0]).toMatchObject({ eventSeq: 1, eventType: 'turn.created' });
    expect(JSON.stringify(ownedRows)).not.toContain('skill_selection_snapshot_json');
  });
});
