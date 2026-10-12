import { createHash } from 'node:crypto';

import {
  agentConfirmedFactDependencySchema,
  agentProductFactsCandidateSchema,
  type AgentBrainImagePayload,
  type AgentBrainStepInput,
} from '@ecom-forge/agent';
import { artifacts, assets, eq, productFactSets, products, type Database } from '@ecom-forge/db';
import type { AttachmentSnapshot } from '@ecom-forge/compiler';
import { canonicalSha256 } from '@ecom-forge/shared';
import type { z } from 'zod';
import { LocalPrivateStorage } from '@ecom-forge/storage';
import sharp from 'sharp';

import type { WorkerConfig } from '../config/worker-config.js';
import type { ClaimedAgentTurn } from './agent-turn.types.js';

export class AgentImageContextService {
  private readonly storage: LocalPrivateStorage;

  constructor(
    private readonly database: Database,
    private readonly config: WorkerConfig,
  ) {
    this.storage = new LocalPrivateStorage(config.localUploadRoot);
  }

  async resolveImages(
    claimed: ClaimedAgentTurn,
    signal: AbortSignal,
  ): Promise<AgentBrainStepInput['authorized_images']> {
    const bindings = [...claimed.attachments, ...(claimed.sessionImageCandidates ?? [])];
    if (bindings.length === 0) return [];
    if (!this.config.storageEnabled || signal.aborted) {
      throw new Error('AGENT_IMAGE_CONTEXT_UNAVAILABLE');
    }
    const resolved: AgentBrainStepInput['authorized_images'] = [];
    const sessionCandidateByKey = new Map(
      (claimed.sessionImageCandidates ?? []).map((candidate) => [candidate.binding_key, candidate]),
    );
    for (const binding of bindings.sort(
      (left, right) =>
        left.position - right.position || left.binding_key.localeCompare(right.binding_key),
    )) {
      if (
        binding.owner_user_id !== claimed.userId ||
        !binding.readable ||
        binding.media_type !== 'image' ||
        binding.lifecycle !== 'active' ||
        binding.visibility === 'deleted' ||
        binding.visibility === 'quarantined'
      ) {
        throw new Error('AGENT_IMAGE_BINDING_INVALID');
      }
      const image = await this.resolveImageMetadata(claimed, binding);
      const sessionCandidate = sessionCandidateByKey.get(binding.binding_key);
      resolved.push({
        binding_key: binding.binding_key,
        image_ref: binding.binding_key,
        role: binding.role,
        ...(image.mediaType ? { media_type: image.mediaType } : {}),
        ...(image.width !== undefined ? { width: image.width } : {}),
        ...(image.height !== undefined ? { height: image.height } : {}),
        content_hash: binding.content_hash,
        context_scope: sessionCandidate ? 'session_candidate' : 'current_attachment',
        ...(sessionCandidate
          ? {
              candidate_kind: sessionCandidate.candidate_kind,
              candidate_position: sessionCandidate.candidate_position,
              lineage_source_binding_keys: sessionCandidate.lineage_source_binding_keys,
              ...(sessionCandidate.source_group
                ? { source_group: sessionCandidate.source_group }
                : {}),
            }
          : {}),
      });
    }
    return resolved;
  }

  async resolveImage(
    claimed: ClaimedAgentTurn,
    image: AgentBrainStepInput['authorized_images'][number],
    detail: 'overview' | 'detail',
    signal: AbortSignal,
  ): Promise<AgentBrainImagePayload> {
    const binding = [...claimed.attachments, ...(claimed.sessionImageCandidates ?? [])].find(
      (candidate) => candidate.binding_key === image.binding_key,
    );
    if (!binding || (image.image_ref ?? image.binding_key) !== binding.binding_key) {
      throw new Error('AGENT_IMAGE_BINDING_INVALID');
    }
    const source = await this.readValidatedImage(claimed, binding, signal);
    // Both modes are bounded. Overview is intentionally cheaper; detail can use the configured
    // maximum edge but never grants access to an unbounded source file or caller-provided path.
    const maxEdge =
      detail === 'detail'
        ? this.config.agentBrainImageMaxEdge
        : Math.min(1_536, this.config.agentBrainImageMaxEdge);
    return prepareBrainImage(source.bytes, source.mediaType, source.width, source.height, maxEdge);
  }

