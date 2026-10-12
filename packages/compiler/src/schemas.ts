import {
  mediaV2ModelSnapshotSchema,
  modelSnapshotSchema,
  providerCapabilitySchema,
} from '@ecom-forge/provider';
import { canonicalSha256, CREATIVE_DIRECTION_PROFILE_IDS } from '@ecom-forge/shared';
import { z } from 'zod';
import { parseSkillExecutionPolicy, type SkillExecutionPolicy } from '@ecom-forge/shared';
import {
  creativeDirectionSelectionSchema,
  generationScopeDecisionSchema,
  imageSourceGroupSchema,
} from '@ecom-forge/agent';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalUuidSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase(), 'UUID must use lowercase canonical form');
const exactSkillIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const moneySchema = z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/);
const versionSchema = z.string().min(1).max(128);
export const bindingRoleSchema = z.enum([
  'product',
  'style_reference',
  'composition_reference',
  'identity_anchor',
  'semantic_reference',
  'edit_source',
  'other',
]);

export const executionAuthorizationSchema = z.strictObject({
  schema_version: z.literal(2),
  kind: z.literal('generate_action'),
  create_request_hash: sha256Schema,
  policy_version: versionSchema,
});

const candidateNodeSchema = z.strictObject({
  candidate_key: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  capability: providerCapabilitySchema,
  capability_version: z.int().positive(),
  depends_on: z.array(z.string().min(1).max(64)).max(32),
  input_bindings: z.array(z.string().min(1).max(128)).max(16),
  params: z.record(z.string(), z.unknown()),
  expected_output: z.enum(['image', 'text']),
});

export const sourceDecisionSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('refine_latest'),
    output_binding_key: z.string().min(1).max(128),
    reason_summary: z.string().trim().min(1).max(240),
  }),
  z.strictObject({
    mode: z.literal('restart_original'),
    output_binding_key: z.string().min(1).max(128),
    original_source_binding_key: z.string().min(1).max(128),
    reason_summary: z.string().trim().min(1).max(240),
  }),
]);

export const candidatePlanSchema = z
  .strictObject({
    schema_version: z.literal(1),
    intent: z.strictObject({
      kind: z.enum([
        'creative_generate',
        'commerce_generate',
        'chat_artifact_edit',
        'external_artifact_edit',
        'raw_asset_generate',
      ]),
      confidence: z.number().min(0).max(1),
    }),
    skill_id: exactSkillIdSchema,
    source: z.literal('chat'),
    creative_direction_profile_id: z.enum(CREATIVE_DIRECTION_PROFILE_IDS).optional(),
    source_decision: sourceDecisionSchema.optional(),
    scope_decision: generationScopeDecisionSchema.optional(),
    nodes: z.array(candidateNodeSchema).min(1).max(32),
  })
  .superRefine((value, context) => {
    const keys = new Set<string>();
    for (const [index, node] of value.nodes.entries()) {
      if (keys.has(node.candidate_key)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'candidate_key'],
          message: 'Candidate keys must be unique',
        });
      }
      keys.add(node.candidate_key);
      if (new Set(node.depends_on).size !== node.depends_on.length) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'depends_on'],
          message: 'Dependencies must be unique',
        });
      }
      if (new Set(node.input_bindings).size !== node.input_bindings.length) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'input_bindings'],
          message: 'Input bindings must be unique',
        });
      }
    }
  });

export const bindingSchema = z
  .strictObject({
    binding_key: z.string().min(1).max(128),
    kind: z.enum(['asset', 'artifact']),
    object_id: canonicalUuidSchema,
    object_version: z.string().min(1).max(128),
    content_hash: sha256Schema,
    owner_user_id: canonicalUuidSchema,
    readable: z.boolean(),
    mutable: z.boolean(),
    producer_mode: z.enum(['chat', 'canvas', 'suite']).nullable(),
    producer_session_id: canonicalUuidSchema.nullable(),
    mutation_owner: z.enum(['chat_session', 'canvas', 'suite']).nullable(),
    source_action: z.enum(['generate', 'edit', 'replace']).nullable(),
    media_type: z.enum(['image', 'text']),
    lifecycle: z.enum(['active', 'quarantined', 'deleted']),
    visibility: z.enum(['private', 'shared', 'public', 'quarantined', 'deleted']),
    role: bindingRoleSchema.optional(),
    position: z.int().min(0).max(15).optional(),
    publication_revision: z.int().positive().nullable().optional(),
    candidate_kind: z.enum(['latest_output', 'original_source']).optional(),
    candidate_position: z.int().min(1).max(16).optional(),
    lineage_source_binding_keys: z.array(z.string().min(1).max(128)).max(9).optional(),
    source_group: imageSourceGroupSchema.optional(),
  })
  .superRefine((binding, context) => {
    if (binding.candidate_kind === 'original_source' && (binding.candidate_position ?? 0) > 9) {
      context.addIssue({
        code: 'custom',
        path: ['candidate_position'],
        message: 'Original source candidate position exceeds nine',
      });
    }
  });

