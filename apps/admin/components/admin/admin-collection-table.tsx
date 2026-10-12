'use client';

import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import {
  ProFormSelect,
  ProFormText,
  ProTable,
  QueryFilter,
  type ProColumns,
  type ProTableProps,
} from '@ant-design/pro-components';
import { Alert, Button, Space, Typography } from 'antd';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAdminAuth } from '@/features/auth/admin-auth-provider';
import { adminErrorMessage } from '@/lib/admin-api';
import { displayValue } from '@/lib/display-value';
import {
  KeysetPaginationError,
  KeysetRequestController,
  type KeysetNavigation,
} from '@/lib/keyset-data-source';

export type AdminRow = Record<string, unknown>;

export interface AdminFilterField {
  key: string;
  label: string;
  type: 'text' | 'select';
  placeholder?: string;
  options?: readonly { label: string; value: string }[];
}

interface CollectionResponse<T> {
  items: T[];
  next_cursor?: string | null;
}

export function AdminCollectionTable<T extends AdminRow>({
  endpoint,
  columns,
  rowKey = 'id',
  title,
  refreshToken = 0,
  actions,
  onLoaded,
  filters = [],
  filterMode = 'server',
  rowSelection,
}: {
  endpoint: string;
  columns: ProColumns<T>[];
  rowKey?: string | ((row: T) => string);
  title: string;
  refreshToken?: number;
  actions?: ReactNode[];
  onLoaded?: (items: T[]) => void;
  filters?: readonly AdminFilterField[];
  filterMode?: 'server' | 'client';
  rowSelection?: ProTableProps<T, Record<string, unknown>>['rowSelection'];
}) {
  const auth = useAdminAuth();
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const controller = useRef(new KeysetRequestController<T>(20));
  const [navigation, setNavigation] = useState<KeysetNavigation>(controller.current.navigation);

  const endpointState = useMemo(() => {
    const [path, rawQuery = ''] = endpoint.split('?', 2);
    return { path, params: Object.fromEntries(new URLSearchParams(rawQuery)) };
  }, [endpoint]);

  const visibleItems = useMemo(() => {
    if (filterMode !== 'client') return items;
    return items.filter((row) =>
      filters.every((field) => {
        const expected = filterValues[field.key];
        if (!expected) return true;
        const actual = row[field.key];
        if (field.type === 'select') return displayValue(actual, '') === expected;
        return displayValue(actual, '').toLocaleLowerCase().includes(expected.toLocaleLowerCase());
      }),
    );
  }, [filterMode, filterValues, filters, items]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await controller.current.request(
        endpointState.params,
        {},
        filterMode === 'server' ? filterValues : {},
        async (input) => {
          const query = new URLSearchParams();
          query.set('limit', String(input.limit));
          if (input.cursor) query.set('cursor', input.cursor);
          for (const [key, value] of Object.entries(input.filters)) {
            if (typeof value === 'string' && value) query.set(key, value);
          }
          const page = await auth.request<CollectionResponse<T>>(
            `${endpointState.path}?${query.toString()}`,
          );
          return { items: page.items, next_cursor: page.next_cursor ?? null };
        },
      );
      setItems(response.data);
      setNavigation(controller.current.navigation);
      onLoaded?.(response.data);
    } catch (cause) {
      setError(
        cause instanceof KeysetPaginationError
          ? '分页状态异常，请重新查询'
          : adminErrorMessage(cause),
      );
    } finally {
      setLoading(false);
    }
  }, [auth, endpointState, filterMode, filterValues, onLoaded]);

  useEffect(() => {
    void load();
  }, [load, refreshToken, reload]);

  function next(): void {
    if (!controller.current.next()) return;
    setNavigation(controller.current.navigation);
    setReload((value) => value + 1);
  }

  function previous(): void {
    if (!controller.current.previous()) return;
    setNavigation(controller.current.navigation);
    setReload((value) => value + 1);
  }

  function applyFilters(values: Record<string, unknown>): void {
    setFilterValues(
      Object.fromEntries(
        Object.entries(values).flatMap(([key, value]) =>
          typeof value === 'string' && value.trim() ? [[key, value.trim()]] : [],
        ),
      ),
    );
    controller.current.reset();
    setNavigation(controller.current.navigation);
  }

  return (
    <>
      {filters.length > 0 ? (
        <QueryFilter<Record<string, unknown>>
          className="mb-4"
          onFinish={(values) => {
            applyFilters(values);
            return Promise.resolve(true);
          }}
          onReset={() => applyFilters({})}
        >
          {filters.map((field) =>
            field.type === 'select' ? (
              <ProFormSelect
                key={field.key}
                label={field.label}
                name={field.key}
                options={[...(field.options ?? [])]}
                placeholder={field.placeholder ?? `请选择${field.label}`}
              />
            ) : (
              <ProFormText
                key={field.key}
                label={field.label}
                name={field.key}
                placeholder={field.placeholder ?? `请输入${field.label}`}
              />
            ),
          )}
        </QueryFilter>
      ) : null}
      {error ? <Alert className="mb-4" message={error} showIcon type="error" /> : null}
      <ProTable<T>
        columns={columns}
        dataSource={visibleItems}
        headerTitle={title}
        loading={loading}
        options={{ density: true, fullScreen: true, reload: () => setReload((value) => value + 1) }}
        pagination={
          filterMode === 'client'
            ? {
                defaultPageSize: 20,
                pageSizeOptions: [20, 50, 100],
                showSizeChanger: true,
                showTotal: (total) => `共 ${total} 条`,
              }
            : false
        }
        rowKey={rowKey}
        {...(rowSelection !== undefined ? { rowSelection } : {})}
        search={false}
        scroll={{ x: 'max-content' }}
        toolBarRender={() => actions ?? []}
      />
      {filterMode === 'server' ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
          <Typography.Text type="secondary">
            第 {navigation.page} 页，本页 {items.length} 条
          </Typography.Text>
          <Space.Compact>
            <Button
              aria-label="上一页"
              disabled={loading || !navigation.canPrevious}
              icon={<LeftOutlined />}
              onClick={previous}
            />
            <Button
              aria-label="下一页"
              disabled={loading || !navigation.canNext}
              icon={<RightOutlined />}
              onClick={next}
            />
          </Space.Compact>
        </div>
      ) : null}
    </>
  );
}
