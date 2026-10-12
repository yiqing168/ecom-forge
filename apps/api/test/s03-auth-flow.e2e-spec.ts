import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  authAccounts,
  authSessions,
  authVerifications,
  creditAccounts,
  creditLedger,
  desc,
  eq,
  inArray,
  inviteCodeRedemptions,
  inviteCodes,
  mailDeliveries,
  registrationClaims,
  registrationRewardClaims,
  rewardCampaigns,
  userActivityLogs,
  users,
  type Database,
} from '@ecom-forge/db';
import request from 'supertest';

import { AppModule } from '../src/app.module.js';
import type { AppConfig } from '../src/config/app-config.js';
import { APP_CONFIG } from '../src/config/config.module.js';
import { MAIL_ADAPTER } from '../src/modules/auth/auth.tokens.js';
import { DrizzleInviteCodeStore } from '../src/modules/auth/invite/drizzle-invite-code.store.js';
import { InviteCodeService } from '../src/modules/auth/invite/invite-code.service.js';
import { DrizzleMailDeliveryStore } from '../src/modules/auth/mail/drizzle-mail-delivery.store.js';
import { FakeMailAdapter } from '../src/modules/auth/mail/fake-mail.adapter.js';
import { HmacKeyring } from '../src/modules/auth/security/hmac-keyring.js';
import {
  REGISTRATION_REWARD_CAMPAIGN_KEY,
  REGISTRATION_REWARD_ELIGIBILITY,
} from '../src/modules/auth/registration/registration-reward.constants.js';
import { DATABASE } from '../src/shared/database/database.module.js';
import { REDIS_EVAL_CLIENT } from '../src/shared/redis/redis.module.js';

const origin = 'http://localhost:3000';
const host = 'localhost:3001';

interface RegistrationResponseBody {
  verification_ticket: string;
}

interface AuthResponseBody {
  user: { email: string; email_verified: boolean };
  access: {
    can_create: boolean;
    can_upload: boolean;
    can_charge: boolean;
    restriction_reason: string | null;
  };
}

interface ErrorResponseBody {
  error: { code: string };
}

function responseBody<T>(response: { body: unknown }): T {
  return response.body as T;
}

