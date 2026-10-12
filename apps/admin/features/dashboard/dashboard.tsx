'use client';

import {
  AlertOutlined,
  ApiOutlined,
  DollarOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { ProTable, type ProColumns } from '@ant-design/pro-components';
import { addMoney } from '@ecom-forge/shared/money';
import { Alert, Button, Card, Descriptions, Spin, Statistic, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAdminAuth } from '@/features/auth/admin-auth-provider';
import { adminErrorMessage } from '@/lib/admin-api';

interface DashboardData {
  window: { from: string; to: string };
  workflow_runs: Record<string, number>;
  tasks: Record<string, { count: number; actual_cost_cny: string }>;
  users_by_risk: Record<string, number>;
  queue_backlog: Record<string, number>;
  credits: { balance: string; frozen: string };
  providers: Record<string, number>;
  workers: { worker_type: string; status: string; last_seen_at: string }[];
  releases: {
    pricing_catalog_revision: number;
    pricing_release_id: string | null;
    skill_catalog_revision: number;
    skill_release_id: string | null;
  };
}

interface HealthData {
  status: 'ready' | 'not_ready';
  dependencies: Record<string, string>;
  workers: { worker_type: string; status: string; last_seen_at: string }[];
  provider_summary: Record<string, number>;
  checked_at: string;
}

interface TaskSummaryRow {
  actualCost: string;
  count: number;
  queueCount: number;
  status: string;
}

const taskColumns: ProColumns<TaskSummaryRow>[] = [
  {
    dataIndex: 'status',
    title: '状态',
    render: (_, row) => <StatusTag status={row.status} />,
  },
  { dataIndex: 'count', title: '任务数', valueType: 'digit' },
  { dataIndex: 'actualCost', title: '实际成本', renderText: (value) => `¥${value}` },
  { dataIndex: 'queueCount', title: '队列记录', valueType: 'digit' },
];

function sumCounts(values: Record<string, number>): number {
  return Object.values(values).reduce((total, value) => total + value, 0);
}

export function Dashboard() {
  const auth = useAdminAuth();
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextDashboard, nextHealth] = await Promise.all([
        auth.request<DashboardData>('/dashboard'),
        auth.request<HealthData>('/health'),
      ]);
      setDashboard(nextDashboard);
      setHealth(nextHealth);
    } catch (cause) {
      setError(adminErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    void load();
  }, [load]);

  const taskRows = useMemo<TaskSummaryRow[]>(
    () =>
      dashboard
        ? Object.entries(dashboard.tasks).map(([status, item]) => ({
            actualCost: item.actual_cost_cny,
            count: item.count,
            queueCount: dashboard.queue_backlog[status] ?? 0,
            status,
          }))
        : [],
    [dashboard],
  );
  const taskCost = useMemo(
    () => taskRows.reduce((total, row) => addMoney(total, row.actualCost), '0.00'),
    [taskRows],
  );
  const taskCount = taskRows.reduce((total, row) => total + row.count, 0);

  return (
    <div className="mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6 sm:py-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Typography.Text type="secondary">最近 24 小时</Typography.Text>
          <Typography.Title className="!mb-0 !mt-1" level={3}>
            运营总览
          </Typography.Title>
        </div>
        <Button
          icon={<ReloadOutlined spin={loading} />}
          loading={loading}
          onClick={() => {
            void load();
          }}
        >
          刷新
        </Button>
      </div>

      {error ? <Alert className="mb-5" message={error} showIcon type="error" /> : null}
      {loading && !dashboard ? (
        <div className="grid min-h-[360px] place-items-center">
          <Spin size="large" tip="加载运营数据">
            <div className="h-20 w-64" />
          </Spin>
        </div>
      ) : null}

      {dashboard ? (
        <>
          <section aria-label="核心指标" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              detail={`${dashboard.workflow_runs.running ?? 0} 个正在运行`}
              icon={<ApiOutlined />}
              label="工作流"
              value={sumCounts(dashboard.workflow_runs).toString()}
            />
            <Metric
              detail={`实际成本 ¥${taskCost}`}
              icon={<AlertOutlined />}
              label="任务处理"
              value={taskCount.toString()}
            />
            <Metric
              detail={`冻结 ${dashboard.credits.frozen}`}
              icon={<DollarOutlined />}
              label="用户积分余额"
              value={dashboard.credits.balance}
            />
            <Metric
              detail={`${dashboard.users_by_risk.frozen ?? 0} 个冻结账户`}
              icon={<SafetyCertificateOutlined />}
              label="受限账户"
              value={(
                (dashboard.users_by_risk.limited ?? 0) + (dashboard.users_by_risk.frozen ?? 0)
              ).toString()}
            />
          </section>

          <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)]">
            <ProTable<TaskSummaryRow>
              columns={taskColumns}
              dataSource={taskRows}
              headerTitle="队列与任务状态"
              options={false}
              pagination={false}
              rowKey="status"
              search={false}
              toolBarRender={() => [
                <Tag
                  color={sumCounts(dashboard.queue_backlog) > 0 ? 'warning' : 'success'}
                  key="queue"
                >
                  {sumCounts(dashboard.queue_backlog) > 0 ? '存在积压' : '无积压'}
                </Tag>,
              ]}
            />

            <Card title="系统就绪状态">
              <Descriptions
                column={1}
                items={[
                  ...(health
                    ? Object.entries(health.dependencies).map(([name, status]) => ({
                        children: <StatusTag status={status} />,
                        key: name,
                        label: name,
                      }))
                    : []),
                  {
                    children: `r${dashboard.releases.pricing_catalog_revision}`,
                    key: 'pricing',
                    label: '价格目录',
                  },
                  {
                    children: `r${dashboard.releases.skill_catalog_revision}`,
                    key: 'skill',
                    label: 'Skill 目录',
                  },
                ]}
                size="small"
              />
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <Card size="small">
      <Statistic prefix={icon} title={label} value={value} />
      <Typography.Text className="!text-xs" type="secondary">
        {detail}
      </Typography.Text>
    </Card>
  );
}

function StatusTag({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const color = ['ok', 'ready', 'configured', 'succeeded', 'active'].includes(normalized)
    ? 'success'
    : ['failed', 'error', 'not_ready', 'disabled'].includes(normalized)
      ? 'error'
      : ['pending', 'queued', 'running', 'warning'].includes(normalized)
        ? 'warning'
        : 'default';
  return <Tag color={color}>{status}</Tag>;
}
