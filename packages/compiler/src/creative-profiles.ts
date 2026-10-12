import {
  canonicalSha256,
  parseSkillExecutionPolicy,
  skillExecutionRules,
  skillGenerationIntent,
  EDIT_SOURCE_ROLES,
  SKILL_EXECUTION_FAMILIES,
  SKILL_IMAGE_ROLES,
  type SkillExecutionPolicy,
} from '@ecom-forge/shared';
import { z } from 'zod';
import type { BindingSnapshot, CandidatePlan } from './types.js';

export const S13A_CREATIVE_PROFILE_VERSION = 'skill-execution-v1' as const;
const skillIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const profileIdSchema = z.enum([...SKILL_EXECUTION_FAMILIES, 'chat_artifact_edit']);
const bindingRoleSchema = z.enum(SKILL_IMAGE_ROLES);
const profileWithoutDigestSchema = z.strictObject({
  schema_version: z.literal(1),
  profile_id: profileIdSchema,
  profile_version: z.literal(S13A_CREATIVE_PROFILE_VERSION),
  primary_skill_id: skillIdSchema,
  execution_policy: z.custom<SkillExecutionPolicy>(
    (value) => parseSkillExecutionPolicy(value) !== null,
  ),
  intent: z.enum(['creative_generate', 'raw_asset_generate', 'chat_artifact_edit']),
  capability: z.enum(['image.generate', 'image.edit']),
  capability_version: z.literal(1),
  allowed_binding_roles: z.array(bindingRoleSchema).max(7),
  provider_binding_roles: z.array(bindingRoleSchema).max(7),
  constraints: z.strictObject({
    min_context_images: z.int().min(0).max(9),
    max_context_images: z.int().min(1).max(9),
    identity_anchor_count: z.int().min(0).max(1),
    semantic_reference_minimum: z.int().min(0).max(9),
    edit_source_count: z.int().min(0).max(1),
    preserve_original_pixels: z.boolean().nullable(),
    allowed_changes: z.array(z.string().min(1).max(80)).max(16),
    forbidden_changes: z.array(z.string().min(1).max(80)).max(16),
  }),
});
export const creativeExecutionProfileSchema = profileWithoutDigestSchema.extend({
  profile_digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CreativeExecutionProfile = z.infer<typeof creativeExecutionProfileSchema>;
export function creativeProfileRequiresDistinctPrompts(profile: CreativeExecutionProfile): boolean {
  return profile.profile_id === 'independent_sources';
}
export const creativeConstraintsSnapshotSchema = z.strictObject({
  schema_version: z.literal(1),
  profile_id: profileIdSchema,
  preserve_original_pixels: z.boolean().nullable(),
  creative_prompt: z.string().trim().min(1).max(128_000).optional(),
  semantic_summary: z.string().trim().min(1).max(500).optional(),
  changed_items: z.array(z.string().trim().min(1).max(120)).max(16).optional(),
  preserved_items: z.array(z.string().trim().min(1).max(120)).max(16).optional(),
  parent_artifact_id: z.uuid().optional(),
  parent_artifact_version: z.string().min(1).max(128).optional(),
  parent_publication_revision: z.int().positive().optional(),
  allowed_changes: z.array(z.string().trim().min(1).max(80)).max(16),
  forbidden_changes: z.array(z.string().trim().min(1).max(80)).max(16),
});
export type CreativeConstraintsSnapshot = z.infer<typeof creativeConstraintsSnapshotSchema>;
type ProfileValidation =
  | {
      ok: true;
      nodes: Record<
        string,
        {
          contextBindings: BindingSnapshot[];
          providerBindings: BindingSnapshot[];
          constraintsSnapshot: Record<string, unknown>;
        }
      >;
    }
  | { ok: false; ruleId: string; bindingKey?: string };

export function isCreativeProfilePrimarySkill(policy: SkillExecutionPolicy | undefined): boolean {
  return policy !== undefined && policy.family !== 'product';
}
export function resolveCreativeExecutionProfile(input: {
  primarySkillId: string;
  intent: CandidatePlan['intent']['kind'];
  executionPolicy?: SkillExecutionPolicy;
}): CreativeExecutionProfile | null {
  const policy = parseSkillExecutionPolicy(input.executionPolicy);
  if (!policy) return null;
  const rules = skillExecutionRules(policy);
  if (input.intent === 'chat_artifact_edit') {
    return profile({
      profile_id: 'chat_artifact_edit',
      primary_skill_id: input.primarySkillId,
      execution_policy: policy,
      intent: input.intent,
      capability: 'image.edit',
      allowed_binding_roles: [...EDIT_SOURCE_ROLES],
      provider_binding_roles: [...EDIT_SOURCE_ROLES],
      constraints: constraints({
        edit_source_count: 1,
        preserve_original_pixels: true,
        max_context_images: policy.max_sources,
      }),
    });
  }
  const textRoute =
    policy.family === 'text_generation' ||
    (policy.family === 'optional_references' && input.intent === 'creative_generate');
  const expectedIntent = skillGenerationIntent(policy, textRoute ? 0 : 1);
  if (input.intent !== expectedIntent || policy.family === 'product') return null;
  return profile({
    profile_id: policy.family,
    primary_skill_id: input.primarySkillId,
    execution_policy: policy,
    intent: input.intent as 'creative_generate' | 'raw_asset_generate',
    capability: textRoute ? 'image.generate' : 'image.edit',
    allowed_binding_roles: policy.family === 'optional_references' && textRoute ? [] : rules.roles,
    provider_binding_roles: textRoute ? [] : rules.roles,
    constraints: constraints({
      min_context_images: textRoute ? 0 : 1,
      max_context_images: policy.max_sources,
      semantic_reference_minimum:
        policy.family === 'independent_sources' || policy.family === 'reference_composition'
          ? 1
          : 0,
      preserve_original_pixels: policy.family === 'identity_edit',
      ...(policy.family === 'identity_edit'
        ? {
            identity_anchor_count: 1,
            allowed_changes: [
              'lighting',
              'composition',
              'background_cleanup',
              'color_balance',
              'detail_restoration',
            ],
            forbidden_changes: [
              'identity',
              'unconfirmed_age',
              'unconfirmed_body_shape',
              'ethnicity',
              'unconfirmed_clothing',
              'relationship',
              'key_action',
              'face_swap',
            ],
          }
        : {}),
    }),
  });
}

export function validateCreativeExecutionProfile(input: {
  profile: CreativeExecutionProfile;
  candidate: CandidatePlan;
  bindings: readonly BindingSnapshot[];
}): ProfileValidation {
  const parsed = creativeExecutionProfileSchema.safeParse(input.profile);
  if (!parsed.success) return { ok: false, ruleId: 'creative_profile_schema_invalid' };
  const { profile_digest: digest, ...unsigned } = parsed.data;
  if (canonicalSha256(unsigned) !== digest) {
    return { ok: false, ruleId: 'creative_profile_digest_invalid' };
  }
  const expected = resolveCreativeExecutionProfile({
    primarySkillId: parsed.data.primary_skill_id,
    intent: parsed.data.intent,
    executionPolicy: parsed.data.execution_policy,
  });
  if (
    !expected ||
    canonicalSha256(expected) !== canonicalSha256(parsed.data) ||
    input.candidate.skill_id !== parsed.data.primary_skill_id ||
    input.candidate.intent.kind !== parsed.data.intent
  ) {
    return { ok: false, ruleId: 'creative_profile_policy_mismatch' };
  }
  const sourceDecision = validateSessionSourceDecision(input.candidate, input.bindings);
  if (!sourceDecision.ok) return sourceDecision;
  if (creativeProfileRequiresDistinctPrompts(parsed.data)) {
    return validateSceneReimagining({
      profile: parsed.data,
      candidate: input.candidate,
      bindings: input.bindings,
    });
  }
  if (input.candidate.nodes.length !== 1) {
    return { ok: false, ruleId: 'creative_profile_single_image_node_required' };
  }
  const node = input.candidate.nodes[0]!;
  if (
    node.capability !== parsed.data.capability ||
    node.capability_version !== parsed.data.capability_version ||
    node.expected_output !== 'image'
  ) {
    return { ok: false, ruleId: 'creative_profile_capability_mismatch' };
  }
  const contextBindings = node.input_bindings.map((key) => ({
    key,
    binding: input.bindings.find((item) => item.binding_key === key),
  }));
  const missing = contextBindings.find((item) => !item.binding);
  if (missing) {
    return {
      ok: false,
      ruleId: 'creative_profile_binding_missing',
      bindingKey: missing.key,
    };
  }
  const bound = contextBindings.map((item) => item.binding!);
  if (
    bound.length < parsed.data.constraints.min_context_images ||
    bound.length > parsed.data.constraints.max_context_images
  ) {
    return { ok: false, ruleId: 'creative_profile_reference_count_invalid' };
  }
  const disallowed = bound.find(
    (binding) => !binding.role || !parsed.data.allowed_binding_roles.includes(binding.role),
  );
  if (disallowed) {
    return {
      ok: false,
      ruleId: 'creative_profile_binding_role_invalid',
      bindingKey: disallowed.binding_key,
    };
  }
  if (
    countRole(bound, 'identity_anchor') !== parsed.data.constraints.identity_anchor_count ||
    countRole(bound, 'semantic_reference') < parsed.data.constraints.semantic_reference_minimum ||
    countRole(bound, 'edit_source') !== parsed.data.constraints.edit_source_count
  ) {
    return { ok: false, ruleId: 'creative_profile_required_role_invalid' };
  }
  const editSource = bound.find((binding) => binding.role === 'edit_source');
  if (
    editSource &&
    (editSource.kind !== 'artifact' ||
      !editSource.mutable ||
      editSource.producer_mode !== 'chat' ||
      editSource.mutation_owner !== 'chat_session' ||
      !editSource.publication_revision)
  ) {
    return {
      ok: false,
      ruleId: 'creative_profile_edit_source_invalid',
      bindingKey: editSource.binding_key,
    };
  }
  const params = creativeParamsSchema.safeParse(node.params);
  if (!params.success) return { ok: false, ruleId: 'creative_profile_params_invalid' };
  if (
    (parsed.data.profile_id === 'optional_references' ||
      parsed.data.profile_id === 'reference_composition') &&
    !params.data.creative_prompt
  ) {
    return { ok: false, ruleId: 'creative_profile_poster_prompt_required' };
  }
  if (
    parsed.data.profile_id === 'chat_artifact_edit' &&
    (!params.data.changed_items?.length || !params.data.preserved_items?.length)
  ) {
    return { ok: false, ruleId: 'creative_profile_edit_scope_required' };
  }
  if (params.data.changed_items?.length) {
    const forbiddenChange = params.data.changed_items.find((item) =>
      parsed.data.constraints.forbidden_changes.includes(item),
    );
    if (forbiddenChange) {
      return { ok: false, ruleId: 'creative_profile_change_forbidden' };
    }
  }
  if (parsed.data.constraints.allowed_changes.length > 0) {
    if (!params.data.changed_items?.length) {
      return { ok: false, ruleId: 'creative_profile_changed_items_required' };
    }
    const unsupportedChange = params.data.changed_items.find(
      (item) => !parsed.data.constraints.allowed_changes.includes(item),
    );
    if (unsupportedChange) {
      return { ok: false, ruleId: 'creative_profile_change_not_allowed' };
    }
  }
  const providerBindings = bound.filter((binding) =>
    parsed.data.provider_binding_roles.includes(binding.role!),
  );
  return {
    ok: true,
    nodes: {
      [node.candidate_key]: {
        contextBindings: bound,
        providerBindings,
        constraintsSnapshot: creativeConstraintsSnapshotSchema.parse({
          schema_version: 1,
          profile_id: parsed.data.profile_id,
          preserve_original_pixels: parsed.data.constraints.preserve_original_pixels,
          ...(params.data.creative_prompt ? { creative_prompt: params.data.creative_prompt } : {}),
          ...(params.data.semantic_summary
            ? { semantic_summary: params.data.semantic_summary }
            : {}),
          ...(params.data.changed_items ? { changed_items: params.data.changed_items } : {}),
          ...(params.data.preserved_items ? { preserved_items: params.data.preserved_items } : {}),
          ...(editSource
            ? {
                parent_artifact_id: editSource.object_id,
                parent_artifact_version: editSource.object_version,
                parent_publication_revision: editSource.publication_revision,
              }
            : {}),
          allowed_changes: parsed.data.constraints.allowed_changes,
          forbidden_changes: parsed.data.constraints.forbidden_changes,
        }),
      },
    },
  };
}

export function validateSessionSourceDecision(
  candidate: CandidatePlan,
  bindings: readonly BindingSnapshot[],
): { ok: true } | { ok: false; ruleId: string; bindingKey?: string } {
  const sessionCandidates = bindings.filter((binding) => binding.candidate_kind);
  if (sessionCandidates.length === 0) {
    return candidate.source_decision
      ? { ok: false, ruleId: 'creative_decision_without_session_candidates' }
      : { ok: true };
  }
  if (!sessionCandidates.some((binding) => binding.candidate_kind === 'latest_output')) {
    return candidate.source_decision
      ? { ok: false, ruleId: 'creative_decision_without_session_output' }
      : { ok: true };
  }
  const decision = candidate.source_decision;
  if (!decision) {
    const selectedKeys = candidate.nodes.flatMap((node) => node.input_bindings);
    const outputSourceKeys = new Set(
      sessionCandidates
        .filter((binding) => binding.candidate_kind === 'latest_output')
        .flatMap((binding) => binding.lineage_source_binding_keys ?? []),
    );
    const selectsOnlyUnpublishedSources =
      candidate.intent.kind !== 'chat_artifact_edit' &&
      candidate.intent.kind !== 'external_artifact_edit' &&
      selectedKeys.length > 0 &&
      selectedKeys.every(
        (key) =>
          sessionCandidates.some(
            (binding) =>
              binding.binding_key === key && binding.candidate_kind === 'original_source',
          ) && !outputSourceKeys.has(key),
      );
    return selectsOnlyUnpublishedSources
      ? { ok: true }
      : { ok: false, ruleId: 'creative_decision_required' };
  }
  const output = bindings.find((binding) => binding.binding_key === decision.output_binding_key);
  if (!output || output.candidate_kind !== 'latest_output' || output.role !== 'edit_source') {
    return {
      ok: false,
      ruleId: 'creative_decision_output_invalid',
      bindingKey: decision.output_binding_key,
    };
  }
  const selectedBindingKeys = candidate.nodes.flatMap((node) => node.input_bindings);
  if (decision.mode === 'refine_latest') {
    if (
      candidate.intent.kind !== 'chat_artifact_edit' ||
      selectedBindingKeys.length !== 1 ||
      selectedBindingKeys[0] !== output.binding_key
    ) {
      return { ok: false, ruleId: 'creative_decision_refine_mismatch' };
    }
    return { ok: true };
  }
  const original = bindings.find(
    (binding) => binding.binding_key === decision.original_source_binding_key,
  );
  if (
    !original ||
    original.candidate_kind !== 'original_source' ||
    !output.lineage_source_binding_keys?.includes(original.binding_key)
  ) {
    return {
      ok: false,
      ruleId: 'creative_decision_lineage_invalid',
      bindingKey: decision.original_source_binding_key,
    };
  }
  if (
    candidate.intent.kind === 'chat_artifact_edit' ||
    candidate.intent.kind === 'external_artifact_edit' ||
    selectedBindingKeys.length !== 1 ||
    selectedBindingKeys[0] !== original.binding_key
  ) {
    return { ok: false, ruleId: 'creative_decision_restart_mismatch' };
  }
  return { ok: true };
}

function validateSceneReimagining(input: {
  profile: CreativeExecutionProfile;
  candidate: CandidatePlan;
  bindings: readonly BindingSnapshot[];
}): ProfileValidation {
  if (
    input.candidate.nodes.length < 1 ||
    input.candidate.nodes.length > input.profile.execution_policy.max_sources
  ) {
    return { ok: false, ruleId: 'creative_profile_scene_batch_size_invalid' };
  }
  const bindingByKey = new Map(input.bindings.map((binding) => [binding.binding_key, binding]));
  const used = new Set<string>();
  const usedPrompts = new Set<string>();
  const usedNotes = new Set<string>();
  const nodes: Extract<ProfileValidation, { ok: true }>['nodes'] = {};
  for (const node of input.candidate.nodes) {
    if (
      node.capability !== 'image.edit' ||
      node.capability_version !== input.profile.capability_version ||
      node.expected_output !== 'image'
    ) {
      return { ok: false, ruleId: 'creative_profile_capability_mismatch' };
    }
    if (node.input_bindings.length !== 1) {
      return { ok: false, ruleId: 'creative_profile_scene_one_source_per_node_required' };
    }
    const bindingKey = node.input_bindings[0]!;
    const binding = bindingByKey.get(bindingKey);
    if (!binding) {
      return { ok: false, ruleId: 'creative_profile_binding_missing', bindingKey };
    }
    if (used.has(bindingKey)) {
      return { ok: false, ruleId: 'creative_profile_scene_source_reused', bindingKey };
    }
    if (binding.role !== 'semantic_reference') {
      return { ok: false, ruleId: 'creative_profile_binding_role_invalid', bindingKey };
    }
    const params = creativeParamsSchema.safeParse(node.params);
    if (!params.success) return { ok: false, ruleId: 'creative_profile_params_invalid' };
    if (
      !params.data.semantic_summary ||
      !params.data.creative_prompt ||
      params.data.output_count !== 1
    ) {
      return { ok: false, ruleId: 'creative_profile_prompt_required' };
    }
    const promptDigest = params.data.creative_prompt
      ? canonicalSha256(params.data.creative_prompt)
      : undefined;
    if (promptDigest && usedPrompts.has(promptDigest)) {
      return { ok: false, ruleId: 'creative_profile_scene_prompt_reused' };
    }
    const noteDigest = params.data.creative_note
      ? canonicalSha256(params.data.creative_note)
      : undefined;
    if (noteDigest && usedNotes.has(noteDigest)) {
      return { ok: false, ruleId: 'creative_profile_scene_note_reused' };
    }
    used.add(bindingKey);
    if (promptDigest) usedPrompts.add(promptDigest);
    if (noteDigest) usedNotes.add(noteDigest);
    nodes[node.candidate_key] = {
      contextBindings: [binding],
      providerBindings: [binding],
      constraintsSnapshot: creativeConstraintsSnapshotSchema.parse({
        schema_version: 1,
        profile_id: input.profile.profile_id,
        preserve_original_pixels: false,
        ...(params.data.semantic_summary ? { semantic_summary: params.data.semantic_summary } : {}),
        ...(params.data.creative_prompt ? { creative_prompt: params.data.creative_prompt } : {}),
        allowed_changes: input.profile.constraints.allowed_changes,
        forbidden_changes: input.profile.constraints.forbidden_changes,
      }),
    };
  }
  return { ok: true, nodes };
}

// Profile validation reads only S13A fields; the capability adapter remains the strict owner
// of the complete candidate params object and rejects model/price/provider-owned extras.
const creativeParamsSchema = z.looseObject({
  goal_summary: z.string().trim().min(1).max(500),
  creative_prompt: z.string().trim().min(1).max(128_000).optional(),
  creative_note: z.string().trim().min(1).max(600).optional(),
  output_count: z.int().min(1).max(16).optional(),
  semantic_summary: z.string().trim().min(1).max(500).optional(),
  changed_items: z.array(z.string().trim().min(1).max(120)).max(16).optional(),
  preserved_items: z.array(z.string().trim().min(1).max(120)).max(16).optional(),
});

type ProfileConstraints = z.infer<typeof profileWithoutDigestSchema>['constraints'];

function constraints(overrides: Partial<ProfileConstraints> = {}): ProfileConstraints {
  return {
    min_context_images: 0,
    max_context_images: 9,
    identity_anchor_count: 0,
    semantic_reference_minimum: 0,
    edit_source_count: 0,
    preserve_original_pixels: null,
    allowed_changes: [],
    forbidden_changes: [],
    ...overrides,
  };
}

type UnsignedProfileInput = Omit<
  z.infer<typeof profileWithoutDigestSchema>,
  'schema_version' | 'profile_version' | 'capability_version'
>;

function profile(input: UnsignedProfileInput): CreativeExecutionProfile {
  const unsigned = profileWithoutDigestSchema.parse({
    schema_version: 1,
    profile_version: S13A_CREATIVE_PROFILE_VERSION,
    capability_version: 1,
    ...input,
  });
  return { ...unsigned, profile_digest: canonicalSha256(unsigned) };
}

function countRole(bindings: readonly BindingSnapshot[], role: BindingSnapshot['role']): number {
  return bindings.filter((binding) => binding.role === role).length;
}
