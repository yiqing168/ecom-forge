import type { Database } from '@ecom-forge/db';

import type { BetterAuthService, VerificationOtpSnapshot } from './better-auth.service.js';
import type { MailService } from './mail/mail.service.js';
import { AuthControlPlaneUnavailableError } from './rate-limit/verification-rate-limiter.js';
import type { VerificationRateLimiter } from './rate-limit/verification-rate-limiter.js';
import { AuthenticationService } from './authentication.service.js';
import { HmacKeyring } from './security/hmac-keyring.js';
import type { AuthActivityService } from './auth-activity.service.js';

const secret = Buffer.alloc(32, 21).toString('base64url');
const context = { ipBucket: '203.0.113.8', deviceBucket: 'signed-device-token' };
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
const snapshot: VerificationOtpSnapshot = {
  id: 'verification-1',
  identifier: 'identifier-hash',
  value: 'otp-hash:0',
  expiresAt: new Date(Date.now() + 300_000),
  createdAt: new Date(),
};

function harness(options: {
  emailVerifiedAt?: Date | null;
  limiterError?: Error;
  mailState?: 'accepted' | 'not_dispatched' | 'outcome_unknown';
  userExists?: boolean;
}) {
  const findFirst = vi.fn().mockResolvedValue(
    options.userExists === false
      ? undefined
      : {
          id: 'user-1',
          email: 'user@example.com',
          emailVerifiedAt: options.emailVerifiedAt ?? null,
        },
  );
  const database = { query: { users: { findFirst } } } as unknown as Database;
  const createPasswordResetOtp = vi.fn().mockResolvedValue('123456');
  const snapshotPasswordResetOtp = vi.fn().mockResolvedValue(snapshot);
  const restorePasswordResetOtp = vi.fn().mockResolvedValue(undefined);
  const auth = {
    createPasswordResetOtp,
    snapshotPasswordResetOtp,
    restorePasswordResetOtp,
  } as unknown as BetterAuthService;
  const deliverVerification = vi.fn().mockResolvedValue({
    state: options.mailState ?? 'accepted',
  });
  const mail = { deliverVerification } as unknown as MailService;
  const consume = options.limiterError
    ? vi.fn().mockRejectedValue(options.limiterError)
    : vi.fn().mockResolvedValue({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
  const limiter: VerificationRateLimiter = {
    consume,
    withExclusiveLock: (_key, _ttlSeconds, operation) => operation(),
  };
  const service = new AuthenticationService(
    database,
    auth,
    mail,
    limiter,
    new HmacKeyring(`rate-v1:${secret}`),
    rateLimits,
    0,
    { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuthActivityService,
  );
  return {
    createPasswordResetOtp,
    deliverVerification,
    findFirst,
    restorePasswordResetOtp,
    service,
  };
}

describe('AuthenticationService password reset request', () => {
  it('returns the generic result without creating an OTP or mail for an unknown account', async () => {
    const { createPasswordResetOtp, deliverVerification, service } = harness({
      userExists: false,
    });

    await expect(service.requestPasswordReset('unknown@example.com', context)).resolves.toEqual({
      mailAccepted: false,
    });
    expect(createPasswordResetOtp).not.toHaveBeenCalled();
    expect(deliverVerification).not.toHaveBeenCalled();
  });

  it('returns a generic result without creating an OTP for an unverified account', async () => {
    const { createPasswordResetOtp, deliverVerification, service } = harness({
      emailVerifiedAt: null,
    });

    await expect(service.requestPasswordReset('user@example.com', context)).resolves.toEqual({
      mailAccepted: false,
    });
    expect(createPasswordResetOtp).not.toHaveBeenCalled();
    expect(deliverVerification).not.toHaveBeenCalled();
  });

  it('fails closed when the Redis control plane is unavailable', async () => {
    const { findFirst, service } = harness({
      limiterError: new AuthControlPlaneUnavailableError(),
    });

    await expect(service.requestPasswordReset('user@example.com', context)).rejects.toBeInstanceOf(
      AuthControlPlaneUnavailableError,
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('restores the previous OTP when a replacement mail was definitely not dispatched', async () => {
    const { restorePasswordResetOtp, service } = harness({
      emailVerifiedAt: new Date(),
      mailState: 'not_dispatched',
    });

    await expect(service.requestPasswordReset('user@example.com', context)).resolves.toEqual({
      mailAccepted: false,
    });
    expect(restorePasswordResetOtp).toHaveBeenCalledWith(snapshot);
  });
});
