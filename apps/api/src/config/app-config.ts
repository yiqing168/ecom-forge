import { API_RUNTIME_DEFAULTS } from './runtime-defaults.js';
import { normalizeOutputOriginEntry } from '@ecom-forge/provider';

export const APP_ENVIRONMENTS = ['local', 'test', 'staging', 'beta', 'production'] as const;
export const MAIL_PROVIDERS = ['fake', 'console', 'smtp', 'tencent_ses'] as const;
export const PROVIDER_MODES = ['fake', 'real'] as const;
export const ADMIN_NETWORK_GATE_MODES = ['identity_gateway', 'vpn', 'source_allowlist'] as const;

export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];
export type MailProviderName = (typeof MAIL_PROVIDERS)[number];
export type ProviderMode = (typeof PROVIDER_MODES)[number];
export type AdminNetworkGateMode = (typeof ADMIN_NETWORK_GATE_MODES)[number];

export interface AppConfig {
  appEnv: AppEnvironment;
  apiPort: number;
  webOrigin: string;
  databaseUrl: string | undefined;
  database: {
    poolMax: number;
    statementTimeoutMs: number;
    transactionTimeoutMs: number;
  };
  redisUrl: string;
  redisPrefix: string;
  localUploadRoot: string;
  storage: {
    driver: 'local' | 'disabled';
    capabilitySecret: string;
    credentialEncryptionKeys: string;
    credentialHintKeys: string;
    uploadTtlSeconds: number;
    accessTtlSeconds: number;
    maxImageBytes: number;
    maxImageWidth: number;
    maxImageHeight: number;
    maxImagePixels: number;
  };
  resourceCursorSecret: string;
  resourceIdempotencySecret: string;
  agent: {
    routeEnabled: boolean;
    executionPolicyVersion: string;
  };
  sse: {
    heartbeatIntervalMs: number;
    watchdogTimeoutMs: number;
    replayBatchSize: number;
    backpressureTimeoutMs: number;
    maxConnections: number;
    maxConnectionsPerUser: number;
  };
  trustedProxyCidrs: string[];
  auth: {
    secret: string;
    trustedOrigins: string[];
    otpHashKeys: string;
    rateLimitHashKeys: string;
    ticketHashKeys: string;
    inviteHashKeys: string;
    inviteCodeEncryptionKeys: string;
    recipientHashKeys: string;
    mailboxFingerprintKeys: string;
    passwordResetResponseFloorMs: number;
    rateLimits: {
      cooldownSeconds: number;
      emailHourly: number;
      emailDaily: number;
      ipHourly: number;
      deviceHourly: number;
      inviteTenMinutes: number;
      verifyIdentityTenMinutes: number;
      verifyIpTenMinutes: number;
      loginIdentityTenMinutes: number;
      loginIpTenMinutes: number;
    };
  };
  admin: {
    origin: string;
    allowedHosts: string[];
    trustedProxyCidrs: string[];
    networkGateMode: AdminNetworkGateMode;
    sourceAllowlistCidrs: string[];
    cookieName: string;
    cookieSecure: boolean;
    identifierHashKeys: string;
    sessionHashKeys: string;
    csrfDerivationKeys: string;
    challengeHashKeys: string;
    enrollmentHashKeys: string;
    idempotencyHashKeys: string;
    recoveryHashKeys: string;
    sourceHashKeys: string;
    totpEncryptionKeys: string;
    sessionTtlSeconds: number;
    sessionIdleTtlSeconds: number;
    challengeTtlSeconds: number;
    stepUpTtlSeconds: number;
    enrollmentTtlSeconds: number;
    argon2: {
      memoryKiB: number;
      timeCost: number;
      parallelism: number;
    };
    authLimits: {
      loginTenMinutes: number;
      mfaTenMinutes: number;
      stepUpTenMinutes: number;
    };
    inviteLimits: {
      batchMax: number;
    };
  };
  mail: {
    provider: MailProviderName;
    from: string;
    host: string | undefined;
    port: number | undefined;
    recoveryStaleSeconds: number;
  };
  provider: {
    mode: ProviderMode;
    adapter: 'fake' | 'disabled';
    fakeWebhookKeyId: string | undefined;
    fakeWebhookSecret: string | undefined;
    callbackDigestKeys: string | undefined;
    credentialEncryptionKeys: string;
    credentialHintKeys: string;
    relayOrigins: string[];
    imageOutputOrigins: string[];
    webhookMaxBodyBytes: number;
    webhookClockSkewSeconds: number;
  };
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new ConfigurationError(`${key} is required`);
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

function localOrRequired(
  env: NodeJS.ProcessEnv,
  key: string,
  appEnv: AppEnvironment,
  fallback: string,
): string {
  const value = env[key]?.trim();
  if (value) return value;
  if (appEnv === 'local' || appEnv === 'test') return fallback;
  return required(env, key);
}

function redisPrefix(env: NodeJS.ProcessEnv, appEnv: AppEnvironment): string {
  const value = localOrRequired(env, 'REDIS_PREFIX', appEnv, API_RUNTIME_DEFAULTS.localRedisPrefix);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ConfigurationError(
      'REDIS_PREFIX must contain only letters, digits, underscores, or hyphens',
    );
  }
  return value;
}

function oneOf<T extends readonly string[]>(value: string, values: T, key: string): T[number] {
  if (!values.includes(value)) {
    throw new ConfigurationError(`${key} has an unsupported value`);
  }
  return value;
}