  async resolveConfirmedProductFactsContext(claimed: ClaimedAgentTurn): Promise<
    | {
        facts: NonNullable<AgentBrainStepInput['confirmed_product_facts']>;
        dependency: z.infer<typeof agentConfirmedFactDependencySchema>;
      }
    | undefined
  > {
    const binding = [...claimed.attachments, ...(claimed.sessionImageCandidates ?? [])]
      .sort((left, right) => left.position - right.position)
      .find((item) => item.kind === 'asset' && item.role === 'product');
    if (!binding) return undefined;
    const source = await this.database.query.assets.findFirst({
      where: eq(assets.id, binding.object_id),
    });
    if (
      !source ||
      source.userId !== claimed.userId ||
      source.status !== 'ready' ||
      source.contentHash !== binding.content_hash ||
      !source.productId
    ) {
      return undefined;
    }
    const product = await this.database.query.products.findFirst({
      where: eq(products.id, source.productId),
    });
    if (
      !product ||
      product.userId !== claimed.userId ||
      product.status !== 'active' ||
      !product.latestFactSetId
    ) {
      return undefined;
    }
    const factSet = await this.database.query.productFactSets.findFirst({
      where: eq(productFactSets.id, product.latestFactSetId),
    });
    if (!factSet || factSet.userId !== claimed.userId || factSet.productId !== product.id) {
      return undefined;
    }
    const facts = agentProductFactsCandidateSchema.parse(factSet.factsJson);
    const dependency = agentConfirmedFactDependencySchema.parse({
      kind: 'product_fact_set',
      object_id: factSet.id,
      object_version: String(factSet.versionNo),
      content_hash: canonicalSha256(facts),
      owner_user_id: claimed.userId,
      product_id: product.id,
      source_asset_id: factSet.sourceAssetId,
      source_version: factSet.sourceVersion,
    });
    return {
      facts: { source_binding_key: binding.binding_key, facts },
      dependency,
    };
  }

  private async resolveStorageKey(
    claimed: ClaimedAgentTurn,
    binding: AttachmentSnapshot,
  ): Promise<string> {
    if (binding.kind === 'asset') {
      const row = await this.database.query.assets.findFirst({
        where: eq(assets.id, binding.object_id),
      });
      if (
        !row ||
        row.userId !== claimed.userId ||
        row.status !== 'ready' ||
        row.contentHash !== binding.content_hash ||
        binding.object_version !== row.contentHash
      ) {
        throw new Error('AGENT_IMAGE_BINDING_INVALID');
      }
      return row.storageKey;
    }
    const row = await this.database.query.artifacts.findFirst({
      where: eq(artifacts.id, binding.object_id),
    });
    if (
      !row ||
      row.userId !== claimed.userId ||
      row.visibility === 'deleted' ||
      row.visibility === 'quarantined' ||
      binding.object_version !== binding.content_hash
    ) {
      throw new Error('AGENT_IMAGE_BINDING_INVALID');
    }
    if (row.publishedContentHash === binding.content_hash && row.publishedStorageKey) {
      return row.publishedStorageKey;
    }
    if (row.contentHash === binding.content_hash) return row.storageKey;
    throw new Error('AGENT_IMAGE_BINDING_INVALID');
  }

  private async resolveImageMetadata(
    claimed: ClaimedAgentTurn,
    binding: AttachmentSnapshot,
  ): Promise<{
    mediaType?: 'image/jpeg' | 'image/png' | 'image/webp';
    width?: number;
    height?: number;
  }> {
    if (binding.kind === 'asset') {
      const row = await this.database.query.assets.findFirst({
        where: eq(assets.id, binding.object_id),
      });
      if (
        !row ||
        row.userId !== claimed.userId ||
        row.status !== 'ready' ||
        row.contentHash !== binding.content_hash ||
        binding.object_version !== row.contentHash
      ) {
        throw new Error('AGENT_IMAGE_BINDING_INVALID');
      }
      return parseStoredImageMetadata(row.mimeType, row.metaJson, this.config);
    }

    const row = await this.database.query.artifacts.findFirst({
      where: eq(artifacts.id, binding.object_id),
    });
    if (
      !row ||
      row.userId !== claimed.userId ||
      row.type !== 'image' ||
      row.visibility === 'deleted' ||
      row.visibility === 'quarantined' ||
      binding.object_version !== binding.content_hash ||
      (row.publishedContentHash !== binding.content_hash &&
        row.contentHash !== binding.content_hash)
    ) {
      throw new Error('AGENT_IMAGE_BINDING_INVALID');
    }
    const mediaType = row.publishedContentHash === binding.content_hash ? 'image/png' : undefined;
    return parseStoredImageMetadata(
      mediaType ?? artifactMediaType(row.metaJson),
      row.metaJson,
      this.config,
    );
  }

