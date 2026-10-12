'use client';

import {
  ModalForm,
  ProFormDependency,
  ProFormSelect,
  ProFormText,
  ProFormTextArea,
} from '@ant-design/pro-components';
import { Alert, Typography } from 'antd';
import { useMemo, useState } from 'react';

import { useAdminAuth } from '@/features/auth/admin-auth-provider';
import { useAdminMutation } from '@/features/auth/admin-mutation-provider';
import { adminErrorMessage, adminIdempotencyKey } from '@/lib/admin-api';

export interface StorageEndpointProfile {
  key: string;
  regions: string[];
  capabilities: string[];
}

export interface StorageAdapterProfile extends Record<string, unknown> {
  adapter_key: string;
  display_name: string;
  probe_contract_version: string;
  endpoint_profiles: StorageEndpointProfile[];
}

interface StorageChannelValues {
  adapter_key: string;
  endpoint_profile_key: string;
  region?: string;
  bucket: string;
  root_prefix: string;
  reason: string;
}

export function StorageChannelCreate({
  adapters,
  open,
  onCancel,
  onCreated,
}: {
  adapters: readonly StorageAdapterProfile[];
  open: boolean;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const auth = useAdminAuth();
  const mutation = useAdminMutation();
  const [error, setError] = useState<string | null>(null);
  const adapterOptions = useMemo(
    () => adapters.map((adapter) => ({ label: adapter.display_name, value: adapter.adapter_key })),
    [adapters],
  );

  return (
    <ModalForm<StorageChannelValues>
      initialValues={{ root_prefix: 'ecom-forge/private-assets' }}
      modalProps={{ destroyOnHidden: true, maskClosable: false, onCancel }}
      onFinish={async (values) => {
        setError(null);
        const key = adminIdempotencyKey();
        try {
          await mutation.execute(() =>
            auth.request('/storage-channels', {
              method: 'POST',
              headers: { 'Idempotency-Key': key },
              body: JSON.stringify({
                purpose: 'private_assets',
                adapter_key: values.adapter_key,
                endpoint_profile_key: values.endpoint_profile_key,
                region: values.region || null,
                bucket: values.bucket,
                root_prefix: values.root_prefix,
                reason: values.reason,
              }),
            }),
          );
          onCreated();
          return true;
        } catch (cause) {
          setError(adminErrorMessage(cause));
          return false;
        }
      }}
      open={open}
      submitter={{ searchConfig: { submitText: '创建存储通道' } }}
      title="新增私有对象存储通道"
      width={640}
    >
      <Typography.Paragraph type="secondary">
        只允许选择系统已注册的私有存储适配器和固定端点，不能输入任意 URL。
      </Typography.Paragraph>
      {error ? <Alert className="mb-4" message={error} showIcon type="error" /> : null}
      <ProFormSelect
        fieldProps={{ 'aria-label': '存储适配器' }}
        label="存储适配器"
        name="adapter_key"
        options={adapterOptions}
        rules={[{ required: true, message: '请选择存储适配器' }]}
      />
      <ProFormDependency name={['adapter_key']}>
        {({ adapter_key: adapterKey }: { adapter_key?: string }) => {
          const endpoints =
            adapters.find((adapter) => adapter.adapter_key === adapterKey)?.endpoint_profiles ?? [];
          return (
            <>
              <ProFormSelect
                fieldProps={{ 'aria-label': '固定端点' }}
                label="固定端点"
                name="endpoint_profile_key"
                options={endpoints.map((endpoint) => ({
                  label: endpoint.key === 'local' ? '本地私有存储' : endpoint.key,
                  value: endpoint.key,
                }))}
                rules={[{ required: true, message: '请选择固定端点' }]}
              />
              <ProFormDependency name={['endpoint_profile_key']}>
                {({ endpoint_profile_key: endpointKey }: { endpoint_profile_key?: string }) => {
                  const endpoint = endpoints.find((candidate) => candidate.key === endpointKey);
                  return endpoint?.regions.length ? (
                    <ProFormSelect
                      fieldProps={{ 'aria-label': '区域' }}
                      label="区域"
                      name="region"
                      options={endpoint.regions.map((region) => ({
                        label: region === 'local' ? '本地' : region,
                        value: region,
                      }))}
                      rules={[{ required: true, message: '请选择区域' }]}
                    />
                  ) : null;
                }}
              </ProFormDependency>
            </>
          );
        }}
      </ProFormDependency>
      <ProFormText
        fieldProps={{ 'aria-label': 'Bucket' }}
        label="Bucket"
        name="bucket"
        rules={[{ required: true, min: 3 }]}
      />
      <ProFormText
        fieldProps={{ 'aria-label': '对象根前缀' }}
        label="对象根前缀"
        name="root_prefix"
        rules={[
          { required: true },
          {
            pattern: /^(?!\/)(?!.*\.\.)[a-zA-Z0-9][a-zA-Z0-9/_-]*$/,
            message: '请输入安全的相对对象前缀',
          },
        ]}
      />
      <ProFormTextArea label="创建原因" name="reason" rules={[{ required: true, min: 3 }]} />
    </ModalForm>
  );
}
