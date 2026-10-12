'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Dialog } from '@/components/ui/dialog';
import {
  AuthApiError,
  type AuthUserResponse,
  confirmPasswordReset,
  login,
  register,
  requestEmailVerification,
  requestPasswordReset,
  verifyEmail,
} from '@/lib/auth-api';
import { AuthDialogForm, type AuthMode, type VerifyPurpose } from './auth-dialog-form';

type AuthDialogProps = {
  onOpenChange: (open: boolean) => void;
  onSuccess: (result: AuthUserResponse) => void;
  open: boolean;
};

const PENDING_REGISTRATION_KEY = 'ecom-forge-pending-registration-verification';

type PendingRegistration = {
  email: string;
  expiresAt: number;
  ticket: string;
};

function readPendingRegistration(): PendingRegistration | null {
  const value = window.sessionStorage.getItem(PENDING_REGISTRATION_KEY);
  if (!value) return null;
  try {
    const pending = JSON.parse(value) as Partial<PendingRegistration>;
    if (
      typeof pending.email === 'string' &&
      typeof pending.ticket === 'string' &&
      typeof pending.expiresAt === 'number' &&
      pending.expiresAt > Date.now()
    ) {
      return pending as PendingRegistration;
    }
  } catch {
    // Invalid browser state is discarded below.
  }
  window.sessionStorage.removeItem(PENDING_REGISTRATION_KEY);
  return null;
}

function writePendingRegistration(pending: PendingRegistration): void {
  window.sessionStorage.setItem(PENDING_REGISTRATION_KEY, JSON.stringify(pending));
}

