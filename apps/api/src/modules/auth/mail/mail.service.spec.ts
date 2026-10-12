import { MailService } from './mail.service.js';
import type {
  MailAdapter,
  MailDeliveryStore,
  MailDispatchResult,
  QueueMailDeliveryInput,
  VerificationMail,
} from './mail.types.js';

function createStore(events: string[]): MailDeliveryStore {
  return {
    queue: (_input: QueueMailDeliveryInput) => {
      events.push('queued');
      return Promise.resolve({ id: 'delivery-1', dispatchRequired: true });
    },
    complete: (_deliveryId: string, result: MailDispatchResult) => {
      events.push(`completed:${result.state}`);
      return Promise.resolve();
    },
    resultForIdempotencyKey: () => Promise.resolve(undefined),
    recoverStaleQueued: () => Promise.resolve(0),
  };
}

const input = {
  userId: '7e5e910a-3fee-4bf8-9605-85f1709fd15a',
  recipient: 'user@example.com',
  purpose: 'email_verification' as const,
  otp: '123456',
  expiresInMinutes: 10,
  idempotencyKey: 'mail:register:1',
};

describe('MailService', () => {
  it('exposes stale queued recovery without dispatching another message', async () => {
    const recoverStaleQueued = vi.fn().mockResolvedValue(2);
    const queue = vi.fn();
    const store: MailDeliveryStore = {
      queue,
      complete: vi.fn(),
      resultForIdempotencyKey: vi.fn(),
      recoverStaleQueued,
    };

    await expect(
      new MailService(store, {
        provider: 'fake',
        sendVerificationMail: vi.fn(),
      }).recoverStaleQueued(new Date()),
    ).resolves.toBe(2);
    expect(recoverStaleQueued).toHaveBeenCalledOnce();
    expect(queue).not.toHaveBeenCalled();
  });

  it('persists queued before performing network IO', async () => {
    const events: string[] = [];
    const adapter: MailAdapter = {
      provider: 'fake',
      sendVerificationMail: (_message: VerificationMail) => {
        events.push('adapter');
        return Promise.resolve({ state: 'accepted', providerMessageId: 'fake-1' });
      },
    };

    const result = await new MailService(createStore(events), adapter).deliverVerification(input);

    expect(result.state).toBe('accepted');
    expect(events).toEqual(['queued', 'adapter', 'completed:accepted']);
  });

  it('records an explicit not-dispatched result without claiming success', async () => {
    const events: string[] = [];
    const adapter: MailAdapter = {
      provider: 'fake',
      sendVerificationMail: () =>
        Promise.resolve({ state: 'not_dispatched', errorCode: 'MAIL_REJECTED' }),
    };

    const result = await new MailService(createStore(events), adapter).deliverVerification(input);

    expect(result).toEqual({ state: 'not_dispatched', errorCode: 'MAIL_REJECTED' });
    expect(events).toEqual(['queued', 'completed:not_dispatched']);
  });

  it('converges an unexpected adapter throw to outcome_unknown', async () => {
    const events: string[] = [];
    const adapter: MailAdapter = {
      provider: 'fake',
      sendVerificationMail: () => Promise.reject(new Error('socket disappeared after write')),
    };

    const result = await new MailService(createStore(events), adapter).deliverVerification(input);

    expect(result.state).toBe('outcome_unknown');
    expect(events).toEqual(['queued', 'completed:outcome_unknown']);
  });

  it('does not dispatch an idempotent delivery twice', async () => {
    const sendVerificationMail = vi.fn();
    const complete = vi.fn();
    const store: MailDeliveryStore = {
      queue: () =>
        Promise.resolve({
          id: 'delivery-1',
          dispatchRequired: false,
          previousResult: { state: 'accepted', providerMessageId: 'existing-message' },
        }),
      complete,
      resultForIdempotencyKey: vi.fn(),
      recoverStaleQueued: vi.fn(),
    };

    const result = await new MailService(store, {
      provider: 'fake',
      sendVerificationMail,
    }).deliverVerification(input);

    expect(result).toEqual({ state: 'accepted', providerMessageId: 'existing-message' });
    expect(sendVerificationMail).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
