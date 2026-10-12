import type { AgentModelSelectionSnapshot, CompilerContext } from '@ecom-forge/compiler';
import type {
  billableSkus,
  modelCatalogEntries,
  models,
  providerChannels,
  providerCredentialVersions,
} from '@ecom-forge/db';
import { mediaV2CapabilityContractSchema, mediaRateCardV2Schema } from '@ecom-forge/provider';
import { canonicalSha256, normalizeMoney } from '@ecom-forge/shared';
import { z } from 'zod';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const moderationRouteSchema = z.strictObject({
  capability: z.enum(['moderation.text', 'moderation.image']),
  runtime_revision: z.int().positive(),
  model_snapshot_id: z.uuid(),
  credential_version_id: z.uuid(),
  policy_version: z.string().min(1).max(128),
  evidence_digest: sha256,
  pricing_digest: sha256,
  risk_adjusted_cost_cny: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
    .nullable(),
});
const releaseEntrySchema = z.strictObject({
  id: z.uuid(),
  model_snapshot_id: z.uuid(),
  public_slug: z.string(),
  version_no: z.int().positive(),
  category: z.enum(['brain', 'image', 'video']),
  display_name: z.string(),
  description: z.string(),
  public_capabilities: z.record(z.string(), z.unknown()),
  rollout: z.strictObject({
    stage: z.enum(['local', 'test', 'staging', 'beta', 'production']),
    percentage: z.int().min(0).max(100),
  }),
  user_selectable: z.boolean(),
  is_default: z.boolean(),
  sort_order: z.int(),
  revision: z.int().positive(),
});
const releaseSkuSchema = z.strictObject({
  id: z.uuid(),
  logical_sku_key: z.string().min(1).max(128),
  version_no: z.int().positive(),
  model_catalog_entry_id: z.uuid(),
  operation: z.enum(['image.generate', 'image.edit', 'upscale', 'video.generate']),
  matcher: z.record(z.string(), z.unknown()),
  matcher_hash: sha256,
  unit_kind: z.enum(['image', 'second', 'segment', 'megapixel']),
  unit_rule: z.record(z.string(), z.unknown()),
  credits_per_unit: z.string(),
  provider_rate_card_key: z.string().min(1).max(128),
  provider_cost_per_unit_cny: z.string().nullable(),
  revision: z.int().positive(),
});
const s12PricingManifestSchema = z.strictObject({
  schema_version: z.literal(2),
  entries: z.array(releaseEntrySchema),
  skus: z.array(releaseSkuSchema),
  defaults: z.strictObject({
    brain: z.uuid().optional(),
    image: z.uuid().optional(),
    video: z.uuid().optional(),
  }),
  moderation: z.strictObject({
    schema_version: z.literal(1),
    text: moderationRouteSchema.extend({ capability: z.literal('moderation.text') }),
    image: moderationRouteSchema.extend({ capability: z.literal('moderation.image') }),
  }),
});

type ModelRow = typeof models.$inferSelect;
type EntryRow = typeof modelCatalogEntries.$inferSelect;
type SkuRow = typeof billableSkus.$inferSelect;
type ChannelRow = typeof providerChannels.$inferSelect;
type CredentialRow = typeof providerCredentialVersions.$inferSelect;

