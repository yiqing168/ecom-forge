import { defineConfig, devices } from '@playwright/test';

process.env.S10_LIVE_E2E = '1';

export default defineConfig({
  testDir: './e2e-live',
  testMatch: 's10-resources-live.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  globalSetup: './e2e-live/global-setup.ts',
  reporter: 'list',
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium-live-resources', use: { ...devices['Desktop Chrome'] } }],
  workers: 1,
});
