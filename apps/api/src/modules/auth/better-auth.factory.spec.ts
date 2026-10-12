import { getAuthTables } from 'better-auth';

import { emailVerifiedTimestampBridge } from './better-auth-bridge.js';

describe('Better Auth database contract', () => {
  it('uses the reviewed table and field mappings', () => {
    const tables = getAuthTables({
      user: {
        modelName: 'users',
        fields: { name: 'displayName', emailVerified: 'emailVerifiedAt' },
      },
      session: { modelName: 'authSessions' },
      account: { modelName: 'authAccounts' },
      verification: { modelName: 'authVerifications' },
      plugins: [emailVerifiedTimestampBridge],
    });

    expect(tables.user?.modelName).toBe('users');
    expect(tables.user?.fields.name?.fieldName).toBe('displayName');
    expect(tables.user?.fields.emailVerified?.fieldName).toBe('emailVerifiedAt');
    expect(tables.user?.fields.updatedAt?.fieldName).toBe('updatedAt');
    expect(tables.session?.modelName).toBe('authSessions');
    expect(tables.account?.modelName).toBe('authAccounts');
    expect(tables.verification?.modelName).toBe('authVerifications');
  });
});
