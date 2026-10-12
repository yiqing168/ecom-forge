import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { and, authSessions, eq, users, type Database } from '@ecom-forge/db';

import type { AuthActivityService } from './auth-activity.service.js';
import type { VerificationRateLimiter } from './rate-limit/verification-rate-limiter.js';
import type { HmacKeyring } from './security/hmac-keyring.js';

const AGENT_USER_LIMIT = { max: 30, windowSeconds: 60 } as const;
const AGENT_IP_LIMIT = { max: 120, windowSeconds: 60 } as const;
const MEDIA_USER_LIMIT = { max: 120, windowSeconds: 60 } as const;
const MEDIA_IP_LIMIT = { max: 180, windowSeconds: 60 } as const;
/**
 * Serving the bytes behind an already-issued capability is the inevitable
 * consequence of a request that was rate limited when the signed URL was minted
 * — it is not a fresh unauthenticated call. Charging it to the same budget made
 * a single viewed image cost two units, so ordinary browsing of a gallery
 * exhausted the limit and every later image failed with 429. It gets its own,
 * deliberately generous budget: normal viewing never trips it, while a script
 * replaying capabilities is still bounded.
 */
const MEDIA_CONTENT_USER_LIMIT = { max: 1200, windowSeconds: 60 } as const;
const MEDIA_CONTENT_IP_LIMIT = { max: 1800, windowSeconds: 60 } as const;
// A single empty balance is a normal product state. Only sustained, distinct retries lock an account.
const ZERO_CREDIT_FREEZE_LIMIT = { max: 10, windowSeconds: 600 } as const;

export class AccountFrozenError extends ForbiddenException {
  constructor() {
    super({
      ok: false,
      data: null,
      error: { code: 'ACCOUNT_FROZEN', message: '当前账户已被暂时锁定，请联系管理员处理' },
    });
  }
}

export class RequestRateLimitedError extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      {
        ok: false,
        data: null,
        error: {
          code: 'RATE_LIMITED',
          message: '请求过于频繁，请稍后再试',
          retry_after_seconds: retryAfterSeconds,
        },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export class AbuseProtectionService {
  constructor(
    private readonly database: Database,
    private readonly limiter: VerificationRateLimiter,
    private readonly keys: HmacKeyring,
    private readonly activity: AuthActivityService,
  ) {}

  async assertAgentRequest(userId: string, ipBucket: string): Promise<void> {
    await this.assertWithinLimits('agent', userId, ipBucket, AGENT_USER_LIMIT, AGENT_IP_LIMIT);
  }

  async assertMediaRequest(
    userId: string,
    ipBucket: string,
    operation: 'upload' | 'preview' | 'download',
  ): Promise<void> {
    await this.assertWithinLimits(
      `media:${operation}`,
      userId,
      ipBucket,
      MEDIA_USER_LIMIT,
      MEDIA_IP_LIMIT,
    );
  }

  /**
   * Budget for fetching bytes with a capability the caller already holds.
   * Kept separate from {@link assertMediaRequest} so normal viewing is not
   * double-charged against the signed-URL issuance limit.
   */
  async assertMediaContentRequest(userId: string, ipBucket: string): Promise<void> {
    await this.assertWithinLimits(
      'media:content',
      userId,
      ipBucket,
      MEDIA_CONTENT_USER_LIMIT,
      MEDIA_CONTENT_IP_LIMIT,
    );
  }

  async recordZeroCreditAttempt(userId: string, ipBucket: string): Promise<void> {
    const identity = this.keys.digest(`zero-credit\0${userId}`).digest;
    const result = await this.limiter.consume(
      `abuse:zero-credit:user:${identity}:10m`,
      ZERO_CREDIT_FREEZE_LIMIT,
    );
    if (result.remaining > 0) return;
    await this.freezeUser(userId, ipBucket);
  }

  private async assertWithinLimits(
    operation: string,
    userId: string,
    ipBucket: string,
    userRule: { max: number; windowSeconds: number },
    ipRule: { max: number; windowSeconds: number },
  ): Promise<void> {
    const userIdentity = this.keys.digest(`${operation}\0user\0${userId}`).digest;
    const ipIdentity = this.keys.digest(`${operation}\0ip\0${ipBucket}`).digest;
    const results = await Promise.all([
      this.limiter.consume(`abuse:${operation}:user:${userIdentity}`, userRule),
      this.limiter.consume(`abuse:${operation}:ip:${ipIdentity}`, ipRule),
    ]);
    const blocked = results.find((result) => !result.allowed);
    if (blocked) throw new RequestRateLimitedError(blocked.retryAfterSeconds);
  }

  private async freezeUser(userId: string, ipBucket: string): Promise<void> {
    let frozen = false;
    await this.database.transaction(async (transaction) => {
      const [user] = await transaction
        .select({ id: users.id, riskStatus: users.riskStatus, riskRevision: users.riskRevision })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      if (!user || user.riskStatus === 'frozen') return;
      const [updated] = await transaction
        .update(users)
        .set({ riskStatus: 'frozen', riskRevision: user.riskRevision + 1, updatedAt: new Date() })
        .where(and(eq(users.id, userId), eq(users.riskRevision, user.riskRevision)))
        .returning({ id: users.id });
      if (!updated) return;
      await transaction.delete(authSessions).where(eq(authSessions.userId, userId));
      frozen = true;
    });
    if (frozen) {
      await this.activity.record({
        activityType: 'risk_block',
        userId,
        targetType: 'user',
        targetId: userId,
        context: { ipBucket },
        metadata: {
          operation: 'automatic_zero_credit_abuse_lock',
          threshold: ZERO_CREDIT_FREEZE_LIMIT.max,
          window_seconds: ZERO_CREDIT_FREEZE_LIMIT.windowSeconds,
        },
      });
    }
  }
}
