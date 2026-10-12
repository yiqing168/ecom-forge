import {
  authoredPromptsSchema,
  mergeAuthoredPrompts,
  prepareAgentTranscriptItem,
  prepareAgentTranscriptPayload,
  validateAgentTranscriptProtocol,
  verifyAgentTranscriptItem,
  verifyAgentTranscriptPayload,
  type AgentTranscriptItemContracts,
  type AgentTranscriptPayloadContract,
} from '@ecom-forge/agent';
import { imageCreativePromptMaxCharacters } from '@ecom-forge/provider';
import { canonicalJson, canonicalSha256 } from '@ecom-forge/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { compilePlan } from './compile-plan.js';
import { compileTaskCost } from './cost.js';
import { createImageCapabilityRegistry } from './image-capabilities.js';
import { candidatePlanSchema } from './schemas.js';
import type { CandidatePlan, CompilerContext } from './types.js';

const ids = {
  user: '11111111-1111-4111-8111-111111111111',
  session: '22222222-2222-4222-8222-222222222222',
  turn: '33333333-3333-4333-8333-333333333333',
  model: '44444444-4444-4444-8444-444444444444',
  channel: '55555555-5555-4555-8555-555555555555',
  credential: '66666666-6666-4666-8666-666666666666',
  entry: '77777777-7777-4777-8777-777777777777',
  sku: '88888888-8888-4888-8888-888888888888',
  release: '99999999-9999-4999-8999-999999999999',
  textModerationModel: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  textModerationCredential: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  imageModerationModel: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  imageModerationCredential: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  planningPayload: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  authoringPayload: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
} as const;
const DIGEST = 'a'.repeat(64);
const registry = createImageCapabilityRegistry();

const capability = {
  schema_version: 2 as const,
  contract_kind: 'media' as const,
  media_kind: 'image' as const,
  capabilities: ['image.generate' as const],
  specs: [
    {
      kind: 'image' as const,
      spec_key: 'quality.2k.generate',
      operation: 'image.generate' as const,
      mode: 'quality',
      resolution_tier: '2k' as const,
      aspect_ratios: ['1:1', '3:4'],
      max_outputs: 4,
      max_reference_images: 0,
      max_prompt_characters: 32_000,
      transparent_background: false,
      output_formats: ['png' as const],
    },
  ],
};
const pricing = {
  schema_version: 2 as const,
  contract_kind: 'media_rate_card' as const,
  currency: 'CNY' as const,
  rate_cards: [
    {
      rate_key: 'quality.2k.image',
      spec_key: 'quality.2k.generate',
      billing_unit: 'image' as const,
      unit_cost_cny: '0.50',
    },
  ],
  overhead_cny: { tool: '0.10', storage: '0.10', traffic: '0.10', agent_brain: '0.10' },
  failure_rate: '0.10',
  unknown_rate: '0.10',
  refund_rate: '0.10',
  risk_reserve_rate: '0.10',
  gross_margin_target: '0.20',
  credit_cny_anchor: '1.00',
};
const matcher = {
  schema_version: 1,
  kind: 'image',
  mode: 'quality',
  resolution: '2k',
  transparent_background: false,
  reference_tier: 'none',
};

