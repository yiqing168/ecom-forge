import { spawnSync } from 'node:child_process';

import {
  provisionValidationTestDatabase,
  requirePnpmCli,
  resolveTestDatabaseUrl,
} from './lib/test-database.mjs';

const pattern = process.argv[2];
if (!pattern) {
  throw new Error('A required Vitest test-name pattern is required');
}

const pnpmCli = requirePnpmCli('Vitest case');
const baseUrl = resolveTestDatabaseUrl('Vitest case');
const { url: testDatabaseUrl } = provisionValidationTestDatabase({ pnpmCli, baseUrl });
const env = { ...process.env, TEST_DATABASE_URL: testDatabaseUrl };
const vitestArgs = ['--config', 'vitest.integration.config.ts'];
const listed = spawnSync(
  process.execPath,
  [pnpmCli, 'exec', 'vitest', 'list', '--json', ...vitestArgs, '-t', pattern],
  {
    encoding: 'utf8',
    env,
  },
);
if (listed.error) throw listed.error;
if (listed.status !== 0) {
  process.stdout.write(listed.stdout ?? '');
  process.stderr.write(listed.stderr ?? '');
  process.exit(listed.status ?? 1);
}

const output = listed.stdout ?? '';
const start = output.indexOf('[');
const end = output.lastIndexOf(']');
const tests = start >= 0 && end >= start ? JSON.parse(output.slice(start, end + 1)) : [];
if (!Array.isArray(tests) || tests.length !== 1) {
  throw new Error(`Expected exactly one Vitest case matching ${pattern}, found ${tests.length}`);
}

const result = spawnSync(
  process.execPath,
  [pnpmCli, 'exec', 'vitest', 'run', ...vitestArgs, '-t', pattern],
  {
    stdio: 'inherit',
    env,
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
