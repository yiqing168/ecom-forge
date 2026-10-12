import { createHash } from 'node:crypto';

export function advisoryLockKey(canonicalScope: string): bigint {
  if (!canonicalScope.trim()) throw new Error('Advisory lock scope must not be empty');
  const digest = createHash('sha256').update(canonicalScope, 'utf8').digest();
  return digest.readBigInt64BE(0);
}

export function scopedAdvisoryLockKey(scopeType: string, scopeId: string): bigint {
  const normalizedType = scopeType.trim();
  const normalizedId = scopeId.trim().toLowerCase();
  if (!normalizedType || !normalizedId) {
    throw new Error('Advisory lock scope type and ID must not be empty');
  }
  return advisoryLockKey(`${normalizedType}:${normalizedId}`);
}