export function resolveMediaModelClosure(input: {
  manifestJson: unknown;
  selection: AgentModelSelectionSnapshot;
  model: ModelRow;
  catalogEntry: EntryRow;
  skuRows: readonly SkuRow[];
  channel: ChannelRow;
  credential: CredentialRow;
}): NonNullable<CompilerContext['model_selection']> {
  const manifest = s12PricingManifestSchema.safeParse(input.manifestJson);
  const capability = mediaV2CapabilityContractSchema.safeParse(input.model.capabilityContractJson);
  const pricing = mediaRateCardV2Schema.safeParse(input.model.pricingJson);
  if (!manifest.success || !capability.success || !pricing.success) {
    throw new Error('MODEL_CATALOG_CLOSURE_INVALID');
  }
  const selected = input.selection.image;
  const entry = manifest.data.entries.find(
    (candidate) => candidate.id === selected.catalog_entry_id,
  );
  if (
    !entry ||
    entry.category !== 'image' ||
    !entry.user_selectable ||
    entry.version_no !== selected.version_no ||
    entry.revision !== selected.catalog_entry_revision ||
    entry.model_snapshot_id !== selected.model_snapshot_id ||
    input.catalogEntry.id !== entry.id ||
    input.catalogEntry.status !== 'approved' ||
    !input.catalogEntry.userSelectable ||
    input.catalogEntry.versionNo !== entry.version_no ||
    input.catalogEntry.revision !== entry.revision ||
    input.catalogEntry.modelSnapshotId !== entry.model_snapshot_id ||
    input.model.id !== entry.model_snapshot_id ||
    input.model.status !== 'poc_passed' ||
    !input.model.statusEvidenceDigest ||
    !input.model.providerChannelId ||
    input.channel.id !== input.model.providerChannelId ||
    input.channel.provider !== input.model.provider ||
    input.channel.status !== 'active' ||
    input.channel.activeCredentialVersionId !== input.credential.id ||
    input.credential.providerChannelId !== input.channel.id ||
    input.credential.status !== 'active' ||
    capability.data.media_kind !== 'image'
  ) {
    throw new Error('MODEL_CATALOG_CLOSURE_INVALID');
  }
  const spec = capability.data.specs.find(
    (candidate) =>
      candidate.kind === 'image' &&
      candidate.spec_key === selected.selected_spec_key &&
      candidate.operation === selected.selected_operation,
  );
  if (!spec || (spec.operation !== 'image.generate' && spec.operation !== 'image.edit')) {
    throw new Error('MODEL_CATALOG_CLOSURE_INVALID');
  }
  const matchingSkus = manifest.data.skus.filter(
    (sku) =>
      sku.model_catalog_entry_id === entry.id &&
      sku.operation === spec.operation &&
      imageMatcherMatches(sku.matcher, spec),
  );
  if (matchingSkus.length !== 1 || !matchingSkus[0]) {
    throw new Error('MODEL_CATALOG_CLOSURE_INVALID');
  }
  const sku = matchingSkus[0];
  const skuRow = input.skuRows.find((row) => row.id === sku.id);
  const rate = pricing.data.rate_cards.find((candidate) => candidate.spec_key === spec.spec_key);
  if (
    !skuRow ||
    skuRow.status !== 'approved' ||
    skuRow.modelCatalogEntryId !== entry.id ||
    skuRow.versionNo !== sku.version_no ||
    skuRow.revision !== sku.revision ||
    skuRow.operation !== sku.operation ||
    canonicalSha256(sku.matcher) !== sku.matcher_hash ||
    canonicalSha256(skuRow.matcherJson) !== sku.matcher_hash ||
    canonicalSha256(skuRow.unitRuleJson) !== canonicalSha256(sku.unit_rule) ||
    skuRow.unitKind !== sku.unit_kind ||
    normalizeMoney(skuRow.creditsPerUnit) !== normalizeMoney(sku.credits_per_unit) ||
    !rate ||
    rate.rate_key !== sku.provider_rate_card_key ||
    (rate.unit_cost_cny === null) !== (sku.provider_cost_per_unit_cny === null) ||
    (rate.unit_cost_cny !== null &&
      normalizeMoney(rate.unit_cost_cny) !== normalizeMoney(sku.provider_cost_per_unit_cny!)) ||
    (skuRow.providerCostPerUnitCny === null) !== (sku.provider_cost_per_unit_cny === null) ||
    (skuRow.providerCostPerUnitCny !== null &&
      normalizeMoney(skuRow.providerCostPerUnitCny) !==
        normalizeMoney(sku.provider_cost_per_unit_cny!)) ||
    rate.billing_unit !== sku.unit_kind ||
    (sku.unit_kind !== 'image' && sku.unit_kind !== 'megapixel')
  ) {
    throw new Error('MODEL_CATALOG_CLOSURE_INVALID');
  }
  return {
    schema_version: 1,
    catalog_revision: input.selection.catalog_revision,
    catalog_release_id: input.selection.catalog_release_id,
    catalog_release_digest: input.selection.catalog_release_digest,
    image: {
      catalog_entry_id: entry.id,
      catalog_entry_revision: entry.revision,
      version_no: entry.version_no,
      model_snapshot_id: entry.model_snapshot_id,
      selected_spec_key: spec.spec_key,
      runtime: {
        provider_channel_id: input.channel.id,
        provider_channel_revision: input.channel.revision,
        adapter_key: input.channel.adapterKey,
        endpoint_profile_key: input.channel.endpointProfileKey,
        region: input.channel.region,
        credential_version_id: input.credential.id,
      },
      billing_sku: {
        id: sku.id,
        logical_sku_key: sku.logical_sku_key,
        version_no: sku.version_no,
        model_catalog_entry_id: sku.model_catalog_entry_id,
        operation: spec.operation,
        matcher: sku.matcher,
        matcher_hash: sku.matcher_hash,
        unit_kind: sku.unit_kind,
        unit_rule: sku.unit_rule,
        credits_per_unit: normalizeMoney(sku.credits_per_unit),
        provider_rate_card_key: sku.provider_rate_card_key,
        provider_cost_per_unit_cny:
          sku.provider_cost_per_unit_cny === null
            ? null
            : normalizeMoney(sku.provider_cost_per_unit_cny),
        revision: sku.revision,
      },
    },
    moderation: manifest.data.moderation,
  };
}

function imageMatcherMatches(
  matcher: Record<string, unknown>,
  spec: Extract<
    ReturnType<typeof mediaV2CapabilityContractSchema.parse>['specs'][number],
    { kind: 'image' }
  >,
): boolean {
  const tier =
    spec.max_reference_images === 0
      ? 'none'
      : spec.max_reference_images <= 4
        ? 'standard'
        : 'extended';
  return (
    matcher.schema_version === 1 &&
    matcher.kind === 'image' &&
    matcher.mode === spec.mode &&
    matcher.resolution === spec.resolution_tier &&
    matcher.transparent_background === spec.transparent_background &&
    matcher.reference_tier === tier
  );
}
