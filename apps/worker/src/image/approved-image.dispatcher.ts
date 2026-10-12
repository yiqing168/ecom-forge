import { createHash } from 'node:crypto';

import {
  and,
  artifacts,
  assets,
  eq,
  modelPocRuns,
  models,
  providerChannels,
  providerCredentialVersions,
  type Database,
} from '@ecom-forge/db';
import {
  buildOpenAiImageSpecBindings,
  imageProviderPromptMaxCharacters,
  imageSpecHasPocCoverage,
  mediaV2ModelSnapshotSchema,
  OpenAiImagesAdapter,
  VERCEL_AI_AGENT_ADAPTER_KEY,
  VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
  type ProviderCallContext,
  type ProviderImageExecutionOutcome,
  type MediaCapabilitySpec,
  type OpenAiReferenceImage,
} from '@ecom-forge/provider';
import { canonicalSha256 } from '@ecom-forge/shared';
import { SecretEnvelope } from '@ecom-forge/shared/secret-envelope';
import { LocalPrivateStorage } from '@ecom-forge/storage';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import type { WorkerConfig } from '../config/worker-config.js';
import type { WorkerWriteFence } from '../lifecycle/processing-fence.js';
import { ProviderCircuitRepository } from '../provider/provider-circuit.repository.js';
import {
  NOOP_PROVIDER_TELEMETRY,
  stableErrorCode,
  telemetryId,
  type ProviderTelemetryLogger,
} from '../provider/provider-telemetry.js';
import {
  ProviderQuotaUnavailableError,
  RedisProviderQuotaGate,
} from '../provider/redis-provider-quota.gate.js';
import { buildApprovedImagePrompt } from './approved-image-prompt.js';
import { imageTaskParamsSchema } from './image-output-ingest.service.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const routeSchema = z.strictObject({
  schema_version: z.literal(1),
  catalog_revision: z.int().positive(),
  catalog_release_id: z.uuid(),
  catalog_release_digest: sha256,
  image: z.strictObject({
    catalog_entry_id: z.uuid(),
    catalog_entry_revision: z.int().positive(),
    version_no: z.int().positive(),
    model_snapshot_id: z.uuid(),
    selected_spec_key: z.string().min(1).max(128),
    runtime: z.strictObject({
      provider_channel_id: z.uuid(),
      provider_channel_revision: z.int().positive(),
      adapter_key: z.string().min(1).max(128),
      endpoint_profile_key: z.string().min(1).max(128),
      region: z.string().nullable(),
      credential_version_id: z.uuid(),
    }),
    billing_sku: z.record(z.string(), z.unknown()),
  }),
  moderation: z.record(z.string(), z.unknown()),
});

export interface ImageDispatchInput {
  taskId: string;
  workflowRunId: string;
  userId: string;
  attemptId: string;
  traceId: string;
  paramsSnapshot: unknown;
  markPotentiallyDispatched(): Promise<boolean>;
}

export type ImageDispatcher = (input: ImageDispatchInput) => Promise<ProviderImageExecutionOutcome>;

export class ApprovedImageDispatcher {
  private readonly circuits: ProviderCircuitRepository;
  private readonly quota: RedisProviderQuotaGate;
  private readonly storage: LocalPrivateStorage;
  private readonly writeFence: WorkerWriteFence;

  constructor(
    private readonly database: Database,
    redis: Redis,
    private readonly config: WorkerConfig,
    writeFence: WorkerWriteFence,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly telemetry: ProviderTelemetryLogger = NOOP_PROVIDER_TELEMETRY,
  ) {
    this.writeFence = writeFence;
    this.circuits = new ProviderCircuitRepository(
      database,
      () => new Date(),
      () => writeFence.assertWritesAllowed(),
      telemetry,
    );
    this.quota = new RedisProviderQuotaGate(redis, config.redisPrefix, () => new Date(), telemetry);
    this.storage = new LocalPrivateStorage(config.localUploadRoot);
  }

