import { eq, users, type Database } from '@ecom-forge/db';
import type { AppConfig } from '../../config/app-config.js';

import { normalizeEmail } from './security/email.js';
import { AuthOtpInvalidError, InvalidCredentialsError } from './auth-errors.js';
import type { HmacKeyring } from './security/hmac-keyring.js';
import type { BetterAuthService, AuthOperationResult } from './better-auth.service.js';
import type { MailService } from './mail/mail.service.js';
import type { VerificationRateLimiter } from './rate-limit/verification-rate-limiter.js';
import { AuthRateLimitedError } from './registration/registration.service.js';
import type { AuthActivityService } from './auth-activity.service.js';

export interface AuthRequestContext {
  ipBucket: string;
  deviceBucket: string;
}

export interface PasswordResetRequestResult {
  mailAccepted: boolean;
}

export interface UserAccessSummary {
  canCreate: boolean;
  canUpload: boolean;
  canCharge: boolean;
  restrictionReason: 'email_verification_required' | 'account_restricted' | null;
}

export interface AuthenticationResult extends AuthOperationResult {
  access: UserAccessSummary;
}

export function accessSummary(emailVerified: boolean, riskStatus: 'normal' | 'frozen' | 'limited') {
  const restrictionReason = !emailVerified
    ? ('email_verification_required' as const)
    : riskStatus === 'normal'
      ? null
      : ('account_restricted' as const);
  const allowed = restrictionReason === null;
  return {
    canCreate: allowed,
    canUpload: allowed,
    canCharge: allowed,
    restrictionReason,
  };
}

export class AuthenticationService {
  constructor(
    private readonly database: Database,
    private readonly auth: BetterAuthService,
    private readonly mail: MailService,
    private readonly limiter: VerificationRateLimiter,
    private readonly rateLimitKeys: HmacKeyring,
    private readonly rateLimits: AppConfig['auth']['rateLimits'],
    private readonly passwordResetResponseFloorMs: number,
    private readonly activity: AuthActivityService,
  ) {}

  async login(
    emailInput: string,
    password: string,
    context: AuthRequestContext,
  ): Promise<AuthenticationResult> {
    const email = normalizeEmail(emailInput);
    await this.consumeLoginLimits(email, context.ipBucket);
    const result = await this.auth.login(email, password);
    const user = await this.database.query.users.findFirst({ where: eq(users.id, result.user.id) });
    if (!user) throw new InvalidCredentialsError();
    await this.activity.record({
      activityType: 'login',
      userId: user.id,
      targetType: 'user',
      targetId: user.id,
      context,
    });
    if (user.riskStatus !== 'normal') {
      await this.activity.record({
        activityType: 'risk_block',
        userId: user.id,
        targetType: 'user',
        targetId: user.id,
        context,
        metadata: { operation: 'login_access' },
      });
    }
    return { ...result, access: accessSummary(result.user.emailVerified, user.riskStatus) };
  }

