import { Module } from '@nestjs/common';

import type { Database } from '@ecom-forge/db';

import type { AppConfig } from '../../config/app-config.js';
import { APP_CONFIG } from '../../config/config.module.js';
import { DATABASE } from '../../shared/database/database.module.js';
import { REDIS_EVAL_CLIENT, type RedisEvalClient } from '../../shared/redis/redis.module.js';
import { createBetterAuth, type BetterAuthInstance } from './better-auth.factory.js';
import { BetterAuthService } from './better-auth.service.js';
import {
  AUTH_IDEMPOTENCY_STORE,
  AUTH_RATE_LIMITER,
  BETTER_AUTH,
  MAIL_ADAPTER,
  RATE_LIMIT_KEYS,
  REGISTRATION_FINALIZER,
  REGISTRATION_SERVICE,
  REGISTRATION_VERIFICATION,
} from './auth.tokens.js';
import { ConsoleMailAdapter } from './mail/console-mail.adapter.js';
import { DrizzleMailDeliveryStore } from './mail/drizzle-mail-delivery.store.js';
import { FakeMailAdapter } from './mail/fake-mail.adapter.js';
import { MailService } from './mail/mail.service.js';
import type { MailAdapter } from './mail/mail.types.js';
import { SmtpMailAdapter } from './mail/smtp-mail.adapter.js';
import { RedisVerificationRateLimiter } from './rate-limit/redis-verification-rate-limiter.js';
import { DrizzleRegistrationGateStore } from './registration/drizzle-registration-gate.store.js';
import { RegistrationGate } from './registration/registration-gate.js';
import { RegistrationService } from './registration/registration.service.js';
import { DrizzleRegistrationClaimQueryStore } from './registration/registration-claim-query.store.js';
import { RegistrationVerificationService } from './registration/verification.service.js';
import { RegistrationFinalizer } from './registration/registration-finalizer.js';
import { RedisAuthIdempotencyStore } from './registration/auth-idempotency.store.js';
import { HmacKeyring } from './security/hmac-keyring.js';
import { AuthenticationService } from './authentication.service.js';
import { AuthController, CurrentUserController } from './auth.controller.js';
import { AuthWriteGuard } from './auth-write.guard.js';
import { AuthActivityService } from './auth-activity.service.js';
import { AbuseProtectionService } from './abuse-protection.service.js';

function createMailAdapter(config: AppConfig): MailAdapter {
  switch (config.mail.provider) {
    case 'fake':
      return new FakeMailAdapter();
    case 'console':
      return new ConsoleMailAdapter();
    case 'smtp':
      if (!config.mail.host || !config.mail.port) {
        throw new Error('SMTP mail provider requires host and port');
      }
      return new SmtpMailAdapter({
        host: config.mail.host,
        port: config.mail.port,
        from: config.mail.from,
      });
    case 'tencent_ses':
      throw new Error(
        'Tencent SES adapter is not available before the production capability spike',
      );
  }
}

