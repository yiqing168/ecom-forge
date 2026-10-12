import { randomUUID } from 'node:crypto';

import {
  AgentBrainCallError,
  agentBrainModelSnapshotSchema,
  type AgentBrainStepInput,
} from '@ecom-forge/agent';
import {
  and,
  eq,
  modelPocRuns,
  models,
  providerChannels,
  providerCredentialVersions,
  type Database,
} from '@ecom-forge/db';
import {
  agentBrainProviderModelSnapshotSchema,
  capabilityContractSchema,
  calculateAgentBrainActualCost,
  mediaV2CapabilityContractSchema,
  VercelAiAgentBrain,
} from '@ecom-forge/provider';
import type { QueuePayload } from '@ecom-forge/queue';
import { canonicalSha256 } from '@ecom-forge/shared';
import { SecretEnvelope } from '@ecom-forge/shared/secret-envelope';

import type { WorkerConfig } from '../config/worker-config.js';
import { ImagePocRunner } from './image-poc.runner.js';
import { ModerationPocRunner } from './moderation-poc.runner.js';

type PocPayload = Extract<QueuePayload, { job_type: 'model-poc.run' }>;
type PocResult = {
  status: 'passed' | 'failed' | 'outcome_unknown';
  evidenceDigest: string;
  summary: Record<string, string>;
};

const terminalStatuses = new Set(['passed', 'failed', 'outcome_unknown', 'cancelled']);

export class ModelPocService {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly database: Database,
    private readonly config: WorkerConfig,
    private readonly leaseMs: number,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  async execute(payload: PocPayload): Promise<boolean> {
    const owner = randomUUID();
    const now = new Date();
    const claim = await this.claim(payload, owner, now);
    if (!claim) return false;
    let result: PocResult;
    try {
      result = await this.validate(payload);
    } catch (error) {
      result = {
        status: 'outcome_unknown',
        evidenceDigest: canonicalSha256({
          run_id: payload.model_poc_run_id,
          outcome: 'unknown',
          error: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
        }),
        summary: { code: 'MODEL_POC_OUTCOME_UNKNOWN' },
      };
    }
    return this.complete(payload, claim, result, new Date());
  }

  private async claim(
    payload: PocPayload,
    owner: string,
    now: Date,
  ): Promise<{ revision: number; owner: string } | null> {
    return this.database.transaction(async (transaction) => {
      const [run] = await transaction
        .select({
          id: modelPocRuns.id,
          revision: modelPocRuns.revision,
          status: modelPocRuns.status,
          processingLeaseExpiresAt: modelPocRuns.processingLeaseExpiresAt,
        })
        .from(modelPocRuns)
        .where(
          and(
            eq(modelPocRuns.id, payload.model_poc_run_id),
            eq(modelPocRuns.modelSnapshotId, payload.model_snapshot_id),
            eq(modelPocRuns.providerChannelId, payload.provider_channel_id),
            eq(modelPocRuns.credentialVersionId, payload.credential_version_id),
            eq(modelPocRuns.probeSuiteVersion, payload.probe_suite_version),
            eq(modelPocRuns.requestedSpecKeysDigest, payload.requested_spec_keys_digest),
            eq(modelPocRuns.attemptNo, payload.attempt_no),
          ),
        )
        .for('update');
      if (!run || terminalStatuses.has(run.status)) return null;
      if (
        run.status === 'running' &&
        run.processingLeaseExpiresAt &&
        run.processingLeaseExpiresAt.getTime() > now.getTime()
      ) {
        return null;
      }
      const revision = run.revision + 1;
      const [updated] = await transaction
        .update(modelPocRuns)
        .set({
          status: 'running',
          revision,
          processingOwner: owner,
          processingLeaseExpiresAt: new Date(now.getTime() + this.leaseMs),
          startedAt: run.status === 'queued' ? now : undefined,
        })
        .where(and(eq(modelPocRuns.id, run.id), eq(modelPocRuns.revision, run.revision)))
        .returning({ id: modelPocRuns.id });
      return updated ? { revision, owner } : null;
    });
  }