export const attachmentSnapshotSchema = bindingSchema.safeExtend({
  role: bindingRoleSchema,
  position: z.int().min(0).max(15),
});

export const generationPreferencesSchema = z.strictObject({
  schema_version: z.literal(2),
  output_kind: z.literal('image'),
  aspect_ratio: z.union([z.literal('auto'), z.string().regex(/^[1-9]\d{0,2}:[1-9]\d{0,2}$/)]),
  resolution_tier: z.enum(['1k', '2k', '4k']),
  creative_direction: creativeDirectionSelectionSchema.optional(),
});

const selectedCatalogEntrySnapshotSchema = z.strictObject({
  catalog_entry_id: canonicalUuidSchema,
  catalog_entry_revision: z.int().positive(),
  version_no: z.int().positive(),
  public_slug: z.string().min(1).max(128),
  display_name: z.string().min(1).max(128),
  model_snapshot_id: canonicalUuidSchema,
});

export const agentModelSelectionSnapshotSchema = z.strictObject({
  schema_version: z.literal(1),
  catalog_revision: z.int().positive(),
  catalog_release_id: canonicalUuidSchema,
  catalog_release_digest: sha256Schema,
  brain: selectedCatalogEntrySnapshotSchema,
  image: selectedCatalogEntrySnapshotSchema.extend({
    selected_spec_key: z.string().min(1).max(128),
    selected_operation: z.enum(['image.generate', 'image.edit']),
    supported_aspect_ratios: z
      .array(z.string().regex(/^[1-9]\d{0,2}:[1-9]\d{0,2}$/))
      .min(1)
      .max(32)
      .optional(),
    max_prompt_characters: z.int().min(4_000).max(128_000).optional(),
  }),
});

const compilerRuntimeFields = {
  status_evidence_digest: sha256Schema.nullable(),
  capability_contract_digest: sha256Schema,
  pricing_digest: sha256Schema,
  quota_digest: sha256Schema,
  circuit_allows_submit: z.boolean(),
  budget_allows_submit: z.boolean(),
} as const;

const legacyCompilerModelSchema = modelSnapshotSchema.extend(compilerRuntimeFields);
const mediaCompilerModelSchema = mediaV2ModelSnapshotSchema.extend(compilerRuntimeFields);
const compilerModelSchema = z.union([legacyCompilerModelSchema, mediaCompilerModelSchema]);

const billingSkuClosureSchema = z.strictObject({
  id: canonicalUuidSchema,
  logical_sku_key: z.string().min(1).max(128),
  version_no: z.int().positive(),
  model_catalog_entry_id: canonicalUuidSchema,
  operation: z.enum(['image.generate', 'image.edit']),
  matcher: z.record(z.string(), z.unknown()),
  matcher_hash: sha256Schema,
  unit_kind: z.enum(['image', 'megapixel']),
  unit_rule: z.record(z.string(), z.unknown()),
  credits_per_unit: moneySchema,
  provider_rate_card_key: z.string().min(1).max(128),
  provider_cost_per_unit_cny: moneySchema.nullable(),
  revision: z.int().positive(),
});

const moderationRouteClosureSchema = z.strictObject({
  capability: z.enum(['moderation.text', 'moderation.image']),
  runtime_revision: z.int().positive(),
  model_snapshot_id: canonicalUuidSchema,
  credential_version_id: canonicalUuidSchema,
  policy_version: versionSchema,
  evidence_digest: sha256Schema,
  pricing_digest: sha256Schema,
  risk_adjusted_cost_cny: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
    .nullable(),
});

const modelSelectionClosureSchema = z.strictObject({
  schema_version: z.literal(1),
  catalog_revision: z.int().positive(),
  catalog_release_id: canonicalUuidSchema,
  catalog_release_digest: sha256Schema,
  image: z.strictObject({
    catalog_entry_id: canonicalUuidSchema,
    catalog_entry_revision: z.int().positive(),
    version_no: z.int().positive(),
    model_snapshot_id: canonicalUuidSchema,
    selected_spec_key: z.string().min(1).max(128),
    max_prompt_characters: z.int().min(4_000).max(128_000).optional(),
    runtime: z.strictObject({
      provider_channel_id: canonicalUuidSchema,
      provider_channel_revision: z.int().positive(),
      adapter_key: z.string().min(1).max(128),
      endpoint_profile_key: z.string().min(1).max(128),
      region: z.string().min(1).max(64).nullable(),
      credential_version_id: canonicalUuidSchema,
    }),
    billing_sku: billingSkuClosureSchema,
  }),
  moderation: z.strictObject({
    schema_version: z.literal(1),
    text: moderationRouteClosureSchema.extend({ capability: z.literal('moderation.text') }),
    image: moderationRouteClosureSchema.extend({ capability: z.literal('moderation.image') }),
  }),
});

