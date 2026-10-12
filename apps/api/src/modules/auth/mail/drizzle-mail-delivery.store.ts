import { and, eq, lt, mailDeliveries, type Database } from '@ecom-forge/db';

import type { HmacKeyring } from '../security/hmac-keyring.js';
import type {
  MailDeliveryStore,
  MailDispatchResult,
  QueueMailDeliveryInput,
  QueuedMailDelivery,
} from './mail.types.js';

function previousResult(row: typeof mailDeliveries.$inferSelect): MailDispatchResult | undefined {
  if (row.status === 'queued') {
    return {
      state: 'outcome_unknown',
      errorCode: 'MAIL_DELIVERY_ALREADY_IN_PROGRESS',
    };
  }
  if (row.status === 'sent' || row.status === 'delivered') {
    return {
      state: 'accepted',
      ...(row.providerMessageId ? { providerMessageId: row.providerMessageId } : {}),
    };
  }
  if (row.status === 'failed') {
    return {
      state: 'not_dispatched',
      ...(row.lastErrorCode ? { errorCode: row.lastErrorCode } : {}),
    };
  }
  if (row.status === 'outcome_unknown') {
    return {
      state: 'outcome_unknown',
      ...(row.lastErrorCode ? { errorCode: row.lastErrorCode } : {}),
    };
  }
  return undefined;
}

export class DrizzleMailDeliveryStore implements MailDeliveryStore {
  constructor(
    private readonly database: Database,
    private readonly recipientKeys: HmacKeyring,
  ) {}

  async queue(input: QueueMailDeliveryInput): Promise<QueuedMailDelivery> {
    const existing = await this.database.query.mailDeliveries.findFirst({
      where: eq(mailDeliveries.idempotencyKey, input.idempotencyKey),
    });
    if (existing) {
      if (existing.status === 'failed') {
        const [retried] = await this.database
          .update(mailDeliveries)
          .set({
            status: 'queued',
            attemptCount: existing.attemptCount + 1,
            lastErrorCode: null,
            updatedAt: new Date(),
          })
          .where(and(eq(mailDeliveries.id, existing.id), eq(mailDeliveries.status, 'failed')))
          .returning({ id: mailDeliveries.id });
        if (retried) return { id: retried.id, dispatchRequired: true };
      }
      const result = previousResult(existing);
      return {
        id: existing.id,
        dispatchRequired: false,
        ...(result ? { previousResult: result } : {}),
      };
    }

    const recipientHash = this.recipientKeys.digest(input.recipient);
    const [created] = await this.database
      .insert(mailDeliveries)
      .values({
        userId: input.userId,
        recipientHash: recipientHash.digest,
        recipientHashKeyId: recipientHash.keyId,
        purpose: input.purpose,
        provider: input.provider,
        idempotencyKey: input.idempotencyKey,
        attemptCount: 1,
      })
      .onConflictDoNothing({ target: mailDeliveries.idempotencyKey })
      .returning();
    if (created) {
      return { id: created.id, dispatchRequired: true };
    }

    const raced = await this.database.query.mailDeliveries.findFirst({
      where: eq(mailDeliveries.idempotencyKey, input.idempotencyKey),
    });
    if (!raced) {
      throw new Error('Mail delivery idempotency race did not converge');
    }
    const result = previousResult(raced);
    return {
      id: raced.id,
      dispatchRequired: false,
      ...(result ? { previousResult: result } : {}),
    };
  }

  async complete(deliveryId: string, result: MailDispatchResult): Promise<void> {
    const status =
      result.state === 'accepted'
        ? 'sent'
        : result.state === 'not_dispatched'
          ? 'failed'
          : 'outcome_unknown';
    await this.database
      .update(mailDeliveries)
      .set({
        status,
        providerMessageId: result.providerMessageId ?? null,
        lastErrorCode: result.errorCode ?? null,
        updatedAt: new Date(),
      })
      .where(eq(mailDeliveries.id, deliveryId));
  }

  async resultForIdempotencyKey(idempotencyKey: string): Promise<MailDispatchResult | undefined> {
    const delivery = await this.database.query.mailDeliveries.findFirst({
      where: eq(mailDeliveries.idempotencyKey, idempotencyKey),
    });
    return delivery ? previousResult(delivery) : undefined;
  }

  async recoverStaleQueued(cutoff: Date): Promise<number> {
    const recovered = await this.database
      .update(mailDeliveries)
      .set({
        status: 'outcome_unknown',
        lastErrorCode: 'MAIL_RECOVERY_OUTCOME_UNKNOWN',
        updatedAt: new Date(),
      })
      .where(and(eq(mailDeliveries.status, 'queued'), lt(mailDeliveries.updatedAt, cutoff)))
      .returning({ id: mailDeliveries.id });
    return recovered.length;
  }
}