  private async validate(payload: PocPayload): Promise<PocResult> {
    const [run, model, channel, credential] = await Promise.all([
      this.database.query.modelPocRuns.findFirst({
        where: eq(modelPocRuns.id, payload.model_poc_run_id),
      }),
      this.database.query.models.findFirst({ where: eq(models.id, payload.model_snapshot_id) }),
      this.database.query.providerChannels.findFirst({
        where: eq(providerChannels.id, payload.provider_channel_id),
      }),
      this.database.query.providerCredentialVersions.findFirst({
        where: eq(providerCredentialVersions.id, payload.credential_version_id),
      }),
    ]);
    if (
      !run ||
      !model ||
      !channel ||
      !credential ||
      model.providerChannelId !== channel.id ||
      credential.providerChannelId !== channel.id ||
      (credential.status !== 'active' && credential.status !== 'valid')
    ) {
      return this.failed(payload, 'MODEL_POC_SNAPSHOT_INVALID');
    }
    const snapshot = {
      snapshot_id: model.id,
      adapter:
        channel.adapterKey === 'fake-provider-v1' ? ('fake' as const) : ('approved' as const),
      provider: model.provider,
      protocol_family: model.protocolFamily ?? undefined,
      api_variant: model.apiVariant ?? undefined,
      model_id: model.modelId,
      version: model.version,
      status: model.status,
      status_evidence_digest: model.statusEvidenceDigest ?? '0'.repeat(64),
      capability_contract: model.capabilityContractJson,
      pricing: model.pricingJson,
      quota: model.quotaJson,
    };
    const media = mediaV2CapabilityContractSchema.safeParse(model.capabilityContractJson);
    const brain = agentBrainProviderModelSnapshotSchema.safeParse(snapshot);
    const moderation = capabilityContractSchema.safeParse(model.capabilityContractJson);
    const isModeration =
      moderation.success &&
      moderation.data.capabilities.every(
        (capability) => capability === 'moderation.text' || capability === 'moderation.image',
      );
    const category = isModeration
      ? 'moderation'
      : media.success
        ? media.data.media_kind
        : brain.success
          ? 'brain'
          : null;
    if (!category) return this.failed(payload, 'MODEL_POC_CONTRACT_INVALID');
    if (category === 'video') return this.failed(payload, 'MODEL_VIDEO_POC_DISABLED_UNTIL_S16');
    if (
      (category === 'moderation' && payload.probe_suite_version !== 'moderation-poc@1') ||
      (category !== 'moderation' && payload.probe_suite_version !== 'model-poc@1')
    ) {
      return this.failed(payload, 'MODEL_POC_SUITE_INVALID');
    }
    if (
      !Array.isArray(run.requestedSpecKeysJson) ||
      !run.requestedSpecKeysJson.every((value) => typeof value === 'string')
    ) {
      return this.failed(payload, 'MODEL_POC_SPEC_SET_INVALID');
    }
    const requested = new Set(run.requestedSpecKeysJson);
    const available = new Set(
      isModeration
        ? moderation.data.capabilities
        : media.success
          ? media.data.specs.map((spec) => spec.spec_key)
          : ['brain'],
    );
    for (const specKey of requested) {
      if (!available.has(specKey)) return this.failed(payload, 'MODEL_POC_SPEC_NOT_SUPPORTED');
    }
    if (channel.adapterKey !== 'fake-provider-v1') {
      if (category === 'brain') {
        return this.validateRealBrain(payload, { model, channel, credential });
      }
      if (category === 'moderation') {
        return this.validateRealModeration(payload, {
          model,
          channel,
          credential,
          requestedCapabilities: [...requested] as Array<'moderation.text' | 'moderation.image'>,
        });
      }
      if (category === 'image') {
        return this.validateRealImage(payload, {
          model,
          channel,
          credential,
          requestedSpecKeys: [...requested],
        });
      }
      return this.failed(payload, 'MODEL_POC_PROVIDER_NOT_ENABLED');
    }
    if (this.config.providerProcessorMode !== 'fake_validation') {
      return this.failed(payload, 'MODEL_POC_PROVIDER_NOT_ENABLED');
    }
    return {
      status: 'passed',
      evidenceDigest: canonicalSha256({
        model_id: model.modelId,
        version: model.version,
        category,
        requested_spec_keys_digest: payload.requested_spec_keys_digest,
        probe_suite_version: payload.probe_suite_version,
        result: 'fake_poc_passed',
      }),
      summary: { code: 'MODEL_FAKE_POC_PASSED', category },
    };
  }

