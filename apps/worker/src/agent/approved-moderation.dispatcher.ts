import { createHash } from 'node:crypto';

import {
  and,
  artifacts,
  assets,
  eq,
  inArray,
  modelPocRuns,
  models,
  moderationRuntimeStates,
  providerChannels,
  providerCredentialVersions,
  type Database,
} from '@ecom-forge/db';
import {
  FakeProviderAdapter,
  MODEL_CONFIGURATION_MODERATION_PROBE_SUITE_VERSION,
  modelSnapshotSchema,
  VERCEL_AI_AGENT_ADAPTER_KEY,
  VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
  VercelAiModerationAdapter,
  type ModerationImageSource,
  type ModerationImageResolver,
  type ModerationOutcome,
  type ProviderAdapter,
  type ProviderCallContext,
} from '@ecom-forge/provider';
import { SecretEnvelope } from '@ecom-forge/shared/secret-envelope';
import { LocalPrivateStorage } from '@ecom-forge/storage';
import type { Redis } from 'ioredis';
import sharp from 'sharp';

import type { WorkerConfig } from '../config/worker-config.js';
import type { WorkerWriteFence } from '../lifecycle/processing-fence.js';
import { ProviderCircuitRepository } from '../provider/provider-circuit.repository.js';
import { RedisProviderQuotaGate } from '../provider/redis-provider-quota.gate.js';
import type {
  ModerationDispatchInput,
  ModerationDispatcher,
} from './content-safety-preflight.service.js';

export interface PostModerationDispatchInput {
  artifactId: string;
  userId: string;
  traceId: string;
  inputDigest: string;
  operationKey: string;
  modelSnapshotId: string;
  credentialVersionId: string;
  runtimeRevision: number;
  policyVersion: string;
  markPotentiallyDispatched(): Promise<boolean>;
}

export type PostModerationDispatcher = (
  input: PostModerationDispatchInput,
) => Promise<ModerationOutcome | { decision: 'not_dispatched' }>;

export class ApprovedModerationDispatcher {
  private readonly circuits: ProviderCircuitRepository;
  private readonly quota: RedisProviderQuotaGate;
  private readonly storage: LocalPrivateStorage;

  constructor(
    private readonly database: Database,
    redis: Redis,
    private readonly config: WorkerConfig,
    writeFence: WorkerWriteFence,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.circuits = new ProviderCircuitRepository(
      database,
      () => new Date(),
      () => writeFence.assertWritesAllowed(),
    );
    this.quota = new RedisProviderQuotaGate(redis, config.redisPrefix);
    this.storage = new LocalPrivateStorage(config.localUploadRoot);
  }

  readonly dispatch: ModerationDispatcher = async (input) => {
    let binding: Awaited<ReturnType<ApprovedModerationDispatcher['resolveBinding']>>;
    try {
      binding = await this.resolveBinding(input.check, (objectId, signal) =>
        this.resolveImage(input, objectId, signal),
      );
    } catch {
      return { decision: 'not_dispatched' };
    }

    let circuitPermit: Awaited<ReturnType<ProviderCircuitRepository['assertCanSubmit']>>;
    let quotaPermit: Awaited<ReturnType<RedisProviderQuotaGate['reserve']>>;
    const deadlineAt = new Date(Date.now() + this.config.providerRequestTimeoutMs);
    try {
      circuitPermit = await this.circuits.assertCanSubmit(binding.model);
      quotaPermit = await this.quota.reserve(binding.model, { deadlineAt });
    } catch {
      return { decision: 'not_dispatched' };
    }

    try {
      if (!(await input.markPotentiallyDispatched())) return { decision: 'not_dispatched' };
      const controller = new AbortController();
      const context: ProviderCallContext = {
        idempotencyKey: input.check.operationKey,
        requestDigest: input.check.inputDigest,
        traceId: input.claimed.traceId,
        deadlineAt,
        signal: controller.signal,
      };
      const transport = Promise.resolve().then(() =>
        input.check.capability === 'moderation.text'
          ? binding.adapter.moderateText!(input.providerInput, binding.model, context)
          : binding.adapter.moderateImage!(input.providerInput, binding.model, context),
      );
      const outcome = await settleByDeadline(transport, controller, deadlineAt);
      try {
        await this.circuits.recordModerationOutcome(binding.model, outcome, circuitPermit);
      } catch {
        return unknown('provider_internal_error');
      }
      return outcome;
    } catch {
      return unknown('provider_internal_error');
    } finally {
      await this.quota.release(binding.model, quotaPermit).catch(() => undefined);
    }
  };

