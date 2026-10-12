import type { BetterAuthService, VerificationOtpSnapshot } from '../better-auth.service.js';
import type { AuthActivityService } from '../auth-activity.service.js';
import { AuthOtpAttemptsExceededError } from '../auth-errors.js';
import type { MailService } from '../mail/mail.service.js';
import {
  AuthControlPlaneUnavailableError,
  AuthExclusiveLockBusyError,
  type VerificationRateLimiter,
} from '../rate-limit/verification-rate-limiter.js';
import { HmacKeyring } from '../security/hmac-keyring.js';
import type { AuthIdempotencyBegin, AuthIdempotencyStore } from './auth-idempotency.store.js';
import type {
  RegistrationClaimQueryStore,
  VerificationClaim,
} from './registration-claim-query.store.js';
import type { RegistrationFinalizer } from './registration-finalizer.js';
import { AuthMailUnavailableError } from './registration.service.js';
import { lookupSeed, ticketSeed } from './registration-gate.js';
import { RegistrationVerificationService } from './verification.service.js';

const secret = Buffer.alloc(32, 12).toString('base64url');
const keys = new HmacKeyring(`v1:${secret}`);
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
const claim: VerificationClaim = {
  id: '48dc4bd0-c8cc-40e2-917a-f8dd5c6a33ad',
  inviteCodeId: '08fd2028-eeed-45d4-8a39-86ae0358e581',
  userId: null,
  email: 'user@example.com',
  displayName: 'User',
  passwordHash: 'better-auth-password-hash',
  agreementVersion: '2026-08-09',
  ticketHash: 'ticket-hash',
  ticketNonce: 'ticket-nonce',
  ticketVersion: 1,
  expiresAt: new Date(Date.now() + 600_000),
};
const context = { ipBucket: '203.0.113.8', deviceBucket: 'signed-device-token' };
const otpSnapshot: VerificationOtpSnapshot = {
  id: 'verification-1',
  identifier: 'identifier-hash',
  value: 'otp-hash:0',
  expiresAt: new Date(Date.now() + 300_000),
  createdAt: new Date(),
};

