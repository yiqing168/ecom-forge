import { describe, expect, it, vi } from 'vitest';

import { AdminCreditService } from './admin-credit.service.js';

const context = { principalId: '00000000-0000-4000-8000-000000000001' } as never;
const config = {
  resourceCursorSecret: 's14-credit-cursor-secret-at-least-32-bytes',
  admin: {
    idempotencyHashKeys: 'v1:s14-credit-idempotency-hash-secret-at-least-32-bytes',
    sourceHashKeys: 'v1:s14-credit-source-hash-secret-at-least-32-bytes',
  },
} as never;

function database(input: {
  account: { balance: string; frozen: string; version: number };
  ledger: { accountVersion: number; balanceAfter: string; frozenAfter: string };
}) {
  const account = {
    userId: '00000000-0000-4000-8000-000000000002',
    updatedAt: new Date('2026-08-14T00:00:00.000Z'),
    ...input.account,
  };
  const limit = vi.fn().mockResolvedValue([account]);
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({ limit })),
        })),
      })),
    })),
    query: {
      creditLedger: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: '00000000-0000-4000-8000-000000000003',
            createdAt: new Date('2026-08-14T00:00:00.000Z'),
            ...input.ledger,
          },
        ]),
      },
    },
  };
}

describe('AdminCreditService reconciliation', () => {
  it('reports a healthy account when ledger replay and projection match', async () => {
    const db = database({
      account: { balance: '10.00', frozen: '0.00', version: 1 },
      ledger: { accountVersion: 1, balanceAfter: '10.00', frozenAfter: '0.00' },
    });
    const service = new AdminCreditService(db as never, config);

    const result = await service.reconcile(context, { limit: 20 });

    expect(result).toMatchObject({
      summary: { checked: 1, drifted: 0 },
      items: [
        {
          status: 'healthy',
          reasons: [],
          account: { balance: '10.00', frozen: '0.00', version: 1 },
          replay: { balance: '10.00', frozen: '0.00', ledger_count: 1 },
        },
      ],
      next_cursor: null,
    });
    expect(JSON.stringify(result)).not.toContain('00000000-0000-4000-8000-000000000002');
  });

  it('reports balance and version drift without mutating the ledger', async () => {
    const db = database({
      account: { balance: '9.00', frozen: '0.00', version: 2 },
      ledger: { accountVersion: 1, balanceAfter: '10.00', frozenAfter: '0.00' },
    });
    const service = new AdminCreditService(db as never, config);

    const result = await service.reconcile(context, { limit: 20 });

    expect(result).toMatchObject({
      summary: { checked: 1, drifted: 1 },
      items: [
        {
          status: 'drift',
        },
      ],
    });
    expect(JSON.stringify(result)).toContain('ledger_count_mismatch');
    expect(JSON.stringify(result)).toContain('balance_mismatch');
    expect(db.select).toHaveBeenCalledOnce();
  });
});
