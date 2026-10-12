import { z } from 'zod';
import type { CreativeDirectionSelection } from '@ecom-forge/shared';
import type { SkillExecutionPolicy } from '@ecom-forge/shared';

import { agentAuthoringOutputSchema, authoredPromptsMatchPlan } from './prompt-authoring.js';
import { publicTextPolicyRuleSchema } from './public-text-policy.js';
import type { AgentTranscriptCompactionItem } from './transcript-summary.js';
import { agentProviderMetadataSchema } from './provider-metadata.js';

const toolCallSchema = z.strictObject({
  call_id: z.string().min(1).max(128),
  name: z.string().regex(/^[a-z][a-z0-9_.-]*@[1-9]\d*$/),
  arguments: z.record(z.string(), z.unknown()),
  provider_metadata: agentProviderMetadataSchema.optional(),
});

const tokenUsageSchema = z.strictObject({
  input_tokens: z.int().nonnegative(),
  cached_input_tokens: z.int().nonnegative().optional(),
  output_tokens: z.int().nonnegative(),
  reasoning_output_tokens: z.int().nonnegative().optional(),
});

export const agentOutputDiagnosticSchema = z.strictObject({
  category: z.enum(['output_truncated', 'tool_json_parse', 'tool_schema', 'tool_protocol']),
  finish_reason: z.enum([
    'stop',
    'length',
    'content-filter',
    'tool-calls',
    'error',
    'other',
    'unknown',
  ]),
  requested_max_output_tokens: z.int().positive(),
});

const transcriptItemIdSchema = z.uuid().toLowerCase();
const transcriptWireCallIdSchema = z.string().regex(/^call_[a-f0-9]{32}_[0-3]$/);
const transcriptCallNameSchema = z.string().regex(/^[a-z][a-z0-9_.-]*@[1-9]\d*$/);
const transcriptResultStatusSchema = z.enum(['succeeded', 'rejected', 'not_executed', 'unknown']);

/**
 * The provider-neutral semantic history used by transcript_v1 turns.  It is
 * deliberately independent from the AI SDK's ModelMessage shape so the
 * worker can validate ownership and the provider can map roles without
 * serializing tool calls into ordinary text.
 */
export const agentBrainTranscriptMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('user_message'),
    item_id: transcriptItemIdSchema,
    current: z.boolean(),
    content: z.string(),
    attachments: z.array(z.record(z.string(), z.unknown())).max(9),
  }),
  z.strictObject({
    type: z.literal('assistant_output'),
    item_id: transcriptItemIdSchema,
    commentary: z.string().trim().min(1).max(2_000).optional(),
    calls: z
      .array(
        z.strictObject({
          call_id: transcriptWireCallIdSchema,
          name: transcriptCallNameSchema,
          arguments: z.record(z.string(), z.unknown()),
          provider_metadata: agentProviderMetadataSchema.optional(),
        }),
      )
      .min(1)
      .max(4),
  }),
  z.strictObject({
    type: z.literal('assistant_text'),
    item_id: transcriptItemIdSchema,
    text: z.string().min(1).max(8_000),
  }),
  z.strictObject({
    type: z.literal('tool_result'),
    item_id: transcriptItemIdSchema,
    call_id: transcriptWireCallIdSchema,
    name: transcriptCallNameSchema,
    status: transcriptResultStatusSchema,
    result: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('host_context'),
    item_id: transcriptItemIdSchema,
    name: transcriptCallNameSchema,
    content: z.unknown(),
  }),
]);

export type AgentBrainTranscriptMessage = z.infer<typeof agentBrainTranscriptMessageSchema>;

export const agentSessionSummaryContentSchema = z.strictObject({
  goals: z.array(z.string().trim().min(1).max(500)).max(8),
  confirmed_preferences: z.array(z.string().trim().min(1).max(240)).max(24),
  constraints: z.array(z.string().trim().min(1).max(240)).max(24),
  key_decisions: z.array(z.string().trim().min(1).max(300)).max(24),
  open_questions: z.array(z.string().trim().min(1).max(300)).max(16),
});

export type AgentSessionSummaryContent = z.infer<typeof agentSessionSummaryContentSchema>;

export interface AgentSessionCompactionInput {
  previous_summary?: AgentSessionSummaryContent;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * transcript_v1 safe semantic projection of an already-closed native history window. When
   * present the caller derived the window from the transcript, so `host_context`/`tool_result`
   * stay typed instead of being flattened into ordinary user/assistant text (`02` §11.0). Legacy
   * callers keep using `messages` unchanged.
   */
  transcript_items?: AgentTranscriptCompactionItem[];
}

