import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: {
    jsx: {
      importSource: 'react',
      runtime: 'automatic',
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    exclude: [
      ...configDefaults.exclude,
      '**/.next/**',
      '**/.next-*/**',
      '**/.turbo/**',
      '**/test-results/**',
      'e2e/**',
      'e2e-live/**',
    ],
    maxWorkers: 1,
    passWithNoTests: false,
    pool: 'threads',
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 15_000,
  },
});
