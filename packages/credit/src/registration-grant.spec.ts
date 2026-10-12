import { describe, expect, it, vi } from 'vitest';

import { grantRegistrationCreditsInTransaction } from './registration-grant.js';

const input = {
  userId: 'user-1',
  rewardClaimId: 'reward-1',
  amount: '10.00',
  idempotencyKey: 'registration_reward:v1:user-1',
  metadata: { source: 'test' },
} as const;

function transaction(
  options: {
    campaign?: Record<string, unknown>;
    existingLedger?: unknown;
    ledgerSnapshots?: { balanceAfter: string; frozenAfter: string }[];
  } = {},
) {
  let updateCount = 0;
  let selectCount = 0;
  const account = { balance: '2.00', frozen: '0.00', version: 1 };
  const ledgerReturning = vi.fn().mockResolvedValue([{ id: 'ledger-1' }]);
  const rewardReturning = vi.fn().mockResolvedValue([{ id: 'reward-1' }]);
  const accountReturning = vi.fn().mockResolvedValue([{ userId: input.userId }]);
  const campaignReturning = vi.fn().mockResolvedValue([{ id: 'campaign-1' }]);

  const database = {
    query: {
      creditLedger: {
        findFirst: vi.fn().mockResolvedValue(options.existingLedger ?? null),
        findMany: vi.fn().mockResolvedValue(
          options.ledgerSnapshots ?? [
            {
              id: 'ledger-legacy-1',
              accountVersion: null,
              balanceAfter: '2.00',
              frozenAfter: '0.00',
              createdAt: new Date(1),
            },
          ],
        ),
      },
    },
    select: vi.fn(() => {
      selectCount += 1;
      const selected = options.campaign && selectCount === 1 ? options.campaign : account;
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            for: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([selected]) })),
          })),
        })),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: ledgerReturning,
        onConflictDoNothing: vi.fn(() => ({ returning: ledgerReturning })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => {
          updateCount += 1;
          return {
            returning:
              updateCount === 1
                ? rewardReturning
                : updateCount === 2
                  ? accountReturning
                  : campaignReturning,
          };
        }),
      })),
    })),
  };

  return { accountReturning, database, ledgerReturning, rewardReturning };
}

describe('registration credit grant', () => {
  it('writes one ledger row and advances the balance', async () => {
    const { database } = transaction();

    const result = await grantRegistrationCreditsInTransaction(database as never, input);

    expect(result).toEqual({ ledgerId: 'ledger-1', balanceAfter: '12.00', alreadyGranted: false });
    expect(database.insert).toHaveBeenCalledOnce();
    expect(database.update).toHaveBeenCalledTimes(2);
  });

  it('rejects a reused idempotency key with a different amount', async () => {
    const { database } = transaction({
      existingLedger: {
        id: 'ledger-old',
        userId: input.userId,
        amount: '9.00',
        balanceAfter: '11.00',
      },
    });

    await expect(grantRegistrationCreditsInTransaction(database as never, input)).rejects.toThrow(
      'Credit grant idempotency conflict',
    );
    expect(database.select).not.toHaveBeenCalled();
  });

  it('rejects a non-positive normalized grant at the boundary', async () => {
    const { database } = transaction();

    await expect(
      grantRegistrationCreditsInTransaction(database as never, { ...input, amount: '0.001' }),
    ).rejects.toThrow('Credit grant amount must be greater than zero');
    expect(database.query.creditLedger.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a grant when the account projection has drifted from ledger replay', async () => {
    const { database } = transaction({
      ledgerSnapshots: [{ balanceAfter: '1.00', frozenAfter: '0.00' }],
    });

    await expect(grantRegistrationCreditsInTransaction(database as never, input)).rejects.toThrow(
      'Credit account projection does not match ledger replay',
    );
    expect(database.insert).not.toHaveBeenCalled();
    expect(database.update).not.toHaveBeenCalled();
  });

  it('atomically advances an active campaign projection', async () => {
    const { database } = transaction({
      campaign: {
        id: 'campaign-1',
        status: 'active',
        startsAt: null,
        expiresAt: null,
        grantCredits: '10.00',
        grantedCount: 0,
        maxGrants: 2,
        grantedCredits: '0.00',
        budgetCredits: '20.00',
      },
    });

    await expect(
      grantRegistrationCreditsInTransaction(database as never, {
        ...input,
        rewardCampaignId: 'campaign-1',
      }),
    ).resolves.toMatchObject({ alreadyGranted: false, balanceAfter: '12.00' });
    expect(database.update).toHaveBeenCalledTimes(3);
  });

  it('rejects an exhausted campaign before locking the credit account', async () => {
    const { database } = transaction({
      campaign: {
        id: 'campaign-1',
        status: 'active',
        startsAt: null,
        expiresAt: null,
        grantCredits: '10.00',
        grantedCount: 1,
        maxGrants: 1,
        grantedCredits: '10.00',
        budgetCredits: '10.00',
      },
    });

    await expect(
      grantRegistrationCreditsInTransaction(database as never, {
        ...input,
        rewardCampaignId: 'campaign-1',
      }),
    ).rejects.toThrow('COUNT_EXHAUSTED');
    expect(database.insert).not.toHaveBeenCalled();
  });
});
