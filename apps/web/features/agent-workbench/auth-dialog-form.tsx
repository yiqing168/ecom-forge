'use client';

import { ArrowLeft, CheckCircle2, Eye, EyeOff, KeyRound, Mail, ShieldCheck } from 'lucide-react';
import type { FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export type AuthMode = 'forgot' | 'login' | 'register' | 'verify';
export type VerifyPurpose = 'register' | 'reset';

type AuthDialogFormState = {
  agreed: boolean;
  code: string;
  description: string;
  email: string;
  error: string;
  inviteCode: string;
  mode: AuthMode;
  notice: string;
  password: string;
  resendSeconds: number;
  showPassword: boolean;
  submitting: boolean;
  title: string;
  verifyPurpose: VerifyPurpose;
};

type AuthDialogFormActions = {
  changeMode: (mode: AuthMode) => void;
  registerFromForgot: () => void;
  setAgreed: (agreed: boolean) => void;
  setCode: (code: string) => void;
  setEmail: (email: string) => void;
  setInviteCode: (inviteCode: string) => void;
  setPassword: (password: string) => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
  resend: () => void;
  togglePassword: () => void;
};

export function AuthDialogForm({
  actions,
  state,
}: {
  actions: AuthDialogFormActions;
  state: AuthDialogFormState;
}) {
  return (
    <DialogContent>
      <div className="mb-5 flex items-center gap-3">
        {state.mode !== 'login' ? (
          <button
            aria-label="返回登录"
            className="grid size-11 place-items-center rounded-[7px] border border-[var(--border)] bg-white text-[var(--muted-foreground)] hover:bg-[var(--soft)]"
            onClick={() => actions.changeMode('login')}
            type="button"
          >
            <ArrowLeft aria-hidden="true" size={19} />
          </button>
        ) : null}
        <span className="grid size-11 place-items-center rounded-[7px] bg-[var(--primary-soft)] text-[var(--primary)]">
          {state.mode === 'verify' ? (
            <CheckCircle2 aria-hidden="true" size={22} />
          ) : state.mode === 'forgot' ? (
            <KeyRound aria-hidden="true" size={22} />
          ) : (
            <ShieldCheck aria-hidden="true" size={22} />
          )}
        </span>
      </div>
      <DialogTitle className="text-[24px] font-bold text-[var(--foreground)]">
        {state.title}
      </DialogTitle>
      <DialogDescription className="mt-2 text-[15px] leading-6 text-[var(--muted-foreground)]">
        {state.description}
      </DialogDescription>

      <form className="mt-6 space-y-4" noValidate onSubmit={actions.submit}>
        {state.mode === 'verify' ? (
          <div>
            <label className="mb-1.5 block text-sm font-semibold" htmlFor="auth-code">
              邮箱验证码
            </label>
            <div className="flex gap-2">
              <Input
                autoComplete="one-time-code"
                className="h-12 text-center text-lg font-semibold tabular-nums"
                id="auth-code"
                inputMode="numeric"
                maxLength={6}
                onChange={(event) => actions.setCode(event.target.value.replace(/\D/g, ''))}
                placeholder="6 位数字"
                value={state.code}
              />
              <Button
                className="shrink-0"
                disabled={state.submitting || state.resendSeconds > 0}
                onClick={actions.resend}
                type="button"
                variant="outline"
              >
                {state.resendSeconds > 0 ? `重新发送 (${state.resendSeconds}s)` : '重新发送'}
              </Button>
            </div>
            {state.verifyPurpose === 'reset' ? (
              <div className="mt-3">
                <label className="mb-1.5 block text-sm font-semibold" htmlFor="reset-password">
                  新密码
                </label>
                <Input
                  autoComplete="new-password"
                  id="reset-password"
                  onChange={(event) => actions.setPassword(event.target.value)}
                  placeholder="不少于 8 位"
                  type={state.showPassword ? 'text' : 'password'}
                  value={state.password}
                />
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div>
              <label className="mb-1.5 block text-sm font-semibold" htmlFor="auth-email">
                邮箱
              </label>
              <span className="relative block">
                <Mail
                  aria-hidden="true"
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--subtle-foreground)]"
                  size={18}
                />
                <Input
                  autoComplete="email"
                  className="h-12 pl-11"
                  id="auth-email"
                  onChange={(event) => actions.setEmail(event.target.value)}
                  placeholder="name@example.com"
                  type="email"
                  value={state.email}
                />
              </span>
            </div>

            {state.mode !== 'forgot' ? (
              <div>
                <div className="mb-1.5 flex items-center justify-between text-sm font-semibold">
                  <label htmlFor="auth-password">密码</label>
                  {state.mode === 'login' ? (
                    <button
                      className="font-normal text-[var(--primary)] hover:underline"
                      onClick={() => actions.changeMode('forgot')}
                      type="button"
                    >
                      忘记密码？
                    </button>
                  ) : null}
                </div>
                <span className="relative block">
                  <Input
                    autoComplete={state.mode === 'register' ? 'new-password' : 'current-password'}
                    className="h-12 pr-11"
                    id="auth-password"
                    onChange={(event) => actions.setPassword(event.target.value)}
                    placeholder="不少于 8 位"
                    type={state.showPassword ? 'text' : 'password'}
                    value={state.password}
                  />
                  <button
                    aria-label={state.showPassword ? '隐藏密码' : '显示密码'}
                    className="absolute right-1 top-1 grid size-10 place-items-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--soft)]"
                    onClick={actions.togglePassword}
                    type="button"
                  >
                    {state.showPassword ? (
                      <EyeOff aria-hidden="true" size={18} />
                    ) : (
                      <Eye aria-hidden="true" size={18} />
                    )}
                  </button>
                </span>
              </div>
            ) : null}

            {state.mode === 'register' ? (
              <div>
                <label className="mb-1.5 block text-sm font-semibold" htmlFor="invite-code">
                  邀请码
                </label>
                <Input
                  className="h-12"
                  id="invite-code"
                  onChange={(event) => actions.setInviteCode(event.target.value)}
                  placeholder="输入内测邀请码"
                  value={state.inviteCode}
                />
              </div>
            ) : null}

            {state.mode === 'register' ? (
              <label className="flex cursor-pointer items-start gap-2.5 text-[13px] leading-5 text-[var(--muted-foreground)]">
                <Checkbox
                  checked={state.agreed}
                  className="mt-0.5"
                  onCheckedChange={(checked) => actions.setAgreed(checked === true)}
                />
                <span>我已阅读并同意用户协议与隐私政策</span>
              </label>
            ) : null}
          </>
        )}

        <div
          aria-live="polite"
          className={`min-h-5 text-[13px] font-medium ${state.error ? 'text-[var(--danger)]' : 'text-[var(--primary)]'}`}
        >
          {state.error || state.notice}
        </div>

        <Button className="w-full" disabled={state.submitting} size="lg" type="submit">
          {state.mode === 'login'
            ? '登录并继续'
            : state.mode === 'register'
              ? '注册并发送验证码'
              : state.mode === 'forgot'
                ? '发送验证码'
                : '完成验证'}
        </Button>
        {state.mode === 'forgot' ? (
          <button
            className="block w-full text-center text-sm font-medium text-[var(--primary)] hover:underline"
            onClick={actions.registerFromForgot}
            type="button"
          >
            还没有账号？去注册
          </button>
        ) : null}
        {state.mode === 'login' ? (
          <Button
            className="w-full"
            onClick={() => actions.changeMode('register')}
            size="lg"
            type="button"
            variant="outline"
          >
            注册账号
          </Button>
        ) : null}
      </form>

      {state.mode === 'login' ? (
        <p className="mt-4 text-center text-xs text-[var(--subtle-foreground)]">
          内测注册需邀请码或白名单邮箱
        </p>
      ) : null}
    </DialogContent>
  );
}
