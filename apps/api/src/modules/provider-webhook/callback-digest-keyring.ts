import { createHmac } from 'node:crypto';

interface DigestKey {
  id: string;
  secret: Buffer;
}

export interface KeyedDigest {
  keyId: string;
  digest: string;
}

function parseKey(entry: string): DigestKey {
  const separator = entry.indexOf(':');
  const id = entry.slice(0, separator).trim();
  const secret = Buffer.from(entry.slice(separator + 1).trim(), 'base64url');
  if (separator <= 0 || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) || secret.length < 32) {
    throw new Error('Provider callback digest keyring is invalid');
  }
  return { id, secret };
}

export class CallbackDigestKeyring {
  private readonly keys: readonly DigestKey[];

  constructor(serialized: string) {
    this.keys = serialized.split(',').map((entry) => parseKey(entry.trim()));
    if (
      this.keys.length === 0 ||
      new Set(this.keys.map((key) => key.id)).size !== this.keys.length
    ) {
      throw new Error('Provider callback digest keyring requires unique keys');
    }
  }

  digest(value: Buffer | string): KeyedDigest {
    return this.digestWith(this.keys[0]!, value);
  }

  candidates(value: Buffer | string): KeyedDigest[] {
    return this.keys.map((key) => this.digestWith(key, value));
  }

  private digestWith(key: DigestKey, value: Buffer | string): KeyedDigest {
    return {
      keyId: key.id,
      digest: createHmac('sha256', key.secret).update(value).digest('base64url'),
    };
  }
}
