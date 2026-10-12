import { createHash, randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';

import {
  and,
  agentTurns,
  assets,
  assetUploadIntents,
  chatMessages,
  desc,
  eq,
  lt,
  or,
  products,
  tasks,
  workflowRuns,
  storageChannels,
  storageCredentialVersions,
  storageRuntimeState,
  assetFolders,
  userActivityLogs,
  users,
  type Database,
} from '@ecom-forge/db';
import { compositeJobId, createQueueIntentInTransaction } from '@ecom-forge/queue';
import { canonicalSha256, scopedAdvisoryLockKey } from '@ecom-forge/shared';
import {
  LocalPrivateStorage,
  StorageCapabilityCodec,
  StorageCapabilityError,
  storageObjectKeyDigest,
} from '@ecom-forge/storage';
import { sql } from '@ecom-forge/db';

import type { AppConfig } from '../../config/app-config.js';
import { SignedCursorCodec } from '../../shared/http/signed-cursor.js';
import { resourceError } from './resource.errors.js';
import type { AssetListQuery, DeleteAssetInput, UploadIntentInput } from './resource.schemas.js';
import { ResourceWriteRepository } from './resource-write.repository.js';
import { AccountFrozenError } from '../auth/abuse-protection.service.js';
import type { AbuseProtectionService } from '../auth/abuse-protection.service.js';

function safeDisplayName(value: string): string {
  const leaf = value.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? '';
  if (
    !leaf ||
    [...leaf].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  )
    resourceError('ASSET_UPLOAD_INVALID');
  return leaf.slice(0, 180);
}

function assetDto(row: typeof assets.$inferSelect) {
  const meta = row.metaJson as { width?: unknown; height?: unknown };
  return {
    id: row.id,
    display_name: row.displayName,
    product_id: row.productId,
    folder_id: row.folderId,
    kind: row.kind,
    origin: row.origin,
    status: row.status,
    processing_error_code: row.processingErrorCode,
    width: typeof meta.width === 'number' ? meta.width : null,
    height: typeof meta.height === 'number' ? meta.height : null,
    content_version: row.status === 'ready' ? row.contentHash : null,
    preview: row.status === 'ready' ? { variant: 'thumbnail' as const } : null,
    created_at: row.createdAt.toISOString(),
  };
}

export class AssetService {
  private readonly logger = new Logger(AssetService.name);
  private readonly storage: LocalPrivateStorage;
  private readonly capabilities: StorageCapabilityCodec;
  private readonly cursor: SignedCursorCodec;
  private readonly writes: ResourceWriteRepository;

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly abuseProtection?: AbuseProtectionService,
  ) {
    this.storage = new LocalPrivateStorage(config.localUploadRoot);
    this.capabilities = new StorageCapabilityCodec(config.storage.capabilitySecret);
    this.cursor = new SignedCursorCodec(config.resourceCursorSecret);
    this.writes = new ResourceWriteRepository(database, config.resourceIdempotencySecret);
  }

  async createUpload(userId: string, input: UploadIntentInput, idempotencyKey: string) {
    this.assertStorageEnabled();
    const normalized = {
      ...input,
      display_name: safeDisplayName(input.display_name),
    };
    if (normalized.file_size_bytes > this.config.storage.maxImageBytes) {
      resourceError('ASSET_UPLOAD_INVALID');
    }
    const requestHash = canonicalSha256(normalized);
    const now = new Date();
    const result = await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('asset-upload', `${userId}:${idempotencyKey}`)})`,
      );
      const replay = await transaction.query.assetUploadIntents.findFirst({
        where: and(
          eq(assetUploadIntents.userId, userId),
          eq(assetUploadIntents.idempotencyKey, idempotencyKey),
        ),
      });
      if (replay) {
        if (replay.requestHash !== requestHash) resourceError('IDEMPOTENCY_CONFLICT');
        if (replay.status !== 'pending' || replay.expiresAt <= now) {
          this.logger.warn({
            event: 'asset_upload_intent_expired',
            metric: 'asset_upload_intent_expired_total',
            upload_id: replay.id,
            asset_id: replay.assetId,
          });
          resourceError('ASSET_UPLOAD_EXPIRED');
        }
        const replayAsset = await transaction.query.assets.findFirst({
          where: and(eq(assets.id, replay.assetId), eq(assets.userId, userId)),
          columns: { storageKey: true },
        });
        if (!replayAsset) resourceError('RESOURCE_NOT_FOUND');
        return {
          response: replay.responseJson as {
            upload_id: string;
            asset_id: string;
            status: 'pending';
            expires_at: string;
            max_size_bytes: number;
          },
          mimeType: replay.declaredMimeType,
          storageKey: replayAsset.storageKey,
        };
      }
      if (normalized.product_id) {
        const product = await transaction.query.products.findFirst({
          where: and(eq(products.id, normalized.product_id), eq(products.userId, userId)),
        });
        if (!product) resourceError('RESOURCE_NOT_FOUND');
      }
      if (normalized.folder_id) {
        const folder = await transaction.query.assetFolders.findFirst({
          where: and(eq(assetFolders.id, normalized.folder_id), eq(assetFolders.userId, userId)),
        });
        if (!folder) resourceError('RESOURCE_NOT_FOUND');
      }
      const storageRuntime = await this.resolveUploadStorage(transaction);
      const uploadId = randomUUID();
      const assetId = randomUUID();
      const relativeStorageKey = `assets/${assetId.slice(0, 2)}/${assetId}/original`;
      const storageKey = storageRuntime?.rootPrefix
        ? `${storageRuntime.rootPrefix}/${relativeStorageKey}`
        : relativeStorageKey;
      const expiresAt = new Date(now.getTime() + this.config.storage.uploadTtlSeconds * 1000);
      const response = {
        upload_id: uploadId,
        asset_id: assetId,
        status: 'pending' as const,
        expires_at: expiresAt.toISOString(),
        max_size_bytes: this.config.storage.maxImageBytes,
      };
      await transaction.insert(assets).values({
        id: assetId,
        userId,
        productId: normalized.product_id,
        folderId: normalized.folder_id,
        displayName: normalized.display_name,
        storageChannelId: storageRuntime?.id ?? null,
        storageKey,
        fileSizeBytes: BigInt(normalized.file_size_bytes),
        kind: 'upload',
        origin: 'upload',
        status: 'uploading',
      });
      await transaction.insert(assetUploadIntents).values({
        id: uploadId,
        userId,
        assetId,
        storageChannelId: storageRuntime?.id ?? null,
        idempotencyKey,
        requestHash,
        responseJson: response,
        declaredMimeType: normalized.declared_mime_type,
        maxSizeBytes: BigInt(this.config.storage.maxImageBytes),
        expiresAt,
      });
      return { response, mimeType: normalized.declared_mime_type, storageKey };
    });
    const token = this.capabilities.issue({
      version: 1,
      purpose: 'upload',
      userId,
      resourceType: 'upload',
      resourceId: result.response.upload_id,
      variant: 'content',
      objectKeyDigest: storageObjectKeyDigest(result.storageKey),
      maxBytes: result.response.max_size_bytes,
      expiresAt: Math.floor(new Date(result.response.expires_at).getTime() / 1000),
    });
    this.logger.log({
      event: 'asset_upload_intent_issued',
      metric: 'asset_upload_intent_created_total',
      upload_id: result.response.upload_id,
      asset_id: result.response.asset_id,
    });
    return {
      upload_id: result.response.upload_id,
      asset_id: result.response.asset_id,
      status: result.response.status,
      upload: {
        method: 'PUT' as const,
        url: `/api/v1/assets/uploads/${result.response.upload_id}/content?capability=${encodeURIComponent(token)}`,
        headers: { 'Content-Type': result.mimeType },
        expires_at: result.response.expires_at,
        max_size_bytes: result.response.max_size_bytes,
      },
    };
  }

  async uploadContent(input: {
    uploadId: string;
    capability: string;
    contentType: string;
    body: Buffer;
    ipBucket?: string;
  }): Promise<void> {
    this.assertStorageEnabled();
    let decoded;
    try {
      decoded = this.capabilities.decode(input.capability);
    } catch (error) {
      if (error instanceof StorageCapabilityError) resourceError('RESOURCE_NOT_FOUND');
      throw error;
    }
    if (
      decoded.purpose !== 'upload' ||
      decoded.resourceType !== 'upload' ||
      decoded.resourceId !== input.uploadId ||
      decoded.variant !== 'content' ||
      !decoded.maxBytes ||
      input.body.length <= 0 ||
      input.body.length > decoded.maxBytes
    ) {
      resourceError('ASSET_UPLOAD_INVALID');
    }
    await this.assertMediaAccess(decoded.userId, input.ipBucket ?? 'unknown', 'upload');
    const intent = await this.database.query.assetUploadIntents.findFirst({
      where: and(
        eq(assetUploadIntents.id, input.uploadId),
        eq(assetUploadIntents.userId, decoded.userId),
      ),
    });
    if (!intent) resourceError('RESOURCE_NOT_FOUND');
    if (intent.status !== 'pending' || intent.expiresAt <= new Date()) {
      resourceError('ASSET_UPLOAD_EXPIRED');
    }
    if (intent.declaredMimeType !== input.contentType) resourceError('ASSET_UPLOAD_INVALID');
    const asset = await this.database.query.assets.findFirst({
      where: and(eq(assets.id, intent.assetId), eq(assets.userId, decoded.userId)),
    });
    if (!asset || asset.status !== 'uploading') resourceError('RESOURCE_NOT_FOUND');
    if (decoded.objectKeyDigest !== storageObjectKeyDigest(asset.storageKey)) {
      resourceError('RESOURCE_NOT_FOUND');
    }
    await this.storage.initialize();
    try {
      await this.storage.writeExclusive(asset.storageKey, input.body);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'EEXIST') {
        const existing = await this.storage.read(asset.storageKey);
        if (
          existing.length === input.body.length &&
          createHash('sha256').update(existing).digest('hex') ===
            createHash('sha256').update(input.body).digest('hex')
        ) {
          return;
        }
        resourceError('IDEMPOTENCY_CONFLICT');
      }
      throw error;
    }
  }

  async complete(userId: string, input: { upload_id: string; asset_id: string }, key: string) {
    const result = await this.writes.execute({
      userId,
      operation: 'POST /assets/complete',
      idempotencyKey: key,
      request: input,
      responseStatus: 202,
      write: async (transaction) => {
        const [intent] = await transaction
          .select()
          .from(assetUploadIntents)
          .where(
            and(eq(assetUploadIntents.id, input.upload_id), eq(assetUploadIntents.userId, userId)),
          )
          .for('update');
        if (!intent || intent.assetId !== input.asset_id) resourceError('RESOURCE_NOT_FOUND');
        if (intent.expiresAt <= new Date()) resourceError('ASSET_UPLOAD_EXPIRED');
        const [asset] = await transaction
          .select()
          .from(assets)
          .where(and(eq(assets.id, input.asset_id), eq(assets.userId, userId)))
          .for('update');
        if (!asset || asset.status !== 'uploading' || intent.status !== 'pending') {
          resourceError('RESOURCE_NOT_FOUND');
        }
        const now = new Date();
        await transaction
          .update(assetUploadIntents)
          .set({ status: 'completed', completedAt: now, updatedAt: now })
          .where(eq(assetUploadIntents.id, intent.id));
        await transaction
          .update(assets)
          .set({ status: 'processing', updatedAt: now })
          .where(eq(assets.id, asset.id));
        await createQueueIntentInTransaction(transaction, {
          queueName: 'asset',
          jobId: compositeJobId({
            job_type: 'asset.process',
            asset_id: asset.id,
            operation: 'inspect_metadata',
            operation_no: asset.processingRevision,
          }),
          aggregateType: 'asset',
          aggregateId: asset.id,
          payloadVersion: 1,
          payload: {
            schema_version: 1,
            trace_id: randomUUID(),
            job_type: 'asset.process',
            asset_id: asset.id,
            user_id: userId,
            operation: 'inspect_metadata',
            operation_no: asset.processingRevision,
            idempotency_key: `asset:${asset.id}:inspect_metadata:${asset.processingRevision}`,
          },
        });
        await transaction.insert(userActivityLogs).values({
          userId,
          activityType: 'asset_upload',
          targetType: 'asset',
          targetId: asset.id,
          metadata: { operation: 'complete' },
        });
        return { asset_id: asset.id, status: 'processing' as const };
      },
    });
    this.logger.log({
      event: 'asset_upload_completed',
      metric: 'asset_upload_completed_total',
      upload_id: input.upload_id,
      asset_id: input.asset_id,
    });
    return result;
  }

  retry(userId: string, assetId: string, key: string) {
    return this.writes.execute({
      userId,
      operation: 'POST /assets/{id}/retry-processing',
      idempotencyKey: key,
      request: { asset_id: assetId, reason: 'user_requested' },
      responseStatus: 202,
      write: async (transaction) => {
        const [asset] = await transaction
          .select()
          .from(assets)
          .where(and(eq(assets.id, assetId), eq(assets.userId, userId)))
          .for('update');
        if (!asset) resourceError('RESOURCE_NOT_FOUND');
        if (asset.status !== 'processing_failed') resourceError('ASSET_NOT_READY');
        const revision = asset.processingRevision + 1;
        await transaction
          .update(assets)
          .set({
            status: 'processing',
            processingRevision: revision,
            processingErrorCode: null,
            updatedAt: new Date(),
          })
          .where(
            and(eq(assets.id, asset.id), eq(assets.processingRevision, asset.processingRevision)),
          );
        await createQueueIntentInTransaction(transaction, {
          queueName: 'asset',
          jobId: compositeJobId({
            job_type: 'asset.process',
            asset_id: asset.id,
            operation: 'inspect_metadata',
            operation_no: revision,
          }),
          aggregateType: 'asset',
          aggregateId: asset.id,
          payloadVersion: 1,
          payload: {
            schema_version: 1,
            trace_id: randomUUID(),
            job_type: 'asset.process',
            asset_id: asset.id,
            user_id: userId,
            operation: 'inspect_metadata',
            operation_no: revision,
            idempotency_key: `asset:${asset.id}:inspect_metadata:${revision}`,
          },
        });
        return { asset_id: asset.id, status: 'processing' as const, processing_revision: revision };
      },
    });
  }

  delete(userId: string, assetId: string, input: DeleteAssetInput, key: string) {
    return this.writes.execute({
      userId,
      operation: 'DELETE /assets/{id}',
      idempotencyKey: key,
      request: { asset_id: assetId, ...input },
      responseStatus: 200,
      write: async (transaction) => {
        const [asset] = await transaction
          .select()
          .from(assets)
          .where(and(eq(assets.id, assetId), eq(assets.userId, userId)))
          .for('update');
        if (!asset || asset.status === 'deleted') resourceError('RESOURCE_NOT_FOUND');
        if (asset.processingRevision !== input.expected_revision) {
          resourceError('ASSET_REVISION_CONFLICT');
        }

        const activeTurn = await transaction
          .select({ id: agentTurns.id })
          .from(agentTurns)
          .leftJoin(chatMessages, eq(chatMessages.turnId, agentTurns.id))
          .where(
            and(
              eq(agentTurns.userId, userId),
              sql`${agentTurns.status} not in ('done','blocked','failed','cancelled','superseded')`,
              or(
                sql`${chatMessages.attachments} @> jsonb_build_array(jsonb_build_object('object_id', ${assetId}::uuid))`,
                sql`jsonb_path_exists(${agentTurns.contextSnapshotJson}, '$.** ? (@ == $asset_id)', jsonb_build_object('asset_id', ${assetId}::uuid))`,
              ),
            ),
          )
          .limit(1);
        if (activeTurn.length > 0) resourceError('ASSET_IN_USE');

        const activeWorkflow = await transaction
          .select({ id: workflowRuns.id })
          .from(workflowRuns)
          .leftJoin(tasks, eq(tasks.workflowRunId, workflowRuns.id))
          .where(
            and(
              eq(workflowRuns.userId, userId),
              sql`${workflowRuns.status} not in ('succeeded','failed','cancelled','refunded')`,
              or(
                sql`jsonb_path_exists(${workflowRuns.planSnapshot}, '$.** ? (@ == $asset_id)', jsonb_build_object('asset_id', ${assetId}::uuid))`,
                sql`jsonb_path_exists(${tasks.paramsSnapshot}, '$.** ? (@ == $asset_id)', jsonb_build_object('asset_id', ${assetId}::uuid))`,
              ),
            ),
          )
          .limit(1);
        if (activeWorkflow.length > 0) resourceError('ASSET_IN_USE');

        const now = new Date();
        await transaction
          .update(products)
          .set({
            primaryAssetId: null,
            revision: sql`${products.revision} + 1`,
            updatedAt: now,
          })
          .where(and(eq(products.userId, userId), eq(products.primaryAssetId, asset.id)));
        await transaction
          .update(assetUploadIntents)
          .set({ status: 'rejected', updatedAt: now })
          .where(
            and(eq(assetUploadIntents.assetId, asset.id), eq(assetUploadIntents.status, 'pending')),
          );
        const [deleted] = await transaction
          .update(assets)
          .set({ status: 'deleted', deletedAt: now, updatedAt: now })
          .where(
            and(
              eq(assets.id, asset.id),
              eq(assets.userId, userId),
              eq(assets.processingRevision, input.expected_revision),
              sql`${assets.status} <> 'deleted'`,
            ),
          )
          .returning({ id: assets.id, deletedAt: assets.deletedAt });
        if (!deleted) resourceError('ASSET_REVISION_CONFLICT');
        await transaction.insert(userActivityLogs).values({
          userId,
          activityType: 'asset_delete',
          targetType: 'asset',
          targetId: asset.id,
          metadata: {
            operation: 'delete',
            reason: input.reason,
            expected_revision: input.expected_revision,
          },
        });
        return {
          asset_id: deleted.id,
          status: 'deleted' as const,
          deleted_at: deleted.deletedAt?.toISOString() ?? now.toISOString(),
        };
      },
    });
  }

  async list(userId: string, input: AssetListQuery) {
    const filters = {
      product_id: input.product_id ?? null,
      folder_id: input.folder_id ?? null,
      status: input.status ?? null,
      kind: input.kind ?? null,
      query: input.query ?? null,
    };
    const position = input.cursor
      ? this.cursor.decode({ cursor: input.cursor, userId, endpoint: 'assets', filters })
      : undefined;
    const rows = await this.database
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.userId, userId),
          input.product_id ? eq(assets.productId, input.product_id) : undefined,
          input.folder_id ? eq(assets.folderId, input.folder_id) : undefined,
          input.status ? eq(assets.status, input.status) : undefined,
          input.kind ? eq(assets.kind, input.kind) : undefined,
          input.query ? sql`${assets.displayName} ilike ${`%${input.query}%`}` : undefined,
          position
            ? or(
                lt(assets.createdAt, position.createdAt),
                and(eq(assets.createdAt, position.createdAt), lt(assets.id, position.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(assets.createdAt), desc(assets.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map(assetDto),
      next_cursor:
        rows.length > input.limit && last
          ? this.cursor.encode({
              userId,
              endpoint: 'assets',
              filters,
              position: { createdAt: last.createdAt, id: last.id },
            })
          : null,
    };
  }

  async access(
    userId: string,
    assetId: string,
    input: {
      variant: 'original' | 'thumbnail';
      purpose: 'preview' | 'download';
    },
    ipBucket = 'unknown',
  ) {
    this.assertStorageEnabled();
    await this.assertMediaAccess(userId, ipBucket, input.purpose);
    const asset = await this.database.query.assets.findFirst({
      where: and(eq(assets.id, assetId), eq(assets.userId, userId)),
    });
    if (!asset) resourceError('RESOURCE_NOT_FOUND');
    if (asset.status !== 'ready') resourceError('ASSET_NOT_READY');
    if (input.variant === 'thumbnail' && !asset.thumbnailKey) resourceError('ASSET_NOT_READY');
    const objectKey = input.variant === 'thumbnail' ? asset.thumbnailKey : asset.storageKey;
    if (!objectKey) resourceError('ASSET_NOT_READY');
    const expiresAt = Math.floor(Date.now() / 1000) + this.config.storage.accessTtlSeconds;
    const token = this.capabilities.issue({
      version: 1,
      purpose: input.purpose,
      userId,
      resourceType: 'asset',
      resourceId: asset.id,
      variant: input.variant,
      objectKeyDigest: storageObjectKeyDigest(objectKey),
      expiresAt,
    });
    if (input.purpose === 'download') {
      await this.database.insert(userActivityLogs).values({
        userId,
        activityType: 'download',
        targetType: 'asset',
        targetId: asset.id,
        metadata: { variant: input.variant },
      });
    }
    return {
      url: `/api/v1/assets/${asset.id}/content?variant=${input.variant}&purpose=${input.purpose}&capability=${encodeURIComponent(token)}`,
      expires_at: new Date(expiresAt * 1000).toISOString(),
    };
  }

  async readContent(input: {
    assetId: string;
    variant: 'original' | 'thumbnail';
    purpose: 'preview' | 'download';
    capability?: string | undefined;
    userId?: string | undefined;
    ipBucket?: string | undefined;
    ifNoneMatch?: string | undefined;
  }): Promise<
    | { notModified: true; etag: string }
    | { notModified: false; body: Buffer; mimeType: string; filename: string; etag: string }
  > {
    this.assertStorageEnabled();
    let resolvedUserId: string;
    let expectedObjectKeyDigest: string | null = null;
    if (input.capability) {
      let decoded;
      try {
        decoded = this.capabilities.decode(input.capability);
      } catch (error) {
        if (error instanceof StorageCapabilityError) resourceError('RESOURCE_NOT_FOUND');
        throw error;
      }
      if (
        decoded.resourceType !== 'asset' ||
        decoded.resourceId !== input.assetId ||
        decoded.variant !== input.variant ||
        decoded.purpose !== input.purpose
      ) {
        resourceError('RESOURCE_NOT_FOUND');
      }
      resolvedUserId = decoded.userId;
      expectedObjectKeyDigest = decoded.objectKeyDigest;
    } else {
      resolvedUserId = input.userId ?? resourceError('RESOURCE_NOT_FOUND');
    }
    await this.assertMediaAccess(
      resolvedUserId,
      input.ipBucket ?? 'unknown',
      input.purpose,
      'content',
    );
    const asset = await this.database.query.assets.findFirst({
      where: and(eq(assets.id, input.assetId), eq(assets.userId, resolvedUserId)),
    });
    if (!asset || asset.status !== 'ready') resourceError('RESOURCE_NOT_FOUND');
    const key = input.variant === 'thumbnail' ? asset.thumbnailKey : asset.storageKey;
    if (!key) resourceError('RESOURCE_NOT_FOUND');
    if (expectedObjectKeyDigest && expectedObjectKeyDigest !== storageObjectKeyDigest(key)) {
      resourceError('RESOURCE_NOT_FOUND');
    }
    const representationHash =
      input.variant === 'thumbnail'
        ? canonicalSha256({
            object_key_digest: storageObjectKeyDigest(key),
            revision: asset.processingRevision,
            source_hash: asset.contentHash,
          })
        : (asset.contentHash ?? storageObjectKeyDigest(key));
    const etag = `"${representationHash}"`;
    if (input.ifNoneMatch === etag) {
      return { notModified: true, etag };
    }
    await this.storage.initialize();
    const body = await this.storage.read(key);
    if (input.purpose === 'download' && !input.capability) {
      // Session-authenticated downloads have no mint step to audit at, so the
      // download activity lands here, on the successful delivery only. Capability
      // downloads are already audited when access-url mints the token.
      await this.database.insert(userActivityLogs).values({
        userId: resolvedUserId,
        activityType: 'download',
        targetType: 'asset',
        targetId: asset.id,
        metadata: { variant: input.variant },
      });
    }
    return {
      notModified: false,
      body,
      mimeType:
        input.variant === 'thumbnail'
          ? 'image/webp'
          : (asset.mimeType ?? 'application/octet-stream'),
      filename: asset.displayName,
      etag,
    };
  }

  private assertStorageEnabled(): void {
    if (this.config.storage.driver !== 'local') resourceError('STORAGE_UNAVAILABLE');
  }

  private async assertMediaAccess(
    userId: string,
    ipBucket: string,
    operation: 'upload' | 'preview' | 'download',
    mode: 'issue' | 'content' = 'issue',
  ): Promise<void> {
    const user = await this.database.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { riskStatus: true },
    });
    if (!user) resourceError('RESOURCE_NOT_FOUND');
    if (user.riskStatus === 'frozen') throw new AccountFrozenError();
    if (mode === 'content') {
      await this.abuseProtection?.assertMediaContentRequest(userId, ipBucket);
      return;
    }
    await this.abuseProtection?.assertMediaRequest(userId, ipBucket, operation);
  }

  private async resolveUploadStorage(
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
  ): Promise<{ id: string; rootPrefix: string } | null> {
    const runtime = await transaction.query.storageRuntimeState.findFirst({
      where: eq(storageRuntimeState.purpose, 'private_assets'),
    });
    if (!runtime) {
      if (this.config.appEnv === 'local' || this.config.appEnv === 'test') return null;
      resourceError('STORAGE_UNAVAILABLE');
    }
    if (!runtime.activeChannelId) resourceError('STORAGE_UNAVAILABLE');
    const channel = await transaction.query.storageChannels.findFirst({
      where: eq(storageChannels.id, runtime.activeChannelId),
    });
    if (
      !channel ||
      channel.purpose !== 'private_assets' ||
      channel.status !== 'active' ||
      !channel.activeCredentialVersionId
    ) {
      resourceError('STORAGE_UNAVAILABLE');
    }
    const credential = await transaction.query.storageCredentialVersions.findFirst({
      where: eq(storageCredentialVersions.id, channel.activeCredentialVersionId),
    });
    if (
      !credential ||
      credential.status !== 'active' ||
      credential.storageChannelId !== channel.id
    ) {
      resourceError('STORAGE_UNAVAILABLE');
    }
    if (
      channel.adapterKey === 'local-private-v1' &&
      this.config.appEnv !== 'local' &&
      this.config.appEnv !== 'test'
    ) {
      resourceError('STORAGE_UNAVAILABLE');
    }
    return { id: channel.id, rootPrefix: channel.rootPrefix.replace(/\/$/, '') };
  }
}