export interface AgentSessionCompactionOutcome {
  summary: AgentSessionSummaryContent;
  usage: z.infer<typeof tokenUsageSchema>;
}

const productFactListSchema = z.array(z.string().trim().min(1).max(120)).max(24).default([]);

export type AgentGenerationCapability = 'image.generate' | 'image.edit';

export const agentProductFactsCandidateSchema = z.strictObject({
  product_name: z.string().trim().min(1).max(120),
  primary_colors: productFactListSchema,
  logos: productFactListSchema,
  visible_text: productFactListSchema,
  materials: productFactListSchema,
  must_preserve: productFactListSchema,
  unknown_fields: productFactListSchema,
});

export const agentRespondArgumentsSchema = z.strictObject({
  text: z.string().min(1).max(8_000),
});
export const agentClarificationArgumentsSchema = z.strictObject({
  question: z.string().min(1).max(500),
  suggestions: z.array(z.string().min(1).max(80)).max(6).optional(),
});
export const agentProductFactsArgumentsSchema = z.strictObject({
  source_binding_key: z.string().min(1).max(128),
  candidate_facts: agentProductFactsCandidateSchema,
  evidence: z
    .array(
      z.strictObject({
        field: z.enum([
          'product_name',
          'primary_colors',
          'logos',
          'visible_text',
          'materials',
          'must_preserve',
        ]),
        observation: z.string().trim().min(1).max(240),
      }),
    )
    .max(24),
});

export const agentBrainStepOutcomeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('tool_calls'),
    calls: z.array(toolCallSchema).min(1).max(4),
    commentary: z.string().trim().min(1).max(2_000).optional(),
    usage: tokenUsageSchema,
  }),
  agentRespondArgumentsSchema.extend({
    type: z.literal('respond'),
    provider_metadata: agentProviderMetadataSchema.optional(),
    usage: tokenUsageSchema,
  }),
  agentRespondArgumentsSchema.extend({
    type: z.literal('chat_text'),
    usage: tokenUsageSchema,
  }),
  agentClarificationArgumentsSchema.extend({
    type: z.literal('request_clarification'),
    provider_metadata: agentProviderMetadataSchema.optional(),
    usage: tokenUsageSchema,
  }),
  z
    .strictObject({
      type: z.literal('candidate_plan'),
      plan: z.record(z.string(), z.unknown()),
      provider_metadata: agentProviderMetadataSchema.optional(),
      authoring_output: agentAuthoringOutputSchema.optional(),
      usage: tokenUsageSchema,
    })
    .refine(
      ({ plan, authoring_output }) =>
        !authoring_output || authoredPromptsMatchPlan(plan, authoring_output.arguments),
      { message: 'Authoring output must match the accepted plan' },
    ),
  z.strictObject({
    type: z.literal('authoring_request'),
    plan: z.record(z.string(), z.unknown()),
    provider_metadata: agentProviderMetadataSchema.optional(),
    usage: tokenUsageSchema,
  }),
  z.strictObject({
    type: z.literal('authoring_batch'),
    authoring_output: agentAuthoringOutputSchema,
    usage: tokenUsageSchema,
  }),
  z.strictObject({
    type: z.literal('public_text_rejected'),
    error_code: z.literal('AGENT_PUBLIC_TEXT_REJECTED'),
    rule: publicTextPolicyRuleSchema,
    usage: tokenUsageSchema,
  }),
  z.strictObject({
    type: z.literal('invalid_tool_input'),
    error_code: z.literal('AGENT_BRAIN_TOOL_INPUT_INVALID'),
    tool: z.string().min(1).max(128),
    paths: z.array(z.string().min(1).max(240)).max(8),
    /**
     * Bounded field/schema guidance, never rejected values or raw arguments. Fed back to
     * the model so a repair round can converge instead of guessing from the path alone.
     */
    detail: z.string().min(1).max(900).optional(),
    output_diagnostic: agentOutputDiagnosticSchema.optional(),
    usage: tokenUsageSchema,
  }),
  z.strictObject({
    type: z.literal('invalid_terminal_output'),
    error_code: z.literal('AGENT_BRAIN_TERMINAL_OUTPUT_INVALID'),
    reason: z.enum([
      'free_text_without_tool_call',
      'empty_without_tool_call',
      'mixed_text_and_tool_calls',
    ]),
    paths: z.array(z.string().min(1).max(240)).max(8),
    output_diagnostic: agentOutputDiagnosticSchema.optional(),
    usage: tokenUsageSchema,
  }),
  agentProductFactsArgumentsSchema.extend({
    type: z.literal('request_product_facts'),
    provider_metadata: agentProviderMetadataSchema.optional(),
    usage: tokenUsageSchema,
  }),
]);

