import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  adminPrincipals,
  agentTraces,
  agentTraceSteps,
  agentTurns,
  chatSessions,
  eq,
  inArray,
  modelPocRuns,
  models,
  providerCircuitStates,
  providerChannels,
  providerCredentialValidationRuns,
  providerCredentialVersions,
  storageChannels,
  storageCredentialVersions,
  storageValidationRuns,
  users,
} from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';
import { SecretEnvelope } from '@ecom-forge/shared/secret-envelope';
import { LocalPrivateStorage, S10_PRIVATE_ASSET_SMOKE_CONTRACT_VERSION } from '@ecom-forge/storage';
import { agentBrainModelSnapshotSchema, type AgentBrainStepInput } from '@ecom-forge/agent';

import { ApprovedAgentBrainRouter } from '../src/agent/approved-agent-brain.router.js';
import type { WorkerConfig } from '../src/config/worker-config.js';
import { ModelPocService } from '../src/provider/model-poc.service.js';
import { ProviderCredentialValidationService } from '../src/provider/provider-credential-validation.service.js';
import { StorageCredentialValidationService } from '../src/storage/storage-credential-validation.service.js';
import {
  closeIntegrationInfrastructure,
  databaseResource,
  integrationWorkerConfig,
  redis,
} from './s05-integration.fixture.js';

const db = databaseResource.db;

function imageContract() {
  return {
    schema_version: 2,
    contract_kind: 'media',
    media_kind: 'image',
    capabilities: ['image.generate'],
    specs: [
      {
        kind: 'image',
        spec_key: 'generate-quality-2k',
        operation: 'image.generate',
        mode: 'quality',
        resolution_tier: '2k',
        aspect_ratios: ['1:1'],
        max_outputs: 1,
        max_reference_images: 0,
        transparent_background: false,
        output_formats: ['png'],
      },
    ],
  } as const;
}

function imagePricing() {
  return {
    schema_version: 2,
    contract_kind: 'media_rate_card',
    currency: 'CNY',
    rate_cards: [
      {
        rate_key: 'generate-quality-2k-per-image',
        spec_key: 'generate-quality-2k',
        billing_unit: 'image',
        unit_cost_cny: '0.40',
      },
    ],
    overhead_cny: { tool: '0.00', storage: '0.02', traffic: '0.01', agent_brain: '0.03' },
    failure_rate: '0.05',
    unknown_rate: '0.01',
    refund_rate: '0.02',
    risk_reserve_rate: '0.10',
    gross_margin_target: '0.50',
    credit_cny_anchor: '0.01',
  } as const;
}

function quota() {
  return {
    schema_version: 1,
    rpm: 60,
    concurrency: 4,
    hourly_budget_cny: '10.00',
    daily_budget_cny: '100.00',
    poll_initial_delay_ms: 1_000,
    poll_interval_ms: 1_000,
    max_poll_count: 30,
    terminal_timeout_ms: 60_000,
    circuit_sample_size: 20,
    circuit_failure_rate: '0.50',
    circuit_unknown_rate: '0.20',
    circuit_open_ms: 60_000,
  } as const;
}

function brainContract() {
  return {
    schema_version: 1,
    contract_kind: 'agent_brain',
    capabilities: ['agent.brain'],
    input_modalities: ['text'],
    tool_protocol: 'native_function_calling',
    terminal_protocol: 'terminal_tools',
    supports_usage_tokens: true,
    max_context_tokens: 32_000,
    max_output_tokens: 4_096,
    max_tool_calls_per_response: 4,
  } as const;
}

function brainPricing() {
  return {
    schema_version: 1,
    contract_kind: 'agent_brain_tokens',
    currency: 'CNY',
    request_base_cost_cny: '0.00',
    input_per_million_tokens_cny: '1.00',
    cached_input_per_million_tokens_cny: '0.50',
    output_per_million_tokens_cny: '4.00',
  } as const;
}

function brainQuota() {
  return {
    schema_version: 1,
    contract_kind: 'agent_brain',
    rpm: 60,
    concurrency: 4,
    hourly_budget_cny: '10.00',
    daily_budget_cny: '100.00',
    max_turn_llm_rounds: 6,
    max_turn_input_tokens: 32_000,
    max_turn_output_tokens: 4_096,
    max_turn_estimated_cost_cny: '0.50',
    terminal_timeout_ms: 60_000,
    circuit_sample_size: 20,
    circuit_failure_rate: '0.50',
    circuit_unknown_rate: '0.20',
    circuit_open_ms: 60_000,
  } as const;
}

