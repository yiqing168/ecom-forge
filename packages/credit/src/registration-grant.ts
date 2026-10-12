import {
  and,
  creditAccounts,
  creditLedger,
  eq,
  registrationRewardClaims,
  rewardCampaigns,
  type Database,
} from '@ecom-forge/db';
import { addMoney, compareMoney, normalizeMoney, type MoneyString } from '@ecom-forge/shared';

import { lockCreditAccount } from './credit-account.js';
export interface RegistrationCreditGrantInput {
  userId: string;
  rewardClaimId: string;
  amount: MoneyString;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  rewardCampaignId?: string;
}

type CreditWriteContext = Pick<Database, 'query' | 'select' | 'insert' | 'update'>;

export interface RegistrationCreditGrantResult {
  ledgerId: string;
  balanceAfter: MoneyString;
  alreadyGranted: boolean;
}

export class RewardCampaignGrantError extends Error {
  constructor(
    readonly code: 'INACTIVE' | 'WINDOW' | 'BUDGET_EXHAUSTED' | 'COUNT_EXHAUSTED' | 'MISMATCH',
  ) {
    super(`Reward campaign grant rejected: ${code}`);
    this.name = 'RewardCampaignGrantError';
  }
}

export async function grantRegistrationCreditsInTransaction(
  transaction: CreditWriteContext,
  input: RegistrationCreditGrantInput,
): Promise<RegistrationCreditGrantResult> {
  const amount = normalizeMoney(input.amount);
  if (compareMoney(amount, '0.00') <= 0) {
    throw new RangeError('Credit grant amount must be greater than zero');
  }
  const existing = await transaction.query.creditLedger.findFirst({
    where: eq(creditLedger.idempotencyKey, input.idempotencyKey),
  });
  if (existing) {
    if (
      existing.userId !== input.userId ||
      existing.type !== 'grant' ||
      normalizeMoney(existing.amount) !== amount
    ) {
      throw new Error('Credit grant idempotency conflict');
    }
    return {
      ledgerId: existing.id,
      balanceAfter: normalizeMoney(existing.balanceAfter),
      alreadyGranted: true,
    };
  }

  const now = new Date();
  const [campaign] = input.rewardCampaignId
    ? await transaction
        .select()
        .from(rewardCampaigns)
        .where(eq(rewardCampaigns.id, input.rewardCampaignId))
        .for('update')
        .limit(1)
    : [];
  if (input.rewardCampaignId) {
    if (!campaign || campaign.status !== 'active') {
      throw new RewardCampaignGrantError('INACTIVE');
    }
    if (
      (campaign.startsAt && campaign.startsAt > now) ||
      (campaign.expiresAt && campaign.expiresAt <= now)
    ) {
      throw new RewardCampaignGrantError('WINDOW');
    }
    if (normalizeMoney(campaign.grantCredits) !== amount) {
      throw new RewardCampaignGrantError('MISMATCH');
    }
    if (campaign.grantedCount >= campaign.maxGrants) {
      throw new RewardCampaignGrantError('COUNT_EXHAUSTED');
    }
    if (compareMoney(addMoney(campaign.grantedCredits, amount), campaign.budgetCredits) > 0) {
      throw new RewardCampaignGrantError('BUDGET_EXHAUSTED');
    }
  }

  const accountState = await lockCreditAccount(transaction, input.userId);
  const balanceAfter = addMoney(accountState.balance, amount);
  const frozenAfter = accountState.frozen;
  const [ledger] = await transaction
    .insert(creditLedger)
    .values({
      userId: input.userId,
      type: 'grant',
      amount,
      idempotencyKey: input.idempotencyKey,
      accountVersion: accountState.version + 1,
      balanceAfter,
      frozenAfter,
      metadata: input.metadata,
    })
    .returning({ id: creditLedger.id });
  if (!ledger) throw new Error('Credit grant ledger insert returned no row');

  const [updatedReward] = await transaction
    .update(registrationRewardClaims)
    .set({ decision: 'granted', ledgerId: ledger.id, updatedAt: new Date() })
    .where(
      and(
        eq(registrationRewardClaims.id, input.rewardClaimId),
        eq(registrationRewardClaims.userId, input.userId),
        eq(registrationRewardClaims.decision, 'pending'),
        input.rewardCampaignId
          ? eq(registrationRewardClaims.rewardCampaignId, input.rewardCampaignId)
          : undefined,
      ),
    )
    .returning({ id: registrationRewardClaims.id });
  if (!updatedReward) throw new Error('Registration reward claim was not pending');

  const [updatedAccount] = await transaction
    .update(creditAccounts)
    .set({
      balance: balanceAfter,
      frozen: frozenAfter,
      version: accountState.version + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(creditAccounts.userId, input.userId),
        eq(creditAccounts.version, accountState.version),
      ),
    )
    .returning({ userId: creditAccounts.userId });
  if (!updatedAccount) throw new Error('Registration grant account version conflict');

  if (campaign) {
    const nextGrantedCredits = addMoney(campaign.grantedCredits, amount);
    const [updatedCampaign] = await transaction
      .update(rewardCampaigns)
      .set({
        grantedCount: campaign.grantedCount + 1,
        grantedCredits: nextGrantedCredits,
      })
      .where(
        and(
          eq(rewardCampaigns.id, campaign.id),
          eq(rewardCampaigns.status, 'active'),
          eq(rewardCampaigns.grantedCount, campaign.grantedCount),
          eq(rewardCampaigns.grantedCredits, campaign.grantedCredits),
        ),
      )
      .returning({ id: rewardCampaigns.id });
    if (!updatedCampaign) throw new Error('Reward campaign projection conflict');
  }
  return { ledgerId: ledger.id, balanceAfter, alreadyGranted: false };
}

export async function grantRegistrationCredits(
  database: Database,
  input: RegistrationCreditGrantInput,
): Promise<RegistrationCreditGrantResult> {
  return database.transaction((transaction) =>
    grantRegistrationCreditsInTransaction(transaction, input),
  );
}
