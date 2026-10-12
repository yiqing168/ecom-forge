import { randomBytes, timingSafeEqual } from 'node:crypto';

import * as OTPAuth from 'otpauth';
import { SecretEnvelope } from '@ecom-forge/shared/secret-envelope';

import type { HmacDigest, HmacKeyring } from '../auth/security/hmac-keyring.js';

export { SecretEnvelope };

export function normalizeAdminIdentifier(value: string): string {
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  if (!normalized || normalized.length > 320 || /[\r\n\0]/.test(normalized)) {
    throw new Error('Invalid Admin identifier');
  }
  return normalized;
}

export function maskAdminIdentifier(identifier: string): string {
  const at = identifier.indexOf('@');
  if (at <= 0 || at === identifier.length - 1) {
    return `${identifier.slice(0, 1)}***`;
  }
  const local = identifier.slice(0, at);
  const domain = identifier.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

export function createTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

function totp(secret: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: 'Ecom Forge Admin',
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

export function totpProvisioningUri(secret: string, label: string): string {
  return totp(secret, label).toString();
}

export function verifyTotp(secret: string, code: string, nowMs = Date.now()): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const currentStep = Math.floor(nowMs / 1_000 / 30);
  const expected = Buffer.from(code, 'ascii');
  for (const offset of [-1, 0, 1]) {
    const step = currentStep + offset;
    const value = totp(secret, 'admin').generate({ timestamp: step * 30_000 });
    const candidate = Buffer.from(value, 'ascii');
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return step;
    }
  }
  return undefined;
}

export function hashRecoveryCode(keyring: HmacKeyring, code: string): HmacDigest {
  return keyring.digest(normalizeRecoveryCode(code));
}

export function normalizeRecoveryCode(code: string): string {
  const normalized = code.normalize('NFKC').trim().toUpperCase();
  if (!/^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/.test(normalized)) {
    throw new Error('Invalid recovery code');
  }
  return normalized;
}

export function createRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () =>
    randomBytes(8)
      .toString('hex')
      .toUpperCase()
      .match(/.{1,4}/g)!
      .join('-'),
  );
}
