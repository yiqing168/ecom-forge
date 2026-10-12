import { addMoney, canonicalSha256, normalizeMoney } from '@ecom-forge/shared';
import { crossUploadGroupScope, validateGenerationScope } from '@ecom-forge/agent';
import {
  imageProviderPromptMaxCharacters,
  resolveOpenAiImageDimensions,
} from '@ecom-forge/provider';

import { authorizeBindings } from './authorization.js';
import { buildApprovedImagePrompt } from './approved-image-prompt.js';
import type { CapabilityRegistry } from './capability-registry.js';
import { compileTaskCost } from './cost.js';
import {
  isCreativeProfilePrimarySkill,
  resolveCreativeExecutionProfile,
  validateCreativeExecutionProfile,
  validateSessionSourceDecision,
} from './creative-profiles.js';
import { stableTopologicalSort } from './dag.js';
import { candidatePlanSchema, compilerContextSchema } from './schemas.js';
import type {
  CompilePlanResult,
  CompiledTask,
  CapabilityRequirements,
  CompilerContext,
  CompilerModel,
  CompilerRejection,
  CompilerRejectionCode,
} from './types.js';

const REJECTION_META: Record<
  CompilerRejectionCode,
  Pick<CompilerRejection, 'category' | 'retryable' | 'safe_action'>
> = {
  candidate_schema_invalid: { category: 'repairable', retryable: true, safe_action: 'repair_plan' },
  clarification_required: { category: 'clarification', retryable: false, safe_action: 'ask_user' },
  skill_version_drift: { category: 'unavailable', retryable: false, safe_action: 'refresh_skill' },
  reference_unavailable: {
    category: 'permission',
    retryable: false,
    safe_action: 'remove_reference',
  },
  mutation_forbidden: {
    category: 'permission',
    retryable: false,
    safe_action: 'start_new_generation',
  },
  dag_invalid: { category: 'repairable', retryable: true, safe_action: 'repair_plan' },
  capability_unavailable: {
    category: 'unavailable',
    retryable: false,
    safe_action: 'explain_unavailable',
  },
  model_not_approved: { category: 'unavailable', retryable: true, safe_action: 'retry_later' },
  cost_unavailable: { category: 'unavailable', retryable: true, safe_action: 'retry_later' },
  policy_version_drift: { category: 'unavailable', retryable: true, safe_action: 'retry_later' },
};

function reject(
  code: CompilerRejectionCode,
  ruleId: string,
  detail: { candidate_key?: string; binding_key?: string } = {},
  safeAction?: CompilerRejection['safe_action'],
): CompilerRejection {
  const meta = REJECTION_META[code];
  return {
    status: 'rejected',
    code,
    ...meta,
    ...(safeAction ? { safe_action: safeAction } : {}),
    details: [{ ...detail, rule_id: ruleId }],
  };
}

function modelSupports(
  model: CompilerModel,
  capability: string,
  requirements: {
    outputCount: number;
    referenceImageCount: number;
    aspectRatio?: string;
    resolution?: string;
  },
): boolean {
  const contract = model.capability_contract;
  if (contract.schema_version === 2) {
    return contract.specs.some(
      (spec) =>
        spec.kind === 'image' &&
        spec.operation === capability &&
        requirements.outputCount <= spec.max_outputs &&
        requirements.referenceImageCount <= spec.max_reference_images &&
        (!requirements.aspectRatio || spec.aspect_ratios.includes(requirements.aspectRatio)) &&
        (!requirements.resolution || spec.resolution_tier === requirements.resolution),
    );
  }
  return (
    contract.capabilities.includes(capability as never) &&
    requirements.outputCount <= contract.max_outputs &&
    requirements.referenceImageCount <= contract.max_reference_images &&
    (!requirements.aspectRatio || contract.aspect_ratios.includes(requirements.aspectRatio)) &&
    (!requirements.resolution || contract.resolutions.includes(requirements.resolution))
  );
}

function referenceTier(maxReferenceImages: number): 'none' | 'standard' | 'extended' {
  if (maxReferenceImages === 0) return 'none';
  return maxReferenceImages <= 4 ? 'standard' : 'extended';
}

