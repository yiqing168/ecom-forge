import { canonicalSha256 } from '@ecom-forge/shared';
import { crossUploadGroupScope } from '@ecom-forge/agent';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CapabilityRegistry } from './capability-registry.js';
import { compilePlan } from './compile-plan.js';
import { createImageCapabilityRegistry } from './image-capabilities.js';
import { bindingSchema } from './schemas.js';
import type {
  BindingSnapshot,
  CandidatePlan,
  CapabilityAdapter,
  CompilerContext,
} from './types.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_SESSION_ID = '44444444-4444-4444-8444-444444444444';
const TURN_ID = '55555555-5555-4555-8555-555555555555';
const MODEL_ID = '66666666-6666-4666-8666-666666666666';
const OBJECT_ID = '77777777-7777-4777-8777-777777777777';
const DIGEST = 'a'.repeat(64);

const paramsSchema = z.strictObject({
  aspect_ratio: z.enum(['1:1', '4:5']),
  resolution: z.enum(['1024x1024']),
  output_count: z.int().positive().max(4),
  output_count_source: z.enum(['user_explicit', 'skill_default']),
  operation: z.enum(['generate', 'edit']),
});

const imageAdapter: CapabilityAdapter = {
  capability: 'image.generate',
  version: 1,
  allowedBindingKinds: ['asset', 'artifact'],
  compile(input) {
    const result = paramsSchema.safeParse(input.params);
    if (!result.success) return { ok: false, ruleId: 'image_params_invalid' };
    return {
      ok: true,
      paramsSnapshot: result.data,
      requirements: {
        outputType: 'image',
        outputCount: result.data.output_count,
        referenceImageCount: input.bindings.length,
        aspectRatio: result.data.aspect_ratio,
        resolution: result.data.resolution,
        operation: result.data.operation,
        mandatoryConfirmation: false,
      },
      quoteLabel: '图片生成',
    };
  },
};

const registry = new CapabilityRegistry('test-registry-v1', [imageAdapter]);

it('permits the sixteenth output but rejects a tenth original-source candidate', () => {
  const candidate = binding({ candidate_kind: 'latest_output', candidate_position: 16 });
  expect(bindingSchema.safeParse(candidate).success).toBe(true);
  expect(bindingSchema.safeParse({ ...candidate, candidate_kind: 'original_source' }).success).toBe(
    false,
  );
});

function binding(overrides: Partial<BindingSnapshot> = {}): BindingSnapshot {
  return {
    binding_key: 'binding-1',
    kind: 'asset',
    object_id: OBJECT_ID,
    object_version: 'v1',
    content_hash: DIGEST,
    owner_user_id: USER_ID,
    readable: true,
    mutable: false,
    producer_mode: null,
    producer_session_id: null,
    mutation_owner: null,
    source_action: null,
    media_type: 'image',
    lifecycle: 'active',
    visibility: 'private',
    ...overrides,
  };
}

function authorization() {
  return {
    schema_version: 2 as const,
    kind: 'generate_action' as const,
    create_request_hash: DIGEST,
    policy_version: 'execution-policy-v1',
  };
}

