import { authVerifications, eq, inArray, users, type Database } from '@ecom-forge/db';
import { serializeSignedCookie } from 'better-call';

import type { BetterAuthInstance } from './better-auth.factory.js';
import {
  AuthOtpInvalidError,
  InvalidCredentialsError,
  classifyBetterAuthOtpError,
} from './auth-errors.js';
import type { HmacKeyring } from './security/hmac-keyring.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
}

export interface AuthOperationResult {
  user: AuthenticatedUser;
  headers: Headers;
}

type BetterAuthEmailOtpApi = {
  createVerificationOTP(input: {
    body: { email: string; type: 'email-verification' | 'forget-password' };
  }): Promise<string>;
  verifyEmailOTP(input: { body: { email: string; otp: string }; returnHeaders: true }): Promise<{
    response: { user: { id: string; email: string; name: string; emailVerified: boolean } };
    headers: Headers;
  }>;
  resetPasswordEmailOTP(input: {
    body: { email: string; otp: string; password: string };
  }): Promise<unknown>;
};

export type VerificationOtpSnapshot = Pick<
  typeof authVerifications.$inferSelect,
  'id' | 'identifier' | 'value' | 'expiresAt' | 'createdAt'
>;

function mapUser(user: {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.name,
    emailVerified: user.emailVerified,
  };
}

export class BetterAuthService {
  constructor(
    private readonly auth: BetterAuthInstance,
    private readonly database: Database,
    private readonly identifierKeys: HmacKeyring,
  ) {}

  async hashPassword(password: string): Promise<string> {
    const context = await this.auth.$context;
    return context.password.hash(password);
  }

  async issueSession(userId: string): Promise<AuthOperationResult> {
    const context = await this.auth.$context;
    const user = await context.internalAdapter.findUserById(userId);
    if (!user) throw new Error('Cannot issue a session for a missing user');
    const session = await context.internalAdapter.createSession(userId);
    if (!session) throw new Error('Better Auth failed to create a registration session');

    const cookie = context.authCookies.sessionToken;
    const serialized = await serializeSignedCookie(
      cookie.name,
      session.token,
      context.secret,
      cookie.attributes,
    );
    const headers = new Headers();
    headers.append('set-cookie', serialized);
    return {
      user: mapUser(user),
      headers,
    };
  }

  private get emailOtpApi(): BetterAuthEmailOtpApi {
    return this.auth.api;
  }

