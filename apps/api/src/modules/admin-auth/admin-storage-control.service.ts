import { randomUUID } from 'node:crypto';

import {
  adminAuditLogs,
  and,
  desc,
  eq,
  ilike,
  lt,
  max,
  or,
  sql,
  storageChannels,
  storageCredentialVersions,
  storageRuntimeState,
  storageValidationRuns,
  type Database,
} from '@ecom-forge/db';
import { canonicalSha256, scopedAdvisoryLockKey } from '@ecom-forge/shared';
import {
  S10_PRIVATE_ASSET_SMOKE_CONTRACT_VERSION,
  STORAGE_CONTROL_PLANE_REGISTRY,
  type StorageAdapterProfile,
  type StorageControlCapability,
} from '@ecom-forge/storage';
import {
  createQueueIntentInTransaction,
  storageCredentialValidationJobId,
} from '@ecom-forge/queue';
import { Injectable } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import { SignedCursorCodec } from '../../shared/http/signed-cursor.js';
import { HmacKeyring } from '../auth/security/hmac-keyring.js';
import { SecretEnvelope } from './admin-crypto.js';
import { adminAuthError } from './admin-errors.js';
import type { AdminRequest, AdminSessionContext } from './admin-http.js';
import { AdminIdempotencyRepository } from './admin-idempotency.repository.js';
import {
  decodeAdminListCursor,
  encodeAdminListCursor,
  normalizedTextFilter,
} from './admin-list-cursor.js';
import { storageChannelInputSchema } from '@ecom-forge/storage';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function requestId(request: AdminRequest): string {
  const value = request.headers['x-request-id'];
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : `admin-storage:${randomUUID()}`;
}

function keyHint(keyring: HmacKeyring, secret: string): string {
  return `key-${keyring.digest(secret).digest.slice(0, 12)}`;
}

function hasS10SmokeEvidence(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'smoke_contract_version' in value &&
    (value as { smoke_contract_version?: unknown }).smoke_contract_version ===
      S10_PRIVATE_ASSET_SMOKE_CONTRACT_VERSION
  );
}

function publicAdapter(profile: StorageAdapterProfile): Record<string, unknown> {
  return {
    adapter_key: profile.adapterKey,
    display_name: profile.displayName,
    probe_contract_version: profile.probeContractVersion,
    endpoint_profiles: profile.endpointProfiles.map((endpoint) => ({
      key: endpoint.key,
      regions: endpoint.regions,
      capabilities: endpoint.capabilities,
    })),
  };
}

@Injectable()
export class AdminStorageControlService {
  private readonly idempotency: AdminIdempotencyRepository;
  private readonly envelope: SecretEnvelope;
  private readonly credentialHint: HmacKeyring;
  private readonly idempotencyHash: HmacKeyring;
  private readonly config: AppConfig;
  private readonly cursor: SignedCursorCodec;

  constructor(
    private readonly database: Database,
    config: AppConfig,
  ) {
    this.config = config;
    this.idempotency = new AdminIdempotencyRepository(database, config.admin.idempotencyHashKeys);
    this.envelope = new SecretEnvelope(config.storage.credentialEncryptionKeys);
    this.credentialHint = new HmacKeyring(config.storage.credentialHintKeys);
    this.idempotencyHash = new HmacKeyring(config.admin.idempotencyHashKeys);
    this.cursor = new SignedCursorCodec(config.resourceCursorSecret);
  }

  adapters(): { items: Record<string, unknown>[] } {
    return { items: STORAGE_CONTROL_PLANE_REGISTRY.list().map(publicAdapter) };
  }

