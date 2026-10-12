import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assets,
  assetUploadIntents,
  createDatabaseClient,
  eq,
  inArray,
  queueDispatchIntents,
  users,
} from '@ecom-forge/db';
import type { QueuePayload } from '@ecom-forge/queue';
import { LocalPrivateStorage } from '@ecom-forge/storage';

import { AssetProcessingService } from '../src/asset/asset-processing.service.js';
import type { WorkerConfig } from '../src/config/worker-config.js';
import { WorkerWriteFence } from '../src/lifecycle/processing-fence.js';

type AssetPayload = Extract<QueuePayload, { job_type: 'asset.process' }>;

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '').toLowerCase();
if (!/_test(?:_|$)/.test(databaseName)) {
  throw new Error('S10 asset integration tests require a database name containing _test');
}

const resource = createDatabaseClient({ databaseUrl, maxConnections: 10 });
const trackedUsers = new Set<string>();
const trackedAssets = new Set<string>();
let storageRoot = '';

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    appEnv: 'test',
    databaseUrl,
    databasePoolMax: 10,
    databaseStatementTimeoutMs: 15_000,
    databaseTransactionTimeoutMs: 10_000,
    redisUrl: 'redis://127.0.0.1:6379/1',
    redisPrefix: `s10-test-${randomUUID().replaceAll('-', '')}`,
    localUploadRoot: storageRoot,
    storageEnabled: true,
    storageMaxImageBytes: 20 * 1024 * 1024,
    storageMaxImageWidth: 16_384,
    storageMaxImageHeight: 16_384,
    storageMaxImagePixels: 100_000_000,
    contentReviewDeadlineMs: 86_400_000,
    contentReviewSweepBatchSize: 50,
    outcomeUnknownReleaseDeadlineMs: 30 * 60 * 1_000,
    outcomeUnknownReleaseSweepBatchSize: 50,
    testProcessorEnabled: false,
    settlementProcessorEnabled: false,
    providerMode: 'fake',
    providerProcessorMode: 'disabled',
    providerAdapter: 'disabled',
    providerRelayOrigins: ['https://local.invalid'],
    providerImageOutputOrigins: ['https://local.invalid'],
    providerRequestTimeoutMs: 30_000,
    imageProviderRequestTimeoutMs: 180_000,
    providerImageTaskConcurrency: 9,
    agentProcessorEnabled: false,
    agentBrainAdapter: 'fake',
    agentBrainReasoningEffort: 'medium',
    providerRealPocEnabled: false,
    agentRequestTimeoutMs: 5_000,
    agentProcessingLeaseMs: 10_000,
    agentProcessingRenewMs: 2_000,
    agentProcessingRetryAttempts: 3,
    agentProcessingRetryBaseMs: 1_000,
    agentMaxLlmRounds: 6,
    agentMaxToolCalls: 12,
    agentMaxInputTokens: 96_000,
    agentMaxOutputTokens: 8_192,
    agentBrainStepMaxOutputTokens: 1_024,
    agentBrainImageMaxEdge: 1_536,
    agentBrainRetryBaseDelayMs: 1_000,
    agentBrainRetryMaxDelayMs: 8_000,
    agentBrainImageMaterializationConcurrency: 2,
    agentBrainMaxMaterializedImageBytes: 64 * 1024 * 1024,
    agentMaxEstimatedCostCny: '0.15',
    agentMaxReferences: 12,
    agentExecutionPolicyVersion: 'agent-execution-policy-v1',
    compilerQuoteTtlSeconds: 600,
    heartbeatIntervalMs: 1_000,
    heartbeatStaleMs: 3_000,
    dispatchLeaseMs: 5_000,
    dispatchLeaseRenewMs: 1_000,
    dispatchPollMs: 100,
    dispatchBatchSize: 100,
    dispatchBackoffBaseMs: 100,
    dispatchBackoffMaxMs: 1_000,
    drainTimeoutMs: 1_000,
    ...overrides,
  };
}

function payload(
  assetId: string,
  userId: string,
  operation: AssetPayload['operation'],
  operationNo = 1,
): AssetPayload {
  return {
    schema_version: 1,
    trace_id: randomUUID(),
    job_type: 'asset.process',
    asset_id: assetId,
    user_id: userId,
    operation,
    operation_no: operationNo,
    idempotency_key: `asset:${assetId}:${operation}:${operationNo}`,
  };
}

