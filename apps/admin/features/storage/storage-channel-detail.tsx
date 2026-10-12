'use client';

import {
  CheckCircleOutlined,
  KeyOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { ModalForm, ProFormText, ProFormTextArea } from '@ant-design/pro-components';
import { Alert, App, Button, Descriptions, Drawer, Empty, Space, Table, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AdminDate, AdminIdentifier, AdminStatus } from '@/components/admin/admin-page';
import { ReasonActionModal } from '@/components/admin/reason-action-modal';
import { useAdminAuth } from '@/features/auth/admin-auth-provider';
import { useAdminMutation } from '@/features/auth/admin-mutation-provider';
import { adminErrorMessage, adminIdempotencyKey } from '@/lib/admin-api';

interface StorageCredential {
  id: string;
  version_no: number;
  key_hint: string;
  status: string;
  revision: number;
  verified_at: string | null;
  created_at: string;
}

interface StorageValidationRun {
  id: string;
  credential_version_id: string;
  probe_contract_version: string;
  status: string;
  attempt_no: number;
  evidence_digest: string | null;
  created_at: string;
}

interface StorageChannelDetailData {
  id: string;
  purpose: string;
  adapter_key: string;
  endpoint_profile_key: string;
  region: string | null;
  bucket: string;
  root_prefix: string;
  status: string;
  active_credential_version_id: string | null;
  revision: number;
  runtime: { is_active: boolean; runtime_revision: number };
  credentials: StorageCredential[];
  validation_runs: StorageValidationRun[];
}

type StorageAction =
  | { kind: 'validate'; credential: StorageCredential }
  | { kind: 'activate-credential'; credential: StorageCredential; run: StorageValidationRun }
  | { kind: 'revoke'; credential: StorageCredential }
  | { kind: 'activate-channel'; run: StorageValidationRun }
  | { kind: 'disable-channel' };

export function StorageChannelDetail({
  channelId,
  onClose,
  onChanged,
}: {
  channelId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const auth = useAdminAuth();
  const mutation = useAdminMutation();
  const { message } = App.useApp();
  const [detail, setDetail] = useState<StorageChannelDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [action, setAction] = useState<StorageAction | null>(null);
  const canRotate =
    auth.status === 'authenticated' && auth.session.permissions.includes('storage_keys.rotate');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!channelId) return;
      setLoading(true);
      setError(null);
      try {
        const next = await auth.request<StorageChannelDetailData>(
          `/storage-channels/${channelId}`,
          {
            signal: signal ?? null,
          },
        );
        if (!signal?.aborted) setDetail(next);
      } catch (cause) {
        if (!signal?.aborted) setError(adminErrorMessage(cause));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [auth, channelId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    if (channelId) void load(controller.signal);
    return () => controller.abort();
  }, [channelId, load]);

  const passedRuns = useMemo(() => {
    const map = new Map<string, StorageValidationRun>();
    for (const run of detail?.validation_runs ?? []) {
      if (run.status === 'passed' && run.evidence_digest && !map.has(run.credential_version_id)) {
        map.set(run.credential_version_id, run);
      }
    }
    return map;
  }, [detail]);
  const activeCredential = detail?.credentials.find(
    (credential) => credential.id === detail.active_credential_version_id,
  );
  const activeRun = activeCredential ? passedRuns.get(activeCredential.id) : undefined;

  async function performAction(reason: string): Promise<void> {
    if (!detail || !action) return;
    const key = adminIdempotencyKey();
    let path = '';
    let body: Record<string, unknown> = { reason };
    if (action.kind === 'validate') {
      path = `/storage-credentials/${action.credential.id}/validate`;
    } else if (action.kind === 'activate-credential') {
      path = `/storage-credentials/${action.credential.id}/activate`;
      body = {
        ...body,
        expected_credential_revision: action.credential.revision,
        expected_channel_revision: detail.revision,
        validation_run_id: action.run.id,
        evidence_digest: action.run.evidence_digest,
      };
    } else if (action.kind === 'revoke') {
      path = `/storage-credentials/${action.credential.id}/revoke`;
      body = {
        ...body,
        expected_credential_revision: action.credential.revision,
        expected_channel_revision: detail.revision,
        expected_runtime_revision: detail.runtime.runtime_revision,
      };
    } else if (action.kind === 'activate-channel') {
      path = `/storage-channels/${detail.id}/activate`;
      body = {
        ...body,
        expected_channel_revision: detail.revision,
        expected_runtime_revision: detail.runtime.runtime_revision,
        validation_run_id: action.run.id,
        evidence_digest: action.run.evidence_digest,
      };
    } else {
      path = `/storage-channels/${detail.id}/disable`;
      body = {
        ...body,
        expected_channel_revision: detail.revision,
        expected_runtime_revision: detail.runtime.runtime_revision,
      };
    }
    await mutation.execute(() =>
      auth.request(path, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify(body),
      }),
    );
    setAction(null);
    await load();
    onChanged();
    void message.success('存储配置已更新');
  }

  return (
    <Drawer
      destroyOnHidden
      loading={loading}
      onClose={onClose}
      open={Boolean(channelId)}
      size="large"
      title="存储通道详情"
    >
      {error ? <Alert className="mb-4" message={error} showIcon type="error" /> : null}
      {!detail && !loading ? <Empty description="暂无存储通道详情" /> : null}
      {detail ? (
        <Space className="w-full" direction="vertical" size="large">
          <Descriptions bordered column={{ xs: 1, sm: 2 }} size="small">
            <Descriptions.Item label="适配器">{detail.adapter_key}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <AdminStatus value={detail.status} />
            </Descriptions.Item>
            <Descriptions.Item label="固定端点">{detail.endpoint_profile_key}</Descriptions.Item>
            <Descriptions.Item label="区域">{detail.region ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="Bucket">{detail.bucket}</Descriptions.Item>
            <Descriptions.Item label="对象根前缀">{detail.root_prefix}</Descriptions.Item>
            <Descriptions.Item label="运行通道">
              {detail.runtime.is_active ? '当前生效' : '未生效'}
            </Descriptions.Item>
            <Descriptions.Item label="运行版本">
              {detail.runtime.runtime_revision}
            </Descriptions.Item>
          </Descriptions>

          <div className="flex flex-wrap gap-2">
            {canRotate ? (
              <Button icon={<KeyOutlined />} onClick={() => setCredentialOpen(true)}>
                添加凭据
              </Button>
            ) : null}
            {canRotate && activeRun && detail.status !== 'active' ? (
              <Button
                icon={<PoweroffOutlined />}
                onClick={() => setAction({ kind: 'activate-channel', run: activeRun })}
                type="primary"
              >
                启用存储通道
              </Button>
            ) : null}
            {canRotate && detail.status !== 'disabled' ? (
              <Button
                danger
                icon={<StopOutlined />}
                onClick={() => setAction({ kind: 'disable-channel' })}
              >
                停用存储通道
              </Button>
            ) : null}
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新证据
            </Button>
          </div>

          <section>
            <Typography.Title level={5}>凭据版本</Typography.Title>
            <Table<StorageCredential>
              columns={[
                { dataIndex: 'version_no', title: '版本', width: 72 },
                { dataIndex: 'key_hint', title: 'Key 提示' },
                {
                  dataIndex: 'status',
                  title: '状态',
                  render: (_, row) => <AdminStatus value={row.status} />,
                },
                {
                  dataIndex: 'verified_at',
                  title: '验证时间',
                  render: (_, row) => <AdminDate value={row.verified_at} />,
                },
                {
                  key: 'actions',
                  title: '操作',
                  width: 220,
                  render: (_, credential) => {
                    const run = passedRuns.get(credential.id);
                    return (
                      <Space wrap>
                        {canRotate &&
                        ['pending_validation', 'invalid', 'validation_unknown', 'active'].includes(
                          credential.status,
                        ) ? (
                          <Button
                            onClick={() => setAction({ kind: 'validate', credential })}
                            size="small"
                          >
                            {credential.status === 'active' ? '重新验证' : '固定验证'}
                          </Button>
                        ) : null}
                        {canRotate && run && credential.status === 'valid' ? (
                          <Button
                            icon={<CheckCircleOutlined />}
                            onClick={() =>
                              setAction({ kind: 'activate-credential', credential, run })
                            }
                            size="small"
                            type="primary"
                          >
                            激活
                          </Button>
                        ) : null}
                        {canRotate && credential.status !== 'revoked' ? (
                          <Button
                            danger
                            onClick={() => setAction({ kind: 'revoke', credential })}
                            size="small"
                            type="link"
                          >
                            撤销
                          </Button>
                        ) : null}
                      </Space>
                    );
                  },
                },
              ]}
              dataSource={detail.credentials}
              pagination={false}
              rowKey="id"
              scroll={{ x: 720 }}
              size="small"
            />
          </section>

          <section>
            <Typography.Title level={5}>固定验证记录</Typography.Title>
            <Table<StorageValidationRun>
              columns={[
                { dataIndex: 'attempt_no', title: '次数', width: 72 },
                { dataIndex: 'probe_contract_version', title: '探测契约' },
                {
                  dataIndex: 'status',
                  title: '结果',
                  render: (_, row) => <AdminStatus value={row.status} />,
                },
                {
                  dataIndex: 'evidence_digest',
                  title: '证据摘要',
                  render: (_, row) => <AdminIdentifier value={row.evidence_digest} />,
                },
                {
                  dataIndex: 'created_at',
                  title: '创建时间',
                  render: (_, row) => <AdminDate value={row.created_at} />,
                },
              ]}
              dataSource={detail.validation_runs}
              pagination={{ pageSize: 5, showSizeChanger: false }}
              rowKey="id"
              scroll={{ x: 640 }}
              size="small"
            />
          </section>
        </Space>
      ) : null}

      <StorageCredentialCreate
        channelId={detail?.id ?? null}
        onCancel={() => setCredentialOpen(false)}
        onCreated={async () => {
          setCredentialOpen(false);
          await load();
          onChanged();
        }}
        open={canRotate && credentialOpen}
      />
      <ReasonActionModal
        danger={action?.kind === 'revoke' || action?.kind === 'disable-channel'}
        description={actionDescription(action)}
        onCancel={() => setAction(null)}
        onSubmit={performAction}
        open={Boolean(action)}
        submitText="确认操作"
        title={actionTitle(action)}
      />
    </Drawer>
  );
}

function StorageCredentialCreate({
  channelId,
  open,
  onCancel,
  onCreated,
}: {
  channelId: string | null;
  open: boolean;
  onCancel: () => void;
  onCreated: () => Promise<void>;
}) {
  const auth = useAdminAuth();
  const mutation = useAdminMutation();
  const [error, setError] = useState<string | null>(null);
  return (
    <ModalForm<{ secret: string; reason: string }>
      modalProps={{ destroyOnHidden: true, maskClosable: false, onCancel }}
      onFinish={async ({ secret, reason }) => {
        if (!channelId) return false;
        const key = adminIdempotencyKey();
        setError(null);
        try {
          await mutation.execute(() =>
            auth.request(`/storage-channels/${channelId}/credentials`, {
              method: 'POST',
              headers: { 'Idempotency-Key': key },
              body: JSON.stringify({ secret, reason }),
            }),
          );
          await onCreated();
          return true;
        } catch (cause) {
          setError(adminErrorMessage(cause));
          return false;
        }
      }}
      open={open}
      submitter={{ searchConfig: { submitText: '保存凭据' } }}
      title="添加存储凭据版本"
      width={520}
    >
      {error ? <Alert className="mb-4" message={error} showIcon type="error" /> : null}
      <Alert
        className="mb-4"
        message="凭据只写不读"
        description="保存后只显示不可逆 Key 提示，明文无法再次查看。"
        showIcon
        type="warning"
      />
      <ProFormText.Password
        fieldProps={{ autoComplete: 'new-password' }}
        label="存储访问凭据"
        name="secret"
        rules={[{ required: true, min: 8 }]}
      />
      <ProFormTextArea label="创建原因" name="reason" rules={[{ required: true, min: 3 }]} />
    </ModalForm>
  );
}

function actionTitle(action: StorageAction | null): string {
  if (action?.kind === 'validate') return '执行存储固定验证';
  if (action?.kind === 'activate-credential') return '激活存储凭据';
  if (action?.kind === 'activate-channel') return '启用存储通道';
  if (action?.kind === 'revoke') return '撤销存储凭据';
  return '停用存储通道';
}

function actionDescription(action: StorageAction | null): string {
  if (action?.kind === 'validate')
    return '将执行 put/head/range-read/delete/sign-private 固定探测，明文凭据不会回显。';
  if (action?.kind === 'activate-credential')
    return '激活后通道将固定使用该凭据版本，旧激活凭据会被撤销。';
  if (action?.kind === 'activate-channel')
    return '启用后新上传使用该通道，历史对象仍按原通道路由。';
  if (action?.kind === 'revoke') return '撤销不可逆；若为当前凭据，运行通道会同步失效。';
  return '停用后不再接受新上传，历史对象和审计记录不会删除。';
}
