import { describe, expect, it } from 'vitest';

import { WORKER_RUNTIME_DEFAULTS } from './runtime-defaults.js';
import { loadWorkerConfig } from './worker-config.js';

function testEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'test',
    TEST_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/ecom_forge_test_run',
    TEST_REDIS_URL: 'redis://127.0.0.1:6379/15',
    TEST_REDIS_PREFIX: 's05-test-run',
    LOCAL_UPLOAD_ROOT: './uploads',
    QUEUE_ENABLE_TEST_PROCESSOR: 'true',
    PROVIDER_MODE: 'fake',
    PROVIDER_PROCESSOR_MODE: 'disabled',
    PROVIDER_ADAPTER: 'fake',
    PROVIDER_RELAY_ORIGINS: 'https://relay.test.invalid',
    ...overrides,
  };
}

describe('worker config', () => {
  it('uses the 272K context policy and starts compaction at 80 percent', () => {
    expect(loadWorkerConfig(testEnv())).toMatchObject({
      agentMaxInputTokens: 272_000,
      agentAutoCompactTokenLimit: 217_600,
    });
  });

  it('rejects an override above the 272K context policy', () => {
    expect(() => loadWorkerConfig(testEnv({ AGENT_MAX_INPUT_TOKENS: '272001' }))).toThrow(
      /AGENT_MAX_INPUT_TOKENS/,
    );
    expect(() => loadWorkerConfig(testEnv({ AGENT_MAX_INPUT_TOKENS: '372000' }))).toThrow(
      /AGENT_MAX_INPUT_TOKENS/,
    );
    expect(
      loadWorkerConfig(testEnv({ AGENT_MAX_INPUT_TOKENS: '272000' })).agentMaxInputTokens,
    ).toBe(272_000);
  });

  it('allows a four-minute Brain request within a five-minute processing lease', () => {
    expect(WORKER_RUNTIME_DEFAULTS).toMatchObject({
      agentRequestTimeoutMs: 240_000,
      agentProcessingLeaseMs: 300_000,
    });
    expect(loadWorkerConfig(testEnv())).toMatchObject({
      agentRequestTimeoutMs: 240_000,
      agentProcessingLeaseMs: 300_000,
    });
  });

  it('loads the frozen S05 defaults in an isolated test environment', () => {
    expect(loadWorkerConfig(testEnv())).toMatchObject({
      appEnv: 'test',
      redisPrefix: 's05-test-run',
      heartbeatIntervalMs: WORKER_RUNTIME_DEFAULTS.heartbeatIntervalMs,
      heartbeatStaleMs: WORKER_RUNTIME_DEFAULTS.heartbeatStaleMs,
      dispatchLeaseMs: WORKER_RUNTIME_DEFAULTS.dispatchLeaseMs,
      dispatchLeaseRenewMs: WORKER_RUNTIME_DEFAULTS.dispatchLeaseRenewMs,
      dispatchBatchSize: WORKER_RUNTIME_DEFAULTS.dispatchBatchSize,
      testProcessorEnabled: true,
      settlementProcessorEnabled: true,
      providerMode: 'fake',
      providerProcessorMode: 'disabled',
      providerRelayOrigins: ['https://relay.test.invalid'],
      providerImageOutputOrigins: ['https://relay.test.invalid'],
      imageProviderRequestTimeoutMs: WORKER_RUNTIME_DEFAULTS.imageProviderRequestTimeoutMs,
      providerImageTaskConcurrency: 9,
      agentProcessorEnabled: true,
      agentBrainAdapter: 'fake',
      agentBrainReasoningEffort: 'medium',
      providerRealPocEnabled: false,
      agentRequestTimeoutMs: WORKER_RUNTIME_DEFAULTS.agentRequestTimeoutMs,
      agentProcessingLeaseMs: WORKER_RUNTIME_DEFAULTS.agentProcessingLeaseMs,
      agentProcessingRenewMs: WORKER_RUNTIME_DEFAULTS.agentProcessingRenewMs,
      agentMaxInputTokens: WORKER_RUNTIME_DEFAULTS.agentMaxInputTokens,
      agentAutoCompactTokenLimit: WORKER_RUNTIME_DEFAULTS.agentAutoCompactTokenLimit,
      agentBrainStepMaxOutputTokens: WORKER_RUNTIME_DEFAULTS.agentBrainStepMaxOutputTokens,
      agentBrainImageMaxEdge: WORKER_RUNTIME_DEFAULTS.agentBrainImageMaxEdge,
      agentBrainMaxMaterializedImageBytes:
        WORKER_RUNTIME_DEFAULTS.agentBrainMaxMaterializedImageBytes,
      agentMaxEstimatedCostCny: WORKER_RUNTIME_DEFAULTS.agentMaxEstimatedCostCny,
      storageEnabled: true,
      storageMaxImageBytes: WORKER_RUNTIME_DEFAULTS.storageMaxImageBytes,
      contentReviewDeadlineMs: WORKER_RUNTIME_DEFAULTS.contentReviewDeadlineSeconds * 1_000,
      contentReviewSweepBatchSize: WORKER_RUNTIME_DEFAULTS.contentReviewSweepBatchSize,
      outcomeUnknownReleaseDeadlineMs: 30 * 60 * 1_000,
      outcomeUnknownReleaseSweepBatchSize:
        WORKER_RUNTIME_DEFAULTS.outcomeUnknownReleaseSweepBatchSize,
    });
  });

  it('rejects a test database without the required isolation marker', () => {
    expect(() =>
      loadWorkerConfig(
        testEnv({
          TEST_DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/ecom_forge',
        }),
      ),
    ).toThrow(/must contain _test/);
  });

  it('rejects a test database that resolves to the development database', () => {
    const databaseUrl = 'postgresql://postgres:postgres@127.0.0.1:5432/ecom_forge_test_shared';
    expect(() =>
      loadWorkerConfig(testEnv({ DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl })),
    ).toThrow(/must not target the development database/);
  });

  it('rejects lease renewal that cannot complete before lease expiry', () => {
    expect(() =>
      loadWorkerConfig(
        testEnv({
          QUEUE_DISPATCH_LEASE_MS: '10000',
          QUEUE_DISPATCH_LEASE_RENEW_MS: '10000',
        }),
      ),
    ).toThrow(/must be less/);
  });

  it('rejects enabling the test processor outside APP_ENV=test', () => {
    expect(() =>
      loadWorkerConfig({
        APP_ENV: 'production',
        DATABASE_URL: 'postgresql://postgres:postgres@db:5432/ecom_forge',
        REDIS_URL: 'redis://redis:6379',
        REDIS_PREFIX: 'ecom-forge',
        LOCAL_UPLOAD_ROOT: './uploads',
        PROVIDER_RELAY_ORIGINS: 'https://relay.test.invalid',
        QUEUE_ENABLE_TEST_PROCESSOR: 'true',
      }),
    ).toThrow(/restricted to APP_ENV=test/);
  });

  it.each(['staging', 'beta', 'production'] as const)(
    'keeps settlement processing disabled in %s until real cost capability is approved',
    (appEnv) => {
      expect(
        loadWorkerConfig({
          APP_ENV: appEnv,
          DATABASE_URL: 'postgresql://postgres:postgres@db:5432/ecom_forge',
          REDIS_URL: 'redis://redis:6379',
          REDIS_PREFIX: 'ecom-forge',
          LOCAL_UPLOAD_ROOT: './uploads',
          PROVIDER_RELAY_ORIGINS: 'https://relay.test.invalid',
        }).settlementProcessorEnabled,
      ).toBe(false);
    },
  );

  it('allows fake validation only in test/local and rejects queue consumer overlap', () => {
    expect(
      loadWorkerConfig(
        testEnv({
          QUEUE_ENABLE_TEST_PROCESSOR: 'false',
          PROVIDER_PROCESSOR_MODE: 'fake_validation',
        }),
      ).providerProcessorMode,
    ).toBe('fake_validation');
    expect(() => loadWorkerConfig(testEnv({ PROVIDER_PROCESSOR_MODE: 'fake_validation' }))).toThrow(
      /cannot consume the same task queue/,
    );
    expect(() =>
      loadWorkerConfig(
        testEnv({
          APP_ENV: 'production',
          DATABASE_URL: 'postgresql://postgres:postgres@db:5432/ecom_forge',
          REDIS_URL: 'redis://redis:6379',
          REDIS_PREFIX: 'ecom-forge',
          LOCAL_UPLOAD_ROOT: './uploads',
          QUEUE_ENABLE_TEST_PROCESSOR: 'false',
          PROVIDER_MODE: 'real',
          PROVIDER_PROCESSOR_MODE: 'fake_validation',
          PROVIDER_ADAPTER: 'disabled',
        }),
      ),
    ).toThrow(/requires APP_ENV=test\/local/);
  });

  it('opens S12 real processing only with the approved mode and credential keyring', () => {
    const base = {
      QUEUE_ENABLE_TEST_PROCESSOR: 'false',
      PROVIDER_MODE: 'real',
      PROVIDER_PROCESSOR_MODE: 'real',
      PROVIDER_ADAPTER: 'disabled',
    };
    expect(() => loadWorkerConfig(testEnv(base))).toThrow(
      /PROVIDER_CREDENTIAL_ENCRYPTION_KEYRING is required/,
    );
    expect(
      loadWorkerConfig(
        testEnv({
          ...base,
          PROVIDER_CREDENTIAL_ENCRYPTION_KEYRING: `v1:${Buffer.alloc(32, 1).toString('base64url')}`,
        }),
      ).providerProcessorMode,
    ).toBe('real');
  });

  it.each(['staging', 'beta', 'production'] as const)(
    'rejects the fake Provider control plane in %s even when processors are disabled',
    (appEnv) => {
      expect(() =>
        loadWorkerConfig({
          APP_ENV: appEnv,
          DATABASE_URL: 'postgresql://postgres:postgres@db:5432/ecom_forge',
          REDIS_URL: 'redis://redis:6379',
          REDIS_PREFIX: 'ecom-forge',
          PROVIDER_RELAY_ORIGINS: 'https://relay.test.invalid',
          PROVIDER_MODE: 'fake',
          PROVIDER_PROCESSOR_MODE: 'disabled',
          PROVIDER_ADAPTER: 'fake',
        }),
      ).toThrow(/restricted to APP_ENV=test\/local/);
    },
  );

  it('requires Provider mode and adapter selections to agree', () => {
    expect(() =>
      loadWorkerConfig(
        testEnv({
          QUEUE_ENABLE_TEST_PROCESSOR: 'false',
          PROVIDER_MODE: 'fake',
          PROVIDER_ADAPTER: 'disabled',
        }),
      ),
    ).toThrow(/requires PROVIDER_ADAPTER=fake/);
    expect(() =>
      loadWorkerConfig(
        testEnv({
          QUEUE_ENABLE_TEST_PROCESSOR: 'false',
          PROVIDER_MODE: 'real',
          PROVIDER_ADAPTER: 'fake',
        }),
      ),
    ).toThrow(/No real Provider adapter/);
  });

  it('rejects an unsafe Agent lease cadence and fake Brain in production', () => {
    expect(() =>
      loadWorkerConfig(
        testEnv({
          AGENT_PROCESSING_LEASE_MS: '10000',
          AGENT_PROCESSING_RENEW_MS: '5000',
          AGENT_REQUEST_TIMEOUT_MS: '9000',
        }),
      ),
    ).toThrow(/times three/);
    expect(() =>
      loadWorkerConfig({
        APP_ENV: 'production',
        DATABASE_URL: 'postgresql://postgres:postgres@db:5432/ecom_forge',
        REDIS_URL: 'redis://redis:6379',
        REDIS_PREFIX: 'ecom-forge',
        LOCAL_UPLOAD_ROOT: './uploads',
        PROVIDER_RELAY_ORIGINS: 'https://relay.test.invalid',
        PROVIDER_MODE: 'real',
        PROVIDER_ADAPTER: 'disabled',
        AGENT_BRAIN_ADAPTER: 'fake',
      }),
    ).toThrow(/restricted to APP_ENV=test\/local/);
  });

  it('rejects an Agent cost budget above the system hard limit', () => {
    expect(() => loadWorkerConfig(testEnv({ AGENT_MAX_ESTIMATED_COST_CNY: '0.16' }))).toThrow(
      /no more than 0.15/,
    );
    expect(() => loadWorkerConfig(testEnv({ AGENT_MAX_ESTIMATED_COST_CNY: 'not-money' }))).toThrow(
      /decimal string/,
    );
  });
  it('uses the registered-call ceiling and a task-sized cumulative ceiling', () => {
    const config = loadWorkerConfig(testEnv());
    expect(config.agentBrainStepMaxOutputTokens).toBe(8192);
    expect(config.agentMaxOutputTokens).toBe(360448);
  });

  it('caps the dedicated image Provider timeout at 600 seconds', () => {
    expect(
      loadWorkerConfig(testEnv({ IMAGE_PROVIDER_REQUEST_TIMEOUT_MS: '599000' })),
    ).toMatchObject({ imageProviderRequestTimeoutMs: 599_000 });
    expect(() =>
      loadWorkerConfig(testEnv({ IMAGE_PROVIDER_REQUEST_TIMEOUT_MS: '600001' })),
    ).toThrow(/IMAGE_PROVIDER_REQUEST_TIMEOUT_MS/);
  });

  it('rejects missing or unsafe relay origins outside local/test', () => {
    expect(() =>
      loadWorkerConfig({
        APP_ENV: 'production',
        DATABASE_URL: 'postgresql://postgres:postgres@db:5432/ecom_forge',
        REDIS_URL: 'redis://redis:6379',
        REDIS_PREFIX: 'ecom-forge',
        LOCAL_UPLOAD_ROOT: './uploads',
      }),
    ).toThrow(/PROVIDER_RELAY_ORIGINS/);
    expect(() =>
      loadWorkerConfig(testEnv({ PROVIDER_RELAY_ORIGINS: 'https://relay.test.invalid/path' })),
    ).toThrow(/PROVIDER_RELAY_ORIGINS/);
  });

  it('keeps image output origins separate from relay API origins', () => {
    expect(
      loadWorkerConfig(
        testEnv({
          PROVIDER_IMAGE_OUTPUT_ORIGINS: 'https://cdn-a.test.invalid,https://cdn-b.test.invalid',
        }),
      ),
    ).toMatchObject({
      providerRelayOrigins: ['https://relay.test.invalid'],
      providerImageOutputOrigins: ['https://cdn-a.test.invalid', 'https://cdn-b.test.invalid'],
    });
    expect(() =>
      loadWorkerConfig(testEnv({ PROVIDER_IMAGE_OUTPUT_ORIGINS: 'https://cdn.test.invalid/path' })),
    ).toThrow(/PROVIDER_IMAGE_OUTPUT_ORIGINS/);
  });

  it('requires explicit local real-cost confirmation for a Brain PoC', () => {
    expect(() =>
      loadWorkerConfig(
        testEnv({
          APP_ENV: 'local',
          DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/ecom_forge',
          REDIS_URL: 'redis://127.0.0.1:6379',
          REDIS_PREFIX: 'ecom-forge',
          QUEUE_ENABLE_TEST_PROCESSOR: 'false',
          AGENT_BRAIN_ADAPTER: 'approved',
          PROVIDER_REAL_POC_ENABLED: 'true',
        }),
      ),
    ).toThrow(/explicit real Provider cost confirmation/);
    expect(() =>
      loadWorkerConfig(
        testEnv({
          APP_ENV: 'production',
          DATABASE_URL: 'postgresql://postgres:postgres@db:5432/ecom_forge',
          REDIS_URL: 'redis://redis:6379',
          REDIS_PREFIX: 'ecom-forge',
          QUEUE_ENABLE_TEST_PROCESSOR: 'false',
          PROVIDER_MODE: 'real',
          PROVIDER_ADAPTER: 'disabled',
          AGENT_BRAIN_ADAPTER: 'approved',
          PROVIDER_REAL_POC_ENABLED: 'true',
          PROVIDER_REAL_COST_CONFIRMED: 'I_ACCEPT_REAL_PROVIDER_COST',
          PROVIDER_CREDENTIAL_ENCRYPTION_KEYRING: `v1:${Buffer.alloc(32, 1).toString('base64url')}`,
        }),
      ),
    ).toThrow(/restricted to APP_ENV=local/);
  });
});

