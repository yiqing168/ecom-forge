import { randomUUID } from 'node:crypto';
import { stdin } from 'node:process';

import { grantRegistrationCredits } from '@ecom-forge/credit';
import {
  adminPrincipals,
  agentTraceSteps,
  agentTraces,
  agentTurns,
  artifactEvaluations,
  artifactInputBindings,
  artifacts,
  assets,
  assetUploadIntents,
  billableSkus,
  contentReviewCases,
  contentSafetyPreflights,
  createDatabaseClient,
  creditAccounts,
  creditLedger,
  creditReservations,
  eq,
  eventOutbox,
  inArray,
  modelCatalogEntries,
  modelPocRuns,
  models,
  moderationRuntimeStates,
  pricingCatalogReleases,
  pricingCatalogState,
  products,
  productFactSets,
  providerCircuitStates,
  providerChannels,
  providerCredentialVersions,
  queueDispatchIntents,
  registrationRewardClaims,
  resourceWriteRequests,
  runQuotes,
  storageChannels,
  storageCredentialVersions,
  storageRuntimeState,
  storageValidationRuns,
  taskAttempts,
  tasks,
  users,
  workflowRuns,
} from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';

const USER_EMAIL = 's11-live-user@example.test';
const FIXTURE_REASON = 'S12 live browser fixture';

type Database = ReturnType<typeof createDatabaseClient>['db'];

async function readStdin(): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) {
    if (typeof chunk === 'string') chunks.push(chunk);
  }
  return JSON.parse(chunks.join('') || '{}') as Record<string, unknown>;
}

