import type { Database } from '@ecom-forge/db';

import { HmacKeyring } from './security/hmac-keyring.js';
import { AuthActivityService } from './auth-activity.service.js';

const secret = Buffer.alloc(32, 6).toString('base64url');

function createService(insertResult: Promise<unknown> = Promise.resolve(undefined)) {
  const values = vi.fn().mockReturnValue(insertResult);
  const insert = vi.fn().mockReturnValue({ values });
  return {
    insert,
    service: new AuthActivityService(
      { insert } as unknown as Database,
      new HmacKeyring(`audit-v1:${secret}`),
    ),
    values,
  };
}

describe('AuthActivityService', () => {
  it('stores only hashed source identities', async () => {
    const { service, values } = createService();

    await service.record({
      activityType: 'login',
      userId: 'f9472da6-7849-4a16-b502-922c451dbdfa',
      targetType: 'user',
      context: { ipBucket: '203.0.113.8', deviceBucket: 'device-cookie' },
    });

    const input = values.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    expect(input.metadata.ip_hash).not.toBe('203.0.113.8');
    expect(input.metadata.device_hash).not.toBe('device-cookie');
    expect(JSON.stringify(input)).not.toContain('203.0.113.8');
    expect(JSON.stringify(input)).not.toContain('device-cookie');
  });

  it('supports server-side activities without a request context', async () => {
    const { service, values } = createService();

    await service.record({
      activityType: 'email_verify',
      userId: null,
      targetType: 'registration_claim',
      metadata: { outcome: 'verified' },
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { outcome: 'verified' } }),
    );
  });

  it('does not invalidate an irreversible auth result when audit storage is unavailable', async () => {
    const { service } = createService(Promise.reject(new Error('database unavailable')));

    await expect(
      service.record({ activityType: 'password_reset', userId: null, targetType: 'user' }),
    ).resolves.toBeUndefined();
  });
});
