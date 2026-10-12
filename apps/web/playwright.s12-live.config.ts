import { defineConfig, devices } from '@playwright/test';

process.env.S11_LIVE_E2E = '1';
process.env.S12_LIVE_E2E = '1';

export default defineConfig({
  testDir: './e2e-live',
  testMatch: 's12-image-pipeline-live.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  globalSetup: './e2e-live/global-setup.ts',
  reporter: 'list',
  timeout: 180_000,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-s12-desktop-1440',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'chromium-s12-mobile-390',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } },
    },
  ],
  workers: 1,
});
