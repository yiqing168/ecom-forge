import { randomUUID } from 'node:crypto';
import { stdin } from 'node:process';

import { deterministicFakeAgentModelSnapshot } from '@ecom-forge/agent';
import {
  agentSessionMutations,
  agentTranscriptItems,
  agentTranscriptPayloads,
  agentTraceSteps,
  agentTraces,
  agentTurnConfirmations,
  agentTurns,
  assetUploadIntents,
  authAccounts,
  authSessions,
  chatMessages,
  chatSessions,
  createDatabaseClient,
  eq,
  eventOutbox,
  inArray,
  modelCatalogEntries,
  models,
  pricingCatalogReleases,
  pricingCatalogState,
  providerCircuitStates,
  providerChannels,
  providerCredentialVersions,
  queueDispatchIntents,
  skillCatalogReleases,
  skillCatalogState,
  skillPackageResources,
  skillPackages,
  skillPackageValidationReports,
  skillResourceSnapshots,
  skills,
  userActivityLogs,
  users,
  workerHeartbeats,
} from '@ecom-forge/db';
import { canonicalSha256, utf8Sha256 } from '@ecom-forge/shared';
import { parseSkillDefinition } from '@ecom-forge/skills';

import { loadAppConfig } from '../src/config/app-config.js';
import { createBetterAuth } from '../src/modules/auth/better-auth.factory.js';

const USER_EMAIL = 's11-live-user@example.test';
const USER_PASSWORD = 'S11-live-user-password-123!';
const PACKAGE_ID = 's11-live-package';
const PROVIDER_KEY = 's11-live-fake';
const PRIMARY_SKILL_ID = 's11-live-creative@1.0.0';
const AUXILIARY_SKILL_ID = 's11-live-guidance@1.0.0';
const PRESET_ID = 's11-live-style@1.0.0';

type Database = ReturnType<typeof createDatabaseClient>['db'];

