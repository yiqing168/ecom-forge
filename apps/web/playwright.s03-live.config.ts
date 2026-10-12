import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e-live',
  testMatch: 's03-auth-live.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  globalSetup: './e2e-live/global-setup.ts',
  reporter: 'list',
  timeout: 90_000,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium-live-auth', use: { ...devices['Desktop Chrome'] } }],
  workers: 1,
});
