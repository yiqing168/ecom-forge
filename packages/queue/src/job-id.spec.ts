import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertStableJobId,
  compositeJobId,
  jobIdFromAggregateId,
  modelPocJobId,
  providerCredentialValidationJobId,
  storageCredentialValidationJobId,
} from './job-id.js';

describe('stable queue job IDs', () => {
  it('uses a persisted aggregate UUID for a single-aggregate job', () => {
    const id = randomUUID();
    expect(jobIdFromAggregateId(id.toUpperCase())).toBe(id);
  });

  it('produces the same hash for equivalent canonical objects', () => {
    const first = compositeJobId({ operation: 'build', attempt: 2, id: 'abc' });
    const second = compositeJobId({ id: 'abc', attempt: 2, operation: 'build' });
    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first).not.toContain(':');
  });

  it('rejects BullMQ job IDs containing separators outside the contract', () => {
    expect(() => assertStableJobId('task:123')).toThrow(/letters, digits/);
  });

  it('uses the frozen S14 evaluation job ID shapes', () => {
    const id = randomUUID();
    expect(providerCredentialValidationJobId(id)).toBe(`provider_credential_validate_${id}`);
    expect(storageCredentialValidationJobId(id)).toBe(`storage_credential_validate_${id}`);
    expect(modelPocJobId(id)).toBe(`model_poc_${id}`);
    expect(() => modelPocJobId('not-an-id')).toThrow(/UUID/);
  });
});