  readonly dispatchPost: PostModerationDispatcher = async (input) => {
    const check = {
      capability: 'moderation.image' as const,
      modelSnapshotId: input.modelSnapshotId,
      credentialVersionId: input.credentialVersionId,
      runtimeRevision: input.runtimeRevision,
    };
    let binding: Awaited<ReturnType<ApprovedModerationDispatcher['resolveBinding']>>;
    try {
      binding = await this.resolveBinding(check, (objectId, signal) =>
        this.resolvePostImage(input.userId, input.artifactId, input.inputDigest, objectId, signal),
      );
    } catch {
      return { decision: 'not_dispatched' };
    }
    let circuitPermit: Awaited<ReturnType<ProviderCircuitRepository['assertCanSubmit']>>;
    let quotaPermit: Awaited<ReturnType<RedisProviderQuotaGate['reserve']>>;
    const deadlineAt = new Date(Date.now() + this.config.providerRequestTimeoutMs);
    try {
      circuitPermit = await this.circuits.assertCanSubmit(binding.model);
      quotaPermit = await this.quota.reserve(binding.model, { deadlineAt });
    } catch {
      return { decision: 'not_dispatched' };
    }
    try {
      if (!(await input.markPotentiallyDispatched())) return { decision: 'not_dispatched' };
      const controller = new AbortController();
      const outcome = await settleByDeadline(
        binding.adapter.moderateImage!({ asset_id: input.artifactId }, binding.model, {
          idempotencyKey: input.operationKey,
          requestDigest: input.inputDigest,
          traceId: input.traceId,
          deadlineAt,
          signal: controller.signal,
        }),
        controller,
        deadlineAt,
      );
      try {
        await this.circuits.recordModerationOutcome(binding.model, outcome, circuitPermit);
      } catch {
        return unknown('provider_internal_error');
      }
      return outcome;
    } catch {
      return unknown('provider_internal_error');
    } finally {
      await this.quota.release(binding.model, quotaPermit).catch(() => undefined);
    }
  };

