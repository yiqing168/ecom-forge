import { createHash } from 'node:crypto';

import { addMoney, compareMoney, normalizeMoney, type MoneyString } from '@ecom-forge/shared';

import { CreditError } from '@ecom-forge/credit';

export interface QuoteRequest {
  source: 'chat' | 'canvas' | 'suite';
  sourceId?: string;
  targetIds: string[];
  skillId?: string;
  canvasCompileFingerprint?: string;
}

export interface QuoteDraftItem {
  taskKey: string;
  taskType: string;
  estimatedCredits: MoneyString;
  provider: string;
  paramsSnapshot: Record<string, unknown>;
}

export interface QuoteDraft {
  userId: string;
  source: QuoteRequest['source'];
  sourceId: string | null;
  productId: string | null;
  inputSignature: string;
  promptPreview: Record<string, unknown>;
  planSnapshot: Record<string, unknown>;
  skillSnapshot: Record<string, unknown>;
  pricingSnapshot: Record<string, unknown>;
  items: QuoteDraftItem[];
  estimatedCallCount: number;
  estimatedTotalCredits: MoneyString;
  hasUnknownPrice: boolean;
  expiresAt: Date;
}

export interface QuoteProducer {
  produce(userId: string, input: QuoteRequest): QuoteDraft | Promise<QuoteDraft>;
}

const MAX_QUOTE_ITEMS = 100;
const MAX_QUOTE_TTL_MS = 30 * 60 * 1000;
const LOCAL_PRICING_VERSION = 'local-v1';

function quoteMoney(value: string): MoneyString {
  try {
    return normalizeMoney(value);
  } catch {
    throw new CreditError('Quote producer returned an invalid amount', 'COST_MODEL_UNAVAILABLE');
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function inputSignature(userId: string, input: QuoteRequest): string {
  return createHash('sha256')
    .update(canonical({ userId, ...input, pricingRulesVersion: LOCAL_PRICING_VERSION }), 'utf8')
    .digest('hex');
}

export function validateQuoteDraft(
  draft: QuoteDraft,
  expected: { userId: string; source: QuoteRequest['source']; sourceId: string | null },
): QuoteDraft {
  if (
    draft.userId !== expected.userId ||
    draft.source !== expected.source ||
    draft.sourceId !== expected.sourceId
  ) {
    throw new CreditError('Quote producer returned mismatched ownership', 'COST_MODEL_UNAVAILABLE');
  }
  if (
    !Number.isInteger(draft.estimatedCallCount) ||
    draft.estimatedCallCount < 0 ||
    draft.items.length !== draft.estimatedCallCount ||
    draft.items.length > MAX_QUOTE_ITEMS
  ) {
    throw new CreditError(
      'Quote producer returned an invalid call count',
      'COST_MODEL_UNAVAILABLE',
    );
  }

  const taskKeys = new Set<string>();
  for (const item of draft.items) {
    if (
      !item.taskKey ||
      !item.taskType ||
      !item.provider ||
      taskKeys.has(item.taskKey) ||
      compareMoney(quoteMoney(item.estimatedCredits), '0.00') < 0
    ) {
      throw new CreditError('Quote producer returned an invalid item', 'COST_MODEL_UNAVAILABLE');
    }
    taskKeys.add(item.taskKey);
  }

  const total = draft.items.reduce(
    (sum, item) => addMoney(sum, quoteMoney(item.estimatedCredits)),
    '0.00' as MoneyString,
  );
  if (compareMoney(total, quoteMoney(draft.estimatedTotalCredits)) !== 0) {
    throw new CreditError('Quote producer returned an invalid total', 'COST_MODEL_UNAVAILABLE');
  }
  const ttl = draft.expiresAt instanceof Date ? draft.expiresAt.getTime() - Date.now() : NaN;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_QUOTE_TTL_MS) {
    throw new CreditError('Quote producer returned an expired quote', 'COST_MODEL_UNAVAILABLE');
  }
  return { ...draft, estimatedTotalCredits: total };
}

export class LocalQuoteProducer implements QuoteProducer {
  produce(userId: string, input: QuoteRequest): QuoteDraft {
    const count = Math.max(input.targetIds.length, 1);
    const items = Array.from({ length: count }, (_, index) => ({
      taskKey: `task-${index + 1}`,
      taskType: 'image.generate',
      estimatedCredits: '1.00' as const,
      provider: 'local-fake',
      paramsSnapshot: { target_id: input.targetIds[index] ?? null },
    }));
    const estimatedTotalCredits = items.reduce(
      (total, item) => addMoney(total, item.estimatedCredits),
      '0.00' as MoneyString,
    );

    return {
      userId,
      source: input.source,
      sourceId: input.sourceId ?? null,
      productId: null,
      inputSignature: inputSignature(userId, input),
      promptPreview: { source: input.source, target_count: input.targetIds.length },
      planSnapshot: {
        compiler: 'local-fake',
        revision: 'local-v1',
        source_id: input.sourceId ?? null,
        items,
      },
      skillSnapshot: { skill_id: input.skillId ?? null, version: 'local-v1' },
      pricingSnapshot: {
        provider: 'local-fake',
        currency: 'credits',
        unit_price: '1.00',
        version: LOCAL_PRICING_VERSION,
      },
      items,
      estimatedCallCount: count,
      estimatedTotalCredits,
      hasUnknownPrice: false,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    };
  }
}

export class UnavailableQuoteProducer implements QuoteProducer {
  produce(): QuoteDraft {
    throw new CreditError(
      'Cost model is not available in this environment',
      'COST_MODEL_UNAVAILABLE',
    );
  }
}
