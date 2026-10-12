import type { RealtimeConnectionStatus } from './workflow-realtime.types';

const labels: Partial<Record<RealtimeConnectionStatus, string>> = {
  connecting: '正在连接实时进度',
  reconnecting: '正在恢复实时进度',
  recovered: '实时进度已恢复',
  polling: '实时连接不稳定，正在持续同步',
  closed: '实时进度已断开',
};

export function RealtimeStatus({ status }: { status: RealtimeConnectionStatus }) {
  const label = labels[status];
  if (!label) return null;
  return (
    <p aria-live="polite" className="text-xs text-[var(--muted-foreground)]" role="status">
      {label}
    </p>
  );
}