const skillSnapshotSchema = z.strictObject({
  execution_policy: z
    .custom<SkillExecutionPolicy>((value) => parseSkillExecutionPolicy(value) !== null)
    .optional(),
  primary_skill_id: exactSkillIdSchema,
  default_output_count: z.int().min(1).max(16).default(1),
  selection_digest: sha256Schema,
  definition_digest: sha256Schema,
  package_digest: sha256Schema,
  release_digest: sha256Schema,
  resource_digests: z.array(sha256Schema).max(32),
  required_capabilities: z.array(providerCapabilitySchema).max(16),
  preset_ids: z.array(z.string().min(1).max(128)).max(8),
  auxiliary_skill_ids: z.array(exactSkillIdSchema).max(5),
});

const productFactsSchema = z.strictObject({
  product_name: z.string().trim().min(1).max(120),
  primary_colors: z.array(z.string().trim().min(1).max(120)).max(24),
  logos: z.array(z.string().trim().min(1).max(120)).max(24),
  visible_text: z.array(z.string().trim().min(1).max(120)).max(24),
  materials: z.array(z.string().trim().min(1).max(120)).max(24),
  must_preserve: z.array(z.string().trim().min(1).max(120)).max(24),
  unknown_fields: z.array(z.string().trim().min(1).max(120)).max(24),
});

export const productFactsSnapshotSchema = z.strictObject({
  schema_version: z.literal(1),
  product_id: canonicalUuidSchema,
  fact_set_id: canonicalUuidSchema,
  fact_set_version: z.int().positive(),
  source_asset_id: canonicalUuidSchema,
  source_version: sha256Schema,
  facts: productFactsSchema,
  snapshot_digest: sha256Schema,
});

export const compilerContextSchema = z
  .strictObject({
    schema_version: z.literal(1),
    actor: z.strictObject({
      user_id: canonicalUuidSchema,
      session_id: canonicalUuidSchema,
      turn_id: canonicalUuidSchema,
      continuation_no: z.int().positive(),
    }),
    skill: skillSnapshotSchema,
    execution_authorization: executionAuthorizationSchema,
    execution_authorization_digest: sha256Schema,
    bindings: z.array(bindingSchema).max(32),
    confirmed_cross_group_scope_digest: sha256Schema.optional(),
    declined_cross_group_scope_digest: sha256Schema.optional(),
    models: z.array(compilerModelSchema).max(64),
    generation_preferences: generationPreferencesSchema.optional(),
    model_selection: modelSelectionClosureSchema.optional(),
    product_facts: productFactsSnapshotSchema.nullable(),
    policies: z.strictObject({
      compiler_version: versionSchema,
      capability_registry_version: versionSchema,
      pricing_policy_version: versionSchema,
      content_safety_policy_version: versionSchema,
      platform_policy_version: versionSchema,
      product_fact_policy_version: versionSchema.nullable(),
      execution_policy_version: versionSchema,
      max_image_pixels: z.int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
      quote_ttl_seconds: z.int().positive().max(86_400),
      compiled_at: z.iso.datetime({ offset: true }),
    }),
    prompt: z.strictObject({
      template_version: versionSchema,
      prompt_digest: sha256Schema,
      safe_summary: z.string().min(1).max(500),
    }),
    mandatory_confirmation: z.boolean(),
  })
  .superRefine((value, context) => {
    const bindingKeys = value.bindings.map((item) => item.binding_key);
    if (new Set(bindingKeys).size !== bindingKeys.length) {
      context.addIssue({
        code: 'custom',
        path: ['bindings'],
        message: 'Binding keys must be unique',
      });
    }
    const productExecution = value.skill.execution_policy?.family === 'product';
    if (
      productExecution &&
      (!value.product_facts || value.policies.product_fact_policy_version !== 'product-facts-v1')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['product_facts'],
        message: 'Product execution requires confirmed product facts',
      });
    }
    if (value.product_facts) {
      const { snapshot_digest: digest, ...snapshot } = value.product_facts;
      if (canonicalSha256(snapshot) !== digest) {
        context.addIssue({
          code: 'custom',
          path: ['product_facts', 'snapshot_digest'],
          message: 'Product facts snapshot digest is invalid',
        });
      }
    }
  });

export type CandidatePlanInput = z.infer<typeof candidatePlanSchema>;
export type CompilerContextInput = z.infer<typeof compilerContextSchema>;
