import { normalizeMoney } from '@ecom-forge/shared';
import { Decimal } from 'decimal.js';

export interface CostReportInput {
  providerUnitCostCny: string;
  toolCostCny: string;
  storageCostCny: string;
  trafficCostCny: string;
  agentBrainCostCny: string;
  failureRate: string;
  unknownRate: string;
  refundRate: string;
  riskReserveRate: string;
  grossMarginTarget: string;
  creditCnyAnchor: string;
}

export interface CostReportResult {
  directCostCny: string;
  riskAdjustedCostCny: string;
  priceCny: string;
  suggestedCredits: string;
}

function decimal(value: string, label: string): Decimal {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new TypeError(`${label} must be a nonnegative decimal string`);
  }
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) throw new RangeError(`${label} must be finite`);
  return parsed;
}

function rate(value: string, label: string, allowOne = true): Decimal {
  const parsed = decimal(value, label);
  if (parsed.greaterThan(1) || (!allowOne && parsed.equals(1))) {
    throw new RangeError(`${label} is outside the allowed range`);
  }
  return parsed;
}

export function calculateCostReport(input: CostReportInput): CostReportResult {
  const directCost = decimal(input.providerUnitCostCny, 'providerUnitCostCny')
    .plus(decimal(input.toolCostCny, 'toolCostCny'))
    .plus(decimal(input.storageCostCny, 'storageCostCny'))
    .plus(decimal(input.trafficCostCny, 'trafficCostCny'))
    .plus(decimal(input.agentBrainCostCny, 'agentBrainCostCny'));
  const riskMultiplier = new Decimal(1)
    .plus(rate(input.failureRate, 'failureRate'))
    .plus(rate(input.unknownRate, 'unknownRate'))
    .plus(rate(input.refundRate, 'refundRate'))
    .plus(rate(input.riskReserveRate, 'riskReserveRate'));
  const grossMargin = rate(input.grossMarginTarget, 'grossMarginTarget', false);
  const creditAnchor = decimal(input.creditCnyAnchor, 'creditCnyAnchor');
  if (creditAnchor.isZero()) throw new RangeError('creditCnyAnchor must be greater than zero');

  const riskAdjustedCost = directCost.times(riskMultiplier);
  const price = riskAdjustedCost.dividedBy(new Decimal(1).minus(grossMargin));

  return {
    directCostCny: normalizeMoney(directCost.toFixed()),
    riskAdjustedCostCny: normalizeMoney(riskAdjustedCost.toFixed()),
    priceCny: normalizeMoney(price.toFixed()),
    suggestedCredits: price.dividedBy(creditAnchor).ceil().toFixed(0),
  };
}