function context(): CompilerContext {
  const executionAuthorization = {
    schema_version: 2 as const,
    kind: 'generate_action' as const,
    create_request_hash: DIGEST,
    policy_version: 'execution-policy-v1',
  };
  return {
    schema_version: 1,
    actor: {
      user_id: ids.user,
      session_id: ids.session,
      turn_id: ids.turn,
      continuation_no: 1,
    },
    skill: {
      primary_skill_id: 'creative-free-generation@1.0.1',
      execution_policy: { version: 1, family: 'text_generation', max_sources: 9 },
      default_output_count: 1,
      selection_digest: DIGEST,
      definition_digest: DIGEST,
      package_digest: DIGEST,
      release_digest: DIGEST,
      resource_digests: [DIGEST],
      required_capabilities: ['image.generate'],
      preset_ids: [],
      auxiliary_skill_ids: [],
    },
    execution_authorization: executionAuthorization,
    execution_authorization_digest: canonicalSha256(executionAuthorization),
    bindings: [],
    product_facts: null,
    generation_preferences: {
      schema_version: 2,
      output_kind: 'image',
      aspect_ratio: '1:1',
      resolution_tier: '2k',
    },
    models: [
      {
        id: ids.model,
        provider_channel_id: ids.channel,
        provider: 'approved-relay',
        model_id: 'gpt-image-compatible',
        version: '2026-08',
        status: 'poc_passed',
        status_evidence_digest: DIGEST,
        capability_contract: capability,
        capability_contract_digest: canonicalSha256(capability),
        pricing,
        pricing_digest: canonicalSha256(pricing),
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
    model_selection: {
      schema_version: 1,
      catalog_revision: 7,
      catalog_release_id: ids.release,
      catalog_release_digest: DIGEST,
      image: {
        catalog_entry_id: ids.entry,
        catalog_entry_revision: 3,
        version_no: 2,
        model_snapshot_id: ids.model,
        selected_spec_key: 'quality.2k.generate',
        max_prompt_characters: 32_000,
        runtime: {
          provider_channel_id: ids.channel,
          provider_channel_revision: 4,
          adapter_key: 'openai-images-v1',
          endpoint_profile_key: 'relay-v1',
          region: null,
          credential_version_id: ids.credential,
        },
        billing_sku: {
          id: ids.sku,
          logical_sku_key: 'image.quality.2k',
          version_no: 2,
          model_catalog_entry_id: ids.entry,
          operation: 'image.generate',
          matcher,
          matcher_hash: canonicalSha256(matcher),
          unit_kind: 'image',
          unit_rule: { min_quantity: 1, max_quantity: 4, step_quantity: 1 },
          credits_per_unit: '3.00',
          provider_rate_card_key: 'quality.2k.image',
          provider_cost_per_unit_cny: '0.50',
          revision: 2,
        },
      },
      moderation: {
        schema_version: 1,
        text: {
          capability: 'moderation.text',
          runtime_revision: 1,
          model_snapshot_id: ids.textModerationModel,
          credential_version_id: ids.textModerationCredential,
          policy_version: 'content-safety@1',
          evidence_digest: DIGEST,
          pricing_digest: DIGEST,
          risk_adjusted_cost_cny: '0.01',
        },
        image: {
          capability: 'moderation.image',
          runtime_revision: 1,
          model_snapshot_id: ids.imageModerationModel,
          credential_version_id: ids.imageModerationCredential,
          policy_version: 'content-safety@1',
          evidence_digest: DIGEST,
          pricing_digest: DIGEST,
          risk_adjusted_cost_cny: '0.02',
        },
      },
    },
    policies: {
      compiler_version: 's09-v1',
      capability_registry_version: registry.version,
      pricing_policy_version: 'pricing-v2',
      content_safety_policy_version: 'content-safety-v1',
      platform_policy_version: 'platform-v1',
      product_fact_policy_version: null,
      execution_policy_version: 'execution-policy-v1',
      max_image_pixels: 100_000_000,
      quote_ttl_seconds: 600,
      compiled_at: '2026-08-18T00:00:00.000Z',
    },
    prompt: { template_version: 'image-v1', prompt_digest: DIGEST, safe_summary: '生成商品图' },
    mandatory_confirmation: false,
  };
}

function candidate(
  params: Record<string, unknown> = {
    goal_summary: '突出商品主体',
    output_count: 2,
    output_count_source: 'user_explicit',
  },
): CandidatePlan {
  return {
    schema_version: 1,
    intent: { kind: 'creative_generate', confidence: 0.99 },
    skill_id: 'creative-free-generation@1.0.1',
    source: 'chat',
    nodes: [
      {
        candidate_key: 'generate-main',
        capability: 'image.generate',
        capability_version: 1,
        depends_on: [],
        input_bindings: [],
        params,
        expected_output: 'image',
      },
    ],
  };
}

describe('S12 media-v2 compilation', () => {
  it.each(['image', 'megapixel'] as const)(
    'checks host pixel limits before producing a %s quote',
    (billingUnit) => {
      for (const [tier, limit, expected] of [
        ['1k', 1_048_576, 'compiled'],
        ['2k', 4_194_304, 'compiled'],
        ['2k', 4_194_303, 'rejected'],
        ['4k', 2_000_000, 'rejected'],
      ] as const) {
        const host = structuredClone(context());
        host.policies.max_image_pixels = limit;
        host.generation_preferences!.resolution_tier = tier;
        const model = host.models[0]!;
        if (model.capability_contract.schema_version !== 2 || model.pricing.schema_version !== 2)
          throw new Error('Expected media v2');
        const spec = model.capability_contract.specs[0]!;
        if (spec.kind !== 'image') throw new Error('Expected image spec');
        spec.resolution_tier = tier;
        spec.max_outputs = 1;
        model.capability_contract_digest = canonicalSha256(model.capability_contract);
        const sku = host.model_selection!.image.billing_sku;
        sku.matcher = { ...sku.matcher, resolution: tier };
        sku.matcher_hash = canonicalSha256(sku.matcher);
        if (billingUnit === 'megapixel') {
          const units = { min_megapixels: '1', max_megapixels: '40', step_megapixels: '1' };
          model.pricing.rate_cards[0] = {
            ...model.pricing.rate_cards[0]!,
            billing_unit: billingUnit,
            ...units,
          };
          sku.unit_kind = billingUnit;
          sku.unit_rule = units;
        } else {
          sku.unit_rule = { min_quantity: 1, max_quantity: 1, step_quantity: 1 };
        }
        model.pricing_digest = canonicalSha256(model.pricing);
        const result = compilePlan({
          candidate: candidate({
            goal_summary: 'A cup',
            output_count: 1,
            output_count_source: 'user_explicit',
          }),
          context: host,
          registry,
        });
        expect(result.status).toBe(expected);
        if (expected === 'rejected') {
          expect(result).toMatchObject({
            code: 'model_not_approved',
            details: [{ rule_id: 'image_dimensions_unavailable' }],
          });
          expect(result).not.toHaveProperty('quote_draft');
        } else {
          expect(result).toMatchObject({ snapshots: { policies: { max_image_pixels: limit } } });
        }
      }
    },
  );

  it('rejects a media image context with no host pixel bound', () => {
    const host = context();
    delete host.policies.max_image_pixels;
    expect(compilePlan({ candidate: candidate(), context: host, registry })).toMatchObject({
      status: 'rejected',
      code: 'model_not_approved',
      details: [{ rule_id: 'image_dimensions_unavailable' }],
    });
  });

  it('uses Provider-aligned 4K dimensions for megapixel pricing', () => {
    const host = structuredClone(context());
    const model = host.models[0]!;
    if (model.capability_contract.schema_version !== 2 || model.pricing.schema_version !== 2)
      throw new Error('Expected media v2');
    const spec = model.capability_contract.specs[0]!;
    if (spec.kind !== 'image') throw new Error('Expected image spec');
    spec.resolution_tier = '4k';
    model.pricing.rate_cards[0] = {
      ...model.pricing.rate_cards[0]!,
      billing_unit: 'megapixel',
      min_megapixels: '1',
      max_megapixels: '40',
      step_megapixels: '1',
    };
    const cost = compileTaskCost({
      model,
      selection: host.model_selection!.image,
      requirements: {
        aspectRatio: '3:4',
        resolution: '4k',
        outputCount: 1,
        outputType: 'image',
        referenceImageCount: 0,
        operation: 'generate',
        mandatoryConfirmation: false,
      },
    });
    // 2448 x 3264 pixels rounds up to 8 billed megapixels at 3 credits each.
    expect(cost.estimated_credits).toBe('24.00');
  });
  it('compiles 4K with matching model and SKU snapshots', () => {
    const host = structuredClone(context());
    host.generation_preferences!.resolution_tier = '4k';
    const model = host.models[0]!;
    if (model.capability_contract.schema_version !== 2) throw new Error('Expected media v2');
    const spec = model.capability_contract.specs[0]!;
    if (spec.kind !== 'image') throw new Error('Expected image spec');
    spec.resolution_tier = '4k';
    model.capability_contract_digest = canonicalSha256(model.capability_contract);
    const sku = host.model_selection!.image.billing_sku;
    sku.matcher = { ...sku.matcher, resolution: '4k' };
    sku.matcher_hash = canonicalSha256(sku.matcher);
    const result = compilePlan({ candidate: candidate(), context: host, registry });
    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') throw new Error('Expected 4K compilation');
    expect(result.canonical_plan.tasks[0]?.params_snapshot.resolution_tier).toBe('4k');
    expect(result.canonical_plan.tasks[0]?.cost.estimated_credits).toBe('6.00');
  });
  it('compiles a complete text-only free creation prompt without any style or auxiliary', () => {
    const prompt =
      'A blue ceramic cup in the lower left, overhead view, white background. No text.';
    const host = context();
    const result = compilePlan({
      candidate: candidate({
        goal_summary: 'Create the requested cup image',
        creative_prompt: prompt,
        output_count: 1,
        output_count_source: 'user_explicit',
      }),
      context: host,
      registry,
    });
    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') throw new Error('Expected text-only compilation');
    expect(host.skill.preset_ids).toEqual([]);
    expect(host.skill.auxiliary_skill_ids).toEqual([]);
    expect(result.canonical_plan.tasks).toHaveLength(1);
    expect(result.canonical_plan.tasks[0]?.params_snapshot).toMatchObject({
      creative_prompt: prompt,
      output_count: 1,
      operation: 'image.generate',
    });
  });

  it('compiles an unfamiliar Skill using its policy and preserves the frozen family', () => {
    const host = context();
    const plan = candidate();
    host.skill.primary_skill_id = 'new-author-method@1.0.0';
    plan.skill_id = host.skill.primary_skill_id;
    const result = compilePlan({ candidate: plan, context: host, registry });
    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') throw new Error('Expected declared Skill compilation');
    expect(result.canonical_plan.tasks[0]?.params_snapshot).toMatchObject({
      creative_execution_profile: {
        profile_id: 'text_generation',
        primary_skill_id: host.skill.primary_skill_id,
        execution_policy: host.skill.execution_policy,
      },
    });
  });

  it('rejects missing product facts for a product family regardless of Skill name', () => {
    const host = context();
    host.skill.primary_skill_id = 'new-product-method@1.0.0';
    host.skill.execution_policy = { version: 1, family: 'product', max_sources: 9 };
    const plan = candidate();
    plan.skill_id = host.skill.primary_skill_id;
    plan.intent.kind = 'commerce_generate';
    const result = compilePlan({ candidate: plan, context: host, registry });
    expect(result).toMatchObject({ status: 'rejected', code: 'policy_version_drift' });
  });
  it('freezes the exact selected model, runtime, spec and SKU', () => {
    const result = compilePlan({ candidate: candidate(), context: context(), registry });

    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') return;
    expect(result.quote_draft.estimated_total_credits).toBe('6.00');
    expect(result.canonical_plan.tasks[0]).toMatchObject({
      model_snapshot: { id: ids.model, provider_channel_id: ids.channel },
      params_snapshot: { aspect_ratio: '1:1', resolution_tier: '2k', output_count: 2 },
      cost: {
        billing_sku_id: ids.sku,
        billing_sku_version: 2,
        credits_per_unit: '3.00',
        estimated_credits: '6.00',
      },
    });
    expect(result.snapshots.model_selection?.image.runtime.credential_version_id).toBe(
      ids.credential,
    );
  });

  it('rejects candidate-owned model, price and generation parameters', () => {
    const result = compilePlan({
      candidate: candidate({
        goal_summary: '突出商品主体',
        model_id: 'attacker-model',
        credits_per_unit: '0.00',
        resolution_tier: '4k',
      }),
      context: context(),
      registry,
    });
    expect(result).toMatchObject({
      status: 'rejected',
      code: 'candidate_schema_invalid',
      details: [{ rule_id: 'image_candidate_params_invalid' }],
    });
  });

  it('enforces the selected image spec prompt limit without truncation', () => {
    const result = compilePlan({
      candidate: candidate({
        goal_summary: '突出商品主体',
        creative_prompt: 'x'.repeat(32_001),
        output_count: 1,
        output_count_source: 'user_explicit',
      }),
      context: context(),
      registry,
    });

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'candidate_schema_invalid',
      details: [{ rule_id: 'image_creative_prompt_too_long_for_model' }],
    });
  });

  it('rejects a model selection whose prompt limit drifted from the selected spec', () => {
    const value = structuredClone(context());
    value.model_selection!.image.max_prompt_characters = 4_000;

    expect(compilePlan({ candidate: candidate(), context: value, registry })).toMatchObject({
      status: 'rejected',
      code: 'model_not_approved',
      details: [{ rule_id: 'selected_model_closure_invalid' }],
    });
  });

  it('uses the legacy prompt limit when an older image spec has no prompt field', () => {
    const value = structuredClone(context());
    delete value.model_selection;
    if (value.models[0]!.capability_contract.schema_version !== 2) {
      throw new Error('Expected a media v2 capability contract');
    }
    const legacySpec = value.models[0]!.capability_contract.specs[0];
    if (!legacySpec || legacySpec.kind !== 'image') {
      throw new Error('Expected an image capability spec');
    }
    delete legacySpec.max_prompt_characters;

    expect(
      compilePlan({
        candidate: candidate({
          goal_summary: '突出商品主体',
          creative_prompt: 'x'.repeat(32_001),
          output_count: 1,
          output_count_source: 'user_explicit',
        }),
        context: value,
        registry,
      }),
    ).toMatchObject({
      status: 'rejected',
      code: 'candidate_schema_invalid',
      details: [{ rule_id: 'image_creative_prompt_too_long_for_model' }],
    });
  });

  it.each([
    ['approval', { status_evidence_digest: null }, 'selected_model_not_approved'],
    ['circuit', { circuit_allows_submit: false }, 'selected_model_circuit_open'],
    ['budget', { budget_allows_submit: false }, 'selected_model_budget_exceeded'],
    [
      'budget and circuit',
      { budget_allows_submit: false, circuit_allows_submit: false },
      'selected_model_budget_exceeded',
    ],
  ] as const)('distinguishes %s rejection from specification drift', (_label, fields, ruleId) => {
    const value = structuredClone(context());
    Object.assign(value.models[0]!, fields);

    expect(compilePlan({ candidate: candidate(), context: value, registry })).toMatchObject({
      status: 'rejected',
      code: 'model_not_approved',
      details: [{ rule_id: ruleId }],
    });
  });

  it('validates and freezes the concrete ratio selected under intelligent mode', () => {
    const value = structuredClone(context());
    value.generation_preferences!.aspect_ratio = 'auto';
    const result = compilePlan({
      candidate: candidate({
        goal_summary: '突出商品主体',
        aspect_ratio: '3:4',
        output_count: 2,
        output_count_source: 'user_explicit',
      }),
      context: value,
      registry,
    });

    expect(result.status).toBe('compiled');
    if (result.status !== 'compiled') return;
    expect(result.canonical_plan.tasks[0]?.params_snapshot.aspect_ratio).toBe('3:4');
  });

  it('rejects an intelligent ratio that the selected model spec does not support', () => {
    const value = structuredClone(context());
    value.generation_preferences!.aspect_ratio = 'auto';
    expect(
      compilePlan({
        candidate: candidate({
          goal_summary: '突出商品主体',
          aspect_ratio: '16:9',
          output_count: 2,
          output_count_source: 'user_explicit',
        }),
        context: value,
        registry,
      }),
    ).toMatchObject({
      status: 'rejected',
      code: 'model_not_approved',
      details: [{ rule_id: 'selected_model_closure_invalid' }],
    });
  });

  it.each([
    [
      'selected model drift',
      (value: CompilerContext) => {
        value.model_selection!.image.model_snapshot_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      },
    ],
    [
      'selected SKU matcher drift',
      (value: CompilerContext) => {
        const changed = { ...value.model_selection!.image.billing_sku.matcher, resolution: '4k' };
        value.model_selection!.image.billing_sku.matcher = changed;
        value.model_selection!.image.billing_sku.matcher_hash = canonicalSha256(changed);
      },
    ],
    [
      'selected specification drift',
      (value: CompilerContext) => {
        value.generation_preferences!.resolution_tier = '4k';
      },
    ],
    [
      'selected model circuit open',
      (value: CompilerContext) => {
        value.models[0]!.circuit_allows_submit = false;
      },
    ],
  ])('fails closed on %s', (_label, mutate) => {
    const value = structuredClone(context());
    mutate(value);
    expect(compilePlan({ candidate: candidate(), context: value, registry })).toMatchObject({
      status: 'rejected',
      code: 'model_not_approved',
    });
  });
});

