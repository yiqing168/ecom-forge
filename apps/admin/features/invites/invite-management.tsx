'use client';

import { CopyOutlined, PlusOutlined, StopOutlined } from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import {
  Alert,
  App,
  Button,
  Form,
  InputNumber,
  Space,
  Switch,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import type { Key } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AdminCollectionTable, type AdminRow } from '@/components/admin/admin-collection-table';
import { dateColumn, statusColumn, textColumn } from '@/components/admin/admin-columns';
import { AdminPage } from '@/components/admin/admin-page';
import { useAdminAuth } from '@/features/auth/admin-auth-provider';
import { useAdminMutation } from '@/features/auth/admin-mutation-provider';
import { adminErrorMessage, adminIdempotencyKey } from '@/lib/admin-api';
import { displayValue } from '@/lib/display-value';
import { adminOptions } from '@/lib/admin-labels';

import { InviteGenerateForm, type GeneratedInviteCode } from './invite-forms';

type InviteRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export async function revealAndCopyInvite(
  request: InviteRequest,
  inviteId: string,
  writeText: (text: string) => Promise<void> = (text) => navigator.clipboard.writeText(text),
): Promise<void> {
  const result = await request<{ plaintext_code: string }>(`/invites/${inviteId}/reveal`, {
    method: 'POST',
    body: '{}',
  });
  await writeText(result.plaintext_code);
}

export function InviteManagementPage() {
  const auth = useAdminAuth();
  const mutation = useAdminMutation();
  const { message, modal } = App.useApp();
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generatedCodes, setGeneratedCodes] = useState<GeneratedInviteCode[]>([]);
  const [selectedRowKeys, setSelectedRowKeys] = useState<Key[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [copyingInviteId, setCopyingInviteId] = useState<string | null>(null);
  const canWrite =
    auth.status === 'authenticated' && auth.session.permissions.includes('invites.write');

  const refresh = useCallback(() => {
    setRefreshToken((value) => value + 1);
    setSelectedRowKeys([]);
  }, []);

  const disableInvites = useCallback(
    async (inviteIds: string[]) => {
      try {
        await mutation.execute(() =>
          auth.request(
            inviteIds.length === 1 ? `/invites/${inviteIds[0]}/disable` : '/invites/disable-batch',
            {
              method: 'POST',
              headers: { 'Idempotency-Key': adminIdempotencyKey() },
              body: JSON.stringify(inviteIds.length === 1 ? {} : { invite_ids: inviteIds }),
            },
          ),
        );
        void message.success(inviteIds.length === 1 ? '邀请码已禁用' : '所选邀请码已禁用');
        refresh();
      } catch (cause) {
        void message.error(adminErrorMessage(cause));
      }
    },
    [auth, message, mutation, refresh],
  );

  const confirmDisable = useCallback(
    (inviteIds: string[]) => {
      modal.confirm({
        title: inviteIds.length === 1 ? '禁用邀请码？' : `禁用 ${inviteIds.length} 个邀请码？`,
        content: '禁用后不能再用于注册，历史使用记录不受影响。',
        okText: '禁用',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => disableInvites(inviteIds),
      });
    },
    [disableInvites, modal],
  );

  const copyInvite = useCallback(
    async (inviteId: string) => {
      setCopyingInviteId(inviteId);
      try {
        await mutation.execute(() => revealAndCopyInvite(auth.request, inviteId));
        void message.success('邀请码已复制');
      } catch (cause) {
        void message.error(adminErrorMessage(cause));
      } finally {
        setCopyingInviteId(null);
      }
    },
    [auth, message, mutation],
  );

  const columns = useMemo<ProColumns<AdminRow>[]>(
    () => [
      textColumn('prefix', '邀请码前缀', 130),
      statusColumn('status', '状态'),
      textColumn('used_count', '使用次数', 100),
      dateColumn('expires_at', '有效期至'),
      dateColumn('created_at', '生成时间'),
      {
        key: 'actions',
        title: '操作',
        fixed: 'right',
        width: 120,
        render: (_, row) => {
          const inviteId = displayValue(row.id);
          return canWrite ? (
            <Space size={4}>
              {row.can_copy === true ? (
                <Tooltip title="复制邀请码">
                  <Button
                    aria-label={`复制邀请码 ${displayValue(row.prefix)}`}
                    icon={<CopyOutlined />}
                    loading={copyingInviteId === inviteId}
                    onClick={() => void copyInvite(inviteId)}
                    type="text"
                  />
                </Tooltip>
              ) : null}
              {row.can_disable === true ? (
                <Button
                  danger
                  icon={<StopOutlined />}
                  onClick={() => confirmDisable([inviteId])}
                  type="link"
                >
                  禁用
                </Button>
              ) : null}
            </Space>
          ) : null;
        },
      },
    ],
    [canWrite, confirmDisable, copyingInviteId, copyInvite],
  );

  return (
    <AdminPage eyebrow="内测准入" title="邀请码">
      <RegistrationRewardSetting canWrite={canWrite} />

      {generatedCodes.length > 0 ? (
        <GeneratedInviteList codes={generatedCodes} onClear={() => setGeneratedCodes([])} />
      ) : null}

      <AdminCollectionTable<AdminRow>
        actions={
          canWrite
            ? [
                <Button
                  icon={<PlusOutlined />}
                  key="generate"
                  onClick={() => setGenerateOpen(true)}
                  type="primary"
                >
                  生成邀请码
                </Button>,
                <Button
                  danger
                  disabled={selectedRowKeys.length === 0}
                  icon={<StopOutlined />}
                  key="disable"
                  onClick={() => confirmDisable(selectedRowKeys.map(String))}
                >
                  批量禁用
                </Button>,
              ]
            : []
        }
        columns={columns}
        endpoint="/invites"
        filters={[
          {
            key: 'status',
            label: '状态',
            type: 'select',
            options: adminOptions(['unused', 'used', 'disabled', 'expired']),
          },
        ]}
        refreshToken={refreshToken}
        rowSelection={
          canWrite
            ? {
                selectedRowKeys,
                onChange: (keys) => setSelectedRowKeys(keys),
                getCheckboxProps: (row) => ({
                  disabled: row.can_disable !== true,
                  name: displayValue(row.prefix),
                }),
              }
            : undefined
        }
        title="邀请码列表"
      />

      <InviteGenerateForm
        onCancel={() => setGenerateOpen(false)}
        onGenerated={(codes) => {
          setGenerateOpen(false);
          setGeneratedCodes(codes);
          refresh();
        }}
        open={generateOpen}
      />
    </AdminPage>
  );
}

