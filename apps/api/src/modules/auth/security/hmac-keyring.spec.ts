import { createInviteCode, createOpaqueTicket, HmacKeyring } from './hmac-keyring.js';

const oldSecret = Buffer.alloc(32, 1).toString('base64url');
const currentSecret = Buffer.alloc(32, 2).toString('base64url');

describe('HmacKeyring', () => {
  it('writes with the current key and verifies without exposing the source value', () => {
    const keyring = new HmacKeyring(`current:${currentSecret},old:${oldSecret}`);
    const digest = keyring.digest('sensitive-value');

    expect(digest.keyId).toBe('current');
    expect(digest.digest).not.toContain('sensitive-value');
    expect(keyring.verify('sensitive-value', digest)).toBe(true);
    expect(keyring.verify('different-value', digest)).toBe(false);
  });

  it('generates lookup candidates for current and valid historical keys', () => {
    const keyring = new HmacKeyring(`current:${currentSecret},old:${oldSecret}`);

    expect(keyring.candidates('invite')).toHaveLength(2);
    expect(keyring.candidates('invite').map(({ keyId }) => keyId)).toEqual(['current', 'old']);
  });

  it('creates non-enumerable invite codes and 256-bit opaque tickets', () => {
    expect(Buffer.from(createOpaqueTicket(), 'base64url')).toHaveLength(32);
    expect(Buffer.from(createInviteCode(), 'base64url')).toHaveLength(18);
    expect(createOpaqueTicket()).not.toBe(createOpaqueTicket());
  });
});