  async createOrRecoverUnverifiedUser(input: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<AuthOperationResult> {
    try {
      const result = await this.auth.api.signUpEmail({
        body: { email: input.email, password: input.password, name: input.displayName },
        returnHeaders: true,
      });
      return { user: mapUser(result.response.user), headers: result.headers };
    } catch (error) {
      const existing = await this.database.query.users.findFirst({
        where: eq(users.email, input.email),
      });
      if (!existing || existing.emailVerifiedAt) {
        throw error;
      }
      const context = await this.auth.$context;
      const passwordHash = await context.password.hash(input.password);
      await context.internalAdapter.updatePassword(existing.id, passwordHash);
      await this.database
        .update(users)
        .set({ displayName: input.displayName, updatedAt: new Date() })
        .where(eq(users.id, existing.id));
      return {
        user: {
          id: existing.id,
          email: existing.email,
          displayName: input.displayName,
          emailVerified: false,
        },
        headers: new Headers(),
      };
    }
  }

  async createEmailVerificationOtp(email: string): Promise<string> {
    const identifiers = this.identifierKeys
      .candidates(`email-verification-otp-${email}`)
      .map((candidate) => candidate.digest);
    await this.database
      .delete(authVerifications)
      .where(inArray(authVerifications.identifier, identifiers));
    return this.emailOtpApi.createVerificationOTP({
      body: { email, type: 'email-verification' },
    });
  }

  async snapshotEmailVerificationOtp(email: string): Promise<VerificationOtpSnapshot | null> {
    return this.snapshotOtp('email-verification', email);
  }

  async snapshotPasswordResetOtp(email: string): Promise<VerificationOtpSnapshot | null> {
    return this.snapshotOtp('forget-password', email);
  }

  async restorePasswordResetOtp(snapshot: VerificationOtpSnapshot): Promise<void> {
    await this.restoreOtp(snapshot);
  }

  private async snapshotOtp(
    type: 'email-verification' | 'forget-password',
    email: string,
  ): Promise<VerificationOtpSnapshot | null> {
    const identifier = this.identifierKeys.digest(`${type}-otp-${email}`).digest;
    const snapshot = await this.database.query.authVerifications.findFirst({
      where: eq(authVerifications.identifier, identifier),
    });
    return snapshot
      ? {
          id: snapshot.id,
          identifier: snapshot.identifier,
          value: snapshot.value,
          expiresAt: snapshot.expiresAt,
          createdAt: snapshot.createdAt,
        }
      : null;
  }

  async restoreEmailVerificationOtp(snapshot: VerificationOtpSnapshot): Promise<void> {
    await this.restoreOtp(snapshot);
  }

  private async restoreOtp(snapshot: VerificationOtpSnapshot): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction
        .delete(authVerifications)
        .where(eq(authVerifications.identifier, snapshot.identifier));
      await transaction.insert(authVerifications).values({
        id: snapshot.id,
        identifier: snapshot.identifier,
        value: snapshot.value,
        expiresAt: snapshot.expiresAt,
        ...(snapshot.createdAt ? { createdAt: snapshot.createdAt } : {}),
      });
    });
  }

  async verifyEmailOtp(email: string, otp: string): Promise<AuthOperationResult> {
    try {
      const result = await this.emailOtpApi.verifyEmailOTP({
        body: { email, otp },
        returnHeaders: true,
      });
      return { user: mapUser(result.response.user), headers: result.headers };
    } catch (error) {
      throw await this.classifyOtpFailure('email-verification', email, error);
    }
  }

  async login(email: string, password: string): Promise<AuthOperationResult> {
    try {
      const result = await this.auth.api.signInEmail({
        body: { email, password },
        returnHeaders: true,
      });
      return { user: mapUser(result.response.user), headers: result.headers };
    } catch {
      throw new InvalidCredentialsError();
    }
  }

  createPasswordResetOtp(email: string): Promise<string> {
    return this.emailOtpApi.createVerificationOTP({ body: { email, type: 'forget-password' } });
  }

  async resetPassword(email: string, otp: string, password: string): Promise<void> {
    try {
      await this.emailOtpApi.resetPasswordEmailOTP({ body: { email, otp, password } });
    } catch (error) {
      throw await this.classifyOtpFailure('forget-password', email, error);
    }
  }

  async getSession(headers: Headers): Promise<AuthOperationResult | null> {
    const result = await this.auth.api.getSession({ headers, returnHeaders: true });
    if (!result.response) {
      return null;
    }
    return { user: mapUser(result.response.user), headers: result.headers };
  }

  private async classifyOtpFailure(
    type: 'email-verification' | 'forget-password',
    email: string,
    error: unknown,
  ): Promise<Error> {
    const classified = classifyBetterAuthOtpError(error);
    if (!(classified instanceof AuthOtpInvalidError)) return classified;

    const identifier = this.identifierKeys.digest(`${type}-otp-${email}`).digest;
    const verification = await this.database.query.authVerifications.findFirst({
      where: eq(authVerifications.identifier, identifier),
    });
    const separator = verification?.value.lastIndexOf(':') ?? -1;
    const attempts = Number(verification?.value.slice(separator + 1));
    if (verification && separator > 0 && Number.isInteger(attempts) && attempts >= 5) {
      await this.database
        .delete(authVerifications)
        .where(eq(authVerifications.id, verification.id));
      return classifyBetterAuthOtpError({ message: 'TOO_MANY_ATTEMPTS' });
    }
    return classified;
  }
}
