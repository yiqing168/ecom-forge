import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../../../config/app-config.js';

import type { BetterAuthService } from '../better-auth.service.js';
import {
  AuthOtpAttemptsExceededError,
  AuthOtpInvalidError,
  VerificationTicketInvalidError,
} from '../auth-errors.js';
import type { MailService } from '../mail/mail.service.js';
import {
  AuthControlPlaneUnavailableError,
  AuthExclusiveLockBusyError,
  emailVerificationRateLimitSubject,
  registrationInviteRateLimitSubject,
  type VerificationRateLimiter,
} from '../rate-limit/verification-rate-limiter.js';
import type { HmacKeyring } from '../security/hmac-keyring.js';
import type { AuthIdempotencyStore, RegistrationResendReplay } from './auth-idempotency.store.js';
import { AuthMailUnavailableError, AuthRateLimitedError } from './registration.service.js';
import { IdempotencyConflictError, ticketSeed, lookupSeed } from './registration-gate.js';
import type { RegistrationClaimQueryStore } from './registration-claim-query.store.js';
import type { RegistrationFinalizer } from './registration-finalizer.js';
import type { AuthActivityService } from '../auth-activity.service.js';

export interface VerificationContext {
  ipBucket: string;
  deviceBucket: string;
}

export interface VerificationResult {
  user: { id: string; email: string; displayName: string; emailVerified: boolean };
  headers: Headers;
}

export class RegistrationVerificationService {
  constructor(
    private readonly claims: RegistrationClaimQueryStore,
    private readonly auth: BetterAuthService,
    private readonly mail: MailService,
    private readonly limiter: VerificationRateLimiter,
    private readonly rateLimitKeys: HmacKeyring,
    private readonly ticketKeys: HmacKeyring,
    private readonly finalizer: RegistrationFinalizer,
    private readonly idempotency: AuthIdempotencyStore,
    private readonly rateLimits: AppConfig['auth']['rateLimits'],
    private readonly activity: AuthActivityService,
  ) {}

  async verify(
    ticket: string,
    code: string,
    context: VerificationContext,
  ): Promise<VerificationResult> {
    const claim = await this.claims.findByTicket(ticket);
    if (!claim || claim.expiresAt.getTime() <= Date.now()) {
      if (claim) await this.invalidateClaimTicket(claim.id, ticket);
      throw new VerificationTicketInvalidError();
    }
    await this.consumeVerificationLimits(claim.email, context.ipBucket);
    const emailIdentity = this.rateLimitKeys.digest(
      emailVerificationRateLimitSubject(claim.email),
    ).digest;
    try {
      return await this.limiter.withExclusiveLock(
        `auth:verify:lock:email_verification:${emailIdentity}`,
        30,
        async () => {
          const currentClaim = await this.claims.findByTicket(ticket);
          if (!currentClaim || currentClaim.id !== claim.id) {
            throw new AuthOtpInvalidError();
          }
          const completion = await this.finalizer.completePendingRegistration(
            currentClaim.id,
            code,
          );
          if (completion.kind === 'invalid_claim') throw new VerificationTicketInvalidError();
          if (completion.kind === 'attempts_exhausted') {
            throw new AuthOtpAttemptsExceededError();
          }
          if (completion.kind === 'invalid_otp') throw new AuthOtpInvalidError();

          const session = await this.auth.issueSession(completion.user.id);
          await Promise.all([
            this.activity.record({
              activityType: 'email_verify',
              userId: completion.user.id,
              targetType: 'registration_claim',
              targetId: currentClaim.id,
              context,
            }),
            this.activity.record({
              activityType: 'register',
              userId: completion.user.id,
              targetType: 'registration_claim',
              targetId: currentClaim.id,
              context,
            }),
          ]);
          return { user: session.user, headers: session.headers };
        },
      );
    } catch (error) {
      if (error instanceof AuthExclusiveLockBusyError) throw new AuthOtpInvalidError();
      throw error;
    }
  }