  private async resolveBinding(
    check: Pick<
      ModerationDispatchInput['check'],
      'capability' | 'modelSnapshotId' | 'credentialVersionId' | 'runtimeRevision'
    >,
    imageResolver: ModerationImageResolver,
  ) {
    const [runtime, modelRow, credential] = await Promise.all([
      this.database.query.moderationRuntimeStates.findFirst({
        where: eq(moderationRuntimeStates.capability, check.capability),
      }),
      this.database.query.models.findFirst({
        where: eq(models.id, check.modelSnapshotId),
      }),
      this.database.query.providerCredentialVersions.findFirst({
        where: eq(providerCredentialVersions.id, check.credentialVersionId),
      }),
    ]);
    const channel = modelRow?.providerChannelId
      ? await this.database.query.providerChannels.findFirst({
          where: eq(providerChannels.id, modelRow.providerChannelId),
        })
      : undefined;
    const poc = modelRow?.statusEvidenceDigest
      ? await this.database.query.modelPocRuns.findFirst({
          where: and(
            eq(modelPocRuns.modelSnapshotId, modelRow.id),
            eq(modelPocRuns.providerChannelId, channel?.id ?? ''),
            eq(modelPocRuns.credentialVersionId, credential?.id ?? ''),
            inArray(modelPocRuns.probeSuiteVersion, [
              'moderation-poc@1',
              MODEL_CONFIGURATION_MODERATION_PROBE_SUITE_VERSION,
            ]),
            eq(modelPocRuns.status, 'passed'),
            eq(modelPocRuns.evidenceDigest, modelRow.statusEvidenceDigest),
          ),
        })
      : undefined;
    const model = modelSnapshotSchema.safeParse(
      modelRow
        ? {
            id: modelRow.id,
            provider: modelRow.provider,
            model_id: modelRow.modelId,
            version: modelRow.version,
            status: modelRow.status,
            capability_contract: modelRow.capabilityContractJson,
            pricing: modelRow.pricingJson,
            quota: modelRow.quotaJson,
          }
        : undefined,
    );
    if (
      !runtime ||
      runtime.activeModelSnapshotId !== check.modelSnapshotId ||
      runtime.runtimeRevision !== check.runtimeRevision ||
      !model.success ||
      model.data.status !== 'poc_passed' ||
      !model.data.capability_contract.capabilities.includes(check.capability) ||
      !channel ||
      channel.status !== 'active' ||
      channel.provider !== model.data.provider ||
      channel.activeCredentialVersionId !== credential?.id ||
      !credential ||
      credential.status !== 'active' ||
      credential.providerChannelId !== channel.id ||
      !credential.validationEvidenceDigest ||
      !poc ||
      !Array.isArray(poc.requestedSpecKeysJson) ||
      !poc.requestedSpecKeysJson.includes(check.capability)
    ) {
      throw new Error('CONTENT_SAFETY_RUNTIME_BINDING_INVALID');
    }

    let adapter: ProviderAdapter;
    if (
      model.data.provider === 'fake' &&
      (this.config.appEnv === 'local' || this.config.appEnv === 'test')
    ) {
      if (channel.adapterKey !== 'fake-provider-v1' || channel.endpointProfileKey !== 'local') {
        throw new Error('CONTENT_SAFETY_RUNTIME_BINDING_INVALID');
      }
      adapter = new FakeProviderAdapter('succeeded', () => new Date(), undefined, {
        modelId: model.data.model_id,
        version: model.data.version,
        moderationPolicyVersion: 'content-safety@1',
      });
    } else {
      if (
        modelRow?.protocolFamily !== 'openai' ||
        modelRow.apiVariant !== 'openai_responses' ||
        channel.adapterKey !== VERCEL_AI_AGENT_ADAPTER_KEY ||
        channel.endpointProfileKey !== VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY ||
        !this.config.providerCredentialEncryptionKeys
      ) {
        throw new Error('CONTENT_SAFETY_RUNTIME_BINDING_INVALID');
      }
      const apiKey = new SecretEnvelope(this.config.providerCredentialEncryptionKeys).decrypt({
        keyId: credential.secretKeyId,
        ciphertext: credential.secretCiphertext,
        nonce: credential.secretNonce,
        authTag: credential.secretAuthTag,
      });
      adapter = new VercelAiModerationAdapter(
        model.data.model_id,
        model.data.version,
        apiKey,
        channel.baseUrl,
        this.config.appEnv === 'local' || this.config.appEnv === 'test'
          ? [...new Set([...this.config.providerRelayOrigins, new URL(channel.baseUrl).origin])]
          : this.config.providerRelayOrigins,
        imageResolver,
        this.fetchImpl,
      );
    }
    return { model: model.data, adapter };
  }

