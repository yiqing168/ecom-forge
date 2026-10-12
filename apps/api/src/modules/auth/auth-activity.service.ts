import { Logger } from '@nestjs/common';
import { userActivityLogs, type Database } from '@ecom-forge/db';
import type { UserActivityType } from '@ecom-forge/types';

import type { HmacKeyring } from './security/hmac-keyring.js';

type AuthActivityType = Extract<
  UserActivityType,
  'email_verify' | 'login' | 'password_reset' | 'register' | 'risk_block'
>;

export interface AuthActivityInput {
  activityType: AuthActivityType;
  userId: string | null;
  targetType: string;
  targetId?: string | null;
  context?: { ipBucket: string; deviceBucket?: string };
  metadata?: Record<string, unknown>;
}

export class AuthActivityService {
  private readonly logger = new Logger(AuthActivityService.name);

  constructor(
    private readonly database: Database,
    private readonly identityKeys: HmacKeyring,
  ) {}

  async record(input: AuthActivityInput): Promise<void> {
    const metadata: Record<string, unknown> = { ...input.metadata };
    if (input.context) {
      metadata.ip_hash = this.identityKeys.digest(`audit-ip\0${input.context.ipBucket}`).digest;
      if (input.context.deviceBucket) {
        metadata.device_hash = this.identityKeys.digest(
          `audit-device\0${input.context.deviceBucket}`,
        ).digest;
      }
    }

    try {
      await this.database.insert(userActivityLogs).values({
        userId: input.userId,
        activityType: input.activityType,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        metadata,
      });
    } catch {
      this.logger.error({
        event: 'auth_activity_write_failed',
        activity_type: input.activityType,
        error_code: 'AUTH_ACTIVITY_WRITE_FAILED',
      });
    }
  }
}