  async resend(
    ticket: string,
    idempotencyKey: string,
    context: VerificationContext,
  ): Promise<{
    verificationTicket: string;
    expiresInSeconds: number;
    resendCooldownSeconds: number;
  }> {
    const keyHash = this.rateLimitKeys.digest(
      `verification-resend-idempotency\0${idempotencyKey}`,
    ).digest;
    const requestHash = this.rateLimitKeys.digest(`verification-resend-payload\0${ticket}`).digest;
    const idempotencyStoreKey = `auth:idempotency:email-verification-request:${keyHash}`;
    const idempotencyResult = await this.idempotency.begin(idempotencyStoreKey, requestHash, 600);
    if (idempotencyResult.kind === 'conflict') throw new IdempotencyConflictError();
    if (idempotencyResult.kind === 'pending') {
      throw new AuthControlPlaneUnavailableError();
    }
    if (idempotencyResult.kind === 'failed') {
      throw new AuthMailUnavailableError(idempotencyResult.result);
    }
    if (idempotencyResult.kind === 'completed') {
      return this.restoreResendResult(idempotencyResult.result);
    }

    try {
      const result = await this.performResend(ticket, idempotencyKey, context);
      await this.idempotency.complete(
        idempotencyStoreKey,
        requestHash,
        idempotencyResult.owner,
        result.replay,
        600,
      );
      return result.response;
    } catch (error) {
      if (error instanceof AuthMailUnavailableError) {
        await this.idempotency.fail(
          idempotencyStoreKey,
          requestHash,
          idempotencyResult.owner,
          error.result,
          600,
        );
      } else {
        await this.idempotency
          .release(idempotencyStoreKey, requestHash, idempotencyResult.owner)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private async performResend(
    ticket: string,
    idempotencyKey: string,
    context: VerificationContext,
  ): Promise<{
    replay: RegistrationResendReplay;
    response: {
      verificationTicket: string;
      expiresInSeconds: number;
      resendCooldownSeconds: number;
    };
  }> {
    const claim = await this.claims.findByTicket(ticket);
    if (!claim || claim.expiresAt.getTime() <= Date.now()) {
      if (claim) await this.invalidateClaimTicket(claim.id, ticket);
      throw new VerificationTicketInvalidError();
    }
    await this.consumeVerificationLimits(claim.email, context.ipBucket);
    await this.consumeResendLimits(
      claim.email,
      claim.inviteCodeId,
      context.ipBucket,
      context.deviceBucket,
    );
    const emailIdentity = this.rateLimitKeys.digest(
      emailVerificationRateLimitSubject(claim.email),
    ).digest;
    try {
      return await this.limiter.withExclusiveLock(
        `auth:verify:lock:email_verification:${emailIdentity}`,
        30,
        async () => {
          const currentClaim = await this.claims.findByTicket(ticket);
          if (!currentClaim || currentClaim.id !== claim.id) {
            throw new VerificationTicketInvalidError();
          }
          const previousOtp = await this.auth.snapshotEmailVerificationOtp(currentClaim.email);
          const otp = await this.auth.createEmailVerificationOtp(currentClaim.email);
          const nextVersion = currentClaim.ticketVersion + 1;
          const nextNonce = randomBytes(16).toString('base64url');
          const nextTicket = this.ticketKeys.digest(
            ticketSeed(currentClaim.id, nextVersion, nextNonce),
          ).digest;
          const nextHash = this.ticketKeys.digest(lookupSeed(nextTicket)).digest;
          const result = await this.mail.deliverVerification({
            userId: null,
            recipient: currentClaim.email,
            purpose: 'email_verification',
            otp,
            expiresInMinutes: 10,
            idempotencyKey: `registration-resend:${currentClaim.id}:${idempotencyKey}`,
          });
          if (result.state !== 'accepted') {
            if (result.state === 'not_dispatched' && previousOtp) {
              await this.auth.restoreEmailVerificationOtp(previousOtp);
            }
            throw new AuthMailUnavailableError(result);
          }
          const rotated = await this.claims.rotateTicket(
            currentClaim.id,
            this.ticketKeys.candidates(lookupSeed(ticket)).map(({ digest }) => digest),
            nextHash,
            nextNonce,
            nextVersion,
          );
          if (!rotated) {
            throw new VerificationTicketInvalidError();
          }
          return {
            replay: {
              claimId: currentClaim.id,
              ticketHash: nextHash,
              ticketNonce: nextNonce,
              ticketVersion: nextVersion,
            },
            response: {
              verificationTicket: nextTicket,
              expiresInSeconds: 600,
              resendCooldownSeconds: 60,
            },
          };
        },
      );
    } catch (error) {
      if (error instanceof AuthExclusiveLockBusyError) {
        throw new AuthControlPlaneUnavailableError();
      }
      throw error;
    }
  }

  private async consumeVerificationLimits(email: string, ipBucket: string): Promise<void> {
    const emailIdentity = this.rateLimitKeys.digest(
      emailVerificationRateLimitSubject(email),
    ).digest;
    const ipIdentity = this.rateLimitKeys.digest(
      emailVerificationRateLimitSubject(ipBucket),
    ).digest;
    const results = await Promise.all([
      this.limiter.consume(`auth:verify:window:${emailIdentity}:10m`, {
        max: this.rateLimits.verifyIdentityTenMinutes,
        windowSeconds: 600,
      }),
      this.limiter.consume(`auth:verify:ip:${ipIdentity}:10m`, {
        max: this.rateLimits.verifyIpTenMinutes,
        windowSeconds: 600,
      }),
    ]);
    if (results.some((result) => !result.allowed)) {
      throw new AuthRateLimitedError();
    }
  }

  private async consumeResendLimits(
    email: string,
    inviteCodeId: string,
    ipBucket: string,
    deviceBucket: string,
  ): Promise<void> {
    const emailIdentity = this.rateLimitKeys.digest(
      emailVerificationRateLimitSubject(email),
    ).digest;
    const inviteIdentity = this.rateLimitKeys.digest(
      registrationInviteRateLimitSubject(inviteCodeId),
    ).digest;
    const ipIdentity = this.rateLimitKeys.digest(
      emailVerificationRateLimitSubject(ipBucket),
    ).digest;
    const deviceIdentity = this.rateLimitKeys.digest(
      emailVerificationRateLimitSubject(deviceBucket),
    ).digest;
    const results = await Promise.all([
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
      this.limiter.consume(`auth:invite:window:${inviteIdentity}:10m`, {
        max: this.rateLimits.inviteTenMinutes,
        windowSeconds: 600,
      }),
      this.limiter.consume(`auth:otp:cooldown:email_verification:${emailIdentity}`, {
        max: 1,
        windowSeconds: this.rateLimits.cooldownSeconds,
      }),
    ]);
    if (results.some((result) => !result.allowed)) {
      throw new AuthRateLimitedError();
    }
  }

  private async invalidateClaimTicket(claimId: string, ticket: string): Promise<void> {
    await this.claims.invalidateTicket(
      claimId,
      this.ticketKeys.candidates(lookupSeed(ticket)).map(({ digest }) => digest),
    );
  }

  private restoreResendResult(replay: RegistrationResendReplay): {
    verificationTicket: string;
    expiresInSeconds: number;
    resendCooldownSeconds: number;
  } {
    const candidates = this.ticketKeys.candidates(
      ticketSeed(replay.claimId, replay.ticketVersion, replay.ticketNonce),
    );
    const verificationTicket = candidates.find((candidate) =>
      this.ticketKeys
        .candidates(lookupSeed(candidate.digest))
        .some(({ digest }) => digest === replay.ticketHash),
    )?.digest;
    if (!verificationTicket) throw new AuthControlPlaneUnavailableError();
    return { verificationTicket, expiresInSeconds: 600, resendCooldownSeconds: 60 };
  }
}
