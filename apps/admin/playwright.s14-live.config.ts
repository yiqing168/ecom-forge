import { defineConfig, devices } from '@playwright/test';

process.env.S14_LIVE_E2E = '1';

export default defineConfig({
  testDir: './e2e-live',
  testMatch: 's14-admin-live.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  globalSetup: './e2e-live/global-setup.ts',
  reporter: 'list',
  timeout: 600_000,
  use: {
    actionTimeout: 15_000,
    baseURL: 'http://127.0.0.1:3200',
    permissions: ['clipboard-read', 'clipboard-write'],
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium-live-admin', use: { ...devices['Desktop Chrome'] } }],
  workers: 1,
});
