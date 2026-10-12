import { randomUUID } from 'node:crypto';

import {
  authAccounts,
  authSessions,
  authVerifications,
  type Database,
  users,
} from '@ecom-forge/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins/email-otp';

import type { AppConfig } from '../../config/app-config.js';
import { emailVerifiedTimestampBridge } from './better-auth-bridge.js';
import { HmacKeyring } from './security/hmac-keyring.js';

export function createBetterAuth(database: Database, config: AppConfig) {
  const otpKeys = new HmacKeyring(config.auth.otpHashKeys);
  const identifierKeys = new HmacKeyring(config.auth.recipientHashKeys);

  return betterAuth({
    appName: 'ecom-forge',
    baseURL: config.webOrigin,
    secret: config.auth.secret,
    trustedOrigins: config.auth.trustedOrigins,
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema: { users, authSessions, authAccounts, authVerifications },
      camelCase: true,
      transaction: true,
    }),
    advanced: {
      useSecureCookies:
        config.appEnv === 'staging' || config.appEnv === 'beta' || config.appEnv === 'production',
      database: {
        generateId: () => randomUUID(),
      },
    },
    user: {
      modelName: 'users',
      fields: {
        name: 'displayName',
        emailVerified: 'emailVerifiedAt',
      },
    },
    session: { modelName: 'authSessions' },
    account: { modelName: 'authAccounts' },
    verification: {
      modelName: 'authVerifications',
      storeIdentifier: {
        hash: (identifier) => Promise.resolve(identifierKeys.digest(identifier).digest),
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      autoSignInAfterVerification: true,
    },
    plugins: [
      emailVerifiedTimestampBridge,
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        resendStrategy: 'rotate',
        overrideDefaultEmailVerification: true,
        storeOTP: {
          hash: (otp) => Promise.resolve(otpKeys.digest(otp).digest),
        },
        sendVerificationOTP: () =>
          Promise.reject(new Error('Direct Better Auth mail dispatch is disabled')),
      }),
    ],
  });
}

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;