  readonly dispatch: ImageDispatcher = async (input) => {
    const params = imageTaskParamsSchema.parse(input.paramsSnapshot);
    const route = routeSchema.parse(params.model_selection);
    let providerPrompt: string;
    try {
      providerPrompt = buildApprovedImagePrompt(params);
    } catch (error) {
      this.logPreparationFailure(input, 'prompt', error);
      return notDispatched('provider_unavailable', params.operation_key);
    }
    let binding: Awaited<ReturnType<ApprovedImageDispatcher['resolveBinding']>>;
    try {
      binding = await this.resolveBinding(input, params, route);
    } catch (error) {
      this.logPreparationFailure(input, 'binding', error);
      return notDispatched('provider_unavailable', params.operation_key);
    }
    if (providerPrompt.length > binding.maxPromptCharacters) {
      this.logPreparationFailure(
        input,
        'prompt',
        new Error('IMAGE_PROMPT_EXCEEDS_SELECTED_MODEL_LIMIT'),
      );
      return notDispatched('provider_unavailable', params.operation_key);
    }

    const requestDigest = canonicalSha256({
      operation_key: params.operation_key,
      model_snapshot_id: binding.model.id,
      spec_key: route.image.selected_spec_key,
      prompt_digest: canonicalSha256(providerPrompt),
      input_bindings: params.input_bindings,
    });
    let admission: Awaited<ReturnType<typeof admitImageProviderCall>>;
    try {
      admission = await admitImageProviderCall({
        quota: this.quota,
        circuits: this.circuits,
        model: binding.model,
        requestTimeoutMs: this.config.imageProviderRequestTimeoutMs,
        signal: this.writeFence.signal,
      });
    } catch (error) {
      this.logPreparationFailure(input, 'admission', error);
      return notDispatched(
        'provider_unavailable',
        params.operation_key,
        error instanceof ProviderQuotaUnavailableError &&
          error.code === 'PROVIDER_QUOTA_UNAVAILABLE',
      );
    }

    let releaseAfterTransport: Promise<unknown> | undefined;
    try {
      if (!(await input.markPotentiallyDispatched())) {
        await this.circuits
          .releaseProbe(binding.model, admission.circuitPermit)
          .catch((error: unknown) => this.logPreparationFailure(input, 'admission', error));
        return notDispatched('provider_unavailable', params.operation_key);
      }
      const controller = new AbortController();
      const context: ProviderCallContext = {
        idempotencyKey: params.operation_key,
        requestDigest,
        traceId: input.traceId,
        deadlineAt: admission.providerDeadlineAt,
        signal: controller.signal,
      };
      const transport = binding.adapter.execute(
        {
          capability: params.operation,
          input: {
            spec_key: route.image.selected_spec_key,
            prompt: providerPrompt,
            aspect_ratio: params.aspect_ratio,
            resolution_tier: params.resolution_tier,
            output_count: params.output_count,
            output_format: binding.outputFormat,
            reference_asset_ids: params.input_bindings
              .filter((item) => item.provider_input)
              .map((item) => item.object_id),
          },
        },
        binding.model,
        context,
      );
      const execution = await settleByDeadline(
        transport,
        controller,
        admission.providerDeadlineAt,
        context.requestDigest,
      );
      if (execution.timedOut) releaseAfterTransport = execution.transport;
      const outcome = execution.outcome;
      const normalized =
        outcome.kind === 'not_dispatched'
          ? unknownOutcome(context.requestDigest, 'provider_internal_error')
          : outcome;
      await this.circuits
        .recordImageOutcome(binding.model, normalized, admission.circuitPermit)
        .catch(() => {
          throw new Error('IMAGE_CIRCUIT_EVIDENCE_FAILED');
        });
      return normalized;
    } catch (error) {
      this.logPreparationFailure(input, 'transport', error);
      return unknownOutcome(requestDigest, 'provider_internal_error');
    } finally {
      if (releaseAfterTransport) {
        void releaseAfterTransport
          .then(() => this.quota.release(binding.model, admission.quotaPermit))
          .catch(() => undefined);
      } else {
        await this.quota.release(binding.model, admission.quotaPermit).catch(() => undefined);
      }
    }
  };

  private logPreparationFailure(
    input: ImageDispatchInput,
    stage: 'prompt' | 'binding' | 'admission' | 'transport',
    error: unknown,
  ): void {
    this.telemetry.error({
      event: 'image_provider_stage_failed',
      metric: 'image_provider_stage_failure_total',
      trace_id: input.traceId,
      task_id_hash: telemetryId(input.taskId),
      attempt_id: input.attemptId,
      stage,
      error_code: stableErrorCode(error),
    });
  }