function context(overrides: Partial<CompilerContext> = {}): CompilerContext {
  const executionAuthorization = authorization();
  return {
    schema_version: 1,
    actor: {
      user_id: USER_ID,
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      continuation_no: 1,
    },
    skill: {
      primary_skill_id: 'creative-studio@1.0.0',
      default_output_count: 1,
      selection_digest: DIGEST,
      definition_digest: DIGEST,
      package_digest: DIGEST,
      release_digest: DIGEST,
      resource_digests: [DIGEST],
      required_capabilities: ['image.generate'],
      preset_ids: ['clean-editorial'],
      auxiliary_skill_ids: [],
    },
    execution_authorization: executionAuthorization,
    execution_authorization_digest: canonicalSha256(executionAuthorization),
    bindings: [binding()],
    product_facts: null,
    models: [
      {
        id: MODEL_ID,
        provider: 'test-provider',
        model_id: 'image-model',
        version: '1',
        status: 'poc_passed',
        status_evidence_digest: DIGEST,
        capability_contract: {
          schema_version: 1,
          capabilities: ['image.generate'],
          aspect_ratios: ['1:1', '4:5'],
          resolutions: ['1024x1024'],
          max_outputs: 4,
          max_reference_images: 4,
        },
        capability_contract_digest: DIGEST,
        pricing: {
          schema_version: 1,
          currency: 'CNY',
          provider_unit_cost_cny: '0.40',
          tool_cost_cny: '0.10',
          storage_cost_cny: '0.10',
          traffic_cost_cny: '0.10',
          agent_brain_cost_cny: '0.10',
          failure_rate: '0.10',
          unknown_rate: '0.10',
          refund_rate: '0.10',
          risk_reserve_rate: '0.10',
          gross_margin_target: '0.20',
          credit_cny_anchor: '1.00',
        },
        pricing_digest: DIGEST,
        quota: {
          schema_version: 1,
          rpm: 100,
          concurrency: 10,
          hourly_budget_cny: '100.00',
          daily_budget_cny: '1000.00',
          poll_initial_delay_ms: 1000,
          poll_interval_ms: 1000,
          max_poll_count: 30,
          terminal_timeout_ms: 60_000,
          circuit_sample_size: 20,
          circuit_failure_rate: '0.50',
          circuit_unknown_rate: '0.25',
          circuit_open_ms: 60_000,
        },
        quota_digest: DIGEST,
        circuit_allows_submit: true,
        budget_allows_submit: true,
      },
    ],
    policies: {
      compiler_version: 's09-v1',
      capability_registry_version: registry.version,
      pricing_policy_version: 'pricing-v1',
      content_safety_policy_version: 'safety-v1',
      platform_policy_version: 'platform-v1',
      product_fact_policy_version: null,
      execution_policy_version: executionAuthorization.policy_version,
      quote_ttl_seconds: 600,
      compiled_at: '2026-08-13T00:00:00.000Z',
    },
    prompt: {
      template_version: 'image-v1',
      prompt_digest: DIGEST,
      safe_summary: 'Create a product image',
    },
    mandatory_confirmation: false,
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}): CandidatePlan {
  const value: CandidatePlan = {
    schema_version: 1,
    intent: { kind: 'creative_generate', confidence: 0.95 },
    skill_id: 'creative-studio@1.0.0',
    source: 'chat',
    nodes: [
      {
        candidate_key: 'generate-1',
        capability: 'image.generate',
        capability_version: 1,
        depends_on: [],
        input_bindings: ['binding-1'],
        params: {
          aspect_ratio: '1:1',
          resolution: '1024x1024',
          output_count: 1,
          output_count_source: 'user_explicit',
          operation: 'generate',
        },
        expected_output: 'image',
      },
    ],
  };
  return Object.assign(value, overrides);
}

