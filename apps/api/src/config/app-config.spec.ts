import { ConfigurationError, loadAppConfig } from './app-config.js';
import { API_RUNTIME_DEFAULTS } from './runtime-defaults.js';

const secret = Buffer.alloc(32, 7).toString('base64url');

function testEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'test',
    API_PORT: '3001',
    WEB_ORIGIN: 'http://localhost:3000',
    REDIS_URL: 'redis://localhost:6379',
    REDIS_PREFIX: 'ecom-forge-test',
    LOCAL_UPLOAD_ROOT: './uploads',
    STORAGE_CAPABILITY_SECRET: Buffer.alloc(32, 31).toString('base64url'),
    PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'provider-credential-v1',
    PROVIDER_CREDENTIAL_ENCRYPTION_KEYRING: `provider-credential-v1:${secret}`,
    PROVIDER_CREDENTIAL_HINT_ACTIVE_KEY_ID: 'provider-credential-hint-v1',
    PROVIDER_CREDENTIAL_HINT_KEYRING: `provider-credential-hint-v1:${secret}`,
    STORAGE_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'storage-credential-v1',
    STORAGE_CREDENTIAL_ENCRYPTION_KEYRING: `storage-credential-v1:${secret}`,
    STORAGE_CREDENTIAL_HINT_ACTIVE_KEY_ID: 'storage-credential-hint-v1',
    STORAGE_CREDENTIAL_HINT_KEYRING: `storage-credential-hint-v1:${secret}`,
    RESOURCE_CURSOR_SECRET: Buffer.alloc(32, 32).toString('base64url'),
    RESOURCE_IDEMPOTENCY_SECRET: Buffer.alloc(32, 33).toString('base64url'),
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
    AUTH_SECRET: secret,
    AUTH_TRUSTED_ORIGINS: 'http://localhost:3000',
    AUTH_OTP_HASH_SECRET: secret,
    AUTH_RATE_LIMIT_SECRET: secret,
    AUTH_VERIFICATION_TICKET_SECRET: secret,
    AUTH_INVITE_CODE_ACTIVE_KEY_ID: 'invite-v1',
    AUTH_INVITE_CODE_KEYRING: `invite-v1:${secret}`,
    ADMIN_INVITE_CODE_ENCRYPTION_ACTIVE_KEY_ID: 'invite-envelope-v1',
    ADMIN_INVITE_CODE_ENCRYPTION_KEYRING: `invite-envelope-v1:${secret}`,
    MAIL_RECIPIENT_HASH_ACTIVE_KEY_ID: 'recipient-v1',
    MAIL_RECIPIENT_HASH_KEYRING: `recipient-v1:${secret}`,
    AUTH_REWARD_FINGERPRINT_ACTIVE_KEY_ID: 'fingerprint-v1',
    AUTH_REWARD_FINGERPRINT_KEYRING: `fingerprint-v1:${secret}`,
    ADMIN_ORIGIN: 'http://localhost:3200',
    ADMIN_ALLOWED_HOSTS: 'localhost:3200,127.0.0.1:3200',
    TRUSTED_ADMIN_PROXY_CIDRS: '127.0.0.1/32,::1/128',
    ADMIN_SOURCE_ALLOWLIST_CIDRS: '127.0.0.1/32,::1/128',
    ADMIN_IDENTIFIER_HASH_ACTIVE_KEY_ID: 'admin-identifier-v1',
    ADMIN_IDENTIFIER_HASH_KEYRING: `admin-identifier-v1:${secret}`,
    ADMIN_SESSION_HASH_ACTIVE_KEY_ID: 'admin-session-v1',
    ADMIN_SESSION_HASH_KEYRING: `admin-session-v1:${secret}`,
    ADMIN_CSRF_DERIVATION_ACTIVE_KEY_ID: 'admin-csrf-v1',
    ADMIN_CSRF_DERIVATION_KEYRING: `admin-csrf-v1:${secret}`,
    ADMIN_CHALLENGE_HASH_ACTIVE_KEY_ID: 'admin-challenge-v1',
    ADMIN_CHALLENGE_HASH_KEYRING: `admin-challenge-v1:${secret}`,
    ADMIN_ENROLLMENT_HASH_ACTIVE_KEY_ID: 'admin-enrollment-v1',
    ADMIN_ENROLLMENT_HASH_KEYRING: `admin-enrollment-v1:${secret}`,
    ADMIN_IDEMPOTENCY_HASH_ACTIVE_KEY_ID: 'admin-idempotency-v1',
    ADMIN_IDEMPOTENCY_HASH_KEYRING: `admin-idempotency-v1:${secret}`,
    ADMIN_RECOVERY_HASH_ACTIVE_KEY_ID: 'admin-recovery-v1',
    ADMIN_RECOVERY_HASH_KEYRING: `admin-recovery-v1:${secret}`,
    ADMIN_SOURCE_HASH_ACTIVE_KEY_ID: 'admin-source-v1',
    ADMIN_SOURCE_HASH_KEYRING: `admin-source-v1:${secret}`,
    ADMIN_TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'admin-totp-v1',
    ADMIN_TOTP_ENCRYPTION_KEYRING: `admin-totp-v1:${secret}`,
    ADMIN_COOKIE_SECURE: 'false',
    MAIL_PROVIDER: 'fake',
    MAIL_FROM: 'no-reply@example.local',
    PROVIDER_MODE: 'fake',
    PROVIDER_PROCESSOR_MODE: 'disabled',
    PROVIDER_ADAPTER: 'fake',
    PROVIDER_RELAY_ORIGINS: 'https://relay.test.invalid',
    PROVIDER_FAKE_WEBHOOK_KEY_ID: 'fake-webhook-v1',
    PROVIDER_FAKE_WEBHOOK_SECRET: secret,
    PROVIDER_CALLBACK_DIGEST_ACTIVE_KEY_ID: 'callback-v1',
    PROVIDER_CALLBACK_DIGEST_KEYRING: `callback-v1:${secret}`,
    ...overrides,
  };
}

