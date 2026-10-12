import { randomUUID } from 'node:crypto';
import {
  and,
  authAccounts,
  authVerifications,
  desc,
  eq,
  inArray,
  inviteCodeRedemptions,
  inviteCodes,
  registrationClaims,
  registrationRewardClaims,
  rewardCampaigns,
  userActivityLogs,
  users,
  type Database,
} from '@ecom-forge/db';
import {
  grantRegistrationCreditsInTransaction,
  RewardCampaignGrantError,
} from '@ecom-forge/credit';
import { addMoney, compareMoney, normalizeMoney } from '@ecom-forge/shared';

import { REGISTRATION_REWARD_CAMPAIGN_KEY } from './registration-reward.constants.js';
import {
  EMAIL_RISK_RULES_VERSION,
  isBlockedRegistrationEmail,
  rewardMailboxIdentity,
} from '../security/email.js';
import type { HmacKeyring } from '../security/hmac-keyring.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type RegistrationCompletionResult =
  | {
      kind: 'completed';
      user: { id: string; email: string; displayName: string; emailVerified: true };
      reward: RegistrationFinalizerResult['reward'];
    }
  | { kind: 'invalid_otp' }
  | { kind: 'attempts_exhausted' }
  | { kind: 'invalid_claim' };

export interface RegistrationFinalizerResult {
  redeemed: boolean;
  reward: 'granted' | 'rejected' | 'disabled' | 'pending';
}

type RewardDecision = 'granted' | 'rejected';

function isSupportedEligibilityPolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return (
    Object.keys(policy).length === 4 &&
    policy.require_verified_email === true &&
    policy.require_normal_risk === true &&
    policy.deny_blocked_email === true &&
    policy.one_per_mailbox === true
  );
}

async function recordRewardDecision(
  transaction: Pick<Database, 'insert'>,
  input: {
    campaignKey: string;
    decision: RewardDecision;
    reasonCode?: string | null;
    rewardClaimId: string;
    userId: string;
  },
): Promise<void> {
  await transaction.insert(userActivityLogs).values({
    userId: input.userId,
    activityType: 'registration_reward',
    targetType: 'registration_reward_claim',
    targetId: input.rewardClaimId,
    metadata: {
      campaign_key: input.campaignKey,
      decision: input.decision,
      ...(input.reasonCode ? { reason_code: input.reasonCode } : {}),
    },
  });
}

export class RegistrationFinalizer {
  constructor(
    private readonly database: Database,
    private readonly fingerprintKeys: HmacKeyring,
    private readonly identifierKeys: HmacKeyring,
    private readonly otpKeys: HmacKeyring,
  ) {}

