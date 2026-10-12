import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedSecret {
  keyId: string;
  ciphertext: string;
  nonce: string;
  authTag: string;
}

interface EncryptionKey {
  id: string;
  secret: Buffer;
}

function decodeKeyring(serialized: string): EncryptionKey[] {
  return serialized
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(':');
      const id = entry.slice(0, separator);
      const secret = Buffer.from(entry.slice(separator + 1), 'base64url');
      if (separator <= 0 || secret.length < 32) {
        throw new Error('Invalid secret encryption keyring');
      }
      return { id, secret };
    });
}

export class SecretEnvelope {
  private readonly keys: readonly EncryptionKey[];

  constructor(serializedKeyring: string) {
    this.keys = decodeKeyring(serializedKeyring);
    if (
      this.keys.length === 0 ||
      new Set(this.keys.map((key) => key.id)).size !== this.keys.length
    ) {
      throw new Error('Secret encryption keyring requires unique keys');
    }
  }

  encrypt(plaintext: string): EncryptedSecret {
    const key = this.keys[0]!;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key.secret.subarray(0, 32), nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      keyId: key.id,
      ciphertext: ciphertext.toString('base64url'),
      nonce: nonce.toString('base64url'),
      authTag: cipher.getAuthTag().toString('base64url'),
    };
  }

  decrypt(input: { keyId: string; ciphertext: string; nonce: string; authTag: string }): string {
    const key = this.keys.find((candidate) => candidate.id === input.keyId);
    if (!key) throw new Error('Secret encryption key is retired');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key.secret.subarray(0, 32),
      Buffer.from(input.nonce, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(input.authTag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(input.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
