import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import { checkDatabase } from './check.js';
import { resolveDatabaseUrl } from './database-url.js';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
const client = postgres(resolveDatabaseUrl(), { max: 1 });

try {
  await migrate(drizzle(client), { migrationsFolder });
} finally {
  await client.end();
}

await checkDatabase();
console.log('Database migrations applied and verified successfully.');
