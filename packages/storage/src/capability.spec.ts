import { describe, expect, it, vi } from 'vitest';

import {
  StorageCapabilityCodec,
  StorageCapabilityError,
  storageObjectKeyDigest,
} from './capability.js';

const codec = new StorageCapabilityCodec(Buffer.alloc(32, 7).toString('base64url'));
const capability = {
  version: 1 as const,
  purpose: 'upload' as const,
  userId: '00000000-0000-4000-8000-000000000001',
  resourceType: 'upload' as const,
  resourceId: '00000000-0000-4000-8000-000000000002',
  variant: 'content' as const,
  objectKeyDigest: storageObjectKeyDigest('assets/00/id/original'),
  maxBytes: 1024,
};

describe('StorageCapabilityCodec', () => {
  it('binds purpose, resource, user, variant, object key and expiry', () => {
    const token = codec.issue({ ...capability, expiresAt: Math.floor(Date.now() / 1000) + 60 });
    expect(codec.verify(token, capability)).toMatchObject(capability);
    expect(() => codec.verify(token, { ...capability, userId: crypto.randomUUID() })).toThrow(
      StorageCapabilityError,
    );
    expect(() =>
      codec.verify(token, {
        ...capability,
        objectKeyDigest: storageObjectKeyDigest('assets/00/id/replacement'),
      }),
    ).toThrow(StorageCapabilityError);
  });

  it('rejects tampering and expiry', () => {
    const token = codec.issue({ ...capability, expiresAt: Math.floor(Date.now() / 1000) + 60 });
    expect(() => codec.verify(`${token}x`, capability)).toThrow(StorageCapabilityError);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));
    const expired = codec.issue({ ...capability, expiresAt: Math.floor(Date.now() / 1000) });
    vi.advanceTimersByTime(1000);
    expect(() => codec.verify(expired, capability)).toThrow(StorageCapabilityError);
    vi.useRealTimers();
  });
});
