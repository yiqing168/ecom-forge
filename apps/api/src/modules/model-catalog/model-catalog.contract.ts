import { canonicalSha256 } from '@ecom-forge/shared';
import { z } from 'zod';

import type { AppEnvironment } from '../../config/app-config.js';

export const modelCatalogRolloutSchema = z.strictObject({
  stage: z.enum(['local', 'test', 'staging', 'beta', 'production']),
  percentage: z.number().int().min(0).max(100),
});

export const modelCatalogEntryManifestSchema = z.strictObject({
  id: z.uuid(),
  model_snapshot_id: z.uuid(),
  public_slug: z.string(),
  version_no: z.number().int().positive(),
  category: z.enum(['brain', 'image', 'video']),
  display_name: z.string(),
  description: z.string(),
  public_capabilities: z.record(z.string(), z.unknown()),
  rollout: modelCatalogRolloutSchema,
  user_selectable: z.boolean(),
  is_default: z.boolean(),
  sort_order: z.number().int(),
  revision: z.number().int().positive(),
});

export const modelCatalogSkuManifestSchema = z.strictObject({
  id: z.uuid(),
  logical_sku_key: z.string(),
  version_no: z.number().int().positive(),
  model_catalog_entry_id: z.uuid(),
  operation: z.string(),
  matcher: z.record(z.string(), z.unknown()),
  matcher_hash: z.string(),
  unit_kind: z.string(),
  unit_rule: z.record(z.string(), z.unknown()),
  credits_per_unit: z.string(),
  provider_rate_card_key: z.string(),
  provider_cost_per_unit_cny: z.string().nullable(),
  revision: z.number().int().positive(),
});

const modelCatalogManifestFields = {
  entries: z.array(modelCatalogEntryManifestSchema),
  skus: z.array(modelCatalogSkuManifestSchema),
  defaults: z.strictObject({
    brain: z.uuid().optional(),
    image: z.uuid().optional(),
    video: z.uuid().optional(),
  }),
} as const;

const moderationRouteSchema = z.strictObject({
  capability: z.enum(['moderation.text', 'moderation.image']),
  runtime_revision: z.number().int().positive(),
  model_snapshot_id: z.uuid(),
  credential_version_id: z.uuid(),
  policy_version: z.string().min(1).max(128),
  evidence_digest: z.string().regex(/^[a-f0-9]{64}$/),
  pricing_digest: z.string().regex(/^[a-f0-9]{64}$/),
  risk_adjusted_cost_cny: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
    .nullable(),
});

const modelCatalogManifestV1Schema = z.strictObject({
  schema_version: z.literal(1),
  ...modelCatalogManifestFields,
});

const modelCatalogManifestV2Schema = z.strictObject({
  schema_version: z.literal(2),
  ...modelCatalogManifestFields,
  moderation: z.strictObject({
    schema_version: z.literal(1),
    text: moderationRouteSchema.extend({ capability: z.literal('moderation.text') }),
    image: moderationRouteSchema.extend({ capability: z.literal('moderation.image') }),
  }),
});

export const modelCatalogManifestSchema = z.discriminatedUnion('schema_version', [
  modelCatalogManifestV1Schema,
  modelCatalogManifestV2Schema,
]);

export type ModelCatalogEntryManifest = z.infer<typeof modelCatalogEntryManifestSchema>;
export type ModelCatalogManifest = z.infer<typeof modelCatalogManifestSchema>;

export function isModelCatalogRolloutVisible(input: {
  appEnv: AppEnvironment;
  entryId: string;
  userId: string;
  rollout: z.infer<typeof modelCatalogRolloutSchema>;
}): boolean {
  if (input.rollout.percentage === 0) return false;
  if (input.appEnv !== 'local' && input.appEnv !== 'test' && input.rollout.stage !== input.appEnv) {
    return false;
  }
  if (input.rollout.percentage === 100) return true;
  const digest = canonicalSha256({
    schema_version: 1,
    purpose: 'model_catalog_rollout',
    entry_id: input.entryId,
    user_id: input.userId,
  });
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % 100;
  return bucket < input.rollout.percentage;
}
