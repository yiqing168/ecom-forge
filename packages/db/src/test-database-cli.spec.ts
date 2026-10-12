import { describe, expect, it } from 'vitest';

import {
  deriveProvisionedDatabaseName,
  isIsolatedTestDatabaseName,
  isProvisionedDatabaseName,
  sanitizeDatabaseIdentifier,
} from './test-database-names.js';

describe('sanitizeDatabaseIdentifier', () => {
  it('lowercases and replaces characters outside [a-z0-9_]', () => {
    expect(sanitizeDatabaseIdentifier('Ecom-Forge Test')).toBe('ecom_forge_test');
  });
});

describe('deriveProvisionedDatabaseName', () => {
  it('appends the stable provisioning suffix to a configured _test database', () => {
    expect(deriveProvisionedDatabaseName('ecom_forge_test')).toBe('ecom_forge_test_migrated');
  });

  it('is idempotent for a name that already carries the suffix', () => {
    expect(deriveProvisionedDatabaseName('ecom_forge_test_migrated')).toBe(
      'ecom_forge_test_migrated',
    );
  });

  it('sanitizes before deriving', () => {
    expect(deriveProvisionedDatabaseName('Ecom-Forge Test')).toBe('ecom_forge_test_migrated');
  });

  it('truncates a long base name while preserving the suffix within the 63-char budget', () => {
    const base = `${'x'.repeat(60)}_test`;
    const derived = deriveProvisionedDatabaseName(base);
    expect(derived.endsWith('_migrated')).toBe(true);
    expect(derived.length).toBeLessThanOrEqual(63);
    expect(derived).toBe(`${base.slice(0, 54)}_migrated`);
  });

  it('can drop the _test marker when truncating, so the derived name fails the secondary guard', () => {
    // `_test` sits beyond the truncation window, so the derived name no longer satisfies the guard
    // the CLI re-checks before creating the database.
    const base = `${'a'.repeat(60)}_test`;
    const derived = deriveProvisionedDatabaseName(base);
    expect(derived.includes('_test')).toBe(false);
    expect(isIsolatedTestDatabaseName(derived)).toBe(false);
  });
});

describe('isIsolatedTestDatabaseName', () => {
  it('accepts names containing a "_test" segment', () => {
    expect(isIsolatedTestDatabaseName('ecom_forge_test')).toBe(true);
    expect(isIsolatedTestDatabaseName('ecom_forge_test_migrated')).toBe(true);
    expect(isIsolatedTestDatabaseName('ecom_forge_test_s14_live')).toBe(true);
  });

  it('rejects names without a "_test" segment', () => {
    expect(isIsolatedTestDatabaseName('ecom_forge')).toBe(false);
    expect(isIsolatedTestDatabaseName('ecom_forge_testing')).toBe(false);
  });
});

describe('isProvisionedDatabaseName', () => {
  it('accepts the isolated, marker-bearing names the harness owns', () => {
    expect(isProvisionedDatabaseName('ecom_forge_test_migrated')).toBe(true);
    expect(isProvisionedDatabaseName('ecom_forge_test_migrated_20260101')).toBe(true);
  });

  it('rejects the stale base database so `drop ecom_forge_test` is refused', () => {
    expect(isProvisionedDatabaseName('ecom_forge_test')).toBe(false);
  });

  it('rejects a "_migrated" name that is not isolated', () => {
    expect(isProvisionedDatabaseName('ecom_forge_migrated')).toBe(false);
  });
});
