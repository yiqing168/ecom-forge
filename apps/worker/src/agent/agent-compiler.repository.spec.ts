import { canonicalSha256 } from '@ecom-forge/shared';
import type { CompiledPlan, CompilerRejection } from '@ecom-forge/compiler';
import { describe, expect, it } from 'vitest';

import {
  compiledModelSnapshotMatches,
  compilerPublicSummary,
} from './agent-compiler.repository.js';

const MODEL_ID = '11111111-1111-4111-8111-111111111111';
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const DIGEST = 'a'.repeat(64);

describe('compiler rejection message', () => {
  it('identifies the selected image model when the Brain completed successfully', () => {
    const rejection: CompilerRejection = {
      status: 'rejected',
      code: 'model_not_approved',
      category: 'unavailable',
      retryable: true,
      safe_action: 'retry_later',
      details: [{ rule_id: 'selected_model_circuit_open', candidate_key: 'scene-1' }],
    };
    expect(compilerPublicSummary(rejection)).toBe(
      '所选生图模型暂时不可用，请稍后重试或选择其他生图模型',
    );
  });
});
const quota = {
  schema_version: 1 as const,
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
};
const capability = {
  schema_version: 2 as const,
  contract_kind: 'media' as const,
  media_kind: 'image' as const,
  capabilities: ['image.edit' as const],
  specs: [
    {
      kind: 'image' as const,
      spec_key: 'quality.1k.edit',
      operation: 'image.edit' as const,
      mode: 'quality',
      resolution_tier: '1k' as const,
      aspect_ratios: ['1:1'],
      max_outputs: 1,
      max_reference_images: 4,
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
      rate_key: 'quality.1k.image',
      spec_key: 'quality.1k.edit',
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

function mediaPair() {
  const row = {
    id: MODEL_ID,
    providerChannelId: CHANNEL_ID,
    provider: 's12-live',
    modelId: 'image-edit-model',
    version: '1',
    status: 'poc_passed' as const,
    statusEvidenceDigest: DIGEST,
    capabilityContractJson: capability,
    pricingJson: pricing,
    quotaJson: quota,
  };
  const expected = {
    id: MODEL_ID,
    provider_channel_id: CHANNEL_ID,
    provider: row.provider,
    model_id: row.modelId,
    version: row.version,
    status: row.status,
    status_evidence_digest: DIGEST,
    capability_contract: capability,
    capability_contract_digest: canonicalSha256(capability),
    pricing,
    pricing_digest: canonicalSha256(pricing),
    quota,
    quota_digest: canonicalSha256(quota),
  } as CompiledPlan['canonical_plan']['tasks'][number]['model_snapshot'];
  return { row, expected };
}

describe('compiledModelSnapshotMatches', () => {
  it('accepts an unchanged Media V2 image model snapshot', () => {
    const { row, expected } = mediaPair();
    expect(compiledModelSnapshotMatches(row, expected)).toBe(true);
  });

  it('rejects Media V2 runtime channel drift', () => {
    const { row, expected } = mediaPair();
    expect(
      compiledModelSnapshotMatches(
        { ...row, providerChannelId: '33333333-3333-4333-8333-333333333333' },
        expected,
      ),
    ).toBe(false);
  });

  it('rejects a mixed Media V2 capability and legacy pricing snapshot', () => {
    const { row, expected } = mediaPair();
    expect(
      compiledModelSnapshotMatches(
        {
          ...row,
          pricingJson: {
            schema_version: 1,
            currency: 'CNY',
            provider_unit_cost_cny: '0.50',
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
        },
        expected,
      ),
    ).toBe(false);
  });
});
