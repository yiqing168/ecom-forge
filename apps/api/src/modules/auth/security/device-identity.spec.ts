import { DeviceIdentity } from './device-identity.js';
import { HmacKeyring } from './hmac-keyring.js';

const keys = new HmacKeyring(`device-v1:${Buffer.alloc(32, 19).toString('base64url')}`);

describe('DeviceIdentity', () => {
  it('issues a signed HttpOnly cookie and reuses it', () => {
    const identity = new DeviceIdentity(keys, true);
    const append = vi.fn();
    const first = identity.resolve({ headers: {} }, { append });
    expect(append).toHaveBeenCalledWith(
      'set-cookie',
      expect.stringContaining('HttpOnly; SameSite=Lax; Secure'),
    );

    const reusedAppend = vi.fn();
    const reused = identity.resolve(
      { headers: { cookie: `other=1; ef_device=${first}` } },
      { append: reusedAppend },
    );
    expect(reused).toBe(first);
    expect(reusedAppend).not.toHaveBeenCalled();
  });

  it('replaces a forged cookie instead of trusting client input', () => {
    const identity = new DeviceIdentity(keys, false);
    const append = vi.fn();
    const resolved = identity.resolve(
      { headers: { cookie: 'ef_device=forged.device.value' } },
      { append },
    );
    expect(resolved).not.toBe('forged.device.value');
    expect(append).toHaveBeenCalledWith('set-cookie', expect.not.stringContaining('Secure'));
  });

  it('ignores unrelated and malformed cookie headers', () => {
    const identity = new DeviceIdentity(keys, false);
    const append = vi.fn();
    expect(() =>
      identity.resolve({ headers: { cookie: ['a=1', 'b=2'] } }, { append }),
    ).not.toThrow();
    expect(append).toHaveBeenCalledOnce();
  });
});
