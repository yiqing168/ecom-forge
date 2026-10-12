import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type StorageCapabilityPurpose = 'upload' | 'preview' | 'download';

export interface StorageCapability {
  version: 1;
  purpose: StorageCapabilityPurpose;
  userId: string;
  resourceType: 'upload' | 'asset' | 'artifact';
  resourceId: string;
  variant: 'content' | 'original' | 'thumbnail';
  objectKeyDigest: string;
  expiresAt: number;
  maxBytes?: number;
}

export class StorageCapabilityError extends Error {
  constructor() {
    super('STORAGE_CAPABILITY_INVALID');
    this.name = 'StorageCapabilityError';
  }
}

function signature(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

export function storageObjectKeyDigest(objectKey: string): string {
  return createHash('sha256').update(objectKey, 'utf8').digest('hex');
}

function isCapability(value: unknown): value is StorageCapability {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort().join(',');
  const expectedKeys =
    item.maxBytes === undefined
      ? 'expiresAt,objectKeyDigest,purpose,resourceId,resourceType,userId,variant,version'
      : 'expiresAt,maxBytes,objectKeyDigest,purpose,resourceId,resourceType,userId,variant,version';
  return (
    keys === expectedKeys &&
    item.version === 1 &&
    ['upload', 'preview', 'download'].includes(String(item.purpose)) &&
    ['upload', 'asset', 'artifact'].includes(String(item.resourceType)) &&
    ['content', 'original', 'thumbnail'].includes(String(item.variant)) &&
    typeof item.userId === 'string' &&
    typeof item.resourceId === 'string' &&
    typeof item.objectKeyDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(item.objectKeyDigest) &&
    Number.isSafeInteger(item.expiresAt) &&
    (item.maxBytes === undefined ||
      (Number.isSafeInteger(item.maxBytes) && Number(item.maxBytes) > 0))
  );
}

export class StorageCapabilityCodec {
  constructor(private readonly secret: string) {}

  issue(capability: StorageCapability): string {
    const body = Buffer.from(JSON.stringify(capability), 'utf8').toString('base64url');
    return `${body}.${signature(this.secret, body).toString('base64url')}`;
  }

  verify(token: string, expected: Omit<StorageCapability, 'expiresAt'>): StorageCapability {
    const parsed = this.decode(token);
    for (const [key, value] of Object.entries(expected)) {
      if (parsed[key as keyof StorageCapability] !== value) throw new StorageCapabilityError();
    }
    return parsed;
  }

  decode(token: string): StorageCapability {
    try {
      const [body, suppliedText, extra] = token.split('.');
      if (!body || !suppliedText || extra !== undefined) throw new StorageCapabilityError();
      const supplied = Buffer.from(suppliedText, 'base64url');
      const expectedSignature = signature(this.secret, body);
      if (
        supplied.length !== expectedSignature.length ||
        !timingSafeEqual(supplied, expectedSignature)
      ) {
        throw new StorageCapabilityError();
      }
      const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!isCapability(parsed) || parsed.expiresAt < Math.floor(Date.now() / 1000)) {
        throw new StorageCapabilityError();
      }
      return parsed;
    } catch (error) {
      if (error instanceof StorageCapabilityError) throw error;
      throw new StorageCapabilityError();
    }
  }
}
