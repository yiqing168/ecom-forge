'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { AdminApiError, adminRequest, type AdminSession } from '@/lib/admin-api';

type AuthState =
  | { status: 'loading'; session: null }
  | { status: 'anonymous'; session: null }
  | { status: 'authenticated'; session: AdminSession };

type AdminAuthContextValue = AuthState & {
  refresh: () => Promise<void>;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  logout: () => Promise<void>;
};

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

export function invalidatesAdminSession(error: unknown): boolean {
  return (
    error instanceof AdminApiError &&
    error.status === 401 &&
    error.code === 'ADMIN_SESSION_REQUIRED'
  );
}

export function AdminAuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading', session: null });

  const refresh = useCallback(async () => {
    try {
      const session = await adminRequest<AdminSession>('/auth/session');
      setState({ status: 'authenticated', session });
    } catch (error) {
      if (error instanceof AdminApiError && error.status === 401) {
        setState({ status: 'anonymous', session: null });
        return;
      }
      throw error;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const loadSession = async () => {
      try {
        await refresh();
      } catch {
        if (!cancelled) retryTimer = setTimeout(() => void loadSession(), 2_000);
      }
    };
    void loadSession();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [refresh]);

  const request = useCallback(
    async <T,>(path: string, init: RequestInit = {}) => {
      const csrf = state.status === 'authenticated' ? state.session.csrf_token : undefined;
      try {
        return await adminRequest<T>(path, init, csrf);
      } catch (error) {
        if (invalidatesAdminSession(error)) {
          setState({ status: 'anonymous', session: null });
        }
        throw error;
      }
    },
    [state],
  );

  const logout = useCallback(async () => {
    const csrf = state.status === 'authenticated' ? state.session.csrf_token : undefined;
    await adminRequest<void>('/auth/logout', { method: 'POST', body: '{}' }, csrf).finally(() =>
      setState({ status: 'anonymous', session: null }),
    );
  }, [state]);

  const value = useMemo<AdminAuthContextValue>(
    () => ({ ...state, refresh, request, logout }),
    [logout, refresh, request, state],
  );
  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth(): AdminAuthContextValue {
  const context = useContext(AdminAuthContext);
  if (!context) throw new Error('useAdminAuth must be used inside AdminAuthProvider');
  return context;
}
