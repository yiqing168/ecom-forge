import { describe, expect, it, vi } from 'vitest';

import type { Database } from '@ecom-forge/db';

import { DrizzleMailDeliveryStore } from './drizzle-mail-delivery.store.js';
import { HmacKeyring } from '../security/hmac-keyring.js';

const recipientKeys = new HmacKeyring(`recipient-v1:${Buffer.alloc(32, 17).toString('base64url')}`);

function storeForStatus(status: string, lastErrorCode: string | null = null) {
  const findFirst = vi.fn().mockResolvedValue({
    status,
    lastErrorCode,
    providerMessageId: status === 'sent' ? 'provider-1' : null,
  });
  const database = { query: { mailDeliveries: { findFirst } } } as unknown as Database;
  return { findFirst, store: new DrizzleMailDeliveryStore(database, recipientKeys) };
}

describe('DrizzleMailDeliveryStore', () => {
  it('maps a sent delivery to an accepted result', async () => {
    const { store } = storeForStatus('sent');

    await expect(store.resultForIdempotencyKey('mail-1')).resolves.toEqual({
      state: 'accepted',
      providerMessageId: 'provider-1',
    });
  });

  it('maps a failed delivery to a definite not-dispatched result', async () => {
    const { store } = storeForStatus('failed', 'SMTP_REJECTED');

    await expect(store.resultForIdempotencyKey('mail-1')).resolves.toEqual({
      state: 'not_dispatched',
      errorCode: 'SMTP_REJECTED',
    });
  });

  it('does not treat a queued delivery as safe to rotate or resend', async () => {
    const { findFirst, store } = storeForStatus('queued');

    await expect(store.resultForIdempotencyKey('mail-1')).resolves.toEqual({
      state: 'outcome_unknown',
      errorCode: 'MAIL_DELIVERY_ALREADY_IN_PROGRESS',
    });
    expect(findFirst).toHaveBeenCalledWith(expect.anything());
  });
});