  private async validateRealModeration(
    payload: PocPayload,
    input: {
      model: typeof models.$inferSelect;
      channel: typeof providerChannels.$inferSelect;
      credential: typeof providerCredentialVersions.$inferSelect;
      requestedCapabilities: Array<'moderation.text' | 'moderation.image'>;
    },
  ): Promise<PocResult> {
    if (!this.config.providerRealPocEnabled || !this.config.providerCredentialEncryptionKeys) {
      return this.failed(payload, 'MODEL_POC_PROVIDER_NOT_ENABLED');
    }
    let apiKey: string;
    try {
      apiKey = new SecretEnvelope(this.config.providerCredentialEncryptionKeys).decrypt({
        keyId: input.credential.secretKeyId,
        ciphertext: input.credential.secretCiphertext,
        nonce: input.credential.secretNonce,
        authTag: input.credential.secretAuthTag,
      });
    } catch {
      return this.failed(payload, 'MODEL_POC_CREDENTIAL_UNAVAILABLE');
    }
    return new ModerationPocRunner(
      this.config.providerRelayOrigins,
      this.config.providerRequestTimeoutMs,
      this.fetchImpl,
    ).run({
      runId: payload.model_poc_run_id,
      traceId: payload.trace_id,
      requestedCapabilities: input.requestedCapabilities,
      apiKey,
      model: input.model,
      channel: input.channel,
      credentialVersionId: input.credential.id,
    });
  }

  private async validateRealImage(
    payload: PocPayload,
    input: {
      model: typeof models.$inferSelect;
      channel: typeof providerChannels.$inferSelect;
      credential: typeof providerCredentialVersions.$inferSelect;
      requestedSpecKeys: string[];
    },
  ): Promise<PocResult> {
    if (!this.config.providerRealPocEnabled || !this.config.providerCredentialEncryptionKeys) {
      return this.failed(payload, 'MODEL_POC_PROVIDER_NOT_ENABLED');
    }
    let apiKey: string;
    try {
      apiKey = new SecretEnvelope(this.config.providerCredentialEncryptionKeys).decrypt({
        keyId: input.credential.secretKeyId,
        ciphertext: input.credential.secretCiphertext,
        nonce: input.credential.secretNonce,
        authTag: input.credential.secretAuthTag,
      });
    } catch {
      return this.failed(payload, 'MODEL_POC_CREDENTIAL_UNAVAILABLE');
    }
    return new ImagePocRunner(
      this.config.providerRelayOrigins,
      this.config.providerImageOutputOrigins,
      this.config.providerRequestTimeoutMs,
      this.config.storageMaxImageBytes,
      this.config.storageMaxImagePixels,
      this.fetchImpl,
    ).run({
      runId: payload.model_poc_run_id,
      traceId: payload.trace_id,
      requestedSpecKeys: input.requestedSpecKeys,
      apiKey,
      model: input.model,
      channel: input.channel,
      credentialVersionId: input.credential.id,
    });
  }

