'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, CircleAlert, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import { ProductShell } from '@/components/layout/product-shell';
import { Button } from '@/components/ui/button';
import { MetricStrip, PageHeader, StatusBadge } from '@/features/product-pages/ui';
import {
  getCreditAccount,
  getCreditLedger,
  getCurrentUser,
  type AuthUserResponse,
  type CreditAccountResponse,
  type CreditLedgerItem,
} from '@/lib/auth-api';

const tasks = [
  { cost: '8.00', id: 'TK-8F31', name: '电影感时装大片', status: '处理中', time: '刚刚' },
  { cost: '12.00', id: 'TK-8F20', name: '连衣裙白底精修', status: '已完成', time: '今天 14:32' },
  { cost: '6.00', id: 'TK-8E91', name: '香氛广告视觉', status: '等待中', time: '今天 12:08' },
  { cost: '0.00', id: 'TK-8E55', name: '运动鞋场景图', status: '失败', time: '昨天 18:40' },
  { cost: '10.00', id: 'TK-8D72', name: '家居空间提案', status: '已退款', time: '昨天 10:16' },
];

export function TasksPage() {
  const [filter, setFilter] = useState('全部');
  return (
    <ProductShell activeItem="任务" title="任务">
      <PageHeader
        description="生成、检查、导出与退款进度都以这里的服务端状态为准"
        title="任务中心"
      />
      <MetricStrip
        items={[
          { label: '处理中', value: '1' },
          { label: '等待确认', value: '1' },
          { label: '本周完成', value: '24' },
          { label: '本周消耗', value: '186.00' },
        ]}
      />
      <div className="mb-4 flex gap-1 border-b border-[var(--border)]">
        {['全部', '处理中', '失败', '已完成'].map((item) => (
          <button
            className={`min-h-11 cursor-pointer border-b-2 px-4 text-sm font-medium ${filter === item ? 'border-[var(--primary)] text-[var(--foreground)]' : 'border-transparent text-[var(--muted-foreground)]'}`}
            key={item}
            onClick={() => setFilter(item)}
            type="button"
          >
            {item}
          </button>
        ))}
      </div>
      <div className="border-y border-[var(--border)]">
        {tasks
          .filter((task) => filter === '全部' || task.status === filter)
          .map((task, index) => (
            <div
              className={`flex flex-col gap-3 p-4 sm:flex-row sm:items-center ${index > 0 ? 'border-t border-[var(--border)]' : ''}`}
              key={task.id}
            >
              <span
                className={`grid size-10 shrink-0 place-items-center rounded-md ${task.status === '失败' ? 'bg-[var(--danger-soft)] text-[var(--danger)]' : 'bg-[var(--soft)] text-[var(--primary)]'}`}
              >
                {task.status === '失败' ? (
                  <CircleAlert aria-hidden="true" size={19} />
                ) : (
                  <Sparkles aria-hidden="true" size={18} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold">{task.name}</p>
                  <StatusBadge status={task.status} />
                </div>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  {task.id} · {task.time}
                </p>
              </div>
              <div className="flex items-center justify-between gap-4 sm:justify-end">
                <span className="text-sm tabular-nums text-[var(--muted-foreground)]">
                  {task.cost} 积分
                </span>
                {task.status === '失败' ? (
                  <Button size="sm" variant="outline">
                    <RotateCcw aria-hidden="true" size={14} />
                    重试
                  </Button>
                ) : (
                  <button
                    className="grid size-11 place-items-center rounded-md hover:bg-[var(--soft)]"
                    title="任务详情"
                    type="button"
                  >
                    <ChevronRight aria-hidden="true" size={17} />
                  </button>
                )}
              </div>
            </div>
          ))}
      </div>
    </ProductShell>
  );
}

const ledgerTypeLabels: Record<CreditLedgerItem['type'], string> = {
  appeal_refund: '申诉退回',
  consume: '生成消费',
  expiry: '积分过期',
  grant: '积分发放',
  manual_correction: '账户调整',
  release: '预留释放',
  reservation_freeze: '生成预留',
};

type AccountState = {
  access: AuthUserResponse['access'] | null;
  account: CreditAccountResponse | null;
  accountError: string;
  ledger: CreditLedgerItem[];
  ledgerError: string;
  ledgerLoading: boolean;
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  user: AuthUserResponse['user'] | null;
};

const initialAccountState: AccountState = {
  access: null,
  account: null,
  accountError: '',
  ledger: [],
  ledgerError: '',
  ledgerLoading: true,
  loading: true,
  loadingMore: false,
  nextCursor: null,
  user: null,
};

function formatLedgerDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'numeric',
  }).format(new Date(value));
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function formatLedgerAmount(amount: string): string {
  return isZeroAmount(amount) || amount.startsWith('-') ? amount : `+${amount}`;
}

