import { randomUUID } from 'node:crypto';

import {
  adminAuditLogs,
  and,
  billableSkus,
  desc,
  eq,
  inArray,
  max,
  modelCatalogEntries,
  modelConfigurations,
  modelPocRuns,
  models,
  moderationRuntimeStates,
  pricingCatalogReleases,
  pricingCatalogState,
  providerChannels,
  providerCredentialVersions,
  sql,
  storageChannels,
  storageCredentialVersions,
  storageRuntimeState,
  storageValidationRuns,
  type Database,
} from '@ecom-forge/db';
import {
  discoverRelayModels,
  ImagePocRunner,
  VERCEL_AI_AGENT_ADAPTER_KEY,
  VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
  type ImagePocInput,
  type ImagePocResult,
} from '@ecom-forge/provider';
import { canonicalSha256, scopedAdvisoryLockKey } from '@ecom-forge/shared';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import type { AppConfig } from '../../config/app-config.js';
import { API_RUNTIME_DEFAULTS } from '../../config/runtime-defaults.js';
import { HmacKeyring } from '../auth/security/hmac-keyring.js';
import { SecretEnvelope } from './admin-crypto.js';
import { adminAuthError } from './admin-errors.js';
import type { AdminRequest, AdminSessionContext } from './admin-http.js';
import { AdminIdempotencyRepository } from './admin-idempotency.repository.js';

type Purpose = 'brain' | 'image' | 'video';
type Protocol = 'openai' | 'anthropic' | 'google';
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Prices = Record<string, string>;
type ModelDiscovery = typeof discoverRelayModels;
type ImageProbe = (input: ImagePocInput) => Promise<ImagePocResult>;

interface BindingPlan {
  channelId: string;
  credentialId: string;
  modelId: string;
  modelVersion: string;
  imagePoc?: {
    runId: string;
    requestedSpecKeys: string[];
    evidenceDigest: string;
    summary: Record<string, string>;
  };
}

const purposeSchema = z.enum(['brain', 'image', 'video']);

const tokenPayload = z.strictObject({
  schema_version: z.literal(1),
  principal_id: z.uuid(),
  purpose: purposeSchema,
  protocol_family: z.enum(['openai', 'anthropic', 'google']),
  base_url: z.string().url(),
  api_key: z.string().min(8).max(16_384),
  model_ids: z.array(z.string().min(1).max(256)).min(1).max(500),
  expires_at: z.string().datetime(),
  nonce: z.uuid(),
});

const tokenEnvelope = z.strictObject({
  keyId: z.string(),
  ciphertext: z.string(),
  nonce: z.string(),
  authTag: z.string(),
});

const mediaQuota = {
  schema_version: 1,
  rpm: 60,
  concurrency: 4,
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
} as const;

