import { agentBrainModelDefinitionSchema } from '@ecom-forge/agent';
import { Decimal } from 'decimal.js';
import { z } from 'zod';

import { quotaSnapshotSchema } from './contracts.js';

const decimalString = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .refine((value) => new Decimal(value).isFinite(), 'Decimal value must be finite');

const positiveDecimalString = decimalString.refine(
  (value) => new Decimal(value).greaterThan(0),
  'Decimal value must be greater than zero',
);

const rateString = decimalString.refine((value) => {
  const rate = new Decimal(value);
  return rate.greaterThanOrEqualTo(0) && rate.lessThanOrEqualTo(1);
}, 'Rate must be between zero and one');

const marginString = decimalString.refine((value) => {
  const margin = new Decimal(value);
  return margin.greaterThanOrEqualTo(0) && margin.lessThan(1);
}, 'Gross margin must be between zero inclusive and one exclusive');

const stableKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
const aspectRatio = z.string().regex(/^[1-9]\d{0,2}:[1-9]\d{0,2}$/);

/** Legacy v2 image snapshots predate model-specific prompt admission. */
export const LEGACY_IMAGE_PROMPT_MAX_CHARACTERS = 32_000 as const;
export const IMAGE_PROMPT_ABSOLUTE_MAX_CHARACTERS = 128_000 as const;
export const IMAGE_PROVIDER_PROMPT_ENVELOPE_RESERVED_CHARACTERS = 512 as const;

export function imageSpecHasPocCoverage(
  specs: readonly MediaCapabilitySpec[],
  selectedSpecKey: string,
  probedSpecKeys: unknown,
): boolean {
  if (!Array.isArray(probedSpecKeys) || probedSpecKeys.some((key) => typeof key !== 'string')) {
    return false;
  }
  const selected = specs.find((spec) => spec.spec_key === selectedSpecKey);
  if (!selected || selected.kind !== 'image') return false;
  if (probedSpecKeys.includes(selected.spec_key)) return true;
  return specs.some(
    (baseline) =>
      baseline.kind === 'image' &&
      baseline.resolution_tier === '1k' &&
      baseline.operation === selected.operation &&
      baseline.mode === selected.mode &&
      probedSpecKeys.includes(baseline.spec_key),
  );
}

/**
 * This is the limit for the complete prompt sent to the image Provider,
 * including the deterministic authorization/safety envelope.
 */
export function imageProviderPromptMaxCharacters(providerMaxCharacters?: number): number {
  return Math.min(
    IMAGE_PROMPT_ABSOLUTE_MAX_CHARACTERS,
    providerMaxCharacters ?? LEGACY_IMAGE_PROMPT_MAX_CHARACTERS,
  );
}

/**
 * Brain/Compiler candidate budget. The final prompt builder must retain room
 * for the deterministic envelope before the complete prompt reaches Provider.
 */
export function imageCreativePromptMaxCharacters(providerMaxCharacters?: number): number {
  return Math.max(
    1,
    imageProviderPromptMaxCharacters(providerMaxCharacters) -
      IMAGE_PROVIDER_PROMPT_ENVELOPE_RESERVED_CHARACTERS,
  );
}

export const mediaOperationSchema = z.enum([
  'image.generate',
  'image.edit',
  'upscale',
  'video.generate',
]);

const durationSchema = z.discriminatedUnion('mode', [
  z
    .strictObject({
      mode: z.literal('range'),
      min_seconds: z.int().positive().max(3_600),
      max_seconds: z.int().positive().max(3_600),
      step_seconds: z.int().positive().max(3_600),
    })
    .superRefine((value, context) => {
      if (value.max_seconds < value.min_seconds) {
        context.addIssue({
          code: 'custom',
          path: ['max_seconds'],
          message: 'max_seconds must not be smaller than min_seconds',
        });
      }
      if ((value.max_seconds - value.min_seconds) % value.step_seconds !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['step_seconds'],
          message: 'duration range must be divisible by step_seconds',
        });
      }
    }),
  z.strictObject({
    mode: z.literal('fixed'),
    seconds: z.array(z.int().positive().max(3_600)).min(1).max(32),
  }),
]);