function decimalEquals(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const canonical = (value: string) => {
    const [whole = '0', fraction = ''] = value.split('.');
    const normalizedFraction = fraction.replace(/0+$/, '');
    return normalizedFraction ? `${whole}.${normalizedFraction}` : whole;
  };
  return canonical(left) === canonical(right);
}

function selectedMediaClosureValid(
  context: CompilerContext,
  model: CompilerModel,
  capability: string,
  requirements: Parameters<typeof modelSupports>[2],
): boolean {
  const selection = context.model_selection?.image;
  if (
    !selection ||
    model.capability_contract.schema_version !== 2 ||
    model.pricing.schema_version !== 2
  ) {
    return false;
  }
  if (
    selection.model_snapshot_id !== model.id ||
    selection.billing_sku.model_catalog_entry_id !== selection.catalog_entry_id ||
    selection.billing_sku.operation !== capability ||
    canonicalSha256(selection.billing_sku.matcher) !== selection.billing_sku.matcher_hash
  ) {
    return false;
  }
  const spec = model.capability_contract.specs.find(
    (candidate) => candidate.kind === 'image' && candidate.spec_key === selection.selected_spec_key,
  );
  if (
    !spec ||
    spec.operation !== capability ||
    requirements.outputCount > spec.max_outputs ||
    requirements.referenceImageCount > spec.max_reference_images ||
    (requirements.aspectRatio && !spec.aspect_ratios.includes(requirements.aspectRatio)) ||
    (requirements.resolution && spec.resolution_tier !== requirements.resolution)
  ) {
    return false;
  }
  if (
    selection.max_prompt_characters !== undefined &&
    selection.max_prompt_characters !== spec.max_prompt_characters
  ) {
    return false;
  }
  const matcher = selection.billing_sku.matcher;
  if (
    matcher.schema_version !== 1 ||
    matcher.kind !== 'image' ||
    matcher.mode !== spec.mode ||
    matcher.resolution !== spec.resolution_tier ||
    matcher.transparent_background !== spec.transparent_background ||
    matcher.reference_tier !== referenceTier(spec.max_reference_images)
  ) {
    return false;
  }
  const rate = model.pricing.rate_cards.find(
    (candidate) =>
      candidate.spec_key === spec.spec_key &&
      (candidate.billing_unit === 'image' || candidate.billing_unit === 'megapixel'),
  );
  if (
    !rate ||
    rate.rate_key !== selection.billing_sku.provider_rate_card_key ||
    (rate.unit_cost_cny === null) !== (selection.billing_sku.provider_cost_per_unit_cny === null) ||
    (rate.unit_cost_cny !== null &&
      normalizeMoney(rate.unit_cost_cny) !== selection.billing_sku.provider_cost_per_unit_cny) ||
    rate.billing_unit !== selection.billing_sku.unit_kind
  ) {
    return false;
  }
  const rule = selection.billing_sku.unit_rule;
  if (rate.billing_unit === 'image') {
    return (
      rule.min_quantity === 1 && rule.max_quantity === spec.max_outputs && rule.step_quantity === 1
    );
  }
  return (
    spec.max_outputs === 1 &&
    decimalEquals(rule.min_megapixels, rate.min_megapixels) &&
    decimalEquals(rule.max_megapixels, rate.max_megapixels) &&
    decimalEquals(rule.step_megapixels, rate.step_megapixels)
  );
}

function imageProviderPromptLimit(
  context: CompilerContext,
  model: CompilerModel,
  requirements: CapabilityRequirements,
): number {
  if (model.capability_contract.schema_version !== 2) {
    return imageProviderPromptMaxCharacters();
  }
  const selectedSpecKey = context.model_selection?.image.selected_spec_key;
  const spec = model.capability_contract.specs.find(
    (candidate) =>
      candidate.kind === 'image' &&
      (selectedSpecKey
        ? candidate.spec_key === selectedSpecKey
        : candidate.operation ===
            (requirements.operation === 'generate' ? 'image.generate' : 'image.edit') &&
          candidate.resolution_tier === requirements.resolution &&
          (!requirements.aspectRatio ||
            candidate.aspect_ratios.includes(requirements.aspectRatio))),
  );
  if (!spec || spec.kind !== 'image') {
    return imageProviderPromptMaxCharacters();
  }
  return imageProviderPromptMaxCharacters(spec.max_prompt_characters);
}

