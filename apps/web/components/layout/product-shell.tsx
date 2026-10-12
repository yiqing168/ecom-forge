'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { AppShell } from '@/components/layout/app-shell';
import { Skeleton } from '@/components/ui/skeleton';
import { getCreditAccount, getCurrentUser } from '@/lib/auth-api';
import { PRODUCT_ROUTES } from '@/lib/product-navigation';
import { markAuthRedirect, resetPrototypeCreationState } from '@/lib/prototype-session';

export function ProductShell({
  activeItem,
  children,
  title,
}: {
  activeItem: string;
  children: ReactNode;
  title: string;
}) {
  const router = useRouter();
  const [authorized, setAuthorized] = useState(false);
  const [account, setAccount] = useState<{
    balance: string | null;
    displayName: string | null;
    userId: string | null;
  }>({
    balance: null,
    displayName: null,
    userId: null,
  });

  useEffect(() => {
    let active = true;
    void getCurrentUser()
      .then(async (result) => {
        const creditAccount = await getCreditAccount().catch(() => null);
        if (active) {
          setAccount({
            balance: creditAccount?.balance ?? null,
            displayName: result.user.display_name,
            userId: result.user.id,
          });
          setAuthorized(true);
        }
      })
      .catch(() => {
        if (!active) return;
        markAuthRedirect();
        router.replace('/');
      });
    return () => {
      active = false;
    };
  }, [router]);

  function navigate(label: string) {
    if (label === '创作') {
      resetPrototypeCreationState(account.userId);
      router.push('/');
      return;
    }
    const route = PRODUCT_ROUTES[label];
    if (route) router.push(route);
  }

  return (
    <AppShell
      account={account}
      navigation={{ activeItem, isAuthenticated: true, onNavigate: navigate }}
      topBar={{
        onLogin: () => undefined,
        onOpenAccount: () => router.push('/account'),
        onOpenGeneration: () => router.push('/workspace/session/new'),
        title,
      }}
    >
      <main
        aria-busy={!authorized}
        className="min-h-[calc(100dvh-64px)] pb-24 lg:ml-[128px] lg:pb-10"
        id="main-content"
      >
        <div className="mx-auto w-full max-w-[1320px] px-4 py-7 sm:px-7 lg:px-9 lg:py-9">
          {authorized ? (
            <div className="content-enter">{children}</div>
          ) : (
            <div aria-label="正在验证登录状态" className="space-y-6" role="status">
              <div className="space-y-3">
                <Skeleton className="h-8 w-40" />
                <Skeleton className="h-4 w-72 max-w-full" />
              </div>
              <Skeleton className="h-12 w-full" />
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
                {Array.from({ length: 8 }, (_, index) => (
                  <Skeleton className="aspect-[4/5] w-full" key={index} />
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </AppShell>
  );
}