const imageSpecSchema = z.strictObject({
  kind: z.literal('image'),
  spec_key: stableKey,
  operation: z.enum(['image.generate', 'image.edit', 'upscale']),
  mode: stableKey,
  resolution_tier: z.enum(['1k', '2k', '4k']),
  aspect_ratios: z.array(aspectRatio).min(1).max(32),
  max_outputs: z.int().positive().max(16),
  max_reference_images: z.int().nonnegative().max(16),
  max_prompt_characters: z
    .int()
    .min(LEGACY_IMAGE_PROMPT_MAX_CHARACTERS)
    .max(IMAGE_PROMPT_ABSOLUTE_MAX_CHARACTERS)
    .optional(),
  transparent_background: z.boolean(),
  output_formats: z
    .array(z.enum(['png', 'jpeg', 'webp']))
    .min(1)
    .max(3),
});

const videoSpecSchema = z.strictObject({
  kind: z.literal('video'),
  spec_key: stableKey,
  operation: z.literal('video.generate'),
  mode: stableKey,
  resolution_tier: z.enum(['720p', '1080p', '4k']),
  aspect_ratios: z.array(aspectRatio).min(1).max(32),
  fps: z.array(z.int().positive().max(240)).min(1).max(16),
  audio: z.boolean(),
  duration: durationSchema,
  max_outputs: z.int().positive().max(16),
  max_reference_images: z.int().nonnegative().max(16),
});

export const mediaCapabilitySpecSchema = z.discriminatedUnion('kind', [
  imageSpecSchema,
  videoSpecSchema,
]);

export const mediaV2CapabilityContractSchema = z
  .strictObject({
    schema_version: z.literal(2),
    contract_kind: z.literal('media'),
    media_kind: z.enum(['image', 'video']),
    capabilities: z.array(mediaOperationSchema).min(1).max(4),
    specs: z.array(mediaCapabilitySpecSchema).min(1).max(128),
  })
  .superRefine((value, context) => {
    const capabilities = new Set(value.capabilities);
    if (capabilities.size !== value.capabilities.length) {
      context.addIssue({
        code: 'custom',
        path: ['capabilities'],
        message: 'Capabilities must be unique',
      });
    }

    const specKeys = new Set<string>();
    for (const [index, spec] of value.specs.entries()) {
      if (spec.kind !== value.media_kind) {
        context.addIssue({
          code: 'custom',
          path: ['specs', index, 'kind'],
          message: 'Spec kind must match media_kind',
        });
      }
      if (!capabilities.has(spec.operation)) {
        context.addIssue({
          code: 'custom',
          path: ['specs', index, 'operation'],
          message: 'Spec operation must be declared as a capability',
        });
      }
      if (specKeys.has(spec.spec_key)) {
        context.addIssue({
          code: 'custom',
          path: ['specs', index, 'spec_key'],
          message: 'spec_key must be unique',
        });
      }
      specKeys.add(spec.spec_key);
    }
  });

const imageRateCardSchema = z.strictObject({
  rate_key: stableKey,
  spec_key: stableKey,
  billing_unit: z.literal('image'),
  unit_cost_cny: positiveDecimalString.nullable(),
});

const secondRateCardSchema = z
  .strictObject({
    rate_key: stableKey,
    spec_key: stableKey,
    billing_unit: z.literal('second'),
    unit_cost_cny: positiveDecimalString.nullable(),
    min_units: z.int().positive().max(3_600),
    max_units: z.int().positive().max(3_600),
    step_units: z.int().positive().max(3_600),
  })
  .superRefine((value, context) => {
    if (value.max_units < value.min_units) {
      context.addIssue({
        code: 'custom',
        path: ['max_units'],
        message: 'max_units must not be smaller than min_units',
      });
    }
    if ((value.max_units - value.min_units) % value.step_units !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['step_units'],
        message: 'unit range must be divisible by step_units',
      });
    }
  });

const segmentRateCardSchema = z.strictObject({
  rate_key: stableKey,
  spec_key: stableKey,
  billing_unit: z.literal('segment'),
  unit_cost_cny: positiveDecimalString.nullable(),
  segment_seconds: z.int().positive().max(3_600),
  max_segments: z.int().positive().max(1_000),
});

const megapixelRateCardSchema = z
  .strictObject({
    rate_key: stableKey,
    spec_key: stableKey,
    billing_unit: z.literal('megapixel'),
    unit_cost_cny: positiveDecimalString.nullable(),
    min_megapixels: positiveDecimalString,
    max_megapixels: positiveDecimalString,
    step_megapixels: positiveDecimalString,
  })
  .superRefine((value, context) => {
    if (new Decimal(value.max_megapixels).lessThan(value.min_megapixels)) {
      context.addIssue({
        code: 'custom',
        path: ['max_megapixels'],
        message: 'max_megapixels must not be smaller than min_megapixels',
      });
    }
  });

