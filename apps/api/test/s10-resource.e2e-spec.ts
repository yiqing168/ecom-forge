import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  and,
  assets,
  assetUploadIntents,
  artifacts,
  agentTurns,
  chatMessages,
  chatSessions,
  createDatabaseClient,
  eq,
  inArray,
  productFactSets,
  products,
  queueDispatchIntents,
  resourceWriteRequests,
  sql,
  storageChannels,
  storageCredentialVersions,
  storageRuntimeState,
  tasks,
  userActivityLogs,
  users,
  workflowRuns,
} from '@ecom-forge/db';
import {
  LocalPrivateStorage,
  StorageCapabilityCodec,
  storageObjectKeyDigest,
} from '@ecom-forge/storage';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadAppConfig } from '../src/config/app-config.js';
import { APP_CONFIG } from '../src/config/config.module.js';
import { configureBodyParsers } from '../src/configure-body-parsers.js';
import { AbuseProtectionService } from '../src/modules/auth/abuse-protection.service.js';
import { AuthenticationService } from '../src/modules/auth/authentication.service.js';
import { AuthWriteGuard } from '../src/modules/auth/auth-write.guard.js';
import { AssetController } from '../src/modules/resource/asset.controller.js';
import { AssetService } from '../src/modules/resource/asset.service.js';
import { AssetWriteGuard } from '../src/modules/resource/asset-write.guard.js';
import { ArtifactController } from '../src/modules/resource/artifact.controller.js';
import { ArtifactService } from '../src/modules/resource/artifact.service.js';
import { ProductController } from '../src/modules/resource/product.controller.js';
import { ProductService } from '../src/modules/resource/product.service.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '').toLowerCase();
if (!/_test(?:_|$)/.test(databaseName)) {
  throw new Error('S10 resource integration tests require a database name containing _test');
}

const resource = createDatabaseClient({ databaseUrl, maxConnections: 20 });
const storageRoot = resolve(tmpdir(), `ecom-forge-s10-${randomUUID()}`);
const config = { ...loadAppConfig(), localUploadRoot: storageRoot };
const productService = new ProductService(
  resource.db,
  config.resourceCursorSecret,
  config.resourceIdempotencySecret,
);
const assetService = new AssetService(resource.db, config);
const artifactService = new ArtifactService(resource.db, config);
const storage = new LocalPrivateStorage(storageRoot);
const trackedUsers = new Set<string>();
const trackedStorageChannels = new Map<string, string>();
let sessionUserId: string | null = null;
let app: INestApplication;

interface ProductResponse {
  data: { id: string; revision: number; sku_code: string | null };
}

interface UploadResponse {
  data: {
    upload_id: string;
    asset_id: string;
    upload: { url: string };
  };
}

interface FactResponse {
  data: { id: string; version_no: number; facts: Record<string, unknown> };
}

interface RetryResponse {
  data: { processing_revision: number; status: string };
}

interface AccessResponse {
  data: { url: string };
}

function authenticated(requestBuilder: request.Test): request.Test {
  return requestBuilder.set('Origin', config.webOrigin).set('Host', `localhost:${config.apiPort}`);
}