export type AgentBrainStepOutcome = z.infer<typeof agentBrainStepOutcomeSchema>;

export const agentBrainProtocolFamilySchema = z.enum(['openai', 'anthropic', 'google']);
export type AgentBrainProtocolFamily = z.infer<typeof agentBrainProtocolFamilySchema>;

export const agentBrainApiVariantSchema = z.enum([
  'openai_chat_completions',
  'openai_responses',
  'anthropic_messages',
  'google_generate_content',
]);
export type AgentBrainApiVariant = z.infer<typeof agentBrainApiVariantSchema>;

export const agentBrainModelDefinitionSchema = z.strictObject({
  snapshot_id: z.uuid().optional(),
  adapter: z.enum(['fake', 'approved']),
  provider: z.string().min(1).max(64),
  protocol_family: agentBrainProtocolFamilySchema.optional(),
  api_variant: agentBrainApiVariantSchema.optional(),
  model_id: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  status: z.enum(['poc_passed', 'free_test_only']),
  status_evidence_digest: z.string().regex(/^[a-f0-9]{64}$/),
  capability_contract: z.strictObject({
    schema_version: z.literal(1),
    contract_kind: z.literal('agent_brain'),
    capabilities: z.tuple([z.literal('agent.brain')]),
    input_modalities: z
      .array(z.enum(['text', 'image']))
      .min(1)
      .max(2),
    tool_protocol: z.literal('native_function_calling'),
    terminal_protocol: z.enum(['strict_json_schema', 'terminal_tools']),
    supports_usage_tokens: z.literal(true),
    max_context_tokens: z.int().positive(),
    max_output_tokens: z.int().positive(),
    max_tool_calls_per_response: z.int().positive().max(4),
  }),
  pricing: z.strictObject({
    schema_version: z.literal(1),
    contract_kind: z.literal('agent_brain_tokens'),
    currency: z.literal('CNY'),
    request_base_cost_cny: decimalStringSchema(),
    input_per_million_tokens_cny: decimalStringSchema(),
    cached_input_per_million_tokens_cny: decimalStringSchema(),
    output_per_million_tokens_cny: decimalStringSchema(),
  }),
  quota: z.strictObject({
    schema_version: z.literal(1),
    contract_kind: z.literal('agent_brain'),
    rpm: z.int().positive(),
    concurrency: z.int().positive(),
    hourly_budget_cny: positiveDecimalStringSchema(),
    daily_budget_cny: positiveDecimalStringSchema(),
    max_turn_llm_rounds: z.int().positive().max(6),
    // Keep frozen snapshots readable; the host applies its current context ceiling per call.
    max_turn_input_tokens: z.int().positive(),
    max_turn_output_tokens: z.int().positive().max(8_192),
    max_turn_estimated_cost_cny: positiveDecimalStringSchema(),
    terminal_timeout_ms: z.int().positive(),
    circuit_sample_size: z.int().positive(),
    circuit_failure_rate: rateStringSchema(),
    circuit_unknown_rate: rateStringSchema(),
    circuit_open_ms: z.int().positive(),
  }),
});

const agentBrainRuntimeBindingSchema = z.strictObject({
  provider_channel_id: z.uuid(),
  provider_channel_revision: z.int().positive(),
  adapter_key: z.string().min(1).max(128),
  endpoint_profile_key: z.string().min(1).max(128),
  region: z.string().min(1).max(64).nullable(),
  credential_version_id: z.uuid(),
});

export const agentBrainModelSnapshotSchema = agentBrainModelDefinitionSchema
  .extend({ runtime: agentBrainRuntimeBindingSchema.optional() })
  .superRefine((value, context) => {
    if (value.adapter === 'approved' && !value.runtime) {
      context.addIssue({
        code: 'custom',
        path: ['runtime'],
        message: 'Approved Brain snapshots require an immutable runtime binding',
      });
    }
    if (value.adapter === 'fake' && value.runtime) {
      context.addIssue({
        code: 'custom',
        path: ['runtime'],
        message: 'Fake Brain snapshots cannot carry a runtime binding',
      });
    }
    if (value.adapter === 'approved') {
      if (!value.protocol_family || !value.api_variant) {
        context.addIssue({
          code: 'custom',
          path: ['protocol_family'],
          message: 'Approved Brain snapshots require a protocol family and API variant',
        });
      } else if (
        (value.protocol_family === 'openai' &&
          !['openai_chat_completions', 'openai_responses'].includes(value.api_variant)) ||
        (value.protocol_family === 'anthropic' && value.api_variant !== 'anthropic_messages') ||
        (value.protocol_family === 'google' && value.api_variant !== 'google_generate_content')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['api_variant'],
          message: 'API variant does not match protocol family',
        });
      }
    }
  });