  async completePendingRegistration(
    claimId: string,
    otp: string,
  ): Promise<RegistrationCompletionResult> {
    return this.database.transaction(async (transaction) => {
      const [claim] = await transaction
        .select()
        .from(registrationClaims)
        .where(eq(registrationClaims.id, claimId))
        .for('update')
        .limit(1);
      const now = new Date();
      if (
        !claim ||
        claim.status !== 'pending' ||
        claim.expiresAt <= now ||
        !claim.pendingEmail ||
        !claim.pendingDisplayName ||
        !claim.pendingPasswordHash
      ) {
        if (claim?.status === 'pending' && claim.expiresAt <= now) {
          await this.expirePendingClaim(transaction, claim.id, now);
        }
        return { kind: 'invalid_claim' as const };
      }

      const identifiers = this.identifierKeys
        .candidates(`email-verification-otp-${claim.pendingEmail}`)
        .map((candidate) => candidate.digest);
      const [verification] = await transaction
        .select()
        .from(authVerifications)
        .where(inArray(authVerifications.identifier, identifiers))
        .for('update')
        .limit(1);
      if (!verification || verification.expiresAt <= now) {
        if (verification) {
          await transaction
            .delete(authVerifications)
            .where(eq(authVerifications.id, verification.id));
        }
        return { kind: 'invalid_otp' as const };
      }

      const separator = verification.value.lastIndexOf(':');
      const storedDigest = separator > 0 ? verification.value.slice(0, separator) : '';
      const attempts = Number(separator > 0 ? verification.value.slice(separator + 1) : '');
      if (!storedDigest || !Number.isInteger(attempts) || attempts < 0) {
        await transaction
          .delete(authVerifications)
          .where(eq(authVerifications.id, verification.id));
        return { kind: 'invalid_otp' as const };
      }
      if (!this.otpKeys.matches(otp, storedDigest)) {
        const nextAttempts = attempts + 1;
        if (nextAttempts >= 5) {
          await transaction
            .delete(authVerifications)
            .where(eq(authVerifications.id, verification.id));
          await this.expirePendingClaim(transaction, claim.id, now);
          return { kind: 'attempts_exhausted' as const };
        }
        await transaction
          .update(authVerifications)
          .set({ value: `${storedDigest}:${nextAttempts}`, updatedAt: now })
          .where(eq(authVerifications.id, verification.id));
        return { kind: 'invalid_otp' as const };
      }

      const userId = randomUUID();
      await transaction.insert(users).values({
        id: userId,
        email: claim.pendingEmail,
        displayName: claim.pendingDisplayName,
        emailVerifiedAt: now,
      });
      await transaction.insert(authAccounts).values({
        id: randomUUID(),
        userId,
        accountId: userId,
        providerId: 'credential',
        password: claim.pendingPasswordHash,
      });
      const [bound] = await transaction
        .update(registrationClaims)
        .set({ userId, status: 'verified', updatedAt: now })
        .where(and(eq(registrationClaims.id, claim.id), eq(registrationClaims.status, 'pending')))
        .returning({ id: registrationClaims.id });
      if (!bound) throw new Error('Registration claim completion lost its write lock');

      await transaction.delete(authVerifications).where(eq(authVerifications.id, verification.id));
      const finalization = await this.finalizeInTransaction(transaction, userId);
      if (!finalization.redeemed) {
        throw new Error('Registration completion did not redeem the invitation');
      }
      return {
        kind: 'completed' as const,
        user: {
          id: userId,
          email: claim.pendingEmail,
          displayName: claim.pendingDisplayName,
          emailVerified: true as const,
        },
        reward: finalization.reward,
      };
    });
  }

  private async expirePendingClaim(
    transaction: Transaction,
    claimId: string,
    now: Date,
  ): Promise<void> {
    await transaction
      .update(registrationClaims)
      .set({
        status: 'expired',
        ticketHash: null,
        ticketNonce: null,
        pendingEmail: null,
        pendingDisplayName: null,
        pendingPasswordHash: null,
        updatedAt: now,
      })
      .where(and(eq(registrationClaims.id, claimId), eq(registrationClaims.status, 'pending')));
  }

  async finalize(userId: string): Promise<RegistrationFinalizerResult> {
    return this.database.transaction((transaction) =>
      this.finalizeInTransaction(transaction, userId),
    );
  }