export const mediaRateSchema = z.discriminatedUnion('billing_unit', [
  imageRateCardSchema,
  secondRateCardSchema,
  segmentRateCardSchema,
  megapixelRateCardSchema,
]);

export const mediaRateCardV2Schema = z
  .strictObject({
    schema_version: z.literal(2),
    contract_kind: z.literal('media_rate_card'),
    currency: z.literal('CNY'),
    rate_cards: z.array(mediaRateSchema).min(1).max(128),
    overhead_cny: z.strictObject({
      tool: decimalString.nullable(),
      storage: decimalString.nullable(),
      traffic: decimalString.nullable(),
      agent_brain: decimalString.nullable(),
    }),
    failure_rate: rateString.nullable(),
    unknown_rate: rateString.nullable(),
    refund_rate: rateString.nullable(),
    risk_reserve_rate: rateString.nullable(),
    gross_margin_target: marginString.nullable(),
    credit_cny_anchor: positiveDecimalString.nullable(),
  })
  .superRefine((value, context) => {
    const rateKeys = new Set<string>();
    const specKeys = new Set<string>();
    for (const [index, rate] of value.rate_cards.entries()) {
      if (rateKeys.has(rate.rate_key)) {
        context.addIssue({
          code: 'custom',
          path: ['rate_cards', index, 'rate_key'],
          message: 'rate_key must be unique',
        });
      }
      if (specKeys.has(rate.spec_key)) {
        context.addIssue({
          code: 'custom',
          path: ['rate_cards', index, 'spec_key'],
          message: 'Each spec_key must have exactly one rate card',
        });
      }
      rateKeys.add(rate.rate_key);
      specKeys.add(rate.spec_key);
    }
  });

const modelStatusSchema = z.enum(['poc_passed', 'poc_failed', 'disabled', 'free_test_only']);

export const mediaV2ModelSnapshotSchema = z
  .strictObject({
    id: z.uuid(),
    provider_channel_id: z.uuid(),
    provider: z.string().min(1).max(64),
    model_id: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
    status: modelStatusSchema,
    capability_contract: mediaV2CapabilityContractSchema,
    pricing: mediaRateCardV2Schema,
    quota: quotaSnapshotSchema,
  })
  .superRefine((value, context) => {
    const specs = new Map(value.capability_contract.specs.map((spec) => [spec.spec_key, spec]));
    const rates = new Map(value.pricing.rate_cards.map((rate) => [rate.spec_key, rate]));

    for (const [specKey, spec] of specs) {
      const rate = rates.get(specKey);
      if (!rate) {
        context.addIssue({
          code: 'custom',
          path: ['pricing', 'rate_cards'],
          message: `Missing rate card for ${specKey}`,
        });
        continue;
      }
      const allowedUnits = spec.kind === 'image' ? ['image', 'megapixel'] : ['second', 'segment'];
      if (!allowedUnits.includes(rate.billing_unit)) {
        context.addIssue({
          code: 'custom',
          path: ['pricing', 'rate_cards'],
          message: `Billing unit ${rate.billing_unit} is incompatible with ${spec.kind}`,
        });
      }
    }
    for (const specKey of rates.keys()) {
      if (!specs.has(specKey)) {
        context.addIssue({
          code: 'custom',
          path: ['pricing', 'rate_cards'],
          message: `Rate card references unknown spec ${specKey}`,
        });
      }
    }
  });

export const agentBrainProviderModelSnapshotSchema = agentBrainModelDefinitionSchema;

export type MediaOperation = z.infer<typeof mediaOperationSchema>;
export type MediaCapabilitySpec = z.infer<typeof mediaCapabilitySpecSchema>;
export type MediaV2CapabilityContract = z.infer<typeof mediaV2CapabilityContractSchema>;
export type MediaRate = z.infer<typeof mediaRateSchema>;
export type MediaRateCardV2 = z.infer<typeof mediaRateCardV2Schema>;
export type MediaV2ModelSnapshot = z.infer<typeof mediaV2ModelSnapshotSchema>;
export type AgentBrainProviderModelSnapshot = z.infer<typeof agentBrainProviderModelSnapshotSchema>;
