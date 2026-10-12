import type { MailDispatchResult } from '../mail/mail.types.js';
import type { AppConfig } from '../../../config/app-config.js';
import type { MailService } from '../mail/mail.service.js';
import {
  AuthControlPlaneUnavailableError,
  AuthExclusiveLockBusyError,
  emailVerificationRateLimitSubject,
  registrationInviteRateLimitSubject,
  type VerificationRateLimiter,
} from '../rate-limit/verification-rate-limiter.js';
import type { HmacKeyring } from '../security/hmac-keyring.js';
import { isBlockedRegistrationEmail, normalizeEmail } from '../security/email.js';
import type { BetterAuthService } from '../better-auth.service.js';
import { RegistrationNotEligibleError } from './registration-gate.js';
import type {
  RegistrationGate,
  RegistrationPayload,
  RegistrationReservation,
} from './registration-gate.js';

export class AuthRateLimitedError extends Error {
  constructor() {
    super('Authentication request was rate limited');
    this.name = 'AuthRateLimitedError';
  }
}

export class AuthMailUnavailableError extends Error {
  readonly result: MailDispatchResult;

  constructor(result: MailDispatchResult) {
    super('Authentication mail is unavailable');
    this.name = 'AuthMailUnavailableError';
    this.result = result;
  }
}

export interface RegisterCommand extends RegistrationPayload {
  idempotencyKey: string;
  ipBucket: string;
  deviceBucket: string;
}

