import { z } from 'zod';
import { agentProductFactsSchema as productFactsSchema } from '@ecom-forge/agent';

export { productFactsSchema };
export { normalizeProductFactList as normalizeFactList } from '@ecom-forge/agent';

export const uuid = z.uuid();
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x20-\x7E]+$/);

const optionalUuid = uuid.optional();
const nullableUuid = uuid.nullable();

export const createProductSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  sku_code: z.string().max(80).optional(),
  primary_asset_id: optionalUuid,
});

export const updateProductSchema = z
  .strictObject({
    revision: z.int().positive(),
    name: z.string().trim().min(1).max(120).optional(),
    sku_code: z.string().max(80).nullable().optional(),
    primary_asset_id: nullableUuid.optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .refine(
    ({ revision: _revision, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    'At least one product change is required',
  );

export const createFactSetSchema = z.strictObject({
  expected_latest_fact_set_id: nullableUuid,
  source_asset_id: uuid,
  facts: productFactsSchema,
});

export const productListQuerySchema = z.strictObject({
  query: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'archived']).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const uploadIntentSchema = z.strictObject({
  display_name: z.string().trim().min(1).max(180),
  declared_mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  file_size_bytes: z.coerce
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
  product_id: optionalUuid,
  folder_id: optionalUuid,
});

export const completeUploadSchema = z.strictObject({ upload_id: uuid, asset_id: uuid });
export const retryAssetSchema = z.strictObject({ reason: z.literal('user_requested') });
export const deleteAssetSchema = z.strictObject({
  reason: z.literal('user_requested'),
  expected_revision: z.int().positive(),
});
export const accessUrlSchema = z.strictObject({
  variant: z.enum(['original', 'thumbnail']),
  purpose: z.enum(['preview', 'download']),
});

export const assetListQuerySchema = z.strictObject({
  product_id: optionalUuid,
  folder_id: optionalUuid,
  status: z
    .enum(['uploading', 'processing', 'ready', 'processing_failed', 'rejected', 'deleted'])
    .optional(),
  kind: z.enum(['upload', 'generated', 'imported']).optional(),
  query: z.string().trim().max(180).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const artifactListQuerySchema = z.strictObject({
  product_id: optionalUuid,
  sku_code: z.string().trim().max(80).optional(),
  type: z.enum(['image', 'video', 'text']).optional(),
  origin_domain: z.enum(['creative', 'commerce']).optional(),
  producer_mode: z.enum(['chat', 'canvas', 'suite']).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const saveArtifactSchema = z.strictObject({
  folder_id: optionalUuid,
  product_id: optionalUuid,
});

export function parseIdempotencyKey(value: string | undefined): string {
  return idempotencyKeySchema.parse(value);
}

export function normalizeSku(value: string | null | undefined): string | null {
  const normalized = value?.trim().normalize('NFKC').toUpperCase() ?? '';
  return normalized || null;
}

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type CreateFactSetInput = z.infer<typeof createFactSetSchema>;
export type UploadIntentInput = z.infer<typeof uploadIntentSchema>;
export type DeleteAssetInput = z.infer<typeof deleteAssetSchema>;
export type AssetListQuery = z.infer<typeof assetListQuerySchema>;
export type ArtifactListQuery = z.infer<typeof artifactListQuerySchema>;