  private async readValidatedImage(
    claimed: ClaimedAgentTurn,
    binding: AttachmentSnapshot,
    signal: AbortSignal,
  ): Promise<{
    bytes: Uint8Array;
    mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
    width: number;
    height: number;
  }> {
    if (signal.aborted) throw new Error('AGENT_IMAGE_CONTEXT_UNAVAILABLE');
    if (
      binding.owner_user_id !== claimed.userId ||
      !binding.readable ||
      binding.media_type !== 'image' ||
      binding.lifecycle !== 'active' ||
      binding.visibility === 'deleted' ||
      binding.visibility === 'quarantined'
    ) {
      throw new Error('AGENT_IMAGE_BINDING_INVALID');
    }
    const storageKey = await this.resolveStorageKey(claimed, binding);
    await this.storage.initialize();
    const bytes = await this.storage.read(storageKey);
    if (signal.aborted) throw new Error('AGENT_IMAGE_CONTEXT_UNAVAILABLE');
    if (bytes.byteLength === 0 || bytes.byteLength > this.config.storageMaxImageBytes) {
      throw new Error('AGENT_IMAGE_SIZE_LIMIT_EXCEEDED');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== binding.content_hash) {
      throw new Error('AGENT_IMAGE_HASH_DRIFT');
    }
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
    const mediaType = imageMediaType(metadata.format);
    const width = metadata.width;
    const height = metadata.height;
    if (
      !mediaType ||
      !width ||
      !height ||
      width > this.config.storageMaxImageWidth ||
      height > this.config.storageMaxImageHeight ||
      width * height > this.config.storageMaxImagePixels
    ) {
      throw new Error('AGENT_IMAGE_FORMAT_INVALID');
    }
    return { bytes, mediaType, width, height };
  }
}

function parseStoredImageMetadata(
  mediaType: unknown,
  metaJson: unknown,
  config: WorkerConfig,
): {
  mediaType?: 'image/jpeg' | 'image/png' | 'image/webp';
  width?: number;
  height?: number;
} {
  const mediaTypeMissing = mediaType === null || mediaType === undefined;
  const normalizedMediaType =
    mediaType === 'image/jpeg' || mediaType === 'image/png' || mediaType === 'image/webp'
      ? mediaType
      : undefined;
  const metadata =
    metaJson !== null && typeof metaJson === 'object' && !Array.isArray(metaJson)
      ? (metaJson as { width?: unknown; height?: unknown })
      : {};
  const width = readStoredDimension(metadata.width, config.storageMaxImageWidth);
  const height = readStoredDimension(metadata.height, config.storageMaxImageHeight);
  if (
    (!mediaTypeMissing && !normalizedMediaType) ||
    width === 'invalid' ||
    height === 'invalid' ||
    (width !== undefined && height !== undefined && width * height > config.storageMaxImagePixels)
  ) {
    throw new Error('AGENT_IMAGE_METADATA_INVALID');
  }
  return {
    ...(normalizedMediaType ? { mediaType: normalizedMediaType } : {}),
    ...(typeof width === 'number' ? { width } : {}),
    ...(typeof height === 'number' ? { height } : {}),
  };
}

function readStoredDimension(value: unknown, max: number): number | 'invalid' | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) <= 0 || Number(value) > max) return 'invalid';
  return Number(value);
}

function artifactMediaType(metaJson: unknown): unknown {
  return metaJson !== null && typeof metaJson === 'object' && !Array.isArray(metaJson)
    ? (metaJson as { media_type?: unknown }).media_type
    : undefined;
}

async function prepareBrainImage(
  bytes: Uint8Array,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
  width: number,
  height: number,
  maxEdge: number,
): Promise<{
  bytes: Uint8Array;
  media_type: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
}> {
  if (Math.max(width, height) <= maxEdge) {
    return { bytes, media_type: mediaType, width, height };
  }

  const preview = await sharp(bytes, { failOn: 'error' })
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer({ resolveWithObject: true });

  return {
    bytes: preview.data,
    media_type: 'image/webp',
    width: preview.info.width,
    height: preview.info.height,
  };
}

function imageMediaType(
  format: string | undefined,
): 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  return undefined;
}
