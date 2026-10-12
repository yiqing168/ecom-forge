import { randomInt, randomUUID } from 'node:crypto';

import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  DETERMINISTIC_FAKE_AGENT_MODEL_ID,
  deterministicFakeAgentModelSnapshot,
  mergeAuthoredPrompts,
  type AgentBrainPort,
} from '@ecom-forge/agent';
import {
  CapabilityRegistry,
  compilePlan,
  type AgentModelSelectionSnapshot,
  type CapabilityAdapter,
  type ExecutionAuthorization,
} from '@ecom-forge/compiler';
import {
  agentTraces,
  agentTraceSteps,
  agentTurns,
  agentTurnConfirmations,
  agentTranscriptItems,
  agentTranscriptPayloads,
  adminPrincipals,
  assets,
  chatMessages,
  chatSessions,
  count,
  contentSafetyPreflights,
  creditAccounts,
  creditLedger,
  creditReservations,
  createDatabaseClient,
  eq,
  eventOutbox,
  inArray,
  billableSkus,
  modelCatalogEntries,
  modelPocRuns,
  models,
  moderationRuntimeStates,
  pricingCatalogReleases,
  pricingCatalogState,
  providerCircuitStates,
  providerChannels,
  providerCredentialVersions,
  queueDispatchIntents,
  runQuotes,
  skillCatalogReleases,
  skillCatalogState,
  skillPackageResources,
  skillPackages,
  skillPackageValidationReports,
  skillResourceSnapshots,
  skills,
  storageChannels,
  storageCredentialVersions,
  storageRuntimeState,
  storageValidationRuns,
  tasks,
  users,
  workflowRuns,
} from '@ecom-forge/db';
import {
  createBullMqConnection,
  createQueueIntentInTransaction,
  parseQueuePayload,
  QueueIntentRepository,
  queueRecoverySentinelKey,
  type QueuePayload,
} from '@ecom-forge/queue';
import { submitRunQuote } from '@ecom-forge/credit';
import { canonicalSha256, utf8Sha256 } from '@ecom-forge/shared';
import { parseSkillDefinition, type SkillSelectionSnapshot } from '@ecom-forge/skills';

import { AgentCompilerRepository } from '../src/agent/agent-compiler.repository.js';
import { AgentQuoteService } from '../src/agent/agent-quote.service.js';
import { sessionImageCandidatesSchema } from '../src/agent/agent-session-image-candidate.service.js';
import { AgentTurnRepository, type ClaimedAgentTurn } from '../src/agent/agent-turn.repository.js';
import { AgentLlmCostRepository } from '../src/agent/agent-llm-cost.repository.js';
import {
  appendNativeTranscriptPrelude,
  nativeTranscriptContracts,
} from '../src/agent/agent-transcript-native.js';
import { createNativeTranscriptReader } from '../src/agent/agent-transcript-native-reader.js';
import { CompilerContextService } from '../src/agent/compiler-context.service.js';
import { AgentSessionImageCandidateService } from '../src/agent/agent-session-image-candidate.service.js';
import { ContentSafetyPreflightService } from '../src/agent/content-safety-preflight.service.js';
import { AgentTurnRecoverySweeper } from '../src/agent/agent-turn-recovery.sweeper.js';
import { BullMqQueuePublisher } from '../src/queue/queue-publisher.js';
import { appendOutboxEventInTransaction } from '../src/database/outbox.repository.js';
import type { WorkerConfig } from '../src/config/worker-config.js';
import { ActiveWorkTracker, WorkerWriteFence } from '../src/lifecycle/processing-fence.js';
import { AgentProcessorWorker } from '../src/processors/agent-processor.js';
import { QueueReconciler } from '../src/queue/reconciler.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/1';
const redisPrefix = `s09-test-${randomUUID().replaceAll('-', '')}`;
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '').toLowerCase();
if (!/_test(?:_|$)/.test(databaseName)) {
  throw new Error('S09 compiler integration tests require a database name containing _test');
}

const resource = createDatabaseClient({ databaseUrl, maxConnections: 20 });
const redis = createBullMqConnection(redisUrl);
const config: WorkerConfig = {
  appEnv: 'test',
  databaseUrl,
  databasePoolMax: 20,
  databaseStatementTimeoutMs: 15_000,
  databaseTransactionTimeoutMs: 10_000,
  redisUrl,
  redisPrefix,
  localUploadRoot: './uploads',
  storageEnabled: true,
  storageMaxImageBytes: 20 * 1024 * 1024,
  storageMaxImageWidth: 16_384,
  storageMaxImageHeight: 16_384,
  storageMaxImagePixels: 100_000_000,
  contentReviewDeadlineMs: 86_400_000,
  contentReviewSweepBatchSize: 50,
  outcomeUnknownReleaseDeadlineMs: 30 * 60 * 1_000,
  outcomeUnknownReleaseSweepBatchSize: 50,
  testProcessorEnabled: false,
  settlementProcessorEnabled: true,
  providerMode: 'fake',
  providerProcessorMode: 'disabled',
  providerAdapter: 'fake',
  providerRelayOrigins: ['https://local.invalid'],
  providerImageOutputOrigins: ['https://local.invalid'],
  providerRequestTimeoutMs: 30_000,
  imageProviderRequestTimeoutMs: 180_000,
  providerImageTaskConcurrency: 9,
  agentProcessorEnabled: true,
  agentBrainAdapter: 'fake',
  agentBrainReasoningEffort: 'medium',
  providerRealPocEnabled: false,
  agentRequestTimeoutMs: 1_000,
  agentProcessingLeaseMs: 5_000,
  agentProcessingRenewMs: 1_000,
  agentProcessingRetryAttempts: 3,
  agentProcessingRetryBaseMs: 1_000,
  agentMaxLlmRounds: 6,
  agentMaxToolCalls: 12,
  agentMaxInputTokens: 96_000,
  agentMaxOutputTokens: 8_192,
  agentBrainStepMaxOutputTokens: 1_024,
  agentBrainImageMaxEdge: 1_536,
  agentBrainRetryBaseDelayMs: 1_000,
  agentBrainRetryMaxDelayMs: 8_000,
  agentBrainImageMaterializationConcurrency: 2,
  agentBrainMaxMaterializedImageBytes: 64 * 1024 * 1024,
  agentMaxEstimatedCostCny: '0.15',
  agentMaxReferences: 12,
  agentExecutionPolicyVersion: 'agent-execution-policy-v1',
  compilerQuoteTtlSeconds: 600,
  heartbeatIntervalMs: 1_000,
  heartbeatStaleMs: 3_000,
  dispatchLeaseMs: 5_000,
  dispatchLeaseRenewMs: 1_000,
  dispatchPollMs: 100,
  dispatchBatchSize: 100,
  dispatchBackoffBaseMs: 100,
  dispatchBackoffMaxMs: 1_000,
  drainTimeoutMs: 1_000,
};

const paramsSchema = z.strictObject({
  aspect_ratio: z.literal('1:1'),
  resolution: z.literal('1k'),
  output_count: z.int().min(1).max(4),
  output_count_source: z.enum(['user_explicit', 'skill_default']),
  operation: z.literal('generate'),
});
const imageAdapter: CapabilityAdapter = {
  capability: 'image.generate',
  version: 1,
  allowedBindingKinds: [],
  compile(input) {
    const parsed = paramsSchema.safeParse(input.params);
    if (!parsed.success) return { ok: false, ruleId: 'image_params_invalid' };
    return {
      ok: true,
      paramsSnapshot: parsed.data,
      requirements: {
        outputType: 'image',
        outputCount: parsed.data.output_count,
        referenceImageCount: 0,
        aspectRatio: parsed.data.aspect_ratio,
        resolution: parsed.data.resolution,
        operation: 'generate',
        mandatoryConfirmation: false,
      },
      quoteLabel: '图片生成',
    };
  },
};
const registry = new CapabilityRegistry('s09-test-registry-v1', [imageAdapter]);
const modelSnapshot = deterministicFakeAgentModelSnapshot({
  maxInputTokens: config.agentMaxInputTokens,
  maxOutputTokens: config.agentMaxOutputTokens,
});
let fixtureModelSelectionSnapshot: AgentModelSelectionSnapshot;
const fixtureGenerationPreferences = {
  schema_version: 2 as const,
  output_kind: 'image' as const,
  aspect_ratio: '1:1',
  resolution_tier: '1k' as const,
};
const trackedUsers = new Set<string>();
let packageRecordId: string;
let validationReportId: string;
let releaseId: string;
let pricingReleaseId: string;
let modelId: string;
let modelProvider: string;
let providerChannelId: string;
let providerCredentialId: string;
let moderationModelId: string;
let moderationChannelId: string;
let moderationCredentialId: string;
let moderationAdminId: string;
let storageChannelId: string;
let storageCredentialId: string;
let storageValidationId: string;
let modelCatalogEntryId: string;
let billableSkuId: string;
let primarySkillId: string;
let selection: SkillSelectionSnapshot;
let previousCatalogReleaseId: string | null | undefined;
let previousSkillCatalogRevision: number | undefined;
let previousPricingCatalogReleaseId: string | null | undefined;
let previousPricingCatalogRevision: number | undefined;
let previousModerationTextState:
  | {
      activeModelSnapshotId: string | null;
      runtimeRevision: number;
      updatedByAdminId: string | null;
    }
  | undefined;
let moderationRuntimeRevision: number;
let previousModerationImageState:
  | {
      activeModelSnapshotId: string | null;
      runtimeRevision: number;
      updatedByAdminId: string | null;
    }
  | undefined;
let moderationImageRuntimeRevision: number;
let previousStorageState: { activeChannelId: string | null; runtimeRevision: number } | undefined;
let storageRuntimeRevision: number;

function candidate(extra: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    intent: { kind: 'creative_generate', confidence: 0.98 },
    skill_id: primarySkillId,
    source: 'chat',
    nodes: [
      {
        candidate_key: 'generate-main',
        capability: 'image.generate',
        capability_version: 1,
        depends_on: [],
        input_bindings: [] as string[],
        params: {
          aspect_ratio: '1:1',
          resolution: '1k',
          output_count: 1,
          output_count_source: 'user_explicit',
          operation: 'generate',
        },
        expected_output: 'image',
      },
    ],
    ...extra,
  };
}

