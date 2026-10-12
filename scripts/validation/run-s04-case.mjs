import { spawnSync } from 'node:child_process';

const DEFAULT_TEST_DATABASE_URL =
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';

const cases = {
  'single-dispatch': [
    {
      workspace: '@ecom-forge/api',
      config: 'vitest.config.ts',
      file: 'test/s04-credit.e2e-spec.ts',
      pattern: 'creates one stable task intent for every task in the first executable stage',
    },
    {
      workspace: '@ecom-forge/worker',
      config: 'vitest.integration.config.ts',
      file: 'test/s05-worker.integration-spec.ts',
      pattern: 'allocates one attempt per task state under concurrent workers',
    },
  ],
  'duplicate-click': [
    {
      workspace: '@ecom-forge/api',
      config: 'vitest.config.ts',
      file: 'test/s04-credit.e2e-spec.ts',
      pattern: 'submits a quote concurrently exactly once without partial financial state',
    },
  ],
  'ledger-replay': [
    {
      workspace: '@ecom-forge/api',
      config: 'vitest.config.ts',
      file: 'test/s04-credit.e2e-spec.ts',
      pattern: 'replays ledger by account version and rejects projection drift',
    },
  ],
};

const name = process.argv[2];
const selected = cases[name];
if (!selected) throw new Error(`Unknown S04 validation case: ${name ?? '<missing>'}`);

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim() || DEFAULT_TEST_DATABASE_URL;
const databaseName = new URL(testDatabaseUrl).pathname.replace(/^\//, '').toLowerCase();
if (!/_test(?:_|$)/.test(databaseName)) {
  throw new Error('S04 validation requires TEST_DATABASE_URL to name an isolated _test database');
}

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('S04 validation must be started through pnpm');
const env = { ...process.env, DATABASE_URL: testDatabaseUrl, TEST_DATABASE_URL: testDatabaseUrl };

for (const testCase of selected) {
  const prefix = ['--filter', testCase.workspace, 'exec', 'vitest'];
  const vitestArgs = ['--config', testCase.config, testCase.file, '-t', testCase.pattern];
  const listed = spawnSync(
    process.execPath,
    [pnpmCli, ...prefix, 'list', '--json', ...vitestArgs],
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
    throw new Error(
      `Expected exactly one ${testCase.workspace} test matching ${testCase.pattern}, found ${tests.length}`,
    );
  }

  const result = spawnSync(process.execPath, [pnpmCli, ...prefix, 'run', ...vitestArgs], {
    stdio: 'inherit',
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
