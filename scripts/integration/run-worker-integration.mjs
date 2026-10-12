import { spawnSync } from 'node:child_process';

import {
  provisionValidationTestDatabase,
  requirePnpmCli,
  resolveTestDatabaseUrl,
} from '../validation/lib/test-database.mjs';

/**
 * Worker integration test entrypoint (`pnpm --filter @ecom-forge/worker test:integration`).
 *
 * Mirrors the zero-config validation runner: the configured test database is guaranteed to be
 * migrated to the current head before Vitest starts, so a stale fallback database surfaces as a
 * transparently provisioned, stably named sibling database instead of a deep SQL error. Nothing
 * is dropped automatically.
 *
 * Extra CLI arguments are forwarded verbatim to Vitest (for example `-t "<pattern>"`).
 */

const pnpmCli = requirePnpmCli('worker integration');
const baseUrl = resolveTestDatabaseUrl('worker integration');
const { url: testDatabaseUrl } = provisionValidationTestDatabase({ pnpmCli, baseUrl });

const env = {
  ...process.env,
  TEST_DATABASE_URL: testDatabaseUrl,
};

const forwarded = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  [
    pnpmCli,
    '--filter',
    '@ecom-forge/worker',
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.integration.config.ts',
    '--passWithNoTests',
    ...forwarded,
  ],
  { stdio: 'inherit', env },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
