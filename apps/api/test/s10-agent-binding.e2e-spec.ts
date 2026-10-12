import { createHash, randomUUID } from 'node:crypto';

import { assets, assetUploadIntents, createDatabaseClient, inArray, users } from '@ecom-forge/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { AgentBindingService } from '../src/modules/agent/agent-binding.service.js';
import type { CreateTurnInput } from '../src/modules/agent/agent.schemas.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '').toLowerCase();
if (!/_test(?:_|$)/.test(databaseName)) {
  throw new Error('S10 binding integration tests require a database name containing _test');
}

const resource = createDatabaseClient({ databaseUrl, maxConnections: 10 });
const trackedUsers = new Set<string>();
const trackedAssets = new Set<string>();
const trackedUploads = new Set<string>();
const service = new AgentBindingService();

async function createUser(label: string) {
  const [user] = await resource.db
    .insert(users)
    .values({
      email: `s10-binding-${label}-${randomUUID()}@example.com`,
      displayName: 'S10 binding user',
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error('Failed to create S10 binding user');
  trackedUsers.add(user.id);
  return user;
}

async function createAsset(
  userId: string,
  input: {
    status?: 'processing' | 'ready' | 'rejected' | 'deleted';
    contentHash?: string | null;
  } = {},
) {
  const hash = input.contentHash ?? createHash('sha256').update(randomUUID()).digest('hex');
  const status = input.status ?? 'ready';
  const [asset] = await resource.db
    .insert(assets)
    .values({
      userId,
      displayName: 'binding fixture',
      storageKey: `s10-binding/${userId}/${randomUUID()}/original`,
      thumbnailKey: status === 'ready' ? `s10-binding/${userId}/${randomUUID()}/thumb.webp` : null,
      contentHash: status === 'rejected' || status === 'processing' ? null : hash,
      fileSizeBytes: BigInt(128),
      mimeType: status === 'ready' ? 'image/png' : null,
      metaJson: status === 'ready' ? { width: 12, height: 8 } : {},
      kind: 'upload',
      origin: 'upload',
      status,
      deletedAt: status === 'deleted' ? new Date() : null,
    })
    .returning();
  if (!asset) throw new Error('Failed to create S10 binding asset');
  trackedAssets.add(asset.id);
  return asset;
}

function attachment(
  resourceId: string,
  resourceVersion: string,
  resourceType: 'asset' | 'upload' = 'asset',
) {
  return {
    binding_id: randomUUID(),
    resource_type: resourceType,
    resource_id: resourceId,
    resource_version: resourceVersion,
    role: 'style_reference' as const,
    position: 0,
  };
}

async function resolve(userId: string, sessionId: string, input: CreateTurnInput['attachments']) {
  return resource.db.transaction((transaction) =>
    service.resolve(transaction, { userId, sessionId, attachments: input }),
  );
}

afterEach(async () => {
  if (trackedUploads.size > 0) {
    await resource.db
      .delete(assetUploadIntents)
      .where(inArray(assetUploadIntents.id, [...trackedUploads]));
  }
  if (trackedAssets.size > 0) {
    await resource.db.delete(assets).where(inArray(assets.id, [...trackedAssets]));
  }
  if (trackedUsers.size > 0) {
    await resource.db.delete(users).where(inArray(users.id, [...trackedUsers]));
  }
  trackedUploads.clear();
  trackedAssets.clear();
  trackedUsers.clear();
});

afterAll(async () => {
  await resource.client.end();
});

describe('S10 agent attachment binding', () => {
  it('creates a snapshot from current server truth for a ready asset', async () => {
    const user = await createUser('ready');
    const sessionId = randomUUID();
    const asset = await createAsset(user.id);

    const [snapshot] = await resolve(user.id, sessionId, [
      attachment(asset.id, asset.contentHash!),
    ]);

    expect(snapshot).toMatchObject({
      kind: 'asset',
      object_id: asset.id,
      object_version: asset.contentHash,
      content_hash: asset.contentHash,
      owner_user_id: user.id,
      readable: true,
      mutable: false,
      lifecycle: 'active',
      visibility: 'private',
      media_type: 'image',
    });
  });

  it.each([
    ['cross-user', 'foreign'],
    ['processing', 'processing'],
    ['rejected', 'rejected'],
    ['deleted', 'deleted'],
  ] as const)('rejects a %s asset without creating a snapshot', async (_label, status) => {
    const owner = await createUser('owner');
    const requester = await createUser('requester');
    const asset = await createAsset(owner.id, { status: status === 'foreign' ? 'ready' : status });
    const requestedVersion =
      asset.contentHash ?? createHash('sha256').update('missing').digest('hex');

    await expect(
      resolve(requester.id, randomUUID(), [attachment(asset.id, requestedVersion)]),
    ).rejects.toMatchObject({ code: 'REFERENCE_NOT_AVAILABLE' });
  });

  it('rejects a client snapshot whose content hash has drifted', async () => {
    const user = await createUser('drift');
    const asset = await createAsset(user.id);

    await expect(
      resolve(user.id, randomUUID(), [
        attachment(asset.id, createHash('sha256').update('old-content').digest('hex')),
      ]),
    ).rejects.toMatchObject({ code: 'REFERENCE_NOT_AVAILABLE' });
  });

  it('does not resolve an upload intent until it is completed', async () => {
    const user = await createUser('upload');
    const asset = await createAsset(user.id, { status: 'processing' });
    const [upload] = await resource.db
      .insert(assetUploadIntents)
      .values({
        userId: user.id,
        assetId: asset.id,
        status: 'pending',
        idempotencyKey: `s10-binding-upload-${randomUUID()}`,
        requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
        responseJson: { asset_id: asset.id },
        declaredMimeType: 'image/png',
        maxSizeBytes: BigInt(20 * 1024 * 1024),
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    if (!upload) throw new Error('Failed to create S10 upload intent');
    trackedUploads.add(upload.id);

    await expect(
      resolve(user.id, randomUUID(), [attachment(upload.id, 'pending-upload', 'upload')]),
    ).rejects.toMatchObject({ code: 'AGENT_CONTEXT_UNAVAILABLE' });
  });
});
