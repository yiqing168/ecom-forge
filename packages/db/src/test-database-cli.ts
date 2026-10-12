import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import {
  deriveProvisionedDatabaseName,
  isIsolatedTestDatabaseName,
  isProvisionedDatabaseName,
  sanitizeDatabaseIdentifier,
} from './test-database-names.js';
import { isTestDatabaseMigrationHead } from './test-database-migrations.js';

/**
 * Validation harness helper: guarantees a database that is migrated to the current head so the
 * zero-config validation entrypoints never run against a stale database.
 *
 * `ensure <url>` first tries the configured database. When it is already at head it is reused as-is.
 * Otherwise the helper derives a stable, deterministic sibling name (`<base>_migrated`) so repeated
 * runs converge on a single database: that sibling is reused and forward-migrated when it exists, or
 * created and migrated when it does not. Nothing is ever dropped or recreated here.
 *
 * `drop <url> <name>` is the only destructive operation. It is intended to be run explicitly (never
 * automatically) and refuses to touch anything but an isolated `_test*` database bearing the
 * `_migrated` provisioning marker. A single marker line is emitted so the caller can parse the
 * outcome deterministically.
 */

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
const MARKER = '__ECOM_TEST_DATABASE__';

/** How the harness obtained a migrated database for this run. */
type ProvisionOutcome = 'base' | 'reused' | 'created';

interface ProvisionResult {
  url: string;
  outcome: ProvisionOutcome;
  databaseName: string;
}

/** A database is reusable only when every journaled migration has been applied. */
async function isMigratedToHead(databaseUrl: string): Promise<boolean> {
  const expected = readMigrationFiles({ migrationsFolder });
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const applied = await sql<{ hash: string; createdAt: string }[]>`
      select hash, created_at::text as "createdAt" from drizzle.__drizzle_migrations order by created_at, id
    `;
    try {
      if (!isTestDatabaseMigrationHead(applied, expected)) return false;
    } catch (error) {
      // A configured base database may contain a stale or divergent local migration history.
      // It is not safe to reuse, but it is safe to leave untouched and provision the isolated
      // sibling below. The sibling is still verified strictly by migrateAndVerify.
      if (error instanceof Error && error.message === 'TEST_DATABASE_MIGRATION_DRIFT') return false;
      throw error;
    }
    const [column] = await sql<{ present: boolean }[]>`
      select exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'chat_sessions'
          and column_name = 'transcript_state_json'
      ) as present
    `;
    if (column?.present !== true) throw new Error('TEST_DATABASE_SCHEMA_DRIFT');
    return true;
  } catch (error) {
    if (error instanceof postgres.PostgresError && ['3D000', '42P01'].includes(error.code))
      return false;
    throw error;
  } finally {
    await sql.end();
  }
}

async function migrateToHead(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}

/** Forward-migrate (if needed) and assert the database now matches the current head. */
async function migrateAndVerify(databaseUrl: string): Promise<void> {
  await migrateToHead(databaseUrl);
  if (!(await isMigratedToHead(databaseUrl))) {
    throw new Error('The validation database did not reach the current migration head.');
  }
}

function databaseNameOf(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
}

function withDatabaseName(databaseUrl: string, name: string): string {
  const target = new URL(databaseUrl);
  target.pathname = `/${name}`;
  return target.toString();
}

function maintenanceUrl(databaseUrl: string): string {
  const admin = new URL(databaseUrl);
  admin.pathname = '/postgres';
  return admin.toString();
}

async function databaseExists(databaseUrl: string, name: string): Promise<boolean> {
  const admin = postgres(maintenanceUrl(databaseUrl), { max: 1 });
  try {
    const [row] = await admin<{ present: boolean }[]>`
      select exists (select 1 from pg_database where datname = ${name}) as present
    `;
    return row?.present === true;
  } finally {
    await admin.end();
  }
}

async function createDatabase(databaseUrl: string, name: string): Promise<void> {
  const admin = postgres(maintenanceUrl(databaseUrl), { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
  } catch {
    throw new Error(
      `Could not provision an isolated migrated test database (create database "${name}" failed). ` +
        'Grant the role CREATEDB, or point TEST_DATABASE_URL at a database that is already migrated ' +
        '(pnpm --filter @ecom-forge/db db:migrate).',
    );
  } finally {
    await admin.end();
  }
}

async function ensureMigrated(databaseUrl: string): Promise<ProvisionResult> {
  const baseName = sanitizeDatabaseIdentifier(databaseNameOf(databaseUrl));
  if (!isIsolatedTestDatabaseName(baseName)) {
    throw new Error(
      'Validation requires the configured database name to contain "_test" before it can be used.',
    );
  }

  // Never silently use a database that is behind head: the configured database is reused only when
  // it is already migrated. Otherwise a stable, deterministic sibling database is used instead.
  if (await isMigratedToHead(databaseUrl)) {
    return { url: databaseUrl, outcome: 'base', databaseName: baseName };
  }

  const provisionedName = deriveProvisionedDatabaseName(baseName);
  if (!isIsolatedTestDatabaseName(provisionedName)) {
    throw new Error('The derived validation database name lost its "_test" safety marker.');
  }
  const provisionedUrl = withDatabaseName(databaseUrl, provisionedName);

  if (await databaseExists(databaseUrl, provisionedName)) {
    // Existing provisioned database: forward-migrate it to head, never drop or recreate it.
    await migrateAndVerify(provisionedUrl);
    return { url: provisionedUrl, outcome: 'reused', databaseName: provisionedName };
  }

  await createDatabase(databaseUrl, provisionedName);
  await migrateAndVerify(provisionedUrl);
  return { url: provisionedUrl, outcome: 'created', databaseName: provisionedName };
}

async function dropProvisioned(databaseUrl: string, name: string): Promise<void> {
  const sanitized = sanitizeDatabaseIdentifier(name);
  // Only ever drop an isolated database this harness provisioned.
  if (!isProvisionedDatabaseName(sanitized)) {
    throw new Error(
      `Refusing to drop "${sanitized}": only isolated "_test*_migrated" databases provisioned by this harness may be dropped.`,
    );
  }
  const admin = postgres(maintenanceUrl(databaseUrl), { max: 1 });
  try {
    await admin`
      select pg_terminate_backend(pid)
      from pg_stat_activity
      where datname = ${sanitized} and pid <> pg_backend_pid()
    `;
    await admin.unsafe(`drop database if exists "${sanitized}"`);
  } finally {
    await admin.end();
  }
}

function emit(payload: unknown): void {
  process.stdout.write(`${MARKER}${JSON.stringify(payload)}\n`);
}

const [, , command, ...args] = process.argv;
const databaseUrl = args[0]?.trim() || process.env.TEST_DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error('test-database-cli requires a database URL argument or TEST_DATABASE_URL.');
}

try {
  if (command === 'ensure') {
    emit(await ensureMigrated(databaseUrl));
  } else if (command === 'drop') {
    const name = args[1];
    if (!name) throw new Error('test-database-cli drop requires a database name argument.');
    await dropProvisioned(databaseUrl, name);
    emit({ dropped: sanitizeDatabaseIdentifier(name) });
  } else {
    throw new Error('TEST_DATABASE_COMMAND_INVALID');
  }
} catch (error) {
  const code =
    error instanceof Error &&
    [
      'TEST_DATABASE_MIGRATION_DRIFT',
      'TEST_DATABASE_SCHEMA_DRIFT',
      'TEST_DATABASE_COMMAND_INVALID',
    ].includes(error.message)
      ? error.message
      : 'TEST_DATABASE_PREPARATION_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
