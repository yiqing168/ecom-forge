'use client';

import { ChevronDown, CircleHelp, History, LogIn } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/ui/brand-mark';
import { cn } from '@/lib/cn';

type TopBarProps = {
  account?: {
    balance: string | null;
    displayName: string | null;
  };
  isAuthenticated: boolean;
  onLogin: () => void;
  onOpenGeneration: () => void;
  onOpenSessions?: (() => void) | undefined;
  onOpenAccount?: () => void;
  title?: string;
  workspace?: boolean;
};

export function TopBar({
  account,
  isAuthenticated,
  onLogin,
  onOpenGeneration,
  onOpenSessions,
  onOpenAccount,
  title = '新会话',
  workspace = false,
}: TopBarProps) {
  const avatarLabel = account?.displayName?.trim().slice(0, 1).toUpperCase() || '我';
  const balanceLabel = account?.balance ?? '--';
  return (
    <header
      className={cn(
        'sticky top-0 z-20 flex h-16 items-center justify-between gap-4 bg-[var(--background)] px-4 lg:px-7',
        workspace ? 'lg:ml-[408px]' : 'lg:ml-[128px]',
      )}
    >
      <div className={cn('flex min-w-0 items-center gap-3', workspace && 'lg:hidden')}>
        <BrandMark className="size-9 lg:hidden" />
        {onOpenSessions ? (
          <button
            className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-[14px] font-medium outline-none hover:bg-[var(--soft)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
            onClick={onOpenSessions}
            type="button"
          >
            <span className="truncate">{title}</span>
            <ChevronDown
              aria-hidden="true"
              className="shrink-0 text-[var(--subtle-foreground)]"
              size={15}
            />
          </button>
        ) : (
          <p className="truncate text-[14px] font-medium text-[var(--muted-foreground)]">{title}</p>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
        {isAuthenticated ? (
          <>
            <button
              className="hidden min-h-10 cursor-pointer items-center gap-2 rounded-md px-3 text-sm text-[var(--muted-foreground)] outline-none hover:bg-[var(--soft)] hover:text-[var(--foreground)] focus-visible:ring-2 focus-visible:ring-[var(--focus)] sm:flex"
              onClick={onOpenGeneration}
              type="button"
            >
              <History aria-hidden="true" size={18} />
              生成
            </button>
            <div className="hidden h-8 items-center gap-2 rounded-md bg-[var(--soft)] px-3 text-sm font-semibold text-[var(--foreground)] sm:flex">
              <span className="size-1.5 rounded-full bg-[var(--primary)]" />
              {balanceLabel} 积分
            </div>
            <button
              aria-label="账户"
              className="grid size-10 cursor-pointer place-items-center rounded-full bg-[var(--avatar)] text-sm font-bold !text-white outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
              onClick={onOpenAccount}
              type="button"
            >
              {avatarLabel}
            </button>
          </>
        ) : (
          <>
            <button
              className="hidden min-h-10 cursor-pointer items-center gap-2 rounded-md px-3 text-sm text-[var(--muted-foreground)] hover:bg-[var(--soft)] sm:flex"
              type="button"
            >
              <CircleHelp aria-hidden="true" size={18} />
              帮助
            </button>
            <Button onClick={onLogin} size="sm">
              <LogIn aria-hidden="true" size={16} />
              登录
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
