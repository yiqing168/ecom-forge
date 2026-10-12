import type { ReactNode } from 'react';

import { SessionWorkbench } from '@/features/agent-workbench/session-workbench';

export default function SessionLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SessionWorkbench />
      {children}
    </>
  );
}