async function image(format: 'jpeg' | 'png' | 'webp', width = 24, height = 16) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 32, g: 120, b: 220 } },
  })
    [format]()
    .toBuffer();
}

async function createProcessingAsset(input: {
  bytes?: Buffer;
  declaredMimeType?: 'image/jpeg' | 'image/png' | 'image/webp';
  operationNo?: number;
}) {
  const suffix = randomUUID();
  const [user] = await resource.db
    .insert(users)
    .values({
      email: `s10-${suffix}@example.com`,
      displayName: 'S10 asset user',
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error('Failed to create S10 user');
  trackedUsers.add(user.id);

  const assetId = randomUUID();
  const storageKey = `s10/${suffix}/${assetId}/original`;
  const [asset] = await resource.db
    .insert(assets)
    .values({
      id: assetId,
      userId: user.id,
      displayName: 'fixture-image',
      storageKey,
      fileSizeBytes: BigInt(input.bytes?.length ?? 0),
      kind: 'upload',
      origin: 'upload',
      status: 'processing',
      processingRevision: input.operationNo ?? 1,
    })
    .returning();
  if (!asset) throw new Error('Failed to create S10 asset');
  trackedAssets.add(asset.id);

  await resource.db.insert(assetUploadIntents).values({
    userId: user.id,
    assetId: asset.id,
    status: 'completed',
    idempotencyKey: `s10-upload-${suffix}`,
    requestHash: createHash('sha256').update(suffix).digest('hex'),
    responseJson: { asset_id: asset.id },
    declaredMimeType: input.declaredMimeType ?? 'image/png',
    maxSizeBytes: BigInt(20 * 1024 * 1024),
    expiresAt: new Date(Date.now() + 60_000),
    completedAt: new Date(),
  });

  if (input.bytes) {
    const storage = new LocalPrivateStorage(storageRoot);
    await storage.initialize();
    await storage.write(storageKey, input.bytes);
  }
  return { user, asset };
}

async function storedAsset(assetId: string) {
  return resource.db.query.assets.findFirst({ where: eq(assets.id, assetId) });
}

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'ecom-forge-s10-'));
});

