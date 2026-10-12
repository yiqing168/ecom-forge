import { createHash } from 'node:crypto';

import { and, assets, assetUploadIntents, eq, type Database } from '@ecom-forge/db';
import {
  compositeJobId,
  createQueueIntentInTransaction,
  type QueuePayload,
} from '@ecom-forge/queue';
import { LocalPrivateStorage } from '@ecom-forge/storage';
import sharp from 'sharp';

import type { WorkerConfig } from '../config/worker-config.js';
import type { WorkerWriteFence } from '../lifecycle/processing-fence.js';
import type { WorkerLifecycleLogger } from '../lifecycle/worker-lifecycle.js';

type AssetPayload = Extract<QueuePayload, { job_type: 'asset.process' }>;

const MIME_BY_FORMAT = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;

type InspectionResult = {
  hash: string;
  mimeType: string;
  width: number;
  height: number;
  size: number;
};

export class AssetProcessingService {
  private readonly storage: LocalPrivateStorage;

  constructor(
    private readonly database: Database,
    private readonly config: WorkerConfig,
    private readonly writeFence: WorkerWriteFence,
    private readonly telemetry?: WorkerLifecycleLogger,
  ) {
    this.storage = new LocalPrivateStorage(config.localUploadRoot);
  }

  async execute(payload: AssetPayload): Promise<void> {
    const startedAt = Date.now();
    if (!this.config.storageEnabled) throw new Error('ASSET_STORAGE_DISABLED');
    const [asset, uploadIntent] = await Promise.all([
      this.database.query.assets.findFirst({
        where: and(eq(assets.id, payload.asset_id), eq(assets.userId, payload.user_id)),
      }),
      this.database.query.assetUploadIntents.findFirst({
        where: and(
          eq(assetUploadIntents.assetId, payload.asset_id),
          eq(assetUploadIntents.userId, payload.user_id),
          eq(assetUploadIntents.status, 'completed'),
        ),
      }),
    ]);
    if (
      !asset ||
      asset.status !== 'processing' ||
      asset.processingRevision !== payload.operation_no
    ) {
      this.logResult(payload, 'no_op', startedAt);
      return;
    }
    await this.storage.initialize();
    if (payload.operation === 'inspect_metadata') {
      await this.inspect(
        payload,
        asset.storageKey,
        asset.kind === 'upload' ? (uploadIntent?.declaredMimeType ?? null) : undefined,
        startedAt,
      );
      return;
    }
    if (payload.operation === 'generate_thumbnail') {
      await this.thumbnail(payload, asset.storageKey, asset.contentHash, startedAt);
    }
  }

