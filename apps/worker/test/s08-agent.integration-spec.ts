import { randomUUID, createHash } from 'node:crypto';

import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DETERMINISTIC_FAKE_AGENT_MODEL_ID,
  AgentBrainCallError,
  callPositionKey,
  deterministicFakeAgentModelSnapshot,
  toolFingerprint,
  type AgentBrainPort,
  type AgentBrainStepInput,
  type AgentBrainStepOutcome,
} from '@ecom-forge/agent';
import {
  adminPrincipals,
  and,
  agentTraces,
  agentTraceSteps,
  agentTranscriptItems,
  agentTranscriptPayloads,
  agentTurnConfirmations,
  agentTurns,
  assets,
  chatMessages,
  chatSessions,
  contentSafetyPreflights,
  count,
  creditLedger,
  createDatabaseClient,
  eq,
  eventOutbox,
  inArray,
  modelPocRuns,
  models,
  moderationRuntimeStates,
  pricingCatalogReleases,
  providerChannels,
  providerCircuitStates,
  providerCredentialVersions,
  queueDispatchIntents,
  runQuotes,
  sql,
  skillCatalogReleases,
  skillPackageValidationReports,
  skillPackageResources,
  skillPackages,
  skillResourceSnapshots,
  skills,
  users,
  workflowRuns,
} from '@ecom-forge/db';
import { DeterministicFakeAgentBrain, nativeTranscriptMessages } from '@ecom-forge/provider';
import { LocalPrivateStorage } from '@ecom-forge/storage';
import sharp from 'sharp';
import {
  compositeJobId,
  createBullMqConnection,
  QueueIntentRepository,
  type QueuePayload,
} from '@ecom-forge/queue';
import { canonicalSha256, utf8Sha256 } from '@ecom-forge/shared';
import {
  parseSkillDefinition,
  resolveBuiltinSkill,
  validateSkillSelection,
  type AuxiliarySkillSelectionSnapshot,
  type SkillSelectionSnapshot,
} from '@ecom-forge/skills';

