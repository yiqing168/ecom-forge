'use client';

import { ModalForm, ProFormDigit, ProFormText } from '@ant-design/pro-components';
import { Alert, Typography } from 'antd';
import { useState } from 'react';

import { useAdminAuth } from '@/features/auth/admin-auth-provider';
import { useAdminMutation } from '@/features/auth/admin-mutation-provider';
import { adminErrorMessage, adminIdempotencyKey } from '@/lib/admin-api';

export interface GeneratedInviteCode {
  id: string;
  prefix: string;
  plaintext_code: string;
}

interface GenerateValues {
  count: number;
  expires_at?: string;
}

export function InviteGenerateForm({
  open,
  onCancel,
  onGenerated,
}: {
  open: boolean;
  onCancel: () => void;
  onGenerated: (codes: GeneratedInviteCode[]) => void;
}) {
  const auth = useAdminAuth();
  const mutation = useAdminMutation();
  const [error, setError] = useState<string | null>(null);

  return (
    <ModalForm<GenerateValues>
      initialValues={{ count: 1 }}
      modalProps={{ destroyOnHidden: true, maskClosable: false, onCancel }}
      onFinish={async (values) => {
        setError(null);
        try {
          const response = await mutation.execute(() =>
            auth.request<{
              plaintext_available: boolean;
              codes: Array<
                Partial<GeneratedInviteCode> & Pick<GeneratedInviteCode, 'id' | 'prefix'>
              >;
            }>('/invites', {
              method: 'POST',
              headers: { 'Idempotency-Key': adminIdempotencyKey() },
              body: JSON.stringify({
                count: values.count,
                expires_at: optionalIso(values.expires_at),
              }),
            }),
          );
          const codes = response.codes.filter(
            (code): code is GeneratedInviteCode => typeof code.plaintext_code === 'string',
          );
          if (!response.plaintext_available || codes.length !== response.codes.length) {
            setError('该请求已经执行，邀请码明文不会再次显示。请使用新的请求重新生成。');
            return false;
          }
          onGenerated(codes);
          return true;
        } catch (cause) {
          setError(adminErrorMessage(cause));
          return false;
        }
      }}
      open={open}
      submitter={{ searchConfig: { submitText: '生成邀请码' } }}
      title="生成邀请码"
      width={480}
    >
      {error ? <Alert className="mb-4" message={error} showIcon type="error" /> : null}
      <ProFormDigit
        fieldProps={{ min: 1, max: 1_000, precision: 0 }}
        label="生成数量"
        name="count"
        rules={[{ required: true, message: '请输入生成数量' }]}
      />
      <ProFormText fieldProps={{ type: 'datetime-local' }} label="有效期至" name="expires_at" />
      <Typography.Text type="secondary">不填写有效期时，邀请码长期有效。</Typography.Text>
    </ModalForm>
  );
}

function optionalIso(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
