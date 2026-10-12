/**
 * Resolve the isolated test-database URL for the migration suites.
 *
 * These suites create databases and apply the full migration chain, so they must never fall back
 * to a development or acceptance instance. A missing `TEST_DATABASE_URL` — or one whose database
 * name has no `_test` boundary — is a hard error. The packaged entrypoint
 * (`scripts/integration/run-db-tests.mjs`) provisions the variable.
 */
export function requireTestDatabaseUrl(): string {
  const configured = process.env.TEST_DATABASE_URL?.trim();
  if (!configured) {
    throw new Error(
      'Database migration suites require TEST_DATABASE_URL; run them through `pnpm --filter @ecom-forge/db test`.',
    );
  }
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(configured).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!/_test(?:_|$)/.test(databaseName.toLowerCase())) {
    throw new Error('Database migration suites refuse a database without a _test boundary');
  }
  return configured;
}
