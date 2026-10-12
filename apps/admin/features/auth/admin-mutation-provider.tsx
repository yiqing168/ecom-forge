'use client';

import { LockOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { ModalForm, ProFormText } from '@ant-design/pro-components';
import { Alert } from 'antd';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { z } from 'zod';

import { AdminApiError, adminErrorMessage } from '@/lib/admin-api';

import { useAdminAuth } from './admin-auth-provider';

const stepUpSchema = z.object({
  password: z.string().min(1),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});
type StepUpValues = z.infer<typeof stepUpSchema>;

interface PendingMutation {
  action: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface AdminMutationContextValue {
  execute: <T>(action: () => Promise<T>) => Promise<T>;
}

const AdminMutationContext = createContext<AdminMutationContextValue | null>(null);

export function AdminMutationProvider({ children }: { children: ReactNode }) {
  const auth = useAdminAuth();
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (cause) {
      if (!(cause instanceof AdminApiError) || cause.code !== 'ADMIN_STEP_UP_REQUIRED') throw cause;
      return await new Promise<T>((resolve, reject) => {
        setError(null);
        setPending({
          action,
          resolve: (value) => resolve(value as T),
          reject,
        });
      });
    }
  }, []);

  const value = useMemo<AdminMutationContextValue>(() => ({ execute }), [execute]);

  async function finishStepUp(raw: StepUpValues): Promise<boolean> {
    const parsed = stepUpSchema.safeParse(raw);
    if (!parsed.success || !pending) return false;
    setError(null);
    try {
      await auth.request('/auth/step-up', {
        method: 'POST',
        body: JSON.stringify(parsed.data),
      });
      await auth.refresh();
      const result = await pending.action();
      pending.resolve(result);
      setPending(null);
      return true;
    } catch (cause) {
      setError(adminErrorMessage(cause));
      return false;
    }
  }

  function cancel(): void {
    pending?.reject(new AdminApiError('ADMIN_STEP_UP_CANCELLED', 0, '已取消安全验证'));
    setPending(null);
    setError(null);
  }

  return (
    <AdminMutationContext.Provider value={value}>
      {children}
      <ModalForm<StepUpValues>
        modalProps={{ destroyOnHidden: true, maskClosable: false }}
        onFinish={finishStepUp}
        onOpenChange={(open) => {
          if (!open && pending) cancel();
        }}
        open={Boolean(pending)}
        submitter={{ searchConfig: { submitText: '完成安全验证' } }}
        title="高风险操作验证"
        width={440}
      >
        {error ? <Alert className="mb-4" message={error} showIcon type="error" /> : null}
        <ProFormText.Password
          fieldProps={{
            'aria-label': '管理员密码',
            autoComplete: 'current-password',
            prefix: <LockOutlined />,
          }}
          label="管理员密码"
          name="password"
          rules={[{ required: true, message: '请输入管理员密码' }]}
        />
        <ProFormText
          fieldProps={{
            'aria-label': '6 位动态验证码',
            autoComplete: 'one-time-code',
            maxLength: 6,
            prefix: <SafetyCertificateOutlined />,
          }}
          label="6 位动态验证码"
          name="code"
          rules={[{ pattern: /^\d{6}$/, message: '请输入 6 位数字验证码' }]}
        />
      </ModalForm>
    </AdminMutationContext.Provider>
  );
}

export function useAdminMutation(): AdminMutationContextValue {
  const context = useContext(AdminMutationContext);
  if (!context) throw new Error('useAdminMutation must be used inside AdminMutationProvider');
  return context;
}
