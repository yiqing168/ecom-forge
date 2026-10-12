'use client';

import { ReloadOutlined } from '@ant-design/icons';
import { Button, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';

import { displayValue } from '@/lib/display-value';
import { adminLabel } from '@/lib/admin-labels';

export function AdminPage({
  title,
  actions,
  children,
}: {
  title: string;
  eyebrow: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div aria-label={title} className="mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6 sm:py-6">
      <Typography.Title className="!mb-4 !text-xl lg:!hidden" level={1}>
        {title}
      </Typography.Title>
      {actions ? <div className="mb-4 flex justify-end">{actions}</div> : null}
      {children}
    </div>
  );
}

export function AdminStatus({ value }: { value: unknown }) {
  const status = displayValue(value, 'unknown');
  const normalized = status.toLowerCase();
  const color = [
    'ok',
    'ready',
    'configured',
    'succeeded',
    'active',
    'approved',
    'published',
  ].includes(normalized)
    ? 'success'
    : ['failed', 'error', 'not_ready', 'disabled', 'frozen', 'rejected', 'revoked'].includes(
          normalized,
        )
      ? 'error'
      : ['pending', 'queued', 'running', 'warning', 'draft', 'limited'].includes(normalized)
        ? 'warning'
        : 'default';
  return <Tag color={color}>{adminLabel(status)}</Tag>;
}

export function AdminIdentifier({ value }: { value: unknown }) {
  const text = displayValue(value, '');
  if (!text) return <Typography.Text type="secondary">-</Typography.Text>;
  return (
    <Typography.Text copyable={{ text }} title={text}>
      {text.length > 16 ? `${text.slice(0, 8)}...${text.slice(-6)}` : text}
    </Typography.Text>
  );
}

export function AdminDate({ value }: { value: unknown }) {
  if (!value) return <Typography.Text type="secondary">-</Typography.Text>;
  const date = new Date(displayValue(value, ''));
  return Number.isNaN(date.getTime()) ? (
    <Typography.Text type="secondary">-</Typography.Text>
  ) : (
    <time dateTime={date.toISOString()}>{date.toLocaleString('zh-CN')}</time>
  );
}

export function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <Button icon={<ReloadOutlined spin={loading} />} loading={loading} onClick={onClick}>
      刷新
    </Button>
  );
}
