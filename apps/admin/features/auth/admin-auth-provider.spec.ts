import { describe, expect, it } from 'vitest';

import { AdminApiError } from '@/lib/admin-api';

import { invalidatesAdminSession } from './admin-auth-provider';

describe('invalidatesAdminSession', () => {
  it('invalidates local auth only when the server rejects the session itself', () => {
    expect(
      invalidatesAdminSession(new AdminApiError('ADMIN_SESSION_REQUIRED', 401, 'expired')),
    ).toBe(true);
    expect(
      invalidatesAdminSession(new AdminApiError('ADMIN_AUTH_INVALID', 401, 'invalid totp')),
    ).toBe(false);
    expect(invalidatesAdminSession(new Error('network failure'))).toBe(false);
  });
});