describe('private transcript payloads at the media compiler boundary', () => {
  const planningContract = { kind: 'planning', contentSchema: candidatePlanSchema } as const;
  const authoringContract = { kind: 'authoring', contentSchema: authoredPromptsSchema } as const;

  function roundtrip<T>(content: unknown, contract: AgentTranscriptPayloadContract<T>): T {
    const scope = {
      user_id: ids.user,
      session_id: ids.session,
      turn_id: ids.turn,
      import_attempt_id: null,
    };
    const prepared = prepareAgentTranscriptPayload(
      {
        ...scope,
        id: contract.kind === 'authoring' ? ids.authoringPayload : ids.planningPayload,
        schema_version: 1,
        kind: contract.kind,
        content_json: content,
      },
      contract,
    );
    const name = contract.kind === 'authoring' ? 'agent_authoring@1' : 'agent_candidate_plan@1';
    const unavailable = { schema: z.never() };
    const itemContracts: AgentTranscriptItemContracts = {
      userMessage: unavailable,
      legacyMessage: unavailable,
      resourceDependencySchema: z.never(),
      hostContexts: [],
      calls: [
        {
          name,
          mode: 'terminal',
          arguments: { schema: contract.contentSchema, privatePayloadKind: contract.kind },
          results: {
            succeeded: { schema: z.strictObject({ captured: z.literal(true) }) },
            rejected: unavailable,
            not_executed: unavailable,
            unknown: unavailable,
          },
        },
      ],
    };
    const metadata = {
      user_id: ids.user,
      session_id: ids.session,
      turn_id: ids.turn,
      continuation_no: 1,
      schema_version: 1,
      source_message_id: null,
      source_trace_step_id: null,
      import_attempt_id: null,
      resource_dependencies_json: [],
      created_at: '2026-09-08T00:00:00Z',
    };
    const assistant = prepareAgentTranscriptItem(
      {
        ...metadata,
        id: ids.planningPayload,
        sequence_no: '1',
        item_type: 'assistant_output',
        source_key: 'fixture:assistant',
        reply_to_item_id: null,
        call_ordinal: null,
        payload_json: {
          schema_version: 1,
          type: 'assistant_output',
          mode: 'terminal',
          calls: [
            {
              name,
              arguments: prepared.reference,
              arguments_digest: prepared.record.content_digest,
              provider_call_id: null,
            },
          ],
        },
      },
      itemContracts,
    ).item;
    const result = prepareAgentTranscriptItem(
      {
        ...metadata,
        id: ids.authoringPayload,
        sequence_no: '2',
        item_type: 'tool_result',
        source_key: 'fixture:result',
        reply_to_item_id: assistant.id,
        call_ordinal: 0,
        payload_json: {
          schema_version: 1,
          type: 'tool_result',
          name,
          arguments_digest: prepared.record.content_digest,
          status: 'succeeded',
          result: { type: 'inline', value: { captured: true } },
        },
      },
      itemContracts,
    ).item;
    const record: unknown = JSON.parse(canonicalJson(assistant));
    const checked = verifyAgentTranscriptItem(
      { scope: { user_id: ids.user, session_id: ids.session }, record },
      itemContracts,
    );
    const protocol = validateAgentTranscriptProtocol(
      {
        scope: { user_id: ids.user, session_id: ids.session },
        first_sequence_no: '1',
        require_closed: true,
        items: [record, JSON.parse(canonicalJson(result)) as unknown],
      },
      itemContracts,
    );
    // A captured fixture result is not compiler admission, execution evidence or a billing receipt.
    expect(protocol.protocol_closed).toBe(true);
    expect(protocol.unresolved_payload_references).toEqual([
      { item_id: assistant.id, reference: prepared.reference },
    ]);
    return verifyAgentTranscriptPayload(
      {
        scope,
        record: JSON.parse(canonicalJson(prepared.record)) as unknown,
        reference: checked.unresolved_payload_references[0],
      },
      contract,
    );
  }

  it('preserves planning and authoring through full compilation, including snapshots and cost', () => {
    const plan = candidate();
    const prompt = 'First line\r\n\u5c71\u6c34 \ud83c\udf04 "light" \\ shadow.  Keep spacing.';
    const authored = {
      prompts: [{ candidate_key: 'generate-main', creative_prompt: prompt }],
    };
    const readPlan = roundtrip(plan, planningContract);
    const readAuthored = roundtrip(authored, authoringContract);
    expect(readPlan).toEqual(plan);
    expect(readAuthored).toEqual(authored);
    const original = compilePlan({
      candidate: mergeAuthoredPrompts(plan, authored),
      context: context(),
      registry,
    });
    const restored = compilePlan({
      candidate: mergeAuthoredPrompts(readPlan, readAuthored),
      context: context(),
      registry,
    });
    expect(original.status).toBe('compiled');
    expect(restored).toEqual(original);
    if (restored.status !== 'compiled') return;
    expect(restored.canonical_plan.tasks[0]?.params_snapshot.creative_prompt).toBe(prompt);
    expect(restored.quote_draft.estimated_total_credits).toBe('6.00');
  });

  it.each([
    ['model selection', { model_id: 'candidate-owned-model' }],
    ['price', { credits_per_unit: '0.00' }],
    ['resolution', { resolution_tier: '4k' }],
    ['prompt limit', { creative_prompt: 'x'.repeat(32_001) }],
  ])('does not treat stored candidate %s as execution authority', (_, params) => {
    const plan = candidate({ ...candidate().nodes[0]!.params, ...params });
    const read = roundtrip(plan, planningContract);
    expect(read).toEqual(plan);
    const original = compilePlan({ candidate: plan, context: context(), registry });
    expect(original).toMatchObject({ status: 'rejected', code: 'candidate_schema_invalid' });
    expect(compilePlan({ candidate: read, context: context(), registry })).toEqual(original);
  });

  it.each([
    ['dependency', { depends_on: ['missing-node'] }, 'dag_invalid'],
    ['reference', { input_bindings: ['missing-binding'] }, 'reference_unavailable'],
  ])('retains compiler rejection of an unavailable %s', (_, change, code) => {
    const plan = candidate();
    Object.assign(plan.nodes[0]!, change);
    const read = roundtrip(plan, planningContract);
    expect(compilePlan({ candidate: read, context: context(), registry })).toMatchObject({
      status: 'rejected',
      code,
    });
  });

  it.each([
    [
      'model availability',
      (value: CompilerContext) => {
        value.models[0]!.circuit_allows_submit = false;
      },
      'model_not_approved',
    ],
    [
      'execution evidence',
      (value: CompilerContext) => {
        value.execution_authorization_digest = 'b'.repeat(64);
      },
      'policy_version_drift',
    ],
    [
      'selected Skill',
      (value: CompilerContext) => {
        value.skill.primary_skill_id = 'creative-portrait-renewal@1.0.1';
      },
      'skill_version_drift',
    ],
  ])('rechecks current %s even when the saved plan compiled previously', (_, mutate, code) => {
    const read = roundtrip(candidate(), planningContract);
    expect(compilePlan({ candidate: read, context: context(), registry }).status).toBe('compiled');
    const current = context();
    mutate(current);
    expect(compilePlan({ candidate: read, context: current, registry })).toMatchObject({
      status: 'rejected',
      code,
    });
  });

  it('uses the real candidate schema to reject duplicate nodes before preparing a payload', () => {
    const plan = candidate();
    plan.nodes.push(structuredClone(plan.nodes[0]!));
    expect(() => roundtrip(plan, planningContract)).toThrow(
      expect.objectContaining({
        name: 'AgentTranscriptPayloadError',
        reason: 'content_invalid',
      }),
    );
  });

  it('does not silently normalize the real source-decision schema at capture time', () => {
    const plan = candidate();
    plan.source_decision = {
      mode: 'refine_latest',
      output_binding_key: 'latest',
      reason_summary: '  Keep the last composition.  ',
    };
    expect(() => roundtrip(plan, planningContract)).toThrow(
      expect.objectContaining({
        name: 'AgentTranscriptPayloadError',
        reason: 'content_changed',
      }),
    );
    const normalized = candidatePlanSchema.parse(plan);
    expect(roundtrip(normalized, planningContract)).toEqual(normalized);
  });

  it.each([1, 32])(
    'checks full admission and lossless storage for %i high-limit nodes',
    (count) => {
      // Schema capacity is not execution authority or proof of live Brain budget reachability.
      const current = structuredClone(context());
      const model = current.models[0]!;
      if (model.capability_contract.schema_version !== 2) throw new Error('Expected media v2');
      const spec = model.capability_contract.specs[0];
      if (spec?.kind !== 'image') throw new Error('Expected an image spec');
      spec.max_prompt_characters = 128_000;
      model.capability_contract_digest = canonicalSha256(model.capability_contract);
      current.model_selection!.image.max_prompt_characters = 128_000;
      const plan = candidate({
        goal_summary: 'Preserve the composition.',
        output_count: 1,
        output_count_source: 'user_explicit',
      });
      plan.nodes = Array.from({ length: count }, (_, index) => ({
        ...structuredClone(plan.nodes[0]!),
        candidate_key: `image-${index}`,
      }));
      const authored = {
        prompts: plan.nodes.map((node) => ({
          candidate_key: node.candidate_key,
          creative_prompt: '\u5c71'.repeat(imageCreativePromptMaxCharacters(128_000)),
        })),
      };
      const merged = mergeAuthoredPrompts(plan, authored);
      const compiled = compilePlan({ candidate: merged, context: current, registry });
      if (count === 1) {
        expect(compiled.status).toBe('compiled');
        expect(roundtrip(authored, authoringContract)).toEqual(authored);
        const read = roundtrip(merged, planningContract);
        expect(read).toEqual(merged);
        expect(compilePlan({ candidate: read, context: current, registry })).toEqual(compiled);
        return;
      }
      expect(candidatePlanSchema.safeParse(merged).success).toBe(true);
      expect(authoredPromptsSchema.safeParse(authored).success).toBe(true);
      expect(compiled).toMatchObject({
        status: 'rejected',
        code: 'candidate_schema_invalid',
        details: [{ rule_id: 'creative_profile_single_image_node_required' }],
      });
      expect(Buffer.byteLength(canonicalJson(authored), 'utf8')).toBeGreaterThan(8_388_608);
      expect(Buffer.byteLength(canonicalJson(merged), 'utf8')).toBeGreaterThan(8_388_608);
      expect(() => roundtrip(authored, authoringContract)).toThrow(
        expect.objectContaining({
          name: 'AgentTranscriptPayloadError',
          reason: 'content_too_large',
        }),
      );
      expect(() => roundtrip(merged, planningContract)).toThrow(
        expect.objectContaining({
          name: 'AgentTranscriptPayloadError',
          reason: 'content_too_large',
        }),
      );
      expect(
        authored.prompts.every(
          (item) => item.creative_prompt.length === imageCreativePromptMaxCharacters(128_000),
        ),
      ).toBe(true);
    },
  );
});