describe('provider image output origins', () => {
  it('accepts exact and single-domain wildcard entries and normalizes them', () => {
    const config = loadWorkerConfig(
      testEnv({
        PROVIDER_IMAGE_OUTPUT_ORIGINS:
          'https://oss4.cxkedu.shop/,https://*.CXKEDU.shop,https://provider-output.example.com',
      }),
    );
    expect(config.providerImageOutputOrigins).toEqual([
      'https://oss4.cxkedu.shop',
      'https://*.cxkedu.shop',
      'https://provider-output.example.com',
    ]);
  });

  it('overrides the Brain reasoning effort from the environment', () => {
    expect(
      loadWorkerConfig(testEnv({ AGENT_BRAIN_REASONING_EFFORT: 'high' })).agentBrainReasoningEffort,
    ).toBe('high');
    expect(loadWorkerConfig(testEnv()).agentBrainReasoningEffort).toBe('medium');
    expect(() => loadWorkerConfig(testEnv({ AGENT_BRAIN_REASONING_EFFORT: 'ultra' }))).toThrow(
      /AGENT_BRAIN_REASONING_EFFORT/,
    );
  });

  it('rejects malformed wildcard entries', () => {
    expect(() => loadWorkerConfig(testEnv({ PROVIDER_IMAGE_OUTPUT_ORIGINS: 'https://*' }))).toThrow(
      /PROVIDER_IMAGE_OUTPUT_ORIGINS/,
    );
    expect(() =>
      loadWorkerConfig(testEnv({ PROVIDER_IMAGE_OUTPUT_ORIGINS: 'http://*.cxkedu.shop' })),
    ).toThrow(/PROVIDER_IMAGE_OUTPUT_ORIGINS/);
  });

  it('still rejects wildcard entries in the relay API origin allowlist', () => {
    expect(() =>
      loadWorkerConfig(testEnv({ PROVIDER_RELAY_ORIGINS: 'https://*.cxkedu.shop' })),
    ).toThrow(/PROVIDER_RELAY_ORIGINS/);
  });
});
