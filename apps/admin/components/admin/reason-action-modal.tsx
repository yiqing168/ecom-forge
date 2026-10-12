'use client';

import { ModalForm, ProFormTextArea } from '@ant-design/pro-components';
import { Alert, Typography } from 'antd';
import { useState } from 'react';

import { adminErrorMessage } from '@/lib/admin-api';

export function ReasonActionModal({
  open,
  title,
  description,
  danger = false,
  submitText = '确认',
  onCancel,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description: string;
  danger?: boolean;
  submitText?: string;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  return (
    <ModalForm<{ reason: string }>
      modalProps={{ destroyOnHidden: true, maskClosable: false, onCancel }}
      onFinish={async ({ reason }) => {
        setError(null);
        try {
          await onSubmit(reason.trim());
          return true;
        } catch (cause) {
          setError(adminErrorMessage(cause));
          return false;
        }
      }}
      open={open}
      submitter={{
        searchConfig: { submitText },
        ...(danger ? { submitButtonProps: { danger: true } } : {}),
      }}
      title={title}
      width={480}
    >
      <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>
      {error ? <Alert className="mb-4" message={error} showIcon type="error" /> : null}
      <ProFormTextArea
        fieldProps={{ maxLength: 500, showCount: true }}
        label="操作原因"
        name="reason"
        placeholder="请说明本次操作的业务原因"
        rules={[
          { required: true, message: '请输入操作原因' },
          { min: 3, message: '操作原因至少 3 个字' },
        ]}
      />
    </ModalForm>
  );
}
