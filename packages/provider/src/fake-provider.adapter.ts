import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import {
  type ModelSnapshot,
  type ModerationOutcome,
  type ProviderAdapter,
  type ProviderCallContext,
  type ProviderCapability,
  providerErrorCodeSchema,
  type ProviderRequest,
  type ProviderPollInput,
  type ProviderPollOutcome,
  type ProviderSubmitOutcome,
  type ProviderWebhookContext,
  type ProviderWebhookHeaders,
  verifiedProviderCallbackSchema,
  type VerifiedProviderCallback,
} from './contracts.js';

export type FakeProviderScenario =
  'succeeded' | 'accepted' | 'not_dispatched' | 'failed' | 'outcome_unknown' | 'throw' | 'never';

export class ProviderWebhookVerificationError extends Error {
  constructor(
    readonly code:
      | 'PROVIDER_WEBHOOK_HEADERS_INVALID'
      | 'PROVIDER_WEBHOOK_SIGNATURE_INVALID'
      | 'PROVIDER_WEBHOOK_CLOCK_SKEW'
      | 'PROVIDER_WEBHOOK_PAYLOAD_INVALID',
  ) {
    super(code);
    this.name = 'ProviderWebhookVerificationError';
  }
}

export interface FakeProviderWebhookOptions {
  keyId: string;
  secret: Buffer;
}

export interface FakeProviderIdentity {
  modelId: string;
  version: string;
  moderationPolicyVersion?: string;
}

const fakeWebhookPayloadSchema = z.discriminatedUnion('status', [
  z.strictObject({
    event_id: z.string().min(1).max(256).optional(),
    request_id: z.string().min(1).max(256),
    status: z.literal('succeeded'),
    completed_at: z.iso.datetime(),
    outputs: z
      .array(
        z.strictObject({
          provider_output_id: z.string().min(1).max(256),
          media_type: z.enum(['image', 'text']),
          output_ref: z.string().min(1).max(512),
        }),
      )
      .min(1)
      .max(16),
    cost: z.strictObject({
      currency: z.literal('CNY'),
      amount: z.string(),
      provider_units: z.string(),
    }),
  }),
  z.strictObject({
    event_id: z.string().min(1).max(256).optional(),
    request_id: z.string().min(1).max(256),
    status: z.literal('failed'),
    failed_at: z.iso.datetime(),
    error_code: providerErrorCodeSchema,
  }),
]);