  private async validateRealBrain(
    payload: PocPayload,
    input: {
      model: typeof models.$inferSelect;
      channel: typeof providerChannels.$inferSelect;
      credential: typeof providerCredentialVersions.$inferSelect;
    },
  ): Promise<PocResult> {
    if (!this.config.providerRealPocEnabled || !this.config.providerCredentialEncryptionKeys) {
      return this.failed(payload, 'MODEL_POC_PROVIDER_NOT_ENABLED');
    }
    let apiKey: string;
    try {
      apiKey = new SecretEnvelope(this.config.providerCredentialEncryptionKeys).decrypt({
        keyId: input.credential.secretKeyId,
        ciphertext: input.credential.secretCiphertext,
        nonce: input.credential.secretNonce,
        authTag: input.credential.secretAuthTag,
      });
    } catch {
      return this.failed(payload, 'MODEL_POC_CREDENTIAL_UNAVAILABLE');
    }
    const snapshotResult = agentBrainModelSnapshotSchema.safeParse({
      snapshot_id: input.model.id,
      adapter: 'approved',
      provider: input.model.provider,
      protocol_family: input.model.protocolFamily,
      api_variant: input.model.apiVariant,
      model_id: input.model.modelId,
      version: input.model.version,
      status: input.model.status,
      status_evidence_digest: input.model.statusEvidenceDigest ?? '0'.repeat(64),
      capability_contract: input.model.capabilityContractJson,
      pricing: input.model.pricingJson,
      quota: input.model.quotaJson,
      runtime: {
        provider_channel_id: input.channel.id,
        provider_channel_revision: input.channel.revision,
        adapter_key: input.channel.adapterKey,
        endpoint_profile_key: input.channel.endpointProfileKey,
        region: input.channel.region,
        credential_version_id: input.credential.id,
      },
    });
    if (!snapshotResult.success) return this.failed(payload, 'MODEL_POC_CONTRACT_INVALID');
    const brainInput: AgentBrainStepInput = {
      execution_format: 'transcript_v1',
      current_message: '请仅调用 agent_respond，返回简短中文确认。',
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
        input_tokens: snapshotResult.data.quota.max_turn_input_tokens,
        output_tokens: Math.min(256, snapshotResult.data.quota.max_turn_output_tokens),
      },
    };
    const requestedMaxOutputTokens = Math.min(
      256,
      snapshotResult.data.capability_contract.max_output_tokens,
    );
    try {
      const outcome = await new VercelAiAgentBrain(
        apiKey,
        input.channel.baseUrl,
        this.config.providerRelayOrigins,
        this.fetchImpl,
      ).runStep(brainInput, {
        abortSignal: AbortSignal.timeout(this.config.agentRequestTimeoutMs),
        deadline: new Date(Date.now() + this.config.agentRequestTimeoutMs),
        idempotencyKey: canonicalSha256({ model_poc_run_id: payload.model_poc_run_id }),
        modelSnapshot: snapshotResult.data,
        requestedMaxOutputTokens,
        traceId: payload.trace_id,
      });
      if (outcome.type !== 'respond') {
        return this.failed(payload, 'MODEL_POC_TERMINAL_PROTOCOL_INVALID');
      }
      const actualCost = calculateAgentBrainActualCost({
        pricing: snapshotResult.data.pricing,
        inputTokens: outcome.usage.input_tokens,
        ...(outcome.usage.cached_input_tokens !== undefined
          ? { cachedInputTokens: outcome.usage.cached_input_tokens }
          : {}),
        outputTokens: outcome.usage.output_tokens,
      });
      return {
        status: 'passed',
        evidenceDigest: canonicalSha256({
          model_id: input.model.modelId,
          version: input.model.version,
          protocol_family: input.model.protocolFamily,
          api_variant: input.model.apiVariant,
          adapter_key: input.channel.adapterKey,
          endpoint_profile_key: input.channel.endpointProfileKey,
          provider_channel_id: input.channel.id,
          provider_channel_revision: input.channel.revision,
          base_url: input.channel.baseUrl,
          credential_version_id: input.credential.id,
          probe_suite_version: payload.probe_suite_version,
          result: 'strict_terminal_passed',
          usage: outcome.usage,
          actual_cost_cny: actualCost,
        }),
        summary: {
          code: 'MODEL_AGENT_BRAIN_POC_PASSED',
          category: 'brain',
          actual_cost_cny: actualCost,
          input_tokens: String(outcome.usage.input_tokens),
          cached_input_tokens: String(outcome.usage.cached_input_tokens ?? 0),
          output_tokens: String(outcome.usage.output_tokens),
        },
      };
    } catch (error) {
      if (error instanceof AgentBrainCallError && error.delivery === 'not_dispatched') {
        return this.failed(payload, 'MODEL_POC_NOT_DISPATCHED');
      }
      return {
        status: 'outcome_unknown',
        evidenceDigest: canonicalSha256({
          model_poc_run_id: payload.model_poc_run_id,
          result: 'outcome_unknown',
        }),
        summary: { code: 'MODEL_POC_OUTCOME_UNKNOWN' },
      };
    }
  }

  private failed(payload: PocPayload, code: string): PocResult {
    return {
      status: 'failed',
      evidenceDigest: canonicalSha256({ run_id: payload.model_poc_run_id, code }),
      summary: { code },
    };
  }

  private async complete(
    payload: PocPayload,
    claim: { revision: number; owner: string },
    result: PocResult,
    now: Date,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const [run] = await transaction
        .update(modelPocRuns)
        .set({
          status: result.status,
          revision: claim.revision + 1,
          processingOwner: null,
          processingLeaseExpiresAt: null,
          evidenceDigest: result.evidenceDigest,
          resultSummaryJson: result.summary,
          completedAt: now,
        })
        .where(
          and(
            eq(modelPocRuns.id, payload.model_poc_run_id),
            eq(modelPocRuns.status, 'running'),
            eq(modelPocRuns.processingOwner, claim.owner),
            eq(modelPocRuns.revision, claim.revision),
          ),
        )
        .returning({ id: modelPocRuns.id });
      return Boolean(run);
    });
  }
}
