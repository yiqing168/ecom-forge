import {
  and,
  artifacts,
  assets,
  assetFolders,
  desc,
  eq,
  lt,
  or,
  products,
  sql,
  userActivityLogs,
  users,
  type Database,
} from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';
import {
  LocalPrivateStorage,
  StorageCapabilityCodec,
  StorageCapabilityError,
  storageObjectKeyDigest,
} from '@ecom-forge/storage';

import type { AppConfig } from '../../config/app-config.js';
import { SignedCursorCodec } from '../../shared/http/signed-cursor.js';
import { resourceError } from './resource.errors.js';
import type { ArtifactListQuery } from './resource.schemas.js';
import { ResourceWriteRepository } from './resource-write.repository.js';
import { AccountFrozenError } from '../auth/abuse-protection.service.js';
import type { AbuseProtectionService } from '../auth/abuse-protection.service.js';

const READABLE_VISIBILITIES = ['private', 'shared', 'public'] as const;

function mediaDimensions(metaJson: unknown): { width: number | null; height: number | null } {
  if (!metaJson || typeof metaJson !== 'object' || Array.isArray(metaJson)) {
    return { width: null, height: null };
  }
  const metadata = metaJson as { width?: unknown; height?: unknown };
  return {
    width:
      Number.isInteger(metadata.width) && Number(metadata.width) > 0
        ? Number(metadata.width)
        : null,
    height:
      Number.isInteger(metadata.height) && Number(metadata.height) > 0
        ? Number(metadata.height)
        : null,
  };
}

function isReadable(value: string): boolean {
  return READABLE_VISIBILITIES.includes(value as (typeof READABLE_VISIBILITIES)[number]);
}

function artifactDto(row: typeof artifacts.$inferSelect) {
  const readable = isReadable(row.visibility);
  const dimensions = mediaDimensions(row.metaJson);
  return {
    id: row.id,
    product_id: row.productId,
    type: row.type,
    origin_domain: row.originDomain,
    producer_mode: row.producerMode,
    source_action: row.sourceAction,
    source_artifact_id: row.sourceArtifactId,
    producer_session_id: row.producerSessionId,
    visibility: row.visibility,
    content_version: readable ? (row.publishedContentHash ?? row.contentHash) : null,
    publication_revision: readable && row.publishedContentHash ? row.publicationRevision : null,
    created_at: row.createdAt.toISOString(),
    width: dimensions.width,
    height: dimensions.height,
    ...(readable ? { preview: { variant: 'thumbnail' as const } } : {}),
  };
}

export class ArtifactService {
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

