import type { ProColumns } from '@ant-design/pro-components';
import { Typography } from 'antd';

import type { AdminRow } from './admin-collection-table';
import { AdminDate, AdminIdentifier, AdminStatus } from './admin-page';
import { displayValue } from '@/lib/display-value';

export function textColumn(key: string, title: string, width?: number): ProColumns<AdminRow> {
  return {
    key,
    title,
    ...(width !== undefined ? { width } : {}),
    render: (_, row) => {
      const value = row[key];
      return value === null || value === undefined || value === '' ? (
        <Typography.Text type="secondary">-</Typography.Text>
      ) : (
        displayValue(value)
      );
    },
  };
}

export function idColumn(key = 'id', title = 'ID'): ProColumns<AdminRow> {
  return { key, title, width: 170, render: (_, row) => <AdminIdentifier value={row[key]} /> };
}

export function statusColumn(key = 'status', title = '状态'): ProColumns<AdminRow> {
  return { key, title, width: 120, render: (_, row) => <AdminStatus value={row[key]} /> };
}

export function dateColumn(key: string, title: string): ProColumns<AdminRow> {
  return { key, title, width: 180, render: (_, row) => <AdminDate value={row[key]} /> };
}

export function moneyColumn(key: string, title: string, prefix = ''): ProColumns<AdminRow> {
  return {
    key,
    title,
    width: 130,
    align: 'right',
    render: (_, row) => `${prefix}${displayValue(row[key], '0.00')}`,
  };
}
