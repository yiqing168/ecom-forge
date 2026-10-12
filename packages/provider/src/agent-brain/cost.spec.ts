import { describe, expect, it } from 'vitest';

import { calculateAgentBrainActualCost, calculateAgentBrainExposure } from './cost.js';

const pricing = {
  schema_version: 1 as const,
  contract_kind: 'agent_brain_tokens' as const,
  currency: 'CNY' as const,
  request_base_cost_cny: '0.01',
  input_per_million_tokens_cny: '2.00',
  cached_input_per_million_tokens_cny: '1.00',
  output_per_million_tokens_cny: '8.00',
};

describe('Agent Brain cost accounting', () => {
  it('rounds once after calculating conservative exposure with non-cached input pricing', () => {
    expect(
      calculateAgentBrainExposure({
        pricing,
        requestedInputTokens: 1_500,
        requestedMaxOutputTokens: 1_000,
      }),
    ).toBe('0.02');
  });

  it('uses trusted usage for actual cost and validates token counts', () => {
    expect(calculateAgentBrainActualCost({ pricing, inputTokens: 1_500, outputTokens: 500 })).toBe(
      '0.02',
    );
    expect(() =>
      calculateAgentBrainActualCost({ pricing, inputTokens: -1, outputTokens: 1 }),
    ).toThrow(/nonnegative safe integer/);
  });

  it('prices cached input tokens with the frozen cached-input rate', () => {
    expect(
      calculateAgentBrainActualCost({
        pricing,
        inputTokens: 1_500_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBe('2.01');
    expect(() =>
      calculateAgentBrainActualCost({
        pricing,
        inputTokens: 1,
        cachedInputTokens: 2,
        outputTokens: 0,
      }),
    ).toThrow(/cannot exceed/);
  });
});