function singleHeader(headers: ProviderWebhookHeaders, name: string): string | undefined {
  const value = headers[name];
  if (typeof value === 'string') return value;
  return value?.length === 1 ? value[0] : undefined;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'base64url');
  const rightBuffer = Buffer.from(right, 'base64url');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly provider = 'fake';
  readonly modelId: string;
  readonly version: string;
  private readonly moderationPolicyVersion: string;
  readonly capabilities: readonly ProviderCapability[] = [
    'image.generate',
    'image.edit',
    'moderation.text',
    'moderation.image',
  ];
  submitCount = 0;
  private readonly submissions = new Map<string, Promise<ProviderSubmitOutcome>>();

  constructor(
    private readonly scenario: FakeProviderScenario = 'succeeded',
    private readonly now: () => Date = () => new Date(),
    private readonly webhook?: FakeProviderWebhookOptions,
    identity: FakeProviderIdentity = { modelId: 'fake-image-v1', version: '1' },
  ) {
    this.modelId = identity.modelId;
    this.version = identity.version;
    this.moderationPolicyVersion = identity.moderationPolicyVersion ?? 'fake-policy-v1';
  }

  async verifyWebhook(
    rawBody: Buffer,
    headers: ProviderWebhookHeaders,
    context: ProviderWebhookContext,
  ): Promise<VerifiedProviderCallback> {
    await Promise.resolve();
    if (!this.webhook) {
      throw new ProviderWebhookVerificationError('PROVIDER_WEBHOOK_SIGNATURE_INVALID');
    }
    const keyId = singleHeader(headers, 'x-provider-key-id');
    const timestamp = singleHeader(headers, 'x-provider-timestamp');
    const signature = singleHeader(headers, 'x-provider-signature');
    if (!keyId || !timestamp || !signature || !/^\d{10}$/.test(timestamp)) {
      throw new ProviderWebhookVerificationError('PROVIDER_WEBHOOK_HEADERS_INVALID');
    }
    if (keyId !== this.webhook.keyId) {
      throw new ProviderWebhookVerificationError('PROVIDER_WEBHOOK_SIGNATURE_INVALID');
    }
    const timestampMs = Number(timestamp) * 1_000;
    if (Math.abs(context.now.getTime() - timestampMs) > context.clockSkewSeconds * 1_000) {
      throw new ProviderWebhookVerificationError('PROVIDER_WEBHOOK_CLOCK_SKEW');
    }
    const expected = createHmac('sha256', this.webhook.secret)
      .update(timestamp, 'utf8')
      .update('.', 'utf8')
      .update(rawBody)
      .digest('base64url');
    if (!constantTimeEqual(signature, expected)) {
      throw new ProviderWebhookVerificationError('PROVIDER_WEBHOOK_SIGNATURE_INVALID');
    }

    let payload: z.infer<typeof fakeWebhookPayloadSchema>;
    try {
      payload = fakeWebhookPayloadSchema.parse(JSON.parse(rawBody.toString('utf8')) as unknown);
    } catch {
      throw new ProviderWebhookVerificationError('PROVIDER_WEBHOOK_PAYLOAD_INVALID');
    }
    const callback =
      payload.status === 'succeeded'
        ? {
            kind: 'succeeded' as const,
            signature_key_id: this.webhook.keyId,
            event_id: payload.event_id,
            provider_request_id: payload.request_id,
            receipt_summary: { provider_status: payload.status },
            completed_at: new Date(payload.completed_at),
            outputs: payload.outputs.map((output) => ({
              provider_output_id: output.provider_output_id,
              media_type: output.media_type,
            })),
            cost_summary: payload.cost,
          }
        : {
            kind: 'failed' as const,
            signature_key_id: this.webhook.keyId,
            event_id: payload.event_id,
            provider_request_id: payload.request_id,
            receipt_summary: { provider_status: payload.status },
            error_code: payload.error_code,
            failed_at: new Date(payload.failed_at),
          };
    return Promise.resolve(verifiedProviderCallbackSchema.parse(callback));
  }

  submit(
    request: ProviderRequest,
    _model: ModelSnapshot,
    context: ProviderCallContext,
  ): Promise<ProviderSubmitOutcome> {
    const existing = this.submissions.get(context.idempotencyKey);
    if (existing) return existing;

    this.submitCount += 1;
    const submission = this.createSubmission(request, context);
    this.submissions.set(context.idempotencyKey, submission);
    return submission;
  }

  private createSubmission(
    request: ProviderRequest,
    context: ProviderCallContext,
  ): Promise<ProviderSubmitOutcome> {
    const stableDigest = createHash('sha256')
      .update(context.idempotencyKey)
      .update('\0')
      .update(context.requestDigest)
      .update('\0')
      .update(request.capability)
      .digest('hex');
    const providerRequestId = `fake-${stableDigest.slice(0, 32)}`;
    const receipt = { request_id_hint: providerRequestId.slice(-12), provider_status: 'accepted' };
    switch (this.scenario) {
      case 'succeeded':
        return Promise.resolve({
          kind: 'succeeded',
          provider_request_id: providerRequestId,
          receipt_summary: receipt,
          accepted_at: this.now(),
          completed_at: this.now(),
          outputs: [
            {
              provider_output_id: `output-${stableDigest.slice(32)}`,
              media_type: 'image',
              output_ref: 'fake://generated/image',
            },
          ],
          cost_summary: { currency: 'CNY', amount: '0.10', provider_units: '1' },
        });
      case 'accepted':
        return Promise.resolve({
          kind: 'accepted',
          provider_request_id: providerRequestId,
          receipt_summary: receipt,
          accepted_at: this.now(),
          poll_after_ms: 1_000,
        });
      case 'not_dispatched':
        return Promise.resolve({
          kind: 'not_dispatched',
          error_code: 'provider_unavailable',
          retryable: true,
          request_digest: context.requestDigest,
        });
      case 'failed':
        return Promise.resolve({
          kind: 'failed',
          provider_request_id: providerRequestId,
          error_code: 'provider_content_rejected',
          receipt_summary: receipt,
          failed_at: this.now(),
        });
      case 'outcome_unknown':
        return Promise.resolve({
          kind: 'outcome_unknown',
          provider_request_id: providerRequestId,
          error_code: 'provider_timeout',
          request_digest: context.requestDigest,
          unknown_at: this.now(),
        });
      case 'throw':
        return Promise.reject(new Error('Fake adapter unexpected failure'));
      case 'never':
        return new Promise(() => undefined);
    }
  }

  poll(
    input: ProviderPollInput,
    _model: ModelSnapshot,
    context: ProviderCallContext,
  ): Promise<ProviderPollOutcome> {
    if (this.scenario === 'never') return new Promise(() => undefined);
    if (this.scenario === 'outcome_unknown' || this.scenario === 'throw') {
      return Promise.resolve({
        kind: 'outcome_unknown',
        provider_request_id: input.providerRequestId,
        error_code: 'provider_timeout',
        request_digest: context.requestDigest,
        unknown_at: this.now(),
      });
    }
    if (this.scenario === 'failed') {
      return Promise.resolve({
        kind: 'failed',
        provider_request_id: input.providerRequestId,
        error_code: 'provider_internal_error',
        receipt_summary: { provider_status: 'failed' },
        failed_at: this.now(),
      });
    }
    return Promise.resolve({
      kind: 'succeeded',
      provider_request_id: input.providerRequestId,
      receipt_summary: { provider_status: 'succeeded' },
      accepted_at: this.now(),
      completed_at: this.now(),
      outputs: [
        {
          provider_output_id: `output-${createHash('sha256').update(input.providerRequestId).digest('hex')}`,
          media_type: 'image',
          output_ref: 'fake://generated/image',
        },
      ],
      cost_summary: { currency: 'CNY', amount: '0.10', provider_units: '1' },
    });
  }

  moderateText(
    _input: unknown,
    _model: ModelSnapshot,
    _context: ProviderCallContext,
  ): Promise<ModerationOutcome> {
    return this.moderationOutcome();
  }

  moderateImage(
    _input: unknown,
    _model: ModelSnapshot,
    _context: ProviderCallContext,
  ): Promise<ModerationOutcome> {
    return this.moderationOutcome();
  }

  private moderationOutcome(): Promise<ModerationOutcome> {
    if (this.scenario === 'never') return new Promise(() => undefined);
    if (this.scenario === 'outcome_unknown' || this.scenario === 'throw') {
      return Promise.resolve({
        decision: 'unknown',
        policy_version: this.moderationPolicyVersion,
        error_code: 'provider_unavailable',
      });
    }
    if (this.scenario === 'failed') {
      return Promise.resolve({
        decision: 'blocked',
        policy_version: this.moderationPolicyVersion,
        confidence: '1',
        reason_codes: ['fake_policy_match'],
      });
    }
    return Promise.resolve({
      decision: 'pass',
      policy_version: this.moderationPolicyVersion,
      confidence: '1',
    });
  }
}
