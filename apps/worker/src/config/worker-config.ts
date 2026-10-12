import { compareMoney, normalizeMoney } from '@ecom-forge/shared';
import { AGENT_BRAIN_REASONING_EFFORTS, normalizeOutputOriginEntry } from '@ecom-forge/provider';
import type { AgentBrainReasoningEffort } from '@ecom-forge/provider';

import { WORKER_RUNTIME_DEFAULTS } from './runtime-defaults.js';

export const WORKER_APP_ENVIRONMENTS = ['local', 'test', 'staging', 'beta', 'production'] as const;
export const PROVIDER_MODES = ['fake', 'real'] as const;
export const PROVIDER_PROCESSOR_MODES = ['disabled', 'fake_validation', 'real'] as const;
export const AGENT_BRAIN_ADAPTERS = ['fake', 'approved'] as const;

export type WorkerAppEnvironment = (typeof WORKER_APP_ENVIRONMENTS)[number];
export type ProviderMode = (typeof PROVIDER_MODES)[number];
export type ProviderProcessorMode = (typeof PROVIDER_PROCESSOR_MODES)[number];
export type AgentBrainAdapter = (typeof AGENT_BRAIN_ADAPTERS)[number];

export interface WorkerConfig {
  appEnv: WorkerAppEnvironment;
  databaseUrl: string;
  databasePoolMax: number;
  databaseStatementTimeoutMs: number;
  databaseTransactionTimeoutMs: number;
  redisUrl: string;
  redisPrefix: string;
  localUploadRoot: string;
  storageEnabled: boolean;
  storageMaxImageBytes: number;
  storageMaxImageWidth: number;
  storageMaxImageHeight: number;
  storageMaxImagePixels: number;
  contentReviewDeadlineMs: number;
  contentReviewSweepBatchSize: number;
  outcomeUnknownReleaseDeadlineMs: number;
  outcomeUnknownReleaseSweepBatchSize: number;
  testProcessorEnabled: boolean;
  settlementProcessorEnabled: boolean;
  providerMode: ProviderMode;
  providerProcessorMode: ProviderProcessorMode;
  providerAdapter: 'fake' | 'disabled';
  providerRelayOrigins: readonly string[];
  providerImageOutputOrigins: readonly string[];
  providerRequestTimeoutMs: number;
  imageProviderRequestTimeoutMs: number;
  providerImageTaskConcurrency: number;
  agentProcessorEnabled: boolean;
  agentBrainAdapter: AgentBrainAdapter;
  agentBrainReasoningEffort: AgentBrainReasoningEffort;
  providerRealPocEnabled: boolean;
  providerCredentialEncryptionKeys?: string;
  agentRequestTimeoutMs: number;
  agentProcessingLeaseMs: number;
  agentProcessingRenewMs: number;
  agentProcessingRetryAttempts: number;
  agentProcessingRetryBaseMs: number;
  agentMaxLlmRounds: number;
  agentMaxToolCalls: number;
  agentMaxInputTokens: number;
  agentAutoCompactTokenLimit?: number;
  agentMaxOutputTokens: number;
  agentBrainStepMaxOutputTokens: number;
  agentBrainImageMaxEdge: number;
  agentBrainRetryBaseDelayMs: number;
  agentBrainRetryMaxDelayMs: number;
  agentBrainImageMaterializationConcurrency: number;
  agentBrainMaxMaterializedImageBytes: number;
  agentMaxEstimatedCostCny: string;
  agentMaxReferences: number;
  agentExecutionPolicyVersion: string;
  compilerQuoteTtlSeconds: number;
  heartbeatIntervalMs: number;
  heartbeatStaleMs: number;
  dispatchLeaseMs: number;
  dispatchLeaseRenewMs: number;
  dispatchPollMs: number;
  dispatchBatchSize: number;
  dispatchBackoffBaseMs: number;
  dispatchBackoffMaxMs: number;
  drainTimeoutMs: number;
}

export class WorkerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerConfigurationError';
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new WorkerConfigurationError(`${key} is required`);
  return value;
}

