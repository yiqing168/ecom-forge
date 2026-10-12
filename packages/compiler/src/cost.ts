import { calculateCostReport, resolveOpenAiImageDimensions } from '@ecom-forge/provider';
import { multiplyMoney, normalizeMoney } from '@ecom-forge/shared';

import type { CapabilityRequirements, CompilerContext, CompilerModel } from './types.js';

type ImageSelection = NonNullable<CompilerContext['model_selection']>['image'];

export function compileTaskCost(input: {
  model: CompilerModel;
  requirements?: CapabilityRequirements;
  selection?: ImageSelection;
  maxImagePixels?: number;
}) {
  const { model } = input;
  const pricing = model.pricing;
  if (pricing.schema_version === 2) {
    const selection = input.selection;
    const requirements = input.requirements;
    const spec =
      model.capability_contract.schema_version === 2
        ? model.capability_contract.specs.find(
            (candidate) => candidate.spec_key === selection?.selected_spec_key,
          )
        : undefined;
    const rate = pricing.rate_cards.find(
      (candidate) => candidate.spec_key === selection?.selected_spec_key,
    );
    if (
      !selection ||
      !requirements ||
      !spec ||
      spec.kind !== 'image' ||
      !rate ||
      (rate.billing_unit !== 'image' && rate.billing_unit !== 'megapixel')
    ) {
      throw new Error('COMPILER_MEDIA_COST_CLOSURE_INVALID');
    }
    const costInputs = [
      rate.unit_cost_cny,
      pricing.overhead_cny.tool,
      pricing.overhead_cny.storage,
      pricing.overhead_cny.traffic,
      pricing.overhead_cny.agent_brain,
      pricing.failure_rate,
      pricing.unknown_rate,
      pricing.refund_rate,
      pricing.risk_reserve_rate,
      pricing.gross_margin_target,
      pricing.credit_cny_anchor,
    ];
    const costsKnown = costInputs.every((value): value is string => value !== null);
    const report = costsKnown
      ? calculateCostReport({
          providerUnitCostCny: rate.unit_cost_cny!,
          toolCostCny: pricing.overhead_cny.tool!,
          storageCostCny: pricing.overhead_cny.storage!,
          trafficCostCny: pricing.overhead_cny.traffic!,
          agentBrainCostCny: pricing.overhead_cny.agent_brain!,
          failureRate: pricing.failure_rate!,
          unknownRate: pricing.unknown_rate!,
          refundRate: pricing.refund_rate!,
          riskReserveRate: pricing.risk_reserve_rate!,
          grossMarginTarget: pricing.gross_margin_target!,
          creditCnyAnchor: pricing.credit_cny_anchor!,
        })
      : null;
    const units =
      rate.billing_unit === 'image'
        ? String(requirements.outputCount)
        : imageMegapixelUnits({
            ...(requirements.aspectRatio ? { aspectRatio: requirements.aspectRatio } : {}),
            resolution: spec.resolution_tier,
            outputCount: requirements.outputCount,
            minimum: rate.min_megapixels,
            maximum: rate.max_megapixels,
            step: rate.step_megapixels,
            ...(input.maxImagePixels !== undefined ? { maxImagePixels: input.maxImagePixels } : {}),
          });
    return {
      provider_unit_cost_cny:
        rate.unit_cost_cny === null ? null : normalizeMoney(rate.unit_cost_cny),
      tool_cost_cny:
        pricing.overhead_cny.tool === null ? null : normalizeMoney(pricing.overhead_cny.tool),
      storage_cost_cny:
        pricing.overhead_cny.storage === null ? null : normalizeMoney(pricing.overhead_cny.storage),
      traffic_cost_cny:
        pricing.overhead_cny.traffic === null ? null : normalizeMoney(pricing.overhead_cny.traffic),
      agent_brain_cost_cny:
        pricing.overhead_cny.agent_brain === null
          ? null
          : normalizeMoney(pricing.overhead_cny.agent_brain),
      risk_adjusted_cost_cny: report?.riskAdjustedCostCny ?? null,
      estimated_credits: multiplyMoney(selection.billing_sku.credits_per_unit, units),
      pricing_snapshot_digest: model.pricing_digest,
      billing_sku_id: selection.billing_sku.id,
      billing_sku_version: selection.billing_sku.version_no,
      billing_matcher_hash: selection.billing_sku.matcher_hash,
      billing_unit_kind: selection.billing_sku.unit_kind,
      billing_unit_rule: selection.billing_sku.unit_rule,
      credits_per_unit: selection.billing_sku.credits_per_unit,
      provider_rate_card_key: selection.billing_sku.provider_rate_card_key,
    };
  }
  if (
    pricing.provider_unit_cost_cny === null ||
    pricing.tool_cost_cny === null ||
    pricing.storage_cost_cny === null ||
    pricing.traffic_cost_cny === null ||
    pricing.agent_brain_cost_cny === null ||
    pricing.failure_rate === null ||
    pricing.unknown_rate === null ||
    pricing.refund_rate === null ||
    pricing.risk_reserve_rate === null ||
    pricing.gross_margin_target === null ||
    pricing.credit_cny_anchor === null
  ) {
    throw new Error('COMPILER_LEGACY_COST_UNAVAILABLE');
  }
  const report = calculateCostReport({
    providerUnitCostCny: pricing.provider_unit_cost_cny,
    toolCostCny: pricing.tool_cost_cny,
    storageCostCny: pricing.storage_cost_cny,
    trafficCostCny: pricing.traffic_cost_cny,
    agentBrainCostCny: pricing.agent_brain_cost_cny,
    failureRate: pricing.failure_rate,
    unknownRate: pricing.unknown_rate,
    refundRate: pricing.refund_rate,
    riskReserveRate: pricing.risk_reserve_rate,
    grossMarginTarget: pricing.gross_margin_target,
    creditCnyAnchor: pricing.credit_cny_anchor,
  });
  return {
    provider_unit_cost_cny: normalizeMoney(pricing.provider_unit_cost_cny),
    tool_cost_cny: normalizeMoney(pricing.tool_cost_cny),
    storage_cost_cny: normalizeMoney(pricing.storage_cost_cny),
    traffic_cost_cny: normalizeMoney(pricing.traffic_cost_cny),
    agent_brain_cost_cny: normalizeMoney(pricing.agent_brain_cost_cny),
    risk_adjusted_cost_cny: report.riskAdjustedCostCny,
    estimated_credits: normalizeMoney(report.suggestedCredits),
    pricing_snapshot_digest: model.pricing_digest,
  };
}