function cookieHeader(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  const cookies = Array.isArray(value)
    ? value.filter((candidate): candidate is string => typeof candidate === 'string')
    : typeof value === 'string'
      ? [value]
      : [];
  return cookies.map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

describe('S03 authentication API flow', () => {
  let app: INestApplication;
  let database: Database;
  let config: AppConfig;
  let fakeMail: FakeMailAdapter;
  const emails = new Set<string>();
  const inviteIds = new Set<string>();
  let createdRewardCampaignId: string | null = null;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    database = app.get<Database>(DATABASE);
    config = app.get<AppConfig>(APP_CONFIG);
    const latestReward = await database.query.rewardCampaigns.findFirst({
      where: eq(rewardCampaigns.campaignKey, REGISTRATION_REWARD_CAMPAIGN_KEY),
      orderBy: [desc(rewardCampaigns.versionNo)],
    });
    if (!latestReward || latestReward.status !== 'active') {
      const [created] = await database
        .insert(rewardCampaigns)
        .values({
          campaignKey: REGISTRATION_REWARD_CAMPAIGN_KEY,
          versionNo: (latestReward?.versionNo ?? 0) + 1,
          kind: 'registration',
          status: 'active',
          grantCredits: '100.00',
          maxGrants: 10_000,
          budgetCredits: '1000000.00',
          eligibilityPolicyJson: REGISTRATION_REWARD_ELIGIBILITY,
          activatedAt: new Date(),
        })
        .returning({ id: rewardCampaigns.id });
      createdRewardCampaignId = created?.id ?? null;
    }
    const adapter = app.get<unknown>(MAIL_ADAPTER);
    if (!(adapter instanceof FakeMailAdapter))
      throw new Error('S03 integration requires fake mail');
    fakeMail = adapter;
  });

  afterAll(async () => {
    for (const email of emails) {
      const user = await database.query.users.findFirst({ where: eq(users.email, email) });
      if (!user) continue;
      await database
        .delete(registrationRewardClaims)
        .where(eq(registrationRewardClaims.userId, user.id));
      await database.delete(creditLedger).where(eq(creditLedger.userId, user.id));
      await database.delete(creditAccounts).where(eq(creditAccounts.userId, user.id));
      await database.delete(inviteCodeRedemptions).where(eq(inviteCodeRedemptions.userId, user.id));
      await database.delete(mailDeliveries).where(eq(mailDeliveries.userId, user.id));
      await database.delete(userActivityLogs).where(eq(userActivityLogs.userId, user.id));
      await database.delete(registrationClaims).where(eq(registrationClaims.userId, user.id));
      await database.delete(authSessions).where(eq(authSessions.userId, user.id));
      await database.delete(authAccounts).where(eq(authAccounts.userId, user.id));
      await database.delete(users).where(eq(users.id, user.id));
    }
    for (const inviteId of inviteIds) {
      await database
        .delete(registrationClaims)
        .where(eq(registrationClaims.inviteCodeId, inviteId));
      await database.delete(inviteCodes).where(eq(inviteCodes.id, inviteId));
    }
    if (createdRewardCampaignId) {
      await database.delete(rewardCampaigns).where(eq(rewardCampaigns.id, createdRewardCampaignId));
    }
    await app.close();
  });

  async function createInvite(maxUses = 1, emailAllowlist: string[] = []) {
    const service = new InviteCodeService(
      new DrizzleInviteCodeStore(database),
      new HmacKeyring(config.auth.inviteHashKeys),
    );
    const invite = await service.createInvite({
      maxUses,
      emailAllowlist,
      expiresAt: null,
      issuedBy: null,
    });
    inviteIds.add(invite.id);
    return invite;
  }

  function post(path: string) {
    const ipToken = randomUUID().replaceAll('-', '');
    const clientIp = `2001:db8:${ipToken.slice(0, 4)}:${ipToken.slice(4, 8)}::1`;
    return request(app.getHttpServer() as Server)
      .post(path)
      .set('Origin', origin)
      .set('Host', host)
      .set('X-Real-IP', clientIp);
  }

  async function clearEmailVerificationCooldown(email: string): Promise<void> {
    const redis = app.get<{
      eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
    }>(REDIS_EVAL_CLIENT);
    const rateLimitKeys = new HmacKeyring(config.auth.rateLimitHashKeys);
    const emailIdentity = rateLimitKeys.digest(`email_verification\0${email}`).digest;
    await redis.eval("return redis.call('DEL', KEYS[1])", {
      keys: [`auth:otp:cooldown:email_verification:${emailIdentity}`],
      arguments: [],
    });
  }

  async function redisCounter(key: string): Promise<number> {
    const redis = app.get<{
      eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
    }>(REDIS_EVAL_CLIENT);
    const value = await redis.eval("return redis.call('GET', KEYS[1])", {
      keys: [key],
      arguments: [],
    });
    return typeof value === 'string' ? Number(value) : 0;
  }

  async function registerOnly(email: string, password: string) {
    emails.add(email);
    const invite = await createInvite();
    const messageOffset = fakeMail.messages.length;
    const registration = await post('/api/v1/auth/register')
      .set('Idempotency-Key', `register-${randomUUID()}`)
      .send({
        email,
        password,
        display_name: 'S03 integration user',
        invite_code: invite.plaintextCode,
        agreement_version: '2026-08-09',
      })
      .expect(201);
    await expect(
      database.query.users.findFirst({ where: eq(users.email, email) }),
    ).resolves.toBeUndefined();
    expect(registration.headers['cache-control']).toBe('no-store');
    const message = fakeMail.messages
      .slice(messageOffset)
      .find(
        (candidate) => candidate.recipient === email && candidate.purpose === 'email_verification',
      );
    expect(message).toBeDefined();
    return { invite, message: message!, registration };
  }

  async function registerAndVerify(email: string, password: string) {
    const registered = await registerOnly(email, password);
    const verification = await post('/api/v1/auth/verify-email')
      .send({
        verification_ticket: responseBody<RegistrationResponseBody>(registered.registration)
          .verification_ticket,
        code: registered.message.otp,
      })
      .expect(201);
    expect(verification.headers['cache-control']).toBe('no-store');
    return {
      cookie: cookieHeader(verification),
      registration: registered.registration,
      verification,
    };
  }

  it('registers, verifies, resets the password and revokes the old session', async () => {
    const email = `s03-${randomUUID()}@example.test`;
    const oldPassword = 'old-password-123';
    const newPassword = 'new-password-456';
    const verified = await registerAndVerify(email, oldPassword);

    expect(responseBody<AuthResponseBody>(verified.verification).user).toMatchObject({
      email,
      email_verified: true,
    });
    const rawSessionCookies = verified.verification.headers['set-cookie'];
    const sessionCookies = Array.isArray(rawSessionCookies)
      ? rawSessionCookies
      : rawSessionCookies
        ? [rawSessionCookies]
        : [];
    expect(sessionCookies).not.toHaveLength(0);
    expect(sessionCookies.join('; ')).toContain('HttpOnly');
    expect(sessionCookies.join('; ')).toContain('SameSite=Lax');
    const currentUser = await request(app.getHttpServer() as Server)
      .get('/api/v1/me')
      .set('Cookie', verified.cookie)
      .expect(200)
      .expect((response) => {
        const body = responseBody<AuthResponseBody>(response);
        expect(body.user).toMatchObject({ email, email_verified: true });
      });
    expect(currentUser.headers['cache-control']).toBe('no-store');

    const messageOffset = fakeMail.messages.length;
    const resetRequest = await post('/api/v1/auth/password-reset/request')
      .send({ email })
      .expect(202);
    expect(resetRequest.headers['cache-control']).toBe('no-store');
    const resetMessage = fakeMail.messages
      .slice(messageOffset)
      .find((candidate) => candidate.recipient === email && candidate.purpose === 'password_reset');
    expect(resetMessage).toBeDefined();
    const resetConfirmation = await post('/api/v1/auth/password-reset/confirm')
      .send({ email, code: resetMessage!.otp, new_password: newPassword })
      .expect(201);
    expect(resetConfirmation.headers['cache-control']).toBe('no-store');

    await request(app.getHttpServer() as Server)
      .get('/api/v1/me')
      .set('Cookie', verified.cookie)
      .expect(401);
    await post('/api/v1/auth/login').send({ email, password: oldPassword }).expect(401);
    const loginResponse = await post('/api/v1/auth/login')
      .send({ email, password: newPassword })
      .expect(201)
      .expect((response) =>
        expect(responseBody<AuthResponseBody>(response).user.email_verified).toBe(true),
      );
    expect(loginResponse.headers['cache-control']).toBe('no-store');

    const user = await database.query.users.findFirst({ where: eq(users.email, email) });
    const activities = user
      ? await database
          .select({ activityType: userActivityLogs.activityType })
          .from(userActivityLogs)
          .where(eq(userActivityLogs.userId, user.id))
      : [];
    expect(activities.map((activity) => activity.activityType)).toEqual(
      expect.arrayContaining([
        'register',
        'email_verify',
        'password_reset',
        'registration_reward',
        'login',
      ]),
    );
  }, 30_000);

  it('rejects a second registration for a verified email without consuming another invite', async () => {
    const email = `s03-duplicate-${randomUUID()}@example.test`;
    await registerAndVerify(email, 'duplicate-password-123');
    const invite = await createInvite();
    const messageOffset = fakeMail.messages.length;
    const identityKeys = new HmacKeyring(config.auth.rateLimitHashKeys);

    await post('/api/v1/auth/register')
      .set('Idempotency-Key', `register-duplicate-${randomUUID()}`)
      .send({
        email,
        password: 'another-password-123',
        display_name: 'Duplicate registration',
        invite_code: invite.plaintextCode,
        agreement_version: '2026-08-09',
      })
      .expect(403)
      .expect((response) =>
        expect(responseBody<ErrorResponseBody>(response).error.code).toBe(
          'REGISTRATION_NOT_ELIGIBLE',
        ),
      );

    const newClaims = await database
      .select({ id: registrationClaims.id })
      .from(registrationClaims)
      .where(
        eq(
          registrationClaims.emailHash,
          identityKeys.digest(`registration-email\0${email}`).digest,
        ),
      );
    const inviteRow = await database.query.inviteCodes.findFirst({
      where: eq(inviteCodes.id, invite.id),
    });
    expect(newClaims).toHaveLength(1);
    expect(inviteRow?.usedCount).toBe(0);
    expect(fakeMail.messages).toHaveLength(messageOffset);
  }, 30_000);

  it('rejects registration when a legacy unverified user row already owns the email', async () => {
    const email = `s03-legacy-unverified-${randomUUID()}@example.test`;
    emails.add(email);
    await database.insert(users).values({ email, displayName: 'Legacy unverified user' });
    const invite = await createInvite();
    const messageOffset = fakeMail.messages.length;

    await post('/api/v1/auth/register')
      .set('Idempotency-Key', `register-legacy-unverified-${randomUUID()}`)
      .send({
        email,
        password: 'legacy-password-123',
        display_name: 'Replacement registration',
        invite_code: invite.plaintextCode,
        agreement_version: '2026-08-09',
      })
      .expect(403)
      .expect((response) =>
        expect(responseBody<ErrorResponseBody>(response).error.code).toBe(
          'REGISTRATION_NOT_ELIGIBLE',
        ),
      );

    expect(
      await database.query.registrationClaims.findFirst({
        where: eq(registrationClaims.inviteCodeId, invite.id),
      }),
    ).toBeUndefined();
    expect(fakeMail.messages).toHaveLength(messageOffset);
  });

  it('does not rotate the reset OTP when a duplicate request is inside the cooldown', async () => {
    const email = `s03-reset-cooldown-${randomUUID()}@example.test`;
    await registerAndVerify(email, 'old-password-123');
    const messageOffset = fakeMail.messages.length;

    await post('/api/v1/auth/password-reset/request').send({ email }).expect(202);
    const firstMessage = fakeMail.messages
      .slice(messageOffset)
      .find((candidate) => candidate.recipient === email && candidate.purpose === 'password_reset');
    expect(firstMessage).toBeDefined();

    await post('/api/v1/auth/password-reset/request').send({ email }).expect(202);
    expect(
      fakeMail.messages
        .slice(messageOffset)
        .filter(
          (candidate) => candidate.recipient === email && candidate.purpose === 'password_reset',
        ),
    ).toHaveLength(1);

    await post('/api/v1/auth/password-reset/confirm')
      .send({ email, code: firstMessage!.otp, new_password: 'new-password-456' })
      .expect(201);
  }, 30_000);

  it('returns the generic reset response without OTP or mail for an unknown account', async () => {
    const email = `s03-unknown-reset-${randomUUID()}@example.test`;
    emails.add(email);
    const recipientKeys = new HmacKeyring(config.auth.recipientHashKeys);
    const messageOffset = fakeMail.messages.length;

    await post('/api/v1/auth/password-reset/request')
      .send({ email })
      .expect(202)
      .expect({ status: 'accepted' });

    await expect(
      database.query.authVerifications.findFirst({
        where: eq(
          authVerifications.identifier,
          recipientKeys.digest(`forget-password-otp-${email}`).digest,
        ),
      }),
    ).resolves.toBeUndefined();
    await expect(
      database.query.mailDeliveries.findFirst({
        where: eq(mailDeliveries.recipientHash, recipientKeys.digest(email).digest),
      }),
    ).resolves.toBeUndefined();
    expect(fakeMail.messages).toHaveLength(messageOffset);
  });

  it('fails authentication writes closed when Redis is unavailable but keeps session reads', async () => {
    const email = `s03-redis-${randomUUID()}@example.test`;
    const password = 'redis-failure-password-123';
    const verified = await registerAndVerify(email, password);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(REDIS_EVAL_CLIENT)
      .useValue({ eval: vi.fn().mockRejectedValue(new Error('redis unavailable')) })
      .compile();
    const unavailableApp = moduleRef.createNestApplication();

    try {
      await unavailableApp.init();
      await request(unavailableApp.getHttpServer() as Server)
        .get('/api/v1/me')
        .set('Cookie', verified.cookie)
        .expect(200);
      await request(unavailableApp.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .set('Origin', origin)
        .set('Host', host)
        .set('X-Real-IP', `2001:db8:${randomUUID().slice(0, 4)}::1`)
        .send({ email, password })
        .expect(503)
        .expect((response) =>
          expect(responseBody<ErrorResponseBody>(response).error.code).toBe(
            'AUTH_TEMPORARILY_UNAVAILABLE',
          ),
        );
    } finally {
      await unavailableApp.close();
    }
  }, 30_000);

  it('rejects an invalid invite before creating a user or mail delivery', async () => {
    const email = `s03-invalid-${randomUUID()}@example.test`;
    emails.add(email);
    const messageOffset = fakeMail.messages.length;

    await post('/api/v1/auth/register')
      .set('Idempotency-Key', `register-invalid-${randomUUID()}`)
      .send({
        email,
        password: 'password-123',
        display_name: 'Rejected user',
        invite_code: 'INVALID-INVITE',
        agreement_version: '2026-08-09',
      })
      .expect(403)
      .expect((response) =>
        expect(responseBody<ErrorResponseBody>(response).error.code).toBe(
          'REGISTRATION_NOT_ELIGIBLE',
        ),
      );

    await expect(
      database.query.users.findFirst({ where: eq(users.email, email) }),
    ).resolves.toBeUndefined();
    expect(fakeMail.messages).toHaveLength(messageOffset);
  });

  it('replays one successful registration without consuming new send limits', async () => {
    const email = `s03-idem-${randomUUID()}@example.test`;
    emails.add(email);
    const invite = await createInvite();
    const idempotencyKey = `register-idem-${randomUUID()}`;
    const body = {
      email,
      password: 'idempotent-password-123',
      display_name: 'Idempotent registration',
      invite_code: invite.plaintextCode,
      agreement_version: '2026-08-09',
    };
    const messageOffset = fakeMail.messages.length;
    const first = await post('/api/v1/auth/register')
      .set('Idempotency-Key', idempotencyKey)
      .send(body)
      .expect(201);
    const firstTicket = responseBody<RegistrationResponseBody>(first).verification_ticket;

    for (let replay = 0; replay < 12; replay += 1) {
      await post('/api/v1/auth/register')
        .set('Idempotency-Key', idempotencyKey)
        .send(body)
        .expect(201)
        .expect((response) =>
          expect(responseBody<RegistrationResponseBody>(response).verification_ticket).toBe(
            firstTicket,
          ),
        );
    }

    expect(
      fakeMail.messages.slice(messageOffset).filter((message) => message.recipient === email),
    ).toHaveLength(1);
  }, 30_000);

  it('enforces the server-side resend cooldown after initial registration mail', async () => {
    const email = `s03-cooldown-${randomUUID()}@example.test`;
    const registered = await registerOnly(email, 'cooldown-password-123');

    await post('/api/v1/auth/email-verification/request')
      .set('Idempotency-Key', `resend-too-soon-${randomUUID()}`)
      .send({
        verification_ticket: responseBody<RegistrationResponseBody>(registered.registration)
          .verification_ticket,
      })
      .expect(429)
      .expect((response) =>
        expect(responseBody<ErrorResponseBody>(response).error.code).toBe('AUTH_OTP_RATE_LIMITED'),
      );
  });

  it('shares email and invite send quotas across initial registration and resend', async () => {
    const email = `s03-shared-quota-${randomUUID()}@example.test`;
    const registered = await registerOnly(email, 'shared-quota-password-123');
    const rateLimitKeys = new HmacKeyring(config.auth.rateLimitHashKeys);
    const emailIdentity = rateLimitKeys.digest(`email_verification\0${email}`).digest;
    const inviteIdentity = rateLimitKeys.digest(
      `email_verification\0invite_code\0${registered.invite.id}`,
    ).digest;
    const emailKey = `auth:otp:window:register:${emailIdentity}:1h`;
    const inviteKey = `auth:invite:window:${inviteIdentity}:10m`;

    await expect(redisCounter(emailKey)).resolves.toBe(1);
    await expect(redisCounter(inviteKey)).resolves.toBe(1);

    await clearEmailVerificationCooldown(email);
    await post('/api/v1/auth/email-verification/request')
      .set('Idempotency-Key', `shared-quota-resend-${randomUUID()}`)
      .send({
        verification_ticket: responseBody<RegistrationResponseBody>(registered.registration)
          .verification_ticket,
      })
      .expect(201);

    await expect(redisCounter(emailKey)).resolves.toBe(2);
    await expect(redisCounter(inviteKey)).resolves.toBe(2);
  });

  it('rotates the registration ticket and OTP only after resend is accepted', async () => {
    const email = `s03-resend-rotate-${randomUUID()}@example.test`;
    const registered = await registerOnly(email, 'rotate-password-123');
    const oldTicket = responseBody<RegistrationResponseBody>(
      registered.registration,
    ).verification_ticket;
    await clearEmailVerificationCooldown(email);
    const messageOffset = fakeMail.messages.length;
    const resend = await post('/api/v1/auth/email-verification/request')
      .set('Idempotency-Key', `resend-accepted-${randomUUID()}`)
      .send({ verification_ticket: oldTicket })
      .expect(201);
    const newTicket = responseBody<{ verification_ticket: string }>(resend).verification_ticket;
    expect(newTicket).not.toBe(oldTicket);
    const replacement = fakeMail.messages
      .slice(messageOffset)
      .find((message) => message.recipient === email && message.purpose === 'email_verification');
    expect(replacement).toBeDefined();

    await post('/api/v1/auth/verify-email')
      .send({ verification_ticket: oldTicket, code: replacement!.otp })
      .expect(401)
      .expect((response) =>
        expect(responseBody<ErrorResponseBody>(response).error.code).toBe(
          'AUTH_VERIFICATION_TICKET_INVALID',
        ),
      );
    await post('/api/v1/auth/verify-email')
      .send({ verification_ticket: newTicket, code: registered.message.otp })
      .expect(422)
      .expect((response) =>
        expect(responseBody<ErrorResponseBody>(response).error.code).toBe(
          'AUTH_OTP_INVALID_OR_EXPIRED',
        ),
      );
    await post('/api/v1/auth/verify-email')
      .send({ verification_ticket: newTicket, code: replacement!.otp })
      .expect(201);
  }, 30_000);

  it('unifies disabled, expired, exhausted and email-mismatched invite failures', async () => {
    const identityKeys = new HmacKeyring(config.auth.rateLimitHashKeys);
    const recipientKeys = new HmacKeyring(config.auth.recipientHashKeys);
    const variants = ['disabled', 'expired', 'exhausted', 'email_mismatch'] as const;

    for (const variant of variants) {
      const email = `s03-invite-${variant}-${randomUUID()}@example.test`;
      emails.add(email);
      const invite = await createInvite(
        1,
        variant === 'email_mismatch' ? ['different-user@example.test'] : [],
      );
      if (variant === 'disabled') {
        await database
          .update(inviteCodes)
          .set({ disabledAt: new Date() })
          .where(eq(inviteCodes.id, invite.id));
      } else if (variant === 'expired') {
        await database
          .update(inviteCodes)
          .set({ expiresAt: new Date(Date.now() - 60_000) })
          .where(eq(inviteCodes.id, invite.id));
      } else if (variant === 'exhausted') {
        await database
          .update(inviteCodes)
          .set({ usedCount: 1 })
          .where(eq(inviteCodes.id, invite.id));
      }
      const messageOffset = fakeMail.messages.length;

      await post('/api/v1/auth/register')
        .set('Idempotency-Key', `register-${variant}-${randomUUID()}`)
        .send({
          email,
          password: 'password-123',
          display_name: 'Rejected user',
          invite_code: invite.plaintextCode,
          agreement_version: '2026-08-09',
        })
        .expect(403)
        .expect((response) =>
          expect(responseBody<ErrorResponseBody>(response).error.code).toBe(
            'REGISTRATION_NOT_ELIGIBLE',
          ),
        );

      await expect(
        database.query.users.findFirst({ where: eq(users.email, email) }),
      ).resolves.toBeUndefined();
      await expect(
        database.query.registrationClaims.findFirst({
          where: eq(
            registrationClaims.emailHash,
            identityKeys.digest(`registration-email\0${email}`).digest,
          ),
        }),
      ).resolves.toBeUndefined();
      await expect(
        database.query.authVerifications.findFirst({
          where: eq(
            authVerifications.identifier,
            recipientKeys.digest(`email-verification-otp-${email}`).digest,
          ),
        }),
      ).resolves.toBeUndefined();
      await expect(
        database.query.mailDeliveries.findFirst({
          where: eq(mailDeliveries.recipientHash, recipientKeys.digest(email).digest),
        }),
      ).resolves.toBeUndefined();
      expect(fakeMail.messages).toHaveLength(messageOffset);
    }
  }, 30_000);

  it('does not exceed one invite claim under ten concurrent registrations', async () => {
    const invite = await createInvite(1);
    const concurrentEmails = Array.from(
      { length: 10 },
      () => `s03-capacity-${randomUUID()}@example.test`,
    );
    concurrentEmails.forEach((email) => emails.add(email));
    const messageOffset = fakeMail.messages.length;

    const responses = await Promise.all(
      concurrentEmails.map((email) =>
        post('/api/v1/auth/register')
          .set('Idempotency-Key', `register-capacity-${randomUUID()}`)
          .send({
            email,
            password: 'concurrent-password-123',
            display_name: 'Concurrent registration',
            invite_code: invite.plaintextCode,
            agreement_version: '2026-08-09',
          }),
      ),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    const rejected = responses.filter((response) => response.status !== 201);
    expect(rejected).toHaveLength(9);
    rejected.forEach((response) => {
      expect(response.status).toBe(403);
      expect(responseBody<ErrorResponseBody>(response).error.code).toBe(
        'REGISTRATION_NOT_ELIGIBLE',
      );
    });
    const claims = await database
      .select({ id: registrationClaims.id })
      .from(registrationClaims)
      .where(eq(registrationClaims.inviteCodeId, invite.id));
    const createdUsers = await database
      .select({ email: users.email })
      .from(users)
      .where(inArray(users.email, concurrentEmails));
    const sentMessages = fakeMail.messages
      .slice(messageOffset)
      .filter((message) => concurrentEmails.includes(message.recipient));
    expect(claims).toHaveLength(1);
    expect(createdUsers).toHaveLength(0);
    expect(sentMessages).toHaveLength(1);
  }, 30_000);

  it('converges concurrent claims for one email across different invites', async () => {
    const email = `s03-email-race-${randomUUID()}@example.test`;
    emails.add(email);
    const invites = await Promise.all([createInvite(), createInvite()]);
    const messageOffset = fakeMail.messages.length;

    const responses = await Promise.all(
      invites.map((invite, index) =>
        post('/api/v1/auth/register')
          .set('Idempotency-Key', `register-email-race-${randomUUID()}`)
          .send({
            email,
            password: `concurrent-password-${index}-123`,
            display_name: 'Concurrent email claim',
            invite_code: invite.plaintextCode,
            agreement_version: '2026-08-09',
          }),
      ),
    );

    expect(responses.map((response) => response.status).sort()).toEqual([201, 403]);
    const rejected = responses.find((response) => response.status === 403);
    expect(responseBody<ErrorResponseBody>(rejected!).error.code).toBe('REGISTRATION_NOT_ELIGIBLE');
    const identityKeys = new HmacKeyring(config.auth.rateLimitHashKeys);
    const claims = await database
      .select({ id: registrationClaims.id })
      .from(registrationClaims)
      .where(
        eq(
          registrationClaims.emailHash,
          identityKeys.digest(`registration-email\0${email}`).digest,
        ),
      );
    const createdUsers = await database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    expect(claims).toHaveLength(1);
    expect(createdUsers).toHaveLength(0);
    expect(
      fakeMail.messages.slice(messageOffset).filter((message) => message.recipient === email),
    ).toHaveLength(1);
  }, 30_000);

  it('rejects missing Origin and spoofed Host before authentication side effects', async () => {
    const invite = await createInvite(2);
    const rejectedEmails = [
      `s03-origin-${randomUUID()}@example.test`,
      `s03-host-${randomUUID()}@example.test`,
    ];
    rejectedEmails.forEach((email) => emails.add(email));
    const messageOffset = fakeMail.messages.length;
    const body = (email: string) => ({
      email,
      password: 'guard-password-123',
      display_name: 'Guard rejection',
      invite_code: invite.plaintextCode,
      agreement_version: '2026-08-09',
    });

    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/register')
      .set('Host', host)
      .set('Idempotency-Key', `register-origin-${randomUUID()}`)
      .send(body(rejectedEmails[0]!))
      .expect(403);
    await request(app.getHttpServer() as Server)
      .post('/api/v1/auth/register')
      .set('Origin', origin)
      .set('Host', 'attacker.example')
      .set('Idempotency-Key', `register-host-${randomUUID()}`)
      .send(body(rejectedEmails[1]!))
      .expect(403);

    for (const email of rejectedEmails) {
      await expect(
        database.query.users.findFirst({ where: eq(users.email, email) }),
      ).resolves.toBeUndefined();
    }
    expect(fakeMail.messages).toHaveLength(messageOffset);
  });

  it('rejects a known disposable mailbox before creating a user or sending mail', async () => {
    const email = `s03-${randomUUID()}@mailinator.com`;
    emails.add(email);
    const invite = await createInvite();
    const messageOffset = fakeMail.messages.length;

    await post('/api/v1/auth/register')
      .set('Idempotency-Key', `register-disposable-${randomUUID()}`)
      .send({
        email,
        password: 'password-123',
        display_name: 'Rejected disposable user',
        invite_code: invite.plaintextCode,
        agreement_version: '2026-08-09',
      })
      .expect(403)
      .expect((response) =>
        expect(responseBody<ErrorResponseBody>(response).error.code).toBe(
          'REGISTRATION_NOT_ELIGIBLE',
        ),
      );

    await expect(
      database.query.users.findFirst({ where: eq(users.email, email) }),
    ).resolves.toBeUndefined();
    expect(fakeMail.messages).toHaveLength(messageOffset);
  });

  it('applies a risk freeze after registration without changing the granted ledger', async () => {
    const email = `s03-risk-${randomUUID()}@example.test`;
    const registered = await registerOnly(email, 'risk-password-123');
    const verification = await post('/api/v1/auth/verify-email')
      .send({
        verification_ticket: responseBody<RegistrationResponseBody>(registered.registration)
          .verification_ticket,
        code: registered.message.otp,
      })
      .expect(201);
    const user = await database.query.users.findFirst({ where: eq(users.email, email) });
    expect(user).toBeDefined();
    await database.update(users).set({ riskStatus: 'frozen' }).where(eq(users.id, user!.id));

    await request(app.getHttpServer() as Server)
      .get('/api/v1/me')
      .set('Host', host)
      .set('Cookie', cookieHeader(verification))
      .expect(200)
      .expect((response) => {
        expect(responseBody<AuthResponseBody>(response).access).toEqual({
          can_create: false,
          can_upload: false,
          can_charge: false,
          restriction_reason: 'account_restricted',
        });
      });

    const ledgers = await database
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, user!.id));
    const reward = await database.query.registrationRewardClaims.findFirst({
      where: eq(registrationRewardClaims.userId, user!.id),
    });
    expect(ledgers).toHaveLength(1);
    expect(reward).toMatchObject({ decision: 'granted', reasonCode: null });
  });

  it('allows exactly one success when the same OTP is submitted concurrently', async () => {
    const email = `s03-concurrent-${randomUUID()}@example.test`;
    const registered = await registerOnly(email, 'concurrent-password-123');

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        post('/api/v1/auth/verify-email').send({
          verification_ticket: responseBody<RegistrationResponseBody>(registered.registration)
            .verification_ticket,
          code: registered.message.otp,
        }),
      ),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    const rejected = responses.filter((response) => response.status !== 201);
    expect(rejected).toHaveLength(9);
    expect(rejected.every((response) => response.status === 422)).toBe(true);
    expect(
      rejected.every(
        (response) =>
          responseBody<ErrorResponseBody>(response).error.code === 'AUTH_OTP_INVALID_OR_EXPIRED',
      ),
    ).toBe(true);
    expect(responses.some((response) => response.status === 503)).toBe(false);
    const user = await database.query.users.findFirst({ where: eq(users.email, email) });
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
    const ledgers = user
      ? await database.select().from(creditLedger).where(eq(creditLedger.userId, user.id))
      : [];
    expect(ledgers).toHaveLength(1);
    const invite = await database.query.inviteCodes.findFirst({
      where: eq(inviteCodes.id, registered.invite.id),
    });
    expect(invite?.usedCount).toBe(1);
  }, 30_000);

  it('invalidates the ticket and correct OTP after the fifth failed attempt', async () => {
    const email = `s03-attempts-${randomUUID()}@example.test`;
    const registered = await registerOnly(email, 'attempt-password-123');
    const ticket = responseBody<RegistrationResponseBody>(
      registered.registration,
    ).verification_ticket;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await post('/api/v1/auth/verify-email')
        .send({ verification_ticket: ticket, code: '000000' })
        .expect(422);
    }
    await post('/api/v1/auth/verify-email')
      .send({ verification_ticket: ticket, code: '000000' })
      .expect(429)
      .expect((response) =>
        expect(responseBody<ErrorResponseBody>(response).error.code).toBe(
          'AUTH_OTP_ATTEMPTS_EXCEEDED',
        ),
      );
    await post('/api/v1/auth/verify-email')
      .send({ verification_ticket: ticket, code: registered.message.otp })
      .expect(401)
      .expect((response) =>
        expect(responseBody<ErrorResponseBody>(response).error.code).toBe(
          'AUTH_VERIFICATION_TICKET_INVALID',
        ),
      );

    const user = await database.query.users.findFirst({ where: eq(users.email, email) });
    expect(user).toBeUndefined();
  });

  it('restores the previous OTP when a resend is definitely not dispatched', async () => {
    const email = `s03-restore-${randomUUID()}@example.test`;
    const registered = await registerOnly(email, 'restore-password-123');
    await clearEmailVerificationCooldown(email);
    const originalSend = fakeMail.sendVerificationMail.bind(fakeMail);
    fakeMail.sendVerificationMail = vi
      .fn()
      .mockResolvedValue({ state: 'not_dispatched', errorCode: 'TEST_NOT_DISPATCHED' });

    try {
      await post('/api/v1/auth/email-verification/request')
        .set('Idempotency-Key', `resend-${randomUUID()}`)
        .send({
          verification_ticket: responseBody<RegistrationResponseBody>(registered.registration)
            .verification_ticket,
        })
        .expect(503)
        .expect((response) =>
          expect(responseBody<ErrorResponseBody>(response).error.code).toBe(
            'AUTH_MAIL_UNAVAILABLE',
          ),
        );
    } finally {
      fakeMail.sendVerificationMail = originalSend;
    }

    await post('/api/v1/auth/verify-email')
      .send({
        verification_ticket: responseBody<RegistrationResponseBody>(registered.registration)
          .verification_ticket,
        code: registered.message.otp,
      })
      .expect(201);
  });

  it('retries a registration only after the mail adapter confirms it was not dispatched', async () => {
    const email = `s03-register-retry-${randomUUID()}@example.test`;
    emails.add(email);
    const invite = await createInvite();
    const idempotencyKey = `register-retry-${randomUUID()}`;
    const body = {
      email,
      password: 'retry-password-123',
      display_name: 'Retry user',
      invite_code: invite.plaintextCode,
      agreement_version: '2026-08-09',
    };
    const originalSend = fakeMail.sendVerificationMail.bind(fakeMail);
    fakeMail.sendVerificationMail = vi
      .fn()
      .mockResolvedValue({ state: 'not_dispatched', errorCode: 'TEST_NOT_DISPATCHED' });

    try {
      await post('/api/v1/auth/register')
        .set('Idempotency-Key', idempotencyKey)
        .send(body)
        .expect(503);
    } finally {
      fakeMail.sendVerificationMail = originalSend;
    }

    await post('/api/v1/auth/register')
      .set('Idempotency-Key', idempotencyKey)
      .send(body)
      .expect(201);
    expect(
      fakeMail.messages.filter(
        (message) => message.recipient === email && message.purpose === 'email_verification',
      ),
    ).toHaveLength(1);
  });

  it('serializes concurrent registration retries so the delivered OTP remains valid', async () => {
    const email = `s03-retry-race-${randomUUID()}@example.test`;
    emails.add(email);
    const invite = await createInvite();
    const idempotencyKey = `register-concurrent-retry-${randomUUID()}`;
    const body = {
      email,
      password: 'concurrent-retry-password-123',
      display_name: 'Concurrent retry user',
      invite_code: invite.plaintextCode,
      agreement_version: '2026-08-09',
    };
    const originalSend = fakeMail.sendVerificationMail.bind(fakeMail);
    fakeMail.sendVerificationMail = vi
      .fn()
      .mockResolvedValue({ state: 'not_dispatched', errorCode: 'TEST_NOT_DISPATCHED' });

    try {
      await post('/api/v1/auth/register')
        .set('Idempotency-Key', idempotencyKey)
        .send(body)
        .expect(503);
    } finally {
      fakeMail.sendVerificationMail = originalSend;
    }
    const messageOffset = fakeMail.messages.length;

    const retries = await Promise.all(
      Array.from({ length: 2 }, () =>
        post('/api/v1/auth/register').set('Idempotency-Key', idempotencyKey).send(body),
      ),
    );
    expect(retries.filter((response) => response.status === 201)).toHaveLength(1);
    expect(retries.filter((response) => response.status === 503)).toHaveLength(1);
    const delivered = fakeMail.messages
      .slice(messageOffset)
      .filter((message) => message.recipient === email && message.purpose === 'email_verification');
    expect(delivered).toHaveLength(1);
    const accepted = retries.find((response) => response.status === 201)!;

    await post('/api/v1/auth/verify-email')
      .send({
        verification_ticket: responseBody<RegistrationResponseBody>(accepted).verification_ticket,
        code: delivered[0]!.otp,
      })
      .expect(201);
  }, 30_000);

  it('keeps the existing OTP when a queued registration delivery has an unknown outcome', async () => {
    const email = `s03-register-queued-${randomUUID()}@example.test`;
    emails.add(email);
    const invite = await createInvite();
    const idempotencyKey = `register-queued-${randomUUID()}`;
    const body = {
      email,
      password: 'queued-password-123',
      display_name: 'Queued delivery user',
      invite_code: invite.plaintextCode,
      agreement_version: '2026-08-09',
    };
    const originalSend = fakeMail.sendVerificationMail.bind(fakeMail);
    fakeMail.sendVerificationMail = vi
      .fn()
      .mockResolvedValue({ state: 'not_dispatched', errorCode: 'TEST_NOT_DISPATCHED' });

    try {
      await post('/api/v1/auth/register')
        .set('Idempotency-Key', idempotencyKey)
        .send(body)
        .expect(503);
    } finally {
      fakeMail.sendVerificationMail = originalSend;
    }

    const identityKeys = new HmacKeyring(config.auth.rateLimitHashKeys);
    const claim = await database.query.registrationClaims.findFirst({
      where: eq(
        registrationClaims.emailHash,
        identityKeys.digest(`registration-email\0${email}`).digest,
      ),
    });
    expect(claim).toBeDefined();
    const delivery = await database.query.mailDeliveries.findFirst({
      where: eq(mailDeliveries.idempotencyKey, `register:${claim!.id}:v1`),
    });
    expect(delivery).toBeDefined();
    await database
      .update(mailDeliveries)
      .set({ status: 'queued', lastErrorCode: null, updatedAt: new Date() })
      .where(eq(mailDeliveries.id, delivery!.id));
    const recipientKeys = new HmacKeyring(config.auth.recipientHashKeys);
    const identifier = recipientKeys.digest(`email-verification-otp-${email}`).digest;
    const otpBefore = await database.query.authVerifications.findFirst({
      where: eq(authVerifications.identifier, identifier),
    });
    const messageOffset = fakeMail.messages.length;

    await post('/api/v1/auth/register')
      .set('Idempotency-Key', idempotencyKey)
      .send(body)
      .expect(503)
      .expect((response) =>
        expect(responseBody<ErrorResponseBody>(response).error.code).toBe('AUTH_MAIL_UNAVAILABLE'),
      );

    const otpAfter = await database.query.authVerifications.findFirst({
      where: eq(authVerifications.identifier, identifier),
    });
    expect(otpAfter).toMatchObject({ id: otpBefore?.id, value: otpBefore?.value });
    expect(fakeMail.messages).toHaveLength(messageOffset);
  });

  it('recovers a stale accepted mail attempt as outcome unknown without dispatching it again', async () => {
    const recipient = `s03-mail-recovery-${randomUUID()}@example.test`;
    const idempotencyKey = `mail-recovery-${randomUUID()}`;
    const store = new DrizzleMailDeliveryStore(
      database,
      new HmacKeyring(config.auth.recipientHashKeys),
    );
    try {
      const queued = await store.queue({
        recipient,
        purpose: 'email_verification',
        provider: 'fake',
        idempotencyKey,
        userId: null,
      });
      expect(queued.dispatchRequired).toBe(true);

      const accepted = await fakeMail.sendVerificationMail({
        recipient,
        purpose: 'email_verification',
        otp: '123456',
        expiresInMinutes: 10,
      });
      expect(accepted.state).toBe('accepted');
      const dispatchCountAfterAccepted = fakeMail.messages.length;

      await database
        .update(mailDeliveries)
        .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
        .where(eq(mailDeliveries.idempotencyKey, idempotencyKey));

      await expect(
        store.recoverStaleQueued(new Date(Date.now() - 5 * 60_000)),
      ).resolves.toBeGreaterThanOrEqual(1);
      const recovered = await database.query.mailDeliveries.findFirst({
        where: eq(mailDeliveries.idempotencyKey, idempotencyKey),
      });
      expect(recovered).toMatchObject({
        status: 'outcome_unknown',
        lastErrorCode: 'MAIL_RECOVERY_OUTCOME_UNKNOWN',
        attemptCount: 1,
      });
      expect(fakeMail.messages).toHaveLength(dispatchCountAfterAccepted);

      const replay = await store.queue({
        recipient,
        purpose: 'email_verification',
        provider: 'fake',
        idempotencyKey,
        userId: null,
      });
      expect(replay).toMatchObject({
        dispatchRequired: false,
        previousResult: {
          state: 'outcome_unknown',
          errorCode: 'MAIL_RECOVERY_OUTCOME_UNKNOWN',
        },
      });
      expect(fakeMail.messages).toHaveLength(dispatchCountAfterAccepted);
    } finally {
      await database
        .delete(mailDeliveries)
        .where(eq(mailDeliveries.idempotencyKey, idempotencyKey));
    }
  });

  it('releases an expired email claim before registering with a different invite', async () => {
    const email = `s03-expired-claim-${randomUUID()}@example.test`;
    emails.add(email);
    const expiredInvite = await createInvite();
    const replacementInvite = await createInvite();
    const expiredClaimId = randomUUID();
    const identityKeys = new HmacKeyring(config.auth.rateLimitHashKeys);
    await database.insert(registrationClaims).values({
      id: expiredClaimId,
      inviteCodeId: expiredInvite.id,
      emailHash: identityKeys.digest(`registration-email\0${email}`).digest,
      ticketHash: identityKeys.digest(`expired-ticket\0${expiredClaimId}`).digest,
      ticketNonce: randomUUID(),
      ticketVersion: 1,
      status: 'pending',
      idempotencyKey: `expired-registration-${randomUUID()}`,
      requestHash: identityKeys.digest(`expired-request\0${expiredClaimId}`).digest,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const messageOffset = fakeMail.messages.length;
    const registration = await post('/api/v1/auth/register')
      .set('Idempotency-Key', `replacement-registration-${randomUUID()}`)
      .send({
        email,
        password: 'replacement-password-123',
        display_name: 'Replacement registration',
        invite_code: replacementInvite.plaintextCode,
        agreement_version: '2026-08-09',
      })
      .expect(201);

    const expiredClaim = await database.query.registrationClaims.findFirst({
      where: eq(registrationClaims.id, expiredClaimId),
    });
    expect(expiredClaim?.status).toBe('expired');
    expect(expiredClaim?.ticketHash).toBeNull();

    const message = fakeMail.messages
      .slice(messageOffset)
      .find(
        (candidate) => candidate.recipient === email && candidate.purpose === 'email_verification',
      );
    expect(message).toBeDefined();
    await post('/api/v1/auth/verify-email')
      .send({
        verification_ticket:
          responseBody<RegistrationResponseBody>(registration).verification_ticket,
        code: message!.otp,
      })
      .expect(201);
    await post('/api/v1/auth/login')
      .send({ email, password: 'replacement-password-123' })
      .expect(201);
  });

  it('does not let password reset verify an unverified registration', async () => {
    const email = `s03-purpose-${randomUUID()}@example.test`;
    const registered = await registerOnly(email, 'purpose-password-123');
    const messageOffset = fakeMail.messages.length;

    await post('/api/v1/auth/password-reset/request').send({ email }).expect(202);
    const resetMessage = fakeMail.messages
      .slice(messageOffset)
      .find((candidate) => candidate.recipient === email && candidate.purpose === 'password_reset');
    expect(resetMessage).toBeUndefined();
    await post('/api/v1/auth/password-reset/confirm')
      .send({
        email,
        code: registered.message.otp,
        new_password: 'replacement-password-456',
      })
      .expect(422);
    const user = await database.query.users.findFirst({ where: eq(users.email, email) });
    expect(user).toBeUndefined();
  });
});
