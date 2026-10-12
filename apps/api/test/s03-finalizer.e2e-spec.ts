import { randomUUID } from 'node:crypto';

import {
  and,
  authAccounts,
  creditAccounts,
  creditLedger,
  createDatabaseClient,
  desc,
  eq,
  inviteCodeRedemptions,
  inviteCodes,
  registrationClaims,
  registrationRewardClaims,
  rewardCampaigns,
  userActivityLogs,
  users,
} from '@ecom-forge/db';
import { describe, expect, it } from 'vitest';

import { loadAppConfig } from '../src/config/app-config.js';
import { RegistrationFinalizer } from '../src/modules/auth/registration/registration-finalizer.js';
import {
  REGISTRATION_REWARD_CAMPAIGN_KEY,
  REGISTRATION_REWARD_ELIGIBILITY,
} from '../src/modules/auth/registration/registration-reward.constants.js';
import { HmacKeyring } from '../src/modules/auth/security/hmac-keyring.js';

describe('S03 registration finalizer', () => {
  it('redeems the invite and grants registration credit exactly once', async () => {
    const resource = createDatabaseClient();
    const config = loadAppConfig();
    const finalizer = new RegistrationFinalizer(
      resource.db,
      new HmacKeyring(config.auth.mailboxFingerprintKeys),
      new HmacKeyring(config.auth.recipientHashKeys),
      new HmacKeyring(config.auth.otpHashKeys),
    );
    const userId = randomUUID();
    const inviteCodeId = randomUUID();
    const claimId = randomUUID();
    const email = `${userId}@example.test`;
    const now = new Date();
    let rewardCampaignId: string | null = null;

    try {
      // The partial unique index `reward_campaigns_active_key_unique` allows only one active
      // campaign per key. Tests must not depend on leftover rows from earlier runs on a shared
      // test database, so retire any stale active campaign before seeding this run's campaign.
      await resource.db
        .update(rewardCampaigns)
        .set({ status: 'disabled', disabledAt: now })
        .where(
          and(
            eq(rewardCampaigns.campaignKey, REGISTRATION_REWARD_CAMPAIGN_KEY),
            eq(rewardCampaigns.status, 'active'),
          ),
        );
      const latestReward = await resource.db.query.rewardCampaigns.findFirst({
        where: eq(rewardCampaigns.campaignKey, REGISTRATION_REWARD_CAMPAIGN_KEY),
        orderBy: [desc(rewardCampaigns.versionNo)],
      });
      const [rewardCampaign] = await resource.db
        .insert(rewardCampaigns)
        .values({
          campaignKey: REGISTRATION_REWARD_CAMPAIGN_KEY,
          versionNo: (latestReward?.versionNo ?? 0) + 1,
          kind: 'registration',
          status: 'active',
          grantCredits: '100.00',
          maxGrants: 100,
          budgetCredits: '10000.00',
          eligibilityPolicyJson: REGISTRATION_REWARD_ELIGIBILITY,
          activatedAt: now,
        })
        .returning({ id: rewardCampaigns.id });
      rewardCampaignId = rewardCampaign?.id ?? null;
      await resource.db.insert(users).values({
        id: userId,
        email,
        displayName: 'S03 finalizer test',
        emailVerifiedAt: now,
      });
      await resource.db.insert(inviteCodes).values({
        id: inviteCodeId,
        codeDigest: `digest-${inviteCodeId}`,
        keyId: 'test-key',
        codePrefix: 'TEST',
        maxUses: 1,
        usedCount: 0,
      });
      await resource.db.insert(registrationClaims).values({
        id: claimId,
        inviteCodeId,
        userId,
        emailHash: `email-${userId}`,
        ticketHash: null,
        ticketNonce: null,
        status: 'verified',
        idempotencyKey: `finalizer-${userId}`,
        requestHash: `request-${userId}`,
        expiresAt: new Date(now.getTime() + 600_000),
      });

      const [first, second] = await Promise.all([
        finalizer.finalize(userId),
        finalizer.finalize(userId),
      ]);
      const third = await finalizer.finalize(userId);

      expect(first).toEqual({ redeemed: true, reward: 'granted' });
      expect(second).toEqual({ redeemed: true, reward: 'granted' });
      expect(third).toEqual({ redeemed: true, reward: 'granted' });

      const [invite] = await resource.db
        .select({ usedCount: inviteCodes.usedCount })
        .from(inviteCodes)
        .where(eq(inviteCodes.id, inviteCodeId));
      const redemptions = await resource.db
        .select({ id: inviteCodeRedemptions.id })
        .from(inviteCodeRedemptions)
        .where(eq(inviteCodeRedemptions.userId, userId));
      const rewards = await resource.db
        .select({
          decision: registrationRewardClaims.decision,
          ledgerId: registrationRewardClaims.ledgerId,
        })
        .from(registrationRewardClaims)
        .where(eq(registrationRewardClaims.userId, userId));
      const ledgers = await resource.db
        .select({ amount: creditLedger.amount })
        .from(creditLedger)
        .where(eq(creditLedger.userId, userId));
      const [account] = await resource.db
        .select({ balance: creditAccounts.balance })
        .from(creditAccounts)
        .where(eq(creditAccounts.userId, userId));

      expect(invite?.usedCount).toBe(1);
      expect(redemptions).toHaveLength(1);
      expect(rewards).toHaveLength(1);
      expect(rewards[0]).toMatchObject({ decision: 'granted' });
      expect(rewards[0]?.ledgerId).toEqual(expect.any(String));
      expect(ledgers).toEqual([{ amount: '100.00' }]);
      expect(account).toEqual({ balance: '100.00' });
    } finally {
      await resource.db
        .delete(registrationRewardClaims)
        .where(eq(registrationRewardClaims.userId, userId));
      await resource.db.delete(userActivityLogs).where(eq(userActivityLogs.userId, userId));
      await resource.db.delete(creditLedger).where(eq(creditLedger.userId, userId));
      await resource.db.delete(creditAccounts).where(eq(creditAccounts.userId, userId));
      await resource.db.delete(registrationClaims).where(eq(registrationClaims.id, claimId));
      await resource.db
        .delete(inviteCodeRedemptions)
        .where(eq(inviteCodeRedemptions.userId, userId));
      await resource.db.delete(authAccounts).where(eq(authAccounts.userId, userId));
      await resource.db.delete(users).where(eq(users.id, userId));
      await resource.db.delete(inviteCodes).where(eq(inviteCodes.id, inviteCodeId));
      if (rewardCampaignId) {
        await resource.db.delete(rewardCampaigns).where(eq(rewardCampaigns.id, rewardCampaignId));
      }
      await resource.client.end();
    }
  }, 30_000);
});
