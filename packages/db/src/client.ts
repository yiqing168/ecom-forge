import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { resolveDatabaseUrl } from './database-url.js';
import * as schema from './schema/index.js';

export interface DatabaseClientOptions {
  databaseUrl?: string;
  maxConnections?: number;
  statementTimeoutMs?: number;
  transactionTimeoutMs?: number;
  applicationName?: string;
}

export function createDatabaseClient(options: DatabaseClientOptions = {}) {
  const client = postgres(options.databaseUrl ?? resolveDatabaseUrl(), {
    max: options.maxConnections ?? 10,
    connection: {
      application_name: options.applicationName ?? 'ecom-forge',
      ...(options.statementTimeoutMs ? { statement_timeout: options.statementTimeoutMs } : {}),
      ...(options.transactionTimeoutMs
        ? { idle_in_transaction_session_timeout: options.transactionTimeoutMs }
        : {}),
    },
  });

  return {
    client,
    db: drizzle(client, { schema }),
  };
}

export type Database = ReturnType<typeof createDatabaseClient>['db'];
