import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['test/**/*.integration-spec.ts', '**/node_modules/**', '**/dist/**'],
  },
});
