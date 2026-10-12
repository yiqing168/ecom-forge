'use client';

import { usePathname } from 'next/navigation';

import { AgentWorkbench } from './workbench';

export function SessionWorkbench() {
  const pathname = usePathname();
  return (
    <AgentWorkbench view={pathname === '/workspace/session/new' ? 'session-new' : 'session'} />
  );
}
