import { spawnSync } from 'node:child_process';

import {
  provisionValidationTestDatabase,
  requirePnpmCli,
  resolveTestDatabaseUrl,
} from '../validation/lib/test-database.mjs';

/**
 * API test entrypoint (`pnpm --filter @ecom-forge/api test`).
 *
 * The API e2e suite is database-backed, so like the worker integration entrypoint it guarantees a
 * database migrated to the current head before Vitest starts: a stale default database surfaces as
 * a transparently provisioned, stably named sibling database instead of a deep SQL error mid-run.
 * Nothing is dropped automatically.
 *
 * `S14_TEST_DATABASE_URL` is provisioned through the same harness so the admin suite cannot run
 * against a stale schema either. Extra CLI arguments are forwarded verbatim to Vitest.
 */

const pnpmCli = requirePnpmCli('api tests');
const baseUrl = resolveTestDatabaseUrl('api tests');
const { url: testDatabaseUrl } = provisionValidationTestDatabase({ pnpmCli, baseUrl });

const s14Fallback =
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test_s14_gate';
const s14BaseUrl = process.env.S14_TEST_DATABASE_URL?.trim() || s14Fallback;
const { url: s14TestDatabaseUrl } = provisionValidationTestDatabase({
  pnpmCli,
  baseUrl: resolveTestDatabaseUrl('s14 api tests', {
    TEST_DATABASE_URL: s14BaseUrl,
  }),
});

const env = {
  ...process.env,
  TEST_DATABASE_URL: testDatabaseUrl,
  S14_TEST_DATABASE_URL: s14TestDatabaseUrl,
};

const result = spawnSync(
  process.execPath,
  [
    pnpmCli,
    '--filter',
    '@ecom-forge/api',
    'exec',
    'vitest',
    'run',
    '--passWithNoTests',
    // Forward the caller's filters (e.g. `test` for the e2e directory) verbatim to Vitest.
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit', env },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
