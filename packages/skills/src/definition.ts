import { z } from 'zod';

import { ORIGIN_DOMAINS, SKILL_KINDS, SKILL_VISIBILITIES } from '@ecom-forge/types';
import {
  skillExecutionPolicySchema,
  skillAttachmentRolesSchema,
  validateSkillExecutionMetadata,
} from './execution-policy.js';

const semver = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const skillId = z.string().regex(/^[a-z0-9][a-z0-9-]*@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const resourcePath = z
  .string()
  .regex(/^(SKILL\.md|presets\/[a-z0-9][a-z0-9-]*\.md|references\/[a-z0-9][a-z0-9-]*\.md)$/);

const assetSchema = z.strictObject({
  url: z.url().refine((value) => value.startsWith('https://'), 'asset URL must use HTTPS'),
  alt: z.string().min(1).max(160),
  aspect_ratio: z.string().regex(/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/),
});

const presetOptionSchema = z.strictObject({
  preset_id: skillId,
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(240),
  resource_path: resourcePath.refine((value) => value.startsWith('presets/')),
  resource_hash: z.string().regex(/^[a-f0-9]{64}$/),
  disabled: z.boolean().default(false),
  preview_asset: assetSchema.optional(),
});

export const skillDefinitionSchema = z
  .strictObject({
    schema_version: z.literal(1),
    slug,
    version: semver,
    display_name: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    kind: z.enum(SKILL_KINDS),
    visibility: z.enum(SKILL_VISIBILITIES),
    domain: z.enum(ORIGIN_DOMAINS),
    category: slug,
    stage: z.string().min(1).max(64),
    sort_order: z.int().min(0).max(1_000_000).default(0),
    required_inputs: z.array(z.string().min(1).max(64)).max(16).default([]),
    required_facts: z.array(z.string().min(1).max(64)).max(32).default([]),
    required_capabilities: z.array(z.string().min(1).max(128)).max(32).default([]),
    default_output_count: z.int().min(1).max(16).default(1),
    execution_policy: skillExecutionPolicySchema.optional(),
    attachment_roles: skillAttachmentRolesSchema.optional(),
    catalog_enabled: z.boolean().optional(),
    planning_view: z.strictObject({
      path: z.literal('SKILL.md'),
      content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    preset_slots: z
      .array(
        z.strictObject({
          slot: slug,
          label: z.string().min(1).max(80),
          required: z.boolean(),
          max_selections: z.int().min(1).max(4),
          options: z.array(presetOptionSchema).min(1).max(24),
        }),
      )
      .max(8)
      .default([]),
    dependencies: z
      .array(
        z.strictObject({
          skill_id: skillId,
          mode: z.enum(['required', 'optional']),
          reason: z.string().min(1).max(240),
        }),
      )
      .max(12)
      .default([]),
    references: z
      .array(
        z.strictObject({ path: resourcePath, content_hash: z.string().regex(/^[a-f0-9]{64}$/) }),
      )
      .max(12)
      .default([]),
    cover_asset: assetSchema.optional(),
  })
  .superRefine((value, context) => {
    validateSkillExecutionMetadata(value, context);
    if (
      value.kind === 'auxiliary' &&
      (value.visibility !== 'internal' ||
        value.preset_slots.length > 0 ||
        value.dependencies.length > 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'auxiliary skills must be internal and cannot declare presets or dependencies',
      });
    }
    if (value.kind === 'primary' && value.visibility !== 'public') {
      context.addIssue({ code: 'custom', message: 'primary skills must be public' });
    }
    const slots = value.preset_slots.map((item) => item.slot);
    if (new Set(slots).size !== slots.length)
      context.addIssue({ code: 'custom', message: 'preset slots must be unique' });
    const dependencies = value.dependencies.map((item) => item.skill_id);
    if (new Set(dependencies).size !== dependencies.length)
      context.addIssue({ code: 'custom', message: 'dependencies must be unique' });
  });

export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;

export function parseSkillDefinition(input: unknown): SkillDefinition {
  const result = skillDefinitionSchema.safeParse(input);
  if (!result.success) throw new Error('SKILL_DEFINITION_INVALID');
  return result.data;
}

export function exactSkillId(definition: SkillDefinition): string {
  return `${definition.slug}@${definition.version}`;
}
