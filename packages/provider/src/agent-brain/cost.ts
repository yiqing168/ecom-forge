import { normalizeMoney } from '@ecom-forge/shared';
import { Decimal } from 'decimal.js';

import type { AgentBrainModelSnapshot } from '@ecom-forge/agent';

type Pricing = AgentBrainModelSnapshot['pricing'];

const ONE_MILLION = new Decimal(1_000_000);

function tokenCost(tokens: number, rate: string): Decimal {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new RangeError('Token count must be a nonnegative safe integer');
  }
  return new Decimal(tokens).times(rate).dividedBy(ONE_MILLION);
}

function assertTokenCount(tokens: number): void {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new RangeError('Token count must be a nonnegative safe integer');
  }
}

export function calculateAgentBrainExposure(input: {
  pricing: Pricing;
  requestedInputTokens: number;
  requestedMaxOutputTokens: number;
}): string {
  return normalizeMoney(
    new Decimal(input.pricing.request_base_cost_cny)
      .plus(tokenCost(input.requestedInputTokens, input.pricing.input_per_million_tokens_cny))
      .plus(tokenCost(input.requestedMaxOutputTokens, input.pricing.output_per_million_tokens_cny))
      .toFixed(),
  );
}

export function calculateAgentBrainActualCost(input: {
  pricing: Pricing;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
}): string {
  const cachedInputTokens = input.cachedInputTokens ?? 0;
  assertTokenCount(input.inputTokens);
  assertTokenCount(cachedInputTokens);
  assertTokenCount(input.outputTokens);
  if (cachedInputTokens > input.inputTokens) {
    throw new RangeError('Cached input tokens cannot exceed total input tokens');
  }
  return normalizeMoney(
    new Decimal(input.pricing.request_base_cost_cny)
      .plus(
        tokenCost(
          input.inputTokens - cachedInputTokens,
          input.pricing.input_per_million_tokens_cny,
        ),
      )
      .plus(tokenCost(cachedInputTokens, input.pricing.cached_input_per_million_tokens_cny))
      .plus(tokenCost(input.outputTokens, input.pricing.output_per_million_tokens_cny))
      .toFixed(),
  );
}
