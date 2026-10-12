import { spawnSync } from 'node:child_process';

import {
  provisionValidationTestDatabase,
  requirePnpmCli,
  resolveTestDatabaseUrl,
} from '../validation/lib/test-database.mjs';

/**
 * Database-package test entrypoint (`pnpm --filter @ecom-forge/db test`).
 *
 * The migration suites create isolated `_test` databases on the configured instance and refuse to
 * run without `TEST_DATABASE_URL`, so this entrypoint provisions a database migrated to the
 * current head and exports it (never falling back to a development or acceptance instance, and
 * never dropping anything automatically).
 */

const pnpmCli = requirePnpmCli('db tests');
const baseUrl = resolveTestDatabaseUrl('db tests');
const { url: testDatabaseUrl } = provisionValidationTestDatabase({ pnpmCli, baseUrl });

const env = { ...process.env, TEST_DATABASE_URL: testDatabaseUrl };

const result = spawnSync(
  process.execPath,
  [pnpmCli, '--filter', '@ecom-forge/db', 'exec', 'vitest', 'run', '--passWithNoTests'],
  { stdio: 'inherit', env },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
