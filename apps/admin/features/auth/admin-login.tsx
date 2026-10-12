'use client';

import {
  KeyOutlined,
  LockOutlined,
  LoginOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { ProForm, ProFormText } from '@ant-design/pro-components';
import { Alert, Button, Segmented, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { adminErrorMessage, adminRequest, type AdminChallenge } from '@/lib/admin-api';

import { adminMfaErrorMessage } from './admin-login-errors';

const credentialsSchema = z.object({
  identifier: z.string().trim().min(1),
  password: z.string().min(1),
});
const mfaSchema = z.object({ code: z.string().trim().min(1).max(64) });

type CredentialsValues = z.infer<typeof credentialsSchema>;
type MfaValues = z.infer<typeof mfaSchema>;

export function AdminLogin({ onAuthenticated }: { onAuthenticated: () => Promise<void> }) {
  const [step, setStep] = useState<'credentials' | 'mfa'>('credentials');
  const [challenge, setChallenge] = useState<AdminChallenge | null>(null);
  const [method, setMethod] = useState<'totp' | 'recovery'>('totp');
  const [error, setError] = useState<string | null>(null);
  const [localLoginAvailable, setLocalLoginAvailable] = useState(false);
  const [localLoginLoading, setLocalLoginLoading] = useState(false);

  useEffect(() => {
    void adminRequest<{ local_login_available: boolean }>('/auth/local-session')
      .then((result) => setLocalLoginAvailable(result.local_login_available))
      .catch(() => setLocalLoginAvailable(false));
  }, []);

  async function localLogin(): Promise<void> {
    setError(null);
    setLocalLoginLoading(true);
    try {
      await adminRequest('/auth/local-session', { method: 'POST', body: '{}' });
      await onAuthenticated();
    } catch (cause) {
      setError(adminErrorMessage(cause));
    } finally {
      setLocalLoginLoading(false);
    }
  }

  async function submitCredentials(raw: CredentialsValues): Promise<boolean> {
    setError(null);
    const parsed = credentialsSchema.safeParse(raw);
    if (!parsed.success) return false;
    try {
      const next = await adminRequest<AdminChallenge>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(parsed.data),
      });
      setChallenge(next);
      setMethod(next.methods.includes('totp') ? 'totp' : 'recovery');
      setStep('mfa');
      return true;
    } catch (cause) {
      setError(adminErrorMessage(cause));
      return false;
    }
  }

  async function submitMfa(raw: MfaValues): Promise<boolean> {
    setError(null);
    const parsed = mfaSchema.safeParse(raw);
    if (!parsed.success || !challenge) return false;
    const path = method === 'totp' ? '/auth/mfa/totp/verify' : '/auth/mfa/recovery/verify';
    const credential =
      method === 'totp' ? { code: parsed.data.code } : { recovery_code: parsed.data.code };
    try {
      await adminRequest(path, {
        method: 'POST',
        body: JSON.stringify({
          challenge_id: challenge.challenge_id,
          challenge_token: challenge.challenge_token,
          ...credential,
        }),
      });
      await onAuthenticated();
      return true;
    } catch (cause) {
      setError(adminMfaErrorMessage(cause, method));
      return false;
    }
  }

  return (
    <main className="grid min-h-screen lg:grid-cols-[minmax(320px,0.82fr)_minmax(480px,1.18fr)]">
      <section className="hidden bg-[var(--navigation)] p-10 text-white lg:flex lg:flex-col lg:justify-between">
        <Brand />
        <div className="max-w-md">
          <Typography.Text className="!text-[#a9d8c2]">独立安全域</Typography.Text>
          <Typography.Title className="!mb-0 !mt-3 !text-white" level={1}>
            Ecom Forge 管理控制面
          </Typography.Title>
        </div>
        <Typography.Text className="!text-xs !text-[var(--navigation-muted)]">
          仅限授权网络与管理员账号
        </Typography.Text>
      </section>

      <section className="flex min-h-screen items-center justify-center bg-[var(--background)] px-5 py-10">
        <div className="w-full max-w-[420px]">
          <div className="mb-8 lg:hidden">
            <Brand dark />
          </div>
          <div className="mb-6">
            <Typography.Text className="!font-semibold !text-[var(--primary)]">
              {step === 'credentials' ? '管理员登录' : '双重验证'}
            </Typography.Text>
            <Typography.Title className="!mb-1 !mt-2" level={2}>
              {step === 'credentials' ? '进入管理控制面' : '验证动态凭据'}
            </Typography.Title>
            <Typography.Paragraph type="secondary">
              {step === 'credentials'
                ? '使用独立管理员账号登录。'
                : method === 'totp'
                  ? '输入认证器中当前显示的 6 位验证码。'
                  : '输入一枚尚未使用的恢复码。'}
            </Typography.Paragraph>
          </div>

          {step === 'credentials' ? (
            <>
              {localLoginAvailable ? (
                <Button
                  block
                  className="mb-5"
                  icon={<LoginOutlined />}
                  loading={localLoginLoading}
                  onClick={() => void localLogin()}
                  size="large"
                  type="primary"
                >
                  一键进入本地管理台
                </Button>
              ) : null}
              <ProForm<CredentialsValues>
                onFinish={submitCredentials}
                submitter={{
                  resetButtonProps: { style: { display: 'none' } },
                  submitButtonProps: { block: true, icon: <LoginOutlined />, size: 'large' },
                  searchConfig: { submitText: '登录' },
                }}
              >
                <ProFormText
                  fieldProps={{
                    autoComplete: 'username',
                    autoFocus: true,
                    prefix: <KeyOutlined />,
                  }}
                  label="管理员账号"
                  name="identifier"
                  rules={[{ required: true, message: '请输入管理员账号' }]}
                />
                <ProFormText.Password
                  fieldProps={{ autoComplete: 'current-password', prefix: <LockOutlined /> }}
                  label="密码"
                  name="password"
                  rules={[{ required: true, message: '请输入密码' }]}
                />
                {error ? <Alert className="mb-4" message={error} showIcon type="error" /> : null}
              </ProForm>
            </>
          ) : (
            <>
              <Segmented
                block
                className="mb-5"
                onChange={(value) => {
                  setMethod(value);
                  setError(null);
                }}
                options={[
                  ...(challenge?.methods.includes('totp')
                    ? [{ label: '动态验证码', value: 'totp' as const }]
                    : []),
                  ...(challenge?.methods.includes('recovery')
                    ? [{ label: '恢复码', value: 'recovery' as const }]
                    : []),
                ]}
                value={method}
              />
              <ProForm<MfaValues>
                key={method}
                onFinish={submitMfa}
                submitter={{
                  resetButtonProps: { style: { display: 'none' } },
                  submitButtonProps: {
                    block: true,
                    icon: <SafetyCertificateOutlined />,
                    size: 'large',
                  },
                  searchConfig: { submitText: '完成验证' },
                }}
              >
                <ProFormText
                  fieldProps={{
                    autoComplete: 'one-time-code',
                    autoFocus: true,
                    maxLength: method === 'totp' ? 6 : 64,
                    prefix: <SafetyCertificateOutlined />,
                  }}
                  label={method === 'totp' ? '6 位动态验证码' : '恢复码'}
                  name="code"
                  rules={[{ required: true, message: '请输入验证凭据' }]}
                />
                {error ? <Alert className="mb-4" message={error} showIcon type="error" /> : null}
              </ProForm>
              <Button
                block
                onClick={() => {
                  setStep('credentials');
                  setChallenge(null);
                  setError(null);
                }}
                type="text"
              >
                返回账号登录
              </Button>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function Brand({ dark = false }: { dark?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={`grid size-9 place-items-center rounded-md ${dark ? 'bg-[var(--navigation)] text-white' : 'bg-white text-[var(--navigation)]'}`}
      >
        <SafetyCertificateOutlined aria-hidden className="text-lg" />
      </span>
      <div>
        <div className={dark ? 'font-bold text-[var(--foreground)]' : 'font-bold text-white'}>
          Ecom Forge
        </div>
        <div className="text-xs text-[var(--navigation-muted)]">Control Plane</div>
      </div>
    </div>
  );
}