  async requestPasswordReset(
    emailInput: string,
    context: AuthRequestContext,
  ): Promise<PasswordResetRequestResult> {
    const startedAt = Date.now();
    try {
      const email = normalizeEmail(emailInput);
      await this.consumePasswordResetSendLimits(email, context.ipBucket, context.deviceBucket);
      const user = await this.database.query.users.findFirst({ where: eq(users.email, email) });
      if (!user?.emailVerifiedAt) {
        return { mailAccepted: false };
      }

      const previousOtp = await this.auth.snapshotPasswordResetOtp(email);
      const otp = await this.auth.createPasswordResetOtp(email);
      const result = await this.mail.deliverVerification({
        userId: user.id,
        recipient: email,
        purpose: 'password_reset',
        otp,
        expiresInMinutes: 10,
        idempotencyKey: `password-reset:${user.id}:${Math.floor(Date.now() / 60_000)}`,
      });
      if (result.state === 'not_dispatched' && previousOtp) {
        await this.auth.restorePasswordResetOtp(previousOtp);
      }
      return { mailAccepted: result.state === 'accepted' };
    } catch (error) {
      if (error instanceof AuthRateLimitedError) {
        return { mailAccepted: false };
      }
      throw error;
    } finally {
      const remaining = this.passwordResetResponseFloorMs - (Date.now() - startedAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
    }
  }

  async confirmPasswordReset(
    emailInput: string,
    code: string,
    password: string,
    context: AuthRequestContext,
  ): Promise<void> {
    const email = normalizeEmail(emailInput);
    await this.consumePasswordResetVerificationLimits(email, context.ipBucket);
    const user = await this.database.query.users.findFirst({ where: eq(users.email, email) });
    if (!user?.emailVerifiedAt) throw new AuthOtpInvalidError();
    await this.auth.resetPassword(email, code, password);
    await this.activity.record({
      activityType: 'password_reset',
      userId: user.id,
      targetType: 'user',
      targetId: user.id,
      context,
    });
  }

  async currentSession(headers: Headers): Promise<AuthenticationResult | null> {
    const result = await this.auth.getSession(headers);
    if (!result) return null;
    const user = await this.database.query.users.findFirst({ where: eq(users.id, result.user.id) });
    if (!user) return null;
    return { ...result, access: accessSummary(result.user.emailVerified, user.riskStatus) };
  }

  async accessForUser(userId: string, emailVerified: boolean): Promise<UserAccessSummary> {
    const user = await this.database.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new InvalidCredentialsError();
    return accessSummary(emailVerified, user.riskStatus);
  }

  private async consumeLoginLimits(email: string, ipBucket: string): Promise<void> {
    const emailIdentity = this.rateLimitKeys.digest(`login\0${email}`).digest;
    const ipIdentity = this.rateLimitKeys.digest(`login\0${ipBucket}`).digest;
    const results = await Promise.all([
      this.limiter.consume(`auth:login:window:${emailIdentity}:10m`, {
        max: this.rateLimits.loginIdentityTenMinutes,
        windowSeconds: 600,
      }),
      this.limiter.consume(`auth:login:ip:${ipIdentity}:10m`, {
        max: this.rateLimits.loginIpTenMinutes,
        windowSeconds: 600,
      }),
    ]);
    if (results.some((result) => !result.allowed)) {
      throw new AuthRateLimitedError();
    }
  }

  private async consumePasswordResetSendLimits(
    email: string,
    ipBucket: string,
    deviceBucket: string,
  ): Promise<void> {
    const emailIdentity = this.rateLimitKeys.digest(`password_reset\0${email}`).digest;
    const ipIdentity = this.rateLimitKeys.digest(`password_reset\0${ipBucket}`).digest;
    const deviceIdentity = this.rateLimitKeys.digest(`password_reset\0${deviceBucket}`).digest;
    const results = await Promise.all([
      this.limiter.consume(`auth:otp:window:password_reset:${emailIdentity}:1h`, {
        max: this.rateLimits.emailHourly,
        windowSeconds: 3600,
      }),
      this.limiter.consume(`auth:otp:window:password_reset:${emailIdentity}:24h`, {
        max: this.rateLimits.emailDaily,
        windowSeconds: 86_400,
      }),
      this.limiter.consume(`auth:otp:ip:password_reset:${ipIdentity}:1h`, {
        max: this.rateLimits.ipHourly,
        windowSeconds: 3600,
      }),
      this.limiter.consume(`auth:otp:device:password_reset:${deviceIdentity}:1h`, {
        max: this.rateLimits.deviceHourly,
        windowSeconds: 3600,
      }),
      this.limiter.consume(`auth:otp:cooldown:password_reset:${emailIdentity}`, {
        max: 1,
        windowSeconds: this.rateLimits.cooldownSeconds,
      }),
    ]);
    if (results.some((result) => !result.allowed)) {
      throw new AuthRateLimitedError();
    }
  }

  private async consumePasswordResetVerificationLimits(
    email: string,
    ipBucket: string,
  ): Promise<void> {
    const emailIdentity = this.rateLimitKeys.digest(`password_reset\0${email}`).digest;
    const ipIdentity = this.rateLimitKeys.digest(`password_reset\0${ipBucket}`).digest;
    const results = await Promise.all([
      this.limiter.consume(`auth:verify:window:password_reset:${emailIdentity}:10m`, {
        max: this.rateLimits.verifyIdentityTenMinutes,
        windowSeconds: 600,
      }),
      this.limiter.consume(`auth:verify:ip:password_reset:${ipIdentity}:10m`, {
        max: this.rateLimits.verifyIpTenMinutes,
        windowSeconds: 600,
      }),
    ]);
    if (results.some((result) => !result.allowed)) {
      throw new AuthRateLimitedError();
    }
  }
}
