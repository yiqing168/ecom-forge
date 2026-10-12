'use client';

import { Alert, Descriptions, Tabs } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { dateColumn, idColumn, statusColumn, textColumn } from '@/components/admin/admin-columns';
import { AdminCollectionTable, type AdminRow } from '@/components/admin/admin-collection-table';
import { AdminPage, AdminStatus, RefreshButton } from '@/components/admin/admin-page';
import { useAdminAuth } from '@/features/auth/admin-auth-provider';
import { adminErrorMessage } from '@/lib/admin-api';
import { displayValue } from '@/lib/display-value';
import { adminOptions } from '@/lib/admin-labels';

const skillColumns = [
  idColumn(),
  textColumn('package_id', 'Package ID', 190),
  textColumn('package_version', '版本', 110),
  statusColumn(),
  statusColumn('risk_status', '风险状态'),
  textColumn('revision', 'Revision', 90),
  {
    key: 'latest_validation',
    title: '最近验证',
    render: (_: unknown, row: AdminRow) => {
      const validation = row.latest_validation as Record<string, unknown> | null;
      return validation ? <AdminStatus value={validation.status} /> : '-';
    },
  },
  dateColumn('created_at', '上传时间'),
  dateColumn('approved_at', '批准时间'),
];

const principalColumns = [
  idColumn(),
  textColumn('display_name', '管理员', 160),
  textColumn('identifier_hint', '登录标识', 190),
  statusColumn(),
  {
    key: 'roles',
    title: '角色',
    render: (_: unknown, row: AdminRow) =>
      Array.isArray(row.roles)
        ? row.roles
            .map((role) => displayValue((role as Record<string, unknown>).role_key, ''))
            .filter(Boolean)
            .join('、')
        : '-',
  },
  textColumn('active_session_count', '活动会话', 100),
  textColumn('authz_version', '权限版本', 100),
  textColumn('revision', 'Revision', 90),
  dateColumn('created_at', '创建时间'),
];

const auditColumns = [
  idColumn(),
  textColumn('actor_display_name', '管理员', 150),
  textColumn('actor_identifier_hint', '登录标识', 180),
  textColumn('action', '操作', 220),
  statusColumn('result', '结果'),
  textColumn('target_type', '目标类型', 150),
  idColumn('target_id', '目标'),
  textColumn('source_ref', '来源 IP 标识', 190),
  textColumn('user_agent_ref', '设备标识', 190),
  textColumn('reason', '理由', 240),
  textColumn('error_code', '错误码', 170),
  dateColumn('created_at', '发生时间'),
];

interface HealthData {
  status: string;
  dependencies: Record<string, string>;
  provider_summary: Record<string, number>;
  checked_at: string;
}

export function SkillsPage() {
  return (
    <AdminPage eyebrow="AI 能力" title="Skill 发布">
      <AdminCollectionTable<AdminRow>
        columns={skillColumns}
        endpoint="/skill-packages"
        filters={[
          {
            key: 'status',
            label: '状态',
            type: 'select',
            options: adminOptions([
              'quarantined',
              'uploaded',
              'validating',
              'validation_failed',
              'ready_for_review',
              'approved',
              'disabled',
              'rejected',
            ]),
          },
        ]}
        title="Skill 安装包"
      />
    </AdminPage>
  );
}

export function AdminsPage() {
  return (
    <AdminPage eyebrow="平台治理" title="管理员">
      <AdminCollectionTable<AdminRow>
        columns={principalColumns}
        endpoint="/admin-principals?limit=100"
        filterMode="client"
        filters={[
          { key: 'display_name', label: '管理员名称', type: 'text' },
          { key: 'identifier_hint', label: '登录标识', type: 'text' },
          {
            key: 'status',
            label: '状态',
            type: 'select',
            options: adminOptions(['pending_enrollment', 'active', 'disabled']),
          },
        ]}
        title="管理员账户"
      />
    </AdminPage>
  );
}

export function AuditPage() {
  return (
    <AdminPage eyebrow="平台治理" title="审计与健康">
      <Tabs
        items={[
          {
            key: 'audit',
            label: '审计日志',
            children: (
              <AdminCollectionTable<AdminRow>
                columns={auditColumns}
                endpoint="/audit-logs"
                filters={[
                  { key: 'action', label: '操作', type: 'text' },
                  {
                    key: 'result',
                    label: '结果',
                    type: 'select',
                    options: adminOptions(['succeeded', 'failed', 'blocked']),
                  },
                ]}
                title="管理操作审计"
              />
            ),
          },
          { key: 'health', label: '系统健康', children: <HealthPanel /> },
        ]}
      />
    </AdminPage>
  );
}

function HealthPanel() {
  const auth = useAdminAuth();
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await auth.request<HealthData>('/health'));
    } catch (cause) {
      setError(adminErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      {error ? <Alert className="mb-4" message={error} showIcon type="error" /> : null}
      <div className="mb-4 flex justify-end">
        <RefreshButton loading={loading} onClick={() => void load()} />
      </div>
      {data ? (
        <Descriptions
          bordered
          column={{ xs: 1, sm: 2, lg: 3 }}
          items={[
            { key: 'overall', label: '整体状态', children: <AdminStatus value={data.status} /> },
            ...Object.entries(data.dependencies).map(([key, value]) => ({
              key,
              label: key,
              children: <AdminStatus value={value} />,
            })),
            ...Object.entries(data.provider_summary).map(([key, value]) => ({
              key: `provider-${key}`,
              label: key,
              children: value,
            })),
            {
              key: 'checked',
              label: '检查时间',
              children: new Date(data.checked_at).toLocaleString('zh-CN'),
            },
          ]}
          size="small"
        />
      ) : null}
    </>
  );
}
