import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  agentBrainProviderModelSnapshotSchema,
  imageSpecHasPocCoverage,
  mediaV2ModelSnapshotSchema,
} from './model-contracts.js';

function mediaSnapshot() {
  return {
    id: randomUUID(),
    provider_channel_id: randomUUID(),
    provider: 'fixture-provider',
    model_id: 'fixture-image-v2',
    version: '2026-08-14',
    status: 'free_test_only',
    capability_contract: {
      schema_version: 2,
      contract_kind: 'media',
      media_kind: 'image',
      capabilities: ['image.generate'],
      specs: [
        {
          kind: 'image',
          spec_key: 'generate-quality-2k',
          operation: 'image.generate',
          mode: 'quality',
          resolution_tier: '2k',
          aspect_ratios: ['1:1', '3:4'],
          max_outputs: 4,
          max_reference_images: 3,
          transparent_background: false,
          output_formats: ['png', 'webp'],
        },
      ],
    },
    pricing: {
      schema_version: 2,
      contract_kind: 'media_rate_card',
      currency: 'CNY',
      rate_cards: [
        {
          rate_key: 'generate-quality-2k-per-image',
          spec_key: 'generate-quality-2k',
          billing_unit: 'image',
          unit_cost_cny: '0.40',
        },
      ],
      overhead_cny: { tool: '0.00', storage: '0.02', traffic: '0.01', agent_brain: '0.03' },
      failure_rate: '0.05',
      unknown_rate: '0.01',
      refund_rate: '0.02',
      risk_reserve_rate: '0.10',
      gross_margin_target: '0.50',
      credit_cny_anchor: '0.01',
    },
    quota: {
      schema_version: 1,
      rpm: 60,
      concurrency: 4,
      hourly_budget_cny: '10.00',
      daily_budget_cny: '100.00',
      poll_initial_delay_ms: 1_000,
      poll_interval_ms: 1_000,
      max_poll_count: 30,
      terminal_timeout_ms: 60_000,
      circuit_sample_size: 20,
      circuit_failure_rate: '0.50',
      circuit_unknown_rate: '0.20',
      circuit_open_ms: 60_000,
    },
  } as const;
}

