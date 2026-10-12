import { describe, expect, it } from 'vitest';

import { advisoryLockKey, scopedAdvisoryLockKey } from './advisory-lock.js';

describe('PostgreSQL advisory lock key derivation', () => {
  it('returns a deterministic signed 64-bit key', () => {
    expect(advisoryLockKey('workflow:00000000-0000-0000-0000-000000000001')).toBe(
      -22497184109023260n,
    );
  });

  it('normalizes persisted UUID casing but preserves scope type semantics', () => {
    const lower = scopedAdvisoryLockKey('workflow', '00000000-0000-0000-0000-00000000ABCD');
    expect(lower).toBe(scopedAdvisoryLockKey('workflow', '00000000-0000-0000-0000-00000000abcd'));
    expect(lower).not.toBe(scopedAdvisoryLockKey('task', '00000000-0000-0000-0000-00000000abcd'));
  });

  it('rejects an empty canonical scope', () => {
    expect(() => advisoryLockKey('  ')).toThrow(/must not be empty/);
  });
});
