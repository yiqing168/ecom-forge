import type {
  MailAdapter,
  MailDeliveryStore,
  MailDispatchResult,
  QueueMailDeliveryInput,
  VerificationMail,
} from './mail.types.js';

export interface DeliverVerificationMailInput extends VerificationMail {
  userId: string | null;
  idempotencyKey: string;
}

export class MailService {
  constructor(
    private readonly store: MailDeliveryStore,
    private readonly adapter: MailAdapter,
  ) {}

  async resultForIdempotencyKey(idempotencyKey: string): Promise<MailDispatchResult | undefined> {
    return this.store.resultForIdempotencyKey(idempotencyKey);
  }

  async recoverStaleQueued(cutoff: Date): Promise<number> {
    return this.store.recoverStaleQueued(cutoff);
  }

  async deliverVerification(input: DeliverVerificationMailInput): Promise<MailDispatchResult> {
    const queueInput: QueueMailDeliveryInput = {
      userId: input.userId,
      recipient: input.recipient,
      purpose: input.purpose,
      provider: this.adapter.provider,
      idempotencyKey: input.idempotencyKey,
    };
    const delivery = await this.store.queue(queueInput);
    if (!delivery.dispatchRequired) {
      return (
        delivery.previousResult ?? {
          state: 'outcome_unknown',
          errorCode: 'MAIL_DELIVERY_ALREADY_IN_PROGRESS',
        }
      );
    }

    let result: MailDispatchResult;
    try {
      result = await this.adapter.sendVerificationMail(input);
    } catch {
      result = { state: 'outcome_unknown', errorCode: 'MAIL_ADAPTER_UNEXPECTED_FAILURE' };
    }

    await this.store.complete(delivery.id, result);
    return result;
  }
}
