type AppliedMigration = { hash: string; createdAt: string };
type FileMigration = { hash: string; folderMillis: number };

/** A behind database must be an exact prefix; drift is never repaired or silently bypassed. */
export function isTestDatabaseMigrationHead(
  applied: readonly AppliedMigration[],
  expected: readonly FileMigration[],
): boolean {
  if (
    applied.length > expected.length ||
    applied.some(
      (row, index) =>
        row.hash !== expected[index]?.hash ||
        row.createdAt !== String(expected[index]?.folderMillis),
    )
  ) {
    throw new Error('TEST_DATABASE_MIGRATION_DRIFT');
  }
  return applied.length === expected.length;
}
