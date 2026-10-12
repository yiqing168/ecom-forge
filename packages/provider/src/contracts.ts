import { Decimal } from 'decimal.js';
import { z } from 'zod';

const decimalString = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .refine((value) => new Decimal(value).isFinite(), 'Decimal value must be finite');

const rateString = decimalString.refine((value) => {
  const rate = new Decimal(value);
  return rate.greaterThanOrEqualTo(0) && rate.lessThanOrEqualTo(1);
}, 'Rate must be between 0 and 1');

const marginString = decimalString.refine((value) => {
  const margin = new Decimal(value);
  return margin.greaterThanOrEqualTo(0) && margin.lessThan(1);
}, 'Gross margin must be between 0 inclusive and 1 exclusive');

const positiveDecimalString = decimalString.refine(
  (value) => new Decimal(value).greaterThan(0),
  'Decimal value must be greater than zero',
);

export const providerCapabilitySchema = z.enum([
  'image.generate',
  'image.edit',
  'moderation.text',
  'moderation.image',
]);
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

export const providerErrorCodeSchema = z.enum([
  'provider_auth_failed',
  'provider_rate_limited',
  'provider_quota_exhausted',
  'provider_content_rejected',
  'provider_request_invalid',
  'provider_unavailable',
  'provider_timeout',
  'provider_response_invalid',
  'provider_cancelled',
  'provider_cost_unknown',
  'provider_internal_error',
]);
export type ProviderErrorCode = z.infer<typeof providerErrorCodeSchema>;

export const capabilityContractSchema = z.strictObject({
  schema_version: z.literal(1),
  capabilities: z.array(providerCapabilitySchema).min(1),
  aspect_ratios: z.array(z.string().min(1).max(32)).max(32).default([]),
  resolutions: z.array(z.string().min(1).max(32)).max(32).default([]),
  max_outputs: z.int().positive().max(16),
  max_reference_images: z.int().nonnegative().max(16),
});

export const pricingSnapshotSchema = z.strictObject({
  schema_version: z.literal(1),
  currency: z.literal('CNY'),
  provider_unit_cost_cny: decimalString.nullable(),
  tool_cost_cny: decimalString.nullable(),
  storage_cost_cny: decimalString.nullable(),
  traffic_cost_cny: decimalString.nullable(),
  agent_brain_cost_cny: decimalString.nullable(),
  failure_rate: rateString.nullable(),
  unknown_rate: rateString.nullable(),
  refund_rate: rateString.nullable(),
  risk_reserve_rate: rateString.nullable(),
  gross_margin_target: marginString.nullable(),
  credit_cny_anchor: positiveDecimalString.nullable(),
});

export const quotaSnapshotSchema = z.strictObject({
  schema_version: z.literal(1),
  rpm: z.int().positive(),
  concurrency: z.int().positive(),
  hourly_budget_cny: positiveDecimalString,
  daily_budget_cny: positiveDecimalString,
  poll_initial_delay_ms: z.int().positive(),
  poll_interval_ms: z.int().positive(),
  max_poll_count: z.int().positive(),
  terminal_timeout_ms: z.int().positive(),
  circuit_sample_size: z.int().positive(),
  circuit_failure_rate: rateString,
  circuit_unknown_rate: rateString,
  circuit_open_ms: z.int().positive(),
});

export const modelSnapshotSchema = z.strictObject({
  id: z.uuid(),
  provider: z.string().min(1).max(64),
  model_id: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  status: z.enum(['poc_passed', 'poc_failed', 'disabled', 'free_test_only']),
  capability_contract: capabilityContractSchema,
  pricing: pricingSnapshotSchema,
  quota: quotaSnapshotSchema,
});
export type ModelSnapshot = z.infer<typeof modelSnapshotSchema>;

const receiptSummarySchema = z.strictObject({
  request_id_hint: z.string().min(1).max(128).optional(),
  status_code_family: z.enum(['2xx', '3xx', '4xx', '5xx']).optional(),
  provider_status: z.string().min(1).max(64).optional(),
});

function hasReceiptEvidence(value: z.infer<typeof receiptSummarySchema>): boolean {
  return Object.values(value).some((item) => item !== undefined);
}

const outputSchema = z.strictObject({
  provider_output_id: z.string().min(1).max(256),
  media_type: z.enum(['image', 'text']),
  output_ref: z.string().min(1).max(512),
});