function ledgerAmountClass(amount: string): string {
  if (amount.startsWith('-') && !isZeroAmount(amount)) return 'text-[var(--danger)]';
  if (!isZeroAmount(amount)) return 'text-[var(--info-foreground)]';
  return '';
}

function isZeroAmount(amount: string): boolean {
  return /^[+-]?0(?:\.0+)?$/.test(amount);
}

export function AccountPage() {
  const [state, setState] = useState<AccountState>(initialAccountState);

  const loadSummary = useCallback(async () => {
    setState((current) => ({ ...current, accountError: '', loading: true }));
    try {
      const [user, account] = await Promise.all([getCurrentUser(), getCreditAccount()]);
      setState((current) => ({
        ...current,
        access: user.access,
        account,
        accountError: '',
        loading: false,
        user: user.user,
      }));
    } catch (cause) {
      setState((current) => ({
        ...current,
        accountError: errorMessage(cause, '账户信息加载失败，请重试'),
        loading: false,
      }));
    }
  }, []);

  const loadLedger = useCallback(async () => {
    setState((current) => ({
      ...current,
      ledgerError: '',
      ledgerLoading: true,
      loadingMore: false,
      nextCursor: null,
    }));
    try {
      const ledgerPage = await getCreditLedger();
      setState((current) => ({
        ...current,
        ledger: ledgerPage.items,
        ledgerError: '',
        ledgerLoading: false,
        nextCursor: ledgerPage.next_cursor,
      }));
    } catch (cause) {
      setState((current) => ({
        ...current,
        ledgerError: errorMessage(cause, '账本加载失败，请重试'),
        ledgerLoading: false,
      }));
    }
  }, []);

  const loadMoreLedger = useCallback(async () => {
    if (!state.nextCursor || state.loadingMore) return;
    const cursor = state.nextCursor;
    setState((current) => ({ ...current, ledgerError: '', loadingMore: true }));
    try {
      const page = await getCreditLedger(cursor);
      setState((current) => ({
        ...current,
        ledger: [...current.ledger, ...page.items],
        ledgerError: '',
        loadingMore: false,
        nextCursor: page.next_cursor,
      }));
    } catch (cause) {
      setState((current) => ({
        ...current,
        ledgerError: errorMessage(cause, '账本加载失败，请重试'),
        loadingMore: false,
      }));
    }
  }, [state.loadingMore, state.nextCursor]);

  useEffect(() => {
    void loadSummary();
    void loadLedger();
  }, [loadLedger, loadSummary]);

  const retryLedger = useCallback(() => {
    if (state.ledger.length > 0 && state.nextCursor) {
      void loadMoreLedger();
      return;
    }
    void loadLedger();
  }, [loadLedger, loadMoreLedger, state.ledger.length, state.nextCursor]);

  return (
    <ProductShell activeItem="账户" title="账户">
      <PageHeader description="积分与账户安全" title="账户" />
      {state.accountError && !state.account ? (
        <section className="border-y border-[var(--border)] py-14 text-center">
          <p className="text-sm text-[var(--danger)]">{state.accountError}</p>
          <Button className="mt-4" onClick={() => void loadSummary()} variant="outline">
            <RefreshCw aria-hidden="true" size={14} />
            重新加载
          </Button>
        </section>
      ) : state.loading ? (
        <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]" role="status">
          <div className="h-44 animate-pulse rounded-lg bg-[var(--soft)]" />
          <div className="h-44 animate-pulse rounded-lg bg-[var(--soft)]" />
          <span className="sr-only">正在加载账户信息</span>
        </div>
      ) : state.account && state.user ? (
        <>
          <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
            <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6">
              <p className="text-sm text-[var(--muted-foreground)]">可用积分</p>
              <p className="mt-2 text-4xl font-bold tabular-nums">{state.account.available}</p>
              <div className="mt-7 flex gap-8 text-sm">
                <div>
                  <p className="text-[var(--muted-foreground)]">冻结中</p>
                  <p className="mt-1 font-semibold tabular-nums">{state.account.frozen}</p>
                </div>
                <div>
                  <p className="text-[var(--muted-foreground)]">已加载流水</p>
                  <p className="mt-1 font-semibold tabular-nums">{state.ledger.length}</p>
                </div>
              </div>
            </section>
            <section className="rounded-lg border border-[var(--border)] bg-white p-5">
              <h2 className="font-bold">账号安全</h2>
              <div className="mt-4 space-y-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <span>登录邮箱</span>
                  <span className="truncate text-[var(--muted-foreground)]">
                    {state.user.email}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>邮箱验证</span>
                  <span className="text-[var(--muted-foreground)]">
                    {state.user.email_verified ? '已验证' : '待验证'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>账户状态</span>
                  <span className="text-[var(--muted-foreground)]">
                    {!state.user.email_verified
                      ? '需完成邮箱验证'
                      : state.access?.restriction_reason
                        ? '当前受限'
                        : state.access?.can_create
                          ? '可正常创作'
                          : '暂不可创作'}
                  </span>
                </div>
              </div>
            </section>
          </div>
          <div className="mb-3 mt-8 flex items-center justify-between gap-4">
            <h2 className="text-lg font-bold">积分明细</h2>
            {state.ledgerError ? (
              <div className="flex items-center gap-2">
                <p className="text-sm text-[var(--danger)]">{state.ledgerError}</p>
                {!state.ledgerLoading && !state.loadingMore ? (
                  <Button onClick={retryLedger} size="sm" variant="outline">
                    重试
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-white">
            {state.ledgerLoading && state.ledger.length === 0 ? (
              <p
                className="px-4 py-14 text-center text-sm text-[var(--muted-foreground)]"
                role="status"
              >
                正在加载积分流水
              </p>
            ) : state.ledger.length === 0 ? (
              <p className="px-4 py-14 text-center text-sm text-[var(--muted-foreground)]">
                {state.ledgerError ? '积分流水暂时无法加载' : '暂无积分流水'}
              </p>
            ) : (
              state.ledger.map((item, index) => (
                <div
                  className={`grid gap-3 px-4 py-4 sm:grid-cols-[1fr_140px_100px] sm:items-center ${index > 0 ? 'border-t border-[var(--border)]' : ''}`}
                  key={item.id}
                >
                  <div>
                    <p className="text-sm font-semibold">
                      {ledgerTypeLabels[item.type] ?? '其他流水'}
                    </p>
                    <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                      {formatLedgerDate(item.created_at)}
                    </p>
                  </div>
                  <p className={`text-sm font-bold tabular-nums ${ledgerAmountClass(item.amount)}`}>
                    {formatLedgerAmount(item.amount)}
                  </p>
                  <p className="text-right text-xs text-[var(--muted-foreground)]">
                    余额 {item.balance_after}
                  </p>
                </div>
              ))
            )}
          </div>
          {state.nextCursor ? (
            <div className="mt-4 flex justify-center">
              <Button
                disabled={state.loadingMore}
                onClick={() => void loadMoreLedger()}
                variant="outline"
              >
                {state.loadingMore ? '加载中…' : '加载更多'}
              </Button>
            </div>
          ) : state.ledger.length > 0 ? (
            <p className="mt-4 text-center text-xs text-[var(--muted-foreground)]">
              已显示全部流水
            </p>
          ) : null}
        </>
      ) : null}
    </ProductShell>
  );
}
