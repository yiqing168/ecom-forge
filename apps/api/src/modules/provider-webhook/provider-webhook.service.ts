import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { and, eq, inArray, providerCallbackEvents, type Database } from '@ecom-forge/db';
import { ProviderWebhookVerificationError } from '@ecom-forge/provider';
import type {
  ProviderWebhookHeaders,
  ProviderWebhookRegistry,
  VerifiedProviderCallback,
} from '@ecom-forge/provider';
import { compositeJobId, createQueueIntentInTransaction } from '@ecom-forge/queue';

import type { CallbackDigestKeyring } from './callback-digest-keyring.js';
import {
  ProviderWebhookNotFoundError,
  ProviderWebhookRequestError,
} from './provider-webhook.errors.js';

export interface ProviderWebhookAccepted {
  accepted: true;
}

export class ProviderWebhookService {
  private readonly logger = new Logger(ProviderWebhookService.name);

  constructor(
    private readonly database: Database,
    private readonly registry: ProviderWebhookRegistry,
    private readonly digestKeys: CallbackDigestKeyring | undefined,
    private readonly clockSkewSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async accept(
    provider: string,
    rawBody: Buffer | undefined,
    headers: ProviderWebhookHeaders,
    traceId: string = randomUUID(),
  ): Promise<ProviderWebhookAccepted> {
    if (!this.registry.has(provider)) {
      this.logger.warn({
        event: 'provider_webhook_rejected',
        metric: 'provider_webhook_invalid_total',
        provider,
        trace_id: traceId,
        error_code: 'PROVIDER_WEBHOOK_NOT_FOUND',
      });
      throw new ProviderWebhookNotFoundError();
    }
    if (!rawBody) {
      this.logger.warn({
        event: 'provider_webhook_rejected',
        metric: 'provider_webhook_invalid_total',
        provider,
        trace_id: traceId,
        error_code: 'PROVIDER_WEBHOOK_BODY_MISSING',
      });
      throw new ProviderWebhookRequestError('invalid');
    }
    if (!this.digestKeys) throw new Error('Provider callback digest keyring is unavailable');

    let callback: VerifiedProviderCallback;
    try {
      callback = await this.registry.verify(provider, rawBody, headers, {
        now: this.now(),
        clockSkewSeconds: this.clockSkewSeconds,
      });
    } catch (error) {
      if (error instanceof ProviderWebhookVerificationError) {
        this.logger.warn({
          event: 'provider_webhook_rejected',
          metric: 'provider_webhook_invalid_total',
          provider,
          trace_id: traceId,
          error_code: error.code,
        });
        throw new ProviderWebhookRequestError(
          error.code === 'PROVIDER_WEBHOOK_PAYLOAD_INVALID' ? 'invalid' : 'unauthorized',
        );
      }
      throw error;
    }

    const dedupInput = callback.event_id
      ? `event:${callback.event_id}`
      : `body:${rawBody.toString('base64url')}`;
    const dedupCandidates = this.digestKeys.candidates(dedupInput);
    const bodyDigest = this.digestKeys.digest(rawBody);
    const activeDedup = dedupCandidates[0]!;

    const result = await this.database.transaction(async (transaction) => {
      const existing = await transaction.query.providerCallbackEvents.findFirst({
        where: and(
          eq(providerCallbackEvents.provider, provider),
          inArray(
            providerCallbackEvents.dedupKey,
            dedupCandidates.map((candidate) => candidate.digest),
          ),
        ),
      });
      if (existing) return 'duplicate' as const;

      const [created] = await transaction
        .insert(providerCallbackEvents)
        .values({
          provider,
          dedupKey: activeDedup.digest,
          providerEventIdHint: callback.event_id?.slice(-16),
          providerRequestId: callback.provider_request_id,
          normalizedPayloadJson: callback,
          rawSummaryJson: { schema_version: 1 },
          signatureKeyId: callback.signature_key_id,
          bodyDigest: `${bodyDigest.keyId}:${bodyDigest.digest}`,
        })
        .onConflictDoNothing({
          target: [providerCallbackEvents.provider, providerCallbackEvents.dedupKey],
        })
        .returning({ id: providerCallbackEvents.id });
      if (!created) return 'duplicate' as const;
      await createQueueIntentInTransaction(transaction, {
        queueName: 'provider-callback',
        jobId: compositeJobId({ provider_callback_event_id: created.id, processing_no: 1 }),
        aggregateType: 'provider_callback_event',
        aggregateId: created.id,
        payloadVersion: 1,
        payload: {
          schema_version: 1,
          job_type: 'provider.callback.process',
          trace_id: traceId,
          provider_callback_event_id: created.id,
          processing_no: 1,
        },
      });
      return 'accepted' as const;
    });

    this.logger.log({
      event: 'provider_webhook_accepted',
      metric:
        result === 'duplicate'
          ? 'provider_webhook_duplicate_total'
          : 'provider_webhook_valid_total',
      provider,
      trace_id: traceId,
      outcome: result,
    });

    return { accepted: true };
  }
}