async function createUser(label: string) {
  const [user] = await resource.db
    .insert(users)
    .values({
      email: `s10-resource-${label}-${randomUUID()}@example.com`,
      displayName: 'S10 resource user',
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error('Failed to create S10 resource user');
  trackedUsers.add(user.id);
  return user;
}

async function createAsset(
  userId: string,
  status: 'ready' | 'processing' | 'processing_failed' = 'ready',
) {
  const id = randomUUID();
  const storageKey = `s10-tests/${userId}/${id}/original`;
  const thumbnailKey = `s10-tests/${userId}/${id}/thumbnail.webp`;
  const body = Buffer.from(`s10-${id}`);
  if (status === 'ready') {
    await storage.initialize();
    await storage.write(storageKey, body);
    await storage.write(thumbnailKey, body);
  }
  const [asset] = await resource.db
    .insert(assets)
    .values({
      id,
      userId,
      displayName: 's10-resource.png',
      storageKey,
      thumbnailKey: status === 'ready' ? thumbnailKey : null,
      contentHash: status === 'ready' ? createHash('sha256').update(body).digest('hex') : null,
      fileSizeBytes: BigInt(body.length),
      mimeType: status === 'ready' ? 'image/png' : null,
      metaJson: status === 'ready' ? { width: 1, height: 1 } : {},
      kind: 'upload',
      origin: 'upload',
      status,
      processingErrorCode: status === 'processing_failed' ? 'THUMBNAIL_FAILED' : null,
    })
    .returning();
  if (!asset) throw new Error('Failed to create S10 resource asset');
  return { asset, body };
}

async function createArtifact(userId: string, visibility: 'private' | 'quarantined' = 'private') {
  const id = randomUUID();
  const storageKey = `s10-tests/artifacts/${id}/original.webp`;
  const thumbnailKey = `s10-tests/artifacts/${id}/thumbnail.webp`;
  const body = Buffer.from(`artifact-${id}`);
  await storage.initialize();
  await storage.write(storageKey, body);
  await storage.write(thumbnailKey, body);
  const [workflow] = await resource.db
    .insert(workflowRuns)
    .values({
      userId,
      triggerMode: 'chat',
      status: 'succeeded',
      planSnapshot: {},
      skillSnapshot: {},
      pricingSnapshot: {},
      finishedAt: new Date(),
    })
    .returning();
  if (!workflow) throw new Error('Failed to create S10 artifact workflow');
  const [task] = await resource.db
    .insert(tasks)
    .values({
      workflowRunId: workflow.id,
      type: 'image.generate',
      status: 'succeeded',
      costEstimate: '0.00',
      costActual: '0.00',
      idempotencyKey: `s10-artifact-task-${randomUUID()}`,
      dagNodeId: 'generate-image',
      dagJson: {},
      paramsSnapshot: {},
      endedAt: new Date(),
    })
    .returning();
  if (!task) throw new Error('Failed to create S10 artifact task');
  await resource.db.insert(artifacts).values({
    id,
    taskId: task.id,
    userId,
    type: 'image',
    storageKey,
    contentHash: createHash('sha256').update(body).digest('hex'),
    thumbnailKey,
    metaJson: { media_type: 'image/png' },
    paramsSnapshot: {},
    sourceAction: 'generate',
    originDomain: 'creative',
    producerMode: 'canvas',
    mutationOwner: 'canvas',
    visibility,
  });
  return { artifactId: id, body, storageKey, thumbnailKey };
}

async function cleanupUser(userId: string): Promise<void> {
  const userAssets = await resource.db.query.assets.findMany({
    where: eq(assets.userId, userId),
    columns: { id: true },
  });
  const assetIds = userAssets.map(({ id }) => id);
  await resource.db
    .update(products)
    .set({ primaryAssetId: null, latestFactSetId: null })
    .where(eq(products.userId, userId));
  await resource.db.delete(productFactSets).where(eq(productFactSets.userId, userId));
  if (assetIds.length > 0) {
    await resource.db
      .delete(queueDispatchIntents)
      .where(inArray(queueDispatchIntents.aggregateId, assetIds));
  }
  await resource.db.delete(userActivityLogs).where(eq(userActivityLogs.userId, userId));
  await resource.db.delete(assetUploadIntents).where(eq(assetUploadIntents.userId, userId));
  await resource.db.delete(resourceWriteRequests).where(eq(resourceWriteRequests.userId, userId));
  await resource.db.delete(assets).where(eq(assets.userId, userId));
  await resource.db.delete(artifacts).where(eq(artifacts.userId, userId));
  const userWorkflows = await resource.db.query.workflowRuns.findMany({
    where: eq(workflowRuns.userId, userId),
    columns: { id: true },
  });
  const workflowIds = userWorkflows.map(({ id }) => id);
  if (workflowIds.length > 0) {
    await resource.db.delete(tasks).where(inArray(tasks.workflowRunId, workflowIds));
    await resource.db.delete(workflowRuns).where(inArray(workflowRuns.id, workflowIds));
  }
  const userSessions = await resource.db.query.chatSessions.findMany({
    where: eq(chatSessions.userId, userId),
    columns: { id: true },
  });
  const sessionIds = userSessions.map(({ id }) => id);
  if (sessionIds.length > 0) {
    await resource.db.delete(chatMessages).where(inArray(chatMessages.sessionId, sessionIds));
    await resource.db.delete(agentTurns).where(inArray(agentTurns.sessionId, sessionIds));
    await resource.db.delete(chatSessions).where(inArray(chatSessions.id, sessionIds));
  }
  await resource.db.delete(products).where(eq(products.userId, userId));
  await resource.db.delete(users).where(eq(users.id, userId));
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProductController, AssetController, ArtifactController],
    providers: [
      AuthWriteGuard,
      AssetWriteGuard,
      { provide: APP_CONFIG, useValue: config },
      { provide: ProductService, useValue: productService },
      { provide: AssetService, useValue: assetService },
      { provide: ArtifactService, useValue: artifactService },
      {
        provide: AuthenticationService,
        useValue: {
          currentSession: () =>
            Promise.resolve(
              sessionUserId
                ? {
                    user: { id: sessionUserId },
                    headers: new Headers(),
                    access: {
                      canCreate: true,
                      canUpload: true,
                      canCharge: true,
                      restrictionReason: null,
                    },
                  }
                : null,
            ),
        },
      },
      {
        provide: AbuseProtectionService,
        useValue: {
          assertMediaRequest: () => Promise.resolve(),
          // Capability-authorised byte reads use their own budget (see
          // AbuseProtectionService.assertMediaContentRequest).
          assertMediaContentRequest: () => Promise.resolve(),
        },
      },
    ],
  }).compile();
  const expressApp = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    rawBody: true,
  });
  configureBodyParsers(expressApp, 65_536, config.storage.maxImageBytes);
  app = expressApp;
  await app.init();
});

afterEach(async () => {
  sessionUserId = null;
  for (const userId of trackedUsers) await cleanupUser(userId);
  trackedUsers.clear();
  if (trackedStorageChannels.size > 0) {
    await resource.db
      .delete(storageRuntimeState)
      .where(eq(storageRuntimeState.purpose, 'private_assets'));
    for (const [channelId, credentialId] of trackedStorageChannels) {
      await resource.db
        .update(storageChannels)
        .set({ activeCredentialVersionId: null })
        .where(eq(storageChannels.id, channelId));
      await resource.db
        .delete(storageCredentialVersions)
        .where(eq(storageCredentialVersions.id, credentialId));
      await resource.db.delete(storageChannels).where(eq(storageChannels.id, channelId));
    }
    trackedStorageChannels.clear();
  }
});