import { AgentTurnRepository } from '../src/agent/agent-turn.repository.js';
import { AgentTurnLeaseRepository } from '../src/agent/agent-turn-lease.repository.js';
import { AgentTurnRecoverySweeper } from '../src/agent/agent-turn-recovery.sweeper.js';
import {
  AgentSessionImageCandidateService,
  sessionImageCandidatesSchema,
} from '../src/agent/agent-session-image-candidate.service.js';
import { AgentTurnToolRepository } from '../src/agent/agent-turn-tool.repository.js';
import { AgentLlmCostRepository } from '../src/agent/agent-llm-cost.repository.js';
import { createNativeTranscriptReader } from '../src/agent/agent-transcript-native-reader.js';
import { NativeTranscriptDependencies } from '../src/agent/agent-transcript-native-reader.js';
import { authorizeHistoricalBuiltinDependency } from '../src/agent/agent-transcript-builtin-history.js';
import { AgentTranscriptCoreSkillReader } from '../src/agent/agent-transcript-skill-reader.js';
import {
  prepareTranscriptCoreSkillContext,
  transcriptCoreSkillDependencies,
} from '../src/agent/agent-transcript-skill-context.js';
import { nativeTranscriptContracts } from '../src/agent/agent-transcript-native.js';
import { projectNativeTranscriptMessages } from '../src/agent/agent-transcript-brain-view.js';
import { readNativeTranscriptRecovery } from '../src/agent/agent-transcript-recovery.js';
import { verifyStoredTranscriptItem } from '../src/agent/agent-transcript-storage-mapping.js';
import type { WorkerConfig } from '../src/config/worker-config.js';
import { ActiveWorkTracker, WorkerWriteFence } from '../src/lifecycle/processing-fence.js';
import { AgentProcessorWorker } from '../src/processors/agent-processor.js';
import { SkillRuntimeAdapter } from '../src/agent/skill-runtime.adapter.js';
import type { WorkerLifecycleLogger } from '../src/lifecycle/worker-lifecycle.js';
import { QueueReconciler } from '../src/queue/reconciler.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/1';
const redisPrefix = `s08-test-${randomUUID().replaceAll('-', '')}`;
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '').toLowerCase();
if (!/_test(?:_|$)/.test(databaseName)) {
  throw new Error('S08 Worker integration tests require a database name containing _test');
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
  agentRequestTimeoutMs: 500,
  agentProcessingLeaseMs: 10_000,
  agentProcessingRenewMs: 200,
  agentProcessingRetryAttempts: 3,
  agentProcessingRetryBaseMs: 100,
  agentMaxLlmRounds: 6,
  agentMaxToolCalls: 12,
  agentMaxInputTokens: 96_000,
  agentMaxOutputTokens: 8_192,
  agentBrainStepMaxOutputTokens: 1_024,
  agentBrainImageMaxEdge: 1_536,
  agentBrainRetryBaseDelayMs: 10,
  agentBrainRetryMaxDelayMs: 20,
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
const fakeModelSnapshot = deterministicFakeAgentModelSnapshot({
  maxInputTokens: config.agentMaxInputTokens,
  maxOutputTokens: config.agentMaxOutputTokens,
});
const fixtureModelSelectionSnapshot = {
  schema_version: 1 as const,
  catalog_revision: 1,
  catalog_release_id: '00000000-0000-4000-8000-000000000001',
  catalog_release_digest: 'a'.repeat(64),
  brain: {
    catalog_entry_id: '00000000-0000-4000-8000-000000000002',
    catalog_entry_revision: 1,
    version_no: 1,
    public_slug: 'fixture-brain',
    display_name: 'Fixture Brain',
    model_snapshot_id: '00000000-0000-4000-8000-000000000003',
  },
  image: {
    catalog_entry_id: '00000000-0000-4000-8000-000000000004',
    catalog_entry_revision: 1,
    version_no: 1,
    public_slug: 'fixture-image',
    display_name: 'Fixture Image',
    model_snapshot_id: '00000000-0000-4000-8000-000000000005',
    selected_spec_key: 'default',
    selected_operation: 'image.generate' as const,
    supported_aspect_ratios: ['1:1'],
  },
};
const fixtureGenerationPreferences = {
  schema_version: 2 as const,
  output_kind: 'image' as const,
  aspect_ratio: '1:1',
  resolution_tier: '1k' as const,
};
const testTokenCounter = () => 1;

const tracked = {
  users: new Set<string>(),
  sessions: new Set<string>(),
  turns: new Set<string>(),
  intents: new Set<string>(),
  packages: new Set<string>(),
  skills: new Set<string>(),
};

let packageRecordId: string;
let catalogReleaseId: string;
let selection: SkillSelectionSnapshot;

function queuePayload(input: {
  turnId: string;
  sessionId: string;
  traceId: string;
  messageId: string;
  revision?: number;
}): Extract<QueuePayload, { job_type: 'agent.continue' }> {
  return {
    schema_version: 1,
    job_type: 'agent.continue',
    trace_id: input.traceId,
    session_id: input.sessionId,
    turn_id: input.turnId,
    user_message_id: input.messageId,
    continuation_no: 1,
    turn_revision: input.revision ?? 1,
  };
}

async function installSkillFixture(): Promise<void> {
  packageRecordId = randomUUID();
  tracked.packages.add(packageRecordId);
  const suffix = packageRecordId.slice(0, 8);
  const primarySkillId = `s08-worker-primary-${suffix}@1.0.0`;
  const requiredSkillId = `s08-worker-required-${suffix}@1.0.0`;
  const optionalSkillId = `s08-worker-optional-${suffix}@1.0.0`;
  for (const skillId of [primarySkillId, requiredSkillId, optionalSkillId]) {
    tracked.skills.add(skillId);
  }
  const resources = [
    {
      skillId: primarySkillId,
      path: 'SKILL.md',
      type: 'planning_view',
      content: '# Primary planning',
    },
    {
      skillId: primarySkillId,
      path: 'presets/clean.md',
      type: 'preset',
      content: '# Clean preset',
    },
    {
      skillId: requiredSkillId,
      path: 'SKILL.md',
      type: 'planning_view',
      content: '# Required knowledge',
    },
    {
      skillId: optionalSkillId,
      path: 'SKILL.md',
      type: 'planning_view',
      content: '# Optional knowledge',
    },
    {
      skillId: optionalSkillId,
      path: 'references/composition.md',
      type: 'reference',
      content: '# Composition reference',
    },
  ] as const;
  await resource.db.insert(skillPackages).values({
    id: packageRecordId,
    packageId: `s08-worker-package-${suffix}`,
    packageVersion: '1.0.0',
    packageDigest: canonicalSha256({ packageRecordId }),
    archiveSha256: canonicalSha256({ archive: packageRecordId }),
    manifestJson: { schema_version: 1, test_run_id: packageRecordId },
    status: 'approved',
    riskStatus: 'clear',
    sourceType: 'first_party',
    quarantineStorageKey: `s08-test/${packageRecordId}`,
    uploadExpiresAt: new Date(Date.now() + 60_000),
    approvedBy: 's08-worker-test',
    approvedAt: new Date(),
  });
  const packageResources = await resource.db
    .insert(skillPackageResources)
    .values(
      resources.map((item) => ({
        packageRecordId,
        resourcePath: `${item.skillId}/${item.path}`,
        resourceType: item.type,
        mediaType: 'text/markdown',
        byteSize: Buffer.byteLength(item.content),
        contentHash: utf8Sha256(item.content),
        storageKey: `s08-test/${packageRecordId}/${item.skillId}/${item.path}`,
        skillId: item.skillId,
        rightsMetadataJson: { source: 'first_party', test_run_id: packageRecordId },
      })),
    )
    .returning();
  const definitions = new Map(
    [primarySkillId, requiredSkillId, optionalSkillId].map((skillId) => {
      const planning = resources.find(
        (item) => item.skillId === skillId && item.path === 'SKILL.md',
      )!;
      return [
        skillId,
        parseSkillDefinition({
          schema_version: 1,
          slug: skillId.split('@')[0]!,
          version: '1.0.0',
          display_name: skillId,
          description: 'Isolated Worker integration knowledge.',
          kind: skillId === primarySkillId ? 'primary' : 'auxiliary',
          visibility: skillId === primarySkillId ? 'public' : 'internal',
          domain: 'creative',
          category: 's08-test',
          stage: '1A',
          planning_view: { path: 'SKILL.md', content_hash: utf8Sha256(planning.content) },
          ...(skillId === primarySkillId
            ? {
                required_capabilities: ['image.generate'],
                dependencies: [
                  { skill_id: requiredSkillId, mode: 'required', reason: 'Shared knowledge' },
                  { skill_id: optionalSkillId, mode: 'optional', reason: 'Optional knowledge' },
                ],
                preset_slots: [
                  {
                    slot: 'style',
                    label: 'Style',
                    required: true,
                    max_selections: 1,
                    options: [
                      {
                        preset_id: `s08-clean-${suffix}@1.0.0`,
                        name: 'Clean',
                        description: 'Clean preset',
                        resource_path: 'presets/clean.md',
                        resource_hash: utf8Sha256(resources[1].content),
                      },
                    ],
                  },
                ],
              }
            : {}),
        }),
      ];
    }),
  );
  const definitionHash = (skillId: string) => canonicalSha256(definitions.get(skillId));
  await resource.db.insert(skills).values([
    {
      id: primarySkillId,
      slug: primarySkillId.split('@')[0]!,
      name: 'S08 Worker Primary',
      category: 's08-test',
      domain: 'creative',
      kind: 'primary',
      visibility: 'public',
      stage: '1A',
      version: '1.0.0',
      packageRecordId,
      skillDigest: canonicalSha256({ skillId: primarySkillId }),
      definitionJson: definitions.get(primarySkillId)!,
      definitionHash: definitionHash(primarySkillId),
      price: {},
      status: 'published',
      publishedAt: new Date(),
    },
    ...[requiredSkillId, optionalSkillId].map((skillId) => ({
      id: skillId,
      slug: skillId.split('@')[0]!,
      name: skillId === requiredSkillId ? 'S08 Required' : 'S08 Optional',
      category: 's08-test',
      domain: 'creative' as const,
      kind: 'auxiliary' as const,
      visibility: 'internal' as const,
      stage: '1A',
      version: '1.0.0',
      packageRecordId,
      skillDigest: canonicalSha256({ skillId }),
      definitionJson: definitions.get(skillId)!,
      definitionHash: definitionHash(skillId),
      price: {},
      status: 'published' as const,
      publishedAt: new Date(),
    })),
  ]);
  const snapshots = resources.map((item, index) => ({
    id: randomUUID(),
    skillId: item.skillId,
    resourcePath: item.path,
    resourceType: item.type,
    contentHash: utf8Sha256(item.content),
    packageResourceId: packageResources[index]!.id,
    contentText: item.content,
    kvKey: `s08:${packageRecordId}:${index}`,
    summaryJson: { test_run_id: packageRecordId },
  }));
  await resource.db.insert(skillResourceSnapshots).values(snapshots);
  const reportId = randomUUID();
  await resource.db.insert(skillPackageValidationReports).values({
    id: reportId,
    packageRecordId,
    packageRevision: 1,
    packageDigest: canonicalSha256({ packageRecordId }),
    attemptNo: 1,
    status: 'passed',
    validatorContractVersion: 's08-test-v1',
    platformEvalSuiteDigest: canonicalSha256({ suite: 's08-test' }),
    reportJson: { passed: true },
    reportDigest: canonicalSha256({ passed: true }),
    completedAt: new Date(),
  });
  await resource.db
    .update(skillPackages)
    .set({
      approvedValidationReportId: reportId,
      latestValidationReportId: reportId,
    })
    .where(eq(skillPackages.id, packageRecordId));
  const releaseManifest = {
    schema_version: 1,
    packages: [
      {
        package_record_id: packageRecordId,
        validation_report_id: reportId,
        package_digest: canonicalSha256({ packageRecordId }),
        skills: [primarySkillId, requiredSkillId, optionalSkillId].map((skillId) => ({
          skill_id: skillId,
          definition_hash: definitionHash(skillId),
          resources: snapshots
            .filter((item) => item.skillId === skillId)
            .map((item) => ({
              skill_resource_snapshot_id: item.id,
              package_resource_id: item.packageResourceId,
              resource_path: item.resourcePath,
              content_hash: item.contentHash,
            })),
        })),
      },
    ],
  };
  catalogReleaseId = randomUUID();
  const releases = await resource.db.query.skillCatalogReleases.findMany({
    columns: { releaseNo: true },
  });
  await resource.db.insert(skillCatalogReleases).values({
    id: catalogReleaseId,
    releaseNo: Math.max(0, ...releases.map((item) => item.releaseNo)) + 1,
    status: 'published',
    releaseDigest: canonicalSha256(releaseManifest),
    manifestJson: releaseManifest,
    reason: 'S08 isolated native fixture',
    createdBy: 's08-test',
    approvedBy: 's08-test',
    publishedAt: new Date(),
  });
  const snapshotFor = (index: number) => ({
    resource_snapshot_id: snapshots[index]!.id,
    package_resource_id: packageResources[index]!.id,
    resource_path: snapshots[index]!.resourcePath,
    resource_hash: snapshots[index]!.contentHash,
  });
  selection = {
    primary_skill_id: primarySkillId,
    primary_name: 'S08 Worker Primary',
    primary_definition_hash: definitionHash(primarySkillId),
    primary_package_record_id: packageRecordId,
    required_capabilities: ['image.generate'],
    default_output_count: 1,
    primary_planning_resource: snapshotFor(0),
    primary_reference_resources: [],
    catalog_release_id: catalogReleaseId,
    catalog_version: canonicalSha256(releaseManifest),
    preset_selections: [
      {
        slot: 'style',
        preset_id: `s08-clean-${suffix}@1.0.0`,
        name: 'Clean',
        ...snapshotFor(1),
      },
    ],
    required_auxiliary: [
      {
        skill_id: requiredSkillId,
        name: 'S08 Required',
        definition_hash: definitionHash(requiredSkillId),
        package_record_id: packageRecordId,
        planning_resource: snapshotFor(2),
        reference_resources: [],
      },
    ],
    optional_auxiliary: [
      {
        skill_id: optionalSkillId,
        name: 'S08 Optional',
        definition_hash: definitionHash(optionalSkillId),
        package_record_id: packageRecordId,
        planning_resource: snapshotFor(3),
        reference_resources: [snapshotFor(4)],
      },
    ],
  };
}

let moderationModelId: string;
let moderationChannelId: string;
let moderationCredentialId: string;
let moderationAdminId: string;
let moderationPricingReleaseId: string;
let moderationTextPreviousState: {
  activeModelSnapshotId: string | null;
  runtimeRevision: number;
  updatedByAdminId: string | null;
} | null = null;
let moderationImagePreviousState: {
  activeModelSnapshotId: string | null;
  runtimeRevision: number;
  updatedByAdminId: string | null;
} | null = null;

/**
 * Seeds a fake moderation route so `ContentSafetyPreflightService` can resolve an active model
 * without stubbing it away. Mirrors the S09 fixture shape; the runtime state is restored on
 * cleanup instead of deleted because `moderationRuntimeStates` rows pre-exist in the database.
 */
async function installContentSafetyFixture(): Promise<void> {
  moderationAdminId = randomUUID();
  moderationChannelId = randomUUID();
  moderationCredentialId = randomUUID();
  moderationModelId = randomUUID();
  moderationPricingReleaseId = randomUUID();
  await resource.db.insert(adminPrincipals).values({
    id: moderationAdminId,
    identifierHash: `s08-${moderationAdminId}`,
    identifierKeyId: 's08-test-key',
    identifierHint: 's08-test',
    displayName: 'S08 test admin',
    status: 'active',
  });
  await resource.db.insert(providerChannels).values({
    id: moderationChannelId,
    provider: 'fake',
    adapterKey: 'fake-provider-v1',
    displayName: 'S08 moderation provider',
    baseUrl: 'https://local.invalid',
    endpointProfileKey: 'local',
    status: 'active',
  });
  await resource.db.insert(providerCredentialVersions).values({
    id: moderationCredentialId,
    providerChannelId: moderationChannelId,
    versionNo: 1,
    secretCiphertext: 's08-test-ciphertext',
    secretNonce: 's08-test-nonce',
    secretAuthTag: 's08-test-auth-tag',
    secretKeyId: 's08-test-key',
    keyHint: 's08-test',
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
    modelId: `s08-moderation-model-${moderationModelId.slice(0, 8)}`,
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
  await resource.db.insert(pricingCatalogReleases).values({
    id: moderationPricingReleaseId,
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
    releaseDigest: canonicalSha256({ pricing: moderationModelId }),
    manifestJson: { schema_version: 1, source: 's08-content-safety-fixture' },
    reason: 'S08 content safety integration test',
    publishedAt: new Date(),
  });
  const moderationRuntime = await resource.db.query.moderationRuntimeStates.findFirst({
    where: eq(moderationRuntimeStates.capability, 'moderation.text'),
  });
  const moderationImageRuntime = await resource.db.query.moderationRuntimeStates.findFirst({
    where: eq(moderationRuntimeStates.capability, 'moderation.image'),
  });
  if (!moderationRuntime || !moderationImageRuntime) {
    throw new Error('S08 moderation runtime state is missing');
  }
  moderationTextPreviousState = {
    activeModelSnapshotId: moderationRuntime.activeModelSnapshotId,
    runtimeRevision: moderationRuntime.runtimeRevision,
    updatedByAdminId: moderationRuntime.updatedByAdminId,
  };
  moderationImagePreviousState = {
    activeModelSnapshotId: moderationImageRuntime.activeModelSnapshotId,
    runtimeRevision: moderationImageRuntime.runtimeRevision,
    updatedByAdminId: moderationImageRuntime.updatedByAdminId,
  };
  await resource.db
    .update(moderationRuntimeStates)
    .set({
      activeModelSnapshotId: moderationModelId,
      runtimeRevision: moderationRuntime.runtimeRevision + 1,
      updatedByAdminId: moderationAdminId,
    })
    .where(eq(moderationRuntimeStates.capability, 'moderation.text'));
  await resource.db
    .update(moderationRuntimeStates)
    .set({
      activeModelSnapshotId: moderationModelId,
      runtimeRevision: moderationImageRuntime.runtimeRevision + 1,
      updatedByAdminId: moderationAdminId,
    })
    .where(eq(moderationRuntimeStates.capability, 'moderation.image'));
}

async function cleanupContentSafetyFixture(): Promise<void> {
  if (!moderationTextPreviousState) return;
  await resource.db
    .update(moderationRuntimeStates)
    .set({
      activeModelSnapshotId: moderationTextPreviousState.activeModelSnapshotId,
      runtimeRevision: moderationTextPreviousState.runtimeRevision,
      updatedByAdminId: moderationTextPreviousState.updatedByAdminId,
    })
    .where(eq(moderationRuntimeStates.capability, 'moderation.text'));
  if (moderationImagePreviousState) {
    await resource.db
      .update(moderationRuntimeStates)
      .set({
        activeModelSnapshotId: moderationImagePreviousState.activeModelSnapshotId,
        runtimeRevision: moderationImagePreviousState.runtimeRevision,
        updatedByAdminId: moderationImagePreviousState.updatedByAdminId,
      })
      .where(eq(moderationRuntimeStates.capability, 'moderation.image'));
    moderationImagePreviousState = null;
  }
  moderationTextPreviousState = null;
  await resource.db
    .delete(pricingCatalogReleases)
    .where(eq(pricingCatalogReleases.id, moderationPricingReleaseId));
  await resource.db
    .delete(providerCircuitStates)
    .where(eq(providerCircuitStates.modelId, moderationModelId));
  await resource.db
    .delete(contentSafetyPreflights)
    .where(eq(contentSafetyPreflights.modelSnapshotId, moderationModelId));
  await resource.db.delete(modelPocRuns).where(eq(modelPocRuns.modelSnapshotId, moderationModelId));
  await resource.db.delete(models).where(eq(models.id, moderationModelId));
  await resource.db
    .update(providerChannels)
    .set({ activeCredentialVersionId: null })
    .where(eq(providerChannels.id, moderationChannelId));
  await resource.db
    .delete(providerCredentialVersions)
    .where(eq(providerCredentialVersions.id, moderationCredentialId));
  await resource.db.delete(providerChannels).where(eq(providerChannels.id, moderationChannelId));
  await resource.db.delete(adminPrincipals).where(eq(adminPrincipals.id, moderationAdminId));
}

async function createTurn(
  message: string,
  withHistory = false,
  existing?: { userId: string; sessionId: string },
): Promise<{
  userId: string;
  sessionId: string;
  turnId: string;
  messageId: string;
  traceId: string;
  history?: Awaited<ReturnType<typeof seedCompactionHistory>>;
}> {
  const userId = existing?.userId ?? randomUUID();
  const sessionId = existing?.sessionId ?? randomUUID();
  const turnId = randomUUID();
  const messageId = randomUUID();
  const traceId = randomUUID();
  const executionAuthorization = {
    schema_version: 2 as const,
    kind: 'generate_action' as const,
    create_request_hash: canonicalSha256({ turn_id: turnId, message_id: messageId }),
    policy_version: config.agentExecutionPolicyVersion,
  };
  tracked.users.add(userId);
  tracked.sessions.add(sessionId);
  tracked.turns.add(turnId);
  if (!existing) {
    await resource.db.insert(users).values({
      id: userId,
      email: `s08-worker-${userId}@example.test`,
      displayName: 'S08 Worker user',
      emailVerifiedAt: new Date(),
    });
    await resource.db.insert(chatSessions).values({
      id: sessionId,
      userId,
      title: message,
      transcriptStateJson: {
        schema_version: 1,
        mode: 'active',
        integrity_version: 1,
        verified_through_sequence: '0',
        verified_digest: canonicalSha256([]),
      },
    });
  }
  const history = withHistory ? await seedCompactionHistory({ userId, sessionId }) : undefined;
  await resource.db.insert(agentTurns).values({
    id: turnId,
    sessionId,
    userId,
    status: 'received_user_input',
    executionFormat: 'transcript_v1',
    transcriptCaptureVersion: 1,
    primarySkillId: selection.primary_skill_id,
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
    content: message,
    attachments: [],
    skillSnapshots: [{ skill_id: selection.primary_skill_id }],
  });
  await resource.db.insert(agentTraces).values({
    id: traceId,
    turnId,
    sessionId,
    userId,
    brainModelId: DETERMINISTIC_FAKE_AGENT_MODEL_ID,
    brainModelSnapshotJson: fakeModelSnapshot,
    skillIds: [selection.primary_skill_id],
  });
  return { userId, sessionId, turnId, messageId, traceId, ...(history ? { history } : {}) };
}

async function seedCompletedTurn(input: {
  userId: string;
  sessionId: string;
  createdAt: Date;
  userContent: string;
  assistantContent: string;
}) {
  const turnId = randomUUID();
  const userMessageId = randomUUID();
  const traceId = randomUUID();
  const authorization = {
    schema_version: 2,
    kind: 'generate_action',
    create_request_hash: canonicalSha256({ turnId, userMessageId }),
    policy_version: config.agentExecutionPolicyVersion,
  };
  tracked.turns.add(turnId);
  await resource.db.insert(agentTurns).values({
    id: turnId,
    sessionId: input.sessionId,
    userId: input.userId,
    status: 'received_user_input',
    executionFormat: 'transcript_v1',
    transcriptCaptureVersion: 1,
    primarySkillId: selection.primary_skill_id,
    skillSelectionSnapshotJson: selection,
    skillSelectionSnapshotHash: canonicalSha256(selection),
    modelSelectionSnapshotJson: fixtureModelSelectionSnapshot,
    modelSelectionSnapshotHash: canonicalSha256(fixtureModelSelectionSnapshot),
    generationPreferencesJson: fixtureGenerationPreferences,
    generationPreferencesHash: canonicalSha256(fixtureGenerationPreferences),
    executionAuthorizationJson: authorization,
    executionAuthorizationHash: canonicalSha256(authorization),
    createdAt: input.createdAt,
  });
  await resource.db.insert(chatMessages).values([
    {
      id: userMessageId,
      sessionId: input.sessionId,
      turnId,
      role: 'user',
      content: input.userContent,
      attachments: [],
      skillSnapshots: [],
      createdAt: input.createdAt,
    },
  ]);
  await resource.db.insert(agentTraces).values({
    id: traceId,
    turnId,
    sessionId: input.sessionId,
    userId: input.userId,
    brainModelId: DETERMINISTIC_FAKE_AGENT_MODEL_ID,
    brainModelSnapshotJson: fakeModelSnapshot,
    skillIds: [selection.primary_skill_id],
  });
  await processTurn(
    { userId: input.userId, sessionId: input.sessionId, turnId, messageId: userMessageId, traceId },
    {
      countInputTokens: testTokenCounter,
      runStep: () =>
        Promise.resolve({
          type: 'respond',
          text: input.assistantContent,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    },
  );
  const assistant = await resource.db.query.chatMessages.findFirst({
    where: and(eq(chatMessages.turnId, turnId), eq(chatMessages.role, 'assistant')),
  });
  if (!assistant) throw new Error('Native history fixture failed to publish its response');
  return { turnId, userMessageId, assistantMessageId: assistant.id };
}

async function seedCompactionHistory(fixture: { userId: string; sessionId: string }) {
  const first = await seedCompletedTurn({
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    createdAt: new Date(Date.now() - 120_000),
    userContent: 'first-user-123',
    assistantContent: 'first-asst-123',
  });
  const second = await seedCompletedTurn({
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    createdAt: new Date(Date.now() - 80_000),
    userContent: 'second-user-12',
    assistantContent: 'second-asst-12',
  });
  const third = await seedCompletedTurn({
    userId: fixture.userId,
    sessionId: fixture.sessionId,
    createdAt: new Date(Date.now() - 40_000),
    userContent: 'last-user-1234',
    assistantContent: 'last-asst-1234',
  });
  return { first, second, third };
}

function coreResourceIds(): string[] {
  return [
    selection.primary_planning_resource.resource_snapshot_id,
    ...selection.preset_selections.map((item) => item.resource_snapshot_id),
    ...selection.required_auxiliary.map((item) => item.planning_resource.resource_snapshot_id),
  ];
}

function contextSnapshot(resourceIds = coreResourceIds()) {
  return {
    session_id: 'recovered',
    session_summary_version: 0,
    session_summary_hash: null,
    resource_snapshots: resourceIds.map((resourceId) => ({
      resource_snapshot_id: resourceId,
    })),
  };
}

async function seedRecoveredContext(
  fixture: Awaited<ReturnType<typeof createTurn>>,
  input: {
    inputTokens?: number;
    outputTokens?: number;
    steps?: Array<{
      stepType: 'llm_call' | 'tool_call' | 'observation';
      status: 'succeeded' | 'failed';
      toolFingerprint?: string;
      errorCode?: string;
      outputSummary?: Record<string, unknown>;
    }>;
    resourceIds?: string[];
  },
): Promise<void> {
  const snapshot = contextSnapshot(input.resourceIds);
  await resource.db
    .update(agentTurns)
    .set({ contextSnapshotJson: snapshot, contextSnapshotHash: canonicalSha256(snapshot) })
    .where(eq(agentTurns.id, fixture.turnId));
  await resource.db
    .update(agentTraces)
    .set({
      inputTokenTotal: input.inputTokens ?? 0,
      outputTokenTotal: input.outputTokens ?? 0,
    })
    .where(eq(agentTraces.id, fixture.traceId));
  if (!input.steps?.length) return;
  await resource.db.insert(agentTraceSteps).values(
    input.steps.map((step, index) => ({
      traceId: fixture.traceId,
      stepNo: index + 1,
      stepType: step.stepType,
      actor:
        step.stepType === 'llm_call'
          ? ('agent' as const)
          : step.stepType === 'observation'
            ? ('system' as const)
            : ('tool' as const),
      toolName: step.stepType === 'tool_call' ? 'load_skill@1' : undefined,
      toolFingerprint: step.toolFingerprint,
      inputSummary: { recovered_fixture: true },
      outputSummary: step.outputSummary ?? {},
      status: step.status,
      errorCode: step.errorCode,
      modelSnapshotJson: step.stepType === 'llm_call' ? fakeModelSnapshot : undefined,
      tokenUsageJson:
        step.stepType === 'llm_call' ? { input_tokens: 1, output_tokens: 1 } : undefined,
    })),
  );
}

async function expectNoChargeSideEffects(userId: string): Promise<void> {
  const [quotes, workflows, ledger] = await Promise.all([
    resource.db.select({ value: count() }).from(runQuotes).where(eq(runQuotes.userId, userId)),
    resource.db
      .select({ value: count() })
      .from(workflowRuns)
      .where(eq(workflowRuns.userId, userId)),
    resource.db
      .select({ value: count() })
      .from(creditLedger)
      .where(eq(creditLedger.userId, userId)),
  ]);
  expect(quotes[0]?.value).toBe(0);
  expect(workflows[0]?.value).toBe(0);
  expect(ledger[0]?.value).toBe(0);
}

function agentQueue(): Queue<Extract<QueuePayload, { job_type: 'agent.continue' }>> {
  return new Queue('agent', { connection: createBullMqConnection(redisUrl), prefix: redisPrefix });
}

async function processTurn(
  fixture: Awaited<ReturnType<typeof createTurn>>,
  brain: AgentBrainPort = new DeterministicFakeAgentBrain(),
  workerConfig: WorkerConfig = config,
  logger?: WorkerLifecycleLogger,
): Promise<void> {
  const worker = new AgentProcessorWorker(
    resource.db,
    redis,
    workerConfig,
    new ActiveWorkTracker(),
    new WorkerWriteFence(),
    { publish: vi.fn().mockResolvedValue(undefined) },
    brain,
    undefined,
    undefined,
    logger,
  );
  const queue = agentQueue();
  try {
    const payload = queuePayload(fixture);
    await queue.add('agent.continue', payload, {
      jobId: compositeJobId({
        job_type: payload.job_type,
        turn_id: payload.turn_id,
        continuation_no: payload.continuation_no,
      }),
    });
    await vi.waitFor(
      async () => {
        const turn = await resource.db.query.agentTurns.findFirst({
          where: eq(agentTurns.id, fixture.turnId),
        });
        expect(['done', 'waiting_user_confirmation', 'blocked', 'cancelled']).toContain(
          turn?.status,
        );
      },
      { timeout: 30_000 },
    );
  } finally {
    await worker.close(true);
    await queue.close();
  }
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

async function cleanupTurns(): Promise<void> {
  const turnIds = [...tracked.turns];
  if (tracked.intents.size > 0) {
    await resource.db
      .delete(queueDispatchIntents)
      .where(inArray(queueDispatchIntents.id, [...tracked.intents]));
    tracked.intents.clear();
  }
  if (tracked.sessions.size > 0) {
    await resource.db
      .update(chatSessions)
      .set({ summaryJson: {}, summaryVersion: 0, summaryThroughTurnId: null })
      .where(inArray(chatSessions.id, [...tracked.sessions]));
  }
  if (turnIds.length > 0) {
    const traces = await resource.db.query.agentTraces.findMany({
      where: inArray(agentTraces.turnId, turnIds),
      columns: { id: true },
    });
    if (traces.length > 0) {
      await resource.db.delete(agentTraceSteps).where(
        inArray(
          agentTraceSteps.traceId,
          traces.map((item) => item.id),
        ),
      );
    }
    await resource.db.delete(eventOutbox).where(inArray(eventOutbox.scopeId, turnIds));
    await resource.db
      .delete(agentTranscriptItems)
      .where(inArray(agentTranscriptItems.turnId, turnIds));
    await resource.db
      .delete(agentTranscriptPayloads)
      .where(inArray(agentTranscriptPayloads.sessionId, [...tracked.sessions]));
    await resource.db
      .delete(agentTurnConfirmations)
      .where(inArray(agentTurnConfirmations.turnId, turnIds));
    await resource.db.delete(chatMessages).where(inArray(chatMessages.turnId, turnIds));
    await resource.db.delete(agentTraces).where(inArray(agentTraces.turnId, turnIds));
    await resource.db
      .delete(contentSafetyPreflights)
      .where(inArray(contentSafetyPreflights.turnId, turnIds));
    await resource.db.delete(agentTurns).where(inArray(agentTurns.id, turnIds));
  }
  if (tracked.sessions.size > 0) {
    await resource.db.delete(chatSessions).where(inArray(chatSessions.id, [...tracked.sessions]));
  }
  if (tracked.users.size > 0) {
    await resource.db.delete(users).where(inArray(users.id, [...tracked.users]));
  }
  tracked.turns.clear();
  tracked.sessions.clear();
  tracked.users.clear();
}

beforeAll(async () => {
  await installSkillFixture();
});

beforeEach(async () => {
  await installContentSafetyFixture();
});

afterEach(async () => {
  await cleanupRedisPrefix();
  await cleanupTurns();
  await cleanupContentSafetyFixture();
});

afterAll(async () => {
  const skillIds = [...tracked.skills];
  if (skillIds.length > 0) {
    await resource.db
      .delete(skillResourceSnapshots)
      .where(inArray(skillResourceSnapshots.skillId, skillIds));
    await resource.db.delete(skills).where(inArray(skills.id, skillIds));
  }
  await resource.db
    .delete(skillPackageResources)
    .where(eq(skillPackageResources.packageRecordId, packageRecordId));
  await resource.db
    .delete(skillCatalogReleases)
    .where(eq(skillCatalogReleases.id, catalogReleaseId));
  await resource.db
    .update(skillPackages)
    .set({ approvedValidationReportId: null, latestValidationReportId: null })
    .where(eq(skillPackages.id, packageRecordId));
  await resource.db
    .delete(skillPackageValidationReports)
    .where(eq(skillPackageValidationReports.packageRecordId, packageRecordId));
  await resource.db.delete(skillPackages).where(eq(skillPackages.id, packageRecordId));
  await cleanupRedisPrefix();
  if (redis.status !== 'end') await redis.quit().catch(() => redis.disconnect());
  await resource.client.end();
});

describe('S08 Agent Worker integration', () => {
  it.each(['hash-drift', 'unsupported-version'] as const)(
    'rejects a %s designer snapshot before leasing or reserving any model call',
    async (invalid) => {
      const fixture = await createTurn('Continue the requested creative work');
      const preferences = {
        ...fixtureGenerationPreferences,
        creative_direction: { mode: 'auto', version: invalid === 'unsupported-version' ? 4 : 1 },
      };
      await resource.db
        .update(agentTurns)
        .set({
          generationPreferencesJson: preferences,
          generationPreferencesHash:
            invalid === 'hash-drift'
              ? canonicalSha256(fixtureGenerationPreferences)
              : canonicalSha256(preferences),
        })
        .where(eq(agentTurns.id, fixture.turnId));
      await expect(
        new AgentTurnLeaseRepository(resource.db).claim({
          turnId: fixture.turnId,
          sessionId: fixture.sessionId,
          traceId: fixture.traceId,
          userMessageId: fixture.messageId,
          continuationNo: 1,
          payloadRevision: 1,
          leaseMs: config.agentProcessingLeaseMs,
          now: new Date(),
        }),
      ).rejects.toThrow();
      const turn = await resource.db.query.agentTurns.findFirst({
        where: eq(agentTurns.id, fixture.turnId),
      });
      expect(turn?.status).toBe('received_user_input');
      expect(turn?.processingOwner).toBeNull();
      expect(
        await resource.db.query.agentTraceSteps.findMany({
          where: eq(agentTraceSteps.traceId, fixture.traceId),
        }),
      ).toHaveLength(0);
      await expectNoChargeSideEffects(fixture.userId);
    },
  );

  it('recovers the frozen designer selection and records only its safe diagnostic identity', async () => {
    const fixture = await createTurn('Continue the requested creative work');
    const direction = { mode: 'profile', profile_id: 'human-story', version: 1 };
    const preferences = { ...fixtureGenerationPreferences, creative_direction: direction };
    await resource.db
      .update(agentTurns)
      .set({
        generationPreferencesJson: preferences,
        generationPreferencesHash: canonicalSha256(preferences),
      })
      .where(eq(agentTurns.id, fixture.turnId));
    const runStep = vi.fn<AgentBrainPort['runStep']>().mockResolvedValue({
      type: 'respond',
      text: 'The direction is ready.',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });
    expect(runStep).toHaveBeenCalledOnce();
    expect(runStep.mock.calls[0]![0].creative_direction).toEqual(direction);
    const step = await resource.db.query.agentTraceSteps.findFirst({
      where: and(
        eq(agentTraceSteps.traceId, fixture.traceId),
        eq(agentTraceSteps.stepType, 'llm_call'),
      ),
    });
    expect(step?.inputSummary).toMatchObject({
      creative_direction: direction,
      creative_direction_hash: canonicalSha256(direction),
    });
    expect(
      (await resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }))
        ?.status,
    ).toBe('done');
    await expectNoChargeSideEffects(fixture.userId);
  });
  it.each(['content', 'version'] as const)(
    'continues an existing session with current builtin knowledge after a %s update',
    async (change) => {
      const builtin = await resolveBuiltinSkill('creative-free-generation@1.0.1');
      if (!builtin) throw new Error('Expected builtin fixture');
      const oldResource = builtin.resources.get('SKILL.md')!;
      const oldContent = builtin.resourceContent.get('SKILL.md')!;
      const oldDefinitionHash = builtin.definitionHash;
      const oldSkillId = builtin.skillId;
      const originalSelection = selection;
      const snapshot = (): SkillSelectionSnapshot => ({
        primary_skill_id: builtin.skillId,
        primary_name: builtin.definition.display_name,
        primary_definition_hash: builtin.definitionHash,
        primary_package_record_id: builtin.packageRecordId,
        primary_planning_resource: builtin.resources.get('SKILL.md')!,
        primary_reference_resources: [],
        catalog_release_id: builtin.catalogReleaseId,
        catalog_version: builtin.catalogVersion,
        required_capabilities: [],
        default_output_count: 1,
        preset_selections: [],
        required_auxiliary: [],
        optional_auxiliary: [],
      });
      try {
        selection = snapshot();
        const oldSelection = selection;
        const oldDependencies = transcriptCoreSkillDependencies(
          prepareTranscriptCoreSkillContext(selection),
        );
        const previous = await createTurn('Previous request');
        await processTurn(previous, {
          countInputTokens: testTokenCounter,
          runStep: () =>
            Promise.resolve({
              type: 'respond',
              text: 'Previous response',
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
        });
        expect(
          (
            await resource.db.query.agentTurns.findFirst({
              where: eq(agentTurns.id, previous.turnId),
            })
          )?.status,
        ).toBe('done');
        const newContent = `${oldContent}\nUpdated builtin method for this regression.\n`;
        if (change === 'version') builtin.skillId = `${builtin.definition.slug}@9999.0.0`;
        builtin.definitionHash = canonicalSha256({ updated: oldDefinitionHash });
        builtin.resources.set('SKILL.md', {
          ...oldResource,
          resource_snapshot_id: randomUUID(),
          resource_hash: utf8Sha256(newContent),
        });
        builtin.resourceContent.set('SKILL.md', newContent);
        selection = snapshot();
        const fixture = await createTurn(
          'Continue with the same Skill after an update',
          false,
          previous,
        );

        const dependencies = new NativeTranscriptDependencies(resource.db);
        expect(
          await authorizeHistoricalBuiltinDependency(
            resource.db,
            async (build) => build(),
            fixture,
            oldDependencies[0]!,
          ),
        ).toBe(true);
        expect(
          await dependencies.authorize(fixture.userId, oldDependencies, fixture.sessionId),
        ).toBe(true);
        expect(await dependencies.authorize(fixture.userId, oldDependencies, randomUUID())).toBe(
          false,
        );
        expect(await dependencies.authorize(randomUUID(), oldDependencies, fixture.sessionId)).toBe(
          false,
        );
        expect(
          await dependencies.authorize(
            fixture.userId,
            oldDependencies.map((entry) => ({ ...entry, resource_hash: 'f'.repeat(64) })),
            fixture.sessionId,
          ),
        ).toBe(false);
        const reader = new AgentTranscriptCoreSkillReader(resource.db);
        await expect(reader.materializeResources(oldDependencies)).rejects.toThrow();
        expect(await reader.materializeResources(oldDependencies, true)).toEqual([]);
        const runStep = vi.fn<AgentBrainPort['runStep']>().mockResolvedValue({
          type: 'respond',
          text: 'Continued with current knowledge',
          usage: { input_tokens: 1, output_tokens: 1 },
        });
        await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });
        expect(runStep).toHaveBeenCalledOnce();
        expect(runStep.mock.calls[0]![0].loaded_skills).toContainEqual(
          expect.objectContaining({ content: newContent }),
        );
        const turn = await resource.db.query.agentTurns.findFirst({
          where: eq(agentTurns.id, fixture.turnId),
        });
        expect(turn?.status).toBe('done');
        const externalSelection = { ...oldSelection, catalog_release_id: randomUUID() };
        await resource.db
          .update(agentTurns)
          .set({
            skillSelectionSnapshotJson: externalSelection,
            skillSelectionSnapshotHash: canonicalSha256(externalSelection),
          })
          .where(eq(agentTurns.id, previous.turnId));
        expect(
          await dependencies.authorize(
            fixture.userId,
            transcriptCoreSkillDependencies(prepareTranscriptCoreSkillContext(externalSelection)),
            fixture.sessionId,
          ),
        ).toBe(false);
        builtin.resourceContent.set('SKILL.md', 'corrupt current content');
        await expect(
          reader.materializeResources(
            transcriptCoreSkillDependencies(prepareTranscriptCoreSkillContext(selection)),
            true,
          ),
        ).rejects.toThrow();
        await resource.db
          .update(agentTurns)
          .set({ skillSelectionSnapshotHash: 'f'.repeat(64) })
          .where(eq(agentTurns.id, previous.turnId));
        expect(
          await dependencies.authorize(fixture.userId, oldDependencies, fixture.sessionId),
        ).toBe(false);
      } finally {
        selection = originalSelection;
        builtin.definitionHash = oldDefinitionHash;
        builtin.skillId = oldSkillId;
        builtin.resources.set('SKILL.md', oldResource);
        builtin.resourceContent.set('SKILL.md', oldContent);
      }
    },
  );

  it('rejects a legacy turn before claiming it or writing model and charge effects', async () => {
    const fixture = await createTurn('legacy execution must not resume');
    await resource.db
      .update(agentTurns)
      .set({
        executionFormat: 'legacy_v1',
        transcriptCaptureVersion: null,
      })
      .where(eq(agentTurns.id, fixture.turnId));
    const before = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    const repository = new AgentTurnRepository(resource.db);
    await expect(
      repository.claim({
        ...payloadToClaim(queuePayload(fixture)),
        leaseMs: 5_000,
        now: new Date(),
      }),
    ).rejects.toThrow('TURN_STATE_INVALID');
    expect(
      await resource.db.query.agentTurns.findFirst({
        where: eq(agentTurns.id, fixture.turnId),
      }),
    ).toEqual(before);
    expect(
      await resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, fixture.traceId),
      }),
    ).toEqual([]);
    await expectNoChargeSideEffects(fixture.userId);
  });

  it('redacts raw failures at the actual processing logger boundary', async () => {
    const fixture = await createTurn('log redaction');
    const logger = { info: vi.fn(), error: vi.fn() };
    const error = new Error('https://storage.example/image?signature=private');
    error.name = 'upstream secret=private';
    error.stack = 'private prompt and credentials';
    const load = vi.spyOn(SkillRuntimeAdapter.prototype, 'loadCore').mockRejectedValue(error);
    try {
      await processTurn(fixture, undefined, config, logger);
    } finally {
      load.mockRestore();
    }
    expect(logger.error).toHaveBeenCalledWith({
      event: 'agent_turn_processing_failed',
      turn_id_hash: canonicalSha256(fixture.turnId),
      trace_id_hash: canonicalSha256(fixture.traceId),
      error_code: 'Error',
      phase: 'skill_core_load',
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private');
    await expectNoChargeSideEffects(fixture.userId);
  });

  it('compacts closed native turns and supplies summary v2 with the active suffix', async () => {
    const fixture = await createTurn('current request', true);
    const { first, second, third } = fixture.history!;
    const summarizeSession = vi.fn<NonNullable<AgentBrainPort['summarizeSession']>>(
      (compactionInput) =>
        Promise.resolve({
          summary: {
            goals: [
              compactionInput.transcript_items?.find((item) => item.type === 'user_message')
                ?.content ?? 'missing',
            ],
            confirmed_preferences: [],
            constraints: [],
            key_decisions: [],
            open_questions: [],
          },
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
    );
    const runStep = vi.fn<AgentBrainPort['runStep']>(() =>
      Promise.resolve({
        type: 'respond',
        text: 'memory ready',
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
    );
    const brain: AgentBrainPort = {
      countInputTokens: (brainInput) =>
        20 +
        100 *
          (brainInput.transcript_messages?.filter(
            (item) => item.type === 'user_message' && !item.current,
          ).length ?? 0),
      summarizeSession,
      runStep,
    };

    await processTurn(fixture, brain, { ...config, agentAutoCompactTokenLimit: 200 });

    expect(summarizeSession).toHaveBeenCalledTimes(1);
    const compactionInput = summarizeSession.mock.calls[0]![0];
    expect(compactionInput.messages).toEqual([]);
    expect(
      compactionInput.transcript_items
        ?.filter((item) => item.type === 'user_message')
        .map((item) => item.content),
    ).toEqual(['first-user-123', 'second-user-12', 'last-user-1234']);
    expect(JSON.stringify(compactionInput)).not.toContain('current request');
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(runStep.mock.calls[0]?.[0]).toMatchObject({
      session_summary: { goals: ['first-user-123'] },
      skill_selection: { required_capabilities: ['image.generate'] },
      execution_format: 'transcript_v1',
      transcript_messages: [{ type: 'user_message', current: true, content: 'current request' }],
    });
    const session = await resource.db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, fixture.sessionId),
    });
    expect(session).toMatchObject({ summaryVersion: 1, summaryThroughTurnId: third.turnId });
    expect(session?.summaryJson).toMatchObject({
      summary_version: 1,
      schema_version: 2,
      source_turn_ids: [first.turnId, second.turnId, third.turnId],
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    expect(JSON.stringify(session?.summaryJson)).not.toContain(fixture.turnId);
    const traceSteps = await resource.db.query.agentTraceSteps.findMany({
      where: eq(agentTraceSteps.traceId, fixture.traceId),
      orderBy: (table, { asc }) => [asc(table.stepNo)],
    });
    expect(
      traceSteps.filter(
        (step) =>
          step.stepType === 'llm_call' &&
          (step.inputSummary as { purpose?: string }).purpose === 'session_compaction',
      ),
    ).toHaveLength(1);
    expect(traceSteps.filter((step) => step.stepType === 'llm_call')).toHaveLength(2);
    const trace = await resource.db.query.agentTraces.findFirst({
      where: eq(agentTraces.id, fixture.traceId),
    });
    expect(trace).toMatchObject({ inputTokenTotal: 8, outputTokenTotal: 3 });
  });

  it.each([
    { name: 'continues with the full native window below the hard limit', maxInputTokens: 8000 },
    { name: 'blocks without discarding history above the hard limit', maxInputTokens: 4000 },
  ])('$name when compaction is not dispatched', async ({ maxInputTokens }) => {
    const fixture = await createTurn('current request after compaction failure', true);
    const summarizeSession = vi.fn<NonNullable<AgentBrainPort['summarizeSession']>>(() =>
      Promise.reject(
        new AgentBrainCallError('AGENT_BRAIN_REQUEST_NOT_DISPATCHED', 'not_dispatched'),
      ),
    );
    const runStep = vi.fn<AgentBrainPort['runStep']>(() =>
      Promise.resolve({
        type: 'respond',
        text: 'fallback window ready',
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
    );
    const brain: AgentBrainPort = {
      // Both windows must fit the conservatively counted summary call before exercising failure.
      countInputTokens: () => 6000,
      summarizeSession,
      runStep,
    };

    await processTurn(fixture, brain, {
      ...config,
      agentMaxInputTokens: maxInputTokens,
      agentAutoCompactTokenLimit: 100,
    });

    expect(summarizeSession).toHaveBeenCalledTimes(1);
    expect(runStep).toHaveBeenCalledTimes(maxInputTokens === 4000 ? 0 : 1);
    if (maxInputTokens === 8000) {
      expect(
        runStep.mock.calls[0]?.[0].transcript_messages?.filter(
          (item) => item.type === 'user_message',
        ),
      ).toHaveLength(4);
    }
    const turn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    expect(turn?.status).toBe(maxInputTokens === 4000 ? 'blocked' : 'done');
    const session = await resource.db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, fixture.sessionId),
    });
    expect(session).toMatchObject({
      summaryJson: {},
      summaryVersion: 0,
      summaryThroughTurnId: null,
    });
    const compactionStep = await resource.db.query.agentTraceSteps.findFirst({
      where: and(
        eq(agentTraceSteps.traceId, fixture.traceId),
        eq(agentTraceSteps.errorCode, 'AGENT_CALL_NOT_DISPATCHED'),
      ),
    });
    expect(compactionStep).toMatchObject({ status: 'failed', estimatedCost: '0.00' });
  });

  it('blocks an active turn whose window exceeds the hard limit without compaction', async () => {
    // No seeded history: nothing is compactable, so an oversized window must fail closed.
    const fixture = await createTurn('验证 active 超窗 fail closed', false);
    const summarizeSession = vi.fn(() => Promise.reject(new Error('压缩不应被调度')));
    const runStep = vi.fn<AgentBrainPort['runStep']>(() =>
      Promise.resolve({
        type: 'respond',
        text: '不应执行',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    await processTurn(
      fixture,
      { countInputTokens: () => 10_000, summarizeSession, runStep },
      {
        ...config,
        agentMaxInputTokens: 2000,
        agentAutoCompactTokenLimit: 100,
      },
    );

    // The full window is over the hard limit and nothing is compactable: fail closed without
    // running the model, without writing a summary, and without discarding history.
    expect(summarizeSession).not.toHaveBeenCalled();
    expect(runStep).not.toHaveBeenCalled();
    const turn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    expect(turn?.status).toBe('blocked');
    const session = await resource.db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, fixture.sessionId),
    });
    expect(session).toMatchObject({ summaryJson: {}, summaryVersion: 0 });
  });

  it('rejects a legacy summary checkpoint on a native session', async () => {
    const fixture = await createTurn('resume with a stale summary checkpoint', true);
    const history = fixture.history!.third;
    const sourceMessageIds = [history.userMessageId, history.assistantMessageId];
    const persistedSummary = {
      schema_version: 1 as const,
      summary_version: 1,
      content: {
        goals: ['durable earlier goal'],
        confirmed_preferences: [],
        constraints: [],
        key_decisions: [],
        open_questions: [],
      },
      source_message_ids: sourceMessageIds,
      source_message_digest: canonicalSha256(sourceMessageIds),
      through_turn_id: history.turnId,
      model_snapshot_hash: canonicalSha256(fakeModelSnapshot),
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    await resource.db
      .update(chatSessions)
      .set({
        summaryJson: persistedSummary,
        summaryVersion: 1,
        summaryThroughTurnId: history.turnId,
      })
      .where(eq(chatSessions.id, fixture.sessionId));
    await seedRecoveredContext(fixture, {});
    const repository = new AgentTurnRepository(resource.db);

    await expect(
      repository.claim({
        ...payloadToClaim(queuePayload(fixture)),
        leaseMs: 5_000,
        now: new Date(),
      }),
    ).rejects.toThrow('AGENT_SESSION_SUMMARY_INVALID');
    const turn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    expect(turn).toMatchObject({
      status: 'received_user_input',
      processingOwner: null,
      processingLeaseExpiresAt: null,
    });
  });

  it('recovers prior originals with SQL tenant and turn-time boundaries', async () => {
    const prior = await createTurn('original upload');
    const assetId = randomUUID();
    await resource.db.insert(assets).values({
      id: assetId,
      userId: prior.userId,
      displayName: 'source',
      storageKey: `s08-candidate/${assetId}`,
      thumbnailKey: `s08-candidate/${assetId}/thumb`,
      contentHash: 'a'.repeat(64),
      fileSizeBytes: 100n,
      mimeType: 'image/png',
      kind: 'upload',
      origin: 'upload',
      status: 'ready',
    });
    const binding = {
      binding_key: 'original',
      kind: 'asset',
      object_id: assetId,
      object_version: 'a'.repeat(64),
      content_hash: 'a'.repeat(64),
      owner_user_id: prior.userId,
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
      position: 0,
      publication_revision: null,
    };
    try {
      await resource.db
        .update(agentTurns)
        .set({ status: 'done', createdAt: new Date('2026-01-01T00:00:00Z') })
        .where(eq(agentTurns.id, prior.turnId));
      await resource.db
        .update(chatMessages)
        .set({ attachments: [binding], createdAt: new Date('2026-01-01T00:00:00Z') })
        .where(eq(chatMessages.id, prior.messageId));
      const current = await createTurn('continue', false, prior);
      await resource.db
        .update(agentTurns)
        .set({ status: 'done', createdAt: new Date('2026-01-02T00:00:00Z') })
        .where(eq(agentTurns.id, current.turnId));
      const future = await createTurn('later upload', false, prior);
      await resource.db
        .update(agentTurns)
        .set({ createdAt: new Date('2026-01-03T00:00:00Z') })
        .where(eq(agentTurns.id, future.turnId));
      await resource.db
        .update(chatMessages)
        .set({
          attachments: [{ ...binding, object_id: randomUUID() }],
          createdAt: new Date('2026-01-03T00:00:00Z'),
        })
        .where(eq(chatMessages.id, future.messageId));
      const service = new AgentSessionImageCandidateService(resource.db);
      const claimed = {
        turnId: current.turnId,
        userId: prior.userId,
        sessionId: prior.sessionId,
        attachments: [],
        isFirstSessionTurn: false,
        selection: {
          ...selection,
          primary_skill_id: 'void-line-poster@1.1.0',
          execution_policy: { version: 1, family: 'independent_sources', max_sources: 9 },
        },
      } satisfies Parameters<AgentSessionImageCandidateService['resolve']>[0];
      expect(await service.resolve(claimed)).toMatchObject([
        { object_id: assetId, candidate_kind: 'original_source' },
      ]);
      expect(await service.resolve({ ...claimed, userId: randomUUID() })).toEqual([]);
      await resource.db
        .update(assets)
        .set({ contentHash: 'b'.repeat(64) })
        .where(eq(assets.id, assetId));
      expect(await service.resolve(claimed)).toEqual([]);
    } finally {
      await resource.db.delete(assets).where(eq(assets.id, assetId));
    }
  });

  it('restores valid middle-group sources from real SQL without including a foreign or drifted image', async () => {
    const first = await createTurn('first upload');
    await resource.db
      .update(agentTurns)
      .set({ status: 'done' })
      .where(eq(agentTurns.id, first.turnId));
    const middle = await createTurn('middle upload', false, first);
    await resource.db
      .update(agentTurns)
      .set({ status: 'done' })
      .where(eq(agentTurns.id, middle.turnId));
    const latest = await createTurn('latest upload', false, first);
    await resource.db
      .update(agentTurns)
      .set({ status: 'done' })
      .where(eq(agentTurns.id, latest.turnId));
    const current = await createTurn('use the middle photo', false, first);
    const sourceIds = [randomUUID(), randomUUID(), randomUUID()];
    try {
      for (const [index, fixture] of [first, middle, latest].entries()) {
        const id = sourceIds[index]!;
        await resource.db.insert(assets).values({
          id,
          userId: first.userId,
          displayName: 'source',
          storageKey: 's08-middle/' + id,
          thumbnailKey: 's08-middle/' + id + '/thumb',
          contentHash: 'a'.repeat(64),
          fileSizeBytes: 100n,
          mimeType: 'image/png',
          kind: 'upload',
          origin: 'upload',
          status: 'ready',
        });
        const date = new Date(Date.UTC(2026, 0, index + 1));
        await resource.db
          .update(agentTurns)
          .set({ status: 'done', createdAt: date })
          .where(eq(agentTurns.id, fixture.turnId));
        await resource.db
          .update(chatMessages)
          .set({
            createdAt: date,
            attachments: [
              {
                binding_key: 'original',
                kind: 'asset',
                object_id: id,
                object_version: 'a'.repeat(64),
                content_hash: 'a'.repeat(64),
                owner_user_id: first.userId,
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
                position: 0,
                publication_revision: null,
              },
            ],
          })
          .where(eq(chatMessages.id, fixture.messageId));
      }
      const service = new AgentSessionImageCandidateService(resource.db);
      const claimed = {
        turnId: current.turnId,
        userId: first.userId,
        sessionId: first.sessionId,
        attachments: [],
        isFirstSessionTurn: false,
        selection: {
          ...selection,
          primary_skill_id: 'void-line-poster@1.1.0',
          execution_policy: { version: 1, family: 'independent_sources', max_sources: 9 },
        },
      } satisfies Parameters<AgentSessionImageCandidateService['resolve']>[0];
      const candidates = await service.resolve(claimed);
      expect(candidates.map((image) => image.object_id)).toEqual(sourceIds);
      expect(candidates[1]?.source_group).toMatchObject({
        message_id: middle.messageId,
        is_latest_upload: false,
      });
      expect(await service.resolve({ ...claimed, userId: randomUUID() })).toEqual([]);
      await resource.db
        .update(assets)
        .set({ contentHash: 'b'.repeat(64) })
        .where(eq(assets.id, sourceIds[1]!));
      expect((await service.resolve(claimed)).map((image) => image.object_id)).toEqual([
        sourceIds[0],
        sourceIds[2],
      ]);
    } finally {
      await resource.db.delete(assets).where(inArray(assets.id, sourceIds));
    }
  });

  it('keeps the initial attachment snapshot when a confirmation continuation has no attachments', async () => {
    const fixture = await createTurn('original generation request');
    const binding = {
      binding_key: 'asset:original-product',
      kind: 'asset' as const,
      object_id: randomUUID(),
      object_version: 'a'.repeat(64),
      content_hash: 'a'.repeat(64),
      owner_user_id: fixture.userId,
      readable: true,
      mutable: true,
      producer_mode: null,
      producer_session_id: null,
      mutation_owner: null,
      source_action: null,
      media_type: 'image' as const,
      lifecycle: 'active' as const,
      visibility: 'private' as const,
      role: 'product' as const,
      position: 0,
    };
    await resource.db
      .update(chatMessages)
      .set({ attachments: [binding] })
      .where(eq(chatMessages.id, fixture.messageId));
    const confirmationMessageId = randomUUID();
    await resource.db.insert(chatMessages).values({
      id: confirmationMessageId,
      sessionId: fixture.sessionId,
      turnId: fixture.turnId,
      role: 'user',
      content: 'confirmed product facts',
      attachments: [],
      skillSnapshots: [],
    });
    await resource.db
      .update(agentTurns)
      .set({ status: 'loading_context', continuationNo: 2, revision: 2 })
      .where(eq(agentTurns.id, fixture.turnId));
    const repository = new AgentTurnRepository(resource.db);

    const claimed = await repository.claim({
      turnId: fixture.turnId,
      sessionId: fixture.sessionId,
      traceId: fixture.traceId,
      userMessageId: confirmationMessageId,
      continuationNo: 2,
      payloadRevision: 2,
      leaseMs: 5_000,
      now: new Date(),
    });

    expect(claimed).toMatchObject({
      message: 'confirmed product facts',
      attachments: [binding],
    });
  });

  it('recovers with a policy observation when product facts target a non-product binding', async () => {
    const fixture = await createTurn('以这张图为灵感生成一张霓虹夜景海报');
    const bytes = await sharp({
      create: { width: 16, height: 12, channels: 3, background: { r: 12, g: 80, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const assetId = randomUUID();
    const storageKey = `s08-test/product-facts/${assetId}/original`;
    const thumbnailKey = `s08-test/product-facts/${assetId}/thumb`;
    const storage = new LocalPrivateStorage(config.localUploadRoot);
    await storage.initialize();
    await storage.write(storageKey, bytes);
    await storage.write(thumbnailKey, bytes);
    await resource.db.insert(assets).values({
      id: assetId,
      userId: fixture.userId,
      displayName: 'style-reference',
      storageKey,
      thumbnailKey,
      contentHash,
      fileSizeBytes: BigInt(bytes.byteLength),
      mimeType: 'image/jpeg',
      kind: 'upload',
      origin: 'upload',
      status: 'ready',
    });
    const binding = {
      binding_key: 'asset:style-ref',
      kind: 'asset' as const,
      object_id: assetId,
      object_version: contentHash,
      content_hash: contentHash,
      owner_user_id: fixture.userId,
      readable: true,
      mutable: false,
      producer_mode: null,
      producer_session_id: null,
      mutation_owner: null,
      source_action: null,
      media_type: 'image' as const,
      lifecycle: 'active' as const,
      visibility: 'private' as const,
      role: 'other' as const,
      position: 0,
    };
    await resource.db
      .update(chatMessages)
      .set({ attachments: [binding] })
      .where(eq(chatMessages.id, fixture.messageId));
    const runStep = vi
      .fn()
      .mockResolvedValueOnce({
        type: 'request_product_facts',
        source_binding_key: 'asset:style-ref',
        candidate_facts: {
          product_name: '运动鞋',
          primary_colors: ['蓝色'],
          logos: [],
          visible_text: [],
          materials: ['网布'],
          must_preserve: ['鞋型'],
          unknown_fields: [],
        },
        evidence: [{ field: 'product_name', observation: '一双运动鞋' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      .mockResolvedValueOnce({
        type: 'respond',
        text: '已基于视觉观察完成创作',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    try {
      await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });
    } finally {
      await resource.db.delete(assets).where(eq(assets.id, assetId));
    }

    const turn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    expect(turn?.status).toBe('done');
    expect(runStep).toHaveBeenCalledTimes(2);
    const retryInput = runStep.mock.calls[1]?.[0] as AgentBrainStepInput | undefined;
    expect(retryInput?.observations).toEqual([]);
    expect(retryInput?.transcript_messages).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        name: 'agent_request_product_facts@1',
        status: 'rejected',
        result: {
          public_error_code: 'REFERENCE_NOT_AVAILABLE',
        },
      }),
    );
    const policyStep = await resource.db.query.agentTraceSteps.findFirst({
      where: and(
        eq(agentTraceSteps.traceId, fixture.traceId),
        eq(agentTraceSteps.stepType, 'observation'),
        eq(agentTraceSteps.errorCode, 'REFERENCE_NOT_AVAILABLE'),
      ),
    });
    expect(policyStep).toMatchObject({ stepType: 'observation', status: 'failed' });
  });

  it('reserves exposure before a Brain call and atomically converts it to actual cost', async () => {
    const fixture = await createTurn('验证模型成本收敛');
    const errors: Array<Record<string, unknown>> = [];
    await processTurn(fixture, new DeterministicFakeAgentBrain(), config, {
      info: vi.fn(),
      error: (event) => errors.push(event),
    });
    expect(errors).toEqual([]);
    const [trace, steps] = await Promise.all([
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
      resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, fixture.traceId),
      }),
    ]);
    const llm = steps.find((step) => step.stepType === 'llm_call');
    expect(trace).toMatchObject({ reservedCost: '0.00', estimatedCost: '0.01' });
    expect(trace?.inputTokenTotal).toBeGreaterThan(0);
    expect(trace?.outputTokenTotal).toBe(24);
    expect(llm).toMatchObject({ status: 'succeeded', estimatedCost: '0.01' });
    expect(llm?.inputSummary).toMatchObject({
      requested_max_output_tokens: config.agentBrainStepMaxOutputTokens,
    });
  });

  it('keeps unknown exposure without redispatch and retries only known not-dispatched calls', async () => {
    const unknown = await createTurn('验证未知调用恢复');
    const unknownRunStep = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset after write'))
      .mockResolvedValueOnce({
        type: 'respond',
        text: '未知调用后以新 step 恢复',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    await processTurn(unknown, {
      countInputTokens: testTokenCounter,
      runStep: unknownRunStep,
    });
    const [unknownTrace, unknownSteps] = await Promise.all([
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, unknown.traceId) }),
      resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, unknown.traceId),
        orderBy: (table, { asc }) => [asc(table.stepNo)],
      }),
    ]);
    const unknownLlmSteps = unknownSteps.filter((step) => step.stepType === 'llm_call');
    expect(unknownRunStep).toHaveBeenCalledTimes(1);
    expect(unknownTrace).toMatchObject({
      status: 'blocked',
      reservedCost: '0.02',
      estimatedCost: '0.00',
      loopGuardrailHit: 'AGENT_MODEL_UNAVAILABLE',
    });
    expect(unknownLlmSteps).toHaveLength(1);
    expect(unknownLlmSteps[0]).toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_CALL_OUTCOME_UNKNOWN',
      estimatedCost: '0.02',
    });
    expect(unknownLlmSteps[1]).toBeUndefined();

    const notDispatched = await createTurn('验证确定未发出释放');
    const notDispatchedRunStep = vi
      .fn()
      .mockRejectedValueOnce(new AgentBrainCallError('AGENT_BRAIN_CIRCUIT_OPEN', 'not_dispatched'))
      .mockResolvedValueOnce({
        type: 'respond',
        text: '明确未发出后安全重试',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    await processTurn(notDispatched, {
      countInputTokens: testTokenCounter,
      runStep: notDispatchedRunStep,
    });
    const [releasedTrace, releasedSteps] = await Promise.all([
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, notDispatched.traceId) }),
      resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, notDispatched.traceId),
      }),
    ]);
    expect(releasedTrace).toMatchObject({ reservedCost: '0.00', estimatedCost: '0.01' });
    expect(notDispatchedRunStep).toHaveBeenCalledTimes(2);
    expect(
      releasedSteps.find((step) => step.errorCode === 'AGENT_CALL_NOT_DISPATCHED'),
    ).toMatchObject({ estimatedCost: '0.00', status: 'failed' });
  });

  it.each([
    {
      diagnostic: {
        code: 'AGENT_BRAIN_PROVIDER_STREAM_FAILED',
        providerErrorType: 'rate_limit_error',
        failureSource: 'stream' as const,
      },
      summary: '推理模型请求过于频繁，本轮已停止；请稍后重新发送，或更换推理模型',
    },
    {
      diagnostic: { code: 'AGENT_BRAIN_PROVIDER_TIMEOUT' },
      summary: '推理模型响应超时，本轮已停止；请稍后重新发送，或更换推理模型',
    },
    {
      diagnostic: {
        code: 'AGENT_BRAIN_PROVIDER_NETWORK_FAILED',
        networkErrorCode: 'UND_ERR_SOCKET',
      },
      summary: '与推理模型的连接异常，未取得完整响应；请稍后重新发送，或更换推理模型',
    },
    {
      diagnostic: { code: 'AGENT_BRAIN_PROVIDER_OUTCOME_UNKNOWN' },
      summary: '未取得推理模型的完整响应，具体原因尚未确认；请稍后重新发送，或更换推理模型',
    },
  ])(
    'persists an actionable $diagnostic.code reason without redispatch or losing exposure',
    async ({ diagnostic, summary }) => {
      const fixture = await createTurn('验证推理失败中文原因');
      const runStep = vi
        .fn()
        .mockRejectedValue(
          new AgentBrainCallError(
            'AGENT_BRAIN_CALL_OUTCOME_UNKNOWN',
            'outcome_unknown',
            diagnostic,
          ),
        );
      await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });
      const [turn, trace, steps, events] = await Promise.all([
        resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
        resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
        resource.db.query.agentTraceSteps.findMany({
          where: eq(agentTraceSteps.traceId, fixture.traceId),
        }),
        resource.db.query.eventOutbox.findMany({
          where: eq(eventOutbox.scopeId, fixture.turnId),
          orderBy: (table, { asc }) => [asc(table.eventSeq)],
        }),
      ]);
      expect(runStep).toHaveBeenCalledOnce();
      expect(turn).toMatchObject({ status: 'blocked', workflowRunId: null, runQuoteId: null });
      expect(trace).toMatchObject({
        status: 'blocked',
        reservedCost: '0.02',
        estimatedCost: '0.00',
      });
      expect(steps.filter((step) => step.stepType === 'llm_call')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        eventType: 'turn.failed',
        payload: {
          public_error_code: 'AGENT_MODEL_UNAVAILABLE',
          summary,
          user_status: 'failed',
        },
      });
      const publicPayload = JSON.stringify(events.at(-1)?.payload);
      expect(publicPayload).not.toContain('AGENT_BRAIN_');
      expect(publicPayload).not.toContain('diagnostic');
      expect(publicPayload).not.toContain('UND_ERR_SOCKET');
    },
  );

  it('keeps exposure and stops when a 5xx response may already have been processed', async () => {
    const fixture = await createTurn('验证 5xx 不重发');
    const runStep = vi
      .fn()
      .mockRejectedValueOnce(
        new AgentBrainCallError('AGENT_BRAIN_CALL_OUTCOME_UNKNOWN', 'outcome_unknown', {
          code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED',
          statusCode: 502,
        }),
      )
      .mockResolvedValue({
        type: 'respond',
        text: '不应执行第二次调用',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });

    const [turn, steps] = await Promise.all([
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, fixture.traceId),
        orderBy: (table, { asc }) => [asc(table.stepNo)],
      }),
    ]);
    const llmSteps = steps.filter((step) => step.stepType === 'llm_call');
    // A 5xx proves the request already reached the provider; a new request would be a duplicate
    // charge, so the turn terminates with its exposure intact (`docs/04`).
    expect(runStep).toHaveBeenCalledOnce();
    expect(turn?.status).toBe('blocked');
    expect(llmSteps[1]).toBeUndefined();
    expect(llmSteps[0]).toMatchObject({
      errorCode: 'AGENT_BRAIN_CALL_OUTCOME_UNKNOWN',
      status: 'failed',
    });
    expect(llmSteps[0]?.estimatedCost).not.toBe('0.00');
  });

  it.each(['started', 'recorded_unknown'] as const)(
    'recovers a crashed %s call without redispatch or clearing exposure',
    async (phase) => {
      const fixture = await createTurn('验证 started 调用崩溃恢复');
      await seedRecoveredContext(fixture, { steps: [] });
      await resource.db.insert(agentTraceSteps).values({
        traceId: fixture.traceId,
        stepNo: 1,
        stepType: 'llm_call',
        actor: 'agent',
        inputSummary: {
          round: 1,
          continuation_no: 1,
          requested_input_tokens: 1,
          requested_max_output_tokens: config.agentBrainStepMaxOutputTokens,
        },
        outputSummary: phase === 'started' ? {} : { outcome: 'unknown' },
        status: phase === 'started' ? 'started' : 'failed',
        errorCode: phase === 'started' ? null : 'AGENT_BRAIN_CALL_OUTCOME_UNKNOWN',
        estimatedCost: '0.02',
        modelSnapshotJson: fakeModelSnapshot,
      });
      await resource.db
        .update(agentTraces)
        .set({ reservedCost: '0.02' })
        .where(eq(agentTraces.id, fixture.traceId));
      const runStep = vi.fn().mockResolvedValue({
        type: 'respond',
        text: '崩溃恢复后完成',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });
      const [trace, steps] = await Promise.all([
        resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
        resource.db.query.agentTraceSteps.findMany({
          where: eq(agentTraceSteps.traceId, fixture.traceId),
          orderBy: (table, { asc }) => [asc(table.stepNo)],
        }),
      ]);
      const llmSteps = steps.filter((step) => step.stepType === 'llm_call');
      expect(runStep).not.toHaveBeenCalled();
      expect(trace).toMatchObject({
        status: 'blocked',
        reservedCost: '0.02',
        estimatedCost: '0.00',
        loopGuardrailHit: 'AGENT_MODEL_UNAVAILABLE',
      });
      expect(llmSteps).toHaveLength(1);
      expect(llmSteps[0]).toMatchObject({
        status: 'failed',
        errorCode:
          phase === 'started' ? 'AGENT_CALL_OUTCOME_UNKNOWN' : 'AGENT_BRAIN_CALL_OUTCOME_UNKNOWN',
        estimatedCost: '0.02',
      });
      expect(llmSteps[1]).toBeUndefined();
    },
  );

  it('stops after four consecutive known not-dispatched Brain failures', async () => {
    const fixture = await createTurn('验证 Brain 交付失败有界恢复');
    const runStep = vi
      .fn()
      .mockRejectedValueOnce(new AgentBrainCallError('AGENT_BRAIN_CIRCUIT_OPEN', 'not_dispatched'))
      .mockRejectedValueOnce(new AgentBrainCallError('AGENT_BRAIN_CIRCUIT_OPEN', 'not_dispatched'))
      .mockRejectedValueOnce(new AgentBrainCallError('AGENT_BRAIN_CIRCUIT_OPEN', 'not_dispatched'))
      .mockRejectedValueOnce(new AgentBrainCallError('AGENT_BRAIN_CIRCUIT_OPEN', 'not_dispatched'))
      .mockResolvedValue({
        type: 'respond',
        text: '不应执行第五次调用',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });

    const [turn, trace, steps, events] = await Promise.all([
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
      resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, fixture.traceId),
        orderBy: (table, { asc }) => [asc(table.stepNo)],
      }),
      resource.db.query.eventOutbox.findMany({
        where: eq(eventOutbox.scopeId, fixture.turnId),
        orderBy: (table, { asc }) => [asc(table.eventSeq)],
      }),
    ]);
    const llmSteps = steps.filter((step) => step.stepType === 'llm_call');
    expect(runStep).toHaveBeenCalledTimes(4);
    expect(turn?.status).toBe('blocked');
    expect(trace).toMatchObject({
      status: 'blocked',
      reservedCost: '0.00',
      estimatedCost: '0.00',
      loopGuardrailHit: 'AGENT_MODEL_UNAVAILABLE',
    });
    expect(llmSteps.map((step) => step.errorCode)).toEqual([
      'AGENT_CALL_NOT_DISPATCHED',
      'AGENT_CALL_NOT_DISPATCHED',
      'AGENT_CALL_NOT_DISPATCHED',
      'AGENT_CALL_NOT_DISPATCHED',
    ]);
    expect(events.at(-1)).toMatchObject({
      eventType: 'turn.failed',
      payload: {
        public_error_code: 'AGENT_MODEL_UNAVAILABLE',
        summary: '创作助手暂时不可用，请稍后重试',
      },
    });
  });

  it('settles invalid tool input, gives three bounded repairs, and keeps the real terminal cause', async () => {
    const fixture = await createTurn('验证候选计划结构错误的有界修复');
    const invalidOutcome: AgentBrainStepOutcome = {
      type: 'invalid_tool_input',
      error_code: 'AGENT_BRAIN_TOOL_INPUT_INVALID',
      tool: 'agent_candidate_plan',
      paths: ['nodes.0.params.creative_prompt'],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const runStep = vi.fn<AgentBrainPort['runStep']>().mockResolvedValue(invalidOutcome);

    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });

    const [turn, trace, steps, events] = await Promise.all([
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
      resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, fixture.traceId),
        orderBy: (table, { asc }) => [asc(table.stepNo)],
      }),
      resource.db.query.eventOutbox.findMany({
        where: eq(eventOutbox.scopeId, fixture.turnId),
        orderBy: (table, { asc }) => [asc(table.eventSeq)],
      }),
    ]);
    const llmSteps = steps.filter((step) => step.stepType === 'llm_call');
    const contextEvents = events.filter(
      (event) =>
        event.eventType.startsWith('turn.activity_') &&
        (event.payload as { activity_type?: string }).activity_type === 'context_reading',
    );
    expect(runStep).toHaveBeenCalledTimes(4);
    expect(runStep.mock.calls[1]?.[0].observations).toEqual([]);
    const firstRepairPolicy = runStep.mock.calls[1]?.[0].transcript_messages?.find(
      (item) => item.type === 'host_context' && item.name === 'runtime_policy@1',
    );
    expect(firstRepairPolicy).toMatchObject({
      type: 'host_context',
      name: 'runtime_policy@1',
      content: {
        public_error_code: 'AGENT_BRAIN_TOOL_INPUT_INVALID',
        tool: 'agent_candidate_plan',
        paths: ['nodes.0.params.creative_prompt'],
      },
    });
    expect(turn?.status).toBe('blocked');
    expect(trace).toMatchObject({
      status: 'blocked',
      reservedCost: '0.00',
      loopGuardrailHit: 'invalid_model_output',
    });
    expect(llmSteps).toHaveLength(4);
    expect(llmSteps.every((step) => step.errorCode === 'AGENT_BRAIN_TOOL_INPUT_INVALID')).toBe(
      true,
    );
    expect(llmSteps.every((step) => step.estimatedCost === '0.01')).toBe(true);
    expect(contextEvents).toHaveLength(8);
    expect(
      contextEvents
        .filter((event) => event.eventType === 'turn.activity_finished')
        .every((event) => (event.payload as { status?: string }).status === 'failed'),
    ).toBe(true);
    expect(steps.at(-1)).toMatchObject({
      stepType: 'guardrail',
      errorCode: 'AGENT_BRAIN_TOOL_INPUT_INVALID',
    });
  });

  it('preloads only free creation and authors a text-only prompt without presets or other Skills', async () => {
    const builtin = await resolveBuiltinSkill('creative-free-generation@1.0.1');
    if (!builtin) throw new Error('Expected free creation fixture');
    const originalSelection = selection;
    const dependencies = new Map<string, AuxiliarySkillSelectionSnapshot>();
    for (const dependency of builtin.definition.dependencies) {
      const skill = await resolveBuiltinSkill(dependency.skill_id);
      if (!skill) throw new Error('Expected shared knowledge fixture');
      dependencies.set(skill.skillId, {
        skill_id: skill.skillId,
        name: skill.definition.display_name,
        definition_hash: skill.definitionHash,
        package_record_id: skill.packageRecordId,
        planning_resource: skill.resources.get('SKILL.md')!,
        reference_resources: skill.definition.references.map((reference) =>
          skill.resources.get(reference.path)!,
        ),
      });
    }
    selection = validateSkillSelection({
      selection: { primary_skill_id: builtin.skillId, preset_selections: [] },
      definition: builtin.definition,
      definitionHash: builtin.definitionHash,
      packageRecordId: builtin.packageRecordId,
      planningResource: builtin.resources.get('SKILL.md')!,
      catalogReleaseId: builtin.catalogReleaseId,
      catalogVersion: builtin.catalogVersion,
      dependencySnapshots: dependencies,
      resourceSnapshots: builtin.resources,
    }).snapshot;
    try {
      const prompt =
        'A blue ceramic cup in the lower left, overhead view, white background. No text.';
      const fixture = await createTurn(prompt);
      const plan = {
        schema_version: 1,
        intent: { kind: 'creative_generate', confidence: 1 },
        skill_id: builtin.skillId,
        source: 'chat',
        nodes: ['cup', 'cup-variant'].map((key) => ({
          candidate_key: key,
          capability: 'image.generate',
          capability_version: 1,
          input_bindings: [],
          depends_on: [],
          params: { goal_summary: 'Create the requested cup image', output_count: 1 },
          expected_output: 'image',
        })),
      };
      const usage = { input_tokens: 1, output_tokens: 1 };
      const runStep = vi
        .fn<AgentBrainPort['runStep']>()
        .mockResolvedValueOnce({ type: 'authoring_request', plan, usage })
        .mockResolvedValueOnce({
          type: 'authoring_batch',
          authoring_output: {
            name: 'agent_author_prompts@1',
            provider_call_id: null,
            arguments: { prompts: [{ candidate_key: 'cup', creative_prompt: prompt }] },
          },
          usage,
        });
      const logger = { info: vi.fn(), error: vi.fn() };
      // Stop after authoring; paid image dispatch is verified separately with fake Providers.
      await processTurn(
        fixture,
        { countInputTokens: testTokenCounter, runStep },
        { ...config, agentMaxLlmRounds: 1 },
        logger,
      );
      expect(logger.error.mock.calls).toEqual([]);
      expect(runStep).toHaveBeenCalledTimes(2);
      for (const [input] of runStep.mock.calls) {
        expect(input.loaded_skills.map((item) => item.skill_id)).toEqual([builtin.skillId]);
        expect(input.authorized_images).toEqual([]);
        expect(input.skill_selection.preset_names).toEqual([]);
        expect(input.required_auxiliary_catalog).toEqual([]);
      }
      expect(runStep.mock.calls[1]![0].authoring_candidate_keys).toEqual(['cup']);
      const payloads = await resource.db.query.agentTranscriptPayloads.findMany({
        where: eq(agentTranscriptPayloads.sessionId, fixture.sessionId),
      });
      expect(JSON.stringify(payloads)).toContain(prompt);
      const items = await resource.db.query.agentTranscriptItems.findMany({
        where: eq(agentTranscriptItems.turnId, fixture.turnId),
      });
      expect(
        items.some(
          (item) =>
            item.itemType === 'tool_result' &&
            (item.payloadJson as { name?: string; status?: string }).name ===
              'agent_author_prompts@1' &&
            (item.payloadJson as { status?: string }).status === 'succeeded',
        ),
      ).toBe(true);
      await expectNoChargeSideEffects(fixture.userId);
    } finally {
      selection = originalSelection;
    }
  });

  it('pins auto v3 at authoring acceptance and recovers the same method on the next turn', async () => {
    const fixture = await createTurn('Choose a session designer');
    const direction = { mode: 'auto' as const, version: 3 as const };
    const snapshot = { schema_version: 1, selection: direction };
    const preferences = { ...fixtureGenerationPreferences, creative_direction: direction };
    await resource.db
      .update(chatSessions)
      .set({
        creativeDirectionSnapshotJson: snapshot,
        creativeDirectionSnapshotHash: canonicalSha256(snapshot),
      })
      .where(eq(chatSessions.id, fixture.sessionId));
    await resource.db
      .update(agentTurns)
      .set({
        generationPreferencesJson: preferences,
        generationPreferencesHash: canonicalSha256(preferences),
      })
      .where(eq(agentTurns.id, fixture.turnId));
    const plan = {
      schema_version: 1,
      intent: { kind: 'creative_generate', confidence: 1 },
      skill_id: selection.primary_skill_id,
      source: 'chat',
      creative_direction_profile_id: 'material-experiment',
      nodes: ['one', 'two'].map((key) => ({
        candidate_key: key,
        capability: 'image.generate',
        capability_version: 1,
        input_bindings: [],
        depends_on: [],
        params: { goal_summary: 'Create a poster', output_count: 1 },
        expected_output: 'image',
      })),
    };
    const usage = { input_tokens: 1, output_tokens: 1 };
    const runStep = vi
      .fn<AgentBrainPort['runStep']>()
      .mockResolvedValueOnce({ type: 'authoring_request', plan, usage })
      .mockResolvedValueOnce({
        type: 'authoring_batch',
        authoring_output: {
          name: 'agent_author_prompts@1',
          provider_call_id: null,
          arguments: {
            prompts: [
              { candidate_key: 'one', creative_prompt: 'An original material relationship.' },
            ],
          },
        },
        usage,
      });
    const logger = { info: vi.fn(), error: vi.fn() };
    await processTurn(
      fixture,
      { countInputTokens: testTokenCounter, runStep },
      { ...config, agentMaxLlmRounds: 1 },
      logger,
    );
    expect(logger.error.mock.calls).toEqual([]);
    expect(runStep.mock.calls[0]?.[0].creative_direction).toEqual(direction);
    expect(runStep.mock.calls[1]?.[0].creative_direction).toEqual({
      mode: 'profile',
      profile_id: 'material-experiment',
      version: 2,
    });
    const session = await resource.db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, fixture.sessionId),
    });
    expect(session?.creativeDirectionSnapshotJson).toMatchObject({
      schema_version: 1,
      selection: direction,
      resolved_profile: { mode: 'profile', profile_id: 'material-experiment', version: 2 },
      resolution_turn_id: fixture.turnId,
    });
    expect(session?.creativeDirectionSnapshotHash).toBe(
      canonicalSha256(session?.creativeDirectionSnapshotJson),
    );
    const frozen = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    expect(frozen?.generationPreferencesHash).toBe(canonicalSha256(preferences));
    const next = await createTurn('Discuss a local change', false, fixture);
    await resource.db
      .update(agentTurns)
      .set({
        generationPreferencesJson: preferences,
        generationPreferencesHash: canonicalSha256(preferences),
      })
      .where(eq(agentTurns.id, next.turnId));
    const nextStep = vi
      .fn<AgentBrainPort['runStep']>()
      .mockResolvedValue({ type: 'respond', text: 'A local change is possible.', usage });
    await processTurn(next, { countInputTokens: testTokenCounter, runStep: nextStep });
    expect(nextStep.mock.calls[0]?.[0].creative_direction).toEqual({
      mode: 'profile',
      profile_id: 'material-experiment',
      version: 2,
    });
    expect(
      (
        await resource.db.query.chatSessions.findFirst({
          where: eq(chatSessions.id, fixture.sessionId),
        })
      )?.creativeDirectionSnapshotJson,
    ).toEqual(session?.creativeDirectionSnapshotJson);
    await expectNoChargeSideEffects(fixture.userId);
  });

  it('keeps automatic v3 unresolved for discussion and repairs a missing designer in planning', async () => {
    const fixture = await createTurn('Discuss before choosing a designer');
    const direction = { mode: 'auto' as const, version: 3 as const };
    const snapshot = { schema_version: 1, selection: direction };
    const preferences = { ...fixtureGenerationPreferences, creative_direction: direction };
    await resource.db
      .update(chatSessions)
      .set({
        creativeDirectionSnapshotJson: snapshot,
        creativeDirectionSnapshotHash: canonicalSha256(snapshot),
      })
      .where(eq(chatSessions.id, fixture.sessionId));
    await resource.db
      .update(agentTurns)
      .set({
        generationPreferencesJson: preferences,
        generationPreferencesHash: canonicalSha256(preferences),
      })
      .where(eq(agentTurns.id, fixture.turnId));
    const usage = { input_tokens: 1, output_tokens: 1 };
    await processTurn(fixture, {
      countInputTokens: testTokenCounter,
      runStep: vi
        .fn<AgentBrainPort['runStep']>()
        .mockResolvedValue({ type: 'respond', text: 'Let us discuss the idea.', usage }),
    });
    expect(
      (
        await resource.db.query.chatSessions.findFirst({
          where: eq(chatSessions.id, fixture.sessionId),
        })
      )?.creativeDirectionSnapshotJson,
    ).toEqual(snapshot);
    const next = await createTurn('Plan an image', false, fixture);
    await resource.db
      .update(agentTurns)
      .set({
        generationPreferencesJson: preferences,
        generationPreferencesHash: canonicalSha256(preferences),
      })
      .where(eq(agentTurns.id, next.turnId));
    const plan = {
      schema_version: 1,
      intent: { kind: 'creative_generate', confidence: 1 },
      skill_id: selection.primary_skill_id,
      source: 'chat',
      nodes: [
        {
          candidate_key: 'one',
          capability: 'image.generate',
          capability_version: 1,
          input_bindings: [],
          depends_on: [],
          params: { goal_summary: 'Create' },
          expected_output: 'image',
        },
      ],
    };
    const runStep = vi
      .fn<AgentBrainPort['runStep']>()
      .mockResolvedValueOnce({ type: 'authoring_request', plan, usage })
      .mockResolvedValueOnce({
        type: 'respond',
        text: 'Please describe your desired image.',
        usage,
      });
    await processTurn(next, { countInputTokens: testTokenCounter, runStep });
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(
      (
        await resource.db.query.chatSessions.findFirst({
          where: eq(chatSessions.id, fixture.sessionId),
        })
      )?.creativeDirectionSnapshotJson,
    ).toEqual(snapshot);
    await expectNoChargeSideEffects(fixture.userId);
  });

  it.each(['wrong_key', 'extra_key'] as const)(
    'repairs an authoring %s through the processor and checkpoints only the accepted batch',
    async (variant) => {
      const fixture = await createTurn('repair authoring before any paid image action');
      const plan = {
        schema_version: 1,
        intent: { kind: 'creative_generate', confidence: 1 },
        skill_id: selection.primary_skill_id,
        source: 'chat',
        nodes: ['one', 'two'].map((key) => ({
          candidate_key: key,
          capability: 'image.generate',
          capability_version: 1,
          input_bindings: [],
          depends_on: [],
          params: { goal_summary: 'Create a poster', output_count: 1 },
          expected_output: 'image',
        })),
      };
      const usage = { input_tokens: 1, output_tokens: 1 };
      const rejected = { candidate_key: 'two', creative_prompt: 'REJECTED_PRIVATE_BRIEF' };
      const accepted = { candidate_key: 'one', creative_prompt: 'An accepted original brief.' };
      const runStep = vi
        .fn<AgentBrainPort['runStep']>()
        .mockResolvedValueOnce({ type: 'authoring_request', plan, usage })
        .mockResolvedValueOnce({
          type: 'authoring_batch',
          authoring_output: {
            name: 'agent_author_prompts@1',
            provider_call_id: null,
            arguments: { prompts: variant === 'wrong_key' ? [rejected] : [accepted, rejected] },
          },
          usage,
        })
        .mockResolvedValueOnce({
          type: 'authoring_batch',
          authoring_output: {
            name: 'agent_author_prompts@1',
            provider_call_id: null,
            arguments: { prompts: [accepted] },
          },
          usage,
        });

      const logger = { info: vi.fn(), error: vi.fn() };
      // Stop at the persisted checkpoint; authoring cannot end with an unrelated reply.
      await processTurn(
        fixture,
        { countInputTokens: testTokenCounter, runStep },
        { ...config, agentMaxLlmRounds: 2 },
        logger,
      );

      expect(runStep).toHaveBeenCalledTimes(3);
      expect(runStep.mock.calls[2]?.[0].authoring_candidate_keys).toEqual(['one']);
      const repairPolicy = runStep.mock.calls[2]?.[0].transcript_messages?.find(
        (item) => item.type === 'host_context' && item.name === 'runtime_policy@1',
      );
      expect(repairPolicy).toMatchObject({
        type: 'host_context',
        name: 'runtime_policy@1',
        content: {
          public_error_code: 'AGENT_BRAIN_TOOL_INPUT_INVALID',
          tool: 'agent_author_prompts',
          repair_attempt: 1,
        },
      });
      const turn = await resource.db.query.agentTurns.findFirst({
        where: eq(agentTurns.id, fixture.turnId),
      });
      const steps = await resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, fixture.traceId),
        orderBy: (table, { asc }) => [asc(table.stepNo)],
      });
      expect(logger.error.mock.calls).toEqual([]);
      expect({
        status: turn?.status,
        guards: steps.filter((step) => step.stepType === 'guardrail').map((step) => step.errorCode),
      }).toEqual({ status: 'blocked', guards: ['AGENT_LOOP_LIMIT_EXCEEDED'] });
      expect(steps.filter((step) => step.stepType === 'llm_call')).toMatchObject([
        { status: 'succeeded' },
        { status: 'failed', errorCode: 'AGENT_BRAIN_TOOL_INPUT_INVALID' },
        { status: 'succeeded' },
      ]);
      const items = await resource.db.query.agentTranscriptItems.findMany({
        where: eq(agentTranscriptItems.turnId, fixture.turnId),
      });
      const acceptedBatch = items.find(
        (item) =>
          item.itemType === 'tool_result' &&
          (item.payloadJson as { name?: string }).name === 'agent_author_prompts@1',
      );
      expect(acceptedBatch?.payloadJson).toMatchObject({
        type: 'tool_result',
        name: 'agent_author_prompts@1',
        status: 'succeeded',
        result: { value: { type: 'authoring_batch_saved' } },
      });
      const payloads = await resource.db.query.agentTranscriptPayloads.findMany({
        where: eq(agentTranscriptPayloads.sessionId, fixture.sessionId),
      });
      expect(JSON.stringify(payloads)).toContain(accepted.creative_prompt);
      expect(JSON.stringify(payloads)).not.toContain('REJECTED_PRIVATE_BRIEF');
      await expectNoChargeSideEffects(fixture.userId);
    },
  );

  it('repairs a billed empty model response with structured feedback and does not charge', async () => {
    const fixture = await createTurn('repair an empty response');
    const invalidOutcome: AgentBrainStepOutcome = {
      type: 'invalid_terminal_output',
      error_code: 'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID',
      reason: 'empty_without_tool_call',
      paths: ['text', 'tool_calls'],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const runStep = vi
      .fn<AgentBrainPort['runStep']>()
      .mockResolvedValueOnce(invalidOutcome)
      .mockResolvedValueOnce({
        type: 'respond',
        text: 'Repaired response',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });

    const [turn, steps] = await Promise.all([
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, fixture.traceId),
        orderBy: (table, { asc }) => [asc(table.stepNo)],
      }),
    ]);
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(runStep.mock.calls[1]?.[0].observations).toEqual([]);
    expect(runStep.mock.calls[1]?.[0].transcript_messages).toContainEqual(
      expect.objectContaining({
        type: 'host_context',
        name: 'runtime_policy@1',
        content: {
          public_error_code: 'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID',
          reason: 'empty_without_tool_call',
          paths: ['text', 'tool_calls'],
          retryable: true,
          repair_attempt: 1,
          max_repair_attempts: 3,
          remaining_repair_attempts: 3,
          required_action: 'return_nonempty_text_or_call_one_supported_tool',
        },
      }),
    );
    expect(turn?.status).toBe('done');
    expect(steps.filter((step) => step.stepType === 'llm_call')).toMatchObject([
      { status: 'failed', errorCode: 'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID' },
      { status: 'succeeded', errorCode: null },
    ]);
    await expectNoChargeSideEffects(fixture.userId);
  });

  it('blocks after the fourth billed empty output without creating a response', async () => {
    const fixture = await createTurn('block repeated empty model output');
    const invalidOutcome: AgentBrainStepOutcome = {
      type: 'invalid_terminal_output',
      error_code: 'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID',
      reason: 'empty_without_tool_call',
      paths: ['text', 'tool_calls'],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const runStep = vi.fn<AgentBrainPort['runStep']>().mockResolvedValue(invalidOutcome);

    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });

    const [turn, messages] = await Promise.all([
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.chatMessages.findMany({ where: eq(chatMessages.turnId, fixture.turnId) }),
    ]);
    expect(runStep).toHaveBeenCalledTimes(4);
    expect(turn?.status).toBe('blocked');
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
    await expectNoChargeSideEffects(fixture.userId);
  });

  it('completes native chat text without a terminal tool or paid image action', async () => {
    const fixture = await createTurn('Discuss the poster direction without generating');
    const runStep = vi.fn<AgentBrainPort['runStep']>().mockResolvedValue({
      type: 'chat_text',
      text: 'The quieter composition fits the source image.',
      usage: { input_tokens: 2, output_tokens: 8 },
    });

    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });

    const [turn, messages, transcript] = await Promise.all([
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.chatMessages.findMany({ where: eq(chatMessages.turnId, fixture.turnId) }),
      resource.db.query.agentTranscriptItems.findMany({
        where: eq(agentTranscriptItems.turnId, fixture.turnId),
      }),
    ]);
    expect(turn?.status).toBe('done');
    expect(messages.filter((message) => message.role === 'assistant')).toMatchObject([
      { content: 'The quieter composition fits the source image.' },
    ]);
    expect(transcript.find((item) => item.itemType === 'assistant_output')?.payloadJson).toEqual({
      schema_version: 1,
      type: 'assistant_output',
      mode: 'text',
      calls: [],
      text: 'The quieter composition fits the source image.',
    });
    const followUp = await createTurn('Compare it with a bolder option', false, {
      userId: fixture.userId,
      sessionId: fixture.sessionId,
    });
    const followUpBrain = vi.fn<AgentBrainPort['runStep']>().mockResolvedValue({
      type: 'chat_text',
      text: 'The bolder option has more contrast.',
      usage: { input_tokens: 2, output_tokens: 8 },
    });
    await processTurn(followUp, { countInputTokens: testTokenCounter, runStep: followUpBrain });
    expect(followUpBrain.mock.calls[0]?.[0].transcript_messages).toContainEqual(
      expect.objectContaining({
        type: 'assistant_text',
        text: 'The quieter composition fits the source image.',
      }),
    );
    expect(
      (await resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, followUp.turnId) }))
        ?.status,
    ).toBe('done');
    await expectNoChargeSideEffects(fixture.userId);
  });

  it('does not capture or publish chat text when actual token usage exceeds the turn limit', async () => {
    const fixture = await createTurn('Discuss the poster direction');
    const runStep = vi.fn<AgentBrainPort['runStep']>().mockResolvedValue({
      type: 'chat_text',
      text: 'This reply must never enter the conversation.',
      usage: { input_tokens: 2, output_tokens: 8 },
    });

    await processTurn(
      fixture,
      { countInputTokens: testTokenCounter, runStep },
      { ...config, agentMaxOutputTokens: 4 },
    );

    const [turn, messages, transcript, steps] = await Promise.all([
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.chatMessages.findMany({ where: eq(chatMessages.turnId, fixture.turnId) }),
      resource.db.query.agentTranscriptItems.findMany({
        where: eq(agentTranscriptItems.turnId, fixture.turnId),
      }),
      resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, fixture.traceId),
      }),
    ]);
    expect(turn?.status).toBe('blocked');
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
    expect(transcript.filter((item) => item.itemType === 'assistant_output')).toHaveLength(0);
    expect(steps.find((step) => step.stepType === 'llm_call')).toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_BUDGET_EXCEEDED',
      outputSummary: { outcome: 'chat_text_budget_rejected' },
    });
    expect(runStep).toHaveBeenCalledTimes(1);
    await expectNoChargeSideEffects(fixture.userId);
  });

  it('shares the three repair opportunities across tool and terminal errors', async () => {
    const fixture = await createTurn('Recover from mixed model output errors');
    const invalidTool: AgentBrainStepOutcome = {
      type: 'invalid_tool_input',
      error_code: 'AGENT_BRAIN_TOOL_INPUT_INVALID',
      tool: 'agent_candidate_plan',
      paths: ['nodes.0.params.creative_prompt'],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const invalidTerminal: AgentBrainStepOutcome = {
      type: 'invalid_terminal_output',
      error_code: 'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID',
      reason: 'mixed_text_and_tool_calls',
      paths: ['text', 'tool_calls'],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const runStep = vi
      .fn<AgentBrainPort['runStep']>()
      .mockResolvedValueOnce(invalidTool)
      .mockResolvedValueOnce(invalidTerminal)
      .mockResolvedValueOnce(invalidTool)
      .mockResolvedValue(invalidTerminal);

    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });

    const turn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    expect(runStep).toHaveBeenCalledTimes(4);
    expect(turn?.status).toBe('blocked');
    const thirdRepairPolicy = runStep.mock.calls[3]?.[0].transcript_messages
      ?.filter((item) => item.type === 'host_context' && item.name === 'runtime_policy@1')
      .at(-1);
    expect(thirdRepairPolicy).toMatchObject({
      type: 'host_context',
      name: 'runtime_policy@1',
      content: {
        repair_attempt: 3,
        max_repair_attempts: 3,
        remaining_repair_attempts: 1,
      },
    });
    await expectNoChargeSideEffects(fixture.userId);
  });

  it('preserves the Brain delivery failure count across lease recovery', async () => {
    const fixture = await createTurn('验证 Brain 交付失败跨接管恢复');
    await seedRecoveredContext(fixture, { steps: [] });
    await resource.db.insert(agentTraceSteps).values({
      traceId: fixture.traceId,
      stepNo: 1,
      stepType: 'llm_call',
      actor: 'agent',
      inputSummary: {
        round: 1,
        continuation_no: 1,
        requested_input_tokens: 1,
        requested_max_output_tokens: config.agentBrainStepMaxOutputTokens,
      },
      outputSummary: { outcome: 'not_dispatched' },
      status: 'failed',
      errorCode: 'AGENT_CALL_NOT_DISPATCHED',
      estimatedCost: '0.00',
      modelSnapshotJson: fakeModelSnapshot,
    });
    const runStep = vi
      .fn()
      .mockRejectedValue(new AgentBrainCallError('AGENT_BRAIN_CIRCUIT_OPEN', 'not_dispatched'));

    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });

    const [turn, steps] = await Promise.all([
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, fixture.traceId),
        orderBy: (table, { asc }) => [asc(table.stepNo)],
      }),
    ]);
    expect(runStep).toHaveBeenCalledTimes(3);
    expect(turn?.status).toBe('blocked');
    expect(
      steps.filter((step) => step.stepType === 'llm_call').map((step) => step.errorCode),
    ).toEqual(Array.from({ length: 4 }, () => 'AGENT_CALL_NOT_DISPATCHED'));
  });

  it('rejects late draft writes after lease expiry without appending an event', async () => {
    const fixture = await createTurn('draft lease boundary');
    const repository = new AgentTurnRepository(resource.db);
    const claimed = await repository.claim({
      ...payloadToClaim(queuePayload(fixture)),
      leaseMs: 10_000,
      now: new Date(),
    });
    if (!claimed) throw new Error('Expected claimed turn');
    await resource.db
      .update(agentTurns)
      .set({ status: 'detecting_intent' })
      .where(eq(agentTurns.id, fixture.turnId));
    const [step] = await resource.db
      .insert(agentTraceSteps)
      .values({
        traceId: fixture.traceId,
        stepNo: 1,
        stepType: 'llm_call',
        actor: 'agent',
        status: 'started',
        inputSummary: { round: 1 },
        outputSummary: {},
        estimatedCost: '0.00',
        modelSnapshotJson: fakeModelSnapshot,
      })
      .returning({ id: agentTraceSteps.id });
    expect(
      await repository.appendResponseDraft({
        claimed,
        revision: claimed.revision,
        stepId: step!.id,
        draftSeq: 1,
        textDelta: 'safe prefix',
      }),
    ).not.toBeNull();
    const before = await resource.db.query.eventOutbox.findMany({
      where: eq(eventOutbox.scopeId, fixture.turnId),
    });
    await resource.db
      .update(agentTurns)
      .set({ processingLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(agentTurns.id, fixture.turnId));
    await expect(
      repository.appendResponseDraft({
        claimed,
        revision: claimed.revision,
        stepId: step!.id,
        draftSeq: 2,
        textDelta: 'late',
      }),
    ).resolves.toBeNull();
    await expect(
      repository.clearResponseDraft({ claimed, revision: claimed.revision, stepId: step!.id }),
    ).resolves.toBeNull();
    expect(
      await resource.db.query.eventOutbox.findMany({
        where: eq(eventOutbox.scopeId, fixture.turnId),
      }),
    ).toHaveLength(before.length);
  });

  it('clears an abandoned streaming reply when a new Worker claims the turn', async () => {
    const fixture = await createTurn('验证流式回复接管');
    const [step] = await resource.db
      .insert(agentTraceSteps)
      .values({
        traceId: fixture.traceId,
        stepNo: 1,
        stepType: 'llm_call',
        actor: 'agent',
        inputSummary: { round: 1 },
        outputSummary: {},
        status: 'started',
        estimatedCost: '0.00',
        modelSnapshotJson: fakeModelSnapshot,
      })
      .returning({ id: agentTraceSteps.id });
    if (!step) throw new Error('Expected model step');
    const events = await resource.db.query.eventOutbox.findMany({
      where: and(eq(eventOutbox.scopeType, 'turn'), eq(eventOutbox.scopeId, fixture.turnId)),
    });
    await resource.db.insert(eventOutbox).values({
      scopeType: 'turn',
      scopeId: fixture.turnId,
      eventSeq: Math.max(0, ...events.map((event) => event.eventSeq)) + 1,
      eventType: 'turn.response_draft_delta',
      payload: {
        turn_id: fixture.turnId,
        agent_trace_id: fixture.traceId,
        step_id: step.id,
        draft_seq: 1,
        text_delta: '尚未完成的回复',
      },
    });
    await resource.db
      .update(agentTurns)
      .set({
        status: 'detecting_intent',
        processingOwner: randomUUID(),
        processingLeaseExpiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(agentTurns.id, fixture.turnId));

    const claimed = await new AgentTurnRepository(resource.db).claim({
      ...payloadToClaim(queuePayload(fixture)),
      leaseMs: 5_000,
      now: new Date(),
    });
    expect(claimed).not.toBeNull();
    const recoveredStep = await resource.db.query.agentTraceSteps.findFirst({
      where: eq(agentTraceSteps.id, step.id),
    });
    const latestEvents = await resource.db.query.eventOutbox.findMany({
      where: and(eq(eventOutbox.scopeType, 'turn'), eq(eventOutbox.scopeId, fixture.turnId)),
      orderBy: (table, { asc }) => [asc(table.eventSeq)],
    });
    expect(recoveredStep).toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_CALL_OUTCOME_UNKNOWN',
    });
    expect(latestEvents.at(-1)).toMatchObject({
      eventType: 'turn.response_draft_cleared',
      payload: { step_id: step.id },
    });
  });

  it('treats a Brain response without usage as unknown and never as zero cost', async () => {
    const fixture = await createTurn('验证 usage 缺失');
    const runStep = vi
      .fn()
      .mockResolvedValueOnce({ type: 'respond', text: '缺少 usage 的非法结果' })
      .mockResolvedValueOnce({
        type: 'respond',
        text: '使用新 step 安全恢复',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    await processTurn(fixture, {
      countInputTokens: testTokenCounter,
      runStep: runStep as AgentBrainPort['runStep'],
    });
    const [trace, steps] = await Promise.all([
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
      resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, fixture.traceId),
        orderBy: (table, { asc }) => [asc(table.stepNo)],
      }),
    ]);
    const llmSteps = steps.filter((step) => step.stepType === 'llm_call');
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(trace).toMatchObject({
      status: 'blocked',
      reservedCost: '0.02',
      estimatedCost: '0.00',
      loopGuardrailHit: 'AGENT_MODEL_UNAVAILABLE',
    });
    expect(llmSteps).toHaveLength(1);
    expect(llmSteps[0]).toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_CALL_OUTCOME_UNKNOWN',
      estimatedCost: '0.02',
    });
  });

  it('blocks before calling Brain when exposure exceeds remaining cost budget', async () => {
    const fixture = await createTurn('验证成本预算前置阻断');
    await resource.db
      .update(agentTraces)
      .set({ reservedCost: '0.14' })
      .where(eq(agentTraces.id, fixture.traceId));
    const runStep = vi.fn();
    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });
    const [turn, trace, llmSteps] = await Promise.all([
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
      resource.db.query.agentTraceSteps.findMany({
        where: and(
          eq(agentTraceSteps.traceId, fixture.traceId),
          eq(agentTraceSteps.stepType, 'llm_call'),
        ),
      }),
    ]);
    expect(runStep).not.toHaveBeenCalled();
    expect(turn?.status).toBe('blocked');
    expect(trace).toMatchObject({
      reservedCost: '0.14',
      estimatedCost: '0.00',
      loopGuardrailHit: 'cost_budget',
    });
    expect(llmSteps).toHaveLength(0);
  });

  it('blocks an oversized current context before calling Brain', async () => {
    const fixture = await createTurn('验证当前上下文前置预算保护');
    const runStep = vi.fn();
    await processTurn(fixture, {
      countInputTokens: () => config.agentMaxInputTokens + 1,
      runStep,
    });
    const [turn, trace, llmSteps] = await Promise.all([
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
      resource.db.query.agentTraceSteps.findMany({
        where: and(
          eq(agentTraceSteps.traceId, fixture.traceId),
          eq(agentTraceSteps.stepType, 'llm_call'),
        ),
      }),
    ]);
    expect(runStep).not.toHaveBeenCalled();
    expect(turn?.status).toBe('blocked');
    expect(trace?.loopGuardrailHit).toBe('token_budget');
    expect(llmSteps).toHaveLength(0);
  });

  it('caps requested output to the remaining model context window', async () => {
    const fixture = await createTurn('验证模型上下文输出裁剪');
    const constrainedModelSnapshot = {
      ...fakeModelSnapshot,
      capability_contract: {
        ...fakeModelSnapshot.capability_contract,
        max_context_tokens: 2_000,
      },
    };
    await resource.db
      .update(agentTraces)
      .set({ brainModelSnapshotJson: constrainedModelSnapshot })
      .where(eq(agentTraces.id, fixture.traceId));
    const runStep = vi.fn().mockResolvedValue({
      type: 'respond',
      text: '上下文预算内的结果',
      usage: { input_tokens: 1_900, output_tokens: 100 },
    });
    await processTurn(fixture, {
      countInputTokens: () => 1_900,
      runStep,
    });
    expect(runStep).toHaveBeenCalledOnce();
    expect(runStep.mock.calls[0]?.[1]).toMatchObject({ requestedMaxOutputTokens: 100 });
  });

  it('records actual cost above exposure and blocks pricing drift before any terminal action', async () => {
    const fixture = await createTurn('验证成本漂移');
    const runStep = vi.fn().mockResolvedValue({
      type: 'respond',
      text: '这个结果不应写入消息',
      usage: { input_tokens: 1, output_tokens: 20_000 },
    });
    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });
    const [trace, messages, step] = await Promise.all([
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
      resource.db.query.chatMessages.findMany({ where: eq(chatMessages.turnId, fixture.turnId) }),
      resource.db.query.agentTraceSteps.findFirst({
        where: and(
          eq(agentTraceSteps.traceId, fixture.traceId),
          eq(agentTraceSteps.stepType, 'llm_call'),
        ),
      }),
    ]);
    expect(trace).toMatchObject({ reservedCost: '0.00', estimatedCost: '0.17' });
    expect(step).toMatchObject({ status: 'succeeded', estimatedCost: '0.17' });
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
  });

  it('rolls back Brain settlement when a respond message cannot be inserted', async () => {
    const fixture = await createTurn('验证回复写入失败时成本回滚');
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = 'test_fail_agent_reply_' + suffix;
    const triggerName = 'test_fail_agent_reply_' + suffix;
    await resource.db.execute(
      sql.raw(
        'CREATE FUNCTION ' +
          functionName +
          "() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_REPLY_INSERT_FAILED'; END; $$",
      ),
    );
    try {
      await resource.db.execute(
        sql.raw(
          'CREATE TRIGGER ' +
            triggerName +
            " BEFORE INSERT ON chat_messages FOR EACH ROW WHEN (NEW.turn_id = '" +
            fixture.turnId +
            "'::uuid AND NEW.role = 'assistant') EXECUTE FUNCTION " +
            functionName +
            '()',
        ),
      );
      await processTurn(fixture, {
        countInputTokens: testTokenCounter,
        runStep: vi.fn().mockResolvedValue({
          type: 'respond',
          text: '不得留下这条回复',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      });
    } finally {
      await resource.db.execute(
        sql.raw('DROP TRIGGER IF EXISTS ' + triggerName + ' ON chat_messages'),
      );
      await resource.db.execute(sql.raw('DROP FUNCTION IF EXISTS ' + functionName + '()'));
    }
    const [trace, messages] = await Promise.all([
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
      resource.db.query.chatMessages.findMany({ where: eq(chatMessages.turnId, fixture.turnId) }),
    ]);
    expect(trace?.estimatedCost).toBe('0.00');
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
  });

  it('settles a concurrent duplicate Brain completion exactly once', async () => {
    const fixture = await createTurn('验证并发成本收敛');
    const turns = new AgentTurnRepository(resource.db);
    const costs = new AgentLlmCostRepository(resource.db);
    const claimed = await turns.claim({
      ...payloadToClaim(queuePayload(fixture)),
      leaseMs: 5_000,
      now: new Date(),
    });
    expect(claimed).not.toBeNull();
    const transcript = {
      expectedGeneration: claimed!.transcriptGeneration!,
      phase: 'planning' as const,
      resourceDependencies: [],
      contracts: nativeTranscriptContracts,
    };
    const reservation = await costs.reserve({
      claimed: claimed!,
      revision: claimed!.revision,
      round: 1,
      modelSnapshot: claimed!.modelSnapshot,
      exposureCost: '0.02',
      turnBudgetCost: '0.15',
      requestedInputTokens: 1,
      requestedMaxOutputTokens: config.agentBrainStepMaxOutputTokens,
      transcript,
    });
    expect(reservation?.kind).toBe('reserved');
    if (!reservation || reservation.kind !== 'reserved') throw new Error('Expected reservation');
    const outcome = {
      type: 'respond' as const,
      text: '并发结果',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const completions = await Promise.all([
      costs.settle({
        claimed: claimed!,
        revision: claimed!.revision,
        step: reservation.step,
        outcome,
        modelSnapshot: claimed!.modelSnapshot,
        turnBudgetCost: '0.15',
        transcript,
      }),
      costs.settle({
        claimed: claimed!,
        revision: claimed!.revision,
        step: reservation.step,
        outcome,
        modelSnapshot: claimed!.modelSnapshot,
        turnBudgetCost: '0.15',
        transcript,
      }),
    ]);
    expect(completions.filter(Boolean)).toHaveLength(1);
    const [trace, step] = await Promise.all([
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
      resource.db.query.agentTraceSteps.findFirst({
        where: eq(agentTraceSteps.id, reservation.step.stepId),
      }),
    ]);
    expect(trace).toMatchObject({
      reservedCost: '0.00',
      estimatedCost: '0.01',
      inputTokenTotal: 1,
      outputTokenTotal: 1,
    });
    expect(step).toMatchObject({ status: 'succeeded', estimatedCost: '0.01' });
  });

  it.each([false, true])(
    'publishes knowledge commentary atomically once, with exhausted token budget=%s',
    async (tokenBudgetExceeded) => {
      const fixture = await createTurn('Explain the next creative step and read the method');
      const turns = new AgentTurnRepository(resource.db);
      const costs = new AgentLlmCostRepository(resource.db);
      const claimed = await turns.claim({
        ...payloadToClaim(queuePayload(fixture)),
        leaseMs: 15_000,
        now: new Date(),
      });
      if (!claimed) throw new Error('Expected claim');
      const transcript = {
        expectedGeneration: claimed.transcriptGeneration!,
        phase: 'planning' as const,
        resourceDependencies: [],
        contracts: nativeTranscriptContracts,
      };
      const reservation = await costs.reserve({
        claimed,
        revision: claimed.revision,
        round: 1,
        modelSnapshot: claimed.modelSnapshot,
        exposureCost: '0.02',
        turnBudgetCost: '0.15',
        requestedInputTokens: 1,
        requestedMaxOutputTokens: config.agentBrainStepMaxOutputTokens,
        transcript,
      });
      if (!reservation || reservation.kind !== 'reserved') throw new Error('Expected reservation');
      const outcome: AgentBrainStepOutcome = {
        type: 'tool_calls',
        commentary: '先读取创作方法，再确定与这张照片相符的方向。',
        calls: [
          {
            call_id: 'commentary-read',
            name: 'load_skill@1',
            arguments: { skill_id: claimed.selection.primary_skill_id, view: 'planning' },
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      const input = {
        claimed,
        revision: claimed.revision,
        step: reservation.step,
        outcome,
        modelSnapshot: claimed.modelSnapshot,
        turnBudgetCost: '0.15',
        transcript,
        maxOutputTokenTotal: tokenBudgetExceeded ? 0 : config.agentMaxOutputTokens,
        commentaryProtectedTexts: [],
      };
      const results = await Promise.all([costs.settle(input), costs.settle(input)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const messages = await resource.db.query.chatMessages.findMany({
        where: eq(chatMessages.turnId, fixture.turnId),
      });
      expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(
        tokenBudgetExceeded ? 0 : 1,
      );
      expect(results.find(Boolean)?.budgetExceeded).toBe(tokenBudgetExceeded);
      if (!tokenBudgetExceeded)
        expect(messages.find((message) => message.role === 'assistant')?.content).toBe(
          outcome.commentary,
        );
      const turn = await resource.db.query.agentTurns.findFirst({
        where: eq(agentTurns.id, fixture.turnId),
      });
      expect(turn?.endedAt).toBeNull();
      expect(turn?.status).not.toBe('completed');
      const window = await createNativeTranscriptReader(resource.db).readCurrentWindow({
        userId: claimed.userId,
        sessionId: claimed.sessionId,
        expectedGeneration: claimed.transcriptGeneration!,
      });
      const recovery = await readNativeTranscriptRecovery(resource.db, window.items, claimed);
      expect(recovery.pending?.outcome).toMatchObject({
        type: 'tool_calls',
        commentary: outcome.commentary,
      });
    },
  );

  it.each(['chat_text', 'respond'] as const)(
    'continues executing knowledge tools after commentary and finishes with %s',
    async (terminalType) => {
      const fixture = await createTurn('Discuss a creative direction without generating an image');
      const commentary = 'I will read the creative method before recommending a direction.';
      const runStep = vi
        .fn<AgentBrainPort['runStep']>()
        .mockResolvedValueOnce({
          type: 'tool_calls',
          commentary,
          calls: [
            {
              call_id: 'commentary-continue',
              name: 'load_skill@1',
              arguments: {
                skill_id: selection.optional_auxiliary[0]!.skill_id,
                view: 'planning',
                reference_paths: [],
              },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        })
        .mockResolvedValueOnce({
          type: terminalType,
          text: 'Use a restrained composition with clear visual hierarchy.',
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });
      expect(runStep).toHaveBeenCalledTimes(2);
      const turn = await resource.db.query.agentTurns.findFirst({
        where: eq(agentTurns.id, fixture.turnId),
      });
      expect(turn?.status).toBe('done');
      const messages = await resource.db.query.chatMessages.findMany({
        where: and(eq(chatMessages.turnId, fixture.turnId), eq(chatMessages.role, 'assistant')),
        orderBy: (table, { asc }) => [asc(table.createdAt)],
      });
      expect(messages.map((message) => message.content)).toEqual([
        commentary,
        'Use a restrained composition with clear visual hierarchy.',
      ]);
      const items = await resource.db.query.agentTranscriptItems.findMany({
        where: and(
          eq(agentTranscriptItems.turnId, fixture.turnId),
          eq(agentTranscriptItems.itemType, 'tool_result'),
        ),
      });
      expect(
        items.some((item) => {
          const payload = item.payloadJson as { name?: string; status?: string };
          return payload.name === 'load_skill@1' && payload.status === 'succeeded';
        }),
      ).toBe(true);
      await expectNoChargeSideEffects(fixture.userId);
    },
  );

  it('skips only the committed member when a native batch crashes between two executions', async () => {
    const fixture = await createTurn('验证部分成功后的恢复窗口');
    const turns = new AgentTurnRepository(resource.db);
    const costs = new AgentLlmCostRepository(resource.db);
    const tool = new AgentTurnToolRepository(resource.db);
    const reader = createNativeTranscriptReader(resource.db);

    // Seed the turn as a native transcript turn, exactly as the API freezes new sessions.
    await resource.db
      .update(agentTurns)
      .set({ executionFormat: 'transcript_v1', transcriptCaptureVersion: 1 })
      .where(eq(agentTurns.id, fixture.turnId));
    await resource.db
      .update(chatSessions)
      .set({
        transcriptStateJson: {
          schema_version: 1,
          mode: 'active',
          integrity_version: 1,
          verified_through_sequence: '0',
          verified_digest: 'a'.repeat(64),
        },
      })
      .where(eq(chatSessions.id, fixture.sessionId));

    const claimed = await turns.claim({
      ...payloadToClaim(queuePayload(fixture)),
      leaseMs: 600_000,
      now: new Date(),
    });
    if (!claimed) throw new Error('Expected claim');
    // A builtin skill keeps the resource dependency authorizable against in-process truth, the
    // same way the production runtime loads builtin knowledge.
    const builtin = await resolveBuiltinSkill('creative-free-generation@1.0.1');
    if (!builtin) throw new Error('Expected the builtin fixture skill');
    const builtinResource = builtin.resources.get('SKILL.md');
    if (!builtinResource) throw new Error('Expected the builtin planning resource');
    const claimedWithBuiltin = {
      ...claimed,
      selection: {
        ...claimed.selection,
        catalog_release_id: builtin.catalogReleaseId,
        catalog_version: builtin.catalogVersion,
        optional_auxiliary: [
          ...claimed.selection.optional_auxiliary,
          {
            skill_id: builtin.skillId,
            name: 'Builtin optional',
            definition_hash: builtin.definitionHash,
            package_record_id: builtin.packageRecordId,
            planning_resource: {
              resource_snapshot_id: builtinResource.resource_snapshot_id,
              package_resource_id: builtinResource.package_resource_id,
              resource_path: builtinResource.resource_path,
              resource_hash: builtinResource.resource_hash,
            },
            reference_resources: [],
          },
        ],
      },
    };
    const loaded = {
      skillId: builtin.skillId,
      name: 'Builtin optional',
      resource: {
        resource_snapshot_id: builtinResource.resource_snapshot_id,
        package_resource_id: builtinResource.package_resource_id,
        resource_path: builtinResource.resource_path,
        resource_hash: builtinResource.resource_hash,
      },
      content: 'fixture knowledge body',
      tokenCount: 8,
      alreadyLoaded: false,
    };

    const transcript = {
      expectedGeneration: String(claimed.transcriptGeneration),
      phase: 'planning' as const,
      resourceDependencies: [],
      contracts: nativeTranscriptContracts,
    };
    const calls = [
      {
        call_id: 'call-recovery-0',
        name: 'load_skill@1' as const,
        arguments: { skill_id: builtin.skillId, view: 'planning' },
      },
      {
        call_id: 'call-recovery-1',
        name: 'load_skill@1' as const,
        arguments: { skill_id: builtin.skillId, view: 'planning' },
      },
    ];
    const reservation = await costs.reserve({
      claimed: claimedWithBuiltin,
      revision: claimed.revision,
      round: 1,
      modelSnapshot: claimed.modelSnapshot,
      exposureCost: '0.02',
      turnBudgetCost: '0.15',
      requestedInputTokens: 1,
      requestedMaxOutputTokens: config.agentBrainStepMaxOutputTokens,
      transcript,
    });
    if (!reservation || reservation.kind !== 'reserved') throw new Error('Expected reservation');
    const outcome: AgentBrainStepOutcome = {
      type: 'tool_calls',
      calls,
      usage: { input_tokens: 3, output_tokens: 1 },
    };
    await costs.settle({
      claimed: claimedWithBuiltin,
      revision: claimed.revision,
      step: reservation.step,
      outcome,
      modelSnapshot: claimed.modelSnapshot,
      turnBudgetCost: '0.15',
      transcript,
    });

    const recover = async () => {
      const window = await reader.readCurrentWindow({
        userId: claimed.userId,
        sessionId: claimed.sessionId,
        expectedGeneration: String(claimed.transcriptGeneration),
      });
      return readNativeTranscriptRecovery(resource.db, window.items, claimed);
    };

    // Crash before any execution: the accepted batch is pending with no committed member.
    const before = await recover();
    expect(before.pending?.completedOrdinals).toEqual([]);

    const [turnRow] = await Promise.all([
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
    ]);
    // The crash lands after member 0 committed its result but before member 1 ran.
    await tool.finishTool({
      claimed: claimedWithBuiltin,
      revision: turnRow!.revision,
      llmStepId: reservation.step.stepId,
      callOrdinal: 0,
      loadedResources: [loaded],
      skillId: builtin.skillId,
      toolName: 'load_skill@1',
      callPositionKey: callPositionKey({
        turnId: fixture.turnId,
        continuationNo: 1,
        llmStepNo: reservation.step.stepNo,
        callIndex: 0,
      }),
      toolFingerprint: toolFingerprint({
        toolName: 'load_skill',
        contractVersion: 1,
        normalizedArgs: calls[0]!.arguments,
      }),
      argsHash: canonicalSha256(calls[0]!.arguments),
      outputSummary: { outcome: 'succeeded', view: 'planning', loaded: true },
      progressHash: 'd'.repeat(64),
      callCount: 2,
      finishActivity: true,
    });

    // Recovery must resume only the unexecuted member and replay the accepted semantics.
    const after = await recover();
    expect(after.pending?.completedOrdinals).toEqual([0]);
    expect(after.pending?.outcome.type).toBe('tool_calls');
  });

  it('persists one terminal response and ignores a duplicate queue delivery', async () => {
    const fixture = await createTurn('请给我一个创作方向');
    const worker = new AgentProcessorWorker(
      resource.db,
      redis,
      config,
      new ActiveWorkTracker(),
      new WorkerWriteFence(),
      { publish: vi.fn().mockResolvedValue(undefined) },
    );
    const queue = agentQueue();
    try {
      const payload = queuePayload(fixture);
      await queue.add('agent.continue', payload, { jobId: `first-${fixture.turnId}` });
      await queue.add('agent.continue', payload, { jobId: `duplicate-${fixture.turnId}` });
      await vi.waitFor(
        async () => {
          const turn = await resource.db.query.agentTurns.findFirst({
            where: eq(agentTurns.id, fixture.turnId),
          });
          expect(turn?.status).toBe('done');
        },
        { timeout: 10_000 },
      );
      const [messages, events] = await Promise.all([
        resource.db.query.chatMessages.findMany({ where: eq(chatMessages.turnId, fixture.turnId) }),
        resource.db.query.eventOutbox.findMany({ where: eq(eventOutbox.scopeId, fixture.turnId) }),
      ]);
      expect(messages.filter((item) => item.role === 'assistant')).toHaveLength(1);
      expect(events.filter((item) => item.eventType === 'turn.completed')).toHaveLength(1);
    } finally {
      await worker.close(true);
      await queue.close();
    }
  });

  it('preloads primary, presets, and required knowledge, then lets the Brain load optional knowledge', async () => {
    const fixture = await createTurn('[load-optional] 请补充知识后回答');
    await processTurn(fixture);
    const trace = await resource.db.query.agentTraces.findFirst({
      where: eq(agentTraces.id, fixture.traceId),
    });
    const steps = await resource.db.query.agentTraceSteps.findMany({
      where: eq(agentTraceSteps.traceId, fixture.traceId),
    });
    const events = await resource.db.query.eventOutbox.findMany({
      where: eq(eventOutbox.scopeId, fixture.turnId),
      orderBy: (table, { asc }) => [asc(table.eventSeq)],
    });
    expect(trace?.status).toBe('succeeded');
    expect((trace?.skillIds as string[]).sort()).toEqual(
      [
        selection.primary_skill_id,
        selection.required_auxiliary[0]!.skill_id,
        selection.optional_auxiliary[0]!.skill_id,
      ].sort(),
    );
    expect(steps.filter((item) => item.stepType === 'tool_call')).toHaveLength(1);
    expect(steps.filter((item) => item.stepType === 'llm_call')).toHaveLength(2);
    const coreSteps = steps.filter(
      (item) =>
        item.stepType === 'observation' &&
        (item.inputSummary as { action?: string }).action === 'skill_preload',
    );
    expect(
      coreSteps
        .map((item) => (item.inputSummary as { resource_snapshot_id: string }).resource_snapshot_id)
        .sort(),
    ).toEqual(coreResourceIds().sort());
    expect(JSON.stringify(coreSteps)).toContain(
      selection.required_auxiliary[0]!.planning_resource.resource_snapshot_id,
    );
    const activityEvents = events.filter((item) => item.eventType.startsWith('turn.activity_'));
    const expectedActivityTypes = [
      'knowledge_loading',
      'context_reading',
      'knowledge_loading',
      'context_reading',
    ];
    expect(activityEvents.map((item) => item.eventType)).toEqual(
      expectedActivityTypes.flatMap(() => ['turn.activity_started', 'turn.activity_finished']),
    );
    expectedActivityTypes.forEach((activityType, index) => {
      const started = activityEvents[index * 2];
      const finished = activityEvents[index * 2 + 1];
      expect(started?.payload).toMatchObject({
        activity_type: activityType,
        status: 'started',
      });
      expect(finished?.payload).toMatchObject({
        activity_id: (started?.payload as { activity_id: string }).activity_id,
        activity_type: activityType,
        status: 'succeeded',
      });
    });
    expect(trace?.brainModelSnapshotJson).toEqual(fakeModelSnapshot);
    expect(
      steps
        .filter((item) => item.stepType === 'llm_call')
        .every(
          (item) => canonicalSha256(item.modelSnapshotJson) === canonicalSha256(fakeModelSnapshot),
        ),
    ).toBe(true);
  });

  it('executes a bounded knowledge batch in provider order and emits one activity pair', async () => {
    const fixture = await createTurn('批量加载所需知识后回答');
    const runStep = vi
      .fn<AgentBrainPort['runStep']>()
      .mockResolvedValueOnce({
        type: 'tool_calls',
        calls: [
          {
            call_id: 'optional',
            name: 'load_skill@1',
            arguments: {
              skill_id: selection.optional_auxiliary[0]!.skill_id,
              view: 'planning',
              reference_paths: [],
            },
          },
          {
            call_id: 'optional-reference',
            name: 'load_skill@1',
            arguments: {
              skill_id: selection.optional_auxiliary[0]!.skill_id,
              view: 'references',
              reference_paths: ['references/composition.md'],
            },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 4 },
      })
      .mockResolvedValueOnce({
        type: 'respond',
        text: '知识已加载。',
        usage: { input_tokens: 10, output_tokens: 4 },
      });
    const brain: AgentBrainPort = { countInputTokens: testTokenCounter, runStep };

    await processTurn(fixture, brain);

    const [trace, steps, events] = await Promise.all([
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
      resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, fixture.traceId),
        orderBy: (table, { asc }) => [asc(table.stepNo)],
      }),
      resource.db.query.eventOutbox.findMany({
        where: eq(eventOutbox.scopeId, fixture.turnId),
        orderBy: (table, { asc }) => [asc(table.eventSeq)],
      }),
    ]);
    expect(trace?.status).toBe('succeeded');
    expect(steps.filter((step) => step.stepType === 'tool_call')).toHaveLength(2);
    expect(
      steps.filter((step) => step.stepType === 'tool_call').map((step) => step.skillId),
    ).toEqual([
      selection.optional_auxiliary[0]!.skill_id,
      selection.optional_auxiliary[0]!.skill_id,
    ]);
    const activityEvents = events.filter(
      (event) =>
        event.eventType.startsWith('turn.activity_') &&
        (event.payload as { activity_type?: string }).activity_type === 'knowledge_loading',
    );
    expect(activityEvents.map((event) => event.eventType)).toEqual([
      'turn.activity_started',
      'turn.activity_finished',
      'turn.activity_started',
      'turn.activity_finished',
    ]);
    expect(
      new Set(activityEvents.map((event) => (event.payload as { activity_id: string }).activity_id))
        .size,
    ).toBe(2);
    expect(runStep).toHaveBeenCalledTimes(2);
    const secondInput = runStep.mock.calls[1]?.[0];
    if (!secondInput?.transcript_messages) throw new Error('Expected native second-step input');
    const persisted = await resource.db.query.agentTranscriptItems.findMany({
      where: eq(agentTranscriptItems.turnId, fixture.turnId),
      orderBy: (table, { asc }) => [asc(table.sequenceNo)],
    });
    const verifiedPersisted = persisted.map((row) => ({
      row,
      item: verifyStoredTranscriptItem(
        row,
        { user_id: fixture.userId, session_id: fixture.sessionId },
        nativeTranscriptContracts,
      ),
    }));
    const firstBatchEnd = verifiedPersisted
      .filter(
        ({ item }) =>
          item.payload_json.type === 'tool_result' &&
          item.payload_json.name === 'load_skill@1' &&
          item.payload_json.status === 'succeeded',
      )
      .at(-1);
    if (!firstBatchEnd) throw new Error('Expected persisted tool results');
    const authorized = await createNativeTranscriptReader(resource.db).readWindow({
      userId: fixture.userId,
      sessionId: fixture.sessionId,
      expectedGeneration: '1',
      firstSequence: '1',
      throughSequence: firstBatchEnd.row.sequenceNo.toString(),
      requireClosed: true,
    });
    const projected = projectNativeTranscriptMessages(authorized.items, fixture.messageId);
    expect(secondInput.transcript_messages).toEqual(projected);

    const wire = nativeTranscriptMessages(secondInput, {
      role: 'user',
      content: '批量加载所需知识后回答',
    });
    const wireJson = JSON.stringify(wire);
    const acceptedBatch = projected.find((message) => message.type === 'assistant_output');
    expect(acceptedBatch?.type).toBe('assistant_output');
    if (acceptedBatch?.type === 'assistant_output') {
      for (const call of acceptedBatch.calls) expect(wireJson).toContain(call.call_id);
    }
    expect(wireJson.split('批量加载所需知识后回答')).toHaveLength(2);
  });

  it('persists a redacted diagnostic code when knowledge loading fails', async () => {
    const fixture = await createTurn('加载不可用的知识后继续');
    const runStep = vi
      .fn<AgentBrainPort['runStep']>()
      .mockResolvedValueOnce({
        type: 'tool_calls',
        calls: [
          {
            call_id: 'not-selected',
            name: 'load_skill@1',
            arguments: {
              skill_id: selection.primary_skill_id,
              view: 'planning',
              reference_paths: [],
            },
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      .mockResolvedValueOnce({
        type: 'respond',
        text: '已跳过不可用的知识。',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });

    const failedToolStep = await resource.db.query.agentTraceSteps.findFirst({
      where: and(
        eq(agentTraceSteps.traceId, fixture.traceId),
        eq(agentTraceSteps.stepType, 'tool_call'),
      ),
    });
    expect(failedToolStep).toMatchObject({
      status: 'failed',
      errorCode: 'AGENT_TOOL_NOT_ALLOWED',
      outputSummary: {
        outcome: 'failed',
        diagnostic: { code: 'AGENT_TOOL_NOT_ALLOWED' },
      },
    });
  });

  it('loads only snapshotted one-hop references and falls back to DB when Redis misses', async () => {
    const fixture = await createTurn('[load-reference] 请读取构图资料后回答');
    await cleanupRedisPrefix();
    await processTurn(fixture);
    const [turn, trace, steps] = await Promise.all([
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
      resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, fixture.traceId),
        orderBy: (table, { asc }) => [asc(table.stepNo)],
      }),
    ]);
    expect(turn?.status).toBe('done');
    expect(trace?.status).toBe('succeeded');
    const toolSteps = steps.filter((item) => item.stepType === 'tool_call');
    expect(toolSteps).toHaveLength(2);
    expect(toolSteps[1]?.outputSummary).toMatchObject({
      view: 'references',
      already_loaded: false,
      resource_snapshot_ids: [
        selection.optional_auxiliary[0]!.reference_resources[0]!.resource_snapshot_id,
      ],
    });
    expect(JSON.stringify(steps)).not.toContain('# Composition reference');
  });

  it('persists a clarification and blocks a candidate from an inactive Skill release', async () => {
    const clarification = await createTurn('[clarify] 我还没想清楚');
    await processTurn(clarification);
    const confirmationRows = await resource.db.query.agentTurnConfirmations.findMany({
      where: eq(agentTurnConfirmations.turnId, clarification.turnId),
    });
    expect(confirmationRows).toHaveLength(1);
    const plan = await createTurn('[candidate-plan] 请直接生成');
    await resource.db
      .update(skillCatalogReleases)
      .set({ status: 'retired', retiredAt: new Date() })
      .where(eq(skillCatalogReleases.id, catalogReleaseId));
    try {
      await processTurn(plan);
    } finally {
      await resource.db
        .update(skillCatalogReleases)
        .set({ status: 'published', retiredAt: null })
        .where(eq(skillCatalogReleases.id, catalogReleaseId));
    }
    const blocked = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, plan.turnId),
    });
    const failedEvent = await resource.db.query.eventOutbox.findFirst({
      where: eq(eventOutbox.scopeId, plan.turnId),
      orderBy: (table, { desc }) => [desc(table.eventSeq)],
    });
    expect(blocked).toMatchObject({ status: 'blocked', runQuoteId: null, workflowRunId: null });
    expect(failedEvent?.payload).toMatchObject({
      public_error_code: 'SKILL_VERSION_DRIFT',
      user_status: 'failed',
    });
  });

  it('releases a safe retry lease with CAS and allows immediate reclaim', async () => {
    const fixture = await createTurn('Verify safe retry lease release');
    const repository = new AgentTurnRepository(resource.db);
    const payload = queuePayload(fixture);
    const claimed = await repository.claim({
      ...payloadToClaim(payload),
      leaseMs: 5_000,
      now: new Date(),
    });
    expect(claimed).not.toBeNull();

    await expect(
      repository.releaseForRetry({ claimed: claimed!, revision: claimed!.revision }),
    ).resolves.toBe(true);
    await expect(
      repository.releaseForRetry({ claimed: claimed!, revision: claimed!.revision }),
    ).resolves.toBe(false);
    const released = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    expect(released).toMatchObject({
      processingOwner: null,
      processingLeaseExpiresAt: null,
      revision: claimed!.revision + 1,
    });

    const reclaimed = await repository.claim({
      ...payloadToClaim(payload),
      leaseMs: 5_000,
      now: new Date(),
    });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.owner).not.toBe(claimed?.owner);
  });

  it.each([3, 9])(
    'round-trips 16 outputs and %i original sources through context persistence and reclaim',
    async (sourceCount) => {
      const fixture = await createTurn('Recover a full session image candidate snapshot');
      const repository = new AgentTurnRepository(resource.db);
      const payload = queuePayload(fixture);
      const claimed = await repository.claim({
        ...payloadToClaim(payload),
        leaseMs: 5_000,
        now: new Date(),
      });
      expect(claimed).not.toBeNull();
      const candidates = sessionImageCandidatesSchema.parse([
        ...Array.from({ length: 16 }, (_, index) => ({
          binding_key: `session-output-${index + 1}`,
          kind: 'artifact',
          object_id: randomUUID(),
          object_version: 'a'.repeat(64),
          content_hash: 'a'.repeat(64),
          owner_user_id: fixture.userId,
          readable: true,
          mutable: true,
          producer_mode: 'chat',
          producer_session_id: fixture.sessionId,
          mutation_owner: 'chat_session',
          source_action: 'edit',
          media_type: 'image',
          lifecycle: 'active',
          visibility: 'private',
          role: 'edit_source',
          position: index,
          publication_revision: 1,
          candidate_kind: 'latest_output',
          candidate_position: index + 1,
          lineage_source_binding_keys: [],
        })),
        ...Array.from({ length: sourceCount }, (_, index) => ({
          binding_key: `session-source-${index + 1}`,
          kind: 'asset',
          object_id: randomUUID(),
          object_version: 'b'.repeat(64),
          content_hash: 'b'.repeat(64),
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
            created_at: '2026-09-27T00:00:00.000Z',
            is_latest_upload: index === sourceCount - 1,
          },
        })),
      ]);
      expect(sessionImageCandidatesSchema.safeParse([...candidates, candidates[0]!]).success).toBe(
        false,
      );
      await expect(
        repository.persistContext({
          claimed: claimed!,
          revision: claimed!.revision,
          contextSnapshot: {
            ...contextSnapshot(),
            session_image_candidates: candidates,
          },
          preloaded: [],
          projectKnowledgeLoading: false,
        }),
      ).rejects.toThrow('AGENT_SESSION_IMAGE_CANDIDATE_SNAPSHOT_INVALID');
      const unchanged = await resource.db.query.agentTurns.findFirst({
        where: eq(agentTurns.id, fixture.turnId),
      });
      expect(unchanged?.contextSnapshotJson).toBeNull();
      const persisted = await repository.persistContext({
        claimed: claimed!,
        revision: claimed!.revision,
        contextSnapshot: {
          ...contextSnapshot(),
          session_id: fixture.sessionId,
          session_image_candidates: candidates,
          session_image_candidates_hash: canonicalSha256(candidates),
        },
        preloaded: [],
        projectKnowledgeLoading: false,
      });
      expect(persisted).not.toBeNull();
      expect(
        await repository.releaseForRetry({ claimed: claimed!, revision: persisted!.revision }),
      ).toBe(true);
      const reclaimed = await repository.claim({
        ...payloadToClaim(queuePayload({ ...fixture, revision: persisted!.revision + 1 })),
        leaseMs: 5_000,
        now: new Date(),
      });
      expect(reclaimed?.sessionImageCandidates).toEqual(candidates);
    },
  );

  it('allows an expired lease takeover and rejects the old owner renew and write', async () => {
    const fixture = await createTurn('验证租约接管');
    const repository = new AgentTurnRepository(resource.db);
    const payload = queuePayload(fixture);
    const first = await repository.claim({
      ...payloadToClaim(payload),
      leaseMs: 40,
      now: new Date(),
    });
    expect(first).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await repository.claim({
      ...payloadToClaim(payload),
      leaseMs: 500,
      now: new Date(),
    });
    expect(second).not.toBeNull();
    expect(second?.owner).not.toBe(first?.owner);
    await expect(
      repository.renew({
        turnId: fixture.turnId,
        owner: first!.owner,
        revision: first!.revision,
        now: new Date(),
        leaseMs: 500,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.persistContext({
        claimed: first!,
        revision: first!.revision,
        contextSnapshot: { stale: true },
        preloaded: [],
        projectKnowledgeLoading: false,
      }),
    ).resolves.toBeNull();
  });

  it('delays a replay until the active database lease expires instead of losing the turn', async () => {
    const fixture = await createTurn('验证进程重启后的租约恢复');
    const repository = new AgentTurnRepository(resource.db);
    const first = await repository.claim({
      ...payloadToClaim(queuePayload(fixture)),
      leaseMs: 200,
      now: new Date(),
    });
    expect(first).not.toBeNull();

    await processTurn(fixture);

    const turn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    expect(turn).toMatchObject({ status: 'done', processingOwner: null });
  });

  it('renews the processing lease while a Brain call is still running', async () => {
    const fixture = await createTurn('验证长调用续约');
    const brain: AgentBrainPort = {
      countInputTokens: testTokenCounter,
      async runStep() {
        const before = await resource.db.query.agentTurns.findFirst({
          where: eq(agentTurns.id, fixture.turnId),
        });
        expect(before?.processingLeaseExpiresAt).toBeInstanceOf(Date);
        await vi.waitFor(
          async () => {
            const during = await resource.db.query.agentTurns.findFirst({
              where: eq(agentTurns.id, fixture.turnId),
            });
            expect(during?.processingOwner).toBe(before!.processingOwner);
            expect(during?.processingLeaseExpiresAt?.getTime()).toBeGreaterThan(
              before!.processingLeaseExpiresAt!.getTime(),
            );
            expect(during?.revision).toBeGreaterThan(before!.revision);
          },
          { timeout: 3_000 },
        );
        return {
          type: 'respond',
          text: '续约后的结果',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };
    await processTurn(fixture, brain);
    const turn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    expect(turn).toMatchObject({ status: 'done', processingOwner: null });
  });

  it('rebuilds only the current active Agent continuation after Redis loss', async () => {
    const active = await createTurn('恢复当前 continuation');
    const waiting = await createTurn('等待确认不应恢复');
    const old = await createTurn('旧 continuation 不应恢复');
    await resource.db
      .update(agentTurns)
      .set({ status: 'waiting_user_confirmation' })
      .where(eq(agentTurns.id, waiting.turnId));
    await resource.db
      .update(agentTurns)
      .set({ continuationNo: 2, revision: 2 })
      .where(eq(agentTurns.id, old.turnId));
    const intents = new QueueIntentRepository(resource.db);
    const records = [];
    for (const fixture of [active, waiting, old]) {
      const payload = queuePayload(fixture);
      const record = await intents.create({
        queueName: 'agent',
        jobId: compositeJobId({
          job_type: payload.job_type,
          turn_id: payload.turn_id,
          continuation_no: payload.continuation_no,
        }),
        aggregateType: 'agent_turn',
        aggregateId: fixture.turnId,
        payloadVersion: 1,
        payload,
      });
      tracked.intents.add(record.id);
      records.push({ fixture, payload, record });
    }
    const owner = randomUUID();
    const now = new Date();
    await resource.db
      .update(queueDispatchIntents)
      .set({
        status: 'dispatching',
        leaseOwner: owner,
        leaseExpiresAt: new Date(now.getTime() + 5_000),
        nextAttemptAt: new Date(now.getTime() + 5_000),
        updatedAt: now,
      })
      .where(
        inArray(
          queueDispatchIntents.id,
          records.map((item) => item.record.id),
        ),
      );
    for (const item of records) {
      await expect(
        intents.markDispatched({
          id: item.record.id,
          owner,
          now: new Date(now.getTime() + 1),
        }),
      ).resolves.toBe(true);
    }
    await cleanupRedisPrefix();
    const publisher = { add: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
    const reconciler = new QueueReconciler(
      resource.db,
      resource.client,
      redis,
      intents,
      publisher,
      config,
    );
    const summary = await reconciler.reconcile();
    expect(summary.rebuilt).toBeGreaterThanOrEqual(1);
    expect(summary.skippedTerminal).toBeGreaterThanOrEqual(2);
    expect(publisher.add).toHaveBeenCalledWith(
      'agent',
      records[0]!.record.jobId,
      records[0]!.payload,
      undefined,
    );
    expect(records[0]!.payload.turn_revision).toBe(1);
  });

  it('requeues only a dispatched continuation whose turn lease expired', async () => {
    const fixture = await createTurn('Recover a stalled turn');
    const payload = {
      schema_version: 1 as const,
      job_type: 'agent.continue' as const,
      trace_id: fixture.traceId,
      session_id: fixture.sessionId,
      turn_id: fixture.turnId,
      user_message_id: fixture.messageId,
      continuation_no: 1,
      turn_revision: 1,
    };
    const intent = await new QueueIntentRepository(resource.db).create({
      queueName: 'agent',
      jobId: compositeJobId({
        job_type: payload.job_type,
        turn_id: fixture.turnId,
        continuation_no: 1,
      }),
      aggregateType: 'agent_turn',
      aggregateId: fixture.turnId,
      payloadVersion: 1,
      payload,
    });
    tracked.intents.add(intent.id);
    await resource.db
      .update(queueDispatchIntents)
      .set({ status: 'dispatched' })
      .where(eq(queueDispatchIntents.id, intent.id));
    const now = new Date();
    await resource.db
      .update(agentTurns)
      .set({
        status: 'detecting_intent',
        revision: 2,
        processingOwner: randomUUID(),
        processingLeaseExpiresAt: new Date(now.getTime() - 1_000),
      })
      .where(eq(agentTurns.id, fixture.turnId));
    const recoverAgentJob = vi.fn().mockResolvedValue('requeued');
    const sweeper = new AgentTurnRecoverySweeper(resource.db, { recoverAgentJob });
    expect(await sweeper.sweep(now)).toEqual({ requeued: 1, exhausted: 0 });
    expect(recoverAgentJob).toHaveBeenCalledWith(intent.jobId, payload);
    await resource.db
      .update(agentTurns)
      .set({ processingLeaseExpiresAt: new Date(now.getTime() + 60_000) })
      .where(eq(agentTurns.id, fixture.turnId));
    expect(await sweeper.sweep(now)).toEqual({ requeued: 0, exhausted: 0 });
    recoverAgentJob.mockResolvedValueOnce('exhausted');
    await resource.db
      .update(agentTurns)
      .set({ processingLeaseExpiresAt: new Date(now.getTime() - 1_000) })
      .where(eq(agentTurns.id, fixture.turnId));
    expect(await sweeper.sweep(now)).toEqual({ requeued: 0, exhausted: 1 });
    expect(
      await resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
    ).toMatchObject({
      status: 'failed',
      processingOwner: null,
      processingLeaseExpiresAt: null,
      revision: 3,
    });
    expect(
      await resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
    ).toMatchObject({ status: 'failed' });
    expect(await sweeper.sweep(now)).toEqual({ requeued: 0, exhausted: 0 });
  });

  it('rotates recovery pages past pending jobs and refuses to fail a renewed lease', async () => {
    const fixtures = await Promise.all([
      createTurn('page one'),
      createTurn('page two'),
      createTurn('page three'),
    ]);
    for (const fixture of fixtures) {
      const payload = {
        schema_version: 1 as const,
        job_type: 'agent.continue' as const,
        trace_id: fixture.traceId,
        session_id: fixture.sessionId,
        turn_id: fixture.turnId,
        user_message_id: fixture.messageId,
        continuation_no: 1,
        turn_revision: 1,
      };
      const intent = await new QueueIntentRepository(resource.db).create({
        queueName: 'agent',
        jobId: compositeJobId(payload),
        aggregateType: 'agent_turn',
        aggregateId: fixture.turnId,
        payloadVersion: 1,
        payload,
      });
      tracked.intents.add(intent.id);
      await resource.db
        .update(queueDispatchIntents)
        .set({ status: 'dispatched' })
        .where(eq(queueDispatchIntents.id, intent.id));
    }
    const recoverAgentJob = vi
      .fn<
        (
          jobId: string,
          payload: Extract<QueuePayload, { job_type: 'agent.continue' }>,
        ) => Promise<'pending' | 'exhausted' | 'requeued'>
      >()
      .mockResolvedValue('pending');
    const sweeper = new AgentTurnRecoverySweeper(resource.db, { recoverAgentJob });
    for (let i = 0; i < 3; i += 1) await sweeper.sweep(new Date(), 1);
    expect(new Set(recoverAgentJob.mock.calls.map((call) => call[1].turn_id)).size).toBe(3);
    await sweeper.sweep(new Date(), 1);
    recoverAgentJob.mockImplementationOnce(async (_id, payload) => {
      await resource.db
        .update(agentTurns)
        .set({
          processingOwner: randomUUID(),
          processingLeaseExpiresAt: new Date(Date.now() + 60_000),
          revision: 2,
        })
        .where(eq(agentTurns.id, payload.turn_id));
      return 'exhausted';
    });
    await sweeper.sweep(new Date(), 1);
    const renewedId = recoverAgentJob.mock.calls.at(-1)![1].turn_id;
    expect(
      await resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, renewedId) }),
    ).toMatchObject({ status: 'received_user_input', revision: 2 });
  });

  it('fails an exhausted continuation once under concurrent sweepers without releasing unknown model exposure', async () => {
    const fixture = await createTurn('concurrent exhausted recovery');
    const payload = queuePayload(fixture);
    const intent = await new QueueIntentRepository(resource.db).create({
      queueName: 'agent',
      jobId: compositeJobId(payload),
      aggregateType: 'agent_turn',
      aggregateId: fixture.turnId,
      payloadVersion: 1,
      payload,
    });
    tracked.intents.add(intent.id);
    await resource.db
      .update(queueDispatchIntents)
      .set({ status: 'dispatched' })
      .where(eq(queueDispatchIntents.id, intent.id));
    await resource.db
      .update(agentTraces)
      .set({ reservedCost: '0.02' })
      .where(eq(agentTraces.id, fixture.traceId));
    await resource.db.insert(agentTraceSteps).values({
      traceId: fixture.traceId,
      stepNo: 1,
      stepType: 'llm_call',
      actor: 'agent',
      status: 'started',
      inputSummary: { reserved_exposure_cost_cny: '0.02' },
      outputSummary: {},
      estimatedCost: '0.00',
      modelSnapshotJson: fakeModelSnapshot,
    });
    const publisher = { recoverAgentJob: vi.fn().mockResolvedValue('exhausted') };
    await Promise.all([
      new AgentTurnRecoverySweeper(resource.db, publisher).sweep(),
      new AgentTurnRecoverySweeper(resource.db, publisher).sweep(),
    ]);
    expect(
      await resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
    ).toMatchObject({ status: 'failed', revision: 2, runQuoteId: null, workflowRunId: null });
    expect(
      await resource.db.query.agentTraces.findFirst({ where: eq(agentTraces.id, fixture.traceId) }),
    ).toMatchObject({ status: 'failed', reservedCost: '0.02', estimatedCost: '0.00' });
    expect(
      await resource.db.query.agentTraceSteps.findFirst({
        where: and(
          eq(agentTraceSteps.traceId, fixture.traceId),
          eq(agentTraceSteps.stepType, 'llm_call'),
        ),
      }),
    ).toMatchObject({ status: 'failed', errorCode: 'AGENT_CALL_OUTCOME_UNKNOWN' });
    const failures = await resource.db.query.eventOutbox.findMany({
      where: and(eq(eventOutbox.scopeId, fixture.turnId), eq(eventOutbox.eventType, 'turn.failed')),
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.payload).toMatchObject({
      public_error_code: 'AGENT_MODEL_UNAVAILABLE',
      summary: '本次处理未能恢复，已停止，请重新发送需求',
    });
    await expectNoChargeSideEffects(fixture.userId);
  });

  it('continues a text turn without partial images when automatic candidates exceed the limit', async () => {
    const fixture = await createTurn('先讨论创作方向，不要生图');
    const resolve = vi
      .spyOn(AgentSessionImageCandidateService.prototype, 'resolve')
      .mockRejectedValueOnce(new Error('SESSION_IMAGE_CANDIDATE_LIMIT_EXCEEDED'));
    const runStep = vi.fn<AgentBrainPort['runStep']>().mockResolvedValue({
      type: 'chat_text',
      text: '可以先讨论方向。',
      usage: { input_tokens: 2, output_tokens: 2 },
    });
    try {
      await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });
    } finally {
      resolve.mockRestore();
    }
    expect(runStep).toHaveBeenCalledOnce();
    expect(runStep.mock.calls[0]?.[0]).toMatchObject({
      session_image_candidates_unavailable: true,
      authorized_images: [],
    });
    const turn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    expect(turn?.status).toBe('done');
    expect(turn?.contextSnapshotJson).toMatchObject({
      session_image_candidates_unavailable: true,
      session_image_candidates: [],
    });
    await expectNoChargeSideEffects(fixture.userId);
  });

  it('restores the frozen candidate-unavailable state without scanning historical images again', async () => {
    const fixture = await createTurn('继续讨论，不要生图');
    const snapshot = {
      ...contextSnapshot(),
      session_image_candidates: [],
      session_image_candidates_hash: canonicalSha256([]),
      session_image_candidates_unavailable: true,
    };
    await resource.db
      .update(agentTurns)
      .set({ contextSnapshotJson: snapshot, contextSnapshotHash: canonicalSha256(snapshot) })
      .where(eq(agentTurns.id, fixture.turnId));
    const resolve = vi.spyOn(AgentSessionImageCandidateService.prototype, 'resolve');
    const runStep = vi.fn<AgentBrainPort['runStep']>().mockResolvedValue({
      type: 'chat_text',
      text: '我们继续讨论。',
      usage: { input_tokens: 2, output_tokens: 2 },
    });
    try {
      await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });
    } finally {
      resolve.mockRestore();
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(runStep.mock.calls[0]?.[0]).toMatchObject({
      session_image_candidates_unavailable: true,
      authorized_images: [],
    });
    await expectNoChargeSideEffects(fixture.userId);
  });

  it('drops a Brain result that arrives after interrupt ownership is revoked', async () => {
    const fixture = await createTurn('等待中的模型结果');
    let resolveBrain!: (outcome: AgentBrainStepOutcome) => void;
    const started = vi.fn();
    const brain: AgentBrainPort = {
      countInputTokens: testTokenCounter,
      runStep: () => {
        started();
        return new Promise((resolve) => {
          resolveBrain = resolve;
        });
      },
    };
    const worker = new AgentProcessorWorker(
      resource.db,
      redis,
      config,
      new ActiveWorkTracker(),
      new WorkerWriteFence(),
      { publish: vi.fn().mockResolvedValue(undefined) },
      brain,
    );
    const queue = agentQueue();
    try {
      await queue.add('agent.continue', queuePayload(fixture), { jobId: fixture.turnId });
      // Explicit timeout (matching the other worker-consumption waits in this file): a cold
      // BullMQ/Redis connection can take well over the 1s `vi.waitFor` default to fetch the job,
      // which made this test flaky in isolation while passing once the suite had warmed up.
      await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      const current = await resource.db.query.agentTurns.findFirst({
        where: eq(agentTurns.id, fixture.turnId),
      });
      await resource.db
        .update(agentTurns)
        .set({
          status: 'cancelled',
          revision: current!.revision + 1,
          processingOwner: null,
          processingLeaseExpiresAt: null,
          interruptedAt: new Date(),
          endedAt: new Date(),
        })
        .where(eq(agentTurns.id, fixture.turnId));
      resolveBrain({
        type: 'respond',
        text: '这个晚到结果不能落库',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const messages = await resource.db.query.chatMessages.findMany({
        where: eq(chatMessages.turnId, fixture.turnId),
      });
      expect(messages.filter((item) => item.role === 'assistant')).toHaveLength(0);
    } finally {
      await worker.close(true);
      await queue.close();
    }
  });

  it('feeds a bounded observation when the model mixes tool classes in one batch', async () => {
    const fixture = await createTurn('mixed tool batch turns into bounded feedback');
    let step = 0;
    const runStep = vi.fn<AgentBrainPort['runStep']>(() => {
      step += 1;
      if (step === 1) {
        // The tool list is stable, so the model may batch incompatible tool classes. The batch is
        // rejected with bounded feedback instead of failing the turn.
        return Promise.resolve({
          type: 'tool_calls',
          calls: [
            {
              call_id: 'call_mixed_inspect',
              name: 'inspect_image@1',
              arguments: { binding_key: 'unused-binding', detail: 'overview' },
            },
            {
              call_id: 'call_mixed_load',
              name: 'load_skill@1',
              arguments: { skill_id: 'unused-skill@1.0.0', view: 'planning' },
            },
          ],
          usage: { input_tokens: 5, output_tokens: 2 },
        });
      }
      return Promise.resolve({
        type: 'respond',
        text: 'mixed batch recovered',
        usage: { input_tokens: 4, output_tokens: 2 },
      });
    });
    const brain: AgentBrainPort = {
      countInputTokens: () => 20,
      runStep,
    };

    await processTurn(fixture, brain);

    // The turn continued to a second Brain round instead of aborting on the mixed batch.
    expect(runStep).toHaveBeenCalledTimes(2);
    const turn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    expect(turn?.status).toBe('done');
    const traceSteps = await resource.db.query.agentTraceSteps.findMany({
      where: eq(agentTraceSteps.traceId, fixture.traceId),
      orderBy: (table, { asc }) => [asc(table.stepNo)],
    });
    const rejections = traceSteps.filter((item) => item.errorCode === 'AGENT_TOOL_NOT_ALLOWED');
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.stepType).toBe('observation');
    expect(rejections[0]?.outputSummary).toMatchObject({
      outcome: 'tool_batch_rejected',
      call_count: 2,
    });
    const messages = await resource.db.query.chatMessages.findMany({
      where: eq(chatMessages.turnId, fixture.turnId),
    });
    expect(messages.filter((item) => item.role === 'assistant')).toHaveLength(1);
  });

  it('gives an illegal tool batch the same three structural repair opportunities', async () => {
    const fixture = await createTurn('允许修复非法工具批次');
    const invalidBatch = (attempt: number): AgentBrainStepOutcome => ({
      type: 'tool_calls',
      calls: [
        {
          call_id: `mixed-inspect-${attempt}`,
          name: 'inspect_image@1',
          arguments: { binding_key: 'unused-binding', detail: 'overview' },
        },
        {
          call_id: `mixed-load-${attempt}`,
          name: 'load_skill@1',
          arguments: { skill_id: 'unused-skill@1.0.0', view: 'planning' },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const runStep = vi
      .fn<AgentBrainPort['runStep']>()
      .mockResolvedValueOnce(invalidBatch(1))
      .mockResolvedValueOnce(invalidBatch(2))
      .mockResolvedValueOnce(invalidBatch(3))
      .mockResolvedValueOnce({
        type: 'respond',
        text: '工具批次已修正',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });

    expect(runStep).toHaveBeenCalledTimes(4);
    const firstRepairPolicy = runStep.mock.calls[1]?.[0].transcript_messages?.find(
      (item) => item.type === 'host_context' && item.name === 'runtime_policy@1',
    );
    expect(firstRepairPolicy).toMatchObject({
      type: 'host_context',
      name: 'runtime_policy@1',
      content: {
        public_error_code: 'AGENT_TOOL_NOT_ALLOWED',
        repair_attempt: 1,
        remaining_repair_attempts: 3,
      },
    });
    expect(runStep.mock.calls[1]?.[0].observations).toEqual([]);
    const [turn, steps, messages] = await Promise.all([
      resource.db.query.agentTurns.findFirst({ where: eq(agentTurns.id, fixture.turnId) }),
      resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, fixture.traceId),
        orderBy: (table, { asc }) => [asc(table.stepNo)],
      }),
      resource.db.query.chatMessages.findMany({ where: eq(chatMessages.turnId, fixture.turnId) }),
    ]);
    expect(turn?.status).toBe('done');
    expect(steps.filter((step) => step.errorCode === 'AGENT_TOOL_NOT_ALLOWED')).toHaveLength(3);
    expect(messages.filter((message) => message.role === 'assistant')).toMatchObject([
      { content: '工具批次已修正' },
    ]);
  }, 60_000);

  it('counts illegal batches when guiding a later invalid terminal repair', async () => {
    const fixture = await createTurn('Repair a mixed illegal batch and terminal output');
    const runStep = vi
      .fn<AgentBrainPort['runStep']>()
      .mockResolvedValueOnce({
        type: 'tool_calls',
        calls: [
          {
            call_id: 'mixed-inspect',
            name: 'inspect_image@1',
            arguments: { binding_key: 'unused-binding', detail: 'overview' },
          },
          {
            call_id: 'mixed-load',
            name: 'load_skill@1',
            arguments: { skill_id: 'unused-skill@1.0.0', view: 'planning' },
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      .mockResolvedValueOnce({
        type: 'invalid_terminal_output',
        error_code: 'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID',
        reason: 'empty_without_tool_call',
        paths: ['text', 'tool_calls'],
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      .mockResolvedValueOnce({
        type: 'respond',
        text: 'The repair succeeded',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });

    expect(runStep).toHaveBeenCalledTimes(3);
    const secondRepairPolicy = runStep.mock.calls[2]?.[0].transcript_messages
      ?.filter((item) => item.type === 'host_context' && item.name === 'runtime_policy@1')
      .at(-1);
    expect(secondRepairPolicy).toMatchObject({
      content: {
        public_error_code: 'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID',
        repair_attempt: 2,
        max_repair_attempts: 3,
        remaining_repair_attempts: 2,
      },
    });
    const turn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    expect(turn?.status).toBe('done');
    await expectNoChargeSideEffects(fixture.userId);
  });

  it('agent trace loop survives lease takeover and blocks persisted limits', async () => {
    const optional = selection.optional_auxiliary[0]!;
    const loadedIds = [...coreResourceIds(), optional.planning_resource.resource_snapshot_id];
    const loadedHashes = [
      selection.primary_planning_resource.resource_hash,
      ...selection.preset_selections.map((item) => item.resource_hash),
      ...selection.required_auxiliary.map((item) => item.planning_resource.resource_hash),
      optional.planning_resource.resource_hash,
    ];
    const repeatedArgs = { skill_id: optional.skill_id, view: 'planning' as const };
    const repeatedFingerprint = toolFingerprint({
      toolName: 'load_skill',
      contractVersion: 1,
      normalizedArgs: repeatedArgs,
      bindingVersions: loadedHashes,
    });
    const alwaysRepeatRunStep = vi.fn().mockResolvedValue({
      type: 'tool_calls',
      calls: [{ call_id: 'repeat', name: 'load_skill@1', arguments: repeatedArgs }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const alwaysRepeat: AgentBrainPort = {
      countInputTokens: testTokenCounter,
      runStep: alwaysRepeatRunStep,
    };
    const repeated = await createTurn('验证接管后的重复工具保护');
    await seedRecoveredContext(repeated, {
      resourceIds: loadedIds,
      steps: [1, 2].map(() => ({
        stepType: 'tool_call' as const,
        status: 'succeeded' as const,
        toolFingerprint: repeatedFingerprint,
        outputSummary: {
          progress_hash: canonicalSha256({ loaded_resource_snapshot_ids: [...loadedIds].sort() }),
          resource_snapshot_ids: [optional.planning_resource.resource_snapshot_id],
        },
      })),
    });
    await processTurn(repeated, alwaysRepeat);
    const [repeatedTrace, repeatedEvents] = await Promise.all([
      resource.db.query.agentTraces.findFirst({
        where: eq(agentTraces.id, repeated.traceId),
      }),
      resource.db.query.eventOutbox.findMany({
        where: eq(eventOutbox.scopeId, repeated.turnId),
        orderBy: (table, { asc }) => [asc(table.eventSeq)],
      }),
    ]);
    expect(repeatedTrace).toMatchObject({
      status: 'blocked',
      loopGuardrailHit: 'repeated_tool_call',
    });
    expect(alwaysRepeatRunStep).toHaveBeenCalledTimes(1);
    const knowledgeEvents = repeatedEvents.filter(
      (event) =>
        ['turn.activity_started', 'turn.activity_finished'].includes(event.eventType) &&
        (event.payload as { activity_type?: string }).activity_type === 'knowledge_loading',
    );
    expect(knowledgeEvents).toHaveLength(2);
    expect(knowledgeEvents[1]).toMatchObject({
      eventType: 'turn.activity_finished',
      payload: {
        activity_id: (knowledgeEvents[0]!.payload as { activity_id: string }).activity_id,
        status: 'blocked',
        public_error_code: 'AGENT_REPEATED_TOOL_CALL',
      },
    });
    await expectNoChargeSideEffects(repeated.userId);

    const stableProgress = canonicalSha256({
      loaded_resource_snapshot_ids: [...coreResourceIds()].sort(),
    });
    const noProgress = await createTurn('验证接管后的无进展保护');
    await seedRecoveredContext(noProgress, {
      steps: [1, 2, 3].map((index) => ({
        stepType: 'tool_call' as const,
        status: 'succeeded' as const,
        toolFingerprint: `distinct-${index}`,
        outputSummary: { progress_hash: stableProgress, resource_snapshot_ids: [] },
      })),
    });
    const noProgressRunStep = vi.fn();
    const noProgressBrain: AgentBrainPort = {
      countInputTokens: testTokenCounter,
      runStep: noProgressRunStep,
    };
    await processTurn(noProgress, noProgressBrain);
    const noProgressTrace = await resource.db.query.agentTraces.findFirst({
      where: eq(agentTraces.id, noProgress.traceId),
    });
    expect(noProgressTrace?.loopGuardrailHit).toBe('no_progress');
    expect(noProgressRunStep).not.toHaveBeenCalled();
    await expectNoChargeSideEffects(noProgress.userId);

    const repeatedError = await createTurn('验证接管后的连续错误保护');
    await seedRecoveredContext(repeatedError, {
      steps: [1, 2, 3].map((index) => ({
        stepType: 'tool_call' as const,
        status: 'failed' as const,
        toolFingerprint: `error-${index}`,
        errorCode: 'AGENT_TOOL_NOT_ALLOWED',
        outputSummary: {
          progress_hash: stableProgress,
          error_key: 'stable-error-key',
        },
      })),
    });
    const repeatedErrorRunStep = vi.fn();
    const repeatedErrorBrain: AgentBrainPort = {
      countInputTokens: testTokenCounter,
      runStep: repeatedErrorRunStep,
    };
    await processTurn(repeatedError, repeatedErrorBrain);
    const repeatedErrorTrace = await resource.db.query.agentTraces.findFirst({
      where: eq(agentTraces.id, repeatedError.traceId),
    });
    expect(repeatedErrorTrace?.loopGuardrailHit).toBe('repeated_error');
    expect(repeatedErrorRunStep).not.toHaveBeenCalled();
    await expectNoChargeSideEffects(repeatedError.userId);

    const exhausted = await createTurn('验证接管后的 token 预算保护');
    const recoveredIllegalBatch = await createTurn('recovered illegal tool batch repair budget');
    await seedRecoveredContext(recoveredIllegalBatch, {
      steps: [1, 2, 3, 4].map((repairAttempt) => ({
        stepType: 'observation' as const,
        status: 'failed' as const,
        errorCode: 'AGENT_TOOL_NOT_ALLOWED',
        outputSummary: {
          policy: 'tool_batch_shape',
          outcome: 'tool_batch_rejected',
          call_count: 2,
          error_key: canonicalSha256({ error_code: 'AGENT_TOOL_NOT_ALLOWED', call_count: 2 }),
          progress_hash: stableProgress,
          repair_attempt: repairAttempt,
        },
      })),
    });
    const recoveredIllegalBatchRunStep = vi.fn();
    await processTurn(recoveredIllegalBatch, {
      countInputTokens: testTokenCounter,
      runStep: recoveredIllegalBatchRunStep,
    });
    const recoveredIllegalBatchTrace = await resource.db.query.agentTraces.findFirst({
      where: eq(agentTraces.id, recoveredIllegalBatch.traceId),
    });
    expect(recoveredIllegalBatchTrace).toMatchObject({
      status: 'blocked',
      loopGuardrailHit: 'invalid_model_output',
    });
    expect(recoveredIllegalBatchRunStep).not.toHaveBeenCalled();
    await expectNoChargeSideEffects(recoveredIllegalBatch.userId);

    await seedRecoveredContext(exhausted, {
      inputTokens: config.agentMaxInputTokens,
    });
    const exhaustedRunStep = vi.fn<AgentBrainPort['runStep']>().mockResolvedValue({
      type: 'respond',
      text: 'Current active context can continue',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const exhaustedBrain: AgentBrainPort = {
      countInputTokens: testTokenCounter,
      runStep: exhaustedRunStep,
    };
    await processTurn(exhausted, exhaustedBrain);
    const [exhaustedTrace, exhaustedTurn] = await Promise.all([
      resource.db.query.agentTraces.findFirst({
        where: eq(agentTraces.id, exhausted.traceId),
      }),
      resource.db.query.agentTurns.findFirst({
        where: eq(agentTurns.id, exhausted.turnId),
      }),
    ]);
    expect(exhaustedTrace?.loopGuardrailHit).toBeNull();
    expect(exhaustedTurn?.status).toBe('done');
    expect(exhaustedRunStep).toHaveBeenCalledTimes(1);
    await expectNoChargeSideEffects(exhausted.userId);
  });

  it.each(['respond', 'chat_text', 'request_clarification', 'tool_calls'] as const)(
    'repairs one unsafe %s without persisting or streaming its content',
    async (mode) => {
      const fixture = await createTurn('验证公开文本安全策略');
      const sensitive = 'api_key=abcdefghijklmnopqrstuvwx';
      const publicTextRunStep = vi
        .fn()
        .mockResolvedValueOnce({
          type: mode,
          ...(mode === 'request_clarification'
            ? { question: '请选择方向', suggestions: [sensitive] }
            : mode === 'tool_calls'
              ? {
                  commentary: sensitive,
                  calls: [
                    {
                      call_id: 'unsafe-commentary',
                      name: 'load_skill@1',
                      arguments: { skill_id: 'creative-free-generation@1.0.1', view: 'planning' },
                    },
                  ],
                }
              : { text: sensitive }),
          usage: { input_tokens: 2, output_tokens: 2 },
        })
        .mockResolvedValueOnce({
          type: 'respond',
          text: '已安全整理当前创作方向。',
          usage: { input_tokens: 2, output_tokens: 2 },
        });
      const brain: AgentBrainPort = {
        countInputTokens: testTokenCounter,
        runStep: publicTextRunStep,
      };
      await processTurn(fixture, brain);
      const [messages, events, steps, transcriptItems, transcriptPayloads] = await Promise.all([
        resource.db.query.chatMessages.findMany({ where: eq(chatMessages.turnId, fixture.turnId) }),
        resource.db.query.eventOutbox.findMany({ where: eq(eventOutbox.scopeId, fixture.turnId) }),
        resource.db.query.agentTraceSteps.findMany({
          where: eq(agentTraceSteps.traceId, fixture.traceId),
        }),
        resource.db.query.agentTranscriptItems.findMany({
          where: eq(agentTranscriptItems.turnId, fixture.turnId),
        }),
        resource.db.query.agentTranscriptPayloads.findMany({
          where: eq(agentTranscriptPayloads.turnId, fixture.turnId),
        }),
      ]);
      expect(publicTextRunStep).toHaveBeenCalledTimes(2);
      expect(messages.filter((item) => item.role === 'assistant')).toHaveLength(1);
      expect(messages.find((item) => item.role === 'assistant')?.content).toBe(
        '已安全整理当前创作方向。',
      );
      expect(JSON.stringify(messages)).not.toContain(sensitive);
      expect(JSON.stringify(events)).not.toContain(sensitive);
      expect(JSON.stringify(steps)).not.toContain(sensitive);
      const stringifyRecord = (value: unknown) =>
        JSON.stringify(value, (_key, field: unknown) =>
          typeof field === 'bigint' ? field.toString() : field,
        );
      expect(stringifyRecord(transcriptItems)).not.toContain(sensitive);
      expect(stringifyRecord(transcriptPayloads)).not.toContain(sensitive);
      expect(steps.filter((item) => item.errorCode === 'AGENT_PUBLIC_TEXT_REJECTED')).toHaveLength(
        1,
      );
      expect(
        steps.some(
          (item) => (item.outputSummary as { outcome?: string }).outcome === 'public_text_rejected',
        ),
      ).toBe(true);
      expect(JSON.stringify(publicTextRunStep.mock.calls[1])).toContain(
        'return_safe_public_text_without_secrets_or_private_context',
      );
      expect(JSON.stringify(publicTextRunStep.mock.calls[1])).not.toContain(sensitive);
      await expectNoChargeSideEffects(fixture.userId);
    },
  );

  it('shares one safety repair across native replies and clarification and stops after repeated rejection', async () => {
    const fixture = await createTurn('安全回复跨形式重复拒绝');
    const runStep = vi
      .fn<AgentBrainPort['runStep']>()
      .mockResolvedValueOnce({
        type: 'chat_text',
        text: 'api_key=abcdefghijklmnopqrstuvwx',
        usage: { input_tokens: 2, output_tokens: 2 },
      })
      .mockResolvedValue({
        type: 'request_clarification',
        question: 'api_key=abcdefghijklmnopqrstuvwx',
        suggestions: [],
        usage: { input_tokens: 2, output_tokens: 2 },
      });
    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });
    expect(runStep).toHaveBeenCalledTimes(2);
    const turn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    expect(turn?.status).toBe('blocked');
    const trace = await resource.db.query.agentTraces.findFirst({
      where: eq(agentTraces.id, fixture.traceId),
    });
    expect(trace).toMatchObject({ loopGuardrailHit: 'public_text_policy', outputTokenTotal: 4 });
    await expectNoChargeSideEffects(fixture.userId);
  });

  it.each(['AGENT_BRAIN_TOOL_INPUT_INVALID', 'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID'])(
    'does not call the model after takeover of an exhausted repair budget ending in %s',
    async (lastError) => {
      const fixture = await createTurn('recovered model output repair budget');
      await seedRecoveredContext(fixture, {
        steps: [
          'AGENT_BRAIN_TOOL_INPUT_INVALID',
          'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID',
          'AGENT_BRAIN_TOOL_INPUT_INVALID',
          lastError,
        ].map((errorCode) => ({
          stepType: 'llm_call' as const,
          status: 'failed' as const,
          errorCode,
        })),
      });
      const runStep = vi.fn<AgentBrainPort['runStep']>().mockResolvedValue({
        type: 'chat_text',
        text: 'This response must never be requested.',
        usage: { input_tokens: 2, output_tokens: 2 },
      });
      const countInputTokens = vi.fn<AgentBrainPort['countInputTokens']>().mockResolvedValue(95000);
      const summarizeSession = vi.fn<NonNullable<AgentBrainPort['summarizeSession']>>();
      await processTurn(fixture, { countInputTokens, runStep, summarizeSession });
      expect(runStep).not.toHaveBeenCalled();
      expect(countInputTokens).not.toHaveBeenCalled();
      expect(summarizeSession).not.toHaveBeenCalled();
      const turn = await resource.db.query.agentTurns.findFirst({
        where: eq(agentTurns.id, fixture.turnId),
      });
      expect(turn?.status).toBe('blocked');
      const steps = await resource.db.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, fixture.traceId),
        orderBy: (table, { asc }) => [asc(table.stepNo)],
      });
      expect(steps.at(-1)).toMatchObject({ stepType: 'guardrail', errorCode: lastError });
      const trace = await resource.db.query.agentTraces.findFirst({
        where: eq(agentTraces.id, fixture.traceId),
      });
      expect(trace?.loopGuardrailHit).toBe('invalid_model_output');
      await expectNoChargeSideEffects(fixture.userId);
    },
  );

  it('does not call the model after takeover of an exhausted public text repair budget', async () => {
    const fixture = await createTurn('接管安全回复拒绝');
    await seedRecoveredContext(fixture, {
      steps: [1, 2].map(() => ({
        stepType: 'llm_call' as const,
        status: 'failed' as const,
        errorCode: 'AGENT_PUBLIC_TEXT_REJECTED',
        outputSummary: { outcome: 'public_text_rejected' },
      })),
    });
    const runStep = vi.fn<AgentBrainPort['runStep']>();
    await processTurn(fixture, { countInputTokens: testTokenCounter, runStep });
    expect(runStep).not.toHaveBeenCalled();
    const turn = await resource.db.query.agentTurns.findFirst({
      where: eq(agentTurns.id, fixture.turnId),
    });
    expect(turn?.status).toBe('blocked');
    await expectNoChargeSideEffects(fixture.userId);
  });
});

function payloadToClaim(payload: Extract<QueuePayload, { job_type: 'agent.continue' }>) {
  return {
    turnId: payload.turn_id,
    sessionId: payload.session_id,
    traceId: payload.trace_id,
    userMessageId: payload.user_message_id,
    continuationNo: payload.continuation_no,
    payloadRevision: payload.turn_revision,
  };
}
