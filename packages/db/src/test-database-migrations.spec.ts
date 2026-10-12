import { describe, expect, it } from 'vitest';

import { isTestDatabaseMigrationHead } from './test-database-migrations.js';

const expected = [
  { hash: 'first', folderMillis: 100 },
  { hash: 'second', folderMillis: 200 },
];
const applied = expected.map((row) => ({ hash: row.hash, createdAt: String(row.folderMillis) }));

describe('test database migration head', () => {
  it('requires the exact complete history and accepts only genuine prefixes for migration', () => {
    expect(isTestDatabaseMigrationHead([], expected)).toBe(false);
    expect(isTestDatabaseMigrationHead(applied.slice(0, 1), expected)).toBe(false);
    expect(isTestDatabaseMigrationHead(applied, expected)).toBe(true);
  });

  it.each([
    [applied[0]!, { hash: 'changed', createdAt: '200' }],
    [applied[0]!, { hash: 'second', createdAt: '201' }],
    [applied[1]!],
    [applied[1]!, applied[0]!],
    [...applied, { hash: 'unrecognized', createdAt: '300' }],
  ])('rejects mismatched hashes, timestamps, order and extra history: %j', (...rows) => {
    expect(() => isTestDatabaseMigrationHead(rows, expected)).toThrow(
      'TEST_DATABASE_MIGRATION_DRIFT',
    );
  });
});
