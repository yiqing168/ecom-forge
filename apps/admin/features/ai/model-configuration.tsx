'use client';

import {
  DeleteOutlined,
  DollarOutlined,
  EditOutlined,
  KeyOutlined,
  LinkOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AdminPage } from '@/components/admin/admin-page';
import { useAdminAuth } from '@/features/auth/admin-auth-provider';
import { adminErrorMessage, adminIdempotencyKey } from '@/lib/admin-api';

type Purpose = 'brain' | 'image' | 'video';
type Protocol = 'openai' | 'anthropic' | 'google';
const protocolLabels: Record<Protocol, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Gemini',
};

interface ModelConfiguration {
  id: string;
  purpose: Purpose;
  protocol_family: Protocol;
  endpoint_host: string;
  base_url: string;
  model_id: string;
  key_hint: string;
  prices: Record<string, string> | null;
  status: 'active';
  runtime_status: 'available' | 'unavailable' | 'pending_s16';
  revision: number;
  updated_at: string;
}

interface ConnectionValues {
  purpose: Purpose;
  protocol_family: Protocol;
  base_url: string;
  api_key: string;
  selected_model_id?: string;
}

function integerCreditsToStoredValue(value: string | null | undefined): string {
  const normalized = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)$/.test(normalized)) {
    throw new Error('INVALID_INTEGER_CREDITS');
  }
  return `${normalized}.00`;
}

interface ProbeResult {
  probe_token: string;
  expires_at: string;
  models: Array<{ id: string; label: string }>;
}

const purposeLabels: Record<Purpose, string> = {
  brain: 'Brain',
  image: '生图',
  video: '视频',
};

const statusLabels: Record<ModelConfiguration['runtime_status'], string> = {
  available: '可用',
  unavailable: '不可用',
  pending_s16: '待视频能力开放',
};

function requestInit(method: string, body: unknown): RequestInit {
  return {
    method,
    body: JSON.stringify(body),
    headers: { 'Idempotency-Key': adminIdempotencyKey() },
  };
}

function priceSummary(configuration: ModelConfiguration): string {
  if (!configuration.prices) return '未配置';
  const unit = configuration.purpose === 'image' ? '积分/张' : '积分/秒';
  const keys = configuration.purpose === 'image' ? ['1k', '2k', '4k'] : ['720p', '1080p', '4k'];
  return keys
    .map(
      (key) =>
        `${key.toUpperCase()} ${configuration.prices?.[key]?.replace(/\.00$/, '') ?? '未配置'}`,
    )
    .join(` · `)
    .concat(` ${unit}`);
}

