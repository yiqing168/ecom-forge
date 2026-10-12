import { describe, expect, it } from 'vitest';

import type { QuoteDraft } from './quote-producer.js';
import { validateQuoteDraft } from './quote-producer.js';

const userId = '00000000-0000-4000-8000-000000000001';

function draft(overrides: Partial<QuoteDraft> = {}): QuoteDraft {
  return {
    userId,
    source: 'chat',
    sourceId: null,
    productId: null,
    inputSignature: 'a'.repeat(64),
    promptPreview: {},
    planSnapshot: {},
    skillSnapshot: {},
    pricingSnapshot: {},
    items: [
      {
        taskKey: 'task-1',
        taskType: 'image.generate',
        estimatedCredits: '1.00',
        provider: 'test',
        paramsSnapshot: {},
      },
    ],
    estimatedCallCount: 1,
    estimatedTotalCredits: '1.00',
    hasUnknownPrice: false,
    expiresAt: new Date(Date.now() + 600_000),
    ...overrides,
  };
}

describe('quote producer validation', () => {
  it('accepts a bounded internally consistent draft', () => {
    expect(validateQuoteDraft(draft(), { userId, source: 'chat', sourceId: null })).toMatchObject({
      estimatedTotalCredits: '1.00',
    });
  });

  it.each([
    ['wrong owner', draft({ userId: '00000000-0000-4000-8000-000000000002' })],
    ['mismatched total', draft({ estimatedTotalCredits: '2.00' })],
    ['invalid amount', draft({ items: [{ ...draft().items[0]!, estimatedCredits: 'NaN' }] })],
    ['excessive ttl', draft({ expiresAt: new Date(Date.now() + 31 * 60_000) })],
    [
      'duplicate task keys',
      draft({
        estimatedCallCount: 2,
        estimatedTotalCredits: '2.00',
        items: [draft().items[0]!, { ...draft().items[0]! }],
      }),
    ],
  ])('fails closed for %s', (_, invalidDraft) => {
    expect(() =>
      validateQuoteDraft(invalidDraft, { userId, source: 'chat', sourceId: null }),
    ).toThrow(expect.objectContaining({ code: 'COST_MODEL_UNAVAILABLE' }));
  });
});