@Module({
  controllers: [AuthController, CurrentUserController],
  providers: [
    AuthWriteGuard,
    {
      provide: AbuseProtectionService,
      inject: [DATABASE, AUTH_RATE_LIMITER, RATE_LIMIT_KEYS, AuthActivityService],
      useFactory: (
        database: Database,
        limiter: RedisVerificationRateLimiter,
        keys: HmacKeyring,
        activity: AuthActivityService,
      ): AbuseProtectionService => new AbuseProtectionService(database, limiter, keys, activity),
    },
    {
      provide: AuthActivityService,
      inject: [DATABASE, RATE_LIMIT_KEYS],
      useFactory: (database: Database, rateLimitKeys: HmacKeyring): AuthActivityService =>
        new AuthActivityService(database, rateLimitKeys),
    },
    {
      provide: BETTER_AUTH,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): BetterAuthInstance =>
        createBetterAuth(database, config),
    },
    {
      provide: BetterAuthService,
      inject: [BETTER_AUTH, DATABASE, APP_CONFIG],
      useFactory: (
        auth: BetterAuthInstance,
        database: Database,
        config: AppConfig,
      ): BetterAuthService =>
        new BetterAuthService(auth, database, new HmacKeyring(config.auth.recipientHashKeys)),
    },
    {
      provide: MAIL_ADAPTER,
      inject: [APP_CONFIG],
      useFactory: createMailAdapter,
    },
    {
      provide: MailService,
      inject: [DATABASE, APP_CONFIG, MAIL_ADAPTER],
      useFactory: (database: Database, config: AppConfig, adapter: MailAdapter): MailService =>
        new MailService(
          new DrizzleMailDeliveryStore(database, new HmacKeyring(config.auth.recipientHashKeys)),
          adapter,
        ),
    },
    {
      provide: RATE_LIMIT_KEYS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): HmacKeyring =>
        new HmacKeyring(config.auth.rateLimitHashKeys),
    },
    {
      provide: AUTH_RATE_LIMITER,
      inject: [REDIS_EVAL_CLIENT],
      useFactory: (redis: RedisEvalClient): RedisVerificationRateLimiter =>
        new RedisVerificationRateLimiter(redis),
    },
    {
      provide: AUTH_IDEMPOTENCY_STORE,
      inject: [REDIS_EVAL_CLIENT],
      useFactory: (redis: RedisEvalClient): RedisAuthIdempotencyStore =>
        new RedisAuthIdempotencyStore(redis),
    },
    {
      provide: REGISTRATION_SERVICE,
      inject: [
        DATABASE,
        APP_CONFIG,
        BetterAuthService,
        MailService,
        AUTH_RATE_LIMITER,
        RATE_LIMIT_KEYS,
      ],
      useFactory: (
        database: Database,
        config: AppConfig,
        auth: BetterAuthService,
        mail: MailService,
        limiter: RedisVerificationRateLimiter,
        rateLimitKeys: HmacKeyring,
      ): RegistrationService => {
        const inviteKeys = new HmacKeyring(config.auth.inviteHashKeys);
        return new RegistrationService(
          new RegistrationGate(
            new DrizzleRegistrationGateStore(database),
            inviteKeys,
            rateLimitKeys,
            new HmacKeyring(config.auth.ticketHashKeys),
          ),
          auth,
          mail,
          limiter,
          rateLimitKeys,
          config.auth.rateLimits,
        );
      },
    },
    {
      provide: AuthenticationService,
      inject: [
        DATABASE,
        APP_CONFIG,
        BetterAuthService,
        MailService,
        AUTH_RATE_LIMITER,
        RATE_LIMIT_KEYS,
        AuthActivityService,
      ],
      useFactory: (
        database: Database,
        config: AppConfig,
        auth: BetterAuthService,
        mail: MailService,
        limiter: RedisVerificationRateLimiter,
        rateLimitKeys: HmacKeyring,
        activity: AuthActivityService,
      ): AuthenticationService =>
        new AuthenticationService(
          database,
          auth,
          mail,
          limiter,
          rateLimitKeys,
          config.auth.rateLimits,
          config.auth.passwordResetResponseFloorMs,
          activity,
        ),
    },
    {
      provide: REGISTRATION_FINALIZER,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: AppConfig): RegistrationFinalizer =>
        new RegistrationFinalizer(
          database,
          new HmacKeyring(config.auth.mailboxFingerprintKeys),
          new HmacKeyring(config.auth.recipientHashKeys),
          new HmacKeyring(config.auth.otpHashKeys),
        ),
    },
    {
      provide: REGISTRATION_VERIFICATION,
      inject: [
        DATABASE,
        APP_CONFIG,
        BetterAuthService,
        MailService,
        AUTH_RATE_LIMITER,
        RATE_LIMIT_KEYS,
        REGISTRATION_FINALIZER,
        AUTH_IDEMPOTENCY_STORE,
        AuthActivityService,
      ],
      useFactory: (
        database: Database,
        config: AppConfig,
        auth: BetterAuthService,
        mail: MailService,
        limiter: RedisVerificationRateLimiter,
        rateLimitKeys: HmacKeyring,
        finalizer: RegistrationFinalizer,
        idempotency: RedisAuthIdempotencyStore,
        activity: AuthActivityService,
      ): RegistrationVerificationService =>
        new RegistrationVerificationService(
          new DrizzleRegistrationClaimQueryStore(
            database,
            new HmacKeyring(config.auth.ticketHashKeys),
          ),
          auth,
          mail,
          limiter,
          rateLimitKeys,
          new HmacKeyring(config.auth.ticketHashKeys),
          finalizer,
          idempotency,
          config.auth.rateLimits,
          activity,
        ),
    },
  ],
  exports: [
    BetterAuthService,
    MAIL_ADAPTER,
    MailService,
    REGISTRATION_SERVICE,
    AuthenticationService,
    REGISTRATION_VERIFICATION,
    REGISTRATION_FINALIZER,
    AUTH_IDEMPOTENCY_STORE,
    AbuseProtectionService,
  ],
})
export class AuthModule {}
