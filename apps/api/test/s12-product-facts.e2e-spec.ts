import { randomUUID } from 'node:crypto';

import {
  agentTraces,
  agentTurnConfirmations,
  agentTurns,
  assets,
  chatMessages,
  chatSessions,
  createDatabaseClient,
  creditAccounts,
  eq,
  eventOutbox,
  inArray,
  productFactSets,
  products,
  queueDispatchIntents,
  users,
} from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { AgentConfirmationService } from '../src/modules/agent/agent-confirmation.service.js';
import { ProductService } from '../src/modules/resource/product.service.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '').toLowerCase();
if (!/_test(?:_|$)/.test(databaseName)) {
  throw new Error('S12 product facts tests require a database name containing _test');
}

const resource = createDatabaseClient({ databaseUrl, maxConnections: 20 });
const productService = new ProductService(
  resource.db,
  Buffer.alloc(32, 61).toString('base64url'),
  Buffer.alloc(32, 62).toString('base64url'),
);
const confirmations = new AgentConfirmationService(resource.db, undefined, productService);
const trackedUsers = new Set<string>();

function productFacts(productName: string) {
  return {
    product_name: productName,
    primary_colors: ['白色'],
    logos: [],
    visible_text: [],
    materials: [],
    must_preserve: ['商品主体结构'],
    unknown_fields: ['材质'],
  };
}

async function createUser(label: string): Promise<string> {
  const [user] = await resource.db
    .insert(users)
    .values({
      email: `s12-facts-${label}-${randomUUID()}@example.com`,
      displayName: `S12 ${label}`,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: users.id });
  if (!user) throw new Error('Failed to create S12 product facts user');
  trackedUsers.add(user.id);
  return user.id;
}

async function createReadyAsset(userId: string, label: string) {
  const contentHash = canonicalSha256({ userId, label, nonce: randomUUID() });
  const [asset] = await resource.db
    .insert(assets)
    .values({
      userId,
      displayName: `${label}.png`,
      storageKey: `s12-facts/${userId}/${randomUUID()}/original.png`,
      thumbnailKey: `s12-facts/${userId}/${randomUUID()}/thumbnail.webp`,
      contentHash,
      fileSizeBytes: 128n,
      mimeType: 'image/png',
      metaJson: { width: 16, height: 16 },
      kind: 'upload',
      origin: 'upload',
      status: 'ready',
    })
    .returning();
  if (!asset) throw new Error('Failed to create S12 product facts asset');
  return asset;
}

