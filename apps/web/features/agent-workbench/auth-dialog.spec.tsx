import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-api', () => ({
  AuthApiError: class AuthApiError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
  confirmPasswordReset: vi.fn(),
  login: vi.fn(),
  register: vi.fn().mockResolvedValue({
    verification_ticket: 'ticket-for-test',
    email: 'r***@example.com',
    expires_in_seconds: 600,
    resend_cooldown_seconds: 60,
  }),
  requestEmailVerification: vi.fn(),
  requestPasswordReset: vi.fn(),
  verifyEmail: vi.fn(),
}));

import { AuthDialog } from './auth-dialog';
import {
  AuthApiError,
  confirmPasswordReset,
  login,
  register,
  requestEmailVerification,
  requestPasswordReset,
} from '@/lib/auth-api';

const registrationResponse = {
  verification_ticket: 'ticket-for-test',
  email: 'r***@example.com',
  expires_in_seconds: 600,
  resend_cooldown_seconds: 60,
};

beforeEach(() => {
  vi.mocked(register).mockReset().mockResolvedValue(registrationResponse);
  vi.mocked(requestEmailVerification).mockReset();
  vi.mocked(requestPasswordReset).mockReset();
  vi.mocked(confirmPasswordReset).mockReset();
  vi.mocked(login).mockReset();
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe('AuthDialog', () => {
  it('keeps invalid login errors next to the form and does not authenticate', () => {
    const onSuccess = vi.fn();
    render(<AuthDialog onOpenChange={vi.fn()} onSuccess={onSuccess} open />);

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'invalid' } });
    fireEvent.click(screen.getByRole('button', { name: '登录并继续' }));

    expect(screen.getByText('请输入有效邮箱地址')).toBeTruthy();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('moves registration into the in-dialog verification state after the API accepts it', async () => {
    render(<AuthDialog onOpenChange={vi.fn()} onSuccess={vi.fn()} open />);

    fireEvent.click(screen.getByRole('button', { name: '注册账号' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'review@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'review123' } });
    fireEvent.change(screen.getByLabelText('邀请码'), { target: { value: 'BETA2026' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '注册并发送验证码' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: '验证你的邮箱' })).toBeTruthy());
    expect(screen.getByLabelText('邮箱验证码')).toBeTruthy();
  });

  it('preserves the case of generated invitation codes', async () => {
    render(<AuthDialog onOpenChange={vi.fn()} onSuccess={vi.fn()} open />);

    fireEvent.click(screen.getByRole('button', { name: '注册账号' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'review@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'review123' } });
    fireEvent.change(screen.getByLabelText('邀请码'), { target: { value: 'Abc_def-123' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '注册并发送验证码' }));

    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(vi.mocked(register).mock.calls[0]?.[0].inviteCode).toBe('Abc_def-123');
  });

  it('reuses the registration idempotency key after a lost network response', async () => {
    vi.mocked(register)
      .mockRejectedValueOnce(new TypeError('network response lost'))
      .mockResolvedValueOnce(registrationResponse);
    render(<AuthDialog onOpenChange={vi.fn()} onSuccess={vi.fn()} open />);

    fireEvent.click(screen.getByRole('button', { name: '注册账号' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'retry@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'review123' } });
    fireEvent.change(screen.getByLabelText('邀请码'), { target: { value: 'BETA2026' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '注册并发送验证码' }));
    await waitFor(() =>
      expect(screen.getByText('无法连接认证服务，请检查网络后重试')).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: '注册并发送验证码' }));
    await waitFor(() => expect(register).toHaveBeenCalledTimes(2));

    expect(vi.mocked(register).mock.calls[0]?.[1]).toBe(vi.mocked(register).mock.calls[1]?.[1]);
  });

  it('reuses the resend idempotency key after a lost network response', async () => {
    window.sessionStorage.setItem(
      'ecom-forge-pending-registration-verification',
      JSON.stringify({
        email: 'retry@example.com',
        expiresAt: Date.now() + 600_000,
        ticket: 'ticket-before-retry',
      }),
    );
    vi.mocked(requestEmailVerification)
      .mockRejectedValueOnce(new TypeError('network response lost'))
      .mockResolvedValueOnce({
        verification_ticket: 'ticket-after-retry',
        expires_in_seconds: 600,
        resend_cooldown_seconds: 60,
      });
    render(<AuthDialog onOpenChange={vi.fn()} onSuccess={vi.fn()} open />);

    await waitFor(() => expect(screen.getByRole('heading', { name: '验证你的邮箱' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '重新发送' }));
    await waitFor(() =>
      expect(screen.getByText('无法连接认证服务，请检查网络后重试')).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: '重新发送' }));
    await waitFor(() => expect(requestEmailVerification).toHaveBeenCalledTimes(2));

    expect(vi.mocked(requestEmailVerification).mock.calls[0]?.[1]).toBe(
      vi.mocked(requestEmailVerification).mock.calls[1]?.[1],
    );
  });

  it('keeps an unverified login in the dialog instead of granting creation access', async () => {
    vi.mocked(login).mockResolvedValueOnce({
      access: {
        can_create: false,
        can_upload: false,
        can_charge: false,
        restriction_reason: 'email_verification_required',
      },
      user: {
        id: 'user-1',
        email: 'review@example.com',
        display_name: 'Review user',
        email_verified: false,
      },
    });
    const onSuccess = vi.fn();
    render(<AuthDialog onOpenChange={vi.fn()} onSuccess={onSuccess} open />);

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'review@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'review123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录并继续' }));

    await waitFor(() =>
      expect(screen.getByText('邮箱尚未验证，请在原注册会话中完成验证')).toBeTruthy(),
    );
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('shows the actionable safe message returned by the authentication API', async () => {
    vi.mocked(register).mockRejectedValueOnce(
      new AuthApiError(
        'REGISTRATION_NOT_ELIGIBLE',
        403,
        '当前无法完成注册，请检查邀请码和邮箱是否正确',
      ),
    );
    render(<AuthDialog onOpenChange={vi.fn()} onSuccess={vi.fn()} open />);

    fireEvent.click(screen.getByRole('button', { name: '注册账号' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'review@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'review123' } });
    fireEvent.change(screen.getByLabelText('邀请码'), { target: { value: 'INVALID' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '注册并发送验证码' }));

    await waitFor(() =>
      expect(screen.getByText('当前无法完成注册，请检查邀请码和邮箱是否正确')).toBeTruthy(),
    );
  });

  it('returns to login after password reset without creating a fake session', async () => {
    vi.mocked(requestPasswordReset).mockResolvedValueOnce({ status: 'accepted' });
    vi.mocked(confirmPasswordReset).mockResolvedValueOnce({ status: 'reset' });
    const onSuccess = vi.fn();
    render(<AuthDialog onOpenChange={vi.fn()} onSuccess={onSuccess} open />);

    fireEvent.click(screen.getByRole('button', { name: '忘记密码？' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'review@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '确认重置身份' })).toBeTruthy());

    fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-password-123' } });
    fireEvent.click(screen.getByRole('button', { name: '完成验证' }));

    await waitFor(() => expect(screen.getByText('密码已重置，请使用新密码登录')).toBeTruthy());
    expect(screen.getByRole('button', { name: '登录并继续' })).toBeTruthy();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('offers registration from the password reset form', () => {
    render(<AuthDialog onOpenChange={vi.fn()} onSuccess={vi.fn()} open />);

    fireEvent.click(screen.getByRole('button', { name: '忘记密码？' }));
    fireEvent.click(screen.getByRole('button', { name: '还没有账号？去注册' }));

    expect(screen.getByRole('heading', { name: '创建内测账号' })).toBeTruthy();
    expect(screen.getByLabelText('邀请码')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '还没有账号？去注册' })).toBeNull();
  });
});