function assertEnvironment(databaseUrl: string): void {
  if (process.env.S12_LIVE_E2E !== '1') throw new Error('S12 live fixture is not enabled');
  const url = new URL(databaseUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
    throw new Error('S12 live fixture requires a loopback database');
  }
  if (!/_test(?:_|$)/.test(url.pathname.replace(/^\//, '').toLowerCase())) {
    throw new Error('S12 live fixture requires a test database');
  }
}

async function setup(database: Database) {
  const user = await database.query.users.findFirst({ where: eq(users.email, USER_EMAIL) });
  const catalogState = await database.query.pricingCatalogState.findFirst({
    where: eq(pricingCatalogState.id, 'global'),
  });
  const release = catalogState?.activeReleaseId
    ? await database.query.pricingCatalogReleases.findFirst({
        where: eq(pricingCatalogReleases.id, catalogState.activeReleaseId),
      })
    : undefined;
  if (!user || !release) throw new Error('S11 live base fixture must be installed first');
  const manifest = release.manifestJson as {
    entries?: Array<Record<string, unknown>>;
    defaults?: Record<string, string>;
  };
  const imageEntryId = manifest.defaults?.image;
  const imageEntry = imageEntryId
    ? await database.query.modelCatalogEntries.findFirst({
        where: eq(modelCatalogEntries.id, imageEntryId),
      })
    : undefined;
  if (!imageEntry) throw new Error('S12 live image catalog entry is missing');

  const suffix = randomUUID();
  const adminId = randomUUID();
  const moderationChannelId = randomUUID();
  const moderationCredentialId = randomUUID();
  const textModerationModelId = randomUUID();
  const imageModerationModelId = randomUUID();
  const storageChannelId = randomUUID();
  const storageCredentialId = randomUUID();
  const storageValidationId = randomUUID();
  const skuId = randomUUID();
  const claimId = randomUUID();
  const textEvidence = canonicalSha256({ fixture: 's12-live-text-moderation', suffix });
  const imageEvidence = canonicalSha256({ fixture: 's12-live-image-moderation', suffix });
  const storageEvidence = canonicalSha256({ fixture: 's12-live-storage', suffix });

  await database.insert(adminPrincipals).values({
    id: adminId,
    identifierHash: `s12-live-${suffix}`,
    identifierKeyId: 'test-key',
    identifierHint: 's12-live',
    displayName: 'S12 live fixture',
    status: 'active',
  });
  await database.insert(providerChannels).values({
    id: moderationChannelId,
    provider: 'fake',
    adapterKey: 'fake-provider-v1',
    displayName: 'S12 Live Moderation',
    baseUrl: `https://s12-live-${suffix}.invalid`,
    endpointProfileKey: 'local',
    status: 'active',
  });
  await database.insert(providerCredentialVersions).values({
    id: moderationCredentialId,
    providerChannelId: moderationChannelId,
    versionNo: 1,
    secretCiphertext: 'fixture',
    secretNonce: 'fixture',
    secretAuthTag: 'fixture',
    secretKeyId: 'fixture',
    keyHint: 'fixture',
    status: 'active',
    validationEvidenceDigest: canonicalSha256({ fixture: 's12-live-credential', suffix }),
    verifiedAt: new Date(),
    activatedAt: new Date(),
  });
  await database
    .update(providerChannels)
    .set({ activeCredentialVersionId: moderationCredentialId })
    .where(eq(providerChannels.id, moderationChannelId));

  const moderationContract = (capability: 'moderation.text' | 'moderation.image') => ({
    schema_version: 1,
    capabilities: [capability],
    aspect_ratios: [],
    resolutions: [],
    max_outputs: 1,
    max_reference_images: capability === 'moderation.image' ? 1 : 0,
  });
  const moderationPricing = {
    schema_version: 1,
    currency: 'CNY',
    provider_unit_cost_cny: '0.01',
    tool_cost_cny: '0.00',
    storage_cost_cny: '0.00',
    traffic_cost_cny: '0.00',
    agent_brain_cost_cny: '0.00',
    failure_rate: '0.00',
    unknown_rate: '0.00',
    refund_rate: '0.00',
    risk_reserve_rate: '0.00',
    gross_margin_target: '0.50',
    credit_cny_anchor: '0.01',
  };
  const moderationQuota = {
    schema_version: 1,
    rpm: 1_000,
    concurrency: 10,
    hourly_budget_cny: '100.00',
    daily_budget_cny: '1000.00',
    poll_initial_delay_ms: 10,
    poll_interval_ms: 10,
    max_poll_count: 1,
    terminal_timeout_ms: 30_000,
    circuit_sample_size: 20,
    circuit_failure_rate: '0.50',
    circuit_unknown_rate: '0.25',
    circuit_open_ms: 60_000,
  };
  await database.insert(models).values([
    {
      id: textModerationModelId,
      provider: 'fake',
      providerChannelId: moderationChannelId,
      modelId: `s12-live-text-moderation-${suffix}`,
      version: '1',
      capabilityContractJson: moderationContract('moderation.text'),
      pricingJson: moderationPricing,
      quotaJson: moderationQuota,
      status: 'poc_passed',
      statusEvidenceDigest: textEvidence,
    },
    {
      id: imageModerationModelId,
      provider: 'fake',
      providerChannelId: moderationChannelId,
      modelId: `s12-live-image-moderation-${suffix}`,
      version: '1',
      capabilityContractJson: moderationContract('moderation.image'),
      pricingJson: moderationPricing,
      quotaJson: moderationQuota,
      status: 'poc_passed',
      statusEvidenceDigest: imageEvidence,
    },
  ]);
  await database
    .insert(modelPocRuns)
    .values([
      pocRun(textModerationModelId, 'moderation.text', textEvidence),
      pocRun(imageModerationModelId, 'moderation.image', imageEvidence),
    ]);

  const previousTextRuntime = await setModerationRuntime(
    database,
    'moderation.text',
    textModerationModelId,
  );
  const previousImageRuntime = await setModerationRuntime(
    database,
    'moderation.image',
    imageModerationModelId,
  );

  await database.insert(storageChannels).values({
    id: storageChannelId,
    purpose: 'private_assets',
    adapterKey: 'local-private-v1',
    endpointProfileKey: 'local',
    bucket: `s12-live-${suffix}`,
    rootPrefix: `s12-live/${suffix}`,
    status: 'active',
    createdByAdminId: adminId,
  });
  await database.insert(storageCredentialVersions).values({
    id: storageCredentialId,
    storageChannelId,
    versionNo: 1,
    secretBundleCiphertext: 'fixture',
    secretNonce: 'fixture',
    secretAuthTag: 'fixture',
    secretKeyId: 'fixture',
    keyHint: 'fixture',
    status: 'active',
    validationEvidenceDigest: storageEvidence,
    verifiedAt: new Date(),
    activatedAt: new Date(),
  });
  await database
    .update(storageChannels)
    .set({ activeCredentialVersionId: storageCredentialId })
    .where(eq(storageChannels.id, storageChannelId));
  await database.insert(storageValidationRuns).values({
    id: storageValidationId,
    storageChannelId,
    credentialVersionId: storageCredentialId,
    probeContractVersion: 'local-private@1',
    status: 'passed',
    evidenceDigest: storageEvidence,
    probePrefixDigest: canonicalSha256({ prefix: suffix }),
    requestedByAdminId: adminId,
    completedAt: new Date(),
  });
  const previousStorage = await database.query.storageRuntimeState.findFirst({
    where: eq(storageRuntimeState.purpose, 'private_assets'),
  });
  await database
    .insert(storageRuntimeState)
    .values({
      purpose: 'private_assets',
      activeChannelId: storageChannelId,
      runtimeRevision: (previousStorage?.runtimeRevision ?? 0) + 1,
    })
    .onConflictDoUpdate({
      target: storageRuntimeState.purpose,
      set: {
        activeChannelId: storageChannelId,
        runtimeRevision: (previousStorage?.runtimeRevision ?? 0) + 1,
      },
    });

  const matcher = {
    schema_version: 1,
    kind: 'image',
    mode: 'image-to-image',
    resolution: '1k',
    transparent_background: false,
    reference_tier: 'standard',
  };
  const sku = {
    id: skuId,
    logical_sku_key: 's12-live-image-1k',
    version_no: 1,
    model_catalog_entry_id: imageEntry.id,
    operation: 'image.edit' as const,
    matcher,
    matcher_hash: canonicalSha256(matcher),
    unit_kind: 'image' as const,
    unit_rule: { min_quantity: 1, max_quantity: 4, step_quantity: 1 },
    credits_per_unit: '2.00',
    provider_rate_card_key: 's11-live-image-edit-1k-square',
    provider_cost_per_unit_cny: '0.10',
    revision: 1,
  };
  await database.insert(billableSkus).values({
    id: sku.id,
    logicalSkuKey: sku.logical_sku_key,
    versionNo: sku.version_no,
    modelCatalogEntryId: sku.model_catalog_entry_id,
    operation: sku.operation,
    matcherJson: sku.matcher,
    matcherHash: sku.matcher_hash,
    unitKind: sku.unit_kind,
    unitRuleJson: sku.unit_rule,
    providerRateCardKey: sku.provider_rate_card_key,
    providerCostPerUnitCny: sku.provider_cost_per_unit_cny,
    creditsPerUnit: sku.credits_per_unit,
    status: 'approved',
    approvedAt: new Date(),
  });
  const nextManifest = {
    schema_version: 2,
    entries: manifest.entries ?? [],
    skus: [sku],
    defaults: manifest.defaults ?? {},
    moderation: {
      schema_version: 1,
      text: moderationClosure(
        'moderation.text',
        previousTextRuntime.revision,
        textModerationModelId,
        moderationCredentialId,
        textEvidence,
        moderationPricing,
      ),
      image: moderationClosure(
        'moderation.image',
        previousImageRuntime.revision,
        imageModerationModelId,
        moderationCredentialId,
        imageEvidence,
        moderationPricing,
      ),
    },
  };
  const nextReleaseDigest = canonicalSha256(nextManifest);
  await database
    .update(pricingCatalogReleases)
    .set({ manifestJson: nextManifest, releaseDigest: nextReleaseDigest })
    .where(eq(pricingCatalogReleases.id, release.id));

  await database.insert(registrationRewardClaims).values({
    id: claimId,
    campaignKey: `s12-live-${suffix}`,
    userId: user.id,
    mailboxFingerprint: canonicalSha256({ email: USER_EMAIL, suffix }),
    fingerprintKeyId: 's12-live',
    fingerprintRulesVersion: 's12-live-v1',
    decision: 'pending',
  });
  await grantRegistrationCredits(database, {
    userId: user.id,
    rewardClaimId: claimId,
    amount: '50.00',
    idempotencyKey: `s12-live-grant-${suffix}`,
    metadata: { fixture: FIXTURE_REASON },
  });

  return {
    admin_id: adminId,
    billable_sku_id: skuId,
    claim_id: claimId,
    image_moderation_model_id: imageModerationModelId,
    moderation_channel_id: moderationChannelId,
    moderation_credential_id: moderationCredentialId,
    previous_image_runtime_model_id: previousImageRuntime.modelId,
    previous_storage_runtime_existed: Boolean(previousStorage),
    previous_storage_channel_id: previousStorage?.activeChannelId ?? null,
    previous_text_runtime_model_id: previousTextRuntime.modelId,
    pricing_release_id: release.id,
    storage_channel_id: storageChannelId,
    storage_credential_id: storageCredentialId,
    storage_validation_id: storageValidationId,
    text_moderation_model_id: textModerationModelId,
    user_id: user.id,
  };

  function pocRun(modelId: string, capability: string, evidenceDigest: string) {
    return {
      modelSnapshotId: modelId,
      providerChannelId: moderationChannelId,
      credentialVersionId: moderationCredentialId,
      probeSuiteVersion: 'moderation-poc@1',
      requestedSpecKeysJson: [capability],
      requestedSpecKeysDigest: canonicalSha256({ spec_keys: [capability] }),
      status: 'passed' as const,
      attemptNo: 1,
      evidenceDigest,
      requestedByAdminId: adminId,
      completedAt: new Date(),
    };
  }
}

async function setModerationRuntime(
  database: Database,
  capability: 'moderation.text' | 'moderation.image',
  modelId: string,
) {
  const previous = await database.query.moderationRuntimeStates.findFirst({
    where: eq(moderationRuntimeStates.capability, capability),
  });
  const revision = (previous?.runtimeRevision ?? 0) + 1;
  await database
    .insert(moderationRuntimeStates)
    .values({ capability, activeModelSnapshotId: modelId, runtimeRevision: revision })
    .onConflictDoUpdate({
      target: moderationRuntimeStates.capability,
      set: { activeModelSnapshotId: modelId, runtimeRevision: revision },
    });
  return { modelId: previous?.activeModelSnapshotId ?? null, revision };
}

function moderationClosure(
  capability: 'moderation.text' | 'moderation.image',
  runtimeRevision: number,
  modelSnapshotId: string,
  credentialVersionId: string,
  evidenceDigest: string,
  pricing: Record<string, unknown>,
) {
  return {
    capability,
    runtime_revision: runtimeRevision,
    model_snapshot_id: modelSnapshotId,
    credential_version_id: credentialVersionId,
    policy_version: 'content-safety@1',
    evidence_digest: evidenceDigest,
    pricing_digest: canonicalSha256(pricing),
    risk_adjusted_cost_cny: '0.01',
  };
}

async function cleanup(database: Database, input: Record<string, unknown>) {
  const userId = typeof input.user_id === 'string' ? input.user_id : undefined;
  if (userId) await cleanupUserAggregates(database, userId);
  const releaseId = stringValue(input.pricing_release_id);
  const skuId = stringValue(input.billable_sku_id);
  if (skuId) await database.delete(billableSkus).where(eq(billableSkus.id, skuId));
  if (releaseId) {
    const release = await database.query.pricingCatalogReleases.findFirst({
      where: eq(pricingCatalogReleases.id, releaseId),
    });
    if (release?.reason === 'S11 live browser fixture') {
      // S11 cleanup owns this temporary release after S12 references are removed.
    }
  }
  await restoreRuntime(database, 'moderation.text', input.previous_text_runtime_model_id);
  await restoreRuntime(database, 'moderation.image', input.previous_image_runtime_model_id);
  const previousStorage = nullableString(input.previous_storage_channel_id);
  if (input.previous_storage_runtime_existed === true) {
    await database
      .update(storageRuntimeState)
      .set({ activeChannelId: previousStorage })
      .where(eq(storageRuntimeState.purpose, 'private_assets'));
  } else {
    await database
      .delete(storageRuntimeState)
      .where(eq(storageRuntimeState.purpose, 'private_assets'));
  }

  const moderationModels = [
    stringValue(input.text_moderation_model_id),
    stringValue(input.image_moderation_model_id),
  ].filter((value): value is string => Boolean(value));
  if (moderationModels.length) {
    await database
      .delete(providerCircuitStates)
      .where(inArray(providerCircuitStates.modelId, moderationModels));
    await database
      .delete(modelPocRuns)
      .where(inArray(modelPocRuns.modelSnapshotId, moderationModels));
    await database.delete(models).where(inArray(models.id, moderationModels));
  }
  const moderationChannelId = stringValue(input.moderation_channel_id);
  if (moderationChannelId) {
    await database
      .update(providerChannels)
      .set({ activeCredentialVersionId: null })
      .where(eq(providerChannels.id, moderationChannelId));
    await database
      .delete(providerCredentialVersions)
      .where(eq(providerCredentialVersions.providerChannelId, moderationChannelId));
    await database.delete(providerChannels).where(eq(providerChannels.id, moderationChannelId));
  }
  const storageChannelId = stringValue(input.storage_channel_id);
  if (storageChannelId) {
    await database
      .delete(storageValidationRuns)
      .where(eq(storageValidationRuns.storageChannelId, storageChannelId));
    await database
      .update(storageChannels)
      .set({ activeCredentialVersionId: null })
      .where(eq(storageChannels.id, storageChannelId));
    await database
      .delete(storageCredentialVersions)
      .where(eq(storageCredentialVersions.storageChannelId, storageChannelId));
    await database.delete(storageChannels).where(eq(storageChannels.id, storageChannelId));
  }
  const adminId = stringValue(input.admin_id);
  if (adminId) await database.delete(adminPrincipals).where(eq(adminPrincipals.id, adminId));
  return { status: 'cleaned' };
}

async function cleanupUser(database: Database) {
  const user = await database.query.users.findFirst({ where: eq(users.email, USER_EMAIL) });
  if (user) await cleanupUserAggregates(database, user.id);
  return { status: 'user-cleaned' };
}

async function cleanupOrphans(database: Database) {
  await cleanupUser(database);
  const staleSkus = await database.query.billableSkus.findMany({
    where: eq(billableSkus.logicalSkuKey, 's12-live-image-1k'),
    columns: { id: true },
  });
  if (staleSkus.length) {
    await database.delete(billableSkus).where(
      inArray(
        billableSkus.id,
        staleSkus.map((row) => row.id),
      ),
    );
  }

  const moderationChannels = (await database.query.providerChannels.findMany()).filter(
    (channel) => channel.displayName === 'S12 Live Moderation',
  );
  const moderationChannelIds = moderationChannels.map((channel) => channel.id);
  const moderationModels = moderationChannelIds.length
    ? await database.query.models.findMany({
        where: inArray(models.providerChannelId, moderationChannelIds),
        columns: { id: true },
      })
    : [];
  const moderationModelIds = moderationModels.map((model) => model.id);
  if (moderationModelIds.length) {
    await database
      .update(moderationRuntimeStates)
      .set({ activeModelSnapshotId: null })
      .where(inArray(moderationRuntimeStates.activeModelSnapshotId, moderationModelIds));
    await database
      .delete(providerCircuitStates)
      .where(inArray(providerCircuitStates.modelId, moderationModelIds));
    await database
      .delete(modelPocRuns)
      .where(inArray(modelPocRuns.modelSnapshotId, moderationModelIds));
    await database.delete(models).where(inArray(models.id, moderationModelIds));
  }
  if (moderationChannelIds.length) {
    await database
      .update(providerChannels)
      .set({ activeCredentialVersionId: null })
      .where(inArray(providerChannels.id, moderationChannelIds));
    await database
      .delete(providerCredentialVersions)
      .where(inArray(providerCredentialVersions.providerChannelId, moderationChannelIds));
    await database
      .delete(providerChannels)
      .where(inArray(providerChannels.id, moderationChannelIds));
  }

  const staleStorage = (await database.query.storageChannels.findMany()).filter((channel) =>
    channel.bucket.startsWith('s12-live-'),
  );
  const storageIds = staleStorage.map((channel) => channel.id);
  if (storageIds.length) {
    await database
      .update(storageRuntimeState)
      .set({ activeChannelId: null })
      .where(inArray(storageRuntimeState.activeChannelId, storageIds));
    await database
      .delete(storageValidationRuns)
      .where(inArray(storageValidationRuns.storageChannelId, storageIds));
    await database
      .update(storageChannels)
      .set({ activeCredentialVersionId: null })
      .where(inArray(storageChannels.id, storageIds));
    await database
      .delete(storageCredentialVersions)
      .where(inArray(storageCredentialVersions.storageChannelId, storageIds));
    await database.delete(storageChannels).where(inArray(storageChannels.id, storageIds));
  }
  const staleAdmins = await database.query.adminPrincipals.findMany({
    where: eq(adminPrincipals.identifierHint, 's12-live'),
    columns: { id: true },
  });
  if (staleAdmins.length) {
    await database.delete(adminPrincipals).where(
      inArray(
        adminPrincipals.id,
        staleAdmins.map((admin) => admin.id),
      ),
    );
  }
  return { status: 'orphans-cleaned' };
}

async function diagnose(database: Database, input: Record<string, unknown>) {
  const turnId = stringValue(input.turn_id);
  if (!turnId) throw new Error('turn_id is required for diagnosis');
  const turn = await database.query.agentTurns.findFirst({
    where: eq(agentTurns.id, turnId),
    columns: {
      id: true,
      userId: true,
      status: true,
      runQuoteId: true,
      workflowRunId: true,
    },
  });
  const trace = await database.query.agentTraces.findFirst({
    where: eq(agentTraces.turnId, turnId),
    columns: { id: true, status: true, loopGuardrailHit: true },
  });
  const steps = trace
    ? await database.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, trace.id),
        columns: {
          stepNo: true,
          stepType: true,
          actor: true,
          toolName: true,
          status: true,
          errorCode: true,
          inputSummary: true,
          outputSummary: true,
        },
      })
    : [];
  const quote = turn?.runQuoteId
    ? await database.query.runQuotes.findFirst({
        where: eq(runQuotes.id, turn.runQuoteId),
        columns: { id: true, status: true, workflowRunId: true, submissionMode: true },
      })
    : undefined;
  const workflowId = turn?.workflowRunId ?? quote?.workflowRunId;
  const workflow = workflowId
    ? await database.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, workflowId),
        columns: { id: true, status: true, revision: true },
      })
    : undefined;
  const taskRows = workflowId
    ? await database.query.tasks.findMany({
        where: eq(tasks.workflowRunId, workflowId),
        columns: { id: true, type: true, status: true, errorCode: true },
      })
    : [];
  const taskIds = taskRows.map((row) => row.id);
  const attempts = taskIds.length
    ? await database.query.taskAttempts.findMany({
        where: inArray(taskAttempts.taskId, taskIds),
        columns: {
          id: true,
          taskId: true,
          attemptNo: true,
          status: true,
          dispatchState: true,
          rawErrorSummary: true,
        },
      })
    : [];
  const artifactRows = taskIds.length
    ? await database.query.artifacts.findMany({
        where: inArray(artifacts.taskId, taskIds),
        columns: { id: true, taskId: true, visibility: true, contentHash: true },
      })
    : [];
  const artifactIds = artifactRows.map((row) => row.id);
  const evaluations = artifactIds.length
    ? await database.query.artifactEvaluations.findMany({
        where: inArray(artifactEvaluations.artifactId, artifactIds),
        columns: {
          id: true,
          artifactId: true,
          evaluatorType: true,
          status: true,
          confidence: true,
        },
      })
    : [];
  const preflights = await database.query.contentSafetyPreflights.findMany({
    where: eq(contentSafetyPreflights.turnId, turnId),
    columns: { capability: true, checkNo: true, status: true, dispatchState: true },
  });
  return {
    turn_id: turnId,
    turn,
    trace,
    steps,
    quote,
    workflow,
    tasks: taskRows,
    attempts,
    artifacts: artifactRows.map((artifact) => ({
      ...artifact,
      contentHash: artifact.contentHash ? 'present' : null,
    })),
    evaluations,
    preflights,
  };
}

