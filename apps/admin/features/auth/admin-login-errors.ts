import { AdminApiError, adminErrorMessage } from '@/lib/admin-api';

export function adminMfaErrorMessage(cause: unknown, method: 'totp' | 'recovery'): string {
  if (
    cause instanceof AdminApiError &&
    ['ADMIN_AUTH_INVALID', 'ADMIN_MFA_INVALID', 'ADMIN_TOTP_INVALID'].includes(cause.code)
  ) {
    return method === 'totp'
      ? '动态验证码错误、已使用或已失效，请输入认证器中的当前验证码'
      : '恢复码错误、已使用或已失效，请换一枚尚未使用的恢复码';
  }
  return adminErrorMessage(cause);
}