export function ModelConfigurationPage() {
  const auth = useAdminAuth();
  const [form] = Form.useForm<ConnectionValues>();
  const [creditForm] = Form.useForm<Record<string, string>>();
  const [items, setItems] = useState<ModelConfiguration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<ModelConfiguration | null>(null);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [creditTarget, setCreditTarget] = useState<ModelConfiguration | null>(null);
  const [creditSaving, setCreditSaving] = useState(false);
  const [notice, noticeContext] = message.useMessage();
  const purpose = Form.useWatch('purpose', form) ?? 'brain';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await auth.request<{ items: ModelConfiguration[] }>('/model-configurations');
      setItems(result.items);
      setError(null);
    } catch (cause) {
      setError(adminErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    void load();
  }, [load]);

  const modelOptions = useMemo(
    () => probe?.models.map((model) => ({ label: model.label, value: model.id })) ?? [],
    [probe],
  );

  function openCreate() {
    setEditing(null);
    setProbe(null);
    form.setFieldsValue({
      purpose: 'brain',
      protocol_family: 'openai',
      base_url: '',
      api_key: '',
    });
    form.resetFields(['selected_model_id']);
    setDrawerOpen(true);
  }

  function openEdit(configuration: ModelConfiguration) {
    setEditing(configuration);
    setProbe(null);
    form.setFieldsValue({
      purpose: configuration.purpose,
      protocol_family: configuration.protocol_family,
      base_url: configuration.base_url,
      api_key: '',
    });
    form.resetFields(['selected_model_id']);
    setDrawerOpen(true);
  }

  function resetProbe() {
    setProbe(null);
    form.setFieldValue('selected_model_id', undefined);
  }

  async function probeModels() {
    const values = await form.validateFields(['purpose', 'protocol_family', 'base_url', 'api_key']);
    const apiKey = values.api_key.trim();
    setProbing(true);
    try {
      const result = await auth.request<ProbeResult>(
        '/model-configurations/probe-models',
        requestInit('POST', {
          purpose: values.purpose,
          protocol_family: values.protocol_family,
          base_url: values.base_url,
          ...(apiKey ? { api_key: apiKey } : { configuration_id: editing?.id }),
        }),
      );
      setProbe(result);
      form.setFieldValue(
        'selected_model_id',
        editing && result.models.some((model) => model.id === editing.model_id)
          ? editing.model_id
          : result.models[0]?.id,
      );
      notice.success(`已获取 ${result.models.length} 个模型`);
    } catch (cause) {
      notice.error(adminErrorMessage(cause));
    } finally {
      setProbing(false);
    }
  }

  async function saveModel() {
    if (!probe) {
      notice.warning('请先获取模型');
      return;
    }
    const values = await form.validateFields(['selected_model_id']);
    setSaving(true);
    try {
      await auth.request(
        editing ? `/model-configurations/${editing.id}` : '/model-configurations',
        requestInit(editing ? 'PATCH' : 'POST', {
          probe_token: probe.probe_token,
          selected_model_id: values.selected_model_id,
          ...(editing ? { expected_revision: editing.revision } : {}),
          reason: editing ? '更新模型配置' : '添加模型配置',
        }),
      );
      setDrawerOpen(false);
      notice.success(editing ? '模型配置已更新' : '模型已添加');
      await load();
    } catch (cause) {
      notice.error(adminErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function openCredits(configuration: ModelConfiguration) {
    setCreditTarget(configuration);
    const keys = configuration.purpose === 'image' ? ['1k', '2k', '4k'] : ['720p', '1080p', '4k'];
    creditForm.setFieldsValue(
      Object.fromEntries(
        keys.map((key) => [key, configuration.prices?.[key]?.replace(/\.00$/, '') ?? '']),
      ),
    );
  }

  async function saveCredits() {
    if (!creditTarget) return;
    const values = await creditForm.validateFields();
    const prices = Object.fromEntries(
      priceKeys.map((key) => [key, integerCreditsToStoredValue(values[key])]),
    );
    setCreditSaving(true);
    try {
      await auth.request(
        `/model-configurations/${creditTarget.id}/credits`,
        requestInit('PUT', {
          prices,
          expected_revision: creditTarget.revision,
          reason: '更新模型积分',
        }),
      );
      setCreditTarget(null);
      notice.success('积分配置已保存');
      await load();
    } catch (cause) {
      notice.error(adminErrorMessage(cause));
    } finally {
      setCreditSaving(false);
    }
  }

  async function remove(configuration: ModelConfiguration) {
    try {
      await auth.request(
        `/model-configurations/${configuration.id}`,
        requestInit('DELETE', {
          expected_revision: configuration.revision,
          reason: '删除模型配置',
        }),
      );
      notice.success('模型配置已删除');
      await load();
    } catch (cause) {
      notice.error(adminErrorMessage(cause));
    }
  }

  const priceKeys =
    creditTarget?.purpose === 'video' ? ['720p', '1080p', '4k'] : ['1k', '2k', '4k'];

  return (
    <AdminPage
      actions={
        <Space>
          <Button
            aria-label="刷新模型列表"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => void load()}
          >
            刷新
          </Button>
          <Button aria-label="添加模型" icon={<PlusOutlined />} onClick={openCreate} type="primary">
            添加模型
          </Button>
        </Space>
      }
      eyebrow="AI 能力"
      title="模型配置"
    >
      {noticeContext}
      {error ? <Alert className="mb-4" message={error} showIcon type="error" /> : null}
      {loading && items.length === 0 ? (
        <div className="rounded-md border border-[var(--border)] bg-white p-5">
          <Skeleton active paragraph={{ rows: 5 }} />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-md border border-[var(--border)] bg-white py-16">
          <Empty description="还没有配置模型">
            <Button
              aria-label="添加模型"
              icon={<PlusOutlined />}
              onClick={openCreate}
              type="primary"
            >
              添加模型
            </Button>
          </Empty>
        </div>
      ) : (
        <List
          dataSource={items}
          renderItem={(configuration) => (
            <List.Item className="mb-3! rounded-md! border! border-[var(--border)]! bg-white! p-4! shadow-[var(--shadow-sm)]!">
              <div className="w-full">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Typography.Text className="!text-base" strong>
                        {configuration.model_id}
                      </Typography.Text>
                      <Tag color="blue">{purposeLabels[configuration.purpose]}</Tag>
                      <Tag
                        color={configuration.runtime_status === 'available' ? 'success' : 'warning'}
                      >
                        {statusLabels[configuration.runtime_status]}
                      </Tag>
                    </div>
                    <Typography.Text className="mt-1 block!" type="secondary">
                      {protocolLabels[configuration.protocol_family]} ·{' '}
                      {configuration.endpoint_host} · {configuration.key_hint}
                    </Typography.Text>
                  </div>
                  <Space size="small" wrap>
                    <Button
                      aria-label={`修改模型 ${configuration.model_id}`}
                      icon={<EditOutlined />}
                      onClick={() => openEdit(configuration)}
                    >
                      修改
                    </Button>
                    {configuration.purpose !== 'brain' ? (
                      <Button
                        aria-label={`配置 ${configuration.model_id} 积分`}
                        icon={<DollarOutlined />}
                        onClick={() => openCredits(configuration)}
                      >
                        积分配置
                      </Button>
                    ) : null}
                    <Popconfirm
                      cancelText="取消"
                      description="历史任务不受影响"
                      okButtonProps={{ danger: true }}
                      okText="删除"
                      onConfirm={() => {
                        void remove(configuration);
                      }}
                      title="删除这个模型配置？"
                    >
                      <Button danger icon={<DeleteOutlined />} aria-label="删除模型配置" />
                    </Popconfirm>
                  </Space>
                </div>
                {configuration.purpose !== 'brain' ? (
                  <div className="mt-3 border-t border-[var(--border)] pt-3 text-sm">
                    {configuration.prices ? (
                      <Typography.Text>{priceSummary(configuration)}</Typography.Text>
                    ) : (
                      <Typography.Text type="secondary">
                        {priceSummary(configuration)}
                      </Typography.Text>
                    )}
                  </div>
                ) : null}
              </div>
            </List.Item>
          )}
        />
      )}

      <Drawer
        destroyOnHidden
        extra={
          <Button
            disabled={!probe}
            loading={saving}
            onClick={() => void saveModel()}
            type="primary"
          >
            {editing ? '保存修改' : '添加模型'}
          </Button>
        }
        onClose={() => setDrawerOpen(false)}
        open={drawerOpen}
        title={editing ? '修改模型' : '添加模型'}
        width="min(520px, 100vw)"
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item label="用途" name="purpose" rules={[{ required: true }]}>
            <Segmented
              block
              onChange={(value) => {
                if (value !== 'brain') form.setFieldValue('protocol_family', 'openai');
                resetProbe();
              }}
              options={[
                { label: 'Brain', value: 'brain' },
                { label: '生图', value: 'image' },
                { label: '视频', value: 'video' },
              ]}
            />
          </Form.Item>
          <Form.Item label="协议" name="protocol_family" rules={[{ required: true }]}>
            <Segmented
              block
              disabled={purpose !== 'brain'}
              onChange={resetProbe}
              options={[
                { label: 'OpenAI', value: 'openai' },
                { label: 'Anthropic', value: 'anthropic' },
                { label: 'Gemini', value: 'google' },
              ]}
            />
          </Form.Item>
          <Form.Item
            label="接口地址"
            name="base_url"
            rules={[{ required: true, message: '请输入接口地址' }]}
          >
            <Input
              autoComplete="url"
              onChange={resetProbe}
              placeholder="https://api.example.com"
              prefix={<LinkOutlined />}
            />
          </Form.Item>
          <Form.Item
            extra={
              editing
                ? '留空则沿用当前 Key；填写新 Key 会替换凭据'
                : '只用于连接并加密保存，不会回显'
            }
            label="API Key"
            name="api_key"
            rules={[
              { required: !editing, message: '请输入 API Key' },
              { min: 8, message: '请输入有效 Key' },
            ]}
          >
            <Input.Password
              autoComplete="new-password"
              onChange={resetProbe}
              placeholder={editing ? '留空则不修改' : '输入 Key'}
              prefix={<KeyOutlined />}
            />
          </Form.Item>
          <Button
            aria-label="获取模型"
            block
            icon={<SearchOutlined />}
            loading={probing}
            onClick={() => void probeModels()}
          >
            获取模型
          </Button>
          <Form.Item
            className="mt-5"
            label="模型"
            name="selected_model_id"
            rules={[{ required: true, message: '请选择模型' }]}
          >
            <Select
              disabled={!probe}
              optionFilterProp="label"
              options={modelOptions}
              placeholder={probe ? '选择模型' : '请先获取模型'}
              showSearch
            />
          </Form.Item>
          {editing ? (
            <Descriptions
              className="mt-5"
              column={1}
              items={[{ key: 'current', label: '当前模型', children: editing.model_id }]}
              size="small"
            />
          ) : null}
        </Form>
      </Drawer>

      <Modal
        cancelText="取消"
        confirmLoading={creditSaving}
        destroyOnHidden
        okButtonProps={{ 'aria-label': '保存积分配置' }}
        okText="保存"
        onCancel={() => setCreditTarget(null)}
        onOk={() => void saveCredits()}
        open={Boolean(creditTarget)}
        title="积分配置"
      >
        <Typography.Paragraph type="secondary">
          {creditTarget?.purpose === 'video' ? '按清晰度配置每秒积分' : '按分辨率配置每张积分'}
        </Typography.Paragraph>
        <Form form={creditForm} layout="vertical" requiredMark={false}>
          {priceKeys.map((key) => (
            <Form.Item
              key={key}
              label={key.toUpperCase()}
              name={key}
              rules={[{ required: true, message: '请输入积分' }]}
            >
              <InputNumber
                className="w-full"
                min={0}
                placeholder="0"
                precision={0}
                step={1}
                stringMode
                suffix={creditTarget?.purpose === 'video' ? '积分/秒' : '积分/张'}
              />
            </Form.Item>
          ))}
        </Form>
      </Modal>
    </AdminPage>
  );
}