function appEnvironment(env: NodeJS.ProcessEnv): WorkerAppEnvironment {
  const fallback =
    env.NODE_ENV === 'test' ? 'test' : env.NODE_ENV === 'production' ? 'production' : 'local';
  const value = env.APP_ENV?.trim() || fallback;
  if (!WORKER_APP_ENVIRONMENTS.includes(value as WorkerAppEnvironment)) {
    throw new WorkerConfigurationError('APP_ENV has an unsupported value');
  }
  return value as WorkerAppEnvironment;
}

function integer(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  options: { min: number; max: number },
): number {
  const parsed = Number(env[key]?.trim() || fallback);
  if (!Number.isInteger(parsed) || parsed < options.min || parsed > options.max) {
    throw new WorkerConfigurationError(
      `${key} must be an integer between ${options.min} and ${options.max}`,
    );
  }
  return parsed;
}

function booleanValue(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const value = env[key]?.trim();
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new WorkerConfigurationError(`${key} must be true or false`);
}

function providerOrigins(
  value: string | undefined,
  appEnv: WorkerAppEnvironment,
  key: 'PROVIDER_RELAY_ORIGINS' | 'PROVIDER_IMAGE_OUTPUT_ORIGINS',
  fallback?: readonly string[],
): string[] {
  const configured = value?.trim();
  if (!configured) {
    if (fallback) return [...fallback];
    if (appEnv === 'local' || appEnv === 'test') return ['https://local.invalid'];
    throw new WorkerConfigurationError(`${key} is required outside local/test`);
  }
  const origins = configured
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        if (key === 'PROVIDER_IMAGE_OUTPUT_ORIGINS') {
          // Image output entries additionally accept single-domain wildcards
          // like `https://*.relay-output.example.com` for provider file pools.
          return normalizeOutputOriginEntry(entry);
        }
        const parsed = new URL(entry);
        if (
          parsed.protocol !== 'https:' ||
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash ||
          (parsed.pathname !== '/' && parsed.pathname !== '') ||
          parsed.hostname.includes('*')
        ) {
          throw new Error('invalid relay origin');
        }
        return parsed.origin;
      } catch {
        throw new WorkerConfigurationError(`${key} contains an invalid HTTPS origin`);
      }
    });
  if (origins.length === 0) {
    throw new WorkerConfigurationError(`${key} must not be empty`);
  }
  return [...new Set(origins)];
}

function agentCostBudget(env: NodeJS.ProcessEnv): string {
  const value =
    env.AGENT_MAX_ESTIMATED_COST_CNY?.trim() || WORKER_RUNTIME_DEFAULTS.agentMaxEstimatedCostCny;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new WorkerConfigurationError('AGENT_MAX_ESTIMATED_COST_CNY must be a decimal string');
  }
  if (compareMoney(value, '0.00') <= 0 || compareMoney(value, '0.15') > 0) {
    throw new WorkerConfigurationError(
      'AGENT_MAX_ESTIMATED_COST_CNY must be greater than zero and no more than 0.15',
    );
  }
  return normalizeMoney(value);
}

function oneOf<T extends readonly string[]>(value: string, values: T, key: string): T[number] {
  if (!values.includes(value)) {
    throw new WorkerConfigurationError(`${key} has an unsupported value`);
  }
  return value;
}

function databaseIdentity(value: string, key: string): string {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('protocol');
    const database = url.pathname.replace(/^\//, '');
    if (!database) throw new Error('database');
    return `${url.hostname.toLowerCase()}:${url.port || '5432'}/${database.toLowerCase()}`;
  } catch {
    throw new WorkerConfigurationError(`${key} must be a PostgreSQL URL with a database name`);
  }
}

function databaseName(value: string): string {
  try {
    return new URL(value).pathname.replace(/^\//, '').toLowerCase();
  } catch {
    throw new WorkerConfigurationError('TEST_DATABASE_URL must be a valid URL');
  }
}

function redisIdentity(value: string, key: string): string {
  try {
    const url = new URL(value);
    if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('protocol');
    return url.toString();
  } catch {
    throw new WorkerConfigurationError(`${key} must use redis:// or rediss://`);
  }
}

function checkedRedisPrefix(value: string, key: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new WorkerConfigurationError(
      `${key} must contain only letters, digits, underscores, or hyphens`,
    );
  }
  return value;
}