  private async finalizeInTransaction(
    transaction: Transaction,
    userId: string,
  ): Promise<RegistrationFinalizerResult> {
    const user = await transaction.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (!user?.emailVerifiedAt) {
      throw new Error('Registration finalizer requires a verified email');
    }
    const claim = await transaction.query.registrationClaims.findFirst({
      where: and(eq(registrationClaims.userId, userId), eq(registrationClaims.status, 'verified')),
    });
    if (!claim) {
      const redeemed = await transaction.query.registrationClaims.findFirst({
        where: and(
          eq(registrationClaims.userId, userId),
          eq(registrationClaims.status, 'redeemed'),
        ),
      });
      if (!redeemed) return { redeemed: false, reward: 'pending' as const };
      const reward = await transaction.query.registrationRewardClaims.findFirst({
        where: eq(registrationRewardClaims.userId, userId),
      });
      return {
        redeemed: true,
        reward:
          reward?.decision === 'granted'
            ? ('granted' as const)
            : reward?.reasonCode === 'REWARD_DISABLED'
              ? ('disabled' as const)
              : ('rejected' as const),
      };
    }

    const [invite] = await transaction
      .select()
      .from(inviteCodes)
      .where(eq(inviteCodes.id, claim.inviteCodeId))
      .for('update')
      .limit(1);
    if (!invite) throw new Error('Registration invite disappeared');

    const [rewardCampaign] = await transaction
      .select()
      .from(rewardCampaigns)
      .where(eq(rewardCampaigns.campaignKey, REGISTRATION_REWARD_CAMPAIGN_KEY))
      .orderBy(desc(rewardCampaigns.versionNo))
      .for('update')
      .limit(1);
    const now = new Date();
    const campaignKey = REGISTRATION_REWARD_CAMPAIGN_KEY;
    const rewardAmount = rewardCampaign?.grantCredits ?? '0.00';
    const campaignUnavailable =
      !rewardCampaign ||
      rewardCampaign.status !== 'active' ||
      (rewardCampaign.startsAt !== null && rewardCampaign.startsAt > now) ||
      (rewardCampaign.expiresAt !== null && rewardCampaign.expiresAt <= now) ||
      !isSupportedEligibilityPolicy(rewardCampaign.eligibilityPolicyJson);
    const campaignExhausted = rewardCampaign
      ? rewardCampaign.grantedCount >= rewardCampaign.maxGrants ||
        compareMoney(
          addMoney(rewardCampaign.grantedCredits, rewardCampaign.grantCredits),
          normalizeMoney(rewardCampaign.budgetCredits),
        ) > 0
      : false;

    const [redemption] = await transaction
      .insert(inviteCodeRedemptions)
      .values({
        inviteCodeId: invite.id,
        userId,
        redeemedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [inviteCodeRedemptions.inviteCodeId, inviteCodeRedemptions.userId],
      })
      .returning({ id: inviteCodeRedemptions.id });
    if (redemption) {
      await transaction
        .update(inviteCodes)
        .set({ usedCount: invite.usedCount + 1 })
        .where(eq(inviteCodes.id, invite.id));
    }
    await transaction
      .update(registrationClaims)
      .set({
        status: 'redeemed',
        ticketHash: null,
        ticketNonce: null,
        pendingEmail: null,
        pendingDisplayName: null,
        pendingPasswordHash: null,
        updatedAt: new Date(),
      })
      .where(and(eq(registrationClaims.id, claim.id), eq(registrationClaims.status, 'verified')));

    const fingerprintSeed = `registration-reward-v1\0${rewardMailboxIdentity(user.email)}`;
    const fingerprint = this.fingerprintKeys.digest(fingerprintSeed);
    const fingerprintCandidates = this.fingerprintKeys
      .candidates(fingerprintSeed)
      .map((candidate) => candidate.digest);
    const existingMailboxReward = await transaction.query.registrationRewardClaims.findFirst({
      where: and(
        eq(registrationRewardClaims.campaignKey, campaignKey),
        inArray(registrationRewardClaims.mailboxFingerprint, fingerprintCandidates),
      ),
    });
    if (existingMailboxReward && existingMailboxReward.userId !== userId) {
      await recordRewardDecision(transaction, {
        campaignKey,
        decision: 'rejected',
        reasonCode: 'MAILBOX_ALREADY_REWARDED',
        rewardClaimId: existingMailboxReward.id,
        userId,
      });
      return { redeemed: true, reward: 'rejected' as const };
    }
    const rejectionReason = campaignUnavailable
      ? 'REWARD_DISABLED'
      : campaignExhausted
        ? 'REWARD_BUDGET_EXHAUSTED'
        : user.riskStatus !== 'normal'
          ? 'ACCOUNT_RESTRICTED'
          : isBlockedRegistrationEmail(user.email)
            ? 'EMAIL_DOMAIN_RESTRICTED'
            : null;
    const [createdReward] = await transaction
      .insert(registrationRewardClaims)
      .values({
        campaignKey,
        rewardCampaignId: rewardCampaign?.id ?? null,
        userId,
        mailboxFingerprint: fingerprint.digest,
        fingerprintKeyId: fingerprint.keyId,
        fingerprintRulesVersion: EMAIL_RISK_RULES_VERSION,
        decision: rejectionReason ? 'rejected' : 'pending',
        reasonCode: rejectionReason,
      })
      .onConflictDoNothing()
      .returning({
        id: registrationRewardClaims.id,
        decision: registrationRewardClaims.decision,
        reasonCode: registrationRewardClaims.reasonCode,
      });
    const reward =
      createdReward ??
      (await transaction.query.registrationRewardClaims.findFirst({
        where: and(
          eq(registrationRewardClaims.campaignKey, campaignKey),
          eq(registrationRewardClaims.userId, userId),
        ),
      }));
    if (!reward) throw new Error('Registration reward claim did not converge');
    if (reward.decision === 'granted') {
      if (createdReward) {
        await recordRewardDecision(transaction, {
          campaignKey,
          decision: 'granted',
          rewardClaimId: reward.id,
          userId,
        });
      }
      return { redeemed: true, reward: 'granted' as const };
    }
    if (reward.decision === 'rejected') {
      if (createdReward) {
        await recordRewardDecision(transaction, {
          campaignKey,
          decision: 'rejected',
          reasonCode: reward.reasonCode,
          rewardClaimId: reward.id,
          userId,
        });
      }
      return {
        redeemed: true,
        reward: reward.reasonCode === 'REWARD_DISABLED' ? 'disabled' : 'rejected',
      };
    }

    if (rejectionReason) {
      const [rejectedReward] = await transaction
        .update(registrationRewardClaims)
        .set({ decision: 'rejected', reasonCode: rejectionReason, updatedAt: new Date() })
        .where(
          and(
            eq(registrationRewardClaims.id, reward.id),
            eq(registrationRewardClaims.decision, 'pending'),
          ),
        )
        .returning({ id: registrationRewardClaims.id });
      if (rejectedReward) {
        await recordRewardDecision(transaction, {
          campaignKey,
          decision: 'rejected',
          reasonCode: rejectionReason,
          rewardClaimId: rejectedReward.id,
          userId,
        });
      }
      return {
        redeemed: true,
        reward: rejectionReason === 'REWARD_DISABLED' ? 'disabled' : 'rejected',
      };
    }

    try {
      await grantRegistrationCreditsInTransaction(transaction, {
        userId,
        rewardClaimId: reward.id,
        amount: rewardAmount,
        idempotencyKey: rewardCampaign
          ? `registration_reward:${rewardCampaign.id}:${userId}`
          : `registration_reward:v1:${userId}`,
        metadata: {
          campaign_key: campaignKey,
          ...(rewardCampaign ? { reward_campaign_id: rewardCampaign.id } : {}),
          source: 'email_verification_finalizer',
        },
        ...(rewardCampaign ? { rewardCampaignId: rewardCampaign.id } : {}),
      });
    } catch (error) {
      if (!(error instanceof RewardCampaignGrantError)) throw error;
      const [rejectedReward] = await transaction
        .update(registrationRewardClaims)
        .set({
          decision: 'rejected',
          reasonCode:
            error.code === 'BUDGET_EXHAUSTED' || error.code === 'COUNT_EXHAUSTED'
              ? 'REWARD_BUDGET_EXHAUSTED'
              : 'REWARD_DISABLED',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(registrationRewardClaims.id, reward.id),
            eq(registrationRewardClaims.decision, 'pending'),
          ),
        )
        .returning({ id: registrationRewardClaims.id });
      if (rejectedReward) {
        await recordRewardDecision(transaction, {
          campaignKey,
          decision: 'rejected',
          reasonCode:
            error.code === 'BUDGET_EXHAUSTED' || error.code === 'COUNT_EXHAUSTED'
              ? 'REWARD_BUDGET_EXHAUSTED'
              : 'REWARD_DISABLED',
          rewardClaimId: reward.id,
          userId,
        });
      }
      return { redeemed: true, reward: 'rejected' as const };
    }
    await recordRewardDecision(transaction, {
      campaignKey,
      decision: 'granted',
      rewardClaimId: reward.id,
      userId,
    });
    return { redeemed: true, reward: 'granted' as const };
  }
}
