import {
  and,
  artifacts,
  assets,
  count,
  desc,
  eq,
  lt,
  or,
  productFactSets,
  products,
  sql,
  type Database,
} from '@ecom-forge/db';
import { normalizeAgentProductFacts as normalizeProductFacts } from '@ecom-forge/agent';

import { SignedCursorCodec } from '../../shared/http/signed-cursor.js';
import { resourceError } from './resource.errors.js';
import {
  normalizeSku,
  type CreateFactSetInput,
  type CreateProductInput,
  type UpdateProductInput,
} from './resource.schemas.js';
import { ResourceWriteRepository } from './resource-write.repository.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class ProductFactsConfirmationError extends Error {
  constructor(
    readonly code: 'SOURCE_INVALID' | 'PRODUCT_INVALID' | 'VERSION_CONFLICT' | 'SKU_CONFLICT',
  ) {
    super(code);
    this.name = 'ProductFactsConfirmationError';
  }
}

export type ConfirmProductFactsInput =
  | {
      mode: 'create_product';
      sourceAssetId: string;
      sourceVersion: string;
      skuCode?: string;
      facts: CreateFactSetInput['facts'];
    }
  | {
      mode: 'link_product';
      sourceAssetId: string;
      sourceVersion: string;
      productId: string;
      expectedLatestFactSetId: string | null;
      facts: CreateFactSetInput['facts'];
    };

function isSkuUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    const databaseError = current as Error & {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
    };
    if (
      databaseError.code === '23505' &&
      (databaseError.constraint === 'products_user_sku_unique' ||
        databaseError.constraint_name === 'products_user_sku_unique')
    ) {
      return true;
    }
    current = databaseError.cause;
  }
  return false;
}

function productDto(row: typeof products.$inferSelect, artifactCount = 0) {
  return {
    id: row.id,
    name: row.name,
    sku_code: row.skuCode,
    status: row.status,
    revision: row.revision,
    primary_asset_id: row.primaryAssetId,
    primary_asset_preview: row.primaryAssetId ? { variant: 'thumbnail' as const } : null,
    artifact_count: artifactCount,
    updated_at: row.updatedAt.toISOString(),
  };
}

async function assertReadyAsset(
  transaction: Pick<Transaction, 'select'>,
  userId: string,
  assetId: string,
  productId?: string,
) {
  // Retain the lifecycle check until the binding commits; deletion locks the asset first too.
  const [asset] = await transaction
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.userId, userId)))
    .for('share');
  if (!asset) resourceError('RESOURCE_NOT_FOUND');
  if (asset.status !== 'ready') resourceError('ASSET_NOT_READY');
  if (productId && asset.productId && asset.productId !== productId) {
    resourceError('RESOURCE_NOT_FOUND');
  }
  return asset;
}

export class ProductService {
  private readonly cursor: SignedCursorCodec;
  private readonly writes: ResourceWriteRepository;

  constructor(database: Database, cursorSecret: string, idempotencySecret: string) {
    this.database = database;
    this.cursor = new SignedCursorCodec(cursorSecret);
    this.writes = new ResourceWriteRepository(database, idempotencySecret);
  }

  private readonly database: Database;

