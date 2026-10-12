export const SKILL_EXECUTION_FAMILIES = [
  'text_generation',
  'independent_sources',
  'optional_references',
  'reference_composition',
  'identity_edit',
  'product',
] as const;

export type SkillExecutionFamily = (typeof SKILL_EXECUTION_FAMILIES)[number];
export interface SkillExecutionPolicy {
  version: 1;
  family: SkillExecutionFamily;
  max_sources: number;
}
export const SKILL_IMAGE_ROLES = [
  'product',
  'identity_anchor',
  'semantic_reference',
  'style_reference',
  'composition_reference',
  'edit_source',
  'other',
] as const;
export type SkillImageRole = (typeof SKILL_IMAGE_ROLES)[number];
export interface SkillAttachmentRoleOption {
  role: SkillImageRole;
  label: string;
}

export function parseSkillExecutionPolicy(value: unknown): SkillExecutionPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 3 ||
    !['version', 'family', 'max_sources'].every((key) => Object.hasOwn(row, key)) ||
    row.version !== 1 ||
    !SKILL_EXECUTION_FAMILIES.some((family) => family === row.family) ||
    typeof row.max_sources !== 'number' ||
    !Number.isInteger(row.max_sources) ||
    row.max_sources < 1 ||
    row.max_sources > 9
  )
    return null;
  return { version: 1, family: row.family as SkillExecutionFamily, max_sources: row.max_sources };
}

export const EDIT_SOURCE_ROLES: readonly SkillImageRole[] = [
  'edit_source',
  'style_reference',
  'composition_reference',
  'other',
];

export function skillExecutionRules(policy: SkillExecutionPolicy) {
  const optionalRoles: SkillImageRole[] = ['style_reference', 'composition_reference', 'other'];
  const roles: SkillImageRole[] =
    policy.family === 'text_generation'
      ? optionalRoles
      : policy.family === 'optional_references'
        ? ['semantic_reference', ...optionalRoles]
        : policy.family === 'identity_edit'
          ? ['identity_anchor', ...optionalRoles]
          : policy.family === 'product'
            ? ['product', ...optionalRoles]
            : ['semantic_reference'];
  return {
    roles,
    min_sources:
      policy.family === 'text_generation' || policy.family === 'optional_references' ? 0 : 1,
    max_sources: policy.max_sources,
    source_role:
      policy.family === 'independent_sources'
        ? ('semantic_reference' as const)
        : policy.family === 'identity_edit'
          ? ('identity_anchor' as const)
          : policy.family === 'product'
            ? ('product' as const)
            : null,
    independent: policy.family === 'independent_sources',
    requires_product_facts: policy.family === 'product',
  };
}

export function skillGenerationIntent(policy: SkillExecutionPolicy, sourceCount: number) {
  if (policy.family === 'product') return 'commerce_generate' as const;
  if (
    policy.family === 'text_generation' ||
    (policy.family === 'optional_references' && sourceCount === 0)
  )
    return 'creative_generate' as const;
  return 'raw_asset_generate' as const;
}
