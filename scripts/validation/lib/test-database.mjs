import { spawnSync } from 'node:child_process';

/**
 * Shared validation-harness helper: resolves a test database that is guaranteed to be migrated to
 * the current head.
 *
 * The zero-config validation entrypoints must be reproducible without manually exporting
 * TEST_DATABASE_URL, so a stale fallback database is transparently upgraded behind a stable,
 * reused database instead of surfacing a deep SQL error. Nothing is dropped automatically; the
 * harness only ever reuses or (at most) creates a single deterministically named database.
 */

export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';

const DB_CLI_RELATIVE_PATH = 'src/test-database-cli.ts';
const RESULT_MARKER = '__ECOM_TEST_DATABASE__';

/** Resolve the configured test database and enforce the isolated "_test" naming guard. */
export function resolveTestDatabaseUrl(label, env = process.env) {
  const testDatabaseUrl = env.TEST_DATABASE_URL?.trim() || DEFAULT_TEST_DATABASE_URL;
  let target;
  try {
    target = new URL(testDatabaseUrl);
  } catch {
    throw new Error(`${label} validation requires a valid TEST_DATABASE_URL`);
  }
  const databaseName = target.pathname.slice(1);
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !/^[a-z0-9_]{1,63}$/.test(databaseName) ||
    !/_test(?:_|$)/.test(databaseName)
  ) {
    throw new Error(
      `${label} validation requires TEST_DATABASE_URL to name an isolated _test database`,
    );
  }
  return testDatabaseUrl;
}

function runDatabaseCli({ pnpmCli, cliArgs, databaseUrl }) {
  const result = spawnSync(
    process.execPath,
    [pnpmCli, '--filter', '@ecom-forge/db', 'exec', 'tsx', DB_CLI_RELATIVE_PATH, ...cliArgs],
    {
      encoding: 'utf8',
      env: { ...process.env, TEST_DATABASE_URL: databaseUrl },
    },
  );
  if (result.error) throw new Error('Could not launch the test database helper');
  const stdout = result.stdout ?? '';
  if (result.status !== 0) {
    const safeCodes = new Set([
      'TEST_DATABASE_MIGRATION_DRIFT',
      'TEST_DATABASE_SCHEMA_DRIFT',
      'TEST_DATABASE_COMMAND_INVALID',
      'TEST_DATABASE_PREPARATION_FAILED',
    ]);
    const diagnostic =
      (result.stderr ?? '').split(/\r?\n/u).find((line) => safeCodes.has(line)) ??
      'TEST_DATABASE_PREPARATION_FAILED';
    throw new Error(
      `${diagnostic}: Could not prepare a migrated test database (helper exited ${result.status ?? 'without a status'}).`,
    );
  }
  const line = stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(RESULT_MARKER))
    .at(-1);
  if (!line) throw new Error('Test database helper produced no result');
  try {
    const value = JSON.parse(line.slice(RESULT_MARKER.length));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof value.url !== 'string' ||
      typeof value.databaseName !== 'string' ||
      !['base', 'created', 'reused'].includes(value.outcome) ||
      !/^[a-z0-9_]{1,63}$/.test(value.databaseName) ||
      !/_test(?:_|$)/.test(value.databaseName)
    ) {
      throw new Error('invalid result');
    }
    const source = new URL(databaseUrl);
    const target = new URL(value.url);
    if (value.outcome === 'base' && source.pathname !== `/${value.databaseName}`)
      throw new Error('invalid base');
    source.pathname = `/${value.databaseName}`;
    if (source.href !== target.href) throw new Error('unexpected database endpoint');
    return { url: value.url, databaseName: value.databaseName, outcome: value.outcome };
  } catch {
    throw new Error('Test database helper produced an invalid result');
  }
}

/**
 * Ensure the configured database is migrated to head. When it is stale the helper reuses (or, at
 * most, creates once) a stable deterministically named migrated database and returns its URL.
 * No database is ever dropped here; see `test-database-cli.ts drop` for the explicit manual path.
 */
export function provisionValidationTestDatabase({ pnpmCli, baseUrl }) {
  resolveTestDatabaseUrl('Provision', { TEST_DATABASE_URL: baseUrl });
  const {
    url,
    databaseName,
    outcome: result,
  } = runDatabaseCli({ pnpmCli, cliArgs: ['ensure'], databaseUrl: baseUrl });
  const baseName = new URL(baseUrl).pathname.slice(1);
  if (result === 'created') {
    console.info(
      `[validation] ${baseName} is not migrated to head; created and migrated ${databaseName}`,
    );
  } else if (result === 'reused') {
    console.info(
      `[validation] ${baseName} is not migrated to head; reusing migrated database ${databaseName}`,
    );
  }
  return { url, outcome: result, databaseName };
}

/** Require the process to have been started through pnpm so the runner can spawn workspace tasks. */
export function requirePnpmCli(label) {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error(`${label} validation must be started through pnpm`);
  return pnpmCli;
}