function resolveInfrastructure(env: NodeJS.ProcessEnv, appEnv: WorkerAppEnvironment) {
  if (appEnv !== 'test') {
    const databaseUrl = required(env, 'DATABASE_URL');
    const redisUrl = required(env, 'REDIS_URL');
    databaseIdentity(databaseUrl, 'DATABASE_URL');
    redisIdentity(redisUrl, 'REDIS_URL');
    return {
      databaseUrl,
      redisUrl,
      redisPrefix: checkedRedisPrefix(
        env.REDIS_PREFIX?.trim() ||
          (appEnv === 'local' ? WORKER_RUNTIME_DEFAULTS.localRedisPrefix : ''),
        'REDIS_PREFIX',
      ),
    };
  }

  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  const redisUrl = required(env, 'TEST_REDIS_URL');
  const redisPrefix = checkedRedisPrefix(required(env, 'TEST_REDIS_PREFIX'), 'TEST_REDIS_PREFIX');
  const testDatabaseName = databaseName(databaseUrl);
  databaseIdentity(databaseUrl, 'TEST_DATABASE_URL');
  redisIdentity(redisUrl, 'TEST_REDIS_URL');
  if (!/_test(?:_|$)/.test(testDatabaseName)) {
    throw new WorkerConfigurationError('TEST_DATABASE_URL database name must contain _test');
  }
  const developmentDatabaseUrl = env.DATABASE_URL?.trim();
  if (
    developmentDatabaseUrl &&
    databaseIdentity(developmentDatabaseUrl, 'DATABASE_URL') ===
      databaseIdentity(databaseUrl, 'TEST_DATABASE_URL')
  ) {
    throw new WorkerConfigurationError(
      'TEST_DATABASE_URL must not target the development database',
    );
  }
  if (!redisPrefix.startsWith('s05-test-')) {
    throw new WorkerConfigurationError('TEST_REDIS_PREFIX must start with s05-test-');
  }
  const developmentRedisUrl = env.REDIS_URL?.trim();
  const developmentRedisPrefix = env.REDIS_PREFIX?.trim();
  if (
    developmentRedisUrl &&
    developmentRedisPrefix &&
    redisIdentity(developmentRedisUrl, 'REDIS_URL') === redisIdentity(redisUrl, 'TEST_REDIS_URL') &&
    developmentRedisPrefix === redisPrefix
  ) {
    throw new WorkerConfigurationError(
      'TEST_REDIS_URL and TEST_REDIS_PREFIX must not match development Redis',
    );
  }
  return { databaseUrl, redisUrl, redisPrefix };
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const appEnv = appEnvironment(env);
  const infrastructure = resolveInfrastructure(env, appEnv);
  const heartbeatIntervalMs = integer(
    env,
    'WORKER_HEARTBEAT_INTERVAL_MS',
    WORKER_RUNTIME_DEFAULTS.heartbeatIntervalMs,
    {
      min: 1_000,
      max: 300_000,
    },
  );
  const heartbeatStaleMs = integer(
    env,
    'WORKER_HEARTBEAT_STALE_MS',
    WORKER_RUNTIME_DEFAULTS.heartbeatStaleMs,
    {
      min: 3_000,
      max: 900_000,
    },
  );
  const dispatchLeaseMs = integer(
    env,
    'QUEUE_DISPATCH_LEASE_MS',
    WORKER_RUNTIME_DEFAULTS.dispatchLeaseMs,
    {
      min: 3_000,
      max: 300_000,
    },
  );
  const dispatchLeaseRenewMs = integer(
    env,
    'QUEUE_DISPATCH_LEASE_RENEW_MS',
    WORKER_RUNTIME_DEFAULTS.dispatchLeaseRenewMs,
    {
      min: 1_000,
      max: 120_000,
    },
  );
  const dispatchBackoffBaseMs = integer(
    env,
    'QUEUE_DISPATCH_BACKOFF_BASE_MS',
    WORKER_RUNTIME_DEFAULTS.dispatchBackoffBaseMs,
    {
      min: 100,
      max: 60_000,
    },
  );
  const dispatchBackoffMaxMs = integer(
    env,
    'QUEUE_DISPATCH_BACKOFF_MAX_MS',
    WORKER_RUNTIME_DEFAULTS.dispatchBackoffMaxMs,
    {
      min: 1_000,
      max: 3_600_000,
    },
  );
  const testProcessorEnabled = booleanValue(env, 'QUEUE_ENABLE_TEST_PROCESSOR', false);
  const providerMode = oneOf(
    env.PROVIDER_MODE?.trim() ||
      (appEnv === 'test'
        ? WORKER_RUNTIME_DEFAULTS.fakeProviderMode
        : WORKER_RUNTIME_DEFAULTS.realProviderMode),
    PROVIDER_MODES,
    'PROVIDER_MODE',
  );
  const providerProcessorMode = oneOf(
    env.PROVIDER_PROCESSOR_MODE?.trim() || WORKER_RUNTIME_DEFAULTS.testProcessorMode,
    PROVIDER_PROCESSOR_MODES,
    'PROVIDER_PROCESSOR_MODE',
  );
  const providerAdapter = oneOf(
    env.PROVIDER_ADAPTER?.trim() ||
      (providerMode === 'fake'
        ? WORKER_RUNTIME_DEFAULTS.fakeProviderAdapter
        : WORKER_RUNTIME_DEFAULTS.realProviderAdapter),
    ['fake', 'disabled'] as const,
    'PROVIDER_ADAPTER',
  );
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
  const agentBrainAdapter = oneOf(
    env.AGENT_BRAIN_ADAPTER?.trim() ||
      (appEnv === 'test'
        ? WORKER_RUNTIME_DEFAULTS.testAgentBrainAdapter
        : WORKER_RUNTIME_DEFAULTS.productionAgentBrainAdapter),
    AGENT_BRAIN_ADAPTERS,
    'AGENT_BRAIN_ADAPTER',
  );
  const agentProcessorEnabled = booleanValue(
    env,
    'AGENT_PROCESSOR_ENABLED',
    appEnv === 'test' ? WORKER_RUNTIME_DEFAULTS.testAgentProcessorEnabled : false,
  );
  const providerRealPocEnabled = booleanValue(env, 'PROVIDER_REAL_POC_ENABLED', false);
  if (providerRealPocEnabled && appEnv !== 'local') {
    throw new WorkerConfigurationError('PROVIDER_REAL_POC_ENABLED is restricted to APP_ENV=local');
  }
  if (
    providerRealPocEnabled &&
    env.PROVIDER_REAL_COST_CONFIRMED?.trim() !== 'I_ACCEPT_REAL_PROVIDER_COST'
  ) {
    throw new WorkerConfigurationError(
      'PROVIDER_REAL_POC_ENABLED requires explicit real Provider cost confirmation',
    );
  }
  const providerCredentialEncryptionKeys =
    (agentBrainAdapter === 'approved' && agentProcessorEnabled) ||
    providerRealPocEnabled ||
    providerProcessorMode === 'real'
      ? required(env, 'PROVIDER_CREDENTIAL_ENCRYPTION_KEYRING')
      : undefined;
  const agentProcessingLeaseMs = integer(
    env,
    'AGENT_PROCESSING_LEASE_MS',
    WORKER_RUNTIME_DEFAULTS.agentProcessingLeaseMs,
    {
      min: 10_000,
      max: 600_000,
    },
  );
  const agentProcessingRenewMs = integer(
    env,
    'AGENT_PROCESSING_RENEW_MS',
    WORKER_RUNTIME_DEFAULTS.agentProcessingRenewMs,
    {
      min: 1_000,
      max: 120_000,
    },
  );

  if (heartbeatStaleMs < heartbeatIntervalMs * 3) {
    throw new WorkerConfigurationError(
      'WORKER_HEARTBEAT_STALE_MS must be at least three heartbeat intervals',
    );
  }
  if (dispatchLeaseRenewMs >= dispatchLeaseMs) {
    throw new WorkerConfigurationError(
      'QUEUE_DISPATCH_LEASE_RENEW_MS must be less than QUEUE_DISPATCH_LEASE_MS',
    );
  }
  if (dispatchBackoffMaxMs < dispatchBackoffBaseMs) {
    throw new WorkerConfigurationError(
      'QUEUE_DISPATCH_BACKOFF_MAX_MS must be at least QUEUE_DISPATCH_BACKOFF_BASE_MS',
    );
  }
  if (testProcessorEnabled && appEnv !== 'test') {
    throw new WorkerConfigurationError('QUEUE_ENABLE_TEST_PROCESSOR is restricted to APP_ENV=test');
  }
  if (providerMode === 'fake' && !['local', 'test'].includes(appEnv)) {
    throw new WorkerConfigurationError('PROVIDER_MODE=fake is restricted to APP_ENV=test/local');
  }
  if (providerMode === 'fake' && providerAdapter !== 'fake') {
    throw new WorkerConfigurationError('PROVIDER_MODE=fake requires PROVIDER_ADAPTER=fake');
  }
  if (providerMode === 'real' && providerAdapter !== 'disabled') {
    throw new WorkerConfigurationError('No real Provider adapter has been approved yet');
  }
  if (
    providerProcessorMode === 'fake_validation' &&
    (providerMode !== 'fake' || providerAdapter !== 'fake' || !['local', 'test'].includes(appEnv))
  ) {
    throw new WorkerConfigurationError(
      'PROVIDER_PROCESSOR_MODE=fake_validation requires APP_ENV=test/local and PROVIDER_MODE=fake',
    );
  }
  if (
    providerProcessorMode === 'real' &&
    (providerMode !== 'real' || providerAdapter !== 'disabled')
  ) {
    throw new WorkerConfigurationError(
      'PROVIDER_PROCESSOR_MODE=real requires PROVIDER_MODE=real and PROVIDER_ADAPTER=disabled',
    );
  }
  if (testProcessorEnabled && providerProcessorMode !== 'disabled') {
    throw new WorkerConfigurationError(
      'S05 test processors and S07 Provider processors cannot consume the same task queue',
    );
  }
  const agentRequestTimeoutMs = integer(
    env,
    'AGENT_REQUEST_TIMEOUT_MS',
    WORKER_RUNTIME_DEFAULTS.agentRequestTimeoutMs,
    {
      min: 1_000,
      max: 300_000,
    },
  );
  if (agentRequestTimeoutMs >= agentProcessingLeaseMs) {
    throw new WorkerConfigurationError(
      'AGENT_REQUEST_TIMEOUT_MS must be less than AGENT_PROCESSING_LEASE_MS',
    );
  }
  if (agentProcessingRenewMs * 3 >= agentProcessingLeaseMs) {
    throw new WorkerConfigurationError(
      'AGENT_PROCESSING_RENEW_MS times three must be less than AGENT_PROCESSING_LEASE_MS',
    );
  }
  if (agentBrainAdapter === 'fake' && !['local', 'test'].includes(appEnv)) {
    throw new WorkerConfigurationError(
      'AGENT_BRAIN_ADAPTER=fake is restricted to APP_ENV=test/local',
    );
  }

  return {
    appEnv,
    ...infrastructure,
    localUploadRoot: env.LOCAL_UPLOAD_ROOT?.trim() || WORKER_RUNTIME_DEFAULTS.localUploadRoot,
    storageEnabled: appEnv === 'local' || appEnv === 'test',
    storageMaxImageBytes: integer(
      env,
      'STORAGE_MAX_IMAGE_BYTES',
      WORKER_RUNTIME_DEFAULTS.storageMaxImageBytes,
      {
        min: 1_024,
        max: 20 * 1024 * 1024,
      },
    ),
    storageMaxImageWidth: integer(
      env,
      'STORAGE_MAX_IMAGE_WIDTH',
      WORKER_RUNTIME_DEFAULTS.storageMaxImageWidth,
      {
        min: 1,
        max: 32_768,
      },
    ),
    storageMaxImageHeight: integer(
      env,
      'STORAGE_MAX_IMAGE_HEIGHT',
      WORKER_RUNTIME_DEFAULTS.storageMaxImageHeight,
      {
        min: 1,
        max: 32_768,
      },
    ),
    storageMaxImagePixels: integer(
      env,
      'STORAGE_MAX_IMAGE_PIXELS',
      WORKER_RUNTIME_DEFAULTS.storageMaxImagePixels,
      {
        min: 1,
        max: 268_435_456,
      },
    ),
    contentReviewDeadlineMs:
      integer(
        env,
        'CONTENT_REVIEW_DEADLINE_SECONDS',
        WORKER_RUNTIME_DEFAULTS.contentReviewDeadlineSeconds,
        {
          min: 60,
          max: 604_800,
        },
      ) * 1_000,
    contentReviewSweepBatchSize: integer(
      env,
      'CONTENT_REVIEW_SWEEP_BATCH_SIZE',
      WORKER_RUNTIME_DEFAULTS.contentReviewSweepBatchSize,
      {
        min: 1,
        max: 500,
      },
    ),
    outcomeUnknownReleaseDeadlineMs:
      WORKER_RUNTIME_DEFAULTS.outcomeUnknownReleaseDeadlineSeconds * 1_000,
    outcomeUnknownReleaseSweepBatchSize:
      WORKER_RUNTIME_DEFAULTS.outcomeUnknownReleaseSweepBatchSize,
    databasePoolMax: integer(env, 'DB_POOL_MAX', WORKER_RUNTIME_DEFAULTS.databasePoolMax, {
      min: 1,
      max: 100,
    }),
    databaseStatementTimeoutMs: integer(
      env,
      'DB_STATEMENT_TIMEOUT_MS',
      WORKER_RUNTIME_DEFAULTS.databaseStatementTimeoutMs,
      {
        min: 1_000,
        max: 300_000,
      },
    ),
    databaseTransactionTimeoutMs: integer(
      env,
      'DB_TRANSACTION_TIMEOUT_MS',
      WORKER_RUNTIME_DEFAULTS.databaseTransactionTimeoutMs,
      {
        min: 1_000,
        max: 300_000,
      },
    ),
    testProcessorEnabled,
    settlementProcessorEnabled: appEnv === 'local' || appEnv === 'test',
    providerMode,
    providerProcessorMode,
    providerAdapter,
    providerRelayOrigins,
    providerImageOutputOrigins,
    providerRequestTimeoutMs: integer(
      env,
      'PROVIDER_REQUEST_TIMEOUT_MS',
      WORKER_RUNTIME_DEFAULTS.providerRequestTimeoutMs,
      {
        min: 1_000,
        max: 600_000,
      },
    ),
    imageProviderRequestTimeoutMs: integer(
      env,
      'IMAGE_PROVIDER_REQUEST_TIMEOUT_MS',
      WORKER_RUNTIME_DEFAULTS.imageProviderRequestTimeoutMs,
      {
        min: 1_000,
        max: 600_000,
      },
    ),
    providerImageTaskConcurrency: WORKER_RUNTIME_DEFAULTS.providerImageTaskConcurrency,
    agentProcessorEnabled,
    agentBrainAdapter,
    agentBrainReasoningEffort: oneOf(
      env.AGENT_BRAIN_REASONING_EFFORT?.trim() || WORKER_RUNTIME_DEFAULTS.agentBrainReasoningEffort,
      [...AGENT_BRAIN_REASONING_EFFORTS],
      'AGENT_BRAIN_REASONING_EFFORT',
    ),
    providerRealPocEnabled,
    ...(providerCredentialEncryptionKeys ? { providerCredentialEncryptionKeys } : {}),
    agentRequestTimeoutMs,
    agentProcessingLeaseMs,
    agentProcessingRenewMs,
    agentProcessingRetryAttempts: WORKER_RUNTIME_DEFAULTS.agentProcessingRetryAttempts,
    agentProcessingRetryBaseMs: WORKER_RUNTIME_DEFAULTS.agentProcessingRetryBaseMs,
    agentMaxLlmRounds: integer(
      env,
      'AGENT_MAX_LLM_ROUNDS',
      WORKER_RUNTIME_DEFAULTS.agentMaxLlmRounds,
      { min: 1, max: 6 },
    ),
    agentMaxToolCalls: integer(
      env,
      'AGENT_MAX_TOOL_CALLS',
      WORKER_RUNTIME_DEFAULTS.agentMaxToolCalls,
      { min: 1, max: 12 },
    ),
    agentMaxInputTokens: integer(
      env,
      'AGENT_MAX_INPUT_TOKENS',
      WORKER_RUNTIME_DEFAULTS.agentMaxInputTokens,
      {
        min: 1,
        max: 272_000,
      },
    ),
    agentAutoCompactTokenLimit: WORKER_RUNTIME_DEFAULTS.agentAutoCompactTokenLimit,
    agentMaxOutputTokens: integer(
      env,
      'AGENT_MAX_OUTPUT_TOKENS',
      WORKER_RUNTIME_DEFAULTS.agentMaxOutputTokens,
      {
        min: 1,
        max: WORKER_RUNTIME_DEFAULTS.agentMaxOutputTokens,
      },
    ),
    agentBrainStepMaxOutputTokens: integer(
      env,
      'AGENT_BRAIN_STEP_MAX_OUTPUT_TOKENS',
      WORKER_RUNTIME_DEFAULTS.agentBrainStepMaxOutputTokens,
      {
        min: 1,
        max: 8_192,
      },
    ),
    agentBrainImageMaxEdge: WORKER_RUNTIME_DEFAULTS.agentBrainImageMaxEdge,
    agentBrainRetryBaseDelayMs: WORKER_RUNTIME_DEFAULTS.agentBrainRetryBaseDelayMs,
    agentBrainRetryMaxDelayMs: WORKER_RUNTIME_DEFAULTS.agentBrainRetryMaxDelayMs,
    agentBrainImageMaterializationConcurrency:
      WORKER_RUNTIME_DEFAULTS.agentBrainImageMaterializationConcurrency,
    agentBrainMaxMaterializedImageBytes:
      WORKER_RUNTIME_DEFAULTS.agentBrainMaxMaterializedImageBytes,
    agentMaxEstimatedCostCny: agentCostBudget(env),
    agentMaxReferences: integer(
      env,
      'AGENT_MAX_REFERENCES',
      WORKER_RUNTIME_DEFAULTS.agentMaxReferences,
      { min: 1, max: 12 },
    ),
    agentExecutionPolicyVersion:
      env.AGENT_EXECUTION_POLICY_VERSION?.trim() ||
      WORKER_RUNTIME_DEFAULTS.agentExecutionPolicyVersion,
    compilerQuoteTtlSeconds: integer(
      env,
      'COMPILER_QUOTE_TTL_SECONDS',
      WORKER_RUNTIME_DEFAULTS.compilerQuoteTtlSeconds,
      {
        min: 60,
        max: 86_400,
      },
    ),
    heartbeatIntervalMs,
    heartbeatStaleMs,
    dispatchLeaseMs,
    dispatchLeaseRenewMs,
    dispatchPollMs: integer(env, 'QUEUE_DISPATCH_POLL_MS', WORKER_RUNTIME_DEFAULTS.dispatchPollMs, {
      min: 100,
      max: 60_000,
    }),
    dispatchBatchSize: integer(
      env,
      'QUEUE_DISPATCH_BATCH_SIZE',
      WORKER_RUNTIME_DEFAULTS.dispatchBatchSize,
      {
        min: 1,
        max: 1_000,
      },
    ),
    dispatchBackoffBaseMs,
    dispatchBackoffMaxMs,
    drainTimeoutMs: integer(
      env,
      'WORKER_DRAIN_TIMEOUT_MS',
      WORKER_RUNTIME_DEFAULTS.drainTimeoutMs,
      {
        min: 1_000,
        max: 600_000,
      },
    ),
  };
}
