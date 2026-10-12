import { createHash, randomUUID } from 'node:crypto';

import type { Database } from '@ecom-forge/db';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerConfig } from '../config/worker-config.js';
import { AgentImageContextService } from './agent-image-context.service.js';
import type { ClaimedAgentTurn } from './agent-turn.types.js';

const storage = vi.hoisted(() => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  read: vi.fn(),
}));

vi.mock('@ecom-forge/storage', () => ({
  LocalPrivateStorage: class {
    initialize = storage.initialize;
    read = storage.read;
  },
}));

describe('AgentImageContextService', () => {
  const userId = randomUUID();
  const assetId = randomUUID();
  const productId = randomUUID();
  const factSetId = randomUUID();
  const findAsset = vi.fn();
  const findArtifact = vi.fn();
  const findProduct = vi.fn();
  const findFactSet = vi.fn();
  const database = {
    query: {
      assets: { findFirst: findAsset },
      artifacts: { findFirst: findArtifact },
      products: { findFirst: findProduct },
      productFactSets: { findFirst: findFactSet },
    },
  } as unknown as Database;
  const config = {
    localUploadRoot: 'test-only',
    storageEnabled: true,
    storageMaxImageBytes: 20 * 1024 * 1024,
    storageMaxImageWidth: 16_384,
    storageMaxImageHeight: 16_384,
    storageMaxImagePixels: 100_000_000,
    agentBrainImageMaxEdge: 4_096,
  } as WorkerConfig;

  let bytes: Uint8Array;
  let contentHash: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    bytes = await sharp({
      create: { width: 16, height: 12, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    contentHash = createHash('sha256').update(bytes).digest('hex');
    storage.read.mockResolvedValue(bytes);
    findAsset.mockResolvedValue({
      id: assetId,
      userId,
      productId: null,
      status: 'ready',
      storageKey: 'private/source.png',
      contentHash,
      mimeType: 'image/png',
      metaJson: { width: 16, height: 12 },
    });
    findArtifact.mockResolvedValue(undefined);
    findProduct.mockResolvedValue(undefined);
    findFactSet.mockResolvedValue(undefined);
  });

  it('treats a current user upload as authorized by default after ownership, version, hash, and MIME checks', async () => {
    const result = await new AgentImageContextService(database, config).resolveImages(
      claimedTurn(userId, assetId, contentHash),
      new AbortController().signal,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      binding_key: 'input-1',
      image_ref: 'input-1',
      role: 'product',
      media_type: 'image/png',
      width: 16,
      height: 12,
      content_hash: contentHash,
    });
    expect(result[0]?.bytes).toBeUndefined();
    expect(storage.read).not.toHaveBeenCalled();
  });

  it('rejects a cross-user row before reading private storage', async () => {
    findAsset.mockResolvedValue({
      id: assetId,
      userId: randomUUID(),
      status: 'ready',
      storageKey: 'private/source.png',
      contentHash,
    });

    await expect(
      new AgentImageContextService(database, config).resolveImages(
        claimedTurn(userId, assetId, contentHash),
        new AbortController().signal,
      ),
    ).rejects.toThrow('AGENT_IMAGE_BINDING_INVALID');
    expect(storage.read).not.toHaveBeenCalled();
  });

  it('keeps legacy image bindings usable when stored metadata is missing', async () => {
    findAsset.mockResolvedValue({
      id: assetId,
      userId,
      status: 'ready',
      storageKey: 'private/source.png',
      contentHash,
      mimeType: null,
      metaJson: {},
    });

    const result = await new AgentImageContextService(database, config).resolveImages(
      claimedTurn(userId, assetId, contentHash),
      new AbortController().signal,
    );

    expect(result[0]).toMatchObject({ binding_key: 'input-1', content_hash: contentHash });
    expect(result[0]?.media_type).toBeUndefined();
    expect(result[0]?.width).toBeUndefined();
    expect(result[0]?.height).toBeUndefined();
    expect(storage.read).not.toHaveBeenCalled();
  });

  it('rejects malformed stored metadata instead of treating it as missing', async () => {
    findAsset.mockResolvedValue({
      id: assetId,
      userId,
      status: 'ready',
      storageKey: 'private/source.png',
      contentHash,
      mimeType: 'image/png',
      metaJson: { width: 0, height: 12 },
    });

    await expect(
      new AgentImageContextService(database, config).resolveImages(
        claimedTurn(userId, assetId, contentHash),
        new AbortController().signal,
      ),
    ).rejects.toThrow('AGENT_IMAGE_METADATA_INVALID');
    expect(storage.read).not.toHaveBeenCalled();
  });

  it('loads frozen session candidates with their lineage metadata', async () => {
    const claimed = claimedTurn(userId, assetId, contentHash);
    claimed.attachments = [];
    claimed.sessionImageCandidates = [
      {
        binding_key: 'session-source-1',
        kind: 'asset',
        object_id: assetId,
        object_version: contentHash,
        content_hash: contentHash,
        owner_user_id: userId,
        readable: true,
        mutable: false,
        producer_mode: null,
        producer_session_id: null,
        mutation_owner: null,
        source_action: null,
        media_type: 'image',
        lifecycle: 'active',
        visibility: 'private',
        role: 'semantic_reference',
        position: 0,
        publication_revision: null,
        candidate_kind: 'original_source',
        candidate_position: 1,
        lineage_source_binding_keys: [],
      },
    ];

    const result = await new AgentImageContextService(database, config).resolveImages(
      claimed,
      new AbortController().signal,
    );

    expect(result[0]).toMatchObject({
      binding_key: 'session-source-1',
      context_scope: 'session_candidate',
      candidate_kind: 'original_source',
      candidate_position: 1,
      lineage_source_binding_keys: [],
    });
  });

  it('rejects content hash drift when inspect_image materializes the source', async () => {
    const service = new AgentImageContextService(database, config);
    const claimed = claimedTurn(userId, assetId, contentHash);
    const [image] = await service.resolveImages(claimed, new AbortController().signal);
    storage.read.mockResolvedValue(new Uint8Array([1, 2, 3]));

    await expect(
      service.resolveImage(claimed, image!, 'overview', new AbortController().signal),
    ).rejects.toThrow('AGENT_IMAGE_HASH_DRIFT');
  });

  it('keeps small images unchanged for Brain input', async () => {
    const result = await new AgentImageContextService(database, config).resolveImages(
      claimedTurn(userId, assetId, contentHash),
      new AbortController().signal,
    );

    expect(result[0]).toMatchObject({
      media_type: 'image/png',
      width: 16,
      height: 12,
      content_hash: contentHash,
    });
    expect(result[0]?.bytes).toBeUndefined();
  });

  it('creates an uncropped, aspect-ratio-preserving Brain preview for large images', async () => {
    bytes = await sharp({
      create: { width: 2_048, height: 1_536, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    contentHash = createHash('sha256').update(bytes).digest('hex');
    storage.read.mockResolvedValue(bytes);
    findAsset.mockResolvedValue({
      id: assetId,
      userId,
      productId: null,
      status: 'ready',
      storageKey: 'private/source.png',
      contentHash,
      mimeType: 'image/png',
      metaJson: { width: 2_048, height: 1_536 },
    });

    const testConfig = { ...config, agentBrainImageMaxEdge: 1_024 };
    const result = await new AgentImageContextService(database, testConfig).resolveImages(
      claimedTurn(userId, assetId, contentHash),
      new AbortController().signal,
    );
    const image = result[0];
    const prepared = await new AgentImageContextService(database, testConfig).resolveImage(
      claimedTurn(userId, assetId, contentHash),
      image!,
      'overview',
      new AbortController().signal,
    );
    const preparedDetail = await new AgentImageContextService(database, {
      ...testConfig,
      agentBrainImageMaxEdge: 4_096,
    }).resolveImage(
      claimedTurn(userId, assetId, contentHash),
      image!,
      'detail',
      new AbortController().signal,
    );
    const previewMetadata = await sharp(prepared.bytes).metadata();
    const detailMetadata = await sharp(preparedDetail.bytes).metadata();

    expect(image).toMatchObject({
      media_type: 'image/png',
      width: 2_048,
      height: 1_536,
      content_hash: contentHash,
    });
    expect(previewMetadata).toMatchObject({ format: 'webp', width: 1_024, height: 768 });
    expect(detailMetadata).toMatchObject({ format: 'png', width: 2_048, height: 1_536 });
    expect(prepared.bytes).not.toEqual(bytes);
  });

  it('injects only a validated latest confirmed fact snapshot', async () => {
    findAsset.mockResolvedValue({
      id: assetId,
      userId,
      productId,
      status: 'ready',
      storageKey: 'private/source.png',
      contentHash,
    });
    findProduct.mockResolvedValue({
      id: productId,
      userId,
      status: 'active',
      latestFactSetId: factSetId,
    });
    findFactSet.mockResolvedValue({
      id: factSetId,
      userId,
      productId,
      versionNo: 1,
      sourceAssetId: assetId,
      sourceVersion: contentHash,
      factsJson: {
        product_name: '白色马克杯',
        primary_colors: ['白色'],
        logos: [],
        visible_text: [],
        materials: ['陶瓷'],
        must_preserve: ['杯柄结构'],
        unknown_fields: ['品牌'],
      },
    });

    const result = await new AgentImageContextService(
      database,
      config,
    ).resolveConfirmedProductFactsContext(claimedTurn(userId, assetId, contentHash));
    expect(result?.facts.source_binding_key).toBe('input-1');
    expect(result?.facts.facts.product_name).toBe('白色马克杯');
    expect(result?.dependency.object_id).toBe(factSetId);
  });
});

function claimedTurn(userId: string, assetId: string, contentHash: string): ClaimedAgentTurn {
  return {
    userId,
    attachments: [
      {
        binding_key: 'input-1',
        kind: 'asset',
        object_id: assetId,
        object_version: contentHash,
        content_hash: contentHash,
        owner_user_id: userId,
        readable: true,
        mutable: false,
        producer_mode: null,
        producer_session_id: null,
        mutation_owner: null,
        source_action: null,
        media_type: 'image',
        lifecycle: 'active',
        visibility: 'private',
        role: 'product',
        position: 0,
      },
    ],
  } as ClaimedAgentTurn;
}
