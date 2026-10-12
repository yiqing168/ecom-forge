import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCreditAccount: vi.fn(),
  getCreditLedger: vi.fn(),
  getCurrentUser: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/components/layout/product-shell', () => ({
  ProductShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/lib/auth-api', () => mocks);

import { AccountPage } from './account-task-pages';

afterEach(cleanup);

describe('AccountPage', () => {
  beforeEach(() => {
    mocks.getCurrentUser.mockReset().mockResolvedValue({
      access: {
        can_charge: true,
        can_create: true,
        can_upload: true,
        restriction_reason: null,
      },
      user: {
        display_name: '测试用户',
        email: 'real@example.com',
        email_verified: true,
        id: 'user-1',
      },
    });
    mocks.getCreditAccount.mockReset().mockResolvedValue({
      as_of: '2026-08-30T00:00:00.000Z',
      available: '317.00',
      balance: '317.00',
      currency: 'credits',
      frozen: '4.00',
    });
    mocks.getCreditLedger.mockReset().mockResolvedValue({
      items: [
        {
          amount: '-3.00',
          balance_after: '317.00',
          created_at: '2026-08-30T08:00:00.000Z',
          frozen_after: '4.00',
          id: 'ledger-1',
          reservation_id: null,
          type: 'consume',
          workflow_run_id: 'workflow-1',
        },
      ],
      next_cursor: null,
    });
  });

  it('renders the authenticated account and ledger returned by the API', async () => {
    render(<AccountPage />);

    await waitFor(() => expect(screen.getByText('317.00')).toBeInstanceOf(HTMLElement));

    expect(screen.getByText('real@example.com')).toBeInstanceOf(HTMLElement);
    expect(screen.getByText('生成消费')).toBeInstanceOf(HTMLElement);
    expect(screen.getByText('已加载流水')).toBeInstanceOf(HTMLElement);
    expect(screen.getByText('已显示全部流水')).toBeInstanceOf(HTMLElement);
    expect(screen.queryByRole('button', { name: /查看我的权益/ })).toBeNull();
    expect(screen.queryByText('468.00')).toBeNull();
    expect(mocks.getCreditLedger).toHaveBeenCalledWith();
  });

  it('renders an empty ledger without inventing entries', async () => {
    mocks.getCreditLedger.mockResolvedValueOnce({ items: [], next_cursor: null });

    render(<AccountPage />);

    expect(await screen.findByText('暂无积分流水')).toBeInstanceOf(HTMLElement);
    expect(screen.queryByText('生成消费')).toBeNull();
    expect(screen.queryByText('已显示全部流水')).toBeNull();
  });

  it('loads the next ledger page and formats positive amounts as strings', async () => {
    mocks.getCreditLedger
      .mockResolvedValueOnce({
        items: [
          {
            amount: '10.00',
            balance_after: '327.00',
            created_at: '2026-08-30T08:00:00.000Z',
            frozen_after: '4.00',
            id: 'ledger-grant',
            reservation_id: null,
            type: 'grant',
            workflow_run_id: null,
          },
        ],
        next_cursor: 'cursor-1',
      })
      .mockResolvedValueOnce({
        items: [
          {
            amount: '2.00',
            balance_after: '329.00',
            created_at: '2026-08-29T08:00:00.000Z',
            frozen_after: '4.00',
            id: 'ledger-release',
            reservation_id: 'reservation-1',
            type: 'release',
            workflow_run_id: 'workflow-1',
          },
        ],
        next_cursor: null,
      });

    render(<AccountPage />);

    const firstAmount = await screen.findByText('+10.00');
    expect(firstAmount.className).toContain('text-[var(--info-foreground)]');
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));

    expect(await screen.findByText('+2.00')).toBeInstanceOf(HTMLElement);
    expect(screen.getByText('已显示全部流水')).toBeInstanceOf(HTMLElement);
    expect(mocks.getCreditLedger).toHaveBeenNthCalledWith(2, 'cursor-1');
  });

  it('keeps the loaded ledger when the next page fails and retries that page', async () => {
    mocks.getCreditLedger
      .mockResolvedValueOnce({
        items: [
          {
            amount: '10.00',
            balance_after: '327.00',
            created_at: '2026-08-30T08:00:00.000Z',
            frozen_after: '4.00',
            id: 'ledger-grant',
            reservation_id: null,
            type: 'grant',
            workflow_run_id: null,
          },
        ],
        next_cursor: 'cursor-1',
      })
      .mockRejectedValueOnce(new Error('下一页暂时无法加载'))
      .mockResolvedValueOnce({ items: [], next_cursor: null });

    render(<AccountPage />);

    await screen.findByText('+10.00');
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByText('下一页暂时无法加载')).toBeInstanceOf(HTMLElement);
    expect(screen.getByText('+10.00')).toBeInstanceOf(HTMLElement);

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByText('已显示全部流水')).toBeInstanceOf(HTMLElement));
    expect(mocks.getCreditLedger).toHaveBeenNthCalledWith(3, 'cursor-1');
  });

  it('keeps account summary available when ledger loading fails', async () => {
    mocks.getCreditLedger.mockRejectedValueOnce(new Error('账本服务暂时不可用'));

    render(<AccountPage />);

    expect(await screen.findByText('real@example.com')).toBeInstanceOf(HTMLElement);
    expect(screen.getByText('317.00')).toBeInstanceOf(HTMLElement);
    expect(screen.getByText('账本服务暂时不可用')).toBeInstanceOf(HTMLElement);
    expect(screen.getByRole('button', { name: '重试' })).toBeInstanceOf(HTMLElement);
  });

  it('renders verification and restriction state from the authenticated user', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({
      access: {
        can_charge: false,
        can_create: false,
        can_upload: true,
        restriction_reason: 'email_verification_required',
      },
      user: {
        display_name: '待验证用户',
        email: 'unverified@example.com',
        email_verified: false,
        id: 'user-2',
      },
    });

    render(<AccountPage />);

    expect(await screen.findByText('unverified@example.com')).toBeInstanceOf(HTMLElement);
    expect(screen.getByText('待验证')).toBeInstanceOf(HTMLElement);
    expect(screen.getByText('需完成邮箱验证')).toBeInstanceOf(HTMLElement);
  });

  it('keeps zero amounts neutral and gives unknown ledger types a fallback label', async () => {
    mocks.getCreditLedger.mockResolvedValueOnce({
      items: [
        {
          amount: '-0.00',
          balance_after: '317.00',
          created_at: '2026-08-30T08:00:00.000Z',
          frozen_after: '4.00',
          id: 'ledger-zero',
          reservation_id: null,
          type: 'future_type',
          workflow_run_id: null,
        },
      ],
      next_cursor: null,
    });

    render(<AccountPage />);

    const amount = await screen.findByText('-0.00');
    expect(amount.className).not.toContain('text-[var(--danger)]');
    expect(screen.getByText('其他流水')).toBeInstanceOf(HTMLElement);
  });
});
