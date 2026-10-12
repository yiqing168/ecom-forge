import postgres from 'postgres';

import { resolveDatabaseUrl } from './database-url.js';

const MINIMUM_SCHEMA_TABLE_COUNT = 49;

interface DatabaseCheckResult {
  artifactTable: string | null;
  ledgerTable: string | null;
  mailDeliveryTable: string | null;
  migrationsTable: string | null;
  registrationClaimTable: string | null;
  tableCount: string;
  userTable: string | null;
  workflowTable: string | null;
}

export async function checkDatabase(databaseUrl = resolveDatabaseUrl()): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    const [result] = await sql<DatabaseCheckResult[]>`
      select
        to_regclass('public.users')::text as "userTable",
        to_regclass('public.credit_ledger')::text as "ledgerTable",
        to_regclass('public.workflow_runs')::text as "workflowTable",
        to_regclass('public.artifacts')::text as "artifactTable",
        to_regclass('public.registration_claims')::text as "registrationClaimTable",
        to_regclass('public.mail_deliveries')::text as "mailDeliveryTable",
        to_regclass('drizzle.__drizzle_migrations')::text as "migrationsTable",
        (
          select count(*)::text
          from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'
        ) as "tableCount"
    `;

    const requiredTables = [
      result?.userTable,
      result?.ledgerTable,
      result?.workflowTable,
      result?.artifactTable,
      result?.registrationClaimTable,
      result?.mailDeliveryTable,
      result?.migrationsTable,
    ];
    const tableCount = Number(result?.tableCount);
    if (
      requiredTables.some((tableName) => tableName === null || tableName === undefined) ||
      !Number.isInteger(tableCount) ||
      tableCount < MINIMUM_SCHEMA_TABLE_COUNT
    ) {
      throw new Error('database schema is incomplete or migrations have not been applied');
    }
  } finally {
    await sql.end();
  }
}