  async list(userId: string, input: ArtifactListQuery) {
    const normalizedSku = input.sku_code?.trim().normalize('NFKC').toUpperCase();
    const filters = {
      product_id: input.product_id ?? null,
      sku_code: normalizedSku ?? null,
      type: input.type ?? null,
      origin_domain: input.origin_domain ?? null,
      producer_mode: input.producer_mode ?? null,
    };
    const position = input.cursor
      ? this.cursor.decode({ cursor: input.cursor, userId, endpoint: 'artifacts', filters })
      : undefined;
    const rows = await this.database
      .select({ artifact: artifacts })
      .from(artifacts)
      .leftJoin(products, eq(products.id, artifacts.productId))
      .where(
        and(
          eq(artifacts.userId, userId),
          input.product_id ? eq(artifacts.productId, input.product_id) : undefined,
          normalizedSku ? eq(products.skuCode, normalizedSku) : undefined,
          input.type ? eq(artifacts.type, input.type) : undefined,
          input.origin_domain ? eq(artifacts.originDomain, input.origin_domain) : undefined,
          input.producer_mode ? eq(artifacts.producerMode, input.producer_mode) : undefined,
          position
            ? or(
                lt(artifacts.createdAt, position.createdAt),
                and(eq(artifacts.createdAt, position.createdAt), lt(artifacts.id, position.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit).map((row) => row.artifact);
    const last = page.at(-1);
    return {
      items: page.map(artifactDto),
      next_cursor:
        rows.length > input.limit && last
          ? this.cursor.encode({
              userId,
              endpoint: 'artifacts',
              filters,
              position: { createdAt: last.createdAt, id: last.id },
            })
          : null,
    };
  }

  async access(
    userId: string,
    artifactId: string,
    input: {
      variant: 'original' | 'thumbnail';
      purpose: 'preview' | 'download';
    },
    ipBucket = 'unknown',
  ) {
    this.assertStorageEnabled();
    await this.assertMediaAccess(userId, ipBucket, input.purpose);
    const artifact = await this.database.query.artifacts.findFirst({
      where: and(eq(artifacts.id, artifactId), eq(artifacts.userId, userId)),
    });
    if (!artifact || artifact.visibility === 'deleted') resourceError('RESOURCE_NOT_FOUND');
    if (artifact.visibility === 'quarantined') resourceError('ARTIFACT_QUARANTINED');
    if (!isReadable(artifact.visibility)) resourceError('RESOURCE_NOT_FOUND');
    if (input.variant === 'thumbnail' && !artifact.thumbnailKey)
      resourceError('RESOURCE_NOT_FOUND');
    const objectKey = artifactObjectKey(artifact, input.variant);
    if (!objectKey) resourceError('RESOURCE_NOT_FOUND');
    const expiresAt = Math.floor(Date.now() / 1000) + this.config.storage.accessTtlSeconds;
    const token = this.capabilities.issue({
      version: 1,
      purpose: input.purpose,
      userId,
      resourceType: 'artifact',
      resourceId: artifact.id,
      variant: input.variant,
      objectKeyDigest: storageObjectKeyDigest(objectKey),
      expiresAt,
    });
    if (input.purpose === 'download') {
      await this.database.insert(userActivityLogs).values({
        userId,
        activityType: 'download',
        targetType: 'artifact',
        targetId: artifact.id,
        metadata: { variant: input.variant },
      });
    }
    return {
      url: `/api/v1/artifacts/${artifact.id}/content?variant=${input.variant}&purpose=${input.purpose}&capability=${encodeURIComponent(token)}`,
      expires_at: new Date(expiresAt * 1000).toISOString(),
    };
  }

  saveToAssets(
    userId: string,
    artifactId: string,
    input: { folder_id?: string; product_id?: string },
    key: string,
  ) {
    return this.writes.execute({
      userId,
      operation: 'POST /artifacts/{id}/save-to-assets',
      idempotencyKey: key,
      request: { artifact_id: artifactId, ...input },
      responseStatus: 201,
      write: async (transaction) => {
        const [artifact] = await transaction
          .select()
          .from(artifacts)
          .where(and(eq(artifacts.id, artifactId), eq(artifacts.userId, userId)))
          .for('update');
        if (!artifact || artifact.visibility === 'deleted') resourceError('RESOURCE_NOT_FOUND');
        if (artifact.visibility === 'quarantined') resourceError('ARTIFACT_QUARANTINED');
        if (
          !isReadable(artifact.visibility) ||
          !(artifact.publishedContentHash ?? artifact.contentHash) ||
          !artifact.thumbnailKey
        ) {
          resourceError('RESOURCE_NOT_FOUND');
        }
        if (input.folder_id) {
          const folder = await transaction.query.assetFolders.findFirst({
            where: and(eq(assetFolders.id, input.folder_id), eq(assetFolders.userId, userId)),
          });
          if (!folder) resourceError('RESOURCE_NOT_FOUND');
        }
        const productId = input.product_id ?? artifact.productId;
        if (productId) {
          const product = await transaction.query.products.findFirst({
            where: and(eq(products.id, productId), eq(products.userId, userId)),
          });
          if (!product) resourceError('RESOURCE_NOT_FOUND');
        }
        const existing = await transaction.query.assets.findFirst({
          where: and(
            eq(assets.userId, userId),
            eq(assets.sourceArtifactId, artifact.id),
            sql`${assets.deletedAt} is null`,
          ),
        });
        if (existing) return assetResponse(existing);
        const [created] = await transaction
          .insert(assets)
          .values({
            userId,
            productId,
            folderId: input.folder_id,
            displayName: `作品 ${artifact.id.slice(0, 8)}`,
            storageKey: artifact.publishedStorageKey ?? artifact.storageKey,
            thumbnailKey: artifact.thumbnailKey,
            contentHash: artifact.publishedContentHash ?? artifact.contentHash,
            fileSizeBytes: BigInt(0),
            mimeType:
              artifact.type === 'image'
                ? artifact.publishedStorageKey
                  ? 'image/png'
                  : artifactMediaType(artifact)
                : 'application/octet-stream',
            metaJson: artifact.metaJson,
            kind: 'generated',
            origin:
              artifact.originDomain === 'commerce' ? 'commerce_artifact' : 'creative_artifact',
            sourceArtifactId: artifact.id,
            status: 'ready',
          })
          .onConflictDoNothing()
          .returning();
        if (created) return assetResponse(created);
        const replay = await transaction.query.assets.findFirst({
          where: and(
            eq(assets.userId, userId),
            eq(assets.sourceArtifactId, artifact.id),
            sql`${assets.deletedAt} is null`,
          ),
        });
        if (!replay) throw new Error('Generated asset conflict did not yield a replay row');
        return assetResponse(replay);
      },
    });
  }

  async readContent(input: {
    artifactId: string;
    variant: 'original' | 'thumbnail';
    purpose: 'preview' | 'download';
    capability?: string | undefined;
    userId?: string | undefined;
    ipBucket?: string | undefined;
    ifNoneMatch?: string | undefined;
  }): Promise<
    | { notModified: true; etag: string }
    | { notModified: false; body: Buffer; mimeType: string; etag: string }
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
        decoded.resourceType !== 'artifact' ||
        decoded.resourceId !== input.artifactId ||
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
    const artifact = await this.database.query.artifacts.findFirst({
      where: and(eq(artifacts.id, input.artifactId), eq(artifacts.userId, resolvedUserId)),
    });
    if (!artifact || artifact.visibility === 'deleted') resourceError('RESOURCE_NOT_FOUND');
    if (artifact.visibility === 'quarantined') resourceError('ARTIFACT_QUARANTINED');
    if (!isReadable(artifact.visibility)) resourceError('RESOURCE_NOT_FOUND');
    const objectKey = artifactObjectKey(artifact, input.variant);
    if (!objectKey) resourceError('RESOURCE_NOT_FOUND');
    if (expectedObjectKeyDigest && expectedObjectKeyDigest !== storageObjectKeyDigest(objectKey)) {
      resourceError('RESOURCE_NOT_FOUND');
    }
    const contentHash = artifact.publishedContentHash ?? artifact.contentHash;
    // Never echo the raw object key in a header: it is an internal storage path, and
    // docs/06 forbids returning storage keys or local paths in responses.
    const representationHash =
      input.variant === 'thumbnail'
        ? canonicalSha256({
            object_key_digest: storageObjectKeyDigest(objectKey),
            revision: artifact.publicationRevision,
            source_hash: contentHash,
          })
        : (contentHash ?? storageObjectKeyDigest(objectKey));
    const etag = `"${representationHash}"`;
    if (input.ifNoneMatch === etag) {
      return { notModified: true, etag };
    }
    await this.storage.initialize();
    const body = await this.storage.read(objectKey);
    if (input.purpose === 'download' && !input.capability) {
      // Session-authenticated downloads have no mint step to audit at, so the
      // download activity lands here, on the successful delivery only. Capability
      // downloads are already audited when access-url mints the token.
      await this.database.insert(userActivityLogs).values({
        userId: resolvedUserId,
        activityType: 'download',
        targetType: 'artifact',
        targetId: artifact.id,
        metadata: { variant: input.variant },
      });
    }
    return {
      notModified: false,
      body,
      mimeType:
        input.variant === 'thumbnail'
          ? 'image/webp'
          : artifact.publishedStorageKey
            ? 'image/png'
            : artifactMediaType(artifact),
      etag,
    };
  }

  private assertStorageEnabled(): void {
    if (this.config.storage.driver !== 'local') resourceError('STORAGE_UNAVAILABLE');
  }

  private async assertMediaAccess(
    userId: string,
    ipBucket: string,
    operation: 'preview' | 'download',
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
}

function artifactObjectKey(
  artifact: typeof artifacts.$inferSelect,
  variant: 'original' | 'thumbnail',
): string | null {
  if (variant === 'thumbnail') return artifact.thumbnailKey;
  return artifact.publishedStorageKey ?? artifact.storageKey;
}

function artifactMediaType(artifact: typeof artifacts.$inferSelect): string {
  if (artifact.type !== 'image') return 'application/octet-stream';
  const mediaType = (artifact.metaJson as { media_type?: unknown }).media_type;
  return mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp'
    ? mediaType
    : 'image/webp';
}

function assetResponse(row: typeof assets.$inferSelect) {
  return {
    id: row.id,
    display_name: row.displayName,
    product_id: row.productId,
    folder_id: row.folderId,
    kind: row.kind,
    origin: row.origin,
    status: row.status,
    content_version: row.contentHash,
    preview: { variant: 'thumbnail' as const },
    created_at: row.createdAt.toISOString(),
  };
}
