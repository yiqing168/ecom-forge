'use client';

import type { ReactNode } from 'react';

import { AppRail, MobileNavigation } from '@/components/layout/app-rail';
import { TopBar } from '@/components/layout/top-bar';
import { TooltipProvider } from '@/components/ui/tooltip';

type AppShellProps = {
  account?: {
    balance: string | null;
    displayName: string | null;
  };
  children: ReactNode;
  navigation: {
    activeItem: string;
    isAuthenticated: boolean;
    onNavigate: (label: string) => void;
  };
  secondaryNavigation?: ReactNode;
  topBar: {
    onLogin: () => void;
    onOpenGeneration: () => void;
    onOpenAccount: () => void;
    onOpenSessions?: () => void;
    title: string;
    workspace?: boolean;
  };
};

export function AppShell({
  account,
  children,
  navigation,
  secondaryNavigation,
  topBar,
}: AppShellProps) {
  return (
    <TooltipProvider>
      <div className="min-h-dvh">
        <AppRail {...navigation} {...(account ? { account } : {})} />
        {secondaryNavigation}
        <TopBar
          isAuthenticated={navigation.isAuthenticated}
          {...topBar}
          {...(account ? { account } : {})}
        />
        <MobileNavigation activeItem={navigation.activeItem} onNavigate={navigation.onNavigate} />
        {children}
      </div>
    </TooltipProvider>
  );
}
