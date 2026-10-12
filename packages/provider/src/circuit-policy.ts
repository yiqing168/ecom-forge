import { Decimal } from 'decimal.js';

export interface CircuitPolicyModel {
  quota: {
    circuit_sample_size: number;
    circuit_failure_rate: string;
    circuit_unknown_rate: string;
  };
}

export type CircuitOpenReason = 'failure_rate' | 'unknown_rate' | 'hourly_budget' | null;

export function evaluateCircuitWindow(input: {
  sampleCount: number;
  failureCount: number;
  unknownCount: number;
  model: CircuitPolicyModel;
}): CircuitOpenReason {
  if (input.sampleCount < input.model.quota.circuit_sample_size) return null;
  const samples = new Decimal(input.sampleCount);
  if (
    new Decimal(input.failureCount)
      .dividedBy(samples)
      .greaterThanOrEqualTo(input.model.quota.circuit_failure_rate)
  ) {
    return 'failure_rate';
  }
  if (
    new Decimal(input.unknownCount)
      .dividedBy(samples)
      .greaterThanOrEqualTo(input.model.quota.circuit_unknown_rate)
  ) {
    return 'unknown_rate';
  }
  return null;
}

export function hourlyDispatchExposureExceeded(input: {
  count: number;
  riskAdjustedUnitCostCny: string;
  hourlyBudgetCny: string;
}): boolean {
  return new Decimal(input.riskAdjustedUnitCostCny)
    .times(input.count)
    .greaterThanOrEqualTo(input.hourlyBudgetCny);
}