  async confirmFactsInTransaction(
    transaction: Transaction,
    userId: string,
    input: ConfirmProductFactsInput,
  ): Promise<{ productId: string; factSetId: string; versionNo: number }> {
    const [source] = await transaction
      .select()
      .from(assets)
      .where(and(eq(assets.id, input.sourceAssetId), eq(assets.userId, userId)))
      .for('update');
    if (
      !source ||
      source.status !== 'ready' ||
      !source.contentHash ||
      source.contentHash !== input.sourceVersion
    ) {
      throw new ProductFactsConfirmationError('SOURCE_INVALID');
    }
    const facts = normalizeProductFacts(input.facts);
    let product: typeof products.$inferSelect;
    let versionNo: number;
    if (input.mode === 'create_product') {
      if (source.productId) throw new ProductFactsConfirmationError('SOURCE_INVALID');
      const [created] = await transaction
        .insert(products)
        .values({
          userId,
          name: facts.product_name,
          skuCode: normalizeSku(input.skuCode),
          primaryAssetId: source.id,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) throw new ProductFactsConfirmationError('SKU_CONFLICT');
      product = created;
      versionNo = 1;
    } else {
      const [existing] = await transaction
        .select()
        .from(products)
        .where(and(eq(products.id, input.productId), eq(products.userId, userId)))
        .for('update');
      if (!existing || existing.status !== 'active') {
        throw new ProductFactsConfirmationError('PRODUCT_INVALID');
      }
      if (
        existing.latestFactSetId !== input.expectedLatestFactSetId ||
        (source.productId !== null && source.productId !== existing.id)
      ) {
        throw new ProductFactsConfirmationError('VERSION_CONFLICT');
      }
      const [latest] = await transaction
        .select({ versionNo: productFactSets.versionNo })
        .from(productFactSets)
        .where(eq(productFactSets.productId, existing.id))
        .orderBy(desc(productFactSets.versionNo))
        .limit(1);
      product = existing;
      versionNo = (latest?.versionNo ?? 0) + 1;
    }
    const now = new Date();
    const [factSet] = await transaction
      .insert(productFactSets)
      .values({
        userId,
        productId: product.id,
        versionNo,
        sourceAssetId: source.id,
        sourceVersion: source.contentHash,
        factsJson: facts,
        confirmedBy: userId,
        confirmedAt: now,
      })
      .returning({ id: productFactSets.id });
    if (!factSet) throw new Error('Product fact confirmation insert returned no row');
    const [updatedProduct] = await transaction
      .update(products)
      .set({ latestFactSetId: factSet.id, revision: product.revision + 1, updatedAt: now })
      .where(and(eq(products.id, product.id), eq(products.revision, product.revision)))
      .returning({ id: products.id });
    if (!updatedProduct) throw new ProductFactsConfirmationError('VERSION_CONFLICT');
    if (source.productId === null) {
      const [bound] = await transaction
        .update(assets)
        .set({ productId: product.id, updatedAt: now })
        .where(
          and(
            eq(assets.id, source.id),
            eq(assets.userId, userId),
            sql`${assets.productId} is null`,
          ),
        )
        .returning({ id: assets.id });
      if (!bound) throw new ProductFactsConfirmationError('VERSION_CONFLICT');
    }
    return { productId: product.id, factSetId: factSet.id, versionNo };
  }

  async list(
    userId: string,
    input: {
      query?: string;
      status?: 'active' | 'archived';
      cursor?: string;
      limit: number;
    },
  ) {
    const filters = { query: input.query ?? null, status: input.status ?? null };
    const position = input.cursor
      ? this.cursor.decode({ cursor: input.cursor, userId, endpoint: 'products', filters })
      : undefined;
    const queryPattern = input.query ? `%${input.query}%` : undefined;
    const rows = await this.database
      .select({ product: products, artifactCount: count(artifacts.id) })
      .from(products)
      .leftJoin(artifacts, and(eq(artifacts.productId, products.id), eq(artifacts.userId, userId)))
      .where(
        and(
          eq(products.userId, userId),
          input.status ? eq(products.status, input.status) : undefined,
          queryPattern
            ? or(
                sql`${products.name} ilike ${queryPattern}`,
                sql`${products.skuCode} ilike ${queryPattern}`,
              )
            : undefined,
          position
            ? or(
                lt(products.updatedAt, position.createdAt),
                and(eq(products.updatedAt, position.createdAt), lt(products.id, position.id)),
              )
            : undefined,
        ),
      )
      .groupBy(products.id)
      .orderBy(desc(products.updatedAt), desc(products.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1)?.product;
    return {
      items: page.map((row) => productDto(row.product, Number(row.artifactCount))),
      next_cursor:
        rows.length > input.limit && last
          ? this.cursor.encode({
              userId,
              endpoint: 'products',
              filters,
              position: { createdAt: last.updatedAt, id: last.id },
            })
          : null,
    };
  }

  async get(userId: string, productId: string) {
    const product = await this.database.query.products.findFirst({
      where: and(eq(products.id, productId), eq(products.userId, userId)),
    });
    if (!product) resourceError('RESOURCE_NOT_FOUND');
    const [latestFact, artifactRows, assetRows] = await Promise.all([
      product.latestFactSetId
        ? this.database.query.productFactSets.findFirst({
            where: and(
              eq(productFactSets.id, product.latestFactSetId),
              eq(productFactSets.userId, userId),
            ),
          })
        : undefined,
      this.database
        .select({ value: count() })
        .from(artifacts)
        .where(and(eq(artifacts.userId, userId), eq(artifacts.productId, product.id))),
      this.database
        .select({ value: count() })
        .from(assets)
        .where(and(eq(assets.userId, userId), eq(assets.productId, product.id))),
    ]);
    return {
      ...productDto(product, Number(artifactRows[0]?.value ?? 0)),
      latest_fact_set: latestFact
        ? {
            id: latestFact.id,
            version_no: latestFact.versionNo,
            source_asset_id: latestFact.sourceAssetId,
            facts: latestFact.factsJson,
            confirmed_at: latestFact.confirmedAt?.toISOString() ?? null,
          }
        : null,
      asset_count: Number(assetRows[0]?.value ?? 0),
      workflow_count: 0,
      credit_summary: null,
    };
  }

  create(userId: string, input: CreateProductInput, idempotencyKey: string) {
    const normalized = { ...input, sku_code: normalizeSku(input.sku_code) };
    return this.writes.execute({
      userId,
      operation: 'POST /products',
      idempotencyKey,
      request: normalized,
      responseStatus: 201,
      write: async (transaction) => {
        if (normalized.primary_asset_id) {
          await assertReadyAsset(transaction, userId, normalized.primary_asset_id);
        }
        const [created] = await transaction
          .insert(products)
          .values({
            userId,
            name: normalized.name,
            skuCode: normalized.sku_code,
            primaryAssetId: normalized.primary_asset_id,
          })
          .onConflictDoNothing()
          .returning();
        if (!created) resourceError('PRODUCT_SKU_CONFLICT');
        return productDto(created);
      },
    });
  }

  async update(
    userId: string,
    productId: string,
    input: UpdateProductInput,
    idempotencyKey: string,
  ) {
    const normalized = {
      ...input,
      ...(input.sku_code !== undefined ? { sku_code: normalizeSku(input.sku_code) } : {}),
    };
    try {
      return await this.writes.execute({
        userId,
        operation: 'PATCH /products/{id}',
        idempotencyKey,
        request: { product_id: productId, ...normalized },
        responseStatus: 200,
        write: async (transaction) => {
          const current = await transaction.query.products.findFirst({
            where: and(eq(products.id, productId), eq(products.userId, userId)),
          });
          if (!current) resourceError('RESOURCE_NOT_FOUND');
          if (normalized.primary_asset_id) {
            await assertReadyAsset(transaction, userId, normalized.primary_asset_id, productId);
          }
          const [updated] = await transaction
            .update(products)
            .set({
              ...(normalized.name !== undefined ? { name: normalized.name } : {}),
              ...(normalized.sku_code !== undefined ? { skuCode: normalized.sku_code } : {}),
              ...(normalized.primary_asset_id !== undefined
                ? { primaryAssetId: normalized.primary_asset_id }
                : {}),
              ...(normalized.status !== undefined ? { status: normalized.status } : {}),
              revision: input.revision + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(products.id, productId),
                eq(products.userId, userId),
                eq(products.revision, input.revision),
              ),
            )
            .returning();
          if (!updated) resourceError('PRODUCT_REVISION_CONFLICT');
          return productDto(updated);
        },
      });
    } catch (error) {
      if (isSkuUniqueViolation(error)) resourceError('PRODUCT_SKU_CONFLICT');
      throw error;
    }
  }

  createFacts(
    userId: string,
    productId: string,
    input: CreateFactSetInput,
    idempotencyKey: string,
  ) {
    const normalizedFacts = normalizeProductFacts(input.facts);
    return this.writes.execute({
      userId,
      operation: 'POST /products/{id}/fact-sets',
      idempotencyKey,
      request: { product_id: productId, ...input, facts: normalizedFacts },
      responseStatus: 201,
      write: async (transaction) => {
        const source = await assertReadyAsset(
          transaction,
          userId,
          input.source_asset_id,
          productId,
        );
        const [product] = await transaction
          .select()
          .from(products)
          .where(and(eq(products.id, productId), eq(products.userId, userId)))
          .for('update');
        if (!product) resourceError('RESOURCE_NOT_FOUND');
        if (product.status !== 'active') resourceError('RESOURCE_NOT_FOUND');
        if (product.latestFactSetId !== input.expected_latest_fact_set_id) {
          resourceError('PRODUCT_FACT_VERSION_CONFLICT');
        }
        if (!source.contentHash) resourceError('ASSET_NOT_READY');
        const [latest] = await transaction
          .select({ versionNo: productFactSets.versionNo })
          .from(productFactSets)
          .where(eq(productFactSets.productId, productId))
          .orderBy(desc(productFactSets.versionNo))
          .limit(1);
        const now = new Date();
        const [fact] = await transaction
          .insert(productFactSets)
          .values({
            userId,
            productId,
            versionNo: (latest?.versionNo ?? 0) + 1,
            sourceAssetId: source.id,
            sourceVersion: source.contentHash,
            factsJson: normalizedFacts,
            confirmedBy: userId,
            confirmedAt: now,
          })
          .returning();
        if (!fact) throw new Error('Fact set insert returned no row');
        await transaction
          .update(products)
          .set({ latestFactSetId: fact.id, revision: product.revision + 1, updatedAt: now })
          .where(and(eq(products.id, product.id), eq(products.revision, product.revision)));
        return {
          id: fact.id,
          product_id: productId,
          version_no: fact.versionNo,
          source_asset_id: fact.sourceAssetId,
          facts: fact.factsJson,
          confirmed_at: now.toISOString(),
        };
      },
    });
  }
}
