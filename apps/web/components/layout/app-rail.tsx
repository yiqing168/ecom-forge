'use client';

import {
  FolderOpen,
  History,
  Images,
  PanelsTopLeft,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

import { BrandMark } from '@/components/ui/brand-mark';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';

type NavigationItem = {
  icon: LucideIcon;
  label: string;
};

const workspaceNavigation: NavigationItem[] = [
  { icon: PanelsTopLeft, label: '创作' },
  { icon: History, label: '生成' },
  { icon: FolderOpen, label: '资产' },
  { icon: Images, label: '作品' },
];

type AppRailProps = {
  account?: {
    balance: string | null;
    displayName: string | null;
  };
  activeItem?: string;
  isAuthenticated?: boolean;
  onNavigate: (label: string) => void;
};

function NavigationButton({
  active,
  icon: Icon,
  label,
  onNavigate,
}: NavigationItem & { active: boolean; onNavigate: (label: string) => void }) {
  return (
    <Tooltip label={label}>
      <button
        aria-current={active ? 'page' : undefined}
        aria-label={label}
        className={cn(
          'relative flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-3 text-left text-[var(--navigation-foreground)] outline-none transition-colors hover:bg-[var(--navigation-hover)] hover:text-[var(--foreground)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]',
          active && 'bg-[var(--primary-soft)] text-[var(--foreground)]',
        )}
        onClick={() => onNavigate(label)}
        type="button"
      >
        {active ? (
          <span className="absolute -left-2.5 h-5 w-0.5 rounded-full bg-[var(--primary)]" />
        ) : null}
        <Icon aria-hidden="true" className="shrink-0" size={18} strokeWidth={active ? 2.2 : 1.8} />
        <span className="text-[14px] font-medium">{label}</span>
      </button>
    </Tooltip>
  );
}

export function AppRail({
  account,
  activeItem = '创作',
  isAuthenticated = false,
  onNavigate,
}: AppRailProps) {
  function renderNavigation(items: NavigationItem[]) {
    return items.map((item) => (
      <NavigationButton
        {...item}
        active={activeItem === item.label}
        key={item.label}
        onNavigate={onNavigate}
      />
    ));
  }

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[128px] border-r border-[var(--border)] bg-[var(--navigation)] lg:flex lg:flex-col">
      <button
        aria-label="首页"
        className="mt-4 flex min-h-11 items-center justify-center gap-2 px-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        onClick={() => onNavigate('创作')}
        type="button"
      >
        <BrandMark className="size-7" />
        <span className="text-[18px] font-bold">象塑</span>
      </button>

      <nav
        aria-label="主要导航"
        className="mt-4 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2"
      >
        {renderNavigation(workspaceNavigation)}
      </nav>

      <div className="mb-3 border-t border-[var(--border)] px-2 pt-3">
        <Tooltip
          label={
            isAuthenticated
              ? `${account?.displayName ?? '账户'} · ${account?.balance ?? '--'} 积分`
              : '登录账户'
          }
        >
          <button
            aria-label="账户"
            className={cn(
              'flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-[var(--navigation-foreground)] outline-none hover:bg-[var(--navigation-hover)] hover:text-[var(--foreground)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]',
              activeItem === '账户' && 'bg-[var(--primary-soft)] text-[var(--foreground)]',
            )}
            onClick={() => onNavigate('账户')}
            type="button"
          >
            <UserRound aria-hidden="true" className="shrink-0" size={18} />
            <span className="text-[14px] font-medium">账户</span>
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}

export function MobileNavigation({ activeItem = '创作', onNavigate }: AppRailProps) {
  const mobileItems = workspaceNavigation.slice(0, 4);
  return (
    <nav
      aria-label="移动端主要导航"
      className="fixed inset-x-0 bottom-0 z-40 grid h-[68px] grid-cols-5 border-t border-[var(--border)] bg-white/96 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      {mobileItems.map(({ icon: Icon, label }) => {
        const active = activeItem === label;
        return (
          <button
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-1 text-xs text-[var(--muted-foreground)]',
              active && 'font-semibold text-[var(--foreground)]',
            )}
            key={label}
            onClick={() => onNavigate(label)}
            type="button"
          >
            <Icon aria-hidden="true" size={20} />
            {label}
          </button>
        );
      })}
      <button
        className="flex cursor-pointer flex-col items-center justify-center gap-1 text-xs text-[var(--muted-foreground)]"
        onClick={() => onNavigate('更多')}
        type="button"
      >
        <UserRound aria-hidden="true" size={20} />
        我的
      </button>
    </nav>
  );
}