function selectModel(
  context: CompilerContext,
  capability: string,
  requirements: Parameters<typeof modelSupports>[2],
): CompilerModel | undefined {
  return [...context.models]
    .filter(
      (model) =>
        model.status === 'poc_passed' &&
        model.status_evidence_digest !== null &&
        model.circuit_allows_submit &&
        model.budget_allows_submit &&
        modelSupports(model, capability, requirements),
    )
    .sort((left, right) =>
      [left.provider, left.model_id, left.version, left.id]
        .join(':')
        .localeCompare([right.provider, right.model_id, right.version, right.id].join(':')),
    )[0];
}

export function compilePlan(input: {
  candidate: unknown;
  context: unknown;
  registry: CapabilityRegistry;
}): CompilePlanResult {
  const candidateResult = candidatePlanSchema.safeParse(input.candidate);
  if (!candidateResult.success) return reject('candidate_schema_invalid', 'candidate_schema_v1');
  const contextResult = compilerContextSchema.safeParse(input.context);
  if (!contextResult.success) {
    const issue = contextResult.error.issues[0];
    const path = issue?.path.length ? issue.path.join('.') : 'root';
    return reject(
      'policy_version_drift',
      `compiler_context_v1:${path}:${issue?.code ?? 'invalid'}`,
    );
  }
  const candidate = candidateResult.data;
  const context = contextResult.data;

  if (candidate.intent.confidence < 0.85) {
    return reject('clarification_required', 'intent_confidence_threshold');
  }
  if (candidate.skill_id !== context.skill.primary_skill_id) {
    return reject('skill_version_drift', 'primary_skill_identity');
  }
  const scopeError = validateGenerationScope(candidate, context.bindings);
  if (scopeError) {
    return reject('candidate_schema_invalid', 'generation_scope_mismatch');
  }
  const crossGroupScope = crossUploadGroupScope(candidate, context.bindings);
  const sourceDecisionValidation = validateSessionSourceDecision(candidate, context.bindings);
  if (!sourceDecisionValidation.ok) {
    return reject(
      sourceDecisionValidation.bindingKey ? 'reference_unavailable' : 'candidate_schema_invalid',
      sourceDecisionValidation.ruleId,
      sourceDecisionValidation.bindingKey
        ? { binding_key: sourceDecisionValidation.bindingKey }
        : {},
    );
  }
  if (
    context.policies.compiler_version !== 's09-v1' ||
    context.policies.capability_registry_version !== input.registry.version ||
    context.execution_authorization.policy_version !== context.policies.execution_policy_version ||
    canonicalSha256(context.execution_authorization) !== context.execution_authorization_digest
  ) {
    return reject('policy_version_drift', 'compiler_or_execution_policy_version');
  }
  const creativeProfile = resolveCreativeExecutionProfile({
    primarySkillId: context.skill.primary_skill_id,
    ...(context.skill.execution_policy ? { executionPolicy: context.skill.execution_policy } : {}),
    intent: candidate.intent.kind,
  });
  if (isCreativeProfilePrimarySkill(context.skill.execution_policy) && !creativeProfile) {
    return reject('capability_unavailable', 'creative_execution_profile_not_available');
  }
  const creativeValidation = creativeProfile
    ? validateCreativeExecutionProfile({
        profile: creativeProfile,
        candidate,
        bindings: context.bindings,
      })
    : null;
  if (creativeValidation && !creativeValidation.ok) {
    return reject(
      creativeValidation.ruleId.includes('binding') || creativeValidation.ruleId.includes('source')
        ? 'reference_unavailable'
        : 'candidate_schema_invalid',
      creativeValidation.ruleId,
      creativeValidation.bindingKey ? { binding_key: creativeValidation.bindingKey } : {},
    );
  }

  const dag = stableTopologicalSort(candidate.nodes);
  if (!dag.ok) {
    return reject(
      'dag_invalid',
      dag.ruleId,
      dag.candidateKey ? { candidate_key: dag.candidateKey } : {},
    );
  }
  const bindingMap = new Map(context.bindings.map((binding) => [binding.binding_key, binding]));
  const prepared: Array<{
    node: (typeof dag.nodes)[number];
    paramsSnapshot: Record<string, unknown>;
    quoteLabel: string;
    requirements: CapabilityRequirements;
    bindings: CompilerContext['bindings'];
    providerBindings: CompilerContext['bindings'];
    model: CompilerModel;
  }> = [];

  for (const node of dag.nodes) {
    const adapter = input.registry.resolve(node.capability, node.capability_version);
    if (!adapter) {
      return reject('capability_unavailable', 'capability_adapter_missing', {
        candidate_key: node.candidate_key,
      });
    }
    if (
      !context.skill.required_capabilities.includes(node.capability) &&
      creativeProfile?.capability !== node.capability
    ) {
      return reject('capability_unavailable', 'skill_capability_not_declared', {
        candidate_key: node.candidate_key,
      });
    }
    const bindings = [];
    for (const key of node.input_bindings) {
      const binding = bindingMap.get(key);
      if (!binding) {
        return reject('reference_unavailable', 'binding_not_in_context', {
          candidate_key: node.candidate_key,
          binding_key: key,
        });
      }
      if (!adapter.allowedBindingKinds.includes(binding.kind)) {
        return reject('reference_unavailable', 'binding_kind_not_allowed', {
          candidate_key: node.candidate_key,
          binding_key: key,
        });
      }
      bindings.push(binding);
    }
    const creativeNode = creativeValidation?.ok
      ? creativeValidation.nodes[node.candidate_key]
      : undefined;
    if (creativeValidation?.ok && !creativeNode) {
      return reject('candidate_schema_invalid', 'creative_profile_node_closure_missing', {
        candidate_key: node.candidate_key,
      });
    }
    const providerBindings = creativeNode?.providerBindings ?? bindings;
    const contextBindings = creativeNode?.contextBindings ?? bindings;
    const adapted = adapter.compile({
      params: node.params,
      bindings: providerBindings,
      expectedOutput: node.expected_output,
      generationPreferences: context.generation_preferences,
    });
    if (!adapted.ok || adapted.requirements.outputType !== node.expected_output) {
      return reject(
        'candidate_schema_invalid',
        adapted.ok ? 'expected_output_mismatch' : adapted.ruleId,
        {
          candidate_key: node.candidate_key,
        },
      );
    }
    const outputCount = adapted.paramsSnapshot.output_count;
    const outputCountSource = adapted.paramsSnapshot.output_count_source;
    if (
      node.expected_output === 'image' &&
      (typeof outputCount !== 'number' ||
        !Number.isInteger(outputCount) ||
        outputCount < 1 ||
        outputCount > 16 ||
        (outputCountSource !== 'user_explicit' && outputCountSource !== 'skill_default'))
    ) {
      return reject('candidate_schema_invalid', 'image_output_count_invalid', {
        candidate_key: node.candidate_key,
      });
    }
    if (
      node.expected_output === 'image' &&
      outputCountSource === 'skill_default' &&
      outputCount !== context.skill.default_output_count
    ) {
      return reject('candidate_schema_invalid', 'skill_default_output_count_mismatch', {
        candidate_key: node.candidate_key,
      });
    }
    const authorization = authorizeBindings({
      intent: candidate.intent.kind,
      actorUserId: context.actor.user_id,
      actorSessionId: context.actor.session_id,
      bindings: contextBindings,
      requirements: adapted.requirements,
    });
    if (!authorization.ok) {
      return reject(
        authorization.code,
        authorization.ruleId,
        {
          candidate_key: node.candidate_key,
          ...(authorization.bindingKey ? { binding_key: authorization.bindingKey } : {}),
        },
        authorization.safeAction,
      );
    }
    const selectedModelId = context.model_selection?.image.model_snapshot_id;
    const model = selectedModelId
      ? context.models.find((candidate) => candidate.id === selectedModelId)
      : selectModel(context, node.capability, adapted.requirements);
    if (!model) {
      return reject('model_not_approved', 'approved_model_not_available', {
        candidate_key: node.candidate_key,
      });
    }
    if (selectedModelId) {
      const ruleId =
        !model.status_evidence_digest || model.status !== 'poc_passed'
          ? 'selected_model_not_approved'
          : !model.budget_allows_submit
            ? 'selected_model_budget_exceeded'
            : !model.circuit_allows_submit
              ? 'selected_model_circuit_open'
              : !selectedMediaClosureValid(context, model, node.capability, adapted.requirements)
                ? 'selected_model_closure_invalid'
                : null;
      if (ruleId) {
        return reject('model_not_approved', ruleId, { candidate_key: node.candidate_key });
      }
    }
    if (node.expected_output === 'image' && model.capability_contract.schema_version === 2) {
      try {
        if (
          context.policies.max_image_pixels === undefined ||
          !adapted.requirements.aspectRatio ||
          !['1k', '2k', '4k'].includes(adapted.requirements.resolution ?? '')
        ) {
          throw new Error('IMAGE_DIMENSIONS_CONTEXT_INVALID');
        }
        resolveOpenAiImageDimensions(
          adapted.requirements.aspectRatio,
          adapted.requirements.resolution as '1k' | '2k' | '4k',
          context.policies.max_image_pixels,
        );
      } catch {
        return reject('model_not_approved', 'image_dimensions_unavailable', {
          candidate_key: node.candidate_key,
        });
      }
    }
    const paramsSnapshot: Record<string, unknown> = {
      ...adapted.paramsSnapshot,
      ...(creativeProfile && creativeValidation?.ok
        ? {
            creative_execution_profile: creativeProfile,
            creative_constraints_snapshot: creativeNode!.constraintsSnapshot,
          }
        : {}),
      ...(context.product_facts ? { product_facts_snapshot: context.product_facts } : {}),
    };
    const goalSummary = paramsSnapshot['goal_summary'];
    const aspectRatio = paramsSnapshot['aspect_ratio'];
    const creativePrompt = paramsSnapshot['creative_prompt'];
    const creativeNote = paramsSnapshot['creative_note'];
    if (node.expected_output === 'image' && typeof goalSummary === 'string') {
      let providerPrompt: string;
      try {
        providerPrompt = buildApprovedImagePrompt({
          goal_summary: goalSummary,
          ...(typeof aspectRatio === 'string' ? { aspect_ratio: aspectRatio } : {}),
          ...(typeof creativePrompt === 'string' ? { creative_prompt: creativePrompt } : {}),
          ...(typeof creativeNote === 'string' ? { creative_note: creativeNote } : {}),
          input_bindings: contextBindings.map((binding) => ({
            object_id: binding.object_id,
            object_version: binding.object_version,
            role: binding.role ?? 'other',
            provider_input: providerBindings.some(
              (providerBinding) => providerBinding.binding_key === binding.binding_key,
            ),
            publication_revision: binding.publication_revision ?? null,
          })),
          ...(paramsSnapshot['creative_execution_profile'] !== undefined
            ? { creative_execution_profile: paramsSnapshot['creative_execution_profile'] }
            : {}),
          ...(paramsSnapshot['creative_constraints_snapshot'] !== undefined
            ? { creative_constraints_snapshot: paramsSnapshot['creative_constraints_snapshot'] }
            : {}),
          ...(paramsSnapshot['product_facts_snapshot'] !== undefined
            ? { product_facts_snapshot: paramsSnapshot['product_facts_snapshot'] }
            : {}),
        });
      } catch {
        return reject('candidate_schema_invalid', 'image_provider_prompt_assembly_invalid', {
          candidate_key: node.candidate_key,
        });
      }
      if (providerPrompt.length > imageProviderPromptLimit(context, model, adapted.requirements)) {
        return reject('candidate_schema_invalid', 'image_creative_prompt_too_long_for_model', {
          candidate_key: node.candidate_key,
        });
      }
    }
    prepared.push({
      node,
      paramsSnapshot,
      quoteLabel: adapted.quoteLabel,
      requirements: adapted.requirements,
      bindings: contextBindings,
      providerBindings,
      model,
    });
  }

  if (crossGroupScope && context.declined_cross_group_scope_digest === crossGroupScope.digest) {
    return reject('candidate_schema_invalid', 'cross_upload_group_scope_declined');
  }
  if (crossGroupScope && context.confirmed_cross_group_scope_digest !== crossGroupScope.digest) {
    return reject('clarification_required', 'cross_upload_group_confirmation_required');
  }

  const planBase = {
    schema_version: 1 as const,
    compiler_version: context.policies.compiler_version,
    capability_registry_version: context.policies.capability_registry_version,
    source: candidate.source,
    intent: candidate.intent,
    ...(candidate.source_decision ? { source_decision: candidate.source_decision } : {}),
    ...(candidate.scope_decision ? { scope_decision: candidate.scope_decision } : {}),
    tasks: prepared.map(
      ({ node, paramsSnapshot, requirements, bindings, providerBindings, model }) => ({
        candidate_key: node.candidate_key,
        capability: node.capability,
        capability_version: node.capability_version,
        depends_on: [...node.depends_on].sort(),
        input_bindings: bindings.map((binding) => ({
          binding_key: binding.binding_key,
          kind: binding.kind,
          object_id: binding.object_id,
          object_version: binding.object_version,
          content_hash: binding.content_hash,
          role: binding.role ?? 'other',
          sort_order: binding.position ?? 0,
          provider_input: providerBindings.some(
            (providerBinding) => providerBinding.binding_key === binding.binding_key,
          ),
          publication_revision: binding.publication_revision ?? null,
        })),
        expected_output: node.expected_output,
        params_snapshot: paramsSnapshot,
        requirements,
        model_id: model.id,
      }),
    ),
  };
  const planDigest = canonicalSha256(planBase);
  const tasks: CompiledTask[] = prepared.map(
    ({ node, paramsSnapshot, requirements, bindings, providerBindings, model }) => {
      const taskKey = canonicalSha256({
        compiler_version: context.policies.compiler_version,
        plan_digest: planDigest,
        candidate_key: node.candidate_key,
      });
      const {
        circuit_allows_submit: _circuitAllowsSubmit,
        budget_allows_submit: _budgetAllowsSubmit,
        ...persistedModel
      } = model;
      void _circuitAllowsSubmit;
      void _budgetAllowsSubmit;
      return {
        candidate_key: node.candidate_key,
        task_key: taskKey,
        operation_key: canonicalSha256({
          turn_id: context.actor.turn_id,
          continuation_no: context.actor.continuation_no,
          plan_digest: planDigest,
          task_key: taskKey,
        }),
        capability: node.capability,
        capability_version: node.capability_version,
        depends_on: [...node.depends_on].sort(),
        input_bindings: bindings.map((binding) => ({
          binding_key: binding.binding_key,
          kind: binding.kind,
          object_id: binding.object_id,
          object_version: binding.object_version,
          content_hash: binding.content_hash,
          role: binding.role ?? 'other',
          sort_order: binding.position ?? 0,
          provider_input: providerBindings.some(
            (providerBinding) => providerBinding.binding_key === binding.binding_key,
          ),
          publication_revision: binding.publication_revision ?? null,
        })),
        expected_output: node.expected_output,
        params_snapshot: paramsSnapshot,
        model_snapshot: {
          ...persistedModel,
          status_evidence_digest: model.status_evidence_digest!,
        },
        cost: compileTaskCost({
          model,
          requirements,
          ...(context.policies.max_image_pixels !== undefined
            ? { maxImagePixels: context.policies.max_image_pixels }
            : {}),
          ...(context.model_selection ? { selection: context.model_selection.image } : {}),
        }),
      };
    },
  );
  const total = tasks.reduce((sum, task) => addMoney(sum, task.cost.estimated_credits), '0.00');
  const canonicalPlan = { ...planBase, tasks };
  const expiresAt = new Date(
    Date.parse(context.policies.compiled_at) + context.policies.quote_ttl_seconds * 1_000,
  ).toISOString();

  return {
    status: 'compiled',
    canonical_plan: canonicalPlan,
    plan_digest: planDigest,
    input_signature: canonicalSha256({ candidate, context }),
    quote_draft: {
      items: prepared.map((item, index) => ({
        label: item.quoteLabel,
        quantity: item.requirements.outputCount,
        estimated_credits: tasks[index]!.cost.estimated_credits,
      })),
      estimated_total_credits: total,
      expires_at: expiresAt,
      submission_mode: 'auto_submit',
    },
    snapshots: {
      skill: context.skill,
      execution_authorization_digest: context.execution_authorization_digest,
      prompt: context.prompt,
      policies: context.policies,
      ...(context.model_selection ? { model_selection: context.model_selection } : {}),
      ...(context.product_facts ? { product_facts: context.product_facts } : {}),
      ...(creativeProfile ? { creative_execution_profile: creativeProfile } : {}),
    },
  };
}