  private async resolvePostImage(
    userId: string,
    artifactId: string,
    expectedHash: string,
    objectId: string,
    signal: AbortSignal,
  ): Promise<ModerationImageSource> {
    if (signal.aborted || objectId !== artifactId) {
      throw new Error('CONTENT_SAFETY_IMAGE_BINDING_INVALID');
    }
    const row = await this.database.query.artifacts.findFirst({
      where: eq(artifacts.id, artifactId),
    });
    if (
      !row ||
      row.userId !== userId ||
      row.visibility !== 'quarantined' ||
      !row.contentHash ||
      row.contentHash !== expectedHash
    ) {
      throw new Error('CONTENT_SAFETY_IMAGE_BINDING_INVALID');
    }
    await this.storage.initialize();
    const bytes = await this.storage.read(row.storageKey);
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
      throw new Error('CONTENT_SAFETY_IMAGE_HASH_DRIFT');
    }
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
    const mediaType =
      metadata.format === 'png'
        ? 'image/png'
        : metadata.format === 'jpeg'
          ? 'image/jpeg'
          : metadata.format === 'webp'
            ? 'image/webp'
            : undefined;
    if (!mediaType) throw new Error('CONTENT_SAFETY_IMAGE_FORMAT_INVALID');
    return { bytes, mediaType };
  }

  private async resolveImage(
    input: ModerationDispatchInput,
    objectId: string,
    signal: AbortSignal,
  ): Promise<ModerationImageSource> {
    if (signal.aborted) throw new Error('CONTENT_SAFETY_IMAGE_READ_ABORTED');
    const binding = [
      ...input.claimed.attachments,
      ...(input.claimed.sessionImageCandidates ?? []),
    ].find((item) => item.object_id === objectId);
    if (!binding) {
      throw new Error('CONTENT_SAFETY_IMAGE_BINDING_INVALID');
    }
    let storageKey: string;
    if (binding.kind === 'asset') {
      const row = await this.database.query.assets.findFirst({ where: eq(assets.id, objectId) });
      if (
        !row ||
        row.userId !== input.claimed.userId ||
        row.status !== 'ready' ||
        row.contentHash !== binding.content_hash
      ) {
        throw new Error('CONTENT_SAFETY_IMAGE_BINDING_INVALID');
      }
      storageKey = row.storageKey;
    } else {
      const row = await this.database.query.artifacts.findFirst({
        where: eq(artifacts.id, objectId),
      });
      if (
        !row ||
        row.userId !== input.claimed.userId ||
        row.visibility === 'deleted' ||
        row.visibility === 'quarantined' ||
        row.contentHash !== binding.content_hash
      ) {
        throw new Error('CONTENT_SAFETY_IMAGE_BINDING_INVALID');
      }
      storageKey = row.publishedStorageKey ?? row.storageKey;
    }
    await this.storage.initialize();
    const bytes = await this.storage.read(storageKey);
    if (createHash('sha256').update(bytes).digest('hex') !== binding.content_hash) {
      throw new Error('CONTENT_SAFETY_IMAGE_HASH_DRIFT');
    }
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
    const mediaType =
      metadata.format === 'png'
        ? 'image/png'
        : metadata.format === 'jpeg'
          ? 'image/jpeg'
          : metadata.format === 'webp'
            ? 'image/webp'
            : undefined;
    if (!mediaType) throw new Error('CONTENT_SAFETY_IMAGE_FORMAT_INVALID');
    return { bytes, mediaType };
  }
}

async function settleByDeadline(
  transport: Promise<ModerationOutcome>,
  controller: AbortController,
  deadlineAt: Date,
): Promise<ModerationOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ModerationOutcome>((resolve) => {
    timer = setTimeout(
      () => {
        controller.abort(new Error('Moderation deadline exceeded'));
        resolve(unknown('provider_timeout'));
      },
      Math.max(0, deadlineAt.getTime() - Date.now()),
    );
  });
  try {
    return await Promise.race([transport.catch(() => unknown('provider_internal_error')), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function unknown(errorCode: 'provider_timeout' | 'provider_internal_error'): ModerationOutcome {
  return {
    decision: 'unknown',
    policy_version: 'content-safety@1',
    error_code: errorCode,
  };
}
