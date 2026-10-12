const key = Buffer.alloc(32, 9).toString('base64url');
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL?.trim() ||
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';
const testDatabaseName = new URL(testDatabaseUrl).pathname.replace(/^\//, '').toLowerCase();
const s14TestDatabaseUrl =
  process.env.S14_TEST_DATABASE_URL?.trim() ||
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test_s14_gate';
const s14TestDatabaseName = new URL(s14TestDatabaseUrl).pathname.replace(/^\//, '').toLowerCase();

if (!/_test(?:_|$)/.test(testDatabaseName)) {
  throw new Error('API tests require TEST_DATABASE_URL to name an isolated _test database');
}
if (!/_test_s14(?:_|$)/.test(s14TestDatabaseName)) {
  throw new Error('S14 Admin tests require S14_TEST_DATABASE_URL to contain _test_s14');
}

Object.assign(process.env, {
  APP_ENV: 'test',
  DATABASE_URL: testDatabaseUrl,
  TEST_DATABASE_URL: testDatabaseUrl,
  S14_TEST_DATABASE_URL: s14TestDatabaseUrl,
  API_PORT: '3001',
  WEB_ORIGIN: 'http://localhost:3000',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_PREFIX: 'ecom-forge-test',
  LOCAL_UPLOAD_ROOT: './uploads',
  STORAGE_CAPABILITY_SECRET: Buffer.alloc(32, 31).toString('base64url'),
  PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'provider-credential-v1',
  PROVIDER_CREDENTIAL_ENCRYPTION_KEYRING: `provider-credential-v1:${key}`,
  PROVIDER_CREDENTIAL_HINT_ACTIVE_KEY_ID: 'provider-credential-hint-v1',
  PROVIDER_CREDENTIAL_HINT_KEYRING: `provider-credential-hint-v1:${key}`,
  STORAGE_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'storage-credential-v1',
  STORAGE_CREDENTIAL_ENCRYPTION_KEYRING: `storage-credential-v1:${key}`,
  STORAGE_CREDENTIAL_HINT_ACTIVE_KEY_ID: 'storage-credential-hint-v1',
  STORAGE_CREDENTIAL_HINT_KEYRING: `storage-credential-hint-v1:${key}`,
  RESOURCE_CURSOR_SECRET: Buffer.alloc(32, 32).toString('base64url'),
  RESOURCE_IDEMPOTENCY_SECRET: Buffer.alloc(32, 33).toString('base64url'),
  TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
  AUTH_SECRET: key,
  AUTH_TRUSTED_ORIGINS: 'http://localhost:3000',
  AUTH_OTP_HASH_SECRET: key,
  AUTH_RATE_LIMIT_SECRET: key,
  AUTH_VERIFICATION_TICKET_SECRET: key,
  AUTH_INVITE_CODE_ACTIVE_KEY_ID: 'invite-v1',
  AUTH_INVITE_CODE_KEYRING: `invite-v1:${key}`,
  ADMIN_INVITE_CODE_ENCRYPTION_ACTIVE_KEY_ID: 'invite-envelope-v1',
  ADMIN_INVITE_CODE_ENCRYPTION_KEYRING: `invite-envelope-v1:${key}`,
  MAIL_RECIPIENT_HASH_ACTIVE_KEY_ID: 'recipient-v1',
  MAIL_RECIPIENT_HASH_KEYRING: `recipient-v1:${key}`,
  AUTH_REWARD_FINGERPRINT_ACTIVE_KEY_ID: 'fingerprint-v1',
  AUTH_REWARD_FINGERPRINT_KEYRING: `fingerprint-v1:${key}`,
  ADMIN_ORIGIN: process.env.ADMIN_ORIGIN?.trim() || 'http://localhost:3200',
  ADMIN_ALLOWED_HOSTS: 'localhost:3200,127.0.0.1:3200,localhost:3001,127.0.0.1:3001',
  TRUSTED_ADMIN_PROXY_CIDRS: '127.0.0.1/32,::1/128',
  ADMIN_NETWORK_GATE_MODE: 'source_allowlist',
  ADMIN_SOURCE_ALLOWLIST_CIDRS: '127.0.0.1/32,::1/128',
  ADMIN_COOKIE_SECURE: 'false',
  ADMIN_IDENTIFIER_HASH_ACTIVE_KEY_ID: 'admin-identifier-v1',
  ADMIN_IDENTIFIER_HASH_KEYRING: `admin-identifier-v1:${key}`,
  ADMIN_SESSION_HASH_ACTIVE_KEY_ID: 'admin-session-v1',
  ADMIN_SESSION_HASH_KEYRING: `admin-session-v1:${key}`,
  ADMIN_CSRF_DERIVATION_ACTIVE_KEY_ID: 'admin-csrf-v1',
  ADMIN_CSRF_DERIVATION_KEYRING: `admin-csrf-v1:${key}`,
  ADMIN_CHALLENGE_HASH_ACTIVE_KEY_ID: 'admin-challenge-v1',
  ADMIN_CHALLENGE_HASH_KEYRING: `admin-challenge-v1:${key}`,
  ADMIN_ENROLLMENT_HASH_ACTIVE_KEY_ID: 'admin-enrollment-v1',
  ADMIN_ENROLLMENT_HASH_KEYRING: `admin-enrollment-v1:${key}`,
  ADMIN_IDEMPOTENCY_HASH_ACTIVE_KEY_ID: 'admin-idempotency-v1',
  ADMIN_IDEMPOTENCY_HASH_KEYRING: `admin-idempotency-v1:${key}`,
  ADMIN_RECOVERY_HASH_ACTIVE_KEY_ID: 'admin-recovery-v1',
  ADMIN_RECOVERY_HASH_KEYRING: `admin-recovery-v1:${key}`,
  ADMIN_SOURCE_HASH_ACTIVE_KEY_ID: 'admin-source-v1',
  ADMIN_SOURCE_HASH_KEYRING: `admin-source-v1:${key}`,
  ADMIN_TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'admin-totp-v1',
  ADMIN_TOTP_ENCRYPTION_KEYRING: `admin-totp-v1:${key}`,
  // Keep the isolated test suite fast while retaining the minimum accepted production settings.
  ADMIN_ARGON2_MEMORY_KIB: '16384',
  ADMIN_ARGON2_TIME_COST: '1',
  ADMIN_ARGON2_PARALLELISM: '1',
  MAIL_PROVIDER: 'fake',
  MAIL_FROM: 'no-reply@example.local',
  PROVIDER_MODE: 'fake',
  PROVIDER_PROCESSOR_MODE: 'disabled',
  PROVIDER_ADAPTER: 'fake',
  PROVIDER_FAKE_WEBHOOK_KEY_ID: 'fake-webhook-v1',
  PROVIDER_FAKE_WEBHOOK_SECRET: key,
  PROVIDER_CALLBACK_DIGEST_ACTIVE_KEY_ID: 'callback-v1',
  PROVIDER_CALLBACK_DIGEST_KEYRING: `callback-v1:${key}`,
});
