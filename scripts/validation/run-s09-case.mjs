import { spawnSync } from 'node:child_process';

import { assertCaseFilesExist } from './lib/assert-case-files.mjs';
import {
  provisionValidationTestDatabase,
  requirePnpmCli,
  resolveTestDatabaseUrl,
} from './lib/test-database.mjs';

const cases = {
  'compiler-r1-r5': 'compiler R1-R5: rejects a forged candidate without financial side effects',
  'compiler-concurrency':
    'compiler concurrency: persists one quote, compiler trace, submit intent, and expiry intent',
  'compiler-cost-snapshot':
    'compiler cost snapshot: concurrently auto-submits once and replays one workflow',
};

const name = process.argv[2];
const pattern = cases[name];
if (!pattern) throw new Error(`Unknown S09 validation case: ${name ?? '<missing>'}`);
assertCaseFilesExist([
  {
    workspace: '@ecom-forge/worker',
    file: 'test/s09-compiler.integration-spec.ts',
  },
]);

const pnpmCli = requirePnpmCli('S09');
// Resolve the configured database (still enforcing the isolated "_test" naming guard) and make
// sure it is migrated to the current head before the case runs. A stale configured database is
// transparently replaced by a stable, reused, migrated sibling database; nothing is ever dropped.
const baseUrl = resolveTestDatabaseUrl('S09');
const { url: testDatabaseUrl } = provisionValidationTestDatabase({ pnpmCli, baseUrl });
const env = {
  ...process.env,
  DATABASE_URL: testDatabaseUrl,
  TEST_DATABASE_URL: testDatabaseUrl,
  TEST_REDIS_URL: process.env.TEST_REDIS_URL?.trim() || 'redis://127.0.0.1:6379/1',
};

const built = spawnSync(
  process.execPath,
  [pnpmCli, '--filter', '@ecom-forge/worker^...', 'build'],
  {
    stdio: 'inherit',
    env,
  },
);
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);

const prefix = ['--filter', '@ecom-forge/worker', 'exec', 'vitest'];
const vitestArgs = [
  '--config',
  'vitest.integration.config.ts',
  'test/s09-compiler.integration-spec.ts',
  '-t',
  pattern,
];
const listed = spawnSync(process.execPath, [pnpmCli, ...prefix, 'list', ...vitestArgs], {
  encoding: 'utf8',
  env,
});
if (listed.error) throw listed.error;
if (listed.status !== 0) {
  process.stdout.write(listed.stdout ?? '');
  process.stderr.write(listed.stderr ?? '');
  process.exit(listed.status ?? 1);
}
const tests = (listed.stdout ?? '')
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter(Boolean);
if (tests.length !== 1) {
  throw new Error(`Expected exactly one S09 test matching ${pattern}, found ${tests.length}`);
}
const result = spawnSync(process.execPath, [pnpmCli, ...prefix, 'run', ...vitestArgs], {
  stdio: 'inherit',
  env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