async function cleanupUserAggregates(database: Database, userId: string) {
  const turns = await database.query.agentTurns.findMany({
    where: eq(agentTurns.userId, userId),
    columns: { id: true },
  });
  const turnIds = turns.map((row) => row.id);
  const workflows = await database.query.workflowRuns.findMany({
    where: eq(workflowRuns.userId, userId),
    columns: { id: true },
  });
  const workflowIds = workflows.map((row) => row.id);
  const taskRows = workflowIds.length
    ? await database.query.tasks.findMany({
        where: inArray(tasks.workflowRunId, workflowIds),
        columns: { id: true },
      })
    : [];
  const taskIds = taskRows.map((row) => row.id);
  const artifactRows = await database.query.artifacts.findMany({
    where: eq(artifacts.userId, userId),
    columns: { id: true },
  });
  const artifactIds = artifactRows.map((row) => row.id);
  if (turnIds.length)
    await database
      .delete(contentSafetyPreflights)
      .where(inArray(contentSafetyPreflights.turnId, turnIds));
  if (artifactIds.length) {
    const evaluations = await database.query.artifactEvaluations.findMany({
      where: inArray(artifactEvaluations.artifactId, artifactIds),
      columns: { id: true },
    });
    const evaluationIds = evaluations.map((row) => row.id);
    if (evaluationIds.length)
      await database
        .delete(contentReviewCases)
        .where(inArray(contentReviewCases.evaluationId, evaluationIds));
    await database
      .delete(artifactInputBindings)
      .where(inArray(artifactInputBindings.artifactId, artifactIds));
    await database
      .delete(artifactEvaluations)
      .where(inArray(artifactEvaluations.artifactId, artifactIds));
    await database.delete(artifacts).where(inArray(artifacts.id, artifactIds));
  }
  await database
    .delete(registrationRewardClaims)
    .where(eq(registrationRewardClaims.userId, userId));
  await database.delete(creditLedger).where(eq(creditLedger.userId, userId));
  if (taskIds.length) {
    await database
      .delete(queueDispatchIntents)
      .where(inArray(queueDispatchIntents.aggregateId, taskIds));
    await database.delete(taskAttempts).where(inArray(taskAttempts.taskId, taskIds));
    const childTasks = await database.query.tasks.findMany({
      where: inArray(tasks.id, taskIds),
      columns: { id: true, parentTaskId: true },
    });
    const childIds = childTasks.filter((row) => row.parentTaskId).map((row) => row.id);
    if (childIds.length) await database.delete(tasks).where(inArray(tasks.id, childIds));
    await database.delete(tasks).where(inArray(tasks.id, taskIds));
  }
  if (workflowIds.length) {
    await database
      .delete(queueDispatchIntents)
      .where(inArray(queueDispatchIntents.aggregateId, workflowIds));
    await database.delete(eventOutbox).where(inArray(eventOutbox.scopeId, workflowIds));
    await database
      .update(agentTurns)
      .set({ workflowRunId: null })
      .where(eq(agentTurns.userId, userId));
    await database
      .update(runQuotes)
      .set({ workflowRunId: null })
      .where(eq(runQuotes.userId, userId));
    await database
      .update(creditReservations)
      .set({ workflowRunId: null })
      .where(eq(creditReservations.userId, userId));
    await database.delete(workflowRuns).where(inArray(workflowRuns.id, workflowIds));
  }
  await database.delete(creditReservations).where(eq(creditReservations.userId, userId));
  await database.update(agentTurns).set({ runQuoteId: null }).where(eq(agentTurns.userId, userId));
  await database.delete(runQuotes).where(eq(runQuotes.userId, userId));
  const productRows = await database.query.products.findMany({
    where: eq(products.userId, userId),
    columns: { id: true },
  });
  const productIds = productRows.map((row) => row.id);
  if (productIds.length) {
    await database
      .update(products)
      .set({ latestFactSetId: null, primaryAssetId: null })
      .where(inArray(products.id, productIds));
    await database.delete(productFactSets).where(inArray(productFactSets.productId, productIds));
    await database.update(assets).set({ productId: null }).where(eq(assets.userId, userId));
    await database.delete(products).where(inArray(products.id, productIds));
  }
  await database.delete(assetUploadIntents).where(eq(assetUploadIntents.userId, userId));
  await database.delete(resourceWriteRequests).where(eq(resourceWriteRequests.userId, userId));
  await database.delete(assets).where(eq(assets.userId, userId));
  await database.delete(creditAccounts).where(eq(creditAccounts.userId, userId));
}

async function restoreRuntime(
  database: Database,
  capability: 'moderation.text' | 'moderation.image',
  previous: unknown,
) {
  await database
    .update(moderationRuntimeStates)
    .set({ activeModelSnapshotId: nullableString(previous) })
    .where(eq(moderationRuntimeStates.capability, capability));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return stringValue(value) ?? null;
}

async function run(): Promise<void> {
  const action = process.argv[2];
  if (
    action !== 'setup' &&
    action !== 'cleanup' &&
    action !== 'cleanup-user' &&
    action !== 'cleanup-orphans' &&
    action !== 'diagnose'
  ) {
    throw new Error('Expected setup, cleanup, cleanup-user, cleanup-orphans or diagnose');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  assertEnvironment(databaseUrl);
  const input = await readStdin();
  const resource = createDatabaseClient({ databaseUrl });
  try {
    const result =
      action === 'setup'
        ? await setup(resource.db)
        : action === 'cleanup-user'
          ? await cleanupUser(resource.db)
          : action === 'cleanup-orphans'
            ? await cleanupOrphans(resource.db)
            : action === 'diagnose'
              ? await diagnose(resource.db, input)
              : await cleanup(resource.db, input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await resource.client.end();
  }
}

await run();