afterAll(async () => {
  await app.close();
  await resource.client.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('S10 resource API integration', () => {
  it('normalizes SKU and rejects duplicate, stale, and cross-user product operations', async () => {
    const owner = await createUser('product-owner');
    const other = await createUser('product-other');
    sessionUserId = owner.id;
    const server = app.getHttpServer() as Server;

    const first = await authenticated(request(server).post('/api/v1/products'))
      .set('Idempotency-Key', `s10-product-${randomUUID()}`)
      .send({ name: '第一件商品', sku_code: ' sku-01 ' })
      .expect(201);
    const firstBody = first.body as unknown as ProductResponse;
    expect(firstBody.data).toMatchObject({ sku_code: 'SKU-01', revision: 1 });

    const duplicate = await authenticated(request(server).post('/api/v1/products'))
      .set('Idempotency-Key', `s10-product-${randomUUID()}`)
      .send({ name: '重复 SKU', sku_code: 'ＳＫＵ－０１' })
      .expect(409);
    expect(duplicate.body).toMatchObject({ error: { code: 'PRODUCT_SKU_CONFLICT' } });

    const second = await authenticated(request(server).post('/api/v1/products'))
      .set('Idempotency-Key', `s10-product-${randomUUID()}`)
      .send({ name: '第二件商品', sku_code: 'SKU-02' })
      .expect(201);
    const secondId = (second.body as unknown as ProductResponse).data.id;
    const updateConflict = await authenticated(
      request(server).patch(`/api/v1/products/${secondId}`),
    )
      .set('Idempotency-Key', `s10-product-${randomUUID()}`)
      .send({ revision: 1, sku_code: 'sku-01' })
      .expect(409);
    expect(updateConflict.body).toMatchObject({ error: { code: 'PRODUCT_SKU_CONFLICT' } });

    const firstId = firstBody.data.id;
    await authenticated(request(server).patch(`/api/v1/products/${firstId}`))
      .set('Idempotency-Key', `s10-product-${randomUUID()}`)
      .send({ revision: 1, name: '新名称' })
      .expect(200);
    const stale = await authenticated(request(server).patch(`/api/v1/products/${firstId}`))
      .set('Idempotency-Key', `s10-product-${randomUUID()}`)
      .send({ revision: 1, name: '过期修改' })
      .expect(409);
    expect(stale.body).toMatchObject({ error: { code: 'PRODUCT_REVISION_CONFLICT' } });

    sessionUserId = other.id;
    const hidden = await request(server).get(`/api/v1/products/${firstId}`).expect(404);
    expect(hidden.body).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });
  });

  it('replays upload creation and concurrent completion exactly once', async () => {
    await resource.db
      .delete(storageRuntimeState)
      .where(eq(storageRuntimeState.purpose, 'private_assets'));
    const user = await createUser('upload');
    sessionUserId = user.id;
    const server = app.getHttpServer() as Server;
    const key = `s10-upload-${randomUUID()}`;
    const input = {
      display_name: 'fixture.png',
      declared_mime_type: 'image/png',
      file_size_bytes: 68,
    };

    const create = () =>
      authenticated(request(server).post('/api/v1/assets/upload-url'))
        .set('Idempotency-Key', key)
        .send(input);
    const [first, replay] = await Promise.all([create(), create()]);
    const firstBody = first.body as unknown as UploadResponse;
    const replayBody = replay.body as unknown as UploadResponse;
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replayBody.data).toMatchObject({
      upload_id: firstBody.data.upload_id,
      asset_id: firstBody.data.asset_id,
    });
    const pendingAsset = await resource.db.query.assets.findFirst({
      where: eq(assets.id, firstBody.data.asset_id),
    });
    expect(pendingAsset?.storageKey).toBe(
      `assets/${firstBody.data.asset_id.slice(0, 2)}/${firstBody.data.asset_id}/original`,
    );
    expect(pendingAsset?.storageKey).not.toContain(user.id.slice(0, 8));

    const conflict = await authenticated(request(server).post('/api/v1/assets/upload-url'))
      .set('Idempotency-Key', key)
      .send({ ...input, display_name: 'changed.png' })
      .expect(409);
    expect(conflict.body).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });

    const uploadUrl = firstBody.data.upload.url;
    await authenticated(request(server).put(uploadUrl))
      .set('Content-Type', 'image/png')
      .send(Buffer.alloc(68, 1))
      .expect(204);
    const completeKey = `s10-complete-${randomUUID()}`;
    const complete = () =>
      authenticated(request(server).post('/api/v1/assets/complete'))
        .set('Idempotency-Key', completeKey)
        .send({ upload_id: firstBody.data.upload_id, asset_id: firstBody.data.asset_id });
    const [completed, completedReplay] = await Promise.all([complete(), complete()]);
    expect([completed.status, completedReplay.status]).toEqual([202, 202]);
    expect((completedReplay.body as unknown as UploadResponse).data).toEqual(
      (completed.body as unknown as UploadResponse).data,
    );

    const intents = await resource.db.query.queueDispatchIntents.findMany({
      where: eq(queueDispatchIntents.aggregateId, firstBody.data.asset_id),
    });
    expect(intents).toHaveLength(1);
    expect(intents[0]?.payload).toMatchObject({ operation: 'inspect_metadata', operation_no: 1 });
  });

  it('pins new uploads to the active S14 storage runtime and fails closed after deactivation', async () => {
    await resource.db
      .delete(storageRuntimeState)
      .where(eq(storageRuntimeState.purpose, 'private_assets'));
    const existingRuntime = await resource.db.query.storageRuntimeState.findFirst({
      where: eq(storageRuntimeState.purpose, 'private_assets'),
    });
    expect(existingRuntime).toBeUndefined();
    const [channel] = await resource.db
      .insert(storageChannels)
      .values({
        purpose: 'private_assets',
        adapterKey: 'local-private-v1',
        endpointProfileKey: 'local',
        region: 'local',
        regionKey: 'local',
        bucket: `s10-runtime-${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        rootPrefix: `s10-runtime/${randomUUID()}`,
        status: 'active',
      })
      .returning();
    if (!channel) throw new Error('Failed to create S14 storage channel fixture');
    const [credential] = await resource.db
      .insert(storageCredentialVersions)
      .values({
        storageChannelId: channel.id,
        versionNo: 1,
        secretBundleCiphertext: 'fixture-ciphertext',
        secretNonce: 'fixture-nonce',
        secretAuthTag: 'fixture-auth-tag',
        secretKeyId: 'fixture-key-v1',
        keyHint: 'key-fixture',
        status: 'active',
        revision: 2,
        activatedAt: new Date(),
      })
      .returning();
    if (!credential) throw new Error('Failed to create S14 storage credential fixture');
    trackedStorageChannels.set(channel.id, credential.id);
    await resource.db
      .update(storageChannels)
      .set({ activeCredentialVersionId: credential.id })
      .where(eq(storageChannels.id, channel.id));
    await resource.db.insert(storageRuntimeState).values({
      purpose: 'private_assets',
      activeChannelId: channel.id,
      runtimeRevision: 1,
    });

    const user = await createUser('storage-runtime');
    sessionUserId = user.id;
    const server = app.getHttpServer() as Server;
    const created = await authenticated(request(server).post('/api/v1/assets/upload-url'))
      .set('Idempotency-Key', `s10-runtime-upload-${randomUUID()}`)
      .send({
        display_name: 'runtime.png',
        declared_mime_type: 'image/png',
        file_size_bytes: 68,
      })
      .expect(201);
    const createdBody = created.body as unknown as UploadResponse;
    const [asset, intent] = await Promise.all([
      resource.db.query.assets.findFirst({
        where: eq(assets.id, createdBody.data.asset_id),
      }),
      resource.db.query.assetUploadIntents.findFirst({
        where: eq(assetUploadIntents.id, createdBody.data.upload_id),
      }),
    ]);
    if (!asset) throw new Error('Failed to load runtime-bound asset fixture');
    expect(asset).toMatchObject({ storageChannelId: channel.id });
    expect(intent).toMatchObject({ storageChannelId: channel.id });
    expect(asset?.storageKey.startsWith(`${channel.rootPrefix}/assets/`)).toBe(true);
    const historicalContents = Buffer.alloc(68, 7);
    await authenticated(request(server).put(createdBody.data.upload.url))
      .set('Content-Type', 'image/png')
      .send(historicalContents)
      .expect(204);
    const historicalThumbnailKey = `${asset.storageKey}.thumbnail.webp`;
    await storage.write(historicalThumbnailKey, historicalContents);
    await resource.db
      .update(assets)
      .set({
        status: 'ready',
        mimeType: 'image/png',
        contentHash: '7'.repeat(64),
        thumbnailKey: historicalThumbnailKey,
      })
      .where(eq(assets.id, createdBody.data.asset_id));

    await resource.db
      .update(storageRuntimeState)
      .set({ activeChannelId: null, runtimeRevision: 2 })
      .where(eq(storageRuntimeState.purpose, 'private_assets'));
    const historicalAccess = await authenticated(
      request(server).post(`/api/v1/assets/${createdBody.data.asset_id}/access-url`),
    )
      .set('Idempotency-Key', `s10-runtime-history-${randomUUID()}`)
      .send({ variant: 'original', purpose: 'preview' })
      .expect(200);
    const historicalUrl = (historicalAccess.body as { data: { url: string } }).data.url;
    await request(server).get(historicalUrl).expect(200, historicalContents);
    await authenticated(request(server).post('/api/v1/assets/upload-url'))
      .set('Idempotency-Key', `s10-runtime-disabled-${randomUUID()}`)
      .send({
        display_name: 'blocked.png',
        declared_mime_type: 'image/png',
        file_size_bytes: 68,
      })
      .expect(503)
      .expect(({ body }) => expect(body).toMatchObject({ error: { code: 'STORAGE_UNAVAILABLE' } }));
    const unchanged = await resource.db.query.assets.findFirst({
      where: eq(assets.id, createdBody.data.asset_id),
    });
    expect(unchanged).toMatchObject({
      storageChannelId: channel.id,
      storageKey: asset?.storageKey,
    });
  });

  it('accepts exactly one concurrent fact version and keeps history immutable', async () => {
    const user = await createUser('facts');
    const { asset } = await createAsset(user.id);
    sessionUserId = user.id;
    const server = app.getHttpServer() as Server;
    const product = await authenticated(request(server).post('/api/v1/products'))
      .set('Idempotency-Key', `s10-product-${randomUUID()}`)
      .send({ name: '事实并发商品' })
      .expect(201);
    const productId = (product.body as unknown as ProductResponse).data.id;
    const facts = (color: string) => ({
      expected_latest_fact_set_id: null,
      source_asset_id: asset.id,
      facts: {
        product_name: '事实并发商品',
        primary_colors: [color],
        logos: [],
        visible_text: [],
        materials: ['棉'],
        must_preserve: [],
        unknown_fields: [],
      },
    });
    const submit = (color: string) =>
      authenticated(request(server).post(`/api/v1/products/${productId}/fact-sets`))
        .set('Idempotency-Key', `s10-facts-${randomUUID()}`)
        .send(facts(color));

    const responses = await Promise.all([submit('蓝色'), submit('白色')]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(responses.find(({ status }) => status === 409)?.body).toMatchObject({
      error: { code: 'PRODUCT_FACT_VERSION_CONFLICT' },
    });
    const winner = responses.find(({ status }) => status === 201);
    const winnerBody = winner?.body as unknown as FactResponse | undefined;
    expect(winnerBody?.data).toMatchObject({ version_no: 1 });

    const stored = await resource.db.query.productFactSets.findMany({
      where: eq(productFactSets.productId, productId),
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.factsJson).toEqual(winnerBody?.data.facts);
    const current = await resource.db.query.products.findFirst({
      where: eq(products.id, productId),
    });
    expect(current).toMatchObject({ latestFactSetId: winnerBody?.data.id, revision: 2 });
  });

  it('retries a failed asset concurrently exactly once', async () => {
    const user = await createUser('retry');
    sessionUserId = user.id;
    const { asset } = await createAsset(user.id, 'processing_failed');
    const server = app.getHttpServer() as Server;
    const key = `s10-retry-${randomUUID()}`;
    const retry = () =>
      authenticated(request(server).post(`/api/v1/assets/${asset.id}/retry-processing`))
        .set('Idempotency-Key', key)
        .send({ reason: 'user_requested' });

    const [first, replay] = await Promise.all([retry(), retry()]);
    const firstBody = first.body as unknown as RetryResponse;
    const replayBody = replay.body as unknown as RetryResponse;
    expect([first.status, replay.status]).toEqual([202, 202]);
    expect(replayBody.data).toEqual(firstBody.data);
    expect(firstBody.data).toMatchObject({ processing_revision: 2, status: 'processing' });
    const stored = await resource.db.query.assets.findFirst({ where: eq(assets.id, asset.id) });
    expect(stored).toMatchObject({ processingRevision: 2, status: 'processing' });
    const intents = await resource.db.query.queueDispatchIntents.findMany({
      where: eq(queueDispatchIntents.aggregateId, asset.id),
    });
    expect(intents).toHaveLength(1);
  });

  it.each(['create', 'update', 'facts'] as const)(
    'rejects a concurrently deleted source during product %s',
    async (action) => {
      const user = await createUser(`delete-race-${action}`);
      const { asset } = await createAsset(user.id);
      const product = await productService.create(user.id, { name: 'Race fixture' }, randomUUID());
      let pending!: Promise<unknown>;
      let settled = false;
      await resource.db.transaction(async (tx) => {
        const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
        await tx.select().from(assets).where(eq(assets.id, asset.id)).for('update');
        await tx
          .update(assets)
          .set({ status: 'deleted', deletedAt: new Date() })
          .where(eq(assets.id, asset.id));
        const operation =
          action === 'create'
            ? productService.create(
                user.id,
                { name: 'Bound fixture', primary_asset_id: asset.id },
                randomUUID(),
              )
            : action === 'update'
              ? productService.update(
                  user.id,
                  product.id,
                  { revision: product.revision, primary_asset_id: asset.id },
                  randomUUID(),
                )
              : productService.createFacts(
                  user.id,
                  product.id,
                  {
                    expected_latest_fact_set_id: null,
                    source_asset_id: asset.id,
                    facts: {
                      product_name: 'Race fixture',
                      primary_colors: [],
                      logos: [],
                      visible_text: [],
                      materials: [],
                      must_preserve: [],
                      unknown_fields: [],
                    },
                  },
                  randomUUID(),
                );
        pending = operation.then(
          () => {
            settled = true;
            return null;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
        // Observe the real lock wait before committing the deletion; no timing-based race.
        await expect
          .poll(
            async () => {
              const [waiting] = await resource.db.execute(sql`
            select exists(select 1 from pg_stat_activity where ${backend!.pid}::int = any(pg_blocking_pids(pid))) as blocked
          `);
              return settled || waiting?.blocked === true;
            },
            { timeout: 3000 },
          )
          .toBe(true);
      });
      expect(await pending).toMatchObject({ code: 'ASSET_NOT_READY' });
      expect(
        await resource.db.query.products.findMany({
          where: and(eq(products.userId, user.id), eq(products.primaryAssetId, asset.id)),
        }),
      ).toEqual([]);
      expect(
        await resource.db.query.productFactSets.findMany({
          where: eq(productFactSets.userId, user.id),
        }),
      ).toEqual([]);
    },
  );

  it('advances from the CAS revision when a concurrent product update wins before an asset lock is released', async () => {
    const user = await createUser('product-revision-race');
    const { asset } = await createAsset(user.id);
    const product = await productService.create(
      user.id,
      { name: 'Revision fixture' },
      randomUUID(),
    );
    let pending!: Promise<unknown>;
    let settled = false;
    await resource.db.transaction(async (tx) => {
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`);
      await tx.select().from(assets).where(eq(assets.id, asset.id)).for('update');
      pending = productService
        .update(
          user.id,
          product.id,
          {
            revision: product.revision + 1,
            primary_asset_id: asset.id,
          },
          randomUUID(),
        )
        .then(
          (value) => {
            settled = true;
            return value;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      await expect
        .poll(
          async () => {
            const [waiting] = await resource.db.execute(sql`
          select exists(select 1 from pg_stat_activity where ${backend!.pid}::int = any(pg_blocking_pids(pid))) as blocked
        `);
            return settled || waiting?.blocked === true;
          },
          { timeout: 3000 },
        )
        .toBe(true);
      expect(settled).toBe(false);
      await resource.db
        .update(products)
        .set({ revision: product.revision + 1 })
        .where(eq(products.id, product.id));
    });
    expect(await pending).toMatchObject({ revision: product.revision + 2 });
    await expect(
      productService.update(
        user.id,
        product.id,
        {
          revision: product.revision + 1,
          name: 'Stale write',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'PRODUCT_REVISION_CONFLICT' });
  });

  it('deletes an asset with revision fencing, closes access, and replays the audit result', async () => {
    const user = await createUser('delete');
    const { asset } = await createAsset(user.id);
    sessionUserId = user.id;
    const [product] = await resource.db
      .insert(products)
      .values({ userId: user.id, name: 'Delete fixture', primaryAssetId: asset.id })
      .returning();
    if (!product) throw new Error('Failed to create delete fixture product');
    const server = app.getHttpServer() as Server;
    const access = await authenticated(
      request(server).post(`/api/v1/assets/${asset.id}/access-url`),
    )
      .set('Idempotency-Key', `s10-delete-access-${randomUUID()}`)
      .send({ variant: 'original', purpose: 'preview' })
      .expect(200);
    const accessUrl = (access.body as unknown as AccessResponse).data.url;
    const key = `s10-delete-${randomUUID()}`;
    const body = { reason: 'user_requested', expected_revision: asset.processingRevision };
    const deleted = await authenticated(request(server).delete(`/api/v1/assets/${asset.id}`))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    const replay = await authenticated(request(server).delete(`/api/v1/assets/${asset.id}`))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(200);
    expect(replay.body).toEqual(deleted.body);
    expect(deleted.body).toMatchObject({
      data: { asset_id: asset.id, status: 'deleted' },
    });
    await request(server).get(accessUrl).expect(404);
    const stored = await resource.db.query.assets.findFirst({
      where: eq(assets.id, asset.id),
    });
    expect(stored?.status).toBe('deleted');
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    const detached = await resource.db.query.products.findFirst({
      where: eq(products.id, product.id),
    });
    expect(detached?.primaryAssetId).toBeNull();
    const audit = await resource.db.query.userActivityLogs.findFirst({
      where: and(eq(userActivityLogs.userId, user.id), eq(userActivityLogs.targetId, asset.id)),
    });
    expect(audit).toMatchObject({ activityType: 'asset_delete', targetType: 'asset' });

    await authenticated(request(server).delete(`/api/v1/assets/${asset.id}`))
      .set('Idempotency-Key', `s10-delete-stale-${randomUUID()}`)
      .send({ ...body, expected_revision: asset.processingRevision + 1 })
      .expect(404);
  });

  it('rejects deletion while a live turn or workflow still references the asset', async () => {
    const user = await createUser('delete-in-use');
    const { asset } = await createAsset(user.id);
    sessionUserId = user.id;
    const sessionId = randomUUID();
    const turnId = randomUUID();
    await resource.db.insert(chatSessions).values({
      id: sessionId,
      userId: user.id,
      title: 'Delete in-use fixture',
    });
    await resource.db.insert(agentTurns).values({
      id: turnId,
      sessionId,
      userId: user.id,
      status: 'planning',
    });
    await resource.db.insert(chatMessages).values({
      sessionId,
      turnId,
      role: 'user',
      content: 'using asset',
      attachments: [{ object_id: asset.id }],
    });
    const server = app.getHttpServer() as Server;
    await authenticated(request(server).delete(`/api/v1/assets/${asset.id}`))
      .set('Idempotency-Key', `s10-delete-turn-${randomUUID()}`)
      .send({ reason: 'user_requested', expected_revision: asset.processingRevision })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ error: { code: 'ASSET_IN_USE' } }));

    await resource.db.update(agentTurns).set({ status: 'done' }).where(eq(agentTurns.id, turnId));
    const [workflow] = await resource.db
      .insert(workflowRuns)
      .values({
        userId: user.id,
        triggerMode: 'chat',
        status: 'running',
        planSnapshot: { input_bindings: [{ object_id: asset.id }] },
        skillSnapshot: {},
        pricingSnapshot: {},
      })
      .returning();
    if (!workflow) throw new Error('Failed to create delete workflow fixture');
    await authenticated(request(server).delete(`/api/v1/assets/${asset.id}`))
      .set('Idempotency-Key', `s10-delete-workflow-${randomUUID()}`)
      .send({ reason: 'user_requested', expected_revision: asset.processingRevision })
      .expect(409)
      .expect(({ body }) => expect(body).toMatchObject({ error: { code: 'ASSET_IN_USE' } }));
  });

  it('binds access capabilities to user, resource, purpose, variant, signature, and expiry', async () => {
    const owner = await createUser('capability-owner');
    const other = await createUser('capability-other');
    const { asset, body } = await createAsset(owner.id);
    const processing = await createAsset(owner.id, 'processing');
    sessionUserId = owner.id;
    const server = app.getHttpServer() as Server;

    const unavailable = await authenticated(
      request(server).post(`/api/v1/assets/${processing.asset.id}/access-url`),
    )
      .set('Idempotency-Key', `s10-access-${randomUUID()}`)
      .send({ variant: 'original', purpose: 'preview' })
      .expect(409);
    expect(unavailable.body).toMatchObject({ error: { code: 'ASSET_NOT_READY' } });

    sessionUserId = other.id;
    const hidden = await authenticated(
      request(server).post(`/api/v1/assets/${asset.id}/access-url`),
    )
      .set('Idempotency-Key', `s10-access-${randomUUID()}`)
      .send({ variant: 'original', purpose: 'preview' })
      .expect(404);
    expect(hidden.body).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });

    sessionUserId = owner.id;
    const access = await authenticated(
      request(server).post(`/api/v1/assets/${asset.id}/access-url`),
    )
      .set('Idempotency-Key', `s10-access-${randomUUID()}`)
      .send({ variant: 'original', purpose: 'preview' })
      .expect(200);
    const accessUrl = new URL(
      (access.body as unknown as AccessResponse).data.url,
      'http://localhost',
    );
    const path = `${accessUrl.pathname}${accessUrl.search}`;
    const valid = await request(server).get(path).expect(200);
    expect(valid.body).toEqual(body);

    for (const [name, mutate] of [
      ['purpose', (url: URL) => url.searchParams.set('purpose', 'download')],
      ['variant', (url: URL) => url.searchParams.set('variant', 'thumbnail')],
      [
        'signature',
        (url: URL) =>
          url.searchParams.set('capability', `${url.searchParams.get('capability') ?? ''}x`),
      ],
    ] as const) {
      const changed = new URL(accessUrl);
      mutate(changed);
      const response = await request(server)
        .get(`${changed.pathname}${changed.search}`)
        .expect(404);
      expect(response.body, name).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });
    }

    const replacementKey = `s10-tests/replaced/${asset.id}/original`;
    await storage.write(replacementKey, body);
    await resource.db
      .update(assets)
      .set({ storageKey: replacementKey })
      .where(eq(assets.id, asset.id));
    const staleObjectKey = await request(server).get(path).expect(404);
    expect(staleObjectKey.body).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });

    const codec = new StorageCapabilityCodec(config.storage.capabilitySecret);
    const capabilityPath = (userId: string, expiresAt: number) => {
      const token = codec.issue({
        version: 1,
        purpose: 'preview',
        userId,
        resourceType: 'asset',
        resourceId: asset.id,
        variant: 'original',
        objectKeyDigest: storageObjectKeyDigest(replacementKey),
        expiresAt,
      });
      return `/api/v1/assets/${asset.id}/content?variant=original&purpose=preview&capability=${encodeURIComponent(token)}`;
    };
    await request(server)
      .get(capabilityPath(other.id, Math.floor(Date.now() / 1000) + 60))
      .expect(404);
    await request(server)
      .get(capabilityPath(owner.id, Math.floor(Date.now() / 1000) - 1))
      .expect(404);
  });

  it('invalidates an artifact capability when its selected object key changes', async () => {
    const user = await createUser('artifact-capability');
    sessionUserId = user.id;
    const server = app.getHttpServer() as Server;
    const [workflow] = await resource.db
      .insert(workflowRuns)
      .values({
        userId: user.id,
        triggerMode: 'chat',
        status: 'succeeded',
        planSnapshot: {},
        skillSnapshot: {},
        pricingSnapshot: {},
        finishedAt: new Date(),
      })
      .returning();
    if (!workflow) throw new Error('Failed to create S10 artifact workflow');
    const [task] = await resource.db
      .insert(tasks)
      .values({
        workflowRunId: workflow.id,
        type: 'image.generate',
        status: 'succeeded',
        costEstimate: '0.00',
        costActual: '0.00',
        idempotencyKey: `s10-artifact-task-${randomUUID()}`,
        dagNodeId: 'generate-image',
        dagJson: {},
        paramsSnapshot: {},
        endedAt: new Date(),
      })
      .returning();
    if (!task) throw new Error('Failed to create S10 artifact task');
    const artifactId = randomUUID();
    const originalKey = `s10-tests/artifacts/${artifactId}/original.webp`;
    const replacementKey = `s10-tests/artifacts/${artifactId}/replacement.webp`;
    const body = Buffer.from(`artifact-${artifactId}`);
    await storage.write(originalKey, body);
    await storage.write(replacementKey, body);
    await resource.db.insert(artifacts).values({
      id: artifactId,
      taskId: task.id,
      userId: user.id,
      type: 'image',
      storageKey: originalKey,
      contentHash: createHash('sha256').update(body).digest('hex'),
      metaJson: {},
      paramsSnapshot: {},
      sourceAction: 'generate',
      originDomain: 'creative',
      producerMode: 'canvas',
      mutationOwner: 'canvas',
      visibility: 'private',
    });

    const access = await authenticated(
      request(server).post(`/api/v1/artifacts/${artifactId}/access-url`),
    )
      .set('Idempotency-Key', `s10-artifact-access-${randomUUID()}`)
      .send({ variant: 'original', purpose: 'preview' })
      .expect(200);
    const accessUrl = new URL(
      (access.body as unknown as AccessResponse).data.url,
      'http://localhost',
    );
    const path = `${accessUrl.pathname}${accessUrl.search}`;
    expect((await request(server).get(path).expect(200)).body).toEqual(body);

    await resource.db
      .update(artifacts)
      .set({ storageKey: replacementKey })
      .where(eq(artifacts.id, artifactId));
    const stale = await request(server).get(path).expect(404);
    expect(stale.body).toMatchObject({ error: { code: 'RESOURCE_NOT_FOUND' } });
  });

  it('serves only the published object after an artifact leaves quarantine', async () => {
    const user = await createUser('published-artifact-capability');
    sessionUserId = user.id;
    const server = app.getHttpServer() as Server;
    const [workflow] = await resource.db
      .insert(workflowRuns)
      .values({
        userId: user.id,
        triggerMode: 'chat',
        status: 'succeeded',
        planSnapshot: {},
        skillSnapshot: {},
        pricingSnapshot: {},
        finishedAt: new Date(),
      })
      .returning();
    if (!workflow) throw new Error('Failed to create published artifact workflow');
    const [task] = await resource.db
      .insert(tasks)
      .values({
        workflowRunId: workflow.id,
        type: 'image.generate',
        status: 'succeeded',
        costEstimate: '0.00',
        costActual: '0.00',
        idempotencyKey: `s12-published-artifact-task-${randomUUID()}`,
        dagNodeId: 'generate-image',
        dagJson: {},
        paramsSnapshot: {},
        endedAt: new Date(),
      })
      .returning();
    if (!task) throw new Error('Failed to create published artifact task');
    const artifactId = randomUUID();
    const quarantineKey = `s12-tests/artifacts/${artifactId}/quarantine.png`;
    const publishedKey = `s12-tests/artifacts/${artifactId}/published.png`;
    const thumbnailKey = `s12-tests/artifacts/${artifactId}/thumbnail.webp`;
    const quarantineBody = Buffer.from('quarantine-source-must-not-leak');
    const publishedBody = Buffer.from('published-delivery');
    await storage.write(quarantineKey, quarantineBody);
    await storage.write(publishedKey, publishedBody);
    await storage.write(thumbnailKey, Buffer.from('published-thumbnail'));
    await resource.db.insert(artifacts).values({
      id: artifactId,
      taskId: task.id,
      userId: user.id,
      type: 'image',
      storageKey: quarantineKey,
      contentHash: createHash('sha256').update(quarantineBody).digest('hex'),
      publishedStorageKey: publishedKey,
      publishedContentHash: createHash('sha256').update(publishedBody).digest('hex'),
      publicationSnapshot: { schema_version: 1 },
      thumbnailKey,
      metaJson: { media_type: 'image/png' },
      paramsSnapshot: {},
      sourceAction: 'generate',
      originDomain: 'creative',
      producerMode: 'canvas',
      mutationOwner: 'canvas',
      visibility: 'private',
    });

    const access = await authenticated(
      request(server).post(`/api/v1/artifacts/${artifactId}/access-url`),
    )
      .set('Idempotency-Key', `s12-published-artifact-access-${randomUUID()}`)
      .send({ variant: 'original', purpose: 'preview' })
      .expect(200);
    const accessUrl = new URL(
      (access.body as unknown as AccessResponse).data.url,
      'http://localhost',
    );
    const delivered = await request(server)
      .get(`${accessUrl.pathname}${accessUrl.search}`)
      .expect(200);
    expect(delivered.body).toEqual(publishedBody);
    expect(delivered.body).not.toEqual(quarantineBody);
  });

  it('serves artifact content over the session-auth path (no capability) with correct bytes and content type', async () => {
    const owner = await createUser('session-artifact-owner');
    const { artifactId, body } = await createArtifact(owner.id);
    sessionUserId = owner.id;
    const server = app.getHttpServer() as Server;
    const path = `/api/v1/artifacts/${artifactId}/content?variant=original&purpose=preview`;
    const res = await request(server).get(path).expect(200);
    expect(res.body).toEqual(body);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.vary).toBe('Cookie');
    expect(res.headers.etag).toBeDefined();
  });

  it('rejects another user reading my artifact over the session-auth path with 404', async () => {
    const owner = await createUser('session-artifact-owner-2');
    const other = await createUser('session-artifact-other');
    const { artifactId } = await createArtifact(owner.id);
    sessionUserId = other.id;
    const server = app.getHttpServer() as Server;
    await request(server)
      .get(`/api/v1/artifacts/${artifactId}/content?variant=original&purpose=preview`)
      .expect(404);
  });

  it('returns ARTIFACT_QUARANTINED for a quarantined artifact over the session-auth path', async () => {
    const owner = await createUser('session-artifact-quarantine');
    const { artifactId } = await createArtifact(owner.id, 'quarantined');
    sessionUserId = owner.id;
    const server = app.getHttpServer() as Server;
    await request(server)
      .get(`/api/v1/artifacts/${artifactId}/content?variant=original&purpose=preview`)
      .expect(423)
      .expect(({ body }) =>
        expect(body).toMatchObject({ error: { code: 'ARTIFACT_QUARANTINED' } }),
      );
  });

  it('honors ETag and returns 304 without a body on a matching If-None-Match', async () => {
    const owner = await createUser('session-artifact-etag');
    const { artifactId, body } = await createArtifact(owner.id);
    sessionUserId = owner.id;
    const server = app.getHttpServer() as Server;
    const path = `/api/v1/artifacts/${artifactId}/content?variant=original&purpose=preview`;
    const first = await request(server).get(path).expect(200);
    expect(first.body).toEqual(body);
    const etag = first.headers.etag;
    expect(etag).toBeDefined();
    const replay = await request(server).get(path).set('If-None-Match', etag!).expect(304);
    expect(replay.headers.etag).toBe(etag);
    expect(replay.headers.vary).toBe('Cookie');
    expect(replay.text).toBe('');
    expect(replay.headers['content-type']).toBeUndefined();
  });

  it.each(['asset', 'artifact'] as const)(
    'invalidates the %s thumbnail ETag when the representation changes',
    async (kind) => {
      const owner = await createUser(`updated-thumbnail-${kind}`);
      const id =
        kind === 'asset'
          ? (await createAsset(owner.id)).asset.id
          : (await createArtifact(owner.id)).artifactId;
      sessionUserId = owner.id;
      const server = app.getHttpServer() as Server;
      const path = `/api/v1/${kind}s/${id}/content?variant=thumbnail&purpose=preview`;
      const original = await request(server).get(path).expect(200);
      const key = `s10-tests/${owner.id}/${id}/updated-thumbnail.webp`;
      const body = Buffer.from('updated-thumbnail');
      await storage.write(key, body);
      if (kind === 'asset')
        await resource.db.update(assets).set({ thumbnailKey: key }).where(eq(assets.id, id));
      else
        await resource.db.update(artifacts).set({ thumbnailKey: key }).where(eq(artifacts.id, id));
      const updated = await request(server)
        .get(path)
        .set('If-None-Match', original.headers.etag!)
        .expect(200);
      expect(updated.body).toEqual(body);
      expect(updated.headers.etag).not.toBe(original.headers.etag);
      expect(updated.headers.etag).not.toContain(key);
      await request(server).get(path).set('If-None-Match', updated.headers.etag!).expect(304);
    },
  );

  it('rejects another user guessing the victim ETag (still 404, no 304, no etag leak)', async () => {
    const owner = await createUser('cross-etag-artifact-owner');
    const other = await createUser('cross-etag-artifact-other');
    const { artifactId } = await createArtifact(owner.id);
    const server = app.getHttpServer() as Server;
    const path = `/api/v1/artifacts/${artifactId}/content?variant=original&purpose=preview`;

    sessionUserId = owner.id;
    const victim = await request(server).get(path).expect(200);
    const etag = victim.headers.etag;
    expect(etag).toBeDefined();

    sessionUserId = other.id;
    const probe = await request(server).get(path).set('If-None-Match', etag!).expect(404);
    expect(probe.status).not.toBe(304);
    // Express attaches its own weak ETag to every response body (including this
    // 404 JSON), so the guarantee that matters is that the victim's content-hash
    // ETag is not echoed back and the response never degrades into a 304.
    expect(probe.headers.etag).not.toBe(etag);
    expect(JSON.stringify(probe.body)).not.toContain(etag!.replaceAll('"', ''));
  });

  it('serves asset content over the session-auth path (no capability) with correct bytes and content type', async () => {
    const owner = await createUser('session-asset-owner');
    const { asset, body } = await createAsset(owner.id);
    sessionUserId = owner.id;
    const server = app.getHttpServer() as Server;
    const path = `/api/v1/assets/${asset.id}/content?variant=original&purpose=preview`;
    const res = await request(server).get(path).expect(200);
    expect(res.body).toEqual(body);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.vary).toBe('Cookie');
    expect(res.headers.etag).toBe(`"${asset.contentHash}"`);

    const other = await createUser('session-asset-other');
    sessionUserId = other.id;
    await request(server).get(path).expect(404);
  });

  it('rejects another user guessing the victim asset ETag (still 404, no 304, no etag leak)', async () => {
    const owner = await createUser('cross-etag-asset-owner');
    const other = await createUser('cross-etag-asset-other');
    const { asset } = await createAsset(owner.id);
    const server = app.getHttpServer() as Server;
    const path = `/api/v1/assets/${asset.id}/content?variant=original&purpose=preview`;

    sessionUserId = owner.id;
    const victim = await request(server).get(path).expect(200);
    const etag = victim.headers.etag;
    expect(etag).toBeDefined();

    sessionUserId = other.id;
    const probe = await request(server).get(path).set('If-None-Match', etag!).expect(404);
    expect(probe.status).not.toBe(304);
    // Express attaches its own weak ETag to every response body (including this
    // 404 JSON), so the guarantee that matters is that the victim's content-hash
    // ETag is not echoed back and the response never degrades into a 304.
    expect(probe.headers.etag).not.toBe(etag);
    expect(JSON.stringify(probe.body)).not.toContain(etag!.replaceAll('"', ''));
  });

  it('still serves content via capability when no session is present (no regression)', async () => {
    const owner = await createUser('capability-owner-regression');
    const { asset, body } = await createAsset(owner.id);
    sessionUserId = owner.id;
    const server = app.getHttpServer() as Server;
    const access = await authenticated(
      request(server).post(`/api/v1/assets/${asset.id}/access-url`),
    )
      .set('Idempotency-Key', `s10-capability-regression-${randomUUID()}`)
      .send({ variant: 'original', purpose: 'preview' })
      .expect(200);
    const accessUrl = new URL(
      (access.body as unknown as AccessResponse).data.url,
      'http://localhost',
    );
    sessionUserId = null;
    const res = await request(server).get(`${accessUrl.pathname}${accessUrl.search}`).expect(200);
    expect(res.body).toEqual(body);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.vary).toBe('Cookie');
  });

  it('audits a session-authenticated artifact download and skips the audit on 304', async () => {
    const owner = await createUser('session-download-audit-owner');
    const { artifactId } = await createArtifact(owner.id);
    const server = app.getHttpServer() as Server;
    const path = `/api/v1/artifacts/${artifactId}/content?variant=thumbnail&purpose=download`;

    sessionUserId = owner.id;
    const countDownloads = async (): Promise<number> =>
      (
        await resource.db
          .select({ id: userActivityLogs.id })
          .from(userActivityLogs)
          .where(
            and(
              eq(userActivityLogs.userId, owner.id),
              eq(userActivityLogs.activityType, 'download'),
              eq(userActivityLogs.targetId, artifactId),
            ),
          )
      ).length;

    // No mint step exists on the session path, so the audit must land on delivery.
    expect(await countDownloads()).toBe(0);
    const first = await request(server).get(path).expect(200);
    expect(await countDownloads()).toBe(1);

    // A 304 delivers no bytes and must not count as another download.
    await request(server).get(path).set('If-None-Match', first.headers.etag!).expect(304);
    expect(await countDownloads()).toBe(1);
  });

  it('audits a session-authenticated asset download', async () => {
    const owner = await createUser('session-asset-download-audit');
    const { asset } = await createAsset(owner.id);
    sessionUserId = owner.id;
    const server = app.getHttpServer() as Server;
    const path = `/api/v1/assets/${asset.id}/content?variant=thumbnail&purpose=download`;

    await request(server).get(path).expect(200);
    const audit = await resource.db.query.userActivityLogs.findFirst({
      where: and(
        eq(userActivityLogs.userId, owner.id),
        eq(userActivityLogs.activityType, 'download'),
        eq(userActivityLogs.targetId, asset.id),
      ),
    });
    expect(audit?.targetType).toBe('asset');
  });
});
