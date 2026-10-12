import { defineConfig } from 'drizzle-kit';

import { resolveDatabaseUrl } from './src/database-url.js';

export default defineConfig({
  dialect: 'postgresql',
  dbCredentials: {
    url: resolveDatabaseUrl(),
  },
  out: './drizzle',
  schema: './src/schema/index.ts',
  strict: true,
  verbose: true,
});