function RegistrationRewardSetting({ canWrite }: { canWrite: boolean }) {
  const auth = useAdminAuth();
  const mutation = useAdminMutation();
  const { message } = App.useApp();
  const [form] = Form.useForm<{ enabled: boolean; credits: string }>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void auth
      .request<{ enabled: boolean; credits: string }>('/registration-reward')
      .then((setting) => {
        if (!active) return;
        form.setFieldsValue({
          enabled: setting.enabled,
          credits: setting.credits === '0.00' ? '10' : setting.credits.replace(/\.00$/, ''),
        });
        setError(null);
      })
      .catch((cause) => {
        if (active) setError(adminErrorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [auth, form]);

  async function save(values: { enabled: boolean; credits: string }) {
    setSaving(true);
    setError(null);
    try {
      const updated = await mutation.execute(() =>
        auth.request<{ enabled: boolean; credits: string }>('/registration-reward', {
          method: 'PUT',
          headers: { 'Idempotency-Key': adminIdempotencyKey() },
          body: JSON.stringify({ ...values, credits: `${values.credits}.00` }),
        }),
      );
      form.setFieldsValue({
        enabled: updated.enabled,
        credits: updated.credits.replace(/\.00$/, ''),
      });
      void message.success('注册赠送积分已保存');
    } catch (cause) {
      setError(adminErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-5 border-b border-[var(--border)] pb-5" aria-label="注册赠送积分">
      <Typography.Title level={4}>注册赠送积分</Typography.Title>
      {error ? <Alert className="mb-3" message={error} showIcon type="error" /> : null}
      <Form
        className="flex flex-wrap items-end gap-x-4"
        disabled={loading || !canWrite}
        form={form}
        initialValues={{ enabled: false, credits: '10' }}
        layout="vertical"
        onFinish={(values) => void save(values)}
      >
        <Form.Item label="启用" name="enabled" valuePropName="checked">
          <Switch aria-label="启用注册赠送积分" />
        </Form.Item>
        <Form.Item
          label="赠送积分"
          name="credits"
          rules={[{ required: true, message: '请输入大于 0 的整数积分' }]}
        >
          <InputNumber
            className="w-40"
            max={999_999_999}
            min={1}
            placeholder="10"
            precision={0}
            step={1}
            stringMode
            suffix="积分"
          />
        </Form.Item>
        <Form.Item>
          <Button htmlType="submit" loading={saving} type="primary">
            保存
          </Button>
        </Form.Item>
      </Form>
    </section>
  );
}

export function GeneratedInviteList({
  codes,
  onClear,
}: {
  codes: GeneratedInviteCode[];
  onClear: () => void;
}) {
  const { message } = App.useApp();
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      void message.success('已复制');
    } catch {
      void message.error('复制失败，请手动选择邀请码');
    }
  };

  return (
    <section className="mb-5" aria-label="本次生成的邀请码">
      <Alert
        className="mb-3"
        message="本次生成的邀请码可立即复制，未使用的邀请码之后也可从列表复制。"
        showIcon
        type="warning"
      />
      <Table<GeneratedInviteCode>
        columns={[
          {
            dataIndex: 'plaintext_code',
            key: 'plaintext_code',
            title: '本次生成的邀请码',
            render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
          },
          {
            key: 'copy',
            title: '操作',
            width: 90,
            render: (_, code) => (
              <Button
                aria-label={`复制邀请码 ${code.prefix}`}
                icon={<CopyOutlined />}
                onClick={() => void copy(code.plaintext_code)}
                type="text"
              />
            ),
          },
        ]}
        dataSource={codes}
        pagination={false}
        rowKey="id"
        size="small"
        title={() => (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Typography.Text strong>刚生成 {codes.length} 个</Typography.Text>
            <Space>
              <Button
                aria-label="复制全部邀请码"
                icon={<CopyOutlined />}
                onClick={() => void copy(codes.map((code) => code.plaintext_code).join('\n'))}
              >
                复制全部
              </Button>
              <Button onClick={onClear} type="text">
                清除
              </Button>
            </Space>
          </div>
        )}
      />
    </section>
  );
}