export function AuthDialog({ onOpenChange, onSuccess, open }: AuthDialogProps) {
  const registrationAttempt = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const resendAttempt = useRef<{ idempotencyKey: string; ticket: string } | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [mode, setMode] = useState<AuthMode>('login');
  const [notice, setNotice] = useState('');
  const [password, setPassword] = useState('');
  const [resendSeconds, setResendSeconds] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [verificationTicket, setVerificationTicket] = useState('');
  const [verifyPurpose, setVerifyPurpose] = useState<VerifyPurpose>('register');

  function changeMode(next: AuthMode) {
    setError('');
    setNotice('');
    setMode(next);
  }

  function validateEmail() {
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError('请输入有效邮箱地址');
      return false;
    }
    return true;
  }

  useEffect(() => {
    if (resendSeconds <= 0) return undefined;
    const timer = window.setInterval(() => {
      setResendSeconds((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  useEffect(() => {
    if (!open) return;
    const pending = readPendingRegistration();
    if (!pending) return;
    setEmail(pending.email);
    setVerificationTicket(pending.ticket);
    setVerifyPurpose('register');
    setMode('verify');
  }, [open]);

  function showRequestError(error: unknown) {
    setNotice('');
    setError(error instanceof AuthApiError ? error.message : '无法连接认证服务，请检查网络后重试');
  }

  async function handleResend() {
    if (submitting || resendSeconds > 0) return;
    setSubmitting(true);
    try {
      if (verifyPurpose === 'register') {
        const attempt =
          resendAttempt.current?.ticket === verificationTicket
            ? resendAttempt.current
            : {
                idempotencyKey: `verification-resend-${crypto.randomUUID()}`,
                ticket: verificationTicket,
              };
        resendAttempt.current = attempt;
        const result = await requestEmailVerification(verificationTicket, attempt.idempotencyKey);
        resendAttempt.current = null;
        setVerificationTicket(result.verification_ticket);
        writePendingRegistration({
          email,
          expiresAt: Date.now() + result.expires_in_seconds * 1000,
          ticket: result.verification_ticket,
        });
      } else {
        await requestPasswordReset(email);
      }
      setResendSeconds(60);
      setError('');
      setNotice(
        verifyPurpose === 'register'
          ? '验证码已重新发送'
          : '如果该邮箱可用于找回，验证码将重新发送',
      );
    } catch (requestError) {
      if (
        requestError instanceof AuthApiError &&
        requestError.code !== 'AUTH_TEMPORARILY_UNAVAILABLE'
      ) {
        resendAttempt.current = null;
      }
      showRequestError(requestError);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === 'verify') {
      if (!/^\d{6}$/.test(code)) {
        setError('请输入 6 位验证码');
        return;
      }
      if (verifyPurpose === 'reset' && password.length < 8) {
        setError('新密码至少需要 8 位');
        return;
      }
      setSubmitting(true);
      try {
        if (verifyPurpose === 'register') {
          const result = await verifyEmail(verificationTicket, code);
          window.sessionStorage.removeItem(PENDING_REGISTRATION_KEY);
          setCode('');
          setPassword('');
          setVerificationTicket('');
          setError('');
          setNotice('');
          onSuccess(result);
        } else {
          await confirmPasswordReset(email, code, password);
          setCode('');
          setPassword('');
          changeMode('login');
          setNotice('密码已重置，请使用新密码登录');
        }
      } catch (requestError) {
        showRequestError(requestError);
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (!validateEmail()) return;
    if (mode === 'forgot') {
      setSubmitting(true);
      try {
        await requestPasswordReset(email);
        setPassword('');
        setVerifyPurpose('reset');
        setResendSeconds(60);
        changeMode('verify');
      } catch (requestError) {
        showRequestError(requestError);
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (password.length < 8) {
      setError('密码至少需要 8 位');
      return;
    }
    if (mode === 'register' && inviteCode.trim().length === 0) {
      setError('请输入有效邀请码');
      return;
    }
    if (mode === 'register' && !agreed) {
      setError('请先阅读并同意用户协议与隐私政策');
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'register') {
        const fingerprint = JSON.stringify({ email, inviteCode, password });
        const attempt =
          registrationAttempt.current?.fingerprint === fingerprint
            ? registrationAttempt.current
            : {
                fingerprint,
                idempotencyKey: `register-${crypto.randomUUID()}`,
              };
        registrationAttempt.current = attempt;
        const result = await register({ email, password, inviteCode }, attempt.idempotencyKey);
        registrationAttempt.current = null;
        setVerificationTicket(result.verification_ticket);
        writePendingRegistration({
          email,
          expiresAt: Date.now() + result.expires_in_seconds * 1000,
          ticket: result.verification_ticket,
        });
        setAgreed(false);
        setInviteCode('');
        setPassword('');
        setVerifyPurpose('register');
        setResendSeconds(result.resend_cooldown_seconds);
        changeMode('verify');
      } else {
        const result = await login(email, password);
        if (!result.user.email_verified) {
          const pending = readPendingRegistration();
          if (pending?.email.toLowerCase() === result.user.email.toLowerCase()) {
            setVerificationTicket(pending.ticket);
            setVerifyPurpose('register');
            setMode('verify');
            setError('邮箱尚未验证，请输入注册验证码');
          } else {
            setError('邮箱尚未验证，请在原注册会话中完成验证');
          }
          return;
        }
        setPassword('');
        setError('');
        setNotice('');
        onSuccess(result);
      }
    } catch (requestError) {
      showRequestError(requestError);
    } finally {
      setSubmitting(false);
    }
  }

  const title =
    mode === 'login'
      ? '登录后开始创作'
      : mode === 'register'
        ? '创建内测账号'
        : mode === 'forgot'
          ? '找回密码'
          : verifyPurpose === 'register'
            ? '验证你的邮箱'
            : '确认重置身份';

  const description =
    mode === 'login'
      ? '你的指令和附件会保留。登录完成后回到这里，由你再次确认发送。'
      : mode === 'register'
        ? '使用邀请码加入内测，创作记录会同步到你的账号。'
        : mode === 'forgot'
          ? '我们会向你的邮箱发送一次性验证码。'
          : verifyPurpose === 'register'
            ? `验证码已发送至 ${email || '你的邮箱'}，10 分钟内有效。`
            : `如果该邮箱已注册并完成验证，验证码将发送至 ${email || '你的邮箱'}，10 分钟内有效。`;

  function registerFromForgot() {
    setCode('');
    setError('');
    setInviteCode('');
    setPassword('');
    setVerifyPurpose('register');
    setAgreed(false);
    changeMode('register');
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          setAgreed(false);
          setCode('');
          setInviteCode('');
          setPassword('');
          changeMode('login');
        }
      }}
      open={open}
    >
      <AuthDialogForm
        actions={{
          changeMode,
          registerFromForgot,
          resend: () => void handleResend(),
          setAgreed,
          setCode,
          setEmail,
          setInviteCode,
          setPassword,
          submit: (event) => void handleSubmit(event),
          togglePassword: () => setShowPassword((value) => !value),
        }}
        state={{
          agreed,
          code,
          description,
          email,
          error,
          inviteCode,
          mode,
          notice,
          password,
          resendSeconds,
          showPassword,
          submitting,
          title,
          verifyPurpose,
        }}
      />
    </Dialog>
  );
}