export interface RegisterResult {
  verificationTicket: string;
  maskedEmail: string;
  expiresInSeconds: number;
  resendCooldownSeconds: number;
  headers: Headers;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local?.slice(0, 1) ?? '*'}***@${domain ?? 'invalid'}`;
}

export class RegistrationService {
  constructor(
    private readonly gate: RegistrationGate,
    private readonly auth: BetterAuthService,
    private readonly mail: MailService,
    private readonly limiter: VerificationRateLimiter,
    private readonly rateLimitKeys: HmacKeyring,
    private readonly rateLimits: AppConfig['auth']['rateLimits'],
  ) {}

  async register(command: RegisterCommand): Promise<RegisterResult> {
    const normalizedEmail = normalizeEmail(command.email);
    const replay = await this.gate.replay(command, command.idempotencyKey);
    if (replay) {
      return this.withRegistrationLock(replay.claim.id, () =>
        this.completeRegistration(command, replay),
      );
    }
    const emailIdentity = this.rateLimitKeys.digest(
      emailVerificationRateLimitSubject(normalizedEmail),
    ).digest;
    const ipIdentity = this.rateLimitKeys.digest(
      emailVerificationRateLimitSubject(command.ipBucket),
    ).digest;
    const deviceIdentity = this.rateLimitKeys.digest(
      emailVerificationRateLimitSubject(command.deviceBucket),
    ).digest;
    const limits = await Promise.all([
      this.limiter.consume(`auth:otp:window:register:${emailIdentity}:1h`, {
        max: this.rateLimits.emailHourly,
        windowSeconds: 3600,
      }),
      this.limiter.consume(`auth:otp:window:register:${emailIdentity}:24h`, {
        max: this.rateLimits.emailDaily,
        windowSeconds: 86_400,
      }),
      this.limiter.consume(`auth:otp:ip:register:${ipIdentity}:1h`, {
        max: this.rateLimits.ipHourly,
        windowSeconds: 3600,
      }),
      this.limiter.consume(`auth:otp:device:register:${deviceIdentity}:1h`, {
        max: this.rateLimits.deviceHourly,
        windowSeconds: 3600,
      }),
    ]);
    if (limits.some((result) => !result.allowed)) {
      throw new AuthRateLimitedError();
    }
    if (isBlockedRegistrationEmail(normalizedEmail)) {
      throw new RegistrationNotEligibleError();
    }

    const inviteCodeId = await this.gate.findInviteCodeId(command.inviteCode);
    if (!inviteCodeId) throw new RegistrationNotEligibleError();
    const inviteIdentity = this.rateLimitKeys.digest(
      registrationInviteRateLimitSubject(inviteCodeId),
    ).digest;
    const inviteLimit = await this.limiter.consume(`auth:invite:window:${inviteIdentity}:10m`, {
      max: this.rateLimits.inviteTenMinutes,
      windowSeconds: 600,
    });
    if (!inviteLimit.allowed) throw new AuthRateLimitedError();

    const passwordHash = await this.auth.hashPassword(command.password);
    const reservation = await this.gate.reserve(command, command.idempotencyKey, passwordHash);
    return this.withRegistrationLock(reservation.claim.id, () =>
      this.completeRegistration(command, reservation),
    );
  }

  private async withRegistrationLock<T>(claimId: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await this.limiter.withExclusiveLock(`auth:register:claim:${claimId}`, 30, operation);
    } catch (error) {
      if (error instanceof AuthExclusiveLockBusyError) {
        throw new AuthControlPlaneUnavailableError();
      }
      throw error;
    }
  }

  private async completeRegistration(
    _command: RegisterCommand,
    reservation: RegistrationReservation,
  ): Promise<RegisterResult> {
    if (reservation.replay) {
      const idempotencyKey = `register:${reservation.claim.id}:v${reservation.claim.ticketVersion}`;
      const previousMail = await this.mail.resultForIdempotencyKey(idempotencyKey);
      if (!previousMail || previousMail.state === 'not_dispatched') {
        const otp = await this.auth.createEmailVerificationOtp(reservation.normalizedEmail);
        const retry = await this.mail.deliverVerification({
          userId: null,
          recipient: reservation.normalizedEmail,
          purpose: 'email_verification',
          otp,
          expiresInMinutes: 10,
          idempotencyKey,
        });
        if (retry.state === 'accepted') {
          await this.recordResendCooldown(reservation.normalizedEmail);
          return {
            verificationTicket: reservation.verificationTicket,
            maskedEmail: maskEmail(reservation.normalizedEmail),
            expiresInSeconds: 600,
            resendCooldownSeconds: this.rateLimits.cooldownSeconds,
            headers: new Headers(),
          };
        }
        if (retry.state === 'outcome_unknown') {
          await this.recordResendCooldown(reservation.normalizedEmail);
        }
        throw new AuthMailUnavailableError(retry);
      }
      if (previousMail.state !== 'accepted') {
        if (previousMail.state === 'outcome_unknown') {
          await this.recordResendCooldown(reservation.normalizedEmail);
        }
        throw new AuthMailUnavailableError(previousMail);
      }
      await this.recordResendCooldown(reservation.normalizedEmail);
      return {
        verificationTicket: reservation.verificationTicket,
        maskedEmail: maskEmail(reservation.normalizedEmail),
        expiresInSeconds: 600,
        resendCooldownSeconds: this.rateLimits.cooldownSeconds,
        headers: new Headers(),
      };
    }

    const otp = await this.auth.createEmailVerificationOtp(reservation.normalizedEmail);
    const mailResult = await this.mail.deliverVerification({
      userId: null,
      recipient: reservation.normalizedEmail,
      purpose: 'email_verification',
      otp,
      expiresInMinutes: 10,
      idempotencyKey: `register:${reservation.claim.id}:v${reservation.claim.ticketVersion}`,
    });
    if (mailResult.state !== 'not_dispatched') {
      await this.recordResendCooldown(reservation.normalizedEmail);
    }
    if (mailResult.state !== 'accepted') {
      throw new AuthMailUnavailableError(mailResult);
    }

    return {
      verificationTicket: reservation.verificationTicket,
      maskedEmail: maskEmail(reservation.normalizedEmail),
      expiresInSeconds: 600,
      resendCooldownSeconds: this.rateLimits.cooldownSeconds,
      headers: new Headers(),
    };
  }

  private async recordResendCooldown(email: string): Promise<void> {
    const emailIdentity = this.rateLimitKeys.digest(
      emailVerificationRateLimitSubject(email),
    ).digest;
    await this.limiter.consume(`auth:otp:cooldown:email_verification:${emailIdentity}`, {
      max: 1,
      windowSeconds: this.rateLimits.cooldownSeconds,
    });
  }
}