async function createPendingConfirmation(input: {
  userId: string;
  sourceAssetId: string;
  sourceVersion: string;
  mode: 'create_product' | 'link_product';
  productId?: string;
  expectedLatestFactSetId?: string | null;
}) {
  const [session] = await resource.db
    .insert(chatSessions)
    .values({ userId: input.userId, title: 'S12 商品事实确认' })
    .returning({ id: chatSessions.id });
  if (!session) throw new Error('Failed to create S12 product facts session');
  const [turn] = await resource.db
    .insert(agentTurns)
    .values({
      sessionId: session.id,
      userId: input.userId,
      status: 'waiting_user_confirmation',
    })
    .returning({ id: agentTurns.id });
  if (!turn) throw new Error('Failed to create S12 product facts turn');
  await resource.db.insert(agentTraces).values({
    turnId: turn.id,
    sessionId: session.id,
    userId: input.userId,
    brainModelId: 's12-product-facts-test',
  });
  const publicPayload = {
    schema_version: 1 as const,
    mode: input.mode,
    source_asset_id: input.sourceAssetId,
    source_version: input.sourceVersion,
    candidate_facts: productFacts('候选商品'),
    required_fields: ['product_name', 'visible_text'] as const,
    ...(input.mode === 'link_product'
      ? {
          product_id: input.productId!,
          expected_latest_fact_set_id: input.expectedLatestFactSetId ?? null,
        }
      : {}),
  };
  const [confirmation] = await resource.db
    .insert(agentTurnConfirmations)
    .values({
      turnId: turn.id,
      userId: input.userId,
      confirmationNo: 1,
      type: 'product_facts',
      answerSchemaVersion: 1,
      publicPayloadJson: publicPayload,
      payloadDigest: canonicalSha256(publicPayload),
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning({ id: agentTurnConfirmations.id });
  if (!confirmation) throw new Error('Failed to create S12 product facts confirmation');
  return { turnId: turn.id, confirmationId: confirmation.id, publicPayload };
}

async function confirmFacts(input: {
  userId: string;
  turnId: string;
  confirmationId: string;
  idempotencyKey: string;
  facts?: ReturnType<typeof productFacts>;
  skuCode?: string;
}) {
  return confirmations.confirm(
    input.userId,
    input.turnId,
    {
      confirmation_id: input.confirmationId,
      confirmation_type: 'product_facts',
      confirmation_version: 1,
      answers: {
        ...(input.skuCode ? { sku_code: input.skuCode } : {}),
        facts: input.facts ?? productFacts('测试商品'),
      },
    },
    input.idempotencyKey,
  );
}

async function createExistingProduct(userId: string, label: string) {
  const source = await createReadyAsset(userId, `${label}-base`);
  const result = await resource.db.transaction((transaction) =>
    productService.confirmFactsInTransaction(transaction, userId, {
      mode: 'create_product',
      sourceAssetId: source.id,
      sourceVersion: source.contentHash!,
      facts: productFacts(`${label}商品`),
    }),
  );
  return { ...result, source };
}

async function cleanupUser(userId: string): Promise<void> {
  const turns = await resource.db.query.agentTurns.findMany({
    where: eq(agentTurns.userId, userId),
    columns: { id: true, sessionId: true },
  });
  const turnIds = turns.map((turn) => turn.id);
  if (turnIds.length > 0) {
    await resource.db.delete(eventOutbox).where(inArray(eventOutbox.scopeId, turnIds));
    await resource.db
      .delete(queueDispatchIntents)
      .where(inArray(queueDispatchIntents.aggregateId, turnIds));
    await resource.db
      .delete(agentTurnConfirmations)
      .where(inArray(agentTurnConfirmations.turnId, turnIds));
    await resource.db.delete(chatMessages).where(inArray(chatMessages.turnId, turnIds));
    await resource.db.delete(agentTraces).where(inArray(agentTraces.turnId, turnIds));
    await resource.db.delete(agentTurns).where(inArray(agentTurns.id, turnIds));
  }
  const sessionIds = [...new Set(turns.map((turn) => turn.sessionId))];
  if (sessionIds.length > 0) {
    await resource.db.delete(chatSessions).where(inArray(chatSessions.id, sessionIds));
  }
  await resource.db
    .update(products)
    .set({ primaryAssetId: null, latestFactSetId: null })
    .where(eq(products.userId, userId));
  await resource.db.update(assets).set({ productId: null }).where(eq(assets.userId, userId));
  await resource.db.delete(productFactSets).where(eq(productFactSets.userId, userId));
  await resource.db.delete(products).where(eq(products.userId, userId));
  await resource.db.delete(assets).where(eq(assets.userId, userId));
  await resource.db.delete(users).where(eq(users.id, userId));
}

afterEach(async () => {
  for (const userId of trackedUsers) await cleanupUser(userId);
  trackedUsers.clear();
});

afterAll(async () => {
  await resource.client.end();
});

describe('S12 product facts confirmation', () => {
  it('creates a product and first fact set atomically, then replays the same answer', async () => {
    const userId = await createUser('create');
    expect(
      await resource.db.query.creditAccounts.findFirst({
        where: eq(creditAccounts.userId, userId),
      }),
    ).toBeUndefined();
    const source = await createReadyAsset(userId, 'create-source');
    const pending = await createPendingConfirmation({
      userId,
      sourceAssetId: source.id,
      sourceVersion: source.contentHash!,
      mode: 'create_product',
    });
    const idempotencyKey = `s12-facts-create-${randomUUID()}`;
    const first = await confirmFacts({
      userId,
      turnId: pending.turnId,
      confirmationId: pending.confirmationId,
      idempotencyKey,
      skuCode: ' sku-01 ',
    });
    const replay = await confirmFacts({
      userId,
      turnId: pending.turnId,
      confirmationId: pending.confirmationId,
      idempotencyKey,
      skuCode: ' sku-01 ',
    });
    expect(replay).toEqual(first);
    const [productRows, factRows, asset, confirmation] = await Promise.all([
      resource.db.query.products.findMany({ where: eq(products.userId, userId) }),
      resource.db.query.productFactSets.findMany({ where: eq(productFactSets.userId, userId) }),
      resource.db.query.assets.findFirst({ where: eq(assets.id, source.id) }),
      resource.db.query.agentTurnConfirmations.findFirst({
        where: eq(agentTurnConfirmations.id, pending.confirmationId),
      }),
    ]);
    expect(productRows).toHaveLength(1);
    expect(productRows[0]?.skuCode).toBe('SKU-01');
    expect(factRows).toHaveLength(1);
    expect(factRows[0]?.factsJson).toEqual(productFacts('测试商品'));
    expect(asset?.productId).toBe(productRows[0]?.id);
    expect(confirmation?.status).toBe('answered');
  });

  it('rejects a changed idempotent answer and strict unknown fields', async () => {
    const userId = await createUser('strict');
    const source = await createReadyAsset(userId, 'strict-source');
    const pending = await createPendingConfirmation({
      userId,
      sourceAssetId: source.id,
      sourceVersion: source.contentHash!,
      mode: 'create_product',
    });
    const idempotencyKey = `s12-facts-strict-${randomUUID()}`;
    await confirmFacts({
      userId,
      turnId: pending.turnId,
      confirmationId: pending.confirmationId,
      idempotencyKey,
    });
    await expect(
      confirmFacts({
        userId,
        turnId: pending.turnId,
        confirmationId: pending.confirmationId,
        idempotencyKey,
        facts: productFacts('被篡改商品'),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const secondSource = await createReadyAsset(userId, 'strict-unknown-source');
    const secondPending = await createPendingConfirmation({
      userId,
      sourceAssetId: secondSource.id,
      sourceVersion: secondSource.contentHash!,
      mode: 'create_product',
    });
    await expect(
      confirmations.confirm(
        userId,
        secondPending.turnId,
        {
          confirmation_id: secondPending.confirmationId,
          confirmation_type: 'product_facts',
          confirmation_version: 1,
          answers: { facts: productFacts('测试商品'), injected: true },
        },
        `s12-facts-unknown-${randomUUID()}`,
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(
      await resource.db.query.agentTurnConfirmations.findFirst({
        where: eq(agentTurnConfirmations.id, secondPending.confirmationId),
      }),
    ).toMatchObject({ status: 'pending', answerJson: null });
  });

  it('links a new source to an existing product and appends the next fact version', async () => {
    const userId = await createUser('link');
    const existing = await createExistingProduct(userId, 'link');
    const source = await createReadyAsset(userId, 'link-source');
    const pending = await createPendingConfirmation({
      userId,
      sourceAssetId: source.id,
      sourceVersion: source.contentHash!,
      mode: 'link_product',
      productId: existing.productId,
      expectedLatestFactSetId: existing.factSetId,
    });
    await confirmFacts({
      userId,
      turnId: pending.turnId,
      confirmationId: pending.confirmationId,
      idempotencyKey: `s12-facts-link-${randomUUID()}`,
      facts: productFacts('更新后的商品'),
    });
    const [product, factRows, linkedSource] = await Promise.all([
      resource.db.query.products.findFirst({ where: eq(products.id, existing.productId) }),
      resource.db.query.productFactSets.findMany({
        where: eq(productFactSets.productId, existing.productId),
      }),
      resource.db.query.assets.findFirst({ where: eq(assets.id, source.id) }),
    ]);
    expect(product).toMatchObject({ revision: 3 });
    expect(factRows.map((row) => row.versionNo).sort()).toEqual([1, 2]);
    expect(linkedSource?.productId).toBe(existing.productId);
  });

  it('fails closed for cross-user resources and source hash drift without partial state', async () => {
    const ownerId = await createUser('owner');
    const attackerId = await createUser('attacker');
    const foreignSource = await createReadyAsset(ownerId, 'foreign-source');
    const pending = await createPendingConfirmation({
      userId: attackerId,
      sourceAssetId: foreignSource.id,
      sourceVersion: foreignSource.contentHash!,
      mode: 'create_product',
    });
    await expect(
      confirmFacts({
        userId: attackerId,
        turnId: pending.turnId,
        confirmationId: pending.confirmationId,
        idempotencyKey: `s12-facts-cross-user-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'REFERENCE_NOT_AVAILABLE' });

    const ownSource = await createReadyAsset(attackerId, 'drift-source');
    const driftPending = await createPendingConfirmation({
      userId: attackerId,
      sourceAssetId: ownSource.id,
      sourceVersion: ownSource.contentHash!,
      mode: 'create_product',
    });
    await resource.db
      .update(assets)
      .set({ contentHash: canonicalSha256({ drifted: true }) })
      .where(eq(assets.id, ownSource.id));
    await expect(
      confirmFacts({
        userId: attackerId,
        turnId: driftPending.turnId,
        confirmationId: driftPending.confirmationId,
        idempotencyKey: `s12-facts-drift-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'REFERENCE_NOT_AVAILABLE' });
    expect(
      await resource.db.query.products.findMany({ where: eq(products.userId, attackerId) }),
    ).toHaveLength(0);
    const confirmationRows = await resource.db.query.agentTurnConfirmations.findMany({
      where: eq(agentTurnConfirmations.userId, attackerId),
    });
    expect(confirmationRows).toHaveLength(2);
    expect(confirmationRows.every((row) => row.status === 'pending')).toBe(true);
  });

  it('allows exactly one concurrent fact revision and rolls the loser back', async () => {
    const userId = await createUser('concurrency');
    const existing = await createExistingProduct(userId, 'concurrency');
    const firstSource = await createReadyAsset(userId, 'concurrency-first');
    const secondSource = await createReadyAsset(userId, 'concurrency-second');
    const first = await createPendingConfirmation({
      userId,
      sourceAssetId: firstSource.id,
      sourceVersion: firstSource.contentHash!,
      mode: 'link_product',
      productId: existing.productId,
      expectedLatestFactSetId: existing.factSetId,
    });
    const second = await createPendingConfirmation({
      userId,
      sourceAssetId: secondSource.id,
      sourceVersion: secondSource.contentHash!,
      mode: 'link_product',
      productId: existing.productId,
      expectedLatestFactSetId: existing.factSetId,
    });
    const settled = await Promise.allSettled([
      confirmFacts({
        userId,
        turnId: first.turnId,
        confirmationId: first.confirmationId,
        idempotencyKey: `s12-facts-race-a-${randomUUID()}`,
      }),
      confirmFacts({
        userId,
        turnId: second.turnId,
        confirmationId: second.confirmationId,
        idempotencyKey: `s12-facts-race-b-${randomUUID()}`,
      }),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'TURN_STATE_INVALID' } });
    const [factRows, confirmationRows, sourceRows] = await Promise.all([
      resource.db.query.productFactSets.findMany({
        where: eq(productFactSets.productId, existing.productId),
      }),
      resource.db.query.agentTurnConfirmations.findMany({
        where: eq(agentTurnConfirmations.userId, userId),
      }),
      resource.db.query.assets.findMany({ where: eq(assets.userId, userId) }),
    ]);
    expect(factRows).toHaveLength(2);
    expect(confirmationRows.filter((row) => row.status === 'answered')).toHaveLength(1);
    expect(confirmationRows.filter((row) => row.status === 'pending')).toHaveLength(1);
    expect(sourceRows.filter((row) => row.productId === existing.productId)).toHaveLength(2);
  });
});