  private async inspect(
    payload: AssetPayload,
    storageKey: string,
    declaredMimeType: string | null | undefined,
    startedAt: number,
  ): Promise<void> {
    let result: InspectionResult;
    try {
      if (declaredMimeType === null) throw new Error('ASSET_UPLOAD_INTENT_INVALID');
      const bytes = await this.storage.read(storageKey);
      result = await this.inspectBytes(bytes);
      if (declaredMimeType && declaredMimeType !== result.mimeType) {
        throw new Error('ASSET_MIME_MISMATCH');
      }
    } catch (error) {
      const errorCode = classifyInspectionError(error);
      await this.reject(payload, errorCode);
      this.logResult(payload, 'rejected', startedAt, errorCode);
      return;
    }
    this.writeFence.assertWritesAllowed();
    const inspected = await this.database.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(assets)
        .set({
          contentHash: result.hash,
          mimeType: result.mimeType,
          fileSizeBytes: BigInt(result.size),
          metaJson: { width: result.width, height: result.height },
          processingErrorCode: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(assets.id, payload.asset_id),
            eq(assets.userId, payload.user_id),
            eq(assets.status, 'processing'),
            eq(assets.processingRevision, payload.operation_no),
          ),
        )
        .returning({ id: assets.id });
      if (!updated) return false;
      const idempotencyKey = `asset:${payload.asset_id}:generate_thumbnail:${payload.operation_no}`;
      await createQueueIntentInTransaction(transaction, {
        queueName: 'asset',
        jobId: compositeJobId({
          job_type: 'asset.process',
          asset_id: payload.asset_id,
          operation: 'generate_thumbnail',
          operation_no: payload.operation_no,
        }),
        aggregateType: 'asset',
        aggregateId: payload.asset_id,
        payloadVersion: 1,
        payload: {
          schema_version: 1,
          trace_id: payload.trace_id,
          job_type: 'asset.process',
          asset_id: payload.asset_id,
          user_id: payload.user_id,
          operation: 'generate_thumbnail',
          operation_no: payload.operation_no,
          idempotency_key: idempotencyKey,
        },
      });
      return true;
    });
    this.logResult(payload, inspected ? 'inspected' : 'no_op', startedAt);
  }

  private async thumbnail(
    payload: AssetPayload,
    storageKey: string,
    expectedHash: string | null,
    startedAt: number,
  ): Promise<void> {
    if (!expectedHash) return;
    const thumbnailKey = `assets/${payload.asset_id.slice(0, 2)}/${payload.asset_id}/thumb-${expectedHash.slice(0, 24)}-s10v1.webp`;
    try {
      const source = await this.storage.read(storageKey);
      const thumbnail = await sharp(source, {
        failOn: 'error',
        limitInputPixels: this.config.storageMaxImagePixels,
      })
        .rotate()
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toBuffer();
      await this.storage.write(thumbnailKey, thumbnail);
    } catch {
      await this.failThumbnail(payload, 'ASSET_THUMBNAIL_FAILED');
      this.logResult(payload, 'processing_failed', startedAt, 'ASSET_THUMBNAIL_FAILED');
      return;
    }
    this.writeFence.assertWritesAllowed();
    const [updated] = await this.database
      .update(assets)
      .set({
        thumbnailKey,
        status: 'ready',
        processingErrorCode: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(assets.id, payload.asset_id),
          eq(assets.userId, payload.user_id),
          eq(assets.status, 'processing'),
          eq(assets.processingRevision, payload.operation_no),
          eq(assets.contentHash, expectedHash),
        ),
      )
      .returning({ id: assets.id });
    this.logResult(payload, updated ? 'ready' : 'no_op', startedAt);
  }

  private async inspectBytes(bytes: Buffer): Promise<InspectionResult> {
    if (bytes.length <= 0 || bytes.length > this.config.storageMaxImageBytes) {
      throw new Error('ASSET_SIZE_INVALID');
    }
    const image = sharp(bytes, {
      failOn: 'error',
      limitInputPixels: this.config.storageMaxImagePixels,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    const mimeType = metadata.format
      ? MIME_BY_FORMAT[metadata.format as keyof typeof MIME_BY_FORMAT]
      : undefined;
    if (!mimeType) throw new Error('ASSET_FORMAT_INVALID');
    if (!metadata.width || !metadata.height) throw new Error('ASSET_DIMENSIONS_INVALID');
    if (
      metadata.width > this.config.storageMaxImageWidth ||
      metadata.height > this.config.storageMaxImageHeight ||
      metadata.width * metadata.height > this.config.storageMaxImagePixels
    ) {
      throw new Error('ASSET_DIMENSIONS_INVALID');
    }
    await image.clone().raw().toBuffer({ resolveWithObject: true });
    return {
      hash: createHash('sha256').update(bytes).digest('hex'),
      mimeType,
      width: metadata.width,
      height: metadata.height,
      size: bytes.length,
    };
  }

  private async reject(payload: AssetPayload, code: string): Promise<void> {
    this.writeFence.assertWritesAllowed();
    await this.database
      .update(assets)
      .set({ status: 'rejected', processingErrorCode: code, updatedAt: new Date() })
      .where(
        and(
          eq(assets.id, payload.asset_id),
          eq(assets.userId, payload.user_id),
          eq(assets.status, 'processing'),
          eq(assets.processingRevision, payload.operation_no),
        ),
      );
  }

  private async failThumbnail(payload: AssetPayload, code: string): Promise<void> {
    this.writeFence.assertWritesAllowed();
    await this.database
      .update(assets)
      .set({ status: 'processing_failed', processingErrorCode: code, updatedAt: new Date() })
      .where(
        and(
          eq(assets.id, payload.asset_id),
          eq(assets.userId, payload.user_id),
          eq(assets.status, 'processing'),
          eq(assets.processingRevision, payload.operation_no),
        ),
      );
  }

  private logResult(
    payload: AssetPayload,
    outcome: 'inspected' | 'no_op' | 'processing_failed' | 'ready' | 'rejected',
    startedAt: number,
    errorCode?: string,
  ): void {
    const event = {
      event: 'asset_processing_completed',
      metric:
        outcome === 'processing_failed'
          ? 'asset_thumbnail_failure_total'
          : outcome === 'ready'
            ? 'asset_thumbnail_latency_ms'
            : 'asset_inspect_result_total',
      trace_id: payload.trace_id,
      asset_id: payload.asset_id,
      operation: payload.operation,
      operation_no: payload.operation_no,
      outcome,
      ...(errorCode ? { error_code: errorCode } : {}),
      duration_ms: Date.now() - startedAt,
    };
    if (errorCode) this.telemetry?.error(event);
    else this.telemetry?.info(event);
  }
}

function classifyInspectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('SIZE')) return 'ASSET_SIZE_INVALID';
  if (message.includes('DIMENSION') || message.includes('pixel')) return 'ASSET_DIMENSIONS_INVALID';
  if (message.includes('ENOENT')) return 'ASSET_OBJECT_MISSING';
  if (message.includes('MIME')) return 'ASSET_MIME_MISMATCH';
  if (message.includes('UPLOAD_INTENT')) return 'ASSET_UPLOAD_INTENT_INVALID';
  if (message.includes('FORMAT')) return 'ASSET_FORMAT_INVALID';
  return 'ASSET_IMAGE_INVALID';
}
