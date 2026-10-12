import * as OTPAuth from 'otpauth';
import { describe, expect, it } from 'vitest';

import {
  createRecoveryCodes,
  createTotpSecret,
  maskAdminIdentifier,
  normalizeAdminIdentifier,
  normalizeRecoveryCode,
  SecretEnvelope,
  verifyTotp,
} from './admin-crypto.js';

const key = Buffer.alloc(32, 21).toString('base64url');

describe('Admin crypto', () => {
  it('encrypts TOTP material with authenticated encryption', () => {
    const envelope = new SecretEnvelope(`totp-v1:${key}`);
    const encrypted = envelope.encrypt('top-secret');

    expect(encrypted.ciphertext).not.toContain('top-secret');
    expect(envelope.decrypt(encrypted)).toBe('top-secret');
    expect(() =>
      envelope.decrypt({ ...encrypted, authTag: Buffer.alloc(16, 1).toString('base64url') }),
    ).toThrow();
  });

  it('accepts one RFC 6238 window and returns the consumed step', () => {
    const secret = createTotpSecret();
    const timestamp = 1_800_000_000_000;
    const code = OTPAuth.TOTP.generate({
      secret: OTPAuth.Secret.fromBase32(secret),
      timestamp,
      digits: 6,
      period: 30,
      algorithm: 'SHA1',
    });

    expect(verifyTotp(secret, code, timestamp)).toBe(Math.floor(timestamp / 30_000));
    expect(verifyTotp(secret, '00000A', timestamp)).toBeUndefined();
  });

  it('normalizes identifiers and emits non-login hints', () => {
    expect(normalizeAdminIdentifier(' Admin@Example.COM ')).toBe('admin@example.com');
    expect(maskAdminIdentifier('admin@example.com')).toBe('a***@example.com');
  });

  it('creates unique one-time recovery codes', () => {
    const codes = createRecoveryCodes();

    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((code) => /^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/.test(code))).toBe(true);
    expect(normalizeRecoveryCode(`  ${codes[0]!.toLowerCase()}  `)).toBe(codes[0]);
    expect(() => normalizeRecoveryCode('not-a-recovery-code')).toThrow();
  });
});
