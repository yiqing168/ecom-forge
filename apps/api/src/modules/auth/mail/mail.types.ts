import type { MailProvider, MailPurpose } from '@ecom-forge/types';

export interface VerificationMail {
  recipient: string;
  purpose: MailPurpose;
  otp: string;
  expiresInMinutes: number;
}

export type MailDispatchState = 'accepted' | 'not_dispatched' | 'outcome_unknown';

export interface MailDispatchResult {
  state: MailDispatchState;
  providerMessageId?: string;
  errorCode?: string;
}

export interface MailAdapter {
  readonly provider: MailProvider;
  sendVerificationMail(message: VerificationMail): Promise<MailDispatchResult>;
}

export interface QueuedMailDelivery {
  id: string;
  dispatchRequired: boolean;
  previousResult?: MailDispatchResult;
}

export interface QueueMailDeliveryInput {
  userId: string | null;
  recipient: string;
  purpose: MailPurpose;
  provider: MailProvider;
  idempotencyKey: string;
}

export interface MailDeliveryStore {
  queue(input: QueueMailDeliveryInput): Promise<QueuedMailDelivery>;
  complete(deliveryId: string, result: MailDispatchResult): Promise<void>;
  resultForIdempotencyKey(idempotencyKey: string): Promise<MailDispatchResult | undefined>;
  recoverStaleQueued(cutoff: Date): Promise<number>;
}