describe('S14 Provider model contracts', () => {
  it('accepts 4K specs and rejects the removed 3K tier', () => {
    const snapshot = mediaSnapshot();
    for (const tier of ['1k', '2k', '4k', '3k']) {
      expect(
        mediaV2ModelSnapshotSchema.safeParse({
          ...snapshot,
          capability_contract: {
            ...snapshot.capability_contract,
            specs: [{ ...snapshot.capability_contract.specs[0], resolution_tier: tier }],
          },
        }).success,
      ).toBe(tier !== '3k');
    }
  });

  it('uses only same-operation 1K evidence for high-tier admission', () => {
    const original = mediaSnapshot().capability_contract.specs[0];
    const base = {
      ...original,
      aspect_ratios: [...original.aspect_ratios],
      output_formats: [...original.output_formats],
    };
    const specs = [
      { ...base, spec_key: 'generate-1k', resolution_tier: '1k' as const },
      { ...base, spec_key: 'generate-4k', resolution_tier: '4k' as const },
      {
        ...base,
        spec_key: 'edit-4k',
        operation: 'image.edit' as const,
        resolution_tier: '4k' as const,
      },
    ];
    expect(imageSpecHasPocCoverage(specs, 'generate-4k', ['generate-1k'])).toBe(true);
    expect(imageSpecHasPocCoverage(specs, 'edit-4k', ['generate-1k'])).toBe(false);
    expect(imageSpecHasPocCoverage(specs, 'generate-4k', ['generate-4k'])).toBe(true);
    expect(imageSpecHasPocCoverage(specs, 'unknown', ['generate-1k'])).toBe(false);
    expect(imageSpecHasPocCoverage(specs, 'generate-4k', null)).toBe(false);
    expect(imageSpecHasPocCoverage(specs, 'generate-4k', [123])).toBe(false);
    expect(imageSpecHasPocCoverage(specs, 'generate-4k', [])).toBe(false);
  });
  it('accepts a strict media-v2 snapshot while preserving stable spec/rate keys', () => {
    const snapshot = mediaSnapshot();
    expect(mediaV2ModelSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('rejects missing, duplicate, unknown, and incompatible rate cards', () => {
    const snapshot = mediaSnapshot();
    expect(
      mediaV2ModelSnapshotSchema.safeParse({
        ...snapshot,
        pricing: { ...snapshot.pricing, rate_cards: [] },
      }).success,
    ).toBe(false);
    expect(
      mediaV2ModelSnapshotSchema.safeParse({
        ...snapshot,
        pricing: {
          ...snapshot.pricing,
          rate_cards: [snapshot.pricing.rate_cards[0], snapshot.pricing.rate_cards[0]],
        },
      }).success,
    ).toBe(false);
    expect(
      mediaV2ModelSnapshotSchema.safeParse({
        ...snapshot,
        pricing: {
          ...snapshot.pricing,
          rate_cards: [
            {
              rate_key: 'unknown-per-image',
              spec_key: 'unknown-spec',
              billing_unit: 'image',
              unit_cost_cny: '0.40',
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      mediaV2ModelSnapshotSchema.safeParse({
        ...snapshot,
        pricing: {
          ...snapshot.pricing,
          rate_cards: [
            {
              rate_key: 'generate-quality-2k-per-second',
              spec_key: 'generate-quality-2k',
              billing_unit: 'second',
              unit_cost_cny: '0.40',
              min_units: 1,
              max_units: 2,
              step_units: 1,
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it('rejects mixed media kinds, undeclared operations, and arbitrary Provider fields', () => {
    const snapshot = mediaSnapshot();
    expect(
      mediaV2ModelSnapshotSchema.safeParse({
        ...snapshot,
        capability_contract: {
          ...snapshot.capability_contract,
          media_kind: 'video',
        },
      }).success,
    ).toBe(false);
    expect(
      mediaV2ModelSnapshotSchema.safeParse({
        ...snapshot,
        capability_contract: {
          ...snapshot.capability_contract,
          capabilities: ['image.edit'],
        },
      }).success,
    ).toBe(false);
    expect(
      mediaV2ModelSnapshotSchema.safeParse({ ...snapshot, endpoint: 'https://x' }).success,
    ).toBe(false);
  });

  it('exports the Agent Brain strict runtime snapshot without widening it', () => {
    const result = agentBrainProviderModelSnapshotSchema.safeParse({
      snapshot_id: randomUUID(),
      adapter: 'approved',
      provider: 'fixture-provider',
      model_id: 'fixture-brain',
      version: '1',
      status: 'poc_passed',
      status_evidence_digest: 'a'.repeat(64),
      capability_contract: {
        schema_version: 1,
        contract_kind: 'agent_brain',
        capabilities: ['agent.brain'],
        input_modalities: ['text'],
        tool_protocol: 'native_function_calling',
        terminal_protocol: 'strict_json_schema',
        supports_usage_tokens: true,
        max_context_tokens: 128_000,
        max_output_tokens: 8_192,
        max_tool_calls_per_response: 4,
      },
      pricing: {
        schema_version: 1,
        contract_kind: 'agent_brain_tokens',
        currency: 'CNY',
        request_base_cost_cny: '0.00',
        input_per_million_tokens_cny: '2.00',
        cached_input_per_million_tokens_cny: '1.00',
        output_per_million_tokens_cny: '8.00',
      },
      quota: {
        schema_version: 1,
        contract_kind: 'agent_brain',
        rpm: 60,
        concurrency: 10,
        hourly_budget_cny: '10.00',
        daily_budget_cny: '100.00',
        max_turn_llm_rounds: 6,
        max_turn_input_tokens: 96_000,
        max_turn_output_tokens: 8_192,
        max_turn_estimated_cost_cny: '1.00',
        terminal_timeout_ms: 45_000,
        circuit_sample_size: 20,
        circuit_failure_rate: '0.50',
        circuit_unknown_rate: '0.20',
        circuit_open_ms: 60_000,
      },
    });
    expect(result.success).toBe(true);
    expect(
      agentBrainProviderModelSnapshotSchema.safeParse({
        ...(result.success ? result.data : {}),
        endpoint: 'https://untrusted.example',
      }).success,
    ).toBe(false);
  });
});