function harness(
  options: {
    mailState?: 'accepted' | 'not_dispatched' | 'outcome_unknown';
    verificationError?: Error;
    verificationClaim?: VerificationClaim;
    idempotencyBegin?: AuthIdempotencyBegin;
    limiter?: VerificationRateLimiter;
  } = {},
) {
  const activeClaim = options.verificationClaim ?? claim;
  const createEmailVerificationOtp = vi.fn().mockResolvedValue('654321');
  const restoreEmailVerificationOtp = vi.fn().mockResolvedValue(undefined);
  const snapshotEmailVerificationOtp = vi.fn().mockResolvedValue(otpSnapshot);
  const issueSession = vi.fn().mockResolvedValue({
    user: {
      id: '8cc90bf1-688c-4054-85f1-dcd4d4288820',
      email: claim.email,
      displayName: 'User',
      emailVerified: true,
    },
    headers: new Headers(),
  });
  const findByTicket = vi.fn().mockResolvedValue(activeClaim);
  const invalidateTicket = vi.fn().mockResolvedValue(undefined);
  const rotateTicket = vi.fn().mockResolvedValue(true);
  const claims = {
    findByTicket,
    invalidateTicket,
    rotateTicket,
  } satisfies RegistrationClaimQueryStore;
  const auth = {
    createEmailVerificationOtp,
    restoreEmailVerificationOtp,
    snapshotEmailVerificationOtp,
    issueSession,
  } as unknown as BetterAuthService;
  const deliverVerification = vi.fn().mockResolvedValue({
    state: options.mailState ?? 'accepted',
  });
  const mail = {
    deliverVerification,
  } as unknown as MailService;
  const limiter: VerificationRateLimiter = options.limiter ?? {
    consume: vi.fn().mockResolvedValue({ allowed: true, remaining: 1, retryAfterSeconds: 0 }),
    withExclusiveLock<T>(_key: string, _ttlSeconds: number, operation: () => Promise<T>) {
      return operation();
    },
  };
  const completePendingRegistration = options.verificationError
    ? vi.fn().mockRejectedValue(options.verificationError)
    : vi.fn().mockResolvedValue({
        kind: 'completed',
        user: {
          id: '8cc90bf1-688c-4054-85f1-dcd4d4288820',
          email: claim.email,
          displayName: 'User',
          emailVerified: true,
        },
        reward: 'granted',
      });
  const finalizer = {
    completePendingRegistration,
  } as unknown as RegistrationFinalizer;
  const begin = vi
    .fn()
    .mockResolvedValue(options.idempotencyBegin ?? { kind: 'acquired', owner: 'owner-1' });
  const complete = vi.fn().mockResolvedValue(undefined);
  const fail = vi.fn().mockResolvedValue(undefined);
  const release = vi.fn().mockResolvedValue(undefined);
  const idempotency: AuthIdempotencyStore = {
    begin,
    complete,
    fail,
    release,
  };
  return {
    begin,
    complete,
    createEmailVerificationOtp,
    deliverVerification,
    fail,
    completePendingRegistration,
    findByTicket,
    invalidateTicket,
    restoreEmailVerificationOtp,
    rotateTicket,
    snapshotEmailVerificationOtp,
    issueSession,
    service: new RegistrationVerificationService(
      claims,
      auth,
      mail,
      limiter,
      keys,
      keys,
      finalizer,
      idempotency,
      rateLimits,
      { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuthActivityService,
    ),
  };
}

describe('RegistrationVerificationService', () => {
  it('atomically completes registration before issuing the session', async () => {
    const { completePendingRegistration, issueSession, service } = harness();

    const result = await service.verify('current-ticket', '123456', context);

    expect(result.user.emailVerified).toBe(true);
    expect(completePendingRegistration).toHaveBeenCalledWith(claim.id, '123456');
    expect(issueSession).toHaveBeenCalledWith('8cc90bf1-688c-4054-85f1-dcd4d4288820');
  });

  it('maps normal verification lock contention to an already-consumed OTP response', async () => {
    const { service, completePendingRegistration } = harness({
      limiter: {
        consume: vi.fn().mockResolvedValue({ allowed: true, remaining: 1, retryAfterSeconds: 0 }),
        withExclusiveLock: vi.fn().mockRejectedValue(new AuthExclusiveLockBusyError()),
      },
    });

    await expect(service.verify('current-ticket', '123456', context)).rejects.toThrow(
      'The verification code is invalid or expired',
    );
    expect(completePendingRegistration).not.toHaveBeenCalled();
  });

  it('preserves a real Redis failure as control-plane unavailable', async () => {
    const { service } = harness({
      limiter: {
        consume: vi.fn().mockResolvedValue({ allowed: true, remaining: 1, retryAfterSeconds: 0 }),
        withExclusiveLock: vi.fn().mockRejectedValue(new AuthControlPlaneUnavailableError()),
      },
    });

    await expect(service.verify('current-ticket', '123456', context)).rejects.toBeInstanceOf(
      AuthControlPlaneUnavailableError,
    );
  });

  it('surfaces an exhausted OTP without creating a session', async () => {
    const { issueSession, service, completePendingRegistration } = harness();
    completePendingRegistration.mockResolvedValueOnce({ kind: 'attempts_exhausted' });

    await expect(service.verify('current-ticket', '000000', context)).rejects.toBeInstanceOf(
      AuthOtpAttemptsExceededError,
    );
    expect(issueSession).not.toHaveBeenCalled();
  });

  it('rotates the ticket only after the replacement email is accepted', async () => {
    const { complete, restoreEmailVerificationOtp, rotateTicket, service } = harness();

    const result = await service.resend('current-ticket', 'resend-1', context);

    expect(result.verificationTicket).toHaveLength(43);
    expect(rotateTicket).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
    expect(restoreEmailVerificationOtp).not.toHaveBeenCalled();
  });

  it('restores the previous OTP and keeps the ticket when mail is not dispatched', async () => {
    const { fail, restoreEmailVerificationOtp, rotateTicket, service } = harness({
      mailState: 'not_dispatched',
    });

    await expect(service.resend('current-ticket', 'resend-1', context)).rejects.toBeInstanceOf(
      AuthMailUnavailableError,
    );
    expect(restoreEmailVerificationOtp).toHaveBeenCalledWith(otpSnapshot);
    expect(rotateTicket).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledOnce();
  });

  it('keeps resend fail-closed when another request owns the verification lock', async () => {
    const { deliverVerification, service } = harness({
      limiter: {
        consume: vi.fn().mockResolvedValue({ allowed: true, remaining: 1, retryAfterSeconds: 0 }),
        withExclusiveLock: vi.fn().mockRejectedValue(new AuthExclusiveLockBusyError()),
      },
    });

    await expect(service.resend('current-ticket', 'resend-busy', context)).rejects.toBeInstanceOf(
      AuthControlPlaneUnavailableError,
    );
    expect(deliverVerification).not.toHaveBeenCalled();
  });

  it('replays a completed resend without looking up the old ticket or sending mail again', async () => {
    const ticketVersion = 2;
    const ticketNonce = 'replay-nonce';
    const verificationTicket = keys.digest(ticketSeed(claim.id, ticketVersion, ticketNonce)).digest;
    const replay = {
      claimId: claim.id,
      ticketHash: keys.digest(lookupSeed(verificationTicket)).digest,
      ticketNonce,
      ticketVersion,
    };
    const { createEmailVerificationOtp, deliverVerification, findByTicket, service } = harness({
      idempotencyBegin: { kind: 'completed', result: replay },
    });

    await expect(service.resend('old-ticket', 'resend-replay', context)).resolves.toEqual({
      verificationTicket,
      expiresInSeconds: 600,
      resendCooldownSeconds: 60,
    });
    expect(findByTicket).not.toHaveBeenCalled();
    expect(createEmailVerificationOtp).not.toHaveBeenCalled();
    expect(deliverVerification).not.toHaveBeenCalled();
  });

  it('expires a claim and clears its ticket when its server-side deadline passes', async () => {
    const expiredClaim = { ...claim, expiresAt: new Date(Date.now() - 1) };
    const { invalidateTicket, service } = harness({ verificationClaim: expiredClaim });

    await expect(service.verify('expired-ticket', '123456', context)).rejects.toThrow(
      'The verification context is invalid',
    );
    expect(invalidateTicket).toHaveBeenCalledWith(claim.id, expect.any(Array));
  });
});
