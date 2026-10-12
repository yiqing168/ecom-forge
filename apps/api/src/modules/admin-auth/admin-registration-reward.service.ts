import { randomUUID } from 'node:crypto';

import { adminAuditLogs, desc, eq, rewardCampaigns, sql, type Database } from '@ecom-forge/db';
import {
  compareMoney,
  multiplyMoney,
  normalizeMoney,
  scopedAdvisoryLockKey,
} from '@ecom-forge/shared';
import { Injectable } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import {
  REGISTRATION_REWARD_CAMPAIGN_KEY,
  REGISTRATION_REWARD_ELIGIBILITY,
  REGISTRATION_REWARD_MAX_CREDITS,
  REGISTRATION_REWARD_MAX_GRANTS,
} from '../auth/registration/registration-reward.constants.js';
import { HmacKeyring } from '../auth/security/hmac-keyring.js';
import { adminAuthError } from './admin-errors.js';
import type { AdminRequest, AdminSessionContext } from './admin-http.js';
import { AdminIdempotencyRepository } from './admin-idempotency.repository.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function requestId(request: AdminRequest): string {
  const value = request.headers['x-request-id'];
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : `admin-registration-reward:${randomUUID()}`;
}

@Injectable()
export class AdminRegistrationRewardService {
  private readonly idempotency: AdminIdempotencyRepository;
  private readonly idempotencyHash: HmacKeyring;

  constructor(
    private readonly database: Database,
    config: AppConfig,
  ) {
    this.idempotency = new AdminIdempotencyRepository(database, config.admin.idempotencyHashKeys);
    this.idempotencyHash = new HmacKeyring(config.admin.idempotencyHashKeys);
  }

  async get(): Promise<Record<string, unknown>> {
    const latest = await this.database.query.rewardCampaigns.findFirst({
      where: eq(rewardCampaigns.campaignKey, REGISTRATION_REWARD_CAMPAIGN_KEY),
      orderBy: [desc(rewardCampaigns.versionNo)],
    });
    return this.response(latest);
  }

  async update(
    context: AdminSessionContext,
    request: AdminRequest,
    input: { enabled: boolean; credits: string; idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    const credits = normalizeMoney(input.credits);
    if (
      compareMoney(credits, '0.00') <= 0 ||
      compareMoney(credits, REGISTRATION_REWARD_MAX_CREDITS) > 0
    ) {
      adminAuthError('ADMIN_REGISTRATION_REWARD_INVALID', 422);
    }
    return this.idempotency.execute({
      context,
      operation: 'registration_reward.update',
      idempotencyKey: input.idempotencyKey,
      request: { enabled: input.enabled, credits },
      responseStatus: 200,
      write: async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey(
            'reward-campaign-key',
            REGISTRATION_REWARD_CAMPAIGN_KEY,
          )})`,
        );
        const rows = await transaction
          .select()
          .from(rewardCampaigns)
          .where(eq(rewardCampaigns.campaignKey, REGISTRATION_REWARD_CAMPAIGN_KEY))
          .orderBy(desc(rewardCampaigns.versionNo))
          .for('update');
        const latest = rows[0];
        const active = rows.find((row) => row.status === 'active');
        const now = new Date();
        if (active) {
          await transaction
            .update(rewardCampaigns)
            .set({ status: 'disabled', disabledAt: now, revision: active.revision + 1 })
            .where(eq(rewardCampaigns.id, active.id));
        }
        const [created] = await transaction
          .insert(rewardCampaigns)
          .values({
            campaignKey: REGISTRATION_REWARD_CAMPAIGN_KEY,
            versionNo: (latest?.versionNo ?? 0) + 1,
            kind: 'registration',
            status: input.enabled ? 'active' : 'disabled',
            grantCredits: credits,
            maxGrants: REGISTRATION_REWARD_MAX_GRANTS,
            budgetCredits: multiplyMoney(credits, String(REGISTRATION_REWARD_MAX_GRANTS)),
            eligibilityPolicyJson: REGISTRATION_REWARD_ELIGIBILITY,
            createdByAdminId: context.principalId,
            activatedAt: input.enabled ? now : null,
            disabledAt: input.enabled ? null : now,
          })
          .returning();
        if (!created) adminAuthError('ADMIN_WRITE_FAILED', 503);
        await this.audit(transaction, context, request, {
          targetId: created.id,
          idempotencyKey: input.idempotencyKey,
          before: this.response(latest),
          after: this.response(created),
        });
        return this.response(created);
      },
    });
  }

  private response(row: typeof rewardCampaigns.$inferSelect | undefined): Record<string, unknown> {
    return {
      enabled: row?.status === 'active',
      credits: row?.grantCredits ?? '0.00',
      version: row?.versionNo ?? 0,
      updated_at: row?.activatedAt ?? row?.disabledAt ?? row?.createdAt ?? null,
    };
  }

  private async audit(
    transaction: Transaction,
    context: AdminSessionContext,
    request: AdminRequest,
    input: {
      targetId: string;
      idempotencyKey: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    },
  ): Promise<void> {
    await transaction.insert(adminAuditLogs).values({
      actorAdminId: context.principalId,
      actorType: 'admin_session',
      adminSessionId: context.id,
      permissionSnapshot: { permissions: context.permissions },
      action: 'registration_reward.updated',
      targetType: 'registration_reward_setting',
      targetId: input.targetId,
      beforeJson: input.before,
      afterJson: input.after,
      reason: 'admin_registration_reward_setting',
      requestId: requestId(request),
      idempotencyKeyHash: this.idempotencyHash.digest(input.idempotencyKey).digest,
      sourceIpHash: context.sourceIpHash,
      userAgentHash: context.userAgentHash,
      mfaLevel: context.mfaLevel,
      stepUpAt: context.stepUpAt,
      result: 'succeeded',
    });
  }
}
