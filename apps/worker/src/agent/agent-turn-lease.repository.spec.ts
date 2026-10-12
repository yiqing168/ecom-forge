import { describe, expect, it } from 'vitest';

import {
  recoverConsecutiveBrainDeliveryFailures,
  recoverLastBrainCallBudgetExceeded,
  recoverLastBrainCallOutcomeUnknown,
} from './agent-turn-lease.repository.js';

function llmStep(outputSummary: unknown) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    stepNo: 1,
    stepType: 'llm_call' as const,
    status: 'succeeded' as const,
    outputSummary,
  };
}

describe('recoverLastBrainCallOutcomeUnknown', () => {
  it.each([
    'AGENT_CALL_OUTCOME_UNKNOWN',
    'AGENT_BRAIN_CALL_OUTCOME_UNKNOWN',
    'AGENT_SESSION_SUMMARY_INVALID',
  ])('stops recovery when the latest Brain call has unknown delivery with code %s', (errorCode) => {
    const unknown = {
      ...llmStep({ outcome: 'unknown' }),
      status: 'failed' as const,
      errorCode,
      toolName: null,
      toolFingerprint: null,
      inputSummary: {},
    };
    const succeeded = {
      ...llmStep({ outcome: 'respond' }),
      errorCode: null,
      toolName: null,
      toolFingerprint: null,
      inputSummary: {},
    };

    expect(recoverLastBrainCallOutcomeUnknown([unknown])).toBe(true);
    expect(recoverLastBrainCallOutcomeUnknown([unknown, succeeded])).toBe(false);
    expect(recoverConsecutiveBrainDeliveryFailures([unknown])).toBe(1);
    expect(recoverConsecutiveBrainDeliveryFailures([unknown, succeeded])).toBe(0);
  });
});

describe('recoverLastBrainCallBudgetExceeded', () => {
  it('blocks replay of a settled but unpublished chat reply', () => {
    const rejected = {
      ...llmStep({ outcome: 'chat_text_budget_rejected' }),
      status: 'failed' as const,
      errorCode: 'AGENT_BUDGET_EXCEEDED',
      toolName: null,
      toolFingerprint: null,
      inputSummary: {},
    };
    const succeeded = {
      ...llmStep({ outcome: 'respond' }),
      errorCode: null,
      toolName: null,
      toolFingerprint: null,
      inputSummary: {},
    };
    expect(recoverLastBrainCallBudgetExceeded([rejected])).toBe(true);
    expect(recoverLastBrainCallBudgetExceeded([rejected, succeeded])).toBe(false);
  });
});