function cookieHeader(headers: Headers): string {
  const values =
    (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
  const cookie = values.map((value) => value.split(';', 1)[0]).join('; ');
  if (!cookie) throw new Error('S11 live fixture did not receive a session cookie');
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
  if (process.env.S11_LIVE_E2E !== '1') {
    throw new Error('This fixture is restricted to the S11 live E2E harness');
  }
  const url = new URL(databaseUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const databaseName = url.pathname.replace(/^\//, '').toLowerCase();
  if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
    throw new Error('S11 live E2E requires a loopback database');
  }
  if (!/_test(?:_|$)/.test(databaseName)) {
    throw new Error('S11 live E2E database name must contain _test');
  }
}

async function cleanupUser(database: Database): Promise<void> {
  const user = await database.query.users.findFirst({ where: eq(users.email, USER_EMAIL) });
  if (!user) return;
  const turns = await database.query.agentTurns.findMany({
    where: eq(agentTurns.userId, user.id),
    columns: { id: true, sessionId: true },
  });
  const turnIds = turns.map((turn) => turn.id);
  const sessionIds = [...new Set(turns.map((turn) => turn.sessionId))];
  await database.delete(agentTranscriptItems).where(eq(agentTranscriptItems.userId, user.id));
  await database.delete(agentTranscriptPayloads).where(eq(agentTranscriptPayloads.userId, user.id));
  const traces =
    turnIds.length > 0
      ? await database.query.agentTraces.findMany({
          where: inArray(agentTraces.turnId, turnIds),
          columns: { id: true },
        })
      : [];
  if (traces.length > 0) {
    await database.delete(agentTraceSteps).where(
      inArray(
        agentTraceSteps.traceId,
        traces.map((trace) => trace.id),
      ),
    );
  }
  if (turnIds.length > 0) {
    await database.delete(eventOutbox).where(inArray(eventOutbox.scopeId, turnIds));
    await database
      .delete(queueDispatchIntents)
      .where(inArray(queueDispatchIntents.aggregateId, turnIds));
    await database
      .delete(agentTurnConfirmations)
      .where(inArray(agentTurnConfirmations.turnId, turnIds));
    await database.delete(chatMessages).where(inArray(chatMessages.turnId, turnIds));
    await database.delete(agentTraces).where(inArray(agentTraces.turnId, turnIds));
    await database.delete(agentTurns).where(inArray(agentTurns.id, turnIds));
  }
  if (sessionIds.length > 0) {
    await database
      .delete(agentSessionMutations)
      .where(inArray(agentSessionMutations.sessionId, sessionIds));
    await database.delete(chatMessages).where(inArray(chatMessages.sessionId, sessionIds));
    await database.delete(chatSessions).where(inArray(chatSessions.id, sessionIds));
  }
  await database.delete(authSessions).where(eq(authSessions.userId, user.id));
  await database.delete(authAccounts).where(eq(authAccounts.userId, user.id));
  await database.delete(userActivityLogs).where(eq(userActivityLogs.userId, user.id));
  await database.delete(assetUploadIntents).where(eq(assetUploadIntents.userId, user.id));
  await database.delete(users).where(eq(users.id, user.id));
}

async function cleanupSkillCatalog(database: Database): Promise<void> {
  const packageRow = await database.query.skillPackages.findFirst({
    where: eq(skillPackages.packageId, PACKAGE_ID),
  });
  const releases = await database.query.skillCatalogReleases.findMany();
  const fixtureReleases = releases.filter((release) => {
    return release.reason === 'S11 live browser fixture';
  });
  if (fixtureReleases.length > 0) {
    const fixtureReleaseIds = fixtureReleases.map((release) => release.id);
    const latestFixtureReleaseNo = Math.max(...fixtureReleases.map((release) => release.releaseNo));
    const previousRelease = releases
      .filter(
        (release) =>
          !fixtureReleaseIds.includes(release.id) &&
          release.status === 'published' &&
          release.releaseNo < latestFixtureReleaseNo,
      )
      .sort((left, right) => right.releaseNo - left.releaseNo)[0];
    await database
      .update(skillCatalogState)
      .set({ activeReleaseId: previousRelease?.id ?? null })
      .where(inArray(skillCatalogState.activeReleaseId, fixtureReleaseIds));
    await database
      .delete(skillCatalogReleases)
      .where(inArray(skillCatalogReleases.id, fixtureReleaseIds));
  }
  await database
    .delete(skillResourceSnapshots)
    .where(inArray(skillResourceSnapshots.skillId, [PRIMARY_SKILL_ID, AUXILIARY_SKILL_ID]));
  await database.delete(skills).where(inArray(skills.id, [PRIMARY_SKILL_ID, AUXILIARY_SKILL_ID]));
  if (!packageRow) return;
  await database
    .update(skillPackages)
    .set({ latestValidationReportId: null, approvedValidationReportId: null })
    .where(eq(skillPackages.id, packageRow.id));
  await database
    .delete(skillPackageValidationReports)
    .where(eq(skillPackageValidationReports.packageRecordId, packageRow.id));
  await database
    .delete(skillPackageResources)
    .where(eq(skillPackageResources.packageRecordId, packageRow.id));
  await database.delete(skillPackages).where(eq(skillPackages.id, packageRow.id));
}

async function cleanupModelCatalog(database: Database): Promise<void> {
  const channels = await database.query.providerChannels.findMany({
    where: eq(providerChannels.provider, PROVIDER_KEY),
  });
  const channelIds = channels.map((channel) => channel.id);
  const modelRows =
    channelIds.length > 0
      ? await database.query.models.findMany({
          where: inArray(models.providerChannelId, channelIds),
          columns: { id: true },
        })
      : [];
  const modelIds = modelRows.map((model) => model.id);
  const catalogRows =
    modelIds.length > 0
      ? await database.query.modelCatalogEntries.findMany({
          where: inArray(modelCatalogEntries.modelSnapshotId, modelIds),
          columns: { id: true },
        })
      : [];
  const catalogIds = catalogRows.map((entry) => entry.id);
  const releases = await database.query.pricingCatalogReleases.findMany();
  const fixtureReleases = releases.filter((release) => {
    return release.reason === 'S11 live browser fixture';
  });
  if (fixtureReleases.length > 0) {
    const fixtureReleaseIds = fixtureReleases.map((release) => release.id);
    const latestFixtureReleaseNo = Math.max(...fixtureReleases.map((release) => release.releaseNo));
    const previousRelease = releases
      .filter(
        (release) =>
          !fixtureReleaseIds.includes(release.id) &&
          release.status === 'published' &&
          release.releaseNo < latestFixtureReleaseNo,
      )
      .sort((left, right) => right.releaseNo - left.releaseNo)[0];
    await database
      .update(pricingCatalogState)
      .set({ activeReleaseId: previousRelease?.id ?? null })
      .where(inArray(pricingCatalogState.activeReleaseId, fixtureReleaseIds));
    await database
      .delete(pricingCatalogReleases)
      .where(inArray(pricingCatalogReleases.id, fixtureReleaseIds));
  }
  if (catalogIds.length > 0) {
    await database.delete(modelCatalogEntries).where(inArray(modelCatalogEntries.id, catalogIds));
  }
  if (modelIds.length > 0) {
    await database
      .delete(providerCircuitStates)
      .where(inArray(providerCircuitStates.modelId, modelIds));
    await database.delete(models).where(inArray(models.id, modelIds));
  }
  if (channelIds.length > 0) {
    await database
      .update(providerChannels)
      .set({ activeCredentialVersionId: null })
      .where(inArray(providerChannels.id, channelIds));
    await database
      .delete(providerCredentialVersions)
      .where(inArray(providerCredentialVersions.providerChannelId, channelIds));
    await database.delete(providerChannels).where(inArray(providerChannels.id, channelIds));
  }
}

async function cleanup(database: Database, workerId?: string): Promise<void> {
  if (workerId) await database.delete(workerHeartbeats).where(eq(workerHeartbeats.id, workerId));
  await cleanupUser(database);
  await cleanupSkillCatalog(database);
  await cleanupModelCatalog(database);
}

async function installSkillCatalog(database: Database) {
  const packageRecordId = randomUUID();
  const validationReportId = randomUUID();
  const releaseId = randomUUID();
  const resourceContent = (path: string) => `# S11 live ${path}\n\nCREATIVE_DECISION_PROTOCOL:v1`;
  const primaryPlanningHash = utf8Sha256(resourceContent('SKILL.md'));
  const presetHash = utf8Sha256(resourceContent('presets/live-style.md'));
  const auxiliaryPlanningHash = utf8Sha256(resourceContent('SKILL.md'));
  const primaryDefinition = parseSkillDefinition({
    schema_version: 1,
    slug: 's11-live-creative',
    version: '1.0.0',
    display_name: 'S11 Live Creative',
    description: 'Isolated creative Skill for the S11 live browser flow.',
    kind: 'primary',
    visibility: 'public',
    domain: 'commerce',
    category: 's11-live',
    stage: '1A',
    sort_order: 1,
    required_capabilities: ['image.edit'],
    planning_view: { path: 'SKILL.md', content_hash: primaryPlanningHash },
    preset_slots: [
      {
        slot: 'style',
        label: 'Style',
        required: true,
        max_selections: 1,
        options: [
          {
            preset_id: PRESET_ID,
            name: 'S11 Live Style',
            description: 'A deterministic style used only by the live acceptance flow.',
            resource_path: 'presets/live-style.md',
            resource_hash: presetHash,
          },
        ],
      },
    ],
    dependencies: [
      { skill_id: AUXILIARY_SKILL_ID, mode: 'required', reason: 'Live fixture guidance' },
    ],
  });
  const auxiliaryDefinition = parseSkillDefinition({
    schema_version: 1,
    slug: 's11-live-guidance',
    version: '1.0.0',
    display_name: 'S11 Live Guidance',
    description: 'Required isolated guidance for the S11 live browser flow.',
    kind: 'auxiliary',
    visibility: 'internal',
    domain: 'commerce',
    category: 's11-live',
    stage: '1A',
    planning_view: { path: 'SKILL.md', content_hash: auxiliaryPlanningHash },
  });
  const packageDigest = canonicalSha256({ fixture: 's11-live', packageRecordId });
  await database.insert(skillPackages).values({
    id: packageRecordId,
    packageId: PACKAGE_ID,
    packageVersion: '1.0.0',
    packageDigest,
    archiveSha256: canonicalSha256({ fixture: 's11-live-archive', packageRecordId }),
    manifestJson: { schema_version: 1, fixture: 's11-live' },
    status: 'approved',
    riskStatus: 'clear',
    sourceType: 'first_party',
    quarantineStorageKey: `s11-live/${packageRecordId}`,
    uploadExpiresAt: new Date(Date.now() + 60_000),
    approvedBy: 's11-live',
    approvedAt: new Date(),
  });
  const resourceInputs = [
    {
      skillId: PRIMARY_SKILL_ID,
      path: 'SKILL.md',
      type: 'planning_view' as const,
      contentHash: primaryPlanningHash,
    },
    {
      skillId: PRIMARY_SKILL_ID,
      path: 'presets/live-style.md',
      type: 'preset' as const,
      contentHash: presetHash,
    },
    {
      skillId: AUXILIARY_SKILL_ID,
      path: 'SKILL.md',
      type: 'planning_view' as const,
      contentHash: auxiliaryPlanningHash,
    },
  ];
  const packageResources = await database
    .insert(skillPackageResources)
    .values(
      resourceInputs.map((item) => ({
        packageRecordId,
        resourcePath: `${item.skillId}/${item.path}`,
        resourceType: item.type,
        mediaType: 'text/markdown',
        byteSize: Buffer.byteLength(resourceContent(item.path)),
        contentHash: item.contentHash,
        storageKey: `s11-live/${packageRecordId}/${item.skillId}/${item.path}`,
        skillId: item.skillId,
        rightsMetadataJson: { source: 'first_party', fixture: 's11-live' },
      })),
    )
    .returning();
  const primaryDefinitionHash = canonicalSha256(primaryDefinition);
  const auxiliaryDefinitionHash = canonicalSha256(auxiliaryDefinition);
  await database.insert(skills).values([
    {
      id: PRIMARY_SKILL_ID,
      slug: primaryDefinition.slug,
      name: primaryDefinition.display_name,
      category: primaryDefinition.category,
      domain: primaryDefinition.domain,
      kind: 'primary',
      visibility: 'public',
      stage: '1A',
      version: '1.0.0',
      packageRecordId,
      skillDigest: canonicalSha256({ fixture: 's11-live-primary' }),
      definitionJson: primaryDefinition,
      definitionHash: primaryDefinitionHash,
      sortOrder: 1,
      price: {},
      status: 'published',
      publishedAt: new Date(),
    },
    {
      id: AUXILIARY_SKILL_ID,
      slug: auxiliaryDefinition.slug,
      name: auxiliaryDefinition.display_name,
      category: auxiliaryDefinition.category,
      domain: auxiliaryDefinition.domain,
      kind: 'auxiliary',
      visibility: 'internal',
      stage: '1A',
      version: '1.0.0',
      packageRecordId,
      skillDigest: canonicalSha256({ fixture: 's11-live-auxiliary' }),
      definitionJson: auxiliaryDefinition,
      definitionHash: auxiliaryDefinitionHash,
      sortOrder: 2,
      price: {},
      status: 'published',
      publishedAt: new Date(),
    },
  ]);
  const snapshots = resourceInputs.map((item, index) => ({
    id: randomUUID(),
    skillId: item.skillId,
    resourcePath: item.path,
    resourceType: item.type,
    contentHash: item.contentHash,
    packageResourceId: packageResources[index]!.id,
    contentText: resourceContent(item.path),
    kvKey: `s11-live:${packageRecordId}:${index}`,
    summaryJson: { fixture: 's11-live' },
  }));
  await database.insert(skillResourceSnapshots).values(snapshots);
  const reportDigest = canonicalSha256({ fixture: 's11-live-validation', packageRecordId });
  await database.insert(skillPackageValidationReports).values({
    id: validationReportId,
    packageRecordId,
    packageRevision: 1,
    packageDigest,
    attemptNo: 1,
    status: 'passed',
    validatorContractVersion: 's11-live-v1',
    platformEvalSuiteDigest: canonicalSha256({ fixture: 's11-live-eval' }),
    reportJson: { passed: true, fixture: 's11-live' },
    reportDigest,
    completedAt: new Date(),
  });
  await database
    .update(skillPackages)
    .set({
      latestValidationReportId: validationReportId,
      approvedValidationReportId: validationReportId,
    })
    .where(eq(skillPackages.id, packageRecordId));
  const resourceManifest = (skillId: string) =>
    snapshots
      .filter((snapshot) => snapshot.skillId === skillId)
      .map((snapshot) => ({
        skill_resource_snapshot_id: snapshot.id,
        package_resource_id: snapshot.packageResourceId,
        resource_path: snapshot.resourcePath,
        content_hash: snapshot.contentHash,
      }));
  const existingReleases = await database.query.skillCatalogReleases.findMany({
    columns: { releaseNo: true },
  });
  const releaseNo = Math.max(0, ...existingReleases.map((release) => release.releaseNo)) + 1;
  const releaseManifest = {
    schema_version: 1 as const,
    packages: [
      {
        package_record_id: packageRecordId,
        validation_report_id: validationReportId,
        package_digest: packageDigest,
        skills: [
          {
            skill_id: PRIMARY_SKILL_ID,
            definition_hash: primaryDefinitionHash,
            resources: resourceManifest(PRIMARY_SKILL_ID),
          },
          {
            skill_id: AUXILIARY_SKILL_ID,
            definition_hash: auxiliaryDefinitionHash,
            resources: resourceManifest(AUXILIARY_SKILL_ID),
          },
        ],
      },
    ],
  };
  await database.insert(skillCatalogReleases).values({
    id: releaseId,
    releaseNo,
    status: 'published',
    releaseDigest: canonicalSha256(releaseManifest),
    manifestJson: releaseManifest,
    reason: 'S11 live browser fixture',
    createdBy: 's11-live',
    approvedBy: 's11-live',
    publishedAt: new Date(),
  });
  await database
    .insert(skillCatalogState)
    .values({ id: 'global', activeReleaseId: releaseId })
    .onConflictDoUpdate({ target: skillCatalogState.id, set: { activeReleaseId: releaseId } });
  return { releaseId };
}

async function installModelCatalog(database: Database) {
  const releaseId = randomUUID();
  const channelId = randomUUID();
  const credentialId = randomUUID();
  const brainModelId = randomUUID();
  const imageModelId = randomUUID();
  const brainCatalogEntryId = randomUUID();
  const imageCatalogEntryId = randomUUID();
  const currentState = await database.query.pricingCatalogState.findFirst({
    where: eq(pricingCatalogState.id, 'global'),
  });
  const existingReleases = await database.query.pricingCatalogReleases.findMany({
    columns: { releaseNo: true },
  });
  const releaseNo = Math.max(0, ...existingReleases.map((release) => release.releaseNo)) + 1;
  const catalogRevision = (currentState?.catalogRevision ?? 0) + 1;
  await database.insert(providerChannels).values({
    id: channelId,
    provider: PROVIDER_KEY,
    adapterKey: 'fake-provider-v1',
    baseUrl: 'https://local.invalid',
    displayName: 'S11 Live Provider',
    endpointProfileKey: `s11-live-${channelId}`,
    status: 'active',
  });
  await database.insert(providerCredentialVersions).values({
    id: credentialId,
    providerChannelId: channelId,
    versionNo: 1,
    secretCiphertext: 's11-live-ciphertext',
    secretNonce: 's11-live-nonce',
    secretAuthTag: 's11-live-auth-tag',
    secretKeyId: 's11-live-key',
    keyHint: 'live-test',
    status: 'active',
    validationEvidenceDigest: canonicalSha256({ fixture: 's11-live-credential' }),
    verifiedAt: new Date(),
    activatedAt: new Date(),
  });
  await database
    .update(providerChannels)
    .set({ activeCredentialVersionId: credentialId })
    .where(eq(providerChannels.id, channelId));
  const fakeBrain = deterministicFakeAgentModelSnapshot({
    maxInputTokens: 96_000,
    maxOutputTokens: 8_192,
    supportsImageInput: true,
  });
  const imageCapability = {
    schema_version: 2 as const,
    contract_kind: 'media' as const,
    media_kind: 'image' as const,
    capabilities: ['image.generate' as const, 'image.edit' as const],
    specs: [
      {
        kind: 'image' as const,
        spec_key: 's11-live-image-1k-square',
        operation: 'image.generate' as const,
        mode: 'text-to-image',
        resolution_tier: '1k' as const,
        aspect_ratios: ['1:1'],
        max_outputs: 4,
        max_reference_images: 4,
        transparent_background: false,
        output_formats: ['png' as const],
      },
      {
        kind: 'image' as const,
        spec_key: 's11-live-image-edit-1k-square',
        operation: 'image.edit' as const,
        mode: 'image-to-image',
        resolution_tier: '1k' as const,
        aspect_ratios: ['1:1'],
        max_outputs: 4,
        max_reference_images: 4,
        transparent_background: false,
        output_formats: ['png' as const],
      },
    ],
  };
  await database.insert(models).values([
    {
      id: brainModelId,
      provider: PROVIDER_KEY,
      providerChannelId: channelId,
      modelId: 's11-live-brain',
      version: '1',
      capabilityContractJson: fakeBrain.capability_contract,
      pricingJson: fakeBrain.pricing,
      quotaJson: fakeBrain.quota,
      status: 'poc_passed',
      statusEvidenceDigest: canonicalSha256({ fixture: 's11-live-brain-poc' }),
    },
    {
      id: imageModelId,
      provider: PROVIDER_KEY,
      providerChannelId: channelId,
      modelId: 's11-live-image',
      version: '1',
      capabilityContractJson: imageCapability,
      pricingJson: {
        schema_version: 2,
        contract_kind: 'media_rate_card',
        currency: 'CNY',
        rate_cards: [
          {
            rate_key: 's11-live-image-1k-square',
            spec_key: 's11-live-image-1k-square',
            billing_unit: 'image',
            unit_cost_cny: '0.10',
          },
          {
            rate_key: 's11-live-image-edit-1k-square',
            spec_key: 's11-live-image-edit-1k-square',
            billing_unit: 'image',
            unit_cost_cny: '0.10',
          },
        ],
        overhead_cny: { tool: '0.00', storage: '0.00', traffic: '0.00', agent_brain: '0.01' },
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
      statusEvidenceDigest: canonicalSha256({ fixture: 's11-live-image-poc' }),
    },
  ]);
  const rollout = { stage: 'test' as const, percentage: 100 };
  const entries = [
    {
      id: brainCatalogEntryId,
      model_snapshot_id: brainModelId,
      public_slug: 's11-live-brain',
      version_no: 1,
      category: 'brain' as const,
      display_name: 'S11 Live Brain',
      description: 'Deterministic local Brain for S11 live acceptance.',
      public_capabilities: { input: ['text'] },
      rollout,
      user_selectable: true,
      is_default: true,
      sort_order: 1,
      revision: 1,
    },
    {
      id: imageCatalogEntryId,
      model_snapshot_id: imageModelId,
      public_slug: 's11-live-image',
      version_no: 1,
      category: 'image' as const,
      display_name: 'S11 Live Image',
      description: 'Catalog-only image model for S11 workbench selection.',
      public_capabilities: { resolutions: ['1k'], aspect_ratios: ['1:1'] },
      rollout,
      user_selectable: true,
      is_default: true,
      sort_order: 2,
      revision: 1,
    },
  ];
  await database.insert(modelCatalogEntries).values(
    entries.map((entry) => ({
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
    entries,
    skus: [],
    defaults: { brain: brainCatalogEntryId, image: imageCatalogEntryId },
  };
  await database.insert(pricingCatalogReleases).values({
    id: releaseId,
    releaseNo,
    status: 'published',
    manifestJson: manifest,
    releaseDigest: canonicalSha256(manifest),
    reason: 'S11 live browser fixture',
    publishedAt: new Date(),
  });
  await database
    .insert(pricingCatalogState)
    .values({ id: 'global', activeReleaseId: releaseId, catalogRevision })
    .onConflictDoUpdate({
      target: pricingCatalogState.id,
      set: { activeReleaseId: releaseId, catalogRevision },
    });
  return { brainCatalogEntryId, catalogRevision, imageCatalogEntryId, releaseId };
}

async function setup(database: Database) {
  await cleanup(database);
  try {
    await installSkillCatalog(database);
    const modelCatalog = await installModelCatalog(database);
    const config = loadAppConfig();
    const auth = createBetterAuth(database, config);
    await auth.api.signUpEmail({
      body: { email: USER_EMAIL, password: USER_PASSWORD, name: 'S11 Live User' },
      returnHeaders: true,
    });
    await database
      .update(users)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.email, USER_EMAIL));
    const login = await auth.api.signInEmail({
      body: { email: USER_EMAIL, password: USER_PASSWORD },
      returnHeaders: true,
    });
    return {
      user_cookie: cookieHeader(login.headers),
      user_email: USER_EMAIL,
      primary_skill_id: PRIMARY_SKILL_ID,
      preset_id: PRESET_ID,
      brain_catalog_entry_id: modelCatalog.brainCatalogEntryId,
      image_catalog_entry_id: modelCatalog.imageCatalogEntryId,
      catalog_revision: modelCatalog.catalogRevision,
    };
  } catch (error) {
    await cleanup(database);
    throw error;
  }
}

async function run(): Promise<void> {
  const action = process.argv[2];
  if (!action || !['setup', 'cleanup'].includes(action) || process.argv.length > 3) {
    throw new Error('Expected exactly one action: setup or cleanup');
  }
  const input = JSON.parse((await readStdin()) || '{}') as { workerId?: unknown };
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  assertEnvironment(databaseUrl);
  const resource = createDatabaseClient({ databaseUrl });
  try {
    const result =
      action === 'setup'
        ? await setup(resource.db)
        : (await cleanup(
            resource.db,
            typeof input.workerId === 'string' ? input.workerId : undefined,
          ),
          { status: 'cleaned' });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await resource.client.end();
  }
}

await run();
