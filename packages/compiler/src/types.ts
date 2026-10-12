import type { ProviderCapability } from '@ecom-forge/provider';
import type { z } from 'zod';

import type { CreativeExecutionProfile } from './creative-profiles.js';
import type {
  candidatePlanSchema,
  agentModelSelectionSnapshotSchema,
  attachmentSnapshotSchema,
  compilerContextSchema,
  executionAuthorizationSchema,
} from './schemas.js';

export type CandidatePlan = z.infer<typeof candidatePlanSchema>;
export type AgentModelSelectionSnapshot = z.infer<typeof agentModelSelectionSnapshotSchema>;
export type CompilerContext = z.infer<typeof compilerContextSchema>;
export type ExecutionAuthorization = z.infer<typeof executionAuthorizationSchema>;
export type BindingSnapshot = CompilerContext['bindings'][number];
export type AttachmentSnapshot = z.infer<typeof attachmentSnapshotSchema>;
export type CandidateNode = CandidatePlan['nodes'][number];
export type CompilerModel = CompilerContext['models'][number];

export interface CapabilityRequirements {
  outputType: 'image' | 'text';
  outputCount: number;
  referenceImageCount: number;
  aspectRatio?: string;
  resolution?: string;
  operation: 'generate' | 'edit';
  mandatoryConfirmation: boolean;
}

export interface CapabilityAdapter {
  readonly capability: ProviderCapability;
  readonly version: number;
  readonly allowedBindingKinds: readonly BindingSnapshot['kind'][];
  compile(input: {
    params: unknown;
    bindings: readonly BindingSnapshot[];
    expectedOutput: CandidateNode['expected_output'];
    generationPreferences?: CompilerContext['generation_preferences'];
  }):
    | {
        ok: true;
        paramsSnapshot: Record<string, unknown>;
        requirements: CapabilityRequirements;
        quoteLabel: string;
      }
    | { ok: false; ruleId: string };
}

export type CompilerRejectionCode =
  | 'candidate_schema_invalid'
  | 'clarification_required'
  | 'skill_version_drift'
  | 'reference_unavailable'
  | 'mutation_forbidden'
  | 'dag_invalid'
  | 'capability_unavailable'
  | 'model_not_approved'
  | 'cost_unavailable'
  | 'policy_version_drift';

export interface CompilerRejection {
  status: 'rejected';
  code: CompilerRejectionCode;
  category: 'repairable' | 'clarification' | 'unavailable' | 'permission';
  retryable: boolean;
  safe_action:
    | 'repair_plan'
    | 'ask_user'
    | 'refresh_skill'
    | 'remove_reference'
    | 'open_canvas'
    | 'start_new_generation'
    | 'explain_unavailable'
    | 'retry_later';
  details: Array<{
    candidate_key?: string;
    binding_key?: string;
    rule_id: string;
  }>;
}

export interface CompiledTask {
  candidate_key: string;
  task_key: string;
  operation_key: string;
  capability: ProviderCapability;
  capability_version: number;
  depends_on: string[];
  input_bindings: Array<{
    binding_key: string;
    kind: BindingSnapshot['kind'];
    object_id: string;
    object_version: string;
    content_hash: string;
    role: NonNullable<BindingSnapshot['role']>;
    sort_order: number;
    provider_input: boolean;
    publication_revision: number | null;
  }>;
  expected_output: 'image' | 'text';
  params_snapshot: Record<string, unknown>;
  model_snapshot: Omit<CompilerModel, 'circuit_allows_submit' | 'budget_allows_submit'> & {
    status_evidence_digest: string;
  };
  cost: {
    provider_unit_cost_cny: string | null;
    tool_cost_cny: string | null;
    storage_cost_cny: string | null;
    traffic_cost_cny: string | null;
    agent_brain_cost_cny: string | null;
    risk_adjusted_cost_cny: string | null;
    estimated_credits: string;
    pricing_snapshot_digest: string;
    billing_sku_id?: string;
    billing_sku_version?: number;
    billing_matcher_hash?: string;
    billing_unit_kind?: 'image' | 'megapixel';
    billing_unit_rule?: Record<string, unknown>;
    credits_per_unit?: string;
    provider_rate_card_key?: string;
  };
}

export interface CompiledPlan {
  status: 'compiled';
  canonical_plan: {
    schema_version: 1;
    compiler_version: string;
    capability_registry_version: string;
    source: 'chat';
    intent: CandidatePlan['intent'];
    source_decision?: NonNullable<CandidatePlan['source_decision']>;
    scope_decision?: NonNullable<CandidatePlan['scope_decision']>;
    tasks: CompiledTask[];
  };
  plan_digest: string;
  input_signature: string;
  quote_draft: {
    items: Array<{ label: string; quantity: number; estimated_credits: string }>;
    estimated_total_credits: string;
    expires_at: string;
    submission_mode: 'auto_submit' | 'confirmation_required';
  };
  snapshots: {
    skill: CompilerContext['skill'];
    execution_authorization_digest: string;
    prompt: CompilerContext['prompt'];
    policies: CompilerContext['policies'];
    model_selection?: CompilerContext['model_selection'];
    product_facts?: NonNullable<CompilerContext['product_facts']>;
    creative_execution_profile?: CreativeExecutionProfile;
  };
}

export type CompilePlanResult = CompiledPlan | CompilerRejection;
