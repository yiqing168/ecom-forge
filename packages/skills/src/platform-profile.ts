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
const relativeResourcePath = z.string().regex(/^(presets|references)\/[a-z0-9][a-z0-9-]*\.md$/);

const platformPresetOptionSchema = z.strictObject({
  preset_id: skillId,
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(240),
  resource_path: relativeResourcePath.refine((value) => value.startsWith('presets/')),
  preview_asset_path: z.string().min(1).max(240).optional(),
});

export const skillPlatformProfileSchema = z
  .strictObject({
    slug,
    version: semver,
    display_name: z.string().min(1).max(120),
    kind: z.enum(SKILL_KINDS),
    category: slug,
    domain: z.enum(ORIGIN_DOMAINS),
    stage: z.string().min(1).max(64),
    sort_order: z.int().min(0).max(1_000_000).default(0),
    required_inputs: z.array(z.string().min(1).max(64)).max(16).default([]),
    required_facts: z.array(z.string().min(1).max(64)).max(32).default([]),
    required_capabilities: z.array(z.string().min(1).max(128)).max(32).default([]),
    default_output_count: z.int().min(1).max(16).default(1),
    execution_policy: skillExecutionPolicySchema.optional(),
    attachment_roles: skillAttachmentRolesSchema.optional(),
    catalog_enabled: z.boolean().optional(),
    catalog: z
      .strictObject({
        visibility: z.enum(SKILL_VISIBILITIES),
        cover_asset_path: z.string().min(1).max(240).optional(),
      })
      .optional(),
    preset_slots: z
      .array(
        z.strictObject({
          slot: slug,
          label: z.string().min(1).max(80),
          required: z.boolean(),
          max_selections: z.int().min(1).max(4),
          options: z.array(platformPresetOptionSchema).min(1).max(24),
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
        z.strictObject({
          path: relativeResourcePath.refine((value) => value.startsWith('references/')),
          purpose: z.string().min(1).max(240),
        }),
      )
      .max(12)
      .default([]),
  })
  .superRefine(validateSkillExecutionMetadata);

export type SkillPlatformProfile = z.infer<typeof skillPlatformProfileSchema>;

export function parseSkillPlatformProfile(input: unknown): SkillPlatformProfile {
  const result = skillPlatformProfileSchema.safeParse(input);
  if (!result.success) throw new Error('SKILL_PLATFORM_PROFILE_INVALID');
  return {
    ...result.data,
    catalog: result.data.catalog ?? {
      visibility: result.data.kind === 'primary' ? 'public' : 'internal',
    },
  };
}
