import type { BetterAuthService } from '../better-auth.service.js';
import { FakeMailAdapter } from '../mail/fake-mail.adapter.js';
import { MailService } from '../mail/mail.service.js';
import type { MailDeliveryStore } from '../mail/mail.types.js';
import type { VerificationRateLimiter } from '../rate-limit/verification-rate-limiter.js';
import { HmacKeyring } from '../security/hmac-keyring.js';
import { RegistrationGate, type RegistrationGateStore } from './registration-gate.js';
import {
  AuthMailUnavailableError,
  AuthRateLimitedError,
  RegistrationService,
} from './registration.service.js';

const secret = Buffer.alloc(32, 8).toString('base64url');
const rateLimits = {
  cooldownSeconds: 60,
  emailHourly: 5,
  emailDaily: 10,
  ipHourly: 30,
  deviceHourly: 20,
  inviteTenMinutes: 20,
  verifyIdentityTenMinutes: 10,
  verifyIpTenMinutes: 60,
  loginIdentityTenMinutes: 10,
  loginIpTenMinutes: 60,
};
const command = {
  email: 'user@example.com',
  password: 'a-long-password-value',
  displayName: '用户',
  inviteCode: 'invite-value',
  agreementVersion: '2026-08-09',
  idempotencyKey: 'register-1',
  ipBucket: '203.0.113.8',
  deviceBucket: 'signed-device-token',
};

function gateStore(replay = false): RegistrationGateStore {
  return {
    findByIdempotencyKey: () => Promise.resolve(null),
    findInviteCodeId: () => Promise.resolve('08fd2028-eeed-45d4-8a39-86ae0358e581'),
    reserve(input) {
      return Promise.resolve({
        kind: 'reserved',
        replay,
        claim: {
          id: input.claimId,
          emailHash: input.emailHash,
          requestHash: input.requestHash,
          ticketHash: input.ticketHash,
          ticketNonce: input.ticketNonce,
          ticketVersion: input.ticketVersion,
          userId: null,
          pendingEmail: input.normalizedEmail,
          pendingDisplayName: input.pendingDisplayName,
          pendingPasswordHash: input.pendingPasswordHash,
          agreementVersion: input.agreementVersion,
          expiresAt: input.expiresAt,
        },
      });
    },
  };
}

function allowedLimiter(): VerificationRateLimiter {
  return {
    consume() {
      return Promise.resolve({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
    },
    withExclusiveLock(_key, _ttlSeconds, operation) {
      return operation();
    },
  };
}

function createService(options: {
  limiter?: VerificationRateLimiter;
  adapter?: FakeMailAdapter;
  mailStore?: MailDeliveryStore;
  replay?: boolean;
}) {
  const adapter = options.adapter ?? new FakeMailAdapter();
  const mailStore =
    options.mailStore ??
    ({
      queue: () => Promise.resolve({ id: 'delivery-1', dispatchRequired: true }),
      complete: () => Promise.resolve(undefined),
      resultForIdempotencyKey: () => Promise.resolve(undefined),
      recoverStaleQueued: () => Promise.resolve(0),
    } satisfies MailDeliveryStore);
  const hashPassword = vi.fn().mockResolvedValue('better-auth-password-hash');
  const createEmailVerificationOtp = vi.fn().mockResolvedValue('123456');
  const auth = {
    hashPassword,
    createEmailVerificationOtp,
  } as unknown as BetterAuthService;
  const keys = new HmacKeyring(`v1:${secret}`);
  return {
    adapter,
    createEmailVerificationOtp,
    hashPassword,
    service: new RegistrationService(
      new RegistrationGate(gateStore(options.replay), keys, keys, keys),
      auth,
      new MailService(mailStore, adapter),
      options.limiter ?? allowedLimiter(),
      keys,
      rateLimits,
    ),
  };
}

describe('RegistrationService', () => {
  it('stores a password hash, creates OTP and queues mail without creating a user', async () => {
    const { service, adapter, createEmailVerificationOtp, hashPassword } = createService({});

    const result = await service.register(command);

    expect(result.maskedEmail).toBe('u***@example.com');
    expect(result.verificationTicket).toHaveLength(43);
    expect(createEmailVerificationOtp).toHaveBeenCalledWith('user@example.com');
    expect(hashPassword).toHaveBeenCalledWith(command.password);
    expect(adapter.messages).toHaveLength(1);
  });

  it('fails before claims, users and mail when a rate dimension is exhausted', async () => {
    const { service, adapter, hashPassword } = createService({
      limiter: {
        consume() {
          return Promise.resolve({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
        },
        withExclusiveLock(_key, _ttlSeconds, operation) {
          return operation();
        },
      },
    });

    await expect(service.register(command)).rejects.toBeInstanceOf(AuthRateLimitedError);
    expect(hashPassword).not.toHaveBeenCalled();
    expect(adapter.messages).toHaveLength(0);
  });

  it('does not claim mail success for not-dispatched or ambiguous outcomes', async () => {
    const adapter = new FakeMailAdapter();
    adapter.sendVerificationMail = vi.fn().mockResolvedValue({ state: 'outcome_unknown' });
    const { service } = createService({ adapter });

    await expect(service.register(command)).rejects.toBeInstanceOf(AuthMailUnavailableError);
  });

  it('retries the same registration only after a definite not-dispatched result', async () => {
    const queue = vi.fn().mockResolvedValue({ id: 'delivery-1', dispatchRequired: true });
    const mailStore = {
      queue,
      complete: vi.fn().mockResolvedValue(undefined),
      resultForIdempotencyKey: vi.fn().mockResolvedValue({ state: 'not_dispatched' }),
      recoverStaleQueued: vi.fn().mockResolvedValue(0),
    } satisfies MailDeliveryStore;
    const { adapter, service } = createService({ mailStore, replay: true });

    await expect(service.register(command)).resolves.toMatchObject({
      maskedEmail: 'u***@example.com',
    });
    expect(queue).toHaveBeenCalledOnce();
    expect(adapter.messages).toHaveLength(1);
  });

  it('resumes safely when a crash happened before the mail delivery row was queued', async () => {
    const queue = vi.fn().mockResolvedValue({ id: 'delivery-1', dispatchRequired: true });
    const mailStore = {
      queue,
      complete: vi.fn().mockResolvedValue(undefined),
      resultForIdempotencyKey: vi.fn().mockResolvedValue(undefined),
      recoverStaleQueued: vi.fn().mockResolvedValue(0),
    } satisfies MailDeliveryStore;
    const { adapter, service } = createService({ mailStore, replay: true });

    await expect(service.register(command)).resolves.toMatchObject({
      maskedEmail: 'u***@example.com',
    });
    expect(queue).toHaveBeenCalledOnce();
    expect(adapter.messages).toHaveLength(1);
  });

  it('does not rotate the OTP or dispatch again when a queued delivery has an unknown outcome', async () => {
    const queue = vi.fn();
    const mailStore = {
      queue,
      complete: vi.fn(),
      resultForIdempotencyKey: vi.fn().mockResolvedValue({
        state: 'outcome_unknown',
        errorCode: 'MAIL_DELIVERY_ALREADY_IN_PROGRESS',
      }),
      recoverStaleQueued: vi.fn().mockResolvedValue(0),
    } satisfies MailDeliveryStore;
    const { adapter, createEmailVerificationOtp, service } = createService({
      mailStore,
      replay: true,
    });

    await expect(service.register(command)).rejects.toBeInstanceOf(AuthMailUnavailableError);
    expect(createEmailVerificationOtp).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(adapter.messages).toHaveLength(0);
  });
});