export type AgentBrainModelSnapshot = z.infer<typeof agentBrainModelSnapshotSchema>;

export const DETERMINISTIC_FAKE_AGENT_MODEL_ID = 'deterministic-fake@1' as const;

export function deterministicFakeAgentModelSnapshot(input: {
  maxInputTokens: number;
  maxOutputTokens: number;
  supportsImageInput?: boolean;
}): AgentBrainModelSnapshot {
  return agentBrainModelSnapshotSchema.parse({
    adapter: 'fake',
    provider: 'deterministic-fake',
    model_id: 'deterministic-fake',
    version: '1',
    status: 'free_test_only',
    status_evidence_digest: '0'.repeat(64),
    capability_contract: {
      schema_version: 1,
      contract_kind: 'agent_brain',
      capabilities: ['agent.brain'],
      input_modalities: input.supportsImageInput ? ['text', 'image'] : ['text'],
      tool_protocol: 'native_function_calling',
      terminal_protocol: 'strict_json_schema',
      supports_usage_tokens: true,
      max_context_tokens: input.maxInputTokens,
      max_output_tokens: input.maxOutputTokens,
      max_tool_calls_per_response: 4,
    },
    pricing: {
      schema_version: 1,
      contract_kind: 'agent_brain_tokens',
      currency: 'CNY',
      request_base_cost_cny: '0.01',
      input_per_million_tokens_cny: '2.00',
      cached_input_per_million_tokens_cny: '1.00',
      output_per_million_tokens_cny: '8.00',
    },
    quota: {
      schema_version: 1,
      contract_kind: 'agent_brain',
      rpm: 10_000,
      concurrency: 100,
      hourly_budget_cny: '10.00',
      daily_budget_cny: '100.00',
      max_turn_llm_rounds: 6,
      max_turn_input_tokens: input.maxInputTokens,
      max_turn_output_tokens: input.maxOutputTokens,
      max_turn_estimated_cost_cny: '0.15',
      terminal_timeout_ms: 45_000,
      circuit_sample_size: 20,
      circuit_failure_rate: '0.50',
      circuit_unknown_rate: '0.25',
      circuit_open_ms: 60_000,
    },
  });
}

function decimalStringSchema() {
  return z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
}

function positiveDecimalStringSchema() {
  return decimalStringSchema().refine((value) => /[1-9]/.test(value));
}

function rateStringSchema() {
  return z.string().regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/);
}

export interface AgentBrainStepInput {
  /** Frozen host-validated creative lens; never an authorization or client-supplied prompt. */
  creative_direction?: CreativeDirectionSelection;
  /** Host-managed staged authoring; never supplied by user or Skill text. */
  prompt_authoring?: boolean;
  /** Owned operational draft for a separately budgeted prompt-authoring round. */
  authoring_plan?: Record<string, unknown>;
  /** Host-selected unfinished nodes for this real authoring call. */
  authoring_candidate_keys?: string[];
  current_message: string;
  /** Native transcript execution is the only supported Brain request format. */
  execution_format: 'transcript_v1';
  transcript_generation?: string;
  transcript_messages?: AgentBrainTranscriptMessage[];
  session_summary?: AgentSessionSummaryContent;
  generation_preferences?: {
    aspect_ratio: string;
    resolution_tier: '1k' | '2k' | '4k';
    supported_aspect_ratios: string[];
    /** Brain creative-prompt budget after reserving the deterministic Provider envelope. */
    max_prompt_characters?: number;
  };
  authorized_images: Array<{
    binding_key: string;
    /** Opaque server-issued reference. Never a filesystem path or signed URL. */
    image_ref?: string;
    role:
      | 'product'
      | 'style_reference'
      | 'composition_reference'
      | 'identity_anchor'
      | 'semantic_reference'
      | 'edit_source'
      | 'other';
    /** Missing for legacy rows; the runtime resolves and validates the real type on inspection. */
    media_type?: 'image/jpeg' | 'image/png' | 'image/webp';
    /** Test/legacy adapter compatibility only. Production turns use image_ref + resolver. */
    bytes?: Uint8Array;
    /** Missing dimensions are allowed only until inspect_image materializes the source. */
    width?: number;
    height?: number;
    content_hash: string;
    context_scope?: 'current_attachment' | 'session_candidate';
    candidate_kind?: 'latest_output' | 'original_source';
    candidate_position?: number;
    lineage_source_binding_keys?: string[];
    source_group?: {
      message_id: string;
      created_at: string;
      is_latest_upload: boolean;
    };
  }>;
  /** Automatic history exceeded its bounded pool; current attachments still work normally. */
  session_image_candidates_unavailable?: boolean;
  /** Only these authorized references have been materialized for this Brain step. */
  materialized_image_binding_keys?: string[];
  /** Detail requested when each materialized image was last inspected. */
  materialized_image_details?: Record<string, AgentBrainImageDetail>;
  confirmed_product_facts?: {
    source_binding_key: string;
    facts: z.infer<typeof agentProductFactsCandidateSchema>;
  };
  skill_selection: {
    execution_policy?: SkillExecutionPolicy;
    primary_skill_id: string;
    primary_name: string;
    default_output_count: number;
    preset_names: string[];
    required_capabilities: AgentGenerationCapability[];
  };
  loaded_skills: Array<{
    skill_id: string;
    name: string;
    content: string;
    resource_path?: string;
  }>;
  required_auxiliary_catalog: Array<{ skill_id: string; name: string }>;
  optional_auxiliary_catalog: Array<{ skill_id: string; name: string }>;
  observations: Array<{
    tool_name: string;
    status: 'succeeded' | 'failed';
    summary: Record<string, unknown>;
  }>;
  enabled_tools: Array<{
    name: string;
    contract_version: number;
    description: string;
  }>;
  remaining_budget: {
    rounds: number;
    tool_calls: number;
    input_tokens: number;
    output_tokens: number;
    /** Actual per-call output allowance, separate from the whole task remainder. */
    step_output_tokens?: number;
  };
}

