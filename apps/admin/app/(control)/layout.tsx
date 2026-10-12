import type { ReactNode } from 'react';

import { AdminShell } from '@/components/layout/admin-shell';
import { AdminGate } from '@/features/auth/admin-gate';

export default function ControlPlaneLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <AdminGate>
      <AdminShell>{children}</AdminShell>
    </AdminGate>
  );
}