function csv(value: string, key: string): string[] {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new ConfigurationError(`${key} must not be empty`);
  return [...new Set(entries)];
}

function providerOrigins(
  value: string | undefined,
  appEnv: AppEnvironment,
  key: 'PROVIDER_RELAY_ORIGINS' | 'PROVIDER_IMAGE_OUTPUT_ORIGINS',
  fallback?: readonly string[],
): string[] {
  const configured = value?.trim();
  if (!configured) {
    if (fallback) return [...fallback];
    if (appEnv === 'local' || appEnv === 'test') return ['https://local.invalid'];
    throw new ConfigurationError(`${key} is required outside local/test`);
  }
  return csv(configured, key).map((entry) => {
    try {
      if (key === 'PROVIDER_IMAGE_OUTPUT_ORIGINS') {
        return normalizeOutputOriginEntry(entry);
      }
      const parsed = new URL(entry);
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        (parsed.pathname !== '/' && parsed.pathname !== '')
      ) {
        throw new Error('invalid relay origin');
      }
      return parsed.origin;
    } catch {
      throw new ConfigurationError(`${key} contains an invalid HTTPS origin`);
    }
  });
}

function hostList(value: string, key: string): string[] {
  return csv(value, key).map((entry) => {
    if (/[\\/\s,]/.test(entry) || entry === '.' || entry === '..') {
      throw new ConfigurationError(`${key} contains an invalid host`);
    }
    try {
      const parsed = new URL(`http://${entry}`);
      if (
        parsed.pathname !== '/' ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        !parsed.hostname
      ) {
        throw new Error('invalid host');
      }
    } catch {
      throw new ConfigurationError(`${key} contains an invalid host`);
    }
    return entry.toLowerCase();
  });
}

function port(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new ConfigurationError(`${key} must be a valid TCP port`);
  }
  return parsed;
}

function positiveInteger(value: string | undefined, key: string, fallback: number): number {
  const parsed = Number(value?.trim() || fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigurationError(`${key} must be a positive integer`);
  }
  return parsed;
}

function nonnegativeInteger(value: string | undefined, key: string, fallback: number): number {
  const parsed = Number(value?.trim() || fallback);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigurationError(`${key} must be a nonnegative integer`);
  }
  return parsed;
}

