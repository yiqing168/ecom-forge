import { describe, expect, it } from 'vitest';

import { AdminApiError } from '@/lib/admin-api';

import { adminMfaErrorMessage } from './admin-login-errors';

describe('admin MFA error messages', () => {
  it('explains a unified auth failure using the active MFA method', () => {
    const cause = new AdminApiError('ADMIN_AUTH_INVALID', 401, 'invalid');

    expect(adminMfaErrorMessage(cause, 'totp')).toContain('动态验证码错误');
    expect(adminMfaErrorMessage(cause, 'recovery')).toContain('恢复码错误');
  });
});