describe('compilePlan', () => {
  it('rejects extra historical work before creating a quote, but permits an explicit old-subject selection', () => {
    const scopedContext = context({
      bindings: [
        binding({
          source_group: {
            message_id: TURN_ID,
            created_at: '2026-09-27T00:00:00.000Z',
            is_latest_upload: false,
          },
        }),
      ],
    });
    const plan = candidate({
      scope_decision: {
        mode: 'latest_upload',
        input_binding_keys: ['binding-1'],
        output_count: 1,
        reason_summary: 'Continue the recent photo.',
      },
    });
    const rejected = compilePlan({ candidate: plan, context: scopedContext, registry });
    expect(rejected).toMatchObject({
      status: 'rejected',
      details: [{ rule_id: 'generation_scope_mismatch' }],
    });
    expect(rejected).not.toHaveProperty('quote_draft');
    plan.scope_decision!.mode = 'conversation_reference';
    plan.scope_decision!.reason_summary = 'The user referred back to the earlier photo.';
    expect(compilePlan({ candidate: plan, context: scopedContext, registry }).status).toBe(
      'compiled',
    );
    plan.scope_decision!.output_count = 2;
    expect(compilePlan({ candidate: plan, context: scopedContext, registry }).status).toBe(
      'rejected',
    );
  });
  it('requires an exact user confirmation before quoting an automatic cross-group plan', () => {
    const bindings = [
      binding({
        source_group: {
          message_id: TURN_ID,
          created_at: '2026-09-27T00:00:00.000Z',
          is_latest_upload: false,
        },
      }),
      binding({
        binding_key: 'binding-2',
        object_id: OTHER_USER_ID,
        source_group: {
          message_id: SESSION_ID,
          created_at: '2026-09-28T00:00:00.000Z',
          is_latest_upload: true,
        },
      }),
    ];
    const plan = candidate({
      scope_decision: {
        mode: 'conversation_reference',
        input_binding_keys: ['binding-1', 'binding-2'],
        output_count: 1,
        reason_summary: 'Use both upload groups.',
      },
    });
    plan.nodes[0]!.input_bindings = ['binding-1', 'binding-2'];
    const base = context({ bindings });
    expect(compilePlan({ candidate: plan, context: base, registry })).toMatchObject({
      status: 'rejected',
      code: 'clarification_required',
      details: [{ rule_id: 'cross_upload_group_confirmation_required' }],
    });
    const scope = crossUploadGroupScope(plan, bindings);
    expect(scope).toMatchObject({ groupCount: 2, sourceCount: 2, outputCount: 1 });
    expect(
      compilePlan({
        candidate: plan,
        context: context({ bindings, declined_cross_group_scope_digest: scope!.digest }),
        registry,
      }),
    ).toMatchObject({
      status: 'rejected',
      code: 'candidate_schema_invalid',
      details: [{ rule_id: 'cross_upload_group_scope_declined' }],
    });
    const confirmed = context({
      bindings,
      confirmed_cross_group_scope_digest: scope!.digest,
    });
    const compiled = compilePlan({ candidate: plan, context: confirmed, registry });
    expect(compiled.status).toBe('compiled');
    if (compiled.status !== 'compiled') throw new Error('Expected a confirmed plan');
    expect(compiled.canonical_plan.scope_decision).toEqual(plan.scope_decision);
    plan.nodes[0]!.params.output_count = 2;
    plan.scope_decision!.output_count = 2;
    expect(compilePlan({ candidate: plan, context: confirmed, registry })).toMatchObject({
      status: 'rejected',
      code: 'clarification_required',
    });
    plan.nodes[0]!.input_bindings = ['binding-2'];
    plan.scope_decision!.input_binding_keys = ['binding-2'];
    expect(compilePlan({ candidate: plan, context: base, registry })).not.toMatchObject({
      code: 'clarification_required',
    });
  });
  it('freezes the validated scope in the canonical plan and includes it in the digest', () => {
    const plan = candidate({
      scope_decision: {
        mode: 'latest_upload',
        input_binding_keys: ['binding-1'],
        output_count: 1,
        reason_summary: 'Use the recent photo.',
      },
    });
    const first = compilePlan({ candidate: plan, context: context(), registry });
    const replay = compilePlan({ candidate: plan, context: context(), registry });
    expect(first).toEqual(replay);
    if (first.status !== 'compiled') throw new Error('Expected a scoped plan');
    expect(first.canonical_plan.scope_decision).toEqual(plan.scope_decision);

    plan.scope_decision!.reason_summary = 'Continue the selected subject.';
    const changed = compilePlan({ candidate: plan, context: context(), registry });
    if (changed.status !== 'compiled') throw new Error('Expected a revised scoped plan');
    expect(changed.plan_digest).not.toBe(first.plan_digest);
    expect(first.canonical_plan.scope_decision?.reason_summary).toBe('Use the recent photo.');
    expect(changed.canonical_plan.scope_decision).toEqual(plan.scope_decision);

    const legacy = compilePlan({ candidate: candidate(), context: context(), registry });
    if (legacy.status !== 'compiled') throw new Error('Expected a legacy unscoped plan');
    expect(legacy.canonical_plan).not.toHaveProperty('scope_decision');
    expect(legacy.plan_digest).not.toBe(first.plan_digest);
  });
  it('compiles the same input into a stable auto-submit plan and decimal quote', () => {
    const first = compilePlan({ candidate: candidate(), context: context(), registry });
    const second = compilePlan({ candidate: candidate(), context: context(), registry });

    expect(first).toEqual(second);
    expect(first.status).toBe('compiled');
    if (first.status !== 'compiled') return;
    expect(first.quote_draft).toMatchObject({
      estimated_total_credits: '2.00',
      expires_at: '2026-08-13T00:10:00.000Z',
      submission_mode: 'auto_submit',
    });
    expect(first.canonical_plan.tasks[0]).toMatchObject({
      capability: 'image.generate',
      input_bindings: [{ binding_key: 'binding-1', object_id: OBJECT_ID }],
    });
  });

  it('rejects an output count that differs from the snapshotted Skill default', () => {
    const plan = candidate();
    plan.nodes[0]!.params.output_count_source = 'skill_default';
    plan.nodes[0]!.params.output_count = 2;

    expect(compilePlan({ candidate: plan, context: context(), registry })).toMatchObject({
      status: 'rejected',
      code: 'candidate_schema_invalid',
      details: [{ rule_id: 'skill_default_output_count_mismatch' }],
    });
  });

  it('requires an explicit model source decision whenever session candidates are present', () => {
    const sessionOutput = binding({
      binding_key: 'session-output-1',
      kind: 'artifact',
      role: 'edit_source',
      mutable: true,
      producer_mode: 'chat',
      producer_session_id: SESSION_ID,
      mutation_owner: 'chat_session',
      publication_revision: 2,
      candidate_kind: 'latest_output',
      candidate_position: 1,
      lineage_source_binding_keys: [],
    });
    const plan = candidate({
      intent: { kind: 'chat_artifact_edit', confidence: 0.95 },
    });
    plan.nodes[0]!.input_bindings = [sessionOutput.binding_key];
    plan.nodes[0]!.params.operation = 'edit';

    expect(
      compilePlan({ candidate: plan, context: context({ bindings: [sessionOutput] }), registry }),
    ).toMatchObject({
      status: 'rejected',
      code: 'candidate_schema_invalid',
      details: [{ rule_id: 'creative_decision_required' }],
    });
  });

  it('preserves the chosen canvas and does not add per-Skill postprocessing', () => {
    const skillId = 'minimal-scene-collage@2.9.0';
    const imageRegistry = createImageCapabilityRegistry();
    const source = binding({ role: 'semantic_reference' });
    const compilerContext = context({
      skill: {
        ...context().skill,
        primary_skill_id: skillId,
        execution_policy: { version: 1, family: 'independent_sources', max_sources: 9 },
        default_output_count: 1,
        required_capabilities: ['image.edit'],
      },
      bindings: [source],
      generation_preferences: {
        schema_version: 2,
        output_kind: 'image',
        aspect_ratio: 'auto',
        resolution_tier: '1k',
      },
    });
    compilerContext.policies.capability_registry_version = imageRegistry.version;
    compilerContext.models[0]!.capability_contract = {
      schema_version: 1,
      capabilities: ['image.edit'],
      aspect_ratios: ['1:1', '3:4', '9:16'],
      resolutions: ['1k'],
      max_outputs: 1,
      max_reference_images: 1,
    };
    const plan = candidate({
      intent: { kind: 'raw_asset_generate', confidence: 0.95 },
      skill_id: skillId,
    });
    plan.nodes[0] = {
      candidate_key: 'scene-1',
      capability: 'image.edit',
      capability_version: 1,
      depends_on: [],
      input_bindings: [source.binding_key],
      params: {
        goal_summary: 'Create a minimal scene collage.',
        aspect_ratio: '1:1',
        output_count: 1,
        output_count_source: 'skill_default',
        semantic_summary: 'Preserve the source scene identity and its main spatial relationship.',
        creative_prompt:
          'Keep the source-specific visual relationship, build a compact lower-panel graphic, and render no visible text.',
      },
      expected_output: 'image',
    };

    const result = compilePlan({
      candidate: plan,
      context: compilerContext,
      registry: imageRegistry,
    });
    expect(result).toMatchObject({
      status: 'compiled',
      canonical_plan: {
        tasks: [
          {
            input_bindings: [
              expect.objectContaining({
                object_id: source.object_id,
                role: 'semantic_reference',
                provider_input: true,
              }),
            ],
            params_snapshot: {
              aspect_ratio: '1:1',
            },
          },
        ],
      },
    });
    if (result.status !== 'compiled') throw new Error('Expected compiled plan');
    expect(result.canonical_plan.tasks[0]?.params_snapshot).not.toHaveProperty('postprocess');

    compilerContext.models[0]!.capability_contract = {
      schema_version: 1,
      capabilities: ['image.edit'],
      aspect_ratios: ['3:4', '16:9'],
      resolutions: ['1k'],
      max_outputs: 1,
      max_reference_images: 1,
    };
    expect(
      compilePlan({ candidate: plan, context: compilerContext, registry: imageRegistry }),
    ).toMatchObject({
      status: 'rejected',
      code: 'model_not_approved',
    });
  });

  it.each([
    ['top-level unknown field', { unknown: true }],
    ['forged provider', { provider: 'attacker' }],
    ['forged model', { model_id: MODEL_ID }],
    ['forged permission', { mutable: true }],
  ])('rejects %s in the untrusted candidate', (_label, extra) => {
    expect(
      compilePlan({ candidate: candidate(extra), context: context(), registry }),
    ).toMatchObject({
      status: 'rejected',
      code: 'candidate_schema_invalid',
    });
  });

  it('requests clarification below the confidence threshold', () => {
    expect(
      compilePlan({
        candidate: candidate({ intent: { kind: 'creative_generate', confidence: 0.84 } }),
        context: context(),
        registry,
      }),
    ).toMatchObject({
      status: 'rejected',
      code: 'clarification_required',
      safe_action: 'ask_user',
    });
  });

  it.each([
    ['self reference', ['generate-1']],
    ['missing dependency', ['missing']],
  ])('rejects a DAG with %s', (_label, dependsOn) => {
    const plan = candidate();
    plan.nodes[0]!.depends_on = dependsOn;
    expect(compilePlan({ candidate: plan, context: context(), registry })).toMatchObject({
      status: 'rejected',
      code: 'dag_invalid',
    });
  });

  it('rejects a cycle and stable-sorts independent nodes', () => {
    const plan = candidate();
    const second = structuredClone(plan.nodes[0]!);
    second.candidate_key = 'generate-2';
    plan.nodes = [second, plan.nodes[0]!];
    const sorted = compilePlan({ candidate: plan, context: context(), registry });
    expect(sorted.status).toBe('compiled');
    if (sorted.status === 'compiled') {
      expect(sorted.canonical_plan.tasks.map((task) => task.candidate_key)).toEqual([
        'generate-1',
        'generate-2',
      ]);
    }

    plan.nodes[0]!.depends_on = ['generate-1'];
    plan.nodes[1]!.depends_on = ['generate-2'];
    expect(compilePlan({ candidate: plan, context: context(), registry })).toMatchObject({
      status: 'rejected',
      code: 'dag_invalid',
    });
  });

  it('returns the same unavailable result for a missing or foreign binding', () => {
    const missing = compilePlan({
      candidate: candidate(),
      context: context({ bindings: [] }),
      registry,
    });
    const foreign = compilePlan({
      candidate: candidate(),
      context: context({ bindings: [binding({ owner_user_id: OTHER_USER_ID })] }),
      registry,
    });
    expect(missing).toMatchObject({ status: 'rejected', code: 'reference_unavailable' });
    expect(foreign).toMatchObject({ status: 'rejected', code: 'reference_unavailable' });
  });

  it.each([
    [
      'current chat session',
      binding({
        kind: 'artifact',
        mutable: true,
        producer_mode: 'chat',
        producer_session_id: SESSION_ID,
        mutation_owner: 'chat_session',
      }),
      'compiled',
      undefined,
    ],
    [
      'another chat session',
      binding({
        kind: 'artifact',
        mutable: false,
        producer_mode: 'chat',
        producer_session_id: OTHER_SESSION_ID,
        mutation_owner: 'chat_session',
      }),
      'rejected',
      'start_new_generation',
    ],
    [
      'canvas artifact',
      binding({
        kind: 'artifact',
        mutable: false,
        producer_mode: 'canvas',
        producer_session_id: null,
        mutation_owner: 'canvas',
      }),
      'rejected',
      'open_canvas',
    ],
  ])('enforces R1-R5 for %s', (_label, target, status, safeAction) => {
    const plan = candidate({ intent: { kind: 'chat_artifact_edit', confidence: 0.95 } });
    plan.nodes[0]!.params.operation = 'edit';
    const result = compilePlan({
      candidate: plan,
      context: context({ bindings: [target] }),
      registry,
    });
    expect(result.status).toBe(status);
    if (safeAction)
      expect(result).toMatchObject({ code: 'mutation_forbidden', safe_action: safeAction });
  });

  it('rejects skill, registry, authorization, and model approval drift', () => {
    expect(
      compilePlan({
        candidate: candidate({ skill_id: 'creative-studio@2.0.0' }),
        context: context(),
        registry,
      }),
    ).toMatchObject({ code: 'skill_version_drift' });

    const disabledModel = context();
    disabledModel.models[0]!.status = 'disabled';
    expect(compilePlan({ candidate: candidate(), context: disabledModel, registry })).toMatchObject(
      {
        code: 'model_not_approved',
      },
    );

    const stalePolicy = context();
    stalePolicy.execution_authorization.policy_version = 'stale';
    expect(compilePlan({ candidate: candidate(), context: stalePolicy, registry })).toMatchObject({
      code: 'policy_version_drift',
    });
  });

  it('always compiles generated work for direct submission', () => {
    const commerce = compilePlan({
      candidate: candidate({ intent: { kind: 'commerce_generate', confidence: 0.95 } }),
      context: context(),
      registry,
    });
    expect(commerce).toMatchObject({
      status: 'compiled',
      quote_draft: { submission_mode: 'auto_submit' },
    });
  });

  it('changes the input signature when a binding, model, skill, or policy snapshot changes', () => {
    const base = compilePlan({ candidate: candidate(), context: context(), registry });
    expect(base.status).toBe('compiled');
    if (base.status !== 'compiled') return;

    const variants = [
      context({ bindings: [binding({ object_version: 'v2' })] }),
      (() => {
        const value = context();
        value.models[0]!.version = '2';
        return value;
      })(),
      (() => {
        const value = context();
        value.skill.definition_digest = 'b'.repeat(64);
        return value;
      })(),
      (() => {
        const value = context();
        value.policies.pricing_policy_version = 'pricing-v2';
        return value;
      })(),
    ];

    for (const variant of variants) {
      const result = compilePlan({ candidate: candidate(), context: variant, registry });
      expect(result.status).toBe('compiled');
      if (result.status === 'compiled')
        expect(result.input_signature).not.toBe(base.input_signature);
    }
  });
});
