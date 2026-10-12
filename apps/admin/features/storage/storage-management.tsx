'use client';

import { EyeOutlined, PlusOutlined } from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { Alert, Button, Tabs } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AdminCollectionTable, type AdminRow } from '@/components/admin/admin-collection-table';
import { idColumn, statusColumn, textColumn } from '@/components/admin/admin-columns';
import { AdminPage } from '@/components/admin/admin-page';
import { useAdminAuth } from '@/features/auth/admin-auth-provider';
import { adminErrorMessage } from '@/lib/admin-api';
import { adminOptions } from '@/lib/admin-labels';
import { displayValue } from '@/lib/display-value';

import { StorageChannelCreate, type StorageAdapterProfile } from './storage-channel-create';
import { StorageChannelDetail } from './storage-channel-detail';

export function StorageManagementPage() {
  const auth = useAdminAuth();
  const [adapters, setAdapters] = useState<StorageAdapterProfile[]>([]);
  const [adapterError, setAdapterError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const canWrite =
    auth.status === 'authenticated' && auth.session.permissions.includes('storage_keys.rotate');

  const loadAdapters = useCallback(async () => {
    try {
      const response = await auth.request<{ items: StorageAdapterProfile[] }>('/storage-adapters');
      setAdapters(response.items);
      setAdapterError(null);
    } catch (cause) {
      setAdapterError(adminErrorMessage(cause));
    }
  }, [auth]);

  useEffect(() => {
    void loadAdapters();
  }, [loadAdapters]);

  const channelColumns = useMemo<ProColumns<AdminRow>[]>(
    () => [
      idColumn(),
      textColumn('adapter_key', '适配器', 180),
      textColumn('endpoint_profile_key', '固定端点', 150),
      textColumn('region', '区域', 100),
      textColumn('bucket', 'Bucket', 190),
      textColumn('root_prefix', '对象根前缀', 200),
      statusColumn(),
      {
        key: 'actions',
        title: '操作',
        fixed: 'right',
        width: 92,
        render: (_, row) => (
          <Button
            icon={<EyeOutlined />}
            onClick={() => setSelectedChannelId(displayValue(row.id))}
            type="link"
          >
            详情
          </Button>
        ),
      },
    ],
    [],
  );

  return (
    <AdminPage eyebrow="生成配置" title="对象存储">
      {adapterError ? (
        <Alert className="mb-4" message={adapterError} showIcon type="error" />
      ) : null}
      <Tabs
        items={[
          {
            key: 'channels',
            label: '存储通道',
            children: (
              <AdminCollectionTable<AdminRow>
                actions={
                  canWrite
                    ? [
                        <Button
                          icon={<PlusOutlined />}
                          key="create"
                          onClick={() => setCreateOpen(true)}
                          type="primary"
                        >
                          新增通道
                        </Button>,
                      ]
                    : []
                }
                columns={channelColumns}
                endpoint="/storage-channels"
                filters={[
                  { key: 'bucket', label: 'Bucket', type: 'text' },
                  {
                    key: 'adapter_key',
                    label: '适配器',
                    type: 'select',
                    options: adapters.map((adapter) => ({
                      label: adapter.display_name,
                      value: adapter.adapter_key,
                    })),
                  },
                  {
                    key: 'status',
                    label: '状态',
                    type: 'select',
                    options: adminOptions(['draft', 'active', 'disabled']),
                  },
                ]}
                refreshToken={refreshToken}
                title="私有对象存储通道"
              />
            ),
          },
          {
            key: 'adapters',
            label: '适配器注册表',
            children: (
              <AdminCollectionTable<StorageAdapterProfile>
                columns={[
                  { dataIndex: 'display_name', title: '适配器', width: 190 },
                  { dataIndex: 'adapter_key', title: '适配器标识', width: 180 },
                  { dataIndex: 'probe_contract_version', title: '探测契约', width: 160 },
                  {
                    key: 'endpoint_profiles',
                    title: '固定端点',
                    render: (_, row) => row.endpoint_profiles.map((item) => item.key).join('、'),
                  },
                ]}
                endpoint="/storage-adapters"
                filterMode="client"
                filters={[
                  {
                    key: 'adapter_key',
                    label: '适配器',
                    type: 'select',
                    options: adapters.map((adapter) => ({
                      label: adapter.display_name,
                      value: adapter.adapter_key,
                    })),
                  },
                ]}
                rowKey={(row) => row.adapter_key}
                title="已注册存储适配器"
              />
            ),
          },
        ]}
      />
      <StorageChannelCreate
        adapters={adapters}
        onCancel={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          setRefreshToken((value) => value + 1);
        }}
        open={createOpen}
      />
      <StorageChannelDetail
        channelId={selectedChannelId}
        onChanged={() => setRefreshToken((value) => value + 1)}
        onClose={() => setSelectedChannelId(null)}
      />
    </AdminPage>
  );
}
