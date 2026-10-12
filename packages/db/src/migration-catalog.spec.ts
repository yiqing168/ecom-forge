import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle, PostgresJsSession, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkDatabase } from './check.js';
import { requireTestDatabaseUrl } from './test-database-env.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
const databaseName = `ecom_forge_test_catalog_${randomUUID().replaceAll('-', '')}`;

let client: ReturnType<typeof postgres> | undefined;
let database: PostgresJsDatabase;
let transcriptIndex = -1;
let baselineCheckBeforeExtension: 'passed' | 'threw' = 'threw';
let tablesBeforeExtension: { items: string | null; payloads: string | null } = {
  items: null,
  payloads: null,
};

beforeAll(async () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Migration catalog tests must not run against a production environment');
  }
  const config = { migrationsFolder };
  const migrations = readMigrationFiles(config);
  transcriptIndex = migrations.findIndex((migration) =>
    migration.sql.some((statement) => statement.includes('CREATE TABLE "agent_transcript_items"')),
  );
  expect(transcriptIndex).toBeGreaterThan(0);

  const targetUrl = new URL(requireTestDatabaseUrl());
  const adminUrl = new URL(targetUrl);
  adminUrl.pathname = '/postgres';
  targetUrl.pathname = `/${databaseName}`;
  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 5 });
  try {
    await admin.unsafe(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }
  client = postgres(targetUrl.toString(), {
    max: 4,
    connect_timeout: 5,
    connection: { client_min_messages: 'warning' },
  });

  // Upgrade a pre-extension structure: everything up to, but excluding, the transcript migration.
  const dialect = new PgDialect();
  await dialect.migrate(
    migrations.slice(0, transcriptIndex),
    new PostgresJsSession(client, dialect, undefined),
    config,
  );

  // `db:check` only validates baseline structure. Prove it is satisfied WITHOUT the transcript
  // extension, so a passing `db:check` never proves `0038` is installed.
  baselineCheckBeforeExtension = await checkDatabase(targetUrl.toString()).then(
    () => 'passed' as const,
    () => 'threw' as const,
  );
  const [before] = await client<{ items: string | null; payloads: string | null }[]>`
    select to_regclass('public.agent_transcript_items')::text as items,
           to_regclass('public.agent_transcript_payloads')::text as payloads
  `;
  tablesBeforeExtension = { items: before?.items ?? null, payloads: before?.payloads ?? null };

  database = drizzle(client);
  await migrate(database, config);
  // Creating a database and applying every migration is slow, and slower still while the rest of
  // the monorepo suite runs concurrently; keep the hook timeout above the observed worst case.
}, 180_000);

afterAll(async () => {
  await client?.end();
  // Retain the uniquely created database; no acceptance data or migration history is removed.
  console.info(`Migration catalog test database retained: ${databaseName}`);
});

describe('transcript migration catalog and journal', () => {
  it('satisfies baseline db:check before 0038, proving db:check alone is insufficient', () => {
    expect(baselineCheckBeforeExtension).toBe('passed');
    expect(tablesBeforeExtension).toEqual({ items: null, payloads: null });
  });

  it('records the transcript migration hash and timestamp exactly as shipped', async () => {
    const fileMigration = readMigrationFiles({ migrationsFolder })[transcriptIndex]!;
    const applied = await database.execute<{ hash: string; createdAt: string }>(sql`
      select hash, created_at::text as "createdAt"
      from drizzle.__drizzle_migrations
      where hash = ${fileMigration.hash}
    `);
    expect([...applied]).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      hash: fileMigration.hash,
      createdAt: String(fileMigration.folderMillis),
    });
  });

  it('keeps every applied migration hash identical to the file (old migrations unchanged, in order)', async () => {
    const expected = readMigrationFiles({ migrationsFolder }).map((migration) => ({
      hash: migration.hash,
      createdAt: String(migration.folderMillis),
    }));
    const applied = await database.execute<{ hash: string; createdAt: string }>(sql`
      select hash, created_at::text as "createdAt"
      from drizzle.__drizzle_migrations order by created_at, id
    `);
    expect([...applied]).toEqual(expected);
  });

  it('installs the transcript tables only after the forward migration', async () => {
    const [after] = await database.execute<{ items: string | null; payloads: string | null }>(sql`
      select to_regclass('public.agent_transcript_items')::text as items,
             to_regclass('public.agent_transcript_payloads')::text as payloads
    `);
    expect(after?.items).not.toBeNull();
    expect(after?.payloads).not.toBeNull();
  });

  it('leaves the migration history stable on a repeated run', async () => {
    const before = [
      ...(await database.execute<{ hash: string; createdAt: string }>(sql`
        select hash, created_at::text as "createdAt"
        from drizzle.__drizzle_migrations order by created_at, id
      `)),
    ];
    await migrate(database, { migrationsFolder });
    const after = [
      ...(await database.execute<{ hash: string; createdAt: string }>(sql`
        select hash, created_at::text as "createdAt"
        from drizzle.__drizzle_migrations order by created_at, id
      `)),
    ];
    expect(after).toEqual(before);
  });
});