function boundedInteger(
  value: string | undefined,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value?.trim() || fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ConfigurationError(`${key} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function url(value: string, key: string): string {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('unsupported URL');
    }
    return parsed.origin;
  } catch {
    throw new ConfigurationError(`${key} must be an HTTP(S) origin`);
  }
}

function keyring(value: string, key: string): string {
  const entries = value.split(',').map((entry) => entry.trim());
  const ids = new Set<string>();
  for (const entry of entries) {
    const separator = entry.indexOf(':');
    const id = entry.slice(0, separator);
    const encoded = entry.slice(separator + 1);
    if (
      separator <= 0 ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) ||
      ids.has(id) ||
      Buffer.from(encoded, 'base64url').length < 32
    ) {
      throw new ConfigurationError(`${key} must contain unique 32-byte key entries`);
    }
    ids.add(id);
  }
  return value;
}

function keyringWithActiveId(
  env: NodeJS.ProcessEnv,
  keyringKey: string,
  activeIdKey: string,
): string {
  const serialized = keyring(required(env, keyringKey), keyringKey);
  const activeId = required(env, activeIdKey);
  const ids = serialized.split(',').map((entry) => entry.slice(0, entry.indexOf(':')));
  if (!ids.includes(activeId)) {
    throw new ConfigurationError(`${activeIdKey} must identify a key in ${keyringKey}`);
  }
  const active = serialized
    .split(',')
    .find((entry) => entry.slice(0, entry.indexOf(':')) === activeId)!;
  const historical = serialized
    .split(',')
    .filter((entry) => entry !== active)
    .join(',');
  return historical ? `${active},${historical}` : active;
}

function keyringSecretValues(serialized: string): string[] {
  return serialized.split(',').map((entry) => entry.slice(entry.indexOf(':') + 1));
}

function secretVariants(value: string): string[] {
  return [`text:${value}`, `bytes:${Buffer.from(value, 'base64url').toString('hex')}`];
}

function assertIndependentSecretDomains(
  appEnv: AppEnvironment,
  domains: readonly (readonly [name: string, values: readonly string[]])[],
): void {
  if (appEnv === 'test') return;
  const seen = new Map<string, string>();
  for (const [name, values] of domains) {
    for (const value of values) {
      for (const variant of secretVariants(value)) {
        const previous = seen.get(variant);
        if (previous && previous !== name) {
          throw new ConfigurationError(`${name} must use a secret independent from ${previous}`);
        }
        seen.set(variant, name);
      }
    }
  }
}

function booleanValue(value: string | undefined, key: string, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ConfigurationError(`${key} must be true or false`);
}

function singleSecret(env: NodeJS.ProcessEnv, key: string, id: string): string {
  const value = required(env, key);
  if (Buffer.from(value, 'base64url').length < 32) {
    throw new ConfigurationError(`${key} must contain at least 32 bytes in base64url form`);
  }
  return `${id}:${value}`;
}

function resolveAppEnvironment(env: NodeJS.ProcessEnv): AppEnvironment {
  const fallback =
    env.NODE_ENV === 'test' ? 'test' : env.NODE_ENV === 'production' ? 'production' : 'local';
  return oneOf(env.APP_ENV?.trim() || fallback, APP_ENVIRONMENTS, 'APP_ENV');
}

function assertProviderEnvironment(appEnv: AppEnvironment, provider: MailProviderName): void {
  if (provider === 'fake' && appEnv !== 'test') {
    throw new ConfigurationError('MAIL_PROVIDER=fake is restricted to APP_ENV=test');
  }
  if (provider === 'console' && appEnv !== 'local') {
    throw new ConfigurationError('MAIL_PROVIDER=console is restricted to APP_ENV=local');
  }
  if (
    (appEnv === 'staging' || appEnv === 'beta' || appEnv === 'production') &&
    provider !== 'tencent_ses'
  ) {
    throw new ConfigurationError(`${appEnv} requires MAIL_PROVIDER=tencent_ses`);
  }
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appEnv = resolveAppEnvironment(env);
  const provider = oneOf(
    env.MAIL_PROVIDER?.trim() ||
      (appEnv === 'test'
        ? API_RUNTIME_DEFAULTS.testMailProvider
        : API_RUNTIME_DEFAULTS.localMailProvider),
    MAIL_PROVIDERS,
    'MAIL_PROVIDER',
  );
  assertProviderEnvironment(appEnv, provider);

  const authSecret = required(env, 'AUTH_SECRET');
  if (Buffer.byteLength(authSecret, 'utf8') < 32) {
    throw new ConfigurationError('AUTH_SECRET must contain at least 32 bytes');
  }
  const storageCapabilitySecret = required(env, 'STORAGE_CAPABILITY_SECRET');
  if (Buffer.from(storageCapabilitySecret, 'base64url').length < 32) {
    throw new ConfigurationError('STORAGE_CAPABILITY_SECRET must contain at least 32 bytes');
  }
  const providerCredentialEncryptionKeys = keyringWithActiveId(
    env,
    'PROVIDER_CREDENTIAL_ENCRYPTION_KEYRING',
    'PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID',
  );
  const storageCredentialEncryptionKeys = keyringWithActiveId(
    env,
    'STORAGE_CREDENTIAL_ENCRYPTION_KEYRING',
    'STORAGE_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID',
  );
  const providerCredentialHintKeys = keyringWithActiveId(
    env,
    'PROVIDER_CREDENTIAL_HINT_KEYRING',
    'PROVIDER_CREDENTIAL_HINT_ACTIVE_KEY_ID',
  );
  const storageCredentialHintKeys = keyringWithActiveId(
    env,
    'STORAGE_CREDENTIAL_HINT_KEYRING',
    'STORAGE_CREDENTIAL_HINT_ACTIVE_KEY_ID',
  );
  const resourceCursorSecret = required(env, 'RESOURCE_CURSOR_SECRET');
  if (Buffer.from(resourceCursorSecret, 'base64url').length < 32) {
    throw new ConfigurationError('RESOURCE_CURSOR_SECRET must contain at least 32 bytes');
  }
  const resourceIdempotencySecret = required(env, 'RESOURCE_IDEMPOTENCY_SECRET');
  if (Buffer.from(resourceIdempotencySecret, 'base64url').length < 32) {
    throw new ConfigurationError('RESOURCE_IDEMPOTENCY_SECRET must contain at least 32 bytes');
  }

  const smtpPort =
    provider === 'smtp' ? port(required(env, 'MAIL_SMTP_PORT'), 'MAIL_SMTP_PORT') : undefined;
  const mailRecoveryStaleSeconds = positiveInteger(
    env.MAIL_RECOVERY_STALE_SECONDS,
    'MAIL_RECOVERY_STALE_SECONDS',
    API_RUNTIME_DEFAULTS.mailRecoveryStaleSeconds,
  );
  const otpHashKeys = singleSecret(env, 'AUTH_OTP_HASH_SECRET', 'otp-v1');
  const rateLimitHashKeys = singleSecret(env, 'AUTH_RATE_LIMIT_SECRET', 'rate-v1');
  const ticketHashKeys = singleSecret(env, 'AUTH_VERIFICATION_TICKET_SECRET', 'ticket-v1');
  const inviteHashKeys = keyringWithActiveId(
    env,
    'AUTH_INVITE_CODE_KEYRING',
    'AUTH_INVITE_CODE_ACTIVE_KEY_ID',
  );
  const inviteCodeEncryptionKeys = keyringWithActiveId(
    env,
    'ADMIN_INVITE_CODE_ENCRYPTION_KEYRING',
    'ADMIN_INVITE_CODE_ENCRYPTION_ACTIVE_KEY_ID',
  );
  const recipientHashKeys = keyringWithActiveId(
    env,
    'MAIL_RECIPIENT_HASH_KEYRING',
    'MAIL_RECIPIENT_HASH_ACTIVE_KEY_ID',
  );
  const mailboxFingerprintKeys = keyringWithActiveId(
    env,
    'AUTH_REWARD_FINGERPRINT_KEYRING',
    'AUTH_REWARD_FINGERPRINT_ACTIVE_KEY_ID',
  );
  const adminIdentifierHashKeys = keyringWithActiveId(
    env,
    'ADMIN_IDENTIFIER_HASH_KEYRING',
    'ADMIN_IDENTIFIER_HASH_ACTIVE_KEY_ID',
  );
  const adminSessionHashKeys = keyringWithActiveId(
    env,
    'ADMIN_SESSION_HASH_KEYRING',
    'ADMIN_SESSION_HASH_ACTIVE_KEY_ID',
  );
  const adminCsrfDerivationKeys = keyringWithActiveId(
    env,
    'ADMIN_CSRF_DERIVATION_KEYRING',
    'ADMIN_CSRF_DERIVATION_ACTIVE_KEY_ID',
  );
  const adminChallengeHashKeys = keyringWithActiveId(
    env,
    'ADMIN_CHALLENGE_HASH_KEYRING',
    'ADMIN_CHALLENGE_HASH_ACTIVE_KEY_ID',
  );
  const adminEnrollmentHashKeys = keyringWithActiveId(
    env,
    'ADMIN_ENROLLMENT_HASH_KEYRING',
    'ADMIN_ENROLLMENT_HASH_ACTIVE_KEY_ID',
  );
  const adminIdempotencyHashKeys = keyringWithActiveId(
    env,
    'ADMIN_IDEMPOTENCY_HASH_KEYRING',
    'ADMIN_IDEMPOTENCY_HASH_ACTIVE_KEY_ID',
  );
  const adminRecoveryHashKeys = keyringWithActiveId(
    env,
    'ADMIN_RECOVERY_HASH_KEYRING',
    'ADMIN_RECOVERY_HASH_ACTIVE_KEY_ID',
  );
  const adminSourceHashKeys = keyringWithActiveId(
    env,
    'ADMIN_SOURCE_HASH_KEYRING',
    'ADMIN_SOURCE_HASH_ACTIVE_KEY_ID',
  );
  const adminTotpEncryptionKeys = keyringWithActiveId(
    env,
    'ADMIN_TOTP_ENCRYPTION_KEYRING',
    'ADMIN_TOTP_ENCRYPTION_ACTIVE_KEY_ID',
  );
  const providerMode = oneOf(
    env.PROVIDER_MODE?.trim() ||
      (appEnv === 'test'
        ? API_RUNTIME_DEFAULTS.testProviderMode
        : API_RUNTIME_DEFAULTS.realProviderMode),
    PROVIDER_MODES,
    'PROVIDER_MODE',
  );
  const providerAdapter = oneOf(
    env.PROVIDER_ADAPTER?.trim() ||
      (providerMode === 'fake'
        ? API_RUNTIME_DEFAULTS.fakeProviderAdapter
        : API_RUNTIME_DEFAULTS.realProviderAdapter),
    ['fake', 'disabled'] as const,
    'PROVIDER_ADAPTER',
  );
  if (providerMode === 'fake' && appEnv !== 'test' && appEnv !== 'local') {
    throw new ConfigurationError('PROVIDER_MODE=fake is restricted to APP_ENV=test/local');
  }
  if (providerMode === 'fake' && providerAdapter !== 'fake') {
    throw new ConfigurationError('PROVIDER_MODE=fake requires PROVIDER_ADAPTER=fake');
  }
  if (providerMode === 'real' && providerAdapter !== 'disabled') {
    throw new ConfigurationError('No real Provider webhook adapter has been approved yet');
  }
  const providerRelayOrigins = providerOrigins(
    env.PROVIDER_RELAY_ORIGINS,
    appEnv,
    'PROVIDER_RELAY_ORIGINS',
  );
  const providerImageOutputOrigins = providerOrigins(
    env.PROVIDER_IMAGE_OUTPUT_ORIGINS,
    appEnv,
    'PROVIDER_IMAGE_OUTPUT_ORIGINS',
    providerRelayOrigins,
  );
  const providerCallbackDigestKeys =
    providerAdapter === 'fake'
      ? keyringWithActiveId(
          env,
          'PROVIDER_CALLBACK_DIGEST_KEYRING',
          'PROVIDER_CALLBACK_DIGEST_ACTIVE_KEY_ID',
        )
      : undefined;
  const fakeWebhookSecret =
    providerAdapter === 'fake' ? required(env, 'PROVIDER_FAKE_WEBHOOK_SECRET') : undefined;
  if (fakeWebhookSecret && Buffer.from(fakeWebhookSecret, 'base64url').length < 32) {
    throw new ConfigurationError('PROVIDER_FAKE_WEBHOOK_SECRET must contain at least 32 bytes');
  }
  const fakeWebhookKeyId =
    providerAdapter === 'fake' ? required(env, 'PROVIDER_FAKE_WEBHOOK_KEY_ID') : undefined;
  if (fakeWebhookKeyId && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(fakeWebhookKeyId)) {
    throw new ConfigurationError('PROVIDER_FAKE_WEBHOOK_KEY_ID is invalid');
  }
  assertIndependentSecretDomains(appEnv, [
    ['AUTH_SECRET', [authSecret]],
    ['STORAGE_CAPABILITY_SECRET', [storageCapabilitySecret]],
    [
      'PROVIDER_CREDENTIAL_ENCRYPTION_KEYRING',
      keyringSecretValues(providerCredentialEncryptionKeys),
    ],
    ['PROVIDER_CREDENTIAL_HINT_KEYRING', keyringSecretValues(providerCredentialHintKeys)],
    ['STORAGE_CREDENTIAL_ENCRYPTION_KEYRING', keyringSecretValues(storageCredentialEncryptionKeys)],
    ['STORAGE_CREDENTIAL_HINT_KEYRING', keyringSecretValues(storageCredentialHintKeys)],
    ['RESOURCE_CURSOR_SECRET', [resourceCursorSecret]],
    ['RESOURCE_IDEMPOTENCY_SECRET', [resourceIdempotencySecret]],
    ['AUTH_OTP_HASH_SECRET', keyringSecretValues(otpHashKeys)],
    ['AUTH_RATE_LIMIT_SECRET', keyringSecretValues(rateLimitHashKeys)],
    ['AUTH_VERIFICATION_TICKET_SECRET', keyringSecretValues(ticketHashKeys)],
    ['AUTH_INVITE_CODE_KEYRING', keyringSecretValues(inviteHashKeys)],
    ['ADMIN_INVITE_CODE_ENCRYPTION_KEYRING', keyringSecretValues(inviteCodeEncryptionKeys)],
    ['MAIL_RECIPIENT_HASH_KEYRING', keyringSecretValues(recipientHashKeys)],
    ['AUTH_REWARD_FINGERPRINT_KEYRING', keyringSecretValues(mailboxFingerprintKeys)],
    ['ADMIN_IDENTIFIER_HASH_KEYRING', keyringSecretValues(adminIdentifierHashKeys)],
    ['ADMIN_SESSION_HASH_KEYRING', keyringSecretValues(adminSessionHashKeys)],
    ['ADMIN_CSRF_DERIVATION_KEYRING', keyringSecretValues(adminCsrfDerivationKeys)],
    ['ADMIN_CHALLENGE_HASH_KEYRING', keyringSecretValues(adminChallengeHashKeys)],
    ['ADMIN_ENROLLMENT_HASH_KEYRING', keyringSecretValues(adminEnrollmentHashKeys)],
    ['ADMIN_IDEMPOTENCY_HASH_KEYRING', keyringSecretValues(adminIdempotencyHashKeys)],
    ['ADMIN_RECOVERY_HASH_KEYRING', keyringSecretValues(adminRecoveryHashKeys)],
    ['ADMIN_SOURCE_HASH_KEYRING', keyringSecretValues(adminSourceHashKeys)],
    ['ADMIN_TOTP_ENCRYPTION_KEYRING', keyringSecretValues(adminTotpEncryptionKeys)],
    ...(providerCallbackDigestKeys
      ? ([
          ['PROVIDER_CALLBACK_DIGEST_KEYRING', keyringSecretValues(providerCallbackDigestKeys)],
        ] as const)
      : []),
    ...(fakeWebhookSecret
      ? ([['PROVIDER_FAKE_WEBHOOK_SECRET', [fakeWebhookSecret]]] as const)
      : []),
  ]);

  const heartbeatIntervalMs = positiveInteger(
    env.SSE_HEARTBEAT_INTERVAL_MS,
    'SSE_HEARTBEAT_INTERVAL_MS',
    API_RUNTIME_DEFAULTS.sseHeartbeatIntervalMs,
  );
  const watchdogTimeoutMs = positiveInteger(
    env.NEXT_PUBLIC_SSE_WATCHDOG_TIMEOUT_MS,
    'NEXT_PUBLIC_SSE_WATCHDOG_TIMEOUT_MS',
    API_RUNTIME_DEFAULTS.sseWatchdogTimeoutMs,
  );
  const maxConnections = positiveInteger(
    env.SSE_MAX_CONNECTIONS,
    'SSE_MAX_CONNECTIONS',
    API_RUNTIME_DEFAULTS.sseMaxConnections,
  );
  const maxConnectionsPerUser = boundedInteger(
    env.SSE_MAX_CONNECTIONS_PER_USER,
    'SSE_MAX_CONNECTIONS_PER_USER',
    API_RUNTIME_DEFAULTS.sseMaxConnectionsPerUser,
    1,
    20,
  );
  if (watchdogTimeoutMs < heartbeatIntervalMs * 3) {
    throw new ConfigurationError(
      'NEXT_PUBLIC_SSE_WATCHDOG_TIMEOUT_MS must be at least three times SSE_HEARTBEAT_INTERVAL_MS',
    );
  }
  if (maxConnectionsPerUser > maxConnections) {
    throw new ConfigurationError(
      'SSE_MAX_CONNECTIONS_PER_USER must not exceed SSE_MAX_CONNECTIONS',
    );
  }

  return {
    appEnv,
    apiPort: port(env.API_PORT?.trim() || API_RUNTIME_DEFAULTS.apiPort, 'API_PORT'),
    webOrigin: url(
      localOrRequired(env, 'WEB_ORIGIN', appEnv, API_RUNTIME_DEFAULTS.localWebOrigin),
      'WEB_ORIGIN',
    ),
    databaseUrl: optional(env, 'DATABASE_URL'),
    database: {
      poolMax: positiveInteger(
        env.DB_POOL_MAX,
        'DB_POOL_MAX',
        API_RUNTIME_DEFAULTS.databasePoolMax,
      ),
      statementTimeoutMs: positiveInteger(
        env.DB_STATEMENT_TIMEOUT_MS,
        'DB_STATEMENT_TIMEOUT_MS',
        API_RUNTIME_DEFAULTS.databaseStatementTimeoutMs,
      ),
      transactionTimeoutMs: positiveInteger(
        env.DB_TRANSACTION_TIMEOUT_MS,
        'DB_TRANSACTION_TIMEOUT_MS',
        API_RUNTIME_DEFAULTS.databaseTransactionTimeoutMs,
      ),
    },
    redisUrl: required(env, 'REDIS_URL'),
    redisPrefix: redisPrefix(env, appEnv),
    localUploadRoot: env.LOCAL_UPLOAD_ROOT?.trim() || API_RUNTIME_DEFAULTS.localUploadRoot,
    storage: {
      driver: appEnv === 'local' || appEnv === 'test' ? 'local' : 'disabled',
      capabilitySecret: storageCapabilitySecret,
      credentialEncryptionKeys: storageCredentialEncryptionKeys,
      credentialHintKeys: storageCredentialHintKeys,
      uploadTtlSeconds: boundedInteger(
        env.STORAGE_UPLOAD_TTL_SECONDS,
        'STORAGE_UPLOAD_TTL_SECONDS',
        API_RUNTIME_DEFAULTS.storageUploadTtlSeconds,
        60,
        3_600,
      ),
      accessTtlSeconds: boundedInteger(
        env.STORAGE_ACCESS_TTL_SECONDS,
        'STORAGE_ACCESS_TTL_SECONDS',
        API_RUNTIME_DEFAULTS.storageAccessTtlSeconds,
        30,
        600,
      ),
      maxImageBytes: boundedInteger(
        env.STORAGE_MAX_IMAGE_BYTES,
        'STORAGE_MAX_IMAGE_BYTES',
        API_RUNTIME_DEFAULTS.storageMaxImageBytes,
        1_024,
        20 * 1024 * 1024,
      ),
      maxImageWidth: boundedInteger(
        env.STORAGE_MAX_IMAGE_WIDTH,
        'STORAGE_MAX_IMAGE_WIDTH',
        API_RUNTIME_DEFAULTS.storageMaxImageWidth,
        1,
        32_768,
      ),
      maxImageHeight: boundedInteger(
        env.STORAGE_MAX_IMAGE_HEIGHT,
        'STORAGE_MAX_IMAGE_HEIGHT',
        API_RUNTIME_DEFAULTS.storageMaxImageHeight,
        1,
        32_768,
      ),
      maxImagePixels: boundedInteger(
        env.STORAGE_MAX_IMAGE_PIXELS,
        'STORAGE_MAX_IMAGE_PIXELS',
        API_RUNTIME_DEFAULTS.storageMaxImagePixels,
        1,
        268_435_456,
      ),
    },
    resourceCursorSecret,
    resourceIdempotencySecret,
    agent: {
      routeEnabled: appEnv === 'local' || appEnv === 'test',
      executionPolicyVersion:
        env.AGENT_EXECUTION_POLICY_VERSION?.trim() ||
        API_RUNTIME_DEFAULTS.agentExecutionPolicyVersion,
    },
    sse: {
      heartbeatIntervalMs,
      watchdogTimeoutMs,
      replayBatchSize: boundedInteger(
        env.SSE_REPLAY_BATCH_SIZE,
        'SSE_REPLAY_BATCH_SIZE',
        API_RUNTIME_DEFAULTS.sseReplayBatchSize,
        1,
        500,
      ),
      backpressureTimeoutMs: positiveInteger(
        env.SSE_BACKPRESSURE_TIMEOUT_MS,
        'SSE_BACKPRESSURE_TIMEOUT_MS',
        API_RUNTIME_DEFAULTS.sseBackpressureTimeoutMs,
      ),
      maxConnections,
      maxConnectionsPerUser,
    },
    trustedProxyCidrs: localOrRequired(
      env,
      'TRUSTED_PROXY_CIDRS',
      appEnv,
      API_RUNTIME_DEFAULTS.localTrustedProxyCidrs.join(','),
    )
      .split(',')
      .map((cidr) => cidr.trim())
      .filter(Boolean),
    auth: {
      secret: authSecret,
      trustedOrigins: localOrRequired(
        env,
        'AUTH_TRUSTED_ORIGINS',
        appEnv,
        API_RUNTIME_DEFAULTS.localAuthTrustedOrigins.join(','),
      )
        .split(',')
        .map((origin) => url(origin.trim(), 'AUTH_TRUSTED_ORIGINS'))
        .filter(Boolean),
      otpHashKeys,
      rateLimitHashKeys,
      ticketHashKeys,
      inviteHashKeys,
      inviteCodeEncryptionKeys,
      recipientHashKeys,
      mailboxFingerprintKeys,
      passwordResetResponseFloorMs: nonnegativeInteger(
        env.AUTH_PASSWORD_RESET_RESPONSE_FLOOR_MS,
        'AUTH_PASSWORD_RESET_RESPONSE_FLOOR_MS',
        appEnv === 'test'
          ? API_RUNTIME_DEFAULTS.testAuthPasswordResetResponseFloorMs
          : API_RUNTIME_DEFAULTS.authPasswordResetResponseFloorMs,
      ),
      rateLimits: {
        cooldownSeconds: positiveInteger(
          env.AUTH_OTP_COOLDOWN_SECONDS,
          'AUTH_OTP_COOLDOWN_SECONDS',
          API_RUNTIME_DEFAULTS.authOtpCooldownSeconds,
        ),
        emailHourly: positiveInteger(
          env.AUTH_OTP_EMAIL_HOURLY_LIMIT,
          'AUTH_OTP_EMAIL_HOURLY_LIMIT',
          API_RUNTIME_DEFAULTS.authOtpEmailHourlyLimit,
        ),
        emailDaily: positiveInteger(
          env.AUTH_OTP_EMAIL_DAILY_LIMIT,
          'AUTH_OTP_EMAIL_DAILY_LIMIT',
          API_RUNTIME_DEFAULTS.authOtpEmailDailyLimit,
        ),
        ipHourly: positiveInteger(
          env.AUTH_OTP_IP_HOURLY_LIMIT,
          'AUTH_OTP_IP_HOURLY_LIMIT',
          API_RUNTIME_DEFAULTS.authOtpIpHourlyLimit,
        ),
        deviceHourly: positiveInteger(
          env.AUTH_OTP_DEVICE_HOURLY_LIMIT,
          'AUTH_OTP_DEVICE_HOURLY_LIMIT',
          API_RUNTIME_DEFAULTS.authOtpDeviceHourlyLimit,
        ),
        inviteTenMinutes: positiveInteger(
          env.AUTH_INVITE_TEN_MINUTE_LIMIT,
          'AUTH_INVITE_TEN_MINUTE_LIMIT',
          API_RUNTIME_DEFAULTS.authInviteTenMinuteLimit,
        ),
        verifyIdentityTenMinutes: positiveInteger(
          env.AUTH_VERIFY_IDENTITY_TEN_MINUTE_LIMIT,
          'AUTH_VERIFY_IDENTITY_TEN_MINUTE_LIMIT',
          API_RUNTIME_DEFAULTS.authVerifyIdentityTenMinuteLimit,
        ),
        verifyIpTenMinutes: positiveInteger(
          env.AUTH_VERIFY_IP_TEN_MINUTE_LIMIT,
          'AUTH_VERIFY_IP_TEN_MINUTE_LIMIT',
          API_RUNTIME_DEFAULTS.authVerifyIpTenMinuteLimit,
        ),
        loginIdentityTenMinutes: positiveInteger(
          env.AUTH_LOGIN_IDENTITY_TEN_MINUTE_LIMIT,
          'AUTH_LOGIN_IDENTITY_TEN_MINUTE_LIMIT',
          API_RUNTIME_DEFAULTS.authLoginIdentityTenMinuteLimit,
        ),
        loginIpTenMinutes: positiveInteger(
          env.AUTH_LOGIN_IP_TEN_MINUTE_LIMIT,
          'AUTH_LOGIN_IP_TEN_MINUTE_LIMIT',
          API_RUNTIME_DEFAULTS.authLoginIpTenMinuteLimit,
        ),
      },
    },
    admin: (() => {
      const adminOrigin = url(
        localOrRequired(env, 'ADMIN_ORIGIN', appEnv, API_RUNTIME_DEFAULTS.localAdminOrigin),
        'ADMIN_ORIGIN',
      );
      const allowedHosts = hostList(
        localOrRequired(
          env,
          'ADMIN_ALLOWED_HOSTS',
          appEnv,
          API_RUNTIME_DEFAULTS.localAdminAllowedHosts.join(','),
        ),
        'ADMIN_ALLOWED_HOSTS',
      );
      const networkGateMode = oneOf(
        env.ADMIN_NETWORK_GATE_MODE?.trim() || API_RUNTIME_DEFAULTS.adminNetworkGateMode,
        ADMIN_NETWORK_GATE_MODES,
        'ADMIN_NETWORK_GATE_MODE',
      );
      if (networkGateMode !== 'source_allowlist') {
        throw new ConfigurationError(
          `ADMIN_NETWORK_GATE_MODE=${networkGateMode} is not available until its trusted ingress verifier is configured`,
        );
      }
      const trustedProxyCidrs = csv(
        localOrRequired(
          env,
          'TRUSTED_ADMIN_PROXY_CIDRS',
          appEnv,
          API_RUNTIME_DEFAULTS.localAdminProxyCidrs.join(','),
        ),
        'TRUSTED_ADMIN_PROXY_CIDRS',
      );
      const sourceAllowlistCidrs = csv(
        localOrRequired(
          env,
          'ADMIN_SOURCE_ALLOWLIST_CIDRS',
          appEnv,
          API_RUNTIME_DEFAULTS.localAdminProxyCidrs.join(','),
        ),
        'ADMIN_SOURCE_ALLOWLIST_CIDRS',
      );
      const cookieSecure = booleanValue(
        env.ADMIN_COOKIE_SECURE,
        'ADMIN_COOKIE_SECURE',
        appEnv === 'staging' || appEnv === 'beta' || appEnv === 'production',
      );
      if (appEnv !== 'local' && appEnv !== 'test' && !cookieSecure) {
        throw new ConfigurationError('ADMIN_COOKIE_SECURE must be true outside local/test');
      }
      if (appEnv !== 'local' && appEnv !== 'test' && trustedProxyCidrs.length === 0) {
        throw new ConfigurationError('TRUSTED_ADMIN_PROXY_CIDRS is required outside local/test');
      }
      if (networkGateMode === 'source_allowlist' && sourceAllowlistCidrs.length === 0) {
        throw new ConfigurationError(
          'ADMIN_SOURCE_ALLOWLIST_CIDRS is required for source_allowlist',
        );
      }
      return {
        origin: adminOrigin,
        allowedHosts,
        trustedProxyCidrs,
        sourceAllowlistCidrs,
        networkGateMode,
        cookieName: cookieSecure ? '__Host-ecom_admin_session' : 'ecom_admin_session',
        cookieSecure,
        identifierHashKeys: adminIdentifierHashKeys,
        sessionHashKeys: adminSessionHashKeys,
        csrfDerivationKeys: adminCsrfDerivationKeys,
        challengeHashKeys: adminChallengeHashKeys,
        enrollmentHashKeys: adminEnrollmentHashKeys,
        idempotencyHashKeys: adminIdempotencyHashKeys,
        recoveryHashKeys: adminRecoveryHashKeys,
        sourceHashKeys: adminSourceHashKeys,
        totpEncryptionKeys: adminTotpEncryptionKeys,
        sessionTtlSeconds: boundedInteger(
          env.ADMIN_SESSION_TTL_SECONDS,
          'ADMIN_SESSION_TTL_SECONDS',
          API_RUNTIME_DEFAULTS.adminSessionTtlSeconds,
          300,
          24 * 60 * 60,
        ),
        sessionIdleTtlSeconds: boundedInteger(
          env.ADMIN_SESSION_IDLE_TTL_SECONDS,
          'ADMIN_SESSION_IDLE_TTL_SECONDS',
          API_RUNTIME_DEFAULTS.adminSessionIdleTtlSeconds,
          60,
          8 * 60 * 60,
        ),
        challengeTtlSeconds: boundedInteger(
          env.ADMIN_CHALLENGE_TTL_SECONDS,
          'ADMIN_CHALLENGE_TTL_SECONDS',
          API_RUNTIME_DEFAULTS.adminChallengeTtlSeconds,
          60,
          900,
        ),
        stepUpTtlSeconds: boundedInteger(
          env.ADMIN_STEP_UP_TTL_SECONDS,
          'ADMIN_STEP_UP_TTL_SECONDS',
          API_RUNTIME_DEFAULTS.adminStepUpTtlSeconds,
          60,
          3_600,
        ),
        enrollmentTtlSeconds: boundedInteger(
          env.ADMIN_ENROLLMENT_TTL_SECONDS,
          'ADMIN_ENROLLMENT_TTL_SECONDS',
          API_RUNTIME_DEFAULTS.adminEnrollmentTtlSeconds,
          300,
          7 * 24 * 60 * 60,
        ),
        argon2: {
          memoryKiB: boundedInteger(
            env.ADMIN_ARGON2_MEMORY_KIB,
            'ADMIN_ARGON2_MEMORY_KIB',
            API_RUNTIME_DEFAULTS.adminArgon2MemoryKib,
            16_384,
            1_048_576,
          ),
          timeCost: boundedInteger(
            env.ADMIN_ARGON2_TIME_COST,
            'ADMIN_ARGON2_TIME_COST',
            API_RUNTIME_DEFAULTS.adminArgon2TimeCost,
            1,
            10,
          ),
          parallelism: boundedInteger(
            env.ADMIN_ARGON2_PARALLELISM,
            'ADMIN_ARGON2_PARALLELISM',
            API_RUNTIME_DEFAULTS.adminArgon2Parallelism,
            1,
            8,
          ),
        },
        authLimits: {
          loginTenMinutes: positiveInteger(
            env.ADMIN_AUTH_LOGIN_TEN_MINUTE_LIMIT,
            'ADMIN_AUTH_LOGIN_TEN_MINUTE_LIMIT',
            API_RUNTIME_DEFAULTS.adminAuthLoginTenMinuteLimit,
          ),
          mfaTenMinutes: positiveInteger(
            env.ADMIN_AUTH_MFA_TEN_MINUTE_LIMIT,
            'ADMIN_AUTH_MFA_TEN_MINUTE_LIMIT',
            API_RUNTIME_DEFAULTS.adminAuthMfaTenMinuteLimit,
          ),
          stepUpTenMinutes: positiveInteger(
            env.ADMIN_AUTH_STEP_UP_TEN_MINUTE_LIMIT,
            'ADMIN_AUTH_STEP_UP_TEN_MINUTE_LIMIT',
            API_RUNTIME_DEFAULTS.adminAuthStepUpTenMinuteLimit,
          ),
        },
        inviteLimits: {
          batchMax: boundedInteger(
            env.ADMIN_INVITE_BATCH_MAX,
            'ADMIN_INVITE_BATCH_MAX',
            API_RUNTIME_DEFAULTS.adminInviteBatchMax,
            1,
            1_000,
          ),
        },
      };
    })(),
    mail: {
      provider,
      from: localOrRequired(env, 'MAIL_FROM', appEnv, API_RUNTIME_DEFAULTS.localMailFrom),
      host: provider === 'smtp' ? required(env, 'MAIL_SMTP_HOST') : optional(env, 'MAIL_SMTP_HOST'),
      port: smtpPort,
      recoveryStaleSeconds: mailRecoveryStaleSeconds,
    },
    provider: {
      mode: providerMode,
      adapter: providerAdapter,
      fakeWebhookKeyId,
      fakeWebhookSecret,
      callbackDigestKeys: providerCallbackDigestKeys,
      credentialEncryptionKeys: providerCredentialEncryptionKeys,
      credentialHintKeys: providerCredentialHintKeys,
      relayOrigins: providerRelayOrigins,
      imageOutputOrigins: providerImageOutputOrigins,
      webhookMaxBodyBytes: boundedInteger(
        env.PROVIDER_WEBHOOK_MAX_BODY_BYTES,
        'PROVIDER_WEBHOOK_MAX_BODY_BYTES',
        API_RUNTIME_DEFAULTS.providerWebhookMaxBodyBytes,
        1_024,
        1_048_576,
      ),
      webhookClockSkewSeconds: boundedInteger(
        env.PROVIDER_WEBHOOK_CLOCK_SKEW_SECONDS,
        'PROVIDER_WEBHOOK_CLOCK_SKEW_SECONDS',
        API_RUNTIME_DEFAULTS.providerWebhookClockSkewSeconds,
        30,
        900,
      ),
    },
  };
}
