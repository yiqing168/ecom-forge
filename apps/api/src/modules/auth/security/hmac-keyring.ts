import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface HmacDigest {
  keyId: string;
  digest: string;
}

interface HmacKey {
  id: string;
  secret: Buffer;
}

export class InvalidKeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidKeyringError';
  }
}

function parseEntry(entry: string): HmacKey {
  const separator = entry.indexOf(':');
  const id = entry.slice(0, separator).trim();
  const encodedSecret = entry.slice(separator + 1).trim();
  if (separator <= 0 || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) || !encodedSecret) {
    throw new InvalidKeyringError('Invalid keyring entry');
  }
  const secret = Buffer.from(encodedSecret, 'base64url');
  if (secret.length < 32) {
    throw new InvalidKeyringError(`Key ${id} must contain at least 32 bytes`);
  }
  return { id, secret };
}

function equalDigest(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'base64url');
  const rightBuffer = Buffer.from(right, 'base64url');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class HmacKeyring {
  private readonly keys: readonly HmacKey[];

  constructor(serialized: string) {
    const entries = serialized
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map(parseEntry);
    if (entries.length === 0 || new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      throw new InvalidKeyringError('Keyring requires unique keys');
    }
    this.keys = entries;
  }

  digest(value: string): HmacDigest {
    return this.digestWith(this.keys[0]!, value);
  }

  candidates(value: string): HmacDigest[] {
    return this.keys.map((key) => this.digestWith(key, value));
  }

  verify(value: string, expected: HmacDigest): boolean {
    const key = this.keys.find((candidate) => candidate.id === expected.keyId);
    return key ? equalDigest(this.digestWith(key, value).digest, expected.digest) : false;
  }

  matches(value: string, expectedDigest: string): boolean {
    return this.candidates(value).some((candidate) =>
      equalDigest(candidate.digest, expectedDigest),
    );
  }

  private digestWith(key: HmacKey, value: string): HmacDigest {
    return {
      keyId: key.id,
      digest: createHmac('sha256', key.secret).update(value, 'utf8').digest('base64url'),
    };
  }
}

export function createOpaqueTicket(): string {
  return randomBytes(32).toString('base64url');
}

export function createInviteCode(): string {
  return randomBytes(18).toString('base64url');
}