  async listChannels(
    context: AdminSessionContext,
    input: {
      cursor?: string | undefined;
      limit: number;
      adapterKey?: string | undefined;
      bucket?: string | undefined;
      status?: 'draft' | 'active' | 'disabled' | undefined;
    },
  ): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    const filters = {
      adapter_key: normalizedTextFilter(input.adapterKey),
      bucket: normalizedTextFilter(input.bucket),
      status: input.status,
    };
    const position = decodeAdminListCursor({
      codec: this.cursor,
      context,
      cursor: input.cursor,
      endpoint: 'admin-storage-channels',
      filters,
    });
    const rows = await this.database
      .select()
      .from(storageChannels)
      .where(
        and(
          filters.adapter_key ? eq(storageChannels.adapterKey, filters.adapter_key) : undefined,
          filters.bucket ? ilike(storageChannels.bucket, `%${filters.bucket}%`) : undefined,
          filters.status ? eq(storageChannels.status, filters.status) : undefined,
          position
            ? or(
                lt(storageChannels.createdAt, position.createdAt),
                and(
                  eq(storageChannels.createdAt, position.createdAt),
                  lt(storageChannels.id, position.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(storageChannels.createdAt), desc(storageChannels.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        purpose: row.purpose,
        adapter_key: row.adapterKey,
        endpoint_profile_key: row.endpointProfileKey,
        region: row.region,
        bucket: row.bucket,
        root_prefix: row.rootPrefix,
        status: row.status,
        active_credential_version_id: row.activeCredentialVersionId,
        revision: row.revision,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      })),
      next_cursor:
        rows.length > input.limit && last
          ? encodeAdminListCursor({
              codec: this.cursor,
              context,
              endpoint: 'admin-storage-channels',
              filters,
              position: { createdAt: last.createdAt, id: last.id },
            })
          : null,
    };
  }

  async createChannel(
    context: AdminSessionContext,
    request: AdminRequest,
    rawInput: { channel: unknown; displayName?: string; reason: string },
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const input = storageChannelInputSchema.parse(rawInput.channel);
    STORAGE_CONTROL_PLANE_REGISTRY.resolve(input);
    const reason = rawInput.reason;
    if (!reason) adminAuthError('ADMIN_REASON_REQUIRED', 422);
    return this.idempotency.execute({
      context,
      operation: 'storage_channel.create',
      idempotencyKey,
      request: { channel: rawInput.channel, display_name: rawInput.displayName, reason },
      responseStatus: 201,
      write: async (transaction) => {
        const [row] = await transaction
          .insert(storageChannels)
          .values({
            purpose: input.purpose,
            adapterKey: input.adapter_key,
            endpointProfileKey: input.endpoint_profile_key,
            region: input.region ?? null,
            regionKey: input.region ?? '',
            bucket: input.bucket,
            rootPrefix: input.root_prefix,
            createdByAdminId: context.principalId,
          })
          .returning();
        if (!row) adminAuthError('ADMIN_WRITE_FAILED', 503);
        await this.audit(transaction, context, request, {
          action: 'storage_channel.created',
          targetType: 'storage_channel',
          targetId: row.id,
          reason,
          idempotencyKey,
          after: { adapter_key: row.adapterKey, bucket: row.bucket, root_prefix: row.rootPrefix },
        });
        return this.channelResponse(row);
      },
    });
  }

  async createCredential(
    context: AdminSessionContext,
    request: AdminRequest,
    channelId: string,
    input: {
      secret: string | Record<string, string>;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    const channel = await this.database.query.storageChannels.findFirst({
      where: eq(storageChannels.id, channelId),
    });
    if (!channel) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    const serializedSecret =
      typeof input.secret === 'string' ? input.secret : JSON.stringify(input.secret);
    return this.idempotency.execute({
      context,
      operation: 'storage_credential.create',
      idempotencyKey: input.idempotencyKey,
      request: { channel_id: channelId, reason: input.reason },
      responseStatus: 201,
      write: async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey(
            'storage-credential-version',
            channelId,
          )})`,
        );
        const [version] = await transaction
          .select({ value: max(storageCredentialVersions.versionNo) })
          .from(storageCredentialVersions)
          .where(eq(storageCredentialVersions.storageChannelId, channelId));
        const encrypted = this.envelope.encrypt(serializedSecret);
        const [row] = await transaction
          .insert(storageCredentialVersions)
          .values({
            storageChannelId: channelId,
            versionNo: Number(version?.value ?? 0) + 1,
            secretBundleCiphertext: encrypted.ciphertext,
            secretNonce: encrypted.nonce,
            secretAuthTag: encrypted.authTag,
            secretKeyId: encrypted.keyId,
            keyHint: keyHint(this.credentialHint, serializedSecret),
          })
          .returning();
        if (!row) adminAuthError('ADMIN_WRITE_FAILED', 503);
        await this.audit(transaction, context, request, {
          action: 'storage_credential.created',
          targetType: 'storage_credential',
          targetId: row.id,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          after: {
            storage_channel_id: channelId,
            version_no: row.versionNo,
            key_hint: row.keyHint,
          },
        });
        return {
          id: row.id,
          storage_channel_id: channelId,
          version_no: row.versionNo,
          key_hint: row.keyHint,
          status: row.status,
        };
      },
    });
  }

  async validateCredential(
    context: AdminSessionContext,
    request: AdminRequest,
    credentialId: string,
    input: { reason: string; idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    const credential = await this.database.query.storageCredentialVersions.findFirst({
      where: eq(storageCredentialVersions.id, credentialId),
    });
    if (!credential) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    if (credential.status === 'revoked') adminAuthError('ADMIN_CREDENTIAL_INVALID', 409);
    const channel = await this.database.query.storageChannels.findFirst({
      where: eq(storageChannels.id, credential.storageChannelId),
    });
    if (!channel) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    const resolved = STORAGE_CONTROL_PLANE_REGISTRY.resolve({
      purpose: channel.purpose,
      adapter_key: channel.adapterKey,
      endpoint_profile_key: channel.endpointProfileKey,
      region: channel.region,
      bucket: channel.bucket,
      root_prefix: channel.rootPrefix,
    });
    return this.idempotency.execute({
      context,
      operation: 'storage_credential.validate',
      idempotencyKey: input.idempotencyKey,
      request: { credential_id: credentialId, reason: input.reason },
      responseStatus: 202,
      write: async (transaction) => {
        const [lockedCredential] = await transaction
          .select()
          .from(storageCredentialVersions)
          .where(eq(storageCredentialVersions.id, credentialId))
          .for('update');
        if (!lockedCredential) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        if (
          lockedCredential.status !== 'pending_validation' &&
          lockedCredential.status !== 'invalid' &&
          lockedCredential.status !== 'validation_unknown' &&
          lockedCredential.status !== 'active'
        ) {
          adminAuthError('ADMIN_CREDENTIAL_INVALID', 409);
        }
        const activeRun = await transaction.query.storageValidationRuns.findFirst({
          where: and(
            eq(storageValidationRuns.credentialVersionId, lockedCredential.id),
            or(
              eq(storageValidationRuns.status, 'queued'),
              eq(storageValidationRuns.status, 'running'),
            ),
          ),
        });
        if (activeRun) adminAuthError('ADMIN_VALIDATION_ALREADY_RUNNING', 409);
        const [latest] = await transaction
          .select({ value: max(storageValidationRuns.attemptNo) })
          .from(storageValidationRuns)
          .where(eq(storageValidationRuns.credentialVersionId, lockedCredential.id));
        if (
          lockedCredential.status === 'invalid' ||
          lockedCredential.status === 'validation_unknown'
        ) {
          const [reset] = await transaction
            .update(storageCredentialVersions)
            .set({
              status: 'pending_validation',
              validationEvidenceDigest: null,
              revision: lockedCredential.revision + 1,
            })
            .where(
              and(
                eq(storageCredentialVersions.id, lockedCredential.id),
                eq(storageCredentialVersions.revision, lockedCredential.revision),
              ),
            )
            .returning({ id: storageCredentialVersions.id });
          if (!reset) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        }
        const runId = randomUUID();
        const probePrefixDigest = canonicalSha256({
          contract: resolved.adapter.probeContractVersion,
          storage_channel_id: channel.id,
          validation_run_id: runId,
        });
        const [run] = await transaction
          .insert(storageValidationRuns)
          .values({
            id: runId,
            storageChannelId: channel.id,
            credentialVersionId: lockedCredential.id,
            probeContractVersion: resolved.adapter.probeContractVersion,
            probePrefixDigest,
            attemptNo: Number(latest?.value ?? 0) + 1,
            requestedByAdminId: context.principalId,
          })
          .returning();
        if (!run) adminAuthError('ADMIN_WRITE_FAILED', 503);
        const intent = await createQueueIntentInTransaction(transaction, {
          queueName: 'evaluation',
          jobId: storageCredentialValidationJobId(run.id),
          aggregateType: 'storage_credential_validation',
          aggregateId: run.id,
          payloadVersion: 3,
          payload: {
            schema_version: 3,
            job_type: 'storage-credential.validate',
            trace_id: randomUUID(),
            storage_validation_run_id: run.id,
            storage_channel_id: channel.id,
            credential_version_id: lockedCredential.id,
            probe_contract_version: run.probeContractVersion,
            attempt_no: run.attemptNo,
          },
        });
        await transaction
          .update(storageValidationRuns)
          .set({ queueIntentId: intent.id })
          .where(eq(storageValidationRuns.id, run.id));
        await this.audit(transaction, context, request, {
          action: 'storage_credential.validation_requested',
          targetType: 'storage_credential',
          targetId: credential.id,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          after: { validation_run_id: run.id, status: run.status },
        });
        return {
          validation_run_id: run.id,
          status: run.status,
          queue_intent_id: intent.id,
        };
      },
    });
  }

  async validationRun(runId: string): Promise<Record<string, unknown>> {
    const run = await this.database.query.storageValidationRuns.findFirst({
      where: eq(storageValidationRuns.id, runId),
    });
    if (!run) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    return {
      id: run.id,
      storage_channel_id: run.storageChannelId,
      credential_version_id: run.credentialVersionId,
      probe_contract_version: run.probeContractVersion,
      status: run.status,
      attempt_no: run.attemptNo,
      evidence_digest: run.evidenceDigest,
      result_summary: run.resultSummaryJson,
      created_at: run.createdAt,
      started_at: run.startedAt,
      completed_at: run.completedAt,
    };
  }

  async getChannel(channelId: string): Promise<Record<string, unknown>> {
    const channel = await this.database.query.storageChannels.findFirst({
      where: eq(storageChannels.id, channelId),
    });
    if (!channel) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    const [credentials, validationRuns, runtime] = await Promise.all([
      this.database
        .select({
          id: storageCredentialVersions.id,
          versionNo: storageCredentialVersions.versionNo,
          keyHint: storageCredentialVersions.keyHint,
          status: storageCredentialVersions.status,
          revision: storageCredentialVersions.revision,
          verifiedAt: storageCredentialVersions.verifiedAt,
          activatedAt: storageCredentialVersions.activatedAt,
          revokedAt: storageCredentialVersions.revokedAt,
          createdAt: storageCredentialVersions.createdAt,
        })
        .from(storageCredentialVersions)
        .where(eq(storageCredentialVersions.storageChannelId, channelId))
        .orderBy(desc(storageCredentialVersions.versionNo)),
      this.database
        .select({
          id: storageValidationRuns.id,
          credentialVersionId: storageValidationRuns.credentialVersionId,
          probeContractVersion: storageValidationRuns.probeContractVersion,
          status: storageValidationRuns.status,
          attemptNo: storageValidationRuns.attemptNo,
          evidenceDigest: storageValidationRuns.evidenceDigest,
          resultSummary: storageValidationRuns.resultSummaryJson,
          createdAt: storageValidationRuns.createdAt,
          startedAt: storageValidationRuns.startedAt,
          completedAt: storageValidationRuns.completedAt,
        })
        .from(storageValidationRuns)
        .where(eq(storageValidationRuns.storageChannelId, channelId))
        .orderBy(desc(storageValidationRuns.createdAt), desc(storageValidationRuns.id))
        .limit(100),
      this.database.query.storageRuntimeState.findFirst({
        where: eq(storageRuntimeState.purpose, channel.purpose),
      }),
    ]);
    return {
      ...this.channelResponse(channel),
      runtime: {
        is_active: runtime?.activeChannelId === channel.id,
        runtime_revision: runtime?.runtimeRevision ?? 0,
      },
      credentials: credentials.map((credential) => ({
        id: credential.id,
        version_no: credential.versionNo,
        key_hint: credential.keyHint,
        status: credential.status,
        revision: credential.revision,
        verified_at: credential.verifiedAt,
        activated_at: credential.activatedAt,
        revoked_at: credential.revokedAt,
        created_at: credential.createdAt,
      })),
      validation_runs: validationRuns.map((run) => ({
        id: run.id,
        credential_version_id: run.credentialVersionId,
        probe_contract_version: run.probeContractVersion,
        status: run.status,
        attempt_no: run.attemptNo,
        evidence_digest: run.evidenceDigest,
        result_summary: run.resultSummary,
        created_at: run.createdAt,
        started_at: run.startedAt,
        completed_at: run.completedAt,
      })),
    };
  }

  async activateCredential(
    context: AdminSessionContext,
    request: AdminRequest,
    credentialId: string,
    input: {
      expectedCredentialRevision: number;
      expectedChannelRevision: number;
      validationRunId: string;
      evidenceDigest: string;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    if (!/^[a-f0-9]{64}$/.test(input.evidenceDigest)) {
      adminAuthError('ADMIN_EVIDENCE_INVALID', 422);
    }
    return this.idempotency.execute({
      context,
      operation: 'storage_credential.activate',
      idempotencyKey: input.idempotencyKey,
      request: { credential_id: credentialId, ...input },
      responseStatus: 200,
      write: async (transaction) => {
        const credentialLocator = await transaction.query.storageCredentialVersions.findFirst({
          columns: { storageChannelId: true },
          where: eq(storageCredentialVersions.id, credentialId),
        });
        if (!credentialLocator) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        await this.lockRuntime(transaction);
        const [channel] = await transaction
          .select()
          .from(storageChannels)
          .where(eq(storageChannels.id, credentialLocator.storageChannelId))
          .for('update');
        const [credential] = await transaction
          .select()
          .from(storageCredentialVersions)
          .where(eq(storageCredentialVersions.id, credentialId))
          .for('update');
        if (!credential) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        const [run] = await transaction
          .select()
          .from(storageValidationRuns)
          .where(eq(storageValidationRuns.id, input.validationRunId))
          .for('update');
        if (!channel || !run || credential.storageChannelId !== channel.id) {
          adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        }
        if (
          channel.status === 'disabled' ||
          channel.revision !== input.expectedChannelRevision ||
          credential.revision !== input.expectedCredentialRevision ||
          credential.status !== 'valid' ||
          credential.storageChannelId !== channel.id ||
          run.storageChannelId !== channel.id ||
          run.credentialVersionId !== credential.id ||
          run.status !== 'passed' ||
          !hasS10SmokeEvidence(run.resultSummaryJson) ||
          run.evidenceDigest !== input.evidenceDigest ||
          credential.validationEvidenceDigest !== input.evidenceDigest
        ) {
          adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        }
        await transaction
          .update(storageCredentialVersions)
          .set({
            status: 'revoked',
            revision: sql`${storageCredentialVersions.revision} + 1`,
            revokedAt: new Date(),
          })
          .where(
            and(
              eq(storageCredentialVersions.storageChannelId, channel.id),
              eq(storageCredentialVersions.status, 'active'),
            ),
          );
        const [activated] = await transaction
          .update(storageCredentialVersions)
          .set({
            status: 'active',
            revision: credential.revision + 1,
            activatedAt: new Date(),
            revokedAt: null,
          })
          .where(
            and(
              eq(storageCredentialVersions.id, credential.id),
              eq(storageCredentialVersions.status, 'valid'),
              eq(storageCredentialVersions.revision, input.expectedCredentialRevision),
            ),
          )
          .returning();
        if (!activated) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        const [updatedChannel] = await transaction
          .update(storageChannels)
          .set({
            activeCredentialVersionId: activated.id,
            revision: channel.revision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(storageChannels.id, channel.id),
              eq(storageChannels.revision, input.expectedChannelRevision),
            ),
          )
          .returning();
        if (!updatedChannel) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        await this.audit(transaction, context, request, {
          action: 'storage_credential.activated',
          targetType: 'storage_credential',
          targetId: activated.id,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          after: {
            storage_channel_id: channel.id,
            status: activated.status,
            revision: activated.revision,
            channel_revision: updatedChannel.revision,
            evidence_digest: input.evidenceDigest,
          },
        });
        return {
          id: activated.id,
          storage_channel_id: channel.id,
          version_no: activated.versionNo,
          key_hint: activated.keyHint,
          status: activated.status,
          revision: activated.revision,
          channel_revision: updatedChannel.revision,
        };
      },
    });
  }

  async activateChannel(
    context: AdminSessionContext,
    request: AdminRequest,
    channelId: string,
    input: {
      expectedRuntimeRevision: number;
      expectedChannelRevision: number;
      validationRunId: string;
      evidenceDigest: string;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    if (!/^[a-f0-9]{64}$/.test(input.evidenceDigest)) {
      adminAuthError('ADMIN_EVIDENCE_INVALID', 422);
    }
    return this.idempotency.execute({
      context,
      operation: 'storage_channel.activate',
      idempotencyKey: input.idempotencyKey,
      request: { channel_id: channelId, ...input },
      responseStatus: 200,
      write: async (transaction) => {
        await this.lockRuntime(transaction);
        const [channel] = await transaction
          .select()
          .from(storageChannels)
          .where(eq(storageChannels.id, channelId))
          .for('update');
        if (!channel?.activeCredentialVersionId) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        const [credential] = await transaction
          .select()
          .from(storageCredentialVersions)
          .where(eq(storageCredentialVersions.id, channel.activeCredentialVersionId))
          .for('update');
        const [run] = await transaction
          .select()
          .from(storageValidationRuns)
          .where(eq(storageValidationRuns.id, input.validationRunId))
          .for('update');
        const [runtime] = await transaction
          .select()
          .from(storageRuntimeState)
          .where(eq(storageRuntimeState.purpose, channel.purpose))
          .for('update');
        const resolved = STORAGE_CONTROL_PLANE_REGISTRY.resolve({
          purpose: channel.purpose,
          adapter_key: channel.adapterKey,
          endpoint_profile_key: channel.endpointProfileKey,
          region: channel.region,
          bucket: channel.bucket,
          root_prefix: channel.rootPrefix,
        });
        const requiredCapabilities: StorageControlCapability[] = [
          'put',
          'head',
          'range_read',
          'delete',
          'sign_private',
        ];
        if (
          channel.status === 'disabled' ||
          channel.revision !== input.expectedChannelRevision ||
          !credential ||
          credential.status !== 'active' ||
          credential.storageChannelId !== channel.id ||
          !run ||
          run.storageChannelId !== channel.id ||
          run.credentialVersionId !== credential.id ||
          run.status !== 'passed' ||
          !hasS10SmokeEvidence(run.resultSummaryJson) ||
          run.evidenceDigest !== input.evidenceDigest ||
          credential.validationEvidenceDigest !== input.evidenceDigest ||
          requiredCapabilities.some(
            (capability) => !resolved.endpoint.capabilities.includes(capability),
          ) ||
          (channel.adapterKey === 'local-private-v1' &&
            this.config.appEnv !== 'local' &&
            this.config.appEnv !== 'test') ||
          (runtime
            ? runtime.runtimeRevision !== input.expectedRuntimeRevision
            : input.expectedRuntimeRevision !== 0)
        ) {
          adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        }
        const [updatedChannel] = await transaction
          .update(storageChannels)
          .set({
            status: 'active',
            revision: channel.revision + 1,
            disabledAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(storageChannels.id, channel.id),
              eq(storageChannels.revision, input.expectedChannelRevision),
            ),
          )
          .returning();
        if (!updatedChannel) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        const runtimeRevision = await this.switchRuntime(
          transaction,
          channel.purpose,
          channel.id,
          input.expectedRuntimeRevision,
          Boolean(runtime),
        );
        await this.audit(transaction, context, request, {
          action: 'storage_channel.activated',
          targetType: 'storage_channel',
          targetId: channel.id,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          after: {
            status: updatedChannel.status,
            revision: updatedChannel.revision,
            active_credential_version_id: credential.id,
            runtime_revision: runtimeRevision,
            evidence_digest: input.evidenceDigest,
          },
        });
        return {
          ...this.channelResponse(updatedChannel),
          runtime_revision: runtimeRevision,
          runtime_active: true,
        };
      },
    });
  }

  async revokeCredential(
    context: AdminSessionContext,
    request: AdminRequest,
    credentialId: string,
    input: {
      expectedCredentialRevision: number;
      expectedChannelRevision: number;
      expectedRuntimeRevision: number;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    return this.idempotency.execute({
      context,
      operation: 'storage_credential.revoke',
      idempotencyKey: input.idempotencyKey,
      request: { credential_id: credentialId, ...input },
      responseStatus: 200,
      write: async (transaction) => {
        const credentialLocator = await transaction.query.storageCredentialVersions.findFirst({
          columns: { storageChannelId: true },
          where: eq(storageCredentialVersions.id, credentialId),
        });
        if (!credentialLocator) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        await this.lockRuntime(transaction);
        const [channel] = await transaction
          .select()
          .from(storageChannels)
          .where(eq(storageChannels.id, credentialLocator.storageChannelId))
          .for('update');
        const [credential] = await transaction
          .select()
          .from(storageCredentialVersions)
          .where(eq(storageCredentialVersions.id, credentialId))
          .for('update');
        if (!credential) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        if (!channel || credential.storageChannelId !== channel.id) {
          adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        }
        const [runtime] = await transaction
          .select()
          .from(storageRuntimeState)
          .where(eq(storageRuntimeState.purpose, channel.purpose))
          .for('update');
        if (
          credential.status === 'revoked' ||
          credential.revision !== input.expectedCredentialRevision ||
          channel.revision !== input.expectedChannelRevision ||
          (runtime
            ? runtime.runtimeRevision !== input.expectedRuntimeRevision
            : input.expectedRuntimeRevision !== 0)
        ) {
          adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        }
        const [revoked] = await transaction
          .update(storageCredentialVersions)
          .set({
            status: 'revoked',
            revision: credential.revision + 1,
            revokedAt: new Date(),
          })
          .where(
            and(
              eq(storageCredentialVersions.id, credential.id),
              eq(storageCredentialVersions.revision, input.expectedCredentialRevision),
            ),
          )
          .returning();
        if (!revoked) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        let channelRevision = channel.revision;
        let runtimeRevision = runtime?.runtimeRevision ?? 0;
        if (channel.activeCredentialVersionId === credential.id) {
          const [updatedChannel] = await transaction
            .update(storageChannels)
            .set({
              status: channel.status === 'disabled' ? 'disabled' : 'draft',
              activeCredentialVersionId: null,
              revision: channel.revision + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(storageChannels.id, channel.id),
                eq(storageChannels.revision, input.expectedChannelRevision),
              ),
            )
            .returning();
          if (!updatedChannel) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
          channelRevision = updatedChannel.revision;
          if (runtime?.activeChannelId === channel.id) {
            runtimeRevision = await this.switchRuntime(
              transaction,
              channel.purpose,
              null,
              input.expectedRuntimeRevision,
              true,
            );
          }
        }
        await this.audit(transaction, context, request, {
          action: 'storage_credential.revoked',
          targetType: 'storage_credential',
          targetId: credential.id,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          after: {
            status: revoked.status,
            revision: revoked.revision,
            channel_revision: channelRevision,
            runtime_revision: runtimeRevision,
          },
        });
        return {
          id: revoked.id,
          storage_channel_id: channel.id,
          status: revoked.status,
          revision: revoked.revision,
          channel_revision: channelRevision,
          runtime_revision: runtimeRevision,
        };
      },
    });
  }

  async disableChannel(
    context: AdminSessionContext,
    request: AdminRequest,
    channelId: string,
    input: {
      expectedChannelRevision: number;
      expectedRuntimeRevision: number;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    return this.idempotency.execute({
      context,
      operation: 'storage_channel.disable',
      idempotencyKey: input.idempotencyKey,
      request: { channel_id: channelId, ...input },
      responseStatus: 200,
      write: async (transaction) => {
        await this.lockRuntime(transaction);
        const [channel] = await transaction
          .select()
          .from(storageChannels)
          .where(eq(storageChannels.id, channelId))
          .for('update');
        if (!channel) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
        const [runtime] = await transaction
          .select()
          .from(storageRuntimeState)
          .where(eq(storageRuntimeState.purpose, channel.purpose))
          .for('update');
        if (
          channel.status === 'disabled' ||
          channel.revision !== input.expectedChannelRevision ||
          (runtime
            ? runtime.runtimeRevision !== input.expectedRuntimeRevision
            : input.expectedRuntimeRevision !== 0)
        ) {
          adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        }
        const [disabled] = await transaction
          .update(storageChannels)
          .set({ status: 'disabled', revision: channel.revision + 1, disabledAt: new Date() })
          .where(
            and(
              eq(storageChannels.id, channel.id),
              eq(storageChannels.revision, input.expectedChannelRevision),
            ),
          )
          .returning();
        if (!disabled) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
        let runtimeRevision = runtime?.runtimeRevision ?? 0;
        if (runtime?.activeChannelId === channel.id) {
          runtimeRevision = await this.switchRuntime(
            transaction,
            channel.purpose,
            null,
            input.expectedRuntimeRevision,
            true,
          );
        }
        await this.audit(transaction, context, request, {
          action: 'storage_channel.disabled',
          targetType: 'storage_channel',
          targetId: channel.id,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          after: {
            status: disabled.status,
            revision: disabled.revision,
            runtime_revision: runtimeRevision,
          },
        });
        return {
          ...this.channelResponse(disabled),
          runtime_revision: runtimeRevision,
          runtime_active: false,
        };
      },
    });
  }

  private async lockRuntime(transaction: Transaction): Promise<void> {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('storage-runtime', 'private_assets')})`,
    );
  }

  private async switchRuntime(
    transaction: Transaction,
    purpose: string,
    activeChannelId: string | null,
    expectedRevision: number,
    exists: boolean,
  ): Promise<number> {
    if (!exists) {
      const [created] = await transaction
        .insert(storageRuntimeState)
        .values({ purpose, activeChannelId, runtimeRevision: 1 })
        .returning();
      if (!created) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
      return created.runtimeRevision;
    }
    const [updated] = await transaction
      .update(storageRuntimeState)
      .set({ activeChannelId, runtimeRevision: expectedRevision + 1, updatedAt: new Date() })
      .where(
        and(
          eq(storageRuntimeState.purpose, purpose),
          eq(storageRuntimeState.runtimeRevision, expectedRevision),
        ),
      )
      .returning();
    if (!updated) adminAuthError('ADMIN_REVISION_CONFLICT', 409);
    return updated.runtimeRevision;
  }

  private channelResponse(row: typeof storageChannels.$inferSelect): Record<string, unknown> {
    return {
      id: row.id,
      purpose: row.purpose,
      adapter_key: row.adapterKey,
      endpoint_profile_key: row.endpointProfileKey,
      region: row.region,
      bucket: row.bucket,
      root_prefix: row.rootPrefix,
      status: row.status,
      active_credential_version_id: row.activeCredentialVersionId,
      revision: row.revision,
    };
  }

  private async audit(
    transaction: Transaction,
    context: AdminSessionContext,
    request: AdminRequest,
    input: {
      action: string;
      targetType: string;
      targetId: string;
      reason: string;
      idempotencyKey: string;
      before?: Record<string, unknown>;
      after: Record<string, unknown>;
    },
  ): Promise<void> {
    await transaction.insert(adminAuditLogs).values({
      actorAdminId: context.principalId,
      actorType: 'admin_session',
      adminSessionId: context.id,
      permissionSnapshot: { permissions: context.permissions },
      action: input.action,
      targetType: input.targetType,
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