afterEach(async () => {
  const assetIds = [...trackedAssets];
  if (assetIds.length > 0) {
    await resource.db
      .delete(queueDispatchIntents)
      .where(inArray(queueDispatchIntents.aggregateId, assetIds));
    await resource.db
      .delete(assetUploadIntents)
      .where(inArray(assetUploadIntents.assetId, assetIds));
    await resource.db.delete(assets).where(inArray(assets.id, assetIds));
  }
  const userIds = [...trackedUsers];
  if (userIds.length > 0) await resource.db.delete(users).where(inArray(users.id, userIds));
  trackedAssets.clear();
  trackedUsers.clear();
  await rm(storageRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await resource.client.end();
});

describe('S10 asset processing', () => {
  it.each([
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp'],
  ] as const)('inspects and thumbnails a real %s image', async (format, mimeType) => {
    const bytes = await image(format);
    const fixture = await createProcessingAsset({ bytes, declaredMimeType: mimeType });
    const service = new AssetProcessingService(resource.db, config(), new WorkerWriteFence());

    await service.execute(payload(fixture.asset.id, fixture.user.id, 'inspect_metadata'));
    const inspected = await storedAsset(fixture.asset.id);
    expect(inspected).toMatchObject({
      status: 'processing',
      mimeType,
      fileSizeBytes: BigInt(bytes.length),
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      metaJson: { width: 24, height: 16 },
    });

    await service.execute(payload(fixture.asset.id, fixture.user.id, 'generate_thumbnail'));
    const ready = await storedAsset(fixture.asset.id);
    const expectedKey = `assets/${fixture.asset.id.slice(0, 2)}/${fixture.asset.id}/thumb-${ready?.contentHash?.slice(0, 24)}-s10v1.webp`;
    expect(ready).toMatchObject({ status: 'ready', thumbnailKey: expectedKey });
    const thumbnail = await new LocalPrivateStorage(storageRoot).read(expectedKey);
    expect((await sharp(thumbnail).metadata()).format).toBe('webp');
  });

  it('rejects a declared MIME that does not match the decoded image', async () => {
    const fixture = await createProcessingAsset({
      bytes: await image('png'),
      declaredMimeType: 'image/jpeg',
    });

    await new AssetProcessingService(resource.db, config(), new WorkerWriteFence()).execute(
      payload(fixture.asset.id, fixture.user.id, 'inspect_metadata'),
    );

    expect(await storedAsset(fixture.asset.id)).toMatchObject({
      status: 'rejected',
      processingErrorCode: 'ASSET_MIME_MISMATCH',
      thumbnailKey: null,
    });
  });

  it.each([
    ['damaged image', Buffer.from('not-an-image'), {}, 'ASSET_IMAGE_INVALID'],
    ['oversized image', Buffer.alloc(64, 1), { storageMaxImageBytes: 32 }, 'ASSET_SIZE_INVALID'],
  ] as const)('rejects a %s without scheduling a thumbnail', async (_name, bytes, limits, code) => {
    const fixture = await createProcessingAsset({ bytes, declaredMimeType: 'image/png' });
    await new AssetProcessingService(resource.db, config(limits), new WorkerWriteFence()).execute(
      payload(fixture.asset.id, fixture.user.id, 'inspect_metadata'),
    );

    expect(await storedAsset(fixture.asset.id)).toMatchObject({
      status: 'rejected',
      processingErrorCode: code,
    });
    const intents = await resource.db.query.queueDispatchIntents.findMany({
      where: eq(queueDispatchIntents.aggregateId, fixture.asset.id),
    });
    expect(intents).toHaveLength(0);
  });

  it('rejects a missing object with a stable safe error', async () => {
    const fixture = await createProcessingAsset({ declaredMimeType: 'image/png' });
    await new AssetProcessingService(resource.db, config(), new WorkerWriteFence()).execute(
      payload(fixture.asset.id, fixture.user.id, 'inspect_metadata'),
    );
    expect(await storedAsset(fixture.asset.id)).toMatchObject({
      status: 'rejected',
      processingErrorCode: 'ASSET_OBJECT_MISSING',
    });
  });

  it('keeps the original object when thumbnail generation fails', async () => {
    const bytes = await image('png', 8, 8);
    const fixture = await createProcessingAsset({ bytes, declaredMimeType: 'image/png' });
    const service = new AssetProcessingService(resource.db, config(), new WorkerWriteFence());
    await service.execute(payload(fixture.asset.id, fixture.user.id, 'inspect_metadata'));

    const failingService = new AssetProcessingService(
      resource.db,
      config({ storageMaxImagePixels: 1 }),
      new WorkerWriteFence(),
    );
    await failingService.execute(payload(fixture.asset.id, fixture.user.id, 'generate_thumbnail'));

    expect(await storedAsset(fixture.asset.id)).toMatchObject({
      status: 'processing_failed',
      processingErrorCode: 'ASSET_THUMBNAIL_FAILED',
    });
    expect(await new LocalPrivateStorage(storageRoot).read(fixture.asset.storageKey)).toEqual(
      bytes,
    );
  });

  it('ignores stale operations and converges repeated thumbnail work to one key', async () => {
    const fixture = await createProcessingAsset({
      bytes: await image('webp'),
      declaredMimeType: 'image/webp',
      operationNo: 2,
    });
    const service = new AssetProcessingService(resource.db, config(), new WorkerWriteFence());

    await service.execute(payload(fixture.asset.id, fixture.user.id, 'inspect_metadata', 1));
    expect(await storedAsset(fixture.asset.id)).toMatchObject({
      contentHash: null,
      status: 'processing',
    });

    await service.execute(payload(fixture.asset.id, fixture.user.id, 'inspect_metadata', 2));
    await Promise.all([
      service.execute(payload(fixture.asset.id, fixture.user.id, 'generate_thumbnail', 2)),
      service.execute(payload(fixture.asset.id, fixture.user.id, 'generate_thumbnail', 2)),
    ]);
    const ready = await storedAsset(fixture.asset.id);
    expect(ready?.status).toBe('ready');
    expect(ready?.thumbnailKey).toBe(
      `assets/${fixture.asset.id.slice(0, 2)}/${fixture.asset.id}/thumb-${ready?.contentHash?.slice(0, 24)}-s10v1.webp`,
    );
  });
});