export interface AgentBrainImagePayload {
  media_type: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: Uint8Array;
  width: number;
  height: number;
}

export type AgentBrainImageDetail = 'overview' | 'detail';

export type AgentBrainImageResolver = (
  image: AgentBrainStepInput['authorized_images'][number],
  detail: AgentBrainImageDetail,
) => Promise<AgentBrainImagePayload>;

export interface AgentBrainPort {
  countInputTokens(
    input: AgentBrainStepInput,
    modelSnapshot: AgentBrainModelSnapshot,
  ): number | Promise<number>;
  runStep(
    input: AgentBrainStepInput,
    context: AgentBrainCallContext,
  ): Promise<AgentBrainStepOutcome>;
  summarizeSession?(
    input: AgentSessionCompactionInput,
    context: AgentBrainCallContext,
  ): Promise<AgentSessionCompactionOutcome>;
}

export interface AgentBrainCallContext {
  abortSignal: AbortSignal;
  deadline: Date;
  idempotencyKey: string;
  modelSnapshot: AgentBrainModelSnapshot;
  requestedMaxOutputTokens: number;
  traceId: string;
  /** Provisional public text from an explicit respond tool or native chat text. */
  onPublicTextDraft?: (text: string) => Promise<void>;
  /** Resolves an authorized opaque image reference only for the current outbound request. */
  resolveAuthorizedImage?: AgentBrainImageResolver;
  /** Maximum number of image payloads that may be materialized concurrently for one request. */
  maxConcurrentImageMaterializations?: number;
}

export interface AgentBrainDiagnostic {
  code: string;
  tool?: string;
  paths?: string[];
  statusCode?: number;
  failureSource?: 'request' | 'stream' | 'response';
  /** Adapter-whitelisted categories only; unknown upstream values must be omitted. */
  providerErrorType?: string;
  providerErrorCode?: string;
  networkErrorCode?: string;
  /** Bounded safe classification and repair guidance; never raw provider messages or bodies. */
  detail?: string;
}

export class AgentBrainCallError extends Error {
  constructor(
    message: string,
    readonly delivery: 'not_dispatched' | 'outcome_unknown',
    readonly diagnostic?: AgentBrainDiagnostic,
  ) {
    super(message);
    this.name = 'AgentBrainCallError';
  }
}

export function parseAgentBrainStepOutcome(input: unknown): AgentBrainStepOutcome {
  const result = agentBrainStepOutcomeSchema.safeParse(input);
  if (!result.success) throw new Error('AGENT_BRAIN_OUTPUT_INVALID');
  if (result.data.type === 'tool_calls') {
    const ids = result.data.calls.map((call) => call.call_id);
    if (new Set(ids).size !== ids.length) throw new Error('AGENT_BRAIN_CALL_ID_DUPLICATE');
  }
  return result.data;
}