describe('S14 control-plane validation workers', () => {
  afterAll(async () => closeIntegrationInfrastructure());

  it('claims concurrent work once, recovers expired leases, and never promotes without passed evidence', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'ecom-forge-s14-storage-'));
    const ids = {
      admin: randomUUID(),
      providerChannel: randomUUID(),
      providerCredential: randomUUID(),
      providerRun: randomUUID(),
      expiredProviderCredential: randomUUID(),
      expiredProviderRun: randomUUID(),
      storageChannel: randomUUID(),
      storageCredential: randomUUID(),
      storageRun: randomUUID(),
      model: randomUUID(),
      modelRun: randomUUID(),
      brainModel: randomUUID(),
      brainModelRun: randomUUID(),
    };
    const config: WorkerConfig = {
      ...integrationWorkerConfig,
      testProcessorEnabled: false,
      providerProcessorMode: 'fake_validation',
      localUploadRoot: storageRoot,
    };
    try {
      await db.insert(adminPrincipals).values({
        id: ids.admin,
        identifierHash: canonicalSha256({ id: ids.admin }),
        identifierKeyId: 's14-test',
        identifierHint: 's14-***',
        displayName: 'S14 Worker Fixture',
        status: 'active',
      });
      await db.insert(providerChannels).values({
        id: ids.providerChannel,
        provider: `fake-${ids.providerChannel}`,
        adapterKey: 'fake-provider-v1',
        baseUrl: 'https://local.invalid',
        displayName: 'S14 fake channel',
        endpointProfileKey: 'local',
        region: 'local',
        regionKey: 'local',
        status: 'active',
        createdByAdminId: ids.admin,
      });
      await db.insert(providerCredentialVersions).values([
        {
          id: ids.providerCredential,
          providerChannelId: ids.providerChannel,
          versionNo: 1,
          secretCiphertext: 'ciphertext',
          secretNonce: 'nonce',
          secretAuthTag: 'auth-tag',
          secretKeyId: 's14-test',
          keyHint: 'key-fixture',
        },
        {
          id: ids.expiredProviderCredential,
          providerChannelId: ids.providerChannel,
          versionNo: 2,
          secretCiphertext: 'ciphertext',
          secretNonce: 'nonce',
          secretAuthTag: 'auth-tag',
          secretKeyId: 's14-test',
          keyHint: 'key-expired',
        },
      ]);
      await db.insert(providerCredentialValidationRuns).values([
        {
          id: ids.providerRun,
          providerChannelId: ids.providerChannel,
          credentialVersionId: ids.providerCredential,
          probeContractVersion: 'provider-credential@1',
          requestedByAdminId: ids.admin,
        },
        {
          id: ids.expiredProviderRun,
          providerChannelId: ids.providerChannel,
          credentialVersionId: ids.expiredProviderCredential,
          probeContractVersion: 'provider-credential@1',
          status: 'running',
          processingOwner: 'crashed-worker',
          processingLeaseExpiresAt: new Date(Date.now() - 1_000),
          revision: 2,
          requestedByAdminId: ids.admin,
        },
      ]);
      const provider = new ProviderCredentialValidationService(db, config, 5_000);
      const providerPayload = {
        schema_version: 3,
        job_type: 'provider-credential.validate',
        trace_id: randomUUID(),
        credential_validation_run_id: ids.providerRun,
        provider_channel_id: ids.providerChannel,
        credential_version_id: ids.providerCredential,
        probe_contract_version: 'provider-credential@1',
        attempt_no: 1,
      } as const;
      expect(
        (
          await Promise.all([provider.execute(providerPayload), provider.execute(providerPayload)])
        ).sort(),
      ).toEqual([false, true]);
      expect(
        await provider.execute({
          ...providerPayload,
          credential_validation_run_id: ids.expiredProviderRun,
          credential_version_id: ids.expiredProviderCredential,
        }),
      ).toBe(true);
      const providerRows = await db
        .select({ id: providerCredentialVersions.id, status: providerCredentialVersions.status })
        .from(providerCredentialVersions)
        .where(eq(providerCredentialVersions.providerChannelId, ids.providerChannel));
      expect(providerRows).toEqual(
        expect.arrayContaining([
          { id: ids.providerCredential, status: 'valid' },
          { id: ids.expiredProviderCredential, status: 'valid' },
        ]),
      );

      await db.insert(storageChannels).values({
        id: ids.storageChannel,
        purpose: 'private_assets',
        adapterKey: 'local-private-v1',
        endpointProfileKey: 'local',
        region: 'local',
        regionKey: 'local',
        bucket: `s14-${ids.storageChannel.replaceAll('-', '').slice(0, 24)}`,
        rootPrefix: 'private',
        createdByAdminId: ids.admin,
      });
      await db.insert(storageCredentialVersions).values({
        id: ids.storageCredential,
        storageChannelId: ids.storageChannel,
        versionNo: 1,
        secretBundleCiphertext: 'ciphertext',
        secretNonce: 'nonce',
        secretAuthTag: 'auth-tag',
        secretKeyId: 's14-test',
        keyHint: 'key-storage',
      });
      await db.insert(storageValidationRuns).values({
        id: ids.storageRun,
        storageChannelId: ids.storageChannel,
        credentialVersionId: ids.storageCredential,
        probeContractVersion: 'storage-private-assets@1',
        probePrefixDigest: canonicalSha256({ run: ids.storageRun }),
        requestedByAdminId: ids.admin,
      });
      const storage = new StorageCredentialValidationService(db, config, 5_000);
      const storagePayload = {
        schema_version: 3,
        job_type: 'storage-credential.validate',
        trace_id: randomUUID(),
        storage_validation_run_id: ids.storageRun,
        storage_channel_id: ids.storageChannel,
        credential_version_id: ids.storageCredential,
        probe_contract_version: 'storage-private-assets@1',
        attempt_no: 1,
      } as const;
      expect(
        (
          await Promise.all([storage.execute(storagePayload), storage.execute(storagePayload)])
        ).sort(),
      ).toEqual([false, true]);
      expect(
        await db.query.storageCredentialVersions.findFirst({
          where: eq(storageCredentialVersions.id, ids.storageCredential),
        }),
      ).toMatchObject({ status: 'valid' });

      await db
        .update(providerCredentialVersions)
        .set({ status: 'active' })
        .where(eq(providerCredentialVersions.id, ids.providerCredential));
      await db.insert(models).values({
        id: ids.model,
        provider: `fake-${ids.providerChannel}`,
        providerChannelId: ids.providerChannel,
        modelId: `s14-image-${ids.model}`,
        version: '1',
        capabilityContractJson: imageContract(),
        pricingJson: imagePricing(),
        quotaJson: quota(),
        status: 'free_test_only',
      });
      const specKeys = ['generate-quality-2k'];
      const specDigest = canonicalSha256({ spec_keys: specKeys });
      await db.insert(modelPocRuns).values({
        id: ids.modelRun,
        modelSnapshotId: ids.model,
        providerChannelId: ids.providerChannel,
        credentialVersionId: ids.providerCredential,
        probeSuiteVersion: 'model-poc@1',
        requestedSpecKeysJson: specKeys,
        requestedSpecKeysDigest: specDigest,
        requestedByAdminId: ids.admin,
      });
      const modelPoc = new ModelPocService(db, config, 5_000);
      expect(
        await modelPoc.execute({
          schema_version: 3,
          job_type: 'model-poc.run',
          trace_id: randomUUID(),
          model_poc_run_id: ids.modelRun,
          model_snapshot_id: ids.model,
          provider_channel_id: ids.providerChannel,
          credential_version_id: ids.providerCredential,
          probe_suite_version: 'model-poc@1',
          requested_spec_keys_digest: specDigest,
          attempt_no: 1,
        }),
      ).toBe(true);
      expect(
        await db.query.modelPocRuns.findFirst({ where: eq(modelPocRuns.id, ids.modelRun) }),
      ).toMatchObject({ status: 'passed' });
      expect(await db.query.models.findFirst({ where: eq(models.id, ids.model) })).toMatchObject({
        status: 'free_test_only',
      });

      await db.insert(models).values({
        id: ids.brainModel,
        provider: `fake-${ids.providerChannel}`,
        providerChannelId: ids.providerChannel,
        modelId: `s14-brain-${ids.brainModel}`,
        version: '1',
        capabilityContractJson: brainContract(),
        pricingJson: brainPricing(),
        quotaJson: brainQuota(),
        status: 'free_test_only',
      });
      const brainSpecKeys = ['brain'];
      const brainSpecDigest = canonicalSha256({ spec_keys: brainSpecKeys });
      await db.insert(modelPocRuns).values({
        id: ids.brainModelRun,
        modelSnapshotId: ids.brainModel,
        providerChannelId: ids.providerChannel,
        credentialVersionId: ids.providerCredential,
        probeSuiteVersion: 'model-poc@1',
        requestedSpecKeysJson: brainSpecKeys,
        requestedSpecKeysDigest: brainSpecDigest,
        requestedByAdminId: ids.admin,
      });
      expect(
        await modelPoc.execute({
          schema_version: 3,
          job_type: 'model-poc.run',
          trace_id: randomUUID(),
          model_poc_run_id: ids.brainModelRun,
          model_snapshot_id: ids.brainModel,
          provider_channel_id: ids.providerChannel,
          credential_version_id: ids.providerCredential,
          probe_suite_version: 'model-poc@1',
          requested_spec_keys_digest: brainSpecDigest,
          attempt_no: 1,
        }),
      ).toBe(true);
      expect(
        await db.query.modelPocRuns.findFirst({ where: eq(modelPocRuns.id, ids.brainModelRun) }),
      ).toMatchObject({ status: 'passed' });
    } finally {
      await db.delete(modelPocRuns).where(eq(modelPocRuns.id, ids.brainModelRun));
      await db.delete(modelPocRuns).where(eq(modelPocRuns.id, ids.modelRun));
      await db.delete(models).where(eq(models.id, ids.brainModel));
      await db.delete(models).where(eq(models.id, ids.model));
      await db.delete(storageValidationRuns).where(eq(storageValidationRuns.id, ids.storageRun));
      await db
        .delete(storageCredentialVersions)
        .where(eq(storageCredentialVersions.id, ids.storageCredential));
      await db.delete(storageChannels).where(eq(storageChannels.id, ids.storageChannel));
      await db
        .delete(providerCredentialValidationRuns)
        .where(eq(providerCredentialValidationRuns.providerChannelId, ids.providerChannel));
      await db
        .delete(providerCredentialVersions)
        .where(eq(providerCredentialVersions.providerChannelId, ids.providerChannel));
      await db.delete(providerChannels).where(eq(providerChannels.id, ids.providerChannel));
      await db.delete(adminPrincipals).where(eq(adminPrincipals.id, ids.admin));
      await rm(storageRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('routes an approved Brain through the exact credential snapshot and rejects rotation', async () => {
    const ids = {
      channel: randomUUID(),
      originalCredential: randomUUID(),
      rotatedCredential: randomUUID(),
      model: randomUUID(),
      user: randomUUID(),
      session: randomUUID(),
      turn: randomUUID(),
      trace: randomUUID(),
    };
    const keyring = `brain-test-v1:${Buffer.alloc(32, 7).toString('base64url')}`;
    const envelope = new SecretEnvelope(keyring);
    const original = envelope.encrypt('sk-original-key-123456');
    const rotated = envelope.encrypt('sk-rotated-key-123456');
    const providerResponse = () =>
      new Response(
        JSON.stringify({
          id: 'resp_test',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              id: 'fc_test',
              call_id: 'call_test',
              name: 'agent_respond',
              arguments: JSON.stringify({ text: '已理解当前创作目标。' }),
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200 },
      );
    let resolveFirstCall!: (response: Response) => void;
    const firstCallResponse = new Promise<Response>((resolve) => {
      resolveFirstCall = resolve;
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstCallResponse)
      .mockImplementation(() => Promise.resolve(providerResponse()));
    try {
      await db.insert(providerChannels).values({
        id: ids.channel,
        provider: 'openai',
        adapterKey: 'vercel-ai-relay-v1',
        baseUrl: 'https://relay.test.invalid/v1',
        displayName: 'OpenAI Responses integration fixture',
        endpointProfileKey: 'relay-v1',
        region: null,
        regionKey: '',
        status: 'draft',
      });
      await db.insert(providerCredentialVersions).values({
        id: ids.originalCredential,
        providerChannelId: ids.channel,
        versionNo: 1,
        secretCiphertext: original.ciphertext,
        secretNonce: original.nonce,
        secretAuthTag: original.authTag,
        secretKeyId: original.keyId,
        keyHint: 'original',
        status: 'active',
        validationEvidenceDigest: 'b'.repeat(64),
      });
      await db
        .update(providerChannels)
        .set({ status: 'active', activeCredentialVersionId: ids.originalCredential })
        .where(eq(providerChannels.id, ids.channel));
      await db.insert(models).values({
        id: ids.model,
        provider: 'openai',
        providerChannelId: ids.channel,
        protocolFamily: 'openai',
        apiVariant: 'openai_responses',
        modelId: 'gpt-5-mini',
        version: '2025-08-07',
        capabilityContractJson: brainContract(),
        pricingJson: brainPricing(),
        quotaJson: brainQuota(),
        status: 'poc_passed',
        statusEvidenceDigest: 'a'.repeat(64),
      });

      const modelSnapshot = agentBrainModelSnapshotSchema.parse({
        snapshot_id: ids.model,
        adapter: 'approved',
        provider: 'openai',
        protocol_family: 'openai',
        api_variant: 'openai_responses',
        model_id: 'gpt-5-mini',
        version: '2025-08-07',
        status: 'poc_passed',
        status_evidence_digest: 'a'.repeat(64),
        capability_contract: brainContract(),
        pricing: brainPricing(),
        quota: { ...brainQuota(), concurrency: 1 },
        runtime: {
          provider_channel_id: ids.channel,
          provider_channel_revision: 1,
          adapter_key: 'vercel-ai-relay-v1',
          endpoint_profile_key: 'relay-v1',
          region: null,
          credential_version_id: ids.originalCredential,
        },
      });
      const brainInput: AgentBrainStepInput = {
        execution_format: 'transcript_v1',
        current_message: '生成一张商品图',
        authorized_images: [],
        skill_selection: {
          primary_skill_id: 'creative-free-generation@1.0.1',
          default_output_count: 1,
          primary_name: '自由创作',
          preset_names: [],
          required_capabilities: ['image.generate'],
        },
        loaded_skills: [],
        required_auxiliary_catalog: [],
        optional_auxiliary_catalog: [],
        observations: [],
        enabled_tools: [],
        remaining_budget: {
          rounds: 1,
          tool_calls: 0,
          input_tokens: 32_000,
          output_tokens: 4_096,
        },
      };
      const context = {
        abortSignal: new AbortController().signal,
        deadline: new Date(Date.now() + 10_000),
        idempotencyKey: 'integration-idempotency-key',
        modelSnapshot,
        requestedMaxOutputTokens: 256,
        traceId: randomUUID(),
      };
      const router = new ApprovedAgentBrainRouter(
        db,
        redis,
        integrationWorkerConfig.redisPrefix,
        keyring,
        ['https://relay.test.invalid'],
        fetchImpl,
        true,
      );
      const firstCall = router.runStep(brainInput, context);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      await expect(
        router.runStep(brainInput, {
          ...context,
          idempotencyKey: 'integration-idempotency-key-concurrent',
        }),
      ).rejects.toMatchObject({ delivery: 'not_dispatched' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      resolveFirstCall(providerResponse());
      await expect(firstCall).resolves.toMatchObject({
        type: 'respond',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      await db.insert(users).values({
        id: ids.user,
        email: `${ids.user}@example.test`,
        displayName: 'Agent budget fixture',
      });
      await db.insert(chatSessions).values({
        id: ids.session,
        userId: ids.user,
        title: 'Agent budget fixture',
      });
      await db.insert(agentTurns).values({
        id: ids.turn,
        sessionId: ids.session,
        userId: ids.user,
        status: 'done',
      });
      await db.insert(agentTraces).values({
        id: ids.trace,
        turnId: ids.turn,
        sessionId: ids.session,
        userId: ids.user,
        brainModelId: 'openai:gpt-5-mini@2025-08-07',
        brainModelSnapshotId: ids.model,
        brainModelSnapshotJson: modelSnapshot,
        status: 'succeeded',
      });
      await db.insert(agentTraceSteps).values({
        traceId: ids.trace,
        stepNo: 1,
        stepType: 'llm_call',
        actor: 'agent',
        inputSummary: {},
        outputSummary: { outcome: 'succeeded' },
        status: 'succeeded',
        estimatedCost: '10.01',
        modelSnapshotId: ids.model,
        modelSnapshotJson: modelSnapshot,
      });
      await expect(
        router.runStep(brainInput, {
          ...context,
          idempotencyKey: 'integration-idempotency-key-budget',
        }),
      ).rejects.toMatchObject({ delivery: 'not_dispatched' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(
        await db.query.providerCircuitStates.findFirst({
          where: eq(providerCircuitStates.scopeKey, `model:${ids.model}`),
        }),
      ).toMatchObject({ status: 'open', reasonCode: 'hourly_budget' });

      await db.delete(agentTraceSteps).where(eq(agentTraceSteps.traceId, ids.trace));
      await db.delete(agentTraces).where(eq(agentTraces.id, ids.trace));
      await db.delete(agentTurns).where(eq(agentTurns.id, ids.turn));
      await db.delete(chatSessions).where(eq(chatSessions.id, ids.session));
      await db.delete(users).where(eq(users.id, ids.user));
      await db
        .update(providerCircuitStates)
        .set({
          status: 'closed',
          reasonCode: null,
          sampleCount: 0,
          failureCount: 0,
          unknownCount: 0,
          openedAt: null,
          probeAfter: null,
          probeOwner: null,
        })
        .where(inArray(providerCircuitStates.scopeKey, ['provider:openai', `model:${ids.model}`]));

      fetchImpl.mockRejectedValueOnce(new Error('connection reset after write'));
      const unknownSnapshot = agentBrainModelSnapshotSchema.parse({
        ...modelSnapshot,
        quota: { ...modelSnapshot.quota, circuit_sample_size: 1 },
      });
      await expect(
        router.runStep(brainInput, {
          ...context,
          idempotencyKey: 'integration-idempotency-key-unknown',
          modelSnapshot: unknownSnapshot,
        }),
      ).rejects.toMatchObject({ delivery: 'outcome_unknown' });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await expect(
        router.runStep(brainInput, {
          ...context,
          idempotencyKey: 'integration-idempotency-key-open',
          modelSnapshot: unknownSnapshot,
        }),
      ).rejects.toMatchObject({ delivery: 'not_dispatched' });
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      await db
        .update(providerCredentialVersions)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(eq(providerCredentialVersions.id, ids.originalCredential));
      await db.insert(providerCredentialVersions).values({
        id: ids.rotatedCredential,
        providerChannelId: ids.channel,
        versionNo: 2,
        secretCiphertext: rotated.ciphertext,
        secretNonce: rotated.nonce,
        secretAuthTag: rotated.authTag,
        secretKeyId: rotated.keyId,
        keyHint: 'rotated',
        status: 'active',
        validationEvidenceDigest: 'c'.repeat(64),
      });
      await db
        .update(providerChannels)
        .set({ activeCredentialVersionId: ids.rotatedCredential })
        .where(eq(providerChannels.id, ids.channel));

      await expect(router.runStep(brainInput, context)).rejects.toMatchObject({
        delivery: 'not_dispatched',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await db.delete(agentTraceSteps).where(eq(agentTraceSteps.traceId, ids.trace));
      await db.delete(agentTraces).where(eq(agentTraces.id, ids.trace));
      await db.delete(agentTurns).where(eq(agentTurns.id, ids.turn));
      await db.delete(chatSessions).where(eq(chatSessions.id, ids.session));
      await db.delete(users).where(eq(users.id, ids.user));
      await db
        .delete(providerCircuitStates)
        .where(inArray(providerCircuitStates.scopeKey, ['provider:openai', `model:${ids.model}`]));
      await db.delete(models).where(eq(models.id, ids.model));
      await db
        .update(providerChannels)
        .set({ activeCredentialVersionId: null })
        .where(eq(providerChannels.id, ids.channel));
      await db
        .delete(providerCredentialVersions)
        .where(eq(providerCredentialVersions.providerChannelId, ids.channel));
      await db.delete(providerChannels).where(eq(providerChannels.id, ids.channel));
    }
  });

  it.each([
    [200, 'passed'],
    [401, 'failed'],
    [503, 'outcome_unknown'],
  ] as const)(
    'revalidates Gemini credentials with HTTP %s through model discovery only',
    async (status, expected) => {
      const ids = {
        admin: randomUUID(),
        channel: randomUUID(),
        credential: randomUUID(),
        run: randomUUID(),
      };
      const keyring = `review-test:${Buffer.alloc(32, 1).toString('base64url')}`;
      const encrypted = new SecretEnvelope(keyring).encrypt('relay-key-test-123456');
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'gemini-test' }] }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
      try {
        await db.insert(adminPrincipals).values({
          id: ids.admin,
          identifierHash: canonicalSha256(ids.admin),
          identifierKeyId: 'review-test',
          identifierHint: 'review-***',
          displayName: 'Review Test',
          status: 'active',
        });
        await db.insert(providerChannels).values({
          id: ids.channel,
          provider: 'google',
          adapterKey: 'vercel-ai-relay-v1',
          endpointProfileKey: 'relay-v1',
          baseUrl: 'https://relay.test.invalid',
          displayName: 'Gemini test',
          regionKey: '',
          status: 'active',
          createdByAdminId: ids.admin,
        });
        await db.insert(providerCredentialVersions).values({
          id: ids.credential,
          providerChannelId: ids.channel,
          versionNo: 1,
          secretCiphertext: encrypted.ciphertext,
          secretNonce: encrypted.nonce,
          secretAuthTag: encrypted.authTag,
          secretKeyId: encrypted.keyId,
          keyHint: 'test-key',
          status: 'active',
          validationEvidenceDigest: 'old-evidence',
        });
        await db.insert(providerCredentialValidationRuns).values({
          id: ids.run,
          providerChannelId: ids.channel,
          credentialVersionId: ids.credential,
          probeContractVersion: 'vercel-ai-relay@1',
          attemptNo: 1,
          requestedByAdminId: ids.admin,
        });
        const payload = {
          schema_version: 3,
          job_type: 'provider-credential.validate',
          trace_id: randomUUID(),
          credential_validation_run_id: ids.run,
          provider_channel_id: ids.channel,
          credential_version_id: ids.credential,
          probe_contract_version: 'vercel-ai-relay@1',
          attempt_no: 1,
        } as const;
        const config = {
          ...integrationWorkerConfig,
          providerRealPocEnabled: true,
          providerCredentialEncryptionKeys: keyring,
          providerRelayOrigins: ['https://relay.test.invalid'],
        };
        const service = new ProviderCredentialValidationService(db, config, 5000, fetchImpl);
        expect(await Promise.all([service.execute(payload), service.execute(payload)])).toEqual(
          expect.arrayContaining([true, false]),
        );
        expect(await service.execute(payload)).toBe(false);
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://relay.test.invalid/v1/models');
        expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
          'Bearer relay-key-test-123456',
        );
        expect(
          await db.query.providerCredentialValidationRuns.findFirst({
            where: eq(providerCredentialValidationRuns.id, ids.run),
          }),
        ).toMatchObject({ status: expected });
        expect(
          await db.query.providerCredentialVersions.findFirst({
            where: eq(providerCredentialVersions.id, ids.credential),
          }),
        ).toMatchObject({
          status: 'active',
          revision: expected === 'passed' ? 2 : 1,
          ...(expected === 'passed' ? {} : { validationEvidenceDigest: 'old-evidence' }),
        });
      } finally {
        await db
          .delete(providerCredentialValidationRuns)
          .where(eq(providerCredentialValidationRuns.id, ids.run));
        await db
          .update(providerChannels)
          .set({ activeCredentialVersionId: null })
          .where(eq(providerChannels.id, ids.channel));
        await db
          .delete(providerCredentialVersions)
          .where(eq(providerCredentialVersions.id, ids.credential));
        await db.delete(providerChannels).where(eq(providerChannels.id, ids.channel));
        await db.delete(adminPrincipals).where(eq(adminPrincipals.id, ids.admin));
      }
    },
  );

  it('refreshes active credential evidence only after a passed revalidation', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'ecom-forge-s14-revalidation-'));
    const blockedRoot = join(storageRoot, 'blocked-root');
    const ids = {
      admin: randomUUID(),
      providerChannel: randomUUID(),
      providerCredential: randomUUID(),
      providerPassedRun: randomUUID(),
      providerFailedRun: randomUUID(),
      storageChannel: randomUUID(),
      storageCredential: randomUUID(),
      storagePassedRun: randomUUID(),
      storageFailedRun: randomUUID(),
      storageUnknownRun: randomUUID(),
    };
    const config: WorkerConfig = {
      ...integrationWorkerConfig,
      testProcessorEnabled: false,
      providerProcessorMode: 'fake_validation',
      localUploadRoot: storageRoot,
    };
    try {
      await db.insert(adminPrincipals).values({
        id: ids.admin,
        identifierHash: canonicalSha256({ id: ids.admin }),
        identifierKeyId: 's14-test',
        identifierHint: 's14-revalidation-***',
        displayName: 'S14 Revalidation Fixture',
        status: 'active',
      });
      await db.insert(providerChannels).values({
        id: ids.providerChannel,
        provider: `fake-${ids.providerChannel}`,
        adapterKey: 'fake-provider-v1',
        baseUrl: 'https://local.invalid',
        displayName: 'S14 active provider',
        endpointProfileKey: 'local',
        region: 'local',
        regionKey: 'local',
        status: 'active',
        createdByAdminId: ids.admin,
      });
      await db.insert(providerCredentialVersions).values({
        id: ids.providerCredential,
        providerChannelId: ids.providerChannel,
        versionNo: 1,
        secretCiphertext: 'ciphertext',
        secretNonce: 'nonce',
        secretAuthTag: 'auth-tag',
        secretKeyId: 's14-test',
        keyHint: 'key-active-provider',
        status: 'active',
        validationEvidenceDigest: 'provider-old-evidence',
        verifiedAt: new Date(Date.now() - 60_000),
      });
      await db.insert(providerCredentialValidationRuns).values({
        id: ids.providerPassedRun,
        providerChannelId: ids.providerChannel,
        credentialVersionId: ids.providerCredential,
        probeContractVersion: 'provider-credential@1',
        attemptNo: 1,
        requestedByAdminId: ids.admin,
      });
      const providerPayload = {
        schema_version: 3,
        job_type: 'provider-credential.validate',
        trace_id: randomUUID(),
        credential_validation_run_id: ids.providerPassedRun,
        provider_channel_id: ids.providerChannel,
        credential_version_id: ids.providerCredential,
        probe_contract_version: 'provider-credential@1',
        attempt_no: 1,
      } as const;
      expect(
        await new ProviderCredentialValidationService(db, config, 5_000).execute(providerPayload),
      ).toBe(true);
      const providerAfterPass = await db.query.providerCredentialVersions.findFirst({
        where: eq(providerCredentialVersions.id, ids.providerCredential),
      });
      expect(providerAfterPass).toMatchObject({ status: 'active', revision: 2 });
      expect(providerAfterPass?.validationEvidenceDigest).not.toBe('provider-old-evidence');
      const providerPassedEvidence = providerAfterPass?.validationEvidenceDigest;
      await db.insert(providerCredentialValidationRuns).values({
        id: ids.providerFailedRun,
        providerChannelId: ids.providerChannel,
        credentialVersionId: ids.providerCredential,
        probeContractVersion: 'provider-credential@1',
        attemptNo: 2,
        requestedByAdminId: ids.admin,
      });
      expect(
        await new ProviderCredentialValidationService(
          db,
          { ...config, providerProcessorMode: 'disabled' },
          5_000,
        ).execute({
          ...providerPayload,
          credential_validation_run_id: ids.providerFailedRun,
          attempt_no: 2,
        }),
      ).toBe(true);
      expect(
        await db.query.providerCredentialVersions.findFirst({
          where: eq(providerCredentialVersions.id, ids.providerCredential),
        }),
      ).toMatchObject({
        status: 'active',
        revision: 2,
        validationEvidenceDigest: providerPassedEvidence,
      });

      await db.insert(storageChannels).values({
        id: ids.storageChannel,
        purpose: 'private_assets',
        adapterKey: 'local-private-v1',
        endpointProfileKey: 'local',
        region: 'local',
        regionKey: 'local',
        bucket: `s14-${ids.storageChannel.replaceAll('-', '').slice(0, 24)}`,
        rootPrefix: 'private',
        status: 'active',
        createdByAdminId: ids.admin,
      });
      await db.insert(storageCredentialVersions).values({
        id: ids.storageCredential,
        storageChannelId: ids.storageChannel,
        versionNo: 1,
        secretBundleCiphertext: 'ciphertext',
        secretNonce: 'nonce',
        secretAuthTag: 'auth-tag',
        secretKeyId: 's14-test',
        keyHint: 'key-active-storage',
        status: 'active',
        validationEvidenceDigest: 'storage-old-evidence',
        verifiedAt: new Date(Date.now() - 60_000),
      });
      await db.insert(storageValidationRuns).values({
        id: ids.storagePassedRun,
        storageChannelId: ids.storageChannel,
        credentialVersionId: ids.storageCredential,
        probeContractVersion: 'storage-private-assets@1',
        probePrefixDigest: canonicalSha256({ run: ids.storagePassedRun }),
        attemptNo: 1,
        requestedByAdminId: ids.admin,
      });
      const storagePayload = {
        schema_version: 3,
        job_type: 'storage-credential.validate',
        trace_id: randomUUID(),
        storage_validation_run_id: ids.storagePassedRun,
        storage_channel_id: ids.storageChannel,
        credential_version_id: ids.storageCredential,
        probe_contract_version: 'storage-private-assets@1',
        attempt_no: 1,
      } as const;
      expect(
        await new StorageCredentialValidationService(db, config, 5_000).execute(storagePayload),
      ).toBe(true);
      const storagePassed = await db.query.storageValidationRuns.findFirst({
        where: eq(storageValidationRuns.id, ids.storagePassedRun),
      });
      expect(storagePassed).toMatchObject({
        status: 'passed',
        resultSummaryJson: {
          smoke_contract_version: S10_PRIVATE_ASSET_SMOKE_CONTRACT_VERSION,
        },
      });
      const storageAfterPass = await db.query.storageCredentialVersions.findFirst({
        where: eq(storageCredentialVersions.id, ids.storageCredential),
      });
      expect(storageAfterPass).toMatchObject({ status: 'active', revision: 2 });
      const storagePassedEvidence = storageAfterPass?.validationEvidenceDigest;
      expect(storagePassedEvidence).not.toBe('storage-old-evidence');

      await db.insert(storageValidationRuns).values({
        id: ids.storageFailedRun,
        storageChannelId: ids.storageChannel,
        credentialVersionId: ids.storageCredential,
        probeContractVersion: 'storage-private-assets@1',
        probePrefixDigest: canonicalSha256({ run: ids.storageFailedRun }),
        attemptNo: 2,
        requestedByAdminId: ids.admin,
      });
      expect(
        await new StorageCredentialValidationService(
          db,
          { ...config, storageEnabled: false },
          5_000,
        ).execute({
          ...storagePayload,
          storage_validation_run_id: ids.storageFailedRun,
          attempt_no: 2,
        }),
      ).toBe(true);
      await db.insert(storageValidationRuns).values({
        id: ids.storageUnknownRun,
        storageChannelId: ids.storageChannel,
        credentialVersionId: ids.storageCredential,
        probeContractVersion: 'storage-private-assets@1',
        probePrefixDigest: canonicalSha256({ run: ids.storageUnknownRun }),
        attemptNo: 3,
        requestedByAdminId: ids.admin,
      });
      await writeFile(blockedRoot, 'not-a-directory', 'utf8');
      expect(
        await new StorageCredentialValidationService(
          db,
          { ...config, localUploadRoot: blockedRoot },
          5_000,
        ).execute({
          ...storagePayload,
          storage_validation_run_id: ids.storageUnknownRun,
          attempt_no: 3,
        }),
      ).toBe(true);
      expect(
        await db.query.storageCredentialVersions.findFirst({
          where: eq(storageCredentialVersions.id, ids.storageCredential),
        }),
      ).toMatchObject({
        status: 'active',
        revision: 2,
        validationEvidenceDigest: storagePassedEvidence,
      });
      expect(
        await db.query.storageValidationRuns.findFirst({
          where: eq(storageValidationRuns.id, ids.storageFailedRun),
        }),
      ).toMatchObject({ status: 'failed' });
      expect(
        await db.query.storageValidationRuns.findFirst({
          where: eq(storageValidationRuns.id, ids.storageUnknownRun),
        }),
      ).toMatchObject({ status: 'outcome_unknown' });
    } finally {
      await db
        .delete(storageValidationRuns)
        .where(eq(storageValidationRuns.storageChannelId, ids.storageChannel));
      await db
        .delete(storageCredentialVersions)
        .where(eq(storageCredentialVersions.storageChannelId, ids.storageChannel));
      await db.delete(storageChannels).where(eq(storageChannels.id, ids.storageChannel));
      await db
        .delete(providerCredentialValidationRuns)
        .where(eq(providerCredentialValidationRuns.providerChannelId, ids.providerChannel));
      await db
        .delete(providerCredentialVersions)
        .where(eq(providerCredentialVersions.providerChannelId, ids.providerChannel));
      await db.delete(providerChannels).where(eq(providerChannels.id, ids.providerChannel));
      await db.delete(adminPrincipals).where(eq(adminPrincipals.id, ids.admin));
      await rm(storageRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('sweeps only bounded terminal probe objects by exact validation run id', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'ecom-forge-s14-probe-sweep-'));
    const ids = {
      admin: randomUUID(),
      channel: randomUUID(),
      credential: randomUUID(),
      missingRun: randomUUID(),
      terminalRun: randomUUID(),
      expiredRun: randomUUID(),
    };
    const config: WorkerConfig = {
      ...integrationWorkerConfig,
      testProcessorEnabled: false,
      localUploadRoot: storageRoot,
    };
    const storage = new LocalPrivateStorage(storageRoot);
    const key = (runId: string) => `private/s14-validation/${runId}/probe.bin`;
    try {
      await db.insert(adminPrincipals).values({
        id: ids.admin,
        identifierHash: canonicalSha256({ id: ids.admin }),
        identifierKeyId: 's14-test',
        identifierHint: 's14-sweep-***',
        displayName: 'S14 Sweep Fixture',
        status: 'active',
      });
      await db.insert(storageChannels).values({
        id: ids.channel,
        purpose: 'private_assets',
        adapterKey: 'local-private-v1',
        endpointProfileKey: 'local',
        region: 'local',
        regionKey: 'local',
        bucket: `s14-${ids.channel.replaceAll('-', '').slice(0, 24)}`,
        rootPrefix: 'private',
        createdByAdminId: ids.admin,
      });
      await db.insert(storageCredentialVersions).values({
        id: ids.credential,
        storageChannelId: ids.channel,
        versionNo: 1,
        secretBundleCiphertext: 'ciphertext',
        secretNonce: 'nonce',
        secretAuthTag: 'auth-tag',
        secretKeyId: 's14-test',
        keyHint: 'key-sweep',
      });
      await db.insert(storageValidationRuns).values([
        {
          id: ids.missingRun,
          storageChannelId: ids.channel,
          credentialVersionId: ids.credential,
          probeContractVersion: 'storage-private-assets@1',
          probePrefixDigest: canonicalSha256({ run: ids.missingRun }),
          status: 'failed',
          evidenceDigest: 'missing-probe-evidence',
          resultSummaryJson: { code: 'STORAGE_VALIDATION_FAILED' },
          completedAt: new Date(Date.now() - 180_000),
          attemptNo: 3,
          requestedByAdminId: ids.admin,
        },
        {
          id: ids.terminalRun,
          storageChannelId: ids.channel,
          credentialVersionId: ids.credential,
          probeContractVersion: 'storage-private-assets@1',
          probePrefixDigest: canonicalSha256({ run: ids.terminalRun }),
          status: 'outcome_unknown',
          evidenceDigest: 'terminal-evidence',
          resultSummaryJson: { code: 'STORAGE_VALIDATION_OUTCOME_UNKNOWN' },
          completedAt: new Date(Date.now() - 120_000),
          attemptNo: 1,
          requestedByAdminId: ids.admin,
        },
        {
          id: ids.expiredRun,
          storageChannelId: ids.channel,
          credentialVersionId: ids.credential,
          probeContractVersion: 'storage-private-assets@1',
          probePrefixDigest: canonicalSha256({ run: ids.expiredRun }),
          status: 'running',
          processingOwner: 'crashed-worker',
          processingLeaseExpiresAt: new Date(Date.now() - 60_000),
          revision: 2,
          attemptNo: 2,
          requestedByAdminId: ids.admin,
        },
      ]);
      await storage.initialize();
      await storage.writeExclusive(key(ids.terminalRun), Buffer.from('terminal'));
      await storage.writeExclusive(key(ids.expiredRun), Buffer.from('expired'));
      const service = new StorageCredentialValidationService(db, config, 5_000);
      expect(await service.sweepResidualProbes(new Date(), 1)).toBe(1);
      expect(
        await db.query.storageValidationRuns.findFirst({
          where: eq(storageValidationRuns.id, ids.missingRun),
          columns: { resultSummaryJson: true },
        }),
      ).toMatchObject({ resultSummaryJson: { probe_cleanup_status: 'completed' } });
      await expect(storage.read(key(ids.terminalRun))).rejects.toThrow();
      await expect(storage.read(key(ids.expiredRun))).resolves.toEqual(Buffer.from('expired'));
      expect(
        await service.execute({
          schema_version: 3,
          job_type: 'storage-credential.validate',
          trace_id: randomUUID(),
          storage_validation_run_id: ids.expiredRun,
          storage_channel_id: ids.channel,
          credential_version_id: ids.credential,
          probe_contract_version: 'storage-private-assets@1',
          attempt_no: 2,
        }),
      ).toBe(true);
      await expect(storage.read(key(ids.expiredRun))).rejects.toThrow();
      await expect(service.sweepResidualProbes(new Date(), 101)).rejects.toThrow(
        'STORAGE_PROBE_SWEEP_LIMIT_INVALID',
      );
    } finally {
      await db
        .delete(storageValidationRuns)
        .where(eq(storageValidationRuns.storageChannelId, ids.channel));
      await db
        .delete(storageCredentialVersions)
        .where(eq(storageCredentialVersions.storageChannelId, ids.channel));
      await db.delete(storageChannels).where(eq(storageChannels.id, ids.channel));
      await db.delete(adminPrincipals).where(eq(adminPrincipals.id, ids.admin));
      await rm(storageRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