describe('loadAppConfig', () => {
  it('returns validated typed configuration', () => {
    const config = loadAppConfig(testEnv());

    expect(config.appEnv).toBe('test');
    expect(config.mail.provider).toBe('fake');
    expect(config.mail.recoveryStaleSeconds).toBe(API_RUNTIME_DEFAULTS.mailRecoveryStaleSeconds);
    expect(config.redisPrefix).toBe('ecom-forge-test');
    expect(config.agent.routeEnabled).toBe(true);
    expect(config.sse).toEqual({
      heartbeatIntervalMs: API_RUNTIME_DEFAULTS.sseHeartbeatIntervalMs,
      watchdogTimeoutMs: API_RUNTIME_DEFAULTS.sseWatchdogTimeoutMs,
      replayBatchSize: API_RUNTIME_DEFAULTS.sseReplayBatchSize,
      backpressureTimeoutMs: API_RUNTIME_DEFAULTS.sseBackpressureTimeoutMs,
      maxConnections: API_RUNTIME_DEFAULTS.sseMaxConnections,
      maxConnectionsPerUser: API_RUNTIME_DEFAULTS.sseMaxConnectionsPerUser,
    });
    expect(config.database).toEqual({
      poolMax: API_RUNTIME_DEFAULTS.databasePoolMax,
      statementTimeoutMs: API_RUNTIME_DEFAULTS.databaseStatementTimeoutMs,
      transactionTimeoutMs: API_RUNTIME_DEFAULTS.databaseTransactionTimeoutMs,
    });
    expect(config.auth.trustedOrigins).toEqual(['http://localhost:3000']);
    expect(config.admin).toMatchObject({
      origin: 'http://localhost:3200',
      cookieName: 'ecom_admin_session',
      cookieSecure: false,
      networkGateMode: 'source_allowlist',
      sessionTtlSeconds: 28_800,
      inviteLimits: { batchMax: 100 },
    });
    expect(config.provider).toMatchObject({
      mode: 'fake',
      adapter: 'fake',
      relayOrigins: ['https://relay.test.invalid'],
      imageOutputOrigins: ['https://relay.test.invalid'],
      webhookMaxBodyBytes: API_RUNTIME_DEFAULTS.providerWebhookMaxBodyBytes,
      webhookClockSkewSeconds: API_RUNTIME_DEFAULTS.providerWebhookClockSkewSeconds,
    });
    expect(config.storage).toMatchObject({
      driver: 'local',
      uploadTtlSeconds: API_RUNTIME_DEFAULTS.storageUploadTtlSeconds,
      accessTtlSeconds: API_RUNTIME_DEFAULTS.storageAccessTtlSeconds,
      maxImageBytes: API_RUNTIME_DEFAULTS.storageMaxImageBytes,
    });
  });

  it('uses the typed local upload root when no path is injected', () => {
    const config = loadAppConfig(testEnv({ LOCAL_UPLOAD_ROOT: '' }));

    expect(config.storage.driver).toBe('local');
    expect(config.localUploadRoot).toBe(API_RUNTIME_DEFAULTS.localUploadRoot);
  });

  it('allows both local Admin and its internal API proxy hosts by default', () => {
    const config = loadAppConfig(
      testEnv({
        ADMIN_ALLOWED_HOSTS: '',
      }),
    );

    expect(config.admin.allowedHosts).toEqual([
      'localhost:3002',
      '127.0.0.1:3002',
      'localhost:3001',
      '127.0.0.1:3001',
    ]);
  });

  it('rejects a development mail adapter in production', () => {
    expect(() =>
      loadAppConfig(
        testEnv({
          APP_ENV: 'production',
          MAIL_PROVIDER: 'console',
          PROVIDER_MODE: 'real',
          PROVIDER_ADAPTER: 'disabled',
        }),
      ),
    ).toThrow(ConfigurationError);
  });

  it('rejects reused HMAC material across security domains outside test', () => {
    const independent = Buffer.alloc(32, 9).toString('base64url');

    expect(() =>
      loadAppConfig(
        testEnv({
          APP_ENV: 'production',
          MAIL_PROVIDER: 'tencent_ses',
          AUTH_OTP_HASH_SECRET: independent,
          PROVIDER_MODE: 'real',
          PROVIDER_ADAPTER: 'disabled',
        }),
      ),
    ).toThrow(/independent/);
  });

  it('rejects missing secrets and invalid ports', () => {
    expect(() => loadAppConfig(testEnv({ AUTH_SECRET: '' }))).toThrow(/AUTH_SECRET/);
    expect(() => loadAppConfig(testEnv({ API_PORT: '70000' }))).toThrow(/API_PORT/);
    expect(() => loadAppConfig(testEnv({ AUTH_OTP_HASH_SECRET: 'weak' }))).toThrow(
      /AUTH_OTP_HASH_SECRET/,
    );
    expect(() => loadAppConfig(testEnv({ MAIL_RECOVERY_STALE_SECONDS: '0' }))).toThrow(
      /MAIL_RECOVERY_STALE_SECONDS/,
    );
    expect(() => loadAppConfig(testEnv({ REDIS_PREFIX: 'ecom:forge' }))).toThrow(/REDIS_PREFIX/);
    expect(() => loadAppConfig(testEnv({ DB_POOL_MAX: '0' }))).toThrow(/DB_POOL_MAX/);
    expect(() => loadAppConfig(testEnv({ ADMIN_INVITE_BATCH_MAX: '0' }))).toThrow(
      /ADMIN_INVITE_BATCH_MAX/,
    );
    expect(() => loadAppConfig(testEnv({ PROVIDER_WEBHOOK_MAX_BODY_BYTES: '100' }))).toThrow(
      /PROVIDER_WEBHOOK_MAX_BODY_BYTES/,
    );
    expect(() =>
      loadAppConfig(testEnv({ PROVIDER_RELAY_ORIGINS: 'https://relay.test.invalid/path' })),
    ).toThrow(/PROVIDER_RELAY_ORIGINS/);
    expect(() =>
      loadAppConfig(testEnv({ PROVIDER_IMAGE_OUTPUT_ORIGINS: 'https://cdn.test.invalid/path' })),
    ).toThrow(/PROVIDER_IMAGE_OUTPUT_ORIGINS/);
    expect(() =>
      loadAppConfig(
        testEnv({
          SSE_HEARTBEAT_INTERVAL_MS: '20000',
          NEXT_PUBLIC_SSE_WATCHDOG_TIMEOUT_MS: '45000',
        }),
      ),
    ).toThrow(/NEXT_PUBLIC_SSE_WATCHDOG_TIMEOUT_MS/);
    expect(() =>
      loadAppConfig(testEnv({ SSE_MAX_CONNECTIONS: '2', SSE_MAX_CONNECTIONS_PER_USER: '3' })),
    ).toThrow(/SSE_MAX_CONNECTIONS_PER_USER/);
    expect(() => loadAppConfig(testEnv({ ADMIN_NETWORK_GATE_MODE: 'identity_gateway' }))).toThrow(
      /trusted ingress verifier/,
    );
  });

  it('accepts the same wildcard image output origin syntax as the Worker', () => {
    const config = loadAppConfig(
      testEnv({ PROVIDER_IMAGE_OUTPUT_ORIGINS: 'https://*.cxkedu.shop' }),
    );

    expect(config.provider.imageOutputOrigins).toEqual(['https://*.cxkedu.shop']);
  });
});