function imageMegapixelUnits(input: {
  aspectRatio?: string;
  resolution: '1k' | '2k' | '4k';
  outputCount: number;
  minimum: string;
  maximum: string;
  step: string;
  maxImagePixels?: number;
}): string {
  if (!input.aspectRatio) throw new Error('COMPILER_MEDIA_UNITS_INVALID');
  const { width, height } = resolveOpenAiImageDimensions(
    input.aspectRatio,
    input.resolution,
    input.maxImagePixels,
  );
  const raw = decimalFraction(BigInt(width) * BigInt(height) * BigInt(input.outputCount), 6);
  return ceilDecimalUnits(raw, input.minimum, input.maximum, input.step);
}

function decimalFraction(numerator: bigint, scale: number): string {
  const base = 10n ** BigInt(scale);
  const whole = numerator / base;
  const fraction = (numerator % base).toString().padStart(scale, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function ceilDecimalUnits(raw: string, minimum: string, maximum: string, step: string): string {
  const scale = Math.max(...[raw, minimum, maximum, step].map(decimalPlaces));
  const factor = 10n ** BigInt(scale);
  const parse = (value: string) => {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(whole) * factor + BigInt(fraction.padEnd(scale, '0'));
  };
  const rawValue = parse(raw);
  const minimumValue = parse(minimum);
  const maximumValue = parse(maximum);
  const stepValue = parse(step);
  if (stepValue <= 0n || rawValue > maximumValue) throw new Error('COMPILER_MEDIA_UNITS_INVALID');
  const value =
    rawValue <= minimumValue
      ? minimumValue
      : minimumValue + ((rawValue - minimumValue + stepValue - 1n) / stepValue) * stepValue;
  if (value > maximumValue) throw new Error('COMPILER_MEDIA_UNITS_INVALID');
  const whole = value / factor;
  const fraction = (value % factor).toString().padStart(scale, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function decimalPlaces(value: string): number {
  return value.split('.')[1]?.length ?? 0;
}