const succeededOutcomeSchema = z.strictObject({
  kind: z.literal('succeeded'),
  provider_request_id: z.string().min(1).max(256),
  receipt_summary: receiptSummarySchema,
  accepted_at: z.date(),
  completed_at: z.date(),
  outputs: z.array(outputSchema).min(1).max(16),
  cost_summary: z
    .strictObject({
      currency: z.literal('CNY'),
      amount: decimalString,
      provider_units: decimalString,
    })
    .optional(),
});

const failedOutcomeSchema = z
  .strictObject({
    kind: z.literal('failed'),
    provider_request_id: z.string().min(1).max(256).optional(),
    error_code: providerErrorCodeSchema,
    receipt_summary: receiptSummarySchema,
    failed_at: z.date(),
  })
  .refine(
    (value) => value.provider_request_id !== undefined || hasReceiptEvidence(value.receipt_summary),
    'A failed Provider outcome requires accepted-request evidence',
  );

const unknownOutcomeSchema = z.strictObject({
  kind: z.literal('outcome_unknown'),
  provider_request_id: z.string().min(1).max(256).optional(),
  error_code: providerErrorCodeSchema,
  request_digest: z.string().min(16).max(256),
  unknown_at: z.date(),
});

export const providerSubmitOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('not_dispatched'),
    error_code: providerErrorCodeSchema,
    retryable: z.boolean(),
    request_digest: z.string().min(16).max(256),
  }),
  z.strictObject({
    kind: z.literal('accepted'),
    provider_request_id: z.string().min(1).max(256),
    receipt_summary: receiptSummarySchema,
    accepted_at: z.date(),
    poll_after_ms: z.int().positive().optional(),
  }),
  succeededOutcomeSchema,
  failedOutcomeSchema,
  unknownOutcomeSchema,
]);
export type ProviderSubmitOutcome = z.infer<typeof providerSubmitOutcomeSchema>;

export type ProviderImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ProviderImageOutputMetadata {
  provider_output_id: string;
  media_type: ProviderImageMediaType;
  byte_length: number;
  width: number;
  height: number;
  content_hash: string;
}

/**
 * Keeps generated bytes outside serializable Provider DTOs. The single consumer
 * is expected to write the bytes to quarantine before the lease is released.
 */
export class ProviderImageOutputLease {
  readonly metadata: ProviderImageOutputMetadata;
  #bytes: Uint8Array | undefined;

  constructor(metadata: ProviderImageOutputMetadata, bytes: Uint8Array) {
    if (bytes.byteLength === 0 || bytes.byteLength !== metadata.byte_length) {
      throw new Error('PROVIDER_IMAGE_OUTPUT_BYTES_INVALID');
    }
    this.metadata = Object.freeze({ ...metadata });
    this.#bytes = Uint8Array.from(bytes);
  }