function brainFor(
  plan: Record<string, unknown>,
  beforeReturn?: () => Promise<void>,
): AgentBrainPort {
  return {
    countInputTokens: () => 1,
    async runStep() {
      await beforeReturn?.();
      return { type: 'candidate_plan', plan, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
}

async function installCompilerCatalog(): Promise<void> {
  packageRecordId = randomUUID();
  validationReportId = randomUUID();
  releaseId = randomUUID();
  modelId = randomUUID();
  modelProvider = `s09-provider-${packageRecordId.slice(0, 8)}`;
  primarySkillId = `s09-image-${packageRecordId.slice(0, 8)}@1.0.0`;
  const slug = primarySkillId.split('@')[0]!;
  const planningContent = '# S09 image generation planning';
  const planningHash = utf8Sha256(planningContent);
  const definition = parseSkillDefinition({
    schema_version: 1,
    slug,
    version: '1.0.0',
    display_name: 'S09 通用生图',
    description: '用于验证确定性编译与交易接线的隔离 Skill',
    kind: 'primary',
    visibility: 'public',
    domain: 'creative',
    category: 's09-test',
    stage: '1A',
    required_capabilities: ['image.generate'],
    planning_view: { path: 'SKILL.md', content_hash: planningHash },
  });
  const definitionHash = canonicalSha256(definition);
  const packageDigest = canonicalSha256({ s09_package: packageRecordId });
  await resource.db.insert(skillPackages).values({
    id: packageRecordId,
    packageId: `s09-package-${packageRecordId.slice(0, 8)}`,
    packageVersion: '1.0.0',
    packageDigest,
    archiveSha256: canonicalSha256({ archive: packageRecordId }),
    manifestJson: { schema_version: 1, test_run_id: packageRecordId },
    status: 'approved',
    riskStatus: 'clear',
    sourceType: 'first_party',
    quarantineStorageKey: `s09-test/${packageRecordId}`,
    uploadExpiresAt: new Date(Date.now() + 60_000),
    approvedBy: 's09-test',
    approvedAt: new Date(),
  });
  const [packageResource] = await resource.db
    .insert(skillPackageResources)
    .values({
      packageRecordId,
      resourcePath: `${primarySkillId}/SKILL.md`,
      resourceType: 'planning_view',
      mediaType: 'text/markdown',
      byteSize: Buffer.byteLength(planningContent),
      contentHash: planningHash,
      storageKey: `s09-test/${packageRecordId}/${primarySkillId}/SKILL.md`,
      skillId: primarySkillId,
      rightsMetadataJson: { source: 'first_party', test_run_id: packageRecordId },
    })
    .returning();
  if (!packageResource) throw new Error('Failed to create S09 package resource');
  await resource.db.insert(skills).values({
    id: primarySkillId,
    slug,
    name: definition.display_name,
    category: definition.category,
    domain: definition.domain,
    kind: 'primary',
    visibility: 'public',
    stage: definition.stage,
    version: definition.version,
    packageRecordId,
    skillDigest: canonicalSha256({ skill: primarySkillId }),
    definitionJson: definition,
    definitionHash,
    price: {},
    status: 'published',
    publishedAt: new Date(),
  });
  const [resourceSnapshot] = await resource.db
    .insert(skillResourceSnapshots)
    .values({
      skillId: primarySkillId,
      resourcePath: 'SKILL.md',
      resourceType: 'planning_view',
      contentHash: planningHash,
      packageResourceId: packageResource.id,
      contentText: planningContent,
      kvKey: `s09:${packageRecordId}:planning`,
      summaryJson: { test_run_id: packageRecordId },
    })
    .returning();
  if (!resourceSnapshot) throw new Error('Failed to create S09 resource snapshot');
  await resource.db.insert(skillPackageValidationReports).values({
    id: validationReportId,
    packageRecordId,
    packageRevision: 1,
    packageDigest,
    attemptNo: 1,
    status: 'passed',
    validatorContractVersion: 's09-test-v1',
    platformEvalSuiteDigest: canonicalSha256({ eval: packageRecordId }),
    reportJson: { passed: true, test_run_id: packageRecordId },
    reportDigest: canonicalSha256({ report: packageRecordId }),
    completedAt: new Date(),
  });
  await resource.db
    .update(skillPackages)
    .set({
      latestValidationReportId: validationReportId,
      approvedValidationReportId: validationReportId,
    })
    .where(eq(skillPackages.id, packageRecordId));
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
            definition_hash: definitionHash,
            resources: [
              {
                skill_resource_snapshot_id: resourceSnapshot.id,
                package_resource_id: packageResource.id,
                resource_path: 'SKILL.md',
                content_hash: planningHash,
              },
            ],
          },
        ],
      },
    ],
  };
  const releaseDigest = canonicalSha256(releaseManifest);
  await resource.db.insert(skillCatalogReleases).values({
    id: releaseId,
    releaseNo: randomInt(100_000_000, 2_000_000_000),
    status: 'published',
    releaseDigest,
    manifestJson: releaseManifest,
    reason: 'S09 compiler integration test',
    createdBy: 's09-test',
    approvedBy: 's09-test',
    publishedAt: new Date(),
  });
  const previous = await resource.db.query.skillCatalogState.findFirst({
    where: eq(skillCatalogState.id, 'global'),
  });
  previousCatalogReleaseId = previous?.activeReleaseId;
  previousSkillCatalogRevision = previous?.revision;
  if (previous) {
    await resource.db
      .update(skillCatalogState)
      .set({ activeReleaseId: releaseId, revision: previous.revision + 1 })
      .where(eq(skillCatalogState.id, 'global'));
  } else {
    await resource.db
      .insert(skillCatalogState)
      .values({ id: 'global', activeReleaseId: releaseId });
  }
  selection = {
    primary_skill_id: primarySkillId,
    primary_name: definition.display_name,
    primary_definition_hash: definitionHash,
    primary_package_record_id: packageRecordId,
    required_capabilities: ['image.generate'],
    default_output_count: 1,
    primary_planning_resource: {
      resource_snapshot_id: resourceSnapshot.id,
      package_resource_id: packageResource.id,
      resource_path: 'SKILL.md',
      resource_hash: planningHash,
    },
    primary_reference_resources: [],
    catalog_release_id: releaseId,
    catalog_version: releaseDigest,
    preset_selections: [],
    required_auxiliary: [],
    optional_auxiliary: [],
  };
  providerChannelId = randomUUID();
  providerCredentialId = randomUUID();
  modelCatalogEntryId = randomUUID();
  billableSkuId = randomUUID();
  pricingReleaseId = randomUUID();
  const previousPricingState = await resource.db.query.pricingCatalogState.findFirst({
    where: eq(pricingCatalogState.id, 'global'),
  });
  previousPricingCatalogReleaseId = previousPricingState?.activeReleaseId;
  previousPricingCatalogRevision = previousPricingState?.catalogRevision;
  const catalogRevision = (previousPricingState?.catalogRevision ?? 0) + 1;
  const imageSpecKey = 'default';
  const providerRateCardKey = `s09-image-${packageRecordId.slice(0, 8)}`;
  const matcher = {
    schema_version: 1,
    kind: 'image',
    mode: 'text-to-image',
    resolution: '1k',
    transparent_background: false,
    reference_tier: 'none',
  } as const;
  const imageCapability = {
    schema_version: 2,
    contract_kind: 'media',
    media_kind: 'image',
    capabilities: ['image.generate'],
    specs: [
      {
        kind: 'image',
        spec_key: imageSpecKey,
        operation: 'image.generate',
        mode: 'text-to-image',
        resolution_tier: '1k',
        aspect_ratios: ['1:1'],
        max_outputs: 4,
        max_reference_images: 0,
        transparent_background: false,
        output_formats: ['png'],
      },
    ],
  } as const;
  const imagePricing = {
    schema_version: 2,
    contract_kind: 'media_rate_card',
    currency: 'CNY',
    rate_cards: [
      {
        rate_key: providerRateCardKey,
        spec_key: imageSpecKey,
        billing_unit: 'image',
        unit_cost_cny: '0.40',
      },
    ],
    overhead_cny: { tool: '0.10', storage: '0.10', traffic: '0.10', agent_brain: '0.10' },
    failure_rate: '0.10',
    unknown_rate: '0.10',
    refund_rate: '0.10',
    risk_reserve_rate: '0.10',
    gross_margin_target: '0.20',
    credit_cny_anchor: '1.00',
  } as const;
  const quota = {
    schema_version: 1,
    rpm: 100,
    concurrency: 10,
    hourly_budget_cny: '100.00',
    daily_budget_cny: '1000.00',
    poll_initial_delay_ms: 1000,
    poll_interval_ms: 1000,
    max_poll_count: 30,
    terminal_timeout_ms: 60_000,
    circuit_sample_size: 20,
    circuit_failure_rate: '0.50',
    circuit_unknown_rate: '0.25',
    circuit_open_ms: 60_000,
  } as const;
  await resource.db.insert(providerChannels).values({
    id: providerChannelId,
    provider: modelProvider,
    adapterKey: 'fake-provider-v1',
    displayName: 'S09 fake provider',
    baseUrl: 'https://local.invalid',
    endpointProfileKey: `s09-${providerChannelId}`,
    status: 'active',
  });
  await resource.db.insert(providerCredentialVersions).values({
    id: providerCredentialId,
    providerChannelId,
    versionNo: 1,
    secretCiphertext: 's09-test-ciphertext',
    secretNonce: 's09-test-nonce',
    secretAuthTag: 's09-test-auth-tag',
    secretKeyId: 's09-test-key',
    keyHint: 's09-test',
    status: 'active',
    validationEvidenceDigest: canonicalSha256({ evidence: providerCredentialId }),
    verifiedAt: new Date(),
    activatedAt: new Date(),
  });
  await resource.db
    .update(providerChannels)
    .set({ activeCredentialVersionId: providerCredentialId })
    .where(eq(providerChannels.id, providerChannelId));
  await resource.db.insert(models).values({
    id: modelId,
    provider: modelProvider,
    providerChannelId,
    modelId: 's09-image-model',
    version: '1',
    capabilityContractJson: imageCapability,
    pricingJson: imagePricing,
    quotaJson: quota,
    status: 'poc_passed',
    statusEvidenceDigest: canonicalSha256({ evidence: modelId }),
    statusOperatorId: 's09-test',
    statusReason: 'approved test model',
    statusChangedAt: new Date(),
  });
  moderationModelId = randomUUID();
  moderationChannelId = randomUUID();
  moderationCredentialId = randomUUID();
  moderationAdminId = randomUUID();
  await resource.db.insert(adminPrincipals).values({
    id: moderationAdminId,
    identifierHash: `s09-${moderationAdminId}`,
    identifierKeyId: 's09-test-key',
    identifierHint: 's09-test',
    displayName: 'S09 test admin',
    status: 'active',
  });
  await resource.db.insert(providerChannels).values({
    id: moderationChannelId,
    provider: 'fake',
    adapterKey: 'fake-provider-v1',
    displayName: 'S09 fake moderation provider',
    baseUrl: 'https://local.invalid',
    endpointProfileKey: 'local',
    status: 'active',
  });
  await resource.db.insert(providerCredentialVersions).values({
    id: moderationCredentialId,
    providerChannelId: moderationChannelId,
    versionNo: 1,
    secretCiphertext: 's09-test-ciphertext',
    secretNonce: 's09-test-nonce',
    secretAuthTag: 's09-test-auth-tag',
    secretKeyId: 's09-test-key',
    keyHint: 's09-test',
    status: 'active',
    validationEvidenceDigest: canonicalSha256({ evidence: moderationCredentialId }),
    verifiedAt: new Date(),
    activatedAt: new Date(),
  });
  await resource.db
    .update(providerChannels)
    .set({ activeCredentialVersionId: moderationCredentialId })
    .where(eq(providerChannels.id, moderationChannelId));
  const moderationEvidenceDigest = canonicalSha256({ evidence: moderationModelId });
  await resource.db.insert(models).values({
    id: moderationModelId,
    provider: 'fake',
    providerChannelId: moderationChannelId,
    modelId: `s09-moderation-model-${moderationModelId.slice(0, 8)}`,
    version: '1',
    capabilityContractJson: {
      schema_version: 1,
      capabilities: ['moderation.text', 'moderation.image'],
      aspect_ratios: [],
      resolutions: [],
      max_outputs: 1,
      max_reference_images: 0,
    },
    pricingJson: {
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
      credit_cny_anchor: '0.05',
    },
    quotaJson: {
      schema_version: 1,
      rpm: 60,
      concurrency: 4,
      hourly_budget_cny: '10.00',
      daily_budget_cny: '100.00',
      poll_initial_delay_ms: 10,
      poll_interval_ms: 10,
      max_poll_count: 1,
      terminal_timeout_ms: 1_000,
      circuit_sample_size: 10,
      circuit_failure_rate: '0.50',
      circuit_unknown_rate: '0.50',
      circuit_open_ms: 1_000,
    },
    status: 'poc_passed',
    statusEvidenceDigest: moderationEvidenceDigest,
    statusOperatorId: moderationAdminId,
    statusReason: 'approved test moderation model',
    statusChangedAt: new Date(),
  });
  await resource.db.insert(modelPocRuns).values({
    modelSnapshotId: moderationModelId,
    providerChannelId: moderationChannelId,
    credentialVersionId: moderationCredentialId,
    probeSuiteVersion: 'moderation-poc@1',
    requestedSpecKeysJson: ['moderation.text', 'moderation.image'],
    requestedSpecKeysDigest: canonicalSha256(['moderation.text', 'moderation.image']),
    status: 'passed',
    attemptNo: 1,
    evidenceDigest: moderationEvidenceDigest,
    requestedByAdminId: moderationAdminId,
    completedAt: new Date(),
  });
  const moderationRuntime = await resource.db.query.moderationRuntimeStates.findFirst({
    where: eq(moderationRuntimeStates.capability, 'moderation.text'),
  });
  const moderationImageRuntime = await resource.db.query.moderationRuntimeStates.findFirst({
    where: eq(moderationRuntimeStates.capability, 'moderation.image'),
  });
  if (!moderationRuntime || !moderationImageRuntime) {
    throw new Error('S09 moderation runtime state is missing');
  }
  previousModerationTextState = {
    activeModelSnapshotId: moderationRuntime.activeModelSnapshotId,
    runtimeRevision: moderationRuntime.runtimeRevision,
    updatedByAdminId: moderationRuntime.updatedByAdminId,
  };
  moderationRuntimeRevision = moderationRuntime.runtimeRevision + 1;
  previousModerationImageState = {
    activeModelSnapshotId: moderationImageRuntime.activeModelSnapshotId,
    runtimeRevision: moderationImageRuntime.runtimeRevision,
    updatedByAdminId: moderationImageRuntime.updatedByAdminId,
  };
  moderationImageRuntimeRevision = moderationImageRuntime.runtimeRevision + 1;
  await resource.db
    .update(moderationRuntimeStates)
    .set({
      activeModelSnapshotId: moderationModelId,
      runtimeRevision: moderationRuntimeRevision,
      updatedByAdminId: moderationAdminId,
    })
    .where(eq(moderationRuntimeStates.capability, 'moderation.text'));
  await resource.db
    .update(moderationRuntimeStates)
    .set({
      activeModelSnapshotId: moderationModelId,
      runtimeRevision: moderationImageRuntimeRevision,
      updatedByAdminId: moderationAdminId,
    })
    .where(eq(moderationRuntimeStates.capability, 'moderation.image'));
  storageChannelId = randomUUID();
  storageCredentialId = randomUUID();
  storageValidationId = randomUUID();
  const storageEvidenceDigest = canonicalSha256({ evidence: storageCredentialId });
  await resource.db.insert(storageChannels).values({
    id: storageChannelId,
    purpose: 'private_assets',
    adapterKey: 'local-private-v1',
    endpointProfileKey: 'local',
    bucket: `s09-${storageChannelId}`,
    rootPrefix: `s09/${storageChannelId}`,
    status: 'active',
    createdByAdminId: moderationAdminId,
  });
  await resource.db.insert(storageCredentialVersions).values({
    id: storageCredentialId,
    storageChannelId,
    versionNo: 1,
    secretBundleCiphertext: 's09-test-secret',
    secretNonce: 's09-test-nonce',
    secretAuthTag: 's09-test-auth-tag',
    secretKeyId: 's09-test-key',
    keyHint: 's09-test',
    status: 'active',
    validationEvidenceDigest: storageEvidenceDigest,
    verifiedAt: new Date(),
    activatedAt: new Date(),
  });
  await resource.db.insert(storageValidationRuns).values({
    id: storageValidationId,
    storageChannelId,
    credentialVersionId: storageCredentialId,
    probeContractVersion: 'local-private@1',
    status: 'passed',
    evidenceDigest: storageEvidenceDigest,
    probePrefixDigest: canonicalSha256({ prefix: storageChannelId }),
    requestedByAdminId: moderationAdminId,
    completedAt: new Date(),
  });
  await resource.db
    .update(storageChannels)
    .set({ activeCredentialVersionId: storageCredentialId })
    .where(eq(storageChannels.id, storageChannelId));
  const previousStorage = await resource.db.query.storageRuntimeState.findFirst({
    where: eq(storageRuntimeState.purpose, 'private_assets'),
  });
  previousStorageState = previousStorage
    ? {
        activeChannelId: previousStorage.activeChannelId,
        runtimeRevision: previousStorage.runtimeRevision,
      }
    : undefined;
  storageRuntimeRevision = (previousStorage?.runtimeRevision ?? 0) + 1;
  if (previousStorage) {
    await resource.db
      .update(storageRuntimeState)
      .set({ activeChannelId: storageChannelId, runtimeRevision: storageRuntimeRevision })
      .where(eq(storageRuntimeState.purpose, 'private_assets'));
  } else {
    await resource.db.insert(storageRuntimeState).values({
      purpose: 'private_assets',
      activeChannelId: storageChannelId,
      runtimeRevision: storageRuntimeRevision,
    });
  }
  const catalogEntry = {
    id: modelCatalogEntryId,
    model_snapshot_id: modelId,
    public_slug: `s09-image-${modelCatalogEntryId.slice(0, 8)}`,
    version_no: 1,
    category: 'image' as const,
    display_name: 'S09 Image',
    description: 'S09 deterministic image model',
    public_capabilities: { resolutions: ['1k'], aspect_ratios: ['1:1'] },
    rollout: { stage: 'test' as const, percentage: 100 },
    user_selectable: true,
    is_default: false,
    sort_order: 1,
    revision: 1,
  };
  await resource.db.insert(modelCatalogEntries).values({
    id: catalogEntry.id,
    modelSnapshotId: catalogEntry.model_snapshot_id,
    publicSlug: catalogEntry.public_slug,
    versionNo: catalogEntry.version_no,
    category: catalogEntry.category,
    displayName: catalogEntry.display_name,
    description: catalogEntry.description,
    publicCapabilitiesJson: catalogEntry.public_capabilities,
    rolloutJson: catalogEntry.rollout,
    userSelectable: catalogEntry.user_selectable,
    isDefault: catalogEntry.is_default,
    sortOrder: catalogEntry.sort_order,
    status: 'approved',
    approvedAt: new Date(),
  });
  const sku = {
    id: billableSkuId,
    logical_sku_key: `s09-image-${packageRecordId.slice(0, 8)}`,
    version_no: 1,
    model_catalog_entry_id: modelCatalogEntryId,
    operation: 'image.generate' as const,
    matcher,
    matcher_hash: canonicalSha256(matcher),
    unit_kind: 'image' as const,
    unit_rule: { min_quantity: 1, max_quantity: 4, step_quantity: 1 },
    credits_per_unit: '2.00',
    provider_rate_card_key: providerRateCardKey,
    provider_cost_per_unit_cny: '0.40',
    revision: 1,
  };
  await resource.db.insert(billableSkus).values({
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
  const moderationDigest = canonicalSha256({ fixture: 's09-moderation', pricingReleaseId });
  const moderationRoute = (capability: 'moderation.text' | 'moderation.image') => ({
    capability,
    runtime_revision:
      capability === 'moderation.text' ? moderationRuntimeRevision : moderationImageRuntimeRevision,
    model_snapshot_id: moderationModelId,
    credential_version_id: moderationCredentialId,
    policy_version: 'content-safety@1',
    evidence_digest: moderationDigest,
    pricing_digest: moderationDigest,
    risk_adjusted_cost_cny: '0.01',
  });
  const pricingManifest = {
    schema_version: 2 as const,
    entries: [catalogEntry],
    skus: [sku],
    defaults: { image: modelCatalogEntryId },
    moderation: {
      schema_version: 1 as const,
      text: moderationRoute('moderation.text'),
      image: moderationRoute('moderation.image'),
    },
  };
  const pricingReleaseDigest = canonicalSha256(pricingManifest);
  await resource.db.insert(pricingCatalogReleases).values({
    id: pricingReleaseId,
    releaseNo:
      Math.max(
        0,
        ...(
          await resource.db.query.pricingCatalogReleases.findMany({
            columns: { releaseNo: true },
          })
        ).map((release) => release.releaseNo),
      ) + 1,
    status: 'published',
    releaseDigest: pricingReleaseDigest,
    manifestJson: pricingManifest,
    reason: 'S09 compiler integration test',
    publishedAt: new Date(),
  });
  if (previousPricingState) {
    await resource.db
      .update(pricingCatalogState)
      .set({ activeReleaseId: pricingReleaseId, catalogRevision })
      .where(eq(pricingCatalogState.id, 'global'));
  } else {
    await resource.db.insert(pricingCatalogState).values({
      id: 'global',
      activeReleaseId: pricingReleaseId,
      catalogRevision,
    });
  }
  fixtureModelSelectionSnapshot = {
    schema_version: 1,
    catalog_revision: catalogRevision,
    catalog_release_id: pricingReleaseId,
    catalog_release_digest: pricingReleaseDigest,
    brain: {
      catalog_entry_id: modelCatalogEntryId,
      catalog_entry_revision: 1,
      version_no: 1,
      public_slug: 'fixture-brain',
      display_name: 'Fixture Brain',
      model_snapshot_id: modelId,
    },
    image: {
      catalog_entry_id: modelCatalogEntryId,
      catalog_entry_revision: 1,
      version_no: 1,
      public_slug: catalogEntry.public_slug,
      display_name: catalogEntry.display_name,
      model_snapshot_id: modelId,
      selected_spec_key: imageSpecKey,
      selected_operation: 'image.generate',
      supported_aspect_ratios: ['1:1'],
    },
  };
}

async function createTurn(input: { balance?: string; message?: string }) {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const messageId = randomUUID();
  const traceId = randomUUID();
  const balance = input.balance ?? '10.00';
  const executionAuthorization: ExecutionAuthorization = {
    schema_version: 2,
    kind: 'generate_action',
    create_request_hash: canonicalSha256({ turn_id: turnId, message_id: messageId }),
    policy_version: config.agentExecutionPolicyVersion,
  };
  trackedUsers.add(userId);
  await resource.db.insert(users).values({
    id: userId,
    email: `s09-${userId}@example.test`,
    displayName: 'S09 compiler user',
    emailVerifiedAt: new Date(),
  });
  await resource.db.insert(creditAccounts).values({
    userId,
    balance,
    frozen: '0.00',
    version: 1,
  });
  await resource.db.insert(creditLedger).values({
    userId,
    type: 'grant',
    amount: balance,
    idempotencyKey: `s09-grant:${userId}`,
    accountVersion: 1,
    balanceAfter: balance,
    frozenAfter: '0.00',
    metadata: { test_run_id: userId },
  });
  await resource.db.insert(chatSessions).values({
    id: sessionId,
    userId,
    title: input.message ?? '生成一张图片',
    transcriptStateJson: {
      schema_version: 1,
      mode: 'active',
      integrity_version: 1,
      verified_through_sequence: '0',
      verified_digest: canonicalSha256([]),
    },
  });
  await resource.db.insert(agentTurns).values({
    id: turnId,
    sessionId,
    userId,
    status: 'received_user_input',
    executionFormat: 'transcript_v1',
    transcriptCaptureVersion: 1,
    primarySkillId,
    skillSelectionSnapshotJson: selection,
    skillSelectionSnapshotHash: canonicalSha256(selection),
    modelSelectionSnapshotJson: fixtureModelSelectionSnapshot,
    modelSelectionSnapshotHash: canonicalSha256(fixtureModelSelectionSnapshot),
    generationPreferencesJson: fixtureGenerationPreferences,
    generationPreferencesHash: canonicalSha256(fixtureGenerationPreferences),
    executionAuthorizationJson: executionAuthorization,
    executionAuthorizationHash: canonicalSha256(executionAuthorization),
  });
  await resource.db.insert(chatMessages).values({
    id: messageId,
    sessionId,
    turnId,
    role: 'user',
    content: input.message ?? '生成一张图片',
    attachments: [],
    skillSnapshots: [{ skill_id: primarySkillId }],
  });
  await resource.db.insert(agentTraces).values({
    id: traceId,
    turnId,
    sessionId,
    userId,
    brainModelId: DETERMINISTIC_FAKE_AGENT_MODEL_ID,
    brainModelSnapshotJson: modelSnapshot,
    skillIds: [primarySkillId],
  });
  return {
    userId,
    sessionId,
    turnId,
    messageId,
    traceId,
    executionAuthorization,
  };
}

function continuePayload(fixture: Awaited<ReturnType<typeof createTurn>>) {
  return {
    schema_version: 1 as const,
    job_type: 'agent.continue' as const,
    trace_id: fixture.traceId,
    session_id: fixture.sessionId,
    turn_id: fixture.turnId,
    user_message_id: fixture.messageId,
    continuation_no: 1,
    turn_revision: 1,
  };
}

async function captureCandidate(
  claimed: ClaimedAgentTurn,
  plan = candidate(),
  phase: 'planning' | 'authoring' = 'planning',
) {
  await appendNativeTranscriptPrelude(resource.db, claimed);
  const repository = new AgentLlmCostRepository(resource.db);
  const request = {
    claimed,
    revision: claimed.revision,
    round: 1,
    modelSnapshot,
    exposureCost: '0.02',
    turnBudgetCost: '0.15',
    requestedInputTokens: 1,
    requestedMaxOutputTokens: 1,
    transcript: {
      expectedGeneration: claimed.transcriptGeneration!,
      phase,
      resourceDependencies: [],
      contracts: nativeTranscriptContracts,
    },
  };
  const reserved = await repository.reserve(request);
  if (reserved?.kind !== 'reserved') throw new Error('Failed to reserve S09 native model step');
  const authored = {
    prompts: plan.nodes.map((node) => ({
      candidate_key: node.candidate_key,
      creative_prompt: 'A controlled creative composition.',
    })),
  };
  await repository.settle({
    ...request,
    step: reserved.step,
    outcome: {
      type: 'candidate_plan',
      plan: phase === 'authoring' ? mergeAuthoredPrompts(plan, authored) : plan,
      ...(phase === 'authoring'
        ? {
            authoring_output: {
              name: 'agent_author_prompts@1' as const,
              arguments: authored,
              provider_call_id: null,
            },
          }
        : {}),
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  return { id: reserved.step.stepId };
}

async function processTurn(
  fixture: Awaited<ReturnType<typeof createTurn>>,
  brain: AgentBrainPort,
  capabilities: CapabilityRegistry = registry,
): Promise<void> {
  const failures: Record<string, unknown>[] = [];
  const worker = new AgentProcessorWorker(
    resource.db,
    redis,
    config,
    new ActiveWorkTracker(),
    new WorkerWriteFence(),
    { publish: vi.fn().mockResolvedValue(undefined) },
    brain,
    capabilities,
    new Set([modelId]),
    {
      info: () => undefined,
      error: (event) => {
        failures.push(event);
      },
    },
  );
  const queue = new Queue<Extract<QueuePayload, { job_type: 'agent.continue' }>>('agent', {
    connection: createBullMqConnection(redisUrl),
    prefix: redisPrefix,
  });
  try {
    const payload = continuePayload(fixture);
    await queue.add('agent.continue', payload, { jobId: `s09-continue-${fixture.turnId}` });
    await expect
      .poll(
        async () =>
          (
            await resource.db.query.agentTurns.findFirst({
              where: eq(agentTurns.id, fixture.turnId),
              columns: { status: true },
            })
          )?.status,
        { timeout: 10_000 },
      )
      .toMatch(/waiting_user_confirmation|run_quote_created|blocked/);
  } catch (error) {
    throw new Error(`S09 Worker did not converge: ${JSON.stringify(failures)}`, { cause: error });
  } finally {
    await worker.close(true);
    await queue.close();
  }
}

async function quotePayload<T extends 'agent.quote.submit' | 'agent.quote.expire'>(
  fixture: Awaited<ReturnType<typeof createTurn>>,
  type: T,
): Promise<Extract<QueuePayload, { job_type: T }>> {
  const intents = await resource.db.query.queueDispatchIntents.findMany({
    where: eq(queueDispatchIntents.aggregateType, 'run_quote'),
  });
  const payload = intents
    .map((intent) => parseQueuePayload(intent.payload))
    .find((item) => item.job_type === type && item.turn_id === fixture.turnId);
  if (!payload || payload.job_type !== type) throw new Error(`Missing ${type} payload`);
  return payload as Extract<QueuePayload, { job_type: T }>;
}

async function sideEffectCounts(userId: string) {
  const [quotes, reservations, workflows, ledger] = await Promise.all([
    resource.db.select({ value: count() }).from(runQuotes).where(eq(runQuotes.userId, userId)),
    resource.db
      .select({ value: count() })
      .from(creditReservations)
      .where(eq(creditReservations.userId, userId)),
    resource.db
      .select({ value: count() })
      .from(workflowRuns)
      .where(eq(workflowRuns.userId, userId)),
    resource.db
      .select({ value: count() })
      .from(creditLedger)
      .where(eq(creditLedger.userId, userId)),
  ]);
  return {
    quotes: quotes[0]?.value ?? 0,
    reservations: reservations[0]?.value ?? 0,
    workflows: workflows[0]?.value ?? 0,
    ledger: ledger[0]?.value ?? 0,
  };
}

async function cleanupRedisPrefix(): Promise<void> {
  if (redis.status === 'wait') await redis.connect();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${redisPrefix}:*`, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) await redis.unlink(...keys);
  } while (cursor !== '0');
}

async function openTestCircuit(): Promise<void> {
  await resource.db
    .insert(providerCircuitStates)
    .values([
      {
        scopeType: 'provider',
        scopeKey: `provider:${modelProvider}`,
        provider: modelProvider,
        modelId: null,
      },
      {
        scopeType: 'model',
        scopeKey: `model:${modelId}`,
        provider: modelProvider,
        modelId,
      },
    ])
    .onConflictDoNothing();
  await resource.db
    .update(providerCircuitStates)
    .set({ status: 'open', reasonCode: 'test_circuit_open' })
    .where(eq(providerCircuitStates.provider, modelProvider));
}

async function cleanupUser(userId: string): Promise<void> {
  await resource.db.delete(agentTranscriptItems).where(eq(agentTranscriptItems.userId, userId));
  await resource.db
    .delete(agentTranscriptPayloads)
    .where(eq(agentTranscriptPayloads.userId, userId));
  const turns = await resource.db.query.agentTurns.findMany({
    where: eq(agentTurns.userId, userId),
    columns: { id: true, sessionId: true },
  });
  const turnIds = turns.map((turn) => turn.id);
  const sessionIds = turns.map((turn) => turn.sessionId);
  const traces =
    turnIds.length > 0
      ? await resource.db.query.agentTraces.findMany({
          where: inArray(agentTraces.turnId, turnIds),
          columns: { id: true },
        })
      : [];
  const workflows = await resource.db.query.workflowRuns.findMany({
    where: eq(workflowRuns.userId, userId),
    columns: { id: true },
  });
  const workflowIds = workflows.map((workflow) => workflow.id);
  const userTasks =
    workflowIds.length > 0
      ? await resource.db.query.tasks.findMany({
          where: inArray(tasks.workflowRunId, workflowIds),
          columns: { id: true },
        })
      : [];
  const taskIds = userTasks.map((task) => task.id);
  const quotes = await resource.db.query.runQuotes.findMany({
    where: eq(runQuotes.userId, userId),
    columns: { id: true },
  });
  const quoteIds = quotes.map((quote) => quote.id);
  const aggregateIds = [...turnIds, ...workflowIds, ...taskIds, ...quoteIds];
  if (aggregateIds.length > 0) {
    await resource.db
      .delete(queueDispatchIntents)
      .where(inArray(queueDispatchIntents.aggregateId, aggregateIds));
    await resource.db.delete(eventOutbox).where(inArray(eventOutbox.scopeId, aggregateIds));
  }
  await resource.db
    .update(agentTurns)
    .set({ runQuoteId: null, workflowRunId: null })
    .where(eq(agentTurns.userId, userId));
  await resource.db
    .update(runQuotes)
    .set({ workflowRunId: null })
    .where(eq(runQuotes.userId, userId));
  await resource.db
    .update(creditReservations)
    .set({ workflowRunId: null })
    .where(eq(creditReservations.userId, userId));
  if (taskIds.length > 0) await resource.db.delete(tasks).where(inArray(tasks.id, taskIds));
  if (workflowIds.length > 0) {
    await resource.db.delete(workflowRuns).where(inArray(workflowRuns.id, workflowIds));
  }
  await resource.db.delete(creditLedger).where(eq(creditLedger.userId, userId));
  await resource.db.delete(creditReservations).where(eq(creditReservations.userId, userId));
  await resource.db.delete(runQuotes).where(eq(runQuotes.userId, userId));
  if (traces.length > 0) {
    await resource.db.delete(agentTraceSteps).where(
      inArray(
        agentTraceSteps.traceId,
        traces.map((trace) => trace.id),
      ),
    );
  }
  if (turnIds.length > 0) {
    await resource.db
      .delete(contentSafetyPreflights)
      .where(inArray(contentSafetyPreflights.turnId, turnIds));
    await resource.db
      .delete(agentTurnConfirmations)
      .where(inArray(agentTurnConfirmations.turnId, turnIds));
    await resource.db.delete(chatMessages).where(inArray(chatMessages.turnId, turnIds));
    await resource.db.delete(agentTraces).where(inArray(agentTraces.turnId, turnIds));
    await resource.db.delete(agentTurns).where(inArray(agentTurns.id, turnIds));
  }
  if (sessionIds.length > 0) {
    await resource.db.delete(chatSessions).where(inArray(chatSessions.id, sessionIds));
  }
  await resource.db.delete(creditAccounts).where(eq(creditAccounts.userId, userId));
  await resource.db.delete(users).where(eq(users.id, userId));
}

beforeAll(async () => {
  await installCompilerCatalog();
});

afterEach(async () => {
  await resource.db.update(models).set({ status: 'poc_passed' }).where(eq(models.id, modelId));
  await resource.db
    .update(providerCircuitStates)
    .set({
      status: 'closed',
      reasonCode: null,
      probeAfter: null,
      probeOwner: null,
    })
    .where(eq(providerCircuitStates.modelId, modelId));
  await resource.db
    .update(providerCircuitStates)
    .set({
      status: 'closed',
      reasonCode: null,
      probeAfter: null,
      probeOwner: null,
    })
    .where(eq(providerCircuitStates.provider, modelProvider));
  await resource.db
    .update(providerCircuitStates)
    .set({
      status: 'closed',
      reasonCode: null,
      probeAfter: null,
      probeOwner: null,
    })
    .where(eq(providerCircuitStates.modelId, moderationModelId));
  await resource.db
    .update(skillPackages)
    .set({ status: 'approved', riskStatus: 'clear', disabledAt: null })
    .where(eq(skillPackages.id, packageRecordId));
  for (const userId of trackedUsers) await cleanupUser(userId);
  trackedUsers.clear();
  await cleanupRedisPrefix();
});

afterAll(async () => {
  for (const userId of trackedUsers) await cleanupUser(userId);
  await resource.db.delete(providerCircuitStates).where(eq(providerCircuitStates.modelId, modelId));
  await resource.db
    .delete(providerCircuitStates)
    .where(eq(providerCircuitStates.provider, modelProvider));
  if (previousPricingCatalogReleaseId === undefined) {
    await resource.db.delete(pricingCatalogState).where(eq(pricingCatalogState.id, 'global'));
  } else {
    await resource.db
      .update(pricingCatalogState)
      .set({
        activeReleaseId: previousPricingCatalogReleaseId,
        catalogRevision: previousPricingCatalogRevision,
      })
      .where(eq(pricingCatalogState.id, 'global'));
  }
  await resource.db.delete(billableSkus).where(eq(billableSkus.id, billableSkuId));
  await resource.db
    .delete(modelCatalogEntries)
    .where(eq(modelCatalogEntries.id, modelCatalogEntryId));
  await resource.db
    .delete(pricingCatalogReleases)
    .where(eq(pricingCatalogReleases.id, pricingReleaseId));
  if (previousModerationTextState) {
    await resource.db
      .update(moderationRuntimeStates)
      .set({
        activeModelSnapshotId: previousModerationTextState.activeModelSnapshotId,
        runtimeRevision: previousModerationTextState.runtimeRevision,
        updatedByAdminId: previousModerationTextState.updatedByAdminId,
      })
      .where(eq(moderationRuntimeStates.capability, 'moderation.text'));
  }
  if (previousModerationImageState) {
    await resource.db
      .update(moderationRuntimeStates)
      .set({
        activeModelSnapshotId: previousModerationImageState.activeModelSnapshotId,
        runtimeRevision: previousModerationImageState.runtimeRevision,
        updatedByAdminId: previousModerationImageState.updatedByAdminId,
      })
      .where(eq(moderationRuntimeStates.capability, 'moderation.image'));
  }
  await resource.db
    .delete(providerCircuitStates)
    .where(eq(providerCircuitStates.modelId, moderationModelId));
  await resource.db.delete(modelPocRuns).where(eq(modelPocRuns.modelSnapshotId, moderationModelId));
  await resource.db.delete(models).where(eq(models.id, moderationModelId));
  await resource.db.delete(models).where(eq(models.id, modelId));
  await resource.db
    .update(providerChannels)
    .set({ activeCredentialVersionId: null })
    .where(eq(providerChannels.id, providerChannelId));
  await resource.db
    .delete(providerCredentialVersions)
    .where(eq(providerCredentialVersions.id, providerCredentialId));
  await resource.db.delete(providerChannels).where(eq(providerChannels.id, providerChannelId));
  if (storageChannelId && storageCredentialId && storageValidationId) {
    if (previousStorageState) {
      await resource.db
        .update(storageRuntimeState)
        .set({
          activeChannelId: previousStorageState.activeChannelId,
          runtimeRevision: previousStorageState.runtimeRevision,
        })
        .where(eq(storageRuntimeState.purpose, 'private_assets'));
    } else {
      await resource.db
        .delete(storageRuntimeState)
        .where(eq(storageRuntimeState.purpose, 'private_assets'));
    }
    await resource.db
      .update(storageChannels)
      .set({ activeCredentialVersionId: null })
      .where(eq(storageChannels.id, storageChannelId));
    await resource.db
      .delete(storageValidationRuns)
      .where(eq(storageValidationRuns.id, storageValidationId));
    await resource.db
      .delete(storageCredentialVersions)
      .where(eq(storageCredentialVersions.id, storageCredentialId));
    await resource.db.delete(storageChannels).where(eq(storageChannels.id, storageChannelId));
  }
  await resource.db.delete(adminPrincipals).where(eq(adminPrincipals.id, moderationAdminId));
  if (previousCatalogReleaseId === undefined) {
    await resource.db.delete(skillCatalogState).where(eq(skillCatalogState.id, 'global'));
  } else {
    await resource.db
      .update(skillCatalogState)
      .set({
        activeReleaseId: previousCatalogReleaseId,
        revision: previousSkillCatalogRevision,
      })
      .where(eq(skillCatalogState.id, 'global'));
  }
  await resource.db.delete(skillCatalogReleases).where(eq(skillCatalogReleases.id, releaseId));
  await resource.db
    .delete(skillResourceSnapshots)
    .where(eq(skillResourceSnapshots.skillId, primarySkillId));
  await resource.db.delete(skills).where(eq(skills.id, primarySkillId));
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
  await cleanupRedisPrefix();
  if (redis.status !== 'end') await redis.quit().catch(() => redis.disconnect());
  await resource.client.end();
});

describe('S09 deterministic compiler integration', () => {
  it('compiler R1-R5: rejects a forged candidate without financial side effects', async () => {
    const fixture = await createTurn({});
    await processTurn(fixture, brainFor(candidate({ provider: 'forged-provider' })));
    expect(await sideEffectCounts(fixture.userId)).toEqual({
      quotes: 0,
      reservations: 0,
      workflows: 0,
      ledger: 1,
    });
    const turn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    expect(turn).toMatchObject({ status: 'blocked', runQuoteId: null, workflowRunId: null });
  });

  it('compiler concurrency: persists one quote, compiler trace, submit intent, and expiry intent', async () => {
    const fixture = await createTurn({});
    const repository = new AgentTurnRepository(resource.db);
    const claimed = await repository.claim({
      turnId: fixture.turnId,
      sessionId: fixture.sessionId,
      traceId: fixture.traceId,
      userMessageId: fixture.messageId,
      continuationNo: 1,
      payloadRevision: 1,
      leaseMs: 10_000,
      now: new Date(),
    });
    if (!claimed) throw new Error('Failed to claim S09 turn');
    const context = await new CompilerContextService(
      resource.db,
      config,
      registry.version,
      new Set([modelId]),
    ).build(claimed);
    const compiled = compilePlan({ candidate: candidate(), context, registry });
    if (compiled.status !== 'compiled') throw new Error('S09 test plan did not compile');
    const llmStep = await captureCandidate(claimed);
    if (!llmStep) throw new Error('Failed to create S09 llm step');
    const compiler = new AgentCompilerRepository(resource.db);
    const results = await Promise.all([
      compiler.persistCompiled({
        claimed,
        revision: claimed.revision,
        llmStepId: llmStep.id,
        compiled,
      }),
      compiler.persistCompiled({
        claimed,
        revision: claimed.revision,
        llmStepId: llmStep.id,
        compiled,
      }),
    ]);
    expect(new Set(results.map((result) => result?.quoteId)).size).toBe(1);
    const [quotes, compilerSteps, cards, intents] = await Promise.all([
      resource.db.query.runQuotes.findMany({ where: eq(runQuotes.userId, fixture.userId) }),
      resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, fixture.traceId),
      }),
      resource.db.query.eventOutbox.findMany({ where: eq(eventOutbox.scopeId, fixture.turnId) }),
      resource.db.query.queueDispatchIntents.findMany({
        where: eq(queueDispatchIntents.aggregateType, 'run_quote'),
      }),
    ]);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.confirmationSnapshot).toEqual({});
    expect(compilerSteps.filter((step) => step.stepType === 'compiler_check')).toHaveLength(1);
    expect(cards.filter((event) => event.eventType === 'turn.confirmation_required')).toHaveLength(
      0,
    );
    expect(
      intents
        .map((intent) => parseQueuePayload(intent.payload))
        .filter(
          (payload) =>
            payload.job_type === 'agent.quote.expire' && payload.turn_id === fixture.turnId,
        ),
    ).toHaveLength(1);
  });

  it.each(['planning', 'authoring'] as const)(
    'reads only an affirmative, intact %s cross-group clarification as quote authorization',
    async (phase) => {
      const fixture = await createTurn({});
      const repository = new AgentTurnRepository(resource.db);
      const claimed = await repository.claim({
        turnId: fixture.turnId,
        sessionId: fixture.sessionId,
        traceId: fixture.traceId,
        userMessageId: fixture.messageId,
        continuationNo: 1,
        payloadRevision: 1,
        leaseMs: 10_000,
        now: new Date(),
      });
      if (!claimed) throw new Error('Failed to claim S09 turn');
      const llmStep = await captureCandidate(claimed, candidate(), phase);
      const scopeDigest = canonicalSha256({ bindings: ['old', 'recent'], output_count: 2 });
      await repository.requestClarification({
        claimed,
        revision: claimed.revision,
        llmStepId: llmStep.id,
        question: '这次要同时处理两组照片吗？',
        suggestions: ['只处理最近上传的照片', '同时处理这两组照片'],
        scopeDigest,
      });
      const confirmation = await resource.db.query.agentTurnConfirmations.findFirst({
        where: eq(agentTurnConfirmations.turnId, fixture.turnId),
      });
      expect(confirmation?.publicPayloadJson).toMatchObject({
        scope_digest: scopeDigest,
        allow_free_text: false,
      });
      const parent = await resource.db.query.agentTranscriptItems.findFirst({
        where: eq(agentTranscriptItems.sourceKey, `model:${llmStep.id}:output`),
      });
      const receipt = await resource.db.query.agentTranscriptItems.findFirst({
        where: eq(agentTranscriptItems.sourceKey, `assistant:${parent!.id}:result:0`),
      });
      expect(receipt).toBeDefined();
      expect(
        (
          await createNativeTranscriptReader(resource.db).readItem({
            userId: fixture.userId,
            sessionId: fixture.sessionId,
            itemId: receipt!.id,
          })
        ).item.payload_json,
      ).toMatchObject({
        status: 'succeeded',
        result: { value: { type: 'scope_confirmation_requested', scope_digest: scopeDigest } },
      });
      const service = new CompilerContextService(
        resource.db,
        config,
        registry.version,
        new Set([modelId]),
      );
      expect((await service.build(claimed)).confirmed_cross_group_scope_digest).toBeUndefined();
      const answeredFields = {
        status: 'answered' as const,
        idempotencyKey: randomUUID(),
        requestHash: canonicalSha256({ answer: 'yes' }),
        responseJson: { status: 'accepted' },
        answeredAt: new Date(),
      };
      await resource.db
        .update(agentTurnConfirmations)
        .set({ ...answeredFields, answerJson: { selected_option_id: 'option-1' } })
        .where(eq(agentTurnConfirmations.id, confirmation!.id));
      expect((await service.build(claimed)).confirmed_cross_group_scope_digest).toBeUndefined();
      expect((await service.build(claimed)).declined_cross_group_scope_digest).toBe(scopeDigest);
      await resource.db
        .update(agentTurnConfirmations)
        .set({ answerJson: { selected_option_id: 'option-2' } })
        .where(eq(agentTurnConfirmations.id, confirmation!.id));
      expect((await service.build(claimed)).confirmed_cross_group_scope_digest).toBe(scopeDigest);
      expect((await service.build(claimed)).declined_cross_group_scope_digest).toBeUndefined();
    },
  );

  it('rejects an invalid cross-group plan before requesting confirmation or quoting', async () => {
    const fixture = await createTurn({ message: 'Use both upload groups' });
    const sourceIds = [randomUUID(), randomUUID()];
    try {
      await resource.db.insert(assets).values(
        sourceIds.map((id) => ({
          id,
          userId: fixture.userId,
          displayName: 'scope source',
          storageKey: `s09-scope/${id}`,
          thumbnailKey: `s09-scope/${id}/thumb`,
          contentHash: 'a'.repeat(64),
          fileSizeBytes: 100n,
          mimeType: 'image/png',
          kind: 'upload' as const,
          origin: 'upload' as const,
          status: 'ready' as const,
        })),
      );
      const repository = new AgentTurnRepository(resource.db);
      const claimed = await repository.claim({
        turnId: fixture.turnId,
        sessionId: fixture.sessionId,
        traceId: fixture.traceId,
        userMessageId: fixture.messageId,
        continuationNo: 1,
        payloadRevision: 1,
        leaseMs: 10_000,
        now: new Date(),
      });
      if (!claimed) throw new Error('Failed to claim S09 turn');
      claimed.sessionImageCandidates = sessionImageCandidatesSchema.parse(
        sourceIds.map((id, index) => ({
          binding_key: `session-source-${index + 1}`,
          kind: 'asset',
          object_id: id,
          object_version: 'a'.repeat(64),
          content_hash: 'a'.repeat(64),
          owner_user_id: fixture.userId,
          readable: true,
          mutable: false,
          producer_mode: null,
          producer_session_id: null,
          mutation_owner: null,
          source_action: null,
          media_type: 'image',
          lifecycle: 'active',
          visibility: 'private',
          role: 'semantic_reference',
          position: index,
          publication_revision: null,
          candidate_kind: 'original_source',
          candidate_position: index + 1,
          lineage_source_binding_keys: [],
          source_group: {
            message_id: randomUUID(),
            created_at: `2026-09-2${index + 7}T00:00:00.000Z`,
            is_latest_upload: index === 1,
          },
        })),
      );
      delete claimed.modelSelection;
      const plan = candidate({
        scope_decision: {
          mode: 'conversation_reference',
          input_binding_keys: ['session-source-1', 'session-source-2'],
          output_count: 1,
          reason_summary: 'User requested both groups.',
        },
      });
      plan.nodes[0]!.input_bindings = ['session-source-1', 'session-source-2'];
      const scopeContext = await new CompilerContextService(
        resource.db,
        config,
        registry.version,
        new Set([modelId]),
      ).build(claimed);
      expect(compilePlan({ candidate: plan, context: scopeContext, registry })).toMatchObject({
        status: 'rejected',
        code: 'reference_unavailable',
        details: [{ rule_id: 'binding_kind_not_allowed' }],
      });
      const step = await captureCandidate(claimed, plan);
      const worker = new AgentProcessorWorker(
        resource.db,
        redis,
        config,
        new ActiveWorkTracker(),
        new WorkerWriteFence(),
        { publish: vi.fn().mockResolvedValue(undefined) },
        brainFor(plan),
        registry,
        new Set([modelId]),
      );
      try {
        await (
          worker as unknown as {
            handleCandidatePlan(
              turn: ClaimedAgentTurn,
              revision: number,
              llmStepId: string,
              rawCandidate: unknown,
            ): Promise<void>;
          }
        ).handleCandidatePlan(claimed, claimed.revision, step.id, plan);
      } finally {
        await worker.close(true);
      }
      expect(
        await resource.db.query.agentTurnConfirmations.findFirst({
          where: eq(agentTurnConfirmations.turnId, fixture.turnId),
        }),
      ).toBeUndefined();
      expect(
        await resource.db.query.agentTurns.findFirst({
          where: eq(agentTurns.id, fixture.turnId),
        }),
      ).toMatchObject({ status: 'blocked' });
      expect(await sideEffectCounts(fixture.userId)).toMatchObject({
        quotes: 0,
        reservations: 0,
        workflows: 0,
      });
    } finally {
      await resource.db.delete(assets).where(inArray(assets.id, sourceIds));
    }
  });

  it('requests cross-group clarification through the processor and rejects scope drift after reclaim', async () => {
    const fixture = await createTurn({ message: 'Create one composition from the photos' });
    const sourceIds = [randomUUID(), randomUUID(), randomUUID()];
    const groupIds = [randomUUID(), randomUUID()];
    const sources = sessionImageCandidatesSchema.parse(
      sourceIds.map((id, index) => ({
        binding_key: `session-source-${index + 1}`,
        kind: 'asset',
        object_id: id,
        object_version: 'a'.repeat(64),
        content_hash: 'a'.repeat(64),
        owner_user_id: fixture.userId,
        readable: true,
        mutable: false,
        producer_mode: null,
        producer_session_id: null,
        mutation_owner: null,
        source_action: null,
        media_type: 'image',
        lifecycle: 'active',
        visibility: 'private',
        role: 'semantic_reference',
        position: index,
        publication_revision: null,
        candidate_kind: 'original_source',
        candidate_position: index + 1,
        lineage_source_binding_keys: [],
        source_group: {
          message_id: groupIds[index === 0 ? 0 : 1],
          created_at: index === 0 ? '2026-09-27T00:00:00.000Z' : '2026-09-28T00:00:00.000Z',
          is_latest_upload: index !== 0,
        },
      })),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Delegate other turns to the real instance via .call.
    const originalResolve = AgentSessionImageCandidateService.prototype.resolve;
    const candidates = vi.spyOn(AgentSessionImageCandidateService.prototype, 'resolve');
    candidates.mockImplementation(function (this: AgentSessionImageCandidateService, claimed) {
      return claimed.turnId === fixture.turnId
        ? Promise.resolve(sources)
        : originalResolve.call(this, claimed);
    });
    const scopeRegistry = new CapabilityRegistry(registry.version, [
      {
        ...imageAdapter,
        allowedBindingKinds: ['asset'],
      },
    ]);
    const plan = {
      ...candidate(),
      scope_decision: {
        mode: 'conversation_reference',
        input_binding_keys: ['session-source-1', 'session-source-2'],
        output_count: 1,
        reason_summary: 'Use two upload groups for one composition.',
      },
    };
    plan.nodes[0]!.input_bindings = ['session-source-1', 'session-source-2'];
    try {
      await resource.db.insert(assets).values(
        sourceIds.map((id) => ({
          id,
          userId: fixture.userId,
          displayName: 'scope source',
          storageKey: `s09-scope/${id}`,
          thumbnailKey: `s09-scope/${id}/thumb`,
          contentHash: 'a'.repeat(64),
          fileSizeBytes: 100n,
          mimeType: 'image/png',
          kind: 'upload' as const,
          origin: 'upload' as const,
          status: 'ready' as const,
        })),
      );
      await processTurn(fixture, brainFor(plan), scopeRegistry);
      const confirmation = await resource.db.query.agentTurnConfirmations.findFirst({
        where: eq(agentTurnConfirmations.turnId, fixture.turnId),
      });
      expect(confirmation).toMatchObject({ status: 'pending', type: 'clarification' });
      const confirmationPayload = confirmation?.publicPayloadJson as {
        scope_digest: string;
        allow_free_text: boolean;
      };
      expect(confirmationPayload.scope_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(confirmationPayload.allow_free_text).toBe(false);
      expect(await sideEffectCounts(fixture.userId)).toEqual({
        quotes: 0,
        reservations: 0,
        workflows: 0,
        ledger: 1,
      });
      await resource.db
        .update(agentTurnConfirmations)
        .set({
          status: 'answered',
          answerJson: { selected_option_id: 'option-2' },
          idempotencyKey: randomUUID(),
          requestHash: canonicalSha256({ answer: 'yes' }),
          responseJson: { status: 'accepted' },
          answeredAt: new Date(),
        })
        .where(eq(agentTurnConfirmations.id, confirmation!.id));
      await resource.db
        .update(agentTurns)
        .set({
          status: 'loading_context',
          continuationNo: 2,
          processingOwner: null,
          processingLeaseExpiresAt: null,
        })
        .where(eq(agentTurns.id, fixture.turnId));
      const claimed = await new AgentTurnRepository(resource.db).claim({
        turnId: fixture.turnId,
        sessionId: fixture.sessionId,
        traceId: fixture.traceId,
        userMessageId: fixture.messageId,
        continuationNo: 2,
        payloadRevision: 1,
        leaseMs: 10_000,
        now: new Date(),
      });
      if (!claimed) throw new Error('Failed to reclaim confirmed scope');
      const context = await new CompilerContextService(
        resource.db,
        config,
        scopeRegistry.version,
        new Set([modelId]),
      ).build(claimed);
      expect(context.confirmed_cross_group_scope_digest).toBe(
        (confirmation!.publicPayloadJson as { scope_digest: string }).scope_digest,
      );
      expect(compilePlan({ candidate: plan, context, registry: scopeRegistry }).status).toBe(
        'compiled',
      );
      for (const kind of ['bindings', 'count'] as const) {
        const drifted = structuredClone(plan);
        if (kind === 'bindings') {
          drifted.nodes[0]!.input_bindings = ['session-source-1', 'session-source-3'];
          drifted.scope_decision.input_binding_keys = ['session-source-1', 'session-source-3'];
        } else {
          drifted.nodes[0]!.params.output_count = 2;
          drifted.scope_decision.output_count = 2;
        }
        expect(compilePlan({ candidate: drifted, context, registry: scopeRegistry })).toMatchObject(
          {
            status: 'rejected',
            code: 'clarification_required',
            details: [{ rule_id: 'cross_upload_group_confirmation_required' }],
          },
        );
      }
      expect(await sideEffectCounts(fixture.userId)).toEqual({
        quotes: 0,
        reservations: 0,
        workflows: 0,
        ledger: 1,
      });
    } finally {
      candidates.mockRestore();
      await resource.db.delete(assets).where(inArray(assets.id, sourceIds));
    }
  });

  it('keeps repeated safety waits delayed without spending attempts or calling the Brain again', async () => {
    const fixture = await createTurn({});
    const brain = brainFor(candidate());
    const step = vi.spyOn(brain, 'runStep');
    let waiting = true;
    let waits = 0;
    const failures: Record<string, unknown>[] = [];
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Delegate to the real instance via .call.
    const execute = ContentSafetyPreflightService.prototype.execute;
    const safety = vi.spyOn(ContentSafetyPreflightService.prototype, 'execute');
    safety.mockImplementation(function (this: ContentSafetyPreflightService, claimed, plan) {
      if (claimed.turnId === fixture.turnId && waiting) {
        waits += 1;
        return Promise.resolve({ status: 'pending' as const });
      }
      return execute.call(this, claimed, plan);
    });
    const createWorker = () =>
      new AgentProcessorWorker(
        resource.db,
        redis,
        { ...config, agentProcessingRetryBaseMs: 50 },
        new ActiveWorkTracker(),
        new WorkerWriteFence(),
        { publish: vi.fn().mockResolvedValue(undefined) },
        brain,
        registry,
        new Set([modelId]),
        { info: () => undefined, error: (event) => failures.push(event) },
      );
    let worker = createWorker();
    const queue = new Queue('agent', {
      connection: createBullMqConnection(redisUrl),
      prefix: redisPrefix,
    });
    const publisher = new BullMqQueuePublisher(config);
    const recover = vi.fn(
      (id: string, payload: Parameters<BullMqQueuePublisher['recoverAgentJob']>[1]) =>
        payload.turn_id === fixture.turnId
          ? publisher.recoverAgentJob(id, payload)
          : Promise.resolve('pending' as const),
    );
    const sweeper = new AgentTurnRecoverySweeper(resource.db, { recoverAgentJob: recover });
    const jobId = `s09-wait-${fixture.turnId}`;
    try {
      const intent = await new QueueIntentRepository(resource.db).create({
        queueName: 'agent',
        jobId,
        aggregateType: 'agent_turn',
        aggregateId: fixture.turnId,
        payloadVersion: 1,
        payload: continuePayload(fixture),
      });
      await resource.db
        .update(queueDispatchIntents)
        .set({ status: 'dispatched' })
        .where(eq(queueDispatchIntents.id, intent.id));
      await publisher.add('agent', jobId, continuePayload(fixture));
      await expect.poll(() => waits, { timeout: 10_000 }).toBeGreaterThanOrEqual(5);
      await worker.pauseNewWork();
      await expect.poll(() => queue.getJobState(jobId), { timeout: 10_000 }).toBe('delayed');
      expect((await queue.getJob(jobId))?.attemptsMade).toBe(0);
      expect(step).toHaveBeenCalledTimes(1);
      expect(await sideEffectCounts(fixture.userId)).toMatchObject({
        quotes: 0,
        reservations: 0,
        workflows: 0,
      });
      for (let index = 0; index < 5; index += 1) {
        expect(await sweeper.sweep()).toEqual({ requeued: 0, exhausted: 0 });
      }
      expect(
        recover.mock.calls.filter(([, payload]) => payload.turn_id === fixture.turnId),
      ).toHaveLength(5);
      expect(
        await resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      ).toMatchObject({ endedAt: null });
      waiting = false;
      await worker.close(false);
      worker = createWorker();
      await expect.poll(() => queue.getJobState(jobId), { timeout: 10_000 }).toBe('completed');
      expect((await queue.getJob(jobId))?.attemptsMade).toBe(1);
      expect(step).toHaveBeenCalledTimes(1);
      expect(await sideEffectCounts(fixture.userId)).toMatchObject({ quotes: 1 });
    } catch (error) {
      const turn = await resource.db.query.agentTurns.findFirst({
        where: eq(agentTurns.id, fixture.turnId),
        columns: { status: true, revision: true, processingLeaseExpiresAt: true },
      });
      throw new Error(`Safety wait did not converge: ${JSON.stringify({ failures, turn })}`, {
        cause: error,
      });
    } finally {
      await worker.close(false);
      await queue.close();
      await publisher.close();
      safety.mockRestore();
    }
  });

  it.each(['not_dispatched', 'outcome_unknown'] as const)(
    'bounds %s safety recovery without quoting or re-running the model',
    async (outcome) => {
      const fixture = await createTurn({});
      const brain = brainFor(candidate());
      const step = vi.spyOn(brain, 'runStep');
      let calls = 0;
      const controlledSafety = new ContentSafetyPreflightService(
        resource.db,
        async (input) => {
          calls += 1;
          if (outcome === 'not_dispatched') return { decision: 'not_dispatched' };
          expect(await input.markPotentiallyDispatched()).toBe(true);
          return {
            decision: 'unknown',
            policy_version: 'content-safety@1',
            error_code: 'provider_timeout',
          };
        },
        config.agentProcessingLeaseMs,
        'test',
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Delegate to the selected real instance via .call.
      const execute = ContentSafetyPreflightService.prototype.execute;
      const safety = vi.spyOn(ContentSafetyPreflightService.prototype, 'execute');
      safety.mockImplementation(function (this: ContentSafetyPreflightService, claimed, plan) {
        return execute.call(
          claimed.turnId === fixture.turnId ? controlledSafety : this,
          claimed,
          plan,
        );
      });
      const worker = new AgentProcessorWorker(
        resource.db,
        redis,
        config,
        new ActiveWorkTracker(),
        new WorkerWriteFence(),
        { publish: vi.fn().mockResolvedValue(undefined) },
        brain,
        registry,
        new Set([modelId]),
      );
      const queue = new Queue('agent', {
        connection: createBullMqConnection(redisUrl),
        prefix: redisPrefix,
      });
      const publisher = new BullMqQueuePublisher({
        ...config,
        agentProcessingRetryAttempts: 4,
        agentProcessingRetryBaseMs: 10,
      });
      const jobId = `s09-safety-${fixture.turnId}`;
      try {
        await publisher.add('agent', jobId, continuePayload(fixture));
        await expect.poll(() => queue.getJobState(jobId), { timeout: 10_000 }).toBe('completed');
        expect(calls).toBe(outcome === 'not_dispatched' ? 4 : 1);
        expect(step).toHaveBeenCalledTimes(1);
        expect(await sideEffectCounts(fixture.userId)).toMatchObject({
          quotes: 0,
          reservations: 0,
          workflows: 0,
        });
        expect(
          await resource.db.query.agentTurns.findFirst({
            where: eq(agentTurns.id, fixture.turnId),
          }),
        ).toMatchObject({ status: 'blocked', processingOwner: null });
        const rows = await resource.db.query.contentSafetyPreflights.findMany({
          where: eq(contentSafetyPreflights.turnId, fixture.turnId),
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe(outcome === 'not_dispatched' ? 'queued' : 'outcome_unknown');
      } finally {
        await worker.close(true);
        await queue.close();
        await publisher.close();
        safety.mockRestore();
      }
    },
  );

  it('compiler cost snapshot: concurrently auto-submits once and replays one workflow', async () => {
    const fixture = await createTurn({});
    await processTurn(fixture, brainFor(candidate()));
    const payload = await quotePayload(fixture, 'agent.quote.submit');
    const service = new AgentQuoteService(resource.db, {
      publish: vi.fn().mockResolvedValue(undefined),
    });
    await Promise.all([service.submit(payload), service.submit(payload)]);
    const [account, ledger, reservations, workflows, storedTasks, turn] = await Promise.all([
      resource.db.query.creditAccounts.findFirst({
        where: eq(creditAccounts.userId, fixture.userId),
      }),
      resource.db.query.creditLedger.findMany({ where: eq(creditLedger.userId, fixture.userId) }),
      resource.db.query.creditReservations.findMany({
        where: eq(creditReservations.userId, fixture.userId),
      }),
      resource.db.query.workflowRuns.findMany({ where: eq(workflowRuns.userId, fixture.userId) }),
      resource.db.query.tasks.findMany(),
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
    ]);
    expect(reservations).toHaveLength(1);
    expect(workflows).toHaveLength(1);
    expect(ledger.filter((entry) => entry.type === 'reservation_freeze')).toHaveLength(1);
    expect(storedTasks.filter((task) => task.workflowRunId === workflows[0]!.id)).toHaveLength(2);
    expect(account).toMatchObject({ balance: '8.00', frozen: '2.00', version: 2 });
    expect(turn).toMatchObject({
      status: 'waiting_provider_confirmation',
      workflowRunId: workflows[0]!.id,
    });
  });

  it('fails closed when a replayed compiler result has a different digest', async () => {
    const fixture = await createTurn({});
    const repository = new AgentTurnRepository(resource.db);
    const claimed = await repository.claim({
      turnId: fixture.turnId,
      sessionId: fixture.sessionId,
      traceId: fixture.traceId,
      userMessageId: fixture.messageId,
      continuationNo: 1,
      payloadRevision: 1,
      leaseMs: 10_000,
      now: new Date(),
    });
    if (!claimed) throw new Error('Failed to claim S09 turn');
    const context = await new CompilerContextService(
      resource.db,
      config,
      registry.version,
      new Set([modelId]),
    ).build(claimed);
    const first = compilePlan({ candidate: candidate(), context, registry });
    const different = compilePlan({
      candidate: candidate({
        nodes: [
          {
            ...candidate().nodes[0],
            params: { ...candidate().nodes[0]!.params, output_count: 2 },
          },
        ],
      }),
      context,
      registry,
    });
    if (first.status !== 'compiled' || different.status !== 'compiled') {
      throw new Error('S09 conflict fixture did not compile');
    }
    const llmStep = await captureCandidate(claimed);
    if (!llmStep) throw new Error('Failed to create S09 conflict step');
    const compiler = new AgentCompilerRepository(resource.db);
    await compiler.persistCompiled({
      claimed,
      revision: claimed.revision,
      llmStepId: llmStep.id,
      compiled: first,
    });
    await expect(
      compiler.persistCompiled({
        claimed,
        revision: claimed.revision,
        llmStepId: llmStep.id,
        compiled: different,
      }),
    ).rejects.toThrow('AGENT_COMPILER_DIGEST_CONFLICT');
    expect(
      await resource.db
        .select({ value: count() })
        .from(runQuotes)
        .where(eq(runQuotes.userId, fixture.userId)),
    ).toEqual([{ value: 1 }]);
  });

  it('cancels an insufficient-credit auto-submit without freezing or showing a cost card', async () => {
    const fixture = await createTurn({
      balance: '1.00',
    });
    await processTurn(fixture, brainFor(candidate()));
    const service = new AgentQuoteService(resource.db, {
      publish: vi.fn().mockResolvedValue(undefined),
    });
    const payload = await quotePayload(fixture, 'agent.quote.submit');
    await service.submit(payload);
    await service.submit(payload);
    const [turn, quote, trace, workflows, ledger, failures] = await Promise.all([
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.runQuotes.findFirst({ where: eq(runQuotes.userId, fixture.userId) }),
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
      resource.db.query.workflowRuns.findMany({ where: eq(workflowRuns.userId, fixture.userId) }),
      resource.db.query.creditLedger.findMany({ where: eq(creditLedger.userId, fixture.userId) }),
      resource.db.query.eventOutbox.findMany({ where: eq(eventOutbox.scopeId, fixture.turnId) }),
    ]);
    expect(turn?.status).toBe('blocked');
    expect(trace?.status).toBe('blocked');
    expect(quote?.status).toBe('cancelled');
    expect(workflows).toHaveLength(0);
    expect(ledger.filter((entry) => entry.type === 'reservation_freeze')).toHaveLength(0);
    expect(failures.filter((event) => event.eventType === 'turn.failed')).toHaveLength(1);
    expect(failures.find((event) => event.eventType === 'turn.failed')?.payload).toMatchObject({
      public_error_code: 'INSUFFICIENT_CREDITS',
      summary:
        '本次生成所需积分超过当前可用余额，未开始生成；请减少生成数量或联系管理员补充积分后重试',
      user_status: 'failed',
    });
    expect(
      failures.filter((event) => event.eventType === 'turn.confirmation_required'),
    ).toHaveLength(0);
  });

  it('fails closed when the provider circuit opens before compiled quote persistence', async () => {
    const fixture = await createTurn({});
    const repository = new AgentTurnRepository(resource.db);
    const claimed = await repository.claim({
      turnId: fixture.turnId,
      sessionId: fixture.sessionId,
      traceId: fixture.traceId,
      userMessageId: fixture.messageId,
      continuationNo: 1,
      payloadRevision: 1,
      leaseMs: 10_000,
      now: new Date(),
    });
    if (!claimed) throw new Error('Failed to claim S09 circuit drift turn');
    const context = await new CompilerContextService(
      resource.db,
      config,
      registry.version,
      new Set([modelId]),
    ).build(claimed);
    const compiled = compilePlan({ candidate: candidate(), context, registry });
    if (compiled.status !== 'compiled')
      throw new Error('S09 circuit drift fixture did not compile');
    await openTestCircuit();
    expect(
      await resource.db.query.providerCircuitStates.findMany({
        where: eq(providerCircuitStates.provider, modelProvider),
        columns: { scopeKey: true, status: true, reasonCode: true },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'open', reasonCode: 'test_circuit_open' }),
      ]),
    );
    const compiledModelId = compiled.canonical_plan.tasks[0]?.model_snapshot.id;
    expect(compiledModelId).toBe(modelId);
    const llmStep = await captureCandidate(claimed);
    if (!llmStep) throw new Error('Failed to create S09 circuit drift step');
    await expect(
      new AgentCompilerRepository(resource.db).persistCompiled({
        claimed,
        revision: claimed.revision,
        llmStepId: llmStep.id,
        compiled,
      }),
    ).rejects.toThrow('AGENT_TRANSCRIPT_WRITE_FAILED');
    expect(await sideEffectCounts(fixture.userId)).toEqual({
      quotes: 0,
      reservations: 0,
      workflows: 0,
      ledger: 1,
    });
  });

  it('does not freeze credits when a quoted Agent model circuit is open at automatic submit', async () => {
    const fixture = await createTurn({});
    await processTurn(fixture, brainFor(candidate()));
    const payload = await quotePayload(fixture, 'agent.quote.submit');
    await openTestCircuit();
    const storedQuote = await resource.db.query.runQuotes.findFirst({
      where: eq(runQuotes.id, payload.quote_id),
      columns: { source: true, sourceId: true, submissionMode: true, planSnapshot: true },
    });
    expect(storedQuote).toMatchObject({
      source: 'chat',
      sourceId: fixture.turnId,
      submissionMode: 'auto_submit',
    });
    expect(
      (
        storedQuote?.planSnapshot as {
          items?: Array<{ paramsSnapshot?: { model_snapshot?: { id?: string } } }>;
        }
      ).items?.[0]?.paramsSnapshot?.model_snapshot?.id,
    ).toBe(modelId);
    const service = new AgentQuoteService(resource.db, {
      publish: vi.fn().mockResolvedValue(undefined),
    });
    await expect(service.submit(payload)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(await sideEffectCounts(fixture.userId)).toEqual({
      quotes: 1,
      reservations: 0,
      workflows: 0,
      ledger: 1,
    });
  });

  it('cancels an automatic quote and blocks the turn when account risk changes', async () => {
    const fixture = await createTurn({});
    await processTurn(fixture, brainFor(candidate()));
    const payload = await quotePayload(fixture, 'agent.quote.submit');
    await resource.db
      .update(users)
      .set({ riskStatus: 'limited' })
      .where(eq(users.id, fixture.userId));
    const service = new AgentQuoteService(resource.db, {
      publish: vi.fn().mockResolvedValue(undefined),
    });
    await service.submit(payload);
    await service.submit(payload);
    const [quote, turn, trace, workflows, freezes, failures] = await Promise.all([
      resource.db.query.runQuotes.findFirst({ where: eq(runQuotes.id, payload.quote_id) }),
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
      resource.db.query.workflowRuns.findMany({ where: eq(workflowRuns.userId, fixture.userId) }),
      resource.db.query.creditLedger.findMany({ where: eq(creditLedger.userId, fixture.userId) }),
      resource.db.query.eventOutbox.findMany({ where: eq(eventOutbox.scopeId, fixture.turnId) }),
    ]);
    expect(quote?.status).toBe('cancelled');
    expect(turn?.status).toBe('blocked');
    expect(trace?.status).toBe('blocked');
    expect(workflows).toHaveLength(0);
    expect(freezes.filter((entry) => entry.type === 'reservation_freeze')).toHaveLength(0);
    expect(failures.filter((event) => event.eventType === 'turn.failed')).toHaveLength(1);
    expect(failures.find((event) => event.eventType === 'turn.failed')?.payload).toMatchObject({
      public_error_code: 'AGENT_TOOL_NOT_ALLOWED',
      summary: '当前状态不允许使用该能力',
      user_status: 'failed',
    });
  });

  it('queues a new workflow when the user already has an active workflow', async () => {
    const second = await createTurn({});
    await processTurn(second, brainFor(candidate()));
    await resource.db.insert(workflowRuns).values({
      userId: second.userId,
      triggerMode: 'chat',
      status: 'queued',
      planSnapshot: { test_run_id: second.userId },
      skillSnapshot: {},
      pricingSnapshot: {},
    });
    const service = new AgentQuoteService(resource.db, {
      publish: vi.fn().mockResolvedValue(undefined),
    });
    const payload = await quotePayload(second, 'agent.quote.submit');
    await service.submit(payload);
    await service.submit(payload);
    const [turn, quote, trace, workflows, freezes, failures] = await Promise.all([
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, second.turnId) }),
      resource.db.query.runQuotes.findFirst({ where: eq(runQuotes.id, payload.quote_id) }),
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, second.traceId) }),
      resource.db.query.workflowRuns.findMany({ where: eq(workflowRuns.userId, second.userId) }),
      resource.db.query.creditLedger.findMany({ where: eq(creditLedger.userId, second.userId) }),
      resource.db.query.eventOutbox.findMany({ where: eq(eventOutbox.scopeId, second.turnId) }),
    ]);
    expect(turn?.status).toBe('waiting_provider_confirmation');
    expect(quote?.status).toBe('submitted');
    expect(trace?.status).toBe('succeeded');
    expect(workflows).toHaveLength(2);
    expect(turn?.workflowRunId).toBe(
      workflows.find((workflow) => workflow.runQuoteId === payload.quote_id)?.id,
    );
    expect(freezes.filter((entry) => entry.type === 'reservation_freeze')).toHaveLength(1);
    expect(failures.filter((event) => event.eventType === 'turn.failed')).toHaveLength(0);
    expect(
      failures.filter((event) => event.eventType === 'turn.confirmation_required'),
    ).toHaveLength(0);
  });

  it('lets submit and expiry race to exactly one terminal quote outcome', async () => {
    const fixture = await createTurn({});
    await processTurn(fixture, brainFor(candidate()));
    const submit = await quotePayload(fixture, 'agent.quote.submit');
    const expire = await quotePayload(fixture, 'agent.quote.expire');
    const service = new AgentQuoteService(resource.db, {
      publish: vi.fn().mockResolvedValue(undefined),
    });
    await Promise.allSettled([
      service.submit(submit),
      service.expire(expire, new Date(Date.now() + 700_000)),
    ]);
    const [quote, turn, workflows] = await Promise.all([
      resource.db.query.runQuotes.findFirst({ where: eq(runQuotes.id, submit.quote_id) }),
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.workflowRuns.findMany({ where: eq(workflowRuns.userId, fixture.userId) }),
    ]);
    expect(['submitted', 'expired']).toContain(quote?.status);
    if (quote?.status === 'submitted') {
      expect(workflows).toHaveLength(1);
      expect(turn?.workflowRunId).toBe(workflows[0]!.id);
    } else {
      expect(workflows).toHaveLength(0);
      expect(turn?.status).toBe('cancelled');
    }
  });

  it.each([
    [
      'model',
      async () =>
        resource.db.update(models).set({ status: 'disabled' }).where(eq(models.id, modelId)),
    ],
    [
      'skill',
      async () =>
        resource.db
          .update(skillPackages)
          .set({ status: 'disabled', disabledAt: new Date() })
          .where(eq(skillPackages.id, packageRecordId)),
    ],
  ])('fails closed when the %s snapshot drifts after Brain output', async (_kind, drift) => {
    const fixture = await createTurn({});
    await processTurn(
      fixture,
      brainFor(candidate(), async () => {
        const before = await resource.db.query.agentTurns.findFirst({
          where: eq(agentTurns.id, fixture.turnId),
          columns: { revision: true },
        });
        await expect
          .poll(
            async () =>
              (
                await resource.db.query.agentTurns.findFirst({
                  where: eq(agentTurns.id, fixture.turnId),
                  columns: { revision: true },
                })
              )?.revision,
            { timeout: 3000 },
          )
          .toBeGreaterThan(before!.revision);
        await drift();
      }),
    );
    expect(await sideEffectCounts(fixture.userId)).toEqual({
      quotes: 0,
      reservations: 0,
      workflows: 0,
      ledger: 1,
    });
  });

  it('expires an unsubmitted automatic quote and cancels its turn and trace', async () => {
    const fixture = await createTurn({});
    await processTurn(fixture, brainFor(candidate()));
    const payload = await quotePayload(fixture, 'agent.quote.expire');
    await new AgentQuoteService(resource.db, {
      publish: vi.fn().mockResolvedValue(undefined),
    }).expire(payload, new Date(Date.now() + 700_000));
    const [quote, turn, trace] = await Promise.all([
      resource.db.query.runQuotes.findFirst({ where: eq(runQuotes.id, payload.quote_id) }),
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
    ]);
    expect(quote?.status).toBe('expired');
    expect(turn?.status).toBe('cancelled');
    expect(trace?.status).toBe('cancelled');
  });

  it('atomically cancels an Agent turn when an automatic submit finds an expired quote', async () => {
    const fixture = await createTurn({});
    await processTurn(fixture, brainFor(candidate()));
    const payload = await quotePayload(fixture, 'agent.quote.submit');
    await resource.db
      .update(runQuotes)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(runQuotes.id, payload.quote_id));
    let expiredError: unknown;
    try {
      await submitRunQuote({
        database: resource.db,
        ports: {
          createQueueIntent: createQueueIntentInTransaction,
          appendOutboxEvent: appendOutboxEventInTransaction,
        },
        userId: fixture.userId,
        quoteId: payload.quote_id,
        idempotencyKey: `s09-expired-submit:${fixture.turnId}`,
        evidence: {
          kind: 'generate_action@v2',
          turn_id: payload.turn_id,
          continuation_no: payload.continuation_no,
          plan_digest: payload.plan_digest,
          authorization_digest: payload.authorization_digest,
        },
      });
    } catch (error) {
      expiredError = error;
    }
    expect(expiredError).toMatchObject({ code: 'RUN_QUOTE_EXPIRED' });
    const [quote, turn, trace, cancellations] = await Promise.all([
      resource.db.query.runQuotes.findFirst({ where: eq(runQuotes.id, payload.quote_id) }),
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
      resource.db.query.eventOutbox.findMany({ where: eq(eventOutbox.scopeId, fixture.turnId) }),
    ]);
    expect(quote?.status).toBe('expired');
    expect(turn?.status).toBe('cancelled');
    expect(trace?.status).toBe('cancelled');
    expect(cancellations.filter((event) => event.eventType === 'turn.cancelled')).toHaveLength(1);
  });

  it('rebuilds only live Agent submit and expiry intents after Redis loss', async () => {
    const fixture = await createTurn({});
    await processTurn(fixture, brainFor(candidate()));
    const intents = await resource.db.query.queueDispatchIntents.findMany({
      where: eq(queueDispatchIntents.aggregateType, 'run_quote'),
    });
    const own = intents.filter((intent) => {
      const payload = parseQueuePayload(intent.payload);
      return (
        ['agent.quote.submit', 'agent.quote.expire'].includes(payload.job_type) &&
        'turn_id' in payload &&
        payload.turn_id === fixture.turnId
      );
    });
    for (const intent of own) {
      await resource.db
        .update(queueDispatchIntents)
        .set({ status: 'dispatched' })
        .where(eq(queueDispatchIntents.id, intent.id));
    }
    await redis.del(queueRecoverySentinelKey(redisPrefix));
    const published: Array<{ queueName: string; payload: QueuePayload; next?: Date }> = [];
    const reconciler = new QueueReconciler(
      resource.db,
      resource.client,
      redis,
      new QueueIntentRepository(resource.db),
      {
        add(queueName, _jobId, payload, next) {
          published.push({ queueName, payload, ...(next ? { next } : {}) });
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      },
      config,
    );
    const summary = await reconciler.reconcile();
    expect(summary.rebuilt).toBeGreaterThanOrEqual(2);
    const ownPublished = published.filter(
      (item) => 'turn_id' in item.payload && item.payload.turn_id === fixture.turnId,
    );
    expect(ownPublished.map((item) => item.payload.job_type).sort()).toEqual([
      'agent.quote.expire',
      'agent.quote.submit',
    ]);
    expect(
      ownPublished.find((item) => item.payload.job_type === 'agent.quote.expire')?.next,
    ).toBeInstanceOf(Date);
  });
});