  private async resolveBinding(
    input: ImageDispatchInput,
    params: z.infer<typeof imageTaskParamsSchema>,
    route: z.infer<typeof routeSchema>,
  ) {
    const [modelRow, credential] = await Promise.all([
      this.database.query.models.findFirst({
        where: eq(models.id, route.image.model_snapshot_id),
      }),
      this.database.query.providerCredentialVersions.findFirst({
        where: eq(providerCredentialVersions.id, route.image.runtime.credential_version_id),
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
            eq(modelPocRuns.probeSuiteVersion, 'model-poc@1'),
            eq(modelPocRuns.status, 'passed'),
            eq(modelPocRuns.evidenceDigest, modelRow.statusEvidenceDigest),
          ),
        })
      : undefined;
    const model = mediaV2ModelSnapshotSchema.safeParse(
      modelRow
        ? {
            id: modelRow.id,
            provider_channel_id: modelRow.providerChannelId,
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
    const frozenModel = params.model_snapshot as {
      id?: string;
      version?: string;
      status_evidence_digest?: string;
      capability_contract_digest?: string;
      pricing_digest?: string;
      quota_digest?: string;
    };
    if (
      !model.success ||
      model.data.capability_contract.media_kind !== 'image' ||
      model.data.status !== 'poc_passed' ||
      frozenModel.id !== model.data.id ||
      frozenModel.version !== model.data.version ||
      frozenModel.status_evidence_digest !== modelRow?.statusEvidenceDigest ||
      frozenModel.capability_contract_digest !== canonicalSha256(model.data.capability_contract) ||
      frozenModel.pricing_digest !== canonicalSha256(model.data.pricing) ||
      frozenModel.quota_digest !== canonicalSha256(model.data.quota) ||
      !channel ||
      channel.id !== route.image.runtime.provider_channel_id ||
      channel.revision !== route.image.runtime.provider_channel_revision ||
      channel.status !== 'active' ||
      channel.provider !== model.data.provider ||
      channel.adapterKey !== route.image.runtime.adapter_key ||
      channel.endpointProfileKey !== route.image.runtime.endpoint_profile_key ||
      channel.region !== route.image.runtime.region ||
      channel.activeCredentialVersionId !== route.image.runtime.credential_version_id ||
      !credential ||
      credential.providerChannelId !== channel.id ||
      credential.status !== 'active' ||
      !credential.validationEvidenceDigest ||
      !poc ||
      !imageSpecHasPocCoverage(
        model.data.capability_contract.specs,
        route.image.selected_spec_key,
        poc.requestedSpecKeysJson,
      ) ||
      modelRow?.protocolFamily !== 'openai' ||
      modelRow.apiVariant !== 'openai_images' ||
      model.data.provider !== 'openai' ||
      channel.adapterKey !== VERCEL_AI_AGENT_ADAPTER_KEY ||
      channel.endpointProfileKey !== VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY ||
      !this.config.providerCredentialEncryptionKeys
    ) {
      throw new Error('IMAGE_RUNTIME_BINDING_INVALID');
    }
    const specs = model.data.capability_contract.specs.filter(
      (spec): spec is Extract<MediaCapabilitySpec, { kind: 'image' }> =>
        spec.kind === 'image' && ['image.generate', 'image.edit'].includes(spec.operation),
    );
    const selectedSpec = specs.find(
      (spec) =>
        spec.spec_key === route.image.selected_spec_key && spec.operation === params.operation,
    );
    const outputFormat = selectedSpec?.output_formats[0];
    if (
      !selectedSpec ||
      !outputFormat ||
      selectedSpec.resolution_tier !== params.resolution_tier ||
      !selectedSpec.aspect_ratios.includes(params.aspect_ratio)
    )
      throw new Error('IMAGE_RUNTIME_SPEC_INVALID');
    const apiKey = new SecretEnvelope(this.config.providerCredentialEncryptionKeys).decrypt({
      keyId: credential.secretKeyId,
      ciphertext: credential.secretCiphertext,
      nonce: credential.secretNonce,
      authTag: credential.secretAuthTag,
    });
    const adapter = new OpenAiImagesAdapter(
      model.data.model_id,
      model.data.version,
      apiKey,
      channel.baseUrl,
      this.config.appEnv === 'local' || this.config.appEnv === 'test'
        ? [...new Set([...this.config.providerRelayOrigins, new URL(channel.baseUrl).origin])]
        : this.config.providerRelayOrigins,
      this.config.providerImageOutputOrigins,
      buildOpenAiImageSpecBindings(
        [{ ...selectedSpec, aspect_ratios: [params.aspect_ratio] }],
        this.config.storageMaxImagePixels,
      ),
      (objectId, signal) => this.resolveReference(input.userId, params, objectId, signal),
      this.fetchImpl,
      {
        maxOutputBytes: this.config.storageMaxImageBytes,
        maxReferenceBytes: this.config.storageMaxImageBytes,
        maxTotalReferenceBytes: this.config.storageMaxImageBytes * 16,
        maxPixels: this.config.storageMaxImagePixels,
      },
    );
    return {
      model: model.data,
      adapter,
      outputFormat,
      maxPromptCharacters: imageProviderPromptMaxCharacters(selectedSpec.max_prompt_characters),
    };
  }

  private async resolveReference(
    userId: string,
    params: z.infer<typeof imageTaskParamsSchema>,
    objectId: string,
    signal: AbortSignal,
  ): Promise<OpenAiReferenceImage> {
    if (signal.aborted) throw new Error('IMAGE_REFERENCE_READ_ABORTED');
    const binding = params.input_bindings.find(
      (item) => item.provider_input && item.object_id === objectId,
    );
    if (!binding) throw new Error('IMAGE_REFERENCE_BINDING_INVALID');
    let storageKey: string;
    let filename: string;
    if (binding.kind === 'asset') {
      const row = await this.database.query.assets.findFirst({ where: eq(assets.id, objectId) });
      if (
        !row ||
        row.userId !== userId ||
        row.status !== 'ready' ||
        row.contentHash !== binding.content_hash
      ) {
        throw new Error('IMAGE_REFERENCE_BINDING_INVALID');
      }
      storageKey = row.storageKey;
      filename = `asset-${row.id}`;
    } else {
      const row = await this.database.query.artifacts.findFirst({
        where: eq(artifacts.id, objectId),
      });
      if (
        !row ||
        row.userId !== userId ||
        !['private', 'shared', 'public'].includes(row.visibility) ||
        !row.publishedStorageKey ||
        row.publishedContentHash !== binding.content_hash
      ) {
        throw new Error('IMAGE_REFERENCE_BINDING_INVALID');
      }
      storageKey = row.publishedStorageKey;
      filename = `artifact-${row.id}`;
    }
    await this.storage.initialize();
    const bytes = await this.storage.read(storageKey);
    if (createHash('sha256').update(bytes).digest('hex') !== binding.content_hash) {
      throw new Error('IMAGE_REFERENCE_HASH_DRIFT');
    }
    const mediaType = mediaTypeFromBytes(bytes);
    return { bytes, mediaType, filename, contentHash: binding.content_hash };
  }
}

function mediaTypeFromBytes(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  ) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  throw new Error('IMAGE_REFERENCE_FORMAT_INVALID');
}

export async function settleByDeadline(
  transport: Promise<ProviderImageExecutionOutcome>,
  controller: AbortController,
  deadlineAt: Date,
  requestDigest: string,
): Promise<{
  outcome: ProviderImageExecutionOutcome;
  timedOut: boolean;
  transport: Promise<ProviderImageExecutionOutcome>;
}> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const settledTransport = transport.catch(() =>
    unknownOutcome(requestDigest, 'provider_internal_error'),
  );
  const timeout = new Promise<ProviderImageExecutionOutcome>((resolve) => {
    timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort(new Error('Image Provider deadline exceeded'));
        resolve(unknownOutcome(requestDigest, 'provider_timeout'));
      },
      Math.max(0, deadlineAt.getTime() - Date.now()),
    );
  });
  try {
    const outcome = await Promise.race([settledTransport, timeout]);
    return { outcome, timedOut, transport: settledTransport };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface ImageProviderAdmissionInput {
  quota: Pick<RedisProviderQuotaGate, 'reserve' | 'release'>;
  circuits: Pick<ProviderCircuitRepository, 'assertCanSubmit'>;
  model: Parameters<ProviderCircuitRepository['assertCanSubmit']>[0];
  requestTimeoutMs: number;
  signal: AbortSignal;
  now?: () => number;
  wait?: typeof waitForQuotaSlot;
}

/**
 * Wait for shared quota before claiming a half-open circuit probe. The Provider
 * request receives a fresh timeout budget after admission, not what remains of
 * the queue-wait budget.
 */
export async function admitImageProviderCall(input: ImageProviderAdmissionInput): Promise<{
  quotaPermit: Awaited<ReturnType<RedisProviderQuotaGate['reserve']>>;
  circuitPermit: Awaited<ReturnType<ProviderCircuitRepository['assertCanSubmit']>>;
  providerDeadlineAt: Date;
}> {
  const now = input.now ?? Date.now;
  const admissionDeadlineAt = new Date(now() + input.requestTimeoutMs);
  const quotaPermit = await reserveProviderQuotaWithBackoff({
    quota: input.quota,
    model: input.model,
    admissionDeadlineAt,
    providerTimeoutMs: input.requestTimeoutMs,
    signal: input.signal,
    now,
    ...(input.wait ? { wait: input.wait } : {}),
  });
  try {
    const circuitPermit = await input.circuits.assertCanSubmit(input.model);
    return {
      quotaPermit,
      circuitPermit,
      providerDeadlineAt: new Date(now() + input.requestTimeoutMs),
    };
  } catch (error) {
    await input.quota.release(input.model, quotaPermit).catch(() => undefined);
    throw error;
  }
}

async function reserveProviderQuotaWithBackoff(input: {
  quota: Pick<RedisProviderQuotaGate, 'reserve' | 'release'>;
  model: Parameters<RedisProviderQuotaGate['reserve']>[0];
  admissionDeadlineAt: Date;
  providerTimeoutMs: number;
  signal: AbortSignal;
  now: () => number;
  wait?: typeof waitForQuotaSlot;
}): Promise<Awaited<ReturnType<RedisProviderQuotaGate['reserve']>>> {
  let delayMs = 250;
  for (;;) {
    try {
      // The admission deadline bounds queue waiting. The quota lease must instead
      // cover a fresh Provider request window after this attempt acquires a slot.
      const permit = await input.quota.reserve(input.model, {
        deadlineAt: new Date(input.now() + input.providerTimeoutMs),
      });
      if (input.now() < input.admissionDeadlineAt.getTime()) return permit;
      await input.quota.release(input.model, permit).catch(() => undefined);
      throw new ProviderQuotaUnavailableError('PROVIDER_QUOTA_EXCEEDED');
    } catch (error) {
      if (
        !(error instanceof ProviderQuotaUnavailableError) ||
        error.code !== 'PROVIDER_QUOTA_EXCEEDED'
      ) {
        throw error;
      }
      const remainingMs = input.admissionDeadlineAt.getTime() - input.now();
      if (remainingMs <= 0) throw error;
      await (input.wait ?? waitForQuotaSlot)(Math.min(delayMs, remainingMs), input.signal);
      delayMs = Math.min(delayMs * 2, 5_000);
    }
  }
}

function abortRejection(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('WORKER_STOPPING');
}

function waitForQuotaSlot(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortRejection(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortRejection(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function notDispatched(
  errorCode: 'provider_unavailable',
  requestDigest: string,
  retryable = false,
): ProviderImageExecutionOutcome {
  return {
    kind: 'not_dispatched',
    error_code: errorCode,
    retryable,
    request_digest: requestDigest,
  };
}

function unknownOutcome(
  requestDigest: string,
  errorCode: 'provider_timeout' | 'provider_internal_error',
): ProviderImageExecutionOutcome {
  return {
    kind: 'outcome_unknown',
    error_code: errorCode,
    request_digest: isSha256(requestDigest) ? requestDigest : canonicalSha256(requestDigest),
    unknown_at: new Date(),
  };
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