  async consume<T>(consumer: (bytes: Uint8Array) => Promise<T>): Promise<T> {
    const bytes = this.#bytes;
    if (!bytes) throw new Error('PROVIDER_IMAGE_OUTPUT_ALREADY_CONSUMED');
    this.#bytes = undefined;
    try {
      return await consumer(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  toJSON(): { metadata: ProviderImageOutputMetadata; bytes: '[REDACTED]' } {
    return { metadata: this.metadata, bytes: '[REDACTED]' };
  }
}

type ProviderImageUnknownOutcome = Extract<ProviderSubmitOutcome, { kind: 'outcome_unknown' }> & {
  cost_summary?: Extract<ProviderSubmitOutcome, { kind: 'succeeded' }>['cost_summary'];
  diagnostic_code?:
    | 'response_body_invalid'
    | 'response_schema_invalid'
    | 'response_identity_or_count_invalid'
    | 'response_metadata_mismatch'
    | 'output_base64_invalid'
    | 'output_url_invalid'
    | 'output_url_download_failed'
    | 'output_media_or_dimensions_invalid'
    | 'output_decode_invalid';
  diagnostic_details?: {
    content_type: string;
    body_kind: 'array' | 'null' | 'object' | 'primitive';
    has_id: boolean;
    has_data: boolean;
    data_count: number;
    first_item_has_url: boolean;
    first_item_has_b64_json: boolean;
    first_item_url_location?: string;
  };
};

export type ProviderImageExecutionOutcome =
  | Exclude<ProviderSubmitOutcome, { kind: 'succeeded' | 'outcome_unknown' }>
  | ProviderImageUnknownOutcome
  | {
      kind: 'succeeded';
      provider_request_id: string;
      receipt_summary: Extract<ProviderSubmitOutcome, { kind: 'succeeded' }>['receipt_summary'];
      accepted_at: Date;
      completed_at: Date;
      outputs: readonly ProviderImageOutputLease[];
      cost_summary?: NonNullable<
        Extract<ProviderSubmitOutcome, { kind: 'succeeded' }>['cost_summary']
      >;
    };

export const providerPollOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pending'), poll_after_ms: z.int().positive().optional() }),
  succeededOutcomeSchema,
  failedOutcomeSchema,
  unknownOutcomeSchema,
]);
export type ProviderPollOutcome = z.infer<typeof providerPollOutcomeSchema>;

export const moderationOutcomeSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    decision: z.literal('pass'),
    policy_version: z.string().min(1).max(128),
    confidence: rateString,
  }),
  z.strictObject({
    decision: z.literal('blocked'),
    policy_version: z.string().min(1).max(128),
    confidence: rateString,
    reason_codes: z.array(z.string().min(1).max(128)).min(1).max(32),
  }),
  z.strictObject({
    decision: z.literal('unknown'),
    policy_version: z.string().min(1).max(128),
    error_code: providerErrorCodeSchema,
  }),
]);
export type ModerationOutcome = z.infer<typeof moderationOutcomeSchema>;

export type GatewayMode = 'workflow' | 'poc' | 'test';

export interface ProviderRequest {
  capability: ProviderCapability;
  input: unknown;
}

export interface ProviderPollInput {
  providerRequestId: string;
}

export interface ProviderCallContext {
  idempotencyKey: string;
  requestDigest: string;
  traceId: string;
  deadlineAt: Date;
  signal: AbortSignal;
}

const callbackOutputSchema = z.strictObject({
  provider_output_id: z.string().min(1).max(256),
  media_type: z.enum(['image', 'text']),
});

export const verifiedProviderCallbackSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('succeeded'),
    signature_key_id: z.string().min(1).max(64),
    event_id: z.string().min(1).max(256).optional(),
    provider_request_id: z.string().min(1).max(256),
    receipt_summary: receiptSummarySchema,
    completed_at: z.coerce.date(),
    outputs: z.array(callbackOutputSchema).min(1).max(16),
    cost_summary: z
      .strictObject({
        currency: z.literal('CNY'),
        amount: decimalString,
        provider_units: decimalString,
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('failed'),
    signature_key_id: z.string().min(1).max(64),
    event_id: z.string().min(1).max(256).optional(),
    provider_request_id: z.string().min(1).max(256),
    receipt_summary: receiptSummarySchema,
    error_code: providerErrorCodeSchema,
    failed_at: z.coerce.date(),
  }),
]);
export type VerifiedProviderCallback = z.infer<typeof verifiedProviderCallbackSchema>;

export interface ProviderWebhookHeaders {
  readonly [name: string]: string | readonly string[] | undefined;
}

export interface ProviderWebhookContext {
  now: Date;
  clockSkewSeconds: number;
}

export interface ProviderAdapter {
  readonly provider: string;
  readonly modelId: string;
  readonly version: string;
  readonly capabilities: readonly ProviderCapability[];
  submit(
    request: ProviderRequest,
    model: ModelSnapshot,
    context: ProviderCallContext,
  ): Promise<ProviderSubmitOutcome>;
  poll?(
    input: ProviderPollInput,
    model: ModelSnapshot,
    context: ProviderCallContext,
  ): Promise<ProviderPollOutcome>;
  verifyWebhook?(
    rawBody: Buffer,
    headers: ProviderWebhookHeaders,
    context: ProviderWebhookContext,
  ): Promise<VerifiedProviderCallback>;
  moderateText?(
    input: unknown,
    model: ModelSnapshot,
    context: ProviderCallContext,
  ): Promise<ModerationOutcome>;
  moderateImage?(
    input: unknown,
    model: ModelSnapshot,
    context: ProviderCallContext,
  ): Promise<ModerationOutcome>;
}
