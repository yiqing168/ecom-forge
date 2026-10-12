import { describe, expect, it } from 'vitest';

import { loadWorkerConfig } from '../config/worker-config.js';

const testEnvironment = {
  APP_ENV: 'test',
  TEST_DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/ecom_forge_test',
  TEST_REDIS_URL: 'redis://127.0.0.1:6379/15',
  TEST_REDIS_PREFIX: 's05-test-contract',
  LOCAL_UPLOAD_ROOT: './uploads',
} satisfies NodeJS.ProcessEnv;

describe('test processor registration', () => {
  it('allows explicit registration only in the test environment', () => {
    expect(
      loadWorkerConfig({ ...testEnvironment, QUEUE_ENABLE_TEST_PROCESSOR: 'true' })
        .testProcessorEnabled,
    ).toBe(true);
  });

  it('rejects test processor registration outside the test environment', () => {
    expect(() =>
      loadWorkerConfig({
        ...testEnvironment,
        APP_ENV: 'local',
        DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/ecom_forge',
        REDIS_URL: 'redis://127.0.0.1:6379/0',
        REDIS_PREFIX: 'ecom-forge',
        QUEUE_ENABLE_TEST_PROCESSOR: 'true',
      }),
    ).toThrow(/restricted/);
  });

  it('keeps test processors disabled by default', () => {
    expect(loadWorkerConfig(testEnvironment).testProcessorEnabled).toBe(false);
  });
});
