'use client';

import { Spin } from 'antd';

import { AdminLogin } from './admin-login';
import { useAdminAuth } from './admin-auth-provider';
import { AdminRecovery } from './admin-recovery';

export function AdminGate({ children }: { children: React.ReactNode }) {
  const auth = useAdminAuth();
  if (auth.status === 'loading') {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--background)] px-6">
        <Spin size="large" tip="正在连接管理服务">
          <div className="h-20 w-64" />
        </Spin>
      </main>
    );
  }
  if (auth.status === 'anonymous') {
    return <AdminLogin onAuthenticated={() => auth.refresh()} />;
  }
  if (auth.session.recovery_restricted) {
    return <AdminRecovery />;
  }
  return children;
}
