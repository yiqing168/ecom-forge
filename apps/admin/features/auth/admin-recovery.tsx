'use client';

import { CopyOutlined, LogoutOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { ProForm, ProFormText } from '@ant-design/pro-components';
import { Alert, Button, Checkbox, Input, Result, Space, Steps, Typography, message } from 'antd';
import { useState } from 'react';
import { z } from 'zod';

import { adminErrorMessage } from '@/lib/admin-api';

import { useAdminAuth } from './admin-auth-provider';

const totpSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});
const stepUpSchema = z.object({
  password: z.string().min(1),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});

interface TotpRotation {
  challenge_id: string;
  challenge_token: string;
  totp_secret: string;
  provisioning_uri: string;
  expires_in_seconds: number;
}

interface RecoveryCodeRotation {
  recovery_codes: string[];
  plaintext_available: true;
}

type RecoveryStep = 'start' | 'totp' | 'step-up' | 'codes';

export function AdminRecovery() {
  const auth = useAdminAuth();
  const [step, setStep] = useState<RecoveryStep>('start');
  const [rotation, setRotation] = useState<TotpRotation | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  async function startRotation(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await auth.request<TotpRotation>('/auth/mfa/totp/rotate/start', {
        method: 'POST',
        body: '{}',
      });
      setRotation(result);
      setStep('totp');
    } catch (cause) {
      setError(adminErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmTotp(raw: z.infer<typeof totpSchema>): Promise<boolean> {
    const parsed = totpSchema.safeParse(raw);
    if (!parsed.success || !rotation) return false;
    setError(null);
    try {
      await auth.request('/auth/mfa/totp/rotate/confirm', {
        method: 'POST',
        body: JSON.stringify({
          challenge_id: rotation.challenge_id,
          challenge_token: rotation.challenge_token,
          code: parsed.data.code,
        }),
      });
      setStep('step-up');
      return true;
    } catch (cause) {
      setError(adminErrorMessage(cause));
      return false;
    }
  }

  async function rotateRecoveryCodes(raw: z.infer<typeof stepUpSchema>): Promise<boolean> {
    const parsed = stepUpSchema.safeParse(raw);
    if (!parsed.success) return false;
    setError(null);
    try {
      await auth.request('/auth/step-up', {
        method: 'POST',
        body: JSON.stringify(parsed.data),
      });
      const result = await auth.request<RecoveryCodeRotation>('/auth/mfa/recovery-codes/rotate', {
        method: 'POST',
        body: '{}',
      });
      setRecoveryCodes(result.recovery_codes);
      setStep('codes');
      return true;
    } catch (cause) {
      setError(adminErrorMessage(cause));
      return false;
    }
  }

  async function copy(value: string, successMessage: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      await messageApi.success(successMessage);
    } catch {
      await messageApi.error('复制失败，请手动选择文本');
    }
  }

  const current = step === 'start' ? 0 : step === 'totp' ? 1 : step === 'step-up' ? 2 : 3;

  return (
    <main className="min-h-screen bg-[var(--background)] px-5 py-10">
      {contextHolder}
      <section className="mx-auto w-full max-w-[560px]">
        <Result
          className="!px-0 !pb-5"
          icon={<SafetyCertificateOutlined />}
          status="warning"
          subTitle="恢复码登录只开放本人安全操作。完成凭据更新后即可恢复管理权限。"
          title="恢复模式受限"
        />

        <Steps
          className="mb-8"
          current={current}
          items={[
            { title: '开始' },
            { title: '动态验证码' },
            { title: '安全确认' },
            { title: '恢复码' },
          ]}
          responsive
          size="small"
        />

        {error ? <Alert className="mb-5" message={error} showIcon type="error" /> : null}

        {step === 'start' ? (
          <Space className="w-full" direction="vertical" size="middle">
            <Typography.Paragraph>
              继续后将更换当前动态验证码密钥，并撤销旧恢复码和其他管理会话。
            </Typography.Paragraph>
            <Button
              block
              loading={busy}
              onClick={() => void startRotation()}
              size="large"
              type="primary"
            >
              开始安全恢复
            </Button>
            <Button block icon={<LogoutOutlined />} onClick={() => void auth.logout()} size="large">
              退出登录
            </Button>
          </Space>
        ) : null}

        {step === 'totp' && rotation ? (
          <>
            <Typography.Title level={4}>绑定新的动态验证码</Typography.Title>
            <Typography.Paragraph type="secondary">
              在认证器中手动添加以下密钥，然后输入当前显示的 6 位验证码。
            </Typography.Paragraph>
            <Input
              addonAfter={
                <Button
                  aria-label="复制动态验证码密钥"
                  icon={<CopyOutlined />}
                  onClick={() => void copy(rotation.totp_secret, '密钥已复制')}
                  type="text"
                />
              }
              className="mb-5"
              readOnly
              value={rotation.totp_secret}
            />
            <ProForm<z.infer<typeof totpSchema>>
              onFinish={confirmTotp}
              submitter={{
                resetButtonProps: { style: { display: 'none' } },
                submitButtonProps: { block: true, size: 'large' },
                searchConfig: { submitText: '确认新的动态验证码' },
              }}
            >
              <ProFormText
                fieldProps={{ autoComplete: 'one-time-code', autoFocus: true, maxLength: 6 }}
                label="6 位动态验证码"
                name="code"
                rules={[{ pattern: /^\d{6}$/, message: '请输入 6 位数字验证码' }]}
              />
            </ProForm>
          </>
        ) : null}

        {step === 'step-up' ? (
          <>
            <Typography.Title level={4}>确认管理员身份</Typography.Title>
            <Typography.Paragraph type="secondary">
              输入管理员密码和认证器更新后的下一组验证码，生成新的恢复码。
            </Typography.Paragraph>
            <ProForm<z.infer<typeof stepUpSchema>>
              onFinish={rotateRecoveryCodes}
              submitter={{
                resetButtonProps: { style: { display: 'none' } },
                submitButtonProps: { block: true, size: 'large' },
                searchConfig: { submitText: '生成新的恢复码' },
              }}
            >
              <ProFormText.Password
                fieldProps={{ autoComplete: 'current-password', autoFocus: true }}
                label="管理员密码"
                name="password"
                rules={[{ required: true, message: '请输入管理员密码' }]}
              />
              <ProFormText
                fieldProps={{ autoComplete: 'one-time-code', maxLength: 6 }}
                label="新的 6 位动态验证码"
                name="code"
                rules={[{ pattern: /^\d{6}$/, message: '请输入 6 位数字验证码' }]}
              />
            </ProForm>
          </>
        ) : null}

        {step === 'codes' ? (
          <>
            <Alert
              className="mb-5"
              message="恢复码仅显示一次"
              description="请保存到受控密码管理器。每个恢复码只能使用一次。"
              showIcon
              type="warning"
            />
            <Input.TextArea
              autoSize={{ minRows: 10, maxRows: 12 }}
              readOnly
              value={recoveryCodes.join('\n')}
            />
            <Button
              className="mt-3"
              icon={<CopyOutlined />}
              onClick={() => void copy(recoveryCodes.join('\n'), '恢复码已复制')}
            >
              复制全部恢复码
            </Button>
            <Checkbox
              checked={acknowledged}
              className="my-5 block"
              onChange={(event) => setAcknowledged(event.target.checked)}
            >
              我已将恢复码保存到安全位置
            </Checkbox>
            <Button
              block
              disabled={!acknowledged}
              onClick={() => void auth.refresh()}
              size="large"
              type="primary"
            >
              进入管理控制面
            </Button>
          </>
        ) : null}
      </section>
    </main>
  );
}