const imageQuota = { ...mediaQuota, concurrency: 9 } as const;
function requestId(request: AdminRequest): string {
  const raw = request.headers['x-request-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : `admin-model-configuration:${randomUUID()}`;
}

function keyHint(keyring: HmacKeyring, secret: string): string {
  return `key-${keyring.digest(secret).digest.slice(0, 12)}`;
}

function uuidFromHmacDigest(digest: string): string {
  const bytes = Buffer.from(digest, 'base64url').subarray(0, 16);
  if (bytes.length !== 16) adminAuthError('ADMIN_WRITE_FAILED', 503);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function relayOrigins(config: AppConfig, baseUrl: string): readonly string[] {
  if (config.appEnv === 'local' || config.appEnv === 'test') {
    return [...new Set([...config.provider.relayOrigins, new URL(baseUrl).origin])];
  }
  return config.provider.relayOrigins;
}

function publicHost(baseUrl: string): string {
  return new URL(baseUrl).host;
}

function ensurePermissions(context: AdminSessionContext, permissions: readonly string[]): void {
  if (permissions.some((permission) => !context.permissions.includes(permission))) {
    adminAuthError('ADMIN_PERMISSION_DENIED', 403);
  }
}

@Injectable()
export class AdminModelConfigurationService {
  private readonly logger = new Logger(AdminModelConfigurationService.name);
  private readonly envelope: SecretEnvelope;
  private readonly credentialHint: HmacKeyring;
  private readonly idempotencyHash: HmacKeyring;
  private readonly idempotency: AdminIdempotencyRepository;
  private readonly runImagePoc: ImageProbe;

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly discoverModels: ModelDiscovery = discoverRelayModels,
    runImagePoc?: ImageProbe,
  ) {
    this.envelope = new SecretEnvelope(config.provider.credentialEncryptionKeys);
    this.credentialHint = new HmacKeyring(config.provider.credentialHintKeys);
    this.idempotencyHash = new HmacKeyring(config.admin.idempotencyHashKeys);
    this.idempotency = new AdminIdempotencyRepository(database, config.admin.idempotencyHashKeys);
    this.runImagePoc =
      runImagePoc ??
      ((input) =>
        new ImagePocRunner(
          relayOrigins(config, input.channel.baseUrl),
          config.provider.imageOutputOrigins,
          120_000,
          config.storage.maxImageBytes,
          config.storage.maxImagePixels,
        ).run(input));
  }

  async list() {
    const rows = await this.database
      .select()
      .from(modelConfigurations)
      .where(eq(modelConfigurations.status, 'active'))
      .orderBy(desc(modelConfigurations.updatedAt), desc(modelConfigurations.id));
    return { items: await Promise.all(rows.map((row) => this.response(row))) };
  }

  async get(id: string) {
    const row = await this.database.query.modelConfigurations.findFirst({
      where: and(eq(modelConfigurations.id, id), eq(modelConfigurations.status, 'active')),
    });
    if (!row) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    return this.response(row);
  }

  async probe(
    context: AdminSessionContext,
    input: {
      purpose: Purpose;
      protocol_family: Protocol;
      base_url: string;
      api_key?: string | undefined;
      configuration_id?: string | undefined;
    },
  ) {
    ensurePermissions(context, ['models.write', 'provider_keys.rotate']);
    if (input.purpose !== 'brain' && input.protocol_family !== 'openai') {
      adminAuthError('MODEL_PROTOCOL_PROVIDER_MISMATCH', 422);
    }
    const apiKey = await this.resolveProbeApiKey(input.api_key, input.configuration_id);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const result = await this.discoverModels({
      apiKey,
      baseUrl: input.base_url,
      allowedRelayOrigins: relayOrigins(this.config, input.base_url),
      protocolFamily: input.protocol_family,
      abortSignal: controller.signal,
    }).finally(() => clearTimeout(timer));
    const diagnostic = {
      event: 'admin_model_probe',
      purpose: input.purpose,
      protocol: input.protocol_family,
      endpoint_host: publicHost(input.base_url),
      result: result.status,
      code: result.status === 'passed' ? 'PROVIDER_MODEL_LIST_PASSED' : result.code,
      diagnostic: result.status === 'outcome_unknown' ? result.diagnostic : undefined,
      duration_ms: Date.now() - startedAt,
      model_count: result.status === 'passed' ? result.models.length : undefined,
    };
    if (result.status !== 'passed') {
      this.logger.warn(JSON.stringify(diagnostic));
      adminAuthError(result.code, result.status === 'failed' ? 401 : 502);
    }
    this.logger.log(JSON.stringify(diagnostic));
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const payload = tokenPayload.parse({
      schema_version: 1,
      principal_id: context.principalId,
      purpose: input.purpose,
      protocol_family: input.protocol_family,
      base_url: result.baseUrl,
      api_key: apiKey,
      model_ids: result.models.map((model) => model.id),
      expires_at: expiresAt.toISOString(),
      nonce: randomUUID(),
    });
    const encrypted = this.envelope.encrypt(JSON.stringify(payload));
    return {
      probe_token: Buffer.from(JSON.stringify(encrypted), 'utf8').toString('base64url'),
      expires_at: expiresAt.toISOString(),
      models: result.models,
    };
  }

  private async resolveProbeApiKey(apiKey?: string, configurationId?: string): Promise<string> {
    if (apiKey) return apiKey;
    if (!configurationId) adminAuthError('PROVIDER_CREDENTIAL_REJECTED', 400);

    const configuration = await this.database.query.modelConfigurations.findFirst({
      where: and(
        eq(modelConfigurations.id, configurationId),
        eq(modelConfigurations.status, 'active'),
      ),
    });
    if (!configuration) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    const credential = await this.database.query.providerCredentialVersions.findFirst({
      where: and(
        eq(providerCredentialVersions.id, configuration.credentialVersionId),
        eq(providerCredentialVersions.status, 'active'),
      ),
    });
    if (!credential) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);

    try {
      return this.envelope.decrypt({
        keyId: credential.secretKeyId,
        ciphertext: credential.secretCiphertext,
        nonce: credential.secretNonce,
        authTag: credential.secretAuthTag,
      });
    } catch {
      adminAuthError('PROVIDER_CREDENTIAL_REJECTED', 409);
    }
  }

  async create(
    context: AdminSessionContext,
    request: AdminRequest,
    input: { probe_token: string; selected_model_id: string; reason: string },
    idempotencyKey: string,
  ) {
    ensurePermissions(context, ['models.write', 'provider_keys.rotate']);
    const idempotencyRequest = {
      ...input,
      probe_token: canonicalSha256(input.probe_token),
    };
    const replay = await this.idempotency.replay({
      context,
      operation: 'model_configuration.create',
      idempotencyKey,
      request: idempotencyRequest,
    });
    if (replay) return replay;
    const verified = await this.verifyProbe(context, input.probe_token, input.selected_model_id);
    const plan = await this.prepareBindingPlan(
      verified,
      `create:${context.principalId}:${idempotencyKey}`,
    );
    return this.idempotency.execute({
      context,
      operation: 'model_configuration.create',
      idempotencyKey,
      request: idempotencyRequest,
      responseStatus: 201,
      write: async (transaction) => {
        const binding = await this.insertBinding(transaction, context, verified, plan);
        const [row] = await transaction
          .insert(modelConfigurations)
          .values({
            purpose: verified.purpose,
            modelSnapshotId: binding.modelId,
            providerChannelId: binding.channelId,
            credentialVersionId: binding.credentialId,
            createdByAdminId: context.principalId,
          })
          .returning();
        if (!row) adminAuthError('ADMIN_WRITE_FAILED', 503);
        if (verified.purpose === 'brain')
          await this.publishCatalog(transaction, context, input.reason);
        await this.audit(transaction, context, request, {
          action: 'model_configuration.created',
          targetId: row.id,
          reason: input.reason,
          idempotencyKey,
          after: { purpose: row.purpose, model_id: verified.selectedModelId },
        });
        return this.response(row, transaction);
      },
    });
  }

  async update(
    context: AdminSessionContext,
    request: AdminRequest,
    id: string,
    input: {
      probe_token: string;
      selected_model_id: string;
      expected_revision: number;
      reason: string;
    },
    idempotencyKey: string,
  ) {
    ensurePermissions(context, ['models.write', 'provider_keys.rotate']);
    const idempotencyRequest = {
      id,
      ...input,
      probe_token: canonicalSha256(input.probe_token),
    };
    const replay = await this.idempotency.replay({
      context,
      operation: 'model_configuration.update',
      idempotencyKey,
      request: idempotencyRequest,
    });
    if (replay) return replay;
    await this.assertCurrentRevision(id, input.expected_revision);
    const verified = await this.verifyProbe(context, input.probe_token, input.selected_model_id);
    const plan = await this.prepareBindingPlan(
      verified,
      `update:${context.principalId}:${id}:${idempotencyKey}`,
    );
    return this.idempotency.execute({
      context,
      operation: 'model_configuration.update',
      idempotencyKey,
      request: idempotencyRequest,
      responseStatus: 200,
      write: async (transaction) => {
        const [current] = await transaction
          .select()
          .from(modelConfigurations)
          .where(eq(modelConfigurations.id, id))
          .for('update');
        if (!current || current.status !== 'active')
          adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        if (current.revision !== input.expected_revision) {
          adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        }
        const binding = await this.insertBinding(transaction, context, verified, plan);
        await transaction
          .update(models)
          .set({ status: 'disabled', statusReason: input.reason, statusChangedAt: new Date() })
          .where(eq(models.id, current.modelSnapshotId));
        await transaction
          .update(providerCredentialVersions)
          .set({ status: 'revoked', revokedAt: new Date() })
          .where(eq(providerCredentialVersions.id, current.credentialVersionId));
        await transaction
          .update(providerChannels)
          .set({ status: 'disabled', activeCredentialVersionId: null, disabledAt: new Date() })
          .where(eq(providerChannels.id, current.providerChannelId));
        await this.disableModerationBinding(
          transaction,
          context,
          current.moderationModelSnapshotId,
        );
        const [updated] = await transaction
          .update(modelConfigurations)
          .set({
            purpose: verified.purpose,
            modelSnapshotId: binding.modelId,
            moderationModelSnapshotId: null,
            providerChannelId: binding.channelId,
            credentialVersionId: binding.credentialId,
            creditsJson: null,
            revision: current.revision + 1,
          })
          .where(
            and(
              eq(modelConfigurations.id, id),
              eq(modelConfigurations.revision, input.expected_revision),
            ),
          )
          .returning();
        if (!updated) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        await this.publishCatalog(transaction, context, input.reason);
        await this.audit(transaction, context, request, {
          action: 'model_configuration.updated',
          targetId: id,
          reason: input.reason,
          idempotencyKey,
          before: { purpose: current.purpose, model_snapshot_id: current.modelSnapshotId },
          after: { purpose: updated.purpose, model_snapshot_id: updated.modelSnapshotId },
        });
        return this.response(updated, transaction);
      },
    });
  }

  private async assertCurrentRevision(id: string, expectedRevision: number): Promise<void> {
    const current = await this.database.query.modelConfigurations.findFirst({
      columns: { revision: true, status: true },
      where: eq(modelConfigurations.id, id),
    });
    if (!current || current.status !== 'active') {
      adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    }
    if (current.revision !== expectedRevision) {
      adminAuthError('ADMIN_REVISION_CONFLICT', 409);
    }
  }

  async putCredits(
    context: AdminSessionContext,
    request: AdminRequest,
    id: string,
    input: { prices: Prices; expected_revision: number; reason: string },
    idempotencyKey: string,
  ) {
    ensurePermissions(context, ['pricing.write']);
    return this.idempotency.execute({
      context,
      operation: 'model_configuration.credits.put',
      idempotencyKey,
      request: { id, ...input },
      responseStatus: 200,
      write: async (transaction) => {
        const [current] = await transaction
          .select()
          .from(modelConfigurations)
          .where(eq(modelConfigurations.id, id))
          .for('update');
        if (!current || current.status !== 'active')
          adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        if (current.revision !== input.expected_revision) {
          adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        }
        const purpose = purposeSchema.parse(current.purpose);
        if (purpose === 'brain') adminAuthError('MODEL_CREDITS_NOT_SUPPORTED', 422);
        this.assertPrices(purpose, input.prices);
        const modelSnapshotId =
          purpose === 'image'
            ? await this.refreshImageDefinition(transaction, current, context, input.reason)
            : current.modelSnapshotId;
        const [updated] = await transaction
          .update(modelConfigurations)
          .set({ modelSnapshotId, creditsJson: input.prices, revision: current.revision + 1 })
          .where(
            and(
              eq(modelConfigurations.id, id),
              eq(modelConfigurations.revision, input.expected_revision),
            ),
          )
          .returning();
        if (!updated) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        if (current.purpose === 'image') {
          await this.replaceImageSkus(transaction, updated, input.prices);
          await this.ensureLocalRuntime(transaction, context);
          if (!(await this.moderationClosure(transaction))) {
            adminAuthError('CONTENT_SAFETY_UNAVAILABLE', 409);
          }
          await this.publishCatalog(transaction, context, input.reason);
        }
        await this.audit(transaction, context, request, {
          action: 'model_configuration.credits_updated',
          targetId: id,
          reason: input.reason,
          idempotencyKey,
          before: { prices: current.creditsJson, model_snapshot_id: current.modelSnapshotId },
          after: { prices: input.prices, model_snapshot_id: modelSnapshotId },
        });
        return this.response(updated, transaction);
      },
    });
  }

  async remove(
    context: AdminSessionContext,
    request: AdminRequest,
    id: string,
    input: { expected_revision: number; reason: string },
    idempotencyKey: string,
  ) {
    ensurePermissions(context, ['models.publish']);
    return this.idempotency.execute({
      context,
      operation: 'model_configuration.delete',
      idempotencyKey,
      request: { id, ...input },
      responseStatus: 200,
      write: async (transaction) => {
        const [current] = await transaction
          .select()
          .from(modelConfigurations)
          .where(eq(modelConfigurations.id, id))
          .for('update');
        if (!current || current.status !== 'active')
          adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        if (current.revision !== input.expected_revision) {
          adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        }
        await transaction
          .update(models)
          .set({ status: 'disabled', statusReason: input.reason, statusChangedAt: new Date() })
          .where(eq(models.id, current.modelSnapshotId));
        await transaction
          .update(providerCredentialVersions)
          .set({ status: 'revoked', revokedAt: new Date() })
          .where(eq(providerCredentialVersions.id, current.credentialVersionId));
        await transaction
          .update(providerChannels)
          .set({ status: 'disabled', activeCredentialVersionId: null, disabledAt: new Date() })
          .where(eq(providerChannels.id, current.providerChannelId));
        await this.disableModerationBinding(
          transaction,
          context,
          current.moderationModelSnapshotId,
        );
        const [updated] = await transaction
          .update(modelConfigurations)
          .set({
            status: 'deleted',
            creditsJson: null,
            deletedAt: new Date(),
            revision: current.revision + 1,
          })
          .where(
            and(
              eq(modelConfigurations.id, id),
              eq(modelConfigurations.revision, input.expected_revision),
            ),
          )
          .returning();
        if (!updated) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        await this.publishCatalog(transaction, context, input.reason);
        await this.audit(transaction, context, request, {
          action: 'model_configuration.deleted',
          targetId: id,
          reason: input.reason,
          idempotencyKey,
          before: { status: current.status },
          after: { status: updated.status },
        });
        return { id, status: 'deleted' };
      },
    });
  }

  private decodeProbe(context: AdminSessionContext, token: string) {
    try {
      const encrypted = tokenEnvelope.parse(
        JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown,
      );
      const payload = tokenPayload.parse(JSON.parse(this.envelope.decrypt(encrypted)) as unknown);
      if (
        payload.principal_id !== context.principalId ||
        Date.parse(payload.expires_at) <= Date.now()
      ) {
        throw new Error('expired');
      }
      return payload;
    } catch {
      adminAuthError('PROVIDER_MODEL_PROBE_TOKEN_INVALID', 409);
    }
  }

  private async verifyProbe(context: AdminSessionContext, token: string, selectedModelId: string) {
    const payload = this.decodeProbe(context, token);
    if (!payload.model_ids.includes(selectedModelId)) {
      adminAuthError('PROVIDER_MODEL_SELECTION_INVALID', 422);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const result = await this.discoverModels({
      apiKey: payload.api_key,
      baseUrl: payload.base_url,
      allowedRelayOrigins: relayOrigins(this.config, payload.base_url),
      protocolFamily: payload.protocol_family,
      abortSignal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (
      result.status !== 'passed' ||
      !result.models.some((model) => model.id === selectedModelId)
    ) {
      adminAuthError(
        result.status === 'passed' ? 'PROVIDER_MODEL_SELECTION_INVALID' : result.code,
        409,
      );
    }
    return {
      purpose: payload.purpose,
      protocolFamily: payload.protocol_family,
      baseUrl: result.baseUrl,
      apiKey: payload.api_key,
      selectedModelId,
    };
  }

  private async prepareBindingPlan(
    input: {
      purpose: Purpose;
      protocolFamily: Protocol;
      baseUrl: string;
      apiKey: string;
      selectedModelId: string;
    },
    operationKey: string,
  ): Promise<BindingPlan> {
    const plan: BindingPlan = {
      channelId: randomUUID(),
      credentialId: randomUUID(),
      modelId: randomUUID(),
      modelVersion: `cfg-${randomUUID()}`,
    };
    if (input.purpose !== 'image') return plan;

    const definition = this.modelDefinition('image');
    const requestedSpecKeys = (
      definition.capability as {
        specs: Array<{ spec_key: string; operation: string; resolution_tier: string }>;
      }
    ).specs
      .filter(
        (spec) =>
          spec.resolution_tier === '1k' &&
          (spec.operation === 'image.generate' || spec.operation === 'image.edit'),
      )
      .map((spec) => spec.spec_key);
    if (requestedSpecKeys.length !== 2) {
      adminAuthError('MODEL_IMAGE_PROBE_CONTRACT_INVALID', 500);
    }
    const runId = uuidFromHmacDigest(
      this.idempotencyHash.digest(`model-configuration.image-poc:${operationKey}`).digest,
    );
    let result: ImagePocResult;
    try {
      result = await this.runImagePoc({
        runId,
        traceId: randomUUID(),
        requestedSpecKeys,
        apiKey: input.apiKey,
        model: {
          id: plan.modelId,
          providerChannelId: plan.channelId,
          provider: 'openai',
          protocolFamily: 'openai',
          apiVariant: 'openai_images',
          modelId: input.selectedModelId,
          version: plan.modelVersion,
          status: 'free_test_only',
          capabilityContractJson: definition.capability,
          pricingJson: definition.pricing,
          quotaJson: definition.quota,
        },
        channel: {
          id: plan.channelId,
          revision: 1,
          provider: 'openai',
          adapterKey: VERCEL_AI_AGENT_ADAPTER_KEY,
          endpointProfileKey: VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
          baseUrl: input.baseUrl,
          region: null,
        },
        credentialVersionId: plan.credentialId,
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'admin_model_image_poc',
          purpose: input.purpose,
          endpoint_host: publicHost(input.baseUrl),
          result: 'runner_error',
          error_type: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      adminAuthError('MODEL_IMAGE_PROBE_UNAVAILABLE', 502);
    }
    if (result.status !== 'passed') {
      this.logger.warn(
        JSON.stringify({
          event: 'admin_model_image_poc',
          purpose: input.purpose,
          endpoint_host: publicHost(input.baseUrl),
          result: result.status,
          code: result.summary.code,
          provider_error_code: result.summary.provider_error_code,
          provider_diagnostic_code: result.summary.provider_diagnostic_code,
          provider_response_shape: result.summary.provider_response_shape,
          attempted_spec_key: result.summary.attempted_spec_key,
          completed_spec_count: result.summary.completed_spec_count ?? '0',
        }),
      );
      adminAuthError(
        result.summary.code ||
          (result.status === 'outcome_unknown'
            ? 'MODEL_IMAGE_PROBE_OUTCOME_UNKNOWN'
            : 'MODEL_IMAGE_PROBE_FAILED'),
        result.status === 'outcome_unknown' ? 502 : 422,
      );
    }
    this.logger.log(
      JSON.stringify({
        event: 'admin_model_image_poc',
        purpose: input.purpose,
        endpoint_host: publicHost(input.baseUrl),
        result: result.status,
        code: result.summary.code,
        completed_spec_count: result.summary.spec_count,
      }),
    );
    return {
      ...plan,
      imagePoc: {
        runId,
        requestedSpecKeys,
        evidenceDigest: result.evidenceDigest,
        summary: result.summary,
      },
    };
  }

  private async insertBinding(
    transaction: Transaction,
    context: AdminSessionContext,
    input: {
      purpose: Purpose;
      protocolFamily: Protocol;
      baseUrl: string;
      apiKey: string;
      selectedModelId: string;
    },
    plan: BindingPlan,
  ) {
    const now = new Date();
    const evidence = canonicalSha256({
      contract: 'model-configuration-probe@1',
      purpose: input.purpose,
      protocol: input.protocolFamily,
      base_url: input.baseUrl,
      model_id: input.selectedModelId,
      verified_at: now.toISOString(),
    });
    const [channel] = await transaction
      .insert(providerChannels)
      .values({
        id: plan.channelId,
        provider: input.protocolFamily,
        adapterKey: VERCEL_AI_AGENT_ADAPTER_KEY,
        displayName: `Model: ${input.selectedModelId}`,
        baseUrl: input.baseUrl,
        endpointProfileKey: VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
        status: 'active',
        createdByAdminId: context.principalId,
      })
      .returning();
    if (!channel) adminAuthError('ADMIN_WRITE_FAILED', 503);
    const encrypted = this.envelope.encrypt(input.apiKey);
    const [credential] = await transaction
      .insert(providerCredentialVersions)
      .values({
        id: plan.credentialId,
        providerChannelId: channel.id,
        versionNo: 1,
        secretCiphertext: encrypted.ciphertext,
        secretNonce: encrypted.nonce,
        secretAuthTag: encrypted.authTag,
        secretKeyId: encrypted.keyId,
        keyHint: keyHint(this.credentialHint, input.apiKey),
        status: 'active',
        validationEvidenceDigest: evidence,
        verifiedAt: now,
        activatedAt: now,
      })
      .returning();
    if (!credential) adminAuthError('ADMIN_WRITE_FAILED', 503);
    await transaction
      .update(providerChannels)
      .set({ activeCredentialVersionId: credential.id })
      .where(eq(providerChannels.id, channel.id));
    const definition = this.modelDefinition(input.purpose);
    if (input.purpose === 'image' && !plan.imagePoc) {
      adminAuthError('MODEL_IMAGE_PROBE_REQUIRED', 503);
    }
    const statusEvidence = plan.imagePoc?.evidenceDigest ?? evidence;
    const [model] = await transaction
      .insert(models)
      .values({
        id: plan.modelId,
        provider: input.protocolFamily,
        providerChannelId: channel.id,
        protocolFamily: input.purpose === 'video' ? null : input.protocolFamily,
        apiVariant:
          input.purpose === 'video'
            ? null
            : input.purpose === 'image'
              ? 'openai_images'
              : input.protocolFamily === 'anthropic'
                ? 'anthropic_messages'
                : input.protocolFamily === 'google'
                  ? 'google_generate_content'
                  : 'openai_chat_completions',
        modelId: input.selectedModelId,
        version: plan.modelVersion,
        capabilityContractJson: definition.capability,
        pricingJson: definition.pricing,
        quotaJson: definition.quota,
        status: input.purpose === 'video' ? 'free_test_only' : 'poc_passed',
        statusEvidenceDigest: statusEvidence,
        statusOperatorId: context.principalId,
        statusReason:
          input.purpose === 'image'
            ? 'Unified model configuration image probe passed'
            : 'Unified model configuration probe passed',
        statusChangedAt: now,
      })
      .returning();
    if (!model) adminAuthError('ADMIN_WRITE_FAILED', 503);
    if (input.purpose !== 'video') {
      const requestedSpecKeys =
        input.purpose === 'brain' ? ['brain'] : plan.imagePoc!.requestedSpecKeys;
      await transaction.insert(modelPocRuns).values({
        ...(plan.imagePoc ? { id: plan.imagePoc.runId } : {}),
        modelSnapshotId: model.id,
        providerChannelId: channel.id,
        credentialVersionId: credential.id,
        probeSuiteVersion: 'model-poc@1',
        requestedSpecKeysJson: requestedSpecKeys,
        requestedSpecKeysDigest: canonicalSha256({ spec_keys: [...requestedSpecKeys].sort() }),
        status: 'passed',
        evidenceDigest: statusEvidence,
        requestedByAdminId: context.principalId,
        ...(plan.imagePoc ? { resultSummaryJson: plan.imagePoc.summary } : {}),
        completedAt: now,
      });
    }
    return { channelId: channel.id, credentialId: credential.id, modelId: model.id };
  }

  private async disableModerationBinding(
    transaction: Transaction,
    context: AdminSessionContext,
    modelId: string | null,
  ): Promise<void> {
    if (!modelId) return;
    await this.lockModerationRuntime(transaction);
    const runtimes = await transaction
      .select()
      .from(moderationRuntimeStates)
      .where(eq(moderationRuntimeStates.activeModelSnapshotId, modelId))
      .for('update');
    for (const runtime of runtimes) {
      const updated = await transaction
        .update(moderationRuntimeStates)
        .set({
          activeModelSnapshotId: null,
          runtimeRevision: runtime.runtimeRevision + 1,
          updatedByAdminId: context.principalId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(moderationRuntimeStates.capability, runtime.capability),
            eq(moderationRuntimeStates.runtimeRevision, runtime.runtimeRevision),
          ),
        )
        .returning({ capability: moderationRuntimeStates.capability });
      if (updated.length !== 1) adminAuthError('ADMIN_WRITE_FAILED', 503);
    }
    const disabled = await transaction
      .update(models)
      .set({
        status: 'disabled',
        statusReason: 'Parent model configuration changed or was deleted',
        statusChangedAt: new Date(),
      })
      .where(eq(models.id, modelId))
      .returning({ id: models.id });
    if (disabled.length !== 1) adminAuthError('ADMIN_WRITE_FAILED', 503);
  }

  private async lockModerationRuntime(transaction: Transaction): Promise<void> {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('moderation-runtime', 'global')})`,
    );
  }

  private modelDefinition(purpose: Purpose) {
    if (purpose === 'brain') {
      return {
        capability: {
          schema_version: 1,
          contract_kind: 'agent_brain',
          capabilities: ['agent.brain'],
          input_modalities: ['text', 'image'],
          tool_protocol: 'native_function_calling',
          terminal_protocol: 'terminal_tools',
          supports_usage_tokens: true,
          max_context_tokens: API_RUNTIME_DEFAULTS.agentBrainContextWindowTokens,
          max_output_tokens: 8192,
          max_tool_calls_per_response: 4,
        },
        pricing: {
          schema_version: 1,
          contract_kind: 'agent_brain_tokens',
          currency: 'CNY',
          request_base_cost_cny: '0.00',
          input_per_million_tokens_cny: '0.00',
          cached_input_per_million_tokens_cny: '0.00',
          output_per_million_tokens_cny: '0.00',
        },
        quota: {
          schema_version: 1,
          contract_kind: 'agent_brain',
          rpm: 60,
          concurrency: 4,
          hourly_budget_cny: '100.00',
          daily_budget_cny: '1000.00',
          max_turn_llm_rounds: 6,
          max_turn_input_tokens: API_RUNTIME_DEFAULTS.agentBrainContextWindowTokens,
          max_turn_output_tokens: 8192,
          max_turn_estimated_cost_cny: '0.15',
          terminal_timeout_ms: 240000,
          circuit_sample_size: 20,
          circuit_failure_rate: '0.50',
          circuit_unknown_rate: '0.25',
          circuit_open_ms: 60000,
        },
      };
    }
    if (purpose === 'image') {
      const specs = (['1k', '2k', '4k'] as const).flatMap((resolution) => [
        {
          kind: 'image' as const,
          spec_key: `image-generate-${resolution}`,
          operation: 'image.generate' as const,
          mode: 'text-to-image',
          resolution_tier: resolution,
          aspect_ratios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
          max_outputs: 4,
          max_reference_images: 0,
          max_prompt_characters: 32_000,
          transparent_background: false,
          output_formats: ['png' as const],
        },
        {
          kind: 'image' as const,
          spec_key: `image-edit-${resolution}`,
          operation: 'image.edit' as const,
          mode: 'image-to-image',
          resolution_tier: resolution,
          aspect_ratios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
          max_outputs: 4,
          max_reference_images: 4,
          max_prompt_characters: 32_000,
          transparent_background: false,
          output_formats: ['png' as const],
        },
      ]);
      return {
        capability: {
          schema_version: 2,
          contract_kind: 'media',
          media_kind: 'image',
          capabilities: ['image.generate', 'image.edit'],
          specs,
        },
        pricing: {
          schema_version: 2,
          contract_kind: 'media_rate_card',
          currency: 'CNY',
          rate_cards: specs.map((spec) => ({
            rate_key: spec.spec_key,
            spec_key: spec.spec_key,
            billing_unit: 'image',
            unit_cost_cny: null,
          })),
          overhead_cny: { tool: null, storage: null, traffic: null, agent_brain: null },
          failure_rate: null,
          unknown_rate: null,
          refund_rate: null,
          risk_reserve_rate: null,
          gross_margin_target: null,
          credit_cny_anchor: null,
        },
        quota: imageQuota,
      };
    }
    const specs = (['720p', '1080p', '4k'] as const).map((resolution) => ({
      kind: 'video' as const,
      spec_key: `video-generate-${resolution}`,
      operation: 'video.generate' as const,
      mode: 'text-to-video',
      resolution_tier: resolution,
      aspect_ratios: ['16:9', '9:16'],
      fps: [24, 30],
      audio: false,
      duration: { mode: 'range' as const, min_seconds: 1, max_seconds: 30, step_seconds: 1 },
      max_outputs: 1,
      max_reference_images: 1,
    }));
    return {
      capability: {
        schema_version: 2,
        contract_kind: 'media',
        media_kind: 'video',
        capabilities: ['video.generate'],
        specs,
      },
      pricing: {
        schema_version: 2,
        contract_kind: 'media_rate_card',
        currency: 'CNY',
        rate_cards: specs.map((spec) => ({
          rate_key: spec.spec_key,
          spec_key: spec.spec_key,
          billing_unit: 'second',
          unit_cost_cny: null,
          min_units: 1,
          max_units: 30,
          step_units: 1,
        })),
        overhead_cny: { tool: null, storage: null, traffic: null, agent_brain: null },
        failure_rate: null,
        unknown_rate: null,
        refund_rate: null,
        risk_reserve_rate: null,
        gross_margin_target: null,
        credit_cny_anchor: null,
      },
      quota: mediaQuota,
    };
  }

  private assertPrices(purpose: Purpose, prices: Prices): void {
    const expected = purpose === 'image' ? ['1k', '2k', '4k'] : ['720p', '1080p', '4k'];
    if (
      Object.keys(prices).length !== expected.length ||
      expected.some((key) => !/^[1-9]\d*\.00$/.test(prices[key] ?? ''))
    ) {
      adminAuthError('MODEL_CREDITS_INVALID', 422);
    }
  }

  private async refreshImageDefinition(
    transaction: Transaction,
    configuration: typeof modelConfigurations.$inferSelect,
    context: AdminSessionContext,
    reason: string,
  ): Promise<string> {
    const model = await transaction.query.models.findFirst({
      where: eq(models.id, configuration.modelSnapshotId),
    });
    if (!model) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    const definition = this.modelDefinition('image');
    if (canonicalSha256(model.capabilityContractJson) === canonicalSha256(definition.capability)) {
      return model.id;
    }
    const baseline = (capability: unknown) =>
      z
        .object({ specs: z.array(z.record(z.string(), z.unknown())) })
        .parse(capability)
        .specs.filter((spec) => spec.resolution_tier === '1k')
        .sort((left, right) => String(left.spec_key).localeCompare(String(right.spec_key)));
    const baselineSpecs = baseline(definition.capability);
    const poc = await transaction.query.modelPocRuns.findFirst({
      where: and(
        eq(modelPocRuns.modelSnapshotId, model.id),
        eq(modelPocRuns.providerChannelId, configuration.providerChannelId),
        eq(modelPocRuns.credentialVersionId, configuration.credentialVersionId),
        eq(modelPocRuns.probeSuiteVersion, 'model-poc@1'),
        eq(modelPocRuns.status, 'passed'),
        eq(modelPocRuns.evidenceDigest, model.statusEvidenceDigest ?? ''),
      ),
    });
    const probedSpecKeys = z.array(z.string()).safeParse(poc?.requestedSpecKeysJson);
    if (
      model.status !== 'poc_passed' ||
      model.provider !== 'openai' ||
      model.providerChannelId !== configuration.providerChannelId ||
      model.protocolFamily !== 'openai' ||
      model.apiVariant !== 'openai_images' ||
      canonicalSha256(baseline(model.capabilityContractJson)) !== canonicalSha256(baselineSpecs) ||
      !poc ||
      !probedSpecKeys.success ||
      poc.requestedSpecKeysDigest !==
        canonicalSha256({ spec_keys: [...probedSpecKeys.data].sort() }) ||
      baselineSpecs.some((spec) => !probedSpecKeys.data.includes(String(spec.spec_key)))
    ) {
      adminAuthError('MODEL_IMAGE_PROBE_REQUIRED', 409);
    }
    // Reuse only unchanged 1K evidence; this does not claim a new high-tier probe.
    const [updatedModel] = await transaction
      .insert(models)
      .values({
        provider: model.provider,
        providerChannelId: model.providerChannelId,
        protocolFamily: model.protocolFamily,
        apiVariant: model.apiVariant,
        modelId: model.modelId,
        version: `cfg-${randomUUID()}`,
        capabilityContractJson: definition.capability,
        pricingJson: definition.pricing,
        quotaJson: model.quotaJson,
        status: model.status,
        statusEvidenceDigest: model.statusEvidenceDigest,
        statusOperatorId: context.principalId,
        statusReason: reason,
        statusChangedAt: new Date(),
      })
      .returning();
    if (!updatedModel) adminAuthError('ADMIN_WRITE_FAILED', 503);
    const specKeys = baselineSpecs.map((spec) => String(spec.spec_key));
    await transaction.insert(modelPocRuns).values({
      modelSnapshotId: updatedModel.id,
      providerChannelId: configuration.providerChannelId,
      credentialVersionId: configuration.credentialVersionId,
      probeSuiteVersion: 'model-poc@1',
      requestedSpecKeysJson: specKeys,
      requestedSpecKeysDigest: canonicalSha256({ spec_keys: [...specKeys].sort() }),
      status: 'passed',
      evidenceDigest: poc.evidenceDigest,
      requestedByAdminId: context.principalId,
      resultSummaryJson: {
        scope: 'unchanged-1k-baseline',
        source_model_snapshot_id: model.id,
        source_poc_run_id: poc.id,
      },
      completedAt: poc.completedAt,
    });
    return updatedModel.id;
  }

  private async replaceImageSkus(
    transaction: Transaction,
    configuration: typeof modelConfigurations.$inferSelect,
    prices: Prices,
  ) {
    const model = await transaction.query.models.findFirst({
      where: eq(models.id, configuration.modelSnapshotId),
    });
    if (!model) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    let entry = await transaction.query.modelCatalogEntries.findFirst({
      where: eq(modelCatalogEntries.modelSnapshotId, model.id),
    });
    if (!entry) {
      const publicSlug = `image-${configuration.id}`;
      const latestEntry = await transaction
        .select({ value: max(modelCatalogEntries.versionNo) })
        .from(modelCatalogEntries)
        .where(eq(modelCatalogEntries.publicSlug, publicSlug));
      [entry] = await transaction
        .insert(modelCatalogEntries)
        .values({
          modelSnapshotId: model.id,
          publicSlug,
          versionNo: Number(latestEntry[0]?.value ?? 0) + 1,
          category: 'image',
          displayName: model.modelId,
          description: '图片生成模型',
          publicCapabilitiesJson: {
            operations: ['image.generate', 'image.edit'],
            resolutions: ['1k', '2k', '4k'],
          },
          rolloutJson: { stage: this.config.appEnv, percentage: 100 },
          userSelectable: true,
          isDefault: false,
          status: 'approved',
          approvedAt: new Date(),
        })
        .returning();
    }
    if (!entry) adminAuthError('ADMIN_WRITE_FAILED', 503);
    await transaction
      .update(billableSkus)
      .set({ status: 'disabled', disabledAt: new Date() })
      .where(
        and(eq(billableSkus.modelCatalogEntryId, entry.id), eq(billableSkus.status, 'approved')),
      );
    const existing = await transaction
      .select({ value: max(billableSkus.versionNo) })
      .from(billableSkus)
      .where(sql`${billableSkus.logicalSkuKey} like ${`${configuration.id}-%`}`);
    const version = Number(existing[0]?.value ?? 0) + 1;
    const definitions = (['1k', '2k', '4k'] as const).flatMap((resolution) =>
      (['image.generate', 'image.edit'] as const).map((operation) => {
        const matcher = {
          schema_version: 1,
          kind: 'image',
          mode: operation === 'image.generate' ? 'text-to-image' : 'image-to-image',
          resolution,
          transparent_background: false,
          reference_tier: operation === 'image.generate' ? 'none' : 'standard',
        };
        return {
          logicalSkuKey: `${configuration.id}-${operation}-${resolution}`,
          versionNo: version,
          modelCatalogEntryId: entry.id,
          operation,
          matcherJson: matcher,
          matcherHash: canonicalSha256(matcher),
          unitKind: 'image',
          unitRuleJson: { min_quantity: 1, max_quantity: 4, step_quantity: 1 },
          providerRateCardKey: `${operation === 'image.generate' ? 'image-generate' : 'image-edit'}-${resolution}`,
          providerCostPerUnitCny: null,
          creditsPerUnit: prices[resolution]!,
          status: 'approved' as const,
          approvedAt: new Date(),
        };
      }),
    );
    await transaction.insert(billableSkus).values(definitions);
  }

  private async publishCatalog(
    transaction: Transaction,
    context: AdminSessionContext,
    reason: string,
  ) {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('pricing-catalog', 'global')})`,
    );
    const configurations = await transaction.query.modelConfigurations.findMany({
      where: eq(modelConfigurations.status, 'active'),
      orderBy: [modelConfigurations.createdAt],
    });
    const entries: Array<Record<string, unknown>> = [];
    const defaults: Record<string, string> = {};
    for (const configuration of configurations) {
      const purpose = purposeSchema.parse(configuration.purpose);
      if (purpose === 'video') continue;
      if (purpose === 'image' && !configuration.creditsJson) continue;
      const model = await transaction.query.models.findFirst({
        where: eq(models.id, configuration.modelSnapshotId),
      });
      if (!model || model.status !== 'poc_passed') continue;
      let entry = await transaction.query.modelCatalogEntries.findFirst({
        where: eq(modelCatalogEntries.modelSnapshotId, model.id),
      });
      if (!entry) {
        const publicSlug = `${purpose}-${configuration.id}`;
        const latestEntry = await transaction
          .select({ value: max(modelCatalogEntries.versionNo) })
          .from(modelCatalogEntries)
          .where(eq(modelCatalogEntries.publicSlug, publicSlug));
        [entry] = await transaction
          .insert(modelCatalogEntries)
          .values({
            modelSnapshotId: model.id,
            publicSlug,
            versionNo: Number(latestEntry[0]?.value ?? 0) + 1,
            category: purpose,
            displayName: model.modelId,
            description: purpose === 'brain' ? '多模态对话模型' : '图片生成模型',
            publicCapabilitiesJson:
              purpose === 'brain'
                ? { input: ['text', 'image'] }
                : { operations: ['image.generate', 'image.edit'], resolutions: ['1k', '2k', '4k'] },
            rolloutJson: { stage: this.config.appEnv, percentage: 100 },
            userSelectable: true,
            isDefault: false,
            status: 'approved',
            approvedAt: new Date(),
          })
          .returning();
      }
      if (!entry) adminAuthError('ADMIN_WRITE_FAILED', 503);
      if (!defaults[purpose]) defaults[purpose] = entry.id;
      entries.push({
        id: entry.id,
        model_snapshot_id: model.id,
        public_slug: entry.publicSlug,
        version_no: entry.versionNo,
        category: entry.category,
        display_name: entry.displayName,
        description: entry.description,
        public_capabilities: entry.publicCapabilitiesJson,
        rollout: entry.rolloutJson,
        user_selectable: entry.userSelectable,
        is_default: defaults[purpose] === entry.id,
        sort_order: entries.length,
        revision: entry.revision,
      });
    }
    const entryIds = entries.map((entry) => String(entry.id));
    const skuRows = entryIds.length
      ? await transaction.query.billableSkus.findMany({
          where: and(
            inArray(billableSkus.modelCatalogEntryId, entryIds),
            eq(billableSkus.status, 'approved'),
          ),
        })
      : [];
    const skus = skuRows.map((row) => ({
      id: row.id,
      logical_sku_key: row.logicalSkuKey,
      version_no: row.versionNo,
      model_catalog_entry_id: row.modelCatalogEntryId,
      operation: row.operation,
      matcher: row.matcherJson,
      matcher_hash: row.matcherHash,
      unit_kind: row.unitKind,
      unit_rule: row.unitRuleJson,
      credits_per_unit: row.creditsPerUnit,
      provider_rate_card_key: row.providerRateCardKey,
      provider_cost_per_unit_cny: row.providerCostPerUnitCny,
      revision: row.revision,
    }));
    const moderation = await this.moderationClosure(transaction);
    const manifest = moderation
      ? { schema_version: 2 as const, entries, skus, defaults, moderation }
      : { schema_version: 1 as const, entries, skus, defaults };
    const latest = await transaction
      .select({ value: max(pricingCatalogReleases.releaseNo) })
      .from(pricingCatalogReleases);
    const state = await transaction.query.pricingCatalogState.findFirst({
      where: eq(pricingCatalogState.id, 'global'),
    });
    const [release] = await transaction
      .insert(pricingCatalogReleases)
      .values({
        releaseNo: Number(latest[0]?.value ?? 0) + 1,
        status: 'published',
        baseReleaseId: state?.activeReleaseId ?? null,
        manifestJson: manifest,
        releaseDigest: canonicalSha256(manifest),
        reason,
        createdByAdminId: context.principalId,
        publishedAt: new Date(),
      })
      .returning();
    if (!release) adminAuthError('ADMIN_WRITE_FAILED', 503);
    await transaction
      .insert(pricingCatalogState)
      .values({
        id: 'global',
        activeReleaseId: release.id,
        catalogRevision: (state?.catalogRevision ?? 0) + 1,
      })
      .onConflictDoUpdate({
        target: pricingCatalogState.id,
        set: { activeReleaseId: release.id, catalogRevision: (state?.catalogRevision ?? 0) + 1 },
      });
  }

  private async ensureLocalRuntime(transaction: Transaction, context: AdminSessionContext) {
    if (this.config.appEnv !== 'local' && this.config.appEnv !== 'test') return;
    for (const capability of ['moderation.text', 'moderation.image'] as const) {
      const runtime = await transaction.query.moderationRuntimeStates.findFirst({
        where: eq(moderationRuntimeStates.capability, capability),
      });
      if (runtime?.activeModelSnapshotId) continue;
      const evidence = canonicalSha256({ capability, fixture: 'local-model-configuration' });
      const [channel] = await transaction
        .insert(providerChannels)
        .values({
          provider: 'fake',
          adapterKey: 'fake-provider-v1',
          displayName: `Local ${capability}`,
          baseUrl: `https://${capability.replace('.', '-')}-${randomUUID()}.invalid`,
          endpointProfileKey: 'local',
          status: 'active',
          createdByAdminId: context.principalId,
        })
        .returning();
      if (!channel) adminAuthError('ADMIN_WRITE_FAILED', 503);
      const [credential] = await transaction
        .insert(providerCredentialVersions)
        .values({
          providerChannelId: channel.id,
          versionNo: 1,
          secretCiphertext: 'local-fixture',
          secretNonce: 'local-fixture',
          secretAuthTag: 'local-fixture',
          secretKeyId: 'local-fixture',
          keyHint: 'local-fixture',
          status: 'active',
          validationEvidenceDigest: evidence,
          verifiedAt: new Date(),
          activatedAt: new Date(),
        })
        .returning();
      if (!credential) adminAuthError('ADMIN_WRITE_FAILED', 503);
      await transaction
        .update(providerChannels)
        .set({ activeCredentialVersionId: credential.id })
        .where(eq(providerChannels.id, channel.id));
      const [model] = await transaction
        .insert(models)
        .values({
          provider: 'fake',
          providerChannelId: channel.id,
          modelId: `local-${capability}-${randomUUID()}`,
          version: '1',
          capabilityContractJson: {
            schema_version: 1,
            capabilities: [capability],
            aspect_ratios: [],
            resolutions: [],
            max_outputs: 1,
            max_reference_images: capability === 'moderation.image' ? 1 : 0,
          },
          pricingJson: {
            schema_version: 1,
            currency: 'CNY',
            provider_unit_cost_cny: null,
            tool_cost_cny: null,
            storage_cost_cny: null,
            traffic_cost_cny: null,
            agent_brain_cost_cny: null,
            failure_rate: null,
            unknown_rate: null,
            refund_rate: null,
            risk_reserve_rate: null,
            gross_margin_target: null,
            credit_cny_anchor: null,
          },
          quotaJson: mediaQuota,
          status: 'poc_passed',
          statusEvidenceDigest: evidence,
        })
        .returning();
      if (!model) adminAuthError('ADMIN_WRITE_FAILED', 503);
      await transaction.insert(modelPocRuns).values({
        modelSnapshotId: model.id,
        providerChannelId: channel.id,
        credentialVersionId: credential.id,
        probeSuiteVersion: 'moderation-poc@1',
        requestedSpecKeysJson: [capability],
        requestedSpecKeysDigest: canonicalSha256({ spec_keys: [capability] }),
        status: 'passed',
        evidenceDigest: evidence,
        requestedByAdminId: context.principalId,
        completedAt: new Date(),
      });
      await transaction
        .insert(moderationRuntimeStates)
        .values({
          capability,
          activeModelSnapshotId: model.id,
          runtimeRevision: 1,
          updatedByAdminId: context.principalId,
        })
        .onConflictDoUpdate({
          target: moderationRuntimeStates.capability,
          set: {
            activeModelSnapshotId: model.id,
            runtimeRevision: (runtime?.runtimeRevision ?? 0) + 1,
            updatedByAdminId: context.principalId,
          },
        });
    }
    const storage = await transaction.query.storageRuntimeState.findFirst({
      where: eq(storageRuntimeState.purpose, 'private_assets'),
    });
    if (!storage?.activeChannelId) {
      const evidence = canonicalSha256({ fixture: 'local-model-configuration-storage' });
      const [channel] = await transaction
        .insert(storageChannels)
        .values({
          purpose: 'private_assets',
          adapterKey: 'local-private-v1',
          endpointProfileKey: 'local',
          bucket: `local-${randomUUID()}`,
          rootPrefix: 'local-model-configurations',
          status: 'active',
          createdByAdminId: context.principalId,
        })
        .returning();
      if (!channel) adminAuthError('ADMIN_WRITE_FAILED', 503);
      const [credential] = await transaction
        .insert(storageCredentialVersions)
        .values({
          storageChannelId: channel.id,
          versionNo: 1,
          secretBundleCiphertext: 'local-fixture',
          secretNonce: 'local-fixture',
          secretAuthTag: 'local-fixture',
          secretKeyId: 'local-fixture',
          keyHint: 'local-fixture',
          status: 'active',
          validationEvidenceDigest: evidence,
          verifiedAt: new Date(),
          activatedAt: new Date(),
        })
        .returning();
      if (!credential) adminAuthError('ADMIN_WRITE_FAILED', 503);
      await transaction
        .update(storageChannels)
        .set({ activeCredentialVersionId: credential.id })
        .where(eq(storageChannels.id, channel.id));
      await transaction.insert(storageValidationRuns).values({
        storageChannelId: channel.id,
        credentialVersionId: credential.id,
        probeContractVersion: 'local-private@1',
        status: 'passed',
        evidenceDigest: evidence,
        probePrefixDigest: canonicalSha256({ prefix: channel.rootPrefix }),
        requestedByAdminId: context.principalId,
        completedAt: new Date(),
      });
      await transaction
        .insert(storageRuntimeState)
        .values({ purpose: 'private_assets', activeChannelId: channel.id, runtimeRevision: 1 })
        .onConflictDoUpdate({
          target: storageRuntimeState.purpose,
          set: {
            activeChannelId: channel.id,
            runtimeRevision: (storage?.runtimeRevision ?? 0) + 1,
          },
        });
    }
  }

  private async moderationClosure(transaction: Transaction) {
    const text = await this.moderationRoute(transaction, 'moderation.text');
    const image = await this.moderationRoute(transaction, 'moderation.image');
    return text && image ? { schema_version: 1 as const, text, image } : undefined;
  }

  private async moderationRoute(
    transaction: Transaction,
    capability: 'moderation.text' | 'moderation.image',
  ) {
    const runtime = await transaction.query.moderationRuntimeStates.findFirst({
      where: eq(moderationRuntimeStates.capability, capability),
    });
    if (!runtime?.activeModelSnapshotId) return undefined;
    const model = await transaction.query.models.findFirst({
      where: eq(models.id, runtime.activeModelSnapshotId),
    });
    if (!model?.providerChannelId || !model.statusEvidenceDigest) return undefined;
    const channel = await transaction.query.providerChannels.findFirst({
      where: eq(providerChannels.id, model.providerChannelId),
    });
    if (!channel?.activeCredentialVersionId) return undefined;
    return {
      capability,
      runtime_revision: runtime.runtimeRevision,
      model_snapshot_id: model.id,
      credential_version_id: channel.activeCredentialVersionId,
      policy_version: 'content-safety@1',
      evidence_digest: model.statusEvidenceDigest,
      pricing_digest: canonicalSha256(model.pricingJson),
      risk_adjusted_cost_cny: null,
    };
  }

  private async response(
    row: typeof modelConfigurations.$inferSelect,
    database: Database | Transaction = this.database,
  ) {
    const [model, channel, credential] = await Promise.all([
      database.query.models.findFirst({ where: eq(models.id, row.modelSnapshotId) }),
      database.query.providerChannels.findFirst({
        where: eq(providerChannels.id, row.providerChannelId),
      }),
      database.query.providerCredentialVersions.findFirst({
        where: eq(providerCredentialVersions.id, row.credentialVersionId),
      }),
    ]);
    if (!model || !channel || !credential) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    return {
      id: row.id,
      purpose: row.purpose,
      protocol_family: model.protocolFamily ?? channel.provider,
      endpoint_host: publicHost(channel.baseUrl),
      base_url: channel.baseUrl,
      model_id: model.modelId,
      key_hint: credential.keyHint,
      prices: row.creditsJson,
      status: row.status,
      runtime_status:
        row.purpose === 'video'
          ? 'pending_s16'
          : model.status === 'poc_passed'
            ? 'available'
            : 'unavailable',
      revision: row.revision,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  private async audit(
    transaction: Transaction,
    context: AdminSessionContext,
    request: AdminRequest,
    input: {
      action: string;
      targetId: string;
      reason: string;
      idempotencyKey: string;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    },
  ) {
    await transaction.insert(adminAuditLogs).values({
      actorAdminId: context.principalId,
      actorType: 'admin_session',
      adminSessionId: context.id,
      permissionSnapshot: { permissions: context.permissions },
      action: input.action,
      targetType: 'model_configuration',
      targetId: input.targetId,
      beforeJson: input.before,
      afterJson: input.after,
      reason: input.reason,
      requestId: requestId(request),
      idempotencyKeyHash: this.idempotencyHash.digest(input.idempotencyKey).digest,
      sourceIpHash: context.sourceIpHash,
      userAgentHash: context.userAgentHash,
      mfaLevel: context.mfaLevel,
      stepUpAt: context.stepUpAt,
      result: 'succeeded',
    });
  }
}
